#!/usr/bin/env node
/**
 * Daily change watch for the Microsoft program/policy pages and the third-party
 * programme pages that the guide, prepare and voucher pages of the hub are
 * written from (retake and reschedule policies, renewal, accommodations,
 * student discounts, beta exam rules, the Virtual Training Days FAQ, the
 * Partner Certification Week event pages, ...). Those facts are typed by hand,
 * so a change on one of the sources means a maintainer has to re-read it.
 *
 * Usage:
 *   node scripts/source-watch.mjs
 *
 * The watch list is src/data_files/watched-sources.json (explicit, one entry per
 * source: url, kind html|pdf, label, optional note / aliases / alsoFeeds /
 * root / skipSections). The state is src/data_files/source-watch.json.
 *
 * What it compares:
 *  - kind "html": the article text of the page, normalized to one text line per
 *    block (headings keep their level "### Title", list items start with "- ",
 *    table rows join their cells with " | "; entities, whitespace, hard line
 *    wraps, soft hyphens, ids, classes and link targets never change a line).
 *    On a Learn host (LEARN_HOSTS) the article is the `<div class="content">`
 *    blocks inside `<main>`; on other sites it is the whole `<main>` (root "main") or, for a site that
 *    has no `<main>`, the `<body>` (root "body"), with navigation, header,
 *    footer, aside and buttons removed. An entry may name `skipSections`
 *    (heading texts): each such section, up to the next heading of the same or a
 *    higher level, is not tracked (for a page with a volatile product
 *    catalogue in the middle); a heading that is gone makes the page "not an
 *    article" instead of silently tracking the catalogue. The SHA-256 of the
 *    lines is the decision: the same hash is never an alert. The lines are
 *    stored only to show WHAT changed (a compact line diff in the issue); they
 *    never decide.
 *  - kind "pdf": the validators the server sends for the file (ETag,
 *    Last-Modified, Content-Length, through HEAD, or GET when HEAD does not
 *    answer) and the URL the link resolves to (an aka.ms alias that now points to
 *    another file is a change). The text of the PDF is NOT compared and the issue
 *    never claims it was: it says "the file was replaced, open it".
 *  - The Learn credentials sitemap (lastmod per URL) is only a hint shown in the
 *    issue and the job summary; it lags the pages and never decides.
 *
 * For every watched URL the hub pages that cite it are found at run time by
 * scanning src/content (the URL, an alias, or the pages named in `alsoFeeds` for a
 * source a page restates without linking), so the issue can say "update
 * src/content/docs/guide/certificationrenewal.mdx:35".
 *
 * Alert rules:
 *  - A source without stored text/validators (new on the list, a tracker written
 *    with another LINES_FORMAT, lines that no longer hash to the stored hash) is
 *    baselined silently. The first run (no tracker) baselines everything.
 *  - A fetch failure is never evidence of a change. A source that cannot be
 *    fetched, or that answers but is not an article any more (no <main>, too
 *    little or too much text, redirected to another host, a PDF that is not a
 *    PDF), keeps its record and warns. Three consecutive runs (UTC days) in which
 *    the same source fails raise ONE running bug issue (ATTENTION_ISSUE_TITLE);
 *    when no source is readable at all the run fails (FAILED_ISSUE_TITLE).
 *  - Failsafe: a run that has spent RUN_DEADLINE_MS (10 minutes, counted from its
 *    first request) stops requesting (a host that hangs costs about 100 seconds,
 *    and the workflow is killed at 15 minutes without writing anything or
 *    opening an issue). The sources not yet requested keep their record and count
 *    as a failed read for the day, so a slowness that lasts raises the same
 *    running attention issue.
 *  - Failsafe: more than MAX_CHANGED (8) sources whose text changed in one run is
 *    probably a template change on the site, not that many edits. Nothing is
 *    recorded for them, the running attention issue says so with the counts (no
 *    per-source diffs), and the same hold repeats until the new text is accepted
 *    with FORCE_BASELINE=1 (workflow input force_baseline) or the parser is fixed.
 *  - A watched URL that no hub page cites any more is reported in the same
 *    attention issue (a voucher page was deleted: drop the entry).
 *  - The state is only rewritten when something in it changed (a page changed or
 *    was baselined, a failure streak moved, the list changed), so a quiet
 *    Microsoft never produces a commit.
 *  - The change issue is opened by the workflow BEFORE the state is committed; the
 *    attention and failure issues are handled in this script (gh CLI) BEFORE
 *    anything is written, so a failed issue step fails the run, skips the commit
 *    and the next run reports the same things again.
 *
 * Env overrides (defaults shown):
 *   WATCH_FILE          src/data_files/watched-sources.json
 *   TRACKER_FILE        src/data_files/source-watch.json
 *   CONTENT_DIR         src/content        (scanned for citations)
 *   REPORT_FILE         <tmpdir>/source-watch-report.md
 *   ATTENTION_FILE      <tmpdir>/source-watch-attention.md
 *   ERROR_FILE          <tmpdir>/source-watch-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (unset: no job summary)
 *   FETCH_DELAY_MS      1000   pause between two requests
 *   FETCH_ATTEMPTS      3
 *   RETRY_BASE_MS       5000
 *   MAX_RETRY_AFTER_MS  60000
 *   FETCH_TIMEOUT_MS    30000
 *   RUN_DEADLINE_MS     600000 after this long from the first request no further
 *                       source is requested
 *   MIN_CONTENT_LINES   5     fewer text lines is "not an article"
 *   MAX_LINES           800    more text lines is "not tracked precisely" (size cap)
 *   MAX_CHANGED         8      more changed sources in one run is held back
 *   FAILURE_RUNS        3      consecutive failing runs that raise the issue
 *   FORCE_BASELINE      1 accepts every changed source silently (no issue)
 *   SITEMAP_HINT        1      0 = do not read the Learn sitemap
 *   SITEMAP_INDEX_URL   https://learn.microsoft.com/_sitemaps/sitemapindex.xml
 *   LEARN_HOSTS         learn.microsoft.com   (the Learn hosts: the article of a page there is its
 *                       content blocks, and the sitemap hint applies to them)
 *   TODAY               YYYY-MM-DD, for tests
 *   CREATE_ISSUES       0   1 = create, comment on and close the running issues with the gh CLI
 *   DRY_RUN             0   1 = touch no issue (the report and the state are still written locally)
 *   GH_TOKEN / GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID   used for the gh CLI and run links
 *   GH_CLI_SCRIPT       (unset)  tests only: run this Node script instead of the gh CLI
 *   GITHUB_ACTIONS      true on a runner: warnings then also become workflow annotations
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * issue_title, sources_changed, attention, mass_change.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { closeOpenIssues, raiseIssue } from "./failure-issue.mjs";
import {
  appendStepSummary,
  warnLoud as warn,
  writeOutput,
} from "./lib/actions.mjs";
import { makeGh } from "./lib/gh.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Bump when htmlToLines / parseHtmlSource change what a page turns into: a state
// written with another format re-baselines silently instead of showing the
// change of the normalization as a change of the pages.
export const LINES_FORMAT = 1;

/** Running issue for what needs a human decision about the watch list itself. */
export const ATTENTION_ISSUE_TITLE = "Source Watch: sources need attention";
export const ATTENTION_ISSUE_LABEL = "bug";
/** Raised when the check itself cannot run. */
export const FAILED_ISSUE_TITLE = "Source Watch: the check failed";
export const FAILED_ISSUE_LABEL = "bug";

const REPORT_MAX_CHARS = 60000;
const DIFF_LINE_MAX_CHARS = 300;
// Changed lines shown per source and in total, tried in turn until the report
// fits into one GitHub issue (65,536 characters at most).
const DIFF_LIMITS = [
  { perPage: 40, total: 200 },
  { perPage: 20, total: 80 },
  { perPage: 8, total: 30 },
  { perPage: 0, total: 0 },
];
const ISSUE_TITLE_MAX_CHARS = 200;
const WATCH_FILE_DISPLAY = "src/data_files/watched-sources.json";
const TRACKER_FILE_DISPLAY = "src/data_files/source-watch.json";
const CONTENT_DISPLAY_ROOT = "src/content";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class ExtractionError extends Error {}

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

