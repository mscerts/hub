#!/usr/bin/env node
/**
 * Weekly check of the MeasureUp Microsoft catalog (not Microsoft Learn), so the
 * MeasureUp blocks of the exam pages stay complete and their links keep working.
 *
 * Usage:
 *   node scripts/measureup-check.mjs
 *
 * What it does:
 *   1. Reads the whole product listing (https://www.measureup.com/microsoft.html,
 *      12 products a page, sorted by product name so the pages do not overlap):
 *      the structured `dl4Objects` data gives id, name and category, the product
 *      tiles give the real product URL. Products MeasureUp marks retired (the
 *      "[Retired Exam]" name prefix and the "Retired Exams" category) are listed
 *      but not active, and bundles (listed without a category, and with no place
 *      on the exam pages) are not tracked: that is why "162 listed" is 93
 *      products followed, with 52 retired and 17 bundles.
 *   2. Compares the active products with the baseline by SET of product ids, never
 *      by count: a new product alerts even when more products retired in the same
 *      week. Products that disappear (retired or no longer listed) are reported
 *      separately and informationally, and never open an issue on their own.
 *   3. Rewrites the baseline whenever the active set (or a name/type/URL) changed,
 *      silently when nothing new appeared, so it cannot go stale. An unchanged
 *      listing never produces a write, so there are no commits on quiet weeks.
 *   4. Checks the hub's own MeasureUp links (src/content/docs): a link whose
 *      product is not in the active listing is probed with one GET and reported as
 *      retired, redirected, or not found. Findings are remembered in the baseline
 *      (`staleHubLinks`) so a link is reported once, not every week.
 *
 * Failsafes (extraction_failed, nothing written):
 *   - the listing is unreachable, malformed or has fewer than MIN_LISTED products;
 *   - a page shows other items than the one asked for, or yields far fewer
 *     products than the toolbar says it should (the per-page count collapsed), or
 *     the whole scan is more than MAX_SHORTFALL_PCT short of the total the site
 *     announces (a scan like that is repeated once before it counts as failed);
 *   - more than MAX_NEW_PCT of the active products are new at once, or more than
 *     MAX_REMOVED_PCT of the baseline vanished at once (HTML or id scheme changed,
 *     not news). FORCE_BASELINE=1 accepts such a change silently.
 * A fetch failure is never evidence: a scan that is merely incomplete reports new
 * products but removes nothing, and a hub link that cannot be probed is "unverified".
 *
 * Env overrides (defaults shown):
 *   BASE_URL            https://www.measureup.com/microsoft.html
 *   LISTING_SORT        name (the `product_list_order` of every page; empty = the
 *                       site default "position", which ties and so can repeat or
 *                       skip products between pages)
 *   SITE_ORIGIN         origin of BASE_URL (hub links are probed here)
 *   BASELINE_FILE       src/data_files/measureup-products.json
 *   DOCS_DIR            src/content/docs
 *   REPORT_FILE         <tmpdir>/measureup-report.md
 *   ERROR_FILE          <tmpdir>/measureup-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY (job summary, optional)
 *   MIN_LISTED          100  (products listed, retired included)
 *   MIN_ACTIVE          40
 *   MAX_NEW_PCT         50
 *   MAX_REMOVED_PCT     50
 *   MAX_SHORTFALL_PCT   10
 *   PAGE_COLLAPSE_PCT   50   (a page below this share of its expected count fails)
 *   MAX_PAGES           40
 *   SCAN_ATTEMPTS       2    (whole-listing reads before an incomplete scan fails)
 *   HUB_LINK_CHECK      1    (0 or false switches the hub link check off)
 *   MAX_HUB_PROBES      60
 *   FORCE_BASELINE      (1 = accept the scan silently, skip the mass-change failsafes)
 *   FETCH_DELAY_MS      2000 (pause between requests)
 *   FETCH_ATTEMPTS      3
 *   RETRY_BASE_MS       5000
 *   MAX_RETRY_AFTER_MS  60000 (the longest Retry-After that is waited out)
 *   FETCH_TIMEOUT_MS    30000
 *   RUN_DEADLINE_MS     900000
 *   TODAY               YYYY-MM-DD (tests)
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * issue_title, new_products, stale_links.
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
import { retryDelayMs } from "./lib/retry.mjs";

export { retryDelayMs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// The title of the workflow annotations (warnings) this monitor makes.
const ANNOTATION_TITLE = "MeasureUp Monitor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_LISTING_URL = "https://www.measureup.com/microsoft.html";
const DEFAULT_PAGE_SIZE = 12;
// A page of the exam docs as the issue names it, whatever DOCS_DIR is.
const DOCS_PREFIX = "src/content/docs";
const TRACKING_FRAGMENT = "#u44";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
// Below this share of listed products with a real URL the product tiles
// probably changed shape: the hub link check would report everything.
const MIN_URL_COVERAGE_PCT = 90;
// Baselines smaller than this make a percentage meaningless.
const PCT_MIN_BASE = 10;
const TYPE_ORDER = [
  "assessment",
  "practice-test",
  "certkit",
  "bundle",
  "unknown",
];
// MeasureUp marks a retired exam twice: "[Retired Exam]" in front of the name and
// the category "Retired Exams". Either is enough.
const RETIRED_RE = /\bretired\b/i;
const REPORT_MAX_CHARS = 60000;
const MAX_TABLE_ROWS = 100;
// Stops GitHub from turning "@name" into a mention or "#123" into a reference.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

class ExtractionError extends Error {}
class MalformedError extends ExtractionError {}
// A scan that came out short or mixed up: worth one more read of the listing
// before it counts as a failure.
class IncompleteScanError extends ExtractionError {}

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
  const listingUrl = new URL(env.BASE_URL || DEFAULT_LISTING_URL);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    listingUrl: listingUrl.href,
    siteOrigin: (env.SITE_ORIGIN || listingUrl.origin).replace(/\/+$/, ""),
    baselineFile: resolveFromRoot(
      env.BASELINE_FILE ?? "src/data_files/measureup-products.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? DOCS_PREFIX),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "measureup-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "measureup-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    minListed: num("MIN_LISTED", 100),
    minActive: num("MIN_ACTIVE", 40),
    maxNewPct: num("MAX_NEW_PCT", 50),
    maxRemovedPct: num("MAX_REMOVED_PCT", 50),
    maxShortfallPct: num("MAX_SHORTFALL_PCT", 10),
    pageCollapsePct: num("PAGE_COLLAPSE_PCT", 50),
    maxPages: num("MAX_PAGES", 40),
    scanAttempts: Math.max(1, num("SCAN_ATTEMPTS", 2)),
    listingSort: (env.LISTING_SORT ?? "name").trim(),
    hubLinkCheck: on("HUB_LINK_CHECK", true),
    maxHubProbes: num("MAX_HUB_PROBES", 60),
    forceBaseline: on("FORCE_BASELINE", false),
    fetchDelayMs: num("FETCH_DELAY_MS", 2000),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 5000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    deadlineMs: num("RUN_DEADLINE_MS", 15 * 60 * 1000),
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

/**
 * A product name as MeasureUp's JSON gives it: non-breaking spaces and U+FFFD
 * (a lost non-breaking space in a few names) become plain spaces.
 */
