#!/usr/bin/env node
/**
 * Measuring the pilot (docs/course-playbook.md): the gold set, the review sample and the pass criteria.
 *
 *   node scripts/course-pilot.mjs gold-template <course.mdx|course.json> [--code CODE] [--size 25] [--seed N]
 *                                 [--include TEXT]... [--out FILE]
 *       Draws a sample of the picks of an existing course (the hand-made AZ-104 page, or a course file) for the
 *       maintainer to mark keep or drop BEFORE the pipeline runs on the same tasks. --include TEXT forces in the
 *       picks whose address or title contains TEXT (the entitlement management card).
 *   node scripts/course-pilot.mjs sample <CODE> [--gated FILE] [--size 40] [--seed N] [--out FILE]
 *       Draws a random sample of what the gates accepted on their own, for the maintainer to mark right or wrong.
 *   node scripts/course-pilot.mjs measure <CODE> [--gated FILE] [--gold FILE] [--sample FILE]
 *                                 [--min-correct 0.95] [--max-queue 0.25] [--min-keep 0.9]
 *       The pass criteria in numbers: the share of automatic acceptances that are right (the reviewed sample),
 *       the share of the judge's picks that waited in the queue, the gold set's keeps that the pipeline kept or
 *       asked about and its drops that the gates accepted on their own (must be none).
 *
 * Files are written to <tmp>/course-pilot/ unless --out says otherwise; nothing is written into the repository.
 * Exit code: 0 (measure) every criterion measured and passed, 1 a criterion failed or is not measured yet,
 * 2 usage or input error.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readGuides } from "./course-source.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import {
  CRITERIA,
  drawGoldSample,
  drawReviewSample,
  goldAgreement,
  goldTemplate,
  picksFromCourseFile,
  picksFromCourseMdx,
  queueShare,
  scoreReviewSample,
} from "./lib/course-pilot.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-pilot.mjs gold-template <course.mdx|course.json> [--code CODE] [--size N] [--seed N] [--include TEXT]... [--out FILE]
       node scripts/course-pilot.mjs sample <CODE> [--gated FILE] [--size N] [--seed N] [--out FILE]
       node scripts/course-pilot.mjs measure <CODE> [--gated FILE] [--gold FILE] [--sample FILE] [--min-correct F] [--max-queue F] [--min-keep F]`;
const COMMANDS = ["gold-template", "sample", "measure"];
/** Below this many marked items a score hardly tells 95% from 85%. */
const SMALL_SAMPLE = 30;

function parseArgs(argv) {
  const options = {
    command: null,
    target: null,
    code: null,
    size: null,
    seed: 1,
    include: [],
    out: null,
    gated: null,
    gold: null,
    sample: null,
    minCorrect: CRITERIA.minCorrect,
    maxQueue: CRITERIA.maxQueueShare,
    minKeep: CRITERIA.minKeepRetained,
  };
  const positional = [];
  const fraction = (name, value) => {
    const n = Number(value);
    if (!(n >= 0 && n <= 1)) throw new Error(`${name} must be from 0 to 1`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      [
        "--code",
        "--size",
        "--seed",
        "--include",
        "--out",
        "--gated",
        "--gold",
        "--sample",
        "--min-correct",
        "--max-queue",
        "--min-keep",
      ].includes(arg)
    ) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      const value = argv[++i];
      if (arg === "--include") options.include.push(value);
      else if (arg === "--size") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1)
          throw new Error("--size must be a whole number of at least 1");
        options.size = n;
      } else if (arg === "--seed") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0)
          throw new Error("--seed must be a whole number");
        options.seed = n;
      } else if (arg === "--min-correct")
        options.minCorrect = fraction(arg, value);
      else if (arg === "--max-queue") options.maxQueue = fraction(arg, value);
      else if (arg === "--min-keep") options.minKeep = fraction(arg, value);
      else options[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length === 0) throw new Error("A command is required");
  if (!COMMANDS.includes(positional[0]))
    throw new Error(`Unknown command ${positional[0]}`);
  if (positional.length < 2)
    throw new Error(
      positional[0] === "gold-template"
        ? "A course file is required"
        : "An exam code is required",
    );
  if (positional.length > 2) throw new Error("Too many arguments");
  options.command = positional[0];
  options.target = positional[1];
  return options;
}

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(
      e.code === "ENOENT"
        ? `${what} not found: ${file}`
        : `${what} is not valid JSON (${file}): ${e.message}`,
    );
  }
};
const write = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** The exam code in a course file's name: az-104course.mdx, AZ-104.json. */
export const codeFromFileName = (file) =>
  /^([a-z]{2}-\d{3})/i.exec(file.split(/[\\/]/).pop())?.[1].toUpperCase() ??
  null;

