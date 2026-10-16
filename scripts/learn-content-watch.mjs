#!/usr/bin/env node
/**
 * Daily watch for NEW official Microsoft Learn content for the exams the hub
 * covers: free practice assessments and instructor-led courses with their
 * learning paths.
 *
 * Usage:
 *   node scripts/learn-content-watch.mjs
 *
 * Two independent detectors share one tracker
 * (src/data_files/learn-content-watch.json) and one issue per run:
 *
 * (A) Practice assessments. A hub exam page earns a "Microsoft Learn Practice
 *     Assessment" card once Microsoft publishes the free assessment (usually
 *     within about 8 weeks after general availability). The assessment id in
 *     the URL cannot be guessed, so the Learn page of every exam whose hub page
 *     LACKS that card (same title rule as scripts/audit-missing-resources.mjs,
 *     computed live, never hard-coded) is read every run. The page is the
 *     certification page or the exam page the hub page links in its "Exam" card
 *     (fallback: /credentials/certifications/exams/<code>/). Its state is one of
 *       link         a practice assessment is offered (classic page: the
 *                    practiceAssessmentUid meta tag and the "Take the practice
 *                    assessment" link; new layout: the
 *                    data-practice-assessment-link-* attributes; AI Skills
 *                    Navigator: a callout that links the assessment there);
 *       unavailable  the static sentence "Practice Assessment for this exam is
 *                    not currently available" is shown;
 *       unknown      neither (a page that does not mention practice assessments
 *                    at all, an exam without a Learn page yet, an ambiguous page).
 *     A link is only reported after its address was requested (HTTP 200 and no
 *     redirect to another page; the AI Skills Navigator host answers 200 to
 *     every address, which the issue says). Alerts: unavailable/unknown -> link
 *     ("available", with the exact URL), and "changed, check by hand" for a
 *     sentence that disappeared without a link, a link that disappeared or
 *     changed, a link that does not resolve, an ambiguous page, and (early
 *     signal) the exam's practice route /exams/<code>/practice/assessment
 *     starting to answer 200 although the page shows no link. The route probe
 *     is only trusted while a control exam code that cannot exist answers 404.
 *
 * (B) Official courses. https://learn.microsoft.com/api/catalog/?type=courses
 *     lists the instructor-led courses (course_number, study_guide = the
 *     learning paths and modules the course covers, exam). Each course is
 *     mapped to a hub exam by its number (<CODE>T<nn>, optional -A suffix) or
 *     by its exam field. Alerts:
 *       1. a course for a hub exam exists that the exam page does not link (any
 *          href under /training/courses/<slug>, the end of the course address
 *          in the catalog `url`: usually the lower-cased number, but Learn
 *          drops a suffix such as -A from it); once per course;
 *       2. the learning path / module list of a tracked course changed (added
 *          and removed uids, titles resolved through the catalog uid query,
 *          and whether the hub page already links an added path);
 *       3. a tracked course disappeared from a healthy catalog on two UTC days
 *          in a row (a single odd response never counts).
 *       4. the announced availability date of a future-dated course ("This
 *          course will be available on 10/30/2026" in the catalog summary)
 *          moved or was withdrawn; the exam page states that date in its card
 *          description, and the alert says whether the page states the old one.
 *     A bare last_modified move or a renamed course is never an alert.
 *
 * Rules applied every run:
 *   - First run (no tracker): a silent baseline, EXCEPT that actionable state
 *     is reported once in a single issue: courses the hub pages do not link and
 *     practice assessments that are already published.
 *   - A fetch failure is never evidence of anything: a page or probe that
 *     cannot be read keeps the previous state of that exam (with a warning), and
 *     a course is only "removed" after two consecutive days of absence. A page
 *     that stays unreadable for FAILURE_DAYS days in a row is reported once
 *     ("changed, check by hand"), because the watch for that exam is off.
 *   - The tracker is only rewritten when something other than lastSynced /
 *     lastSeen / lastChecked changed, so a quiet Learn never produces a commit.
 *   - An alert records its own dedupe state in the tracker, so the workflow
 *     opens the issue BEFORE it commits the tracker: when the issue step fails
 *     the next run reports the same things again.
 *
 * Failsafes that fail the run (no tracker write, extraction_failed=true):
 *   - the course catalog is unreachable, is not JSON, lists fewer than
 *     MIN_COURSES courses or its shape changed (uid/title/study_guide);
 *   - no exam page found in DOCS_DIR;
 *   - more than MAX_CHANGES alert items at once (a structure change, not
 *     news); FORCE_BASELINE=1 records them silently instead;
 *   - a corrupt tracker (a malformed record, or a date field that is not
 *     YYYY-MM-DD: the dates are compared as text).
 *
 * Tracker (src/data_files/learn-content-watch.json), sorted by code:
 *   { lastSynced, format, courses: [{ code, number, uid, title, paths:
 *     [{ uid, type, title }], firstSeen, lastSeen, lastChanged?, missingSince?,
 *     availableOn?, removedAt?, unlinkedReported? }], practiceAssessments:
 *     [{ code, state,
 *     detail?, kind?, assessmentId?, url?, candidateUrl?, routeLive, pageUrl,
 *     firstSeen, lastChanged, lastChecked, failedSince?, failureReported? }] }
 *   Only exams whose hub page lacks the practice card are in
 *   practiceAssessments (the record is dropped once the card exists).
 *   failedSince / failureReported exist only while the exam's Learn page cannot
 *   be read (see FAILURE_DAYS); a successful read removes them.
 *
 * Env overrides (defaults shown):
 *   LEARN_BASE_URL       https://learn.microsoft.com
 *   ASN_BASE_URL         https://aiskillsnavigator.microsoft.com (where a
 *                        link found on a Learn page to that host is requested)
 *   TRACKER_FILE        src/data_files/learn-content-watch.json
 *   DOCS_DIR             src/content/docs
 *   REPORT_FILE          <tmpdir>/learn-content-watch-report.md
 *   ERROR_FILE           <tmpdir>/learn-content-watch-error.md
 *   GITHUB_OUTPUT        <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY  unset (when set, a baseline, a forced baseline and any
 *                        warning-worthy condition are appended to it)
 *   MIN_COURSES          100
 *   MAX_CHANGES          15
 *   TITLE_BATCH          20   (uids per catalog title lookup)
 *   FAILURE_DAYS         5    (days in a row an exam's Learn page may stay
 *                        unreadable before one "check by hand" alert says that
 *                        exam is no longer being watched)
 *   FORCE_BASELINE       unset (1 = record everything silently and skip the
 *                        MAX_CHANGES failsafe; the workflow sets it from its
 *                        `force_baseline` input)
 *   FETCH_DELAY_MS       1000 (pause between any two requests; one at a time)
 *   FETCH_ATTEMPTS       3
 *   RETRY_BASE_MS        3000
 *   MAX_RETRY_AFTER_MS   60000
 *   FETCH_TIMEOUT_MS     30000
 *   RUN_DEADLINE_MS      600000
 *   TODAY                today's UTC date (YYYY-MM-DD), for tests
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * practice_alerts, course_alerts, issue_title (raw, not lowercased).
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

export { retryDelayMs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// The title of the workflow annotations (warnings) this monitor makes.
const ANNOTATION_TITLE = "Learn Content Watch";
const EXAM_FILE_RE = /^([A-Z]{2,3}-\d{3})\.mdx$/;
const TRACKER_FORMAT = 1;
const TRACKING = "?WT.mc_id=studentamb_165290";
const TRACKING_AMP = "&WT.mc_id=studentamb_165290";
const PUBLIC_BASE = "https://learn.microsoft.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// The hub's own rule (scripts/audit-missing-resources.mjs): a page has the
// practice assessment when a LinkCard title starts with this text. The AI
// Skills Navigator variant "... (AI Skills Navigator)" counts too.
const PRACTICE_CARD_PREFIX = "Microsoft Learn Practice Assessment";
const PRACTICE_CARD_DESCRIPTION =
  "Mini test that shows examples of how exam questions are structured. It is not equivalent to the real exams in format/difficulty. It is easier than real exams.";
const UNAVAILABLE_RE =
  /practice assessment for this exam is not currently available/i;
const ASN_HOST = "aiskillsnavigator.microsoft.com";
// An exam code that cannot exist: the practice route must answer 404 for it,
// otherwise the route no longer tells a real exam from a missing one.
const CONTROL_EXAM_CODE = "zz-000";
const COURSE_NUMBER_RE = /^([A-Z]{2,3}-\d{3})T\d{2}(?:-[A-Z])?$/;
const SAFE_COURSE_NUMBER_RE = /^[A-Z0-9._-]{1,40}$/;
// A course slug ends up in a link: plain lower-case characters only.
const COURSE_SLUG_RE = /^[a-z0-9._-]{1,80}$/;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const REPORT_MAX_CHARS = 60000;
const ROW_LIMITS = [
  { perCourse: 40, total: 200 },
  { perCourse: 15, total: 60 },
  { perCourse: 5, total: 20 },
  { perCourse: 0, total: 0 },
];

class ExtractionError extends Error {}

const stats = { requests: 0 };
let lastRequestEnd = 0;

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

export function loadConfig(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    baseUrl: (env.LEARN_BASE_URL || PUBLIC_BASE).replace(/\/+$/, ""),
    asnBaseUrl: (env.ASN_BASE_URL || `https://${ASN_HOST}`).replace(/\/+$/, ""),
    trackerFile: resolveFromRoot(
      env.TRACKER_FILE ?? "src/data_files/learn-content-watch.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? "src/content/docs"),
    reportFile:
      env.REPORT_FILE ?? join(tmpdir(), "learn-content-watch-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "learn-content-watch-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    minCourses: num("MIN_COURSES", 100),
    maxChanges: num("MAX_CHANGES", 15),
    titleBatch: Math.max(1, num("TITLE_BATCH", 20)),
    failureDays: Math.max(1, num("FAILURE_DAYS", 5)),
    forceBaseline: env.FORCE_BASELINE === "1",
    fetchDelayMs: num("FETCH_DELAY_MS", 1000),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 3000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    deadlineMs: num("RUN_DEADLINE_MS", 10 * 60 * 1000),
    today,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      safeCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributesOf(source) {
  const attrs = {};
  for (const match of source.matchAll(
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/**
 * A name taken from a Learn page, for a table cell of a public issue: no HTML,
 * links, code spans or table breaks, and no @mention or #123 cross-reference (a
 * zero-width space after the sign stops GitHub from linking it).
 */
