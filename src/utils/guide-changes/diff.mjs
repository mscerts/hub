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

/**
 * Words that say little about what a skill is about (and the verbs every skill starts with), left out when
 * skills of different domains are matched by topic.
 */
const TOPIC_STOP = new Set(
  `a an and are as at be by can for from how in into is it of on or other such that the their this to use using via when whether which with within without your you including include includes based across between each any all more most not new existing manage implement configure create design monitor review respond plan deploy develop analyze apply enable perform identify describe understand select determine evaluate build set up`.split(
    " ",
  ),
);

const topicWords = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((word) => word && !TOPIC_STOP.has(word))
      .map((word) => word.replace(/s$/, "")),
  );

/**
 * What two skills are about, regardless of how they are worded: the meaningful words they share, and
 * those as a share of the shorter skill (a broad skill can swallow a precise one), and as a share of both
 * together (`jaccard`, which says how close two skills are when several could swallow one). `{ shared, score,
 * jaccard }`.
 */
export function topicOverlap(a, b) {
  const A = topicWords(a);
  const B = topicWords(b);
  let shared = 0;
  for (const word of A) if (B.has(word)) shared++;
  return {
    shared,
    score: shared / Math.max(1, Math.min(A.size, B.size)),
    jaccard: shared / Math.max(1, A.size + B.size - shared),
  };
}

/** Topic overlap from which a removed and an added skill of different places count as the same topic moved. */
export const MOVE_THRESHOLD = 0.8;
/**
 * The topic overlap from which two skills of a hand-paired old and new group count as the same skill moved
 * or reworded: lower than between domains, because a person already said the groups are about the same thing.
 */
export const GROUP_MOVE_THRESHOLD = 0.5;
/** The fewest meaningful words two skills must share to count as the same topic moved. */
const MOVE_MIN_SHARED = 2;

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

/** The old title of a domain or group entry of a comparison (the new one when the title did not change). */
const oldTitleOf = (entry) => entry.oldTitle ?? entry.title;

/**
 * Match each removed skill to the added skill it is closest to, when they are about the same thing
 * (`topicOverlap` at or above `threshold`); an added skill can take several removed ones. Where `groupMap` has a hand-made pairing of the old group of a skill, only
 * the groups it connects are allowed (at `GROUP_MOVE_THRESHOLD`); otherwise only the domains `edges` connects
 * (when given). Then the skills of an old group that `groupMap` marks as covered by a broader one, and that
 * found no counterpart, become `covered`. Changes the items and `stats` in place.
 */
function pairMoves(domains, threshold, stats, edges, groupMap) {
  const removed = [];
  const added = [];
  for (const domain of domains)
    for (const group of domain.groups)
      for (const item of group.items) {
        if (item.kind === "removed")
          removed.push({
            item,
            domain: oldTitleOf(domain),
            group: oldTitleOf(group),
          });
        if (item.kind === "added")
          added.push({ item, domain: domain.title, group: group.title });
      }
  // Every old skill goes to the new skill it is closest to (several old, low-level skills can land on one
  // new, higher-level skill), as long as it is about the same topic and in a place the areas allow.
  const best = new Map();
  removed.forEach((from, i) => {
    const grouped = groupMap?.grouped.has(from.group);
    let top = null;
    added.forEach((to, j) => {
      if (grouped) {
        if (!groupMap.edges.has(moveEdge(from.group, to.group))) return;
      } else if (edges && !edges.has(moveEdge(from.domain, to.domain))) return;
      const { shared, score, jaccard } = topicOverlap(
        from.item.old,
        to.item.new,
      );
      if (
        shared < MOVE_MIN_SHARED ||
        score < (grouped ? GROUP_MOVE_THRESHOLD : threshold)
      )
        return;
      if (
        !top ||
        jaccard > top.jaccard ||
        (jaccard === top.jaccard && shared > top.shared)
      )
        top = { j, jaccard, shared };
    });
    if (top) best.set(i, top);
  });
  const receivers = new Map();
  for (const [i, top] of best) {
    if (!receivers.has(top.j)) receivers.set(top.j, []);
    receivers.get(top.j).push({ i, jaccard: top.jaccard });
  }
  for (const [j, sources] of receivers) {
    sources.sort((x, y) => y.jaccard - x.jaccard);
    const to = added[j];
    const lead = removed[sources[0].i];
    to.item.kind = "moved-in";
    to.item.old = lead.item.old;
    to.item.from = { domain: lead.domain, group: lead.group };
    if (sources.length > 1) to.item.alsoFrom = sources.length - 1;
    stats.added--;
    stats.moved++;
    for (const { i } of sources) {
      const from = removed[i];
      from.item.kind = "moved-out";
      from.item.to = { domain: to.domain, group: to.group, text: to.item.new };
      stats.removed--;
    }
  }
  if (!groupMap?.covered.size) return;
  const domainOfNewGroup = new Map();
  for (const domain of domains)
    if (domain.status !== "removed")
      for (const group of domain.groups)
        domainOfNewGroup.set(group.title, domain.title);
  for (const { item, group } of removed) {
    const target = groupMap.covered.get(group);
    if (item.kind !== "removed" || !target) continue;
    item.kind = "covered";
    item.to = { domain: domainOfNewGroup.get(target), group: target };
    stats.removed--;
    stats.covered++;
  }
}

