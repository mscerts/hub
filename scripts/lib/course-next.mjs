/**
 * The upcoming course: what a course becomes when the study guide announces other tasks (docs/courses.md, "The two
 * versions"; the decisions of the maintainers are in docs/course-next.md).
 *
 * The course in force (src/data_files/courses/<CODE>.json) is carried forward to the upcoming version of the
 * guide, and only what is new is built again:
 *
 *   same        the task is in the same place with the same words: its picks and decisions carry over untouched
 *   moved       the same words in another place: the picks carry over under the new key
 *   reworded    other words, same task (the old and the new wording share at least CONFIRM_SIMILARITY of their
 *               words): the picks carry over; from CARRY_SIMILARITY up they are trusted, below it a person
 *               confirms them (`pending.confirm`), so the course is not complete until they have
 *   added       a task with no counterpart: it has no picks yet (`pending.added`) and goes through the pipeline
 *   removed     a task of the old guide with no counterpart: its picks leave with it
 *
 * A group of the new guide that has a counterpart keeps its fundamentals; one without gets them from the pipeline
 * (`pending.foundations`). When too much changed (MAJOR_SHARE of the tasks, or a domain or a group appeared or
 * went) the course is not patched: `planNext` says so and the whole pipeline is the way.
 *
 * Everything here is pure: the command line (scripts/course-next.mjs) reads and writes the files.
 */

import {
  REWORD_THRESHOLD,
  REWRITTEN_SHARE,
  align,
  norm,
  similarity,
} from "../../src/utils/guide-changes/diff.mjs";
import {
  foundationKey,
  groupKeyOf,
  isFoundationKey,
} from "./course-foundations.mjs";
import { buildAudience, eachConcept } from "./course-audience.mjs";
import { moduleOfPick } from "./course-format.mjs";
import { squish } from "./course-guide.mjs";
import { prettyDate, dayBefore } from "../../src/utils/guide-changes/state.mjs";
import { diffAudience } from "./course-status.mjs";
import { versionRef, withVersion } from "./course-version.mjs";

/** From this share of shared words a reworded task keeps its picks without anyone looking at them. */
export const CARRY_SIMILARITY = 0.8;
/** Below this share a task and its old wording are not the same task: removed and added. */
export const CONFIRM_SIMILARITY = REWORD_THRESHOLD;
/** More than this share of new or reworded tasks is a rewrite, not an update: the whole pipeline instead. */
export const MAJOR_SHARE = REWRITTEN_SHARE;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The tasks of a tree (a parsed guide or a course file) as rows with their place, in order. */
function rowsOf(tree) {
  return (tree.domains ?? []).flatMap((domain) =>
    (domain.groups ?? []).flatMap((group) =>
      (group.tasks ?? []).map((task) => ({
        key: task.key,
        text: squish(task.text),
        domain: squish(domain.title),
        group: squish(group.title),
        task,
      })),
    ),
  );
}

/**
 * How the tasks of the course pair with the tasks of the upcoming guide. Returns
 * [{ kind: "same" | "moved" | "reworded" | "added" | "removed", old?, new?, similarity? }]: the new tasks in the
 * guide's order (each as same, moved, reworded or added), then the removed ones.
 */
