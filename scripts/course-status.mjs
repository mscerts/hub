#!/usr/bin/env node
/**
 * The rebuild check (docs/courses.md): is a course still what its inputs say it should be, and if not, how
 * much of it has to be redone?
 *
 *   node scripts/course-status.mjs <CODE> [--urls [--live]] [--json]
 *   node scripts/course-status.mjs --all [--urls [--live]] [--json]
 *
 * It compares the course file (src/data_files/courses/<CODE>.json) with today's inputs: the study guide the
 * New Exam Monitor stores, and what Learn offers for the exam's courses (learnsync + the catalog API, as in
 * scripts/course-source.mjs). Nothing is written. Prints a rebuild plan: the tasks the guide added, removed or
 * moved, the picks whose module or listing changed, and how many tasks are untouched.
 *   current  nothing a pick relies on changed and the tasks are the same
 *   review   nothing is broken, but the exam's official course changed shape
 *   stale    tasks changed, or a pick's target is gone or no longer listed
 * --urls also asks learnsync's validator whether every pick's target is still a current Learn page
 * (--live: and learn.microsoft.com about what the caches cannot settle).
 * Exit code: 0 current or review, 1 at least one course is stale, 2 an input problem.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentFromVerdict, learnsyncVerdicts } from "./course-file.mjs";
import { fetchCourses, loadLearnsync, readGuides } from "./course-source.mjs";
import { eachPick } from "./lib/course-format.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";
import { rebuildPlan } from "./lib/course-status.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-status.mjs <CODE> [--urls [--live]] [--json]
       node scripts/course-status.mjs --all [--urls [--live]] [--json]`;
const SHOWN = 10;

function parseArgs(argv) {
  const options = {
    code: null,
    all: false,
    urls: false,
    live: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--all") options.all = true;
    else if (arg === "--urls") options.urls = true;
    else if (arg === "--live") options.live = options.urls = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  if (!options.code && !options.all)
    throw new Error("An exam code or --all is required");
  if (options.code && options.all)
    throw new Error("Give an exam code or --all, not both");
  return options;
}

const more = (list, n = SHOWN) =>
  list.length > n ? [`... and ${list.length - n} more`] : [];

/** The plan as lines of text. */
export function describePlan(plan) {
  const lines = [
    `${plan.code}: ${plan.status.toUpperCase()}${plan.reasons.length ? ` - ${plan.reasons.join("; ")}` : ""}${plan.reviewReasons.length ? ` - ${plan.reviewReasons.join("; ")}` : ""}`,
  ];
  const g = plan.guide;
  if (g.added.length) {
    lines.push(
      `  Study guide: ${g.added.length} task(s) added (they need picks)`,
    );
    for (const t of g.added.slice(0, SHOWN))
      lines.push(`    + ${t.text}  (${t.domain} > ${t.group})`);
    for (const l of more(g.added)) lines.push(`    ${l}`);
  }
  if (g.removed.length) {
    lines.push(
      `  Study guide: ${g.removed.length} task(s) removed (their picks go)`,
    );
    for (const t of g.removed.slice(0, SHOWN))
      lines.push(`    - ${t.text}  (${t.domain} > ${t.group})`);
    for (const l of more(g.removed)) lines.push(`    ${l}`);
  }
  for (const m of g.moved.slice(0, SHOWN))
    lines.push(
      `  Moved (picks carry over): ${m.from.text}  (${m.from.group} -> ${m.to.group})`,
    );
  for (const h of g.renameHints.slice(0, SHOWN))
    lines.push(
      `  Possible rename (${Math.round(h.similarity * 100)}% the same words): "${h.from.text}" -> "${h.to.text}"`,
    );
  for (const w of g.weightChanges)
    lines.push(`  Weight of "${w.domain}": ${w.from} -> ${w.to}`);
  if (g.asOf || g.hashChanged)
    lines.push(
      `  Information: the guide text changed${g.asOf ? ` (skills measured as of ${g.asOf.from ?? "?"} -> ${g.asOf.to ?? "?"})` : ""}; this alone never needs a rebuild`,
    );
  const d = plan.scope.diff;
  const modules = [
    d.modules.added.length && `${d.modules.added.length} added`,
    d.modules.removed.length && `${d.modules.removed.length} removed`,
    d.modules.contentChanged.length &&
      `${d.modules.contentChanged.length} with new content`,
    d.modules.resourcesChanged.length &&
      `${d.modules.resourcesChanged.length} with a new resource list`,
  ].filter(Boolean);
  if (modules.length)
    lines.push(
      `  Learn: modules of the official course: ${modules.join(", ")}`,
    );
  if (plan.scope.picked.missing.length || plan.scope.picked.changed.length)
    lines.push(
      `  Learn: modules outside the course that picks use: ${plan.scope.picked.missing.length} gone, ${plan.scope.picked.changed.length} changed`,
    );
  if (plan.picks.hard.length) {
    lines.push(`  Picks to replace: ${plan.picks.hard.length}`);
    for (const p of plan.picks.hard.slice(0, SHOWN))
      lines.push(`    ${p.path}  (${p.source}, ${p.taskKey}): ${p.reason}`);
    for (const l of more(plan.picks.hard)) lines.push(`    ${l}`);
  }
  if (plan.picks.soft.length) {
    lines.push(`  Picks to look at: ${plan.picks.soft.length}`);
    for (const p of plan.picks.soft.slice(0, SHOWN))
      lines.push(`    ${p.path}  (${p.source}, ${p.taskKey}): ${p.reason}`);
    for (const l of more(plan.picks.soft)) lines.push(`    ${l}`);
  }
  const w = plan.work;
  if (
    plan.status !== "current" ||
    w.tasksToBuild.length ||
    w.tasksToCheck.length
  ) {
    lines.push(
      `  Work: build ${w.tasksToBuild.length} task(s), check ${w.tasksToCheck.length}, carry over ${w.carriedOver.length}, ${w.unchanged} untouched`,
    );
  }
  return lines;
}

