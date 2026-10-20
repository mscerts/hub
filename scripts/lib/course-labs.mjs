/**
 * The hands-on pages a course leaves out (course-build.mjs routing) against the exam's lab page
 * (src/content/docs/labs/<area>/<code>.mdx). Pure: no I/O. The command line is scripts/course-labs.mjs.
 *
 * The lab page is where hands-on material belongs, so every accepted hands-on page must be on it. This finds the
 * ones that are not and writes the card for each; placing a card in the right tab of the page is the person's
 * (or the agent's) edit, because the layout of a lab page differs from exam to exam.
 */

import { learnPath } from "./course-scope.mjs";
import { learnHref } from "./course-render.mjs";
import { squish } from "./course-guide.mjs";

const LINK_CARD = /<LinkCard\b[^>]*?\bhref="([^"]*)"/g;
const TAB_LABEL = /<TabItem\b[^>]*\blabel="([^"]*)"/g;
// "Exercise - X", "Simulation: X", "Optional exercise - X", and a title that only starts with "Exercise X"
const PREFIX =
  /^(?:(?:optional|hands-on)\s+)*(?:(?:exercise|simulation|lab)\s*[-–—:]\s*|exercise\s+)/i;

/** The Learn paths the lab page links, as a Set of canonical paths. */
export function labPagePaths(mdx) {
  const paths = new Set();
  for (const m of mdx.matchAll(LINK_CARD)) {
    const path = learnPath(m[1].replace(/&amp;/g, "&"));
    if (path) paths.add(path);
  }
  return paths;
}

/** The labels of the tabs of a page, in order. */
export function tabLabels(mdx) {
  return [...mdx.matchAll(TAB_LABEL)].map((m) => m[1]);
}

/** A unit address without the position Learn puts in front of its name: /training/modules/a/3-x -> /training/modules/a/x. */
const unnumbered = (path) => path.replace(/\/\d+-([^/]+)$/, "/$1");

/** Whether the lab page already has a hands-on page: the page itself, the same unit, or (a project module) any unit of it. */
export function onLabPage(entry, paths) {
  if (paths.has(entry.path)) return true;
  if (entry.kind === "unit") {
    const wanted = unnumbered(entry.path);
    return [...paths].some((p) => unnumbered(p) === wanted);
  }
  if (entry.kind === "module")
    return [...paths].some((p) => p.startsWith(`${entry.path}/`));
  return false;
}

/**
 * The text of a lab-page card: the page's title without the "Exercise - " or "Simulation - " the lab page leaves
 * off (every card there is an exercise), the first letter in capitals. A tutorial or a quickstart keeps its name.
 */
export function cardTitle(entry) {
  const title = squish(entry.title);
  const bare = squish(title.replace(PREFIX, ""));
  const text = bare === "" ? title : bare;
  return `${text[0].toUpperCase()}${text.slice(1)}`.replace(/"/g, "'");
}

/** The LinkCard line for a hands-on page (the lab page's own style: no description, no target). */
export function cardLine(entry, indent = "  ") {
  return `${indent}<LinkCard title="${cardTitle(entry)}" href="${learnHref(entry.path)}" />`;
}

/**
 * Compare the routed hands-on pages with the lab page.
 *   handsOn  routing.handsOn of the build ([{ path, kind, title, reason, tasks }])
 *   mdx      the text of the lab page
 * Returns { present, missing }: the entries the lab page has and the ones it lacks, each with its `domain` (the
 * first part of its first task's key), missing ones sorted by domain, then title.
 */
export function compareWithLabPage({ handsOn, mdx }) {
  const paths = labPagePaths(mdx);
  const present = [];
  const missing = [];
  for (const entry of handsOn) {
    const withDomain = { ...entry, domain: entry.tasks?.[0]?.split("/")[0] ?? "" };
    (onLabPage(entry, paths) ? present : missing).push(withDomain);
  }
  missing.sort(
    (a, b) =>
      a.domain.localeCompare(b.domain) ||
      cardTitle(a).localeCompare(cardTitle(b)),
  );
  return { present, missing };
}