export function pairTasks(course, guide) {
  const olds = rowsOf(course);
  const news = rowsOf(guide);
  const pairs = new Map(); // new key -> { old, kind, similarity }
  const keys = new Set(olds.map((o) => o.key));
  // 1. the same key: the task did not move (its words are the same by construction of the key)
  for (const n of news)
    if (keys.has(n.key))
      pairs.set(n.key, {
        old: olds.find((o) => o.key === n.key),
        kind: "same",
        similarity: 1,
      });
  const takenOld = new Set([...pairs.values()].map((p) => p.old.key));
  const restOld = olds.filter((o) => !takenOld.has(o.key));
  const restNew = news.filter((n) => !pairs.has(n.key));
  // 2. what is left, by words: equal words (a move), then the most alike
  const queueOf = (rows) => {
    const byWords = new Map();
    for (const row of rows) {
      const list = byWords.get(row.text) ?? [];
      list.push(row);
      byWords.set(row.text, list);
    }
    return (text) => byWords.get(text)?.shift();
  };
  const nextOld = queueOf(restOld);
  const nextNew = queueOf(restNew);
  for (const entry of align(
    restOld.map((r) => r.text),
    restNew.map((r) => r.text),
    CONFIRM_SIMILARITY,
  )) {
    if (!entry.old || entry.new === undefined) continue;
    const old = nextOld(entry.old);
    const now = nextNew(entry.new);
    const score =
      norm(entry.old) === norm(entry.new)
        ? 1
        : Math.round(similarity(entry.old, entry.new) * 100) / 100;
    pairs.set(now.key, {
      old,
      kind: score === 1 ? "moved" : "reworded",
      similarity: score,
    });
  }
  const used = new Set([...pairs.values()].map((p) => p.old.key));
  return [
    ...news.map((n) =>
      pairs.has(n.key)
        ? { ...pairs.get(n.key), new: n }
        : { kind: "added", new: n },
    ),
    ...olds
      .filter((o) => !used.has(o.key))
      .map((o) => ({ kind: "removed", old: o })),
  ];
}

const slug = (text) => norm(text);

/** The skill groups of a tree as [{ domain, group, key }] (the key is the group's key, from its first task). */
function groupsOf(tree) {
  return (tree.domains ?? []).flatMap((domain) =>
    (domain.groups ?? []).map((group) => ({
      domain: squish(domain.title),
      group: squish(group.title),
      key: group.tasks?.[0] ? groupKeyOf(group.tasks[0].key) : null,
      node: group,
    })),
  );
}

/** The group of the course that is the counterpart of a group of the guide: same title, same domain first. */
function counterpartOf(wanted, oldGroups) {
  const same = oldGroups.filter((g) => slug(g.group) === slug(wanted.group));
  return (
    same.find((g) => slug(g.domain) === slug(wanted.domain)) ??
    (same.length === 1 ? same[0] : null)
  );
}

/**
 * What the change is, task by task, and whether it is an update or a rewrite.
 *   course  the course in force            guide  the parsed upcoming guide (`ok`)
 * Returns { pairs, counts, major }. `major` is null for an update, else the reasons the course is not patched.
 */
export function planNext({ course, guide }) {
  const pairs = pairTasks(course, guide);
  const count = (kind) => pairs.filter((p) => p.kind === kind).length;
  const counts = {
    same: count("same"),
    moved: count("moved"),
    reworded: count("reworded"),
    added: count("added"),
    removed: count("removed"),
    tasks: guide.domains.reduce(
      (n, d) => n + d.groups.reduce((m, g) => m + g.tasks.length, 0),
      0,
    ),
  };
  const reasons = [];
  const titles = (tree) =>
    new Set((tree.domains ?? []).map((d) => slug(d.title)));
  const before = titles(course);
  const after = titles(guide);
  for (const t of after)
    if (!before.has(t)) reasons.push("a domain is new in the upcoming guide");
  for (const t of before)
    if (!after.has(t)) reasons.push("a domain is gone from the upcoming guide");
  const oldGroups = groupsOf(course);
  const newGroups = groupsOf(guide);
  const unmatchedNew = newGroups.filter((g) => !counterpartOf(g, oldGroups));
  const unmatchedOld = oldGroups.filter((g) => !counterpartOf(g, newGroups));
  if (unmatchedNew.length)
    reasons.push(
      `${unmatchedNew.length} skill group${unmatchedNew.length === 1 ? " is" : "s are"} new: ${unmatchedNew.map((g) => g.group).join("; ")}`,
    );
  if (unmatchedOld.length)
    reasons.push(
      `${unmatchedOld.length} skill group${unmatchedOld.length === 1 ? " is" : "s are"} gone: ${unmatchedOld.map((g) => g.group).join("; ")}`,
    );
  const share = counts.tasks
    ? (counts.added + counts.reworded) / counts.tasks
    : 0;
  if (share > MAJOR_SHARE)
    reasons.push(
      `${counts.added + counts.reworded} of ${counts.tasks} tasks are new or reworded (more than ${Math.round(MAJOR_SHARE * 100)}%)`,
    );
  return {
    pairs,
    counts,
    share: Math.round(share * 100) / 100,
    major: reasons.length ? [...new Set(reasons)] : null,
  };
}

