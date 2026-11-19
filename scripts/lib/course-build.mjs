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
 *     other sources, then the task with the fewest picks so far; a module takes the earliest task of the guide that
 *     it fits instead of the thinnest one) and `routing.repeats` lists where else it fit.
 *   - A module is placed as a module, once, in the FIRST skill group (in the guide's order) where it was accepted
 *     (maintainer, 2026-10-21): it is not split into units across the page. A unit that was accepted, which the
 *     generator no longer offers but an older gated file still holds, is collapsed into its module (listed in
 *     `routing.collapsed`), and a module accepted in several groups stays in the earliest one (the choice among
 *     the tasks of that group is the rule above; `routing.repeats` lists the groups it left). A unit whose module
 *     the maintainer rejected for that task is not collapsed (the module must not come back): it is dropped and listed
 *     in `routing.blocked`.
 *
 * The maintainer's accepts that no candidate answers (the gated file's `manual` list: a page added by hand, or one
 * the generator stopped proposing) become picks too, with the maintainer's reason as their reason and evidence; and
 * an accept the maintainer pinned (`pinned: true` in the decisions file) is where its page is shown, before the
 * page rules above choose. So a course edited by hand comes out of a rebuild as it went in.
 */

import {
  COURSE_SCHEMA_VERSION,
  courseStats,
  moduleOfPick,
  validateCourse,
} from "./course-format.mjs";
import { isClassic } from "./course-classic.mjs";
import { CONCEPT_TITLE } from "./course-candidates.mjs";
import { isConceptPath } from "./course-toc.mjs";
import { ACCEPTED_BY_MAINTAINER, kindOfPath } from "./course-gates.mjs";
import { buildAudience } from "./course-audience.mjs";
import { handsOnReason } from "./course-handson.mjs";
import {
  FOUNDATION_CLASS,
  foundationKey,
  groupKeyOf,
  isFoundationKey,
  orderFoundations,
} from "./course-foundations.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SOURCE_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3, P5: 4, P6: 5 };
const KIND_ORDER = { module: 0, unit: 1, docs: 2, github: 3 };
// a page that fits a task as core stays there; a page of the fundamentals comes before one that only supports a task
const CLASS_ORDER = { core: 0, [FOUNDATION_CLASS]: 1, supporting: 2 };

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
    g.class === FOUNDATION_CLASS ||
    item.source === "P3" ||
    item.source === "P4" ||
    item.source === "P5" ||
    item.source === "P6";
  // The judge's words describe the page as the judge saw it. When the judge rejected the page and the maintainer
  // accepted it, they argue against the pick: the maintainer's note is its reason and its evidence. A note the
  // maintainer wrote also replaces the judge's reason when the judge picked the page too.
  // (an accept without a candidate has no judge at all: the maintainer's note is everything it has)
  const judgePicked = Boolean(item.judge) && item.judge.verdict !== "reject";
  const note =
    g.by === "maintainer" &&
    typeof g.reason === "string" &&
    g.reason.trim() !== "" &&
    g.reason !== ACCEPTED_BY_MAINTAINER
      ? g.reason.trim()
      : null;
  if (g.class === "supporting" || g.class === FOUNDATION_CLASS) {
    pick.why = note ?? (judgePicked ? item.judge.why : null);
    if (!pick.why)
      return {
        problem: item.judge
          ? `${item.task.key}: ${target.path} is accepted as supporting over the judge's reject without a note, so it has no reason (answer it again with a note)`
          : `${item.task.key}: ${target.path} was accepted by the maintainer without being a candidate and without a note, so it has no reason (give the decision a reason)`,
      };
  }
  if (needsEvidence) {
    const evidence = judgePicked ? item.judge.quote : note;
    if (!evidence)
      return {
        problem: judgePicked
          ? `${item.task.key}: ${target.path} (${item.source}) needs an evidence quote and the judge gave none`
          : item.judge
            ? `${item.task.key}: ${target.path} (${item.source}) was rejected by the judge and accepted without a note, so it has no evidence (answer it again with a note)`
            : `${item.task.key}: ${target.path} (${item.source}) was accepted by the maintainer without being a candidate and without a note, so it has no evidence (give the decision a reason)`,
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
 * Returns { accepted, handsOn, classic, collapsed, repeats }: `accepted` the same shape without the classic and
 * hands-on pages and with every page under one task only; `classic` [{ path, title, tasks }] sorted by path;
 * `handsOn` [{ path, kind, title, reason, module?, moduleTitle?, tasks }] sorted by path; `collapsed`
 * [{ path, module, title, moduleTitle, tasks }] for every accepted unit that became its module, sorted by path;
 * `blocked` [{ path, module, title, tasks }] for every accepted unit whose module the maintainer rejected for that
 * task (`rejected`: the Set or Map of "<task key>|<path>" the builder remembers); `repeats` [{ path, title,
 * shownUnder, alsoFits }] for every page that fitted several tasks.
 */
export function routePicks({ accepted, taskKeys, rejected = new Map() }) {
  const order = new Map(taskKeys.map((key, i) => [key, i]));
  // the skill groups in the guide's order (a group's fundamentals key and its tasks share the group key)
  const groupOrder = new Map();
  for (const key of taskKeys) {
    const group = groupKeyOf(key);
    if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size);
  }
  const handsOn = new Map();
  const classic = new Map();
  const collapsed = new Map();
  const blocked = new Map();
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
      // a module is placed as a module: an accepted unit that is not hands-on is its module
      let entry = { ...row, taskKey: key };
      if (pick.target.kind === "unit") {
        const module = moduleOfPick(pick);
        if (rejected.has(`${key}|${module}`)) {
          const known = blocked.get(pick.target.path) ?? {
            path: pick.target.path,
            module,
            title: pick.title,
            tasks: [],
          };
          if (!known.tasks.includes(key)) known.tasks.push(key);
          blocked.set(pick.target.path, known);
          continue;
        }
        const moduleTitle = item.module?.title ?? null;
        const known = collapsed.get(pick.target.path) ?? {
          path: pick.target.path,
          module,
          title: pick.title,
          moduleTitle,
          tasks: [],
        };
        if (!known.tasks.includes(key)) known.tasks.push(key);
        collapsed.set(pick.target.path, known);
        entry = {
          pick: {
            ...pick,
            target: { kind: "module", path: module },
            title: moduleTitle ?? pick.title,
          },
          item,
          taskKey: key,
          fromUnit: true,
        };
      }
      const path = entry.pick.target.path;
      const list = byPath.get(path) ?? [];
      // several units of one module accepted for the same task are one pick of the module
      const same = list.findIndex((r) => r.taskKey === key);
      if (same < 0) list.push(entry);
      else if (
        (list[same].fromUnit && !entry.fromUnit) ||
        (list[same].fromUnit === entry.fromUnit &&
          fitOrder(entry, list[same]) < 0)
      )
        list[same] = entry;
      byPath.set(path, list);
    }
  }
  // Count distinct core candidates per task so a conceptual overview (`concept` / `What is ...`) accepted for
  // `<group>/@foundations` stays in Fundamentals whenever every competing `core` task in that group already has
  // another `core` resource of its own.
  const corePathsByTask = new Map();
  for (const [, list] of byPath) {
    for (const r of list) {
      if (r.pick.class === "core") {
        let s = corePathsByTask.get(r.taskKey);
        if (!s) {
          s = new Set();
          corePathsByTask.set(r.taskKey, s);
        }
        s.add(r.pick.target.path);
      }
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
  for (const [path, allRows] of paths) {
    // the maintainer pinned the page under one task: it is shown there, and the rules below are not asked
    const pinned = allRows
      .filter((r) => r.item.gate?.pinned)
      .sort((a, b) => order.get(a.taskKey) - order.get(b.taskKey))[0];
    // a module stays in the first skill group where it was accepted; the rest of the rule is within that group
    let rows = allRows;
    if (pinned) rows = [pinned];
    else if (allRows[0].pick.target.kind === "module" && allRows.length > 1) {
      const first = Math.min(
        ...allRows.map((r) => groupOrder.get(groupKeyOf(r.taskKey))),
      );
      rows = allRows.filter(
        (r) => groupOrder.get(groupKeyOf(r.taskKey)) === first,
      );
    }
    let winner = rows[0];
    if (rows.length > 1) {
      const fRow = rows.find(
        (r) =>
          isFoundationKey(r.taskKey) &&
          (r.item?.signals?.concept === true ||
            isConceptPath(path) ||
            CONCEPT_TITLE.test(r.pick.title)),
      );
      const coreCompetitors = rows.filter((r) => r.pick.class === "core");
      const canPreserveInFoundations =
        Boolean(fRow) &&
        coreCompetitors.length > 0 &&
        coreCompetitors.every(
          (c) => (corePathsByTask.get(c.taskKey)?.size ?? 0) >= 2,
        );
      if (canPreserveInFoundations) {
        winner = fRow;
        for (const c of coreCompetitors) {
          corePathsByTask.get(c.taskKey)?.delete(path);
        }
      } else {
        const top = rows.reduce(
          (m, r) => (fitOrder(r, m) < 0 ? r : m),
          rows[0],
        );
        // a module introduces the skill group's first task it fits, whatever the load; a docs page goes to the thinnest task
        const byGuide = rows[0].pick.target.kind === "module";
        winner = rows
          .filter((r) => fitOrder(r, top) === 0)
          .sort(
            (a, b) =>
              (byGuide ? order.get(a.taskKey) - order.get(b.taskKey) : 0) ||
              (load.get(a.taskKey) ?? 0) - (load.get(b.taskKey) ?? 0) ||
              (b.item.judge?.quoteTermCoverage ?? 0) -
                (a.item.judge?.quoteTermCoverage ?? 0) ||
              (b.item.coverage ?? 0) - (a.item.coverage ?? 0) ||
              order.get(a.taskKey) - order.get(b.taskKey),
          )[0];
      }
    }
    if (allRows.length > 1)
      repeats.push({
        path,
        title: winner.pick.title,
        kind: winner.pick.target.kind,
        shownUnder: winner.taskKey,
        alsoFits: allRows
          .filter((r) => r !== winner)
          .map((r) => r.taskKey)
          .sort((a, b) => order.get(a) - order.get(b)),
      });
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
    collapsed: [...collapsed.values()]
      .map(inGuideOrder)
      .sort((a, b) => byText(a.path, b.path)),
    blocked: [...blocked.values()]
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
 *   allowNoScope build an exam that has no official course on Learn: the scope is empty, every pick comes from search
 *   audienceDecisions   the maintainer's picks for the guide's audience profile (course-audience.mjs), or null
 *   describe     (path) => { title, unitSig } | null: what learnsync's module catalog says about a module, for the
 *                maintainer's accepts that are not candidates (`gated.manual`); without it only such an accept of
 *                a documentation page, or of a module of the exam's own course, that carries its own title is added
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
  allowNoScope = false,
  audienceDecisions = null,
  describe = null,
}) {
  const problems = [];
  const warnings = [];
  if (!guide?.ok) problems.push("the study guide does not parse completely");
  if (!scope?.ok) {
    const noCourse = `${code} has no official course in Learn's catalog: there is no scope to build on`;
    if (allowNoScope && scope?.inputs?.fingerprint)
      warnings.push(
        `${noCourse}; built anyway (--no-official-course), so every pick comes from search and the rebuild check will ask for a review once an official course exists`,
      );
    else problems.push(noCourse);
  }
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

  // the keys of the page's order: the fundamentals of a skill group (its pseudo-task), then the group's tasks
  const orderedKeys = guide.domains.flatMap((d) =>
    d.groups.flatMap((g) => [
      ...(g.tasks[0] ? [foundationKey(groupKeyOf(g.tasks[0].key))] : []),
      ...g.tasks.map((t) => t.key),
    ]),
  );
  const taskKeys = new Set(orderedKeys);
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

  // The maintainer's accepts that no candidate answers (a page added by hand, or one the generator no longer
  // proposes): a decision is remembered, so they are picks like the others. What the candidate would have carried
  // comes from the exam's scope (a module of the exam's own course is P1; a documentation page that such a module
  // lists is P2, with the module as its `via`), from learnsync's catalog (`describe`: the title and the signature
  // of another module, P3) or from the decision itself (the title of a documentation page, P4 when no module of
  // the course lists it); the maintainer's reason is the pick's reason and evidence.
  const ownModules = new Set(
    (scope.inputs?.snapshot?.modules ?? []).map((m) => m[0]),
  );
  // the documentation pages the modules of the exam's course list, with the first module that lists each
  const listedBy = new Map();
  for (const module of scope.modules ?? [])
    for (const link of module.resources?.links ?? [])
      if (link.path && !listedBy.has(link.path))
        listedBy.set(link.path, module.path);
  const judgedPairs = new Set(
    gated.items.map((i) => `${i.task.key}|${i.target.path}`),
  );
  let addedWithoutCandidate = 0;
  for (const m of gated.manual ?? []) {
    const path = m.target.path;
    if (judgedPairs.has(`${m.task}|${path}`)) continue;
    if (!taskKeys.has(m.task)) {
      warnings.push(
        `${m.task}: the maintainer accepted ${path} for a task that is not in the study guide any more: it is left out`,
      );
      continue;
    }
    const kind = m.target.kind ?? kindOfPath(path);
    const modulePath =
      kind === "docs" || kind === "github"
        ? null
        : path.split("/").slice(0, 4).join("/");
    const moduleInfo = modulePath ? (describe?.(modulePath) ?? null) : null;
    const title =
      (kind === "docs" || kind === "github"
        ? null
        : (describe?.(path)?.title ??
          (kind === "module" ? moduleInfo?.title : null))) ??
      m.title ??
      null;
    if (!title) {
      warnings.push(
        `${m.task}: the maintainer accepted ${path}, which is not a candidate, and nothing gives its title (learnsync's catalog does not list it and the decision has no title): it is left out`,
      );
      continue;
    }
    const own = modulePath !== null && ownModules.has(modulePath);
    const unitSig = modulePath && !own ? (moduleInfo?.unitSig ?? null) : null;
    if (modulePath && !own && !unitSig) {
      warnings.push(
        `${m.task}: the maintainer accepted ${path}, which is not a candidate and not a module of the exam's course, and learnsync's catalog has no signature for it: it is left out`,
      );
      continue;
    }
    const item = {
      task: { key: m.task },
      target: { kind, path },
      title,
      ...(kind === "unit" && modulePath
        ? {
            module: {
              path: modulePath,
              title: moduleInfo?.title ?? null,
            },
          }
        : {}),
      source:
        kind === "github"
          ? "P6"
          : own
            ? "P1"
            : modulePath
              ? "P3"
              : listedBy.has(path)
                ? "P2"
                : "P4",
      ...(!modulePath && listedBy.has(path) ? { via: listedBy.get(path) } : {}),
      ...(unitSig ? { unitSig } : {}),
      signals: {},
      flags: [],
      judge: null,
      manual: true,
      gate: {
        decision: "accept",
        class: m.class,
        ...(m.relation ? { relation: m.relation } : {}),
        by: "maintainer",
        via: "remembered",
        reasons: [`accepted by the maintainer: ${m.reason}`],
        reason: m.reason,
        at: m.at,
        ...(m.pinned ? { pinned: true } : {}),
      },
    };
    const built = pickOf(item, gated.builtAt ?? today);
    // an accept that only confirmed the judge's pick has no note of its own: without the candidate there is nothing
    // to say why the page is in the course, so it is left out (and said), not a reason to stop the build
    if (built.problem) warnings.push(`${built.problem}: it is left out`);
    else {
      const list = decided.get(m.task) ?? [];
      list.push({ pick: built.pick, item });
      decided.set(m.task, list);
      addedWithoutCandidate++;
    }
  }

  // hands-on material goes to the lab page and a page is shown once (the top of this file)
  const routed = routePicks({
    accepted: decided,
    taskKeys: orderedKeys,
    rejected,
  });
  const accepted = new Map(
    [...routed.accepted].map(([key, rows]) => [key, [...rows].sort(pickOrder)]),
  );
  // the picks that stay in the course but are marked for the maintainer, in the guide's order
  const review = [];
  for (const key of orderedKeys) {
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
        why: item.judge?.why,
        confidence: item.judge?.confidence,
        flags: item.judge?.flags ?? [],
      });
    }
  }
  const routing = {
    classic: routed.classic,
    handsOn: routed.handsOn,
    collapsed: routed.collapsed,
    blocked: routed.blocked,
    repeats: routed.repeats,
  };
  for (const c of routed.collapsed)
    if (!c.moduleTitle)
      warnings.push(
        `${c.path} was accepted as a unit and became its module ${c.module}, but the gated file has no title for the module: the page shows the unit's title`,
      );

  // everything a pick of another exam's course (or found by search) depends on is recorded with its signature
  const picked = new Map();
  const rowsOf = (key) => {
    const rows = accepted.get(key) ?? [];
    for (const { pick, item } of rows) {
      if (
        pick.source === "P3" ||
        pick.source === "P4" ||
        pick.source === "P5" ||
        pick.source === "P6"
      ) {
        const module = moduleOfPick(pick);
        if (module && !picked.has(module)) {
          if (!item.unitSig)
            problems.push(
              `${key}: ${pick.target.path} depends on ${module} but its signature is not in the gated file`,
            );
          else picked.set(module, item.unitSig);
        }
      }
    }
    return rows;
  };
  const domains = guide.domains.map((d) => ({
    title: d.title,
    ...(d.weight ? { weight: d.weight } : {}),
    groups: d.groups.map((g) => {
      const foundations = g.tasks[0]
        ? rowsOf(foundationKey(groupKeyOf(g.tasks[0].key)))
        : [];
      return {
        title: g.title,
        ...(foundations.length
          ? {
              foundations: orderFoundations(
                foundations.map((r) => r.pick),
                g.tasks.map((t) => t.text),
                g.title,
              ),
            }
          : {}),
        tasks: g.tasks.map((t) => {
          const picks = rowsOf(t.key).map((r) => r.pick);
          // a task without a module of its own points to the module that also covers it but is shown under another task
          const overlaps = picks.some((p) => p.target.kind === "module")
            ? []
            : routed.repeats
                .filter(
                  (r) =>
                    r.kind === "module" &&
                    r.alsoFits.includes(t.key) &&
                    !isFoundationKey(r.shownUnder),
                )
                .map((r) => ({
                  path: r.path,
                  title: r.title,
                  shownUnder: r.shownUnder,
                }));
          // likewise, a task without documentation of its own points to accepted docs placed once under sibling tasks
          const docOverlaps = picks.some(
            (p) => p.target.kind === "docs" || p.target.kind === "github",
          )
            ? []
            : routed.repeats
                .filter(
                  (r) =>
                    (r.kind === "docs" || r.kind === "github") &&
                    r.alsoFits.includes(t.key) &&
                    !isFoundationKey(r.shownUnder),
                )
                .map((r) => ({
                  path: r.path,
                  title: r.title,
                  shownUnder: r.shownUnder,
                }));
          return {
            key: t.key,
            text: t.text,
            picks,
            ...(overlaps.length ? { overlaps } : {}),
            ...(docOverlaps.length ? { docOverlaps } : {}),
          };
        }),
      };
    }),
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
    ...(guide.audience
      ? { audience: buildAudience(guide.audience, audienceDecisions) }
      : {}),
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
    // how many of the maintainer's accepts became picks although they are not candidates
    addedWithoutCandidate,
  };
}
