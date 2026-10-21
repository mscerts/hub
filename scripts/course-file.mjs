#!/usr/bin/env node
/**
 * Validate a course file and render it to a course page (docs/courses.md).
 *
 *   node scripts/course-file.mjs validate <CODE|file> [--live]
 *       Checks the course file (default src/data_files/courses/<CODE>.json) against the study guide the New Exam
 *       Monitor stores and against learnsync: the tree must be the guide's tree, every pick must follow the
 *       format and approval rules, and every target must be a current Learn page (learnsync's validator;
 *       --live also asks learn.microsoft.com about what the caches cannot settle). Exit 1 on any error.
 *   node scripts/course-file.mjs render <CODE|file> [--out FILE] [--review FILE] [--group TEXT]
 *       Renders the course page (MDX) to stdout, or to FILE. The file must pass the checks that need no
 *       network; nothing is written to src/content unless --out says so. There are no draft pages: the page
 *       is an ordinary page of the site. With --review (the FILE.review.json that course-build.mjs writes) it is
 *       the review copy: the picks the judge was not sure of are orange, numbered and carry its reason. --group
 *       renders only the skill groups whose title contains TEXT (a preview of one group).
 *
 * URL checks need a learnsync checkout (LEARNSYNC_DIR, default ../learnsync) because they run its validator.
 * Nothing here writes a course file: those come from the build steps described in docs/courses.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COURSE_SCHEMA_VERSION,
  eachPick,
  validateCourse,
} from "./lib/course-format.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { AREA_BY_PREFIX } from "./lib/areas.mjs";
import { numberReview, renderCourse } from "./lib/course-render.mjs";
import { readGuides } from "./course-source.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-file.mjs validate <CODE|file> [--live]
       node scripts/course-file.mjs render <CODE|file> [--out FILE] [--review FILE] [--group TEXT]`;

/** What the validator needs to know about a learnsync verdict: is the target a current page? */
export function currentFromVerdict(verdict) {
  if (!verdict) return { ok: false, reason: "no verdict" };
  if (verdict.verdict === "valid") return { ok: true };
  const where = verdict.redirectsTo ? ` to ${verdict.redirectsTo}` : "";
  return {
    ok: false,
    reason: `${verdict.verdict}${where}: ${verdict.reason ?? "not confirmed"}`,
  };
}

/** learnsync's validator from a checkout: async (paths) => Map(path -> verdict). */
export async function learnsyncVerdicts({ dir, live }) {
  const validate = await import(
    pathToFileURL(join(dir, "scripts", "lib", "validate.mjs")).href
  );
  const data = validate.loadData(join(dir, "data"));
  const probe = live
    ? await import(
        pathToFileURL(join(dir, "scripts", "lib", "live-probe.mjs")).href
      )
    : null;
  return async (paths) => {
    let { results } = validate.validateUrls(
      paths.map((p) => `https://learn.microsoft.com${p}`),
      data,
    );
    if (probe)
      ({ results } = await probe.liveLayer(results, {
        confirmLive: true,
        probeUnverifiable: true,
      }));
    return new Map(results.map((r) => [r.path, r]));
  };
}

function parseArgs(argv) {
  const [command, target, ...rest] = argv;
  const options = {
    command,
    target,
    live: false,
    out: null,
    review: null,
    group: null,
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--live") options.live = true;
    else if (
      rest[i] === "--out" ||
      rest[i] === "--review" ||
      rest[i] === "--group"
    ) {
      if (rest[i + 1] === undefined)
        throw new Error(`${rest[i]} needs a value`);
      options[rest[i].slice(2)] = rest[++i];
    } else throw new Error(`Unknown option ${rest[i]}`);
  }
  if (!["validate", "render"].includes(command) || !target)
    throw new Error(
      "A command (validate or render) and an exam code or file are required",
    );
  return options;
}

const isCode = (value) => /^[A-Za-z]{2,3}-\d{3}$/.test(value);