const clone = (value) => structuredClone(value);

/**
 * The audience profile of the upcoming course: the new version's (the validator compares it with the guide
 * version the course names), with the picks of every prerequisite concept the course in force had decided whose
 * key is still there. A guide without an audience profile keeps the course's.
 */
function carryAudience(guideAudience, courseAudience) {
  if (!guideAudience) return clone(courseAudience);
  const concepts = eachConcept(courseAudience)
    .filter((item) => item.key && item.picks)
    .map((item) => ({ key: item.key, picks: item.picks }));
  return buildAudience(guideAudience, { concepts });
}

/**
 * Build the upcoming course. `course` is the course in force, `guide` the parsed upcoming guide and `version` its
 * history version ({ n, asOf, firstSeen, lines }) and `today` a day (YYYY-MM-DD). Returns
 *   { ok: false, plan }                      the change is a rewrite: nothing is built (the whole pipeline instead)
 *   { ok: true, next, plan, report, rekey }
 * `rekey` lists the tasks and groups whose key changed ({ tasks: [[from, to]], groups: [[from, to]], removed }):
 * the decision list (src/data_files/course-decisions/<CODE>.json) is keyed by task, so it is moved to the new keys
 * with rekeyDecisions when the upcoming course takes over, not before (the course in force still uses the old
 * ones). `force` builds the patch although the change is a rewrite.
 */