export function safeText(text) {
  return collapse(
    collapse(text)
      .replace(/[<>`[\]]/g, " ")
      .replace(/\|/g, "/")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE),
  );
}

export function markdownUrl(url) {
  return String(url).replace(
    /[()\s<>`"]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** A value for a fenced code block: the fence can never be closed from inside. */
function fenceSafe(text) {
  return String(text).replace(/`{3,}/g, "``");
}

// ---------------------------------------------------------------------------
// Fetching (polite: one request at a time, a pause between any two requests)
// ---------------------------------------------------------------------------
export function makeDeadline(ms, now = Date.now) {
  const at = now() + ms;
  return {
    expired: () => now() >= at,
    remaining: () => Math.max(0, at - now()),
  };
}

/**
 * GET with retries for rate limits, server errors and network errors. A
 * successful answer carries the final URL (after redirects). Any other status
 * is returned as { ok: false, status } so the caller can tell a definite 404
 * from a transient failure.
 */
async function fetchText(cfg, url, deadline = null) {
  let status;
  let error;

  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    if (deadline?.expired()) {
      return { ok: false, status, error, deadline: true };
    }
    const wait = cfg.fetchDelayMs - (Date.now() - lastRequestEnd);
    if (wait > 0) await sleep(wait);

    let retryAfter = null;
    try {
      stats.requests++;
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(
          deadline
            ? Math.max(1, Math.min(cfg.timeoutMs, deadline.remaining()))
            : cfg.timeoutMs,
        ),
      });
      if (response.ok) {
        const text = await response.text();
        lastRequestEnd = Date.now();
        return { ok: true, status: response.status, text, url: response.url };
      }
      lastRequestEnd = Date.now();
      status = response.status;
      error = undefined;
      retryAfter = response.headers.get("retry-after");
      // A missing page is an answer (the practice route probe expects it).
      if (status !== 404 && status !== 410) {
        console.error(
          `WARNING: ${url} attempt ${attempt} failed (${response.status})`,
        );
      }
      // Only rate limits and server errors are worth another try.
      if (status !== 429 && status < 500) return { ok: false, status };
    } catch (err) {
      lastRequestEnd = Date.now();
      error = err;
      status = undefined;
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${err.message})`,
      );
    }

    if (attempt < cfg.fetchAttempts) {
      const delay = retryDelayMs({
        attempt,
        retryAfter,
        baseMs: cfg.retryBaseMs,
        maxMs: cfg.maxRetryAfterMs,
      });
      await sleep(deadline ? Math.min(delay, deadline.remaining()) : delay);
    }
  }
  return { ok: false, status, error, deadline: Boolean(deadline?.expired()) };
}

// ---------------------------------------------------------------------------
// The hub's exam pages
// ---------------------------------------------------------------------------
export function stripComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Every <LinkCard ...> tag as an attribute map (quoted values may hold ">"). */
export function parseLinkCards(text) {
  const cards = [];
  for (const match of text.matchAll(
    /<LinkCard\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g,
  )) {
    const attrs = attributesOf(match[1]);
    cards.push({ title: collapse(attrs.title ?? ""), href: attrs.href ?? "" });
  }
  return cards;
}

/**
 * An AI Skills Navigator address without query, fragment or trailing slash, or
 * null for any other link. Two links to the same credential compare equal.
 */
export function asnAddress(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.hostname !== ASN_HOST) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function slugsAfter(text, segment) {
  const slugs = new Set();
  const re = new RegExp(`/training/${segment}/([A-Za-z0-9._-]+)`, "g");
  for (const match of text.matchAll(re)) slugs.add(match[1].toLowerCase());
  return slugs;
}

/**
 * The Learn page the hub page names as the exam: the "Exam <CODE>" LinkCard
 * that points under /credentials/certifications/ (never a study guide or a
 * practice route). Returns the path only (no host, query or fragment) with a
 * trailing slash, or null.
 */
export function examPagePath(cards, code) {
  const wanted = `exam ${code.toLowerCase()}`;
  const learnCert = (card) =>
    /^https?:\/\/learn\.microsoft\.com(?:\/en-us)?\/credentials\/certifications\//i.test(
      card.href,
    ) &&
    !/\/resources\/study-guides\//i.test(card.href) &&
    !/\/practice\//i.test(card.href);
  const candidates = cards.filter(learnCert);
  const card =
    candidates.find((c) => c.title.toLowerCase().startsWith(wanted)) ??
    candidates.find((c) => /^exam\s/i.test(c.title));
  if (!card) return null;
  try {
    const path = new URL(card.href).pathname.replace(/^\/en-us(?=\/)/i, "");
    return path.endsWith("/") ? path : `${path}/`;
  } catch {
    return null;
  }
}

/** One hub exam page, parsed. `raw` is the file content. */
export function parseHubPage(raw, code, area) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  const draft = frontmatter
    ? /^draft:\s*true\s*$/m.test(frontmatter[1])
    : false;
  const text = stripComments(normalized);
  const cards = parseLinkCards(text);
  const titles = cards.map((card) => card.title);
  return {
    code,
    area,
    path: `src/content/docs/${area}/${code}.mdx`,
    draft,
    // Same title rule as scripts/audit-missing-resources.mjs.
    hasPracticeCard: titles.some((title) =>
      title.startsWith(PRACTICE_CARD_PREFIX),
    ),
    // "PL-200: Microsoft Learn Practice Assessment": a predecessor's card used
    // as a stand-in until the exam has its own.
    standIns: cards
      .filter((card) =>
        /^[A-Z]{2,3}-\d{3}:\s*Microsoft Learn Practice Assessment/.test(
          card.title,
        ),
      )
      .map((card) => card.title),
    examPath: examPagePath(cards, code),
    // The AI Skills Navigator credentials this page links, to tell an address
    // that belongs to this exam from one that Learn repeats for other exams.
    asnUrls: [
      ...new Set(cards.map((card) => asnAddress(card.href)).filter(Boolean)),
    ],
    // The page text without comments: whether it states a date is checked when
    // a course's availability date changes.
    text,
    courseSlugs: slugsAfter(text, "courses"),
    pathSlugs: slugsAfter(text, "paths"),
    moduleSlugs: slugsAfter(text, "modules"),
  };
}

/** Every non-draft exam page in the hub areas: Map code -> parsed page. */
export function scanHub(cfg) {
  const hub = new Map();
  for (const area of EXAM_AREAS) {
    let files = [];
    try {
      files = readdirSync(join(cfg.docsDir, area));
    } catch {
      continue; // an area directory that does not exist covers nothing
    }
    for (const file of files) {
      const match = file.match(EXAM_FILE_RE);
      if (!match) continue;
      const page = parseHubPage(
        readFileSync(join(cfg.docsDir, area, file), "utf8"),
        match[1],
        area,
      );
      if (!page.draft) hub.set(page.code, page);
    }
  }
  return new Map([...hub].sort((a, b) => byCodePoint(a[0], b[0])));
}

