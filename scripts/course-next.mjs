#!/usr/bin/env node
/**
 * The upcoming course of an exam: carry the course in force forward to the study guide's upcoming version and
 * build only what is new (docs/course-next.md, docs/courses.md).
 *
 *   node scripts/course-next.mjs build <CODE> [--version N] [--write] [--force]
 *       Plans the upcoming course from src/data_files/courses/<CODE>.json and the upcoming version of the guide
 *       (the newest version of its history when that is dated ahead, or --version N): which tasks carry over,
 *       which are reworded (and need a look), which are new, which leave. With --write it writes
 *       src/data_files/courses/<CODE>.next.json. A rewrite (more than half of the tasks new or reworded, or a
 *       domain or group appeared or went) is not patched: the whole pipeline is the way, unless --force says so.
 *   node scripts/course-next.mjs status <CODE>
 *       What is left in the upcoming course before it may be shown: tasks to build, reworded tasks to confirm,
 *       groups without fundamentals.
 *   node scripts/course-next.mjs confirm <CODE> (--all | TASKKEY...)
 *       The carried picks of these reworded tasks still fit.
 *   node scripts/course-next.mjs reject <CODE> TASKKEY
 *       The carried picks of this reworded task do not fit: they go and the task is built like a new one.
 *   node scripts/course-next.mjs merge <CODE> --from FILE
 *       Takes the picks the pipeline built for the tasks and groups still to be built from FILE (a course file
 *       of the same exam, built from the same version of the guide) into the upcoming course.
 *
 * Nothing is written without --write (build) or by the other commands, which change the upcoming file only.
 * Exit code: 0 done, 1 the change is a rewrite or the file would not be valid, 2 usage or input problem.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { versionState } from "../src/utils/guide-changes/state.mjs";
import {
  CARRY_SIMILARITY,
  buildNext,
  confirmPending,
  isComplete,
  mergeBuilt,
  rejectPending,
} from "./lib/course-next.mjs";
import { NEXT_SUFFIX, validateCourse } from "./lib/course-format.mjs";
import { findVersion, guideOfVersion } from "./lib/course-version.mjs";
import { readHistory } from "./lib/guide-history.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-next.mjs build <CODE> [--version N] [--write] [--force]
       node scripts/course-next.mjs status <CODE>
       node scripts/course-next.mjs confirm <CODE> (--all | TASKKEY...)
       node scripts/course-next.mjs reject <CODE> TASKKEY
       node scripts/course-next.mjs merge <CODE> --from FILE`;

const COMMANDS = ["build", "status", "confirm", "reject", "merge"];

function parseArgs(argv) {
  const [command, code, ...rest] = argv;
  const options = {
    command,
    code: code?.toUpperCase(),
    version: null,
    write: false,
    force: false,
    all: false,
    from: null,
    keys: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--version" || arg === "--from") {
      if (rest[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = rest[++i];
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.keys.push(arg);
  }
  if (
    !COMMANDS.includes(command) ||
    !/^[A-Z]{2,3}-\d{3}$/.test(options.code ?? "")
  )
    throw new Error(
      `A command (${COMMANDS.join(", ")}) and an exam code are required`,
    );
  if (options.version !== null && !/^\d+$/.test(options.version))
    throw new Error("--version needs a version number of the guide's history");
  return options;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** The lines a person reads about what is left in an upcoming course. */
export function pendingLines(next) {
  const p = next.pending ?? {};
  const lines = [];
  if (p.added?.length) {
    lines.push(`${p.added.length} tasks to build (they have no picks yet):`);
    for (const key of p.added) lines.push(`  ${key}`);
  }
  if (p.confirm?.length) {
    lines.push(
      `${p.confirm.length} reworded tasks whose carried picks need a look (confirm or reject):`,
    );
    for (const c of p.confirm)
      lines.push(
        `  ${c.key}\n    was: ${c.was} (${Math.round(c.similarity * 100)}% of the words)`,
      );
  }
  if (p.foundations?.length) {
    lines.push(`${p.foundations.length} groups without fundamentals:`);
    for (const key of p.foundations) lines.push(`  ${key}`);
  }
  return lines.length
    ? lines
    : ["Nothing is left: the upcoming course is complete."];
}

/**
 * The command line, dependencies injectable. `now` is the day the version state is read on (tests set it).
 */
