#!/usr/bin/env node
/**
 * Weekly change check for the Microsoft Partner Center pages that back
 * src/content/docs/guide/partneremployees.mdx (the skilling tabs of the new
 * Partner designations, the program introduction and the Learn account
 * association steps). Those texts are typed by hand, so a change on one of the
 * pages means a maintainer has to re-read it.
 *
 * Usage:
 *   node scripts/partner-designations-check.mjs
 *
 * What it compares: the article text of each tracked page (the Learn
 * `<div class="content">` blocks inside `<main>`, so the navigation, feedback
 * widgets, related links and every other part of the page chrome never count),
 * normalized to one text line per block: headings keep their level ("### Title"),
 * list items start with "- ", table rows join their cells with " | ". Entities,
 * whitespace, hard line wraps, soft hyphens, ids, classes and link targets never
 * change a line. The SHA-256 of those lines is the decision: the same hash is
 * never an alert. The lines themselves are stored in the tracker, only to
 * show WHAT changed (a compact line diff) in the issue; they never decide.
 *
 * It does NOT parse certification names or point values (the prose differs too
 * much from page to page to parse without silent breakage): a human re-reads
 * the page and edits the MDX.
 *
 * Alert rules:
 *  - A page without stored lines (an older tracker that only had a hash, a page
 *    added by hand, lines that do not hash to the stored hash, or a tracker
 *    written with another LINES_FORMAT) is baselined silently, never alerted.
 *  - A page that cannot be fetched, or that is not a Learn article any more (no
 *    `<main>`, no content block, no title, too little text), keeps its record and
 *    only warns: a failed read is never evidence of a change. When no page can
 *    be read at all the run fails (a `bug` issue) and writes nothing.
 *  - The tracker is only rewritten when a page changed or was baselined, so an
 *    unchanged Microsoft never produces a commit.
 *
 * Env overrides (defaults shown):
 *   TRACKER_FILE        src/data_files/partner-designations.json
 *   REPORT_FILE         <tmpdir>/partner-designations-report.md
 *   ERROR_FILE          <tmpdir>/partner-designations-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (unset: no job summary)
 *   FETCH_DELAY_MS      1000   pause between two pages
 *   FETCH_ATTEMPTS      3      at least 1
 *   RETRY_BASE_MS       5000
 *   MAX_RETRY_AFTER_MS  60000
 *   FETCH_TIMEOUT_MS    30000
 *   MIN_CONTENT_LINES   10     fewer text lines is "not an article"
 *   TODAY               YYYY-MM-DD, for tests
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * issue_title, pages_changed.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

export { retryDelayMs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Bump when htmlToLines / parsePartnerPage change what a page turns into: a
// tracker written with another format re-baselines silently instead of showing
// the change of the normalization as a change of the pages.
export const LINES_FORMAT = 1;

const HUB_PAGE = "src/content/docs/guide/partneremployees.mdx";
const REPORT_MAX_CHARS = 60000;
const DIFF_LINE_MAX_CHARS = 300;
// Changed lines shown per page and in total, tried in turn until the report fits
// into one GitHub issue (65,536 characters at most).
const DIFF_LIMITS = [
  { perPage: 40, total: 200 },
  { perPage: 20, total: 80 },
  { perPage: 8, total: 30 },
  { perPage: 0, total: 0 },
];
const ISSUE_TITLE_MAX_CHARS = 200;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
    trackerFile: resolveFromRoot(
      env.TRACKER_FILE ?? "src/data_files/partner-designations.json",
    ),
    reportFile:
      env.REPORT_FILE ?? join(tmpdir(), "partner-designations-report.md"),
    errorFile:
      env.ERROR_FILE ?? join(tmpdir(), "partner-designations-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    fetchDelayMs: num("FETCH_DELAY_MS", 1000),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 5000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    minContentLines: num("MIN_CONTENT_LINES", 10),
    today,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * A fragment of a page as normalized text lines: one line per block, nothing
 * but the text of the page. Empty headings and list items are dropped.
 */