// ---------------------------------------------------------------------------
// (B) The course catalog
// ---------------------------------------------------------------------------
/** "exam.ab-650" -> "AB-650"; null for anything else. */
function examCodeFromUid(uid) {
  const match = String(uid ?? "")
    .trim()
    .match(/^exam\.([A-Za-z]{2,3}-\d{3})$/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Validates and normalizes the catalog answer. A shape the check does not know
 * is a failure, never "no courses".
 */
export function parseCourseCatalog(json, minCourses) {
  if (!json || typeof json !== "object" || !Array.isArray(json.courses)) {
    throw new ExtractionError(
      "The course catalog answer has no `courses` list. The API shape may have changed; the tracker was not modified.",
    );
  }
  const raw = json.courses.filter(
    (course) => course && typeof course === "object",
  );
  if (raw.length < minCourses) {
    throw new ExtractionError(
      `The course catalog lists only ${raw.length} courses (expected at least ${minCourses}). The API shape or filter may have changed; the tracker was not modified.`,
    );
  }
  const wellFormed = raw.filter(
    (course) =>
      typeof course.uid === "string" &&
      course.uid !== "" &&
      typeof course.title === "string" &&
      course.title !== "",
  );
  if (wellFormed.length * 10 < raw.length * 9) {
    throw new ExtractionError(
      `Only ${wellFormed.length} of ${raw.length} catalog courses have a uid and a title. The API shape may have changed; the tracker was not modified.`,
    );
  }
  const withGuide = wellFormed.filter((course) =>
    Array.isArray(course.study_guide),
  );
  if (withGuide.length * 2 < wellFormed.length) {
    throw new ExtractionError(
      `Only ${withGuide.length} of ${wellFormed.length} catalog courses carry a study_guide list. The API shape may have changed; the tracker was not modified.`,
    );
  }

  const seen = new Set();
  const courses = [];
  for (const course of wellFormed) {
    if (seen.has(course.uid)) continue;
    seen.add(course.uid);
    courses.push({
      uid: course.uid,
      number: collapse(course.course_number).toUpperCase(),
      title: collapse(course.title),
      // The address of the course page: its last segment is the slug (see courseSlug).
      url: typeof course.url === "string" ? course.url : "",
      exam: examCodeFromUid(course.exam),
      summary: typeof course.summary === "string" ? course.summary : "",
      // null = the field is absent (no data), [] = a real empty list.
      studyGuide: Array.isArray(course.study_guide)
        ? course.study_guide
            .filter(
              (entry) =>
                entry &&
                typeof entry.uid === "string" &&
                entry.uid !== "" &&
                /^[A-Za-z]+$/.test(String(entry.type ?? "")),
            )
            .map((entry) => ({ uid: entry.uid, type: entry.type }))
        : null,
    });
  }
  return courses;
}

/**
 * The last segment of the address of a catalog course: what the hub page links
 * (/training/courses/<slug>) and what the issue links to. It is not always the
 * lower-cased course number: Learn drops a suffix of the number (AZ-104T00-A is
 * served at /training/courses/az-104t00) and writes some numbers differently
 * (MSLEAIBootcampFUN is msle-ai-bootcamp-fun). Taken from the catalog `url`, else
 * from the `uid` (course.<slug>), else the lower-cased number.
 */
export function courseSlug({ url, uid, number } = {}) {
  const usable = (slug) => COURSE_SLUG_RE.test(slug) && slug;
  let fromUrl = "";
  try {
    fromUrl =
      /\/training\/courses\/([^/]+)\/?$/i.exec(new URL(url).pathname)?.[1] ??
      "";
  } catch {
    /* no usable address */
  }
  const fromUid = /^course\.(.+)$/i.exec(String(uid ?? ""))?.[1] ?? "";
  return (
    usable(fromUrl.toLowerCase()) ||
    usable(fromUid.toLowerCase()) ||
    String(number ?? "").toLowerCase()
  );
}
export function mapCoursesToExams(courses, hubCodes) {
  const map = new Map();
  const add = (code, course) => {
    if (!map.has(code)) map.set(code, []);
    if (!map.get(code).some((c) => c.uid === course.uid))
      map.get(code).push(course);
  };
  for (const course of courses) {
    // The number ends up in links, table cells and the issue title: a value
    // that is not a plain course number (markup, spaces) maps to nothing.
    if (!SAFE_COURSE_NUMBER_RE.test(course.number)) continue;
    const match = course.number.match(COURSE_NUMBER_RE);
    if (match && hubCodes.has(match[1])) add(match[1], course);
    if (course.exam && hubCodes.has(course.exam)) add(course.exam, course);
  }
  for (const list of map.values())
    list.sort((a, b) => byCodePoint(a.number, b.number));
  return new Map([...map].sort((a, b) => byCodePoint(a[0], b[0])));
}

/** "This course will be available on 10/30/2026" in the catalog summary. */
export function availabilityNote(summary) {
  const text = stripTags(String(summary ?? ""));
  const match = text.match(/available on (\d{1,2}\/\d{1,2}\/\d{4})/i);
  return match ? `the catalog says it will be available on ${match[1]}` : "";
}

/** The announced availability date of a future-dated course: "2026-10-30", or "". */
export function availabilityDate(summary) {
  const text = stripTags(String(summary ?? ""));
  const match = text.match(/available on (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return "";
  const [month, day, year] = [match[1], match[2], match[3]].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // A day that does not exist (13/45/2026) is not a date.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return date.toISOString().slice(0, 10);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-30" -> "October 30, 2026", the way the hub pages write dates. */
export function longDate(iso) {
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

async function fetchCourseCatalog(cfg, deadline) {
  const url = `${cfg.baseUrl}/api/catalog/?type=courses&locale=en-us`;
  const response = await fetchText(cfg, url, deadline);
  if (!response.ok) {
    throw new ExtractionError(
      `The course catalog could not be read (${response.deadline ? "run deadline reached" : `status ${response.status ?? "network error"}`}). The tracker was not modified.`,
    );
  }
  let json;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new ExtractionError(
      "The course catalog answer is not JSON. The API may have changed; the tracker was not modified.",
    );
  }
  return json;
}

/** The public form of a catalog URL: no locale, the repo's tracking parameter. */
export function publicLearnUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/en-us(?=\/)/i, "");
    return `${PUBLIC_BASE}${path}${TRACKING}`;
  } catch {
    return "";
  }
}

function slugOfCatalogUrl(url) {
  const match = String(url ?? "").match(
    /\/training\/(?:paths|modules)\/([A-Za-z0-9._-]+)/,
  );
  return match ? match[1].toLowerCase() : "";
}

/**
 * Titles and addresses of learning paths and modules by uid (the catalog uid
 * query, in batches). A batch that fails is skipped with a warning: a missing
 * title never blocks an alert, the uid is shown instead.
 */
async function resolveTitles(cfg, uids, deadline) {
  const found = new Map();
  const list = [...uids];
  for (let i = 0; i < list.length; i += cfg.titleBatch) {
    const batch = list.slice(i, i + cfg.titleBatch);
    const url = `${cfg.baseUrl}/api/catalog/?locale=en-us&uid=${batch.map(encodeURIComponent).join(",")}`;
    const response = await fetchText(cfg, url, deadline);
    if (!response.ok) {
      warnLoud(
        `Could not resolve ${batch.length} learning path titles (status ${response.status ?? "network error"}); their uids are shown instead.`,
        { title: ANNOTATION_TITLE },
      );
      continue;
    }
    let json;
    try {
      json = JSON.parse(response.text);
    } catch {
      warnLoud("The catalog title lookup did not answer with JSON.", {
        title: ANNOTATION_TITLE,
      });
      continue;
    }
    for (const key of ["learningPaths", "modules"]) {
      for (const item of Array.isArray(json?.[key]) ? json[key] : []) {
        if (typeof item?.uid !== "string" || typeof item?.title !== "string")
          continue;
        found.set(item.uid, {
          title: collapse(item.title),
          url: typeof item.url === "string" ? publicLearnUrl(item.url) : "",
          slug: slugOfCatalogUrl(item.url),
        });
      }
    }
  }
  return found;
}

/**
 * The course side of one run: tracker records plus the four kinds of alerts
 * (unlinked course, changed learning paths, changed availability date, removed
 * course).
 * Pure: `titles` is a Map uid -> { title, url, slug } of resolved lookups, and
 * `needTitles` is the set of uids that still have no title (the caller fetches
 * them and calls again).
 */
export function evaluateCourses({
  previous,
  courseMap,
  hub,
  today,
  titles = new Map(),
}) {
  const prevByKey = new Map(previous.map((r) => [`${r.code}|${r.number}`, r]));
  const prevUidOwners = new Map(); // uid -> Set(course numbers) before this run
  for (const record of previous) {
    for (const entry of record.paths) {
      if (!prevUidOwners.has(entry.uid))
        prevUidOwners.set(entry.uid, new Set());
      prevUidOwners.get(entry.uid).add(record.number);
    }
  }

  const records = [];
  const unlinked = [];
  const pathChanges = [];
  const availability = [];
  const removed = [];
  const warnings = [];
  const needTitles = new Set();
  const seen = new Set();

  for (const [code, courses] of courseMap) {
    const page = hub.get(code);
    if (!page) continue;
    for (const course of courses) {
      const key = `${code}|${course.number}`;
      seen.add(key);
      const prev = prevByKey.get(key);
      // What the hub page links and the issue links to: the end of the course
      // address, which is not always the lower-cased number.
      const courseUrlSlug = courseSlug(course);
      const linked = page.courseSlugs.has(courseUrlSlug);

      const titleOf = (uid) =>
        prev?.paths.find((entry) => entry.uid === uid)?.title ||
        titles.get(uid)?.title ||
        "";
      let paths;
      if (course.studyGuide === null && prev) {
        paths = prev.paths; // no data this run: keep what was known
        warnings.push(
          `${course.number}: the catalog entry has no study_guide list this run; its learning paths were kept as they were.`,
        );
      } else {
        paths = (course.studyGuide ?? [])
          .map((entry) => ({
            uid: entry.uid,
            type: entry.type,
            title: titleOf(entry.uid),
          }))
          .sort((a, b) => byCodePoint(a.uid, b.uid));
      }
      for (const entry of paths) if (!entry.title) needTitles.add(entry.uid);

      let pathsChanged = false;
      if (prev) {
        const before = new Set(prev.paths.map((entry) => entry.uid));
        const after = new Set(paths.map((entry) => entry.uid));
        const added = paths.filter((entry) => !before.has(entry.uid));
        const gone = prev.paths.filter((entry) => !after.has(entry.uid));
        if (added.length > 0 || gone.length > 0) {
          pathsChanged = true;
          pathChanges.push({
            code,
            number: course.number,
            slug: courseUrlSlug,
            title: course.title,
            added: added.map((entry) => {
              const info = titles.get(entry.uid);
              const slug = info?.slug ?? "";
              const hubLinks =
                entry.type === "module" ? page.moduleSlugs : page.pathSlugs;
              return {
                uid: entry.uid,
                type: entry.type,
                title: entry.title || info?.title || "",
                url: info?.url ?? "",
                linked: slug ? hubLinks.has(slug) : null,
                alsoIn: [...(prevUidOwners.get(entry.uid) ?? [])]
                  .filter((number) => number !== course.number)
                  .sort(byCodePoint),
              };
            }),
            removed: gone.map((entry) => ({
              uid: entry.uid,
              type: entry.type,
              title: entry.title,
            })),
          });
        }
      }

      // The announced availability date of a future-dated course ("This course
      // will be available on 10/30/2026"). The hub page states it in the card
      // description, so a moved or withdrawn date makes the page wrong. A
      // catalog entry without summary text is no data: the known date stays.
      const hasSummary =
        typeof course.summary === "string" && course.summary.trim() !== "";
      const availableOn = hasSummary
        ? availabilityDate(course.summary)
        : (prev?.availableOn ?? "");
      let availabilityChanged = false;
      if (prev && hasSummary && (prev.availableOn ?? "") !== availableOn) {
        availabilityChanged = true;
        availability.push({
          code,
          number: course.number,
          slug: courseUrlSlug,
          title: course.title,
          from: prev.availableOn ?? "",
          to: availableOn,
          pagePath: page.path,
          // Does the hub page state the old / the new date? (null: no such date)
          statesOld: prev.availableOn
            ? page.text.includes(longDate(prev.availableOn))
            : null,
          statesNew: availableOn
            ? page.text.includes(longDate(availableOn))
            : null,
        });
      }

      let unlinkedReported = linked ? undefined : prev?.unlinkedReported;
      if (!linked && !prev?.unlinkedReported) {
        unlinked.push({
          code,
          number: course.number,
          slug: courseUrlSlug,
          title: course.title,
          reason: prev ? "not-linked" : "new-course",
          note: availabilityNote(course.summary),
          pagePath: page.path,
        });
        unlinkedReported = today;
      }

      const record = {
        code,
        number: course.number,
        uid: course.uid,
        title: course.title,
        paths,
        firstSeen: prev?.firstSeen ?? today,
        lastSeen: today,
      };
      if (availableOn) record.availableOn = availableOn;
      const changedNow =
        !prev ||
        pathsChanged ||
        availabilityChanged ||
        prev.title !== course.title;
      const lastChanged = changedNow ? today : prev.lastChanged;
      if (lastChanged) record.lastChanged = lastChanged;
      if (unlinkedReported) record.unlinkedReported = unlinkedReported;
      records.push(record);
    }
  }

  // Tracked courses the catalog does not list now.
  for (const prev of previous) {
    const key = `${prev.code}|${prev.number}`;
    if (seen.has(key)) continue;
    if (!hub.has(prev.code)) continue; // the exam page is gone: forget it
    if (prev.removedAt) {
      records.push(prev); // already reported
      continue;
    }
    const record = { ...prev };
    if (!prev.missingSince) {
      record.missingSince = today;
      warnings.push(
        `${prev.number} is not in the catalog today; it is reported if it is still missing on a later day.`,
      );
    } else if (prev.missingSince < today) {
      removed.push({
        code: prev.code,
        number: prev.number,
        slug: courseSlug(prev),
        title: prev.title,
        missingSince: prev.missingSince,
      });
      delete record.missingSince;
      record.removedAt = today;
      record.lastChanged = today;
    }
    records.push(record);
  }

  records.sort(
    (a, b) => byCodePoint(a.code, b.code) || byCodePoint(a.number, b.number),
  );
  return {
    records,
    unlinked,
    pathChanges,
    availability,
    removed,
    needTitles,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// (A) Practice assessments: reading a Learn exam / certification page
// ---------------------------------------------------------------------------
function metaMap(html) {
  const metas = [];
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributesOf(match[1]);
    if (attrs.name)
      metas.push({ name: attrs.name, content: attrs.content ?? "" });
  }
  return metas;
}

/** True for a certification or exam page (not a 404, a bot check or a login). */
export function isLearnCredentialPage(html) {
  const uid = metaMap(html).find((meta) => meta.name === "uid")?.content ?? "";
  return /^(?:certification|exam)\./i.test(uid);
}

/** Every exam code the page talks about (meta, exam cards, scheduling links). */
export function pageExamCodes(html) {
  const codes = new Set();
  const add = (value) => {
    const code = examCodeFromUid(value);
    if (code) codes.add(code);
  };
  for (const meta of metaMap(html)) {
    if (meta.name === "learn_exam" || meta.name === "uid") add(meta.content);
  }
  for (const match of html.matchAll(/examUid=(exam\.[A-Za-z0-9-]+)/g))
    add(match[1]);
  for (const match of html.matchAll(
    /data-practice-assessment-link-exam-uid="([^"]*)"/g,
  ))
    add(match[1]);
  for (const match of html.matchAll(
    /class="exam-card-title"[^>]*>\s*([A-Z]{2,3}-\d{3}):/g,
  ))
    codes.add(match[1]);
  return codes;
}

const ASSESSMENT_ID_RE = /^\d{1,15}$/;

/**
 * Practice assessment signals on the page: ids offered (with the exam they
 * belong to when the markup says so) and AI Skills Navigator links.
 */
export function practiceSignals(html) {
  const ids = []; // { id, exam|null, source, certificationType? }
  const external = []; // { url }

  for (const match of html.matchAll(
    /<a\b[^>]*data-practice-assessment-link[^>]*>/gi,
  )) {
    const attrs = attributesOf(match[0]);
    const id = attrs["data-practice-assessment-link-assessment-uid"] ?? "";
    if (ASSESSMENT_ID_RE.test(id)) {
      ids.push({
        id,
        exam: examCodeFromUid(attrs["data-practice-assessment-link-exam-uid"]),
        source: "data attributes",
      });
    }
  }
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const href = decodeEntities(match[1]);
    if (!/practice\/assessment/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, `${PUBLIC_BASE}/credentials/certifications/x/`);
    } catch {
      continue;
    }
    const id = url.searchParams.get("assessmentId") ?? "";
    if (!ASSESSMENT_ID_RE.test(id)) continue;
    const exam = url.pathname.match(/\/exams\/([A-Za-z]{2,3}-\d{3})\//i);
    ids.push({
      id,
      exam: exam ? exam[1].toUpperCase() : null,
      source: "link",
    });
  }
  const metaId = metaMap(html).find(
    (meta) => meta.name === "practiceAssessmentUid",
  )?.content;
  if (metaId && ASSESSMENT_ID_RE.test(metaId.trim())) {
    ids.push({ id: metaId.trim(), exam: null, source: "page metadata" });
  }
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attributesOf(match[0]).href ?? "";
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== ASN_HOST) continue;
    const around = stripTags(
      html.slice(Math.max(0, match.index - 600), match.index + 600),
    );
    if (/practice assessment/i.test(around)) {
      external.push({ url: `${url.origin}${url.pathname}` });
    }
  }
  return { ids, external };
}

