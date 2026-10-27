/**
 * The course file: the source of truth of one exam's course (src/data_files/courses/<CODE>.json), and its
 * validator. Pure: no I/O, no network (URL freshness and catalog titles are injected).
 * The page is generated from this file (course-render.mjs); the file is never edited to match a page.
 * Format, classes and approval rules: docs/courses.md.
 *
 * A course file is the study guide's tree (domain > skill group > task, exactly as scripts/lib/course-guide.mjs
 * parses it) with a list of picks under every task: Learn modules, units and documentation pages.
 *
 * A skill group may also carry `foundations`: the pages that teach the theory a learner needs before the group's
 * tasks (scripts/lib/course-foundations.mjs). They are picks of the class `foundation`, shown once in the whole
 * course like every other page.
 *
 * Two classes of pick under a task, and nothing else:
 *   core        covers the listed task as the guide words it.
 *   supporting  is NOT in the guide, but is part of the job the task belongs to: a professional doing the
 *               listed task meets it (a prerequisite, a neighbouring step of the same workflow, running or
 *               troubleshooting what the task sets up, a deeper look at the same feature). It must say why
 *               (`why`) and how it relates (`relation`). Material from another role, product area or
 *               licensing tier is NOT supporting; it is out of scope and is rejected, however close the
 *               keywords look (an access review of an access package in entitlement management is not part
 *               of managing external users for an Azure administrator).
 */

import { audienceProblems, eachConcept } from "./course-audience.mjs";
import { isClassic } from "./course-classic.mjs";
import {
  FOUNDATION_CLASS,
  foundationKey,
  groupKeyOf,
} from "./course-foundations.mjs";
import { handsOnReason } from "./course-handson.mjs";
import { diffTrees, squish } from "./course-guide.mjs";
import { fingerprintOfSnapshot } from "./course-scope.mjs";

export const COURSE_SCHEMA_VERSION = 1;

export const CLASSES = Object.freeze(["core", "supporting"]);

/** How a supporting pick relates to the task it sits under; `meaning` is shown to the judge and in the docs. */
export const RELATIONS = Object.freeze({
  prerequisite: {
    label: "Prerequisite",
    meaning: "needed before the listed task can be done",
  },
  "same-workflow": {
    label: "Same workflow",
    meaning: "a neighbouring step of the job the listed task belongs to",
  },
  operate: {
    label: "Operate and troubleshoot",
    meaning: "running, monitoring or fixing what the listed task sets up",
  },
  deeper: {
    label: "Deeper dive",
    meaning: "more depth on the same feature than the exam asks for",
  },
});

/**
 * Where a pick came from: P1 a module or unit of the exam's own official course, P2 a documentation page
 * that such a module lists in its last unit, P3 material of another exam's official course, P4 anything
 * else found by searching the catalogs, P5 a page a model named from its own knowledge for the task and a
 * script confirmed exists (docs/course-proposals.md).
 */
export const SOURCES = Object.freeze(["P1", "P2", "P3", "P4", "P5"]);

export const PICK_KINDS = Object.freeze(["module", "unit", "docs"]);
/**
 * Who decided a pick: `auto` (the gates took it: the judge was sure of it, whatever the source;
 * docs/course-gates.md) or `maintainer` (an answer of the review queue). The format does not limit which sources
 * the gates may accept (maintainer, 2026-10-20: a pick the judge is sure of, of any source, goes in), so the validator
 * checks that a decider is named, not who it was.
 */
export const DECIDERS = Object.freeze(["auto", "maintainer"]);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_PATH = /^\/[a-z0-9][a-z0-9._~()%/-]*$/;
const isDay = (value) =>
  typeof value === "string" &&
  ISO_DAY.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const present = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Check one pick (without its context); returns a list of problems. `foundation` is true for a pick of a group's
 * fundamentals, whose class is `foundation` (it has a `why`, no relation) instead of core or supporting.
 */
