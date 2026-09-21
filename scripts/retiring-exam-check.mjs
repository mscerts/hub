#!/usr/bin/env node
/**
 * Daily check of the retiring exam tracker for newly retired exams.
 *
 * Usage:
 *   node scripts/retiring-exam-check.mjs
 *
 * Reads src/data_files/retiring-exams.json and flags any exam whose
 * `retirementDate` is yesterday (UTC) or earlier and not yet `notified`.
 * Using "yesterday or earlier" rather than an exact match means a missed
 * workflow run (e.g. an outage) never silently skips a notification.
 *
 * Pure local date math — no network calls.
 *
 * Env overrides (defaults shown):
 *   EXAMS_FILE       src/data_files/retiring-exams.json
 *   REPORT_FILE      <tmpdir>/retiring-exam-report.md
 *   ERROR_FILE       <tmpdir>/retiring-exam-error.md
 *   GITHUB_OUTPUT    <tmpdir>/github-output
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const EXAMS_FILE = resolveFromRoot(
  process.env.EXAMS_FILE ?? "src/data_files/retiring-exams.json",
);
const REPORT_FILE =
  process.env.REPORT_FILE ?? join(tmpdir(), "retiring-exam-report.md");
const ERROR_FILE =
  process.env.ERROR_FILE ?? join(tmpdir(), "retiring-exam-error.md");
const GITHUB_OUTPUT =
  process.env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output");

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

function yesterdayUTC() {
  const now = new Date();
  const utcToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(utcToday - 86400000).toISOString().slice(0, 10);
}

function loadExams() {
  if (!existsSync(EXAMS_FILE)) {
    fail(`Tracker file not found at ${relative(root, EXAMS_FILE)}.`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(EXAMS_FILE, "utf8"));
  } catch {
    fail(
      `Corrupt tracker file at ${relative(root, EXAMS_FILE)} (invalid JSON).`,
    );
    return null;
  }

  if (!Array.isArray(parsed.exams)) {
    fail(
      `Corrupt tracker file at ${relative(root, EXAMS_FILE)} (missing exams array).`,
    );
    return null;
  }

  return parsed;
}

function buildReport(retired) {
  const rows = retired
    .map(
      (exam) =>
        `| ${exam.code} | ${exam.name} | ${exam.retirementDate} | ${exam.replacementCode ?? "—"} |`,
    )
    .join("\n");

  return (
    "## Exam(s) retired\n\n" +
    "The following exam(s) passed their retirement date:\n\n" +
    "| Code | Name | Retirement date | Replacement |\n" +
    "|------|------|------------------|-------------|\n" +
    `${rows}\n\n` +
    'See the "Beta and Retiring Exam Tracking" section of `AGENTS.md` for how to process these.\n'
  );
}

function main() {
  console.log("=== Retiring Exam Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const tracker = loadExams();
  const cutoff = yesterdayUTC();
  console.log(
    `Notifying for any retirement date on or before ${cutoff} (UTC).`,
  );

  const newlyRetired = tracker.exams.filter(
    (exam) => !exam.notified && exam.retirementDate <= cutoff,
  );

  if (newlyRetired.length === 0) {
    console.log("No exams retired since the last check.");
    writeOutput({
      changes_found: false,
      baseline_updated: false,
      extraction_failed: false,
    });
    return;
  }

  const notifiedAt = new Date().toISOString().slice(0, 10);
  for (const exam of newlyRetired) {
    exam.notified = true;
    exam.notifiedAt = notifiedAt;
    console.log(`${exam.code} retired on ${exam.retirementDate} — notifying.`);
  }

  writeFileSync(EXAMS_FILE, JSON.stringify(tracker, null, 2) + "\n");
  writeFileSync(REPORT_FILE, buildReport(newlyRetired));
  writeOutput({
    changes_found: true,
    baseline_updated: true,
    extraction_failed: false,
  });
  console.log(`${newlyRetired.length} exam(s) newly retired.`);
}

main();
