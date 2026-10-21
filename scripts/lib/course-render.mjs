/**
 * Course file -> course page (MDX for the docs system). Pure: no I/O.
 * The page is generated and never edited by hand: change the course file and render again.
 *
 * Layout, in the style of the docs the hub already has: `##` domain with its weight, `###` skill group,
 * `####` task, and under every task a Tabs block with two tabs: "Learning" (modules and units) and
 * "Documentation" (docs pages). Core picks come first in each tab; a supporting pick follows them (maintainer,
 * 2026-10-20: no separate tab for them; 2026-10-21: no description on any button, the relation and the reason
 * stay in the course file). A tab with nothing in it is left out; a task with no pick at all says so.
 *
 * There are no draft pages (maintainer, 2026-10-21): a generated page is an ordinary page of the site, and it is
 * only reachable from the exam pages, the sidebar or the landing page when the maintainer links it there.
 *
 * The review copy (`review`, the picks course-build.mjs lists in FILE.review.json) is the same page with the picks
 * the judge was not sure of, or flagged as another role or product area, in orange and numbered in page order,
 * each with the judge's reason in its card. It exists so that the maintainer can look at those picks in the place
 * where they would be read, and answer with the numbers to drop.
 */

import { squish } from "./course-guide.mjs";

export const TRACKING = "?WT.mc_id=studentamb_165290";

/** The address of a Learn target with the hub's tracking parameter and no locale. */
export function learnHref(path) {
  return `https://learn.microsoft.com${path}${TRACKING}`;
}

/** Text for a double-quoted JSX attribute: no line breaks, no double quotes. */
const attr = (text) => squish(text).replace(/"/g, "'");
/** Text for a markdown heading or a paragraph: nothing MDX would read as an expression or a tag. */
const plain = (text) => squish(text).replace(/[{}<>]/g, (c) => `\\${c}`);

const FLAG_TEXT = {
  "other-role": "Flagged as another job role",
  "other-sub-product": "Flagged as another product area",
  "licensing-tier": "Flagged as another licensing tier",
};

/** What a marked card says before the judge's reason: why it is marked, e.g. "Not sure · Flagged as another job role". */
export function reviewLabel(reasons) {
  const parts = [];
  for (const reason of reasons) {
    if (/not sure/.test(reason)) parts.push("Not sure");
    else {
      const flags = reason.replace(/^flagged:\s*/, "").split(/,\s*/);
      for (const f of flags) parts.push(FLAG_TEXT[f] ?? `Flagged ${f}`);
    }
  }
  return [...new Set(parts)].join(" · ");
}

function card(pick, indent, mark) {
  const base = `${indent}<LinkCard title="${attr(pick.title)}" href="${learnHref(pick.target.path)}" target="_blank"`;
  if (!mark) return `${base}/>`;
  const text = `#${mark.n} ${reviewLabel(mark.reasons)}. ${mark.why}`;
  return `${base} tone="review" description="${attr(text)}"/>`;
}

/** The tab of a task. `markOf(pick)` returns the numbered review mark of a pick, or null. */
function tab(label, picks, markOf) {
  if (picks.length === 0) return [];
  return [
    `  <TabItem label="${label}">`,
    "    <CardGrid>",
    ...picks.map((p) => card(p, "      ", markOf(p))),
    "    </CardGrid>",
    "  </TabItem>",
  ];
}

/** The picks of a task as the page shows them: the Learning tab, then the Documentation tab; core before supporting. */
function shownPicks(task) {
  const all = task.picks ?? [];
  const picks = [
    ...all.filter((p) => p.class === "core"),
    ...all.filter((p) => p.class === "supporting"),
  ];
  return {
    learning: picks.filter((p) => p.target.kind !== "docs"),
    docs: picks.filter((p) => p.target.kind === "docs"),
  };
}

/**
 * The marked picks of a review file in the order the page shows them, numbered from 1:
 * [{ n, task, path, reasons, why, ... }]. A mark whose pick is not in the course is left out, so a review file of
 * another build is noticed by its length. The page and the command that applies the maintainer's answers both
 * take their numbers from here.
 */
export function numberReview(course, review) {
  const marks = new Map(
    (review?.picks ?? []).map((m) => [`${m.task}|${m.path}`, m]),
  );
  const numbered = [];
  for (const domain of course.domains)
    for (const group of domain.groups)
      for (const task of group.tasks) {
        const { learning, docs } = shownPicks(task);
        for (const pick of [...learning, ...docs]) {
          const m = marks.get(`${task.key}|${pick.target.path}`);
          if (m) numbered.push({ ...m, n: numbered.length + 1 });
        }
      }
  return numbered;
}

/** The weight of a domain as " (20–25%)", or "" when the guide gave none. */
function weightText(weight) {
  if (!weight) return "";
  return weight.min === weight.max
    ? ` (${weight.min}%)`
    : ` (${weight.min}–${weight.max}%)`;
}

/**
 * Render a validated course file to MDX (a string ending in a newline). `labPage` is the address of the exam's
 * lab page, which the opening note links when the hub has one. `review` is the review file of the build
 * ({ picks: [{ task, path, reasons, why }] }); with it the page is the review copy (see the top of this file).
 */
export function renderCourse(course, { labPage = null, review = null } = {}) {
  const exam = `${course.code}: ${course.name}`;
  const guideUrl = `https://learn.microsoft.com/credentials/certifications/resources/study-guides/${course.code.toLowerCase()}${TRACKING}`;
  const version = course.inputs?.guideAsOf
    ? ` (${plain(course.inputs.guideAsOf)} version)`
    : "";
  const marks = new Map(
    numberReview(course, review).map((m) => [`${m.task}|${m.path}`, m]),
  );
  const out = [
    "---",
    `title: ${course.code} Study Guide Course${review ? " (review copy)" : ""}`,
    `description: "${attr(`A task-by-task walkthrough of the ${exam} skills measured, with Microsoft Learn training and documentation for every task in the official study guide.`)}"`,
    "---",
    "import { LinkCard, CardGrid, Tabs, TabItem } from '@components/docs';",
    "",
    ":::note",
    `Structured directly from the [official ${course.code} study guide](${guideUrl}) skills measured${version}. Each task links to the relevant Microsoft Learn training and documentation. Exercises, guided projects, tutorials and quickstarts are on ${labPage ? `the [${course.code} labs page](${labPage})` : "the lab page"}, not here, and every page appears once.`,
    ":::",
    "",
  ];
  if (review)
    out.push(
      ":::caution",
      `This is the review copy. Every page the judge picked is here. The ${marks.size} orange cards are the ones it was not sure about, or flagged as written for another job role or product area; each says why. To drop one, give its number.`,
      ":::",
      "",
    );
  for (const domain of course.domains) {
    out.push(`## ${plain(domain.title)}${weightText(domain.weight)}`, "");
    for (const group of domain.groups) {
      out.push(`### ${plain(group.title)}`, "");
      for (const task of group.tasks) {
        out.push(`#### ${plain(task.text)}`, "");
        const { learning, docs } = shownPicks(task);
        const markOf = (pick) =>
          marks.get(`${task.key}|${pick.target.path}`) ?? null;
        const tabs = [
          ...tab("Learning", learning, markOf),
          ...tab("Documentation", docs, markOf),
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