export function buildNext({ course, guide, version, today, force = false }) {
  const plan = planNext({ course, guide });
  if (plan.major && !force) return { ok: false, plan };

  const keyMap = new Map(); // old task key -> new task key, for every carried task
  const confirm = [];
  const added = [];
  for (const pair of plan.pairs) {
    if (pair.kind === "added") added.push(pair.new.key);
    if (!pair.old || !pair.new) continue;
    keyMap.set(pair.old.key, pair.new.key);
    if (pair.kind === "reworded" && pair.similarity < CARRY_SIMILARITY)
      confirm.push({
        key: pair.new.key,
        was: pair.old.text,
        similarity: pair.similarity,
      });
  }
  const pairOf = new Map(
    plan.pairs.filter((p) => p.new).map((p) => [p.new.key, p]),
  );
  const oldGroups = groupsOf(course);
  const groupMap = new Map(); // old group key -> new group key
  const foundationsPending = [];

  const domains = guide.domains.map((domain) => ({
    title: domain.title,
    ...(domain.weight ? { weight: domain.weight } : {}),
    groups: domain.groups.map((group) => {
      const where = {
        domain: squish(domain.title),
        group: squish(group.title),
      };
      const counterpart = counterpartOf(where, oldGroups);
      const groupKey = group.tasks[0] ? groupKeyOf(group.tasks[0].key) : null;
      if (counterpart?.key && groupKey) groupMap.set(counterpart.key, groupKey);
      if (!counterpart && groupKey) foundationsPending.push(groupKey);
      const foundations = counterpart?.node.foundations;
      return {
        title: group.title,
        ...(foundations?.length ? { foundations: clone(foundations) } : {}),
        tasks: group.tasks.map((task) => {
          const pair = pairOf.get(task.key);
          const old = pair?.old?.task;
          const overlaps = (old?.overlaps ?? [])
            .map((o) => ({
              ...clone(o),
              shownUnder: keyMap.get(o.shownUnder),
            }))
            .filter((o) => o.shownUnder && !isFoundationKey(o.shownUnder));
          const docOverlaps = (old?.docOverlaps ?? [])
            .map((o) => ({
              ...clone(o),
              shownUnder: keyMap.get(o.shownUnder),
            }))
            .filter((o) => o.shownUnder && !isFoundationKey(o.shownUnder));
          return {
            key: task.key,
            text: task.text,
            picks: old?.picks ? clone(old.picks) : [],
            ...(overlaps.length ? { overlaps } : {}),
            ...(docOverlaps.length ? { docOverlaps } : {}),
          };
        }),
      };
    }),
  }));

  const taskKeys = new Set(
    plan.pairs.filter((p) => p.new).map((p) => p.new.key),
  );
  const rejected = (course.rejected ?? [])
    .map((entry) => {
      const key = keyMap.get(entry.taskKey);
      if (key) return { ...entry, taskKey: key };
      const group = groupMap.get(groupKeyOf(entry.taskKey));
      return isFoundationKey(entry.taskKey) && group
        ? { ...entry, taskKey: foundationKey(group) }
        : null;
    })
    .filter(
      (entry) =>
        entry &&
        (taskKeys.has(entry.taskKey) || isFoundationKey(entry.taskKey)),
    )
    .sort((a, b) => byText(a.taskKey, b.taskKey) || byText(a.path, b.path));

  const pending = {
    ...(added.length ? { added } : {}),
    ...(confirm.length ? { confirm } : {}),
    ...(foundationsPending.length ? { foundations: foundationsPending } : {}),
  };
  const inputs = { ...course.inputs };
  delete inputs.guideHash;
  delete inputs.guideAsOf;
  const base = {
    schemaVersion: course.schemaVersion,
    code: course.code,
    name: course.name,
    inputs: { ...inputs, builtAt: today },
    ...(guide.audience || course.audience
      ? { audience: carryAudience(guide.audience, course.audience) }
      : {}),
    domains,
    rejected,
    ...(Object.keys(pending).length ? { pending } : {}),
  };
  const withAsOf = guide.asOf?.text
    ? { ...base, inputs: { guideAsOf: guide.asOf.text, ...base.inputs } }
    : base;
  prunePicked(withAsOf);
  const next = withVersion(withAsOf, versionRef(version));

  // the keys that changed, for the decision list (see rekeyDecisions: it is done when the upcoming course takes over)
  const rekey = rekeyBetween(course, next);
  const audience = diffAudience(course.audience, guide.audience);
  return {
    ok: true,
    next,
    plan,
    rekey,
    report: {
      carried: plan.counts.same + plan.counts.moved + plan.counts.reworded,
      confirm,
      added,
      removed: plan.pairs
        .filter((p) => p.kind === "removed")
        .map((p) => p.old.key),
      foundations: foundationsPending,
      audienceChanged: Boolean(audience?.changed),
    },
  };
}

/** Whether an upcoming course is complete: nothing is left to build or to confirm. */
export function isComplete(next) {
  const pending = next?.pending;
  return (
    !pending ||
    ((pending.added ?? []).length === 0 &&
      (pending.confirm ?? []).length === 0 &&
      (pending.foundations ?? []).length === 0)
  );
}

function dropPendingIfEmpty(course) {
  if (!course.pending) return course;
  const pending = Object.fromEntries(
    Object.entries(course.pending).filter(([, list]) => list.length > 0),
  );
  const { pending: _old, ...rest } = course;
  return Object.keys(pending).length ? { ...rest, pending } : rest;
}

