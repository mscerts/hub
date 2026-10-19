/**
 * Measuring the pilot (docs/course-playbook.md): the pass criteria of the pilot, as numbers. Pure: no I/O, no
 * network, no AI. The command line is scripts/course-pilot.mjs.
 *
 *   gold set      the maintainer marks picks of an EXISTING course (the hand-made AZ-104 test page, or a course
 *                 file) keep or drop, before looking at what the pipeline produces. The pipeline then runs blind
 *                 on the same tasks and the marks are compared with its decisions.
 *   review sample a random sample of what the gates accepted on their own, which the maintainer marks right or
 *                 wrong: the share that is right is the number the pilot is judged on.
 *   queue share   how much of what the judge picked waited for the maintainer.
 */

import { normalizeTitle, parseHeading, splitWeight } from "./course-guide.mjs";
import { learnPath } from "./course-scope.mjs";
import { flattenTasks } from "./course-status.mjs";

export const PILOT_SCHEMA_VERSION = 1;

/** The pass criteria the board item proposes; each can be changed on the command line. */
export const CRITERIA = Object.freeze({
  minCorrect: 0.95, // of the gates' own acceptances, on the reviewed sample
  maxQueueShare: 0.25, // of the judge's picks
  minKeepRetained: 0.9, // of the gold set's keeps, accepted or queued by the pipeline
  maxFalseAccepts: 0, // gold-set drops that the gates accepted on their own
});

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The kind of a Learn target path: module, unit or docs; null for a page that is not on Learn. */
export function kindOfLearnPath(path) {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "training" && parts[1] === "modules")
    return parts.length === 3 ? "module" : parts.length > 3 ? "unit" : null;
  if (["training", "credentials", "shows", "answers"].includes(parts[0]))
    return null;
  return "docs";
}

const linkTarget = (href) => {
  let url;
  try {
    url = new URL(href, "https://learn.microsoft.com");
  } catch {
    return null;
  }
  if (url.hostname !== "learn.microsoft.com") return null;
  const path = learnPath(href);
  const kind = kindOfLearnPath(path);
  return kind ? { kind, path } : null;
};

/**
 * The picks of a rendered or hand-made course page (MDX), as rows tied to the guide's tasks.
 * `guide` is the parsed study guide. A task of the page is matched to the guide's by the titles of its domain and
 * group and its own text; picks under a heading that is not a task of the guide are `unmatched`.
 * Returns { picks: [{ task: { key, text, domain, group }, target, title }], unmatched: [task text], tasks }.
 */
