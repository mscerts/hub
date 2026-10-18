#!/usr/bin/env node
/**
 * The approval gates (docs/course-gates.md): decide what happens to every judged candidate of an exam, queue what
 * needs the maintainer, and remember the maintainer's decisions so nothing is asked twice.
 *
 *   node scripts/course-gates.mjs gate <CODE> [--judged DIR] [--out DIR] [--decisions FILE] [--today YYYY-MM-DD]
 *                                 [--urls [--live]] [--force]
 *       Reads <CODE>.*.judged.json of DIR (default <tmp>/course-judge; node scripts/course-judge.mjs merge writes
 *       them) and writes <CODE>.gated.json (a decision for every candidate) and <CODE>.queue.json (what waits for the
 *       maintainer) to OUT (default <tmp>/course-gates). --urls also asks learnsync's validator whether each page is a
 *       current Learn page. A queue file that has answers not yet applied is never overwritten (run resolve, or --force).
 *   node scripts/course-gates.mjs show <CODE> [--out DIR]
 *       Prints the queue in a readable form.
 *   node scripts/course-gates.mjs resolve <CODE> [--out DIR] [--decisions FILE] [--today YYYY-MM-DD] [--replace]
 *       Applies the answers written by hand into the queue file to the decisions file
 *       (default src/data_files/course-decisions/<CODE>.json, committed like a course file), and removes the answered
 *       items from the queue file.
 *
 * Exit code: 0 done, 1 answers in the queue file or the decisions file are not valid, 2 usage or input error.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentFromVerdict, learnsyncVerdicts } from "./course-file.mjs";
import { learnsyncDir } from "./course-source.mjs";
import {
  ageInDays,
  applyAnswers,
  buildQueue,
  emptyDecisions,
  gateJudged,
  validateDecisions,
} from "./lib/course-gates.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-gates.mjs gate <CODE> [--judged DIR] [--out DIR] [--decisions FILE] [--today YYYY-MM-DD] [--urls [--live]] [--force]
       node scripts/course-gates.mjs show <CODE> [--out DIR]
       node scripts/course-gates.mjs resolve <CODE> [--out DIR] [--decisions FILE] [--today YYYY-MM-DD] [--replace]`;
const COMMANDS = ["gate", "show", "resolve"];

function parseArgs(argv) {
  const options = {
    command: null,
    code: null,
    judged: null,
    out: null,
    decisions: null,
    today: null,
    urls: false,
    live: false,
    force: false,
    replace: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--urls") options.urls = true;
    else if (arg === "--live") options.live = options.urls = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--replace") options.replace = true;
    else if (["--judged", "--out", "--decisions", "--today"].includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length === 0) throw new Error("A command is required");
  if (!COMMANDS.includes(positional[0]))
    throw new Error(`Unknown command ${positional[0]}`);
  if (positional.length < 2) throw new Error("An exam code is required");
  if (positional.length > 2) throw new Error("Too many arguments");
  options.command = positional[0];
  options.code = positional[1].toUpperCase();
  if (options.today && !/^\d{4}-\d{2}-\d{2}$/.test(options.today))
    throw new Error("--today must be a YYYY-MM-DD day");
  return options;
}

const readJson = (file, what) => {
  if (!existsSync(file)) throw new Error(`${what} not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${file}): ${e.message}`);
  }
};
const write = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/**
 * How old a page is, from learnsync: the lastmod of docs-urls.txt for a documentation page, the catalog's
 * lastModified for a module and its units. Null when learnsync has nothing, so that nothing is queued for age.
 */
export function loadAges(dir, today) {
  if (!dir) return null;
  const lastmod = new Map();
  const urls = join(dir, "data", "docs-urls.txt");
  if (existsSync(urls))
    for (const line of readFileSync(urls, "utf8").split("\n")) {
      const [path, stamp] = line.split("\t");
      if (path?.startsWith("/") && stamp && stamp.trim() !== "-")
        lastmod.set(path, stamp.trim());
    }
  const catalog = join(dir, "data", "learn-catalog.json");
  if (existsSync(catalog))
    for (const m of JSON.parse(readFileSync(catalog, "utf8")).modules ?? [])
      if (m.path && m.lastModified) lastmod.set(m.path, m.lastModified);
  if (lastmod.size === 0) return null;
  return (target) => {
    const path =
      target.kind === "docs"
        ? target.path
        : target.path.split("/").slice(0, 4).join("/");
    return ageInDays(lastmod.get(path), today);
  };
}