export function htmlToLines(fragment) {
  const text = decodeEntities(
    String(fragment)
      // Source line breaks are only how Learn wraps its Markdown: they are
      // whitespace, never a block boundary (those are added below).
      .replace(/\s*[\r\n]+\s*/g, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
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
 * A Learn article as { ok, lines, updatedAt } or { ok: false, reason }. The
 * text is the `<div class="content">` blocks of `<main>` (the title and the
 * body); a page that has none, no title or hardly any text is not the article
 * (a bot-check or error page, a changed layout) and never a change.
 */
export function parsePartnerPage(html, { minLines = 10 } = {}) {
  const source = String(html ?? "");
  const open = source.match(/<main\b[^>]*>/i);
  if (!open) return { ok: false, reason: "no <main> element" };
  const mainStart = open.index + open[0].length;
  const mainEnd = source.toLowerCase().lastIndexOf("</main>");
  const main = source.slice(
    mainStart,
    mainEnd > mainStart ? mainEnd : source.length,
  );

  const blocks = contentBlocks(main);
  if (blocks.length === 0) {
    return { ok: false, reason: 'no <div class="content"> block in <main>' };
  }
  const lines = blocks.flatMap((block) => htmlToLines(block));
  if (!lines.some((line) => line.startsWith("# "))) {
    return { ok: false, reason: "no page title (h1)" };
  }
  if (lines.length < minLines) {
    return {
      ok: false,
      reason: `only ${lines.length} text line${lines.length === 1 ? "" : "s"} (expected at least ${minLines})`,
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
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
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
  // The (up to three) nearest headings a hunk sits under, for example
  // "Skilling category > Enterprise track > STEP 1 (Required)"; a hunk that
  // starts with a heading sits under that heading's parents only.
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
// Tracker
// ---------------------------------------------------------------------------
export function normalizeTracker(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pages)) {
    throw new ExtractionError("missing pages array");
  }
  const seen = new Set();
  const pages = parsed.pages.map((page, index) => {
    const where = `page #${index + 1}`;
    if (
      !page ||
      typeof page !== "object" ||
      typeof page.url !== "string" ||
      !/^https?:\/\/\S+$/.test(page.url)
    ) {
      throw new ExtractionError(`${where} has no valid url`);
    }
    if (seen.has(page.url)) {
      throw new ExtractionError(`${where} repeats the url ${page.url}`);
    }
    seen.add(page.url);
    if (
      page.contentHash !== undefined &&
      page.contentHash !== null &&
      !(
        typeof page.contentHash === "string" &&
        /^[0-9a-f]{64}$/.test(page.contentHash)
      )
    ) {
      throw new ExtractionError(`${where} has a malformed contentHash`);
    }
    if (
      page.lines !== undefined &&
      page.lines !== null &&
      !(
        Array.isArray(page.lines) &&
        page.lines.every((line) => typeof line === "string")
      )
    ) {
      throw new ExtractionError(`${where} has malformed stored lines`);
    }
    return {
      label:
        typeof page.label === "string" && page.label ? page.label : page.url,
      url: page.url,
      areas: Array.isArray(page.areas)
        ? page.areas.filter((area) => typeof area === "string")
        : [],
      feeds:
        typeof page.feeds === "string" && page.feeds ? page.feeds : undefined,
      contentHash: page.contentHash ?? null,
      lastChanged:
        typeof page.lastChanged === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(page.lastChanged)
          ? page.lastChanged
          : undefined,
      lines: Array.isArray(page.lines) ? page.lines : undefined,
    };
  });
  return {
    lastSynced:
      typeof parsed.lastSynced === "string" ? parsed.lastSynced : null,
    format: Number.isInteger(parsed.format) ? parsed.format : 0,
    pages,
  };
}

/** The tracker file content: fixed key order, one JSON line per stored text line. */
export function trackerContent(tracker) {
  return (
    JSON.stringify(
      {
        lastSynced: tracker.lastSynced,
        format: tracker.format,
        pages: tracker.pages.map((page) => ({
          label: page.label,
          url: page.url,
          areas: page.areas,
          ...(page.feeds ? { feeds: page.feeds } : {}),
          contentHash: page.contentHash,
          ...(page.lastChanged ? { lastChanged: page.lastChanged } : {}),
          ...(page.lines ? { lines: page.lines } : {}),
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

function loadTracker(cfg) {
  if (!existsSync(cfg.trackerFile)) {
    throw new ExtractionError(
      `Tracker file not found at ${relative(root, cfg.trackerFile)}.`,
    );
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
/**
 * The stored text of a page when it can be trusted as the previous version:
 * written by the current LINES_FORMAT and hashing to the stored hash. Anything
 * else (an older tracker, a page added by hand, an edited record) has no
 * previous text, so its next read is a silent baseline.
 */
export function storedLines(page, format) {
  if (format !== LINES_FORMAT) return null;
  if (!page.contentHash || !page.lines || page.lines.length === 0) return null;
  return hashLines(page.lines) === page.contentHash ? page.lines : null;
}

/**
 * Applies the reads (one per tracked page, in order: { ok: true, lines, hash,
 * updatedAt } or { ok: false, kind: "fetch" | "parse", reason }) to the
 * tracker. Returns the next tracker and what happened to each page. Pure: the
 * tracker passed in is not modified.
 */
export function applyResults(tracker, reads, today) {
  const formatChanged = tracker.format !== LINES_FORMAT;
  const result = {
    changed: [],
    baselined: [],
    unchanged: [],
    failed: [],
    unparsed: [],
  };

  const pages = tracker.pages.map((page, index) => {
    const read = reads[index];
    if (!read?.ok) {
      const entry = { page, reason: read?.reason ?? "not read" };
      (read?.kind === "parse" ? result.unparsed : result.failed).push(entry);
      // Text stored in another format cannot be compared with a later read of
      // this format: the next successful read baselines it silently.
      return formatChanged ? { ...page, lines: undefined } : page;
    }

    const previous = storedLines(page, tracker.format);
    if (previous === null) {
      const next = { ...page, contentHash: read.hash, lines: read.lines };
      result.baselined.push({
        page: next,
        updatedAt: read.updatedAt,
        redirectedTo: read.redirectedTo,
      });
      return next;
    }
    if (page.contentHash === read.hash) {
      result.unchanged.push({
        page,
        updatedAt: read.updatedAt,
        redirectedTo: read.redirectedTo,
      });
      return page;
    }

    const next = {
      ...page,
      contentHash: read.hash,
      lines: read.lines,
      lastChanged: today,
    };
    result.changed.push({
      page: next,
      updatedAt: read.updatedAt,
      redirectedTo: read.redirectedTo,
      diff: summarizeDiff(previous, read.lines),
    });
    return next;
  });

  const dirty = result.changed.length > 0 || result.baselined.length > 0;
  return {
    ...result,
    dirty,
    tracker: dirty
      ? { lastSynced: today, format: LINES_FORMAT, pages }
      : tracker,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
/** GET with retries for rate limits, server errors and network errors only. */
async function fetchText(cfg, url) {
  let status;
  let error;

  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    let retryAfter = null;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text: await response.text(),
          url: response.url,
        };
      }

      status = response.status;
      error = undefined;
      retryAfter = response.headers.get("retry-after");
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

/** "/partner-center/x" of a Learn URL, without the locale segment. */
function learnPath(url) {
  try {
    return new URL(url).pathname
      .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

async function readPage(cfg, page) {
  const response = await fetchText(cfg, page.url);
  if (!response.ok) {
    return {
      ok: false,
      kind: "fetch",
      reason: response.status
        ? `HTTP ${response.status}`
        : `network error${response.error ? ` (${response.error.message})` : ""}`,
    };
  }
  const parsed = parsePartnerPage(response.text, {
    minLines: cfg.minContentLines,
  });
  if (!parsed.ok) return { ok: false, kind: "parse", reason: parsed.reason };
  return {
    ok: true,
    lines: parsed.lines,
    hash: hashLines(parsed.lines),
    updatedAt: parsed.updatedAt,
    // Microsoft moved the page: the tracked URL only works through a redirect.
    redirectedTo:
      response.url && learnPath(response.url) !== learnPath(page.url)
        ? response.url
        : undefined,
  };
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
function safeText(text) {
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
  return url.replace(
    /[()\s<>]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** What on partneremployees.mdx a page feeds, for the issue table. */
export function feedsText(page) {
  if (page.feeds) return page.feeds;
  if (page.areas.length === 0) return "the guide page";
  return `the ${page.areas.join(", ")} skilling tab${page.areas.length === 1 ? "" : "s"} (certification lists, point values and totals)`;
}

const STEPS =
  "### What to do\n\n" +
  `1. Open each changed page and read the diff in context: the diff shows the previous text from the tracker, the page has the full current text. ` +
  'A "Skilling" change usually means new, removed or re-pointed certifications or other point values.\n' +
  `2. Update the matching part of \`${HUB_PAGE}\` (the column "Feeds" names it): for a solution area page the Level 1/2/3 skilling tabs of that area, including its "Total skilling points: X/70" line and the retirement footnotes of its certification lists. ` +
  "Copy certification names and point values only after checking them on the page; do not invent any.\n" +
  "3. A change outside the Skilling category (performance, customer success, data freshness) usually needs no edit. For the program introduction and the account association page, check the text of the section the table names.\n" +
  "4. If the tracked URL now redirects, update the link in the guide page and the `url` of the page in `src/data_files/partner-designations.json`.\n" +
  "5. Nothing needs to be dismissed: the new text is already recorded in the tracker, and a page that changes again produces a new issue.\n\n" +
  'See the "Partner Designation Skilling Requirements" runbook (`docs/monitors/partner-designations.md`) for the full process.';

/** "Partner Center pages changed: Security, Modern Work" (at most 200 characters). */
export function buildIssueTitle(changed) {
  const names = changed.map(
    ({ page }) => safeText(page.label.replace(/\s*\(.*\)\s*$/, "")) || "page",
  );
  const head = `Partner Center page${names.length === 1 ? "" : "s"} changed: `;
  for (let shown = names.length; shown >= 1; shown--) {
    const rest = names.length - shown;
    const title =
      head + names.slice(0, shown).join(", ") + (rest ? ` +${rest} more` : "");
    if (title.length <= ISSUE_TITLE_MAX_CHARS) return title;
  }
  return clip(head + names[0], ISSUE_TITLE_MAX_CHARS);
}

function buildReportBody(changed, { perPage, total }, shortened) {
  const rows = changed.map(
    ({ page, diff, updatedAt }) =>
      `| [${cell(page.label)}](${markdownUrl(page.url)}) | ${cell(feedsText(page))} | ` +
      `+${diff.added} / -${diff.removed} | ${updatedAt || "—"} |`,
  );

  let remaining = total;
  const blocks = changed.map(({ page, diff, redirectedTo }) => {
    const parts = [`#### ${safeText(page.label) || "Page"}`];
    if (redirectedTo) {
      parts.push(
        `The tracked URL now redirects to ${markdownUrl(redirectedTo)}. The page moved: update its link and the tracker URL.`,
      );
    }
    if (diff.added + diff.removed === 0) {
      parts.push("No line differs from the stored text.");
    } else {
      const rendered = renderDiff(diff.entries, Math.min(perPage, remaining));
      remaining -= rendered.shown;
      parts.push(
        `Changed text, from the Partner Center page (\`-\` removed, \`+\` added; ${diff.added} added and ${diff.removed} removed lines):`,
      );
      if (rendered.shown > 0) {
        parts.push("```diff\n" + rendered.text + "\n```");
      }
      if (rendered.omitted > 0) {
        parts.push(
          `${rendered.omitted} more changed line${rendered.omitted === 1 ? " is" : "s are"} not shown here ` +
            `(at most ${perPage} lines per page, ${total} in total, to stay under GitHub's issue size limit). ` +
            "Open the page for the rest.",
        );
      }
    }
    return parts.join("\n\n");
  });

  return [
    `## Partner Center page${changed.length === 1 ? "" : "s"} changed (${changed.length})`,
    `The text of the Microsoft Partner Center page${changed.length === 1 ? "" : "s"} below changed since the last check. ` +
      `\`${HUB_PAGE}\` is typed by hand from these pages, so it may be out of date now. ` +
      "A change of formatting alone (wrapping, spaces, ids, links, page chrome) is never reported, only a change of the article text. " +
      "**Learn updated_at** is when Learn says it republished the page." +
      (shortened
        ? " The diffs are shortened to keep this issue under GitHub's size limit."
        : ""),
    "| Page | Feeds | Changed lines | Learn updated_at |\n" +
      "|------|-------|---------------|------------------|\n" +
      rows.join("\n"),
    ...blocks,
    STEPS,
  ].join("\n\n");
}

/**
 * The issue body for the changed pages ({ page, diff, updatedAt, redirectedTo }).
 * Page text is only ever inside code fences; names are sanitized. The diffs
 * shrink in steps until the body fits into one issue.
 */
export function buildReport(changed) {
  for (let step = 0; step < DIFF_LIMITS.length; step++) {
    const report = buildReportBody(changed, DIFF_LIMITS[step], step > 0) + "\n";
    if (report.length <= REPORT_MAX_CHARS) return report;
  }
  const last = buildReportBody(changed, DIFF_LIMITS.at(-1), true);
  return (
    last.slice(0, REPORT_MAX_CHARS - 200) +
    "\n\n(The report was cut to fit into one issue.)\n"
  );
}

// ---------------------------------------------------------------------------
// Job summary
// ---------------------------------------------------------------------------
function writeStepSummary(cfg, result, reads) {
  const rows = result.pagesInOrder.map(({ page, status, detail }, index) => {
    const read = reads[index];
    return (
      `| ${cell(page.label)} | ${status} | ${detail ? cell(detail) : "—"} | ` +
      `${read?.ok ? read.lines.length : "—"} | ${read?.ok && read.updatedAt ? read.updatedAt : "—"} |`
    );
  });
  const text =
    "### Partner Designations Monitor\n\n" +
    "| Page | Result | Detail | Text lines | Learn updated_at |\n" +
    "|------|--------|--------|------------|------------------|\n" +
    rows.join("\n") +
    "\n\n" +
    (result.failed.length + result.unparsed.length > 0
      ? "A page that failed or is not an article keeps its previous record and is never reported as a change: check it by hand.\n"
      : "");
  appendStepSummary(cfg.stepSummary, text);
}

function statusRows(tracker, result) {
  const byUrl = new Map();
  // A tracked URL that only works through a redirect is not an alert (the text
  // decides), but the job summary says so: the links should be updated.
  const moved = (entry) =>
    entry.redirectedTo ? `redirects to ${entry.redirectedTo}` : "";
  for (const entry of result.changed)
    byUrl.set(entry.page.url, ["changed", moved(entry)]);
  for (const entry of result.baselined)
    byUrl.set(entry.page.url, ["baseline recorded", moved(entry)]);
  for (const entry of result.unchanged)
    byUrl.set(entry.page.url, ["unchanged", moved(entry)]);
  for (const entry of result.failed)
    byUrl.set(entry.page.url, ["FAILED, kept", entry.reason]);
  for (const entry of result.unparsed)
    byUrl.set(entry.page.url, ["NOT AN ARTICLE, kept", entry.reason]);
  return tracker.pages.map((page) => {
    const [status, detail] = byUrl.get(page.url) ?? ["not read", ""];
    return { page, status, detail };
  });
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
    pages_changed: 0,
  });
  process.exit(1);
}

export async function main(cfg) {
  console.log("=== Partner Designations Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const tracker = loadTracker(cfg);

  const reads = [];
  for (let i = 0; i < tracker.pages.length; i++) {
    if (i > 0) await sleep(cfg.fetchDelayMs);
    reads.push(await readPage(cfg, tracker.pages[i]));
  }

  if (!reads.some((read) => read.ok)) {
    throw new ExtractionError(
      `None of the ${tracker.pages.length} tracked Partner Center pages could be read as an article, so the tracker was not modified. ` +
        "Either the site is down or blocking requests, or its layout changed:\n\n" +
        tracker.pages
          .map((page, i) => `- ${page.url}: ${reads[i].reason}`)
          .join("\n"),
    );
  }

  const result = applyResults(tracker, reads, cfg.today);
  result.pagesInOrder = statusRows(tracker, result);

  for (const entry of result.baselined) {
    console.log(
      `"${entry.page.label}" has no stored text yet: recorded ${entry.page.lines.length} lines as the baseline.`,
    );
  }
  for (const entry of result.unchanged) {
    console.log(`"${entry.page.label}" unchanged.`);
  }
  for (const entry of result.changed) {
    console.log(
      `"${entry.page.label}" changed: +${entry.diff.added} / -${entry.diff.removed} lines.`,
    );
  }
  // Never an alert by itself (the text decides), but the links should follow.
  for (const entry of [
    ...result.changed,
    ...result.baselined,
    ...result.unchanged,
  ]) {
    if (entry.redirectedTo) {
      console.error(
        `NOTE: ${entry.page.url} now redirects to ${entry.redirectedTo}.`,
      );
    }
  }
  for (const entry of result.failed) {
    warnLoud(
      `could not fetch "${entry.page.label}" (${entry.page.url}): ${entry.reason}; kept its previous record.`,
      { title: "Partner Designations Monitor" },
    );
  }
  for (const entry of result.unparsed) {
    warnLoud(
      `"${entry.page.label}" (${entry.page.url}) is not a readable Learn article (${entry.reason}); kept its previous record. Check the page by hand.`,
      { title: "Partner Designations Monitor" },
    );
  }

  writeStepSummary(cfg, result, reads);

  if (!result.dirty) {
    console.log("No partner designation pages changed this run.");
    writeOutput(cfg.githubOutput, {
      changes_found: false,
      baseline_updated: false,
      extraction_failed: false,
      issue_title: "",
      pages_changed: 0,
    });
    return;
  }

  // Written before the report on purpose: nothing below can fail halfway into
  // a state where the tracker is updated but no output says so.
  writeFileSync(cfg.trackerFile, trackerContent(result.tracker));

  let issueTitle = "";
  if (result.changed.length > 0) {
    writeFileSync(cfg.reportFile, buildReport(result.changed));
    issueTitle = buildIssueTitle(result.changed);
    console.log(`${result.changed.length} page(s) changed.`);
  } else {
    console.log("Recorded baseline text; nothing to report.");
  }

  writeOutput(cfg.githubOutput, {
    changes_found: result.changed.length > 0,
    baseline_updated: true,
    extraction_failed: false,
    issue_title: issueTitle,
    pages_changed: result.changed.length,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