export function picksFromCourseMdx(mdx, guide) {
  const wanted = new Map();
  for (const t of flattenTasks(guide))
    wanted.set(
      `${normalizeTitle(t.domain)}|${normalizeTitle(t.group)}|${normalizeTitle(t.text)}`,
      t,
    );
  const picks = [];
  const unmatched = new Set();
  let domain = null;
  let group = null;
  let task = null;
  let inCode = false;
  let taskText = null;
  for (const raw of String(mdx ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    if (/^```/.test(raw)) inCode = !inCode;
    if (inCode) continue;
    const heading = parseHeading(raw);
    if (heading) {
      const text = heading.text.replace(/\\([{}<>])/g, "$1");
      task = null;
      taskText = null;
      if (heading.level === 2) {
        const { title, weight } = splitWeight(text);
        domain = weight ? title : null;
        group = null;
      } else if (heading.level === 3 && domain) group = text;
      else if (heading.level === 4 && group) {
        taskText = text;
        task =
          wanted.get(
            `${normalizeTitle(domain)}|${normalizeTitle(group)}|${normalizeTitle(text)}`,
          ) ?? null;
      }
      continue;
    }
    if (taskText === null) continue;
    for (const m of raw.matchAll(/<LinkCard\b([^>]*?)\/?>/g)) {
      const href = m[1].match(/\bhref="([^"]*)"/)?.[1];
      const title = m[1].match(/\btitle="([^"]*)"/)?.[1] ?? "";
      const target = href && linkTarget(href.replace(/&amp;/g, "&"));
      if (!target) continue;
      if (task) picks.push({ task, target, title });
      else unmatched.add(taskText);
    }
  }
  return { picks, unmatched: [...unmatched], tasks: wanted.size };
}

/** The picks of a course file (src/data_files/courses/<CODE>.json) as the same rows. */
export function picksFromCourseFile(course) {
  const picks = [];
  for (const d of course.domains ?? [])
    for (const g of d.groups ?? [])
      for (const t of g.tasks ?? [])
        for (const p of t.picks ?? [])
          picks.push({
            task: { key: t.key, text: t.text, domain: d.title, group: g.title },
            target: { kind: p.target.kind, path: p.target.path },
            title: p.title,
          });
  return { picks, unmatched: [], tasks: picks.length };
}

/** A small deterministic random generator (mulberry32), so a sample can be drawn again from its seed. */
export function seededRandom(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A sample of `size` picks spread over the domains and tasks of the course: domains in turn, a task of each in
 * turn, one pick of a task before a second. Picks whose path or title contains one of `include` are always in
 * (the entitlement management card). The same picks, size and seed give the same sample.
 */
export function drawGoldSample(
  picks,
  { size = 25, seed = 1, include = [] } = {},
) {
  const random = seededRandom(seed);
  const needles = include.map((s) => s.toLowerCase());
  const forced = picks.filter((p) =>
    needles.some((n) =>
      `${p.target.path} ${p.title}`.toLowerCase().includes(n),
    ),
  );
  const chosen = new Set(forced);
  const byDomain = new Map();
  for (const p of picks) {
    if (chosen.has(p)) continue;
    const domain = byDomain.get(p.task.domain) ?? new Map();
    const task = domain.get(p.task.key) ?? [];
    task.push(p);
    domain.set(p.task.key, task);
    byDomain.set(p.task.domain, domain);
  }
  const queues = [...byDomain.values()].map((domain) =>
    shuffled(
      [...domain.values()].map((list) => shuffled(list, random)),
      random,
    ),
  );
  let more = true;
  while (chosen.size < size && more) {
    more = false;
    for (const tasks of queues) {
      const next = tasks.find((list) => list.length > 0);
      if (!next) continue;
      more = true;
      chosen.add(next.shift());
      tasks.push(tasks.splice(tasks.indexOf(next), 1)[0]);
      if (chosen.size >= size) break;
    }
  }
  return [...chosen].sort(
    (a, b) =>
      byText(a.task.key, b.task.key) || byText(a.target.path, b.target.path),
  );
}

/** The gold file the maintainer marks: `mark` is "keep" or "drop". */
export function goldTemplate({ code, source, picks }) {
  return {
    schemaVersion: PILOT_SCHEMA_VERSION,
    kind: "gold",
    code,
    source,
    // the skill groups the pipeline has to run on for the comparison to mean anything
    groups: [...new Set(picks.map((p) => p.task.group))].sort(),
    picks: picks.map((p) => ({
      task: p.task.key,
      taskText: p.task.text,
      group: p.task.group,
      target: p.target,
      title: p.title,
      mark: null,
      note: "",
    })),
  };
}

/** `/training/modules/<slug>` for a module or one of its units, else null. */
const moduleBase = (path) => {
  const parts = String(path).split("/").filter(Boolean);
  return parts[0] === "training" && parts[1] === "modules" && parts[2]
    ? `/${parts.slice(0, 3).join("/")}`
    : null;
};

const OUTCOME_RANK = { accept: 0, queue: 1, reject: 2 };
/** Of several gated items, the one the pipeline went furthest with: accepted, then queued, then rejected. */
const bestOf = (items) =>
  [...items].sort(
    (a, b) =>
      OUTCOME_RANK[a.gate.decision] - OUTCOME_RANK[b.gate.decision] ||
      byText(a.target.path, b.target.path),
  )[0] ?? null;

const outcomeOf = (item) => {
  if (!item) return "not a candidate";
  const g = item.gate;
  if (g.decision === "accept")
    return g.by === "maintainer"
      ? "accepted by the maintainer"
      : "accepted by the gates";
  if (g.decision === "queue") return "queued";
  return g.via === "judge" ? "rejected by the judge" : `rejected (${g.via})`;
};

/**
 * Compare a marked gold file with the gated file of the same exam.
 * Returns { problems, keeps, drops, unmarked, items, passes, criteria }.
 *   keeps retained  accepted (by the gates or the maintainer) or queued: the pipeline kept it or asked about it
 *   keeps lost      rejected, or never a candidate
 *   false accepts   drops that the gates accepted on their own
 */
export function goldAgreement(gold, gated, criteria = {}) {
  const limits = { ...CRITERIA, ...criteria };
  const problems = [];
  if (gold?.kind !== "gold" || !Array.isArray(gold.picks))
    return { problems: ["not a gold file"] };
  if (gold.code !== gated.code)
    problems.push(
      `the gold file is for ${gold.code}, the gated file for ${gated.code}`,
    );
  const index = new Map(
    gated.items.map((i) => [`${i.task.key}|${i.target.path}`, i]),
  );
  const byModule = new Map();
  for (const i of gated.items) {
    const base = moduleBase(i.target.path);
    if (!base) continue;
    const key = `${i.task.key}|${base}`;
    byModule.set(key, [...(byModule.get(key) ?? []), i]);
  }
  const tasks = new Set(gated.items.map((i) => i.task.key));
  const items = [];
  const seen = new Set();
  let unmarked = 0;
  for (const p of gold.picks) {
    if (p.mark === null || p.mark === undefined || p.mark === "") {
      unmarked++;
      continue;
    }
    if (p.mark !== "keep" && p.mark !== "drop") {
      problems.push(
        `${p.task} ${p.target?.path}: the mark is "${p.mark}", not keep or drop`,
      );
      continue;
    }
    const id = `${p.task}|${p.target.path}`;
    if (seen.has(id)) {
      problems.push(`${id} is in the gold file twice`);
      continue;
    }
    seen.add(id);
    if (!tasks.has(p.task))
      problems.push(
        `${p.task}: the pipeline did not run on this task (judge and gate it, or remove its picks from the gold file)`,
      );
    const exact = index.get(id);
    // A keep may be found as another page of the same module (the module for its unit, or the reverse): the
    // learner reaches the same material. A drop is only matched exactly.
    const near =
      !exact && p.mark === "keep"
        ? bestOf(byModule.get(`${p.task}|${moduleBase(p.target.path)}`) ?? [])
        : null;
    items.push({
      ...p,
      outcome: outcomeOf(exact ?? near),
      found: Boolean(exact),
      ...(near ? { nearPath: near.target.path } : {}),
    });
  }
  const keeps = items.filter((i) => i.mark === "keep");
  const drops = items.filter((i) => i.mark === "drop");
  const retained = keeps.filter((i) => /^(accepted|queued)/.test(i.outcome));
  const falseAccepts = drops.filter(
    (i) => i.outcome === "accepted by the gates",
  );
  const count = (list, outcome) =>
    list.filter((i) => i.outcome === outcome).length;
  const result = {
    problems,
    unmarked,
    items,
    keeps: {
      total: keeps.length,
      acceptedByGates: count(keeps, "accepted by the gates"),
      acceptedByMaintainer: count(keeps, "accepted by the maintainer"),
      queued: count(keeps, "queued"),
      lost: keeps.length - retained.length,
      notCandidates: count(keeps, "not a candidate"),
      foundAsAnotherPageOfTheModule: keeps.filter((i) => i.nearPath).length,
      retainedShare: keeps.length ? retained.length / keeps.length : null,
    },
    drops: {
      total: drops.length,
      falseAccepts: falseAccepts.length,
      queued: count(drops, "queued"),
      rejected: drops.filter((i) => /^rejected/.test(i.outcome)).length,
      notCandidates: count(drops, "not a candidate"),
    },
  };
  result.passes = {
    keepsRetained:
      keeps.length === 0 ||
      result.keeps.retainedShare >= limits.minKeepRetained,
    noFalseAccepts: falseAccepts.length <= limits.maxFalseAccepts,
  };
  result.criteria = limits;
  return result;
}

/**
 * A random sample of what the gates accepted on their own, for the maintainer to mark right or wrong.
 * Returns the review file; the same gated file, size and seed give the same sample.
 */
export function drawReviewSample(gated, { size = 40, seed = 1 } = {}) {
  const accepted = gated.items
    .filter((i) => i.gate.decision === "accept" && i.gate.by === "gates")
    .sort(
      (a, b) =>
        byText(a.task.key, b.task.key) || byText(a.target.path, b.target.path),
    );
  const chosen = shuffled(accepted, seededRandom(seed))
    .slice(0, size)
    .sort(
      (a, b) =>
        byText(a.task.key, b.task.key) || byText(a.target.path, b.target.path),
    );
  return {
    schemaVersion: PILOT_SCHEMA_VERSION,
    kind: "review-sample",
    code: gated.code,
    seed,
    population: accepted.length,
    items: chosen.map((i) => ({
      task: i.task.key,
      taskText: i.task.text,
      group: i.task.group,
      target: i.target,
      title: i.title,
      url: `https://learn.microsoft.com${i.target.path}`,
      source: i.source,
      class: i.gate.class,
      ...(i.gate.relation ? { relation: i.gate.relation } : {}),
      judge: i.judge.why,
      ...(i.judge.quote ? { quote: i.judge.quote } : {}),
      correct: null,
      note: "",
    })),
  };
}

