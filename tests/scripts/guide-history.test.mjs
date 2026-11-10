// scripts/lib/guide-history.mjs, scripts/study-guide-history-backfill.mjs: the version rules and the
// files of the study guide history (docs/study-guide-changes.md). Offline; the guides are the small
// fixtures of tests/fixtures/study-guide-changes.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  asOfOfHeading,
  emptyHistory,
  historyFileName,
  readAllHistories,
  readHistory,
  recordGuides,
  recordVersion,
  serializeHistory,
  skillsSections,
  validateHistory,
  writeHistory,
} from "../../scripts/lib/guide-history.mjs";
import { replayCommits } from "../../scripts/study-guide-history-backfill.mjs";
import {
  domains,
  guide,
  withPriorSection,
} from "../fixtures/study-guide-changes/guides.mjs";

const record = (history, lines, today) => recordVersion(history, lines, today);
const start = (lines, today = "2026-10-01") =>
  record(emptyHistory("DP-700"), lines, today);

test("a heading's date is read as a day, and a heading without one has none", () => {
  assert.equal(
    asOfOfHeading("## Skills measured as of October 14, 2026"),
    "2026-10-14",
  );
  assert.equal(
    asOfOfHeading("## Skills measured as of March 2, 2026"),
    "2026-03-02",
  );
  assert.equal(asOfOfHeading("## Skills measured"), null);
  // "prior to <date>" is not an "as of" date: a prior section has none of its own.
  assert.equal(asOfOfHeading("## Skills measured prior to May 1, 2026"), null);
  assert.equal(
    asOfOfHeading("## Skills measured as of February 31, 2026"),
    null,
  );
});

test("the first section is the live version and Microsoft's own 'prior to' section follows it", () => {
  const lines = withPriorSection(
    guide({ asOf: "2026-11-16", domains: domains() }),
    { asOf: "2026-11-16", domains: domains() },
  );
  const sections = skillsSections(lines);
  assert.equal(sections.length, 2);
  assert.match(sections[0].heading, /as of November 16, 2026/);
  assert.match(sections[1].heading, /prior to November 16, 2026/);
  assert.deepEqual(skillsSections(["## Updates", "- x"]), []);
});

test("the first sight of a guide is version 1, seen that day", () => {
  const lines = guide({ asOf: "2026-10-14", domains: domains() });
  const { history, event } = start(lines, "2026-10-15");
  assert.deepEqual(event, { kind: "first", n: 1 });
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0].asOf, "2026-10-14");
  assert.equal(history.versions[0].firstSeen, "2026-10-15");
  assert.deepEqual(history.versions[0].lines, lines);
});

test("the same text again changes nothing, and the input is never modified", () => {
  const lines = guide({ asOf: "2026-10-14", domains: domains() });
  const first = start(lines).history;
  const frozen = structuredClone(first);
  const again = record(first, lines, "2026-10-20");
  assert.equal(again.event, null);
  assert.equal(again.history, first);
  assert.deepEqual(first, frozen);
  const changed = record(
    first,
    guide({ asOf: "2026-11-16", domains: domains() }),
    "2026-10-22",
  );
  assert.deepEqual(
    first,
    frozen,
    "recording a new version leaves the old history alone",
  );
  assert.equal(changed.history.versions.length, 2);
});

test("a page without a skills section is not recorded", () => {
  const { history, event } = record(
    emptyHistory("AZ-900"),
    ["## Updates to the exam", "- x"],
    "2026-10-01",
  );
  assert.equal(event, null);
  assert.deepEqual(history.versions, []);
});

test("a different date is a new version, also when only the date changed", () => {
  const v1 = start(guide({ asOf: "2026-10-14", domains: domains() })).history;
  const v2 = record(
    v1,
    guide({ asOf: "2026-11-16", domains: domains() }),
    "2026-10-22",
  );
  assert.deepEqual(v2.event, { kind: "new", n: 2 });
  assert.equal(v2.history.versions[1].asOf, "2026-11-16");
  assert.equal(v2.history.versions[1].firstSeen, "2026-10-22");
  assert.deepEqual(
    v2.history.versions[0],
    v1.versions[0],
    "version 1 is kept as it was",
  );
});

test("an earlier date is still a new version: the page wins", () => {
  const v1 = start(guide({ asOf: "2026-10-19", domains: domains() })).history;
  const v2 = record(
    v1,
    guide({
      asOf: "2026-03-11",
      domains: domains((d) => d[0].groups[0].tasks.pop()),
    }),
    "2026-10-29",
  );
  assert.deepEqual(v2.event, { kind: "new", n: 2 });
  assert.equal(v2.history.versions[1].asOf, "2026-03-11");
});