export function pickProblems(pick, { foundation = false } = {}) {
  const problems = [];
  if (!pick || typeof pick !== "object") return ["a pick is not an object"];
  if (!pick.target || !PICK_KINDS.includes(pick.target.kind))
    problems.push(`target.kind must be one of ${PICK_KINDS.join(", ")}`);
  // a module is placed as a module, once (maintainer, 2026-10-21): the units of a module are not picks of a course
  if (pick.target?.kind === "unit")
    problems.push(
      "a course places a module, not its units: the pick must be the module (/training/modules/<slug>); a hands-on unit belongs on the lab page",
    );
  const path = pick.target?.path;
  if (!present(path) || !CANONICAL_PATH.test(path) || path.endsWith("/"))
    problems.push(
      `target.path "${path}" is not a canonical Learn path (lower case, no host, locale, query or trailing slash)`,
    );
  else if (
    pick.target?.kind === "module" &&
    !/^\/training\/modules\/[^/]+$/.test(path)
  )
    problems.push(
      `a module target must be /training/modules/<slug>, got ${path}`,
    );
  else if (
    pick.target?.kind === "unit" &&
    !/^\/training\/modules\/[^/]+\/[^/]+$/.test(path)
  )
    problems.push(
      `a unit target must be /training/modules/<slug>/<unit>, got ${path}`,
    );
  else if (pick.target?.kind === "docs" && /^\/training\//.test(path))
    problems.push(`a docs target is not a training page: ${path}`);
  if (!present(pick.title)) problems.push("title is missing");
  if (foundation) {
    if (pick.class !== FOUNDATION_CLASS)
      problems.push(`a fundamentals pick has the class ${FOUNDATION_CLASS}`);
    if (pick.relation !== undefined && pick.relation !== null)
      problems.push("a fundamentals pick has no relation");
    if (!present(pick.why))
      problems.push(
        "a fundamentals pick must say which concept it teaches (why)",
      );
  } else if (!CLASSES.includes(pick.class))
    problems.push(`class must be one of ${CLASSES.join(", ")}`);
  if (!SOURCES.includes(pick.source))
    problems.push(`source must be one of ${SOURCES.join(", ")}`);
  if (
    pick.class === "core" &&
    pick.relation !== undefined &&
    pick.relation !== null
  )
    problems.push("a core pick has no relation");
  if (pick.class === "supporting") {
    if (!RELATIONS[pick.relation])
      problems.push(
        `a supporting pick needs a relation: ${Object.keys(RELATIONS).join(", ")}`,
      );
    if (!present(pick.why))
      problems.push(
        "a supporting pick must say why a professional doing the task meets it (why)",
      );
  }
  if (
    (pick.class === "supporting" ||
      pick.class === FOUNDATION_CLASS ||
      pick.source === "P3" ||
      pick.source === "P4" ||
      pick.source === "P5") &&
    !present(pick.evidence)
  )
    problems.push(
      "evidence is required for a supporting or fundamentals pick and for material found outside the exam's own course",
    );
  const decision = pick.decision;
  if (!decision || !DECIDERS.includes(decision.by) || !isDay(decision.at))
    problems.push("decision must be { by: auto | maintainer, at: YYYY-MM-DD }");
  if (pick.was !== undefined && !present(pick.was))
    problems.push("was must be a non-empty path when present");
  // `via`: the module whose last unit lists a documentation page. It lets the rebuild check trace a change of
  // that module's resource list to the picks it affects.
  if (pick.source === "P2") {
    if (pick.target?.kind !== "docs")
      problems.push(
        "a P2 pick is a documentation page a module lists, so its target.kind is docs",
      );
    if (!MODULE_PATH.test(pick.via ?? ""))
      problems.push(
        "a P2 pick needs via: the /training/modules/<slug> whose last unit lists it",
      );
  } else if (pick.via !== undefined && !MODULE_PATH.test(pick.via)) {
    problems.push("via must be a /training/modules/<slug> path when present");
  }
  return problems;
}

const MODULE_PATH = /^\/training\/modules\/[^/]+$/;

const tupleOf = (entry, length) =>
  Array.isArray(entry) &&
  entry.length === length &&
  entry.every((v) => typeof v === "string");

/**
 * The shape of the snapshot parts of `inputs`: `scope` = { courses: [[number, lastModified]], modules:
 * [[path, unitSig, linksHash]] } (scope-snapshot of course-scope.mjs) and the optional `picked` =
 * [[modulePath, unitSig]] for every module outside the exam's official course that a pick depends on.
 * Returns a problem text, or null.
 */
function snapshotShapeProblem(scope, picked) {
  if (
    !scope ||
    !Array.isArray(scope.courses) ||
    !Array.isArray(scope.modules) ||
    !scope.courses.every((e) => tupleOf(e, 2)) ||
    !scope.modules.every((e) => tupleOf(e, 3))
  )
    return "inputs.scope must be { courses: [[number, lastModified]], modules: [[path, unitSig, linksHash]] }, the snapshot of the exam scope map";
  if (
    picked !== undefined &&
    !(Array.isArray(picked) && picked.every((e) => tupleOf(e, 2)))
  )
    return "inputs.picked must be a list of [modulePath, unitSig] pairs";
  return null;
}

/** The module a pick depends on: its own module (module or unit target), or the one it was listed by (`via`), else null. */
export function moduleOfPick(pick) {
  const target = pick?.target;
  if (target?.kind === "module" || target?.kind === "unit") {
    return target.path.split("/").slice(0, 4).join("/");
  }
  return MODULE_PATH.test(pick?.via ?? "") ? pick.via : null;
}

/**
 * The picks of a course file as { domain, group, task, pick } rows, in the order of the page. The fundamentals of a
 * group come first, with the pseudo-task `{ key: <group>/@foundations, text: "Fundamentals", foundation: true }`
 * as their `task`.
 */
export function* eachPick(course) {
  for (const domain of course.domains ?? []) {
    for (const group of domain.groups ?? []) {
      const first = group.tasks?.[0]?.key;
      if (first && group.foundations?.length) {
        const task = {
          key: foundationKey(groupKeyOf(first)),
          text: "Fundamentals",
          foundation: true,
        };
        for (const pick of group.foundations)
          yield { domain, group, task, pick };
      }
      for (const task of group.tasks ?? []) {
        for (const pick of task.picks ?? [])
          yield { domain, group, task, pick };
      }
    }
  }
}

/** Counts for a summary line. */
export function courseStats(course) {
  const stats = {
    tasks: 0,
    tasksWithCore: 0,
    tasksWithoutPicks: 0,
    picks: 0,
    core: 0,
    supporting: 0,
    foundation: 0,
    bySource: { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 },
    byKind: { module: 0, unit: 0, docs: 0 },
    byDecider: { auto: 0, maintainer: 0 },
  };
  const count = (pick) => {
    stats.picks++;
    if (pick.class in stats) stats[pick.class]++;
    if (pick.source in stats.bySource) stats.bySource[pick.source]++;
    if (pick.target?.kind in stats.byKind) stats.byKind[pick.target.kind]++;
    if (pick.decision?.by in stats.byDecider)
      stats.byDecider[pick.decision.by]++;
  };
  for (const domain of course.domains ?? []) {
    for (const group of domain.groups ?? []) {
      for (const pick of group.foundations ?? []) count(pick);
      for (const task of group.tasks ?? []) {
        stats.tasks++;
        const picks = task.picks ?? [];
        if (picks.length === 0) stats.tasksWithoutPicks++;
        if (picks.some((p) => p.class === "core")) stats.tasksWithCore++;
        for (const pick of picks) count(pick);
      }
    }
  }
  return stats;
}

/**
 * Validate a course file.
 *   course     the parsed JSON
 *   guide      the parsed study guide (course-guide.mjs parseGuide), so the tree and the task keys can be compared
 *   isCurrent  (path, kind) => { ok: boolean, reason?: string } | undefined: whether a target is a live,
 *              current Learn page (learnsync's validator in the CLI); left out, URLs are not checked
 *   titleOf    (path) => string | undefined: the catalog title of a target; a different `title` is a warning
 * Returns { ok, errors, warnings, stats }. `ok` is true only when there is no error.
 */
export function validateCourse(course, { guide, isCurrent, titleOf } = {}) {
  const errors = [];
  const warnings = [];
  if (!course || typeof course !== "object" || Array.isArray(course))
    return {
      ok: false,
      errors: ["the course file is not an object"],
      warnings,
      stats: courseStats({}),
    };
  if (course.schemaVersion !== COURSE_SCHEMA_VERSION)
    errors.push(
      `schemaVersion must be ${COURSE_SCHEMA_VERSION}, got ${JSON.stringify(course.schemaVersion)}`,
    );
  if (!/^[A-Z]{2,3}-\d{3}$/.test(String(course.code ?? "")))
    errors.push(`code "${course.code}" is not an exam code`);
  if (!present(course.name)) errors.push("name (the exam name) is missing");
  const inputs = course.inputs ?? {};
  if (!present(inputs.guideHash)) errors.push("inputs.guideHash is missing");
  if (!/^[0-9a-f]{40}$/.test(String(inputs.scopeFingerprint ?? "")))
    errors.push(
      "inputs.scopeFingerprint must be the 40-character fingerprint of the exam scope map",
    );
  if (!isDay(inputs.builtAt)) errors.push("inputs.builtAt must be YYYY-MM-DD");
  // the snapshot of what the course was built from: the rebuild check compares it with today's
  const scopeModules = new Set();
  const snapshotProblem = snapshotShapeProblem(inputs.scope, inputs.picked);
  if (snapshotProblem) errors.push(snapshotProblem);
  else {
    for (const [path] of inputs.scope.modules) scopeModules.add(path);
    if (
      /^[0-9a-f]{40}$/.test(String(inputs.scopeFingerprint ?? "")) &&
      fingerprintOfSnapshot(inputs.scope) !== inputs.scopeFingerprint
    )
      errors.push(
        "inputs.scopeFingerprint is not the fingerprint of inputs.scope",
      );
  }
  const pickedModules = new Set(
    (inputs.picked ?? []).map((entry) => entry?.[0]),
  );
  if (!Array.isArray(course.domains) || course.domains.length === 0) {
    errors.push("domains is missing or empty");
    return { ok: false, errors, warnings, stats: courseStats(course) };
  }

  // the tree must be the guide's tree, key for key
  if (guide) {
    if (!guide.ok)
      errors.push(
        "the study guide does not parse completely, so the course cannot be checked against it",
      );
    const { differences } = diffTrees(guide, course);
    for (const d of differences)
      errors.push(
        `tree differs from the study guide: ${d.kind} ${d.at.join(" > ")}`,
      );
    if (differences.length === 0) {
      const wanted = guide.domains.flatMap((d) =>
        d.groups.flatMap((g) => g.tasks.map((t) => t.key)),
      );
      const actual = course.domains.flatMap((d) =>
        (d.groups ?? []).flatMap((g) => (g.tasks ?? []).map((t) => t.key)),
      );
      if (
        wanted.length !== actual.length ||
        wanted.some((key, i) => key !== actual[i])
      )
        errors.push(
          "task keys differ from the study guide's keys (or their order does)",
        );
    }
    if (inputs.guideHash && guide.hash && inputs.guideHash !== guide.hash)
      warnings.push(
        "inputs.guideHash is not the guide's current hash: the guide changed since the course was built",
      );
  }

  const rejected = Array.isArray(course.rejected) ? course.rejected : [];
  const rejectedPairs = new Set();
  for (const entry of rejected) {
    if (
      !present(entry?.taskKey) ||
      !present(entry?.path) ||
      !present(entry?.reason) ||
      !isDay(entry?.at)
    )
      errors.push(
        `a rejected entry needs taskKey, path, reason and at: ${JSON.stringify(entry)}`,
      );
    else rejectedPairs.add(`${entry.taskKey}|${entry.path}`);
  }

  for (const domain of course.domains)
    for (const group of domain.groups ?? [])
      if (group.foundations !== undefined && !Array.isArray(group.foundations))
        errors.push(`${group.title}: foundations must be a list of picks`);
  for (const { task, pick } of eachPick(course)) {
    const where = `${task.key ?? task.text}: ${pick?.target?.path ?? "?"}`;
    for (const problem of pickProblems(pick, { foundation: task.foundation }))
      errors.push(`${where}: ${problem}`);
    // everything a pick depends on is recorded, so a change to it can be found later
    const module =
      typeof pick?.target?.path === "string" ? moduleOfPick(pick) : null;
    if (module && !snapshotProblem) {
      const official = pick.source === "P1" || pick.source === "P2";
      if (official && !scopeModules.has(module))
        errors.push(
          `${where}: its module ${module} is not in inputs.scope, so it is not part of the exam's official course`,
        );
      if (!official && !scopeModules.has(module) && !pickedModules.has(module))
        errors.push(
          `${where}: its module ${module} is not recorded in inputs.picked, so a change to it could not be found`,
        );
    }
  }
  // a page is shown once in the whole course, and hands-on material is on the lab page instead
  const shownAt = new Map();
  for (const { task, pick } of eachPick(course)) {
    const path = pick?.target?.path;
    if (!path) continue;
    const first = shownAt.get(path);
    if (first === task.key)
      errors.push(`${task.key}: ${path} appears twice under one task`);
    else if (first !== undefined)
      errors.push(
        `${task.key}: ${path} is already shown under ${first}: a page appears once in a course`,
      );
    else shownAt.set(path, task.key);
    if (isClassic({ title: pick.title, path }))
      errors.push(
        `${task.key}: ${path} is classic material; a course leaves it out`,
      );
    const handsOn = handsOnReason({
      kind: pick.target?.kind,
      path,
      title: pick.title,
    });
    if (handsOn)
      errors.push(
        `${task.key}: ${path} is hands-on material (${handsOn}); it belongs on the lab page, not in the course`,
      );
    if (task.key && rejectedPairs.has(`${task.key}|${path}`))
      errors.push(
        `${task.key}: ${path} was rejected by the maintainer and must not come back`,
      );
    if (isCurrent) {
      const verdict = isCurrent(path, pick.target.kind);
      if (verdict && verdict.ok === false)
        errors.push(
          `${task.key}: ${path} is not a current Learn page${verdict.reason ? ` (${verdict.reason})` : ""}`,
        );
    }
    if (titleOf) {
      const official = titleOf(path);
      if (official && squish(official) !== squish(pick.title))
        warnings.push(
          `${task.key}: the title "${pick.title}" is not the catalog title "${official}"`,
        );
    }
  }
  // the audience profile: the guide's own words with the maintainer's picks; a Learn page also picked for a task is only a warning
  const audienceChecked = audienceProblems(course.audience, {
    guideAudience: guide?.audience ?? null,
  });
  errors.push(...audienceChecked.errors);
  warnings.push(...audienceChecked.warnings);
  for (const concept of eachConcept(course.audience))
    for (const pick of concept.picks ?? [])
      if (pick.kind === "learn" && shownAt.has(pick.path))
        warnings.push(
          `${concept.text}: ${pick.path} is also shown under ${shownAt.get(pick.path)}`,
        );
  // a task without a module of its own may point to a module that also covers it and is shown under another task
  for (const domain of course.domains)
    for (const group of domain.groups ?? [])
      for (const task of group.tasks ?? []) {
        if (task.overlaps === undefined) continue;
        if (!Array.isArray(task.overlaps) || task.overlaps.length === 0) {
          errors.push(`${task.key}: overlaps must be a non-empty list`);
          continue;
        }
        if ((task.picks ?? []).some((p) => p?.target?.kind === "module"))
          errors.push(
            `${task.key}: has a module of its own, so it needs no pointer to another task's module`,
          );
        for (const o of task.overlaps) {
          if (
            !present(o?.path) ||
            !present(o?.title) ||
            !present(o?.shownUnder)
          )
            errors.push(
              `${task.key}: an overlap needs path, title and shownUnder: ${JSON.stringify(o)}`,
            );
          else if (shownAt.get(o.path) !== o.shownUnder)
            errors.push(
              `${task.key}: the overlap ${o.path} is shown under ${shownAt.get(o.path) ?? "no task"}, not under ${o.shownUnder}`,
            );
          else if (o.shownUnder === task.key)
            errors.push(`${task.key}: an overlap points to the task itself`);
        }
      }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: courseStats(course),
  };
}
