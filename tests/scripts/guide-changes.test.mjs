// src/utils/guide-changes/{diff,state,render}.mjs: how two versions of a study guide are compared,
// what state a history is in on a given day, and the pages built from it (docs/study-guide-changes.md).
// Offline; the guides are the small fixtures of tests/fixtures/study-guide-changes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyHistory,
  recordVersion,
} from "../../scripts/lib/guide-history.mjs";
import {
  REWORD_THRESHOLD,
  align,
  changeKind,
  diffVersions,
  similarity,
} from "../../src/utils/guide-changes/diff.mjs";
import {
  buildChangePage,
  wordDiff,
} from "../../src/utils/guide-changes/render.mjs";
import {
  daysBetween,
  dayBefore,
  prettyDate,
  shortLabels,
  summarise,
  versionState,
} from "../../src/utils/guide-changes/state.mjs";
import {
  domains,
  guide,
  withPriorSection,
} from "../fixtures/study-guide-changes/guides.mjs";

const kindOf = (a, b) => changeKind(diffVersions(a, b));
const at = (iso) => new Date(`${iso}T12:00:00Z`);

/** A history of the given `[asOf, domains, firstSeen]` versions, recorded in order. */
function historyOf(...versions) {
  let history = emptyHistory("DP-700");
  for (const [asOf, doms, seen, audience] of versions)
    history = recordVersion(
      history,
      guide({ asOf, domains: doms, audience }),
      seen,
    ).history;
  return history;
}

const REWEIGHED = () =>
  domains((d) => {
    d[0].min = 25;
    d[0].max = 30;
    d[1].min = 35;
    d[1].max = 40;
  });
const TOPICS = () =>
  domains((d) => {
    d[0].groups[0].tasks[0] = "Configure Spark and Python workspace settings";
    d[1].groups[0].tasks.push(
      "Handle duplicate, missing, and late-arriving data",
    );
    d[2].groups[0].tasks.shift();
  });
const REWRITTEN = () =>
  domains((d) => {
    d[0].groups[0].tasks = [
      "Plan agent governance",
      "Define data products",
      "Review capacity",
    ];
    d[0].groups[1].tasks = [
      "Build semantic links",
      "Publish lineage",
      "Audit sharing",
    ];
    d[1].groups[0].tasks = [
      "Stream telemetry",
      "Window events",
      "Join reference data",
    ];
  });

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test("a reworded skill is paired with its old wording, an unrelated one is not", () => {
  assert.ok(
    similarity(
      "Configure Spark workspace settings",
      "Configure Spark and Python workspace settings",
    ) >= REWORD_THRESHOLD,
  );
  assert.ok(
    similarity("Monitor data ingestion", "Design a streaming loading pattern") <
      REWORD_THRESHOLD,
  );
  assert.ok(
    similarity("Create databases", "Create database") > 0.9,
    "a plural is the same word",
  );

  const entries = align(
    ["Configure Spark workspace settings", "Monitor data ingestion"],
    [
      "Configure Spark and Python workspace settings",
      "Design a streaming loading pattern",
    ],
  );
  const pairs = entries.map((e) => [e.old ?? null, e.new ?? null]);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs[0], [
    "Configure Spark workspace settings",
    "Configure Spark and Python workspace settings",
  ]);
  assert.ok(
    pairs.some((p) => p[0] === "Monitor data ingestion" && p[1] === null),
    "the old one is removed",
  );
  assert.ok(
    pairs.some(
      (p) => p[0] === null && p[1] === "Design a streaming loading pattern",
    ),
    "the new one is added",
  );
});

test("the kind of change: none, weights, topics, rewritten", () => {
  const base = guide({ asOf: "2026-10-01", domains: domains() });
  assert.equal(
    kindOf(base, guide({ asOf: "2026-11-16", domains: domains() })),
    "none",
    "only the date differs",
  );
  assert.equal(
    kindOf(base, guide({ asOf: "2026-11-16", domains: REWEIGHED() })),
    "weights",
  );
  assert.equal(
    kindOf(base, guide({ asOf: "2026-11-16", domains: TOPICS() })),
    "topics",
  );
  assert.equal(
    kindOf(base, guide({ asOf: "2026-11-16", domains: REWRITTEN() })),
    "rewritten",
  );
});

