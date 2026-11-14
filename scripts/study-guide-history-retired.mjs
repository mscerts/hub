#!/usr/bin/env node
/**
 * Records the study guide of exams that have retired, for the comparison tabs of the Study Guide Changes
 * pages (src/utils/guide-changes/compare.mjs). The New Exam Monitor only records the guides of exams the hub
 * covers, so the guide of an exam that retired before the history existed is not in it; Microsoft keeps
 * the guide of a retired exam on Learn (with a "This exam was retired" notice), so it is read from there.
 * Runbook: docs/study-guide-changes.md.
 *
 *   node scripts/study-guide-history-retired.mjs [CODE ...] [--dir <folder>] [--write]
 *
 * With no codes it takes every replaced exam of `comparisonPairs` that has no history file yet. A guide is
 * read once, with the reader of the monitor (`parseStudyGuide`), and recorded as version 1 on today's date
 * (`firstSeen` is the day it was pulled, not the day it was published). Without --write nothing is written.
 * Files that already exist are left alone: a retired guide does not change.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStudyGuide, studyGuideUrl } from "./new-exam-check.mjs";
import {
  emptyHistory,
  historyFileName,
  recordVersion,
  writeHistory,
} from "./lib/guide-history.mjs";
import { comparisonPairs } from "../src/utils/guide-changes/compare.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DELAY_MS = 1000;
const USER_AGENT =
  "msfthub-study-guide-history (+https://github.com/mscerts/hub; one-off read of retired study guides)";

/** The history of one fetched guide page, or `{ error }` when the page is not a readable study guide. */
export function historyOfPage(html, code, today) {
  const guide = parseStudyGuide(html, code);
  if (!guide.ok || !guide.lines?.length)
    return { error: guide.reason || "no skills section found" };
  const { history, event } = recordVersion(
    emptyHistory(code),
    guide.lines,
    today,
  );
  if (!event) return { error: "no skills measured section in the guide" };
  return { history };
}

async function fetchGuide(code) {
  const url = studyGuideUrl(code);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function main(argv) {
  const write = argv.includes("--write");
  const dirIndex = argv.indexOf("--dir");
  const dir =
    dirIndex === -1
      ? join(root, "src/data_files/study-guide-history")
      : resolve(argv[dirIndex + 1]);
  const named = argv.filter(
    (arg, i) => /^[A-Z]{2,3}-\d{2,4}$/.test(arg) && argv[i - 1] !== "--dir",
  );
  const codes = (
    named.length ? named : comparisonPairs.flatMap((pair) => pair.from)
  ).filter((code) => !existsSync(join(dir, historyFileName(code))));
  if (!codes.length) {
    console.log("Every replaced exam already has its guide recorded.");
    return 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  let failed = 0;
  for (const [index, code] of codes.entries()) {
    if (index) await new Promise((done) => setTimeout(done, DELAY_MS));
    try {
      const result = historyOfPage(await fetchGuide(code), code, today);
      if (result.error) throw new Error(result.error);
      const [version] = result.history.versions;
      console.log(
        `${code}: ${version.lines.length} lines, ${version.asOf ? `skills measured as of ${version.asOf}` : "no date stated"}${write ? "" : " (dry run)"}`,
      );
      if (write) writeHistory(dir, result.history);
    } catch (error) {
      failed++;
      console.error(`${code}: ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
