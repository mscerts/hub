#!/usr/bin/env node
/**
 * Daily check of the Microsoft Learn course videos on YouTube, so the Videos tab
 * of the exam pages gets the "Microsoft Learn <CODE> Course on YouTube" card of a
 * new course and keeps working links.
 *
 * Usage:
 *   node scripts/course-videos-check.mjs
 *
 * Microsoft publishes the recordings of its instructor-led courses on its
 * YouTube channel and gives every course a short link, https://aka.ms/<CODE>onYouTube
 * (AZ-104, SC-401, and the four-digit courses such as AI-3016). The short link is
 * the one place that always points at the current playlist, which is why the hub
 * cards use it. A code without a recording redirects to a Bing page instead.
 *
 * What it does:
 *   1. Collects the course codes that could have a recording: the courses of the
 *      Learn catalog (C-NNNT00 and the four-digit C-NNNN ones), the codes listed on
 *      https://learn.microsoft.com/training/course-videos-on-shows, the exam codes of
 *      the hub's own exam pages (an exam page whose course is not in the catalog
 *      yet), the codes of the cards the hub already has, and the baseline.
 *   2. Asks aka.ms for every code (one GET, the redirect NOT followed) and reads
 *      where it goes: a YouTube playlist, or somewhere else (no recording). A
 *      control code that cannot exist must come back as "somewhere else".
 *   3. Compares with the baseline by SET of codes. A code that now points at a
 *      playlist and was not in the baseline is a NEW course (the issue names the
 *      hub page, whether a card exists, and the card to add). A code that points
 *      at another playlist than before is reported as changed. A code that stops
 *      resolving is dropped only after a second run confirms it.
 *   4. Checks the hub's own cards (src/content/docs): a card that links a Learn
 *      playlist directly where the short link resolves to the same playlist (use
 *      the short link), a card whose playlist is no longer the one its code
 *      resolves to, and a short link that does not resolve any more. Each finding
 *      is remembered in the baseline (`staleHubCards`), so it is reported once.
 *   5. For the new and changed playlists only, reads the playlist title with
 *      YouTube's oEmbed endpoint (no key needed) for the issue; it is a courtesy,
 *      never evidence.
 *   6. For a new course whose code is not an exam with a hub page (AI-3026,
 *      SC-5006), suggests the exam pages it could go on, with the evidence
 *      (scripts/course-placement.mjs, docs/course-placement.md). Another courtesy:
 *      when it fails, the issue is written without it.
 *
 * Failsafes (extraction_failed, nothing written):
 *   - the catalog is unreachable or malformed, or lists fewer than MIN_CATALOG courses;
 *   - the control code resolves to a YouTube playlist (aka.ms answers everything);
 *   - more than MAX_UNVERIFIED_PCT of the requests failed (aka.ms unreachable or
 *     blocking, an HTTP 429 or 5xx is never evidence of a missing recording);
 *   - more than MAX_NEW_PCT of the baseline is new at once, or more than
 *     MAX_GONE_PCT of it stopped resolving at once. FORCE_BASELINE=1 accepts that.
 * The Learn page is a second opinion only: a page that cannot be read or parsed is
 * a warning, and the job summary says how complete the page is.
 *
 * Env overrides (defaults shown):
 *   LEARN_PAGE_URL      https://learn.microsoft.com/training/course-videos-on-shows
 *   CATALOG_URL         https://learn.microsoft.com/api/catalog/?type=courses
 *   AKAMS_ORIGIN        https://aka.ms
 *   OEMBED_URL          https://www.youtube.com/oembed
 *   BASELINE_FILE       src/data_files/course-videos.json
 *   DOCS_DIR            src/content/docs
 *   REPORT_FILE         <tmpdir>/course-videos-report.md
 *   ERROR_FILE          <tmpdir>/course-videos-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (job summary, optional)
 *   MIN_CATALOG         50
 *   MIN_PAGE_CODES      10   (a Learn page with fewer codes is ignored with a warning)
 *   MAX_UNVERIFIED_PCT  20
 *   MAX_NEW_PCT         50
 *   MAX_GONE_PCT        50
 *   FORCE_BASELINE      (1 = accept the scan silently, skip the mass-change failsafes)
 *   PLACEMENT           1    (0 or false: no suggested exam pages for new courses; they need
 *                            the learnsync data, LEARNSYNC_DIR or GitHub, and LEARN_EXAMS_FILE)
 *   FETCH_DELAY_MS      300  (pause between aka.ms requests)
 *   FETCH_ATTEMPTS      3
 *   RETRY_BASE_MS       5000
 *   MAX_RETRY_AFTER_MS  60000
 *   FETCH_TIMEOUT_MS    30000
 *   RUN_DEADLINE_MS     600000
 *   TODAY               YYYY-MM-DD (tests)
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * issue_title, new_courses, hub_findings.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import { courseCode, describeSuggestion } from "./lib/course-placement.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

export { retryDelayMs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// The title of the workflow annotations (warnings) this monitor makes.
const ANNOTATION_TITLE = "Course Videos Monitor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_LEARN_PAGE =
  "https://learn.microsoft.com/training/course-videos-on-shows";
const DEFAULT_CATALOG = "https://learn.microsoft.com/api/catalog/?type=courses";
const DEFAULT_AKAMS = "https://aka.ms";
const DEFAULT_OEMBED = "https://www.youtube.com/oembed";
// A page of the exam docs as the issue names it, whatever DOCS_DIR is.
const DOCS_PREFIX = "src/content/docs";
// No such course can exist (no real code has a zero course number): aka.ms must
// answer it with "somewhere else", otherwise it answers everything.
const CONTROL_CODE = "ZZ-0000";
const CODE_RE = /^[A-Z]{1,4}-\d{3,4}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 (msfthub-course-videos-monitor; +https://github.com/mscerts/hub)";
// Baselines smaller than this make a percentage meaningless.
const PCT_MIN_BASE = 10;
const REPORT_MAX_CHARS = 60000;
const MAX_TABLE_ROWS = 100;
// Stops GitHub from turning "@name" into a mention or "#123" into a reference.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

class ExtractionError extends Error {}

const stats = { requests: 0 };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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
  const on = (key, fallback) => {
    const raw = (env[key] ?? "").trim().toLowerCase();
    if (raw === "") return fallback;
    return !["0", "false", "no", "off"].includes(raw);
  };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    learnPageUrl: env.LEARN_PAGE_URL || DEFAULT_LEARN_PAGE,
    catalogUrl: env.CATALOG_URL || DEFAULT_CATALOG,
    akamsOrigin: (env.AKAMS_ORIGIN || DEFAULT_AKAMS).replace(/\/+$/, ""),
    oembedUrl: env.OEMBED_URL || DEFAULT_OEMBED,
    baselineFile: resolveFromRoot(
      env.BASELINE_FILE ?? "src/data_files/course-videos.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? DOCS_PREFIX),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "course-videos-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "course-videos-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    minCatalog: num("MIN_CATALOG", 50),
    minPageCodes: num("MIN_PAGE_CODES", 10),
    maxUnverifiedPct: num("MAX_UNVERIFIED_PCT", 20),
    maxNewPct: num("MAX_NEW_PCT", 50),
    maxGonePct: num("MAX_GONE_PCT", 50),
    forceBaseline: on("FORCE_BASELINE", false),
    placement: on("PLACEMENT", true),
    fetchDelayMs: num("FETCH_DELAY_MS", 300),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 5000),
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
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null;
}

// Plain code-point order, independent of the runner's locale.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/[\u00a0\u2007\u202f\ufffd]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ");
}

function makeDeadline(ms) {
  const end = Date.now() + ms;
  return () => {
    if (Date.now() > end) {
      throw new ExtractionError(
        `The run deadline (${Math.round(ms / 1000)} s) ran out while asking aka.ms; nothing was written.`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Course codes
// ---------------------------------------------------------------------------
// The code a course number stands for (AZ-104T00-A -> AZ-104, SC-5006 ->
// SC-5006) lives with the placement code, which needs it as well.
export { courseCode };

/**
 * The courses of the Learn catalog: Map code -> { title, uid, course } (the
 * course as the catalog API gives it, with its learning paths).
 */
