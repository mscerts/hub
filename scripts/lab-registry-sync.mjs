#!/usr/bin/env node
/**
 * Weekly sync of the lab registry (src/data_files/lab-registry.json): every Microsoft Learn hands-on page and the
 * exams it belongs to, so that no exercise, project, demonstration, quickstart or Applied Skill is missed, and the
 * new ones that Learn publishes are found. Runbook: docs/monitors/lab-registry.md. What counts as hands-on, and what
 * an entry is, is in scripts/lib/lab-registry.mjs.
 *
 * Usage:
 *   node scripts/lab-registry-sync.mjs              sync, check, write the registry, report
 *   node scripts/lab-registry-sync.mjs --check      the check only: nothing is written, no issue is touched
 *
 * What it does:
 *   1. Reads learnsync's data (learn-catalog.json, learn-content.json, docs-catalog.json) from a checkout
 *      (LEARNSYNC_DIR) or from mscerts/learnsync on GitHub, the course list of the Learn catalog API, the hub's exam
 *      pages and lab pages, and the Applied Skills Monitor's cache.
 *   2. Builds the universe of hands-on pages from titles and addresses (no page is read for that), and maps every
 *      page of a module of an exam's official course to that exam ("course"). A lab page that links a page ties it to
 *      its exam ("page"). Decisions of the maintainer ("judged", "maintainer", no-exam, excluded, skip) are kept.
 *   3. Reads the page of every unit of a module that is new or whose unitSig changed, up to MAX_PAGE_READS units
 *      a run, and looks for demo hosts (CloudGuides, Highlights): such a unit is an entry ("demo link"). The catalog
 *      holds titles and addresses, not page text, so the links can only be found by reading. The first runs catch up
 *      module by module; a local run with a large MAX_PAGE_READS does it at once.
 *   4. Compares the registry with the lab pages: a page the registry ties to an exam whose lab page lacks it is
 *      "missing"; a Learn card of a lab page that no entry accounts for is an "extra" (information).
 *   5. Writes the registry when something changed (never for lastSynced alone), writes the report, and keeps ONE
 *      running issue with a stable title: created when something needs a person, commented when the list changed,
 *      closed when nothing is left.
 *
 * Failsafes (extraction_failed, nothing written):
 *   - the catalog, the course list or an exam's page cannot be read, or the catalog lists fewer than MIN_MODULES
 *     modules, the course list fewer than MIN_COURSES courses;
 *   - more than MAX_GONE_PCT of the registry's pages vanish from the universe at once (the data changed shape).
 *     FORCE_BASELINE=1 accepts that;
 *   - a corrupt registry.
 * A page that cannot be read is never evidence: more than MAX_PAGE_FAILURE_PCT failures stop the page reads (a
 * warning), the module stays unscanned and is tried again next run.
 *
 * Env overrides (defaults shown):
 *   LEARNSYNC_DIR       (a checkout of mscerts/learnsync; else its raw files on GitHub)
 *   LEARNSYNC_RAW       https://raw.githubusercontent.com/mscerts/learnsync/main/data
 *   COURSES_URL         https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us
 *   COURSES_FILE        (a local copy of that answer: tests, offline work)
 *   LEARN_ORIGIN        https://learn.microsoft.com   (where the unit pages are read)
 *   REGISTRY_FILE       src/data_files/lab-registry.json
 *   DOCS_DIR            src/content/docs
 *   APPLIED_SKILLS_FILE src/data_files/applied-skills-cache.json
 *   REPORT_FILE         <tmpdir>/lab-registry-report.md
 *   ERROR_FILE          <tmpdir>/lab-registry-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (job summary, optional)
 *   MAX_PAGE_READS      1000   (units; 0 = no page reads; a module is never split)
 *   SCAN_SCOPE          hub    (hub: the modules of the hub exams' courses, the modules the lab pages link and the
 *                              modules that have an entry; all: every module of the catalog, about 27,500 pages)
 *   PAGE_DELAY_MS       350
 *   MIN_MODULES         2000   MIN_COURSES 50   MAX_GONE_PCT 30   MAX_PAGE_FAILURE_PCT 25
 *   DOCS                1      (0: no docs tutorials and quickstarts, the docs catalog is not read)
 *   MAX_ROWS            60     (rows per table of the report)
 *   FORCE_BASELINE      (1 = accept a big drop of the universe silently)
 *   CREATE_ISSUES       0      (1 = create, comment on and close the running issue with the gh CLI)
 *   DRY_RUN             (1 = touch no issue and write no file)
 *   FETCH_ATTEMPTS 3   RETRY_BASE_MS 5000   MAX_RETRY_AFTER_MS 60000   FETCH_TIMEOUT_MS 60000
 *   TODAY               YYYY-MM-DD (tests)
 *   GH_CLI_SCRIPT       (tests only: a Node script run instead of the gh CLI)
 *
 * Writes GITHUB_OUTPUT keys: changes_found (the issue was created or commented), baseline_updated (the registry
 * changed), extraction_failed, issue_title.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeOpenIssues, raiseIssue } from "./failure-issue.mjs";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";
import { makeGh } from "./lib/gh.mjs";
import {
  buildReport,
  buildUniverse,
  cardIndex,
  checkLabPages,
  comparable,
  demoHostsIn,
  emptyRegistry,
  examOfLabPage,
  examsByModule,
  familiesFromContent,
  familiesFromModuleLinks,
  labPageCards,
  moduleOf,
  parseRegistry,
  serializeRegistry,
  summarize,
  syncRegistry,
  worklist,
} from "./lib/lab-registry.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

export const ISSUE_TITLE = "Lab registry: hands-on pages need attention";
export const FAILURE_TITLE = "Lab registry: the sync failed";
const ISSUE_LABEL = "enhancement";
const ANNOTATION_TITLE = "Lab registry";

const intOr = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n)
    ? n
    : fallback;
};

export function loadConfig(env = process.env) {
  const tmp = tmpdir();
  return {
    learnsyncDir: env.LEARNSYNC_DIR || "",
    learnsyncRaw:
      env.LEARNSYNC_RAW ||
      "https://raw.githubusercontent.com/mscerts/learnsync/main/data",
    coursesUrl:
      env.COURSES_URL ||
      "https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us",
    coursesFile: env.COURSES_FILE || "",
    learnOrigin: (env.LEARN_ORIGIN || "https://learn.microsoft.com").replace(
      /\/$/,
      "",
    ),
    registryFile:
      env.REGISTRY_FILE || join(root, "src/data_files/lab-registry.json"),
    docsDir: env.DOCS_DIR || join(root, "src/content/docs"),
    skillsFile:
      env.APPLIED_SKILLS_FILE ||
      join(root, "src/data_files/applied-skills-cache.json"),
    reportFile: env.REPORT_FILE || join(tmp, "lab-registry-report.md"),
    errorFile: env.ERROR_FILE || join(tmp, "lab-registry-error.md"),
    githubOutput: env.GITHUB_OUTPUT || join(tmp, "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    maxPageReads: intOr(env.MAX_PAGE_READS, 1000),
    scanScope: env.SCAN_SCOPE === "all" ? "all" : "hub",
    pageDelayMs: intOr(env.PAGE_DELAY_MS, 350),
    minModules: intOr(env.MIN_MODULES, 2000),
    minCourses: intOr(env.MIN_COURSES, 50),
    maxGonePct: intOr(env.MAX_GONE_PCT, 30),
    maxPageFailurePct: intOr(env.MAX_PAGE_FAILURE_PCT, 25),
    docs: env.DOCS !== "0",
    maxRows: intOr(env.MAX_ROWS, 60),
    forceBaseline: env.FORCE_BASELINE === "1",
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    fetchAttempts: intOr(env.FETCH_ATTEMPTS, 3),
    retryBaseMs: intOr(env.RETRY_BASE_MS, 5000),
    maxRetryAfterMs: intOr(env.MAX_RETRY_AFTER_MS, 60000),
    fetchTimeoutMs: intOr(env.FETCH_TIMEOUT_MS, 60000),
    today: env.TODAY || new Date().toISOString().slice(0, 10),
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : "",
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET with retries (network errors, 429 and 5xx); returns the Response of the last attempt or throws. */
export async function fetchRetry(url, cfg, fetchImpl = fetch) {
  let last;
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": "msfthub-lab-registry/1.0" },
        signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
      });
      if (res.status !== 429 && res.status < 500) return res;
      last = new Error(`HTTP ${res.status} from ${url}`);
      if (attempt < cfg.fetchAttempts)
        await sleep(
          retryDelayMs({
            attempt,
            retryAfter: res.headers.get("retry-after"),
            baseMs: cfg.retryBaseMs,
            maxMs: cfg.maxRetryAfterMs,
          }),
        );
    } catch (error) {
      last = error;
      if (attempt < cfg.fetchAttempts)
        await sleep(
          retryDelayMs({
            attempt,
            baseMs: cfg.retryBaseMs,
            maxMs: cfg.maxRetryAfterMs,
          }),
        );
    }
  }
  throw last;
}

