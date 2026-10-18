/**
 * The rebuild check: is a course still what its inputs say it should be, and if not, how much of it has to be
 * redone? Pure: no I/O, no network. The CLI is scripts/course-status.mjs (docs/courses.md).
 *
 * A course is built from two things and changes only when one of them changes:
 *   - the exam's study guide: its TASKS (domain > skill group > task). The guide's other text, its "as of" date
 *     and its hash can change without touching a task; that is information, never a reason to rebuild;
 *   - what Learn offers for the exam: the modules of the exam's official courses and the documentation links
 *     their last units list (the scope snapshot), plus the modules of other courses that picks rely on.
 *
 * The result is a plan, not a verdict: which tasks are new and need picks, which keep theirs under a new key,
 * which picks are broken (hard) or worth a look (soft), and how many tasks are untouched.
 *
 *   current  nothing a pick relies on changed and the tasks are the same
 *   review   nothing is broken, but Learn's official course changed shape (a module or course added or removed)
 *   stale    a task was added, removed, moved or reordered, or a pick's target is gone or no longer listed
 */

import { eachPick, moduleOfPick } from "./course-format.mjs";
import { overlap, squish } from "./course-guide.mjs";
import { fingerprintOfSnapshot } from "./course-scope.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The tasks of a tree (a parsed guide or a course file) as flat rows, in order. */
export function flattenTasks(tree) {
  return (tree.domains ?? []).flatMap((domain) =>
    (domain.groups ?? []).flatMap((group) =>
      (group.tasks ?? []).map((task) => ({
        key: task.key,
        text: squish(task.text),
        domain: squish(domain.title),
        group: squish(group.title),
      })),
    ),
  );
}

const weightText = (w) =>
  w ? (w.min === w.max ? `${w.min}%` : `${w.min}-${w.max}%`) : null;

/**
 * What the study guide changed for this course. `guide` is the parsed current guide (with `hash`), `course` the
 * course file. Added tasks need picks; removed tasks drop theirs; a moved task (same wording, new place) keeps
 * its picks under the new key; a rename hint pairs a removed and an added task with similar wording (the
 * maintainer decides whether the picks carry over).
 */
export function planGuideChanges(guide, course) {
  const guideTasks = flattenTasks(guide);
  const courseTasks = flattenTasks(course);
  const inGuide = new Set(guideTasks.map((t) => t.key));
  const inCourse = new Set(courseTasks.map((t) => t.key));
  const added = guideTasks.filter((t) => !inCourse.has(t.key));
  const removed = courseTasks.filter((t) => !inGuide.has(t.key));

  const moved = [];
  for (const task of [...removed]) {
    const at = added.findIndex((a) => a.text === task.text);
    if (at < 0) continue;
    moved.push({ from: task, to: added[at] });
    added.splice(at, 1);
    removed.splice(removed.indexOf(task), 1);
  }
  const renameHints = [];
  const taken = new Set();
  for (const task of removed) {
    let best = null;
    for (const candidate of added) {
      if (taken.has(candidate)) continue;
      const similarity = overlap(task.text, candidate.text);
      if (similarity >= 0.6 && (!best || similarity > best.similarity))
        best = { candidate, similarity };
    }
    if (best) {
      taken.add(best.candidate);
      renameHints.push({
        from: task,
        to: best.candidate,
        similarity: Math.round(best.similarity * 100) / 100,
      });
    }
  }

  const weights = new Map(
    (course.domains ?? []).map((d) => [squish(d.title), d.weight]),
  );
  const weightChanges = [];
  const guideDomains = new Set();
  for (const d of guide.domains ?? []) {
    guideDomains.add(squish(d.title));
    if (
      weights.has(squish(d.title)) &&
      weightText(weights.get(squish(d.title))) !== weightText(d.weight)
    ) {
      weightChanges.push({
        domain: squish(d.title),
        from: weightText(weights.get(squish(d.title))),
        to: weightText(d.weight),
      });
    }
  }
  const sameKeys =
    added.length === 0 && removed.length === 0 && moved.length === 0;
  const reordered =
    sameKeys && guideTasks.some((t, i) => t.key !== courseTasks[i]?.key);
  const asOfFrom = course.inputs?.guideAsOf ?? null;
  const asOfTo = guide.asOf?.text ?? null;
  return {
    treeChanged: !sameKeys || reordered,
    hashChanged: Boolean(
      course.inputs?.guideHash &&
      guide.hash &&
      course.inputs.guideHash !== guide.hash,
    ),
    asOf: asOfFrom !== asOfTo ? { from: asOfFrom, to: asOfTo } : null,
    added,
    removed,
    moved,
    renameHints,
    weightChanges,
    reordered,
  };
}

