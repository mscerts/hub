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
 * A skill group that has fundamentals (docs/courses.md, scripts/lib/course-foundations.mjs) opens with them: a
 * "Fundamentals" block of the same Learning and Documentation tabs, before the group's tasks, for the learner to
 * read first.
 *
 * The review copy (`review`, the picks course-build.mjs lists in FILE.review.json) is the same page with the picks
 * the judge was not sure of, or flagged as another role or product area, in orange and numbered in page order,
 * each with the judge's reason in its card. It exists so that the maintainer can look at those picks in the place
 * where they would be read, and answer with the numbers to drop.
 */

import { foundationKey, groupKeyOf } from "./course-foundations.mjs";
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

/** Picks split into the two tabs of the page: the Learning tab (modules and units), then the Documentation tab. */
const byTab = (picks) => ({
  learning: picks.filter((p) => p.target.kind !== "docs"),
  docs: picks.filter((p) => p.target.kind === "docs"),
});

/** The picks of a task as the page shows them: the Learning tab, then the Documentation tab; core before supporting. */
function shownPicks(task) {
  const all = task.picks ?? [];
  return byTab([
    ...all.filter((p) => p.class === "core"),
    ...all.filter((p) => p.class === "supporting"),
  ]);
}

/** The pseudo-task key of a group's fundamentals, or null when the group has none to show. */
function foundationsOf(group) {
  const first = group.tasks?.[0]?.key;
  return first && group.foundations?.length
    ? { key: foundationKey(groupKeyOf(first)), ...byTab(group.foundations) }
    : null;
}

/**
 * The marked picks of a review file in the order the page shows them, numbered from 1:
 * [{ n, task, path, reasons, why, ... }]. A mark whose pick is not in the course is left out, so a review file of
 * another build is noticed by its length. The page and the command that applies the maintainer's answers both
 * take their numbers from here. `only` (a text) numbers just the skill groups whose title contains it, as a page
 * rendered with the same `only` shows them.
 */
export function numberReview(course, review, { only = null } = {}) {
  const marks = new Map(
    (review?.picks ?? []).map((m) => [`${m.task}|${m.path}`, m]),
  );
  const numbered = [];
  for (const domain of course.domains)
    for (const group of domain.groups.filter((g) => shownGroup(g, only))) {
      const shown = [];
      const foundations = foundationsOf(group);
      if (foundations)
        shown.push([
          foundations.key,
          [...foundations.learning, ...foundations.docs],
        ]);
      for (const task of group.tasks) {
        const { learning, docs } = shownPicks(task);
        shown.push([task.key, [...learning, ...docs]]);
      }
      for (const [key, picks] of shown)
        for (const pick of picks) {
          const m = marks.get(`${key}|${pick.target.path}`);
          if (m) numbered.push({ ...m, n: numbered.length + 1 });
        }
    }
  return numbered;
}

/** Whether a skill group is on the page: always, unless `only` (a text) asks for the groups whose title contains it. */
const shownGroup = (group, only) =>
  !only || squish(group.title).toLowerCase().includes(only.toLowerCase());

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
 * `only` (a text) renders just the skill groups whose title contains it, as a preview of one group.
 */
export function renderCourse(
  course,
  { labPage = null, review = null, only = null } = {},
) {
  const exam = `${course.code}: ${course.name}`;
  const guideUrl = `https://learn.microsoft.com/credentials/certifications/resources/study-guides/${course.code.toLowerCase()}${TRACKING}`;
  const version = course.inputs?.guideAsOf
    ? ` (${plain(course.inputs.guideAsOf)} version)`
    : "";
  const marks = new Map(
    numberReview(course, review, { only }).map((m) => [
      `${m.task}|${m.path}`,
      m,
    ]),
  );
  const hasFoundations = course.domains.some((d) =>
    (d.groups ?? []).some((g) => g.foundations?.length),
  );
  const out = [
    "---",
    `title: ${course.code} Study Guide Course${only ? " (one skill group)" : ""}${review ? " (review copy)" : ""}`,
    `description: "${attr(`A task-by-task walkthrough of the ${exam} skills measured, with Microsoft Learn training and documentation for every task in the official study guide.`)}"`,
    "---",
    "import { LinkCard, CardGrid, Tabs, TabItem } from '@components/docs';",
    "",
    ":::note",
    `Structured directly from the [official ${course.code} study guide](${guideUrl}) skills measured${version}. Each task links to the relevant Microsoft Learn training and documentation.${hasFoundations ? " Each skill group opens with its fundamentals, the theory behind its tasks, to read before the tasks." : ""} Exercises, guided projects, tutorials and quickstarts are on ${labPage ? `the [${course.code} labs page](${labPage})` : "the lab page"}, not here, and every page appears once.`,
    ":::",
    "",
  ];
  if (only)
    out.push(
      ":::caution",
      `This is a preview of the skill groups whose title contains "${plain(only)}", not the whole course.`,
      ":::",
      "",
    );
  if (review)
    out.push(
      ":::caution",
      `This is the review copy. Every page the judge picked is here. The ${marks.size} orange cards are the ones it was not sure about, or flagged as written for another job role or product area; each says why. To drop one, give its number.`,
      ":::",
      "",
    );
  for (const domain of course.domains) {
    const groups = domain.groups.filter((g) => shownGroup(g, only));
    if (groups.length === 0) continue;
    out.push(`## ${plain(domain.title)}${weightText(domain.weight)}`, "");
    for (const group of groups) {
      out.push(`### ${plain(group.title)}`, "");
      const foundations = foundationsOf(group);
      if (foundations) {
        const markOf = (pick) =>
          marks.get(`${foundations.key}|${pick.target.path}`) ?? null;
        out.push(
          "#### Fundamentals",
          "",
          "The concepts behind the tasks of this skill group. Work through them first: the tasks below assume you know them.",
          "",
          "<Tabs>",
          ...tab("Learning", foundations.learning, markOf),
          ...tab("Documentation", foundations.docs, markOf),
          "</Tabs>",
          "",
        );
      }
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
