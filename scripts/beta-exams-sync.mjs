#!/usr/bin/env node
/**
 * One-time/manual sync of the beta exam tracker from astro.config.mjs.
 *
 * Usage:
 *   node scripts/beta-exams-sync.mjs
 *
 * Reads every `examBadges[area][code]` entry in astro.config.mjs with
 * `{ text: "BETA", variant: "tip" }`, pulls the exam name from that page's
 * frontmatter `description`, and writes src/data_files/beta-exams.json.
 *
 * This is a bootstrap/full-resync tool, not part of any scheduled workflow.
 * It overwrites the tracker file entirely — entries added by hand for exams
 * that no longer carry a BETA badge in astro.config.mjs will be dropped if
 * you re-run this. New beta exams found after the initial sync should be
 * added to beta-exams.json by hand (see AGENTS.md), not by re-running this.
 *
 * Env overrides (defaults shown):
 *   CONFIG_FILE   astro.config.mjs
 *   OUTPUT_FILE   src/data_files/beta-exams.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const CONFIG_FILE = process.env.CONFIG_FILE ?? join(root, "astro.config.mjs");
const OUTPUT_FILE =
  process.env.OUTPUT_FILE ?? join(root, "src", "data_files", "beta-exams.json");
const DOCS_DIR = join(root, "src", "content", "docs");
const TRACKING = "?WT.mc_id=studentamb_165290";

// ---------------------------------------------------------------------------
// Parse `const examBadges = { ... }` out of astro.config.mjs without eval.
// ---------------------------------------------------------------------------
function extractBraceBlock(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  throw new Error("Unbalanced braces while parsing examBadges");
}

function parseExamBadges(configText) {
  const marker = "const examBadges = ";
  const start = configText.indexOf(marker);
  if (start === -1)
    throw new Error("Could not find `const examBadges = ` in astro.config.mjs");

  const block = extractBraceBlock(configText, configText.indexOf("{", start));
  const badges = {};

  const areaRe = /(\w+):\s*\{/g;
  let areaMatch;
  while ((areaMatch = areaRe.exec(block))) {
    const area = areaMatch[1];
    const subBlockStart = areaMatch.index + areaMatch[0].length - 1;
    const subBlock = extractBraceBlock(block, subBlockStart);
    badges[area] = {};

    const entryRe =
      /"([A-Z]{2,3}-\d{3})":\s*\{\s*text:\s*"([^"]+)",\s*variant:\s*"([^"]+)"\s*\}/g;
    let entryMatch;
    while ((entryMatch = entryRe.exec(subBlock))) {
      badges[area][entryMatch[1]] = {
        text: entryMatch[2],
        variant: entryMatch[3],
      };
    }

    areaRe.lastIndex = subBlockStart + subBlock.length;
  }

  return badges;
}

// ---------------------------------------------------------------------------
// Area directory + exam-name lookup
// ---------------------------------------------------------------------------
function findExamPage(area, code) {
  const candidate = join(DOCS_DIR, area, `${code}.mdx`);
  return existsSync(candidate) ? candidate : null;
}

function examNameFromPage(file, code) {
  const content = readFileSync(file, "utf8");
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log("=== Beta Exam Tracker Sync ===");

  const configText = readFileSync(CONFIG_FILE, "utf8");
  const badges = parseExamBadges(configText);

  const exams = [];
  for (const [area, entries] of Object.entries(badges)) {
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
      const url = `https://learn.microsoft.com/credentials/certifications/exams/${code.toLowerCase()}${TRACKING}`;

      exams.push({ code, area, name, url, flaggedGA: false });
      console.log(`Found beta exam: ${code} (${area}) — ${name}`);
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
