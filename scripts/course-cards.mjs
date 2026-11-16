#!/usr/bin/env node
/**
 * Keeps the "Study Guide Course" card on the exam pages. An exam that has a course page
 * (src/content/docs/courses/<code>.mdx, docs/courses.md) links it from the Text tab of its exam page, directly
 * under the card of the exam's own Microsoft Learn course, or as the first card of the tab when the page has no
 * such card yet (a beta exam, mostly):
 *
 *   <LinkCard title="AZ-104 Study Guide Course" href="/certs/courses/az-104/" description="..."/>
 *
 * node scripts/course-cards.mjs           add the missing cards
 * node scripts/course-cards.mjs --check   list what is missing or wrong, change nothing
 *
 * tests/scripts/course-cards.test.mjs runs the check, so a course page that its exam page does not link, a card
 * in the wrong place and a card that points to a course page the hub does not have fail CI. Runbook:
 * docs/courses.md ("The card on the exam page").
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAM_AREAS } from "./lib/areas.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESCRIPTION =
  "A collection of Microsoft Learn modules and documentation pages, based on the study guide.";

/** The address of an exam's course page. */
export const coursePath = (code) => `/certs/courses/${code.toLowerCase()}/`;

/** The card, as one MDX line (without indentation). */
export const courseCard = (code) =>
  `<LinkCard title="${code} Study Guide Course" href="${coursePath(code)}" description="${DESCRIPTION}"/>`;

const isCard = (line) => line.trimStart().startsWith("<LinkCard");
const LEARN_COURSE = /^\s*<LinkCard\s+title="Microsoft Learn"(?=[\s/>]|$)/;

/**
 * The Text tab of an exam page: { start, end } line indexes (the <TabItem> line and its </TabItem>), with
 * `skip`, the Set of lines that are inside an MDX comment or a `:::` box (a commented-out card is not a card).
 * Null when the page has no Text tab.
 */
function textTab(lines) {
  const start = lines.findIndex((line) => /<TabItem\s+label="Text"/.test(line));
  if (start < 0) return null;
  const closing = lines.findIndex(
    (line, i) => i > start && line.includes("</TabItem>"),
  );
  const end = closing < 0 ? lines.length : closing;
  const skip = new Set();
  let comment = false;
  let box = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const wasComment = comment;
    if (!comment && line.includes("{/*")) comment = true;
    if (comment || wasComment) skip.add(i);
    if (comment && line.includes("*/}")) comment = false;
    if (/^\s*:::/.test(line)) {
      skip.add(i);
      box = !box && /^\s*:::\w/.test(line);
    } else if (box) skip.add(i);
  }
  return { start, end, skip };
}

/** The line a card that starts on line `at` ends on (a card can span several lines). */
function endOfCard(lines, at, end) {
  for (let i = at; i < end; i++) if (lines[i].includes("/>")) return i;
  return at;
}

/**
 * Where the card belongs in the Text tab: { line, indent }, the index it is inserted at and its indentation.
 * Directly under the exam's own "Microsoft Learn" course card; without one, before the first card or card grid
 * of the tab; in an empty tab, as its first line.
 */
function cardPlace(lines, tab) {
  const active = (i) => !tab.skip.has(i);
  for (let i = tab.start + 1; i < tab.end; i++)
    if (active(i) && LEARN_COURSE.test(lines[i]))
      return {
        line: endOfCard(lines, i, tab.end) + 1,
        indent: lines[i].match(/^\s*/)[0],
      };
  for (let i = tab.start + 1; i < tab.end; i++)
    if (
      active(i) &&
      (isCard(lines[i]) || lines[i].trimStart().startsWith("<CardGrid"))
    )
      return { line: i, indent: lines[i].match(/^\s*/)[0] };
  // an empty tab: after its last box or comment, else right under the <TabItem> line
  let line = tab.start + 1;
  for (let i = tab.start + 1; i < tab.end; i++)
    if (tab.skip.has(i)) line = i + 1;
  return { line, indent: `${lines[tab.start].match(/^\s*/)[0]}  ` };
}