export function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    root = repoRoot,
    now = env.TODAY ? new Date(`${env.TODAY}T12:00:00Z`) : new Date(),
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { code } = options;
  const dir = join(root, "src", "data_files", "courses");
  const currentFile = join(dir, `${code}.json`);
  const nextFile = join(dir, `${code}${NEXT_SUFFIX}.json`);
  const historyDir =
    env.HISTORY_DIR || join(root, "src", "data_files", "study-guide-history");
  const today = now.toISOString().slice(0, 10);

  const load = (file, what) => {
    if (!existsSync(file)) {
      error(`There is no ${what}: ${file}`);
      return null;
    }
    try {
      return readJson(file);
    } catch (e) {
      error(`Cannot read ${file}: ${e.message}`);
      return null;
    }
  };
  let history;
  try {
    history = readHistory(historyDir, code);
  } catch (e) {
    error(`The study guide history of ${code} cannot be read: ${e.message}`);
    return 2;
  }
  /** Validate an upcoming course against the version it names; returns the errors. */
  const problemsOf = (next) => {
    const version = findVersion(history, next.inputs?.guideVersion);
    const guide = version ? guideOfVersion(version) : undefined;
    return validateCourse(next, { guide, history, next: true }).errors;
  };

  if (options.command === "build") {
    const course = load(currentFile, "course");
    if (!course) return 2;
    if (!course.inputs?.guideVersion) {
      error(
        `${code}: the course does not name its guide version (inputs.guideVersion). Run node scripts/course-versions-backfill.mjs --write.`,
      );
      return 2;
    }
    if (!history.versions?.length) {
      error(`${code}: no version of the study guide is recorded.`);
      return 2;
    }
    const state = versionState(history, now);
    const target =
      options.version !== null
        ? history.versions.find((v) => v.n === Number(options.version))
        : state.upcoming;
    if (!target) {
      log(
        options.version !== null
          ? `${code}: the history has no version ${options.version}.`
          : `${code}: no version of the study guide is dated ahead, so there is no upcoming course to build.`,
      );
      return options.version !== null ? 2 : 0;
    }
    const guide = guideOfVersion(target);
    if (!guide.ok) {
      error(
        `${code}: version ${target.n} of the guide does not parse completely.`,
      );
      return 2;
    }
    if (target.n === course.inputs.guideVersion.n) {
      log(
        `${code}: the course already follows version ${target.n}; nothing to carry forward.`,
      );
      return 0;
    }
    const result = buildNext({
      course,
      guide,
      version: target,
      today,
      force: options.force,
    });
    const c = result.plan.counts;
    log(
      `${code}: version ${course.inputs.guideVersion.n} to ${target.n} (as of ${target.asOf ?? "not stated"}): ${c.same} tasks the same, ${c.moved} moved, ${c.reworded} reworded, ${c.added} new, ${c.removed} leaving.`,
    );
    if (!result.ok) {
      error(
        `This is a rewrite, not an update, so the course is not patched (build it with the whole pipeline, docs/course-build.md):`,
      );
      for (const reason of result.plan.major) error(`  ${reason}`);
      return 1;
    }
    if (result.plan.major)
      log(`  --force: patching although ${result.plan.major.join("; ")}`);
    const problems = problemsOf(result.next);
    if (problems.length) {
      error(`The upcoming course would not be valid; nothing was written:`);
      for (const p of problems) error(`  ${p}`);
      return 1;
    }
    const r = result.report;
    log(
      `${r.carried} tasks carry their picks (${r.confirm.length} reworded ones under ${Math.round(CARRY_SIMILARITY * 100)}% of the words to confirm); ${r.added.length} to build; ${r.removed.length} leave; ${r.foundations.length} groups need fundamentals.${r.audienceChanged ? " The audience profile changed: look at it." : ""}`,
    );
    for (const line of pendingLines(result.next)) log(line);
    if (!options.write) {
      log("Not written (add --write).");
      return 0;
    }
    if (existsSync(nextFile) && !options.force) {
      error(
        `${nextFile} exists; --force replaces it (its pending list and merged picks are lost).`,
      );
      return 1;
    }
    writeJson(nextFile, result.next);
    log(`Wrote ${nextFile}`);
    return 0;
  }

  const next = load(nextFile, "upcoming course (run build --write first)");
  if (!next) return 2;

  if (options.command === "status") {
    const version = next.inputs?.guideVersion;
    log(
      `${code}: upcoming course for version ${version?.n} (as of ${version?.asOf ?? "not stated"}).`,
    );
    for (const line of pendingLines(next)) log(line);
    const problems = problemsOf(next);
    for (const p of problems) log(`  error: ${p}`);
    return problems.length ? 1 : 0;
  }

  let changed = next;
  if (options.command === "confirm") {
    if (!options.all && options.keys.length === 0) {
      error("confirm needs --all or at least one task key");
      return 2;
    }
    const r = confirmPending(next, { keys: options.keys, all: options.all });
    if (r.unknown.length) {
      error(`Not waiting for confirmation: ${r.unknown.join(", ")}`);
      return 2;
    }
    changed = r.next;
    log(
      `Confirmed ${r.confirmed} reworded task${r.confirmed === 1 ? "" : "s"}.`,
    );
  } else if (options.command === "reject") {
    if (options.keys.length !== 1) {
      error("reject needs exactly one task key");
      return 2;
    }
    const r = rejectPending(next, options.keys[0]);
    if (!r.rejected) {
      error(`Not waiting for confirmation: ${options.keys[0]}`);
      return 2;
    }
    changed = r.next;
    log("Dropped the carried picks; the task is now to be built.");
  } else if (options.command === "merge") {
    if (!options.from) {
      error("merge needs --from FILE");
      return 2;
    }
    const built = load(resolve(options.from), "built course");
    if (!built) return 2;
    if (built.code !== code) {
      error(`${options.from} is the course of ${built.code}, not ${code}.`);
      return 2;
    }
    const r = mergeBuilt(next, built);
    changed = r.next;
    log(
      `Merged the picks of ${r.merged.tasks.length} tasks and the fundamentals of ${r.merged.groups.length} groups.`,
    );
    if (r.missing.length) {
      log(`Still to build (the built course has no picks for them):`);
      for (const key of r.missing) log(`  ${key}`);
    }
  }
  const problems = problemsOf(changed);
  if (problems.length) {
    error("The upcoming course would not be valid; nothing was written:");
    for (const p of problems) error(`  ${p}`);
    return 1;
  }
  writeJson(nextFile, changed);
  log(isComplete(changed) ? "The upcoming course is complete." : "Left to do:");
  if (!isComplete(changed)) for (const line of pendingLines(changed)) log(line);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
