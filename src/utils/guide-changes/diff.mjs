// The difference between two versions of a study guide, as data. Pure and dependency-free apart from
// the guide parser. Runbook: docs/study-guide-changes.md.
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";

/** The share of the new guide's skills that are new or reworded above which a guide counts as largely rewritten. */
export const REWRITTEN_SHARE = 0.5;
/** Word overlap (0 to 1) from which a removed and an added skill of one group are paired as a reworded skill. */
export const REWORD_THRESHOLD = 0.55;
/** The same overlap for lines of the audience profile, which are longer sentences. */
const AUDIENCE_THRESHOLD = 0.7;

export const norm = (text) =>
  String(text).toLowerCase().replace(/\s+/g, " ").trim();

const words = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/s$/, "")); // "eventstreams" and "eventstream" are the same word

/** Share of words two texts have in common (0 to 1). */
export function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  let shared = 0;
  for (const word of A) if (B.has(word)) shared++;
  return shared / Math.max(A.size, B.size, 1);
}

/**
 * Align two lists. Equal items (ignoring case and spacing) are paired first, then the most similar
 * remaining pairs at or above `threshold` (1 or more: exact matches only). The result follows the order
 * of the new list, with removed old items kept where they were: `{ old?, new? }` per entry.
 */
export function align(oldItems, newItems, threshold = REWORD_THRESHOLD) {
  const oldNorm = oldItems.map(norm);
  const newNorm = newItems.map(norm);
  const matchOfOld = new Array(oldItems.length).fill(-1);
  const matchOfNew = new Array(newItems.length).fill(-1);
  for (let j = 0; j < newItems.length; j++)
    for (let i = 0; i < oldItems.length; i++)
      if (matchOfOld[i] < 0 && oldNorm[i] === newNorm[j]) {
        matchOfOld[i] = j;
        matchOfNew[j] = i;
        break;
      }
  if (threshold < 1) {
    const candidates = [];
    for (let i = 0; i < oldItems.length; i++) {
      if (matchOfOld[i] >= 0) continue;
      for (let j = 0; j < newItems.length; j++) {
        if (matchOfNew[j] >= 0) continue;
        const score = similarity(oldItems[i], newItems[j]);
        if (score >= threshold) candidates.push([score, i, j]);
      }
    }
    candidates.sort((x, y) => y[0] - x[0]);
    for (const [, i, j] of candidates)
      if (matchOfOld[i] < 0 && matchOfNew[j] < 0) {
        matchOfOld[i] = j;
        matchOfNew[j] = i;
      }
  }
  const entries = [];
  const emitted = new Array(oldItems.length).fill(false);
  const flush = (upTo) => {
    for (let i = 0; i < upTo; i++)
      if (!emitted[i] && matchOfOld[i] < 0) {
        entries.push({ old: oldItems[i] });
        emitted[i] = true;
      }
  };
  for (let j = 0; j < newItems.length; j++) {
    if (matchOfNew[j] >= 0) {
      flush(matchOfNew[j]);
      emitted[matchOfNew[j]] = true;
      entries.push({ old: oldItems[matchOfNew[j]], new: newItems[j] });
    } else entries.push({ new: newItems[j] });
  }
  flush(oldItems.length);
  return entries;
}

/** What kind of entry an aligned pair is. */
export function entryKind(entry) {
  if (entry.old === undefined) return "added";
  if (entry.new === undefined) return "removed";
  return norm(entry.old) === norm(entry.new) ? "same" : "reworded";
}