/** Say of reworded tasks that their carried picks still fit: `keys` (or every one with `all`). */
export function confirmPending(next, { keys = [], all = false } = {}) {
  const list = next.pending?.confirm ?? [];
  const unknown = keys.filter((k) => !list.some((c) => c.key === k));
  const left = list.filter((c) => !(all || keys.includes(c.key)));
  const pending = { ...next.pending, confirm: left };
  return {
    next: dropPendingIfEmpty({ ...next, pending }),
    confirmed: list.length - left.length,
    unknown,
  };
}

/** Say that the carried picks of a reworded task do not fit: they go, and the task is built like an added one. */
export function rejectPending(next, key) {
  const list = next.pending?.confirm ?? [];
  if (!list.some((c) => c.key === key)) return { next, rejected: false };
  const copy = clone(next);
  for (const d of copy.domains)
    for (const g of d.groups)
      for (const t of g.tasks)
        if (t.key === key) {
          t.picks = [];
          delete t.overlaps;
          delete t.docOverlaps;
        }
  copy.pending = {
    ...copy.pending,
    confirm: list.filter((c) => c.key !== key),
    added: [...(copy.pending.added ?? []), key],
  };
  repairOverlaps(copy);
  prunePicked(copy);
  return { next: dropPendingIfEmpty(copy), rejected: true };
}

/**
 * A page appears once in a course. The build that made the picks of `mergeBuilt` saw only the tasks it judged, so a
 * page it picked may already be shown under a task or fundamentals list the upcoming course carried over. The
 * carried one stays; the merged pick goes, and a task left without a module (or documentation page) of its own
 * points to where the page is shown when that holder is another task (never a group's fundamentals).
 */
function dedupeMerged(course, mergedTasks, mergedGroups) {
  const holder = new Map();
  const pathOf = (pick) => pick?.target?.path;
  const groupKey = (g) => (g.tasks[0] ? groupKeyOf(g.tasks[0].key) : null);
  for (const d of course.domains)
    for (const g of d.groups) {
      const gk = groupKey(g);
      if (gk && !mergedGroups.has(gk))
        for (const pick of g.foundations ?? [])
          if (pathOf(pick) && !holder.has(pathOf(pick)))
            holder.set(pathOf(pick), foundationKey(gk));
      for (const t of g.tasks)
        if (!mergedTasks.has(t.key))
          for (const pick of t.picks ?? [])
            if (pathOf(pick) && !holder.has(pathOf(pick)))
              holder.set(pathOf(pick), t.key);
    }
  for (const d of course.domains)
    for (const g of d.groups) {
      const gk = groupKey(g);
      if (gk && mergedGroups.has(gk) && g.foundations) {
        g.foundations = g.foundations.filter((p) => !holder.has(pathOf(p)));
        if (!g.foundations.length) delete g.foundations;
      }
      for (const t of g.tasks) {
        if (!mergedTasks.has(t.key)) continue;
        const dropped = (t.picks ?? []).filter((p) => holder.has(pathOf(p)));
        if (!dropped.length) continue;
        t.picks = t.picks.filter((p) => !holder.has(pathOf(p)));
        const point = (kinds, field) => {
          const left = t.picks.some((p) => kinds.includes(p.target?.kind));
          const entries = dropped
            .filter((p) => kinds.includes(p.target?.kind))
            .map((p) => ({
              path: pathOf(p),
              title: p.title,
              shownUnder: holder.get(pathOf(p)),
            }))
            .filter((o) => o.shownUnder && !isFoundationKey(o.shownUnder));
          if (left) delete t[field];
          else if (entries.length) t[field] = [...(t[field] ?? []), ...entries];
        };
        point(["module"], "overlaps");
        point(["docs", "github"], "docOverlaps");
      }
    }
  repairOverlaps(course);
}

/**
 * Follow every overlap/docOverlap pointer across the course to the task that currently shows the page, dropping
 * pointers to pages shown nowhere or only in a group's fundamentals, self-pointers, duplicates, and pointers on
 * tasks that already have a pick of that kind.
 */
