#!/usr/bin/env node
/**
 * Weekly check of tracked beta exams against Microsoft Learn.
 *
 * Usage:
 *   node scripts/beta-exam-check.mjs
 *
 * Reads src/data_files/beta-exams.json and fetches each exam not yet
 * `flaggedGA` from Microsoft Learn. If the page's <title> no longer contains
 * "(beta)", the exam has gone generally available: it is added to the report
 * and marked `flaggedGA: true` (with `flaggedAt`) so it is not reported again.
 * A fetch failure is never treated as "went GA" — only a successful fetch
 * confirming the marker is gone triggers the flag.
 *
 * Env overrides (defaults shown):
 *   EXAMS_FILE       src/data_files/beta-exams.json
 *   REPORT_FILE      <tmpdir>/beta-exam-report.md
 *   ERROR_FILE       <tmpdir>/beta-exam-error.md
 *   GITHUB_OUTPUT    <tmpdir>/github-output
 *   FETCH_DELAY_MS   500
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const EXAMS_FILE = resolveFromRoot(process.env.EXAMS_FILE ?? "src/data_files/beta-exams.json");
const REPORT_FILE = process.env.REPORT_FILE ?? join(tmpdir(), "beta-exam-report.md");
const ERROR_FILE = process.env.ERROR_FILE ?? join(tmpdir(), "beta-exam-error.md");
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

function isStillBeta(html) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return null; // Unknown — couldn't find a title to check.
  return /\(beta\)/i.test(titleMatch[1]);
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
    fail(`Corrupt tracker file at ${relative(root, EXAMS_FILE)} (invalid JSON).`);
    return null;
  }

  if (!Array.isArray(parsed.exams)) {
    fail(`Corrupt tracker file at ${relative(root, EXAMS_FILE)} (missing exams array).`);
    return null;
  }

  return parsed;
}

function buildReport(wentGA) {
  const rows = wentGA.map((exam) => `| ${exam.code} | ${exam.name} | [Link](${exam.url}) |`).join("\n");

  return (
    "## Beta exam(s) now generally available\n\n" +
    "The following exam(s) no longer show a beta marker on Microsoft Learn:\n\n" +
    "| Code | Name | URL |\n" +
    "|------|------|-----|\n" +
    `${rows}\n\n` +
    'See the "Beta and Retiring Exam Tracking" section of `AGENTS.md` for how to process these ' +
    "(remove the BETA badge in `astro.config.mjs`, update the exam page's beta banner and Get Started card).\n"
  );
}

async function main() {
  console.log("=== Beta Exam Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  const tracker = loadExams();
  const pending = tracker.exams.filter((exam) => !exam.flaggedGA);

  if (pending.length === 0) {
    console.log("No untracked-as-GA beta exams to check.");
    writeOutput({ changes_found: false, baseline_updated: false, extraction_failed: false });
    return;
  }

  const wentGA = [];
  let fetchFailures = 0;

  for (let i = 0; i < pending.length; i++) {
    const exam = pending[i];
    if (i > 0) await sleep(FETCH_DELAY_MS);

    const response = await fetchText(exam.url);
    if (!response.ok) {
      fetchFailures++;
      console.error(`WARNING: could not fetch ${exam.code} (${exam.url}); skipping this run.`);
      continue;
    }

    const stillBeta = isStillBeta(response.text);
    if (stillBeta === null) {
      console.error(`WARNING: could not find a <title> on ${exam.code}'s page; skipping this run.`);
      continue;
    }

    if (stillBeta) {
      console.log(`${exam.code} is still in beta.`);
      continue;
    }

    console.log(`${exam.code} no longer shows a beta marker — flagging as GA.`);
    exam.flaggedGA = true;
    exam.flaggedAt = new Date().toISOString().slice(0, 10);
    wentGA.push(exam);
  }

  if (fetchFailures === pending.length) {
    fail(
      `All ${pending.length} tracked beta exam page fetch(es) failed. Microsoft Learn may be down ` +
        "or blocking requests; the tracker was not modified."
    );
    return;
  }

  if (wentGA.length === 0) {
    console.log("No beta exams changed status this run.");
    writeOutput({ changes_found: false, baseline_updated: false, extraction_failed: false });
    return;
  }

  writeFileSync(EXAMS_FILE, JSON.stringify(tracker, null, 2) + "\n");
  writeFileSync(REPORT_FILE, buildReport(wentGA));
  writeOutput({ changes_found: true, baseline_updated: true, extraction_failed: false });
  console.log(`${wentGA.length} beta exam(s) flagged as GA.`);
}

main();