export function codesFromCatalog(json) {
  if (!Array.isArray(json?.courses)) {
    throw new ExtractionError(
      "The Learn catalog answer has no courses list (the API probably changed); nothing was written.",
    );
  }
  const courses = new Map();
  for (const course of json.courses) {
    const code = courseCode(course?.course_number);
    if (!code || courses.has(code)) continue;
    courses.set(code, {
      title: cleanText(course.title),
      uid: String(course.uid ?? ""),
      course,
    });
  }
  return courses;
}

/** CODE of https://aka.ms/<CODE>onYouTube, or "". */
export function akamsCode(href) {
  const match =
    /^https?:\/\/aka\.ms\/([A-Za-z]{1,4}-\d{3,4})onYouTube\/?(?:[?#].*)?$/i.exec(
      String(href ?? "").trim(),
    );
  return match ? match[1].toUpperCase() : "";
}

/** The codes the Learn page "Course videos" links to: Map code -> link text. */
export function parseLearnPage(html) {
  const found = new Map();
  for (const match of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(match[1])?.[1];
    const code = href ? akamsCode(decodeEntities(href)) : "";
    if (!code || found.has(code)) continue;
    found.set(code, cleanText(decodeEntities(stripTags(match[2]))));
  }
  return found;
}

/** The playlist id of a YouTube address, or "". */
export function playlistOfUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return "";
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return "";
  const list = url.searchParams.get("list") ?? "";
  return PLAYLIST_ID_RE.test(list) ? list : "";
}

/** The card a code gets: the short link the hub prefers over the playlist. */
export const shortLink = (code) => `https://aka.ms/${code}onYouTube`;

// ---------------------------------------------------------------------------
// The hub's own cards
// ---------------------------------------------------------------------------
/** Same text, comments blanked out, line numbers kept. */
export function stripComments(text) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Every <LinkCard ...> of an MDX text as { title, href, line }. The attributes
 * are read by hand (quotes and {expressions} aware), because a description may
 * contain a ">" or a "/>" that a simple pattern would take for the tag's end.
 */
export function findLinkCards(text) {
  const cards = [];
  const nameRe = /[A-Za-z_:][\w:.-]*/y;
  for (const match of text.matchAll(/<LinkCard\b/g)) {
    let i = match.index + match[0].length;
    const attrs = {};
    while (i < text.length) {
      while (/\s/.test(text[i] ?? "")) i++;
      if (i >= text.length || text[i] === ">" || text[i] === "/") break;
      nameRe.lastIndex = i;
      const name = nameRe.exec(text)?.[0];
      if (!name) {
        i++;
        continue;
      }
      i += name.length;
      while (/\s/.test(text[i] ?? "")) i++;
      if (text[i] !== "=") {
        attrs[name] = true;
        continue;
      }
      i++;
      while (/\s/.test(text[i] ?? "")) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        if (end < 0) {
          i = text.length;
          break;
        }
        attrs[name] = decodeEntities(text.slice(i + 1, end));
        i = end + 1;
      } else if (quote === "{") {
        let depth = 0;
        let j = i;
        for (; j < text.length; j++) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}" && --depth === 0) {
            j++;
            break;
          }
        }
        // An expression is not a literal address or title: it counts as present
        // but gives nothing to read.
        attrs[name] = true;
        i = j;
      } else {
        i++;
      }
    }
    cards.push({
      title: typeof attrs.title === "string" ? cleanText(attrs.title) : "",
      href: typeof attrs.href === "string" ? attrs.href.trim() : "",
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return cards;
}

function walkFiles(dir, accept, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, accept, out);
    else if (accept(entry.name)) out.push(path);
  }
  return out;
}

/**
 * The cards of the docs that can be a course video: a short link
 * (aka.ms/<CODE>onYouTube) or a link to a YouTube playlist. Each carries its
 * file (as the issue names it) and line.
 */
