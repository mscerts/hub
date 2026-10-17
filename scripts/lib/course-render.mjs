/**
 * Course file -> course page (MDX for the docs system). Pure: no I/O.
 * The page is generated and never edited by hand: change the course file and render again.
 *
 * Layout, in the style of the docs the hub already has: `##` domain with its weight, `###` skill group,
 * `####` task, and under every task a Tabs block: "Learning" (core modules and units), "Documentation"
 * (core docs pages) and "Related in practice" (supporting picks, each with how it relates and why).
 * A tab with nothing in it is left out; a task with no pick at all says so.
 */

import { RELATIONS } from "./course-format.mjs";
import { squish } from "./course-guide.mjs";

export const TRACKING = "?WT.mc_id=studentamb_165290";
export const SUPPORTING_TAB = "Related in practice";

/** The address of a Learn target with the hub's tracking parameter and no locale. */
export function learnHref(path) {
  return `https://learn.microsoft.com${path}${TRACKING}`;
}

/** Text for a double-quoted JSX attribute: no line breaks, no double quotes. */
const attr = (text) => squish(text).replace(/"/g, "'");
/** Text for a markdown heading or a paragraph: nothing MDX would read as an expression or a tag. */
const plain = (text) => squish(text).replace(/[{}<>]/g, (c) => `\\${c}`);
const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function card(pick, indent) {
  const description =
    pick.class === "supporting"
      ? ` description="${attr(clip(`${RELATIONS[pick.relation].label}: ${pick.why}`, 220))}"`
      : "";
  return `${indent}<LinkCard title="${attr(pick.title)}" href="${learnHref(pick.target.path)}" target="_blank"${description}/>`;
}

function tab(label, picks) {
  if (picks.length === 0) return [];
  return [
    `  <TabItem label="${label}">`,
    "    <CardGrid>",
    ...picks.map((p) => card(p, "      ")),
    "    </CardGrid>",
    "  </TabItem>",
  ];
}

/** The weight of a domain as " (20–25%)", or "" when the guide gave none. */
function weightText(weight) {
  if (!weight) return "";
  return weight.min === weight.max
    ? ` (${weight.min}%)`
    : ` (${weight.min}–${weight.max}%)`;
}

/**
 * Render a validated course file to MDX (a string ending in a newline). The page is a draft unless `draft` is
 * false: every route of the site leaves a draft out (and so do the sitemap, the search index and the MCP
 * bundle), so a generated course is not published until the maintainer says so.
 */
export function renderCourse(course, { draft = true } = {}) {
  const exam = `${course.code}: ${course.name}`;
  const guideUrl = `https://learn.microsoft.com/credentials/certifications/resources/study-guides/${course.code.toLowerCase()}${TRACKING}`;
  const version = course.inputs?.guideAsOf
    ? ` (${plain(course.inputs.guideAsOf)} version)`
    : "";
  const out = [
    "---",
    `title: ${course.code} Study Guide Course`,
    `description: "${attr(`A task-by-task walkthrough of the ${exam} skills measured, with Microsoft Learn training and documentation for every task in the official study guide.`)}"`,
    ...(draft ? ["draft: true"] : []),
    "---",
    "import { LinkCard, CardGrid, Tabs, TabItem } from '@components/docs';",
    "",
    ":::note",
    `Structured directly from the [official ${course.code} study guide](${guideUrl}) skills measured${version}. Each task links to the relevant Microsoft Learn training and documentation. "${SUPPORTING_TAB}" lists material the guide does not name but that you meet when you do the task at work.`,
    ":::",
    "",
  ];
  for (const domain of course.domains) {
    out.push(`## ${plain(domain.title)}${weightText(domain.weight)}`, "");
    for (const group of domain.groups) {
      out.push(`### ${plain(group.title)}`, "");
      for (const task of group.tasks) {
        out.push(`#### ${plain(task.text)}`, "");
        const picks = task.picks ?? [];
        const core = picks.filter((p) => p.class === "core");
        const tabs = [
          ...tab(
            "Learning",
            core.filter((p) => p.target.kind !== "docs"),
          ),
          ...tab(
            "Documentation",
            core.filter((p) => p.target.kind === "docs"),
          ),
          ...tab(
            SUPPORTING_TAB,
            picks.filter((p) => p.class === "supporting"),
          ),
        ];
        if (tabs.length === 0)
          out.push(
            ":::note",
            "No Learn module or documentation page covers this task yet.",
            ":::",
            "",
          );
        else out.push("<Tabs>", ...tabs, "</Tabs>", "");
      }
    }
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