/**
 * The command line, dependencies injectable. Exit code: 0 current or review, 1 a course is stale, 2 input problem.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
    verdictsFor,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const dataDir = join(root, "src", "data_files", "courses");
  const files = options.all
    ? existsSync(dataDir)
      ? readdirSync(dataDir)
          .filter((f) => /^[A-Z]{2,3}-\d{3}\.json$/.test(f))
          .sort()
          .map((f) => join(dataDir, f))
      : []
    : [join(dataDir, `${options.code}.json`)];
  if (options.all && files.length === 0) {
    log("No course files: nothing to check.");
    return 0;
  }
  const courses = [];
  for (const file of files) {
    try {
      courses.push(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      error(
        `Cannot read the course file ${file}: ${e.code === "ENOENT" ? "it does not exist" : e.message}`,
      );
      return 2;
    }
  }

  let guides;
  let learnsync;
  let courseList;
  try {
    guides = readGuides(
      env.LEARN_EXAMS_FILE ||
        join(root, "src", "data_files", "learn-exams.json"),
    );
    const dir =
      env.LEARNSYNC_DIR ||
      (existsSync(join(root, "..", "learnsync", "data"))
        ? join(root, "..", "learnsync")
        : null);
    learnsync = await loadLearnsync({ dir, fetchImpl });
    courseList = await fetchCourses(fetchImpl);
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }
  let lookup = null;
  if (options.urls) {
    try {
      lookup =
        verdictsFor ??
        (await learnsyncVerdicts({
          dir: env.LEARNSYNC_DIR || join(root, "..", "learnsync"),
          live: options.live,
        }));
    } catch (e) {
      error(
        `Cannot check the URLs (${e.message}). Set LEARNSYNC_DIR to a learnsync checkout.`,
      );
      return 2;
    }
  }

  const plans = [];
  for (const course of courses) {
    const stored = guides.get(course.code);
    if (!stored) {
      error(`No stored study guide text for ${course.code}.`);
      return 2;
    }
    const guide = { ...parseGuide(stored.lines), hash: stored.hash };
    if (!guide.ok) {
      error(
        `${course.code}: the study guide does not parse completely, so the course cannot be compared with it.`,
      );
      return 2;
    }
    const scopeMap = buildScopeMap({
      code: course.code,
      courses: courseList,
      learningPaths: learnsync.content.learningPaths,
      modules: learnsync.catalog.modules,
      moduleLinks: learnsync.moduleLinks,
    });
    let isCurrent;
    if (lookup) {
      const verdicts = await lookup([
        ...new Set([...eachPick(course)].map(({ pick }) => pick.target.path)),
      ]);
      isCurrent = (path) => currentFromVerdict(verdicts.get(path));
    }
    plans.push(
      rebuildPlan({
        course,
        guide,
        scopeMap,
        catalog: learnsync.catalog.modules,
        isCurrent,
      }),
    );
  }

  if (options.json)
    log(
      JSON.stringify(
        plans.length === 1 && !options.all ? plans[0] : plans,
        null,
        2,
      ),
    );
  else {
    for (const plan of plans) for (const line of describePlan(plan)) log(line);
    if (plans.length > 1)
      log(
        `\n${plans.length} courses: ${plans.filter((p) => p.status === "stale").length} stale, ${plans.filter((p) => p.status === "review").length} to review, ${plans.filter((p) => p.status === "current").length} current`,
      );
  }
  return plans.some((p) => p.status === "stale") ? 1 : 0;
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