/** The share of picks the judge made that waited for the maintainer. */
export function queueShare(gated) {
  const accepted = gated.items.filter(
    (i) => i.gate.decision === "accept",
  ).length;
  const queued = gated.items.filter((i) => i.gate.decision === "queue").length;
  return {
    accepted,
    acceptedByGates: gated.items.filter(
      (i) => i.gate.decision === "accept" && i.gate.by === "gates",
    ).length,
    queued,
    rejected: gated.items.length - accepted - queued,
    share: accepted + queued ? queued / (accepted + queued) : null,
  };
}

/**
 * The lower end of the 95% Wilson interval for `correct` right out of `total`: what the share could plausibly be at
 * the least, given how small the sample is. 38 of 40 is 95% observed but could be 83% in truth.
 */
export function wilsonLowerBound(correct, total, z = 1.96) {
  if (!total) return null;
  const p = correct / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - margin) / denominator);
}

/**
 * Score a marked review sample: how many are right, among those marked. Returns
 * { problems, answered, pending, correct, wrong, share, lowerBound, passes, wrongItems }; `passes` is null until
 * every item is marked, and it compares the observed share with the limit (`lowerBound` says how far to trust it).
 */
export function scoreReviewSample(sample, criteria = {}) {
  const limits = { ...CRITERIA, ...criteria };
  if (sample?.kind !== "review-sample" || !Array.isArray(sample.items))
    return { problems: ["not a review sample"] };
  const problems = sample.items
    .filter(
      (i) =>
        i.correct !== null &&
        i.correct !== undefined &&
        typeof i.correct !== "boolean",
    )
    .map(
      (i) =>
        `${i.task} ${i.target?.path}: "correct" must be true or false, not ${JSON.stringify(i.correct)}`,
    );
  const answered = sample.items.filter((i) => typeof i.correct === "boolean");
  const correct = answered.filter((i) => i.correct).length;
  const pending = sample.items.length - answered.length - problems.length;
  const share = answered.length ? correct / answered.length : null;
  return {
    problems,
    answered: answered.length,
    pending,
    correct,
    wrong: answered.length - correct,
    share,
    lowerBound: wilsonLowerBound(correct, answered.length),
    population: sample.population,
    passes: pending > 0 || share === null ? null : share >= limits.minCorrect,
    wrongItems: answered.filter((i) => !i.correct),
    criteria: limits,
  };
}