function repairOverlaps(course) {
  const taskHolder = new Map();
  for (const d of course.domains)
    for (const g of d.groups)
      for (const t of g.tasks)
        for (const pick of t.picks ?? [])
          if (pick?.target?.path && !taskHolder.has(pick.target.path))
            taskHolder.set(pick.target.path, t.key);
  const own = (t, kinds) =>
    (t.picks ?? []).some((p) => kinds.includes(p.target?.kind));
  for (const d of course.domains)
    for (const g of d.groups)
      for (const t of g.tasks) {
        for (const [field, kinds] of [
          ["overlaps", ["module"]],
          ["docOverlaps", ["docs", "github"]],
        ]) {
          if (!t[field]) continue;
          const seen = new Set();
          const fixed = own(t, kinds)
            ? []
            : t[field]
                .map((o) => ({ ...o, shownUnder: taskHolder.get(o.path) }))
                .filter((o) => {
                  if (
                    !o.shownUnder ||
                    isFoundationKey(o.shownUnder) ||
                    o.shownUnder === t.key ||
                    seen.has(o.path)
                  )
                    return false;
                  seen.add(o.path);
                  return true;
                });
          if (fixed.length) t[field] = fixed;
          else delete t[field];
        }
      }
}

/** Remove `inputs.picked` entries for modules no pick in the course references anymore. */
function prunePicked(course) {
  if (!course.inputs?.picked) return;
  const scopeModules = new Set(
    (course.inputs?.scope?.modules ?? []).map((e) => e[0]),
  );
  const used = new Set();
  for (const d of course.domains ?? [])
    for (const g of d.groups ?? []) {
      for (const p of g.foundations ?? []) {
        const m = moduleOfPick(p);
        if (m && !scopeModules.has(m)) used.add(m);
      }
      for (const t of g.tasks ?? [])
        for (const p of t.picks ?? []) {
          const m = moduleOfPick(p);
          if (m && !scopeModules.has(m)) used.add(m);
        }
    }
  const kept = course.inputs.picked.filter((e) => used.has(e[0]));
  if (kept.length)
    course.inputs.picked = kept.sort((a, b) => byText(a[0], b[0]));
  else delete course.inputs.picked;
}

/** Record modules used by merged picks in `inputs.picked` and prune any orphaned entries. */
function carryPicked(course, built) {
  const have = new Map((course.inputs?.picked ?? []).map((e) => [e[0], e]));
  for (const entry of built.inputs?.picked ?? [])
    if (!have.has(entry[0])) have.set(entry[0], entry);
  if (have.size) course.inputs.picked = [...have.values()];
  prunePicked(course);
}

/** Carry remembered rejections from `built` for the newly merged tasks and group fundamentals. */
function carryRejected(course, built, mergedTasks, mergedGroups) {
  const map = new Map(
    (course.rejected ?? []).map((e) => [`${e.taskKey}|${e.path}`, e]),
  );
  for (const entry of built.rejected ?? []) {
    const k = entry?.taskKey;
    if (!k || !entry?.path) continue;
    const relevant = isFoundationKey(k)
      ? mergedGroups.has(groupKeyOf(k))
      : mergedTasks.has(k);
    if (relevant) map.set(`${k}|${entry.path}`, clone(entry));
  }
  course.rejected = [...map.values()].sort(
    (a, b) => byText(a.taskKey, b.taskKey) || byText(a.path, b.path),
  );
}

/**
 * Take the picks that a build made for the tasks (and the groups' fundamentals) still to be built from `built`
 * (a course file of the same exam made from the same version), and clear them from `pending`. Returns
 * { next, merged: { tasks, groups }, missing: [keys the built course has no task for] }.
 */