export function scanHubCards(docsDir) {
  const cards = [];
  for (const file of walkFiles(docsDir, (name) => /\.mdx?$/i.test(name))) {
    const text = stripComments(readFileSync(file, "utf8"));
    const rel = `${DOCS_PREFIX}/${relative(docsDir, file).split("\\").join("/")}`;
    for (const card of findLinkCards(text)) {
      const code = akamsCode(card.href);
      const playlist = code ? "" : playlistOfUrl(card.href);
      if (!code && !playlist) continue;
      cards.push({ ...card, file: rel, code, playlist });
    }
  }
  return cards;
}

/**
 * Whether a hub card (from scanHubCards) is the card of a course: its own
 * short link, a direct link to its playlist, or the short link of another code
 * that resolves to the same playlist (`courses`: code -> { playlist }; AI-900
 * and AI-901 are one recording).
 */
export function cardCovers(card, code, playlist, courses = {}) {
  if (card.code === code) return true;
  if (!playlist) return false;
  if (card.playlist === playlist) return true;
  return Boolean(card.code && courses[card.code]?.playlist === playlist);
}

/** Exam code -> hub page path, from docs/<area>/<CODE>.mdx. */
export function findExamPages(docsDir) {
  const pages = new Map();
  for (const area of EXAM_AREAS) {
    let files;
    try {
      files = readdirSync(join(docsDir, area));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^([A-Z]{1,4}-\d{3,4})\.mdx$/.exec(file);
      if (match) pages.set(match[1], `${DOCS_PREFIX}/${area}/${file}`);
    }
  }
  return pages;
}

/**
 * The course code a card's title names ("Microsoft Learn AZ-2008 Course on
 * YouTube", "AZ-500: Microsoft Learn Course on YouTube"), or "". Only titles of
 * the Microsoft Learn course cards count, so a creator's playlist never does.
 */
export function titleCode(title) {
  const text = cleanText(title);
  if (!/microsoft learn/i.test(text) || !/youtube/i.test(text)) return "";
  const named = /Microsoft Learn\s+([A-Z]{1,4}-\d{3,4})\b/.exec(text);
  if (named) return named[1];
  const lead = /^([A-Z]{1,4}-\d{3,4})\b/.exec(text);
  return lead ? lead[1] : "";
}

// ---------------------------------------------------------------------------
// Fetching (polite: one request at a time, a pause, retry with backoff)
// ---------------------------------------------------------------------------
/** One page or API answer as text; throws ExtractionError once every attempt failed. */
async function fetchText(cfg, url, label, checkDeadline, accept) {
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    checkDeadline();
    let retryAfter = null;
    try {
      stats.requests++;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      retryAfter = response.headers.get("retry-after");
      const body = await response.text();
      if (response.ok) return body;
      reason = `HTTP ${response.status}`;
    } catch (error) {
      reason = error?.message ?? String(error);
    }
    console.error(
      `WARNING: ${label} fetch attempt ${attempt} failed (${reason}).`,
    );
    if (attempt < cfg.fetchAttempts) {
      await sleep(
        retryDelayMs({
          attempt,
          retryAfter,
          baseMs: cfg.retryBaseMs,
          maxMs: cfg.maxRetryAfterMs,
        }),
      );
    }
  }
  throw new ExtractionError(
    `Failed to fetch the ${label} (${reason}). The site may be down, blocking requests, or returning incomplete content; nothing was written.`,
  );
}

export async function fetchCatalog(cfg, checkDeadline = () => {}) {
  const body = await fetchText(
    cfg,
    cfg.catalogUrl,
    "Learn catalog",
    checkDeadline,
    "application/json",
  );
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ExtractionError(
      "The Learn catalog answer is not valid JSON (the API probably changed); nothing was written.",
    );
  }
  const courses = codesFromCatalog(json);
  if (courses.size < cfg.minCatalog) {
    throw new ExtractionError(
      `The Learn catalog gave ${courses.size} course codes (expected at least ${cfg.minCatalog}); the course numbers probably changed shape. Nothing was written.`,
    );
  }
  return courses;
}