/**
 * The state of one exam from its Learn page.
 * Returns { state, detail?, kind?, assessmentId?, rawUrl?, extraIds? } where
 * state is "link" | "unavailable" | "unknown".
 */
export function classifyPracticePage(html, code) {
  if (!isLearnCredentialPage(html)) {
    return { state: "unknown", detail: "not-a-credential-page" };
  }
  const examCodes = pageExamCodes(html);
  const { ids, external } = practiceSignals(html);
  const sentence = UNAVAILABLE_RE.test(stripTags(html));

  // A signal that names another exam is not this exam's. One that names no
  // exam (the page metadata, a callout) belongs to this exam only when the
  // page is about this exam alone.
  const mine = ids.filter((entry) => entry.exam === code);
  const unassociated = ids.filter((entry) => entry.exam === null);
  // A classic page may carry no machine-readable exam code at all (AZ-802's
  // certification page only names it in text): the hub links the page for this
  // exam, so it is trusted until the markup names other exams.
  const alone =
    examCodes.size === 0 || (examCodes.size === 1 && examCodes.has(code));
  const listed = examCodes.size === 0 || examCodes.has(code);

  if (mine.length > 0 || (unassociated.length > 0 && alone)) {
    const chosen = mine.length > 0 ? mine : unassociated;
    const distinct = [...new Set(chosen.map((entry) => entry.id))];
    return {
      state: "link",
      kind: "learn",
      assessmentId: distinct[0],
      extraIds: distinct.slice(1),
      source: chosen[0].source,
    };
  }
  if (external.length > 0 && alone) {
    return { state: "link", kind: "asn", rawUrl: external[0].url };
  }
  if (unassociated.length > 0 || external.length > 0) {
    // Practice assessments are offered, but not provably for this exam.
    return { state: "unknown", detail: "ambiguous" };
  }
  if (!listed) {
    return { state: "unknown", detail: "exam-not-listed" };
  }
  if (sentence) return { state: "unavailable" };
  return { state: "unknown", detail: "no-mention" };
}

/**
 * The addresses a practice assessment found on Learn can have, best first, in
 * the hub's URL form (no locale, tracking parameter kept). The page's own path
 * comes first because that is where Learn's own link points (a certification
 * path: <cert>/practice/assessment); the exam path
 * /exams/<code>/practice/assessment only exists for exams that have an exam
 * page (DP-700, for one, answers 404 there). The first address that resolves
 * is the one reported.
 * `practice-assessment-type=certification` belongs to a certification route
 * only: the exam route, which is also what the page of an exam is, is written
 * without it (AGENTS.md > URL Formats), so for an exam whose only candidate is
 * the exam route the card to paste has no such parameter.
 */
