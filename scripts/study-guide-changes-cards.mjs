#!/usr/bin/env node
/**
 * Keeps the "Study Guide Changes" card on the exam pages. Every exam page links its change page from
 * the Get Started card, directly under the Study Guide card:
 *
 *   <LinkCard title="AB-100 Study Guide Changes" href="/certs/changelog/ab-100/" description="..."/>
 *
 * node scripts/study-guide-changes-cards.mjs           add the missing cards
 * node scripts/study-guide-changes-cards.mjs --check   list what is missing or wrong, change nothing
 *
 * tests/scripts/study-guide-changes-cards.test.mjs runs the check, so an exam page without its card
 * fails CI (scripts/new-exam.mjs writes the card into every new page). Runbook:
 * docs/study-guide-changes.md.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXAM_AREAS = [
  "aibusiness",
  "azure",
  "dynamics",
  "github",
  "microsoft365",
  "power",
  "security",
];
const DESCRIPTION =
  "What changed in the study guide, what is coming, and the previous version.";

/** The address of an exam's change page. */
export const changePath = (code) => `/certs/changelog/${code.toLowerCase()}/`;

/** The card, as one MDX line (without indentation). */
export const changesCard = (code) =>
  `<LinkCard title="${code} Study Guide Changes" href="${changePath(code)}" description="${DESCRIPTION}"/>`;

const studyGuideLine = (code) =>
  new RegExp(`^\\s*<LinkCard title="${code} Study Guide"`);

/**
 * The Get Started card of a page: `{ start, end }` line indexes, or null. The Study Guide card's line
 * and the Changes card's line (if any) are found inside it.
 */
function getStarted(lines) {
  const start = lines.findIndex((line) =>
    line.includes('<Card title="Get Started"'),
  );
  if (start < 0) return null;
  const closing = lines.findIndex(
    (line, i) => i > start && line.includes("</Card>"),
  );
  return { start, end: closing < 0 ? lines.length : closing };
}

/** Where things stand on a page: `ok`, `missing`, `misplaced` (not directly under the Study Guide card) or `no-anchor`. */
export function cardStatus(text, code) {
  const lines = text.split("\n");
  const card = getStarted(lines);
  if (!card) return "no-anchor";
  const guide = lines.findIndex(
    (line, i) =>
      i > card.start && i < card.end && studyGuideLine(code).test(line),
  );
  if (guide < 0) return "no-anchor";
  const href = `href="${changePath(code)}"`;
  const at = lines.findIndex(
    (line) => line.includes(href) && line.includes("<LinkCard"),
  );
  if (at < 0) return "missing";
  return at === guide + 1 ? "ok" : "misplaced";
}

/** The page text with the card added under the Study Guide card (unchanged when it is already there). */
export function withCard(text, code) {
  const lines = text.split("\n");
  const card = getStarted(lines);
  if (!card) return text;
  const guide = lines.findIndex(
    (line, i) =>
      i > card.start && i < card.end && studyGuideLine(code).test(line),
  );
  if (guide < 0) return text;
  if (cardStatus(text, code) !== "missing") return text;
  const indent = lines[guide].match(/^\s*/)[0];
  lines.splice(guide + 1, 0, `${indent}${changesCard(code)}`);
  return lines.join("\n");
}

/** `Map<code, file>` of the exam pages of src/content/docs. */
export function examPages(base = root) {
  const pages = new Map();
  for (const area of EXAM_AREAS) {
    const dir = join(base, "src/content/docs", area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir))
      if (/^[A-Z]{2,3}-\d{2,4}\.mdx$/.test(name))
        pages.set(name.replace(/\.mdx$/, ""), join(dir, name));
  }
  return pages;
}

/** The exam codes that have a history file. */
export function historyCodes(base = root) {
  const dir = join(base, "src/data_files/study-guide-history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[A-Z]{2,3}-\d{2,4}\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

/**
 * The problems of every exam page: `[{ code, file, problem }]`. Every exam page has the card, whether or
 * not its guide has been recorded yet: the change page exists for every exam page (it says so when
 * nothing is recorded).
 */
export function findProblems(base = root) {
  const problems = [];
  for (const [code, file] of examPages(base)) {
    const status = cardStatus(readFileSync(file, "utf8"), code);
    if (status !== "ok") problems.push({ code, file, problem: status });
  }
  return problems;
}

function main(argv) {
  const check = argv.includes("--check");
  const problems = findProblems();
  if (check) {
    for (const p of problems)
      console.log(`${p.code}: ${p.problem} (${p.file})`);
    console.log(
      problems.length
        ? `${problems.length} problem(s).`
        : "All exam pages are in order.",
    );
    process.exit(problems.length ? 1 : 0);
  }
  let added = 0;
  for (const p of problems) {
    if (p.problem !== "missing") {
      console.log(`${p.code}: ${p.problem}, fix by hand (${p.file})`);
      continue;
    }
    const text = readFileSync(p.file, "utf8");
    writeFileSync(p.file, withCard(text, p.code));
    added++;
  }
  console.log(`Added ${added} card(s).`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
