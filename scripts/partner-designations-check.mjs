#!/usr/bin/env node
/**
 * Weekly change-detection check for the Microsoft Partner solution-area
 * designation pages that back the skilling tab content in
 * src/content/docs/guide/partneremployees.mdx.
 *
 * Usage:
 *   node scripts/partner-designations-check.mjs
 *
 * This does NOT attempt to re-parse certification names or point values from
 * the live pages (their prose formatting is too irregular to parse reliably
 * without silent breakage — mandatory-gate steps for the Azure areas and
 * Security vs. flat per-person lists for Business Applications and Modern
 * Work). Instead it hashes each full page's normalized text and compares
 * against the last-known hash — a mismatch means a human needs to re-read
 * the page and update the MDX tab content (and this tracker) by hand.
 *
 * Env overrides (defaults shown):
 *   TRACKER_FILE     src/data_files/partner-designations.json
 *   REPORT_FILE      <tmpdir>/partner-designations-report.md
 *   ERROR_FILE       <tmpdir>/partner-designations-error.md
 *   GITHUB_OUTPUT    <tmpdir>/github-output
 *   FETCH_DELAY_MS   500
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const TRACKER_FILE = resolveFromRoot(process.env.TRACKER_FILE ?? "src/data_files/partner-designations.json");
const REPORT_FILE = process.env.REPORT_FILE ?? join(tmpdir(), "partner-designations-report.md");
const ERROR_FILE = process.env.ERROR_FILE ?? join(tmpdir(), "partner-designations-error.md");
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output");
const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS ?? 500);

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function writeOutput(obj) {
  const lines = Object.entries(obj)
    .map(([key, value]) => `${key}=${String(value).toLowerCase()}\n`)
    .join("");
  appendFileSync(GITHUB_OUTPUT, lines);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  writeFileSync(ERROR_FILE, `${message}\n`);
  writeOutput({ changes_found: false, baseline_updated: false, extraction_failed: true });
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, { attempts = 3 } = {}) {
  let lastStatus;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) return { ok: true, status: response.status, text: await response.text() };

      lastStatus = response.status;
      console.error(`WARNING: ${url} attempt ${attempt} failed (${response.status})`);
    } catch (error) {
      lastError = error;
      console.error(`WARNING: ${url} attempt ${attempt} failed (${error.message})`);
    }

    if (attempt < attempts) await sleep(attempt * 5000);
  }

  return { ok: false, status: lastStatus, error: lastError };
}

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function normalizedText(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const withoutScripts = body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  return decodeEntities(withoutScripts.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function hashOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadTracker() {
  if (!existsSync(TRACKER_FILE)) {
    fail(`Tracker file not found at ${relative(root, TRACKER_FILE)}.`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TRACKER_FILE, "utf8"));
  } catch {
    fail(`Corrupt tracker file at ${relative(root, TRACKER_FILE)} (invalid JSON).`);
    return null;
  }

  if (!Array.isArray(parsed.pages)) {
    fail(`Corrupt tracker file at ${relative(root, TRACKER_FILE)} (missing pages array).`);
    return null;
  }

  return parsed;
}

function buildReport(changed) {
  const rows = changed
    .map((page) => `| ${page.label} | ${page.areas.join(", ")} | [Link](${page.url}) |`)
    .join("\n");

  return (
    "## Partner designation page(s) changed\n\n" +
    "The following Partner Center pathway page(s) changed since the last check. Re-read the page and " +
    "update the matching tab content in `src/content/docs/guide/partneremployees.mdx`:\n\n" +
    "| Page | Areas | URL |\n" +
    "|------|-------|-----|\n" +
    `${rows}\n\n` +
    'See the "Partner Designation Skilling Requirements" section of `AGENTS.md` for how to process these.\n'
  );
}

async function main() {
  console.log("=== Partner Designations Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const tracker = loadTracker();
  const changed = [];
  let baselineRecorded = false;
  let fetchFailures = 0;

  for (let i = 0; i < tracker.pages.length; i++) {
    const page = tracker.pages[i];
    if (i > 0) await sleep(FETCH_DELAY_MS);

    const response = await fetchText(page.url);
    if (!response.ok) {
      fetchFailures++;
      console.error(`WARNING: could not fetch "${page.label}" (${page.url}); skipping this run.`);
      continue;
    }

    const hash = hashOf(normalizedText(response.text));

    if (page.contentHash === hash) {
      console.log(`"${page.label}" unchanged.`);
      continue;
    }

    if (!page.contentHash) {
      console.log(`"${page.label}" has no baseline hash yet — recording the current content as the baseline.`);
      page.contentHash = hash;
      page.lastChanged = new Date().toISOString().slice(0, 10);
      baselineRecorded = true;
      continue;
    }

    console.log(`"${page.label}" changed (hash mismatch) — flagging for review.`);
    page.contentHash = hash;
    page.lastChanged = new Date().toISOString().slice(0, 10);
    changed.push(page);
  }

  if (fetchFailures === tracker.pages.length) {
    fail(
      `All ${tracker.pages.length} tracked Partner Center page fetch(es) failed. The site may be down ` +
        "or blocking requests; the tracker was not modified."
    );
    return;
  }

  if (changed.length === 0 && !baselineRecorded) {
    console.log("No partner designation pages changed this run.");
    writeOutput({ changes_found: false, baseline_updated: false, extraction_failed: false });
    return;
  }

  tracker.lastSynced = new Date().toISOString().slice(0, 10);
  writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2) + "\n");

  if (changed.length > 0) {
    writeFileSync(REPORT_FILE, buildReport(changed));
    console.log(`${changed.length} page(s) changed.`);
  } else {
    console.log("Recorded initial baseline hash(es); nothing to report.");
  }

  writeOutput({ changes_found: changed.length > 0, baseline_updated: true, extraction_failed: false });
}

main();