/** The key of an allowed move: from an old domain to a new one. */
export const moveEdge = (oldDomain, newDomain) => `${oldDomain} ${newDomain}`;

/**
 * Align the domains of two guides by a hand-made pairing: `pairs` maps an old domain title to the new domain
 * it became (see compare.mjs). Domains with the same title that nobody paired are paired too; the rest is
 * added or removed. Same shape as `align`, in the order of the new guide with the removed domains last.
 */
function alignDomains(oldTitles, newTitles, pairs) {
  const entries = [];
  const usedOld = new Set();
  const pairedOldOf = new Map();
  for (const [old, now] of pairs)
    if (
      oldTitles.includes(old) &&
      newTitles.includes(now) &&
      !pairedOldOf.has(now)
    )
      pairedOldOf.set(now, old);
  for (const title of pairedOldOf.values()) usedOld.add(title);
  for (const now of newTitles) {
    let old = pairedOldOf.get(now);
    if (old === undefined && !pairedOldOf.has(now)) {
      const same = oldTitles.find(
        (t) => !usedOld.has(t) && norm(t) === norm(now),
      );
      if (same !== undefined && ![...pairs.keys()].includes(same)) old = same;
    }
    if (old !== undefined) {
      usedOld.add(old);
      entries.push({ old, new: now });
    } else entries.push({ new: now });
  }
  for (const old of oldTitles) if (!usedOld.has(old)) entries.push({ old });
  return entries;
}

/**
 * Compare two versions (their stored lines). Returns
 * `{ ok, stats, domains, audience }`; `ok` is false when either version cannot be read as a guide
 * (the caller then falls back to a plain line comparison).
 *
 * - `domains`: one entry per domain of either version, `{ status, title, weights: {old?, new?},
 *   groups: [{ status, title, items: [{ kind, old?, new? }] }] }`, `status` being `same`, `added` or
 *   `removed`; groups and domains are matched by exact title, or, with `options.titleThreshold` below 1
 *   (the comparison of two different exams), by similar title: `oldTitle` is then set when the title differs.
 * - `options.pairDomains` (a Map of old to new domain title) replaces the pairing of domains by title with a
 *   hand-made one (the comparison of two different exams, compare.mjs).
 * - with `options.moveThreshold` below 1, the skills left over as removed or added are matched across domains
 *   and groups by topic (`topicOverlap`), only between the domains `options.moveEdges` allows (a Set of
 *   `moveEdge(oldDomain, newDomain)`; all when it is not given): a pair is one skill that moved (and perhaps was
 *   reworded), kind `moved-out` on the old side (`to` names where it went) and `moved-in` on the new side
 *   (`old` is its old wording, `from` where it came from), counted in `stats.moved` and no longer as added and
 *   removed. `options.groupMap` (`{ edges, grouped, covered }`, see groupGraph in compare.mjs) narrows that to
 *   hand-paired groups, and makes the skills of an old group that a broader new one covers kind `covered`
 *   (`to` names that group), counted in `stats.covered` and no longer as removed.
 * - `audience`: `{ changed, entries }` over the lines of the audience profile.
 * - `stats`: skills added, removed and reworded, the totals, whether any weight changed and the
 *   share of the new guide's skills that are new or reworded.
 */
export function diffVersions(
  prevLines,
  curLines,
  {
    titleThreshold = 1,
    moveThreshold = 1,
    pairDomains = null,
    moveEdges = null,
    groupMap = null,
  } = {},
) {
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
  const oldDomainTitles = prev.domains.map((d) => d.title);
  const newDomainTitles = cur.domains.map((d) => d.title);
  const domainEntries = pairDomains
    ? alignDomains(oldDomainTitles, newDomainTitles, pairDomains)
    : align(oldDomainTitles, newDomainTitles, titleThreshold);
  const domains = domainEntries.map((domainEntry) => {
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
      titleThreshold,
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
        ...(oldGroup && newGroup && oldGroup.title !== newGroup.title
          ? { oldTitle: oldGroup.title }
          : {}),
        items,
      };
    });
    return {
      status: oldDomain && newDomain ? "same" : newDomain ? "added" : "removed",
      title: (newDomain ?? oldDomain).title,
      ...(oldDomain && newDomain && oldDomain.title !== newDomain.title
        ? { oldTitle: oldDomain.title }
        : {}),
      weights,
      groups,
    };
  });
  stats.moved = 0;
  stats.covered = 0;
  if (moveThreshold < 1)
    pairMoves(domains, moveThreshold, stats, moveEdges, groupMap);
  stats.totalNow = taskCount(cur);
  stats.totalBefore = taskCount(prev);
  stats.changedShare = stats.totalNow
    ? (stats.added + stats.reworded + stats.moved) / stats.totalNow
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