test("a changed audience profile alone is a topics change", () => {
  const base = guide({ asOf: "2026-10-01", domains: domains() });
  const audience = [
    "### Audience profile",
    "As a candidate for this exam, you build, secure and run data solutions on Azure.",
    "Your competencies include:",
    "- Designing data pipelines.",
    "- Monitoring and tuning workloads.",
    "- Governing data products.",
  ];
  const diff = diffVersions(
    base,
    guide({ asOf: "2026-11-16", domains: domains(), audience }),
  );
  assert.equal(diff.audience.changed, true);
  assert.equal(changeKind(diff), "topics");
  assert.equal(diff.stats.added + diff.stats.removed + diff.stats.reworded, 0);
});

test("the counts of a topics change", () => {
  const diff = diffVersions(
    guide({ asOf: "2026-10-01", domains: domains() }),
    guide({ asOf: "2026-11-16", domains: TOPICS() }),
  );
  assert.equal(diff.ok, true);
  assert.deepEqual(
    [
      diff.stats.added,
      diff.stats.removed,
      diff.stats.reworded,
      diff.stats.weightsChanged,
    ],
    [1, 1, 1, false],
  );
  assert.equal(diff.stats.totalBefore, 12);
  assert.equal(diff.stats.totalNow, 12);
});

test("a domain that appears or disappears is matched by title and listed as added or removed", () => {
  const diff = diffVersions(
    guide({ asOf: "2026-10-01", domains: domains() }),
    guide({
      asOf: "2026-11-16",
      domains: domains((d) => {
        d.pop();
        d.push({
          title: "Govern data",
          min: 30,
          max: 35,
          groups: [{ title: "Apply policies", tasks: ["Label items"] }],
        });
      }),
    }),
  );
  assert.deepEqual(
    diff.domains.map((d) => [d.status, d.title]),
    [
      ["same", "Implement and manage an analytics solution"],
      ["same", "Ingest and transform data"],
      ["added", "Govern data"],
      ["removed", "Monitor and optimize an analytics solution"],
    ],
    "a removed domain comes last",
  );
});

test("a guide that cannot be read falls back to a line comparison", () => {
  const diff = diffVersions(
    ["## Skills measured as of October 1, 2026", "Some prose", "More prose"],
    ["## Skills measured as of November 16, 2026", "Some prose", "Other prose"],
  );
  assert.equal(diff.ok, false);
  assert.equal(changeKind(diff), "unreadable");
  assert.equal(
    changeKind(
      diffVersions(
        ["## Skills measured", "Some prose"],
        ["## Skills measured as of May 1, 2026", "Some prose"],
      ),
    ),
    "none",
    "a new date over the same prose is no change",
  );
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

test("small date helpers", () => {
  assert.equal(prettyDate("2026-03-02"), "March 2, 2026");
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
  assert.equal(daysBetween("2026-10-01", "2026-10-31"), 30);
  assert.deepEqual(
    shortLabels([
      "Plan AI solutions",
      "Design AI solutions",
      "Deploy AI solutions",
    ]),
    ["Plan", "Design", "Deploy"],
  );
  assert.deepEqual(shortLabels(["Plan A", "Plan B"]), ["Plan A", "Plan B"]);
});

test("the summary of each kind says what changed, and nothing for no change", () => {
  const stateOf = (doms) => {
    const diff = diffVersions(
      guide({ asOf: "2026-10-01", domains: domains() }),
      guide({ asOf: "2026-11-16", domains: doms }),
    );
    return summarise(diff, changeKind(diff));
  };
  assert.equal(
    stateOf(REWEIGHED()),
    "Domain weights change: Implement −5, Ingest +5 points.",
  );
  assert.equal(stateOf(TOPICS()), "1 skill added, 1 removed and 1 reworded.");
  assert.match(
    stateOf(REWRITTEN()),
    /^Largely rewritten: \d+ of 12 skills are new or reworded\.$/,
  );
  assert.equal(stateOf(domains()), "");
});

test("a version dated ahead is upcoming; the one before it is current", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  const state = versionState(history, at("2026-11-10"));
  assert.equal(state.upcoming.n, 2);
  assert.equal(state.current.n, 1);
  assert.equal(state.pair.from, state.current);
  assert.equal(state.pair.to, state.upcoming);
  assert.equal(state.kind, "weights");
  assert.deepEqual(state.change.effective, {
    date: "2026-11-16",
    basis: "effective",
  });
  assert.deepEqual(
    {
      kind: state.banner.kind,
      days: state.banner.days,
      effective: state.banner.effective,
    },
    { kind: "upcoming", days: 6, effective: "2026-11-16" },
  );
});

test("once the date has come the new version is current, the old one previous", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  const state = versionState(history, at("2026-11-20"));
  assert.equal(state.upcoming, null);
  assert.equal(state.current.n, 2);
  assert.equal(state.previous.n, 1);
  assert.equal(state.previousSource, "recorded");
  assert.deepEqual(
    { kind: state.banner.kind, daysAgo: state.banner.daysAgo },
    { kind: "recent", daysAgo: 4 },
  );
});

