#!/usr/bin/env node
/**
 * Weekly sync of Microsoft's "voucher challenge" / sweepstakes pages.
 *
 * Usage:
 *   node scripts/voucher-challenge-sync.mjs
 *
 * Microsoft periodically publishes limited-time promotional pages (tied to
 * events like Ignite, Build, or a product launch) that give away discounted
 * or free certification exam vouchers through a sweepstakes/challenge. These
 * live as top-level entries in the Microsoft Learn "Credentials support" nav
 * tree, alongside the site's permanent/evergreen help sections, and have no
 * dedicated API of their own.
 *
 * Data source: https://learn.microsoft.com/en-us/credentials/toc.json — the
 * TOC behind https://learn.microsoft.com/credentials/support/*. Evergreen
 * sections (e.g. "Earn a certification", "Program information") are always
 * nested with children of their own topic; every promotional voucher/
 * challenge/sweepstakes page observed so far is a bare top-level node (or a
 * top-level node whose children are exactly Official Rules/FAQ/How to
 * redeem), so matching top-level items by title keyword is a clean signal
 * with no observed false positives.
 *
 * Writes src/data_files/voucher-challenges.json — an append-only historical
 * record (entries are never removed, since Microsoft appears to keep old
 * campaign pages in the nav indefinitely rather than retiring them).
 *
 * Env overrides (defaults shown):
 *   TOC_URL             https://learn.microsoft.com/en-us/credentials/toc.json
 *   BASELINE_FILE       src/data_files/voucher-challenges.json
 *   REPORT_FILE         <tmpdir>/voucher-challenge-report.md
 *   ERROR_FILE          <tmpdir>/voucher-challenge-error.md
 *   GITHUB_OUTPUT       <tmpdir>/github-output
 *   MIN_TOP_LEVEL_ITEMS 15
 *   MAX_DROP_PCT        50
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const TOC_URL =
  process.env.TOC_URL ?? "https://learn.microsoft.com/en-us/credentials/toc.json";
const BASELINE_FILE = resolveFromRoot(
  process.env.BASELINE_FILE ?? "src/data_files/voucher-challenges.json",
);
const REPORT_FILE =
  process.env.REPORT_FILE ?? join(tmpdir(), "voucher-challenge-report.md");
const ERROR_FILE =
  process.env.ERROR_FILE ?? join(tmpdir(), "voucher-challenge-error.md");
const GITHUB_OUTPUT =
  process.env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output");

const MIN_TOP_LEVEL_ITEMS = Number(process.env.MIN_TOP_LEVEL_ITEMS ?? 15);
const MAX_DROP_PCT = Number(process.env.MAX_DROP_PCT ?? 50);

const KEYWORD_RE = /challenge|voucher|sweepstake/i;
const TRACKING = "?WT.mc_id=studentamb_165290";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function writeOutput(obj) {
  const lines = Object.entries(obj)
    .map(([key, value]) => `${key}=${String(value).toLowerCase()}\n`)
    .join("");
  appendFileSync(GITHUB_OUTPUT, lines);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  writeFileSync(ERROR_FILE, `${message}\n`);
  writeOutput({
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
  });
  process.exit(1);
}

function pageUrl(href) {
  return `https://learn.microsoft.com/credentials/${href}${TRACKING}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sortByHref(entries) {
  return [...entries].sort((a, b) =>
    a.href.localeCompare(b.href, "en", { numeric: true }),
  );
}

// ---------------------------------------------------------------------------
// Step 1: Fetch and filter the TOC
// ---------------------------------------------------------------------------
async function fetchChallenges() {
  let response;
  try {
    response = await fetch(TOC_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    fail(
      `Failed to fetch the credentials TOC from Microsoft Learn (${error.message}). ` +
        "The site may be down or blocking requests; the baseline was not modified.",
    );
    return null;
  }

  if (!response.ok) {
    fail(
      `Failed to fetch the credentials TOC from Microsoft Learn (status ${response.status}). ` +
        "The baseline was not modified.",
    );
    return null;
  }

  let json;
  try {
    json = await response.json();
  } catch {
    fail(
      "Failed to parse the credentials TOC response as JSON. The endpoint shape may have " +
        "changed; the baseline was not modified.",
    );
    return null;
  }

  if (!Array.isArray(json.items)) {
    fail(
      "Credentials TOC response has no top-level `items` array. The endpoint shape may have " +
        "changed; the baseline was not modified.",
    );
    return null;
  }

  if (json.items.length < MIN_TOP_LEVEL_ITEMS) {
    fail(
      `Credentials TOC returned only ${json.items.length} top-level items (expected at least ` +
        `${MIN_TOP_LEVEL_ITEMS}). The endpoint shape may have changed; the baseline was not modified.`,
    );
    return null;
  }

  const challenges = [];
  for (const item of json.items) {
    const title = item.toc_title;
    if (!title || !KEYWORD_RE.test(title)) continue;

    let href = item.href;
    if (!href && Array.isArray(item.children)) {
      const officialRules = item.children.find((c) =>
        /^official rules$/i.test(c.toc_title ?? ""),
      );
      href = (officialRules ?? item.children[0])?.href;
    }
    if (!href) {
      console.error(`WARNING: "${title}" matched but has no resolvable href; skipping.`);
      continue;
    }

    challenges.push({ title, href });
  }

  console.log(
    `Scanned ${json.items.length} top-level TOC items; ${challenges.length} match as voucher challenges.`,
  );
  return challenges;
}

// ---------------------------------------------------------------------------
// Step 2: Load the baseline
// ---------------------------------------------------------------------------
function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) {
    console.log("No baseline found. Creating initial tracker...");
    return { lastSynced: null, challenges: [] };
  }

  const raw = readFileSync(BASELINE_FILE, "utf8").trim();
  if (!raw) return { lastSynced: null, challenges: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(
      `Corrupt baseline at ${relative(root, BASELINE_FILE)} (invalid JSON). The baseline was not modified.`,
    );
    return null;
  }

  if (!Array.isArray(parsed.challenges)) {
    fail(
      `Corrupt baseline at ${relative(root, BASELINE_FILE)} (missing challenges array). ` +
        "The baseline was not modified.",
    );
    return null;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Step 3: Diff against baseline
// ---------------------------------------------------------------------------
function diff(current, baseline) {
  const known = new Map(baseline.challenges.map((c) => [c.href, c]));
  const seenHrefs = new Set(current.map((c) => c.href));

  const newlyFound = [];
  const merged = [];

  for (const entry of current) {
    const prev = known.get(entry.href);
    if (prev) {
      merged.push({ ...prev, title: entry.title }); // keep firstSeen, refresh title
    } else {
      const withDate = { ...entry, firstSeen: today() };
      merged.push(withDate);
      newlyFound.push(withDate);
    }
  }

  // Append-only: keep any baseline entries that didn't show up in this run's
  // top-level scan (Microsoft appears to keep old campaign pages in the nav
  // indefinitely, but don't assume that holds forever).
  const stillMissing = baseline.challenges.filter((c) => !seenHrefs.has(c.href));
  merged.push(...stillMissing);

  return { merged: sortByHref(merged), newlyFound, stillMissing };
}

// ---------------------------------------------------------------------------
// Step 4: Report
// ---------------------------------------------------------------------------
function buildReport(newlyFound) {
  const rows = sortByHref(newlyFound)
    .map((c) => `| ${c.title} | [Link](${pageUrl(c.href)}) |`)
    .join("\n");

  return (
    "## New Microsoft voucher challenge(s) detected\n\n" +
    "The following limited-time exam voucher challenge/sweepstakes page(s) appeared in the " +
    "Microsoft Learn credentials support nav that weren't tracked before:\n\n" +
    "| Challenge | URL |\n|-----------|-----|\n" +
    rows +
    "\n\nVerify the details (discount, deadline, eligibility, country exclusions) on the linked " +
    "page, then decide whether it's worth a voucher page per the Voucher Pages conventions in " +
    "`AGENTS.md`. See the \"Voucher Challenge Monitor\" section there for the full process.\n"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Voucher Challenge Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  console.log("Fetching credentials TOC...");
  const current = await fetchChallenges();

  console.log("Loading baseline...");
  const baseline = loadBaseline();

  const { merged, newlyFound, stillMissing } = diff(current, baseline);

  const baselineCount = baseline.challenges.length;
  if (baselineCount >= 1) {
    const dropPct = (stillMissing.length * 100) / baselineCount;
    if (dropPct > MAX_DROP_PCT) {
      fail(
        `${stillMissing.length} of ${baselineCount} previously known voucher challenges vanished ` +
          `from the TOC at once (${dropPct.toFixed(1)}%), exceeding MAX_DROP_PCT — the TOC shape ` +
          "probably changed; the baseline was not modified.",
      );
      return;
    }
  }

  const next = { lastSynced: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), challenges: merged };

  const baselineExists = existsSync(BASELINE_FILE);
  const changed =
    !baselineExists ||
    JSON.stringify(sortByHref(baseline.challenges)) !== JSON.stringify(merged);

  if (changed) {
    writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  const changesFound = newlyFound.length > 0;
  if (changesFound) {
    writeFileSync(REPORT_FILE, buildReport(newlyFound), "utf8");
  }

  writeOutput({
    changes_found: changesFound,
    baseline_updated: changed,
    extraction_failed: false,
  });

  console.log(`Tracked: ${merged.length} · New this run: ${newlyFound.length}`);
  if (newlyFound.length > 0) {
    console.log(newlyFound.map((c) => ` - ${c.title}`).join("\n"));
  }
  console.log(changed ? "Baseline updated" : "Baseline unchanged");
  console.log("=== Done ===");
}

main().catch((err) => {
  fail(`Unexpected error: ${err?.stack ?? err}`);
});