/** The Learn page's codes, or null (with a warning) when it cannot be used. */
export async function fetchLearnPage(cfg, checkDeadline = () => {}) {
  try {
    const html = await fetchText(
      cfg,
      cfg.learnPageUrl,
      "Learn course videos page",
      checkDeadline,
      "text/html,application/xhtml+xml",
    );
    const codes = parseLearnPage(html);
    if (codes.size < cfg.minPageCodes) {
      warnLoud(
        `the Learn course videos page lists only ${codes.size} course videos (expected at least ${cfg.minPageCodes}); its layout probably changed, so it was ignored this run.`,
        { title: ANNOTATION_TITLE },
      );
      return null;
    }
    return codes;
  } catch (error) {
    if (!(error instanceof ExtractionError)) throw error;
    warnLoud(`${error.message} The Learn page was ignored this run.`, {
      title: ANNOTATION_TITLE,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// aka.ms
// ---------------------------------------------------------------------------
/**
 * What an aka.ms answer says. playlist: it redirects to a YouTube playlist;
 * youtube-other: to YouTube but not a playlist; none: anywhere else (aka.ms
 * sends an unknown name to a Bing page) or a plain not found; unverified: the
 * answer proves nothing (429, 5xx, a redirect without a place to go).
 */
export function classifyRedirect(status, location, base) {
  if (status >= 300 && status < 400) {
    if (!location) return { state: "unverified", reason: `HTTP ${status}` };
    let url;
    try {
      url = new URL(location, base);
    } catch {
      return { state: "unverified", reason: `HTTP ${status}, bad Location` };
    }
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
      return { state: "none" };
    }
    const playlist = playlistOfUrl(url.href);
    return playlist
      ? { state: "playlist", playlist }
      : { state: "youtube-other", location: url.href };
  }
  if (status === 404 || status === 410 || (status >= 200 && status < 300)) {
    return { state: "none" };
  }
  return { state: "unverified", reason: `HTTP ${status}` };
}

/** One GET of https://aka.ms/<code>onYouTube; the redirect is read, not followed. */
export async function probeCode(cfg, code, checkDeadline = () => {}) {
  const url = `${cfg.akamsOrigin}/${code}onYouTube`;
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    checkDeadline();
    let retryAfter = null;
    try {
      stats.requests++;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      retryAfter = response.headers.get("retry-after");
      try {
        await response.body?.cancel();
      } catch {
        /* the status and the Location header are all that is needed */
      }
      const outcome = classifyRedirect(
        response.status,
        response.headers.get("location"),
        url,
      );
      if (outcome.state !== "unverified") return outcome;
      reason = outcome.reason;
    } catch (error) {
      reason = error?.message ?? String(error);
    }
    console.error(
      `WARNING: aka.ms/${code}onYouTube attempt ${attempt} failed (${reason}).`,
    );
    if (attempt < cfg.fetchAttempts) {
      await sleep(
        retryDelayMs({
          attempt,
          retryAfter,
          baseMs: cfg.retryBaseMs,
          maxMs: cfg.maxRetryAfterMs,
        }),
      );
    }
  }
  return { state: "unverified", reason };
}

/** Every code, one request at a time: Map code -> outcome of probeCode. */
export async function probeCodes(cfg, codes, checkDeadline = () => {}) {
  const probes = new Map();
  let first = true;
  for (const code of codes) {
    if (!first) await sleep(cfg.fetchDelayMs);
    first = false;
    probes.set(code, await probeCode(cfg, code, checkDeadline));
  }
  return probes;
}

/**
 * The title YouTube's oEmbed endpoint gives a playlist. { state: "ok", title }
 * when it answers, "unreadable" when YouTube refuses it (a private, deleted or
 * embedding-disabled playlist), "unverified" for anything else. Never throws.
 */
export async function fetchPlaylistTitle(cfg, playlist) {
  const target = new URL(cfg.oembedUrl);
  target.searchParams.set(
    "url",
    `https://www.youtube.com/playlist?list=${playlist}`,
  );
  target.searchParams.set("format", "json");
  try {
    stats.requests++;
    const response = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (response.ok) {
      const json = await response.json();
      const title = cleanText(json?.title);
      return title ? { state: "ok", title } : { state: "unverified" };
    }
    await response.body?.cancel().catch(() => {});
    return [400, 401, 403, 404].includes(response.status)
      ? { state: "unreadable", status: response.status }
      : { state: "unverified", reason: `HTTP ${response.status}` };
  } catch (error) {
    return { state: "unverified", reason: error?.message ?? String(error) };
  }
}

// ---------------------------------------------------------------------------
// Baseline and the comparison
// ---------------------------------------------------------------------------
const hasEntries = (object) =>
  Boolean(object) && Object.keys(object).length > 0;

const sortedObject = (object) =>
  Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => byCodePoint(a, b)),
  );

function loadBaseline(cfg) {
  const rel = relative(root, cfg.baselineFile) || cfg.baselineFile;
  if (!existsSync(cfg.baselineFile)) return { exists: false, courses: {} };
  const raw = readFileSync(cfg.baselineFile, "utf8").trim();
  if (!raw) return { exists: false, courses: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExtractionError(
      `Corrupt course videos baseline at ${rel} (invalid JSON). The baseline was not modified.`,
    );
  }
  const plain = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  if (!plain(parsed?.courses)) {
    throw new ExtractionError(
      `Corrupt course videos baseline at ${rel} (missing courses object). The baseline was not modified.`,
    );
  }
  const courses = {};
  for (const [code, entry] of Object.entries(parsed.courses)) {
    if (!CODE_RE.test(code) || !PLAYLIST_ID_RE.test(entry?.playlist ?? "")) {
      throw new ExtractionError(
        `Corrupt course videos baseline at ${rel} (the entry "${code}" has no valid playlist). The baseline was not modified.`,
      );
    }
    courses[code] = {
      playlist: entry.playlist,
      since: String(entry.since ?? ""),
      ...(entry.missed ? { missed: Number(entry.missed) } : {}),
    };
  }
  return {
    exists: Object.keys(courses).length > 0,
    courses,
    staleHubCards: plain(parsed.staleHubCards) ? parsed.staleHubCards : {},
  };
}

/** The part of the baseline that decides whether it needs rewriting. */
function baselineContent(courses, staleHubCards) {
  return JSON.stringify({
    courses: sortedObject(courses),
    staleHubCards: hasEntries(staleHubCards)
      ? sortedObject(staleHubCards)
      : null,
  });
}

