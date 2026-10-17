#!/usr/bin/env node
/**
 * The candidate generator (docs/course-candidates.md): for every task of an exam's study guide, a shortlist of
 * Microsoft Learn modules, units and documentation pages with their provenance (P1-P4). It only shortlists;
 * the judging step decides.
 *
 *   node scripts/course-candidates.mjs <CODE> [--out DIR]
 *       Writes <CODE>.candidates.json to DIR (default: <tmp>/course-candidates) and prints a summary.
 *   node scripts/course-candidates.mjs <CODE> --task <text> [--json]
 *       Prints the shortlist of the tasks whose text contains <text> (case-insensitive) and writes nothing.
 *       With --json the same tasks as JSON.
 *
 * Inputs (nothing is written to the repository):
 *   the guide text   src/data_files/learn-exams.json (LEARN_EXAMS_FILE), as the New Exam Monitor stores it
 *   learnsync data   a checkout in LEARNSYNC_DIR (default: ../learnsync next to this repo), else GitHub main:
 *                    learn-catalog.json, learn-content.json, module-links.json, and for the documentation
 *                    pools docs-catalog.json (about 40 MB), docs-urls.txt and docs-redirects.json
 *   the course list  https://learn.microsoft.com/api/catalog/?type=courses (one request)
 * Exit code: 0 done, 2 usage or input error (no stored guide, guide not parsable, no learnsync data).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchCourses,
  learnsyncDir,
  loadLearnsync,
  loadLearnsyncDocs,
  readGuides,
} from "./course-source.mjs";
import { buildPools, generateCandidates } from "./lib/course-candidates.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-candidates.mjs <CODE> [--out DIR]
       node scripts/course-candidates.mjs <CODE> --task <text> [--json]`;

function parseArgs(argv) {
  const options = { code: null, out: null, task: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "--task") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  if (!options.code) throw new Error("An exam code is required");
  return options;
}

const SOURCE_NAMES = {
  P1: "the exam's own course",
  P2: "listed by the exam's modules",
  P3: "another exam's course",
  P4: "catalog search only",
};

// what a candidate's signals look like in the text output
const TAGS = [
  ["viaGroup", "through the skill group"],
  ["relaxed", "relaxed search"],
  ["foreignFamily", "family the exam does not list"],
  ["siblingSection", "section the exam does not list"],
];
const tagsOf = (c) => {
  const tags = TAGS.filter(([key]) => c[key]).map(([, text]) => text);
  if (c.recommendedBy) tags.push("recommended by the exam's module");
  return tags.length ? `  [${tags.join("; ")}]` : "";
};

/** One task's shortlist as lines of text. */
export function describeTask(task) {
  const lines = [`${task.text}  (${task.domain} > ${task.group})`];
  const a = task.anchor;
  if (a) {
    lines.push(
      `  anchor: ${a.basis === "p1-top" ? a.modules.map((m) => m.title).join("; ") : "none of the exam's modules fits well: the whole exam"}`,
    );
    const shown = a.families.slice(0, 8).join(", ");
    lines.push(
      `  anchor families: ${shown || "none"}${a.families.length > 8 ? `, ... ${a.families.length - 8} more` : ""}`,
    );
  }
  if (task.candidates.length === 0) lines.push("  no candidates");
  let last = "";
  for (const c of task.candidates) {
    const group = `${c.source} ${c.target.kind}`;
    if (group !== last) {
      lines.push(`  ${c.source} ${c.target.kind} (${SOURCE_NAMES[c.source]})`);
      last = group;
    }
    const where =
      c.via || c.module?.path
        ? `  via ${c.via ?? c.module.path}`
        : c.courses
          ? `  ${c.courses.join(", ")}`
          : "";
    lines.push(
      `    ${c.rank}. [${c.score}, covers ${Math.round(c.coverage * 100)}%] ${c.title}  ${c.target.path}${where}${tagsOf(c)}`,
    );
  }
  const dropped = Object.entries(task.dropped);
  if (dropped.length)
    lines.push(
      `  dropped: ${dropped
        .map(
          ([reason, d]) => `${reason} ${d.count} (e.g. ${d.samples[0].path})`,
        )
        .join("; ")}`,
    );
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
    tmp = tmpdir(),
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  let guide;
  let pools;
  let scope;
  try {
    const guides = readGuides(
      env.LEARN_EXAMS_FILE ||
        join(root, "src", "data_files", "learn-exams.json"),
    );
    const stored = guides.get(options.code);
    if (!stored) {
      error(`No stored study guide text for ${options.code}.`);
      return 2;
    }
    guide = { ...parseGuide(stored.lines), hash: stored.hash };
    if (!guide.ok) {
      error(`${options.code}: the study guide does not parse completely.`);
      return 2;
    }
    const dir = learnsyncDir({ root, env });
    const learnsync = await loadLearnsync({ dir, fetchImpl });
    const docs = await loadLearnsyncDocs({ dir, fetchImpl });
    const courses = await fetchCourses(fetchImpl);
    scope = buildScopeMap({
      code: options.code,
      courses,
      learningPaths: learnsync.content.learningPaths,
      modules: learnsync.catalog.modules,
      moduleLinks: learnsync.moduleLinks,
    });
    scope.warnings.unshift(...learnsync.warnings, ...docs.warnings);
    pools = buildPools({
      catalog: learnsync.catalog,
      courses,
      learningPaths: learnsync.content.learningPaths,
      moduleLinks: learnsync.moduleLinks,
      docs: docs.docs,
      docPaths: docs.docPaths,
      redirects: docs.redirects,
    });
  } catch (e) {
    error(`Cannot load the inputs: ${e.message}`);
    return 2;
  }

  const result = generateCandidates({
    code: options.code,
    guide,
    scope,
    pools,
  });

  if (options.task) {
    const needle = options.task.toLowerCase();
    const tasks = result.tasks.filter((t) =>
      t.text.toLowerCase().includes(needle),
    );
    if (tasks.length === 0) {
      error(`No task of ${options.code} contains "${options.task}".`);
      return 2;
    }
    if (options.json) log(JSON.stringify(tasks, null, 2));
    else for (const t of tasks) for (const l of describeTask(t)) log(l);
    return 0;
  }

  const outDir = options.out ?? join(tmp, "course-candidates");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${options.code}.candidates.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const s = result.stats;
  log(
    `${options.code}: ${s.tasks} tasks, ${s.candidates} candidates (P1 ${s.bySource.P1}, P2 ${s.bySource.P2}, P3 ${s.bySource.P3}, P4 ${s.bySource.P4}); ${s.tasksWithoutP1} tasks without a P1 candidate, ${s.tasksWithoutCandidates} without any`,
  );
  for (const w of result.warnings) log(`  warning: ${w}`);
  log(`Wrote ${file}`);
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
