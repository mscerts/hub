#!/usr/bin/env node
/**
 * Study guide parser and exam scope map (docs/course-source.md).
 *
 *   node scripts/course-source.mjs <CODE> [--out DIR]
 *       Parses the exam's study guide into domain / skill group / task and builds the exam scope map
 *       (official course -> learning paths -> modules -> the docs links each module's last unit lists).
 *       Writes <CODE>.guide.json and <CODE>.scope.json to DIR (default: <tmp>/course-source) and prints a
 *       summary. Exit 1 when the guide cannot be parsed completely; an exam with no official course is
 *       only a warning (its scope map is empty).
 *   node scripts/course-source.mjs --survey
 *       Parses every stored study guide and prints one line each: the shapes in the wild, for people.
 *   node scripts/course-source.mjs <CODE> --check <course.mdx>
 *       Compares the domain / group / task headings of a course page with the guide. Exit 1 on a difference.
 *
 * Inputs (nothing is fetched for the guide):
 *   the guide text   src/data_files/learn-exams.json (LEARN_EXAMS_FILE), as the New Exam Monitor stores it
 *   learnsync data   a checkout in LEARNSYNC_DIR (default: ../learnsync next to this repo), else the files
 *                    of mscerts/learnsync main on raw.githubusercontent.com; module-links.json is optional
 *   the course list  https://learn.microsoft.com/api/catalog/?type=courses (one request; the cached
 *                    learn-content.json has no course -> learning path edges)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  diffTrees,
  parseGuide,
  treeFromCourseMdx,
} from "./lib/course-guide.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COURSES_URL =
  "https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us";
export const LEARNSYNC_RAW =
  "https://raw.githubusercontent.com/mscerts/learnsync/main/data";

/** The stored guides of the tracker file: Map code -> { code, name, hash, updatedAt, lines }. */
export function readGuides(file) {
  let tracker;
  try {
    tracker = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(tracker?.studyGuides))
    throw new Error(`${file} has no studyGuides list`);
  return new Map(
    tracker.studyGuides
      .filter((g) => Array.isArray(g.lines))
      .map((g) => [g.code, g]),
  );
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": "msfthub-course-source" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

/** learnsync's catalog, content and (optional) module links: from a checkout, else from GitHub main. */
export async function loadLearnsync({ dir, fetchImpl }) {
  const warnings = [];
  if (dir) {
    const data = join(dir, "data");
    const links = join(data, "module-links.json");
    if (!existsSync(links))
      warnings.push(
        "module-links.json is not in the learnsync checkout: modules have no resources",
      );
    return {
      source: dir,
      catalog: readJson(join(data, "learn-catalog.json")),
      content: readJson(join(data, "learn-content.json")),
      moduleLinks: existsSync(links) ? readJson(links) : null,
      warnings,
    };
  }
  const [catalog, content, moduleLinks] = await Promise.all(
    ["learn-catalog.json", "learn-content.json", "module-links.json"].map((f) =>
      fetchJson(`${LEARNSYNC_RAW}/${f}`, fetchImpl),
    ),
  );
  if (!catalog || !content)
    throw new Error(
      "learnsync main has no learn-catalog.json / learn-content.json",
    );
  if (!moduleLinks)
    warnings.push(
      "module-links.json is not on learnsync main yet: modules have no resources",
    );
  return {
    source: "github.com/mscerts/learnsync (main)",
    catalog,
    content,
    moduleLinks,
    warnings,
  };
}

export async function fetchCourses(fetchImpl) {
  const body = await fetchJson(COURSES_URL, fetchImpl);
  if (!Array.isArray(body?.courses))
    throw new Error("the catalog API answer has no courses list");
  return body.courses;
}

const USAGE = `Usage: node scripts/course-source.mjs <CODE> [--out DIR]
       node scripts/course-source.mjs --survey
       node scripts/course-source.mjs <CODE> --check <course.mdx>`;

function parseArgs(argv) {
  const options = {
    code: null,
    out: null,
    survey: false,
    check: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--survey") options.survey = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out" || arg === "--check") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  return options;
}

const summaryLine = (r) =>
  `${r.stats.domains} domains, ${r.stats.groups} groups, ${r.stats.tasks} tasks${r.asOf ? `, skills measured as of ${r.asOf.text}` : ""}`;

/**
 * The command line, with every dependency injectable. Returns the exit code:
 * 0 done, 1 the guide does not parse completely / the course differs from the guide, 2 usage or input error.
 */
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
  if (options.help || (!options.code && !options.survey)) {
    log(USAGE);
    return options.help ? 0 : 2;
  }
  let guides;
  try {
    guides = readGuides(
      env.LEARN_EXAMS_FILE ||
        join(root, "src", "data_files", "learn-exams.json"),
    );
  } catch (e) {
    error(e.message);
    return 2;
  }

  if (options.survey) {
    let bad = 0;
    let tasks = 0;
    for (const [code, guide] of [...guides].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      const r = parseGuide(guide.lines);
      if (!r.ok) bad++;
      tasks += r.stats.tasks;
      log(
        `${code.padEnd(7)} ${r.ok ? "ok " : "BAD"} ${summaryLine(r)}${r.warnings.length ? `  [${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}]` : ""}`,
      );
      for (const w of r.warnings) log(`          ${w}`);
    }
    log(
      `\n${guides.size} guides, ${bad} not parsed completely, ${tasks} tasks`,
    );
    return bad > 0 ? 1 : 0;
  }

  const guide = guides.get(options.code);
  if (!guide) {
    error(
      `No stored study guide text for ${options.code} (the New Exam Monitor stores the guides of the exams the hub covers).`,
    );
    return 2;
  }
  const parsed = parseGuide(guide.lines);

  if (options.check) {
    let mdx;
    try {
      mdx = readFileSync(resolve(options.check), "utf8");
    } catch (e) {
      error(`Cannot read ${options.check}: ${e.message}`);
      return 2;
    }
    const { identical, differences } = diffTrees(
      parsed,
      treeFromCourseMdx(mdx),
    );
    if (identical) {
      log(
        `${options.check} matches the ${options.code} study guide (${summaryLine(parsed)}).`,
      );
      return 0;
    }
    log(
      `${options.check} differs from the ${options.code} study guide (guide hash ${String(guide.hash).slice(0, 10)}):`,
    );
    for (const d of differences) log(`  ${d.kind}: ${d.at.join(" > ")}`);
    return 1;
  }

  let learnsync;
  let courses;
  try {
    const dir =
      env.LEARNSYNC_DIR ||
      (existsSync(join(root, "..", "learnsync", "data"))
        ? join(root, "..", "learnsync")
        : null);
    learnsync = await loadLearnsync({ dir, fetchImpl });
    courses = await fetchCourses(fetchImpl);
  } catch (e) {
    error(`Cannot load the Learn data: ${e.message}`);
    return 2;
  }
  const scope = buildScopeMap({
    code: options.code,
    courses,
    learningPaths: learnsync.content.learningPaths,
    modules: learnsync.catalog.modules,
    moduleLinks: learnsync.moduleLinks,
  });
  scope.warnings.unshift(...learnsync.warnings);

  const out = resolve(options.out || join(tmpdir(), "course-source"));
  mkdirSync(out, { recursive: true });
  const guideFile = join(out, `${options.code}.guide.json`);
  const scopeFile = join(out, `${options.code}.scope.json`);
  writeFileSync(
    guideFile,
    `${JSON.stringify({ code: guide.code, name: guide.name, hash: guide.hash, updatedAt: guide.updatedAt, ...parsed }, null, 2)}\n`,
  );
  writeFileSync(
    scopeFile,
    `${JSON.stringify({ ...scope, learnsync: learnsync.source }, null, 2)}\n`,
  );

  log(
    `${options.code} ${guide.name}\nGuide: ${parsed.ok ? "parsed" : "NOT PARSED COMPLETELY"} - ${summaryLine(parsed)}`,
  );
  for (const w of parsed.warnings) log(`  warning: ${w}`);
  log(
    `Scope: ${scope.courses.map((c) => c.number).join(", ") || "no official course"} - ${scope.paths.length} learning paths, ${scope.modules.length} modules, ${scope.inputs.resourceModules} with resource links`,
  );
  for (const w of scope.warnings) log(`  warning: ${w}`);
  log(`Wrote ${guideFile}\n      ${scopeFile}`);
  return parsed.ok ? 0 : 1;
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
