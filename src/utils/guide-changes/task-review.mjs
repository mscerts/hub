// The hand-made task review of a comparison (compare-tasks.mjs) applied to the diff of the two guides: every
// skill is placed by what the review says, not matched by topic. Runbook: docs/study-guide-changes.md.
import { createHash } from "node:crypto";
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";
import { norm } from "./diff.mjs";

/** The `[domain, group, task]` of every task of a guide, in order; null when the guide cannot be read. */
export function taskTuples(lines) {
  const tree = parseGuide(lines);
  if (!tree.ok) return null;
  return tree.domains.flatMap((domain) =>
    domain.groups.flatMap((group) =>
      group.tasks.map((task) => [domain.title, group.title, task.text]),
    ),
  );
}

/** What a review pins for each guide: the SHA-256 of its task tuples. */
export const taskFingerprint = (tuples) =>
  createHash("sha256").update(JSON.stringify(tuples)).digest("hex");

export const taskRefs = (value) => (Array.isArray(value) ? value : [value]);

const placeKey = (domain, group) => `${domain}\u0000${group}`;

/**
 * Rebuild the items of `diff` (diffVersions of the merged old guide and the new one, domains paired, no moves)
 * from `review`. `sourceLines` are the lines of each old guide in the order of the pair, `fromLabel` names
 * them in the notes. Returns null, so the caller can say so and fall back, when a guide is not the one the
 * review was made against. Invalid relationships throw rather than silently changing the comparison.
 *
 * Item kinds: `same` and `reworded` (one skill to one in the same group), `moved-in` and `moved-out` (one to
 * one in another group or domain), `merged` (a new skill of a relationship with several skills on either
 * side; the first of a run of them lists the old skills, `lead`) and `merged-out` (an old skill of such a
 * relationship shown where it was, because none of its new skills is in that group), `added` and `removed`.
 * Places are `{ side, domain, group, near }`: the diff's own domain and group, and whether the domain is the
 * one the item is shown in.
 */