export function practiceUrlCandidates({
  code,
  kind,
  assessmentId,
  rawUrl,
  pagePath,
}) {
  if (kind === "asn") return [rawUrl];
  const query = `assessment-type=practice&assessmentId=${assessmentId}`;
  const address = (route, extra = "") =>
    `${PUBLIC_BASE}${route}/practice/assessment?${query}${extra}${TRACKING_AMP}`;
  const forms = [];
  if (pagePath && pagePath.startsWith("/credentials/certifications/")) {
    const route = pagePath.replace(/\/+$/, "");
    forms.push(
      /^\/credentials\/certifications\/exams\/[^/]+$/i.test(route)
        ? address(route)
        : address(route, "&practice-assessment-type=certification"),
    );
  }
  forms.push(
    address(`/credentials/certifications/exams/${code.toLowerCase()}`),
  );
  return [...new Set(forms)];
}

function samePath(finalUrl, requestedUrl) {
  const path = (value) => {
    try {
      return new URL(value).pathname
        .replace(/^\/en-us(?=\/)/i, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    } catch {
      return null;
    }
  };
  return path(finalUrl) !== null && path(finalUrl) === path(requestedUrl);
}

/**
 * Requests an address: "ok" (200 and no redirect to another page), "missing"
 * (404/410, or a redirect to another page) or "unverified" (anything that is
 * not evidence: rate limits, 5xx, timeouts, other 4xx).
 */
async function checkResolves(cfg, url, deadline) {
  const response = await fetchText(cfg, url, deadline);
  if (response.ok) {
    return samePath(response.url, url) ? "ok" : "missing";
  }
  if (response.status === 404 || response.status === 410) return "missing";
  return "unverified";
}

/** The request address of a public Learn path on the configured base. */
function onBase(cfg, publicUrl) {
  const url = new URL(publicUrl);
  return `${cfg.baseUrl}/en-us${url.pathname}${url.search}`;
}

/** The request address of an AI Skills Navigator link on its configured base. */
function onAsnBase(cfg, publicUrl) {
  const url = new URL(publicUrl);
  return `${cfg.asnBaseUrl}${url.pathname}${url.search}`;
}

/**
 * Does the exam's practice route exist? true / false, or null when the answer
 * is no evidence. Only called while the control probe says the route
 * discriminates.
 */
async function probeRoute(cfg, code, deadline) {
  const url = `${cfg.baseUrl}/en-us/credentials/certifications/exams/${code.toLowerCase()}/practice/assessment?assessment-type=practice&assessmentId=1`;
  const response = await fetchText(cfg, url, deadline);
  if (response.ok) return samePath(response.url, url);
  if (response.status === 404 || response.status === 410) return false;
  return null;
}

/**
 * Reads the Learn page of one exam and turns it into an observation:
 *   { failed: true, status?, reason } when nothing can be concluded, else
 *   { state, detail?, kind?, assessmentId?, url?, candidateUrl?, extraIds?,
 *     spaHost?, routeLive, pageUrl }
 */
async function observePractice(cfg, page, ctx, deadline) {
  const path =
    page.examPath ??
    `/credentials/certifications/exams/${page.code.toLowerCase()}/`;
  let pageUrl = `${PUBLIC_BASE}${path}`;
  const response = await fetchText(
    cfg,
    `${cfg.baseUrl}/en-us${path}`,
    deadline,
  );

  let routeLive = null;
  if (ctx.routeUsable) {
    routeLive = await probeRoute(cfg, page.code, deadline);
  }

  if (!response.ok) {
    return {
      failed: true,
      status: response.status,
      reason: response.deadline
        ? "run deadline reached"
        : `status ${response.status ?? "network error"}`,
      routeLive,
      pageUrl,
    };
  }

  // The page the request ended on (an exam URL may redirect to its
  // certification page): that is where the signals were read.
  let pagePath = null;
  try {
    pagePath = new URL(response.url).pathname.replace(/^\/en-us(?=\/)/i, "");
    pageUrl = `${PUBLIC_BASE}${pagePath}`;
  } catch {
    /* keep the requested address */
  }

  const found = classifyPracticePage(response.text, page.code);
  if (found.detail === "not-a-credential-page") {
    return {
      failed: true,
      reason: "the answer is not a certification or exam page",
      routeLive,
      pageUrl,
    };
  }
  if (found.state !== "link") {
    return { ...found, routeLive, pageUrl };
  }

  // The first address that resolves wins; if none does the link is reported
  // as not resolving, and if any attempt was inconclusive nothing is concluded.
  const candidates = practiceUrlCandidates({
    code: page.code,
    pagePath,
    ...found,
  });
  let url = null;
  let inconclusive = false;
  for (const candidate of candidates) {
    const check = await checkResolves(
      cfg,
      found.kind === "asn" ? onAsnBase(cfg, candidate) : onBase(cfg, candidate),
      deadline,
    );
    if (check === "ok") {
      url = candidate;
      break;
    }
    if (check === "unverified") inconclusive = true;
  }
  if (!url && inconclusive) {
    return {
      failed: true,
      reason: "the practice assessment address could not be verified",
      routeLive,
      pageUrl,
    };
  }
  if (!url) {
    return {
      state: "unknown",
      detail: "link-not-resolving",
      kind: found.kind,
      candidateUrl: candidates[0],
      routeLive,
      pageUrl,
    };
  }
  return {
    state: "link",
    kind: found.kind,
    assessmentId: found.assessmentId,
    extraIds: found.extraIds,
    url,
    spaHost: found.kind === "asn",
    routeLive,
    pageUrl,
  };
}

/**
 * An AI Skills Navigator address is one credential. When Learn offers the same
 * address for several exams, or offers one that another exam's hub page
 * already links, it cannot be this exam's: checked 2026-10-14, the Learn pages
 * of AB-210, AB-250, AB-410 and AB-620 all point at the address that AI-300's
 * card links, so suggesting it four times would hand the maintainers a wrong
 * card to paste. Such an observation is demoted to unknown / `shared-link`
 * (the candidate address is kept for the log). Pure.
 *
 * `entries` is [{ code, observation }]; `hubPages` is every parsed hub page.
 * Returns { entries, demoted: [{ code, address, sharedWith }] }.
 */
export function demoteSharedAsnLinks(entries, hubPages) {
  const users = new Map(); // address -> Set of exam codes using it
  const use = (address, code) => {
    if (!users.has(address)) users.set(address, new Set());
    users.get(address).add(code);
  };
  for (const page of hubPages) {
    for (const address of page.asnUrls ?? []) use(address, page.code);
  }
  const addressOf = (observation) =>
    observation?.state === "link" && observation.kind === "asn"
      ? asnAddress(observation.url)
      : null;
  for (const { code, observation } of entries) {
    const address = addressOf(observation);
    if (address) use(address, code);
  }
  const demoted = [];
  const next = entries.map((entry) => {
    const address = addressOf(entry.observation);
    if (!address) return entry;
    const sharedWith = [...users.get(address)]
      .filter((other) => other !== entry.code)
      .sort();
    if (sharedWith.length === 0) return entry;
    demoted.push({ code: entry.code, address, sharedWith });
    const { routeLive, pageUrl, url } = entry.observation;
    return {
      ...entry,
      observation: {
        state: "unknown",
        detail: "shared-link",
        kind: "asn",
        candidateUrl: url,
        routeLive,
        pageUrl,
      },
    };
  });
  return { entries: next, demoted };
}

/**
 * One exam's practice record and alert from the previous record and a fresh
 * observation. Pure.
 */
export function evaluatePractice({
  code,
  previous,
  observation,
  today,
  failureDays = 5,
}) {
  let obs = observation;
  // The exam has no Learn page (yet): a state, not a failure. A page that
  // existed before and answers 404 now is not evidence of anything (a failure
  // below), only a page that was never there is a 404 state.
  if (
    obs.failed &&
    obs.status === 404 &&
    (!previous || previous.detail === "no-learn-page")
  ) {
    obs = {
      state: "unknown",
      detail: "no-learn-page",
      routeLive: obs.routeLive,
      pageUrl: obs.pageUrl,
    };
  }
  if (obs.failed) {
    // Nothing can be concluded: the previous state stays (a first read that
    // fails is kept as a placeholder, so the failure can be counted). A page
    // that stays unreadable day after day would otherwise switch the watch off
    // for this exam without anybody noticing, so one alert is raised once the
    // failure has lasted `failureDays` days.
    const record = previous
      ? { ...previous }
      : {
          code,
          state: "unknown",
          detail: "unreadable",
          routeLive: obs.routeLive ?? null,
          pageUrl: obs.pageUrl ?? "",
          firstSeen: today,
          lastChanged: today,
          lastChecked: today,
        };
    record.failedSince = record.failedSince ?? today;
    let alert = null;
    // Days on which the page was unreadable, today included: with the daily
    // schedule, FAILURE_DAYS=5 reports on the fifth failing day in a row.
    const days = daysBetween(record.failedSince, today) + 1;
    if (days >= failureDays && !record.failureReported) {
      record.failureReported = today;
      alert = {
        kind: "changed",
        code,
        reasons: [
          `the Learn page could not be read for ${days} day${days === 1 ? "" : "s"} in a row (${obs.reason}), so practice assessments are not being watched for this exam`,
        ],
        state: record.state,
        detail: record.detail ?? "",
        candidateUrl: "",
        before: describeState(record),
        after: `not readable since ${record.failedSince}`,
        pageUrl: obs.pageUrl ?? record.pageUrl ?? "",
      };
    }
    return { record, alert, carried: obs.reason };
  }

  const routeLive =
    obs.routeLive === null || obs.routeLive === undefined
      ? (previous?.routeLive ?? null)
      : obs.routeLive;
  const record = {
    code,
    state: obs.state,
    routeLive,
    pageUrl: obs.pageUrl,
    firstSeen: previous?.firstSeen ?? today,
    lastChanged: today,
    lastChecked: today,
  };
  if (obs.detail) record.detail = obs.detail;
  if (obs.kind) record.kind = obs.kind;
  if (obs.assessmentId) record.assessmentId = obs.assessmentId;
  if (obs.state === "link") record.url = obs.url;
  if (obs.candidateUrl) record.candidateUrl = obs.candidateUrl;

  const sameState =
    previous &&
    previous.state === record.state &&
    (previous.detail ?? "") === (record.detail ?? "") &&
    (previous.assessmentId ?? "") === (record.assessmentId ?? "") &&
    (previous.url ?? "") === (record.url ?? "") &&
    (previous.candidateUrl ?? "") === (record.candidateUrl ?? "");
  if (sameState && previous.lastChanged)
    record.lastChanged = previous.lastChanged;

  const reasons = [];
  let kind = "changed";
  if (obs.state === "link") {
    if (!previous || previous.state !== "link") {
      kind = "available";
    } else if (!sameState) {
      reasons.push(
        "the practice assessment address on the Learn page changed since the last run",
      );
    }
  } else {
    if (previous?.state === "link") {
      reasons.push(
        "the Learn page used to offer a practice assessment and no longer does",
      );
    } else if (previous?.state === "unavailable" && obs.state === "unknown") {
      reasons.push(
        'the sentence "Practice Assessment for this exam is not currently available" is gone, but no practice assessment link took its place',
      );
    }
    if (
      obs.detail === "link-not-resolving" &&
      previous?.detail !== "link-not-resolving"
    ) {
      reasons.push(
        "the Learn page offers a practice assessment, but its address does not resolve (HTTP 404 or a redirect to another page)",
      );
    }
    if (obs.detail === "ambiguous" && previous?.detail !== "ambiguous") {
      reasons.push(
        "the Learn page offers practice assessments, but the markup does not say which exam they belong to",
      );
    }
    if (routeLive === true && previous?.routeLive !== true) {
      reasons.push(
        "the exam's practice assessment page answers HTTP 200 (it answers 404 for exams without one), although the Learn page shows no practice assessment link (or does not exist) yet",
      );
    }
  }

  let alert = null;
  if (kind === "available") {
    alert = {
      kind,
      code,
      reasons: [],
      url: obs.url,
      assessmentKind: obs.kind,
      assessmentId: obs.assessmentId,
      extraIds: obs.extraIds ?? [],
      spaHost: Boolean(obs.spaHost),
      pageUrl: obs.pageUrl,
    };
  } else if (reasons.length > 0) {
    alert = {
      kind: "changed",
      code,
      reasons,
      state: obs.state,
      detail: obs.detail ?? "",
      candidateUrl: obs.candidateUrl ?? "",
      before: previous ? describeState(previous) : "not tracked yet",
      after: describeState(record),
      pageUrl: obs.pageUrl,
    };
  }
  return { record, alert };
}

function daysBetween(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : 0;
}

const DETAIL_TEXT = {
  "no-mention": "the page does not mention practice assessments",
  "no-learn-page": "no Learn page for the exam",
  unreadable: "the Learn page could not be read yet",
  ambiguous: "practice assessments of an unspecified exam",
  "shared-link":
    "the AI Skills Navigator address is also used for other exams, so it is not this exam's",
  "link-not-resolving": "a link that does not resolve",
  "exam-not-listed": "the page does not list the exam",
};

function describeState(record) {
  const detail = DETAIL_TEXT[record.detail] ?? record.detail ?? "";
  const live = record.routeLive === true ? ", practice page live" : "";
  return `${record.state}${detail ? ` (${detail})` : ""}${live}`;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
function emptyTracker() {
  return {
    lastSynced: null,
    format: TRACKER_FORMAT,
    courses: [],
    practiceAssessments: [],
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The dates a record stores. They are compared as text ("missingSince < today",
// "two days in a row"), so a hand-edited value that is not YYYY-MM-DD would
// break those comparisons without a sound: it is a corrupt tracker.
const COURSE_DATES = [
  "firstSeen",
  "lastSeen",
  "lastChanged",
  "missingSince",
  "availableOn",
  "removedAt",
  "unlinkedReported",
];
const PRACTICE_DATES = [
  "firstSeen",
  "lastChanged",
  "lastChecked",
  "failedSince",
  "failureReported",
];

export function normalizeTracker(parsed) {
  const fail = (what) => {
    throw new ExtractionError(
      `The tracker is corrupt (${what}). Fix or delete src/data_files/learn-content-watch.json; it was not modified.`,
    );
  };
  // A date that is there must be YYYY-MM-DD; no date at all is allowed.
  const checkDate = (value, field, where) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || !DATE_RE.test(value)) {
      const shown = JSON.stringify(value);
      fail(
        `${where}${field} is ${shown.length > 40 ? `${shown.slice(0, 39)}…` : shown}, not a YYYY-MM-DD date`,
      );
    }
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("not an object");
  if (parsed.format !== undefined && parsed.format !== TRACKER_FORMAT)
    fail(`unsupported format ${parsed.format}`);
  const courses = parsed.courses ?? [];
  const practice = parsed.practiceAssessments ?? [];
  if (!Array.isArray(courses) || !Array.isArray(practice))
    fail("`courses` or `practiceAssessments` is not a list");

  const out = emptyTracker();
  checkDate(parsed.lastSynced, "lastSynced", "");
  out.lastSynced = parsed.lastSynced ?? null;
  for (const record of courses) {
    if (
      !record ||
      typeof record.code !== "string" ||
      typeof record.number !== "string" ||
      !Array.isArray(record.paths)
    )
      fail("a course record is malformed");
    for (const field of COURSE_DATES) {
      checkDate(record[field], field, `course ${record.number}: `);
    }
    out.courses.push({
      ...record,
      paths: record.paths
        .filter((entry) => entry && typeof entry.uid === "string")
        .map((entry) => ({
          uid: entry.uid,
          type: String(entry.type ?? "learningPath"),
          title: String(entry.title ?? ""),
        })),
    });
  }
  for (const record of practice) {
    if (
      !record ||
      typeof record.code !== "string" ||
      !["link", "unavailable", "unknown"].includes(record.state)
    )
      fail("a practice assessment record is malformed");
    for (const field of PRACTICE_DATES) {
      checkDate(record[field], field, `practice assessment ${record.code}: `);
    }
    out.practiceAssessments.push({ routeLive: null, ...record });
  }
  return out;
}

function loadTracker(cfg) {
  if (!existsSync(cfg.trackerFile)) return emptyTracker();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfg.trackerFile, "utf8"));
  } catch (error) {
    throw new ExtractionError(
      `The tracker could not be read (${error.message}). Fix or delete src/data_files/learn-content-watch.json; it was not modified.`,
    );
  }
  return normalizeTracker(parsed);
}

const VOLATILE_KEYS = new Set(["lastSynced", "lastSeen", "lastChecked"]);

/** The same value with every object's keys in sorted order (arrays keep theirs). */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byCodePoint)
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

