#!/usr/bin/env node
/**
 * The course builder (docs/course-build.md): assemble a course file from the gated decisions of an exam.
 *
 *   node scripts/course-build.mjs <CODE> [--gated FILE] [--out FILE] [--today YYYY-MM-DD] [--allow-stale]
 *                                 [--urls [--live]]
 *       Reads the gated file (default <tmp>/course-gates/<CODE>.gated.json; node scripts/course-gates.mjs gate
 *       writes it), the study guide the New Exam Monitor stores and what Learn offers the exam today, and writes
 *       the course file to FILE (default <tmp>/course-build/<CODE>.json). The file passes the offline checks of
 *       scripts/lib/course-format.mjs; --urls also checks that every pick is a current Learn page. Nothing is
 *       written into the repository unless --out says so: the maintainer moves a built course to
 *       src/data_files/courses/<CODE>.json when it is wanted.
 *       The build stops when the study guide or Learn changed since the candidates were made, because the
 *       course would record a state its picks were never judged against; --allow-stale builds anyway.
 *       Hands-on pages (exercises, simulations, guided projects, tutorials, quickstarts) are left out of the
 *       course, a page that fits several tasks is shown once and a classic page is left out; all three are
 *       listed in FILE.routing.json. The picks the judge was not sure of (or flagged as another role or product
 *       area) are in the course and listed in FILE.review.json, for the review copy of the course page
 *       (node scripts/course-file.mjs render ... --review FILE.review.json).
 *
 * Exit code: 0 built, 1 the course cannot be built (stale inputs, a missing quote, a pick that is not valid, a
 * page that is not current), 2 usage or input error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentFromVerdict, learnsyncVerdicts } from "./course-file.mjs";
import { currentScope, learnsyncDir, readGuides } from "./course-source.mjs";
import { decisionsProblems } from "./lib/course-audience.mjs";
import { buildCourse } from "./lib/course-build.mjs";
import { eachPick } from "./lib/course-format.mjs";
import { parseGuide } from "./lib/course-guide.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-build.mjs <CODE> [--gated FILE] [--out FILE] [--today YYYY-MM-DD] [--allow-stale] [--audience FILE] [--urls [--live]]`;

function parseArgs(argv) {
  const options = {
    code: null,
    gated: null,
    out: null,
    today: null,
    allowStale: false,
    urls: false,
    live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-stale") options.allowStale = true;
    else if (arg === "--urls") options.urls = true;
    else if (arg === "--live") options.live = options.urls = true;
    else if (["--gated", "--out", "--today", "--audience"].includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  if (!options.code) throw new Error("An exam code is required");
  if (options.today && !/^\d{4}-\d{2}-\d{2}$/.test(options.today))
    throw new Error("--today must be a YYYY-MM-DD day");
  return options;
}

/** The study guide the New Exam Monitor stores, parsed, with the exam's name; null when there is none. */
function storedGuide({ code, root, env }) {
  const stored = readGuides(
    env.LEARN_EXAMS_FILE || join(root, "src", "data_files", "learn-exams.json"),
  ).get(code);
  if (!stored) return null;
  const guide = { ...parseGuide(stored.lines), hash: stored.hash };
  return { guide, name: stored.name ?? guide.name ?? null };
}

