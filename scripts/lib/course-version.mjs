/**
 * Which version of an exam's study guide a course follows (docs/courses.md, "The two versions").
 *
 * The history of a guide (src/data_files/study-guide-history/<CODE>.json) keeps every version Microsoft published,
 * each with the day it says its skills are measured from (`asOf`, null when the guide states none) and the day the
 * hub first saw it. A course names its version in `inputs.guideVersion` as { n, asOf, firstSeen }, so it can be
 * checked against that version and not against whatever the live page says today: while a change is upcoming the
 * live page already carries the new version, and the course in force still follows the old one.
 *
 * Everything here is pure.
 */

import { guideVersionProblem } from "./course-format.mjs";
import { parseGuide } from "./course-guide.mjs";
import { planGuideChanges } from "./course-status.mjs";

export { guideVersionProblem };

/** The reference a course stores for a history version. */
export const versionRef = (version) => ({
  n: version.n,
  asOf: version.asOf ?? null,
  firstSeen: version.firstSeen,
});

/** The history version a course names, or null. */
export function findVersion(history, ref) {
  if (!ref) return null;
  return (history?.versions ?? []).find((v) => v.n === ref.n) ?? null;
}

/** The parsed guide (course-guide.mjs parseGuide) of a history version; `ok` says whether it parsed completely. */
export const guideOfVersion = (version) => parseGuide(version?.lines ?? []);

/** Whether a course has exactly the tasks of a parsed guide, in the same places and order. */
export function followsGuide(course, guide) {
  return guide.ok === true && !planGuideChanges(guide, course).treeChanged;
}

/** The history versions whose tasks a course has, oldest first (a version that does not parse never matches). */
export function versionsMatching(history, course) {
  return (history?.versions ?? []).filter((version) =>
    followsGuide(course, guideOfVersion(version)),
  );
}

/**
 * The version a course was most likely built for, when it does not name one: of the versions with its tasks, the
 * newest the hub had already seen on the day the course was built, else the newest of them. Null when no version
 * has its tasks (the course is out of date, or the history is missing).
 */
export function builtForVersion(history, course) {
  const matching = versionsMatching(history, course);
  if (matching.length === 0) return null;
  const builtAt = course.inputs?.builtAt ?? null;
  const seen = builtAt
    ? matching.filter((v) => v.firstSeen <= builtAt)
    : matching;
  return (seen.length ? seen : matching).at(-1);
}

/** The course with its version recorded in `inputs`, key order kept: guideVersion goes after guideHash/guideAsOf. */
export function withVersion(course, ref) {
  const entries = Object.entries(course.inputs ?? {}).filter(
    ([key]) => key !== "guideVersion",
  );
  let after = -1;
  entries.forEach(([key], i) => {
    if (key === "guideHash" || key === "guideAsOf") after = i;
  });
  entries.splice(after + 1, 0, ["guideVersion", ref]);
  return { ...course, inputs: Object.fromEntries(entries) };
}
