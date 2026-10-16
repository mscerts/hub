#!/usr/bin/env node
/**
 * Watches the Microsoft Skills Hub blog, the channel where Microsoft announces
 * new, renamed and retiring exams and certifications, beta windows and vouchers
 * weeks before the Microsoft Learn pages change. The hub's beta rule ("Beta Exam
 * Pages" in AGENTS.md) takes the beta start date, and the go-live month when
 * Microsoft names one, from exactly such an official announcement, and nothing
 * else watched it.
 *
 * Usage:
 *   node scripts/skills-hub-watch.mjs
 *
 * Source: the RSS feed of the blog board, the one the blog page itself links
 * (https://aka.ms/MTC/RSS-Board-Footer?board.id=skills-hub-blog redirects to it):
 *   https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog
 * It holds the 20 newest posts, each with its full text, no categories today.
 *
 * What it does, once per run (the workflow runs every 6 hours):
 *  1. Reads the feed (RSS 2.0, RSS 1.0 and Atom are understood) and compares the
 *     posts with the tracker src/data_files/skills-hub-posts.json. A post is
 *     identified by its numeric Tech Community id when the guid/link has one
 *     (`/ba-p/<id>`, `/blog/<board>/<slug>/<id>`), else by the guid or link, so
 *     an edited title or slug is never a new post.
 *  2. A NEW post is relevant when RELEVANCE_RE matches its title, its summary
 *     (the first SUMMARY_CHARS characters of the text, which is the teaser: the
 *     feed's description is the whole article, and matching the whole article
 *     matched 19 of the 20 posts) or its categories. A second, much stricter
 *     pass reads the whole article for the few words that cannot be incidental
 *     (voucher, retire/retirement, "beta exam", an exam code like AB-650): two
 *     real AI Skills Fest posts announced free exam vouchers deep in the text
 *     under a title and a teaser about something else. Every new post is
 *     recorded with a `matched` flag; only the relevant ones are reported.
 *  3. ONE issue per run lists the new relevant posts (title, date, link, the
 *     exam codes in the post with the hub page and hub status of each, a short
 *     escaped excerpt, the dates the post states) and a checklist that points at
 *     AGENTS.md and docs/monitors/ (beta announcement, voucher, retirement, new exam).
 *     A post that names the code of a tracked beta exam (src/data_files/beta-exams.json,
 *     not flaggedGA) whose `announcement` is still "pending" or "unannounced" is the
 *     announcement that exam's beta note is waiting for: its entry in the issue starts
 *     with an ACTION line and the exact steps (record the post's URL as `announcement`,
 *     regenerate the note with scripts/beta-note.mjs, add the beta voucher page, re-run
 *     the tests). An exam whose announcement already is a URL, and a post that names no
 *     such exam, change nothing. A beta-exams.json that cannot be read is said so in the
 *     issue and never fails the run.
 *
 * Rules:
 *  - First run (no tracker or no posts in it, or FORCE_BASELINE=1): silent
 *    baseline. The newest BASELINE_SHOWN (5) relevant posts go into the job
 *    summary so the maintainers can see what was swallowed.
 *  - A fetch failure is never evidence: the tracker keeps its posts, the run
 *    warns, and a counter in the tracker (`problem`) counts consecutive runs
 *    without a usable feed. An empty or malformed feed (HTTP 200 but not RSS/Atom
 *    or fewer than MIN_FEED_ITEMS usable items) and a gone feed (404/410) raise
 *    an `extraction failed` issue on the DEFINITE_FAILURE_RUNS-th (2) consecutive
 *    definite run; a feed that merely cannot be fetched (5xx, 429, timeouts,
 *    network errors) after FETCH_FAILURE_RUNS (8) runs, about two days. The issue
 *    repeats every REMINDER_DAYS (7) while the problem lasts, and the workflow
 *    run is red meanwhile. The counter stops growing at its threshold, so an
 *    outage does not commit the tracker every 6 hours. What the run tells the
 *    workflow: extraction_failed (raise the failure issue), feed_problem (end the
 *    run red) and feed_read (a usable feed was read and nothing failed: ONLY then
 *    does the workflow close the failure issue). A first or second bad read sets
 *    none of the three: it is no evidence of a problem and none of health, so it
 *    must not close an issue that the failsafe below or a corrupt tracker raised.
 *  - Failsafe: more than MAX_NEW_POSTS (10) new posts at once is the feed changing
 *    shape (another board, another id scheme), not news: nothing is written and
 *    a `bug` issue is raised. FORCE_BASELINE=1 (the workflow's force_baseline
 *    input) records them silently.
 *  - The CDN in front of the feed serves different snapshots within seconds of
 *    each other (verified live 2026-10-14), and a stale snapshot holds posts
 *    that already rolled out of a fresher snapshot's window of 20. Such an
 *    unseen post more than OLD_POST_DAYS (30) older than the newest known post
 *    is ignored (neither reported nor recorded, so the tracker stays byte-stable;
 *    the job summary says how many): a post that is really new is never older
 *    than the newest one.
 *  - The tracker is byte-stable: it is rewritten only when a new post appears or
 *    the `problem` counter changes; `lastSynced` moves only with new posts. It
 *    keeps the newest MAX_TRACKED_POSTS (200) posts.
 *  - Text from the feed is untrusted: it is stripped of HTML, cut to a short
 *    excerpt and escaped (no @mention, #123 or GH-123 reference, link, HTML, code
 *    span or table break), and the post link is only used when it is a
 *    microsoft.com / aka.ms URL.
 *
 * Env overrides (defaults shown):
 *   FEED_URL            the verified feed URL above
 *   TRACKER_FILE        src/data_files/skills-hub-posts.json
 *   DOCS_DIR            src/content/docs   (hub pages, voucher pages)
 *   EXAM_STATUS_FILE    src/data_files/exam-status.mjs
 *   LEARN_TRACKER_FILE  src/data_files/learn-exams.json
 *   BETA_EXAMS_FILE     src/data_files/beta-exams.json   (tracked beta exams, the state of their announcement)
 *   REPORT_FILE         <tmpdir>/skills-hub-report.md
 *   ERROR_FILE          <tmpdir>/skills-hub-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (unset: no job summary)
 *   FETCH_ATTEMPTS      3
 *   RETRY_BASE_MS       5000
 *   MAX_RETRY_AFTER_MS  60000
 *   FETCH_TIMEOUT_MS    30000
 *   MAX_FEED_BYTES      5242880
 *   MIN_FEED_ITEMS      5
 *   MAX_NEW_POSTS       10
 *   MAX_TRACKED_POSTS   200
 *   OLD_POST_DAYS       30     an unseen post this much older than the newest
 *                              known post is a stale-snapshot artefact (0: off)
 *   DEFINITE_FAILURE_RUNS 2
 *   FETCH_FAILURE_RUNS  8
 *   REMINDER_DAYS       7
 *   FORCE_BASELINE      1 records every new post silently
 *   TODAY               YYYY-MM-DD, for tests
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * feed_problem, feed_read, issue_title, posts_new, posts_relevant.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  appendStepSummary,
  warnLoud as warn,
  writeOutput,
} from "./lib/actions.mjs";
import { AREA_BY_PREFIX } from "./lib/areas.mjs";
import { announcementState } from "./lib/beta-note.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const FEED_URL =
  "https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog";
export const BLOG_URL =
  "https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog";

// THE relevance filter, in one place: a post is relevant when this matches its
// title, its summary or its categories. Plain substrings on purpose ("exam" also
// matches "example"): a post reported for nothing costs a glance, a missed
// announcement costs an outdated page. No `g` flag, so .test() has no state.
export const RELEVANCE_RE =
  /exam|certif|retir|beta|voucher|renew|roundup|credential|applied skill|badge|discount/i;

// The stricter pass over the WHOLE article, for what the title and the teaser
// can miss: a post about a skills festival that announces free exam vouchers in
// its fourth section (2026-06-16, "Free Microsoft Certification exam vouchers")
// or one that says a voucher comes with an eligible playlist (2026-06-02). The
// words are the ones that cannot be incidental in an article of this blog; the
// broad words (exam, certif, credential, badge, discount, renew) are left to the
// title and the teaser because they appear in almost every article (matching
// them anywhere matched 19 of the 20 posts). On the 20 live posts of 2026-10-14
// this pass adds exactly those 2 and no other. "term" is the name the checklist
// of the report uses.
export const BODY_RELEVANCE = [
  { term: "voucher", re: /voucher/i },
  { term: "retir", re: /\bretir(?:e|es|ed|ing|ement)\b/i },
  { term: "beta", re: /\bbeta exams?\b/i },
];
// An exam code in the article ("AB-650", also with a non-breaking hyphen).
const BODY_CODE_RE = /\b[A-Z]{2,3}[‐‑‒–−-]\d{3}\b/;

/** The terms of the stricter pass that occur in the article text of a post. */
export function bodyTerms(post) {
  const text = (post.bodyBlocks ?? []).join("\n");
  const found = BODY_RELEVANCE.filter(({ re }) => re.test(text)).map(
    ({ term }) => term,
  );
  return { terms: found, code: BODY_CODE_RE.test(text) };
}

