/**
 * The course builder (docs/course-build.md): assemble a course file (docs/courses.md) from what the earlier steps
 * decided. Pure: no I/O, no network. The command line is scripts/course-build.mjs.
 *
 *   the study guide    the tree: domains, skill groups, tasks, in the guide's order
 *   the exam scope map what Learn offered when the candidates were made (the snapshot a rebuild check compares)
 *   the gated file     every candidate with its decision (course-gates.mjs): the accepted ones become picks
 *
 * Nothing is decided here about relevance. A pick keeps the class, the relation and the decider the gates (or the
 * maintainer's remembered decision) gave it, its reason and its evidence are the judge's, and a rejection worth
 * remembering goes into the file's `rejected` list so that it cannot come back.
 *
 * What the maintainer still has to look at is listed in `review`, not decided: a pick the judge was not sure of or
 * flagged as out of scope is in the course, and the review copy of the course page (course-render.mjs) marks it with
 * the judge's reason.
 *
 * Three rules of the page are applied here (maintainer, 2026-10-20), and what they take out is reported in
 * `routing`, not lost:
 *   - Classic material (course-classic.mjs) is not learned: an accepted classic page is left out and listed in
 *     `routing.classic`. The generator filters classic pages before they are judged, so this catches only what
 *     was judged before the rule or accepted by hand.
 *   - Hands-on material (an exercise, a simulation, a guided project, a tutorial, a quickstart) is not in the
 *     course: the lab page collects it (course-handson.mjs). `routing.handsOn` lists every such page that was
 *     accepted, with the tasks it was accepted for, so that scripts/course-labs.mjs can add what the lab page lacks.
 *   - A page is shown once in the whole course. A page accepted for several tasks stays under the task where it
 *     fits best (core before supporting, a sure judgement before an unsure one, the exam's own course before
 *     other sources, then the task with the fewest picks so far) and `routing.repeats` lists where else it fit.
 */

import {
  COURSE_SCHEMA_VERSION,
  courseStats,
  moduleOfPick,
  validateCourse,
} from "./course-format.mjs";
import { isClassic } from "./course-classic.mjs";
import { ACCEPTED_BY_MAINTAINER } from "./course-gates.mjs";
import { handsOnReason } from "./course-handson.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SOURCE_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3, P5: 4 };
const KIND_ORDER = { module: 0, unit: 1, docs: 2 };
const CLASS_ORDER = { core: 0, supporting: 1 };

/**
 * One accepted gated item as a pick, or a problem text. `day` is the day the gates decided (for a decision the
 * gates took themselves).
 */
function pickOf(item, day) {
  const g = item.gate;
  const target = item.target;
  const pick = {
    target: { kind: target.kind, path: target.path },
    title: item.title,
    class: g.class,
    ...(g.class === "supporting" ? { relation: g.relation } : {}),
    source: item.source,
    ...(item.source === "P2" && item.via
      ? { via: item.via.path ?? item.via }
      : {}),
  };
  const needsEvidence =
    g.class === "supporting" ||
    item.source === "P3" ||
    item.source === "P4" ||
    item.source === "P5";
  // The judge's words describe the page as the judge saw it. When the judge rejected the page and the maintainer
  // accepted it, they argue against the pick: the maintainer's note is its reason and its evidence. A note the
  // maintainer wrote also replaces the judge's reason when the judge picked the page too.
  const judgePicked = item.judge.verdict !== "reject";
  const note =
    g.by === "maintainer" &&
    typeof g.reason === "string" &&
    g.reason.trim() !== "" &&
    g.reason !== ACCEPTED_BY_MAINTAINER
      ? g.reason.trim()
      : null;
  if (g.class === "supporting") {
    pick.why = note ?? (judgePicked ? item.judge.why : null);
    if (!pick.why)
      return {
        problem: `${item.task.key}: ${target.path} is accepted as supporting over the judge's reject without a note, so it has no reason (answer it again with a note)`,
      };
  }
  if (needsEvidence) {
    const evidence = judgePicked ? item.judge.quote : note;
    if (!evidence)
      return {
        problem: judgePicked
          ? `${item.task.key}: ${target.path} (${item.source}) needs an evidence quote and the judge gave none`
          : `${item.task.key}: ${target.path} (${item.source}) was rejected by the judge and accepted without a note, so it has no evidence (answer it again with a note)`,
      };
    pick.evidence = evidence;
  }
  pick.decision = {
    by: g.by === "maintainer" ? "maintainer" : "auto",
    at: g.at ?? day,
  };
  return { pick };
}