/** The audience profile lines of a version: between its "Audience profile" and "Skills at a glance" headings. */
export function audienceLines(lines) {
  const from = lines.findIndex((line) => /^### Audience profile/.test(line));
  if (from < 0) return [];
  const to = lines.findIndex(
    (line, i) => i > from && /^### Skills at a glance/.test(line),
  );
  return lines
    .slice(from + 1, to < 0 ? undefined : to)
    .filter((line) => line.trim() && line !== "Tip");
}

const taskCount = (tree) =>
  tree.domains.reduce(
    (n, domain) =>
      n + domain.groups.reduce((m, group) => m + group.tasks.length, 0),
    0,
  );

/**
 * Compare two versions (their stored lines). Returns
 * `{ ok, stats, domains, audience }`; `ok` is false when either version cannot be read as a guide
 * (the caller then falls back to a plain line comparison).
 *
 * - `domains`: one entry per domain of either version, `{ status, title, weights: {old?, new?},
 *   groups: [{ status, title, items: [{ kind, old?, new? }] }] }`, `status` being `same`, `added` or
 *   `removed`; groups and domains are matched by exact title.
 * - `audience`: `{ changed, entries }` over the lines of the audience profile.
 * - `stats`: skills added, removed and reworded, the totals, whether any weight changed and the
 *   share of the new guide's skills that are new or reworded.
 */
export function diffVersions(prevLines, curLines) {
  const prev = parseGuide(prevLines);
  const cur = parseGuide(curLines);
  const audienceEntries = align(
    audienceLines(prevLines),
    audienceLines(curLines),
    AUDIENCE_THRESHOLD,
  );
  const audience = {
    changed: audienceEntries.some((entry) => entryKind(entry) !== "same"),
    entries: audienceEntries,
  };
  if (!prev.ok || !cur.ok) {
    // A guide whose structure cannot be read is compared line by line (the heading with the date apart).
    const body = (lines) =>
      lines.filter((line) => !/^## Skills measured/.test(line));
    const lineEntries = align(
      body(prevLines),
      body(curLines),
      AUDIENCE_THRESHOLD,
    );
    return {
      ok: false,
      audience,
      lineEntries,
      linesChanged: lineEntries.some((entry) => entryKind(entry) !== "same"),
      prev,
      cur,
      prevLines,
      curLines,
    };
  }

  const stats = { added: 0, removed: 0, reworded: 0, weightsChanged: false };
  const domains = align(
    prev.domains.map((d) => d.title),
    cur.domains.map((d) => d.title),
    1,
  ).map((domainEntry) => {
    const oldDomain = prev.domains.find((d) => d.title === domainEntry.old);
    const newDomain = cur.domains.find((d) => d.title === domainEntry.new);
    const weights = { old: oldDomain?.weight, new: newDomain?.weight };
    if (
      oldDomain &&
      newDomain &&
      (weights.old.min !== weights.new.min ||
        weights.old.max !== weights.new.max)
    )
      stats.weightsChanged = true;
    const groups = align(
      (oldDomain?.groups ?? []).map((g) => g.title),
      (newDomain?.groups ?? []).map((g) => g.title),
      1,
    ).map((groupEntry) => {
      const oldGroup = oldDomain?.groups.find(
        (g) => g.title === groupEntry.old,
      );
      const newGroup = newDomain?.groups.find(
        (g) => g.title === groupEntry.new,
      );
      const items = align(
        (oldGroup?.tasks ?? []).map((t) => t.text),
        (newGroup?.tasks ?? []).map((t) => t.text),
      ).map((entry) => ({ kind: entryKind(entry), ...entry }));
      for (const item of items) if (item.kind !== "same") stats[item.kind]++;
      return {
        status: oldGroup && newGroup ? "same" : newGroup ? "added" : "removed",
        title: (newGroup ?? oldGroup).title,
        items,
      };
    });
    return {
      status: oldDomain && newDomain ? "same" : newDomain ? "added" : "removed",
      title: (newDomain ?? oldDomain).title,
      weights,
      groups,
    };
  });
  stats.totalNow = taskCount(cur);
  stats.totalBefore = taskCount(prev);
  stats.changedShare = stats.totalNow
    ? (stats.added + stats.reworded) / stats.totalNow
    : 0;
  return { ok: true, stats, domains, audience, prev, cur, prevLines, curLines };
}

/**
 * How big the change between two versions is: `none` (nothing but, maybe, the date), `weights`
 * (only domain weights), `topics` (skills or the audience profile changed) or `rewritten` (more than
 * half of the new guide's skills are new or reworded). `unreadable` when a version cannot be parsed.
 */
export function changeKind(diff) {
  if (!diff.ok) return diff.linesChanged ? "unreadable" : "none";
  const { stats, audience } = diff;
  const skills = stats.added + stats.removed + stats.reworded;
  if (stats.changedShare > REWRITTEN_SHARE) return "rewritten";
  if (skills > 0 || audience.changed) return "topics";
  return stats.weightsChanged ? "weights" : "none";
}
