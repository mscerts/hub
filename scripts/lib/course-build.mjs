/**
 * The course builder (docs/course-build.md): assemble a course file (docs/courses.md) from what the earlier steps
 * decided. Pure: no I/O, no network. The command line is scripts/course-build.mjs.
 *
 *   the study guide    the tree: domains, skill groups, tasks, in the guide's order
 *   the exam scope map what Learn offered when the candidates were made (the snapshot a rebuild check compares)
 *   the gated file     every candidate with its decision (course-gates.mjs): the accepted ones become picks
 *
 * Nothing is decided here. A pick keeps the class, the relation and the decider the gates (or the maintainer's
 * remembered decision) gave it, its reason and its evidence are the judge's, and a rejection worth remembering goes
 * into the file's `rejected` list so that it cannot come back.
 */

import {
  COURSE_SCHEMA_VERSION,
  courseStats,
  moduleOfPick,
  validateCourse,
} from "./course-format.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SOURCE_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 };
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
    g.class === "supporting" || item.source === "P3" || item.source === "P4";
  if (g.class === "supporting") {
    pick.why = item.judge.why;
    if (!item.judge.quote)
      return {
        problem: `${item.task.key}: ${target.path} is accepted as supporting but the judge gave no quote, so it has no evidence`,
      };
  }
  if (needsEvidence) {
    if (!item.judge.quote)
      return {
        problem: `${item.task.key}: ${target.path} (${item.source}) needs an evidence quote and the judge gave none`,
      };
    pick.evidence = item.judge.quote;
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
  const accepted = new Map();
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
        const list = accepted.get(item.task.key) ?? [];
        list.push({ pick: built.pick, item });
        accepted.set(item.task.key, list);
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
          if (pick.source === "P3" || pick.source === "P4") {
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
  return { ok: true, course, problems, warnings, stats: courseStats(course) };
}
