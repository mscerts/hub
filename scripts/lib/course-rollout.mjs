/**
 * The rollout table (docs/course-playbook.md, "Rollout"): which exams are ready for a course, in which order, and
 * how much work each is. Pure: the command line (scripts/course-rollout.mjs) loads the guides, the exam statuses
 * and the scope maps and hands them in.
 *
 * Waves, in the order they are worked:
 *   pilot    the exams the pilot uses (named by the maintainer; never chosen here)
 *   1        a stable guide, a parsed tree, an official course with enough modules: the rich ones first
 *   2        the same, but the exam is NEW (generally available for less than 90 days): its Learn material is
 *            still settling, so it waits for the first wave to have taught the process
 *   later    BETA, UPCOMING, AT RISK or RETIRING exams: a course built now would be rebuilt soon
 *   decide   too little Learn material (no official course, fewer modules than the threshold, or no module with
 *            harvested links): the maintainer decides whether a course makes sense, or whether it would be mostly
 *            the documentation shortlist
 *
 * A guide whose "skills measured as of" day is still ahead does not wait: the stored text is already that
 * version, and the rebuild check (course-status.mjs) catches any later change.
 *   blocked  the stored guide does not parse completely: fix the parser first (course-source.mjs --survey)
 *   skip     RETIRED
 */

import { parseGuide } from "./course-guide.mjs";
import { AREA_BY_PREFIX } from "./areas.mjs";

/**
 * Picks per task on the hand-made AZ-104 test page (354 picks over 82 tasks). Only the default of the review
 * estimate; the pilot replaces it with what the pipeline really produced.
 */
export const PICKS_PER_TASK = 4.3;
export const DEFAULT_THIN_MODULES = 6;
export const DEFAULT_QUEUE_SHARE = 0.25;

const LATER_STATUSES = ["BETA", "UPCOMING", "AT RISK", "RETIRING"];

export const areaOf = (code) =>
  AREA_BY_PREFIX[String(code).split("-")[0]] ?? null;

/** The exam statuses of exam-status.mjs (area -> code -> { text }) as a Map code -> status text. */
export function statusMap(examStatuses) {
  const map = new Map();
  for (const area of Object.values(examStatuses ?? {}))
    for (const [code, status] of Object.entries(area ?? {}))
      map.set(code, status.text);
  return map;
}

/**
 * Whether a guide's "skills measured as of" day is still ahead of today. `iso` is a day, or a month (YYYY-MM)
 * when the guide names no day; a month counts as ahead while it has not begun.
 */
export function guideChangesSoon(asOf, today) {
  const iso = asOf?.iso;
  if (!iso) return false;
  return iso.length === 7 ? `${iso}-01` > today : iso > today;
}

const sum = (list, fn) => list.reduce((n, x) => n + fn(x), 0);

/**
 * One row for an exam.
 * `guide` is a stored guide { lines, hash, name }; `scope` the exam's scope map (buildScopeMap), or null when
 * the Learn data could not be read; `status` the badge text of the exam or null.
 */
export function rolloutRow({
  code,
  guide,
  scope,
  status,
  today,
  pilot = false,
  thinModules = DEFAULT_THIN_MODULES,
  picksPerTask = PICKS_PER_TASK,
  queueShare = DEFAULT_QUEUE_SHARE,
  minutesPerItem = null,
}) {
  const parsed = parseGuide(guide.lines);
  const soon = guideChangesSoon(parsed.asOf, today);
  const modules = scope?.modules?.length ?? 0;
  const withResources = scope?.inputs?.resourceModules ?? 0;
  const why = [];
  let wave;
  if (!parsed.ok) {
    wave = "blocked";
    why.push(
      `the study guide does not parse completely${parsed.warnings[0] ? ` (${parsed.warnings[0]})` : ""}`,
    );
  } else if (status === "RETIRED") {
    wave = "skip";
    why.push("retired");
  } else if (pilot) {
    wave = "pilot";
    why.push("named by the maintainer for the pilot");
  } else if (LATER_STATUSES.includes(status)) {
    wave = "later";
    why.push(`${status}: a course built now would be rebuilt soon`);
  } else if (!scope || scope.courses.length === 0) {
    wave = "decide";
    why.push("no official course on Learn");
  } else if (modules < thinModules) {
    wave = "decide";
    why.push(
      `only ${modules} module${modules === 1 ? "" : "s"} in the official course (threshold ${thinModules})`,
    );
  } else if (withResources === 0) {
    wave = "decide";
    why.push(
      "no module of the official course has harvested links, so the best source (P2) is empty",
    );
  } else if (status === "NEW") {
    wave = 2;
    why.push("NEW: its Learn material is still settling");
  } else {
    wave = 1;
  }
  if (wave !== "blocked" && soon)
    why.push(
      `the guide takes effect on ${parsed.asOf.text} (the stored text is that version; Learn's course may lag it)`,
    );
  if (
    wave !== "blocked" &&
    scope &&
    withResources > 0 &&
    withResources < modules
  )
    why.push(
      `no harvested links in ${modules - withResources} of ${modules} modules`,
    );
  if (wave !== "blocked" && parsed.warnings.length)
    why.push(
      `${parsed.warnings.length} guide warning${parsed.warnings.length === 1 ? "" : "s"}`,
    );
  const tasks = parsed.stats.tasks;
  const expectedQueue = Math.round(tasks * picksPerTask * queueShare);
  return {
    code,
    name: guide.name ?? null,
    area: areaOf(code),
    status: status ?? null,
    guide: {
      ok: parsed.ok,
      domains: parsed.stats.domains,
      groups: parsed.stats.groups,
      tasks,
      warnings: parsed.warnings.length,
      asOf: parsed.asOf?.text ?? null,
      changesSoon: soon,
    },
    scope: scope
      ? { courses: scope.courses.length, modules, withResources }
      : null,
    wave,
    why,
    estimate: {
      judgeBatches: parsed.stats.groups,
      expectedPicks: Math.round(tasks * picksPerTask),
      expectedQueue,
      ...(minutesPerItem
        ? { reviewMinutes: expectedQueue * minutesPerItem }
        : {}),
    },
  };
}