/** The address of the exam's lab page when the hub has one (the course page points there), else null. */
function labPageOf(code, root) {
  const area = AREA_BY_PREFIX[code.split("-")[0]];
  const slug = code.toLowerCase();
  return area &&
    existsSync(
      join(root, "src", "content", "docs", "labs", area, `${slug}.mdx`),
    )
    ? `/certs/labs/${area}/${slug}/`
    : null;
}

/**
 * The command line, dependencies injectable. Exit code: 0 done, 1 the course file has errors,
 * 2 usage or input problem.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    write = (text) => process.stdout.write(text),
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
  const file = isCode(options.target)
    ? join(
        root,
        "src",
        "data_files",
        "courses",
        `${options.target.toUpperCase()}.json`,
      )
    : resolve(options.target);
  let course;
  try {
    course = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    error(
      `Cannot read the course file ${file}: ${e.code === "ENOENT" ? "it does not exist" : e.message}`,
    );
    return 2;
  }
  if (course?.schemaVersion !== COURSE_SCHEMA_VERSION) {
    error(
      `${file}: schemaVersion ${JSON.stringify(course?.schemaVersion)} is not ${COURSE_SCHEMA_VERSION}`,
    );
    return 1;
  }

  let guide = null;
  try {
    const stored = readGuides(
      env.LEARN_EXAMS_FILE ||
        join(root, "src", "data_files", "learn-exams.json"),
    ).get(course.code);
    if (stored) guide = { ...parseGuide(stored.lines), hash: stored.hash };
  } catch (e) {
    error(e.message);
    return 2;
  }
  if (!guide) {
    error(
      `No stored study guide text for ${course.code}: the tree cannot be checked.`,
    );
    return 2;
  }

  let isCurrent;
  if (options.command === "validate") {
    try {
      const lookup =
        verdictsFor ??
        (await learnsyncVerdicts({
          dir: env.LEARNSYNC_DIR || join(root, "..", "learnsync"),
          live: options.live,
        }));
      const verdicts = await lookup([
        ...new Set(
          [...eachPick(course)]
            .map(({ pick }) => pick?.target?.path)
            .filter(Boolean),
        ),
      ]);
      isCurrent = (path) => currentFromVerdict(verdicts.get(path));
    } catch (e) {
      error(
        `Cannot check the URLs (${e.message}). Set LEARNSYNC_DIR to a learnsync checkout.`,
      );
      return 2;
    }
  }
  const result = validateCourse(course, { guide, isCurrent });

  if (options.command === "validate") {
    const s = result.stats;
    log(
      `${course.code}: ${result.ok ? "valid" : "INVALID"} - ${s.tasks} tasks (${s.tasksWithCore} with core picks, ${s.tasksWithoutPicks} with none), ${s.picks} picks (${s.core} core, ${s.supporting} supporting${s.foundation ? `, ${s.foundation} fundamentals` : ""}; ${s.byDecider.auto} automatic, ${s.byDecider.maintainer} approved by the maintainer)`,
    );
    for (const w of result.warnings) log(`  warning: ${w}`);
    for (const e of result.errors) log(`  error: ${e}`);
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    error(`${course.code}: the course file has errors, not rendered:`);
    for (const e of result.errors) error(`  ${e}`);
    return 1;
  }
  let review = null;
  if (options.review) {
    try {
      review = JSON.parse(readFileSync(resolve(options.review), "utf8"));
    } catch (e) {
      error(`Cannot read the review file ${options.review}: ${e.message}`);
      return 2;
    }
    if (review?.kind !== "review" || review.code !== course.code) {
      error(`${options.review} is not the review file of ${course.code}.`);
      return 2;
    }
    const placed = numberReview(course, review).length;
    // a preview of one group renders its marks only: the file is still checked against the whole course
    if (placed !== review.picks.length) {
      error(
        `${options.review} lists ${review.picks.length} picks but only ${placed} of them are in the course file: it belongs to another build; build the course again.`,
      );
      return 1;
    }
  }
  const page = renderCourse(course, {
    labPage: labPageOf(course.code, root),
    review,
    only: options.group,
  });
  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(resolve(options.out), page);
    log(`Wrote ${options.out} (${page.split("\n").length - 1} lines).`);
  } else {
    write(page);
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