test("the banner lasts 30 days from the day the change took effect, then stops; the change page stays", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  assert.ok(
    versionState(history, at("2026-12-15")).banner,
    "day 29 is the last day shown",
  );
  assert.equal(versionState(history, at("2026-12-16")).banner, null);
  assert.equal(versionState(history, at("2026-12-16")).kind, "weights");
});

test("a change that moves nothing but the date shows no banner", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", domains(), "2026-10-22"],
  );
  const state = versionState(history, at("2026-11-10"));
  assert.equal(state.kind, "none");
  assert.equal(state.banner, null);
});

test("an undated version takes the day we first saw it", () => {
  const history = historyOf(
    [null, domains(), "2026-10-01"],
    [null, TOPICS(), "2026-11-02"],
  );
  const state = versionState(history, at("2026-11-10"));
  assert.deepEqual(state.change.effective, {
    date: "2026-11-02",
    basis: "seen",
  });
  assert.deepEqual(
    {
      kind: state.banner.kind,
      daysAgo: state.banner.daysAgo,
      basis: state.banner.basis,
    },
    {
      kind: "recent",
      daysAgo: 8,
      basis: "seen",
    },
  );
});

test("a date earlier than the one it replaced is still the current version, with a note", () => {
  const history = historyOf(
    ["2026-10-19", domains(), "2026-10-20"],
    ["2026-03-11", TOPICS(), "2026-10-29"],
  );
  const state = versionState(history, at("2026-11-10"));
  assert.equal(state.current.n, 2);
  assert.equal(state.change.regressed, true);
  assert.deepEqual(state.change.effective, {
    date: "2026-10-29",
    basis: "seen",
  });
  assert.match(state.banner.dateNote, /earlier than the one it replaced/);
});

test("Microsoft's own 'prior to' section is the previous version only when none was recorded", () => {
  const live = guide({ asOf: "2025-01-10", domains: TOPICS() });
  const history = recordVersion(
    emptyHistory("AZ-104"),
    withPriorSection(live, { asOf: "2025-01-10", domains: domains() }),
    "2026-11-02",
  ).history;
  const state = versionState(history, at("2026-11-10"));
  assert.equal(state.previousSource, "onPage");
  assert.equal(state.kind, "topics");
  assert.equal(state.change.effective.date, "2025-01-10");
  assert.equal(state.banner, null, "a change that old has no banner");
});