test("the same date with other text is a correction made in place, and the old lines are kept", () => {
  const before = guide({ asOf: "2026-10-14", domains: domains() });
  const v1 = start(before, "2026-10-15").history;
  const after = guide({
    asOf: "2026-10-14",
    domains: domains(
      (d) =>
        (d[1].groups[0].tasks[0] = "Design and implement loading patterns"),
    ),
  });
  const fixed = record(v1, after, "2026-10-18");
  assert.deepEqual(fixed.event, { kind: "corrected", n: 1 });
  assert.equal(fixed.history.versions.length, 1);
  assert.deepEqual(fixed.history.versions[0].lines, after);
  assert.deepEqual(fixed.history.versions[0].corrections, [
    { day: "2026-10-18", before },
  ]);
  assert.equal(
    fixed.history.versions[0].firstSeen,
    "2026-10-15",
    "the version keeps the day it was first seen",
  );
});

test("an undated guide has no 'same date': every text change is a new version", () => {
  const v1 = start(guide({ domains: domains() })).history;
  const v2 = record(
    v1,
    guide({ domains: domains((d) => d[2].groups[0].tasks.pop()) }),
    "2026-11-02",
  );
  assert.deepEqual(v2.event, { kind: "new", n: 2 });
  assert.equal(v2.history.versions[1].asOf, null);
});