export function loadConfig(env = process.env) {
  const num = (key, fallback, { min = -Infinity } = {}) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min ? value : fallback;
  };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    watchFile: resolveFromRoot(env.WATCH_FILE ?? WATCH_FILE_DISPLAY),
    trackerFile: resolveFromRoot(env.TRACKER_FILE ?? TRACKER_FILE_DISPLAY),
    contentDir: resolveFromRoot(env.CONTENT_DIR ?? "src/content"),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "source-watch-report.md"),
    attentionFile:
      env.ATTENTION_FILE ?? join(tmpdir(), "source-watch-attention.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "source-watch-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    fetchDelayMs: num("FETCH_DELAY_MS", 1000, { min: 0 }),
    fetchAttempts: num("FETCH_ATTEMPTS", 3, { min: 1 }),
    retryBaseMs: num("RETRY_BASE_MS", 5000, { min: 0 }),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000, { min: 0 }),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000, { min: 1 }),
    runDeadlineMs: num("RUN_DEADLINE_MS", 600000, { min: 1 }),
    minContentLines: num("MIN_CONTENT_LINES", 5, { min: 1 }),
    maxLines: num("MAX_LINES", 800, { min: 1 }),
    maxChanged: num("MAX_CHANGED", 8, { min: 0 }),
    failureRuns: Math.max(1, Math.floor(num("FAILURE_RUNS", 3, { min: 1 }))),
    forceBaseline: env.FORCE_BASELINE === "1",
    sitemapHint: env.SITEMAP_HINT !== "0",
    sitemapIndexUrl:
      env.SITEMAP_INDEX_URL ??
      "https://learn.microsoft.com/_sitemaps/sitemapindex.xml",
    learnHosts: (env.LEARN_HOSTS || "learn.microsoft.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    today,
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : "",
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
const warnLoud = (message) => warn(message, { title: "Source Watch" });

// The text helpers below (entities, htmlToLines, the line diff and its
// rendering) are kept in step with
// scripts/partner-designations-check.mjs on purpose by copying and NOT
// importing: a tweak of one monitor's normalization must never look like a
// change of the pages in the other, and each tracker versions its own format.
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
  // Invisible or space-like characters, written as code points on purpose (they
  // cannot be told apart in a source file). htmlToLines drops or collapses them.
  shy: String.fromCharCode(0xad),
  zwnj: String.fromCharCode(0x200c),
  zwj: String.fromCharCode(0x200d),
  ensp: String.fromCharCode(0x2002),
  emsp: String.fromCharCode(0x2003),
  thinsp: String.fromCharCode(0x2009),
  hairsp: String.fromCharCode(0x200a),
  lrm: String.fromCharCode(0x200e),
  rlm: String.fromCharCode(0x200f),
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

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// HTML -> normalized text lines
// ---------------------------------------------------------------------------
const BLOCK_TAGS = [
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "blockquote",
  "section",
  "article",
  "aside",
  "details",
  "summary",
  "pre",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "nav",
  "header",
  "footer",
  "form",
  "fieldset",
  "main",
  "address",
];
const BLOCK_TAG_RE = new RegExp(
  `</?(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`,
  "gi",
);
// No-break and thin spaces count as spaces; soft hyphens, zero-width characters
// and the byte order mark are dropped. Built from code points on purpose: the
// characters are invisible in a source file.
const SPACE_LIKE_RE = new RegExp(
  `[${String.fromCharCode(0xa0, 0x2007, 0x202f)}]`,
  "g",
);
const INVISIBLE_RE = new RegExp(
  `[${String.fromCharCode(0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff)}]`,
  "g",
);

const MAX_TAG_CHARS = 50000;

/**
 * "<" and ">" inside a quoted attribute value (a data-* attribute that carries
 * HTML) would end the tag early and leak the rest of the attribute into the
 * text; they are escaped so that the tag patterns below see the whole tag. A
 * quote only opens a value right after "=", and a tag that never closes is left
 * alone.
 */
export function escapeBracketsInAttributes(html) {
  const src = String(html);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);
    if (!/[a-zA-Z/]/.test(src[lt + 1] ?? "")) {
      out += "<";
      i = lt + 1;
      continue;
    }
    let tag = "<";
    let quote = "";
    let previous = "";
    let end = -1;
    for (let j = lt + 1; j < src.length && j - lt < MAX_TAG_CHARS; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) {
          quote = "";
          tag += c;
          previous = c;
        } else {
          tag += c === ">" ? "&gt;" : c === "<" ? "&lt;" : c;
        }
        continue;
      }
      if ((c === '"' || c === "'") && previous === "=") {
        quote = c;
        tag += c;
        previous = c;
        continue;
      }
      tag += c;
      if (c === ">") {
        end = j;
        break;
      }
      if (!/\s/.test(c)) previous = c;
    }
    if (end < 0) {
      out += "<";
      i = lt + 1;
    } else {
      out += tag;
      i = end + 1;
    }
  }
  return out;
}

/**
 * A fragment of a page as normalized text lines: one line per block, nothing
 * but the text of the page. Empty headings and list items are dropped.
 */
export function htmlToLines(fragment) {
  const text = decodeEntities(
    escapeBracketsInAttributes(
      String(fragment)
        // Source line breaks are only how a site wraps its Markdown: they are
        // whitespace, never a block boundary (those are added below).
        .replace(/\s*[\r\n]+\s*/g, " ")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(
          /<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi,
          "",
        ),
    )
      .replace(
        /<h([1-6])\b[^>]*>/gi,
        (_, level) => `\n${"#".repeat(Number(level))} `,
      )
      .replace(/<\/h[1-6]\s*>/gi, "\n")
      .replace(/<li\b[^>]*>(?:\s*<(?:p|div)\b[^>]*>)?/gi, "\n- ")
      .replace(/<\/t[dh]\s*>/gi, " | ")
      .replace(/<tr\b[^>]*>/gi, "\n")
      .replace(/<\/tr\s*>/gi, "\n")
      .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
      .replace(BLOCK_TAG_RE, "\n")
      .replace(/<[^>]*>/g, ""),
  );

  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .normalize("NFC")
      .replace(SPACE_LIKE_RE, " ")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*\|$/, "");
    if (!line || line === "-" || /^#{1,6}$/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

const CONTENT_BLOCK_OPEN_RE =
  /<div\b[^>]*\bclass\s*=\s*["'](?:[^"']*\s)?content(?:\s[^"']*)?["'][^>]*>/gi;

/** Index of the </div> that closes the block a position is in (or the end). */
function contentEnd(html, from) {
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 0;
  for (let tag; (tag = tags.exec(html));) {
    if (!tag[1]) {
      depth++;
    } else if (depth === 0) {
      return tag.index;
    } else {
      depth--;
    }
  }
  return html.length;
}

/** The inner HTML of the outermost `<div class="content">` blocks of a source. */
function contentBlocks(source) {
  const blocks = [];
  let reached = 0;
  CONTENT_BLOCK_OPEN_RE.lastIndex = 0;
  for (let open; (open = CONTENT_BLOCK_OPEN_RE.exec(source));) {
    // A content block inside another one is part of the outer block.
    if (open.index < reached) continue;
    const start = open.index + open[0].length;
    const end = contentEnd(source, start);
    blocks.push(source.slice(start, end));
    reached = end;
  }
  return blocks;
}

/**
 * Removes every <name>…</name> element (nested ones of the same name included)
 * from an HTML string; an unbalanced opening tag only loses the tag itself.
 */
export function removeElements(html, names) {
  let current = String(html);
  for (const name of names) {
    // (?=[\s/>]) and not \b: <nav-menu> is another element than <nav>.
    const open = new RegExp(`<${name}(?=[\\s/>])[^>]*>`, "gi");
    const tag = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, "gi");
    let out = "";
    let position = 0;
    for (let match; (match = open.exec(current));) {
      const tagEnd = match.index + match[0].length;
      let end = tagEnd;
      if (!/\/\s*>$/.test(match[0])) {
        tag.lastIndex = tagEnd;
        let depth = 1;
        for (let t; (t = tag.exec(current));) {
          if (t[1]) {
            if (--depth === 0) {
              end = t.index + t[0].length;
              break;
            }
          } else {
            depth++;
          }
        }
      }
      out += current.slice(position, match.index);
      position = end;
      open.lastIndex = end;
    }
    current = out + current.slice(position);
  }
  return current;
}

// What is page chrome, not article text, on a site whose article we take from
// <main> or <body> as a whole.
const CHROME_TAGS = [
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "button",
  "select",
  "iframe",
];

function metaContent(html, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    if (attrs.name?.toLowerCase() === name)
      return decodeEntities(attrs.content ?? "");
  }
  return "";
}

/**
 * A page as { ok, lines, updatedAt } or { ok: false, reason }.
 *  - root "main" (default): the page needs a <main>. On a Learn host (`learn`:
 *    the caller knows the host, see isLearnHost) whose <main> holds Learn's
 *    `<div class="content">` blocks those are the article (and a title, the h1,
 *    is required); any other page, or Learn content blocks without a title, is
 *    the whole <main> without its chrome. A `div.content` wrapper on another
 *    site is just a div: the rest of its <main> is tracked too.
 *  - root "body": for a site without <main>: the <body> without its chrome.
 * A page with hardly any text, or with more than `maxLines`, is not tracked (a
 * bot-check or error page, a changed layout, a page too long to store).
 */