/**
 * The tracker without the fields that move on every run, with the keys sorted.
 * The order of the keys must not count: a tracker read back from disk (and
 * normalized, which can move a key) must compare equal to the one the run
 * builds, otherwise every quiet day would rewrite the file and commit it.
 */
export function stableContent(tracker) {
  return JSON.stringify(sortKeys(tracker), (key, value) =>
    VOLATILE_KEYS.has(key) ? undefined : value,
  );
}

export function trackerContent(tracker) {
  return `${JSON.stringify(tracker, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const codeSpan = (text) => `\`${String(text).replace(/`/g, "'")}\``;

/**
 * The address of a course page for the issue: the slug of the alert (the end of
 * the catalog address), or the number in lower case for an alert that has none.
 */
const courseUrl = (item) =>
  `${PUBLIC_BASE}/training/courses/${item.slug || item.number.toLowerCase()}${TRACKING}`;

function listCodes(codes, limit) {
  const sorted = [...new Set(codes)].sort(byCodePoint);
  if (sorted.length <= limit) return sorted.join(", ");
  return `${sorted.slice(0, limit).join(", ")} +${sorted.length - limit} more`;
}

/** "Learn content watch: practice assessment available: AB-650; ..." (<= 200). */
export function buildIssueTitle(alerts) {
  const limit = 200;
  const groups = [
    [
      "practice assessment available",
      alerts.practice.filter((a) => a.kind === "available").map((a) => a.code),
    ],
    [
      "practice assessment changed",
      alerts.practice.filter((a) => a.kind === "changed").map((a) => a.code),
    ],
    ["course not linked", alerts.unlinked.map((a) => a.number)],
    ["course paths changed", alerts.pathChanges.map((a) => a.number)],
    [
      "course availability date changed",
      (alerts.availability ?? []).map((a) => a.number),
    ],
    ["course removed", alerts.removed.map((a) => a.number)],
  ].filter(([, codes]) => codes.length > 0);

  for (const per of [6, 3, 1]) {
    const title = `Learn content watch: ${groups
      .map(([label, codes]) => `${label}: ${listCodes(codes, per)}`)
      .join("; ")}`;
    if (title.length <= limit) return title;
  }
  const short = `Learn content watch: ${groups.map(([label, codes]) => `${label} (${new Set(codes).size})`).join("; ")}`;
  return short.slice(0, limit);
}