export function cleanName(text) {
  return String(text ?? "")
    .replace(/[\u00a0\u2007\u202f\ufffd]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Parsing the listing pages
// ---------------------------------------------------------------------------
/**
 * The JSON array/object assigned to `marker` ("var dl4Objects = [...]"), found by
 * bracket matching that knows strings, so a "];" inside a product name or a
 * later script cannot cut it short.
 */
export function extractAssignedJson(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) throw new MalformedError(`missing ${marker} product data`);
  const after = /^\s*=\s*/.exec(html.slice(at + marker.length));
  if (!after) throw new MalformedError(`${marker} is not an assignment`);
  const start = at + marker.length + after[0].length;
  const open = html[start];
  if (open !== "[" && open !== "{") {
    throw new MalformedError(`${marker} does not hold an array or object`);
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new MalformedError(`${marker} is not terminated`);
}

/** {from, to, total} of the toolbar ("Items 13-24 of 162"), or null. */
export function parseToolbar(html) {
  const numbers = [...html.matchAll(/toolbar-number">\s*(\d+)\s*</g)].map(
    (match) => Number(match[1]),
  );
  if (numbers.length >= 3) {
    return { from: numbers[0], to: numbers[1], total: numbers[2] };
  }
  // A single page reads "12 Items": one number, the total.
  if (numbers.length === 1) {
    return { from: 1, to: numbers[0], total: numbers[0] };
  }
  return null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ");
}

function absoluteUrl(href, origin) {
  try {
    const url = new URL(decodeEntities(href).trim(), origin);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * The real product URLs of one listing page. MeasureUp's slugs do not follow the
 * product name, so they cannot be derived: they are read from the product tiles,
 * by product id and, as a fallback, by the name shown in the link.
 */
export function parseProductLinks(html, origin) {
  const byId = new Map();
  const byName = new Map();

  const anchorOf = (fragment) => {
    for (const match of fragment.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (!/\bproduct-item-link\b/.test(match[1])) continue;
      const href = /\bhref\s*=\s*"([^"]*)"/i.exec(match[1])?.[1];
      if (!href) continue;
      return {
        url: absoluteUrl(href, origin),
        name: cleanName(decodeEntities(stripTags(match[2]))),
      };
    }
    return null;
  };

  const segments = html.split(/<li\b[^>]*\bproduct__item\b[^>]*>/i).slice(1);
  for (const segment of segments) {
    const anchor = anchorOf(segment);
    if (!anchor?.url) continue;
    const id =
      /data-product-id="(\d+)"/.exec(segment)?.[1] ??
      /name="product"\s+value="(\d+)"/.exec(segment)?.[1];
    if (id && !byId.has(id)) byId.set(id, anchor.url);
    if (anchor.name && !byName.has(anchor.name.toLowerCase())) {
      byName.set(anchor.name.toLowerCase(), anchor.url);
    }
  }
  // A theme change that drops the tile wrapper still leaves the links.
  if (byId.size === 0) {
    for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const anchor = anchorOf(match[0]);
      if (
        anchor?.url &&
        anchor.name &&
        !byName.has(anchor.name.toLowerCase())
      ) {
        byName.set(anchor.name.toLowerCase(), anchor.url);
      }
    }
  }
  return { byId, byName };
}

/** The `ecommerce.items` list of dl4Objects, the toolbar and the links of a page. */
export function parseListingPage(html, origin) {
  let data;
  try {
    data = JSON.parse(extractAssignedJson(html, "var dl4Objects"));
  } catch (error) {
    if (error instanceof MalformedError) throw error;
    throw new MalformedError(`dl4Objects is not valid JSON (${error.message})`);
  }
  const holder = (Array.isArray(data) ? data : [data]).find((entry) =>
    Array.isArray(entry?.ecommerce?.items),
  );
  if (!holder) {
    throw new MalformedError("ecommerce.items must be a list");
  }
  return {
    items: holder.ecommerce.items.filter(
      (item) => item && typeof item === "object",
    ),
    toolbar: parseToolbar(html),
    links: parseProductLinks(html, origin),
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export function examCodeOf(name) {
  return /([A-Z]{2,3}-\d+)/.exec(name)?.[1] ?? "";
}

/** Every exam code in a name ("Bundle ... (AZ-900 + AZ-204)"), in order. */
export function examCodesOf(name) {
  return [...new Set(name.match(/\b[A-Z]{2,3}-\d{2,4}\b/g) ?? [])];
}

/**
 * assessment / practice-test / certkit / bundle / unknown. The category fields
 * are not reliable (bundles have none, some certkits only the second one), so
 * the name decides when they do not.
 */
export function classifyProduct(item, name = cleanName(item?.item_name)) {
  const categories = [
    item?.item_category,
    item?.item_category2,
    item?.item_category3,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/^bundle\b/i.test(name)) return "bundle";
  if (/certkit/i.test(categories) || /^certkit\b/i.test(name)) return "certkit";
  if (
    /assessment/i.test(categories) ||
    /^(?:microsoft )?assessment\b/i.test(name)
  ) {
    return "assessment";
  }
  if (/practice test/i.test(categories) || /practice test/i.test(name)) {
    return "practice-test";
  }
  if (/bundle/i.test(categories)) return "bundle";
  return "unknown";
}

export function productKey(product) {
  const id = String(product.id ?? "").trim();
  if (id) return id;
  return `${product.type ?? ""}|${cleanName(product.name).toLowerCase()}`;
}

/** The record kept in the baseline (and the shape read back from it). */
export function storedProduct(product) {
  return {
    name: cleanName(product.name),
    id: String(product.id ?? "").trim(),
    examCode: product.examCode ?? examCodeOf(cleanName(product.name)),
    type: product.type ?? "unknown",
    url: product.url ?? "",
  };
}

/** True when MeasureUp marks the product retired, in its name or its category. */
export function isRetired(item, name = cleanName(item?.item_name)) {
  if (RETIRED_RE.test(name)) return true;
  return [item?.item_category, item?.item_category2, item?.item_category3].some(
    (value) => typeof value === "string" && RETIRED_RE.test(value),
  );
}

export function buildProduct(item, links) {
  const name = cleanName(item.item_name);
  const id = String(item.item_id ?? "").trim();
  return {
    name,
    id,
    examCode: examCodeOf(name),
    type: classifyProduct(item, name),
    url: links.byId.get(id) ?? links.byName.get(name.toLowerCase()) ?? "",
    retired: isRetired(item, name),
  };
}

/**
 * Bundles are not tracked: MeasureUp lists them without a category, and the exam
 * pages have no place for them. An older baseline stored them with type "unknown",
 * so the name decides too.
 */
export function isBundle(product) {
  return product.type === "bundle" || /^bundle\b/i.test(product.name ?? "");
}

/** A product the monitor follows: active (not retired) and not a bundle. */
export function isTracked(product) {
  return !product.retired && !isBundle(product);
}

const compareProducts = (a, b) =>
  byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id);

// ---------------------------------------------------------------------------
// Fetching (polite: one request at a time, a pause, retry with backoff)
// ---------------------------------------------------------------------------
function makeDeadline(ms) {
  const end = Date.now() + ms;
  return () => {
    if (Date.now() > end) {
      throw new ExtractionError(
        `The run deadline (${Math.round(ms / 1000)} s) ran out while reading MeasureUp; nothing was written.`,
      );
    }
  };
}

/** One listing page; throws ExtractionError once every attempt failed. */
async function fetchListingHtml(cfg, url, label, checkDeadline) {
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    checkDeadline();
    let retryAfter = null;
    try {
      stats.requests++;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      retryAfter = response.headers.get("retry-after");
      const body = await response.text();
      if (response.ok && body.includes("var dl4Objects")) return body;
      reason = response.ok
        ? "the page has no product data"
        : `HTTP ${response.status}`;
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
    `Failed to fetch MeasureUp ${label} with product data (${reason}). ` +
      "The site may be down, blocking requests, or returning incomplete content; nothing was written.",
  );
}

/**
 * The URL of one listing page. The site's default order ("position") has ties,
 * so a page can repeat or skip products another page shows (July 2026: a scan
 * read 65 distinct products out of the 136 active ones); the product name is
 * unique, which makes every page a stable slice.
 */
export function pageUrl(cfg, page) {
  const url = new URL(cfg.listingUrl);
  if (cfg.listingSort && !url.searchParams.has("product_list_order")) {
    url.searchParams.set("product_list_order", cfg.listingSort);
  }
  if (page > 1) url.searchParams.set("p", String(page));
  return url.href;
}

/**
 * Reads the whole listing, once more when the scan came out short or mixed up.
 * The numbers it returns are the sound ones the failsafes use: `listed` (every
 * product, retired included) against the total the toolbar announces, never the
 * count of active products, which shrinks whenever an exam retires.
 */
export async function scanListing(cfg, checkDeadline = () => {}) {
  let lastError;
  for (let attempt = 1; attempt <= cfg.scanAttempts; attempt++) {
    try {
      return await scanListingOnce(cfg, checkDeadline);
    } catch (error) {
      if (!(error instanceof IncompleteScanError)) throw error;
      lastError = error;
      console.error(
        `WARNING: listing scan ${attempt} of ${cfg.scanAttempts} was incomplete (${error.message})`,
      );
      if (attempt < cfg.scanAttempts) {
        await sleep(
          retryDelayMs({
            attempt,
            baseMs: cfg.retryBaseMs,
            maxMs: cfg.maxRetryAfterMs,
          }),
        );
      }
    }
  }
  throw lastError;
}

async function scanListingOnce(cfg, checkDeadline) {
  const origin = new URL(cfg.listingUrl).origin;
  const listed = new Map();
  let duplicates = 0;

  const firstHtml = await fetchListingHtml(
    cfg,
    pageUrl(cfg, 1),
    "page 1",
    checkDeadline,
  );
  const parseOrFail = (html, label) => {
    try {
      return parseListingPage(html, origin);
    } catch (error) {
      if (error instanceof MalformedError) {
        throw new MalformedError(
          `MeasureUp product data on ${label} was malformed (${error.message}); nothing was written.`,
        );
      }
      throw error;
    }
  };

  let page = parseOrFail(firstHtml, "page 1");
  if (!page.toolbar || !(page.toolbar.total > 0)) {
    throw new ExtractionError(
      "MeasureUp extraction failed: the product count could not be read from the page toolbar " +
        "(the HTML probably changed); nothing was written.",
    );
  }
  const announced = page.toolbar.total;
  if (announced < cfg.minListed) {
    throw new ExtractionError(
      `MeasureUp extraction failed. Got total=${announced} (expected at least ${cfg.minListed}); nothing was written.`,
    );
  }
  const pageSize =
    page.toolbar.to >= page.toolbar.from
      ? page.toolbar.to - page.toolbar.from + 1
      : DEFAULT_PAGE_SIZE;
  const pages = Math.ceil(announced / pageSize);
  if (pages > cfg.maxPages) {
    throw new ExtractionError(
      `MeasureUp lists ${announced} products over ${pages} pages (limit ${cfg.maxPages}); ` +
        "the page size probably changed. Nothing was written.",
    );
  }
  console.log(`Found ${announced} products across ${pages} pages`);

  let lastTotal = announced;
  for (let number = 1; number <= pages; number++) {
    if (number > 1) {
      await sleep(cfg.fetchDelayMs);
      console.log(`Fetching page ${number}/${pages}...`);
      page = parseOrFail(
        await fetchListingHtml(
          cfg,
          pageUrl(cfg, number),
          `page ${number}`,
          checkDeadline,
        ),
        `page ${number}`,
      );
    }
    const { toolbar } = page;
    const firstShown = (number - 1) * pageSize + 1;
    if (toolbar && toolbar.from !== firstShown) {
      throw new IncompleteScanError(
        `MeasureUp page ${number} of ${pages} shows items ${toolbar.from}-${toolbar.to} instead of ${firstShown}-${Math.min(number * pageSize, announced)}; ` +
          "the listing pages overlap or the page number was ignored. Nothing was written.",
      );
    }
    const expected =
      toolbar && toolbar.to >= toolbar.from
        ? toolbar.to - toolbar.from + 1
        : number < pages
          ? pageSize
          : announced - pageSize * (pages - 1);
    if (page.items.length < Math.ceil((expected * cfg.pageCollapsePct) / 100)) {
      throw new ExtractionError(
        `MeasureUp page ${number} of ${pages} yielded ${page.items.length} of the ${expected} products expected there; ` +
          "the per-page product count collapsed (HTML or data structure probably changed). Nothing was written.",
      );
    }
    if (toolbar?.total > 0) lastTotal = toolbar.total;

    for (const item of page.items) {
      const product = buildProduct(item, page.links);
      if (!product.name) {
        console.error(
          `WARNING: skipped a product without a name on page ${number} (id "${product.id}").`,
        );
        continue;
      }
      const key = productKey(product);
      if (listed.has(key)) {
        duplicates++;
        continue;
      }
      listed.set(key, product);
    }
  }

  const shortfall = lastTotal - listed.size;
  if (shortfall > (lastTotal * cfg.maxShortfallPct) / 100) {
    throw new IncompleteScanError(
      `MeasureUp announced ${lastTotal} products but only ${listed.size} were read (${duplicates} repeated); ` +
        "the scan is too incomplete to trust. Nothing was written.",
    );
  }
  if (listed.size < cfg.minListed) {
    throw new ExtractionError(
      `MeasureUp extraction partially failed. Got ${listed.size} products (expected at least ${cfg.minListed}). ` +
        "The scan was ignored so the baseline was not changed and no notification was sent.",
    );
  }
  const complete = shortfall <= 0;
  if (!complete) {
    warnLoud(
      `the scan read ${listed.size} of ${lastTotal} announced products (${duplicates} duplicates, probably a product ` +
        "added while the pages were read): new products are reported, but no product is removed from the baseline this run.",
      { title: ANNOTATION_TITLE },
    );
  }
  const withUrl = [...listed.values()].filter((product) => product.url).length;
  return {
    listed,
    announced: lastTotal,
    complete,
    duplicates,
    pages,
    urlCoveragePct: listed.size ? (withUrl * 100) / listed.size : 0,
  };
}

// ---------------------------------------------------------------------------
// Baseline and the comparison
// ---------------------------------------------------------------------------
function loadBaseline(cfg) {
  const rel = relative(root, cfg.baselineFile) || cfg.baselineFile;
  if (!existsSync(cfg.baselineFile)) return { exists: false, products: [] };
  const raw = readFileSync(cfg.baselineFile, "utf8").trim();
  if (!raw) return { exists: false, products: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExtractionError(
      `Corrupt MeasureUp baseline at ${rel} (invalid JSON). The baseline was not modified.`,
    );
  }
  if (!Array.isArray(parsed?.products)) {
    throw new ExtractionError(
      `Corrupt MeasureUp baseline at ${rel} (missing products array). The baseline was not modified.`,
    );
  }
  const staleHubLinks =
    parsed.staleHubLinks &&
    typeof parsed.staleHubLinks === "object" &&
    !Array.isArray(parsed.staleHubLinks)
      ? parsed.staleHubLinks
      : undefined;
  const products = parsed.products.map(storedProduct);
  return {
    exists: products.length > 0,
    products,
    staleHubLinks,
    lastChecked: parsed.lastChecked,
  };
}

/**
 * The comparison by SET of product keys. `removed` is informational: products the
 * scan shows as retired, and (only when the scan read everything) products that
 * are no longer listed. A product the scan simply did not see is carried over.
 */
export function diffProducts(previous, scan) {
  const previousByKey = new Map(
    previous
      .filter((product) => !isBundle(product))
      .map((product) => [productKey(product), product]),
  );
  const active = [...scan.listed.values()].filter(isTracked);
  const activeKeys = new Set(active.map(productKey));

  const added = active.filter(
    (product) => !previousByKey.has(productKey(product)),
  );
  const removed = [];
  const carried = [];
  for (const [key, product] of previousByKey) {
    if (activeKeys.has(key)) continue;
    const seen = scan.listed.get(key);
    if (seen?.retired) {
      removed.push({
        ...product,
        reason: "retired",
        url: seen.url || product.url,
      });
    } else if (scan.complete) {
      removed.push({ ...product, reason: "unlisted" });
    } else {
      carried.push(product);
    }
  }

  const refreshed = active.map((product) => {
    const stored = storedProduct(product);
    const old = previousByKey.get(productKey(product));
    // A tile that lost its link for one run must not rewrite the baseline.
    if (!stored.url && old?.url) stored.url = old.url;
    return stored;
  });
  const next = [...refreshed, ...carried].sort(compareProducts);
  return {
    active,
    added: added.sort(compareProducts),
    removed: removed.sort(compareProducts),
    carried,
    next,
  };
}

/** How the listed products split: followed, retired, and bundles (not followed). */
export function countListing(scan, diff) {
  const all = [...scan.listed.values()];
  return {
    listed: all.length,
    tracked: diff.active.length,
    retired: all.filter((product) => product.retired).length,
    bundles: all.filter((product) => !product.retired && isBundle(product))
      .length,
  };
}

/** The part of the baseline that decides whether it needs rewriting. */
function baselineContent(products, staleHubLinks) {
  return JSON.stringify({
    products: products.map(storedProduct).sort(compareProducts),
    staleHubLinks: hasEntries(staleHubLinks) ? staleHubLinks : null,
  });
}

const hasEntries = (object) =>
  Boolean(object) && Object.keys(object).length > 0;

function baselineText(products, staleHubLinks) {
  const body = {
    lastChecked: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    totalProducts: products.length,
  };
  if (hasEntries(staleHubLinks)) body.staleHubLinks = staleHubLinks;
  body.products = products;
  return JSON.stringify(body, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// The hub's own MeasureUp links
// ---------------------------------------------------------------------------
/** Same text, comments blanked out, line numbers kept. */
export function stripComments(text) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
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

/** Lower-case path of a URL without query, fragment or trailing slash. */
const pathOf = (rawUrl) => {
  try {
    return new URL(rawUrl).pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
};

/**
 * The MeasureUp links of the exam docs: a Map path -> {path, locations}. Product
 * pages and the generic ones (the subscription plans) both count; the listing
 * page itself, which every run reads anyway, does not, and neither do links
 * inside comments.
 */
export function scanHubLinks(docsDir, listingPath = "/microsoft.html") {
  const links = new Map();
  const files = walkFiles(docsDir, (name) => /\.mdx?$/i.test(name));
  const urlRe = /https?:\/\/(?:www\.)?measureup\.com\/[^\s"'<>`)\]}]*/gi;
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    const rel = `${DOCS_PREFIX}/${relative(docsDir, file).split("\\").join("/")}`;
    for (const match of text.matchAll(urlRe)) {
      const raw = match[0].replace(/[.,;:!]+$/, "");
      const path = pathOf(raw);
      if (!path || path === "/" || path === listingPath) continue;
      const line = text.slice(0, match.index).split("\n").length;
      // `path` is the comparison key (lower case); the probe asks for the path
      // as written in the page.
      const entry = links.get(path) ?? {
        path,
        probePath: new URL(raw).pathname,
        locations: [],
      };
      entry.locations.push({ file: rel, line });
      links.set(path, entry);
    }
  }
  return links;
}

/** Exam code -> hub page path, from docs/<area>/<CODE>.mdx. */
export function findExamPages(docsDir) {
  const pages = new Map();
  let areas;
  try {
    areas = readdirSync(docsDir, { withFileTypes: true });
  } catch {
    return pages;
  }
  for (const area of areas) {
    if (!area.isDirectory()) continue;
    let files;
    try {
      files = readdirSync(join(docsDir, area.name));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^([A-Z]{2,3}-\d+[A-Z]?)\.mdx$/.exec(file);
      if (match) pages.set(match[1], `${DOCS_PREFIX}/${area.name}/${file}`);
    }
  }
  return pages;
}

/** Hub links split by what the listing alone says about them. */
export function classifyHubLinks(links, scan) {
  const byPath = new Map();
  for (const product of scan.listed.values()) {
    if (!product.url) continue;
    const path = pathOf(product.url);
    if (path && !byPath.has(path)) byPath.set(path, product);
  }
  const ok = [];
  const retired = [];
  const toProbe = [];
  for (const link of links.values()) {
    const product = byPath.get(link.path);
    if (!product) toProbe.push(link);
    else if (product.retired) retired.push({ ...link, product });
    else ok.push(link);
  }
  return { ok, retired, toProbe, byPath };
}

/** One GET of a hub link the listing does not show. Never throws. */
export async function probeHubLink(cfg, path) {
  const url = cfg.siteOrigin + path;
  const key = pathOf(url);
  try {
    stats.requests++;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
      redirect: "follow",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    try {
      await response.body?.cancel();
    } catch {
      /* the status is all that is needed */
    }
    if (response.status === 404 || response.status === 410) {
      return { state: "not-found", status: response.status };
    }
    if (response.ok) {
      const finalPath = pathOf(response.url);
      if (finalPath && finalPath !== key) {
        return {
          state: "redirected",
          target: response.url,
          targetPath: finalPath,
        };
      }
      return { state: "unlisted" };
    }
    return { state: "unverified", reason: `HTTP ${response.status}` };
  } catch (error) {
    return { state: "unverified", reason: error?.message ?? String(error) };
  }
}

/**
 * The exam-page links to review, with their state. Flagged problems (retired,
 * redirected, not-found) are remembered in the baseline; "unlisted" (the page
 * still answers) and "unverified" (the probe failed) are shown but never flagged.
 */
export async function checkHubLinks(
  cfg,
  scan,
  links,
  checkDeadline = () => {},
) {
  const { ok, retired, toProbe, byPath } = classifyHubLinks(links, scan);
  const results = [];
  for (const link of retired) {
    results.push({
      link,
      problem: "retired",
      detail: "MeasureUp lists this product as retired",
    });
  }

  const probes = toProbe.slice(0, cfg.maxHubProbes);
  let outOfTime = false;
  for (const link of probes) {
    if (!outOfTime) {
      try {
        checkDeadline();
      } catch {
        outOfTime = true;
      }
    }
    if (outOfTime) {
      results.push({
        link,
        problem: "unverified",
        detail: "not checked (the run deadline ran out)",
      });
      continue;
    }
    await sleep(cfg.fetchDelayMs);
    const outcome = await probeHubLink(cfg, link.probePath ?? link.path);
    if (outcome.state === "not-found") {
      results.push({
        link,
        problem: "not-found",
        detail: `page not found (HTTP ${outcome.status})`,
      });
    } else if (outcome.state === "redirected") {
      const target = byPath.get(outcome.targetPath);
      results.push({
        link,
        problem: "redirected",
        target: outcome.target,
        targetProduct: target,
        detail: target
          ? `redirects to ${markdownUrl(outcome.targetPath)}${target.retired ? ", which is marked retired" : ""}`
          : `redirects to ${markdownUrl(outcome.targetPath)}, which is not a listed product`,
      });
    } else if (outcome.state === "unlisted") {
      // Healthy: the page opens, it just is not a product of the listing (the
      // subscription plans) or MeasureUp does not list it.
      results.push({
        link,
        problem: "open",
        detail: "the page opens but is not in the product listing",
      });
    } else {
      results.push({
        link,
        problem: "unverified",
        detail: `could not be checked (${outcome.reason})`,
      });
    }
  }
  for (const link of toProbe.slice(cfg.maxHubProbes)) {
    results.push({
      link,
      problem: "unverified",
      detail: `not checked (more than ${cfg.maxHubProbes} links to probe in one run)`,
    });
  }
  const count = (problem) =>
    results.filter((result) => result.problem === problem).length;
  return {
    checked: links.size,
    okCount: ok.length,
    openCount: count("open"),
    unverifiedCount: count("unverified"),
    results,
  };
}

const FLAGGED = new Set(["retired", "redirected", "not-found"]);

/**
 * Remembers what was already reported: `next` is the state to store (flagged
 * links only, so a fixed link drops out), `fresh` the findings to report now.
 */
export function diffHubState(previousState, results, today) {
  const previous = previousState ?? {};
  const next = {};
  const fresh = [];
  let known = 0;
  for (const result of results) {
    const before = previous[result.link.path];
    if (result.problem === "unverified" && before) {
      // A probe that failed is no evidence that the link was fixed: keep what
      // is known, so the next successful probe does not report it a second time.
      next[result.link.path] = before;
      known++;
      continue;
    }
    if (!FLAGGED.has(result.problem)) continue;
    next[result.link.path] = {
      problem: result.problem,
      since: before?.problem === result.problem ? before.since : today,
    };
    if (before?.problem === result.problem) known++;
    else fresh.push(result);
  }
  const sorted = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => byCodePoint(a, b)),
  );
  return { next: sorted, fresh, known };
}

/**
 * A replacement matched by exam code and kind of product only. It is a lead for
 * the maintainer, never a verified fix.
 */
export function suggestReplacements(path, scan) {
  const code = /(?:^|[-/])([a-z]{2,3})-(\d{2,4})(?=-|\.|$)/.exec(path);
  if (!code) return [];
  const examCode = `${code[1]}-${code[2]}`.toUpperCase();
  const type = /certkit/.test(path)
    ? "certkit"
    : /assessment/.test(path)
      ? "assessment"
      : /practice-test|exam/.test(path)
        ? "practice-test"
        : null;
  return [...scan.listed.values()]
    .filter(
      (product) =>
        !product.retired &&
        product.url &&
        examCodesOf(product.name).includes(examCode) &&
        (type === null || product.type === type),
    )
    .sort(compareProducts)
    .slice(0, 2);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
/**
 * A name taken from a web page, for a heading or a table cell of a public issue:
 * no HTML, links or code spans, and no @mention or #123 cross-reference.
 */
export function safeText(text) {
  return cleanName(
    cleanName(text)
      .replace(/[<>`[\]|]/g, " ")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE),
  );
}

/** A URL from the web, safe inside a Markdown link, a code span and a table cell. */
function markdownUrl(url) {
  return url.replace(
    /[ ()|`<>\r\n]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function withTracking(url) {
  return url.includes("#") ? url : url + TRACKING_FRAGMENT;
}

function linkCell(url) {
  return url ? `[Link](${markdownUrl(withTracking(url))})` : "—";
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

function typeRank(type) {
  const index = TYPE_ORDER.indexOf(type);
  return index < 0 ? TYPE_ORDER.length : index;
}

function hubPagesFor(name, examPages) {
  const codes = examCodesOf(name);
  const pages = codes.filter((code) => examPages.has(code));
  if (pages.length > 0) {
    return pages.map((code) => `\`${examPages.get(code)}\``).join("<br>");
  }
  return codes.length > 0 ? `no hub page for ${codes[0]}` : "—";
}

function linkedOn(product, hubLinks) {
  const path = product.url ? pathOf(product.url) : null;
  const entry = path ? hubLinks?.get(path) : null;
  if (!entry) return "not linked";
  const files = [...new Set(entry.locations.map((loc) => loc.file))];
  return files.map((file) => `\`${file}\``).join("<br>");
}

function locationsCell(link) {
  const shown = link.locations
    .slice(0, 3)
    .map((loc) => `\`${loc.file}:${loc.line}\``);
  const more = link.locations.length - shown.length;
  return shown.join("<br>") + (more > 0 ? `<br>+${more} more` : "");
}

function suggestionCell(result, scan) {
  if (result.target) {
    return result.targetProduct && !result.targetProduct.retired
      ? `Use \`${markdownUrl(withTracking(result.target))}\``
      : "Find the current product on MeasureUp, or remove the link";
  }
  const suggestions = suggestReplacements(result.link.path, scan);
  if (suggestions.length === 0) {
    return "No active product with this exam code and kind is listed: remove the link, or say that MeasureUp has no material yet";
  }
  return (
    "Likely: " +
    suggestions
      .map((product) => `\`${markdownUrl(withTracking(product.url))}\``)
      .join(" or ") +
    " (matched by exam code and kind only: open it first)"
  );
}

export function buildIssueTitle({ added, fresh }) {
  const parts = [];
  if (added.length > 0) {
    const codes = [
      ...new Set(
        added.flatMap((product) =>
          product.examCode ? [product.examCode] : [],
        ),
      ),
    ].sort(byCodePoint);
    const shown = codes.slice(0, 4);
    const rest = codes.length - shown.length;
    parts.push(
      `${plural(added.length, "new product")}` +
        (shown.length > 0
          ? ` (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})`
          : ""),
    );
  }
  if (fresh.length > 0) {
    parts.push(`${plural(fresh.length, "stale exam page link")}`);
  }
  return `MeasureUp: ${parts.join("; ")}`.slice(0, 200);
}

export function buildReport({
  cfg,
  scan,
  diff,
  hubFresh,
  hubKnown,
  hubLinks,
  examPages,
}) {
  const counts = countListing(scan, diff);
  const lines = [
    "## MeasureUp changes detected",
    "",
    `MeasureUp lists ${counts.listed} Microsoft products on ${cfg.today}: ${counts.tracked} followed by this monitor, ${counts.retired} marked \`[Retired Exam]\` and ${counts.bundles} bundles (not tracked). ` +
      "The baseline is `src/data_files/measureup-products.json`; it is refreshed by the same run, so each change is reported once.",
    "",
  ];

  if (diff.added.length > 0) {
    lines.push(`### New products (${diff.added.length})`, "");
    lines.push(
      "| Product | Exam | Type | Hub page | Already linked on | MeasureUp |",
      "|---------|------|------|----------|-------------------|-----------|",
    );
    const rows = [...diff.added]
      .sort(
        (a, b) =>
          typeRank(a.type) - typeRank(b.type) ||
          byCodePoint(a.examCode, b.examCode) ||
          compareProducts(a, b),
      )
      .map(
        (product) =>
          `| ${safeText(product.name)} | ${product.examCode || "—"} | ${product.type} | ` +
          `${hubPagesFor(product.name, examPages)} | ${linkedOn(product, hubLinks)} | ${linkCell(product.url)} |`,
      );
    lines.push(...limitRows(rows), "");
  }

  if (hubFresh.length > 0) {
    lines.push(
      `### Exam page links to review (${hubFresh.length}, informational)`,
      "",
      "These links in `src/content/docs` point to MeasureUp products that are no longer in the active product listing. " +
        "Each is reported once; fixed links drop out of the baseline by themselves.",
      "",
      "| Link | Problem | Used in | Suggestion |",
      "|------|---------|---------|------------|",
    );
    const rows = hubFresh.map(
      (result) =>
        `| \`${result.link.path}\` | ${result.detail} | ${locationsCell(result.link)} | ${suggestionCell(result, scan)} |`,
    );
    lines.push(...limitRows(rows), "");
    if (hubKnown > 0) {
      lines.push(
        `${plural(hubKnown, "link")} reported in an earlier run ${hubKnown === 1 ? "is" : "are"} still stale and not repeated here.`,
        "",
      );
    }
  }

  if (diff.removed.length > 0) {
    lines.push(
      `### Products no longer active (${diff.removed.length}, informational)`,
      "",
      "These were in the baseline and are now retired or gone from the listing. They are dropped from the baseline; nothing to do unless an exam page still links them.",
      "",
      "| Product | Exam | Why | Hub page |",
      "|---------|------|-----|----------|",
      ...limitRows(
        diff.removed.map(
          (product) =>
            `| ${safeText(product.name)} | ${product.examCode || "—"} | ${
              product.reason === "retired"
                ? "marked [Retired Exam]"
                : "no longer listed"
            } | ${hubPagesFor(product.name, examPages)} |`,
        ),
      ),
      "",
    );
  }

  lines.push("### What to do", "");
  let step = 1;
  if (diff.added.length > 0) {
    lines.push(
      `${step++}. For each new product, open its MeasureUp page and confirm it is current, then add it to the exam page named in the table: ` +
        'the assessment and practice test go in the Tests tab and in the bottom `MeasureUp Practice Tests` card (or the `MeasureUpCard` props), the certkit in the Paid tab (see "Exam Page Anatomy" in `AGENTS.md`). ' +
        `Copy the URL from the MeasureUp column (MeasureUp does not build it from the product name), keep the \`${TRACKING_FRAGMENT}\` fragment and the canonical \`MeasureUp ...\` link titles. A product for an exam without a hub page needs no action until that page exists.`,
    );
  }
  if (hubFresh.length > 0) {
    lines.push(
      `${step++}. For each stale link, open the suggested replacement on MeasureUp and update the file and line named in the table; if MeasureUp has no product for the exam any more, remove the link (a retiring exam page may keep a retired product only while its page still opens).`,
    );
  }
  if (diff.added.length > 0 || hubFresh.length > 0) {
    lines.push(
      `${step++}. Run \`node scripts/audit-missing-resources.mjs\`, commit the regenerated \`src/data_files/missing-resources.json\` with the page edits, then run \`pnpm build\`.`,
    );
  }
  lines.push(
    "",
    'See the "MeasureUp Monitor" runbook (`docs/monitors/measureup.md`) for the full process.',
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
    new_products: 0,
    stale_links: 0,
  });
  process.exit(1);
}

export async function main(cfg) {
  console.log("=== MeasureUp Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);
  // Never publish a stale report or error.
  rmSync(cfg.reportFile, { force: true });
  rmSync(cfg.errorFile, { force: true });

  const baseline = loadBaseline(cfg);
  const silent = !baseline.exists || cfg.forceBaseline;
  const checkDeadline = makeDeadline(cfg.deadlineMs);

  const scan = await scanListing(cfg, checkDeadline);
  const diff = diffProducts(baseline.products, scan);
  const counts = countListing(scan, diff);
  console.log(
    `Extracted ${counts.listed} unique products (${counts.tracked} tracked, ${counts.retired} retired, ${counts.bundles} bundles not tracked)`,
  );
  if (diff.active.length < cfg.minActive) {
    throw new ExtractionError(
      `Only ${diff.active.length} of ${counts.listed} listed products are active (expected at least ${cfg.minActive}); ` +
        "the retired marker in the names probably changed. Nothing was written.",
    );
  }

  // Failsafes on sound numbers: a share of the active set, and a share of the
  // baseline. Never on a bare count, which moves with every retirement.
  if (!silent && baseline.products.length >= PCT_MIN_BASE) {
    const newPct = (diff.added.length * 100) / diff.active.length;
    if (newPct > cfg.maxNewPct) {
      throw new ExtractionError(
        `MeasureUp monitor detected ${diff.added.length} new products (${Math.round(newPct)}% of ${diff.active.length} active). ` +
          `This exceeds the ${cfg.maxNewPct}% threshold, suggesting the HTML or the product ids changed. ` +
          "Nothing was written. If the change is real, run the workflow with force_baseline enabled.",
      );
    }
    const removedPct = (diff.removed.length * 100) / baseline.products.length;
    if (removedPct > cfg.maxRemovedPct) {
      throw new ExtractionError(
        `${diff.removed.length} of ${baseline.products.length} baseline products vanished at once (${Math.round(removedPct)}%, ` +
          `threshold ${cfg.maxRemovedPct}%), suggesting the HTML or the product ids changed. ` +
          "Nothing was written. If the change is real, run the workflow with force_baseline enabled.",
      );
    }
  }

  // The hub's own links.
  const examPages = findExamPages(cfg.docsDir);
  const listingPath = pathOf(cfg.listingUrl) ?? "/microsoft.html";
  const hubLinks = scanHubLinks(cfg.docsDir, listingPath);
  let hub = null;
  let hubState = baseline.staleHubLinks;
  let hubDiff = { next: hubState, fresh: [], known: 0 };
  if (cfg.hubLinkCheck) {
    if (scan.urlCoveragePct < MIN_URL_COVERAGE_PCT) {
      warnLoud(
        `only ${Math.round(scan.urlCoveragePct)}% of the listed products have a product URL, so the product tiles probably changed shape; ` +
          "the hub link check was skipped this run and its remembered findings were kept.",
        { title: ANNOTATION_TITLE },
      );
    } else {
      hub = await checkHubLinks(cfg, scan, hubLinks, checkDeadline);
      hubDiff = diffHubState(
        baseline.exists ? baseline.staleHubLinks : undefined,
        hub.results,
        cfg.today,
      );
      hubState = hubDiff.next;
    }
  }

  // Decide.
  const hubFresh = silent ? [] : hubDiff.fresh;
  const changesFound =
    !silent && (diff.added.length > 0 || hubFresh.length > 0);
  const nextProducts = diff.next;
  const nextContent = baselineContent(nextProducts, hubState);
  const previousContent = baseline.exists
    ? baselineContent(baseline.products, baseline.staleHubLinks)
    : null;
  const baselineChanged = nextContent !== previousContent;

  let issueTitle = "";
  if (changesFound) {
    issueTitle = buildIssueTitle({ added: diff.added, fresh: hubFresh });
    writeFileSync(
      cfg.reportFile,
      buildReport({
        cfg,
        scan,
        diff,
        hubFresh,
        hubKnown: hubDiff.known,
        hubLinks,
        examPages,
      }),
      "utf8",
    );
  }
  if (baselineChanged) {
    writeFileSync(
      cfg.baselineFile,
      baselineText(nextProducts, hubState),
      "utf8",
    );
  }

  const staleNow = hub
    ? hub.results.filter((result) => FLAGGED.has(result.problem)).length
    : 0;
  for (const result of hub?.results ?? []) {
    if (FLAGGED.has(result.problem)) {
      console.log(
        `Hub link ${result.problem}: ${result.link.path} (${result.detail})`,
      );
    }
  }
  const unverified = (hub?.results ?? []).filter(
    (result) => result.problem === "unverified",
  );
  if (unverified.length > 0) {
    const shown = unverified
      .slice(0, 5)
      .map((result) => `${result.link.path} (${result.detail})`)
      .join("; ");
    warnLoud(
      `${plural(unverified.length, "hub link")} not confirmed this run, so left as they were: ${shown}` +
        (unverified.length > 5 ? `; and ${unverified.length - 5} more` : ""),
      { title: ANNOTATION_TITLE },
    );
  }
  console.log(
    `New products: ${diff.added.length} · no longer active: ${diff.removed.length} · ` +
      `hub links checked: ${hub ? hub.checked : "skipped"}, stale: ${staleNow}` +
      (hubFresh.length > 0 ? ` (${hubFresh.length} newly reported)` : ""),
  );
  if (silent && diff.added.length > 0) {
    console.log(
      baseline.exists
        ? `FORCE_BASELINE: ${diff.added.length} new products accepted silently.`
        : `No baseline found. Created it with ${nextProducts.length} products; no issue is opened.`,
    );
  }
  for (const product of diff.removed) {
    console.log(
      `No longer active: ${product.name} (${product.reason === "retired" ? "marked retired" : "not listed"})`,
    );
  }
  console.log(
    changesFound
      ? `Found ${diff.added.length} new products and ${hubFresh.length} newly stale hub links!`
      : "No alert.",
  );
  console.log(baselineChanged ? "Baseline updated" : "Baseline unchanged");
  console.log(`HTTP requests: ${stats.requests}`);

  const summary = [
    `- Listed ${counts.listed} products: ${counts.tracked} tracked, ${counts.retired} retired, ${counts.bundles} bundles (not tracked).`,
    `- New: ${diff.added.length}${silent && diff.added.length > 0 ? " (accepted silently)" : ""}. No longer active: ${diff.removed.length}.`,
    hub
      ? `- Hub links: ${hub.checked} checked, ${staleNow} stale (${hubDiff.known} already reported), ${hub.openCount} not listed but open, ${hub.unverifiedCount} could not be checked.`
      : "- Hub links: not checked this run.",
    `- Baseline ${baselineChanged ? "updated" : "unchanged"}.`,
  ];
  for (const product of diff.removed.slice(0, 40)) {
    summary.push(
      `  - no longer active: ${safeText(product.name)} (${product.reason === "retired" ? "retired" : "not listed"})`,
    );
  }
  appendStepSummary(
    cfg.stepSummary,
    `### MeasureUp Monitor\n\n${summary.join("\n")}\n`,
  );

  writeOutput(cfg.githubOutput, {
    changes_found: changesFound,
    baseline_updated: baselineChanged,
    extraction_failed: false,
    issue_title: issueTitle,
    new_products: silent ? 0 : diff.added.length,
    stale_links: hubFresh.length,
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