test("Microsoft's 'prior to' section is kept with the version that carried it", () => {
  const prior = { asOf: "2026-11-16", domains: domains() };
  const live = guide({
    asOf: "2026-11-16",
    domains: domains((d) => d[0].groups[0].tasks.pop()),
  });
  const { history } = start(withPriorSection(live, prior));
  const [version] = history.versions;
  assert.equal(version.priorOnPage.asOf, null);
  assert.match(version.priorOnPage.lines[0], /^## Skills measured prior to/);
  assert.deepEqual(
    version.lines,
    live,
    "the live lines are the first section only",
  );
});

test("files: one row per line, written and read back unchanged, listed by exam code", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-history-"));
  try {
    const v1 = start(guide({ asOf: "2026-10-14", domains: domains() })).history;
    const { history } = record(
      v1,
      guide({
        asOf: "2026-10-14",
        domains: domains((d) => d[0].groups[0].tasks.pop()),
      }),
      "2026-10-16",
    );
    const text = serializeHistory(history);
    assert.ok(text.endsWith("}\n"));
    assert.deepEqual(JSON.parse(text), history);
    assert.ok(
      text
        .split("\n")
        .some(
          (row) =>
            row.trim() === '"## Skills measured as of October 14, 2026",',
        ),
      "every line of a guide is a row of its own, so a git diff reads",
    );
    writeHistory(dir, history);
    writeHistory(dir, { ...emptyHistory("AB-100"), versions: [] });
    assert.deepEqual(readHistory(dir, "DP-700"), history);
    assert.deepEqual(
      readHistory(dir, "NOPE-1"),
      emptyHistory("NOPE-1"),
      "no file is an empty history",
    );
    assert.deepEqual(
      readdirSync(dir).sort(),
      ["AB-100.json", "DP-700.json"],
      "no temporary file is left",
    );
    assert.deepEqual(
      readAllHistories(dir).map((h) => h.code),
      ["AB-100", "DP-700"],
    );
    assert.equal(historyFileName("DP-700"), "DP-700.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt file is refused with the reason", () => {
  const good = start(guide({ asOf: "2026-10-14", domains: domains() })).history;
  assert.doesNotThrow(() => validateHistory(good));
  const bad = (edit) => {
    const copy = structuredClone(good);
    edit(copy);
    return copy;
  };
  assert.throws(
    () => validateHistory(bad((h) => (h.schemaVersion = 9))),
    /schemaVersion/,
  );
  assert.throws(() => validateHistory(bad((h) => (h.code = "dp700"))), /code/);
  assert.throws(
    () => validateHistory(bad((h) => (h.versions[0].n = 3))),
    /n 3/,
  );
  assert.throws(
    () => validateHistory(bad((h) => (h.versions[0].asOf = "October"))),
    /asOf/,
  );
  assert.throws(
    () => validateHistory(bad((h) => (h.versions[0].firstSeen = "yesterday"))),
    /firstSeen/,
  );
  assert.throws(
    () => validateHistory(bad((h) => (h.versions[0].lines = ["- x"]))),
    /Skills measured heading/,
  );
});

test("recordGuides writes only the exams that changed and ignores unusable records", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-history-"));
  try {
    const dp = guide({ asOf: "2026-10-14", domains: domains() });
    const ab = guide({ asOf: "2026-10-14", domains: domains((d) => d.pop()) });
    const guides = [
      { code: "DP-700", hash: "a", lines: dp },
      { code: "AB-100", hash: "b", lines: ab },
      { code: "AZ-104", hash: null, lines: dp }, // never read in full
      { code: "AZ-105", hash: "c" }, // no text stored
      { hash: "d", lines: dp },
    ];
    assert.deepEqual(recordGuides({ dir, guides, today: "2026-10-15" }), [
      { code: "DP-700", kind: "first", n: 1 },
      { code: "AB-100", kind: "first", n: 1 },
    ]);
    assert.deepEqual(readdirSync(dir).sort(), ["AB-100.json", "DP-700.json"]);

    const stamp = readFileSync(join(dir, "DP-700.json"), "utf8");
    assert.deepEqual(
      recordGuides({ dir, guides, today: "2026-10-16" }),
      [],
      "the same guides record nothing",
    );
    assert.equal(readFileSync(join(dir, "DP-700.json"), "utf8"), stamp);

    const next = [
      {
        code: "DP-700",
        hash: "e",
        lines: guide({ asOf: "2026-11-16", domains: domains() }),
      },
    ];
    assert.deepEqual(recordGuides({ dir, guides: next, today: "2026-10-22" }), [
      { code: "DP-700", kind: "new", n: 2 },
    ]);
    assert.equal(
      readHistory(dir, "DP-700").versions[1].firstSeen,
      "2026-10-22",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordGuides refuses to overwrite a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "guide-history-"));
  try {
    writeFileSync(
      join(dir, "DP-700.json"),
      '{"schemaVersion": 1, "code": "DP-700", "versions": 5}',
    );
    assert.throws(
      () =>
        recordGuides({
          dir,
          guides: [
            { code: "DP-700", hash: "a", lines: guide({ domains: domains() }) },
          ],
          today: "2026-10-01",
        }),
      /Corrupt study guide history/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replayCommits rebuilds the history from the commits of the tracker, oldest first", () => {
  const v1 = guide({ asOf: "2026-10-14", domains: domains() });
  const v2 = guide({
    asOf: "2026-11-16",
    domains: domains((d) => d[0].groups[0].tasks.pop()),
  });
  const tracker = (lines, hash) => ({
    studyGuides: [{ code: "AB-100", hash, lines }],
  });
  const { histories, events } = replayCommits([
    { day: "2026-10-15", tracker: tracker(v1, "a") },
    { day: "2026-10-16", tracker: tracker(v1, "a") },
    { day: "2026-10-22", tracker: tracker(v2, "b") },
    { day: "2026-10-23", tracker: {} },
  ]);
  assert.deepEqual(events, [
    { day: "2026-10-15", code: "AB-100", kind: "first", n: 1 },
    { day: "2026-10-22", code: "AB-100", kind: "new", n: 2 },
  ]);
  const history = histories.get("AB-100");
  assert.deepEqual(
    history.versions.map((v) => [v.n, v.asOf, v.firstSeen]),
    [
      [1, "2026-10-14", "2026-10-15"],
      [2, "2026-11-16", "2026-10-22"],
    ],
  );
});

// ---------------------------------------------------------------------------
// scripts/study-guide-history-retired.mjs
// ---------------------------------------------------------------------------

import { readFileSync as readFixture } from "node:fs";
import { historyOfPage } from "../../scripts/study-guide-history-retired.mjs";

const page = (name) =>
  readFixture(new URL(`../fixtures/new-exam/${name}`, import.meta.url), "utf8");

test("a retired exam's guide page becomes version 1 of a history, dated by its heading", () => {
  const { history, error } = historyOfPage(
    page("study-guide-az-801.html"),
    "AZ-801",
    "2026-11-10",
  );
  assert.equal(error, undefined);
  assert.equal(history.code, "AZ-801");
  assert.equal(history.versions.length, 1);
  const [version] = history.versions;
  assert.equal(version.firstSeen, "2026-11-10", "the day it was pulled");
  assert.match(version.lines[0], /^## Skills measured/);
  assert.doesNotThrow(() => validateHistory(history));
  assert.ok(
    version.lines.every((line) => !/^## (Notices|Updates)/.test(line)),
    "only the skills part is kept",
  );
});

test("a page that is not a readable study guide is an error, not a history", () => {
  assert.ok(
    historyOfPage(page("study-guide-no-skills.html"), "AZ-999", "2026-11-10")
      .error,
  );
  assert.ok(historyOfPage("<html></html>", "AZ-999", "2026-11-10").error);
});
