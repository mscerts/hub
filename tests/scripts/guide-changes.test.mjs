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
  MOVE_THRESHOLD,
  moveEdge,
  REWORD_THRESHOLD,
  align,
  changeKind,
  diffVersions,
  similarity,
  topicOverlap,
} from "../../src/utils/guide-changes/diff.mjs";
import {
  areaGraph,
  comparisonFor,
  comparisonInput,
  groupGraph,
  mergeGuides,
} from "../../src/utils/guide-changes/compare.mjs";
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

// ---------------------------------------------------------------------------
// Comparing the guide of an exam with the one of its replacement
// ---------------------------------------------------------------------------

const OLD_EXAM = () =>
  domains((d) => {
    d[2].title = "Develop a monitoring plan";
  });
const NEW_EXAM = () =>
  domains((d) => {
    d[2].title = "Design and implement a monitoring plan";
    d[2].groups[0].tasks.push("Monitor workloads by using AI agents");
  });

test("domains of two different exams are paired by similar title, and the old title is kept", () => {
  const prev = guide({ asOf: "2026-07-27", domains: OLD_EXAM() });
  const cur = guide({ asOf: null, domains: NEW_EXAM() });
  const exact = diffVersions(prev, cur);
  assert.deepEqual(
    exact.domains.map((d) => d.status),
    ["same", "same", "added", "removed"],
    "by exact title a renamed domain is one added and one removed",
  );
  const similar = diffVersions(prev, cur, { titleThreshold: 0.5 });
  assert.deepEqual(
    similar.domains.map((d) => d.status),
    ["same", "same", "same"],
  );
  assert.equal(similar.domains[2].oldTitle, "Develop a monitoring plan");
  assert.equal(
    similar.domains[2].title,
    "Design and implement a monitoring plan",
  );
  assert.equal(
    similar.domains[0].oldTitle,
    undefined,
    "an unchanged title has no old title",
  );
});

test("an exam and its replacement get a Compared to tab on both pages", () => {
  const from = {
    code: "AZ-400",
    history: historyOf(["2026-07-27", OLD_EXAM(), "2026-10-15"]),
  };
  const to = {
    code: "AZ-401",
    history: historyOf([null, NEW_EXAM(), "2026-10-15"]),
  };
  const compare = {
    from: [from],
    to,
    retirements: [{ code: "AZ-400", date: "2027-02-01" }],
  };
  for (const [history, other] of [
    [to.history, "AZ-400"],
    [from.history, "AZ-401"],
  ]) {
    const page = buildChangePage(history, { now: at("2026-11-10"), compare });
    assert.deepEqual(labels(page).slice(0, 2), [
      "Changes",
      `Compared to ${other}`,
    ]);
  }
  const page = buildChangePage(to.history, { now: at("2026-11-10"), compare });
  const text = words(tab(page, "Compared to AZ-400"));
  assert.match(text, /AZ-401 is the replacement for AZ-400\./);
  assert.match(text, /AZ-400 retires on February 1, 2027/);
  assert.match(text, /skills measured as of July 27, 2026/);
  assert.match(text, /1 skill is new/);
  assert.match(
    tab(page, "Compared to AZ-400").html,
    /<del [^>]*>Develop<\/del>/,
  );
  // The tab is optional: without a comparison, or when a guide is not recorded, there is none.
  assert.deepEqual(
    labels(buildChangePage(to.history, { now: at("2026-11-10") })),
    ["Changes", "Current", "History"],
  );
  assert.ok(
    !labels(
      buildChangePage(to.history, {
        now: at("2026-11-10"),
        compare: {
          from: [{ code: "AZ-400", history: emptyHistory("AZ-400") }],
          to,
        },
      }),
    ).includes("Compared to AZ-400"),
  );
});