function practiceAvailableSection(items, hub) {
  if (items.length === 0) return [];
  const lines = [
    "## Practice assessment now available",
    "",
    'The Learn page of each exam below offers a free practice assessment, and the hub exam page has no "Microsoft Learn Practice Assessment" card yet.',
    "",
    "| Exam | Hub page | Learn page | How the link was found | Address check |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const page = hub.get(item.code);
    const check = item.spaHost
      ? "AI Skills Navigator answers HTTP 200 to every address, so this only shows the host is up: open the link by hand (sign-in required)"
      : "the practice page exists (HTTP 200, no redirect to another page); Learn answers 200 for any assessment id on an existing page, so the id comes from the Learn page: open the link once before adding it";
    const found = item.spaHost
      ? "callout on the Learn page"
      : `assessment id ${codeSpan(item.assessmentId)}`;
    const extra =
      item.extraIds.length > 0
        ? ` (the page also names ${item.extraIds.map(codeSpan).join(", ")}: check which one belongs to this exam)`
        : "";
    lines.push(
      `| ${item.code} | ${codeSpan(page?.path ?? "")} | [Learn page](${markdownUrl(item.pageUrl + TRACKING)}) | ${found}${extra} | ${check} |`,
    );
  }
  lines.push("");
  for (const item of items) {
    const page = hub.get(item.code);
    const title = item.spaHost
      ? `${PRACTICE_CARD_PREFIX} (AI Skills Navigator)`
      : PRACTICE_CARD_PREFIX;
    lines.push(`**${item.code}**: add this card to the Tests tab.`, "");
    lines.push(
      "```mdx",
      `<LinkCard title="${title}" href="${fenceSafe(item.url)}" target="_blank" description="${PRACTICE_CARD_DESCRIPTION}"/>`,
      "```",
      "",
    );
    if (page?.standIns.length > 0) {
      lines.push(
        `The page currently links ${page.standIns.map(codeSpan).join(", ")} as a stand-in; decide whether to keep it next to the exam's own assessment or replace it.`,
        "",
      );
    }
  }
  return lines;
}

function practiceChangedSection(items) {
  if (items.length === 0) return [];
  const lines = [
    "## Practice assessment changed, check by hand",
    "",
    'The state of the practice assessment on Learn moved in a way that is not simply "now available". Open the Learn page and decide whether the hub page needs anything.',
    "",
    "| Exam | Learn page | Before | Now | What changed |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const reasons = item.reasons.map(safeText).join("; ");
    const candidate = item.candidateUrl
      ? ` Address found: ${codeSpan(item.candidateUrl)}.`
      : "";
    lines.push(
      `| ${item.code} | [Learn page](${markdownUrl(item.pageUrl + TRACKING)}) | ${safeText(item.before)} | ${safeText(item.after)} | ${reasons}.${candidate} |`,
    );
  }
  lines.push("");
  return lines;
}

function unlinkedSection(items) {
  if (items.length === 0) return [];
  const lines = [
    "## Courses the exam pages do not link",
    "",
    "The Learn catalog lists an official course for each exam below, and the hub exam page has no link to it.",
    "",
    "| Exam | Hub page | Course | Catalog title | Why it is listed | Note |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const url = courseUrl(item);
    const why =
      item.reason === "new-course"
        ? "course is new for this exam"
        : "the link is not on the page any more";
    lines.push(
      `| ${item.code} | ${codeSpan(item.pagePath)} | [${item.number}](${markdownUrl(url)}) | ${safeText(item.title)} | ${why} | ${safeText(item.note) || "-"} |`,
    );
  }
  lines.push("");
  return lines;
}

function pathChangesSection(items, limits) {
  if (items.length === 0) return [];
  const lines = [
    "## Course learning paths changed",
    "",
    'The list of learning paths and modules of a tracked course changed. "On the page" says whether the hub exam page already links the path.',
    "",
  ];
  let budget = limits.total;
  for (const item of items) {
    const url = courseUrl(item);
    lines.push(
      `### ${item.code}: [${item.number}](${markdownUrl(url)}) ${safeText(item.title)}`,
      "",
    );
    const rows = [
      ...item.added.map((entry) => ({ ...entry, change: "added" })),
      ...item.removed.map((entry) => ({ ...entry, change: "removed" })),
    ];
    const shown = Math.max(0, Math.min(limits.perCourse, budget, rows.length));
    budget -= shown;
    if (shown > 0) {
      lines.push(
        "| Change | Learning path or module | On the page | Also in |",
        "| --- | --- | --- | --- |",
      );
      for (const row of rows.slice(0, shown)) {
        const title = safeText(row.title || row.uid);
        const label = row.url ? `[${title}](${markdownUrl(row.url)})` : title;
        const onPage =
          row.change === "removed"
            ? "-"
            : row.linked === null
              ? "unknown"
              : row.linked
                ? "yes"
                : "no";
        const also =
          row.change === "added" && row.alsoIn?.length > 0
            ? row.alsoIn.join(", ")
            : row.change === "added"
              ? "new for the hub"
              : "-";
        lines.push(
          `| ${row.change} | ${label} (${row.type === "module" ? "module" : "learning path"}) | ${onPage} | ${also} |`,
        );
      }
      lines.push("");
    }
    if (rows.length > shown) {
      lines.push(
        `${rows.length - shown} more change(s) of this course are not shown; compare the course page with the exam page.`,
        "",
      );
    }
  }
  return lines;
}

function availabilitySection(items) {
  if (items.length === 0) return [];
  const lines = [
    "## Course availability dates changed",
    "",
    'The Learn catalog announces a course as "will be available on <date>". The date below moved or was withdrawn, and an exam page that states the old date is wrong.',
    "",
    "| Exam | Hub page | Course | Announced before | Announced now | Hub page states the old date | Hub page states the new date |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const yesNo = (value) => (value === null ? "-" : value ? "yes" : "no");
  for (const item of items) {
    const url = courseUrl(item);
    const date = (iso) =>
      iso ? longDate(iso) : "no date (probably available now)";
    lines.push(
      `| ${item.code} | ${codeSpan(item.pagePath)} | [${item.number}](${markdownUrl(url)}) | ${date(item.from)} | ${date(item.to)} | ${yesNo(item.statesOld)} | ${yesNo(item.statesNew)} |`,
    );
  }
  lines.push("");
  return lines;
}

function removedSection(items) {
  if (items.length === 0) return [];
  const lines = [
    "## Courses removed from the Learn catalog",
    "",
    "The course below was missing from the catalog on two consecutive days. Open the course page: the exam may have a new course number, or the course was retired.",
    "",
    "| Exam | Course | Title | Missing since |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of items) {
    const url = courseUrl(item);
    lines.push(
      `| ${item.code} | [${item.number}](${markdownUrl(url)}) | ${safeText(item.title)} | ${item.missingSince} |`,
    );
  }
  lines.push("");
  return lines;
}

function whatToDo(alerts) {
  const steps = [];
  if (alerts.practice.length > 0 || alerts.unlinked.length > 0) {
    steps.push(
      "Open each Learn page or course page above and verify it yourself (Content Rules: never infer a URL, an assessment id or a title).",
    );
  }
  if (alerts.practice.some((a) => a.kind === "available")) {
    steps.push(
      'Add the practice assessment card to the Tests tab of the exam page (Exam Page Anatomy, URL Formats); the AI Skills Navigator variant keeps its "(AI Skills Navigator)" title suffix.',
    );
  }
  if (alerts.unlinked.length > 0) {
    steps.push(
      'Add the course as a `Microsoft Learn` LinkCard in the Text tab with `href="https://learn.microsoft.com/training/courses/<course>' +
        TRACKING +
        '"` (`<course>` is the end of the course link in the table: usually the course number in lower case, without a suffix such as `-A` when Learn has none), ' +
        "after the other Microsoft resources of that grid; when the course is future-dated, put its verified availability date in the description.",
    );
  }
  if (alerts.pathChanges.length > 0) {
    steps.push(
      "For an added learning path, check whether it belongs on the exam page (Text tab) and, if it has hands-on units, on the lab page (see Lab Page Workflow); for a removed one, remove its card if the page links it.",
    );
  }
  if ((alerts.availability ?? []).length > 0) {
    steps.push(
      'Open the course page and confirm the date. Update the "Becomes available <date>" sentence in the `Microsoft Learn` card description (and in the page description when it repeats the date); when the course has no announced date any more, remove the sentence once the course page shows it is available.',
    );
  }
  if (alerts.removed.length > 0) {
    steps.push(
      "For a removed course, check whether the exam has a new course number; otherwise remove the dead `Microsoft Learn` card.",
    );
  }
  steps.push(
    "Run `node scripts/audit-missing-resources.mjs`, commit the regenerated `src/data_files/missing-resources.json` with the page edits, then run `pnpm build`.",
    "Nothing needs to be dismissed: the tracker already records what this issue reported, so each item is reported once.",
  );
  return ["## What to do", "", ...steps.map((s, i) => `${i + 1}. ${s}`), ""];
}

export function buildReport({ alerts, hub, today, baseline }) {
  for (const limits of ROW_LIMITS) {
    const lines = [
      `Learn Content Watch checked Microsoft Learn on ${today} and found official content the hub exam pages do not reflect yet.`,
      "",
    ];
    if (baseline) {
      lines.push(
        "This is the first run: everything that was already in place is recorded silently. Only the items below need action today.",
        "",
      );
    }
    lines.push(
      ...practiceAvailableSection(
        alerts.practice.filter((a) => a.kind === "available"),
        hub,
      ),
      ...practiceChangedSection(
        alerts.practice.filter((a) => a.kind === "changed"),
      ),
      ...unlinkedSection(alerts.unlinked),
      ...pathChangesSection(alerts.pathChanges, limits),
      ...availabilitySection(alerts.availability ?? []),
      ...removedSection(alerts.removed),
      ...whatToDo(alerts),
    );
    const text = `${lines.join("\n").trimEnd()}\n`;
    if (text.length <= REPORT_MAX_CHARS) return text;
  }
  return `${TOO_LONG_NOTE}\n`;
}

const TOO_LONG_NOTE =
  "The report was too long for a GitHub issue. Run `node scripts/learn-content-watch.mjs` locally against a copy of the tracker to see every item.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function handleFailure(cfg, error) {
  const message =
    error instanceof ExtractionError
      ? error.message
      : `Unexpected error: ${error?.stack ?? error}`;
  console.error(`ERROR: ${message}`);
  try {
    writeFileSync(cfg.errorFile, `${message}\n`);
  } catch {
    /* the error is already on stderr */
  }
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
    practice_alerts: 0,
    course_alerts: 0,
    issue_title: "",
  });
  process.exit(1);
}

