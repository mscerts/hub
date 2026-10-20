/**
 * The approval gates (docs/course-gates.md): what happens to a judged candidate. Each is accepted into the course
 * by the gates, rejected, or queued for the maintainer, and what the maintainer decides is remembered and never
 * asked twice. Pure: no I/O, no network (the freshness of a page and its age are injected). The command line is
 * scripts/course-gates.mjs.
 *
 * Input: the judged files of an exam (course-judge.mjs merge). Output: a decision per candidate, and the queue.
 *
 *   accept   a pick the gates may take on their own: the judge and the skeptic agree, nothing is flagged, and the
 *            approval policy of the course format lets the gates decide (not a P4, not core from P3, not a
 *            deeper dive)
 *   reject   remembered before, in an excluded sub-product, not a current Learn page, or rejected by the judge
 *   queue    everything else, with the reasons, for the maintainer
 *
 * The maintainer's decisions live in src/data_files/course-decisions/<CODE>.json (committed, like the course file);
 * they are applied before anything else, so a decided candidate never comes back to the queue.
 */

import { docFamily } from "./course-candidates.mjs";
import { CLASSES, RELATIONS, approvalPolicy } from "./course-format.mjs";

export const GATES_SCHEMA_VERSION = 1;

/** The reason stored for an accept the maintainer gave no note to: not a reason a course page can show. */
export const ACCEPTED_BY_MAINTAINER = "accepted by the maintainer";

export const GATE_DEFAULTS = Object.freeze({
  // a core pick's quote must carry at least this share of the task's distinctive words: a quote that says
  // nothing of the task is no evidence for it
  coreQuoteCoverage: 0.5,
  // a page not modified for longer than this is queued (24 months)
  maxAgeDays: 730,
});

// the flags that say a candidate is out of scope: a rejection with one is worth remembering
const OUT_OF_SCOPE_FLAGS = [
  "other-role",
  "other-sub-product",
  "licensing-tier",
];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value) =>
  typeof value === "string" &&
  ISO_DAY.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const present = (value) => typeof value === "string" && value.trim() !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (task, path) => `${task}|${path}`;

// ---------------------------------------------------------------------------
// The maintainer's decisions
// ---------------------------------------------------------------------------

export const emptyDecisions = (code) => ({
  schemaVersion: GATES_SCHEMA_VERSION,
  code,
  decisions: [],
  excludedFamilies: [],
});

/**
 * Check a decisions file. A decision is { task, target, decision: accept | reject, class + relation for an accept,
 * reason, by: "maintainer", at }; an excluded family is { family, reason, at }. Returns a list of problems.
 */