test("two exams replaced by one: their guides are merged and each old domain says where it came from", () => {
  const one = guide({
    asOf: "2026-01-21",
    domains: [
      {
        title: "Deploy directory services",
        min: 50,
        max: 55,
        groups: [{ title: "Install", tasks: ["Install a domain controller"] }],
      },
      {
        title: "Manage storage",
        min: 45,
        max: 50,
        groups: [{ title: "Volumes", tasks: ["Create a volume"] }],
      },
    ],
  });
  const two = guide({
    asOf: "2025-10-06",
    domains: [
      {
        title: "Secure Windows Server",
        min: 100,
        max: 100,
        groups: [{ title: "Harden", tasks: ["Apply a baseline"] }],
      },
    ],
  });
  const merged = mergeGuides([
    { code: "AZ-800", lines: one },
    { code: "AZ-801", lines: two },
  ]);
  assert.equal(merged.lines[0], "## Skills measured");
  assert.deepEqual(
    [...merged.sources],
    [
      ["Deploy directory services", "AZ-800"],
      ["Manage storage", "AZ-800"],
      ["Secure Windows Server", "AZ-801"],
    ],
  );
  const tree = diffVersions(merged.lines, merged.lines);
  assert.equal(tree.ok, true);
  assert.equal(tree.stats.totalNow, 3);

  const replacement = guide({
    asOf: null,
    domains: [
      {
        title: "Deploy and manage directory services",
        min: 40,
        max: 45,
        groups: [{ title: "Install", tasks: ["Install a domain controller"] }],
      },
      {
        title: "Secure Windows Server infrastructure",
        min: 55,
        max: 60,
        groups: [{ title: "Harden", tasks: ["Apply a security baseline"] }],
      },
    ],
  });
  // A history of one version, built from the lines of a guide of our own.
  const hist = (lines) =>
    recordVersion(emptyHistory("X"), lines, "2026-10-15").history;
  const page = buildChangePage(hist(replacement), {
    now: at("2026-11-10"),
    compare: {
      from: [
        { code: "AZ-800", history: hist(one) },
        { code: "AZ-801", history: hist(two) },
      ],
      to: { code: "AZ-802", history: hist(replacement) },
      retirements: [
        { code: "AZ-800", date: "2026-09-30" },
        { code: "AZ-801", date: "2026-09-30" },
      ],
    },
  });
  assert.deepEqual(labels(page).slice(0, 2), [
    "Changes",
    "Compared to AZ-800 + AZ-801",
  ]);
  const text = words(tab(page, "Compared to AZ-800 + AZ-801"));
  assert.match(text, /AZ-802 is the replacement for AZ-800 and AZ-801./);
  assert.match(text, /AZ-800 and AZ-801 retired on September 30, 2026/);
  assert.match(text, /AZ-800: 50–55% · 1 skill /);
  assert.match(text, /AZ-801: 100% · 1 skill /);
});

test("the pairs: the replaced exams and the replacement share one comparison, and it needs every guide", () => {
  assert.equal(comparisonFor("AZ-400").to, "AZ-401");
  assert.equal(comparisonFor("AZ-401").from[0], "AZ-400");
  assert.deepEqual(comparisonFor("AZ-802").from, ["AZ-800", "AZ-801"]);
  assert.equal(comparisonFor("AZ-104"), undefined);
  const histories = {
    "AZ-400": historyOf(["2026-07-27", domains(), "2026-10-15"]),
    "AZ-401": historyOf([null, domains(), "2026-10-15"]),
  };
  const input = comparisonInput("AZ-401", (code) => histories[code], [
    { code: "AZ-400", retirementDate: "2027-02-01" },
    { code: "MS-102", retirementDate: "2026-11-30" },
  ]);
  assert.deepEqual(input.retirements, [{ code: "AZ-400", date: "2027-02-01" }]);
  assert.equal(input.from[0].history, histories["AZ-400"]);
  assert.equal(
    comparisonInput("AZ-401", (code) =>
      code === "AZ-401" ? histories[code] : undefined,
    ),
    null,
  );
  assert.equal(
    comparisonInput("AZ-104", () => histories["AZ-400"]),
    null,
  );
});