/**
 * Where things stand on an exam page: `ok`, `missing`, `misplaced` (the card is not where cardPlace puts it) or
 * `no-anchor` (the page has no Text tab).
 */
export function cardStatus(text, code) {
  const lines = text.split(/\r?\n/);
  const tab = textTab(lines);
  if (!tab) return "no-anchor";
  const href = `href="${coursePath(code)}"`;
  const at = lines.findIndex((line) => isCard(line) && line.includes(href));
  if (at < 0) return "missing";
  if (at <= tab.start || at >= tab.end || tab.skip.has(at)) return "misplaced";
  // the place is worked out without the card itself
  const without = [...lines.slice(0, at), ...lines.slice(at + 1)];
  const place = cardPlace(without, textTab(without));
  return place.line === at ? "ok" : "misplaced";
}

/** Whether an exam page links a course page at all (in a card that is not commented out). */
export function hasCard(text, code) {
  const lines = text.split(/\r?\n/);
  const href = `href="${coursePath(code)}"`;
  const tab = textTab(lines);
  return lines.some(
    (line, i) => isCard(line) && line.includes(href) && !tab?.skip.has(i),
  );
}

/** The page text with the card added in its place (unchanged when the page has it or has no Text tab). */
export function withCard(text, code) {
  if (cardStatus(text, code) !== "missing") return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const place = cardPlace(lines, textTab(lines));
  lines.splice(place.line, 0, `${place.indent}${courseCard(code)}`);
  return lines.join(eol);
}

/** `Map<code, file>` of the exam pages of src/content/docs. */
export function examPages(base = root) {
  const pages = new Map();
  for (const area of EXAM_AREAS) {
    const dir = join(base, "src/content/docs", area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir))
      if (/^[A-Z]{2,3}-\d{3}\.mdx$/.test(name))
        pages.set(name.replace(/\.mdx$/, ""), join(dir, name));
  }
  return pages;
}

/**
 * The exam codes that have a course page: src/content/docs/courses/<code>.mdx that is not a draft. Other pages of
 * that folder (a review copy, say) are not courses of an exam.
 */
export function courseCodes(base = root) {
  const dir = join(base, "src/content/docs/courses");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[a-z]{2,3}-\d{3}\.mdx$/.test(name))
    .filter(
      (name) =>
        !/^draft:\s*true\s*$/m.test(
          readFileSync(join(dir, name), "utf8").split(/^---\s*$/m)[1] ?? "",
        ),
    )
    .map((name) => name.replace(/\.mdx$/, "").toUpperCase())
    .sort();
}

/**
 * The problems of the exam pages: `[{ code, file, problem }]`. An exam with a course page must have the card in
 * its place; an exam without one must not link a course page; a course page without an exam page is `no-exam-page`.
 */
export function findProblems(base = root) {
  const problems = [];
  const pages = examPages(base);
  const courses = new Set(courseCodes(base));
  for (const code of courses)
    if (!pages.has(code))
      problems.push({ code, file: null, problem: "no-exam-page" });
  for (const [code, file] of pages) {
    const text = readFileSync(file, "utf8");
    if (courses.has(code)) {
      const status = cardStatus(text, code);
      if (status !== "ok") problems.push({ code, file, problem: status });
    } else if (hasCard(text, code))
      problems.push({ code, file, problem: "no-course-page" });
  }
  return problems;
}

function main(argv) {
  const check = argv.includes("--check");
  const problems = findProblems();
  if (check) {
    for (const p of problems)
      console.log(`${p.code}: ${p.problem}${p.file ? ` (${p.file})` : ""}`);
    console.log(
      problems.length
        ? `${problems.length} problem(s).`
        : "Every exam page with a course links it.",
    );
    process.exit(problems.length ? 1 : 0);
  }
  let added = 0;
  for (const p of problems) {
    if (p.problem !== "missing") {
      console.log(
        `${p.code}: ${p.problem}, fix by hand${p.file ? ` (${p.file})` : ""}`,
      );
      continue;
    }
    writeFileSync(p.file, withCard(readFileSync(p.file, "utf8"), p.code));
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
