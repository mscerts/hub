#!/usr/bin/env node
/**
 * Course placement (docs/course-placement.md): which exam pages a Microsoft Learn course that is not an exam's own
 * course (AI-3026, SC-5006, AZ-2008, ...) belongs on. It suggests, with the reasons; a person decides. It writes
 * nothing to the repository.
 *
 *   node scripts/course-placement.mjs <CODE>... [--json]
 *       Suggestions for the courses with these codes (AI-3026, or a course number such as AI-3026-A).
 *   node scripts/course-placement.mjs --unplaced [--json]
 *       Suggestions for every course whose short link resolves to a playlist (the Course Videos Monitor's baseline)
 *       and that has no exam page of its own code and no card on any hub page yet.
 *
 * Inputs:
 *   the guide text   src/data_files/learn-exams.json (LEARN_EXAMS_FILE), as the New Exam Monitor stores it
 *   learnsync data   a checkout in LEARNSYNC_DIR (default: ../learnsync next to this repo), else GitHub main:
 *                    learn-catalog.json, learn-content.json (the documentation files are not needed)
 *   the course list  https://learn.microsoft.com/api/catalog/?type=courses (one request)
 * Exit code: 0 done, 2 usage or input error (an unknown course code, no learnsync data, no stored guides).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchCourses,
  learnsyncDir,
  loadLearnsync,
  readGuides,
} from "./course-source.mjs";
import { buildPools } from "./lib/course-candidates.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import {
  buildGuideIndex,
  courseCode,
  courseModules,
  describeSuggestion,
  suggestExams,
} from "./lib/course-placement.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-placement.mjs <CODE>... [--json]
       node scripts/course-placement.mjs --unplaced [--json]`;

/**
 * Everything the matching reads: { learnsync, courses, pools, guides, guideIndex, skipped }. `courses` may be passed
 * when the caller has the catalog API's course list already (the Course Videos Monitor has). `guides` has the
 * exams whose stored study guide parses completely; `skipped` the codes whose guide does not.
 */
export async function loadPlacement({
  root = repoRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  courses = null,
} = {}) {
  const learnsync = await loadLearnsync({
    dir: learnsyncDir({ root, env }),
    fetchImpl,
  });
  const list = courses ?? (await fetchCourses(fetchImpl));
  const pools = buildPools({
    catalog: learnsync.catalog,
    courses: list,
    learningPaths: learnsync.content.learningPaths,
  });
  const stored = readGuides(
    env.LEARN_EXAMS_FILE || join(root, "src", "data_files", "learn-exams.json"),
  );
  const guides = new Map();
  const skipped = [];
  for (const [code, guide] of stored) {
    const tree = parseGuide(guide.lines);
    if (tree.ok) guides.set(code, { name: guide.name ?? code, tree });
    else skipped.push(code);
  }
  return {
    learnsync,
    courses: list,
    pools,
    guides,
    guideIndex: buildGuideIndex(guides),
    skipped,
  };
}

/** The first course of the catalog list with this code (or course number), or null. */
export function findCourse(courses, code) {
  const wanted = String(code).toUpperCase();
  return (
    courses.find(
      (c) => String(c.course_number ?? "").toUpperCase() === wanted,
    ) ??
    courses.find((c) => courseCode(c.course_number) === wanted) ??
    null
  );
}

/**
 * A course the catalog API does not list (AI-3016 has a short link and a playlist, but no catalog entry) as far as
 * the placement can use it: its playlist's title, which YouTube gives without a key. null when the Course Videos
 * Monitor's baseline has no playlist for the code or the title cannot be read.
 */
export async function courseFromPlaylist(
  code,
  { root = repoRoot, env = process.env } = {},
) {
  const monitor = await import("./course-videos-check.mjs");
  let playlist;
  try {
    const baseline = JSON.parse(
      readFileSync(
        env.COURSE_VIDEOS_FILE ||
          join(root, "src", "data_files", "course-videos.json"),
        "utf8",
      ),
    );
    playlist = baseline.courses?.[code]?.playlist;
  } catch {
    return null;
  }
  if (!playlist) return null;
  const info = await monitor.fetchPlaylistTitle(
    monitor.loadConfig(env),
    playlist,
  );
  if (info.state !== "ok") return null;
  // "AI-3016: Develop generative AI apps in Azure AI Foundry portal" -> the part after the code
  const title = info.title.replace(
    new RegExp(`^${code}\\s*[:\\-–—]\\s*`, "i"),
    "",
  );
  return {
    course_number: code,
    title,
    study_guide: [],
    fromPlaylist: true,
  };
}

