#!/usr/bin/env node
/**
 * Model proposals (docs/course-proposals.md): a model names, from its own knowledge, the Microsoft Learn pages for
 * each task of an exam's study guide; the pages that exist join the shortlist of the candidate generator as a fifth
 * source, P5, and are judged like every other candidate. No AI runs here: the prompts are files a person or an
 * agent session gives to a model, and the answers are files they save back.
 *
 *   node scripts/course-propose.mjs prepare <CODE> [--group TEXT] [--out DIR]
 *       One batch per skill group of the stored study guide: <prefix>.propose-batch.json and <prefix>.propose.md
 *       (the prompt) in DIR (default <tmp>/course-propose), <prefix> being <CODE>.<nn>-<group>. Only the tasks
 *       go to the model, never what the word search found.
 *   node scripts/course-propose.mjs check <prefix>
 *       Validates <prefix>.proposals.json (the model's answer) against the batch. Exit 1 when it is not valid.
 *   node scripts/course-propose.mjs merge <CODE> [--candidates FILE] [--answers DIR] [--out FILE] [--only-new] [--probe]
 *       Looks every proposed page up in learnsync's catalogs (its address, Learn's moves, then its title) and adds
 *       the ones that exist to the candidates file as P5 (a page the word search had is marked alsoProposed).
 *       Writes OUT (default <tmp>/course-candidates/<CODE>.proposed.json) and OUT.report.json, and prints what
 *       became of the proposals. --only-new keeps the new P5 candidates only, to judge just them. --probe asks
 *       learn.microsoft.com about every address the catalogs do not know (one request each, PROBE_DELAY_MS apart,
 *       default 250): Learn's own redirects find the pages that moved, which learnsync's move list lacks.
 *
 * Inputs: the stored guide (src/data_files/learn-exams.json, LEARN_EXAMS_FILE); for merge also the candidates file
 * of scripts/course-candidates.mjs and learnsync's data (LEARNSYNC_DIR or GitHub main, with the documentation
 * files: about 50 MB).
 * Exit code: 0 done, 1 an answer is not valid, 2 usage or input error.
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
import { loadPools } from "./course-candidates.mjs";
import { readGuides } from "./course-source.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { flattenTasks } from "./lib/course-status.mjs";
import {
  buildProposalBatches,
  mergeProposals,
  probeLiveMoves,
  proposalPrompt,
  validateProposals,
} from "./lib/course-propose.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-propose.mjs prepare <CODE> [--group TEXT] [--out DIR]
       node scripts/course-propose.mjs check <prefix>
       node scripts/course-propose.mjs merge <CODE> [--candidates FILE] [--answers DIR] [--out FILE] [--only-new] [--probe]`;
const COMMANDS = ["prepare", "check", "merge"];

function parseArgs(argv) {
  const options = {
    command: null,
    subject: null,
    group: null,
    out: null,
    candidates: null,
    answers: null,
    onlyNew: false,
    probe: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only-new") options.onlyNew = true;
    else if (arg === "--probe") options.probe = true;
    else if (["--group", "--out", "--candidates", "--answers"].includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length === 0) throw new Error("A command is required");
  [options.command, options.subject] = positional;
  if (!COMMANDS.includes(options.command))
    throw new Error(`Unknown command ${options.command}`);
  if (positional.length > 2) throw new Error("Too many arguments");
  if (!options.subject)
    throw new Error(
      options.command === "check"
        ? "A file prefix is required"
        : "An exam code is required",
    );
  if (options.command !== "check")
    options.subject = options.subject.toUpperCase();
  return options;
}

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const readJson = (file, what) => {
  if (!existsSync(file)) throw new Error(`${what} not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${file}): ${e.message}`);
  }
};
const write = (file, data) =>
  writeFileSync(
    file,
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
  );

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
    tmp = tmpdir(),
    loadPoolsImpl = loadPools,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    if (options.command === "prepare")
      return prepare(options, { env, log, error, root, tmp });
    if (options.command === "check") return check(options, { log, error });
    return await merge(options, {
      env,
      log,
      error,
      fetchImpl,
      root,
      tmp,
      loadPoolsImpl,
    });
  } catch (e) {
    error(e.message);
    return 2;
  }
}

function prepare(options, { env, log, error, root, tmp }) {
  const code = options.subject;
  const guides = readGuides(
    env.LEARN_EXAMS_FILE || join(root, "src", "data_files", "learn-exams.json"),
  );
  const stored = guides.get(code);
  if (!stored) {
    error(`No stored study guide text for ${code}.`);
    return 2;
  }
  const guide = { ...parseGuide(stored.lines), hash: stored.hash };
  if (!guide.ok) {
    error(`${code}: the study guide does not parse completely.`);
    return 2;
  }
  let batches = buildProposalBatches({
    tasks: flattenTasks(guide),
    exam: { code, name: stored.name ?? null },
    guideHash: stored.hash ?? null,
  });
  if (options.group) {
    const needle = options.group.toLowerCase();
    batches = batches.filter((b) =>
      `${b.group.domain} ${b.group.title}`.toLowerCase().includes(needle),
    );
    if (batches.length === 0) {
      error(`No skill group of ${code} contains "${options.group}".`);
      return 2;
    }
  }
  const outDir = options.out ?? join(tmp, "course-propose");
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  batches.forEach((batch, i) => {
    const prefix = join(
      outDir,
      `${code}.${String(i + 1).padStart(String(batches.length).length > 2 ? 3 : 2, "0")}-${slug(batch.group.title)}`,
    );
    const prompt = proposalPrompt(batch);
    write(`${prefix}.propose-batch.json`, batch);
    write(`${prefix}.propose.md`, prompt);
    const tokens = Math.ceil(prompt.length / 4);
    total += tokens;
    log(
      `${prefix}: ${batch.tasks.length} tasks, prompt about ${tokens} tokens`,
    );
  });
  log(
    `${batches.length} batches, about ${total} prompt tokens in all. Files are in ${outDir}`,
  );
  return 0;
}

function check(options, { log, error }) {
  const prefix = options.subject;
  const batch = readJson(`${prefix}.propose-batch.json`, "the batch file");
  const file = readJson(`${prefix}.proposals.json`, "the proposals file");
  const { problems, tasks } = validateProposals(batch, file);
  if (problems.length > 0) {
    for (const p of problems) error(`  ${p}`);
    error(
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${prefix}.proposals.json: the model corrects only these entries.`,
    );
    return 1;
  }
  const pages = [...tasks.values()].reduce((n, list) => n + list.length, 0);
  const empty = batch.tasks.filter(
    (t) => !tasks.has(t.key) || tasks.get(t.key).length === 0,
  ).length;
  log(
    `${prefix}: ${tasks.size} of ${batch.tasks.length} tasks answered, ${pages} pages proposed${empty ? `, ${empty} tasks without a page` : ""}.`,
  );
  return 0;
}

async function merge(
  options,
  { env, log, error, fetchImpl, root, tmp, loadPoolsImpl },
) {
  const code = options.subject;
  const candidatesFile =
    options.candidates ??
    join(tmp, "course-candidates", `${code}.candidates.json`);
  const candidates = readJson(candidatesFile, "the candidates file");
  if (candidates.code !== code) {
    error(`${candidatesFile} is for ${candidates.code}, not ${code}.`);
    return 2;
  }
  const answersDir = options.answers ?? join(tmp, "course-propose");
  if (!existsSync(answersDir)) {
    error(`No proposals: ${answersDir} does not exist. Run prepare first.`);
    return 2;
  }
  const files = readdirSync(answersDir)
    .filter((f) => f.startsWith(`${code}.`) && f.endsWith(".proposals.json"))
    .sort();
  if (files.length === 0) {
    error(`No ${code}.*.proposals.json files in ${answersDir}.`);
    return 2;
  }
  const answers = [];
  for (const f of files) {
    const prefix = join(answersDir, f.replace(/\.proposals\.json$/, ""));
    const batch = readJson(`${prefix}.propose-batch.json`, "the batch file");
    const result = validateProposals(batch, readJson(join(answersDir, f), f));
    if (result.problems.length > 0) {
      for (const p of result.problems) error(`  ${f}: ${p}`);
      error(
        `${f} is not valid: fix it (node scripts/course-propose.mjs check ${prefix}).`,
      );
      return 1;
    }
    answers.push(result);
  }
  let loaded;
  try {
    loaded = await loadPoolsImpl({ root, env, fetchImpl });
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }
  const redirects = loaded.docs?.redirects ?? loaded.world?.redirects ?? [];
  const mergeWith = (moves) =>
    mergeProposals({
      candidates,
      answers,
      pools: loaded.pools,
      redirects: [...redirects, ...moves],
      onlyNew: options.onlyNew,
    });
  let { candidates: merged, report } = mergeWith([]);
  if (options.probe) {
    const unknown = report.unresolvedPages
      .filter((p) => p.reason === "not-found" && p.asked)
      .map((p) => p.asked);
    if (unknown.length > 0) {
      log(
        `Asking learn.microsoft.com about ${new Set(unknown).size} addresses the catalogs do not know...`,
      );
      const { moves, failed } = await probeLiveMoves({
        paths: unknown,
        fetchImpl,
        delayMs: Number(env.PROBE_DELAY_MS ?? 250),
      });
      ({ candidates: merged, report } = mergeWith(moves));
      report.probe = {
        asked: new Set(unknown).size,
        moved: moves.length,
        failed: failed.length,
      };
    }
  }
  const outFile =
    options.out ?? join(tmp, "course-candidates", `${code}.proposed.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  write(outFile, merged);
  write(`${outFile}.report.json`, report);
  const pct = (n) =>
    report.proposed ? ` (${Math.round((100 * n) / report.proposed)}%)` : "";
  log(`${report.proposed} pages proposed for ${report.tasksAnswered} tasks:`);
  log(
    `  exist: ${report.ok}${pct(report.ok)} (by address ${report.how.path}, after the catalogs' moves ${report.how.moved}, after a live redirect ${report.how.live}, module of a unit ${report.how.unit}, by title ${report.how.title})`,
  );
  log(
    `  already on the shortlist: ${report.alreadyCandidates}; new P5 candidates: ${report.added} (${report.addedByKind.docs} docs, ${report.addedByKind.module} modules, ${report.addedByKind.unit} units) for ${report.tasksWithNew} tasks`,
  );
  const reasons = (m) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  if (Object.keys(report.unresolved).length > 0)
    log(
      `  not found: ${Object.values(report.unresolved).reduce((a, b) => a + b, 0)} (${reasons(report.unresolved)})`,
    );
  if (Object.keys(report.dropped).length > 0)
    log(
      `  dropped by a hard filter: ${Object.values(report.dropped).reduce((a, b) => a + b, 0)} (${reasons(report.dropped)})`,
    );
  log(
    `Wrote ${outFile}${options.onlyNew ? " (the new P5 candidates only)" : ""}`,
  );
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