export function mergeBuilt(next, built) {
  const copy = clone(next);
  const builtTasks = new Map();
  const builtGroups = new Map();
  for (const d of built.domains ?? [])
    for (const g of d.groups ?? []) {
      if (g.tasks?.[0]) builtGroups.set(groupKeyOf(g.tasks[0].key), g);
      for (const t of g.tasks ?? []) builtTasks.set(t.key, t);
    }
  const wantedTasks = new Set(copy.pending?.added ?? []);
  const wantedGroups = new Set(copy.pending?.foundations ?? []);
  const doneTasks = [];
  const doneGroups = [];
  for (const d of copy.domains)
    for (const g of d.groups) {
      const groupKey = g.tasks[0] ? groupKeyOf(g.tasks[0].key) : null;
      if (groupKey && wantedGroups.has(groupKey) && builtGroups.has(groupKey)) {
        const found = builtGroups.get(groupKey).foundations;
        if (found?.length) g.foundations = clone(found);
        else delete g.foundations;
        doneGroups.push(groupKey);
      }
      for (const t of g.tasks)
        if (wantedTasks.has(t.key) && builtTasks.has(t.key)) {
          const source = builtTasks.get(t.key);
          t.picks = clone(source.picks ?? []);
          if (source.overlaps?.length) t.overlaps = clone(source.overlaps);
          else delete t.overlaps;
          if (source.docOverlaps?.length)
            t.docOverlaps = clone(source.docOverlaps);
          else delete t.docOverlaps;
          doneTasks.push(t.key);
        }
    }
  const mergedTaskSet = new Set(doneTasks);
  const mergedGroupSet = new Set(doneGroups);
  dedupeMerged(copy, mergedTaskSet, mergedGroupSet);
  carryPicked(copy, built);
  carryRejected(copy, built, mergedTaskSet, mergedGroupSet);
  if (copy.pending) {
    copy.pending = {
      ...copy.pending,
      added: (copy.pending.added ?? []).filter((k) => !doneTasks.includes(k)),
      foundations: (copy.pending.foundations ?? []).filter(
        (k) => !doneGroups.includes(k),
      ),
    };
  }
  return {
    next: dropPendingIfEmpty(copy),
    merged: { tasks: doneTasks, groups: doneGroups },
    missing: [
      ...[...wantedTasks].filter((k) => !doneTasks.includes(k)),
      ...[...wantedGroups].filter((k) => !doneGroups.includes(k)),
    ],
  };
}

/**
 * The keys that differ between the course in force and an upcoming course, for the decision list:
 * { tasks: [[from, to]], groups: [[from, to]], removed: [task keys], groupsGone: [group keys] }. Computed the
 * same way whenever it is asked, from the two courses, so it can be done on the day the upcoming course takes over.
 */
export function rekeyBetween(current, next) {
  const pairs = pairTasks(current, next);
  const oldGroups = groupsOf(current);
  const groups = [];
  const counterparts = new Set();
  for (const group of groupsOf(next)) {
    const counterpart = counterpartOf(group, oldGroups);
    if (!counterpart) continue;
    counterparts.add(counterpart.key);
    if (counterpart.key && group.key && counterpart.key !== group.key)
      groups.push([counterpart.key, group.key]);
  }
  return {
    tasks: pairs
      .filter((p) => p.old && p.new && p.old.key !== p.new.key)
      .map((p) => [p.old.key, p.new.key]),
    groups,
    removed: pairs.filter((p) => p.kind === "removed").map((p) => p.old.key),
    groupsGone: oldGroups
      .filter((g) => g.key && !counterparts.has(g.key))
      .map((g) => g.key),
  };
}

/**
 * The decision list with its keys moved to the upcoming course: a decision of a task that changed key follows it
 * (so does a decision about the fundamentals of a group that changed key); a decision of a task that is gone is
 * dropped; everything else stays. `rekey` is the one buildNext returns. Returns { store, moved, dropped }.
 */
