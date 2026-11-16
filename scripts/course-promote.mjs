#!/usr/bin/env node
/**
 * Let the upcoming course of an exam take over (docs/course-next.md).
 *
 *   node scripts/course-promote.mjs <CODE> [--write] [--force]
 *
 * From the day the upcoming skills count the page already shows only the upcoming course (the build and the
 * browser decide); what is left is the files. Without --write this says what it would do. With --write it:
 *   1. writes src/data_files/courses/<CODE>.next.json as src/data_files/courses/<CODE>.json (the course in force
 *      stays in the history of git),
 *   2. deletes <CODE>.next.json,
 *   3. moves the decision list (src/data_files/course-decisions/<CODE>.json) to the new task keys and drops the
 *      decisions of tasks and groups that are gone,
 *   4. renders the page of the course (src/content/docs/courses/<code>.mdx) again, now with the new course alone.
 * It refuses when the upcoming course is not valid against the version it names, is not complete, or the day its
 * skills count from has not come (--force skips the day, for the one case where the version states none).
 * Exit code: 0 done (or only said), 1 refused, 2 usage or input problem.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main as renderMain } from "./course-file.mjs";
import { NEXT_SUFFIX, validateCourse } from "./lib/course-format.mjs";
import { validateDecisions } from "./lib/course-gates.mjs";
import {
  isComplete,
  rekeyBetween,
  rekeyDecisions,
} from "./lib/course-next.mjs";
import { findVersion, guideOfVersion } from "./lib/course-version.mjs";
import { readHistory } from "./lib/guide-history.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage: node scripts/course-promote.mjs <CODE> [--write] [--force]";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    root = repoRoot,
    now = env.TODAY ? new Date(`${env.TODAY}T12:00:00Z`) : new Date(),
  } = deps;
  const [codeArg, ...rest] = argv;
  const code = codeArg?.toUpperCase();
  const flags = new Set(rest);
  const unknown = rest.filter((a) => !["--write", "--force"].includes(a));
  if (!/^[A-Z]{2,3}-\d{3}$/.test(code ?? "") || unknown.length) {
    error(`${unknown.length ? `Unknown option ${unknown[0]}\n` : ""}${USAGE}`);
    return 2;
  }
  const write = flags.has("--write");
  const force = flags.has("--force");
  const today = now.toISOString().slice(0, 10);
  const dir = join(root, "src", "data_files", "courses");
  const currentFile = join(dir, `${code}.json`);
  const nextFile = join(dir, `${code}${NEXT_SUFFIX}.json`);
  const decisionsFile = join(
    root,
    "src",
    "data_files",
    "course-decisions",
    `${code}.json`,
  );
  const pageFile = join(
    root,
    "src",
    "content",
    "docs",
    "courses",
    `${code.toLowerCase()}.mdx`,
  );

  let current;
  let next;
  let history;
  try {
    for (const [file, what] of [
      [currentFile, "course"],
      [nextFile, "upcoming course"],
    ])
      if (!existsSync(file)) {
        error(`There is no ${what}: ${file}`);
        return 2;
      }
    current = readJson(currentFile);
    next = readJson(nextFile);
    history = readHistory(
      env.HISTORY_DIR || join(root, "src", "data_files", "study-guide-history"),
      code,
    );
  } catch (e) {
    error(`Cannot read the files of ${code}: ${e.message}`);
    return 2;
  }

  const version = findVersion(history, next.inputs?.guideVersion);
  const problems = [];
  const checked = validateCourse(next, {
    guide: version ? guideOfVersion(version) : undefined,
    history,
    next: true,
  });
  problems.push(...checked.errors);
  if (!isComplete(next))
    problems.push(
      "the upcoming course is not complete (node scripts/course-next.mjs status " +
        code +
        ")",
    );
  const effective = version?.asOf ?? null;
  if (!force && !effective)
    problems.push(
      "the upcoming version states no day its skills count from (--force takes over anyway)",
    );
  if (!force && effective && effective > today)
    problems.push(
      `the upcoming skills count from ${effective}, which has not come (today is ${today})`,
    );
  if (problems.length) {
    error(`${code}: the upcoming course cannot take over:`);
    for (const p of problems) error(`  ${p}`);
    return 1;
  }

  // the course as it will be: the upcoming course alone, which must be valid on its own against its version
  const { pending: _done, ...promoted } = next;
  const alone = validateCourse(promoted, {
    guide: guideOfVersion(version),
    history,
  });
  if (!alone.ok) {
    error(
      `${code}: the upcoming course would not be valid as the course in force:`,
    );
    for (const e of alone.errors) error(`  ${e}`);
    return 1;
  }

  const rekey = rekeyBetween(current, promoted);
  let decisions = null;
  let moved = 0;
  let dropped = 0;
  if (existsSync(decisionsFile)) {
    const result = rekeyDecisions(readJson(decisionsFile), rekey);
    const bad = validateDecisions(result.store, code);
    if (bad.length) {
      error(`${code}: the decision list would not be valid after the move:`);
      for (const b of bad) error(`  ${b}`);
      return 1;
    }
    decisions = result.store;
    moved = result.moved;
    dropped = result.dropped;
  }

  log(
    `${code}: the upcoming course (version ${next.inputs.guideVersion.n}, as of ${effective ?? "not stated"}) takes over from version ${current.inputs?.guideVersion?.n ?? "?"}.`,
  );
  log(
    `Decisions: ${moved} moved to new keys, ${dropped} dropped (tasks or groups that are gone)${decisions ? "" : "; there is no decision list"}.`,
  );
  log(
    existsSync(pageFile)
      ? `The page ${pageFile} is rendered again with the new course alone.`
      : "The course has no page: nothing to render.",
  );
  if (!write) {
    log("Not written (add --write).");
    return 0;
  }

  writeJson(currentFile, promoted);
  unlinkSync(nextFile);
  if (decisions && (moved || dropped)) writeJson(decisionsFile, decisions);
  log(`Wrote ${currentFile} and removed ${nextFile}.`);
  if (existsSync(pageFile)) {
    const rendered = await renderMain(["render", code, "--out", pageFile], {
      env,
      root,
      log,
      error,
      write() {},
    });
    if (rendered !== 0) {
      error(
        `${code}: the files took over but the page was not rendered (exit ${rendered}); run node scripts/course-file.mjs render ${code} --out ${pageFile}.`,
      );
      return 1;
    }
  }
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