test("guides with the same skills, weights and audience say so instead of listing differences", () => {
  const same = historyOf(["2026-10-16", domains(), "2026-10-15"]);
  const page = buildChangePage(historyOf([null, domains(), "2026-10-16"]), {
    now: at("2026-11-10"),
    compare: {
      from: [{ code: "PL-400", history: same }],
      to: {
        code: "AB-400",
        history: historyOf([null, domains(), "2026-10-16"]),
      },
      blurb:
        "<strong>AB-400 is the new name of PL-400</strong>, the same certification.",
    },
  });
  const text = words(tab(page, "Compared to PL-400"));
  assert.match(text, /AB-400 is the new name of PL-400/);
  assert.match(text, /are the same in both guides/);
  assert.doesNotMatch(text, /Show every difference/);
});

// ---------------------------------------------------------------------------
// Several domains of one exam merged into one domain of the next
// ---------------------------------------------------------------------------

const MERGE_OLD = () =>
  guide({
    asOf: "2026-04-28",
    domains: [
      {
        title: "Manage identity",
        min: 30,
        max: 35,
        groups: [
          {
            title: "Authentication",
            tasks: [
              "Configure self-service password reset (SSPR)",
              "Implement Microsoft Entra Password Protection",
              "Plan Conditional Access policies",
            ],
          },
        ],
      },
      {
        title: "Manage threats",
        min: 30,
        max: 35,
        groups: [
          {
            title: "Email threats",
            tasks: [
              "Configure alert policies in Microsoft Defender for Office 365",
              "Manage attack simulations, including training campaigns",
            ],
          },
        ],
      },
      {
        title: "Manage compliance",
        min: 30,
        max: 35,
        groups: [
          {
            title: "Information protection",
            tasks: [
              "Implement sensitivity labels and sensitivity label policies",
              "Implement retention labels, retention label policies, and retention policies",
            ],
          },
        ],
      },
    ],
  });
const MERGE_NEW = () =>
  guide({
    asOf: null,
    domains: [
      {
        title: "Govern and secure tenants",
        min: 60,
        max: 65,
        groups: [
          {
            title: "Govern",
            tasks: [
              "Configure self-service password reset (SSPR)",
              "Implement and manage Microsoft Entra Password Protection",
              "Manage alerts in Microsoft Defender for Office 365",
              "Configure and manage attack simulations, including training campaigns",
              "Identify requirements for information protection, including sensitivity labels and sensitivity label policies",
              "Identify requirements for data lifecycle management, including retention labels, retention label policies, and retention policies",
              "Secure agent access by using Entra Agent ID",
            ],
          },
        ],
      },
    ],
  });

test("skills move only between the domains the areas allow, and only when they are about the same topic", () => {
  const all = diffVersions(MERGE_OLD(), MERGE_NEW(), {
    titleThreshold: 0.5,
    moveThreshold: MOVE_THRESHOLD,
  });
  assert.equal(all.stats.moved, 6);
  assert.equal(all.stats.added, 1, "only the agent skill is new");
  assert.equal(
    all.stats.removed,
    1,
    "only Conditional Access has no counterpart",
  );
  const items = all.domains.flatMap((d) => d.groups.flatMap((g) => g.items));
  const reworded = items.find(
    (i) => i.kind === "moved-in" && /alerts in Microsoft Defender/.test(i.new),
  );
  assert.equal(reworded.from.domain, "Manage threats");
  assert.match(reworded.old, /Configure alert policies/);
  const out = items.find((i) => i.kind === "moved-out" && /SSPR/.test(i.old));
  assert.equal(out.to.domain, "Govern and secure tenants");
  assert.ok(changeKind(all) !== "none" && all.stats.changedShare > 0.5);

  // Without the edge from "Manage compliance", its skills stay removed and the new ones stay added.
  const limited = diffVersions(MERGE_OLD(), MERGE_NEW(), {
    titleThreshold: 0.5,
    moveThreshold: MOVE_THRESHOLD,
    moveEdges: new Set([
      moveEdge("Manage identity", "Govern and secure tenants"),
      moveEdge("Manage threats", "Govern and secure tenants"),
    ]),
  });
  assert.equal(limited.stats.moved, 4);
  assert.equal(limited.stats.added, 3);
  assert.equal(limited.stats.removed, 3);
  // Not asked for: no moves at all.
  const none = diffVersions(MERGE_OLD(), MERGE_NEW(), { titleThreshold: 0.5 });
  assert.equal(none.stats.moved, 0);
});

