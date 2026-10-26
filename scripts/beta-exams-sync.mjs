#!/usr/bin/env node
/**
 * One-time/manual sync of the beta exam tracker from exam-status.mjs.
 *
 * Usage:
 *   node scripts/beta-exams-sync.mjs
 *
 * Reads every `examStatuses[area][code]` entry in src/data_files/exam-status.mjs with
 * `{ text: "BETA", variant: "tip" }`, pulls the exam name from that page's
 * frontmatter `examName` (legacy description fallback), and writes src/data_files/beta-exams.json.
 *
 * This is a bootstrap/full-resync tool, not part of any scheduled workflow.
 * It rebuilds the tracker file from exam-status.mjs: an entry whose exam no longer
 * carries a BETA status there (one added by hand included) is dropped, without a
 * warning, and so is an entry whose exam page is missing (with the warning "no exam
 * page found ... skipping"). For an exam the file already has, only `area` (from
 * exam-status.mjs) and `name` (from the exam page) are refreshed; everything else
 * is kept as it is: the hand-set `url` (a certification address verified by hand,
 * such as GH-700's, beats the canonical exams/<code> one), the monitor's own state
 * (`flaggedGA`, `flaggedAt`), `betaStart` and `announcement` (they cannot be
 * derived from exam-status.mjs or the exam page) and any other key. An entry with
 * no usable `url` gets the canonical one.
 * An exam that is BETA but has no entry yet gets the canonical
 * https://learn.microsoft.com/credentials/certifications/exams/<code> URL,
 * `flaggedGA: false` and NO `betaStart` and `announcement`, and a warning: both must
 * be added by hand (tests/scripts/beta-pages.test.mjs fails until they are there).
 * New beta exams found after the initial sync should be
 * added to beta-exams.json by hand (see docs/monitors/beta-and-retiring-exams.md), not by re-running this.
 *
 * Env overrides (defaults shown):
 *   OUTPUT_FILE   src/data_files/beta-exams.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { examStatuses } from "../src/data_files/exam-status.mjs";
import { readExamName } from "../src/utils/exam-name.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const OUTPUT_FILE =
  process.env.OUTPUT_FILE ?? join(root, "src", "data_files", "beta-exams.json");
const DOCS_DIR = join(root, "src", "content", "docs");
const TRACKING = "?WT.mc_id=studentamb_165290";

// The keys buildEntry places itself, in the documented order. Of an existing entry
// every other key is kept as it is, in the order it has in the file.
const PLACED_KEYS = new Set([
  "code",
  "area",
  "name",
  "url",
  "flaggedGA",
  "flaggedAt",
]);
// What a resync cannot derive, and tests/scripts/beta-pages.test.mjs requires of every BETA exam.
const HAND_KEYS = ["betaStart", "announcement"];

const canonicalUrl = (code) =>
  `https://learn.microsoft.com/credentials/certifications/exams/${code.toLowerCase()}${TRACKING}`;

// ---------------------------------------------------------------------------
// Area directory + exam-name lookup
// ---------------------------------------------------------------------------
function findExamPage(area, code) {
  const candidate = join(DOCS_DIR, area, `${code}.mdx`);
  return existsSync(candidate) ? candidate : null;
}

function examNameFromPage(file, code) {
  const content = readFileSync(file, "utf8");
  const explicit = readExamName(content);
  if (explicit) return explicit;
  const match = content.match(
    new RegExp(`certification exam ${code}:\\s*([^.]+)\\.`, "i"),
  );
  if (!match) {
    throw new Error(
      `Could not find the exam name in ${file}'s description frontmatter`,
    );
  }
  return match[1].trim();
}

/** The entries the file has now, by code. A file that cannot be read is no reason to stop a resync. */
function loadExisting(file) {
  if (!existsSync(file)) return new Map();
  let exams;
  try {
    exams = JSON.parse(readFileSync(file, "utf8"))?.exams;
    if (!Array.isArray(exams)) throw new Error("it has no exams array");
  } catch (error) {
    console.error(
      `WARNING: ${file} cannot be read (${error.message}), so no entry can be kept: every entry is written with the canonical url and flaggedGA false, and without "betaStart" and "announcement", which must be added by hand.`,
    );
    return new Map();
  }
  return new Map(
    exams
      .filter((exam) => typeof exam?.code === "string")
      .map((exam) => [exam.code, exam]),
  );
}

/**
 * The entry of a BETA exam. `area` and `name` are the repository's; of an existing
 * entry (`previous`) the hand-set `url`, the monitor's state (`flaggedGA`,
 * `flaggedAt`) and every other key stay as the file has them. Without an entry, or
 * without a usable url, the url is the canonical one.
 */
function buildEntry(previous, { code, area, name }) {
  const old = previous ?? {};
  const hasUrl = typeof old.url === "string" && old.url.trim() !== "";
  return {
    code,
    area,
    name,
    url: hasUrl ? old.url : canonicalUrl(code),
    ...Object.fromEntries(
      Object.entries(old).filter(([key]) => !PLACED_KEYS.has(key)),
    ),
    flaggedGA: old.flaggedGA ?? false,
    ...("flaggedAt" in old ? { flaggedAt: old.flaggedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log("=== Beta Exam Tracker Sync ===");

  const existing = loadExisting(OUTPUT_FILE);

  const exams = [];
  for (const [area, entries] of Object.entries(examStatuses)) {
    for (const [code, badge] of Object.entries(entries)) {
      if (badge.variant !== "tip" || badge.text !== "BETA") continue;

      const page = findExamPage(area, code);
      if (!page) {
        console.error(
          `WARNING: no exam page found for ${code} in ${area}; skipping.`,
        );
        continue;
      }

      const name = examNameFromPage(page, code);

      const previous = existing.get(code);
      const entry = buildEntry(previous, { code, area, name });
      exams.push(entry);
      console.log(`Found beta exam: ${code} (${area}) — ${name}`);

      const missing = HAND_KEYS.filter((key) => !entry[key]);
      if (missing.length > 0) {
        const keys = missing.map((key) => `"${key}"`).join(" and ");
        console.error(
          `WARNING: ${code} is BETA, but ${
            previous
              ? `its entry has no ${keys}`
              : `the tracker had no entry for it, so the new entry has no ${keys}`
          }. A resync cannot derive ${missing.length === 1 ? "it" : "them"}: ${missing.length === 1 ? "it" : "both"} must be added by hand, from the official announcement or the exam's Microsoft Learn page and never guessed (tests/scripts/beta-pages.test.mjs fails until then; see docs/monitors/beta-and-retiring-exams.md).`,
        );
      }
    }
  }

  exams.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  const output = {
    lastSynced: new Date().toISOString().slice(0, 10),
    exams,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${exams.length} beta exam(s) to ${OUTPUT_FILE}`);
}

main();
