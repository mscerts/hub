// src/utils/guide-changes/compare-areas.mjs against the guides it was written from: every title it names exists,
// and every area of both guides is covered by an entry. A guide that Microsoft changes later (a new domain, a
// renamed one) fails this test: that is the signal to look at the areas of that pair again
// (docs/study-guide-changes.md). Reads the real history files.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGuide } from "../../scripts/lib/course-guide.mjs";
import { readHistory } from "../../scripts/lib/guide-history.mjs";
import { comparisonPairs } from "../../src/utils/guide-changes/compare.mjs";
import { areasByTarget } from "../../src/utils/guide-changes/compare-areas.mjs";
import { groupAreasByTarget } from "../../src/utils/guide-changes/compare-groups.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "src/data_files/study-guide-history");
const latest = (code) => readHistory(dir, code).versions.at(-1);
const domainTitles = (code) =>
  parseGuide(latest(code).lines).domains.map((d) => d.title);

test("every comparison pair has its guides recorded, and the areas of a pair name only domains that exist", () => {
  for (const pair of comparisonPairs) {
    const areas = areasByTarget[pair.to];
    for (const code of [...pair.from, pair.to])
      assert.ok(latest(code), `${code}: no recorded guide`);
    if (!areas) continue;
    const olds = new Set(pair.from.flatMap(domainTitles));
    const news = new Set(domainTitles(pair.to));
    for (const area of areas) {
      assert.ok(area.note.length > 20, `${pair.to}: an area has no note`);
      assert.ok(
        area.from.length + area.to.length > 0,
        `${pair.to}: an empty area`,
      );
      for (const title of area.from)
        assert.ok(olds.has(title), `${pair.to}: "${title}" is no old domain`);
      for (const title of area.to)
        assert.ok(news.has(title), `${pair.to}: "${title}" is no new domain`);
    }
  }
});

test("every domain of both guides of a pair is in at least one area", () => {
  for (const pair of comparisonPairs) {
    const areas = areasByTarget[pair.to];
    if (!areas) continue;
    const inFrom = new Set(areas.flatMap((a) => a.from));
    const inTo = new Set(areas.flatMap((a) => a.to));
    for (const title of pair.from.flatMap(domainTitles))
      assert.ok(
        inFrom.has(title),
        `${pair.to}: old domain "${title}" is in no area`,
      );
    for (const title of domainTitles(pair.to))
      assert.ok(
        inTo.has(title),
        `${pair.to}: new domain "${title}" is in no area`,
      );
  }
});

test("a pair without hand-made areas has domains that match by title alone", () => {
  for (const pair of comparisonPairs) {
    if (areasByTarget[pair.to]) continue;
    assert.deepEqual(
      domainTitles(pair.from[0]),
      domainTitles(pair.to),
      `${pair.to} has no areas: its domains must be the same as ${pair.from[0]}'s`,
    );
  }
});

test("the areas name no pair that is not compared", () => {
  const targets = new Set(comparisonPairs.map((p) => p.to));
  for (const code of Object.keys(areasByTarget))
    assert.ok(targets.has(code), `${code} has areas but is in no pair`);
});

const groupTitles = (code) =>
  parseGuide(latest(code).lines).domains.flatMap((d) =>
    d.groups.map((g) => g.title),
  );

test("the group pairings name only groups that exist, once each, and group titles are unique in a guide", () => {
  for (const pair of comparisonPairs) {
    const groups = groupAreasByTarget[pair.to];
    if (!groups) continue;
    const olds = pair.from.flatMap(groupTitles);
    const news = groupTitles(pair.to);
    assert.equal(
      new Set(olds).size,
      olds.length,
      `${pair.to}: old group titles repeat`,
    );
    assert.equal(
      new Set(news).size,
      news.length,
      `${pair.to}: new group titles repeat`,
    );
    const seenFrom = new Set();
    const seenTo = new Set();
    for (const entry of groups) {
      assert.equal(
        typeof entry.note,
        "string",
        `${pair.to}: a group entry has no note`,
      );
      assert.ok(entry.from.length + entry.to.length > 0);
      for (const title of entry.from) {
        assert.ok(
          olds.includes(title),
          `${pair.to}: "${title}" is no old group`,
        );
        assert.ok(
          !seenFrom.has(title),
          `${pair.to}: old group "${title}" is listed twice`,
        );
        seenFrom.add(title);
      }
      for (const title of entry.to) {
        assert.ok(
          news.includes(title),
          `${pair.to}: "${title}" is no new group`,
        );
        seenTo.add(title);
      }
      if (entry.broader)
        assert.ok(
          entry.from.length && entry.to.length,
          `${pair.to}: a broader entry needs both sides`,
        );
    }
  }
});

test("a pair with group pairings lists every new group at least once", () => {
  for (const pair of comparisonPairs) {
    const groups = groupAreasByTarget[pair.to];
    if (!groups) continue;
    const listed = new Set(groups.flatMap((g) => g.to));
    for (const title of groupTitles(pair.to))
      assert.ok(
        listed.has(title),
        `${pair.to}: new group "${title}" is in no group entry`,
      );
  }
});