export function parseHtmlSource(
  html,
  {
    root: rootKind = "main",
    learn = false,
    minLines = 5,
    maxLines = Infinity,
    skipSections = [],
  } = {},
) {
  const source = String(html ?? "");
  let lines;
  if (rootKind === "body") {
    const open = source.match(/<body\b[^>]*>/i);
    if (!open) return { ok: false, reason: "no <body> element" };
    const start = open.index + open[0].length;
    const end = source.toLowerCase().lastIndexOf("</body>");
    lines = htmlToLines(
      removeElements(
        source.slice(start, end > start ? end : source.length),
        CHROME_TAGS,
      ),
    );
  } else {
    const open = source.match(/<main\b[^>]*>/i);
    if (!open) return { ok: false, reason: "no <main> element" };
    const start = open.index + open[0].length;
    const end = source.toLowerCase().lastIndexOf("</main>");
    const main = source.slice(start, end > start ? end : source.length);
    // Learn: the article is the content blocks (they hold the title, the h1).
    // Any other site, or content blocks without a title, is the whole <main>.
    const fromBlocks = learn
      ? contentBlocks(main).flatMap((block) => htmlToLines(block))
      : [];
    lines = fromBlocks.some((line) => line.startsWith("# "))
      ? fromBlocks
      : htmlToLines(removeElements(main, CHROME_TAGS));
  }
  for (const heading of skipSections) {
    // A page with a volatile catalogue in the middle (a list of free services,
    // a product grid) is tracked without that section: from the heading to the
    // next heading of the same or a higher level. A heading that is gone is a
    // layout change, so the page is "not an article" (kept, warned about)
    // rather than silently tracked in full, catalogue included.
    const start = lines.findIndex(
      (line) =>
        /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, "") === heading,
    );
    if (start < 0) {
      return {
        ok: false,
        reason: `the section "${clip(heading, 80)}" (skipSections) is no longer on the page`,
      };
    }
    const level = lines[start].match(/^#+/)[0].length;
    let end = start + 1;
    while (end < lines.length) {
      const next = lines[end].match(/^(#{1,6}) /);
      if (next && next[1].length <= level) break;
      end++;
    }
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  if (lines.length < minLines) {
    return {
      ok: false,
      reason: `only ${lines.length} text line${lines.length === 1 ? "" : "s"} (expected at least ${minLines})`,
    };
  }
  if (lines.length > maxLines) {
    return {
      ok: false,
      reason: `${lines.length} text lines (more than the ${maxLines} this monitor stores per page; raise MAX_LINES or check the page)`,
    };
  }
  const updated = metaContent(source, "updated_at");
  return {
    ok: true,
    lines,
    // Shown in the issue; a malformed value never reaches it.
    updatedAt: /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : "",
  };
}

export function hashLines(lines) {
  return sha256(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------
/**
 * Line diff of two normalized texts: [{ t: "=" | "-" | "+", line }]. Common
 * head and tail are trimmed, the rest is a longest-common-subsequence diff
 * (pages are a few hundred lines); a pathological size falls back to "all old
 * lines removed, all new lines added" for the differing middle.
 */
export function diffLines(oldLines, newLines) {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > head &&
    newEnd > head &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const a = oldLines.slice(head, oldEnd);
  const b = newLines.slice(head, newEnd);

  const ops = oldLines.slice(0, head).map((line) => ({ t: "=", line }));
  if (a.length * b.length > 4_000_000) {
    ops.push(...a.map((line) => ({ t: "-", line })));
    ops.push(...b.map((line) => ({ t: "+", line })));
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ t: "=", line: a[i] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ t: "-", line: a[i++] });
      } else {
        ops.push({ t: "+", line: b[j++] });
      }
    }
    while (i < a.length) ops.push({ t: "-", line: a[i++] });
    while (j < b.length) ops.push({ t: "+", line: b[j++] });
  }
  ops.push(...oldLines.slice(oldEnd).map((line) => ({ t: "=", line })));
  return ops;
}

/**
 * The changed lines of two normalized texts, grouped into hunks that each carry
 * the heading path they sit under: { added, removed, entries } with entries
 * { kind: "hunk", context } and { kind: "-" | "+", line }.
 */
export function summarizeDiff(oldLines, newLines) {
  const entries = [];
  const path = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;
  const enter = (line) => {
    const heading = line.match(/^(#{1,6}) (.*)$/);
    if (!heading) return;
    const level = heading[1].length;
    path.length = level - 1;
    path[level - 1] = heading[2];
  };
  // The (up to three) nearest headings a hunk sits under; a hunk that starts
  // with a heading sits under that heading's parents only.
  const context = (first) => {
    const level = first.match(/^(#{1,6}) /)?.[1].length ?? 7;
    return path
      .slice(0, level - 1)
      .filter(Boolean)
      .slice(-3)
      .join(" > ");
  };

  for (const { t, line } of diffLines(oldLines, newLines)) {
    if (t === "=") {
      inHunk = false;
      enter(line);
      continue;
    }
    if (!inHunk) {
      entries.push({ kind: "hunk", context: context(line) });
      inHunk = true;
    }
    entries.push({ kind: t, line });
    if (t === "+") {
      added++;
      enter(line);
    } else {
      removed++;
    }
  }
  return { added, removed, entries };
}

/**
 * The diff as the lines of a fenced `diff` block: "@@ heading path @@" before a
 * hunk, then "- old" / "+ new" lines, at most `maxLines` of them. Returns the
 * text, how many changed lines it shows and how many it left out. A run of
 * three backticks in a line can never close the fence.
 */
export function renderDiff(entries, maxLines) {
  const out = [];
  let shown = 0;
  let omitted = 0;
  let hunk = null;
  for (const entry of entries) {
    if (entry.kind === "hunk") {
      hunk = entry;
      continue;
    }
    if (shown >= maxLines) {
      omitted++;
      continue;
    }
    if (hunk) {
      out.push(
        `@@ ${clip(hunk.context || "top of the page", 160).replace(/`{3,}/g, "'''")} @@`,
      );
      hunk = null;
    }
    out.push(
      `${entry.kind} ${clip(entry.line, DIFF_LINE_MAX_CHARS).replace(/`{3,}/g, "'''")}`,
    );
    shown++;
  }
  return { text: out.join("\n"), shown, omitted };
}

// ---------------------------------------------------------------------------
// URL keys (how a hub link is matched with a watched source)
// ---------------------------------------------------------------------------
// Tracking parameters never make two links different.
const TRACKING_PARAM_RE = /^(?:wt\.mc_id|utm_.*|ocid|fbclid|gclid)$/i;

/**
 * { path, full, hasQuery } of a URL: lowercase host + path without a locale
 * segment ("/en-us"), a trailing slash or a fragment, and the same plus the
 * query without tracking parameters. Null for something that is not a URL.
 */
export function urlKeys(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  const path =
    parsed.pathname
      .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/|$)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase() || "/";
  const query = [...parsed.searchParams]
    .filter(([key]) => !TRACKING_PARAM_RE.test(key))
    .map(([key, value]) => `${key}=${value}`.toLowerCase())
    .sort()
    .join("&");
  return {
    path: `${host}${path}`,
    full: query ? `${host}${path}?${query}` : `${host}${path}`,
    hasQuery: query !== "",
  };
}

// ---------------------------------------------------------------------------
// Watch list
// ---------------------------------------------------------------------------
const SOURCE_KINDS = new Set(["html", "pdf"]);
const SOURCE_ROOTS = new Set(["main", "body"]);

/** The watch list as validated sources; ExtractionError names the first problem. */
export function normalizeWatchList(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sources)) {
    throw new ExtractionError("missing sources array");
  }
  const seen = new Set();
  return parsed.sources.map((entry, index) => {
    const where = `source #${index + 1}`;
    if (!entry || typeof entry !== "object") {
      throw new ExtractionError(`${where} is not an object`);
    }
    if (typeof entry.url !== "string" || !urlKeys(entry.url)) {
      throw new ExtractionError(`${where} has no valid http(s) url`);
    }
    if (seen.has(entry.url)) {
      throw new ExtractionError(`${where} repeats the url ${entry.url}`);
    }
    seen.add(entry.url);
    if (typeof entry.label !== "string" || !collapse(entry.label)) {
      throw new ExtractionError(`${where} (${entry.url}) has no label`);
    }
    if (!SOURCE_KINDS.has(entry.kind)) {
      throw new ExtractionError(
        `${where} (${entry.url}) has kind ${JSON.stringify(entry.kind)}, expected html or pdf`,
      );
    }
    if (entry.root !== undefined && !SOURCE_ROOTS.has(entry.root)) {
      throw new ExtractionError(
        `${where} (${entry.url}) has root ${JSON.stringify(entry.root)}, expected main or body`,
      );
    }
    const list = (name, valid) => {
      if (entry[name] === undefined) return [];
      if (
        !Array.isArray(entry[name]) ||
        !entry[name].every((item) => typeof item === "string" && valid(item))
      ) {
        throw new ExtractionError(
          `${where} (${entry.url}) has a malformed ${name} list`,
        );
      }
      return entry[name];
    };
    const skipSections = list("skipSections", (item) => collapse(item) !== "");
    if (skipSections.length > 0 && entry.kind !== "html") {
      throw new ExtractionError(
        `${where} (${entry.url}) has skipSections, which only an html source can have`,
      );
    }
    return {
      url: entry.url,
      kind: entry.kind,
      label: collapse(entry.label),
      root: entry.root ?? "main",
      skipSections: skipSections.map(collapse),
      note: typeof entry.note === "string" ? collapse(entry.note) : "",
      aliases: list("aliases", (item) => urlKeys(item) !== null),
      alsoFeeds: list("alsoFeeds", (item) =>
        /^src\/content\/[\w./-]+$/.test(item),
      ),
    };
  });
}

function loadWatchList(cfg) {
  if (!existsSync(cfg.watchFile)) {
    throw new ExtractionError(
      `Watch list not found at ${relative(root, cfg.watchFile)}.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfg.watchFile, "utf8"));
  } catch {
    throw new ExtractionError(
      `Corrupt watch list at ${relative(root, cfg.watchFile)} (invalid JSON).`,
    );
  }
  try {
    const list = normalizeWatchList(parsed);
    if (list.length === 0) {
      throw new ExtractionError("the list is empty");
    }
    return list;
  } catch (error) {
    if (!(error instanceof ExtractionError)) throw error;
    throw new ExtractionError(
      `Corrupt watch list at ${relative(root, cfg.watchFile)} (${error.message}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Which hub pages cite a source
// ---------------------------------------------------------------------------
const COMMENT_RE = /\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)\]}`\\]+/g;

function walkContent(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkContent(full, out);
    } else if (/\.mdx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every URL in the Markdown/MDX pages under the content dir (commented-out
 * links do not count), as [{ file, line, keys }] with `file` written the way
 * the issue shows it (src/content/<dir>/<page>).
 */
export function scanContentUrls(contentDir) {
  const found = [];
  for (const path of walkContent(contentDir)) {
    const file = `${CONTENT_DISPLAY_ROOT}/${relative(contentDir, path)
      .split(sep)
      .join("/")}`;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // Comments keep their line breaks so that line numbers stay right.
    text = text.replace(COMMENT_RE, (comment) => comment.replace(/[^\n]/g, ""));
    for (const match of text.matchAll(URL_IN_TEXT_RE)) {
      const url = match[0].replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&");
      const keys = urlKeys(url);
      if (!keys) continue;
      found.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        keys,
      });
    }
  }
  return found;
}

/**
 * The hub pages that cite a source: [{ file, line, via }] (one entry per page,
 * its first line), by the URL, its aliases or `alsoFeeds`. A source with a
 * query string in its URL (an event page that needs it) is matched with the
 * query, any other by host and path. `via` is "link" or "restated".
 */
export function citationsOf(source, contentUrls, existingFiles = null) {
  const wanted = new Set();
  for (const url of [source.url, ...source.aliases]) {
    const keys = urlKeys(url);
    if (!keys) continue;
    wanted.add(keys.hasQuery ? `full:${keys.full}` : `path:${keys.path}`);
  }
  const byFile = new Map();
  for (const found of contentUrls) {
    if (
      !wanted.has(`path:${found.keys.path}`) &&
      !wanted.has(`full:${found.keys.full}`)
    ) {
      continue;
    }
    const previous = byFile.get(found.file);
    if (!previous || found.line < previous.line) {
      byFile.set(found.file, {
        file: found.file,
        line: found.line,
        via: "link",
      });
    }
  }
  for (const file of source.alsoFeeds) {
    if (byFile.has(file)) continue;
    if (existingFiles && !existingFiles.has(file)) continue;
    byFile.set(file, { file, line: 0, via: "restated" });
  }
  return [...byFile.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
}

/** alsoFeeds paths that do not exist (a typo, or a deleted page). */
export function missingFeeds(watch, existingFiles) {
  return watch.flatMap((source) =>
    source.alsoFeeds
      .filter((file) => !existingFiles.has(file))
      .map((file) => ({ source, file })),
  );
}

export function contentFileSet(contentDir) {
  return new Set(
    walkContent(contentDir).map(
      (path) =>
        `${CONTENT_DISPLAY_ROOT}/${relative(contentDir, path).split(sep).join("/")}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
const VALIDATOR_FIELDS = ["etag", "lastModified", "contentLength"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeValidators(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ExtractionError("malformed validators");
  }
  const out = {};
  if (typeof value.etag === "string" && value.etag) out.etag = value.etag;
  if (typeof value.lastModified === "string" && value.lastModified) {
    out.lastModified = value.lastModified;
  }
  if (Number.isInteger(value.contentLength) && value.contentLength >= 0) {
    out.contentLength = value.contentLength;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeTracker(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sources)) {
    throw new ExtractionError("missing sources array");
  }
  const seen = new Set();
  const sources = parsed.sources.map((source, index) => {
    const where = `source #${index + 1}`;
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.url !== "string" ||
      !/^https?:\/\/\S+$/.test(source.url)
    ) {
      throw new ExtractionError(`${where} has no valid url`);
    }
    if (seen.has(source.url)) {
      throw new ExtractionError(`${where} repeats the url ${source.url}`);
    }
    seen.add(source.url);
    if (
      source.contentHash !== undefined &&
      source.contentHash !== null &&
      !(
        typeof source.contentHash === "string" &&
        /^[0-9a-f]{64}$/.test(source.contentHash)
      )
    ) {
      throw new ExtractionError(`${where} has a malformed contentHash`);
    }
    if (
      source.lines !== undefined &&
      source.lines !== null &&
      !(
        Array.isArray(source.lines) &&
        source.lines.every((line) => typeof line === "string")
      )
    ) {
      throw new ExtractionError(`${where} has malformed stored lines`);
    }
    let validators;
    try {
      validators = normalizeValidators(source.validators);
    } catch (error) {
      throw new ExtractionError(`${where} has ${error.message}`);
    }
    const date = (value) =>
      typeof value === "string" && ISO_DATE_RE.test(value) ? value : undefined;
    return {
      url: source.url,
      label:
        typeof source.label === "string" && source.label
          ? source.label
          : source.url,
      kind: source.kind === "pdf" ? "pdf" : "html",
      contentHash: source.contentHash ?? null,
      lines: Array.isArray(source.lines) ? source.lines : undefined,
      resolvedUrl:
        typeof source.resolvedUrl === "string" ? source.resolvedUrl : undefined,
      validators,
      lastChanged: date(source.lastChanged),
      failures:
        Number.isInteger(source.failures) && source.failures > 0
          ? source.failures
          : undefined,
      failingSince: date(source.failingSince),
      lastFailedOn: date(source.lastFailedOn),
      lastFailure:
        typeof source.lastFailure === "string" && source.lastFailure
          ? source.lastFailure
          : undefined,
    };
  });
  let attention = null;
  if (parsed.attention !== undefined && parsed.attention !== null) {
    const a = parsed.attention;
    if (
      typeof a !== "object" ||
      typeof a.signature !== "string" ||
      !/^[0-9a-f]{16}$/.test(a.signature)
    ) {
      throw new ExtractionError("malformed attention record");
    }
    attention = {
      signature: a.signature,
      since:
        typeof a.since === "string" && ISO_DATE_RE.test(a.since)
          ? a.since
          : null,
    };
  }
  return {
    lastSynced:
      typeof parsed.lastSynced === "string" ? parsed.lastSynced : null,
    format: Number.isInteger(parsed.format) ? parsed.format : 0,
    attention,
    sources,
  };
}

function serializeSource(source) {
  return {
    url: source.url,
    label: source.label,
    kind: source.kind,
    contentHash: source.contentHash,
    ...(source.resolvedUrl ? { resolvedUrl: source.resolvedUrl } : {}),
    ...(source.validators ? { validators: source.validators } : {}),
    ...(source.lastChanged ? { lastChanged: source.lastChanged } : {}),
    ...(source.failures ? { failures: source.failures } : {}),
    ...(source.failingSince ? { failingSince: source.failingSince } : {}),
    ...(source.lastFailedOn ? { lastFailedOn: source.lastFailedOn } : {}),
    ...(source.lastFailure ? { lastFailure: source.lastFailure } : {}),
    ...(source.lines ? { lines: source.lines } : {}),
  };
}

/** The tracker file content: fixed key order, one JSON line per stored text line. */
export function trackerContent(tracker) {
  return (
    JSON.stringify(
      {
        lastSynced: tracker.lastSynced,
        format: tracker.format,
        attention: tracker.attention ?? null,
        sources: tracker.sources.map(serializeSource),
      },
      null,
      2,
    ) + "\n"
  );
}

/** What decides whether the file must be rewritten: everything but lastSynced. */
function trackerFingerprint(tracker) {
  return trackerContent({ ...tracker, lastSynced: null });
}

export const EMPTY_TRACKER = Object.freeze({
  lastSynced: null,
  format: LINES_FORMAT,
  attention: null,
  sources: [],
});

function loadTracker(cfg) {
  if (!existsSync(cfg.trackerFile)) {
    return { ...EMPTY_TRACKER, sources: [], fresh: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfg.trackerFile, "utf8"));
  } catch {
    throw new ExtractionError(
      `Corrupt tracker file at ${relative(root, cfg.trackerFile)} (invalid JSON).`,
    );
  }
  try {
    return { ...normalizeTracker(parsed), fresh: false };
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
/**
 * The stored text of a source when it can be trusted as the previous version:
 * written by the current LINES_FORMAT and hashing to the stored hash. Anything
 * else (a state of another format, a new source, an edited record) has no
 * previous text, so its next read is a silent baseline.
 */
export function storedLines(record, format) {
  if (format !== LINES_FORMAT) return null;
  if (!record || record.kind !== "html") return null;
  if (!record.contentHash || !record.lines || record.lines.length === 0) {
    return null;
  }
  return hashLines(record.lines) === record.contentHash ? record.lines : null;
}

/** An ETag without the weak marker and the compression suffix of a variant. */
export function normalizeEtag(etag) {
  if (!etag) return "";
  return String(etag)
    .trim()
    .replace(/^W\//i, "")
    .replace(/[-;](?:gzip|br|deflate)(?=")/gi, "");
}

/**
 * Compares two validator sets on the fields both have. Returns
 * { comparable, changes: [{ field, before, after }] }; with no field in common
 * the reads cannot be compared.
 */
export function compareValidators(before, after) {
  const changes = [];
  let shared = 0;
  for (const field of VALIDATOR_FIELDS) {
    const a = before?.[field];
    const b = after?.[field];
    if (a === undefined || b === undefined) continue;
    shared++;
    if (String(a) !== String(b)) changes.push({ field, before: a, after: b });
  }
  return { comparable: shared > 0, changes };
}

const stripFragment = (url) => String(url ?? "").replace(/#.*$/, "");

const clipReason = (reason) => clip(collapse(reason), 200);

/**
 * Applies the reads (one per watched source, in order: { ok: true, ... } or
 * { ok: false, kind: "fetch" | "parse", reason }) to the tracker. Returns the
 * next tracker and what happened to each source. Pure: nothing passed in is
 * modified.
 *  - html read: { ok, lines, hash, updatedAt, redirectedTo }
 *  - pdf read:  { ok, validators, resolvedUrl }
 */
export function applyResults(
  tracker,
  watch,
  reads,
  { today, force = false, maxChanged = 8, failureRuns = 3 },
) {
  const previousByUrl = new Map(tracker.sources.map((s) => [s.url, s]));
  const result = {
    changed: [],
    baselined: [],
    unchanged: [],
    failed: [],
    unparsed: [],
    held: [],
    accepted: [],
  };

  const records = watch.map((source, index) => {
    const read = reads[index];
    const previous = previousByUrl.get(source.url) ?? null;
    const base = {
      url: source.url,
      label: source.label,
      kind: source.kind,
    };

    if (!read?.ok) {
      const kind = read?.kind === "parse" ? "parse" : "fetch";
      const reason = clipReason(read?.reason ?? "not read");
      (kind === "parse" ? result.unparsed : result.failed).push({
        source,
        reason,
        // Cut off by the run deadline: one warning for all of them, not one each.
        skipped: read?.skipped === true,
      });
      // The record is kept as it was; text of another format cannot be
      // compared with a later read of this format.
      const kept =
        previous && previous.kind === source.kind
          ? previous
          : { ...base, contentHash: null };
      const formatStale = tracker.format !== LINES_FORMAT && kept.lines;
      const common = {
        ...kept,
        ...base,
        lines: formatStale ? undefined : kept.lines,
      };
      // A streak that reached the limit is frozen (nothing moves, so a source
      // that stays dead produces no commits), and a second run on the same UTC
      // day counts once.
      if ((kept.failures ?? 0) >= failureRuns || kept.lastFailedOn === today) {
        return common;
      }
      return {
        ...common,
        failures: (kept.failures ?? 0) + 1,
        failingSince: kept.failures ? (kept.failingSince ?? today) : today,
        lastFailedOn: today,
        lastFailure: reason,
      };
    }

    // A healthy read ends a failure streak.
    const clean = (record) => ({
      ...record,
      failures: undefined,
      failingSince: undefined,
      lastFailedOn: undefined,
      lastFailure: undefined,
    });

    if (source.kind === "pdf") {
      const fresh = {
        ...base,
        contentHash: null,
        resolvedUrl: read.resolvedUrl,
        validators: read.validators,
      };
      if (!previous || previous.kind !== "pdf" || !previous.validators) {
        result.baselined.push({ source, record: fresh, ...read });
        return clean({ ...fresh, lastChanged: previous?.lastChanged });
      }
      const { comparable, changes } = compareValidators(
        previous.validators,
        read.validators,
      );
      const moved =
        previous.resolvedUrl !== undefined &&
        stripFragment(previous.resolvedUrl) !== stripFragment(read.resolvedUrl);
      // Fields the server sent before and does not send now are kept; fields
      // it did not send before are added.
      const merged = { ...previous.validators, ...read.validators };
      const next = clean({
        ...previous,
        ...base,
        resolvedUrl: read.resolvedUrl,
        validators: merged,
      });
      if (!comparable && !moved) {
        result.baselined.push({ source, record: next, ...read });
        return clean({ ...next, lastChanged: previous.lastChanged });
      }
      if (changes.length === 0 && !moved) {
        result.unchanged.push({ source, record: next, ...read });
        return next;
      }
      const record = { ...next, lastChanged: today };
      result.changed.push({
        source,
        record,
        kind: "pdf",
        before: {
          resolvedUrl: previous.resolvedUrl,
          ...previous.validators,
        },
        after: { resolvedUrl: read.resolvedUrl, ...merged },
        changes,
        moved,
        previousRecord: previous,
        ...read,
      });
      return record;
    }

    // html
    const trusted = previous ? storedLines(previous, tracker.format) : null;
    const fresh = {
      ...base,
      contentHash: read.hash,
      lines: read.lines,
    };
    if (trusted === null) {
      const record = clean({ ...fresh, lastChanged: previous?.lastChanged });
      result.baselined.push({ source, record, ...read });
      return record;
    }
    if (previous.contentHash === read.hash) {
      const record = clean({ ...previous, ...base });
      result.unchanged.push({ source, record, ...read });
      return record;
    }
    const record = clean({ ...fresh, lastChanged: today });
    result.changed.push({
      source,
      record,
      kind: "html",
      diff: summarizeDiff(trusted, read.lines),
      previousRecord: previous,
      ...read,
    });
    return record;
  });

  // Failsafe: too many changed texts in one run is the site changing shape.
  let nextRecords = records;
  if (force && result.changed.length > 0) {
    result.accepted = result.changed;
    result.changed = [];
  } else if (result.changed.length > maxChanged) {
    const heldUrls = new Set(result.changed.map((entry) => entry.source.url));
    result.held = result.changed;
    result.changed = [];
    nextRecords = records.map((record) =>
      heldUrls.has(record.url)
        ? (previousByUrl.get(record.url) ?? record)
        : record,
    );
  }

  const next = {
    lastSynced: tracker.lastSynced,
    format: LINES_FORMAT,
    attention: tracker.attention ?? null,
    sources: nextRecords,
  };
  return { ...result, tracker: next };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
/** Whether a URL is on one of the Learn hosts (`learnHosts`: lower case host names). */
export function isLearnHost(url, learnHosts) {
  try {
    return learnHosts.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A request with retries for rate limits, server errors and network errors
 * only. `body: false` reads no body (HEAD, or a GET whose body is dropped).
 */
async function request(
  cfg,
  url,
  {
    method = "GET",
    accept = "text/html,application/xhtml+xml,*/*;q=0.8",
    body = true,
  } = {},
) {
  let status;
  let error;

  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    let retryAfter = null;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });

      if (response.ok) {
        let text = "";
        if (body) {
          text = await response.text();
        } else {
          await response.body?.cancel().catch(() => {});
        }
        return {
          ok: true,
          status: response.status,
          headers: response.headers,
          text,
          url: response.url || url,
        };
      }

      status = response.status;
      error = undefined;
      retryAfter = response.headers.get("retry-after");
      await response.body?.cancel().catch(() => {});
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${response.status})`,
      );
      // Only rate limits and server errors are worth another try.
      if (status !== 429 && status < 500) return { ok: false, status };
    } catch (err) {
      error = err;
      status = undefined;
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${err.message})`,
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

  return { ok: false, status, error };
}

function failureOf(response) {
  return {
    ok: false,
    kind: "fetch",
    reason: response.status
      ? `HTTP ${response.status}`
      : `network error${response.error ? ` (${response.error.message})` : ""}`,
  };
}

/** Host and path of a URL, without www., a locale segment or a trailing slash. */
function pageIdentity(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase().replace(/^www\./, ""),
      path: parsed.pathname
        .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/|$)/i, "")
        .replace(/\/+$/, "")
        .toLowerCase(),
    };
  } catch {
    return { host: "", path: "" };
  }
}

async function readHtmlSource(cfg, source) {
  const response = await request(cfg, source.url);
  if (!response.ok) return failureOf(response);

  const type = response.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) {
    return {
      ok: false,
      kind: "parse",
      reason: `not an HTML page (content type ${type.split(";")[0]})`,
    };
  }
  const wanted = pageIdentity(source.url);
  const got = pageIdentity(response.url);
  if (got.host !== wanted.host) {
    return {
      ok: false,
      kind: "parse",
      reason: `redirected to another site (${got.host || response.url})`,
    };
  }
  const parsed = parseHtmlSource(response.text, {
    root: source.root,
    learn: isLearnHost(source.url, cfg.learnHosts),
    minLines: cfg.minContentLines,
    maxLines: cfg.maxLines,
    skipSections: source.skipSections,
  });
  if (!parsed.ok) return { ok: false, kind: "parse", reason: parsed.reason };
  return {
    ok: true,
    lines: parsed.lines,
    hash: hashLines(parsed.lines),
    updatedAt: parsed.updatedAt,
    // Moved: the watched URL only works through a redirect.
    redirectedTo: got.path !== wanted.path ? response.url : undefined,
  };
}

function validatorsOf(headers) {
  const out = {};
  const etag = normalizeEtag(headers.get("etag"));
  if (etag) out.etag = etag;
  const modified = headers.get("last-modified");
  if (modified) {
    const time = Date.parse(modified);
    out.lastModified = Number.isNaN(time)
      ? collapse(modified)
      : new Date(time).toISOString();
  }
  const length = Number(headers.get("content-length"));
  if (headers.get("content-length") !== null && Number.isInteger(length)) {
    out.contentLength = length;
  }
  return Object.keys(out).length ? out : undefined;
}

async function readPdfSource(cfg, source) {
  const accept = "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5";
  // HEAD first (no download); a server that rejects HEAD or hides the
  // validators from it is asked with GET and the body is dropped.
  let response = await request(cfg, source.url, {
    method: "HEAD",
    accept,
    body: false,
  });
  let validators = response.ok ? validatorsOf(response.headers) : undefined;
  if (!response.ok || !validators) {
    await sleep(cfg.fetchDelayMs);
    response = await request(cfg, source.url, {
      method: "GET",
      accept,
      body: false,
    });
    validators = response.ok ? validatorsOf(response.headers) : undefined;
  }
  if (!response.ok) return failureOf(response);

  const type = response.headers.get("content-type") ?? "";
  if (type && /html/i.test(type)) {
    return {
      ok: false,
      kind: "parse",
      reason: `not a PDF (content type ${type.split(";")[0]}, resolved to ${response.url})`,
    };
  }
  if (!validators) {
    return {
      ok: false,
      kind: "parse",
      reason: "the server sent no ETag, Last-Modified or Content-Length",
    };
  }
  return { ok: true, validators, resolvedUrl: stripFragment(response.url) };
}

async function readSource(cfg, source) {
  return source.kind === "pdf"
    ? readPdfSource(cfg, source)
    : readHtmlSource(cfg, source);
}

/** "10 minutes", "45 seconds" or "150 ms", for a log line or a reason. */
export function durationText(ms) {
  const unit = (value, name) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (ms >= 60000) return unit(Math.round(ms / 60000), "minute");
  if (ms >= 1000) return unit(Math.round(ms / 1000), "second");
  return `${ms} ms`;
}

/**
 * Reads every source in order, one at a time, `fetchDelayMs` apart. The deadline
 * (`runDeadlineMs` since `startedAt`) is checked before each source starts: once it
 * has passed, the remaining sources are not requested and come back as a failed read
 * ({ ok: false, kind: "fetch", skipped: true }), which keeps their record and counts
 * as a failure for the day. Without this a handful of hosts that hang (each costs
 * fetchAttempts timeouts) would run into the workflow's own timeout, which kills
 * the job without writing the tracker or opening any issue. `read`, `now` and
 * `wait` are injectable for the tests.
 */
export async function readAllSources(
  cfg,
  watch,
  { startedAt, read = readSource, now = Date.now, wait = sleep } = {},
) {
  const begin = startedAt ?? now();
  const reads = [];
  for (let i = 0; i < watch.length; i++) {
    if (now() - begin > cfg.runDeadlineMs) {
      reads.push({
        ok: false,
        kind: "fetch",
        skipped: true,
        reason: `not requested: the run deadline of ${durationText(cfg.runDeadlineMs)} was reached`,
      });
      continue;
    }
    if (i > 0) await wait(cfg.fetchDelayMs);
    reads.push(await read(cfg, watch[i]));
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Sitemap hint (never a decision)
// ---------------------------------------------------------------------------
/** { loc, lastmod } of every <url> in a sitemap file. */
export function parseSitemapUrls(xml) {
  const out = [];
  for (const block of String(xml).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = block[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
    const lastmod = block[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1];
    if (loc && lastmod && /^\d{4}-\d{2}-\d{2}/.test(lastmod)) {
      out.push({ loc: decodeEntities(loc), lastmod: lastmod.slice(0, 10) });
    }
  }
  return out;
}

/** The credentials sitemap files an index lists (paths only; fetched from the index's own site). */
export function credentialsSitemapFiles(indexXml, indexUrl) {
  const files = [];
  for (const match of String(indexXml).matchAll(
    /<loc>\s*([^<\s]+)\s*<\/loc>/gi,
  )) {
    const loc = decodeEntities(match[1]);
    if (!/credentials_en-us_\d+\.xml$/i.test(loc)) continue;
    try {
      files.push(new URL(new URL(loc).pathname, indexUrl).href);
    } catch {
      /* not a URL */
    }
  }
  return files;
}

/**
 * Map of source url -> lastmod (YYYY-MM-DD) from the Learn credentials
 * sitemap, for the sources on a Learn host. Best effort: any problem returns
 * what was found (or nothing) with a warning; it never decides anything.
 */
async function fetchSitemapHints(cfg, watch) {
  const hints = new Map();
  const learnSources = watch.filter((source) =>
    isLearnHost(source.url, cfg.learnHosts),
  );
  if (learnSources.length === 0) return hints;
  try {
    await sleep(cfg.fetchDelayMs);
    const index = await request(cfg, cfg.sitemapIndexUrl, {
      accept: "application/xml,text/xml,*/*",
    });
    if (!index.ok)
      throw new Error(`sitemap index: HTTP ${index.status ?? "error"}`);
    const files = credentialsSitemapFiles(index.text, cfg.sitemapIndexUrl);
    if (files.length === 0)
      throw new Error("no credentials sitemap in the index");
    const lastmods = new Map();
    for (const file of files) {
      await sleep(cfg.fetchDelayMs);
      const response = await request(cfg, file, {
        accept: "application/xml,text/xml,*/*",
      });
      if (!response.ok)
        throw new Error(`${file}: HTTP ${response.status ?? "error"}`);
      for (const { loc, lastmod } of parseSitemapUrls(response.text)) {
        const keys = urlKeys(loc);
        if (keys) lastmods.set(keys.path, lastmod);
      }
    }
    for (const source of learnSources) {
      const keys = urlKeys(source.url);
      const lastmod = keys && lastmods.get(keys.path);
      if (lastmod) hints.set(source.url, lastmod);
    }
  } catch (error) {
    console.error(
      `WARNING: the Learn sitemap hint is unavailable (${error.message}); the issue simply has no lastmod column values.`,
    );
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
// Stops GitHub from turning "@name" into a mention or "#123" into a reference.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * A name for a heading or a table cell of a public issue: no HTML, links or code
 * spans, no @mention or #123 cross-reference, no pipe that would end a cell.
 */
export function safeText(text) {
  return collapse(
    collapse(text)
      .replace(/[<>`[\]|]/g, " ")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE),
  );
}

const cell = (text) => safeText(text) || "—";

// A URL goes into a Markdown link: keep it from ending the link early.
function markdownUrl(url) {
  return String(url).replace(
    /[()\s<>`]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

const fileRef = (ref) =>
  ref.via === "restated" || !ref.line ? ref.file : `${ref.file}:${ref.line}`;

/** The hub pages of a source for a table cell: at most three, then "+N more". */
export function citedCell(refs) {
  if (refs.length === 0) return "—";
  const shown = refs
    .slice(0, 3)
    .map((ref) => `\`${fileRef(ref)}\``)
    .join("<br>");
  return refs.length > 3 ? `${shown}<br>+${refs.length - 3} more` : shown;
}

const STEPS =
  "### What to do\n\n" +
  "1. Open each changed source and read the change in context: for a page, the diff shows the previous text from the tracker and the page has the full current text; for a PDF only the file's identity changed, so open it and compare it with the hub text by eye.\n" +
  '2. Update the hub pages the table names for that source (the lines are where the source is linked; "restated" pages quote it without a link). ' +
  "Copy numbers, dates, names and conditions only after checking them on the source; do not invent any, and never copy an exam question or dump.\n" +
  "3. A change that does not touch anything the hub says (wording, layout, a rotated date, an event page that moved on to the next week) needs no edit.\n" +
  `4. If the source moved (a "redirects to" note), update the links in the hub pages and the \`url\` of the entry in \`${WATCH_FILE_DISPLAY}\`; if a PDF now lives at a new address, the entry keeps working through its alias.\n` +
  '5. If an offer or event page is over, follow "Ended offers" under "Voucher Pages" in `AGENTS.md` and remove the entry from the watch list.\n' +
  "6. Nothing needs to be dismissed: the new text is already recorded in the tracker, and a source that changes again produces a new issue.\n\n" +
  'See the "Source Watch" runbook (`docs/monitors/source-watch.md`) for the full process.';

/** "Watched sources changed: Exam retake policy, Online exams" (at most 200 characters). */
export function buildIssueTitle(changed) {
  const names = changed.map(
    ({ source }) =>
      safeText(source.label.replace(/\s*\(.*\)\s*$/, "")) || "source",
  );
  const head = `Watched source${names.length === 1 ? "" : "s"} changed: `;
  for (let shown = names.length; shown >= 1; shown--) {
    const rest = names.length - shown;
    const title =
      head + names.slice(0, shown).join(", ") + (rest ? ` +${rest} more` : "");
    if (title.length <= ISSUE_TITLE_MAX_CHARS) return title;
  }
  return clip(head + names[0], ISSUE_TITLE_MAX_CHARS);
}

function changeSummary(entry) {
  if (entry.kind === "pdf") {
    return entry.moved && entry.changes.length === 0
      ? "points to another file"
      : "file replaced";
  }
  return `+${entry.diff.added} / -${entry.diff.removed}`;
}

function validatorLines(label, values) {
  const out = [];
  if (values.resolvedUrl) out.push(`${label} URL: ${values.resolvedUrl}`);
  if (values.etag) out.push(`${label} ETag: ${values.etag}`);
  if (values.lastModified)
    out.push(`${label} Last-Modified: ${values.lastModified}`);
  if (values.contentLength !== undefined) {
    out.push(`${label} Content-Length: ${values.contentLength}`);
  }
  return out;
}

function buildReportBody(changed, ctx, { perPage, total }, shortened) {
  const hintOf = (entry) => ctx.hints.get(entry.source.url) ?? "";
  const rows = changed.map((entry) => {
    const refs = ctx.citations.get(entry.source.url) ?? [];
    const updated = [
      entry.updatedAt,
      hintOf(entry) && `sitemap ${hintOf(entry)}`,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      `| [${cell(entry.source.label)}](${markdownUrl(entry.source.url)}) | ${citedCell(refs)} | ` +
      `${changeSummary(entry)} | ${updated || "—"} |`
    );
  });

  let remaining = total;
  const blocks = changed.map((entry) => {
    const { source } = entry;
    const refs = ctx.citations.get(source.url) ?? [];
    const parts = [`#### ${safeText(source.label) || "Source"}`];
    if (source.note) parts.push(`Note: ${safeText(source.note)}`);
    parts.push(
      refs.length
        ? "Hub pages: " +
            refs
              .slice(0, 10)
              .map(
                (ref) =>
                  `\`${fileRef(ref)}\`${ref.via === "restated" ? " (restated, not linked)" : ""}`,
              )
              .join(", ") +
            (refs.length > 10 ? `, +${refs.length - 10} more` : "")
        : "Hub pages: none found by the scan.",
    );
    if (entry.redirectedTo) {
      parts.push(
        `The watched URL now redirects to ${markdownUrl(entry.redirectedTo)}. The page moved: update the hub links and the watch list URL.`,
      );
    }
    if (entry.kind === "pdf") {
      const lines = [
        ...validatorLines("before", entry.before),
        ...validatorLines("after ", entry.after),
      ];
      parts.push(
        "The file the link resolves to changed (a PDF is not compared by text; open it to see what changed):",
        "```\n" +
          lines.map((line) => line.replace(/`{3,}/g, "'''")).join("\n") +
          "\n```",
      );
    } else if (entry.diff.added + entry.diff.removed === 0) {
      parts.push("No line differs from the stored text.");
    } else {
      const rendered = renderDiff(
        entry.diff.entries,
        Math.min(perPage, remaining),
      );
      remaining -= rendered.shown;
      parts.push(
        `Changed text (\`-\` removed, \`+\` added; ${entry.diff.added} added and ${entry.diff.removed} removed lines):`,
      );
      if (rendered.shown > 0) {
        parts.push("```diff\n" + rendered.text + "\n```");
      }
      if (rendered.omitted > 0) {
        parts.push(
          `${rendered.omitted} more changed line${rendered.omitted === 1 ? " is" : "s are"} not shown here ` +
            `(at most ${perPage} lines per source, ${total} in total, to stay under GitHub's issue size limit). ` +
            "Open the page for the rest.",
        );
      }
    }
    return parts.join("\n\n");
  });

  return [
    `## Watched source${changed.length === 1 ? "" : "s"} changed (${changed.length})`,
    `The source${changed.length === 1 ? "" : "s"} below changed since the last check. ` +
      "The hub pages in the table are written by hand from them, so they may be out of date now. " +
      "A change of formatting alone (wrapping, spaces, ids, links, page chrome) is never reported, only a change of the article text or, for a PDF, of the file. " +
      "**Updated** is the date the source itself states (Learn `updated_at`) and the date in the Learn credentials sitemap; both are hints only." +
      (shortened
        ? " The diffs are shortened to keep this issue under GitHub's size limit."
        : ""),
    "| Source | Hub pages | Changed | Updated |\n" +
      "|--------|-----------|---------|---------|\n" +
      rows.join("\n"),
    ...blocks,
    STEPS,
  ].join("\n\n");
}

/**
 * The issue body for the changed sources. Source text is only ever inside code
 * fences; names are sanitized. The diffs shrink in steps until the body fits
 * into one issue. `ctx` = { citations: Map(url -> refs), hints: Map(url -> date) }.
 */
export function buildReport(changed, ctx) {
  for (let step = 0; step < DIFF_LIMITS.length; step++) {
    const report =
      buildReportBody(changed, ctx, DIFF_LIMITS[step], step > 0) + "\n";
    if (report.length <= REPORT_MAX_CHARS) return report;
  }
  const last = buildReportBody(changed, ctx, DIFF_LIMITS.at(-1), true);
  return (
    last.slice(0, REPORT_MAX_CHARS - 200) +
    "\n\n(The report was cut to fit into one issue.)\n"
  );
}

// ---------------------------------------------------------------------------
// The running attention issue
// ---------------------------------------------------------------------------
/**
 * What needs a human decision about the watch list itself, from this run:
 *  - failing: sources that failed `failureRuns` runs in a row;
 *  - held: sources whose text changed in a run with too many changes;
 *  - uncited: sources no hub page cites any more (and `alsoFeeds` paths that
 *    do not exist).
 * Returns { active, signature, failing, held, uncited, missing }.
 */
export function attentionState({
  records,
  watch,
  held,
  citations,
  missing,
  failureRuns,
}) {
  const watched = new Map(watch.map((source) => [source.url, source]));
  const failing = records
    .filter(
      (record) =>
        (record.failures ?? 0) >= failureRuns && watched.has(record.url),
    )
    .map((record) => ({
      source: watched.get(record.url),
      since: record.failingSince ?? null,
      reason: record.lastFailure ?? "",
    }));
  const uncited = watch.filter(
    (source) => (citations.get(source.url) ?? []).length === 0,
  );
  const heldList = held.map((entry) => ({
    source: entry.source,
    summary: changeSummary(entry),
  }));
  const signature = sha256(
    JSON.stringify({
      failing: failing.map((f) => [f.source.url, f.since]).sort(),
      held: heldList.map((h) => h.source.url).sort(),
      uncited: uncited.map((s) => s.url).sort(),
      missing: missing.map((m) => [m.source.url, m.file]).sort(),
    }),
  ).slice(0, 16);
  return {
    active:
      failing.length > 0 ||
      heldList.length > 0 ||
      uncited.length > 0 ||
      missing.length > 0,
    signature,
    failing,
    held: heldList,
    uncited,
    missing,
  };
}

export function buildAttentionReport(state, ctx) {
  const parts = [`## Source Watch needs attention (${ctx.today})`];
  parts.push(
    "This running issue is kept up to date by the daily Source Watch run: it gets a comment when the list below changes and closes itself when nothing is left. " +
      `The watch list is \`${WATCH_FILE_DISPLAY}\`; the "Source Watch" runbook (\`docs/monitors/source-watch.md\`) explains the monitor.`,
  );
  if (state.failing.length > 0) {
    const rows = state.failing.map(
      ({ source, since, reason }) =>
        `| [${cell(source.label)}](${markdownUrl(source.url)}) | ${since ?? "—"} | ${cell(reason)} | ${citedCell(ctx.citations.get(source.url) ?? [])} |`,
    );
    parts.push(
      `### Sources that could not be read ${ctx.failureRuns} runs in a row\n\n` +
        "Their last good text is still recorded and nothing was reported as a change, but they are not being watched while this lasts.\n\n" +
        "| Source | Failing since | Last problem | Hub pages |\n" +
        "|--------|---------------|--------------|-----------|\n" +
        rows.join("\n") +
        "\n\n" +
        "**What to do:** open the URL. If it works in a browser but not for the checker, the site blocks automated requests: remove the entry from the watch list. " +
        "If the page moved, put the new URL in the entry (keep the old one as an `aliases` item). " +
        "If it is no longer an article (a login or consent page, a redesign without `<main>`), decide whether the entry can still be watched or must be removed.",
    );
  }
  if (state.held.length > 0) {
    const rows = state.held.map(
      ({ source, summary }) =>
        `| [${cell(source.label)}](${markdownUrl(source.url)}) | ${summary} |`,
    );
    parts.push(
      `### Many sources changed at once (held back)\n\n` +
        `${state.held.length} of ${ctx.total} watched sources changed text in one run, more than the limit of ${ctx.maxChanged}. ` +
        "That is probably a change of the site's template or of this monitor's parser, not that many real edits, so nothing was recorded for them and no diffs are shown. " +
        "The hold repeats every day until it is resolved.\n\n" +
        "| Source | Changed lines |\n|--------|---------------|\n" +
        rows.join("\n") +
        "\n\n" +
        "**What to do:** open two or three of them. If the page text really changed, accept it: run the workflow manually with `force_baseline` ticked " +
        "(or `FORCE_BASELINE=1 node scripts/source-watch.mjs` locally and commit the tracker) and read what changed with `git log -p` on the tracker afterwards; to see the diffs first run `MAX_CHANGED=1000 DRY_RUN=1 TRACKER_FILE=<copy of the tracker> REPORT_FILE=<report file> node scripts/source-watch.mjs` and read the report file. " +
        "If only the markup changed, fix `parseHtmlSource` in `scripts/source-watch.mjs` and bump `LINES_FORMAT`, which re-baselines silently.",
    );
  }
  if (state.uncited.length > 0) {
    const rows = state.uncited.map(
      (source) => `| [${cell(source.label)}](${markdownUrl(source.url)}) |`,
    );
    parts.push(
      "### Watched sources that no hub page cites\n\n" +
        "No page under `src/content` links these URLs (or their aliases) any more and no `alsoFeeds` page restates them, so a change on them could not be matched to a page to update. " +
        "A voucher or event page that was deleted or rewritten is the usual cause.\n\n" +
        "| Source |\n|--------|\n" +
        rows.join("\n") +
        "\n\n" +
        `**What to do:** remove the entry from \`${WATCH_FILE_DISPLAY}\` (the tracker drops it by itself), or restore the link / add the page to its \`alsoFeeds\`.`,
    );
  }
  if (state.missing.length > 0) {
    const rows = state.missing.map(
      ({ source, file }) =>
        `| [${cell(source.label)}](${markdownUrl(source.url)}) | \`${file}\` |`,
    );
    parts.push(
      "### `alsoFeeds` pages that do not exist\n\n" +
        "| Source | Missing page |\n|--------|--------------|\n" +
        rows.join("\n") +
        "\n\n**What to do:** fix the path or remove it from the entry in the watch list.",
    );
  }
  if (ctx.runUrl) parts.push(`Run: ${ctx.runUrl}`);
  return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Issues (through the gh CLI)
// ---------------------------------------------------------------------------
// The gh calls are the shared ones: the runner (makeGh) of scripts/lib/gh.mjs and,
// for creating or commenting and for closing, raiseIssue and closeOpenIssues of
// scripts/failure-issue.mjs (they list the issues with lib/gh.mjs and create the
// label first). What is this monitor's own is the state machine below and its wording.

/**
 * Bring one issue in line with the state, through `gh(args, stdin)`:
 *   active, none open   create ONE issue (title, label) with `body`;
 *   active, one open    add `commentBody` as a comment, never a second issue (with
 *                       several open copies, to the oldest only);
 *   inactive, some open close each with `closeComment`.
 * Not `enabled` (no CREATE_ISSUES, or DRY_RUN): touch nothing, not even to read. When the
 * issue is needed a failed lookup or write throws (nothing else was committed yet); when
 * it is only being closed a failure is reported in the result and the next run retries.
 */
export function syncIssue({
  gh,
  enabled,
  title,
  label,
  labelColor,
  labelDescription,
  active,
  body,
  commentBody = body,
  closeComment,
}) {
  const result = (action, extra = {}) => ({
    action,
    number: null,
    closed: [],
    error: null,
    ...extra,
  });
  if (!enabled) return result(active ? "skipped" : "none");
  if (active) {
    const raised = raiseIssue({
      gh,
      title,
      label,
      labelColor,
      labelDescription,
      body,
      commentBody,
    });
    return result(raised.action, { number: raised.number });
  }
  let found;
  try {
    found = closeOpenIssues({ gh, title, label, comment: closeComment });
  } catch (error) {
    return result("lookup-failed", { error: error.message });
  }
  const { closed, failures } = found;
  return result(
    closed.length ? "closed" : failures.length ? "close-failed" : "none",
    { number: closed[0] ?? null, closed, error: failures.join("; ") || null },
  );
}

const runLink = (cfg) => (cfg.runUrl ? `\n\nRun: ${cfg.runUrl}` : "");
const issuesEnabled = (cfg) => cfg.createIssues && !cfg.dryRun;
// Only the script of the tests, never the whole cfg: its timeoutMs is the timeout of
// the page fetches, not of a gh call.
const ghOf = (cfg) => makeGh({ ghCliScript: cfg.ghCliScript });

/**
 * The running attention issue: a changed list -> create or comment, an empty
 * list after a reported one -> close. The same list as the last report does
 * nothing (no gh call at all).
 */
export function syncAttentionIssue(cfg, gh, state, report, previous) {
  const none = { action: "none", number: null, closed: [], error: null };
  if (state.active) {
    if (previous && previous.signature === state.signature) return none;
    return syncIssue({
      gh,
      enabled: issuesEnabled(cfg),
      title: ATTENTION_ISSUE_TITLE,
      label: ATTENTION_ISSUE_LABEL,
      labelColor: "d73a4a",
      labelDescription: "Something isn't working",
      active: true,
      body: report,
      commentBody: report,
    });
  }
  if (!previous) return none;
  return syncIssue({
    gh,
    enabled: issuesEnabled(cfg),
    title: ATTENTION_ISSUE_TITLE,
    label: ATTENTION_ISSUE_LABEL,
    labelColor: "d73a4a",
    labelDescription: "Something isn't working",
    active: false,
    body: "",
    closeComment: `Nothing needs attention any more as of ${cfg.today}: every watched source is readable, none is held back and every one is cited by a hub page. Closing this issue; the next problem opens a new one.${runLink(cfg)}`,
  });
}

/**
 * The failure issue: after a failed check, create it or add a comment (one issue, not one
 * per run); after a healthy check, close it. `message` is the text of the failure, or null
 * for a healthy run.
 */
export function syncFailureIssue(cfg, gh, message) {
  const failed = message !== null;
  return syncIssue({
    gh,
    enabled: issuesEnabled(cfg),
    title: FAILED_ISSUE_TITLE,
    label: FAILED_ISSUE_LABEL,
    labelColor: "d73a4a",
    labelDescription: "Something isn't working",
    active: failed,
    body: failed
      ? `The daily Source Watch run could not complete on ${cfg.today}. Nothing was reported and the tracker was not written, so nothing was lost: the next healthy run continues where the last one stopped.\n\n**Why:** ${message}${runLink(cfg)}\n\nThis issue gets one comment per failed run and closes itself after the next healthy run.`
      : "",
    commentBody: failed
      ? `Source Watch failed again on ${cfg.today}:\n\n${message}${runLink(cfg)}`
      : "",
    closeComment: `Source Watch ran normally on ${cfg.today}. Closing this issue.${runLink(cfg)}`,
  });
}

// ---------------------------------------------------------------------------
// Job summary
// ---------------------------------------------------------------------------
function statusRows(watch, result, hints, citations) {
  const byUrl = new Map();
  const moved = (entry) =>
    entry.redirectedTo ? `redirects to ${entry.redirectedTo}` : "";
  for (const entry of result.changed)
    byUrl.set(entry.source.url, ["changed", moved(entry), entry]);
  for (const entry of result.held)
    byUrl.set(entry.source.url, [
      "CHANGED, HELD BACK",
      changeSummary(entry),
      entry,
    ]);
  for (const entry of result.accepted)
    byUrl.set(entry.source.url, [
      "changed, accepted (forced)",
      changeSummary(entry),
      entry,
    ]);
  for (const entry of result.baselined)
    byUrl.set(entry.source.url, ["baseline recorded", moved(entry), entry]);
  for (const entry of result.unchanged)
    byUrl.set(entry.source.url, ["unchanged", moved(entry), entry]);
  for (const entry of result.failed)
    byUrl.set(entry.source.url, ["FAILED, kept", entry.reason, entry]);
  for (const entry of result.unparsed)
    byUrl.set(entry.source.url, ["NOT AN ARTICLE, kept", entry.reason, entry]);
  return watch.map((source) => {
    const [status, detail, entry] = byUrl.get(source.url) ?? [
      "not read",
      "",
      {},
    ];
    return {
      source,
      status,
      detail,
      lines: entry.lines?.length,
      updatedAt: entry.updatedAt,
      hint: hints.get(source.url),
      cited: (citations.get(source.url) ?? []).length,
    };
  });
}

function writeStepSummary(cfg, rows, extra) {
  const body = rows
    .map(
      (row) =>
        `| ${cell(row.source.label)} | ${row.status} | ${row.detail ? cell(row.detail) : "—"} | ` +
        `${row.lines ?? "—"} | ${row.updatedAt || "—"} | ${row.hint || "—"} | ${row.cited} |`,
    )
    .join("\n");
  appendStepSummary(
    cfg.stepSummary,
    "### Source Watch\n\n" +
      "| Source | Result | Detail | Text lines | Updated | Sitemap lastmod | Hub pages |\n" +
      "|--------|--------|--------|------------|---------|-----------------|-----------|\n" +
      body +
      "\n\n" +
      extra,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function failureText(error) {
  return error instanceof ExtractionError
    ? error.message
    : `Unexpected error: ${error?.stack ?? error}`;
}

function handleFailure(cfg, error) {
  const message = failureText(error);
  console.error(`ERROR: ${message}`);
  try {
    writeFileSync(cfg.errorFile, `${message}\n`);
  } catch {
    /* the error is already on stderr */
  }
  // One running issue for a failing check, a comment per further failed run.
  // Best effort: the run fails anyway, so a failed gh call only shows up here.
  try {
    syncFailureIssue(cfg, ghOf(cfg), message);
  } catch (issueError) {
    console.error(
      `ERROR: could not raise the failure issue (${issueError.message}).`,
    );
  }
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
    issue_title: "",
    sources_changed: 0,
    attention: false,
    mass_change: false,
  });
  process.exit(1);
}

export async function main(cfg) {
  console.log("=== Source Watch ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const watch = loadWatchList(cfg);
  const tracker = loadTracker(cfg);

  // Which hub pages cite each source.
  const contentUrls = scanContentUrls(cfg.contentDir);
  const existingFiles = contentFileSet(cfg.contentDir);
  const citations = new Map(
    watch.map((source) => [
      source.url,
      citationsOf(source, contentUrls, existingFiles),
    ]),
  );
  const missing = missingFeeds(watch, existingFiles);

  // The deadline counts from the first request, not from the start of the
  // process: reading the watch list and scanning the content pages is local work
  // that a loaded machine can stretch, and it is not what runs into the job's
  // own timeout.
  const startedAt = Date.now();
  const reads = await readAllSources(cfg, watch, { startedAt });
  const notRequested = reads.filter((read) => read.skipped).length;
  if (notRequested > 0) {
    warnLoud(
      `the run deadline of ${durationText(cfg.runDeadlineMs)} was reached: ${notRequested} of ${watch.length} sources were not requested and keep their previous record. ` +
        "Some hosts answered slowly or not at all (see the attempts above); if this lasts, the sources it cuts off are named by the attention issue after a few days.",
    );
  }

  if (!reads.some((read) => read.ok)) {
    throw new ExtractionError(
      `None of the ${watch.length} watched sources could be read, so the tracker was not modified. ` +
        "Either the sites are down or blocking requests, or this runner has no network access:\n\n" +
        watch
          .map((source, i) => `- ${source.url}: ${reads[i].reason}`)
          .join("\n"),
    );
  }

  // The sitemap is a hint only: past the deadline it is not worth the time.
  const hints =
    cfg.sitemapHint && Date.now() - startedAt <= cfg.runDeadlineMs
      ? await fetchSitemapHints(cfg, watch)
      : new Map();

  const result = applyResults(tracker, watch, reads, {
    today: cfg.today,
    force: cfg.forceBaseline,
    maxChanged: cfg.maxChanged,
    failureRuns: cfg.failureRuns,
  });
  const rows = statusRows(watch, result, hints, citations);

  // ---- log
  for (const entry of result.baselined) {
    console.log(
      `"${entry.source.label}" has no stored state yet: recorded as the baseline.`,
    );
  }
  for (const entry of result.unchanged) {
    console.log(`"${entry.source.label}" unchanged.`);
  }
  for (const entry of result.changed) {
    console.log(`"${entry.source.label}" changed: ${changeSummary(entry)}.`);
  }
  for (const entry of result.accepted) {
    console.log(
      `"${entry.source.label}" changed, accepted silently (FORCE_BASELINE).`,
    );
  }
  for (const entry of result.held) {
    console.log(
      `"${entry.source.label}" changed: ${changeSummary(entry)} (held back).`,
    );
  }
  for (const entry of [
    ...result.changed,
    ...result.baselined,
    ...result.unchanged,
  ]) {
    if (entry.redirectedTo) {
      console.error(
        `NOTE: ${entry.source.url} now redirects to ${entry.redirectedTo}.`,
      );
    }
  }
  for (const entry of result.failed) {
    if (entry.skipped) continue;
    warnLoud(
      `could not fetch "${entry.source.label}" (${entry.source.url}): ${entry.reason}; kept its previous record.`,
    );
  }
  for (const entry of result.unparsed) {
    warnLoud(
      `"${entry.source.label}" (${entry.source.url}) cannot be read as an article (${entry.reason}); kept its previous record. Check it by hand.`,
    );
  }
  if (result.held.length > 0) {
    warnLoud(
      `${result.held.length} of ${watch.length} sources changed at once (limit ${cfg.maxChanged}): probably a template change; nothing was recorded for them. See the "${ATTENTION_ISSUE_TITLE}" issue.`,
    );
  }
  for (const source of watch) {
    if ((citations.get(source.url) ?? []).length === 0) {
      warnLoud(
        `no hub page cites "${source.label}" (${source.url}) any more; remove it from the watch list.`,
      );
    }
  }
  for (const { source, file } of missing) {
    warnLoud(
      `"${source.label}" lists ${file} in alsoFeeds, which does not exist.`,
    );
  }

  // ---- the running attention issue (before anything is written)
  const state = attentionState({
    records: result.tracker.sources,
    watch,
    held: result.held,
    citations,
    missing,
    failureRuns: cfg.failureRuns,
  });
  const attentionReport = buildAttentionReport(state, {
    today: cfg.today,
    citations,
    failureRuns: cfg.failureRuns,
    maxChanged: cfg.maxChanged,
    total: watch.length,
    runUrl: cfg.runUrl,
  });
  let attentionResult;
  if (state.active) {
    writeFileSync(cfg.attentionFile, attentionReport);
  }
  attentionResult = syncAttentionIssue(
    cfg,
    ghOf(cfg),
    state,
    attentionReport,
    tracker.attention,
  );
  // Closing is retried by the next run when it failed: the record stays.
  const closeFailed = !state.active && attentionResult.error;
  const next = {
    ...result.tracker,
    attention: state.active
      ? {
          signature: state.signature,
          since:
            tracker.attention && tracker.attention.signature === state.signature
              ? tracker.attention.since
              : cfg.today,
        }
      : closeFailed
        ? tracker.attention
        : null,
  };
  if (
    attentionResult.action !== "none" &&
    attentionResult.action !== "skipped"
  ) {
    console.log(
      `Attention issue: ${attentionResult.action}${attentionResult.number ? ` #${attentionResult.number}` : ""}.`,
    );
  }
  if (attentionResult.error) {
    warnLoud(`attention issue: ${attentionResult.error}`);
  }
  // A healthy check closes the failure issue of an earlier failed run.
  const recovered = syncFailureIssue(cfg, ghOf(cfg), null);
  if (recovered.error) {
    warnLoud(`could not close the failure issue: ${recovered.error}`);
  }

  writeStepSummary(
    cfg,
    rows,
    [
      result.failed.length + result.unparsed.length > 0
        ? "A source that failed or is not an article keeps its previous record and is never reported as a change: check it by hand."
        : "",
      result.held.length > 0
        ? `${result.held.length} changed sources were held back (more than ${cfg.maxChanged} at once).`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );

  // ---- the tracker
  const dirty =
    trackerFingerprint(next) !== trackerFingerprint(tracker) ||
    tracker.format !== LINES_FORMAT ||
    tracker.fresh;
  if (dirty) {
    next.lastSynced = cfg.today;
    writeFileSync(cfg.trackerFile, trackerContent(next));
  }

  let issueTitle = "";
  if (result.changed.length > 0) {
    writeFileSync(
      cfg.reportFile,
      buildReport(result.changed, { citations, hints }),
    );
    issueTitle = buildIssueTitle(result.changed);
    console.log(`${result.changed.length} source(s) changed.`);
  } else if (!dirty) {
    console.log("No watched source changed this run.");
  } else {
    console.log("State updated; nothing to report.");
  }

  writeOutput(cfg.githubOutput, {
    changes_found: result.changed.length > 0,
    baseline_updated: dirty,
    extraction_failed: false,
    issue_title: issueTitle,
    sources_changed: result.changed.length,
    attention: state.active,
    mass_change: result.held.length > 0,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