/** Suggestions for one course of the list: { code, title, modules, unresolved, suggestions, note }. */
export function placeCourse(world, course, options) {
  const resolved = courseModules(course, {
    learningPaths: world.learnsync.content.learningPaths,
    modules: world.learnsync.catalog.modules,
  });
  const { suggestions, note } = suggestExams({
    course,
    modules: resolved.modules,
    guides: world.guides,
    guideIndex: world.guideIndex,
    pools: world.pools,
    options,
  });
  return {
    code: courseCode(course.course_number) || course.course_number,
    title: course.title ?? "",
    modules: resolved.modules.length,
    unresolved: resolved.unresolved.length,
    suggestions,
    note,
    fromPlaylist: Boolean(course.fromPlaylist),
  };
}

function parseArgs(argv) {
  const options = { codes: [], json: false, unplaced: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--unplaced") options.unplaced = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else options.codes.push(arg.toUpperCase());
  }
  if (options.unplaced === options.codes.length > 0) {
    throw new Error(
      options.unplaced
        ? "--unplaced takes no course codes"
        : "A course code or --unplaced is required",
    );
  }
  return options;
}

/**
 * The codes of the courses that resolve to a playlist, have no exam page of their own and are on no hub page:
 * the Course Videos Monitor's baseline against the exam pages and cards of the docs.
 */
async function unplacedCodes(root, env) {
  const monitor = await import("./course-videos-check.mjs");
  const docsDir = join(root, "src", "content", "docs");
  const baseline = JSON.parse(
    readFileSync(
      env.COURSE_VIDEOS_FILE ||
        join(root, "src", "data_files", "course-videos.json"),
      "utf8",
    ),
  );
  const examPages = monitor.findExamPages(docsDir);
  const cards = monitor.scanHubCards(docsDir);
  return Object.entries(baseline.courses ?? {})
    .filter(
      ([code, entry]) =>
        !examPages.has(code) &&
        !cards.some((card) =>
          monitor.cardCovers(card, code, entry.playlist, baseline.courses),
        ),
    )
    .map(([code]) => code)
    .sort();
}

function describePlacement(result) {
  const basis = result.fromPlaylist
    ? "not in the Learn catalog: matched by its playlist title only"
    : `${result.modules} ${result.modules === 1 ? "module" : "modules"}${result.unresolved ? `, ${result.unresolved} entries not resolved` : ""}`;
  const lines = [`${result.code}  ${result.title}  (${basis})`];
  if (result.suggestions.length === 0) {
    lines.push(`    no suggestion: ${result.note}`);
  }
  result.suggestions.forEach((s, i) => {
    lines.push(
      `    ${i + 1}. ${describeSuggestion(s, { groupsShown: 3 })}${s.name ? `  ${s.name}` : ""}`,
    );
  });
  return lines;
}

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  let world;
  let codes = options.codes;
  try {
    if (options.unplaced) codes = await unplacedCodes(root, env);
    world = await loadPlacement({ root, env, fetchImpl });
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }
  const results = [];
  for (const code of codes) {
    const course =
      findCourse(world.courses, code) ??
      (await courseFromPlaylist(code, { root, env }));
    if (!course) {
      error(
        `No course ${code} in the Learn catalog, and no playlist title to match it by.`,
      );
      return 2;
    }
    results.push(placeCourse(world, course));
  }
  if (options.json) {
    log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results)
      for (const line of describePlacement(result)) log(line);
    if (world.skipped.length > 0) {
      log(
        `Note: the study guide of ${world.skipped.join(", ")} does not parse completely, so ${world.skipped.length === 1 ? "that exam is" : "those exams are"} not matched.`,
      );
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