export async function main(cfg) {
  console.log("=== Learn Content Watch ===");
  console.log(`Started: ${new Date().toISOString()}`);
  rmSync(cfg.reportFile, { force: true });
  rmSync(cfg.errorFile, { force: true });

  const previous = loadTracker(cfg);
  const baseline =
    previous.lastSynced === null &&
    previous.courses.length === 0 &&
    previous.practiceAssessments.length === 0;
  const deadline = makeDeadline(cfg.deadlineMs);

  const hub = scanHub(cfg);
  if (hub.size === 0) {
    throw new ExtractionError(
      `No exam page found under ${cfg.docsDir}. Check DOCS_DIR; the tracker was not modified.`,
    );
  }
  console.log(`Hub exam pages: ${hub.size}.`);

  // --- (B) courses ---------------------------------------------------------
  console.log("Fetching the course catalog...");
  const catalog = parseCourseCatalog(
    await fetchCourseCatalog(cfg, deadline),
    cfg.minCourses,
  );
  const courseMap = mapCoursesToExams(catalog, new Set(hub.keys()));
  console.log(
    `Catalog: ${catalog.length} courses, ${[...courseMap.values()].flat().length} mapped to ${courseMap.size} hub exams.`,
  );

  const input = {
    previous: previous.courses,
    courseMap,
    hub,
    today: cfg.today,
  };
  let courseResult = evaluateCourses(input);
  let titles = new Map();
  if (courseResult.needTitles.size > 0) {
    console.log(`Resolving ${courseResult.needTitles.size} path titles...`);
    titles = await resolveTitles(cfg, courseResult.needTitles, deadline);
    courseResult = evaluateCourses({ ...input, titles });
  }
  for (const warning of courseResult.warnings) {
    warnLoud(warning, { title: ANNOTATION_TITLE });
  }

  // --- (A) practice assessments --------------------------------------------
  const targets = [...hub.values()].filter((page) => !page.hasPracticeCard);
  console.log(
    `Exam pages without a practice assessment card: ${targets.length}.`,
  );
  const prevPractice = new Map(
    previous.practiceAssessments.map((record) => [record.code, record]),
  );
  const ctx = { routeUsable: false };
  const summaryLines = [];
  if (targets.length > 0) {
    const control = await probeRoute(cfg, CONTROL_EXAM_CODE, deadline);
    ctx.routeUsable = control === false;
    if (!ctx.routeUsable) {
      const message = `The practice route probe is not used this run: the control exam code answered ${control === true ? "HTTP 200 (the route no longer separates real exams from missing ones)" : "with no usable answer"}.`;
      warnLoud(message, { title: ANNOTATION_TITLE });
      summaryLines.push(`- ${message}`);
    }
  }
  const practiceRecords = [];
  const practiceAlerts = [];
  const observed = [];
  for (const page of targets) {
    let observation;
    if (deadline.expired()) {
      observation = { failed: true, reason: "run deadline reached" };
    } else {
      observation = await observePractice(cfg, page, ctx, deadline);
    }
    observed.push({ code: page.code, observation });
  }
  // An AI Skills Navigator address that other exams use too is not suggested.
  const shared = demoteSharedAsnLinks(observed, hub.values());
  for (const item of shared.demoted) {
    const message = `${item.code}: the AI Skills Navigator address on its Learn page (${item.address}) is also used for ${item.sharedWith.join(", ")}, so it is not suggested as this exam's practice assessment.`;
    console.log(message);
    summaryLines.push(`- ${message}`);
  }
  for (const { code, observation } of shared.entries) {
    const previousRecord = prevPractice.get(code);
    const result = evaluatePractice({
      code,
      previous: previousRecord,
      observation,
      today: cfg.today,
      failureDays: cfg.failureDays,
    });
    if (result.carried) {
      const message = `${code}: the Learn page could not be evaluated (${result.carried}); its previous state was kept.`;
      warnLoud(message, { title: ANNOTATION_TITLE });
      summaryLines.push(`- ${message}`);
    }
    if (result.record) practiceRecords.push(result.record);
    if (result.alert) practiceAlerts.push(result.alert);
  }
  const counts = { link: 0, unavailable: 0, unknown: 0 };
  for (const record of practiceRecords) counts[record.state]++;
  console.log(
    `Practice assessment states: ${counts.link} link, ${counts.unavailable} unavailable, ${counts.unknown} unknown.`,
  );

  // --- combine -------------------------------------------------------------
  const alerts = {
    practice: practiceAlerts,
    unlinked: courseResult.unlinked,
    pathChanges: courseResult.pathChanges,
    availability: courseResult.availability,
    removed: courseResult.removed,
  };
  const total =
    alerts.practice.length +
    alerts.unlinked.length +
    alerts.pathChanges.length +
    alerts.availability.length +
    alerts.removed.length;
  // The same limit holds for a first run: a flood of "unlinked" courses there
  // means the hub pages were not read as expected, not news.
  if (total > cfg.maxChanges && !cfg.forceBaseline) {
    throw new ExtractionError(
      `${total} changes at once (limit ${cfg.maxChanges}): ${alerts.practice.length} practice assessment, ${alerts.unlinked.length} unlinked course, ${alerts.pathChanges.length} learning path, ${alerts.availability.length} availability date and ${alerts.removed.length} removed course items. That looks like a structure change on Microsoft Learn or in the hub pages, not news. Nothing was written. If the changes are real, run the workflow with force_baseline enabled (or FORCE_BASELINE=1 locally): they are then recorded silently.`,
    );
  }

  const next = {
    lastSynced: cfg.today,
    format: TRACKER_FORMAT,
    courses: courseResult.records,
    practiceAssessments: practiceRecords.sort((a, b) =>
      byCodePoint(a.code, b.code),
    ),
  };
  const changed = stableContent(next) !== stableContent(previous);
  if (changed) {
    writeFileSync(cfg.trackerFile, trackerContent(next));
    console.log(`Tracker updated: ${cfg.trackerFile}`);
  } else {
    console.log("Nothing changed in the tracker.");
  }

  const silent = cfg.forceBaseline;
  const reportable = silent ? 0 : total;
  let issueTitle = "";
  if (reportable > 0) {
    issueTitle = buildIssueTitle(alerts);
    writeFileSync(
      cfg.reportFile,
      buildReport({ alerts, hub, today: cfg.today, baseline }),
    );
    console.log(`Report written: ${cfg.reportFile} (${reportable} items).`);
  } else if (silent && total > 0) {
    summaryLines.push(
      `- FORCE_BASELINE recorded ${total} item(s) silently: ${alerts.practice
        .map((a) => `${a.code} (practice)`)
        .concat(
          alerts.unlinked.map((a) => `${a.number} (unlinked)`),
          alerts.pathChanges.map((a) => `${a.number} (paths)`),
          alerts.availability.map((a) => `${a.number} (availability date)`),
          alerts.removed.map((a) => `${a.number} (removed)`),
        )
        .join(", ")}.`,
    );
  }
  if (baseline) {
    summaryLines.unshift(
      `- Recorded ${courseResult.records.length} courses with ${courseResult.records.reduce((n, r) => n + r.paths.length, 0)} learning paths and ${practiceRecords.length} practice assessment states silently (${counts.link} link, ${counts.unavailable} unavailable, ${counts.unknown} unknown).`,
    );
  }
  if (summaryLines.length > 0) {
    appendStepSummary(
      cfg.stepSummary,
      `### Learn Content Watch: ${baseline ? "baseline" : "notes"}\n\n${summaryLines.join("\n")}\n`,
    );
  }

  writeOutput(cfg.githubOutput, {
    changes_found: reportable > 0,
    baseline_updated: changed,
    extraction_failed: false,
    practice_alerts: alerts.practice.length,
    course_alerts:
      alerts.unlinked.length +
      alerts.pathChanges.length +
      alerts.availability.length +
      alerts.removed.length,
    issue_title: issueTitle,
  });
  console.log(`HTTP requests: ${stats.requests}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