function baselineText(courses, staleHubCards) {
  const body = {
    lastChecked: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    totalCourses: Object.keys(courses).length,
  };
  if (hasEntries(staleHubCards))
    body.staleHubCards = sortedObject(staleHubCards);
  body.courses = sortedObject(courses);
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * The comparison by SET of codes. `previous` is the baseline's courses
 * ({ code: { playlist, since, missed? } }), `probes` the outcome of every code
 * asked this run.
 *   added    code now points at a playlist and was not in the baseline
 *   changed  code points at another playlist than before
 *   gone     in the baseline, but answered "no recording" on two runs in a row
 *            (the first run only marks it `missed`: aka.ms hiccups happen)
 *   pending  first "no recording" answer for a baseline code
 *   carried  not confirmed either way (the request failed): kept as it was
 */
export function diffCourses(previous, probes, today) {
  const next = {};
  const added = [];
  const changed = [];
  const gone = [];
  const pending = [];
  const carried = [];
  for (const [code, probe] of probes) {
    if (code === CONTROL_CODE) continue;
    const before = previous[code];
    if (probe.state === "playlist") {
      if (!before) added.push({ code, playlist: probe.playlist });
      else if (before.playlist !== probe.playlist) {
        changed.push({
          code,
          from: before.playlist,
          to: probe.playlist,
        });
      }
      next[code] = {
        playlist: probe.playlist,
        since: before?.playlist === probe.playlist ? before.since : today,
      };
    } else if (before) {
      if (probe.state === "unverified") {
        next[code] = before;
        carried.push(code);
      } else if ((before.missed ?? 0) >= 1) {
        gone.push({ code, playlist: before.playlist });
      } else {
        next[code] = { ...before, missed: 1 };
        pending.push({ code, playlist: before.playlist });
      }
    }
  }
  for (const [code, before] of Object.entries(previous)) {
    if (!probes.has(code)) {
      next[code] = before;
      carried.push(code);
    }
  }
  const byCode = (a, b) => byCodePoint(a.code, b.code);
  return {
    next: sortedObject(next),
    added: added.sort(byCode),
    changed: changed.sort(byCode),
    gone: gone.sort(byCode),
    pending: pending.sort(byCode),
    carried: carried.sort(byCodePoint),
  };
}

// ---------------------------------------------------------------------------
// The hub's cards against the short links
// ---------------------------------------------------------------------------
/**
 * What is wrong with the cards, one finding per card:
 *   use-short-link  a direct playlist link where aka.ms/<CODE>onYouTube resolves
 *                   to the very same playlist: use the short link
 *   moved           a direct playlist link to a playlist its code no longer
 *                   resolves to (the course was re-recorded or replaced)
 *   broken          a short link that does not resolve to a playlist (twice in a
 *                   row for a code that did resolve before)
 * `skipped` are the cards whose code could not be asked this run: their
 * remembered finding is kept.
 *
 * `courses` is the baseline of this run (code -> { playlist, missed? }), `previous`
 * the one of the last run: a playlist that was the answer last time still belongs
 * to its code, which is how a card with the OLD playlist is recognised.
 */
export function evaluateHubCards(cards, courses, previous, probes) {
  const reverse = new Map();
  for (const [code, entry] of Object.entries(previous)) {
    reverse.set(entry.playlist, code);
  }
  for (const [code, entry] of Object.entries(courses)) {
    reverse.set(entry.playlist, code);
  }
  const findings = [];
  const skipped = [];
  for (const card of cards) {
    if (card.code) {
      const state = probes.get(card.code)?.state;
      if (courses[card.code] && !courses[card.code].missed) continue;
      if (state === "unverified" || courses[card.code]?.missed) {
        skipped.push(card);
        continue;
      }
      if (state === "none" || state === "youtube-other") {
        findings.push({
          card,
          code: card.code,
          problem: "broken",
          detail: `aka.ms/${card.code}onYouTube does not resolve to a YouTube playlist`,
        });
      }
      continue;
    }
    const code = reverse.get(card.playlist) || titleCode(card.title);
    if (!code) continue;
    const current = courses[code];
    if (!current || current.missed) continue;
    if (current.playlist === card.playlist) {
      findings.push({
        card,
        code,
        problem: "use-short-link",
        detail: `links the playlist of ${code} directly`,
        suggestion: shortLink(code),
      });
    } else {
      findings.push({
        card,
        code,
        problem: "moved",
        detail: `${code} now resolves to another playlist than this card links`,
        suggestion: shortLink(code),
      });
    }
  }
  return { findings, skipped };
}

export const hubKey = (card) => `${card.file}|${card.href}`;

/**
 * Remembers what was already reported: `next` is the state to store (flagged
 * cards only, so a fixed one drops out), `fresh` the findings to report now.
 */
export function diffHubState(previousState, findings, skipped, today) {
  const previous = previousState ?? {};
  const next = {};
  const fresh = [];
  let known = 0;
  for (const card of skipped) {
    const key = hubKey(card);
    if (previous[key]) {
      next[key] = previous[key];
      known++;
    }
  }
  for (const finding of findings) {
    const key = hubKey(finding.card);
    const before = previous[key];
    next[key] = {
      problem: finding.problem,
      since: before?.problem === finding.problem ? before.since : today,
    };
    if (before?.problem === finding.problem) known++;
    else fresh.push(finding);
  }
  return { next: sortedObject(next), fresh, known };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
/**
 * A name taken from a web page, for a heading or a table cell of a public issue:
 * no HTML, links or code spans, and no @mention or #123 cross-reference.
 */
export function safeText(text) {
  return cleanText(
    cleanText(text)
      .replace(/[<>`[\]|]/g, " ")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE),
  );
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function limitRows(rows) {
  if (rows.length <= MAX_TABLE_ROWS) return rows;
  return [
    ...rows.slice(0, MAX_TABLE_ROWS),
    `| … ${rows.length - MAX_TABLE_ROWS} more not shown |`,
  ];
}

export function buildIssueTitle({ added, fresh }) {
  const parts = [];
  if (added.length > 0) {
    const codes = added.map((entry) => entry.code).sort(byCodePoint);
    const shown = codes.slice(0, 4);
    const rest = codes.length - shown.length;
    parts.push(
      `${plural(added.length, "new course video")} (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})`,
    );
  }
  if (fresh.length > 0) {
    parts.push(plural(fresh.length, "card to review", "cards to review"));
  }
  return `Course videos: ${parts.join("; ")}`.slice(0, 200);
}

const PROBLEM_TEXT = {
  "use-short-link": "use the short link",
  moved: "points at an older playlist",
  broken: "short link does not resolve",
};

/** The card to add for a new course, in the repo's own wording. */
function suggestedCard(code) {
  return `<LinkCard title="Microsoft Learn ${code} Course on YouTube" href="${shortLink(code)}" target="_blank"/>`;
}

/**
 * The exam pages a new course without an exam of its own (AI-3026, SC-5006)
 * could go on: Map code -> the result of `placeCourse` of
 * scripts/course-placement.mjs (docs/course-placement.md). A suggestion is a
 * courtesy, never evidence: when the study guides or the learnsync data cannot
 * be read, the issue is written without it (a warning annotation says so).
 */
export async function suggestPlacements(
  entries,
  { catalog, details, examPages },
) {
  const wanted = entries.filter(({ code }) => !examPages.has(code));
  const out = new Map();
  if (wanted.length === 0) return out;
  try {
    const placement = await import("./course-placement.mjs");
    const world = await placement.loadPlacement({
      root,
      env: process.env,
      courses: [...catalog.values()].map((entry) => entry.course),
    });
    for (const { code } of wanted) {
      // A course the catalog does not list is matched by its playlist's title.
      const playlistTitle = (details.get(code)?.playlistTitle ?? "").replace(
        new RegExp(`^${code}\\s*[:\\-–—]\\s*`, "i"),
        "",
      );
      const course =
        catalog.get(code)?.course ??
        (playlistTitle
          ? {
              course_number: code,
              title: playlistTitle,
              study_guide: [],
              fromPlaylist: true,
            }
          : null);
      if (course) out.set(code, placement.placeCourse(world, course));
    }
  } catch (error) {
    warnLoud(
      `could not suggest exam pages for the new courses (${error?.message ?? error}); the issue lists them without suggestions.`,
      { title: ANNOTATION_TITLE },
    );
  }
  return out;
}

/**
 * `view` is everything the text needs: cfg, the diff, the fresh hub findings
 * and how many were known, `details` (code -> { catalogTitle, pageText,
 * playlistTitle }), `placements` (code -> placeCourse result, optional),
 * `examPages` and `hubCards`.
 */
export function buildReport(view) {
  const {
    cfg,
    diff,
    hubFresh,
    hubKnown,
    details,
    examPages,
    hubCards,
    placements = new Map(),
  } = view;
  const suggestionsCell = (code) => {
    const result = placements.get(code);
    if (examPages.has(code)) return "—";
    if (!result) return "not available";
    if (result.suggestions.length === 0) return "no clear match";
    return result.suggestions
      .slice(0, 3)
      .map((suggestion) =>
        safeText(describeSuggestion(suggestion, { groupsShown: 1 })),
      )
      .join("<br>");
  };
  const lines = [
    "## Course video changes detected",
    "",
    `Checked on ${cfg.today}: the short links \`https://aka.ms/<CODE>onYouTube\` of ${view.checked} course codes, ${view.resolving} of them resolve to a YouTube playlist of Microsoft Learn. ` +
      "The baseline is `src/data_files/course-videos.json`; it is refreshed by the same run, so each change is reported once.",
    "",
  ];

  const hubFilesOf = (code, playlist) =>
    [
      ...new Set(
        hubCards
          .filter((card) => cardCovers(card, code, playlist, view.courses))
          .map((card) => card.file),
      ),
    ].sort(byCodePoint);

  if (diff.added.length > 0) {
    lines.push(`### New course videos (${diff.added.length})`, "");
    lines.push(
      "| Course | Learn course | Playlist title | Hub exam page | Suggested exam pages | Already on the hub | Short link |",
      "|--------|--------------|----------------|---------------|----------------------|--------------------|------------|",
    );
    const rows = diff.added.map(({ code, playlist }) => {
      const detail = details.get(code) ?? {};
      const page = examPages.get(code);
      const files = hubFilesOf(code, playlist);
      return (
        `| ${code} | ${detail.catalogTitle ? safeText(detail.catalogTitle) : "—"} | ` +
        `${detail.playlistTitle ? safeText(detail.playlistTitle) : "—"} | ` +
        `${page ? `\`${page}\`` : "no exam page"} | ` +
        `${suggestionsCell(code)} | ` +
        `${files.length > 0 ? files.map((file) => `\`${file}\``).join("<br>") : "no card"} | ` +
        `[${shortLink(code).replace("https://", "")}](${shortLink(code)}) |`
      );
    });
    lines.push(...limitRows(rows), "");
    lines.push("Card to add (Videos tab, in the `CardGrid`):", "");
    for (const { code } of diff.added) {
      lines.push("```mdx", suggestedCard(code), "```", "");
    }
  }

  if (diff.changed.length > 0) {
    lines.push(
      `### Short links that now point at another playlist (${diff.changed.length}, informational)`,
      "",
      "Cards that use the short link follow by themselves. Cards that link the old playlist directly are listed below.",
      "",
      "| Course | Before | Now | Playlist title |",
      "|--------|--------|-----|----------------|",
      ...limitRows(
        diff.changed.map(
          ({ code, from, to }) =>
            `| ${code} | \`${from}\` | \`${to}\` | ${details.get(code)?.playlistTitle ? safeText(details.get(code).playlistTitle) : "—"} |`,
        ),
      ),
      "",
    );
  }

  if (hubFresh.length > 0) {
    lines.push(
      `### Exam page cards to review (${hubFresh.length})`,
      "",
      "These cards in `src/content/docs` link a Microsoft Learn course video in a way that does not follow the short link. Each is reported once; a fixed card drops out of the baseline by itself.",
      "",
      "| Card | Problem | Used in | Suggestion |",
      "|------|---------|---------|------------|",
    );
    const rows = hubFresh.map(
      (finding) =>
        `| ${finding.card.title ? safeText(finding.card.title) : "—"} | ${PROBLEM_TEXT[finding.problem]} (${safeText(finding.detail)}) | ` +
        `\`${finding.card.file}:${finding.card.line}\` | ${
          finding.suggestion
            ? `Use \`${finding.suggestion}\``
            : "Find the current playlist on the Microsoft Learn YouTube channel, or remove the card"
        } |`,
    );
    lines.push(...limitRows(rows), "");
    if (hubKnown > 0) {
      lines.push(
        `${plural(hubKnown, "card")} reported in an earlier run ${hubKnown === 1 ? "is" : "are"} still unchanged and not repeated here.`,
        "",
      );
    }
  }

  if (diff.gone.length > 0) {
    lines.push(
      `### Courses that stopped resolving (${diff.gone.length}, informational)`,
      "",
      "Their short link redirected somewhere else on two runs in a row. They are dropped from the baseline.",
      "",
      "| Course | Last playlist |",
      "|--------|---------------|",
      ...limitRows(
        diff.gone.map(({ code, playlist }) => `| ${code} | \`${playlist}\` |`),
      ),
      "",
    );
  }

  lines.push("### What to do", "");
  let step = 1;
  if (diff.added.length > 0) {
    lines.push(
      `${step++}. For each new course, open the short link and check that the playlist is the course's own (the title starts with the code). ` +
        "Add the card to the Videos tab of the hub exam page named in the table, next to the other instructor-led training cards and with the " +
        '`Microsoft Learn <CODE> Course on YouTube` title (see "Exam Page Anatomy" in `AGENTS.md`); add a short description when the course title helps. ' +
        "A course whose code is not an exam (the four-digit ones, such as AI-3016) goes on the page of the exam whose study guide covers it: " +
        "the suggestions column lists the candidates with the evidence behind each (a course's modules that an exam's own course contains, the words its title shares with the study guide, " +
        "the skill groups it covers; `node scripts/course-placement.mjs <CODE>` shows more), but it is a suggestion, so check it against the course and the study guide. " +
        "A course without a hub exam page needs no action until that page exists.",
    );
  }
  if (hubFresh.length > 0) {
    lines.push(
      `${step++}. For each card to review, change the \`href\` to the suggested short link (or, for a short link that does not resolve, find the current playlist and ask whether the card should stay).`,
    );
  }
  if (diff.added.length > 0 || hubFresh.length > 0) {
    lines.push(
      `${step++}. Run \`node scripts/audit-missing-resources.mjs\` if a card was added, then \`pnpm build\`.`,
    );
  }
  lines.push(
    "",
    'See the "Course Videos Monitor" runbook (`docs/monitors/course-videos.md`) for the full process.',
  );

  let text = lines.join("\n") + "\n";
  if (text.length > REPORT_MAX_CHARS) {
    text =
      text.slice(0, REPORT_MAX_CHARS - 200) +
      "\n\n_(report cut: it exceeded the issue size limit; see the job summary and the baseline diff)_\n";
  }
  return text;
}

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
    issue_title: "",
    new_courses: 0,
    hub_findings: 0,
  });
  process.exit(1);
}