const today = (now) => now().toISOString().slice(0, 10);

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    root = repoRoot,
    tmp = tmpdir(),
    now = () => new Date(),
    verdictsFor,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const code = options.code;
  const outDir = options.out ?? join(tmp, "course-gates");
  const queueFile = join(outDir, `${code}.queue.json`);
  const decisionsFile =
    options.decisions ??
    join(root, "src", "data_files", "course-decisions", `${code}.json`);
  const day = options.today ?? today(now);

  try {
    if (options.command === "show")
      return show(readJson(queueFile, "the queue file"), log);

    let store = null;
    if (existsSync(decisionsFile)) {
      store = readJson(decisionsFile, "the decisions file");
      const problems = validateDecisions(store, code);
      if (problems.length) {
        error(`The decisions file is not valid (${decisionsFile}):`);
        for (const p of problems) error(`  ${p}`);
        return 1;
      }
    }

    if (options.command === "resolve") {
      const queue = readJson(queueFile, "the queue file");
      const result = applyAnswers(store ?? emptyDecisions(code), queue, {
        today: day,
        replace: options.replace,
      });
      if (result.problems.length) {
        error(
          "The answers in the queue file cannot be applied; nothing was written:",
        );
        for (const p of result.problems) error(`  ${p}`);
        return 1;
      }
      if (result.applied.length === 0) {
        log(
          `${code}: no answers in the queue file (${result.pending} items pending).`,
        );
        return 0;
      }
      write(decisionsFile, result.store);
      const answered = new Set(
        result.applied.map((d) => `${d.task}|${d.target}`),
      );
      write(queueFile, {
        ...queue,
        items: queue.items.filter(
          (q) => !answered.has(`${q.task}|${q.target.path}`),
        ),
      });
      const accepted = result.applied.filter(
        (d) => d.decision === "accept",
      ).length;
      log(
        `${code}: ${result.applied.length} decisions applied (${accepted} accepted, ${result.applied.length - accepted} rejected), ${result.pending} still pending. Wrote ${decisionsFile}; run gate again.`,
      );
      return 0;
    }

    // gate
    if (existsSync(queueFile) && !options.force) {
      const old = readJson(queueFile, "the queue file");
      const answered = (old.items ?? []).filter(
        (q) =>
          q.decision !== null && q.decision !== undefined && q.decision !== "",
      ).length;
      if (answered > 0) {
        error(
          `${queueFile} has ${answered} answers that were not applied: run resolve ${code} first (or gate with --force to discard them).`,
        );
        return 2;
      }
    }
    const judgedDir = options.judged ?? join(tmp, "course-judge");
    if (!existsSync(judgedDir)) {
      error(
        `No judged files: ${judgedDir} does not exist. Run node scripts/course-judge.mjs merge first.`,
      );
      return 2;
    }
    const files = readdirSync(judgedDir)
      .filter((f) => f.startsWith(`${code}.`) && f.endsWith(".judged.json"))
      .sort();
    if (files.length === 0) {
      error(
        `No ${code}.*.judged.json files in ${judgedDir}. Run node scripts/course-judge.mjs merge first.`,
      );
      return 2;
    }
    const judged = files.map((f) => readJson(join(judgedDir, f), f));
    for (const [i, file] of judged.entries())
      if (file.kind !== "judged" || file.exam?.code !== code)
        throw new Error(`${files[i]} is not a judged file of ${code}`);
    const hashes = new Set(judged.map((f) => f.inputs?.guideHash));
    if (hashes.size > 1)
      log(
        "warning: the judged files were built from different study guide texts",
      );

    const dir = learnsyncDir({ root, env });
    const ageOf = loadAges(dir, day);
    if (!ageOf)
      log("warning: no learnsync data, so the age of a page is not checked");
    let isCurrent = null;
    if (options.urls) {
      if (!dir && !verdictsFor) {
        error("--urls needs a learnsync checkout (LEARNSYNC_DIR).");
        return 2;
      }
      const lookup =
        verdictsFor ?? (await learnsyncVerdicts({ dir, live: options.live }));
      const paths = [
        ...new Set(
          judged.flatMap((f) =>
            f.tasks.flatMap((t) => t.items.map((i) => i.target.path)),
          ),
        ),
      ];
      const verdicts = await lookup(paths);
      isCurrent = (path) => currentFromVerdict(verdicts.get(path));
    }

    const gated = gateJudged(judged, {
      decisions: store,
      today: day,
      isCurrent,
      ageOf,
    });
    const queue = buildQueue(code, gated, { builtAt: day });
    write(join(outDir, `${code}.gated.json`), {
      schemaVersion: 1,
      kind: "gated",
      code,
      builtAt: day,
      inputs: judged[0].inputs,
      stats: gated.stats,
      items: gated.items,
    });
    write(queueFile, queue);
    const s = gated.stats;
    log(
      `${code}: ${s.candidates} candidates: ${s.accepted} accepted (${s.acceptedCore} core, ${s.acceptedSupporting} supporting; ${s.acceptedByMaintainer} by earlier decisions), ${s.rejected} rejected (${s.rejectedByJudge} by the judge, ${s.rejectedRemembered} remembered, ${s.rejectedExcluded} in excluded sub-products, ${s.rejectedNotCurrent} not current), ${s.queued} for the maintainer.`,
    );
    for (const [reason, n] of Object.entries(s.queueReasons))
      log(`  queued: ${reason} (${n})`);
    log(`Wrote ${join(outDir, `${code}.gated.json`)} and ${queueFile}`);
    return 0;
  } catch (e) {
    error(e.message);
    return 2;
  }
}

/** The queue as lines of text, grouped by task. */
export function describeQueue(queue) {
  const lines = [];
  const pending = queue.items.filter((q) => !q.decision);
  lines.push(
    `${queue.code}: ${queue.items.length} items in the queue (${pending.length} pending, ${queue.items.length - pending.length} answered, not yet applied)`,
  );
  let task = null;
  for (const q of queue.items) {
    if (q.task !== task) {
      task = q.task;
      lines.push("", `${q.taskText}  (${q.group})`);
    }
    const p = q.proposal;
    lines.push(
      `  [${q.id}] ${q.source} ${q.target.kind}  ${q.title}${q.decision ? `   -> ${q.decision}` : ""}`,
      `      ${q.url}`,
      `      proposed: ${p.class}${p.relation ? ` (${p.relation})` : ""}; why it waits: ${q.reasons.join("; ")}`,
      `      judge (${q.judge.confidence}): ${q.judge.why}${q.judge.quote ? `  quote: "${q.judge.quote}"` : ""}`,
    );
    if (q.skeptic)
      lines.push(`      skeptic: ${q.skeptic.stance} - ${q.skeptic.reason}`);
  }
  return lines;
}

function show(queue, log) {
  for (const l of describeQueue(queue)) log(l);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