export const SUMMARY_CHARS = 600;
export const EXCERPT_CHARS = 300;
const BASELINE_SHOWN = 5;
const MAX_FEED_ITEMS = 500;
const MAX_TITLE_CHARS = 300;
const REPORT_MAX_CHARS = 60000;
const ISSUE_TITLE_MAX_CHARS = 200;
const MAX_DATED_STATEMENTS = 4;
const DATED_STATEMENT_MAX_CHARS = 300;
const PROBLEM_KINDS = ["feed", "gone", "fetch"];
const HUB_SITE = "https://msfthub.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// Detail levels of the report, tried in turn until it fits into one issue
// (GitHub rejects bodies above 65,536 characters).
const REPORT_LEVELS = [
  { excerpt: EXCERPT_CHARS, dates: MAX_DATED_STATEMENTS, codes: 40 },
  { excerpt: 150, dates: 2, codes: 20 },
  { excerpt: 0, dates: 0, codes: 10 },
];

export class ExtractionError extends Error {}

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
    feedUrl: env.FEED_URL || FEED_URL,
    trackerFile: resolveFromRoot(
      env.TRACKER_FILE ?? "src/data_files/skills-hub-posts.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? "src/content/docs"),
    examStatusFile: resolveFromRoot(
      env.EXAM_STATUS_FILE ?? "src/data_files/exam-status.mjs",
    ),
    learnTrackerFile: resolveFromRoot(
      env.LEARN_TRACKER_FILE ?? "src/data_files/learn-exams.json",
    ),
    betaExamsFile: resolveFromRoot(
      env.BETA_EXAMS_FILE || "src/data_files/beta-exams.json",
    ),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "skills-hub-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "skills-hub-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    fetchAttempts: num("FETCH_ATTEMPTS", 3),
    retryBaseMs: num("RETRY_BASE_MS", 5000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    maxFeedBytes: num("MAX_FEED_BYTES", 5 * 1024 * 1024),
    minFeedItems: num("MIN_FEED_ITEMS", 5),
    maxNewPosts: num("MAX_NEW_POSTS", 10),
    maxTrackedPosts: num("MAX_TRACKED_POSTS", 200),
    oldPostDays: num("OLD_POST_DAYS", 30),
    definiteRuns: num("DEFINITE_FAILURE_RUNS", 2),
    fetchRuns: num("FETCH_FAILURE_RUNS", 8),
    reminderDays: num("REMINDER_DAYS", 7),
    forceBaseline: ["1", "true", "yes"].includes(
      String(env.FORCE_BASELINE ?? "").toLowerCase(),
    ),
    today,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A problem that does not fail the run but must not go unnoticed: on stderr and,
 * on a GitHub runner, as a workflow annotation shown on the run summary page.
 */
const warnLoud = (message) => warn(message, { title: "Skills Hub Watch" });

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  laquo: "«",
  raquo: "»",
};

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** One pass, so "&amp;lt;" becomes "&lt;" and never "<". */
export function decodeEntities(str) {
  return String(str).replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,
    (whole, dec, hex, name) => {
      if (dec !== undefined) return safeCodePoint(Number(dec));
      if (hex !== undefined) return safeCodePoint(parseInt(hex, 16));
      // hasOwn: "&constructor;" must stay text, not become Object's constructor.
      const key = name.toLowerCase();
      return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : whole;
    },
  );
}

const collapse = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

// Plain code-point order, independent of the runner's locale.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One line of visible text: no control or invisible characters, one space. */
function cleanLine(text) {
  return collapse(
    String(text ?? "")
      .normalize("NFC")
      .replace(/[   ]/g, " ")
      .replace(/[­​-‏⁠﻿]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " "),
  );
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// HTML -> text
// ---------------------------------------------------------------------------
const BLOCK_TAG_RE =
  /<\/?(?:p|div|ul|ol|li|h[1-6]|table|thead|tbody|tfoot|tr|td|th|blockquote|section|article|figure|figcaption|pre|br|hr|dl|dt|dd|header|footer|aside|nav|details|summary|caption)\b[^>]*>/gi;

/** An HTML fragment as text blocks: one string per block, tags and entities gone. */
export function htmlToBlocks(html) {
  const text = decodeEntities(
    String(html ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi,
        " ",
      )
      .replace(BLOCK_TAG_RE, "\n")
      .replace(/<[^>]*>/g, ""),
  );
  return text.split("\n").map(cleanLine).filter(Boolean);
}

export const htmlToText = (html) => htmlToBlocks(html).join(" ");

// ---------------------------------------------------------------------------
// Feed parsing (RSS 2.0, RSS 1.0, Atom)
// ---------------------------------------------------------------------------
const tagCache = new Map();
/** Matches <name ...>inner</name> (not a self-closing tag); inner is group 1. */
function tagRe(name) {
  if (!tagCache.has(name)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    tagCache.set(
      name,
      new RegExp(
        `<${escaped}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${escaped}\\s*>`,
        "i",
      ),
    );
  }
  return tagCache.get(name);
}

function extractCdata(xml) {
  const sections = [];
  const text = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, data) => {
    sections.push(data);
    return `\u0000${sections.length - 1}\u0000`;
  });
  return { text, sections };
}

/** Element text: entities decoded, CDATA sections kept raw. */
function unwrap(inner, sections) {
  return inner
    .split(/\u0000(\d+)\u0000/)
    .map((part, index) =>
      index % 2 === 1 ? (sections[Number(part)] ?? "") : decodeEntities(part),
    )
    .join("");
}

