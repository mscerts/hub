#!/usr/bin/env node
/**
 * One-time/manual sync of the retiring exam tracker from exam-status.mjs.
 *
 * Usage:
 *   node scripts/retiring-exams-sync.mjs
 *
 * Reads every `examStatuses[area][code]` entry in src/data_files/exam-status.mjs
 * whose badge is RETIRING (`{ text: "RETIRING", variant: "danger" }`) or RETIRED
 * (`{ text: "RETIRED", variant: "note" }`), pulls the exam name from that
 * page's frontmatter `description` and the retirement date from its
 * <RetirementBanner retireDate="..."> prop or inline `:::caution` text
 * (whichever the page uses), and writes src/data_files/retiring-exams.json.
 * A RETIRED exam stays in the tracker as history: when its page no longer gives
 * a name or date (a banner reworded past tense) the entry the tracker already
 * has is kept as it is instead of failing the resync.
 *
 * This is a bootstrap/full-resync tool, not part of any scheduled workflow.
 * It overwrites the tracker file entirely, but preserves `notifiedOnDay`/
 * `notifiedOnDayAt` and `notified`/`notifiedAt` for exams that are still present
 * so a resync never re-fires a notification.
 * A tracker entry whose exam has neither badge any more is
 * dropped, with a warning naming it.
 * New retiring exams found after the initial sync should be added to
 * retiring-exams.json by hand (see docs/monitors/beta-and-retiring-exams.md), not by re-running this.
 *
 * Env overrides (defaults shown):
 *   OUTPUT_FILE   src/data_files/retiring-exams.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { examStatuses } from "../src/data_files/exam-status.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const OUTPUT_FILE =
  process.env.OUTPUT_FILE ??
  join(root, "src", "data_files", "retiring-exams.json");
const DOCS_DIR = join(root, "src", "content", "docs");
// Retired exams are archived out of the live docs tree (see AGENTS.md, "Docs
// Rendering"), so the page lookup falls back to the sibling archive collection.
const ARCHIVE_DIR = join(dirname(DOCS_DIR), "archive");

// The two badges of a retirement: RETIRING until the date has passed, RETIRED
// after it (see src/data_files/exam-status.mjs).
const RETIREMENT_BADGES = new Set(["RETIRING", "RETIRED"]);

const MONTHS = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

// ---------------------------------------------------------------------------
// Area directory + exam-name/retirement-date lookup
// ---------------------------------------------------------------------------
function findExamPage(area, code) {
  for (const dir of [DOCS_DIR, ARCHIVE_DIR]) {
    const candidate = join(dir, area, `${code}.mdx`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function examNameFromPage(content, code) {
  const match = content.match(
    new RegExp(`certification exam ${code}:\\s*([^.]+)\\.`, "i"),
  );
  if (match) return match[1].trim();
  // Archived pages describe the exam without the "certification exam" template.
  const archived = content.match(
    new RegExp(`\\bexam ${code}:\\s*([^,.]+)`, "i"),
  );
  if (archived) return archived[1].trim();
  throw new Error(
    `Could not find the exam name in the description frontmatter for ${code}`,
  );
}

function isoDateFromHumanDate(humanDate) {
  const match = humanDate.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  const day = match[2].padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

function retirementDateFromPage(content, code) {
  const bannerMatch = content.match(
    /<RetirementBanner[^>]*\bretireDate="([^"]+)"/,
  );
  if (bannerMatch) return isoDateFromHumanDate(bannerMatch[1]);

  const inlineMatch = content.match(
    /retir(?:ed|ing|es?)[^.\n]*?\bon\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i,
  );
  if (inlineMatch) return isoDateFromHumanDate(inlineMatch[1]);

  // MS-102-style pages that mention a pushed-back date after an initial strikethrough estimate.
  const updateMatch = content.match(
    /pushed the retirement date to\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i,
  );
  if (updateMatch) return isoDateFromHumanDate(updateMatch[1]);

  throw new Error(`Could not find a retirement date on the ${code} exam page`);
}

function replacementCodeFromPage(content) {
  const bannerMatch = content.match(
    /<RetirementBanner[^>]*\breplacementCode="([^"]+)"/,
  );
  if (bannerMatch) return bannerMatch[1];

  const inlineMatch = content.match(/replaced by \[([A-Z]{2,3}-\d{3})/i);
  return inlineMatch ? inlineMatch[1] : null;
}

function loadExisting(file) {
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return new Map((parsed.exams ?? []).map((exam) => [exam.code, exam]));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log("=== Retiring Exam Tracker Sync ===");

  const existing = loadExisting(OUTPUT_FILE);

  const exams = [];
  for (const [area, entries] of Object.entries(examStatuses)) {
    for (const [code, badge] of Object.entries(entries)) {
      if (!RETIREMENT_BADGES.has(badge.text)) continue;

      const prev = existing.get(code);
      // A RETIRED exam is history: keep the entry the tracker has when the page
      // can no longer be read for it, instead of losing the record.
      const keepHistory = (reason) => {
        if (badge.text !== "RETIRED" || !prev) return false;
        console.error(
          `WARNING: ${reason}; ${code} is RETIRED, so its existing tracker entry is kept as history.`,
        );
        exams.push(prev);
        return true;
      };

      const page = findExamPage(area, code);
      if (!page) {
        if (keepHistory(`no exam page found for ${code} in ${area}`)) continue;
        console.error(
          `WARNING: no exam page found for ${code} in ${area}; skipping.`,
        );
        continue;
      }

      const content = readFileSync(page, "utf8");
      let name;
      let retirementDate;
      try {
        name = examNameFromPage(content, code);
        retirementDate = retirementDateFromPage(content, code);
      } catch (error) {
        if (keepHistory(error.message)) continue;
        throw error;
      }
      const replacementCode = replacementCodeFromPage(content);

      exams.push({
        code,
        area,
        name,
        retirementDate,
        ...(replacementCode ? { replacementCode } : {}),
        ...(prev?.notifiedOnDay ? { notifiedOnDay: prev.notifiedOnDay } : {}),
        ...(prev?.notifiedOnDayAt
          ? { notifiedOnDayAt: prev.notifiedOnDayAt }
          : {}),
        notified: prev?.notified ?? false,
        ...(prev?.notifiedAt ? { notifiedAt: prev.notifiedAt } : {}),
      });
      console.log(
        `Found ${badge.text === "RETIRED" ? "retired" : "retiring"} exam: ${code} (${area}) — ${badge.text === "RETIRED" ? "retired" : "retires"} ${retirementDate}`,
      );
    }
  }

  const kept = new Set(exams.map((exam) => exam.code));
  for (const [code, prev] of existing) {
    if (!kept.has(code)) {
      console.error(
        `WARNING: ${code} (retires ${prev.retirementDate}) is in the tracker but has neither a RETIRING nor a RETIRED badge in exam-status.mjs; this resync drops it.`,
      );
    }
  }

  exams.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  const output = {
    lastSynced: new Date().toISOString().slice(0, 10),
    exams,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${exams.length} retiring exam(s) to ${OUTPUT_FILE}`);
}

main();