const pickOrder = (a, b) =>
  CLASS_ORDER[a.pick.class] - CLASS_ORDER[b.pick.class] ||
  SOURCE_ORDER[a.pick.source] - SOURCE_ORDER[b.pick.source] ||
  KIND_ORDER[a.pick.target.kind] - KIND_ORDER[b.pick.target.kind] ||
  (b.item.coverage ?? 0) - (a.item.coverage ?? 0) ||
  byText(a.pick.target.path, b.pick.target.path);

/** 1 when the judge was unsure of the pick, else 0. */
const doubt = (item) => (item.judge?.confidence === "low" ? 1 : 0);

/** Which of two accepted rows for the same page fits its task better: negative when a does. */
const fitOrder = (a, b) =>
  CLASS_ORDER[a.pick.class] - CLASS_ORDER[b.pick.class] ||
  doubt(a.item) - doubt(b.item) ||
  SOURCE_ORDER[a.pick.source] - SOURCE_ORDER[b.pick.source];

/**
 * Apply the two rules of the page to the accepted rows (see the top of this file).
 *   accepted  Map: task key -> [{ pick, item }]
 *   taskKeys  the task keys in the guide's order
 * Returns { accepted, handsOn, classic, repeats }: `accepted` the same shape without the classic and hands-on
 * pages and with every page under one task only; `classic` [{ path, title, tasks }] sorted by path; `handsOn` [{ path, kind, title, reason, module?, moduleTitle?, tasks }] sorted by path;
 * `repeats` [{ path, title, shownUnder, alsoFits }] for every page that fitted several tasks.
 */