test("a skill that only shares filler words with another is not a move", () => {
  const dom = (title, task) => [
    { title, min: 100, max: 100, groups: [{ title: "G", tasks: [task] }] },
  ];
  const diff = diffVersions(
    guide({
      asOf: null,
      domains: dom(
        "A",
        "Monitor synchronization by using Microsoft Entra Connect Health",
      ),
    }),
    guide({
      asOf: null,
      domains: dom(
        "C",
        "Monitor service health by using the Copilot Control System",
      ),
    }),
    { titleThreshold: 0.5, moveThreshold: MOVE_THRESHOLD },
  );
  assert.equal(diff.stats.moved, 0);
  assert.ok(topicOverlap("Monitor a", "Monitor b").shared < 2);
});

test("domains are paired as the areas say, not by how alike their titles are", () => {
  const prev = guide({ asOf: null, domains: OLD_EXAM() });
  const cur = guide({ asOf: null, domains: NEW_EXAM() });
  const paired = diffVersions(prev, cur, {
    pairDomains: new Map([
      ["Develop a monitoring plan", "Design and implement a monitoring plan"],
    ]),
  });
  assert.deepEqual(
    paired.domains.map((d) => [d.status, d.oldTitle ?? null]),
    [
      ["same", null],
      ["same", null],
      ["same", "Develop a monitoring plan"],
    ],
  );
  // Pairing two domains that look nothing alike is allowed: that is the point of doing it by hand.
  const odd = diffVersions(prev, cur, {
    pairDomains: new Map([
      ["Ingest and transform data", "Design and implement a monitoring plan"],
    ]),
  });
  assert.equal(
    odd.domains.find(
      (d) => d.title === "Design and implement a monitoring plan",
    ).oldTitle,
    "Ingest and transform data",
  );
  // A pairing that names a domain neither guide has is ignored.
  const stale = diffVersions(prev, cur, {
    pairDomains: new Map([["Nope", "Design and implement a monitoring plan"]]),
  });
  assert.deepEqual(stale.domains.map((d) => d.status).sort(), [
    "added",
    "removed",
    "same",
    "same",
  ]);
  // The graph of an entry list: one to one entries pair, every from/to combination is an edge.
  const graph = areaGraph([
    { from: ["a"], to: ["b"], note: "" },
    { from: ["c", "d"], to: ["e"], note: "" },
    { from: [], to: ["f"], note: "" },
  ]);
  assert.deepEqual([...graph.pairs], [["a", "b"]]);
  assert.equal(graph.edges.size, 3);
  assert.ok(graph.edges.has(moveEdge("d", "e")));
  assert.equal(areaGraph(null).pairs.size, 0);
});

const compareMerged = (areas) => {
  const hist = (lines) =>
    recordVersion(emptyHistory("X"), lines, "2026-10-15").history;
  const to = { code: "AB-650", history: hist(MERGE_NEW()) };
  const page = buildChangePage(to.history, {
    now: at("2026-11-10"),
    compare: {
      from: [{ code: "MS-102", history: hist(MERGE_OLD()) }],
      to,
      areas,
    },
  });
  return { page, tab: tab(page, "Compared to MS-102") };
};

