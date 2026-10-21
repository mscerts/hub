#!/usr/bin/env node
/**
 * Weekly sync of the Learn course tracker (src/data_files/learn-courses.json): every course of the Microsoft Learn
 * catalog and the hub exam pages it is assigned to. Runbook: docs/monitors/learn-courses.md. What a course entry is,
 * and every rule that decides, is in scripts/lib/learn-courses.mjs.
 *
 * Usage:
 *   node scripts/learn-courses-sync.mjs              sync, check, write the file, report
 *   node scripts/learn-courses-sync.mjs --check      the check only: nothing is written, no issue is touched
 *
 * What it does:
 *   1. Reads the course list and the Applied Skills of the Learn catalog API, learnsync's data (the learning paths and
 *      modules a course lists, for the module sets and the placement), the hub's exam pages in src/content/docs and
 *      src/content/archive, every course card of the hub, the exams on Learn (learn-exams.json), the retiring exams
 *      and the Course Videos Monitor's recordings.
 *   2. Updates every entry. An EXAM course (<CODE>T<nn> with <CODE> an exam on Learn) is assigned to its exam's page by
 *      the rule, and proposed for the page of the exam that replaces it while it retires. Every OTHER course gets
 *      proposals by relevancy (scripts/lib/course-placement.mjs) until the maintainer decides. Nothing is placed
 *      automatically: a proposal becomes an assignment when the maintainer sets it to confirmed. A hub page that
 *      already has a card for a course counts as confirmed.
 *   3. Compares the file with the hub: a confirmed page without the course card, a course Learn removed that hub
 *      pages (active or archived) still link, a temporary assignment that is due, a course whose learning paths
 *      changed, a retiring Applied Skill built on a tracked course.
 *   4. Writes the file when something changed (never for lastSynced alone), writes the report, and keeps ONE running
 *      issue with a stable title: created when something needs a person, commented when the list changed, closed when
 *      nothing is left.
 *
 * Failsafes (extraction_failed, nothing written):
 *   - the course list or learnsync's data cannot be read, or the catalog lists fewer than MIN_COURSES courses;
 *   - more than MAX_GONE_PCT of the tracked courses are missing from the catalog at once (FORCE_BASELINE=1 accepts it);
 *   - no exam page found in the hub, or a corrupt file.
 * A course counts as removed only after it is missing two runs in a row. The Applied Skills list is optional: when it
 * cannot be read the skills of the entries stay as they are.
 *
 * Env overrides (defaults shown):
 *   COURSES_URL        https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us
 *   COURSES_FILE       (a local copy of that answer: tests, offline work)
 *   SKILLS_URL         https://learn.microsoft.com/api/catalog/?type=appliedSkills&locale=en-us
 *   SKILLS_FILE        (a local copy of that answer)
 *   LEARNSYNC_DIR      (a checkout of mscerts/learnsync; else its raw files on GitHub; read by the placement)
 *   TRACKER_FILE       src/data_files/learn-courses.json
 *   DOCS_DIR           src/content/docs
 *   ARCHIVE_DIR        src/content/archive
 *   LEARN_EXAMS_FILE   src/data_files/learn-exams.json
 *   RETIRING_FILE      src/data_files/retiring-exams.json
 *   SKILLS_CACHE_FILE  src/data_files/applied-skills-cache.json
 *   VIDEOS_FILE        src/data_files/course-videos.json
 *   REPORT_FILE        <tmpdir>/learn-courses-report.md
 *   ERROR_FILE         <tmpdir>/learn-courses-error.md
 *   GITHUB_OUTPUT      <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (job summary, optional)
 *   MIN_COURSES        60   MAX_GONE_PCT 30   MAX_ROWS 60
 *   FORCE_BASELINE     (1 = accept a big drop of the catalog silently)
 *   CREATE_ISSUES      0    (1 = create, comment on and close the running issue with the gh CLI)
 *   DRY_RUN            (1 = touch no issue and write no file)
 *   FETCH_ATTEMPTS 3   RETRY_BASE_MS 5000   MAX_RETRY_AFTER_MS 60000   FETCH_TIMEOUT_MS 60000
 *   TODAY              YYYY-MM-DD (tests)
 *   GH_CLI_SCRIPT      (tests only: a Node script run instead of the gh CLI)
 *
 * Writes GITHUB_OUTPUT keys: changes_found (the issue was created or commented), baseline_updated (the file changed),
 * extraction_failed, issue_title.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlacement, placeCourse } from "./course-placement.mjs";
import {
  akamsCode,
  findLinkCards,
  playlistOfUrl,
  stripComments,
  titleCode,
} from "./course-videos-check.mjs";
import { closeOpenIssues, raiseIssue } from "./failure-issue.mjs";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import {
  buildReport,
  checkHub,
  comparable,
  emptyFile,
  needsCount,
  parseFile,
  serializeFile,
  signatureOf,
  skillSlug,
  summarize,
  syncCourses,
} from "./lib/learn-courses.mjs";
import { courseModules, describeSuggestion } from "./lib/course-placement.mjs";
import { makeGh } from "./lib/gh.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

export const ISSUE_TITLE = "Learn courses: decisions needed";
export const FAILURE_TITLE = "Learn courses: the sync failed";
const ISSUE_LABEL = "enhancement";
const ANNOTATION_TITLE = "Learn course tracker";

const intOr = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n)
    ? n
    : fallback;
};

export function loadConfig(env = process.env) {
  const tmp = tmpdir();
  const file = (key, fallback) => env[key] || join(root, fallback);
  return {
    env,
    coursesUrl:
      env.COURSES_URL ||
      "https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us",
    coursesFile: env.COURSES_FILE || "",
    skillsUrl:
      env.SKILLS_URL ||
      "https://learn.microsoft.com/api/catalog/?type=appliedSkills&locale=en-us",
    skillsFile: env.SKILLS_FILE || "",
    trackerFile: file("TRACKER_FILE", "src/data_files/learn-courses.json"),
    docsDir: file("DOCS_DIR", "src/content/docs"),
    archiveDir: file("ARCHIVE_DIR", "src/content/archive"),
    examsFile: file("LEARN_EXAMS_FILE", "src/data_files/learn-exams.json"),
    retiringFile: file("RETIRING_FILE", "src/data_files/retiring-exams.json"),
    skillsCacheFile: file(
      "SKILLS_CACHE_FILE",
      "src/data_files/applied-skills-cache.json",
    ),
    videosFile: file("VIDEOS_FILE", "src/data_files/course-videos.json"),
    reportFile: env.REPORT_FILE || join(tmp, "learn-courses-report.md"),
    errorFile: env.ERROR_FILE || join(tmp, "learn-courses-error.md"),
    githubOutput: env.GITHUB_OUTPUT || join(tmp, "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    minCourses: intOr(env.MIN_COURSES, 60),
    maxGonePct: intOr(env.MAX_GONE_PCT, 30),
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
        headers: { "user-agent": "msfthub-learn-courses/1.0" },
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

async function readJson(url, file, cfg, fetchImpl) {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetchRetry(url, cfg, fetchImpl);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const readOptionalJson = (file) => {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const isDraft = (text) =>
  /^draft:\s*true\s*$/m.test(text.split(/^---$/m)[1] ?? "");

function walk(dir, accept, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(name)) out.push(path);
  }
  return out;
}

const LEARN_COURSE =
  /^https?:\/\/learn\.microsoft\.com\/(?:[a-z]{2}-[a-z]{2}\/)?training\/courses\/([a-z0-9-]+)/i;

/**
 * The hub: { hubPages, cards }. hubPages: Map exam code -> { file, archived } of the exam pages (drafts left out; an
 * active page wins over an archived one of the same code). cards: every card that links a Learn course page, a
 * course short link (aka.ms/<CODE>onYouTube) or a YouTube playlist, in the docs AND the archive:
 * { file, line, page, archived, kind: learn | youtube, key, code, playlist }, `page` the exam code of the file
 * (<area>/<CODE>.mdx) or "" for any other page.
 */
