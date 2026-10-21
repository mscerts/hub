/**
 * The fundamentals of a skill group (maintainer, 2026-10-21): everything theoretical a learner should know BEFORE
 * they start the group's tasks, as a learning path for a fundamentals exam would teach it, but scoped to one skill
 * group (the `###` heading of the page: "Manage Microsoft Entra users and groups"). It is liberal on purpose: the
 * point is that the learner has the whole conceptual base before the tasks, which are more advanced.
 *
 * A group's fundamentals travel through the pipeline as a pseudo-task of the group with the key
 * `<domain>/<group>/@foundations`: the generator searches for it, the judge answers `foundation` or `reject` for
 * it, the gates decide it like any other candidate, and the builder puts the accepted pages into the group's
 * `foundations` list of the course file. This file holds the helpers every step shares. Pure: no I/O.
 */

import { squish } from "./course-guide.mjs";
import { queryTerms, termCoverage } from "./course-lexical.mjs";

/** The class of a fundamentals pick (the classes of a task's picks are core and supporting). */
export const FOUNDATION_CLASS = "foundation";

/** The last segment of the pseudo-task key of a group's fundamentals. */
export const FOUNDATION_KEY_SUFFIX = "@foundations";

/**
 * How much of the group's words a page must contain, per provenance. The query of the word search is the group's
 * title and the wording of ALL its tasks together, so a page matches only part of it: the thresholds are low to
 * compensate (a task's own are 0.34, 0.5, 0.5 and 0.6). With the title alone and thresholds this low the search takes
 * every page that mentions "users" or "groups", which is why the title is not used alone. A concept page that shares no
 * word with the group is found by the generator's concept pass instead.
 */
export const FOUNDATION_DEFAULTS = Object.freeze({
  minCoverage: Object.freeze({ P1: 0.15, P2: 0.25, P3: 0.25, P4: 0.3 }),
});

/** The key of the skill group a task key belongs to (`<domain>/<group>`). */
export const groupKeyOf = (taskKey) =>
  String(taskKey).split("/").slice(0, 2).join("/");

/** The pseudo-task key of the fundamentals of a skill group. */
export const foundationKey = (groupKey) =>
  `${groupKey}/${FOUNDATION_KEY_SUFFIX}`;

export const isFoundationKey = (key) =>
  typeof key === "string" && key.endsWith(`/${FOUNDATION_KEY_SUFFIX}`);

/**
 * The fundamentals pseudo-tasks of a study guide tree or a course file, one per skill group that has a task, in the
 * order of the page: [{ key, text, domain, group, tasks, foundation: true }]. `text` is the group's title; `tasks`
 * the wording of its tasks, which is what a search for the group's concepts is built from.
 */
export function flattenFoundations(tree) {
  const out = [];
  for (const domain of tree.domains ?? [])
    for (const group of domain.groups ?? []) {
      const first = group.tasks?.[0]?.key;
      if (!first) continue;
      out.push({
        key: foundationKey(groupKeyOf(first)),
        text: squish(group.title),
        domain: squish(domain.title),
        group: squish(group.title),
        tasks: group.tasks.map((t) => squish(t.text)),
        foundation: true,
      });
    }
  return out;
}

/** At least this share of a task's own words must be in a page for it to lead into that task. */
const LEADS_INTO = 0.5;

/**
 * Which task of the group a fundamentals pick leads into: the index of the task whose OWN words the page (its title,
 * the judge's reason and the quote) covers best, the first of them on a tie, or -1 when no task qualifies: a general
 * concept behind the whole group. A task's own words are its distinctive words minus those of the group's title
 * (`groupTitle`: "Microsoft Entra users and groups" is what every task of the group is about, so a page that only says
 * that is general) and minus short words such as "id".
 */
export function taskIndexOf(pick, taskTexts, groupTitle = "") {
  const text = [pick.title, pick.why, pick.evidence].filter(Boolean).join(" ");
  const without = new Set(queryTerms(groupTitle).terms.map((t) => t.term));
  let best = -1;
  let bestCoverage = 0;
  taskTexts.forEach((taskText, i) => {
    const coverage = termCoverage(taskText, text, {
      without,
      emptyIs: 0,
      minWordLength: 3,
    });
    if (coverage >= LEADS_INTO && coverage > bestCoverage) {
      best = i;
      bestCoverage = coverage;
    }
  });
  return best;
}

/**
 * A group's fundamentals in the order a learner meets them (maintainer, 2026-10-21): the general concepts first, the
 * pages that fit no single task, then the pages in the order of the tasks they lead into, each task's pages in the
 * order they came in (the builder's pick order). Returns a new list.
 */
export function orderFoundations(picks, taskTexts, groupTitle = "") {
  return picks
    .map((pick, i) => ({
      pick,
      i,
      task: taskIndexOf(pick, taskTexts, groupTitle),
    }))
    .sort((a, b) => a.task - b.task || a.i - b.i)
    .map((entry) => entry.pick);
}
