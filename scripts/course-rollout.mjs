#!/usr/bin/env node
/**
 * The rollout table (docs/course-playbook.md, "Rollout"): every exam whose study guide the hub stores, with its
 * size, what Learn offers it, the wave it belongs to and a rough review estimate. Read-only: it builds the scope
 * map of each exam (one request for the course list, learnsync's files) and writes nothing.
 *
 *   node scripts/course-rollout.mjs [--pilot AZ-104,SC-300] [--thin N] [--picks-per-task N] [--queue-share F]
 *                                   [--minutes-per-item N] [--today YYYY-MM-DD] [--json]
 *
 * Exit code: 0 done, 2 usage or input error.
 */

import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { examStatuses } from "../src/data_files/exam-status.mjs";
import {
  fetchCourses,
  learnsyncDir,
  loadLearnsync,
  readGuides,
} from "./course-source.mjs";
import {
  DEFAULT_QUEUE_SHARE,
  DEFAULT_THIN_MODULES,
  PICKS_PER_TASK,
  describeTable,
  rolloutTable,
} from "./lib/course-rollout.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-rollout.mjs [--pilot CODE,CODE] [--thin N] [--picks-per-task N] [--queue-share F] [--minutes-per-item N] [--today YYYY-MM-DD] [--json]`;

function parseArgs(argv) {
  const options = {
    pilot: [],
    thin: DEFAULT_THIN_MODULES,
    picksPerTask: PICKS_PER_TASK,
    queueShare: DEFAULT_QUEUE_SHARE,
    minutesPerItem: null,
    today: null,
    json: false,
  };
  const number = (name, value, { min = 0, max = Infinity } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max)
      throw new Error(`${name} must be a number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (
      [
        "--pilot",
        "--thin",
        "--picks-per-task",
        "--queue-share",
        "--minutes-per-item",
        "--today",
      ].includes(arg)
    ) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      const value = argv[++i];
      if (arg === "--pilot")
        options.pilot = value
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
      else if (arg === "--today") options.today = value;
      else if (arg === "--thin") options.thin = number(arg, value, { min: 0 });
      else if (arg === "--picks-per-task")
        options.picksPerTask = number(arg, value, { min: 0.1 });
      else if (arg === "--queue-share")
        options.queueShare = number(arg, value, { min: 0, max: 1 });
      else options.minutesPerItem = number(arg, value, { min: 0.1 });
    } else throw new Error(`Unknown option or argument ${arg}`);
  }
  if (options.today && !/^\d{4}-\d{2}-\d{2}$/.test(options.today))
    throw new Error("--today must be a YYYY-MM-DD day");
  return options;
}

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
    now = () => new Date(),
    statuses = examStatuses,
    loadInputs,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const today = options.today ?? now().toISOString().slice(0, 10);

  let guides;
  let courses;
  let learnsync;
  try {
    guides = readGuides(
      env.LEARN_EXAMS_FILE ||
        join(root, "src", "data_files", "learn-exams.json"),
    );
    ({ courses, learnsync } = loadInputs
      ? await loadInputs({ root, env })
      : {
          learnsync: await loadLearnsync({
            dir: learnsyncDir({ root, env }),
            fetchImpl,
          }),
          courses: await fetchCourses(fetchImpl),
        });
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }

  const table = rolloutTable({
    guides,
    statuses,
    today,
    pilot: options.pilot,
    thinModules: options.thin,
    picksPerTask: options.picksPerTask,
    queueShare: options.queueShare,
    minutesPerItem: options.minutesPerItem,
    scopeOf: (code) =>
      buildScopeMap({
        code,
        courses,
        learningPaths: learnsync.content.learningPaths,
        modules: learnsync.catalog.modules,
        moduleLinks: learnsync.moduleLinks,
      }),
  });
  if (table.unknownPilot.length) {
    error(
      `No stored study guide for the pilot exam${table.unknownPilot.length > 1 ? "s" : ""} ${table.unknownPilot.join(", ")}.`,
    );
    return 2;
  }
  if (options.json) {
    log(JSON.stringify(table, null, 2));
    return 0;
  }
  for (const w of learnsync.warnings ?? []) log(`warning: ${w}`);
  for (const l of describeTable(table, {
    minutesPerItem: options.minutesPerItem,
  }))
    log(l);
  log(
    `\n${table.rows.length} exams. The estimates assume ${options.picksPerTask} picks per task and ${Math.round(options.queueShare * 100)}% of the picks in the queue; the pilot replaces both with measured numbers.`,
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