export function scanHub(cfg) {
  const hubPages = new Map();
  const cards = [];
  for (const [dir, archived] of [
    [cfg.docsDir, false],
    [cfg.archiveDir, true],
  ]) {
    const prefix = relative(root, dir).split("\\").join("/");
    for (const file of walk(dir, (n) => /\.mdx?$/.test(n))) {
      const text = readFileSync(file, "utf8");
      if (isDraft(text)) continue;
      const rel = relative(dir, file).split("\\").join("/");
      const label = `${prefix}/${rel}`;
      const exam = new RegExp(
        `^(?:${EXAM_AREAS.join("|")})/([A-Z]{2,3}-\\d{3})\\.mdx?$`,
      ).exec(rel)?.[1];
      if (exam && !(hubPages.has(exam) && !hubPages.get(exam).archived))
        hubPages.set(exam, { file: label, archived });
      for (const card of findLinkCards(stripComments(text))) {
        const learn = LEARN_COURSE.exec(card.href);
        const code = akamsCode(card.href);
        const playlist = code ? "" : playlistOfUrl(card.href);
        if (!learn && !code && !playlist) continue;
        cards.push({
          file: label,
          line: card.line,
          page: exam ?? "",
          archived,
          kind: learn ? "learn" : "youtube",
          key: learn ? learn[1].toLowerCase() : "",
          code: learn ? "" : code || titleCode(card.title),
          playlist,
        });
      }
    }
  }
  return { hubPages, cards };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class Failsafe extends Error {}

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

/** The placement's world (learnsync data, pools, study guides); injectable for tests. */
async function defaultWorld(cfg, fetchImpl, courses) {
  return loadPlacement({
    root,
    env: cfg.env,
    fetchImpl,
    courses,
  });
}

async function runSync(
  cfg,
  {
    fetchImpl = fetch,
    checkOnly = false,
    gh = null,
    world: injected = null,
  } = {},
) {
  const log = (message) => console.log(`[learn-courses] ${message}`);
  const out = {
    changesFound: false,
    baselineUpdated: false,
    extractionFailed: false,
    issueTitle: "",
  };
  try {
    // 1. the file
    let previous = emptyFile();
    let firstRun = true;
    if (existsSync(cfg.trackerFile)) {
      previous = parseFile(readFileSync(cfg.trackerFile, "utf8"));
      firstRun = false;
    }
    const reportedBefore = previous.reported ?? null;

    // 2. the hub
    const { hubPages, cards } = scanHub(cfg);
    if (hubPages.size === 0)
      throw new Failsafe(
        `no exam page found in ${cfg.docsDir}: the folder layout changed?`,
      );
    const exams = readOptionalJson(cfg.examsFile);
    const examCodes = new Set([
      ...(exams?.exams ?? []).map((e) => e.code),
      ...hubPages.keys(),
    ]);
    const retiring = readOptionalJson(cfg.retiringFile)?.exams ?? [];
    const skillsCache = readOptionalJson(cfg.skillsCacheFile);
    const videosFile = readOptionalJson(cfg.videosFile);
    const videos = new Map(Object.entries(videosFile?.courses ?? {}));

    // 3. Learn
    const courses = (
      await readJson(cfg.coursesUrl, cfg.coursesFile, cfg, fetchImpl)
    ).courses;
    if (!Array.isArray(courses) || courses.length < cfg.minCourses)
      throw new Failsafe(
        `the course list has ${courses?.length ?? 0} courses, fewer than MIN_COURSES (${cfg.minCourses}).`,
      );
    let skillRecords = null;
    try {
      skillRecords = (
        await readJson(cfg.skillsUrl, cfg.skillsFile, cfg, fetchImpl)
      ).appliedSkills;
      if (!Array.isArray(skillRecords)) skillRecords = null;
    } catch (error) {
      warnLoud(
        `the Applied Skills list could not be read (${error.message}): the skills of the entries are left as they are.`,
        { title: ANNOTATION_TITLE },
      );
    }

    // 4. failsafe against a shrinking catalog
    const catalogKeys = new Set(
      courses.map((c) => c.uid?.replace(/^course\./i, "").toLowerCase()),
    );
    const tracked = previous.courses.filter(
      (c) => c.state !== "removed" && c.uid,
    );
    const missing = tracked.filter((c) => !catalogKeys.has(c.key));
    if (
      !cfg.forceBaseline &&
      tracked.length >= 20 &&
      missing.length / tracked.length > cfg.maxGonePct / 100
    )
      throw new Failsafe(
        `${missing.length} of ${tracked.length} tracked courses are missing from the catalog at once (more than ${cfg.maxGonePct} percent): the data probably changed shape. Run again with FORCE_BASELINE=1 if the change is real.`,
      );

    // 5. the placement's world: learnsync's learning paths and modules, the study guides
    let world;
    try {
      world = injected ?? (await defaultWorld(cfg, fetchImpl, courses));
    } catch (error) {
      throw new Failsafe(
        `learnsync's data could not be read: ${error.message}`,
      );
    }
    const lp = world.learnsync?.content?.learningPaths ?? [];
    const mods = world.learnsync?.catalog?.modules ?? [];
    const modulesOf = (record) =>
      new Set(
        courseModules(record, { learningPaths: lp, modules: mods }).modules.map(
          (m) => m.path,
        ),
      );
    const skills = skillRecords
      ? skillRecords.map((s) => ({ slug: skillSlug(s), modules: modulesOf(s) }))
      : null;
    const propose =
      world.propose ?? ((course) => placeCourse(world, course).suggestions);

    // 6. sync, check, report
    const { file, changes } = syncCourses({
      previous,
      courses,
      examCodes,
      hubPages,
      retiring,
      modulesOf,
      skills,
      cards,
      videos,
      propose,
      describe: describeSuggestion,
      today: cfg.today,
    });
    const view = checkHub({
      file,
      hubPages,
      cards,
      retiring,
      skillsCache,
      videos,
      today: cfg.today,
    });
    const sums = summarize(file);
    const notes = [];
    if (!skillRecords)
      notes.push(
        "The Applied Skills list could not be read this run, so the skills shown are those of the last run.",
      );
    const report = buildReport({
      file,
      view,
      changes,
      summary: sums,
      date: cfg.today,
      maxRows: cfg.maxRows,
      notes,
    });
    const signature = report ? signatureOf(view) : null;
    // What the issue was last told is only remembered when this run really talks to GitHub: a local run without
    // CREATE_ISSUES must not mark the list as reported, or the first run in CI would find nothing to say.
    const unchanged = (reportedBefore?.signature ?? null) === signature;
    file.reported =
      cfg.createIssues && !cfg.dryRun
        ? {
            signature,
            date: unchanged ? (reportedBefore?.date ?? null) : cfg.today,
          }
        : (reportedBefore ?? { signature: null, date: null });
    const changed = firstRun || comparable(file) !== comparable(previous);
    log(
      `${sums.total} courses (${sums.exam} exam, ${sums.other} other): ${sums.active} assigned, ${sums.new} waiting, ${sums.noPage} no-page, ${sums.removed} removed; ${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed; ${needsCount(view)} need a person`,
    );

    // 7. nothing is written for a check or a dry run
    if (checkOnly || cfg.dryRun) {
      writeFileSync(cfg.reportFile, report || "Nothing needs a person.\n");
      return { ...out, file, changes, view, report };
    }

    // 8. the running issue comes BEFORE the file is written: the workflow commits the file only after this step
    // succeeded, so a failed issue loses no alert (the next run reports the same list again).
    const issue = syncIssue(
      cfg,
      { report, signature, previous: reportedBefore },
      gh,
    );
    out.changesFound =
      issue.action === "created" || issue.action === "commented";
    out.issueTitle = ISSUE_TITLE;
    writeFileSync(cfg.reportFile, report || "");
    if (changed) writeFileSync(cfg.trackerFile, serializeFile(file));
    out.baselineUpdated = changed;
    if (cfg.stepSummary)
      appendStepSummary(
        cfg.stepSummary,
        report || "Learn courses: nothing needs a person.",
      );
    return { ...out, file, changes, view, report, issue };
  } catch (error) {
    out.baselineUpdated = false;
    out.changesFound = false;
    out.extractionFailed = true;
    const message =
      error instanceof Failsafe
        ? `The Learn course tracker stopped by its own failsafe and wrote nothing.\n\n${error.message}\n`
        : `The Learn course tracker failed and wrote nothing.\n\n${error.stack ?? error.message}\n`;
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
    return raiseIssue({
      gh,
      title: ISSUE_TITLE,
      label: ISSUE_LABEL,
      labelColor: "a2eeef",
      labelDescription: "New feature or request",
      body: report + run,
      commentBody: report + run,
    });
  }
  if (!previous?.signature) return none;
  const closed = closeOpenIssues({
    gh,
    title: ISSUE_TITLE,
    label: ISSUE_LABEL,
    comment:
      "Nothing in the Learn course tracker needs a person any more. Closing this issue.",
  });
  if (closed.failures.length)
    warnLoud(
      `could not close the Learn courses issue: ${closed.failures.join("; ")}`,
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