const WAVE_ORDER = ["pilot", 1, 2, "decide", "later", "blocked", "skip"];

/**
 * The table: every stored guide as a row, in the order they are worked (wave, then the richest catalog first,
 * then the code), with the totals of each wave.
 */
export function rolloutTable({
  guides,
  statuses,
  scopeOf,
  today,
  pilot = [],
  ...options
}) {
  const statusOf = statusMap(statuses);
  const pilotCodes = new Set(pilot.map((c) => c.toUpperCase()));
  const rows = [...guides.entries()].map(([code, guide]) =>
    rolloutRow({
      code,
      guide,
      scope: scopeOf(code),
      status: statusOf.get(code) ?? null,
      today,
      pilot: pilotCodes.has(code),
      ...options,
    }),
  );
  rows.sort(
    (a, b) =>
      WAVE_ORDER.indexOf(a.wave) - WAVE_ORDER.indexOf(b.wave) ||
      (b.scope?.withResources ?? 0) - (a.scope?.withResources ?? 0) ||
      b.guide.tasks - a.guide.tasks ||
      (a.code < b.code ? -1 : 1),
  );
  const waves = WAVE_ORDER.map((wave) => {
    const inWave = rows.filter((r) => r.wave === wave);
    return {
      wave,
      exams: inWave.length,
      tasks: sum(inWave, (r) => r.guide.tasks),
      judgeBatches: sum(inWave, (r) => r.estimate.judgeBatches),
      expectedPicks: sum(inWave, (r) => r.estimate.expectedPicks),
      expectedQueue: sum(inWave, (r) => r.estimate.expectedQueue),
      ...(options.minutesPerItem
        ? { reviewMinutes: sum(inWave, (r) => r.estimate.reviewMinutes ?? 0) }
        : {}),
    };
  }).filter((w) => w.exams > 0);
  const unknownPilot = [...pilotCodes].filter((c) => !guides.has(c));
  return { rows, waves, unknownPilot };
}

/** The table as lines of text. */
export function describeTable(table, { minutesPerItem = null } = {}) {
  const lines = [];
  const pad = (v, n) => String(v).padEnd(n);
  let wave = null;
  for (const r of table.rows) {
    if (r.wave !== wave) {
      wave = r.wave;
      lines.push(
        "",
        `== ${typeof wave === "number" ? `wave ${wave}` : wave} ==`,
      );
    }
    lines.push(
      `${pad(r.code, 7)} ${pad(r.status ?? "", 8)} ${String(r.guide.tasks).padStart(3)} tasks ${String(r.guide.groups).padStart(2)} groups  ${
        r.scope
          ? `${String(r.scope.modules).padStart(3)} module${r.scope.modules === 1 ? " " : "s"} (${r.scope.withResources} with links)`
          : "no scope data"
      }  ~${r.estimate.expectedQueue} queue items${r.why.length ? `  - ${r.why.join("; ")}` : ""}`,
    );
  }
  lines.push("", "Totals by wave:");
  for (const w of table.waves)
    lines.push(
      `  ${pad(typeof w.wave === "number" ? `wave ${w.wave}` : w.wave, 8)} ${String(w.exams).padStart(2)} exams, ${String(w.tasks).padStart(4)} tasks, ${String(w.judgeBatches).padStart(3)} judge batches, ~${w.expectedPicks} picks, ~${w.expectedQueue} queue items${minutesPerItem ? ` (~${Math.round(w.reviewMinutes / 60)} h of review)` : ""}`,
    );
  return lines;
}