export function rekeyDecisions(store, rekey) {
  const tasks = new Map(rekey.tasks);
  const groups = new Map(rekey.groups);
  const removed = new Set(rekey.removed);
  const groupsGone = new Set(rekey.groupsGone ?? []);
  const byPair = new Map();
  let moved = 0;
  let dropped = 0;
  for (const decision of store.decisions ?? []) {
    const task = String(decision.task);
    let entry = null;
    if (isFoundationKey(task)) {
      const to = groups.get(groupKeyOf(task));
      if (to) {
        entry = { ...decision, task: foundationKey(to) };
        moved++;
      } else if (groupsGone.has(groupKeyOf(task))) dropped++;
      else entry = decision;
    } else if (removed.has(task)) dropped++;
    else if (tasks.has(task)) {
      entry = { ...decision, task: tasks.get(task) };
      moved++;
    } else entry = decision;
    if (entry) byPair.set(`${entry.task}|${entry.target}`, entry);
  }
  return {
    store: { ...store, decisions: [...byPair.values()] },
    moved,
    dropped,
  };
}

/**
 * What differs between the course in force and the upcoming course, for the page that shows both:
 * { counts, current: { task, card }, upcoming: { task, card } }. `task` maps a task key to what the
 * heading says ("new", "reworded-upcoming", "reworded-current", "leaves") and `card` maps `<task key>|<page path>`
 * to "added" (only the upcoming course has the card) or "removed" (only the course in force has it); cards of a
 * task that is new or leaves are not marked, the heading says it. Every change is marked, however much of the
 * course it touches: showing what differs is the point of the page, so there is no limit (a rewrite is marked
 * like any other change; MAJOR_SHARE only stops `buildNext` from patching one).
 */
export function versionMarks({ current, next }) {
  const { pairs, counts } = planNext({ course: current, guide: next });
  const marks = {
    counts,
    current: { task: new Map(), card: new Map() },
    upcoming: { task: new Map(), card: new Map() },
  };
  const pathsOf = (task) =>
    new Set((task.picks ?? []).map((pick) => pick.target.path));
  for (const pair of pairs) {
    if (pair.kind === "added") marks.upcoming.task.set(pair.new.key, "new");
    else if (pair.kind === "removed")
      marks.current.task.set(pair.old.key, "leaves");
    else {
      if (pair.kind === "reworded") {
        marks.upcoming.task.set(pair.new.key, "reworded-upcoming");
        marks.current.task.set(pair.old.key, "reworded-current");
      }
      const before = pathsOf(pair.old.task);
      const after = pathsOf(pair.new.task);
      for (const path of after)
        if (!before.has(path))
          marks.upcoming.card.set(`${pair.new.key}|${path}`, "added");
      for (const path of before)
        if (!after.has(path))
          marks.current.card.set(`${pair.old.key}|${path}`, "removed");
    }
  }
  return marks;
}

/**
 * The words of the page with two versions, from the day the upcoming skills count from (YYYY-MM-DD) and the
 * counts of versionMarks: the labels of the tabs, the notes above them and the text of every mark.
 */
export function versionLabels({ effective, counts }) {
  const day = prettyDate(effective);
  const eve = prettyDate(dayBefore(effective));
  return {
    current: `Current, until ${eve}`,
    upcoming: `Upcoming, from ${day}`,
    intro: `The skills measured change on ${day}. The first tab is the course for what the exam measures until ${eve}, the second tab the course for the skills measured from ${day}. What differs between them is marked in words as well as colour; the Study Guide Changes page shows every difference word for word.`,
    currentLegend: `This is the course for the skills measured until ${eve}. A task that leaves is marked "Leaves ${day}", a card the upcoming course does not have says "Until ${eve}", and a reworded task keeps its old wording here.`,
    upcomingLegend: `This is the course for the skills measured from ${day}. New and reworded tasks are green and underlined with a badge, and a card the current course does not have is green and says "New from ${day}".`,
    added: `New from ${day}`,
    reworded: "Reworded",
    rewordedCurrent: `Reworded from ${day}`,
    leaves: `Leaves ${day}`,
    cardAdded: `New from ${day}`,
    cardRemoved: `Until ${eve}`,
  };
}