/** The command line, dependencies injectable. Returns the exit code. */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
    tmp = tmpdir(),
    now = () => new Date(),
    scopeFor = currentScope,
    loadGuide = storedGuide,
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
  const today = options.today ?? now().toISOString().slice(0, 10);
  const gatedFile = resolve(
    options.gated ?? join(tmp, "course-gates", `${code}.gated.json`),
  );
  let gated;
  try {
    gated = JSON.parse(readFileSync(gatedFile, "utf8"));
  } catch (e) {
    error(
      e.code === "ENOENT"
        ? `No gated file for ${code}: ${gatedFile}. Run node scripts/course-gates.mjs gate ${code} first.`
        : `The gated file is not valid JSON (${gatedFile}): ${e.message}`,
    );
    return 2;
  }
  if (gated.kind !== "gated" || !Array.isArray(gated.items)) {
    error(`${gatedFile} is not a gated file.`);
    return 2;
  }

  let guide;
  let name;
  let scope;
  try {
    const loaded = loadGuide({ code, root, env });
    if (!loaded) {
      error(`No stored study guide text for ${code}.`);
      return 2;
    }
    ({ guide, name } = loaded);
    ({ scope } = await scopeFor({ code, root, env, fetchImpl }));
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }
  if (!name) {
    error(`${code}: the stored study guide has no exam name.`);
    return 2;
  }

  // the maintainer's picks for the audience profile (course-audience.mjs); a course without them lists the concepts as text
  const audienceFile = resolve(
    options.audience ??
      join(root, "src", "data_files", "course-audience", `${code}.json`),
  );
  let audienceDecisions = null;
  if (existsSync(audienceFile)) {
    try {
      audienceDecisions = JSON.parse(readFileSync(audienceFile, "utf8"));
    } catch (e) {
      error(
        `The audience decisions are not valid JSON (${audienceFile}): ${e.message}`,
      );
      return 2;
    }
    const { problems } = decisionsProblems(audienceDecisions, {
      code,
      audience: guide.audience,
    });
    if (problems.length) {
      error(`${audienceFile} is not valid:`);
      for (const p of problems) error(`  ${p}`);
      return 1;
    }
  } else if (options.audience) {
    error(`No audience decisions: ${audienceFile} does not exist.`);
    return 2;
  }
  const result = buildCourse({
    code,
    name,
    guide,
    scope,
    gated,
    today,
    allowStale: options.allowStale,
    audienceDecisions,
  });
  for (const w of result.warnings) log(`warning: ${w}`);
  if (!result.ok) {
    error(`${code}: the course cannot be built; nothing was written:`);
    for (const p of result.problems) error(`  ${p}`);
    return 1;
  }

  if (options.urls) {
    let lookup = verdictsFor;
    try {
      lookup ??= await learnsyncVerdicts({
        dir: learnsyncDir({ root, env }),
        live: options.live,
      });
    } catch (e) {
      error(
        `Cannot check the URLs (${e.message}). Set LEARNSYNC_DIR to a learnsync checkout.`,
      );
      return 2;
    }
    const verdicts = await lookup([
      ...new Set(
        [...eachPick(result.course)].map(({ pick }) => pick.target.path),
      ),
    ]);
    const stale = [...eachPick(result.course)].filter(
      ({ pick }) =>
        currentFromVerdict(verdicts.get(pick.target.path)).ok === false,
    );
    if (stale.length) {
      error(
        `${code}: some picks are not current Learn pages; nothing was written:`,
      );
      for (const { task, pick } of stale)
        error(
          `  ${task.key}: ${pick.target.path} (${currentFromVerdict(verdicts.get(pick.target.path)).reason})`,
        );
      return 1;
    }
  }

  const out = resolve(options.out ?? join(tmp, "course-build", `${code}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result.course, null, 2)}\n`);
  const s = result.stats;
  log(
    `${code}: built a course of ${s.tasks} tasks, ${s.picks} picks (${s.core} core, ${s.supporting} supporting; ${s.byDecider.auto} automatic, ${s.byDecider.maintainer} approved by the maintainer), ${s.tasksWithoutPicks} tasks with no picks, ${result.course.rejected.length} remembered rejections.`,
  );
  log(`Wrote ${out}`);
  // what the page rules took out of the course, for scripts/course-labs.mjs and the maintainer
  const routing = result.routing;
  const routingFile = out.replace(/\.json$/, "") + ".routing.json";
  writeFileSync(
    routingFile,
    `${JSON.stringify({ schemaVersion: 1, kind: "routing", code, builtAt: today, ...routing }, null, 2)}
`,
  );
  // the picks marked for the maintainer on the review copy of the course page
  const reviewFile = out.replace(/\.json$/, "") + ".review.json";
  writeFileSync(
    reviewFile,
    `${JSON.stringify({ schemaVersion: 1, kind: "review", code, builtAt: today, picks: result.review }, null, 2)}
`,
  );
  if (result.review.length)
    log(
      `${result.review.length} picks are in the course but marked for review (the judge was not sure of them or flagged them): node scripts/course-file.mjs render ${code} --review ${reviewFile}`,
    );
  if (routing.classic.length)
    log(
      `${routing.classic.length} accepted classic pages are not in the course (routing.classic).`,
    );
  if (routing.collapsed.length)
    log(
      `${routing.collapsed.length} accepted units became their module (a module is placed once, as a module: routing.collapsed).`,
    );
  if (routing.blocked.length)
    log(
      `${routing.blocked.length} accepted units are left out because the maintainer had rejected their module for that task (routing.blocked).`,
    );
  log(
    `${routing.handsOn.length} accepted hands-on pages are not in the course: the lab page collects them (node scripts/course-labs.mjs ${code} --routing ${routingFile}); ${routing.repeats.length} pages fitted several tasks and are shown once.`,
  );
  log(
    `To use it: move it to src/data_files/courses/${code}.json, then node scripts/course-file.mjs validate ${code} --live`,
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