/** Compare two scope snapshots (course.inputs.scope against the current one): which courses and modules changed. */
export function diffSnapshots(before, after) {
  const index = (list) => new Map(list.map((entry) => [entry[0], entry]));
  const courses = {
    before: index(before.courses),
    after: index(after.courses),
  };
  const modules = {
    before: index(before.modules),
    after: index(after.modules),
  };
  const only = (a, b) => [...a.keys()].filter((k) => !b.has(k)).sort(byText);
  const both = (a, b) => [...a.keys()].filter((k) => b.has(k));
  return {
    courses: {
      added: only(courses.after, courses.before),
      removed: only(courses.before, courses.after),
      changed: both(courses.after, courses.before)
        .filter((k) => courses.before.get(k)[1] !== courses.after.get(k)[1])
        .sort(byText),
    },
    modules: {
      added: only(modules.after, modules.before),
      removed: only(modules.before, modules.after),
      contentChanged: both(modules.after, modules.before)
        .filter((k) => modules.before.get(k)[1] !== modules.after.get(k)[1])
        .sort(byText),
      resourcesChanged: both(modules.after, modules.before)
        .filter((k) => modules.before.get(k)[2] !== modules.after.get(k)[2])
        .sort(byText),
    },
  };
}

/** The recorded modules outside the official course (inputs.picked) against the catalog: which left, which changed. */
export function diffPicked(picked, catalog) {
  const missing = [];
  const changed = [];
  for (const [path, sig] of picked ?? []) {
    const record = catalog.get(path);
    if (!record) missing.push(path);
    else if ((record.unitSig ?? "") !== sig) changed.push(path);
  }
  return { missing: missing.sort(byText), changed: changed.sort(byText) };
}

const listedUnder = (links, path) =>
  links.some((l) => (l.path ?? l.url) === path);

/**
 * The picks the changes hurt. Returns [{ taskKey, path, source, level: "hard" | "soft", reason }].
 *   hard  the pick's target is gone, or the module no longer lists it: it has to be replaced
 *   soft  something the pick relies on changed (a module's content, a page listed under a new path): look at it
 * `current` = { scope: Map(path -> scope map module), catalog: Map(path -> catalog module) }; `isCurrent`
 * (optional) = (path, kind) => { ok, reason }, learnsync's verdict on the target itself.
 */
export function affectedPicks({
  course,
  scopeDiff,
  pickedDiff,
  current,
  isCurrent,
}) {
  const out = [];
  const removedScope = new Set(scopeDiff.modules.removed);
  const contentChanged = new Set(scopeDiff.modules.contentChanged);
  const resourcesChanged = new Set(scopeDiff.modules.resourcesChanged);
  const pickedMissing = new Set(pickedDiff.missing);
  const pickedChanged = new Set(pickedDiff.changed);
  for (const { task, pick } of eachPick(course)) {
    const module = moduleOfPick(pick);
    const found = [];
    const add = (level, reason) =>
      found.push({
        taskKey: task.key,
        path: pick.target.path,
        source: pick.source,
        level,
        reason,
      });
    const official = pick.source === "P1" || pick.source === "P2";
    if (module) {
      if (official && removedScope.has(module)) {
        add(
          "hard",
          pick.source === "P2"
            ? "the module that lists it left the exam's official course"
            : "its module left the exam's official course",
        );
      } else if (!official && pickedMissing.has(module)) {
        add("hard", "its module left the catalog");
      } else {
        if (pick.target.kind === "unit") {
          const record = current.catalog.get(module);
          if (
            record &&
            Array.isArray(record.unitUrls) &&
            !record.unitUrls.includes(pick.target.path)
          )
            add("hard", "the unit no longer exists in its module");
        }
        if (pick.source === "P2" && resourcesChanged.has(module)) {
          const links = current.scope.get(module)?.resources?.links ?? [];
          if (listedUnder(links, pick.target.path)) {
            // still listed
          } else if (links.some((l) => l.was === pick.target.path))
            add("soft", "the module lists this page under a new path now");
          else add("hard", "the module no longer lists it");
        } else if (
          official &&
          pick.source === "P1" &&
          contentChanged.has(module) &&
          found.length === 0
        ) {
          add("soft", "the module's content changed");
        } else if (
          !official &&
          pickedChanged.has(module) &&
          found.length === 0
        ) {
          add("soft", "its module's content changed");
        }
      }
    }
    if (isCurrent && !found.some((f) => f.level === "hard")) {
      const verdict = isCurrent(pick.target.path, pick.target.kind);
      if (verdict && verdict.ok === false)
        add(
          "hard",
          `not a current Learn page${verdict.reason ? ` (${verdict.reason})` : ""}`,
        );
    }
    out.push(...found);
  }
  return out;
}