export function routePicks({ accepted, taskKeys }) {
  const order = new Map(taskKeys.map((key, i) => [key, i]));
  const handsOn = new Map();
  const classic = new Map();
  const byPath = new Map();
  for (const key of taskKeys) {
    for (const row of accepted.get(key) ?? []) {
      const { pick, item } = row;
      if (isClassic({ title: pick.title, path: pick.target.path })) {
        const entry = classic.get(pick.target.path) ?? {
          path: pick.target.path,
          title: pick.title,
          tasks: [],
        };
        if (!entry.tasks.includes(key)) entry.tasks.push(key);
        classic.set(pick.target.path, entry);
        continue;
      }
      const reason = handsOnReason({
        kind: pick.target.kind,
        path: pick.target.path,
        title: pick.title,
        moduleTitle: item.module?.title,
      });
      if (reason) {
        const entry = handsOn.get(pick.target.path) ?? {
          path: pick.target.path,
          kind: pick.target.kind,
          title: pick.title,
          reason,
          ...(item.module?.path
            ? { module: item.module.path, moduleTitle: item.module.title }
            : {}),
          tasks: [],
        };
        if (!entry.tasks.includes(key)) entry.tasks.push(key);
        handsOn.set(pick.target.path, entry);
        continue;
      }
      const list = byPath.get(pick.target.path) ?? [];
      list.push({ ...row, taskKey: key });
      byPath.set(pick.target.path, list);
    }
  }
  // a page that fits one task fixes that task's load first; then the pages that fit the fewest tasks choose
  const load = new Map();
  const bump = (key) => load.set(key, (load.get(key) ?? 0) + 1);
  const kept = new Map();
  const repeats = [];
  const paths = [...byPath].sort(
    (a, b) => a[1].length - b[1].length || byText(a[0], b[0]),
  );
  for (const [path, rows] of paths) {
    let winner = rows[0];
    if (rows.length > 1) {
      const top = rows.reduce((m, r) => (fitOrder(r, m) < 0 ? r : m), rows[0]);
      winner = rows
        .filter((r) => fitOrder(r, top) === 0)
        .sort(
          (a, b) =>
            (load.get(a.taskKey) ?? 0) - (load.get(b.taskKey) ?? 0) ||
            (b.item.judge?.quoteTermCoverage ?? 0) -
              (a.item.judge?.quoteTermCoverage ?? 0) ||
            (b.item.coverage ?? 0) - (a.item.coverage ?? 0) ||
            order.get(a.taskKey) - order.get(b.taskKey),
        )[0];
      repeats.push({
        path,
        title: winner.pick.title,
        shownUnder: winner.taskKey,
        alsoFits: rows
          .filter((r) => r !== winner)
          .map((r) => r.taskKey)
          .sort((a, b) => order.get(a) - order.get(b)),
      });
    }
    bump(winner.taskKey);
    const list = kept.get(winner.taskKey) ?? [];
    list.push({ pick: winner.pick, item: winner.item });
    kept.set(winner.taskKey, list);
  }
  const inGuideOrder = (e) => ({
    ...e,
    tasks: e.tasks.sort((a, b) => order.get(a) - order.get(b)),
  });
  return {
    accepted: kept,
    classic: [...classic.values()]
      .map(inGuideOrder)
      .sort((a, b) => byText(a.path, b.path)),
    handsOn: [...handsOn.values()]
      .map(inGuideOrder)
      .sort((a, b) => byText(a.path, b.path)),
    repeats,
  };
}

/**
 * Build the course file of an exam.
 *   code, name   the exam
 *   guide        the parsed study guide (parseGuide, with `hash`)
 *   scope        the exam scope map (buildScopeMap)
 *   gated        the gated file ({ code, builtAt, inputs, items })
 *   today        YYYY-MM-DD, the day the course is built
 *   allowStale   build even when the guide or Learn changed since the candidates were made
 * Returns { ok, course, problems, warnings, stats }; a course with problems is not returned.
 */
