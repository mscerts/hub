#!/usr/bin/env node
/**
 * The judging protocol (docs/course-judging.md): turn the candidates of an exam into prompts for an AI judge,
 * check the judge's answers mechanically, and merge them with a skeptic's. No AI runs here: the prompts are
 * files a person or an agent session gives to a model, and the answers are files they save back.
 *
 *   node scripts/course-judge.mjs prepare <CODE> [--candidates FILE] [--group TEXT] [--out DIR] [--max-candidates N]
 *       One batch per skill group of the candidates file (scripts/course-candidates.mjs), with the text a judge
 *       may quote: <prefix>.batch.json and <prefix>.judge.md (prompt) in DIR (default <tmp>/course-judge),
 *       where <prefix> is <CODE>.<nn>-<group>. A group with more than N candidates (default 150, so that a
 *       prompt stays within one session) is cut into parts <CODE>.<nn>-<group>-p<k>of<n>, each judged on its
 *       own; nothing is left out. Prints the size of each prompt (a rough token count).
 *   node scripts/course-judge.mjs check <prefix>
 *       Validates <prefix>.judgments.json against the batch: every candidate judged once, a verdict, a reason, a
 *       relation for a supporting pick, and for every pick a quote that is really in the evidence. Exit 1 when
 *       something is wrong (the judge redoes those entries).
 *   node scripts/course-judge.mjs skeptic <prefix> [--keep-unverified]
 *       Writes <prefix>.skeptic-batch.json and <prefix>.skeptic.md for the picks of a clean judgments file.
 *   node scripts/course-judge.mjs merge <prefix> [--no-skeptic] [--keep-unverified]
 *       Validates <prefix>.judgments.json and <prefix>.skeptic.json and writes <prefix>.judged.json: every
 *       candidate with both answers and whether they agree.
 *
 * Exit code: 0 done, 1 an answer is not valid, 2 usage or input error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPools } from "./course-candidates.mjs";
import { readGuides } from "./course-source.mjs";
import {
  buildBatches,
  buildSkepticBatch,
  estimateTokens,
  judgePrompt,
  mergeJudged,
  skepticPrompt,
  validateJudgments,
  validateSkeptic,
} from "./lib/course-judge.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-judge.mjs prepare <CODE> [--candidates FILE] [--group TEXT] [--out DIR] [--max-candidates N]
       node scripts/course-judge.mjs check <prefix>
       node scripts/course-judge.mjs skeptic <prefix> [--keep-unverified]
       node scripts/course-judge.mjs merge <prefix> [--no-skeptic] [--keep-unverified]`;

const COMMANDS = ["prepare", "check", "skeptic", "merge"];

function parseArgs(argv) {
  const options = {
    command: null,
    subject: null,
    candidates: null,
    group: null,
    out: null,
    maxCandidates: null,
    keepUnverified: false,
    noSkeptic: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep-unverified") options.keepUnverified = true;
    else if (arg === "--no-skeptic") options.noSkeptic = true;
    else if (arg === "--max-candidates") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(
          "--max-candidates must be a whole number of at least 1",
        );
      options.maxCandidates = n;
    } else if (["--candidates", "--group", "--out"].includes(arg)) {
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
      options.command === "prepare"
        ? "An exam code is required"
        : "A file prefix is required",
    );
  if (options.command === "prepare")
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

/** The problems of a validated answer as lines; a quote that is not in the evidence is one unless it is kept. */
function problemLines(result, { keepUnverified }) {
  const lines = result.errors.map((e) => `  ${e}`);
  if (!keepUnverified)
    for (const u of result.unverified)
      lines.push(
        `  ${u.task} | ${u.target}: the quote is not in the evidence: "${u.quote}"`,
      );
  return lines;
}

const hasProblems = (result, { keepUnverified }) =>
  result.errors.length > 0 || (!keepUnverified && result.unverified.length > 0);

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
      return await prepare(options, {
        env,
        log,
        error,
        fetchImpl,
        root,
        tmp,
        loadPoolsImpl,
      });
    return afterwards(options, { log, error });
  } catch (e) {
    error(e.message);
    return 2;
  }
}