export async function main(cfg) {
  console.log("=== Course Videos Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);
  // Never publish a stale report or error.
  rmSync(cfg.reportFile, { force: true });
  rmSync(cfg.errorFile, { force: true });

  const baseline = loadBaseline(cfg);
  const silent = !baseline.exists || cfg.forceBaseline;
  const checkDeadline = makeDeadline(cfg.deadlineMs);

  // The sources of candidate codes. The catalog is needed (a failing one stops
  // the run); the Learn page is a second opinion (a failing one is a warning).
  const catalog = await fetchCatalog(cfg, checkDeadline);
  const page = await fetchLearnPage(cfg, checkDeadline);
  const examPages = findExamPages(cfg.docsDir);
  const hubCards = scanHubCards(cfg.docsDir);

  const candidates = new Set(
    [
      ...catalog.keys(),
      ...(page?.keys() ?? []),
      ...examPages.keys(),
      ...hubCards.flatMap((card) => (card.code ? [card.code] : [])),
      ...Object.keys(baseline.courses),
    ].filter((code) => CODE_RE.test(code) && code !== CONTROL_CODE),
  );
  const codes = [...candidates].sort(byCodePoint);
  console.log(
    `Asking aka.ms for ${codes.length} course codes (catalog ${catalog.size}, Learn page ${page ? page.size : "unavailable"}, hub exam pages ${examPages.size}, hub short links ${hubCards.filter((card) => card.code).length}, baseline ${Object.keys(baseline.courses).length})`,
  );

  const probes = await probeCodes(cfg, [CONTROL_CODE, ...codes], checkDeadline);

  // Failsafes on what aka.ms said.
  const control = probes.get(CONTROL_CODE);
  if (control.state === "playlist") {
    throw new ExtractionError(
      `aka.ms answers the control code ${CONTROL_CODE}onYouTube, which cannot exist, with a YouTube playlist (${control.playlist}); it would resolve every course. Nothing was written.`,
    );
  }
  const unverified = [...probes.entries()].filter(
    ([, probe]) => probe.state === "unverified",
  );
  const unverifiedPct = (unverified.length * 100) / probes.size;
  if (unverifiedPct > cfg.maxUnverifiedPct) {
    throw new ExtractionError(
      `${unverified.length} of ${probes.size} requests to aka.ms failed (${Math.round(unverifiedPct)}%, threshold ${cfg.maxUnverifiedPct}%; for example ${unverified[0][0]}: ${unverified[0][1].reason}). ` +
        "aka.ms is unreachable or blocking requests. Nothing was written.",
    );
  }

  const diff = diffCourses(baseline.courses, probes, cfg.today);
  const baseSize = Object.keys(baseline.courses).length;
  if (!silent && baseSize >= PCT_MIN_BASE) {
    const newPct = (diff.added.length * 100) / baseSize;
    if (newPct > cfg.maxNewPct) {
      throw new ExtractionError(
        `${diff.added.length} course videos are new at once (${Math.round(newPct)}% of the ${baseSize} in the baseline, threshold ${cfg.maxNewPct}%), ` +
          "which looks like aka.ms or the course codes changed, not like news. Nothing was written. If the change is real, run the workflow with force_baseline enabled.",
      );
    }
    const gonePct = ((diff.gone.length + diff.pending.length) * 100) / baseSize;
    if (gonePct > cfg.maxGonePct) {
      throw new ExtractionError(
        `${diff.gone.length + diff.pending.length} of the ${baseSize} course videos in the baseline stopped resolving at once (${Math.round(gonePct)}%, threshold ${cfg.maxGonePct}%), ` +
          "which looks like aka.ms or the short link scheme changed. Nothing was written. If the change is real, run the workflow with force_baseline enabled.",
      );
    }
  }

  // The hub's own cards against what aka.ms says now.
  const hub = evaluateHubCards(hubCards, diff.next, baseline.courses, probes);
  const hubDiff = diffHubState(
    baseline.exists ? baseline.staleHubCards : undefined,
    hub.findings,
    hub.skipped,
    cfg.today,
  );
  const hubFresh = silent ? [] : hubDiff.fresh;

  // The titles of the playlists the issue is about (a courtesy).
  const details = new Map();
  if (!silent) {
    for (const entry of [...diff.added, ...diff.changed]) {
      const code = entry.code;
      const playlist = entry.playlist ?? entry.to;
      await sleep(cfg.fetchDelayMs);
      const info = await fetchPlaylistTitle(cfg, playlist);
      details.set(code, {
        catalogTitle: catalog.get(code)?.title ?? page?.get(code) ?? "",
        playlistTitle: info.state === "ok" ? info.title : "",
        playlistState: info.state,
      });
      if (info.state === "ok" && !info.title.toUpperCase().startsWith(code)) {
        warnLoud(
          `the playlist of ${code} is titled "${info.title}", which does not start with the code: open aka.ms/${code}onYouTube before adding a card.`,
          { title: ANNOTATION_TITLE },
        );
      }
    }
  }

  // The exam pages a new course without an exam of its own could go on.
  const placements =
    !silent && cfg.placement
      ? await suggestPlacements(diff.added, {
          catalog,
          details,
          examPages,
        })
      : new Map();

  // Decide.
  const changesFound =
    !silent && (diff.added.length > 0 || hubFresh.length > 0);
  const nextContent = baselineContent(diff.next, hubDiff.next);
  const previousContent = baseline.exists
    ? baselineContent(baseline.courses, baseline.staleHubCards)
    : null;
  const baselineChanged = nextContent !== previousContent;
  const resolving = Object.keys(diff.next).filter(
    (code) => !diff.next[code].missed,
  ).length;

  let issueTitle = "";
  if (changesFound) {
    issueTitle = buildIssueTitle({ added: diff.added, fresh: hubFresh });
    writeFileSync(
      cfg.reportFile,
      buildReport({
        cfg,
        diff,
        hubFresh,
        hubKnown: hubDiff.known,
        details,
        placements,
        courses: diff.next,
        examPages,
        hubCards,
        checked: codes.length,
        resolving,
      }),
      "utf8",
    );
  }
  if (baselineChanged) {
    writeFileSync(
      cfg.baselineFile,
      baselineText(diff.next, hubDiff.next),
      "utf8",
    );
  }

  for (const entry of diff.added) {
    console.log(`New course video: ${entry.code} (${entry.playlist})`);
  }
  for (const entry of diff.changed) {
    console.log(
      `Playlist changed: ${entry.code} (${entry.from} -> ${entry.to})`,
    );
  }
  for (const entry of diff.gone) {
    console.log(`Stopped resolving: ${entry.code}`);
  }
  for (const entry of diff.pending) {
    console.log(
      `Did not resolve this run (confirmed by the next): ${entry.code}`,
    );
  }
  for (const finding of hub.findings) {
    console.log(
      `Hub card ${finding.problem}: ${finding.card.file}:${finding.card.line} (${finding.detail})`,
    );
  }
  if (unverified.length > 0) {
    const shown = unverified
      .slice(0, 5)
      .map(([code, probe]) => `${code} (${probe.reason})`)
      .join("; ");
    warnLoud(
      `${plural(unverified.length, "short link")} not confirmed this run, so left as they were: ${shown}` +
        (unverified.length > 5 ? `; and ${unverified.length - 5} more` : ""),
      { title: ANNOTATION_TITLE },
    );
  }
  if (silent && diff.added.length > 0) {
    console.log(
      baseline.exists
        ? `FORCE_BASELINE: ${diff.added.length} course videos accepted silently.`
        : `No baseline found. Created it with ${Object.keys(diff.next).length} course videos; no issue is opened.`,
    );
  }
  console.log(
    changesFound
      ? `Found ${diff.added.length} new course videos and ${hubFresh.length} cards to review!`
      : "No alert.",
  );
  console.log(baselineChanged ? "Baseline updated" : "Baseline unchanged");
  console.log(`HTTP requests: ${stats.requests}`);

  // How complete is the Learn page: the second opinion this run was asked for.
  const summary = [
    `- Asked aka.ms for ${codes.length} course codes: ${resolving} resolve to a playlist, ${unverified.length} could not be confirmed.`,
    `- New: ${diff.added.length}${silent && diff.added.length > 0 ? " (accepted silently)" : ""}. Playlist changed: ${diff.changed.length}. Stopped resolving: ${diff.gone.length} (${diff.pending.length} waiting for a second run).`,
    `- Hub cards: ${hubCards.length} link a short link or a YouTube playlist, ${hub.findings.length} to review (${hubDiff.known} already reported).`,
    `- Baseline ${baselineChanged ? "updated" : "unchanged"}.`,
  ];
  if (page) {
    const resolvingCodes = Object.keys(diff.next).filter(
      (code) => !diff.next[code].missed,
    );
    const missingOnPage = resolvingCodes.filter((code) => !page.has(code));
    const deadOnPage = [...page.keys()].filter(
      (code) => !resolvingCodes.includes(code),
    );
    summary.push(
      `- Learn page: lists ${page.size} course videos; ${missingOnPage.length} that resolve are not on it${missingOnPage.length > 0 ? ` (${missingOnPage.join(", ")})` : ""}; ${deadOnPage.length} on it do not resolve${deadOnPage.length > 0 ? ` (${deadOnPage.join(", ")})` : ""}.`,
    );
    console.log(summary.at(-1).slice(2));
  } else {
    summary.push("- Learn page: not available this run.");
  }
  const other = [...probes.entries()]
    .filter(([, probe]) => probe.state === "youtube-other")
    .map(([code]) => code);
  if (other.length > 0) {
    summary.push(
      `- Short links that go to YouTube but not to a playlist (not followed): ${other.join(", ")}.`,
    );
  }
  appendStepSummary(
    cfg.stepSummary,
    `### Course Videos Monitor\n\n${summary.join("\n")}\n`,
  );

  writeOutput(cfg.githubOutput, {
    changes_found: changesFound,
    baseline_updated: baselineChanged,
    extraction_failed: false,
    issue_title: issueTitle,
    new_courses: silent ? 0 : diff.added.length,
    hub_findings: hubFresh.length,
  });
  console.log("=== Done ===");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