export function validateDecisions(store, code = null) {
  const errors = [];
  if (!store || typeof store !== "object")
    return ["the decisions file is not a JSON object"];
  if (store.schemaVersion !== GATES_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${GATES_SCHEMA_VERSION}`);
  if (code && store.code !== code)
    errors.push(`code is "${store.code}", expected "${code}"`);
  if (!Array.isArray(store.decisions)) errors.push("decisions must be a list");
  if (!Array.isArray(store.excludedFamilies))
    errors.push("excludedFamilies must be a list");
  const seen = new Set();
  for (const d of Array.isArray(store.decisions) ? store.decisions : []) {
    const label = `${d?.task} | ${d?.target}`;
    if (!present(d?.task) || !present(d?.target)) {
      errors.push(`a decision needs a task and a target: ${JSON.stringify(d)}`);
      continue;
    }
    if (seen.has(pairKey(d.task, d.target)))
      errors.push(`${label}: decided twice`);
    seen.add(pairKey(d.task, d.target));
    if (!["accept", "reject"].includes(d.decision))
      errors.push(`${label}: decision must be accept or reject`);
    if (d.decision === "accept") {
      if (!CLASSES.includes(d.class))
        errors.push(
          `${label}: an accept needs a class (${CLASSES.join(", ")})`,
        );
      if (d.class === "supporting" && !Object.hasOwn(RELATIONS, d.relation))
        errors.push(
          `${label}: a supporting accept needs a relation (${Object.keys(RELATIONS).join(", ")})`,
        );
      if (d.class === "core" && d.relation !== undefined)
        errors.push(`${label}: only a supporting accept has a relation`);
    } else if (d.class !== undefined || d.relation !== undefined)
      errors.push(`${label}: only an accept has a class or a relation`);
    if (!present(d.reason)) errors.push(`${label}: reason is required`);
    if (d.by !== "maintainer") errors.push(`${label}: by must be "maintainer"`);
    if (!isDay(d.at)) errors.push(`${label}: at must be a YYYY-MM-DD day`);
  }
  const families = new Set();
  for (const f of Array.isArray(store.excludedFamilies)
    ? store.excludedFamilies
    : []) {
    if (!present(f?.family) || !f.family.startsWith("/"))
      errors.push(
        `an excluded family needs a path like /entra/id-governance: ${JSON.stringify(f)}`,
      );
    else if (families.has(f.family)) errors.push(`${f.family}: excluded twice`);
    families.add(f?.family);
    if (!present(f?.reason)) errors.push(`${f?.family}: reason is required`);
    if (!isDay(f?.at)) errors.push(`${f?.family}: at must be a YYYY-MM-DD day`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/** The Learn address of a target, for a person to open. */
export const learnUrl = (path) => `https://learn.microsoft.com${path}`;

const daysBetween = (from, to) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

/**
 * The gates for one judged candidate. `task` is { key, text, group }; `item` is an entry of a judged file.
 * `ctx` is { decisions, today, isCurrent, ageOf, options }. Returns
 *   { decision: "accept" | "reject" | "queue", class?, relation?, by, via, reasons: [text], remember? }
 * `via` says what decided: "remembered" (a maintainer decision), "excluded" (an excluded sub-product),
 * "current" (not a current page), "judge" (the judge rejected it), "gates" (the rules below).
 */
export function gateItem(task, item, ctx) {
  const { decisions, isCurrent, ageOf } = ctx;
  const options = { ...GATE_DEFAULTS, ...(ctx.options ?? {}) };
  const path = item.target.path;
  const flags = item.flags ?? [];

  const remembered = decisions?.byPair.get(pairKey(task.key, path));
  if (remembered) {
    if (remembered.decision === "reject")
      return {
        decision: "reject",
        by: "maintainer",
        via: "remembered",
        reasons: [`rejected by the maintainer: ${remembered.reason}`],
        reason: remembered.reason,
        at: remembered.at,
      };
    const current = isCurrent?.(path, item.target.kind);
    if (current && current.ok === false)
      return {
        decision: "reject",
        by: "gates",
        via: "current",
        reasons: [
          `not a current Learn page${current.reason ? ` (${current.reason})` : ""}`,
        ],
      };
    return {
      decision: "accept",
      class: remembered.class,
      ...(remembered.relation ? { relation: remembered.relation } : {}),
      by: "maintainer",
      via: "remembered",
      reasons: [`accepted by the maintainer: ${remembered.reason}`],
      reason: remembered.reason,
      at: remembered.at,
    };
  }

  if (item.target.kind === "docs") {
    const family = docFamily(path);
    const excluded = decisions?.families.get(family);
    if (excluded)
      return {
        decision: "reject",
        by: "gates",
        via: "excluded",
        reasons: [
          `in ${family}, which the maintainer excluded: ${excluded.reason}`,
        ],
      };
  }

  const current = isCurrent?.(path, item.target.kind);
  if (current && current.ok === false)
    return {
      decision: "reject",
      by: "gates",
      via: "current",
      reasons: [
        `not a current Learn page${current.reason ? ` (${current.reason})` : ""}`,
      ],
    };

  const j = item.judge;
  if (j.verdict === "reject") {
    // A judge that is not sure does not get to dismiss a page: the maintainer is the final judge of what it
    // cannot place. Only a reject with high or medium confidence is final.
    if (j.confidence === "low")
      return {
        decision: "queue",
        by: "maintainer",
        via: "gates",
        reasons: [
          `the judge rejected it but is not sure (low confidence): ${j.why}`,
        ],
      };
    return {
      decision: "reject",
      by: "gates",
      via: "judge",
      reasons: [`rejected by the judge: ${j.why}`],
      reason: j.why,
      remember: flags.some((f) => OUT_OF_SCOPE_FLAGS.includes(f)),
    };
  }

  // a pick: the class the judge gave, unless the skeptic downgraded it
  const proposal =
    item.skeptic?.stance === "downgrade"
      ? { class: "supporting", relation: item.skeptic.relation }
      : {
          class: j.verdict,
          ...(j.relation ? { relation: j.relation } : {}),
        };
  const reasons = [];
  const policy = approvalPolicy({
    source: item.source,
    class: proposal.class,
    relation: proposal.relation,
  });
  if (policy === "maintainer")
    reasons.push(
      item.source === "P4"
        ? "found by search only (P4): the maintainer decides"
        : item.source === "P5"
          ? "named by a model only (P5): the maintainer decides"
          : proposal.class === "core"
            ? "core material of another exam's course (P3): the maintainer decides"
            : "a deeper dive than the exam asks for: the maintainer decides",
    );
  if (item.agreement === "disagree")
    reasons.push(
      `the skeptic ${item.skeptic.stance === "refute" ? "refuted" : "downgraded"} it: ${item.skeptic.reason}`,
    );
  else if (item.agreement === "unchallenged")
    reasons.push("no skeptic has challenged it");
  if (j.confidence === "low")
    reasons.push("the judge is not sure (low confidence)");
  if (flags.length) reasons.push(`flagged: ${flags.join(", ")}`);
  if (j.quoteVerified === false)
    reasons.push("the quote is not in the evidence");
  else if (
    j.verdict === "core" &&
    (j.quoteTermCoverage ?? 0) < options.coreQuoteCoverage
  )
    reasons.push(
      `the quote carries ${Math.round((j.quoteTermCoverage ?? 0) * 100)}% of the task's words`,
    );
  const s = item.signals ?? {};
  if (s.foreignFamily || s.siblingSection || s.anchored === false)
    reasons.push(
      "another sub-product than the task's anchor" +
        (s.foreignFamily
          ? " (a family the exam's course does not list)"
          : s.siblingSection
            ? " (a section the exam's course does not list)"
            : ""),
    );
  const age = ageOf?.(item.target);
  if (typeof age === "number" && age > options.maxAgeDays)
    reasons.push(`not modified for ${Math.round(age / 30)} months`);

  if (reasons.length)
    return {
      decision: "queue",
      class: proposal.class,
      ...(proposal.relation ? { relation: proposal.relation } : {}),
      by: "maintainer",
      via: "gates",
      reasons,
    };
  return {
    decision: "accept",
    class: proposal.class,
    ...(proposal.relation ? { relation: proposal.relation } : {}),
    by: "gates",
    via: "gates",
    reasons: [
      `${item.source}, the judge and the skeptic agree` +
        (item.source === "P3" ? ", same sub-product" : ""),
    ],
  };
}

/**
 * Index a decisions file for the gates: by (task, target) and by excluded family.
 */
export function indexDecisions(store) {
  return {
    byPair: new Map(
      (store?.decisions ?? []).map((d) => [pairKey(d.task, d.target), d]),
    ),
    families: new Map(
      (store?.excludedFamilies ?? []).map((f) => [f.family, f]),
    ),
  };
}

/**
 * Gate every candidate of the judged files of an exam. Returns { items, stats }; an item is
 * { task: { key, text, group }, target, title, source, via?, signals, flags, judge, skeptic?, agreement, gate }
 * with `gate` the result of gateItem. `today` is a YYYY-MM-DD day.
 */
export function gateJudged(judgedFiles, ctx) {
  const decisions = ctx.decisions ? indexDecisions(ctx.decisions) : null;
  const items = [];
  for (const file of judgedFiles)
    for (const task of file.tasks)
      for (const item of task.items) {
        const info = {
          key: task.key,
          text: task.text,
          group: file.group.title,
        };
        items.push({
          task: info,
          target: item.target,
          title: item.title,
          source: item.source,
          ...(item.via ? { via: item.via } : {}),
          ...(item.module ? { module: item.module } : {}),
          ...(item.unitSig ? { unitSig: item.unitSig } : {}),
          ...(item.coverage !== undefined ? { coverage: item.coverage } : {}),
          signals: item.signals ?? {},
          flags: item.flags ?? [],
          judge: item.judge,
          ...(item.skeptic ? { skeptic: item.skeptic } : {}),
          agreement: item.agreement,
          gate: gateItem(info, item, { ...ctx, decisions }),
        });
      }
  items.sort(
    (a, b) =>
      byText(a.task.key, b.task.key) || byText(a.target.path, b.target.path),
  );
  return { items, stats: gateStats(items) };
}

export function gateStats(items) {
  const count = (fn) => items.filter(fn).length;
  const queued = items.filter((i) => i.gate.decision === "queue");
  const reasons = {};
  for (const i of queued)
    for (const r of i.gate.reasons) {
      const key = r.split(":")[0].replace(/\b\d+%?(?=\s)/g, "N");
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  return {
    candidates: items.length,
    accepted: count((i) => i.gate.decision === "accept"),
    acceptedCore: count(
      (i) => i.gate.decision === "accept" && i.gate.class === "core",
    ),
    acceptedSupporting: count(
      (i) => i.gate.decision === "accept" && i.gate.class === "supporting",
    ),
    acceptedByMaintainer: count(
      (i) => i.gate.decision === "accept" && i.gate.by === "maintainer",
    ),
    rejected: count((i) => i.gate.decision === "reject"),
    rejectedRemembered: count(
      (i) => i.gate.via === "remembered" && i.gate.decision === "reject",
    ),
    rejectedExcluded: count((i) => i.gate.via === "excluded"),
    rejectedNotCurrent: count((i) => i.gate.via === "current"),
    rejectedByJudge: count((i) => i.gate.via === "judge"),
    queued: queued.length,
    // pages the judge rejected without being sure: the maintainer decides them
    queuedJudgeRejects: queued.filter((i) => i.judge.verdict === "reject")
      .length,
    queueReasons: Object.fromEntries(
      Object.entries(reasons).sort((a, b) => b[1] - a[1] || byText(a[0], b[0])),
    ),
  };
}

// ---------------------------------------------------------------------------
// The queue and the maintainer's answers
// ---------------------------------------------------------------------------

/**
 * The queue file: the candidates that wait for the maintainer, with what they need to decide. The maintainer
 * edits the file by hand: `decision` ("accept" or "reject"), and optionally `class` and `relation` (to accept as
 * another class than proposed), `excludeFamily: true` (with a reject of a documentation page: every page of that
 * family is rejected from now on) and `note` (the reason; for a reject it is what is remembered).
 */
export function buildQueue(code, gated, { builtAt }) {
  const queued = gated.items.filter((i) => i.gate.decision === "queue");
  return {
    schemaVersion: GATES_SCHEMA_VERSION,
    kind: "queue",
    code,
    builtAt,
    items: queued.map((i, n) => ({
      id: `q${String(n + 1).padStart(3, "0")}`,
      task: i.task.key,
      taskText: i.task.text,
      group: i.task.group,
      target: i.target,
      title: i.title,
      source: i.source,
      ...(i.via ? { via: i.via } : {}),
      url: learnUrl(i.target.path),
      // a page the judge rejected without being sure has no proposed class: the maintainer gives one to accept it
      proposal: i.gate.class
        ? {
            class: i.gate.class,
            ...(i.gate.relation ? { relation: i.gate.relation } : {}),
          }
        : { verdict: "reject" },
      reasons: i.gate.reasons,
      judge: {
        verdict: i.judge.verdict,
        why: i.judge.why,
        ...(i.judge.quote ? { quote: i.judge.quote } : {}),
        confidence: i.judge.confidence,
        flags: i.judge.flags ?? [],
      },
      ...(i.skeptic
        ? { skeptic: { stance: i.skeptic.stance, reason: i.skeptic.reason } }
        : {}),
      decision: null,
      class: null,
      relation: null,
      excludeFamily: false,
      note: "",
    })),
  };
}

/**
 * Apply the maintainer's answers of a queue file to the decisions file. Items without a `decision` stay
 * pending. Returns { store, applied, pending, problems }; a queue with a problem applies nothing.
 * An item already decided is a problem unless `replace` is set.
 */
export function applyAnswers(store, queue, { today, replace = false }) {
  const problems = [];
  if (!queue || queue.kind !== "queue" || !Array.isArray(queue.items))
    return { store, applied: [], pending: 0, problems: ["not a queue file"] };
  if (queue.code !== store.code)
    problems.push(
      `the queue is for ${queue.code}, the decisions are ${store.code}`,
    );
  const decisions = new Map(
    store.decisions.map((d) => [pairKey(d.task, d.target), d]),
  );
  const families = new Map(store.excludedFamilies.map((f) => [f.family, f]));
  const applied = [];
  let pending = 0;
  for (const q of queue.items) {
    if (q.decision === null || q.decision === undefined || q.decision === "") {
      pending++;
      continue;
    }
    const label = `${q.id} (${q.task} | ${q.target?.path})`;
    if (!["accept", "reject"].includes(q.decision)) {
      problems.push(`${label}: decision must be "accept" or "reject"`);
      continue;
    }
    const key = pairKey(q.task, q.target.path);
    if (decisions.has(key) && !replace) {
      problems.push(`${label}: already decided (use --replace to change it)`);
      continue;
    }
    const entry = { task: q.task, target: q.target.path, decision: q.decision };
    if (q.decision === "accept") {
      const overruled = q.proposal?.verdict === "reject";
      entry.class = q.class || q.proposal?.class;
      if (!CLASSES.includes(entry.class)) {
        problems.push(
          `${label}: class must be ${CLASSES.join(" or ")}${overruled ? " (the judge rejected this page, so no class is proposed: give one)" : ""}`,
        );
        continue;
      }
      if (overruled && !present(q.note)) {
        problems.push(
          `${label}: the judge rejected this page; say in note why you accept it (it becomes the pick's reason)`,
        );
        continue;
      }
      if (entry.class === "supporting") {
        entry.relation =
          q.relation ||
          (q.proposal.class === "supporting" ? q.proposal.relation : undefined);
        if (!Object.hasOwn(RELATIONS, entry.relation)) {
          problems.push(
            `${label}: a supporting accept needs a relation (${Object.keys(RELATIONS).join(", ")})`,
          );
          continue;
        }
      } else if (q.relation) {
        problems.push(`${label}: a core accept has no relation`);
        continue;
      }
      if (q.excludeFamily) {
        problems.push(`${label}: excludeFamily goes with a reject`);
        continue;
      }
      entry.reason = present(q.note) ? q.note.trim() : ACCEPTED_BY_MAINTAINER;
    } else {
      entry.reason = present(q.note)
        ? q.note.trim()
        : "rejected by the maintainer";
      if (q.excludeFamily) {
        if (q.target.kind !== "docs") {
          problems.push(
            `${label}: only a documentation page can exclude a family`,
          );
          continue;
        }
        const family = docFamily(q.target.path);
        if (!families.has(family))
          families.set(family, { family, reason: entry.reason, at: today });
      }
    }
    entry.by = "maintainer";
    entry.at = today;
    decisions.set(key, entry);
    applied.push(entry);
  }
  if (problems.length) return { store, applied: [], pending, problems };
  return {
    store: {
      ...store,
      decisions: [...decisions.values()].sort(
        (a, b) => byText(a.task, b.task) || byText(a.target, b.target),
      ),
      excludedFamilies: [...families.values()].sort((a, b) =>
        byText(a.family, b.family),
      ),
    },
    applied,
    pending,
    problems,
  };
}

/** Days since an ISO timestamp or day, or null when it is not one. */
export function ageInDays(stamp, today) {
  if (!present(stamp)) return null;
  const day = String(stamp).slice(0, 10);
  return isDay(day) ? daysBetween(day, today) : null;
}