async function prepare(
  options,
  { env, log, error, fetchImpl, root, tmp, loadPoolsImpl },
) {
  const code = options.subject;
  const candidatesFile =
    options.candidates ??
    join(tmp, "course-candidates", `${code}.candidates.json`);
  if (!existsSync(candidatesFile)) {
    error(
      `No candidates file for ${code}: ${candidatesFile}. Run node scripts/course-candidates.mjs ${code} first.`,
    );
    return 2;
  }
  const candidates = readJson(candidatesFile, "the candidates file");
  if (candidates.code !== code) {
    error(`${candidatesFile} is for ${candidates.code}, not ${code}.`);
    return 2;
  }
  const guides = readGuides(
    env.LEARN_EXAMS_FILE || join(root, "src", "data_files", "learn-exams.json"),
  );
  const guide = guides.get(code);
  if (!guide) {
    error(`No stored study guide text for ${code}.`);
    return 2;
  }
  if (candidates.inputs?.guideHash !== guide.hash)
    log(
      `warning: the candidates were built from another study guide text than the stored one: run course-candidates again`,
    );
  let loaded;
  try {
    loaded = await loadPoolsImpl({ root, env, fetchImpl });
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }
  let batches = buildBatches({
    candidates,
    pools: loaded.pools,
    exam: { code, name: guide.name ?? null },
    ...(options.maxCandidates ? { maxCandidates: options.maxCandidates } : {}),
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
  const outDir = options.out ?? join(tmp, "course-judge");
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  batches.forEach((batch, i) => {
    const prefix = join(
      outDir,
      `${code}.${String(i + 1).padStart(String(batches.length).length > 2 ? 3 : 2, "0")}-${slug(batch.group.title)}${batch.part ? `-p${batch.part.n}of${batch.part.of}` : ""}`,
    );
    const prompt = judgePrompt(batch);
    write(`${prefix}.batch.json`, batch);
    write(`${prefix}.judge.md`, prompt);
    const count = batch.tasks.reduce((n, t) => n + t.candidates.length, 0);
    const tokens = estimateTokens(prompt);
    total += tokens;
    log(
      `${prefix}: ${batch.tasks.length} tasks, ${count} candidates, prompt about ${tokens} tokens`,
    );
  });
  log(
    `${batches.length} batches, about ${total} prompt tokens in all (judge run once; a skeptic run is smaller: it sees the picks only). Files are in ${outDir}`,
  );
  return 0;
}

function afterwards(options, { log, error }) {
  const prefix = options.subject;
  const batch = readJson(`${prefix}.batch.json`, "the batch file");
  const judgmentsFile = `${prefix}.judgments.json`;
  const judged = validateJudgments(
    batch,
    readJson(judgmentsFile, "the judgments file"),
  );

  if (options.command === "check") {
    const lines = problemLines(judged, options);
    if (lines.length === 0 && !hasProblems(judged, options)) {
      const picks = [...judged.items.values()].filter(
        (i) => i.judgment.verdict !== "reject",
      ).length;
      log(
        `${prefix}: ${judged.items.size} candidates judged, ${picks} picks, every quote is in the evidence.`,
      );
      return 0;
    }
    log(`${prefix}: the judgments need another pass:`);
    for (const l of lines) log(l);
    return 1;
  }

  if (hasProblems(judged, options)) {
    error(
      `The judgments are not valid (run check ${prefix}); nothing was written.`,
    );
    for (const l of problemLines(judged, options)) error(l);
    return 1;
  }

  if (options.command === "skeptic") {
    const skBatch = buildSkepticBatch(batch, judged);
    const picks = skBatch.tasks.reduce((n, t) => n + t.candidates.length, 0);
    if (picks === 0) {
      log(
        `${prefix}: the judge picked nothing, so there is nothing to challenge.`,
      );
      return 0;
    }
    const prompt = skepticPrompt(skBatch);
    write(`${prefix}.skeptic-batch.json`, skBatch);
    write(`${prefix}.skeptic.md`, prompt);
    log(
      `${prefix}: ${picks} picks to challenge, prompt about ${estimateTokens(prompt)} tokens. Give ${prefix}.skeptic.md to a fresh model (not the judge) and save its JSON as ${prefix}.skeptic.json.`,
    );
    return 0;
  }

  // merge
  let skeptic = null;
  if (!options.noSkeptic) {
    const skBatchFile = `${prefix}.skeptic-batch.json`;
    const tasksWithPicks = buildSkepticBatch(batch, judged).tasks.length;
    if (tasksWithPicks > 0) {
      if (!existsSync(skBatchFile)) {
        error(
          `No skeptic batch: run skeptic ${prefix}, or merge with --no-skeptic.`,
        );
        return 2;
      }
      skeptic = validateSkeptic(
        readJson(skBatchFile, "the skeptic batch"),
        readJson(`${prefix}.skeptic.json`, "the skeptic file"),
      );
      if (hasProblems(skeptic, options)) {
        error(`The skeptic's answers are not valid; nothing was written.`);
        for (const l of problemLines(skeptic, options)) error(l);
        return 1;
      }
    }
  }
  const out = mergeJudged(batch, judged, skeptic);
  write(`${prefix}.judged.json`, out);
  const s = out.stats;
  log(
    `${prefix}: ${s.candidates} candidates: ${s.core} core, ${s.supporting} supporting, ${s.reject} reject; skeptic agrees on ${s.agree}, disagrees on ${s.disagree}${s.unverifiedQuotes ? `; ${s.unverifiedQuotes} unverified quotes kept` : ""}. Wrote ${prefix}.judged.json`,
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