/** One learnsync data file, from the checkout or from GitHub. */
async function learnsyncFile(name, cfg, fetchImpl) {
  if (cfg.learnsyncDir)
    return JSON.parse(readFileSync(join(cfg.learnsyncDir, name), "utf8"));
  const res = await fetchRetry(`${cfg.learnsyncRaw}/${name}`, cfg, fetchImpl);
  if (!res.ok)
    throw new Error(`HTTP ${res.status} for ${cfg.learnsyncRaw}/${name}`);
  return res.json();
}

async function readCourses(cfg, fetchImpl) {
  if (cfg.coursesFile) return JSON.parse(readFileSync(cfg.coursesFile, "utf8"));
  const res = await fetchRetry(cfg.coursesUrl, cfg, fetchImpl);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${cfg.coursesUrl}`);
  return res.json();
}

const readDirSafe = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** The exam codes of the hub's exam pages (<area>/<CODE>.mdx, drafts left out). */
export function examCodes(docsDir) {
  const codes = [];
  for (const area of EXAM_AREAS) {
    for (const file of readDirSafe(join(docsDir, area))) {
      const m = /^([A-Z]{2,3}-\d{3})\.mdx?$/.exec(file);
      if (!m) continue;
      const text = readFileSync(join(docsDir, area, file), "utf8");
      if (/^draft:\s*true\s*$/m.test(text.split(/^---$/m)[1] ?? "")) continue;
      codes.push(m[1]);
    }
  }
  return codes.sort();
}

/** Map exam code -> cardIndex of its (non-draft) lab page at <docsDir>/labs/<area>/<code>.mdx. */
export function readLabPages(docsDir) {
  const pages = new Map();
  const labs = join(docsDir, "labs");
  for (const area of readDirSafe(labs)) {
    const dir = join(labs, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readDirSafe(dir)) {
      const exam = examOfLabPage(`labs/${area}/${file.replace(/\.mdx?$/, "")}`);
      if (!exam || !/\.mdx?$/.test(file)) continue;
      const text = readFileSync(join(dir, file), "utf8");
      if (/^draft:\s*true\s*$/m.test(text.split(/^---$/m)[1] ?? "")) continue;
      pages.set(exam, cardIndex(labPageCards(text)));
    }
  }
  return pages;
}

function contentTexts(docsDir) {
  const texts = [];
  const walk = (dir) => {
    for (const name of readDirSafe(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name)) texts.push(readFileSync(path, "utf8"));
    }
  };
  walk(docsDir);
  return texts;
}

// ---------------------------------------------------------------------------
// Page reads
// ---------------------------------------------------------------------------

/**
 * The modules whose pages to read this run and how many units that is: modules of an official course, modules a lab
 * page links and modules with a unit entry, whose unitSig differs from the one last scanned; official-course modules
 * first. A module is never split, so the cap may be passed by the last module taken.
 */
export function pickModulesToRead({
  universe,
  previous,
  courseExams,
  pageExams,
  maxUnits,
  scope = "hub",
}) {
  const byPath = new Map(universe.modules.map((m) => [m.path, m]));
  const wanted = new Map(); // path -> priority (0 course, 1 lab page / entry)
  for (const path of courseExams.keys())
    if (byPath.has(path)) wanted.set(path, 0);
  for (const index of pageExams.values()) {
    for (const path of index.paths) {
      const mod = moduleOf(path);
      if (mod && byPath.has(mod) && !wanted.has(mod)) wanted.set(mod, 1);
    }
  }
  for (const found of universe.entries.values()) {
    const mod = found.kind === "unit" ? moduleOf(found.key) : null;
    if (mod && byPath.has(mod) && !wanted.has(mod)) wanted.set(mod, 1);
  }
  if (scope === "all")
    for (const path of byPath.keys())
      if (!wanted.has(path)) wanted.set(path, 2);
  const todo = [...wanted]
    .map(([path, priority]) => ({ module: byPath.get(path), priority }))
    .filter(
      ({ module }) =>
        (previous.scanned?.[module.path] ?? null) !== (module.unitSig ?? ""),
    )
    .sort(
      (a, b) =>
        a.priority - b.priority || (a.module.path < b.module.path ? -1 : 1),
    );
  const picked = [];
  let units = 0;
  for (const { module } of todo) {
    if (maxUnits <= 0 || units >= maxUnits) break;
    picked.push(module);
    units += module.units.length;
  }
  return { picked, pending: todo.length - picked.length, units };
}

/**
 * Read the unit pages of the picked modules. Returns { demoUnits: Map key -> { hosts, path, title, module },
 * scanned: Map modulePath -> unitSig, read, failed, stopped }. A module is marked scanned only when every unit page
 * was read; a failure is never evidence of anything.
 */
export async function readUnitPages(modules, cfg, fetchImpl = fetch) {
  const demoUnits = new Map();
  const scanned = new Map();
  let read = 0;
  let failed = 0;
  let stopped = false;
  for (const module of modules) {
    let moduleFailed = false;
    for (const unit of module.units) {
      try {
        const res = await fetchRetry(
          `${cfg.learnOrigin}${unit.path}`,
          cfg,
          fetchImpl,
        );
        if (res.status === 404 || res.status === 410) {
          read++;
        } else if (!res.ok) {
          failed++;
          moduleFailed = true;
        } else {
          read++;
          const hosts = demoHostsIn(await res.text());
          if (hosts.length)
            demoUnits.set(unit.key, {
              hosts,
              path: unit.path,
              title: unit.title,
              module: module.path,
            });
        }
      } catch {
        failed++;
        moduleFailed = true;
      }
      if (cfg.pageDelayMs > 0) await sleep(cfg.pageDelayMs);
      const tried = read + failed;
      if (tried >= 40 && failed / tried > cfg.maxPageFailurePct / 100) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    if (!moduleFailed) scanned.set(module.path, module.unitSig ?? "");
  }
  return { demoUnits, scanned, read, failed, stopped };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class Failsafe extends Error {}

/** A stable fingerprint of what needs a person: the signature of the running issue. */
export function signatureOf({ work, check }) {
  const parts = [
    ...work.unmapped.map((e) => `n|${e.key}`),
    ...work.retiring.map((r) => `r|${r.entry.key}`),
    ...check.missing.map((m) => `m|${m.exam}|${m.key}`),
  ].sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** Run the sync. Returns the result object; writes files and the issue as the config allows. */
export async function run(cfg, options = {}) {
  const result = await runSync(cfg, options);
  if (!options.checkOnly && !cfg.dryRun) {
    writeOutput(cfg.githubOutput, {
      changes_found: result.changesFound,
      baseline_updated: result.baselineUpdated,
      extraction_failed: result.extractionFailed,
      issue_title: result.issueTitle,
    });
  }
  return result;
}

async function runSync(
  cfg,
  { fetchImpl = fetch, checkOnly = false, gh = null } = {},
) {
  const log = (message) => console.log(`[lab-registry] ${message}`);
  const out = {
    changesFound: false,
    baselineUpdated: false,
    extractionFailed: false,
    issueTitle: "",
  };
  try {
    // 1. the registry
    let previous = emptyRegistry();
    let firstRun = true;
    if (existsSync(cfg.registryFile)) {
      previous = parseRegistry(readFileSync(cfg.registryFile, "utf8"));
      firstRun = false;
    }
    const reportedBefore = previous.reported ?? null;

    // 2. the hub
    const codes = examCodes(cfg.docsDir);
    if (codes.length === 0)
      throw new Failsafe(
        `no exam page found in ${cfg.docsDir}: the folder layout changed?`,
      );
    const pageExams = readLabPages(cfg.docsDir);
    const skills = existsSync(cfg.skillsFile)
      ? JSON.parse(readFileSync(cfg.skillsFile, "utf8"))
      : null;
    const contentFamilies = familiesFromContent(contentTexts(cfg.docsDir));

    // 3. learnsync and Learn
    const catalog = await learnsyncFile("learn-catalog.json", cfg, fetchImpl);
    const content = await learnsyncFile("learn-content.json", cfg, fetchImpl);
    const courses = (await readCourses(cfg, fetchImpl)).courses;
    if (
      !Array.isArray(catalog?.modules) ||
      catalog.modules.length < cfg.minModules
    )
      throw new Failsafe(
        `the catalog lists ${catalog?.modules?.length ?? 0} modules, fewer than MIN_MODULES (${cfg.minModules}).`,
      );
    if (!Array.isArray(courses) || courses.length < cfg.minCourses)
      throw new Failsafe(
        `the course list has ${courses?.length ?? 0} courses, fewer than MIN_COURSES (${cfg.minCourses}).`,
      );
    let docs = null;
    if (cfg.docs) {
      try {
        docs = await learnsyncFile("docs-catalog.json", cfg, fetchImpl);
      } catch (error) {
        warnLoud(
          `the docs catalog could not be read (${error.message}): tutorials and quickstarts are left as they are.`,
          { title: ANNOTATION_TITLE },
        );
      }
    }

    // 4. the exams, the docs families and the universe. A docs family counts when a page of the hub links it or
    // when the course of an exam sends its learners there (the links of the last unit of its modules).
    const scopeOf = (code) =>
      buildScopeMap({
        code,
        courses,
        learningPaths: content.learningPaths,
        modules: catalog.modules,
        moduleLinks: null,
      });
    const courseExams = examsByModule(codes, scopeOf);
    let moduleLinks = null;
    try {
      moduleLinks = await learnsyncFile("module-links.json", cfg, fetchImpl);
    } catch (error) {
      warnLoud(
        `module-links.json could not be read (${error.message}): the docs families of the exam courses are left out.`,
        { title: ANNOTATION_TITLE },
      );
    }
    const families = new Set([
      ...contentFamilies,
      ...familiesFromModuleLinks(moduleLinks, courseExams.keys()),
    ]);
    const universe = buildUniverse({ catalog, docs, skills, families });
    log(
      `universe: ${universe.entries.size} pages (${JSON.stringify(universe.stats)}), ${universe.modules.length} modules, ${courseExams.size} modules in an exam course`,
    );

    // 5. failsafe against a shrinking universe
    const before = previous.entries.filter(
      (e) =>
        e.state !== "retiring" && e.kind !== "docs" && e.why !== "demo link",
    );
    const missing = before.filter((e) => !universe.entries.has(e.key));
    if (
      !cfg.forceBaseline &&
      before.length >= 50 &&
      missing.length / before.length > cfg.maxGonePct / 100
    )
      throw new Failsafe(
        `${missing.length} of ${before.length} hands-on pages vanished from the universe at once (more than ${cfg.maxGonePct} percent): the data probably changed shape. Run again with FORCE_BASELINE=1 if the change is real.`,
      );

    // 6. the page reads
    let reads = {
      demoUnits: new Map(),
      scanned: new Map(),
      read: 0,
      failed: 0,
      stopped: false,
    };
    let pending = 0;
    if (cfg.maxPageReads > 0) {
      const plan = pickModulesToRead({
        universe,
        previous,
        courseExams,
        pageExams,
        maxUnits: cfg.maxPageReads,
        scope: cfg.scanScope,
      });
      pending = plan.pending;
      log(
        `reading ${plan.units} unit pages of ${plan.picked.length} modules (${plan.pending} more modules wait)`,
      );
      reads = await readUnitPages(plan.picked, cfg, fetchImpl);
      if (reads.stopped)
        warnLoud(
          `the page reads stopped after ${reads.failed} failures of ${reads.read + reads.failed}: Learn is unreachable or blocking. The unread modules are tried again next run.`,
          { title: ANNOTATION_TITLE },
        );
    }

    // 7. sync, check, report
    const { registry, changes } = syncRegistry({
      previous,
      universe,
      courseExams,
      pageExams,
      demoUnits: reads.demoUnits,
      scanned: reads.scanned,
      today: cfg.today,
    });
    const check = checkLabPages({
      registry,
      pageExams,
      hasLabPage: (exam) => pageExams.has(exam),
    });
    const work = worklist(registry, pageExams);
    const notes = [];
    const age = Math.floor(
      (Date.parse(cfg.today) - Date.parse(catalog.lastChecked ?? "")) /
        86400000,
    );
    if (Number.isFinite(age) && age > 21)
      notes.push(
        `The learnsync catalog is ${age} days old (checked ${catalog.lastChecked}); new pages Learn published since are not seen yet.`,
      );
    if (pending > 0)
      notes.push(
        `${pending} modules still wait for their pages to be read (MAX_PAGE_READS ${cfg.maxPageReads} units a run); demo links in them are not found yet.`,
      );
    const report = buildReport({
      registry,
      work,
      check,
      changes,
      date: cfg.today,
      maxRows: cfg.maxRows,
      notes,
    });
    const signature = report ? signatureOf({ work, check }) : null;
    // What the issue was last told is only remembered when this run really talks to GitHub: a local run without
    // CREATE_ISSUES must not mark the list as reported, or the first run in CI would find nothing to say.
    const unchanged = (reportedBefore?.signature ?? null) === signature;
    registry.reported =
      cfg.createIssues && !cfg.dryRun
        ? {
            signature,
            date: unchanged ? (reportedBefore?.date ?? null) : cfg.today,
          }
        : (reportedBefore ?? { signature: null, date: null });
    const changed = firstRun || comparable(registry) !== comparable(previous);
    const sums = summarize(registry);
    log(
      `${sums.total} pages (${sums.active} with an exam, ${sums.new} without, ${sums.noExam} no-exam, ${sums.excluded} excluded, ${sums.retiring} retiring); ${changes.added.length} added, ${changes.mapped.length} exam links made, ${changes.retiring.length} retiring, ${check.missing.length} missing on lab pages`,
    );

    // 8. nothing is written for a check or a dry run
    if (checkOnly || cfg.dryRun) {
      writeFileSync(cfg.reportFile, report || "Nothing needs a person.\n");
      return { ...out, registry, changes, check, work, report };
    }

    // 9. the running issue comes BEFORE the registry is written: the workflow commits the registry only after this
    // step succeeded, so a failed issue loses no alert (the next run reports the same list again).
    const issue = syncIssue(
      cfg,
      { report, signature, previous: reportedBefore },
      gh,
    );
    out.changesFound =
      issue.action === "created" || issue.action === "commented";
    out.issueTitle = ISSUE_TITLE;
    writeFileSync(cfg.reportFile, report || "");
    if (changed) writeFileSync(cfg.registryFile, serializeRegistry(registry));
    out.baselineUpdated = changed;
    if (cfg.stepSummary)
      appendStepSummary(
        cfg.stepSummary,
        report || "Lab registry: nothing needs a person.",
      );
    return { ...out, registry, changes, check, work, report, issue };
  } catch (error) {
    out.baselineUpdated = false;
    out.changesFound = false;
    out.extractionFailed = true;
    const message =
      error instanceof Failsafe
        ? `The lab registry sync stopped by its own failsafe and wrote nothing.\n\n${error.message}\n`
        : `The lab registry sync failed and wrote nothing.\n\n${error.stack ?? error.message}\n`;
    writeFileSync(cfg.errorFile, message);
    console.error(message);
    return { ...out, error: error.message };
  }
}

/**
 * The running issue: created when something needs a person, a comment when the list changed since the last report,
 * closed when nothing is left. The same list as the last report does nothing (no gh call at all).
 */
export function syncIssue(
  cfg,
  { report, signature, previous },
  ghRunner = null,
) {
  const none = { action: "none", number: null };
  if (!cfg.createIssues || cfg.dryRun)
    return report ? { action: "skipped", number: null } : none;
  const gh = ghRunner ?? makeGh({ ghCliScript: cfg.ghCliScript });
  if (report) {
    if (previous?.signature && previous.signature === signature) return none;
    const run = cfg.runUrl ? `\n\nRun: ${cfg.runUrl}` : "";
    const raised = raiseIssue({
      gh,
      title: ISSUE_TITLE,
      label: ISSUE_LABEL,
      labelColor: "a2eeef",
      labelDescription: "New feature or request",
      body: report + run,
      commentBody: report + run,
    });
    return raised;
  }
  if (!previous?.signature) return none;
  const closed = closeOpenIssues({
    gh,
    title: ISSUE_TITLE,
    label: ISSUE_LABEL,
    comment:
      "Nothing in the lab registry needs a person any more. Closing this issue.",
  });
  if (closed.failures.length)
    warnLoud(
      `could not close the lab registry issue: ${closed.failures.join("; ")}`,
      { title: ANNOTATION_TITLE },
    );
  return {
    action: closed.closed.length ? "closed" : "none",
    number: closed.closed[0] ?? null,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = loadConfig(env);
  const result = await run(cfg, { checkOnly: argv.includes("--check") });
  return result.extractionFailed ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => process.exit(code));
}