/**
 * The rebuild plan of one course.
 *   course      the course file
 *   guide       the parsed current study guide, with `hash`
 *   scopeMap    the current exam scope map (course-scope.mjs buildScopeMap)
 *   catalog     the catalog's modules (learn-catalog.json `modules`)
 *   isCurrent   optional URL check, see affectedPicks
 */
export function rebuildPlan({ course, guide, scopeMap, catalog, isCurrent }) {
  const guidePlan = planGuideChanges(guide, course);
  const before = course.inputs?.scope ?? { courses: [], modules: [] };
  const after = scopeMap.inputs.snapshot;
  const scopeDiff = diffSnapshots(before, after);
  const catalogByPath = new Map(catalog.map((m) => [m.path, m]));
  const pickedDiff = diffPicked(course.inputs?.picked, catalogByPath);
  const picks = affectedPicks({
    course,
    scopeDiff,
    pickedDiff,
    current: {
      scope: new Map(scopeMap.modules.map((m) => [m.path, m])),
      catalog: catalogByPath,
    },
    isCurrent,
  });
  const hard = picks.filter((p) => p.level === "hard");
  const soft = picks.filter((p) => p.level === "soft");

  const reasons = [];
  if (guidePlan.added.length)
    reasons.push(`${guidePlan.added.length} task(s) added to the study guide`);
  if (guidePlan.removed.length)
    reasons.push(
      `${guidePlan.removed.length} task(s) removed from the study guide`,
    );
  if (guidePlan.moved.length)
    reasons.push(
      `${guidePlan.moved.length} task(s) moved within the study guide`,
    );
  if (guidePlan.reordered)
    reasons.push("the study guide's tasks are in a different order");
  if (hard.length) reasons.push(`${hard.length} pick(s) have to be replaced`);
  const stale = reasons.length > 0;
  const reviewReasons = [];
  if (scopeDiff.modules.added.length)
    reviewReasons.push(
      `${scopeDiff.modules.added.length} module(s) added to the exam's official course`,
    );
  if (scopeDiff.modules.removed.length)
    reviewReasons.push(
      `${scopeDiff.modules.removed.length} module(s) left the exam's official course`,
    );
  if (
    scopeDiff.courses.added.length ||
    scopeDiff.courses.removed.length ||
    scopeDiff.courses.changed.length
  )
    reviewReasons.push("the exam's official course list changed");
  if (soft.length)
    reviewReasons.push(`${soft.length} pick(s) rely on something that changed`);

  const buildKeys = new Set([
    ...guidePlan.added.map((t) => t.key),
    ...hard.map((p) => p.taskKey),
  ]);
  const checkKeys = new Set(
    soft.map((p) => p.taskKey).filter((k) => !buildKeys.has(k)),
  );
  const total = flattenTasks(guide).length;
  return {
    code: course.code,
    status: stale ? "stale" : reviewReasons.length ? "review" : "current",
    reasons: [...reasons, ...(stale ? reviewReasons : [])],
    reviewReasons: stale ? [] : reviewReasons,
    guide: guidePlan,
    scope: {
      fingerprintChanged:
        fingerprintOfSnapshot(before) !== scopeMap.inputs.fingerprint,
      diff: scopeDiff,
      picked: pickedDiff,
    },
    picks: { hard, soft },
    work: {
      tasksToBuild: [...buildKeys].sort(byText),
      tasksToCheck: [...checkKeys].sort(byText),
      carriedOver: guidePlan.moved.map((m) => ({
        from: m.from.key,
        to: m.to.key,
      })),
      unchanged: Math.max(
        0,
        total -
          new Set([
            ...buildKeys,
            ...checkKeys,
            ...guidePlan.moved.map((m) => m.to.key),
          ]).size,
      ),
    },
  };
}