function parseAttrs(source) {
  const attrs = {};
  for (const m of String(source).matchAll(
    /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

export function parseDate(value) {
  const text = collapse(value);
  if (!text) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The http(s) URL in a string, or "". Anything else is never kept or linked. */
export function httpUrl(value) {
  const text = collapse(value);
  if (!/^https?:\/\/\S+$/i.test(text)) return "";
  try {
    new URL(text);
    return text;
  } catch {
    return "";
  }
}

/**
 * Raw items of a document: { ok: true, items, format } or { ok: false, reason }.
 * Lenient on purpose (regular expressions, no entity expansion beyond the fixed
 * table), strict about what the document is: only an RSS or Atom root counts.
 */
export function parseFeed(xml) {
  const source = String(xml ?? "")
    .replace(/^﻿/, "")
    .replace(/\u0000/g, "");
  if (!source.trim()) return { ok: false, reason: "the response is empty" };

  const { text, sections } = extractCdata(source);
  const prolog = text
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>/gi, " ");
  const root = prolog.match(/<([A-Za-z_][\w:.-]*)/)?.[1]?.toLowerCase();
  if (!root) return { ok: false, reason: "the response is not XML" };
  const format =
    root === "rss" || root === "rdf:rdf"
      ? "rss"
      : root === "feed"
        ? "atom"
        : null;
  if (!format) {
    return {
      ok: false,
      reason: `the document is <${root.slice(0, 30)}>, not an RSS or Atom feed`,
    };
  }

  const itemRe =
    format === "atom"
      ? /<entry(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/entry\s*>/gi
      : /<item(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/item\s*>/gi;
  const items = [];
  for (const match of prolog.matchAll(itemRe)) {
    if (items.length >= MAX_FEED_ITEMS) break;
    items.push(parseItem(match[1], sections, format));
  }
  return { ok: true, format, items };
}

function parseItem(block, sections, format) {
  const element = (name) => {
    const m = block.match(tagRe(name));
    return m ? unwrap(m[1], sections) : "";
  };
  const all = (name) =>
    [...block.matchAll(new RegExp(tagRe(name).source, "gi"))].map((m) =>
      collapse(unwrap(m[1], sections)),
    );

  if (format === "atom") {
    let link = "";
    for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
      const attrs = parseAttrs(m[1]);
      if (!attrs.href) continue;
      if (!attrs.rel || attrs.rel === "alternate") {
        link = attrs.href;
        break;
      }
      link ||= attrs.href;
    }
    return {
      title: element("title"),
      link,
      guid: element("id"),
      date: element("published") || element("updated"),
      summaryHtml: element("summary"),
      bodyHtml: element("content"),
      categories: [
        ...[...block.matchAll(/<category\b([^>]*?)\/?>/gi)].map((m) => {
          const attrs = parseAttrs(m[1]);
          return collapse(attrs.label || attrs.term || "");
        }),
      ].filter(Boolean),
    };
  }

  return {
    title: element("title"),
    link: element("link"),
    guid: element("guid"),
    date: element("pubDate") || element("dc:date"),
    summaryHtml: element("description"),
    bodyHtml: element("content:encoded"),
    categories: [...all("category"), ...all("dc:subject")].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * A name for an issue title: one line, no HTML, no @mention, #123 or GH-123
 * cross-reference.
 */
export function plain(text) {
  return collapse(
    cleanLine(text)
      .replace(/[<>`]/g, " ")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE)
      .replace(/\bGH-(?=\d)/g, "GH-" + ZERO_WIDTH_SPACE),
  );
}

/**
 * Text from a post for Markdown (headings, table cells, a quote): everything
 * plain() does, plus no link (also a bare URL), no code span or table break, and
 * no emphasis or heading syntax.
 */
export function safeText(text) {
  return plain(
    cleanLine(text)
      .replace(/https?:\/\/\S+/gi, "(link)")
      .replace(/[[\]|]/g, " ")
      .replace(/([\\*_~])/g, "\\$1"),
  );
}

const cell = (text) => safeText(text) || "—";

// A configured URL (not feed text) as an inline code span.
const codeSpan = (text) => `\`${String(text).replace(/[`\r\n]+/g, " ")}\``;

/** Cuts at a word boundary, with an ellipsis when it cut. */
function excerptOf(text, max) {
  const flat = collapse(text);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * The identity of a post. Tech Community posts keep their numeric id when the
 * title (and so the slug of the URL) is edited, so that id wins; any other
 * guid or link is compared as a lowercased URL or string without fragment and
 * trailing slash.
 */
export function postKey(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate ?? "");
    const id =
      value.match(/\/(?:ba|bc|td)-p\/(\d{4,})(?:[/?#]|$)/i) ??
      value.match(/\/blog\/[^/?#]+\/[^/?#]+\/(\d{4,})(?:[/?#]|$)/i);
    if (id) return `tc:${id[1]}`;
  }
  for (const candidate of candidates) {
    const value = collapse(candidate).toLowerCase();
    if (value) return value.replace(/#.*$/, "").replace(/\/+$/, "");
  }
  return "";
}

/** The broad filter on the title, the teaser and the categories of a post. */
export function matchesBroadFilter({ title, summary, categories }) {
  return RELEVANCE_RE.test(
    [title, summary, ...(categories ?? [])].filter(Boolean).join("\n"),
  );
}

/**
 * The relevance filter on a post: the broad words in the title, the teaser or
 * the categories, or (with `bodyBlocks`) one of the stricter words anywhere in
 * the article.
 */
export function isRelevant(post) {
  if (matchesBroadFilter(post)) return true;
  const body = bodyTerms(post);
  return body.terms.length > 0 || body.code;
}

/**
 * The terms that made a post relevant, for the report: `broadTerms` are the
 * alternatives of RELEVANCE_RE that occur in the title, the teaser or the
 * categories, `articleOnly` the stricter words only the article text has,
 * `terms` both (what the checklist reads) and `code` says the article names an
 * exam code.
 */
export function matchedDetails(post) {
  const text = [post.title, post.summary, ...(post.categories ?? [])].join(
    "\n",
  );
  const broadTerms = RELEVANCE_RE.source
    .split("|")
    .filter((term) => new RegExp(term, "i").test(text));
  const body = bodyTerms(post);
  const articleOnly = body.terms.filter((term) => !broadTerms.includes(term));
  return {
    terms: [...broadTerms, ...articleOnly],
    broadTerms,
    articleOnly,
    code: body.code,
  };
}

/** The alternatives of the filter that occur, for the report and its checklist. */
export function matchedTerms(post) {
  return matchedDetails(post).terms;
}

/**
 * A raw feed item as a post, or null when it has no title or no id. Not stored
 * as is: the tracker keeps only { id, link, title, pubDate, matched }.
 */
export function toPost(raw) {
  // Stored as text; every place that shows it escapes it first (plain/safeText).
  const title = clip(htmlToText(raw.title), MAX_TITLE_CHARS);
  const link = httpUrl(raw.link);
  const guid = collapse(raw.guid);
  const id = guid || link;
  if (!title || !id) return null;

  const summaryBlocks = htmlToBlocks(raw.summaryHtml || raw.bodyHtml);
  const bodyBlocks = htmlToBlocks(raw.bodyHtml || raw.summaryHtml);
  const post = {
    id,
    link,
    key: postKey(guid, link),
    title,
    pubDate: parseDate(raw.date),
    summary: clip(summaryBlocks.join(" "), SUMMARY_CHARS),
    bodyBlocks,
    categories: raw.categories.map(cleanLine).filter(Boolean),
  };
  post.matched = isRelevant(post);
  return post;
}

/** All usable posts of a parsed feed, de-duplicated by key, in feed order. */
export function feedPosts(parsed) {
  const seen = new Set();
  const posts = [];
  let skipped = 0;
  for (const raw of parsed.items) {
    const post = toPost(raw);
    if (!post) {
      skipped++;
      continue;
    }
    if (seen.has(post.key)) continue;
    seen.add(post.key);
    posts.push(post);
  }
  return { posts, skipped };
}

// Exam codes: two or three capital letters, a hyphen, three digits ("AB-650",
// "GH-600"). "AZ-800T00" (a course) is not a code, "COVID-19" neither. The
// posts often write the hyphen as a non-breaking one (U+2011, "AB‑250"), so
// the other hyphen-like characters between the letters and the digits count as
// a hyphen.
export function extractExamCodes(text) {
  const codes = new Set();
  const normalized = String(text ?? "").replace(
    /\b([A-Z]{2,3})[‐‑‒–−](?=\d{3}\b)/g,
    "$1-",
  );
  for (const m of normalized.matchAll(/\b[A-Z]{2,3}-\d{3}\b/g)) {
    codes.add(m[0]);
  }
  return [...codes].sort(byCodePoint);
}

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
// "October 16, 2026", "October 2026", "October 16", "16 October 2026". Month
// names are matched with their capital: "may" is a verb.
const DATE_RE = new RegExp(
  `\\b${MONTH}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?(?:\\s*[–-]\\s*\\d{1,2})?,?\\s+)?\\d{4}\\b|` +
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`,
);
const DATE_CONTEXT_RE =
  /\b(?:beta|exam|retire|retires|retirement|voucher|discount|available|availability|schedule|scheduling|register|registration|deadline|expire|expires|until|through|launch|renew|renewal|live|begin|begins|start|starts|ends?)\b/i;
const STRONG_DATE_RE =
  /\b(?:beta|voucher|discount|retire|retires|retirement|register|registration|schedule|scheduling|deadline|goes live|general availability|generally available)\b/i;

/**
 * Sentences of a post that state a date and talk about an exam, a beta, a
 * voucher, a retirement or an availability, verbatim and de-duplicated, the
 * ones that mention a beta, voucher, retirement or registration first. They are
 * only a pointer for the maintainer: the post decides, and a date here is not
 * a verified beta start date.
 */
export function datedStatements(
  blocks,
  { max = MAX_DATED_STATEMENTS, maxChars = DATED_STATEMENT_MAX_CHARS } = {},
) {
  const candidates = [];
  const seen = new Set();
  for (const block of blocks) {
    for (const sentence of block.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const text = sentence.trim();
      if (text.length < 12 || !DATE_RE.test(text)) continue;
      if (!DATE_CONTEXT_RE.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ text, strong: STRONG_DATE_RE.test(text) });
      if (candidates.length >= 60) break;
    }
  }
  return [
    ...candidates.filter((c) => c.strong),
    ...candidates.filter((c) => !c.strong),
  ]
    .slice(0, max)
    .map((c) => clip(c.text, maxChars));
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
const isIsoDate = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const emptyTracker = () => ({
  lastSynced: null,
  problem: null,
  posts: [],
});

/** Newest first; undated posts last; ties by id so the order is deterministic. */
export function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    const left = a.pubDate ?? "";
    const right = b.pubDate ?? "";
    if (left !== right) return left < right ? 1 : -1;
    return byCodePoint(a.id, b.id);
  });
}

export function normalizeTracker(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.posts)) {
    throw new ExtractionError("missing posts array");
  }
  const seen = new Set();
  const posts = parsed.posts.map((post, index) => {
    const where = `post #${index + 1}`;
    if (!post || typeof post !== "object") {
      throw new ExtractionError(`${where} is not an object`);
    }
    if (typeof post.id !== "string" || !post.id) {
      throw new ExtractionError(`${where} has no id`);
    }
    if (typeof post.title !== "string") {
      throw new ExtractionError(`${where} has no title`);
    }
    if (typeof post.matched !== "boolean") {
      throw new ExtractionError(`${where} has no matched flag`);
    }
    if (
      post.pubDate !== null &&
      post.pubDate !== undefined &&
      typeof post.pubDate !== "string"
    ) {
      throw new ExtractionError(`${where} has a malformed pubDate`);
    }
    const key = postKey(post.id, post.link);
    if (seen.has(key)) {
      throw new ExtractionError(`${where} repeats the post ${post.id}`);
    }
    seen.add(key);
    return {
      id: post.id,
      title: post.title,
      ...(typeof post.link === "string" && post.link
        ? { link: post.link }
        : {}),
      pubDate: post.pubDate ?? null,
      matched: post.matched,
    };
  });

  let problem = null;
  if (parsed.problem !== null && parsed.problem !== undefined) {
    const p = parsed.problem;
    if (
      typeof p !== "object" ||
      !PROBLEM_KINDS.includes(p.kind) ||
      !Number.isInteger(p.runs) ||
      p.runs < 1 ||
      !Number.isInteger(p.definite) ||
      p.definite < 0 ||
      !isIsoDate(p.since) ||
      (p.reportedAt !== undefined && !isIsoDate(p.reportedAt))
    ) {
      throw new ExtractionError("malformed problem record");
    }
    problem = {
      kind: p.kind,
      runs: p.runs,
      definite: p.definite,
      since: p.since,
      ...(p.reportedAt ? { reportedAt: p.reportedAt } : {}),
    };
  }

  return {
    lastSynced: isIsoDate(parsed.lastSynced) ? parsed.lastSynced : null,
    problem,
    posts: sortPosts(posts),
  };
}

/** The tracker file content: fixed key order, one JSON line per post. */
export function trackerContent(tracker) {
  const post = (p) =>
    JSON.stringify({
      id: p.id,
      title: p.title,
      ...(p.link ? { link: p.link } : {}),
      pubDate: p.pubDate ?? null,
      matched: p.matched,
    });
  const problem = tracker.problem
    ? JSON.stringify({
        kind: tracker.problem.kind,
        runs: tracker.problem.runs,
        definite: tracker.problem.definite,
        since: tracker.problem.since,
        ...(tracker.problem.reportedAt
          ? { reportedAt: tracker.problem.reportedAt }
          : {}),
      })
    : "null";
  const posts = tracker.posts.length
    ? `[\n${tracker.posts.map((p) => `    ${post(p)}`).join(",\n")}\n  ]`
    : "[]";
  return (
    `{\n  "lastSynced": ${JSON.stringify(tracker.lastSynced ?? null)},\n` +
    `  "problem": ${problem},\n  "posts": ${posts}\n}\n`
  );
}

function loadTracker(cfg) {
  // A tracker that was never written is the first run.
  if (!existsSync(cfg.trackerFile)) return emptyTracker();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfg.trackerFile, "utf8"));
  } catch {
    throw new ExtractionError(
      `Corrupt tracker file at ${relative(root, cfg.trackerFile)} (invalid JSON).`,
    );
  }
  try {
    return normalizeTracker(parsed);
  } catch (error) {
    if (!(error instanceof ExtractionError)) throw error;
    throw new ExtractionError(
      `Corrupt tracker file at ${relative(root, cfg.trackerFile)} (${error.message}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
const toRecord = (post) => ({
  id: post.id,
  title: post.title,
  ...(post.link && post.link !== post.id ? { link: post.link } : {}),
  pubDate: post.pubDate,
  matched: post.matched,
});

/**
 * Applies a good read of the feed (posts in feed order) to the tracker. Returns
 * { baseline, fresh, news, older, relevant, changed, tracker }; pure, the tracker
 * passed in is not modified. A good read also ends a `problem`.
 *
 * `fresh` are the posts the tracker does not know. Microsoft's CDN serves
 * different snapshots of the feed within seconds of each other (checked
 * 2026-10-14: three snapshots, channel dates 12 Oct 12:00, 13 Oct 09:03 and
 * 13 Oct 15:06, one request after the other), and the feed holds the 20 posts
 * created last, ordered by creation while pubDate is the last publish time (the
 * 20th item is newer by pubDate than the 17th). A snapshot older than the one a
 * tracker was baselined from therefore contains posts that rolled out of the
 * newer window, and the tracker never saw them: on the first live test a
 * 2 June post turned up as "new" on the third run. A post that is not in the
 * tracker and is more than oldPostDays older than the newest post known (the
 * tracker's or this feed's) is such a post, not news, and is `older`: it is
 * neither reported nor recorded (recording it would commit the tracker for
 * nothing every time a stale snapshot shows up) and not counted by the
 * failsafe. A brand-new post is never older than the newest one. `news` are the
 * fresh posts that are not `older`: the ones that are recorded.
 *
 * Throws ExtractionError for more than maxNewPosts new posts at once, unless the
 * run is a baseline.
 */
export function applyFeed(tracker, posts, cfg) {
  const known = new Set(tracker.posts.map((p) => postKey(p.id, p.link)));
  const baseline = tracker.posts.length === 0 || cfg.forceBaseline;
  const fresh = posts.filter((post) => !known.has(post.key));

  const newest = [...tracker.posts, ...posts]
    .map((post) => post.pubDate)
    .filter(Boolean)
    .sort()
    .at(-1);
  const cutoff =
    newest && cfg.oldPostDays > 0
      ? new Date(Date.parse(newest) - cfg.oldPostDays * 86_400_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
      : null;
  const older =
    baseline || cutoff === null
      ? []
      : fresh.filter((post) => post.pubDate && post.pubDate < cutoff);
  const news = fresh.filter((post) => !older.includes(post));

  if (!baseline && news.length > cfg.maxNewPosts) {
    throw new ExtractionError(
      `${news.length} of the ${posts.length} posts in the feed are new at once (limit ${cfg.maxNewPosts}), ` +
        "so the feed probably changed shape (another board, another id scheme) instead of the blog publishing " +
        "that many posts between two runs. Nothing was written. If the posts are real, run the workflow with " +
        "force_baseline ticked: every post is then recorded silently, so read the latest posts of the blog yourself.\n\n" +
        "The new posts:\n\n```text\n" +
        news
          .slice(0, 12)
          .map((post) => `- ${clip(post.title, 140).replace(/`{3,}/g, "'''")}`)
          .join("\n") +
        "\n```",
    );
  }

  const changed = news.length > 0;
  const merged = changed
    ? sortPosts([...tracker.posts, ...news.map(toRecord)]).slice(
        0,
        cfg.maxTrackedPosts,
      )
    : tracker.posts;
  return {
    baseline,
    fresh,
    news,
    older,
    relevant: baseline ? [] : news.filter((post) => post.matched),
    changed,
    tracker: {
      lastSynced: changed ? cfg.today : tracker.lastSynced,
      problem: null,
      posts: merged,
    },
  };
}

/**
 * Applies a run without a usable feed to the tracker's `problem` counter.
 * `definite` is true for an answer that says the feed is wrong (HTTP 200 but not
 * a feed, 404, 410); a transient failure (5xx, 429, timeout, network) is never
 * evidence and only counts toward the longer threshold. Returns { tracker,
 * established, alert }: established when the problem has lasted long enough to
 * be an alert, alert when an issue is due now (the first time, then every
 * reminderDays). Pure.
 *
 * Once a problem is established the record is frozen: a further bad run changes
 * nothing, so an outage that lasts days does not commit the tracker every 6
 * hours (only `reportedAt` moves, once a week). Frozen means: the feed itself
 * said it is wrong (`definite` reached its threshold), or it could not be read
 * for fetchRuns runs and this run is a transient failure again. A transient
 * failure is no news either way, so it neither ends nor deepens a problem the
 * feed established. A definite answer after a streak of transient failures
 * still counts, because it names the kind of the problem.
 */
export function applyProblem(tracker, { kind, definite }, cfg) {
  const previous = tracker.problem;
  const wasDefinite = (previous?.definite ?? 0) >= cfg.definiteRuns;
  const wasEstablished = wasDefinite || (previous?.runs ?? 0) >= cfg.fetchRuns;
  const frozen = wasDefinite || (wasEstablished && !definite);

  const runs = frozen
    ? previous.runs
    : Math.min((previous?.runs ?? 0) + 1, cfg.fetchRuns);
  const definiteRuns = frozen
    ? previous.definite
    : definite
      ? Math.min((previous?.definite ?? 0) + 1, cfg.definiteRuns)
      : 0;
  const recordKind = frozen && !definite ? previous.kind : kind;
  const established =
    frozen || definiteRuns >= cfg.definiteRuns || runs >= cfg.fetchRuns;
  const reportedAt = previous?.reportedAt;
  const alert =
    established &&
    (!reportedAt || daysBetween(reportedAt, cfg.today) >= cfg.reminderDays);
  return {
    established,
    alert,
    tracker: {
      ...tracker,
      problem: {
        kind: recordKind,
        runs,
        definite: definiteRuns,
        since: previous?.since ?? cfg.today,
        ...(alert
          ? { reportedAt: cfg.today }
          : reportedAt
            ? { reportedAt }
            : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
/**
 * Whether an HTTP status is a definite answer about the feed (it is gone or not
 * allowed to be asked like this) rather than a rate limit or an outage.
 */
export function isDefiniteStatus(status) {
  return (
    status >= 400 &&
    status < 500 &&
    ![401, 403, 405, 406, 407, 408, 429].includes(status)
  );
}

/** GET with retries for rate limits, server errors and network errors only. */
async function fetchFeed(cfg) {
  let last = { ok: false, kind: "fetch", definite: false, reason: "not read" };
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    let retryAfter = null;
    try {
      const response = await fetch(cfg.feedUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text: await response.text(),
        };
      }
      const gone = response.status === 404 || response.status === 410;
      last = {
        ok: false,
        kind: gone ? "gone" : "fetch",
        definite: isDefiniteStatus(response.status),
        reason: `HTTP ${response.status}`,
      };
      retryAfter = response.headers.get("retry-after");
      console.error(
        `WARNING: ${cfg.feedUrl} attempt ${attempt} failed (${last.reason})`,
      );
      // Only rate limits and server errors are worth another try.
      if (response.status !== 429 && response.status < 500) return last;
    } catch (error) {
      const detail = error?.cause?.code
        ? `${error.message}: ${error.cause.code}`
        : (error?.message ?? String(error));
      last = {
        ok: false,
        kind: "fetch",
        definite: false,
        reason: `network error (${detail})`,
      };
      console.error(
        `WARNING: ${cfg.feedUrl} attempt ${attempt} failed (${detail})`,
      );
    }
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
  return last;
}

// ---------------------------------------------------------------------------
// Hub context: which exam codes the hub covers, and in what state
// ---------------------------------------------------------------------------
/** A short reason without file paths for a failed read, for a note in the issue. */
function reasonOf(error) {
  if (error?.code === "ENOENT" || error?.code === "ERR_MODULE_NOT_FOUND") {
    return "file not found";
  }
  if (error instanceof SyntaxError) return "invalid JSON or script";
  return "unreadable";
}

/**
 * The tracked beta exams that wait for their announcement post: the entries of
 * beta-exams.json that are not flaggedGA and whose `announcement` is "pending" or
 * "unannounced", as Map(code -> { code, state, betaStart }) (betaStart "" when the
 * entry has none). An entry without a usable code or announcement waits for nothing:
 * the tests of the beta pages are the ones that complain about it. Throws when the
 * file cannot be read as a tracker.
 */
export function readBetaWaiting(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed?.exams)) throw new Error("no exams list");
  const waiting = new Map();
  for (const entry of parsed.exams) {
    if (!entry || typeof entry !== "object" || entry.flaggedGA === true) {
      continue;
    }
    const code = String(entry.code ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{2,3}-\d{3}$/.test(code)) continue;
    let state;
    try {
      state = announcementState(entry.announcement);
    } catch {
      continue;
    }
    if (state === "announced") continue;
    waiting.set(code, {
      code,
      state,
      betaStart: typeof entry.betaStart === "string" ? entry.betaStart : "",
    });
  }
  return waiting;
}

/**
 * { pages: Map(code -> area), statuses: Map(code -> "BETA" | ...) | null,
 *   learn: Set(code) | null, vouchers: Map(code -> [slug]),
 *   betaWaiting: Map(code -> { code, state, betaStart }) | null, notes: [string] }.
 * `betaWaiting` holds the tracked beta exams (beta-exams.json, not flaggedGA) whose
 * announcement is still "pending" or "unannounced". Context only: whatever cannot
 * be read is reported as unknown in the issue and never changes whether a post is
 * reported.
 */
export async function loadHubContext(cfg) {
  const notes = [];
  const pages = new Map();
  for (const area of new Set(Object.values(AREA_BY_PREFIX))) {
    let names = [];
    try {
      names = readdirSync(join(cfg.docsDir, area));
    } catch {
      continue; // an area folder that does not exist has no exam pages
    }
    for (const name of names) {
      const match = /^([A-Za-z]{2,3}-\d{3})\.mdx$/.exec(name);
      if (match) pages.set(match[1].toUpperCase(), area);
    }
  }
  if (pages.size === 0) {
    notes.push(
      `no exam page was found under \`${relative(root, cfg.docsDir) || cfg.docsDir}\`, so the hub pages below are not known`,
    );
  }

  let statuses = null;
  try {
    const { examStatuses } = await import(
      pathToFileURL(cfg.examStatusFile).href
    );
    statuses = new Map();
    for (const exams of Object.values(examStatuses ?? {})) {
      for (const [code, status] of Object.entries(exams ?? {})) {
        statuses.set(code.toUpperCase(), String(status?.text ?? ""));
      }
    }
  } catch (error) {
    notes.push(
      `\`exam-status.mjs\` could not be loaded (${reasonOf(error)}), so the hub statuses are not shown`,
    );
    warnLoud(`could not load the hub exam statuses: ${error.message}`);
  }

  let learn = null;
  try {
    const parsed = JSON.parse(readFileSync(cfg.learnTrackerFile, "utf8"));
    if (!Array.isArray(parsed?.exams)) throw new Error("no exams list");
    learn = new Set(
      parsed.exams
        .map((exam) => String(exam?.code ?? "").toUpperCase())
        .filter(Boolean),
    );
  } catch (error) {
    notes.push(
      error?.code === "ENOENT"
        ? "`learn-exams.json` does not exist yet (the New Exam Monitor has not recorded its baseline), so it is not known which exams Microsoft Learn already lists"
        : `\`learn-exams.json\` could not be read (${reasonOf(error)}), so it is not known which exams Microsoft Learn already lists`,
    );
    warnLoud(`could not read the Learn exam tracker: ${error.message}`);
  }

  let betaWaiting = null;
  try {
    betaWaiting = readBetaWaiting(cfg.betaExamsFile);
  } catch (error) {
    notes.push(
      error?.code === "ENOENT"
        ? "`beta-exams.json` does not exist, so it is not known which beta exam is waiting for its announcement post"
        : `\`beta-exams.json\` could not be read (${reasonOf(error)}), so it is not known which beta exam is waiting for its announcement post`,
    );
    warnLoud(`could not read the beta exam tracker: ${error.message}`);
  }

  const vouchers = new Map();
  try {
    const dir = join(cfg.docsDir, "vouchers");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".mdx")) continue;
      const head = readFileSync(join(dir, name), "utf8").split("\n", 80);
      for (const line of head) {
        const match = /^linkedExam:\s*["']?([A-Za-z]{2,3}-\d{3})["']?\s*$/.exec(
          line.trim(),
        );
        if (!match) continue;
        const code = match[1].toUpperCase();
        vouchers.set(code, [
          ...(vouchers.get(code) ?? []),
          `vouchers/${name.replace(/\.mdx$/, "")}`,
        ]);
      }
    }
  } catch {
    // no voucher folder: no voucher page is mentioned
  }
  return { pages, statuses, learn, vouchers, betaWaiting, notes };
}

/** The exam codes of a post split by what the hub knows about them. */
export function classifyCodes(codes, ctx) {
  const groups = {
    withPage: [],
    learnOnly: [],
    notOnLearn: [],
    unknown: [],
    other: [],
  };
  for (const code of codes) {
    const prefix = code.split("-")[0];
    if (!Object.hasOwn(AREA_BY_PREFIX, prefix)) {
      groups.other.push({ code });
      continue;
    }
    const area = ctx.pages.get(code);
    if (area) {
      groups.withPage.push({
        code,
        area,
        status: ctx.statuses?.get(code) ?? "",
        vouchers: ctx.vouchers.get(code) ?? [],
      });
    } else if (ctx.learn === null) {
      groups.unknown.push({ code });
    } else if (ctx.learn.has(code)) {
      groups.learnOnly.push({ code });
    } else {
      groups.notOnLearn.push({ code });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
// A URL goes into a Markdown link: keep it from ending the link early.
function markdownUrl(url) {
  return url.replace(
    /[()\s<>]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Only Microsoft's own hosts are linked from the issue. */
export function trustedLink(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" &&
      (hostname === "aka.ms" ||
        hostname === "microsoft.com" ||
        hostname.endsWith(".microsoft.com"))
    );
  } catch {
    return false;
  }
}

/** The address of a post: its link, or its id when that is a URL; "" when it has none. */
const postLink = (post) => post.link || (httpUrl(post.id) ? post.id : "");

function postHeading(post, index) {
  const title = safeText(post.title) || "Untitled post";
  const link = postLink(post);
  return trustedLink(link)
    ? `### ${index}. [${title}](${markdownUrl(link)})`
    : `### ${index}. ${title}`;
}

const dateOf = (post) =>
  post.pubDate
    ? `${post.pubDate.slice(0, 10)} ${post.pubDate.slice(11, 16)} UTC`
    : "unknown";

const codeLink = (entry) => {
  const text = `\`${entry.code}\``;
  return entry.area
    ? `[${text}](${HUB_SITE}/certs/${entry.area}/${entry.code.toLowerCase()}/)`
    : text;
};

function codeLines(post, ctx, maxCodes) {
  const all = extractExamCodes([post.title, ...post.bodyBlocks].join("\n"));
  if (all.length === 0) return ["- Exam codes in the post: none"];
  const shown = all.slice(0, maxCodes);
  const groups = classifyCodes(shown, ctx);
  const lines = [
    `- Exam codes in the post (${all.length}${all.length > shown.length ? `, first ${shown.length} listed` : ""}):`,
  ];
  const list = (entries, render) => entries.map(render).join(", ");
  if (groups.withPage.length) {
    lines.push(
      `  - Hub page exists (${groups.withPage.length}): ` +
        list(groups.withPage, (e) => {
          const notes = [
            e.status ? e.status : null,
            e.vouchers.length
              ? `voucher page: ${e.vouchers.map((v) => `\`${v}\``).join(", ")}`
              : null,
          ].filter(Boolean);
          return `${codeLink(e)}${notes.length ? ` (${notes.join("; ")})` : ""}`;
        }),
    );
  }
  if (groups.learnOnly.length) {
    lines.push(
      `  - No hub page, already listed on Microsoft Learn (the New Exam Monitor tracks them) (${groups.learnOnly.length}): ` +
        list(groups.learnOnly, codeLink),
    );
  }
  if (groups.notOnLearn.length) {
    lines.push(
      `  - No hub page, not seen on Microsoft Learn yet (this post may be ahead of Learn) (${groups.notOnLearn.length}): ` +
        list(groups.notOnLearn, codeLink),
    );
  }
  if (groups.unknown.length) {
    lines.push(
      `  - No hub page, Learn status unknown (${groups.unknown.length}): ` +
        list(groups.unknown, codeLink),
    );
  }
  if (groups.other.length) {
    lines.push(
      `  - Not a hub exam family, may not be exams (${groups.other.length}): ` +
        list(groups.other, codeLink),
    );
  }
  return lines;
}

/** The "Matched the relevance filter on" line of a post (where the match was found when it was only in the article). */
function matchLine(post) {
  const details = matchedDetails(post);
  const list = (terms) => terms.map((t) => `\`${t}\``).join(", ");
  if (details.broadTerms.length > 0) {
    return (
      `- Matched the relevance filter on: ${list(details.broadTerms)}` +
      (details.articleOnly.length
        ? `; also in the article text: ${list(details.articleOnly)}`
        : "")
    );
  }
  const what = [
    ...(details.articleOnly.length ? [list(details.articleOnly)] : []),
    ...(details.code ? ["an exam code"] : []),
  ].join(" and ");
  return `- Matched on ${what} in the article text only: the title and the teaser do not mention it, so read the whole post`;
}

// ---------------------------------------------------------------------------
// The announcement a beta exam waits for
// ---------------------------------------------------------------------------
const BETA_TRACKER_DISPLAY = "src/data_files/beta-exams.json";
// The tracking parameter of every Microsoft link of the hub (AGENTS.md).
const TRACKING_PARAM = "WT.mc_id=studentamb_165290";

/**
 * The tracked beta exams a post names that wait for their announcement
 * (`ctx.betaWaiting`, see readBetaWaiting), in code order: the post is the
 * announcement their beta note is waiting for. Empty when the post names no such
 * exam, and when the tracker could not be read (the report says so).
 */
export function betaAnnouncements(post, ctx) {
  const waiting = ctx.betaWaiting;
  if (!waiting || waiting.size === 0) return [];
  return extractExamCodes([post.title, ...post.bodyBlocks].join("\n"))
    .filter((code) => waiting.has(code))
    .map((code) => waiting.get(code));
}

/**
 * What `announcement` of beta-exams.json becomes for a post: its address on one of
 * Microsoft's hosts with the hub's tracking parameter. "" when the post has no such
 * address or the note generator would refuse it.
 */
export function announcementUrl(post) {
  const link = postLink(post);
  if (!trustedLink(link)) return "";
  const base = link.replace(/#.*$/, "");
  const url = /[?&]WT\.mc_id=/i.test(base)
    ? base
    : `${base}${base.includes("?") ? "&" : "?"}${TRACKING_PARAM}`;
  try {
    return announcementState(url) === "announced" && !url.includes("`")
      ? url
      : "";
  } catch {
    return "";
  }
}

/** The entry of a post that is the announcement a beta exam waits for: what to do, step by step. */
function betaAction(post, exam, ctx) {
  const { code, state, betaStart } = exam;
  const url = announcementUrl(post);
  const area = ctx.pages?.get(code);
  // GitHub turns a bare GH-700 into a link to issue 700, so the code is a code
  // span everywhere but in the one line that is worded as the maintainers know it.
  const span = `\`${code}\``;
  const page = area
    ? `\`src/content/docs/${area}/${code}.mdx\``
    : `the exam page of ${span} (the hub has no page for it yet: create it first with \`node scripts/new-exam.mjs --code ${code} --name "<official name>" --beta --beta-start ${betaStart || "YYYY-MM-DD"}\`)`;
  const start = betaStart
    ? `\`betaStart\` stays ${betaStart} unless the post states another day the beta period began (the day the post was published is not that date unless the post says so).`
    : `\`betaStart\` is not recorded for ${span}: add the day the beta period began only if the post states it, otherwise ask for it instead of guessing (the note generator needs it).`;
  return [
    `**ACTION: this post is the announcement the beta note of ${code} is waiting for.**`,
    `\`${BETA_TRACKER_DISPLAY}\` has ${span} with \`announcement\` set to \`${state}\`. Read the post first: if it only mentions ${span} in passing, it is not the announcement and nothing changes. Otherwise:`,
    [
      `- [ ] Set \`announcement\` of ${span} in \`${BETA_TRACKER_DISPLAY}\` to the URL of this post${url ? `: \`${url}\`` : ` (its address with \`?${TRACKING_PARAM}\` added)`}. ${start}`,
      `- [ ] Regenerate the note with \`node scripts/beta-note.mjs --code ${code} --expects "<Microsoft's go-live wording from the post, if it gives one>"\` (leave \`--expects\` out when the post gives no go-live date or month) and replace the \`:::note\` that follows the beta \`:::tip\` on ${page} with its output.`,
      `- [ ] Add the beta voucher page (\`node scripts/new-beta-voucher.mjs\`, "Beta voucher format" under "Voucher Pages" in \`AGENTS.md\`, with \`voucherEnds\` and \`linkedExam: ${code}\`) and link it from the exam page.`,
      "- [ ] Re-run the tests (`pnpm test:scripts`).",
    ].join("\n"),
  ].join("\n\n");
}

function buildPostSection(post, index, ctx, level) {
  const parts = [postHeading(post, index)];
  parts.push(
    ...betaAnnouncements(post, ctx).map((exam) => betaAction(post, exam, ctx)),
  );
  const facts = [
    `- Published: ${dateOf(post)}`,
    matchLine(post),
    ...codeLines(post, ctx, level.codes),
  ];
  parts.push(facts.join("\n"));

  const excerpt = level.excerpt
    ? excerptOf(post.bodyBlocks.join(" ") || post.summary, level.excerpt)
    : "";
  if (excerpt) parts.push(`> ${safeText(excerpt)}`);

  const dates = level.dates
    ? datedStatements(post.bodyBlocks, { max: level.dates })
    : [];
  if (dates.length) {
    parts.push(
      "Dates the post states (verbatim sentences from the post, not verified; " +
        "a date here is not a beta start date until you have read the post):\n\n" +
        "```text\n" +
        dates.map((d) => `- ${d.replace(/`{3,}/g, "'''")}`).join("\n") +
        "\n```",
    );
  }
  return parts.join("\n\n");
}

/** The terms found across the new posts decide which checklist items appear. */
function checklist(posts, ctx) {
  const terms = new Set(posts.flatMap((post) => matchedTerms(post)));
  const hasCodes = posts.some(
    (post) =>
      extractExamCodes([post.title, ...post.bodyBlocks].join("\n")).length > 0,
  );
  const items = [
    'Open each post and read it in full. Nothing in this issue is verified: confirm every exam name, code, date and URL on Microsoft Learn before it goes into the hub (never invent names, dates, URLs or IDs; "Content Rules" in `AGENTS.md`).',
  ];
  if (terms.has("exam") || terms.has("certif") || hasCodes) {
    items.push(
      "New or renamed exam or certification: if the hub has no page for an exam, verify its official name and create the page with " +
        '`node scripts/new-exam.mjs --code <CODE> --name "<official name>"` ("Working the list" under "New Exam Monitor" in `docs/monitors/new-exam-monitor.md`); ' +
        "for a beta exam add `--beta --beta-start YYYY-MM-DD`, with the day the beta period began taken from the official announcement or the maintainers, never from this issue. " +
        "For an exam the hub already covers, check its exam page title, description and resources against the post. " +
        "The New Exam Monitor reports an exam once Microsoft Learn lists it, so this post can be weeks ahead of that issue.",
    );
  }
  if (
    terms.has("beta") ||
    posts.some((post) => betaAnnouncements(post, ctx).length > 0)
  ) {
    items.push(
      'Beta exam: `src/data_files/beta-exams.json` holds, for each beta exam, the day the beta period began (`betaStart`) and the state of its announcement (`announcement`: `pending`, `unannounced` or the URL of the Skills Hub post; "Beta Exam Pages" in `AGENTS.md`). ' +
        "A post that announces the beta of an exam that is still `pending` or `unannounced` is the announcement its `:::note` is waiting for (the post then starts with an ACTION line and the steps); while an exam is `pending` no announcement exists yet, so a post that does not announce it changes nothing. " +
        "The beta start date comes from the post only when the post states it: the date the beta period began or the first day the exam could be scheduled; the day the post was published is not that date unless the post says so. " +
        "If the post gives no start date, keep the `betaStart` of the tracker, and if the tracker has none either, ask for it instead of publishing a date. " +
        'If the post also gives an expected go-live date or month, the note states it exactly as Microsoft wrote it, linked to the post, next to the calculated 10-12 week window and not instead of it (`--expects`, "Beta Exam Pages" in `AGENTS.md`); never make it more precise than the post. ' +
        'For an exam the hub does not track yet, add `{ text: "BETA", variant: "tip" }` to `src/data_files/exam-status.mjs` and an entry with `betaStart` and `announcement` to `src/data_files/beta-exams.json` ("Adding a new exam to either tracker" in `docs/monitors/beta-and-retiring-exams.md`).',
    );
  }
  if (terms.has("voucher") || terms.has("discount")) {
    items.push(
      'Voucher or discount: add or update the voucher page ("Voucher Pages" in `AGENTS.md`; the beta voucher format when it is a beta discount). ' +
        'Verify the percentage, code, candidate limit, deadline and country exclusions on the official source, set `voucherEnds` to the last day the post states and `linkedExam` to the exam code, and link the post from the "Read Official Announcement" button.',
    );
  }
  if (terms.has("retir")) {
    items.push(
      'Retirement or transition: follow the retirement rules in `docs/monitors/beta-and-retiring-exams.md` (a `:::caution` banner with the verified replacement, the `RETIRING` badge in `src/data_files/exam-status.mjs`, an entry in `src/data_files/retiring-exams.json`; "At Risk Exam Treatment" in `AGENTS.md` when nothing is confirmed). Use dates from the official source only.',
    );
  }
  if (terms.has("renew")) {
    items.push(
      "Renewal or credential program change: check the certification program pages under `src/content/docs/guide/` against the post and edit them only after verifying the change on Microsoft Learn.",
    );
  }
  items.push(
    "A post that is not about an exam, certification or voucher the hub covers needs no edit. Nothing needs to be dismissed: every post is recorded in `src/data_files/skills-hub-posts.json` and is not reported again.",
  );
  return (
    "### What to do\n\n" +
    items.map((item) => `- [ ] ${item}`).join("\n") +
    '\n\nSee the "Skills Hub Watch" runbook (`docs/monitors/skills-hub-watch.md`) for the full process.' +
    (ctx.notes.length
      ? "\n\nContext that could not be read for this report: " +
        ctx.notes.join("; ") +
        "."
      : "")
  );
}

/** "Skills Hub post: <title>" / "Skills Hub posts (3): a; b +1 more" (at most 200 characters). */
export function buildIssueTitle(posts) {
  // A title is shown as text, but a link of a post never goes into it.
  const names = posts.map(
    (post) => plain(post.title.replace(/https?:\/\/\S+/gi, "(link)")) || "post",
  );
  if (names.length === 1) {
    return clip(`Skills Hub post: ${names[0]}`, ISSUE_TITLE_MAX_CHARS);
  }
  const head = `Skills Hub posts (${names.length}): `;
  for (let shown = names.length; shown >= 1; shown--) {
    const rest = names.length - shown;
    const title =
      head + names.slice(0, shown).join("; ") + (rest ? ` +${rest} more` : "");
    if (title.length <= ISSUE_TITLE_MAX_CHARS) return title;
  }
  return clip(head + names[0], ISSUE_TITLE_MAX_CHARS);
}

function buildReportBody(posts, ctx, level, shortened) {
  const many = posts.length === 1 ? "post" : "posts";
  return [
    `## Skills Hub: ${posts.length} new ${many} to review`,
    `The Microsoft Skills Hub blog published ${posts.length} new ${many} that matched the relevance filter since the last check. ` +
      "Microsoft announces new, renamed and retiring exams and certifications, beta windows and vouchers there, often weeks before the Microsoft Learn pages change. " +
      "Text quoted below comes from the post and is escaped; open the post for the original. " +
      (shortened
        ? "The details are shortened to keep this issue under GitHub's size limit. "
        : "") +
      `Feed: ${markdownUrl(FEED_URL)}`,
    ...posts.map((post, index) =>
      buildPostSection(post, index + 1, ctx, level),
    ),
    checklist(posts, ctx),
  ].join("\n\n");
}

/**
 * The issue body for the new relevant posts. Text of a post is only ever
 * escaped inline text or inside a code fence. The details shrink in steps until
 * the body fits into one issue.
 */
export function buildReport(posts, ctx) {
  for (let step = 0; step < REPORT_LEVELS.length; step++) {
    const report =
      buildReportBody(posts, ctx, REPORT_LEVELS[step], step > 0) + "\n";
    if (report.length <= REPORT_MAX_CHARS) return report;
  }
  const last = buildReportBody(posts, ctx, REPORT_LEVELS.at(-1), true);
  return (
    last.slice(0, REPORT_MAX_CHARS - 200) +
    "\n\n(The report was cut to fit into one issue.)\n"
  );
}

const PROBLEM_ADVICE =
  "### What to do\n\n" +
  "1. Open the feed in a browser and check it still shows the newest posts of the blog: " +
  `${markdownUrl(FEED_URL)}\n` +
  "2. Compare it with the RSS link of the blog page itself (https://aka.ms/MTC/RSS-Board-Footer?board.id=skills-hub-blog, which redirects to the feed). " +
  'If Microsoft moved the feed, update `FEED_URL` in `scripts/skills-hub-watch.mjs` (and the "Skills Hub Watch" runbook, `docs/monitors/skills-hub-watch.md`); never guess a feed URL.\n' +
  "3. Until it is fixed no post is reported. Nothing is lost for good: the next good read reports every relevant post published meanwhile, as long as the feed still holds it (the feed holds the 20 newest posts).\n" +
  "4. This issue is raised again every week while the problem lasts. Nothing needs to be dismissed once it is fixed: the next good run clears the counter in `src/data_files/skills-hub-posts.json`.\n\n" +
  'See the "Skills Hub Watch" runbook (`docs/monitors/skills-hub-watch.md`) for the full process.';

const PROBLEM_TITLES = {
  feed: "the feed answered, but it is not a usable RSS or Atom feed",
  gone: "the feed address answers that the page does not exist",
  fetch: "the feed could not be fetched",
};

/** The text of the `bug` issue for an established feed problem. */
export function buildProblemReport(problem, reason, cfg) {
  return (
    "## The Skills Hub blog feed cannot be read\n\n" +
    `The monitor has had no usable feed for ${problem.runs} consecutive run${problem.runs === 1 ? "" : "s"} (since ${problem.since}): ${PROBLEM_TITLES[problem.kind]}.\n\n` +
    `Last answer: ${safeText(reason) || "unknown"}\n\n` +
    `Feed: ${markdownUrl(cfg.feedUrl)}\n\n` +
    PROBLEM_ADVICE +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Job summary
// ---------------------------------------------------------------------------
function summaryTable(rows) {
  return (
    "| Item | Value |\n|------|-------|\n" +
    rows.map(([name, value]) => `| ${name} | ${value} |`).join("\n") +
    "\n"
  );
}

function latestRelevantTable(posts) {
  const latest = sortPosts(posts.filter((post) => post.matched)).slice(
    0,
    BASELINE_SHOWN,
  );
  if (latest.length === 0) return "No relevant post in the feed.\n";
  return (
    `The ${latest.length} newest relevant post${latest.length === 1 ? "" : "s"} in the feed (the baseline swallows them, read them once):\n\n` +
    "| Published | Post | Exam codes |\n|-----------|------|------------|\n" +
    latest
      .map((post) => {
        const codes = extractExamCodes(
          [post.title, ...post.bodyBlocks].join("\n"),
        );
        return `| ${post.pubDate ? post.pubDate.slice(0, 10) : "—"} | ${cell(post.title)} | ${codes.length ? codes.slice(0, 8).join(", ") + (codes.length > 8 ? ", …" : "") : "—"} |`;
      })
      .join("\n") +
    "\n"
  );
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
    writeFileSync(cfg.errorFile, `## Skills Hub Watch failed\n\n${message}\n`);
  } catch {
    /* the error is already on stderr */
  }
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
    feed_problem: false,
    feed_read: false,
    issue_title: "",
    posts_new: 0,
    posts_relevant: 0,
  });
  process.exit(1);
}

/** A run without a usable feed: count it, warn, raise the issue when it is due. */
function handleProblem(cfg, tracker, problem) {
  const result = applyProblem(tracker, problem, cfg);
  const record = result.tracker.problem;
  const message =
    `no usable feed (${problem.reason}); run ${record.runs} without one since ${record.since}` +
    (result.established
      ? ""
      : ". A single bad read is not evidence, so nothing is reported yet");
  warnLoud(message + ". Kept the previous posts.");

  const dirty = trackerContent(result.tracker) !== trackerContent(tracker);
  if (dirty) writeFileSync(cfg.trackerFile, trackerContent(result.tracker));
  if (result.alert) {
    writeFileSync(
      cfg.errorFile,
      buildProblemReport(record, problem.reason, cfg),
    );
  }
  appendStepSummary(
    cfg.stepSummary,
    "### Skills Hub Watch\n\n" +
      summaryTable([
        ["Feed", codeSpan(cfg.feedUrl)],
        ["Result", "NO USABLE FEED, previous posts kept"],
        ["Reason", cell(problem.reason)],
        [
          "Runs without a usable feed",
          `${record.runs}${result.established ? " (alert raised or due)" : ""}`,
        ],
        ["Since", record.since],
      ]),
  );
  // Nothing was read, so this run is no evidence of health either: feed_read stays
  // false and the workflow leaves an open failure issue alone.
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: dirty,
    extraction_failed: result.alert,
    feed_problem: result.established,
    feed_read: false,
    issue_title: "",
    posts_new: 0,
    posts_relevant: 0,
  });
  return {
    problem: record,
    alert: result.alert,
    established: result.established,
  };
}

export async function main(cfg) {
  console.log("=== Skills Hub Watch ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const tracker = loadTracker(cfg);

  const fetched = await fetchFeed(cfg);
  if (!fetched.ok) {
    return handleProblem(cfg, tracker, fetched);
  }
  if (fetched.text.length > cfg.maxFeedBytes) {
    return handleProblem(cfg, tracker, {
      kind: "feed",
      definite: true,
      reason: `the response is larger than ${cfg.maxFeedBytes} bytes`,
    });
  }
  const parsed = parseFeed(fetched.text);
  if (!parsed.ok) {
    return handleProblem(cfg, tracker, {
      kind: "feed",
      definite: true,
      reason: parsed.reason,
    });
  }
  const { posts, skipped } = feedPosts(parsed);
  if (posts.length < cfg.minFeedItems) {
    return handleProblem(cfg, tracker, {
      kind: "feed",
      definite: true,
      reason: `only ${posts.length} usable item${posts.length === 1 ? "" : "s"} in the feed (expected at least ${cfg.minFeedItems}; ${parsed.items.length} read, ${skipped} without a title or id)`,
    });
  }

  const result = applyFeed(tracker, posts, cfg);
  const next = result.tracker;
  const dirty = trackerContent(next) !== trackerContent(tracker);

  if (tracker.problem) {
    console.log(
      `The feed is readable again after ${tracker.problem.runs} run(s) without one (since ${tracker.problem.since}).`,
    );
  }
  if (skipped > 0) {
    warnLoud(`${skipped} feed item(s) had no title or id and were skipped.`);
  }
  if (dirty) writeFileSync(cfg.trackerFile, trackerContent(next));

  let issueTitle = "";
  if (result.relevant.length > 0) {
    const ctx = await loadHubContext(cfg);
    // Newest first, like the blog.
    const ordered = sortPosts(result.relevant);
    writeFileSync(cfg.reportFile, buildReport(ordered, ctx));
    issueTitle = buildIssueTitle(ordered);
    console.log(`${result.relevant.length} new relevant post(s):`);
    for (const post of ordered) console.log(`  - ${post.title}`);
  } else if (result.baseline) {
    console.log(
      `Recorded ${result.news.length} post(s) as the baseline; nothing to report.`,
    );
  } else if (result.news.length > 0) {
    console.log(
      `${result.news.length} new post(s), none relevant; recorded without a report.`,
    );
  } else if (result.older.length === 0) {
    console.log("No new posts.");
  }
  if (result.older.length > 0) {
    console.log(
      `${result.older.length} post(s) more than ${cfg.oldPostDays} days older than the newest known post (a stale snapshot of the feed): not recorded, never reported.`,
    );
  }

  const newest = sortPosts(posts)[0];
  appendStepSummary(
    cfg.stepSummary,
    "### Skills Hub Watch\n\n" +
      summaryTable([
        ["Feed", codeSpan(cfg.feedUrl)],
        ["Items read", `${parsed.items.length} (${posts.length} usable)`],
        ["New posts", result.news.length],
        ...(result.older.length
          ? [["Old posts ignored (stale feed snapshot)", result.older.length]]
          : []),
        ["New relevant posts", result.relevant.length],
        ["Newest post", newest?.pubDate ? newest.pubDate.slice(0, 10) : "—"],
        ["Posts in the tracker", next.posts.length],
        [
          "Result",
          result.baseline
            ? "BASELINE recorded silently"
            : result.relevant.length
              ? "issue raised"
              : "nothing to report",
        ],
      ]) +
      (result.baseline ? "\n" + latestRelevantTable(posts) : ""),
  );

  // A usable feed was read and nothing failed: the only run that is healthy.
  writeOutput(cfg.githubOutput, {
    changes_found: result.relevant.length > 0,
    baseline_updated: dirty,
    extraction_failed: false,
    feed_problem: false,
    feed_read: true,
    issue_title: issueTitle,
    posts_new: result.news.length,
    posts_relevant: result.relevant.length,
  });
  return {
    baseline: result.baseline,
    news: result.news,
    older: result.older,
    relevant: result.relevant,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