test("one version and no history give no change", () => {
  const one = versionState(
    historyOf(["2026-10-14", domains(), "2026-10-15"]),
    at("2026-11-10"),
  );
  assert.equal(one.current.n, 1);
  assert.equal(one.pair, null);
  assert.equal(one.kind, "none");
  assert.equal(one.banner, null);
  const none = versionState(emptyHistory("GH-900"), at("2026-11-10"));
  assert.equal(none.current, null);
  assert.equal(none.banner, null);
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const labels = (page) => page.tabs.map((tab) => tab.label);
const tab = (page, label) => page.tabs.find((t) => t.label === label);
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** The text of a tab as a visitor reads it: the note above it, then the body. */
const words = (t) => plain(`${t.note ?? ""} ${t.html}`);

test("a word diff marks only the words that changed", () => {
  const html = wordDiff(
    "Configure Spark workspace settings",
    "Configure Spark and Python workspace settings",
  );
  assert.match(html, /<ins [^>]*>and Python<\/ins>/);
  assert.doesNotMatch(html, /<del/);
  assert.equal(wordDiff("same words", "same words"), "same words");
  assert.match(wordDiff("a <b> c", "a <b> d"), /&lt;b&gt;/, "text is escaped");
});

test("an exam whose guide has not been recorded says so, on a Changes tab alone", () => {
  const page = buildChangePage(emptyHistory("GH-900"), {
    now: at("2026-11-10"),
  });
  assert.deepEqual(labels(page), ["Changes"]);
  assert.match(
    words(tab(page, "Changes")),
    /We have not recorded this study guide yet/,
  );
  assert.match(page.title, /GH-900/);
});

test("one recorded version: Changes first and default, saying nothing has changed, then Current and History", () => {
  const page = buildChangePage(
    historyOf(["2026-10-14", domains(), "2026-10-15"]),
    { now: at("2026-11-10") },
  );
  assert.deepEqual(labels(page), ["Changes", "Current", "History"]);
  assert.match(words(tab(page, "Changes")), /No changes recorded/);
});

test("an upcoming change adds an Upcoming tab and a Previous tab appears with the second version", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  const upcoming = buildChangePage(history, { now: at("2026-11-10") });
  assert.deepEqual(labels(upcoming), [
    "Changes",
    "Current",
    "Upcoming",
    "History",
  ]);
  const after = buildChangePage(history, { now: at("2026-11-20") });
  assert.deepEqual(labels(after), [
    "Changes",
    "Current",
    "Previous",
    "History",
  ]);
});

test("weights: a table of the three columns and a line saying no skills changed", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  const html = tab(
    buildChangePage(history, { now: at("2026-11-10") }),
    "Changes",
  ).html;
  assert.match(html, /<table/);
  assert.match(plain(html), /No skills were added, removed or reworded/);
  assert.match(plain(html), /What this means for you/);
  assert.match(plain(html), /30–35%/);
  assert.match(plain(html), /25–30%/);
  assert.doesNotMatch(html, /<ins/, "a weights change shows no skill edits");
});

test("topics: additions underlined, removals struck, the reworded skill as a word diff", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", TOPICS(), "2026-10-22"],
  );
  const html = tab(
    buildChangePage(history, { now: at("2026-11-20") }),
    "Changes",
  ).html;
  assert.match(
    html,
    /<ins [^>]*>Handle duplicate, missing, and late-arriving data<\/ins>/,
  );
  assert.match(html, /<del [^>]*>Monitor data ingestion<\/del>/);
  assert.match(html, /<ins [^>]*>and Python<\/ins>/);
  assert.match(html, /decoration-1 underline-offset-2/);
  assert.match(html, /line-through/);
});

test("rewritten: says so, counts, and puts every change behind a closed dropdown", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWRITTEN(), "2026-10-22"],
  );
  const html = tab(
    buildChangePage(history, { now: at("2026-11-20") }),
    "Changes",
  ).html;
  assert.match(plain(html), /largely rewritten/i);
  assert.match(plain(html), /Show every change/);
  assert.doesNotMatch(html, /<details[^>]* open[ >][^<]*Show every change/);
});

test("History lists the first sight, the new version, and a correction", () => {
  let history = historyOf(["2026-10-14", domains(), "2026-10-15"]);
  history = recordVersion(
    history,
    guide({
      asOf: "2026-10-14",
      domains: domains((d) => d[0].groups[0].tasks.pop()),
    }),
    "2026-10-16",
  ).history;
  history = recordVersion(
    history,
    guide({ asOf: "2026-11-16", domains: REWEIGHED() }),
    "2026-10-22",
  ).history;
  const text = plain(
    tab(buildChangePage(history, { now: at("2026-11-20") }), "History").html,
  );
  assert.match(text, /October 15, 2026/);
  assert.match(text, /October 22, 2026/);
  assert.match(
    text,
    /corrected, the guide's date \(October 14, 2026\) stayed the same/,
  );
});

test("no page carries a day count: it is worked out in the visitor's browser", () => {
  const history = historyOf(
    ["2026-10-14", domains(), "2026-10-15"],
    ["2026-11-16", REWEIGHED(), "2026-10-22"],
  );
  const page = buildChangePage(history, { now: at("2026-11-10") });
  const everything = page.tabs
    .map((t) => `${t.note ?? ""} ${plain(t.html)}`)
    .join(" ");
  assert.doesNotMatch(everything, /\bin \d+ days?\b|\b\d+ days? ago\b/);
});
