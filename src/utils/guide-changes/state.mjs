// What a study guide history means today: which version is current, which is upcoming or previous,
// what changed between them and what the exam page's banner should say. Pure. Runbook:
// docs/study-guide-changes.md.
import { guideChangeWhen } from "../guide-change-date.mjs";
import { changeKind, diffVersions } from "./diff.mjs";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-11-16" -> "November 16, 2026". */
export function prettyDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** The day before an ISO date. */
export function dayBefore(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from one ISO day to another. */
export const daysBetween = (from, to) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86400000,
  );

/** Short, unique names for domain titles: the first words that tell them apart ("Plan", "Design", "Deploy"). */
export function shortLabels(titles) {
  const split = titles.map((title) => title.split(/\s+/));
  return split.map((parts, index) => {
    for (let k = 1; k <= parts.length; k++) {
      const label = parts.slice(0, k).join(" ");
      const clash = split.some(
        (other, i) => i !== index && other.slice(0, k).join(" ") === label,
      );
      if (!clash) return label;
    }
    return parts.join(" ");
  });
}

const midpoint = (w) => (w.min + w.max) / 2;

function skillsSentence(stats) {
  const parts = [
    [stats.added, "added"],
    [stats.removed, "removed"],
    [stats.reworded, "reworded"],
  ].filter(([n]) => n > 0);
  if (!parts.length) return "";
  const texts = parts.map(([n, verb], i) =>
    i === 0 ? `${n} skill${n === 1 ? "" : "s"} ${verb}` : `${n} ${verb}`,
  );
  const joined =
    texts.length === 1
      ? texts[0]
      : `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}`;
  return `${joined}.`;
}

/** "Plan +10, Design +5, Deploy −20 points" for the domains whose weight changed. */
function weightsSentence(diff) {
  const domains = diff.domains.filter(
    (d) =>
      d.status === "same" &&
      (d.weights.old.min !== d.weights.new.min ||
        d.weights.old.max !== d.weights.new.max),
  );
  if (!domains.length) return "";
  const labels = shortLabels(
    diff.domains.filter((d) => d.status !== "removed").map((d) => d.title),
  );
  const names = new Map(
    diff.domains
      .filter((d) => d.status !== "removed")
      .map((d, i) => [d.title, labels[i]]),
  );
  const parts = domains.map((d) => {
    const delta = midpoint(d.weights.new) - midpoint(d.weights.old);
    return `${names.get(d.title)} ${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
  });
  return `${parts.join(", ")} points`;
}

/** One line saying what changed, from a comparison and its kind. */
export function summarise(diff, kind) {
  if (kind === "rewritten")
    return `Largely rewritten: ${diff.stats.added + diff.stats.reworded} of ${diff.stats.totalNow} skills are new or reworded.`;
  if (kind === "weights")
    return `Domain weights change: ${weightsSentence(diff)}.`;
  if (kind === "topics") {
    const parts = [];
    if (diff.stats.weightsChanged)
      parts.push(`Domain weights change: ${weightsSentence(diff)}.`);
    const skills = skillsSentence(diff.stats);
    if (skills) parts.push(skills);
    if (diff.audience.changed)
      parts.push(
        skills
          ? "The audience profile changed too."
          : "The audience profile changed.",
      );
    return parts.join(" ");
  }
  if (kind === "unreadable") return "The wording of the guide changed.";
  return "";
}

/**
 * The state of a history at `now`:
 * - `upcoming`: the newest version, when its date is still ahead;
 * - `current`: the newest version that is not dated in the future (the page wins whatever the dates
 *   say, so an earlier-dated replacement is still the current one);
 * - `previous`: the version recorded before `current`, else the version Microsoft's page lists as
 *   "prior to" (`previousSource` says which);
 * - `pair`: the two versions the Changes tab compares: current to upcoming when one is announced,
 *   otherwise previous to current.
 */
export function versionState(history, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const versions = history.versions;
  const future = (v) => v.asOf !== null && v.asOf > today;
  let upcoming = null;
  let index = versions.length - 1;
  if (index >= 0 && future(versions[index])) {
    upcoming = versions[index];
    index--;
    while (index >= 0 && future(versions[index])) index--;
  }
  const current = index >= 0 ? versions[index] : null;
  const anchor = current ?? upcoming; // the version whose "prior to" section is Microsoft's own previous
  let previous = null;
  let previousSource = null;
  if (current && index > 0) {
    previous = versions[index - 1];
    previousSource = "recorded";
  } else if (anchor?.priorOnPage) {
    previous = {
      ...anchor.priorOnPage,
      firstSeen: anchor.firstSeen,
      onPage: true,
    };
    previousSource = "onPage";
  }

  let pair = null;
  if (upcoming && current)
    pair = { from: current, to: upcoming, fromSource: "recorded" };
  else if (upcoming && previous)
    pair = { from: previous, to: upcoming, fromSource: previousSource };
  else if (current && previous)
    pair = { from: previous, to: current, fromSource: previousSource };

  const result = {
    today,
    versions,
    current,
    upcoming,
    previous,
    previousSource,
    pair,
  };
  if (!pair)
    return { ...result, diff: null, kind: "none", change: null, banner: null };

  const diff = diffVersions(pair.from.lines, pair.to.lines);
  const kind = changeKind(diff);

  // When did the change take effect, and on what footing: a date the guide states, or the day we saw it.
  let effective = null;
  if (pair.to === upcoming)
    effective = { date: pair.to.asOf, basis: "effective" };
  else if (pair.fromSource === "onPage")
    effective = pair.to.asOf
      ? { date: pair.to.asOf, basis: "effective" }
      : null;
  else if (pair.to.asOf && pair.to.asOf > pair.to.firstSeen)
    effective = { date: pair.to.asOf, basis: "effective" };
  else effective = { date: pair.to.firstSeen, basis: "seen" };

  const regressed = Boolean(
    pair.fromSource === "recorded" &&
    pair.to.asOf &&
    pair.from.asOf &&
    pair.to.asOf < pair.from.asOf,
  );
  const change = { diff, kind, effective, regressed };
  const when = effective ? guideChangeWhen(effective.date, now) : null;
  const banner =
    when && kind !== "none"
      ? {
          ...when,
          effective: effective.date,
          basis: effective.basis,
          summary: summarise(diff, kind),
          ...(regressed
            ? {
                dateNote: `Microsoft replaced the guide with a version dated ${prettyDate(pair.to.asOf)}, earlier than the one it replaced.`,
              }
            : {}),
        }
      : null;
  return { ...result, diff, kind, change, banner };
}