export function buildCourse({
  code,
  name,
  guide,
  scope,
  gated,
  today,
  allowStale = false,
}) {
  const problems = [];
  const warnings = [];
  if (!guide?.ok) problems.push("the study guide does not parse completely");
  if (!scope?.ok)
    problems.push(
      `${code} has no official course in Learn's catalog: there is no scope to build on`,
    );
  if (gated.code !== code)
    problems.push(`the gated file is for ${gated.code}, not ${code}`);
  if (problems.length)
    return { ok: false, course: null, problems, warnings, stats: null };

  // the candidates were judged against a guide text and a state of Learn; a course built on newer ones would
  // record a snapshot that its picks were never judged against
  const stale = [];
  if (gated.inputs?.guideHash !== guide.hash)
    stale.push(
      "the study guide changed since the candidates were made (its text hash is different)",
    );
  if (gated.inputs?.scopeFingerprint !== scope.inputs.fingerprint)
    stale.push(
      "Learn's modules for the exam changed since the candidates were made (the scope fingerprint is different)",
    );
  for (const s of stale)
    (allowStale ? warnings : problems).push(
      allowStale
        ? `${s}; built anyway`
        : `${s}: run the candidates, judging and gates again, or build with --allow-stale`,
    );

  const taskKeys = new Set(
    guide.domains.flatMap((d) =>
      d.groups.flatMap((g) => g.tasks.map((t) => t.key)),
    ),
  );
  const decided = new Map();
  const rejected = new Map();
  for (const item of gated.items) {
    if (!taskKeys.has(item.task.key)) {
      problems.push(
        `${item.task.key} is not a task of the study guide (the candidates are for another version of it)`,
      );
      continue;
    }
    const g = item.gate;
    if (g.decision === "accept") {
      const built = pickOf(item, gated.builtAt ?? today);
      if (built.problem) problems.push(built.problem);
      else {
        const list = decided.get(item.task.key) ?? [];
        list.push({ pick: built.pick, item });
        decided.set(item.task.key, list);
      }
    } else if (
      g.decision === "reject" &&
      (g.via === "remembered" || g.remember === true)
    ) {
      rejected.set(`${item.task.key}|${item.target.path}`, {
        taskKey: item.task.key,
        path: item.target.path,
        reason: g.reason ?? g.reasons[0],
        at: g.at ?? gated.builtAt ?? today,
      });
    } else if (g.decision === "queue")
      warnings.push(
        `${item.task.key}: ${item.target.path} is still in the queue: it is not in the course`,
      );
  }

  // hands-on material goes to the lab page and a page is shown once (the top of this file)
  const routed = routePicks({ accepted: decided, taskKeys: [...taskKeys] });
  const accepted = routed.accepted;
  // the picks that stay in the course but are marked for the maintainer, in the guide's order
  const review = [];
  for (const key of taskKeys) {
    for (const { pick, item } of accepted.get(key) ?? []) {
      const marks = item.gate.review;
      if (!marks?.length) continue;
      review.push({
        task: key,
        path: pick.target.path,
        title: pick.title,
        kind: pick.target.kind,
        source: pick.source,
        class: pick.class,
        ...(pick.relation ? { relation: pick.relation } : {}),
        reasons: marks,
        why: item.judge.why,
        confidence: item.judge.confidence,
        flags: item.judge.flags ?? [],
      });
    }
  }
  const routing = {
    classic: routed.classic,
    handsOn: routed.handsOn,
    repeats: routed.repeats,
  };

  // everything a pick of another exam's course (or found by search) depends on is recorded with its signature
  const picked = new Map();
  const domains = guide.domains.map((d) => ({
    title: d.title,
    ...(d.weight ? { weight: d.weight } : {}),
    groups: d.groups.map((g) => ({
      title: g.title,
      tasks: g.tasks.map((t) => {
        const rows = (accepted.get(t.key) ?? []).sort(pickOrder);
        for (const { pick, item } of rows) {
          if (
            pick.source === "P3" ||
            pick.source === "P4" ||
            pick.source === "P5"
          ) {
            const module = moduleOfPick(pick);
            if (module && !picked.has(module)) {
              if (!item.unitSig)
                problems.push(
                  `${t.key}: ${pick.target.path} depends on ${module} but its signature is not in the gated file`,
                );
              else picked.set(module, item.unitSig);
            }
          }
        }
        return { key: t.key, text: t.text, picks: rows.map((r) => r.pick) };
      }),
    })),
  }));

  const course = {
    schemaVersion: COURSE_SCHEMA_VERSION,
    code,
    name,
    inputs: {
      guideHash: guide.hash,
      ...(guide.asOf?.text ? { guideAsOf: guide.asOf.text } : {}),
      scopeFingerprint: scope.inputs.fingerprint,
      scope: structuredClone(scope.inputs.snapshot),
      picked: [...picked].sort((a, b) => byText(a[0], b[0])),
      builtAt: today,
    },
    domains,
    rejected: [...rejected.values()].sort(
      (a, b) => byText(a.taskKey, b.taskKey) || byText(a.path, b.path),
    ),
  };
  // the checks of the format, offline: a course the builder returns is one the validator accepts
  const checked = validateCourse(course, { guide });
  for (const e of checked.errors)
    problems.push(`the built course is not valid: ${e}`);
  warnings.push(...checked.warnings);
  if (problems.length)
    return { ok: false, course: null, problems, warnings, stats: null };
  return {
    ok: true,
    course,
    problems,
    warnings,
    stats: courseStats(course),
    routing,
    review,
  };
}