const percent = (share) =>
  share === null || share === undefined
    ? "n/a"
    : `${Math.round(share * 1000) / 10}%`;

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    root = repoRoot,
    tmp = tmpdir(),
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const pilotDir = join(tmp, "course-pilot");

  try {
    if (options.command === "gold-template") {
      const file = resolve(options.target);
      const code = (options.code ?? codeFromFileName(file) ?? "").toUpperCase();
      if (!code)
        throw new Error(
          "The exam code is not in the file name: give it with --code",
        );
      const stored = readGuides(
        env.LEARN_EXAMS_FILE ||
          join(root, "src", "data_files", "learn-exams.json"),
      ).get(code);
      if (!stored) throw new Error(`No stored study guide text for ${code}.`);
      const guide = parseGuide(stored.lines);
      let found;
      if (file.endsWith(".json"))
        found = picksFromCourseFile(readJson(file, "the course file"));
      else {
        let mdx;
        try {
          mdx = readFileSync(file, "utf8");
        } catch (e) {
          throw new Error(`Cannot read ${file}: ${e.message}`);
        }
        found = picksFromCourseMdx(mdx, guide);
      }
      if (found.picks.length === 0)
        throw new Error(
          `${file} has no picks that match a task of the ${code} study guide.`,
        );
      const size = options.size ?? 25;
      const sample = drawGoldSample(found.picks, {
        size,
        seed: options.seed,
        include: options.include,
      });
      const missing = options.include.filter(
        (text) =>
          !sample.some((p) =>
            `${p.target.path} ${p.title}`
              .toLowerCase()
              .includes(text.toLowerCase()),
          ),
      );
      if (missing.length)
        throw new Error(
          `No pick of the course contains "${missing.join('", "')}": check the spelling of --include.`,
        );
      const gold = goldTemplate({ code, source: file, picks: sample });
      const out = resolve(options.out ?? join(pilotDir, `${code}.gold.json`));
      write(out, gold);
      log(
        `${code}: ${sample.length} of ${found.picks.length} picks drawn (seed ${options.seed}) from ${gold.groups.length} skill groups.`,
      );
      if (found.unmatched.length)
        log(
          `warning: ${found.unmatched.length} tasks of the course page are not in the study guide (their picks are left out): ${found.unmatched.slice(0, 3).join("; ")}${found.unmatched.length > 3 ? "; ..." : ""}`,
        );
      log(`Wrote ${out}`);
      log(
        'Mark every pick "keep" or "drop" (field "mark") BEFORE the pipeline runs on these groups, then run it blind.',
      );
      return 0;
    }

    const code = options.target.toUpperCase();
    const gatedFile = resolve(
      options.gated ?? join(tmp, "course-gates", `${code}.gated.json`),
    );
    const gated = readJson(gatedFile, "the gated file");
    if (gated.kind !== "gated" || !Array.isArray(gated.items))
      throw new Error(`${gatedFile} is not a gated file.`);
    if (gated.code !== code)
      throw new Error(`${gatedFile} is for ${gated.code}, not ${code}.`);

    if (options.command === "sample") {
      const size = options.size ?? 40;
      const sample = drawReviewSample(gated, { size, seed: options.seed });
      if (sample.items.length === 0)
        throw new Error(
          `${code}: the gates accepted nothing on their own, so there is nothing to sample.`,
        );
      const out = resolve(options.out ?? join(pilotDir, `${code}.sample.json`));
      write(out, sample);
      log(
        `${code}: ${sample.items.length} of ${sample.population} automatic acceptances drawn (seed ${options.seed}).`,
      );
      if (sample.items.length < SMALL_SAMPLE)
        log(
          "warning: a sample this small hardly tells 95% from 85%; the score prints how far to trust it.",
        );
      log(`Wrote ${out}`);
      log(
        'Open each "url" and set "correct" to true or false. The question: is this page right for the task, as the class and relation say?',
      );
      return 0;
    }

    // measure
    const results = [];
    const queue = queueShare(gated);
    log(
      `${code}: ${gated.items.length} candidates: ${queue.accepted} accepted (${queue.acceptedByGates} by the gates alone), ${queue.queued} queued, ${queue.rejected} rejected.`,
    );
    results.push({
      name: "queue share",
      line: `the queue holds ${percent(queue.share)} of the judge's picks (limit ${percent(options.maxQueue)})`,
      pass: queue.share === null ? null : queue.share <= options.maxQueue,
    });

    if (options.sample) {
      const score = scoreReviewSample(
        readJson(resolve(options.sample), "the review sample"),
        { minCorrect: options.minCorrect },
      );
      if (score.problems.length) {
        error("The review sample is not valid:");
        for (const p of score.problems) error(`  ${p}`);
        return 2;
      }
      results.push({
        name: "automatic acceptances",
        line:
          score.pending > 0
            ? `${score.answered} of ${score.answered + score.pending} sampled acceptances marked so far: ${score.pending} still to mark`
            : `${score.correct} of ${score.answered} sampled automatic acceptances are right: ${percent(score.share)} (limit ${percent(options.minCorrect)}; at 95% confidence it could be as low as ${percent(score.lowerBound)})`,
        pass: score.passes,
      });
      for (const w of score.wrongItems)
        log(
          `  wrong: ${w.task} ${w.taskText}\n         ${w.title}  ${w.url}${w.note ? `\n         ${w.note}` : ""}`,
        );
    } else
      results.push({
        name: "automatic acceptances",
        line: "not measured: draw a sample with the sample command and mark it",
        pass: null,
      });

    if (options.gold) {
      const agreement = goldAgreement(
        readJson(resolve(options.gold), "the gold file"),
        gated,
        { minKeepRetained: options.minKeep },
      );
      if (agreement.problems.length) {
        error("The gold file cannot be compared:");
        for (const p of agreement.problems) error(`  ${p}`);
        return 2;
      }
      if (agreement.keeps.total + agreement.drops.total === 0) {
        error("The gold file has no marks yet.");
        return 2;
      }
      if (agreement.unmarked)
        log(
          `warning: ${agreement.unmarked} picks of the gold file are not marked and are left out`,
        );
      const k = agreement.keeps;
      results.push({
        name: "gold keeps",
        line: `${k.total - k.lost} of ${k.total} picks marked keep were kept or queued by the pipeline (${percent(k.retainedShare)}; limit ${percent(options.minKeep)}): ${k.acceptedByGates} accepted by the gates, ${k.acceptedByMaintainer} by the maintainer's earlier decisions, ${k.queued} queued, ${k.lost} lost${k.foundAsAnotherPageOfTheModule ? `; ${k.foundAsAnotherPageOfTheModule} found as another page of the same module` : ""}`,
        pass: agreement.passes.keepsRetained,
      });
      const d = agreement.drops;
      results.push({
        name: "gold drops",
        line: `${d.falseAccepts} of ${d.total} picks marked drop were accepted by the gates on their own (must be 0); ${d.queued} queued, ${d.rejected} rejected, ${d.notCandidates} never a candidate`,
        pass: agreement.passes.noFalseAccepts,
      });
      for (const i of agreement.items.filter(
        (i) =>
          (i.mark === "keep" && !/^(accepted|queued)/.test(i.outcome)) ||
          (i.mark === "drop" && i.outcome === "accepted by the gates"),
      ))
        log(
          `  ${i.mark === "keep" ? "lost keep" : "FALSE ACCEPT"}: ${i.task} ${i.taskText}\n         ${i.title}  ${i.target.path}  (${i.outcome})${i.note ? `\n         ${i.note}` : ""}`,
        );
    } else
      results.push({
        name: "gold set",
        line: "not measured: pass --gold with the marked gold file",
        pass: null,
      });

    for (const r of results)
      log(
        `${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "----"}  ${r.name}: ${r.line}`,
      );
    log(
      "Also needed, not measured here: every pick is a current Learn page (course-build.mjs --urls --live), and the review minutes and the AI cost, which the pilot records by hand.",
    );
    return results.every((r) => r.pass === true) ? 0 : 1;
  } catch (e) {
    error(e.message);
    return 2;
  }
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