export function applyTaskReview(diff, review, sourceLines, fromLabel) {
  if (!diff.ok || !review) return null;
  const sources = sourceLines.map(taskTuples);
  const newTuples = taskTuples(diff.curLines);
  if (sources.some((tuples) => !tuples) || !newTuples) return null;
  const guides = [...sources, newTuples];
  if (
    guides.length !== review.sources.length ||
    guides.some((tuples, i) => taskFingerprint(tuples) !== review.sources[i])
  )
    return null;
  const oldTuples = sources.flat();
  if (JSON.stringify(taskTuples(diff.prevLines)) !== JSON.stringify(oldTuples))
    return null;

  const domains = diff.domains.map((domain) => ({
    ...domain,
    groups: domain.groups.map((group) => ({ ...group, items: [] })),
  }));
  const oldPlaces = new Map();
  const newPlaces = new Map();
  for (const domain of domains)
    for (const group of domain.groups) {
      const place = { domain, group };
      if (domain.status !== "added" && group.status !== "added")
        oldPlaces.set(
          placeKey(
            domain.oldTitle ?? domain.title,
            group.oldTitle ?? group.title,
          ),
          place,
        );
      if (domain.status !== "removed" && group.status !== "removed")
        newPlaces.set(placeKey(domain.title, group.title), place);
    }
  const locate = (tuples, places) =>
    tuples.map(([domain, group]) => places.get(placeKey(domain, group)));
  const oldAt = locate(oldTuples, oldPlaces);
  const newAt = locate(newTuples, newPlaces);
  if (oldAt.some((p) => !p) || newAt.some((p) => !p)) return null;
  const oldText = (i) => oldTuples[i - 1][2];
  const newText = (j) => newTuples[j - 1][2];

  const rels = review.matches.map(([from, to, note]) => ({
    olds: taskRefs(from),
    news: taskRefs(to),
    note,
  }));
  const relOfOld = new Map();
  const relOfNew = new Map();
  const invalid = (reason) => {
    throw new Error(`Invalid hand review for ${fromLabel}: ${reason}`);
  };
  for (const rel of rels) {
    if (!rel.olds.length || !rel.news.length)
      invalid("a relationship must name tasks on both sides");
    rel.multi = rel.olds.length > 1 || rel.news.length > 1;
    for (const i of rel.olds) {
      if (relOfOld.has(i)) invalid(`old task ${i} occurs more than once`);
      relOfOld.set(i, rel);
    }
    for (const j of rel.news) {
      if (relOfNew.has(j)) invalid(`new task ${j} occurs more than once`);
      relOfNew.set(j, rel);
    }
  }
  const accounted = (count, related, unpaired) => {
    const all = [...related.keys(), ...unpaired];
    return (
      all.length === count &&
      new Set(all).size === count &&
      all.every((n) => Number.isInteger(n) && n >= 1 && n <= count)
    );
  };
  if (
    !accounted(oldTuples.length, relOfOld, review.removed) ||
    !accounted(newTuples.length, relOfNew, review.added)
  )
    invalid("every task must be accounted for exactly once");

  const oldsIn = new Map();
  const newsIn = new Map();
  oldAt.forEach((p, k) => {
    if (!oldsIn.has(p.group)) oldsIn.set(p.group, []);
    oldsIn.get(p.group).push(k + 1);
  });
  newAt.forEach((p, k) => {
    if (!newsIn.has(p.group)) newsIn.set(p.group, []);
    newsIn.get(p.group).push(k + 1);
  });

  const placeFor = (p, side, here) => ({
    side,
    domain: p.domain,
    group: p.group,
    near: p.domain === here.domain,
  });
  // Every place a relationship's new skills are, once: by group in the same domain, else by domain.
  const targets = (rel, here) => {
    const seen = new Set();
    return rel.news
      .map((j) => placeFor(newAt[j - 1], "new", here))
      .filter((p) => {
        const key = p.near ? p.group : p.domain;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  const shape = (rel) => ({ n: rel.olds.length, m: rel.news.length });

  for (const domain of domains)
    for (const group of domain.groups) {
      const here = { domain, group };
      const olds = oldsIn.get(group) ?? [];
      const standalone = (i) => {
        const rel = relOfOld.get(i);
        return !rel || !rel.news.some((j) => newAt[j - 1].group === group);
      };
      const oldItem = (i) => {
        const rel = relOfOld.get(i);
        if (!rel) return { review: true, kind: "removed", old: oldText(i) };
        return {
          review: true,
          kind: rel.multi ? "merged-out" : "moved-out",
          old: oldText(i),
          to: targets(rel, here),
          rel: shape(rel),
        };
      };
      const emitted = new Set();
      const flush = (upTo) => {
        for (const i of olds)
          if (i < upTo && !emitted.has(i) && standalone(i)) {
            group.items.push(oldItem(i));
            emitted.add(i);
          }
      };
      let previous = null;
      for (const j of newsIn.get(group) ?? []) {
        const rel = relOfNew.get(j);
        if (!rel) {
          group.items.push({ review: true, kind: "added", new: newText(j) });
          previous = null;
          continue;
        }
        const local = rel.olds.filter((i) => oldAt[i - 1].group === group);
        if (local.length) flush(Math.min(...local));
        if (rel.multi) {
          const lead = previous !== rel;
          group.items.push({
            review: true,
            kind: "merged",
            new: newText(j),
            rel: shape(rel),
            of: fromLabel,
            lead,
            ...(lead
              ? {
                  olds: rel.olds.map((i) => ({
                    text: oldText(i),
                    from:
                      oldAt[i - 1].group === group
                        ? null
                        : placeFor(oldAt[i - 1], "old", here),
                  })),
                  note: rel.note,
                }
              : {}),
          });
        } else {
          const i = rel.olds[0];
          const inPlace = oldAt[i - 1].group === group;
          group.items.push({
            review: true,
            kind: inPlace
              ? norm(oldText(i)) === norm(newText(j))
                ? "same"
                : "reworded"
              : "moved-in",
            old: oldText(i),
            new: newText(j),
            ...(inPlace ? {} : { from: placeFor(oldAt[i - 1], "old", here) }),
            ...(rel.note ? { note: rel.note } : {}),
          });
        }
        previous = rel;
      }
      flush(Infinity);
      group.counts = {
        old: olds.length,
        new: (newsIn.get(group) ?? []).length,
      };
    }

  const stats = {
    added: review.added.length,
    removed: review.removed.length,
    same: 0,
    reworded: 0,
    moved: 0,
    covered: 0,
    mergedOld: 0,
    mergedNew: 0,
    weightsChanged: diff.stats.weightsChanged,
    totalNow: newTuples.length,
    totalBefore: oldTuples.length,
  };
  let inPlace = 0;
  for (const rel of rels) {
    if (rel.multi) {
      stats.mergedOld += rel.olds.length;
      stats.mergedNew += rel.news.length;
      continue;
    }
    // Same or reworded wherever it is now; `moved` counts those of them in another group as well.
    const [i] = rel.olds;
    const [j] = rel.news;
    const moved = oldAt[i - 1].group !== newAt[j - 1].group;
    if (moved) stats.moved++;
    if (norm(oldText(i)) === norm(newText(j))) {
      stats.same++;
      if (!moved) inPlace++;
    } else stats.reworded++;
  }
  stats.changedShare = stats.totalNow
    ? (stats.totalNow - inPlace) / stats.totalNow
    : 0;
  return {
    ...diff,
    domains,
    stats,
    reviewed: { date: review.reviewed, from: fromLabel },
  };
}