test("the comparison explains each area, links the areas to their place in the full guide and tags moved skills", () => {
  const { page, tab: t } = compareMerged([
    {
      from: ["Manage identity", "Manage threats", "Manage compliance"],
      to: ["Govern and secure tenants"],
      note: "Three technical domains combined into one.",
    },
  ]);
  const text = words(t);
  assert.match(text, /How the areas changed/);
  assert.match(text, /MS-102 area AB-650 area What changed/);
  assert.match(
    text,
    /Manage identity \( 30–35% , 3 skills\) Manage threats \( 30–35% , 2 skills\)/,
  );
  assert.match(text, /Merged\. Three technical domains combined into one\./);
  assert.match(text, /Skills moved to another domain 6/);
  // Domains that are not in the new guide say where they went in the weights table.
  assert.match(t.html, /<em>→ Govern and secure tenants<\/em>/);
  // Skills at a glance: how each area changed.
  const glance = t.html.match(
    /<h4>Skills at a glance<\/h4><ul>[\s\S]*?<\/ul>/,
  )[0];
  assert.match(glance, /Govern and secure tenants[\s\S]*merged from/);
  assert.match(glance, /— merged into <a /);
  // Every link points at a heading that exists, and no heading id is used twice.
  const idList = [...t.html.matchAll(/<h4 id="([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set(idList);
  assert.equal(ids.size, idList.length);
  const targets = [...t.html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 8);
  for (const id of targets) assert.ok(ids.has(id), `${id} has no heading`);
  // A moved skill names where it came from and where it went, as links.
  assert.match(
    t.html,
    /← from <a href="#cmp-manage-threats-old"[^>]*>Manage threats<\/a>/,
  );
  assert.match(
    t.html,
    /→ now in <a href="#cmp-govern-and-secure-tenants"[^>]*>Govern and secure tenants<\/a>/,
  );
  assert.ok(page.headings.some((x) => x.slug === "how-the-areas-changed"));
});

test("an area entry that names a title no guide has is left out, and new and removed areas are labelled", () => {
  const { tab: t } = compareMerged([
    {
      from: ["Manage identity"],
      to: ["Govern and secure tenants"],
      note: "Carried.",
    },
    { from: ["Manage threats"], to: [], note: "Gone." },
    {
      from: ["Missing domain"],
      to: ["Govern and secure tenants"],
      note: "Stale.",
    },
    { from: [], to: ["No such new domain"], note: "Stale as well." },
  ]);
  const text = words(t);
  assert.match(text, /Renamed\. Carried\./);
  assert.match(text, /Not in AB-650\. Gone\./);
  assert.doesNotMatch(text, /Stale/);
  assert.match(
    t.html,
    /<em>not in AB-650<\/em>/,
    "an old domain with no new home says so",
  );
  // Without any areas the comparison still works, by title alone, and has no areas table.
  const bare = words(compareMerged(null).tab);
  assert.doesNotMatch(bare, /How the areas changed/);
});

// ---------------------------------------------------------------------------
// Low-level skills covered by a few high-level ones (MS-102 Purview to AB-650)
// ---------------------------------------------------------------------------

const DETAILED = () =>
  guide({
    asOf: "2026-04-28",
    domains: [
      {
        title: "Manage compliance",
        min: 100,
        max: 100,
        groups: [
          {
            title: "Implement information protection and DLP",
            tasks: [
              "Implement sensitivity labels and sensitivity label policies",
              "Implement and manage sensitive information types by using keywords",
              "Configure Endpoint DLP",
              "Configure DLP policies for Microsoft 365 workloads, including Exchange Online and SharePoint",
              "Review and respond to DLP alerts, events, and reports",
            ],
          },
        ],
      },
    ],
  });
const BROAD = () =>
  guide({
    asOf: null,
    domains: [
      {
        title: "Govern",
        min: 100,
        max: 100,
        groups: [
          {
            title: "Protect data",
            tasks: [
              "Identify requirements for information protection, including sensitivity labels and sensitivity label policies",
              "Identify requirements for DLP policies, including those for Exchange Online and SharePoint, and Endpoint DLP",
              "Review and respond to DLP alerts for Microsoft 365 and AI services",
            ],
          },
        ],
      },
    ],
  });
const BROAD_GROUPS = [
  {
    from: ["Implement information protection and DLP"],
    to: ["Protect data"],
    broader: true,
    note: "The same topics at a higher level.",
  },
];

test("several detailed skills can land on one broad skill, and detailed skills nothing matches are covered by the broad group, not removed", () => {
  const diff = diffVersions(DETAILED(), BROAD(), {
    moveThreshold: MOVE_THRESHOLD,
    pairDomains: new Map([["Manage compliance", "Govern"]]),
    groupMap: groupGraph(BROAD_GROUPS),
  });
  const items = diff.domains.flatMap((d) => d.groups.flatMap((g) => g.items));
  const kinds = (kind) => items.filter((i) => i.kind === kind);
  // Endpoint DLP and the DLP policies skill both land on the one skill about DLP requirements.
  const dlp = kinds("moved-in").find((i) => /DLP policies/.test(i.new));
  assert.equal(dlp.alsoFrom, 1);
  assert.equal(kinds("moved-out").filter((i) => /DLP/.test(i.old)).length, 3);
  // Responding to alerts goes to the alerts skill, not to the broad DLP one that a short skill could swallow.
  const alerts = kinds("moved-in").find((i) =>
    /respond to DLP alerts/.test(i.new),
  );
  assert.match(alerts.old, /Review and respond to DLP alerts, events/);
  // Sensitive information types match no skill: covered by the group.
  assert.deepEqual(
    kinds("covered").map((i) => [i.old, i.to.group]),
    [
      [
        "Implement and manage sensitive information types by using keywords",
        "Protect data",
      ],
    ],
  );
  assert.deepEqual(
    [
      diff.stats.added,
      diff.stats.removed,
      diff.stats.moved,
      diff.stats.covered,
    ],
    [0, 0, 3, 1],
  );
  // Without the group pairing marked broader the same skill is simply removed.
  const plain = diffVersions(DETAILED(), BROAD(), {
    moveThreshold: MOVE_THRESHOLD,
    pairDomains: new Map([["Manage compliance", "Govern"]]),
    groupMap: groupGraph([{ ...BROAD_GROUPS[0], broader: false }]),
  });
  assert.equal(plain.stats.removed, 1);
  assert.equal(plain.stats.covered, 0);
});

test("a covered skill and a group table show up on the comparison page", () => {
  const hist = (lines) =>
    recordVersion(emptyHistory("X"), lines, "2026-10-15").history;
  const to = { code: "AB-650", history: hist(BROAD()) };
  const page = buildChangePage(to.history, {
    now: at("2026-11-10"),
    compare: {
      from: [{ code: "MS-102", history: hist(DETAILED()) }],
      to,
      areas: [
        {
          from: ["Manage compliance"],
          to: ["Govern"],
          label: "Higher level",
          note: "Purview, at a higher level.",
        },
      ],
      groups: BROAD_GROUPS,
    },
  });
  const t = tab(page, "Compared to MS-102");
  const text = words(t);
  assert.match(text, /1 is covered at a higher level by broader skills/);
  assert.match(text, /Skills covered at a higher level 1/);
  assert.match(text, /Group by group/);
  assert.match(
    text,
    /MS-102 group AB-650 group What changed Implement information protection and DLP \(5 skills\) Protect data \(3 skills\) Higher level\. The same topics at a higher level\./,
  );
  // The covered skill names the group that covers it, as a link to that group's heading.
  const groupId = t.html.match(
    /<h5 id="([^"]+)"[^>]*>(?:<ins[^>]*>)?Protect data/,
  )[1];
  assert.match(
    t.html,
    new RegExp(`→ covered at a higher level by <a href="#${groupId}"`),
  );
  assert.match(t.html, /and 1 more skill of the old guide/);
});
