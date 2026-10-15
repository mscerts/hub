import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_IDLE_WAIT_MINUTES,
  DEFAULT_STALE_ALERT_DAYS,
  FULL_AUDIT_MAX_AGE_DAYS,
  FULL_AUDIT_RULE,
  MAX_REPORT_CHARS,
  MAX_TABLE_ROWS,
  SPARSE_PATHS,
  STALE_ISSUE_LABEL,
  STALE_ISSUE_TITLE,
  buildFreshComment,
  buildReport,
  buildStaleReport,
  carryOver,
  checkoutCommands,
  chooseCheckSource,
  chooseSourceFromEnv,
  collectRepoUrls,
  diffTracker,
  evaluateChanges,
  extractLearnUrls,
  failedSyncSections,
  heartbeatNotes,
  isFullAuditDay,
  isFullAuditOverdue,
  issueTitle,
  ledgerFreshness,
  ledgerNotes,
  ledgerResult,
  learnsyncStaleness,
  listOpenStaleIssues,
  needsLiveConfirmation,
  nextFullAuditDate,
  parseStaleAlertDays,
  plain,
  readLastFullAudit,
  recentlyVerified,
  reconcileStaleIssue,
  selectCheckSource,
  staleSections,
  stripComments,
  summarizeSyncRuns,
  syncState,
  syncWaitPlan,
  toFindings,
} from "../../scripts/learn-url-check.mjs";

// stand-in for learnsync's canonicalPath (the real one is covered in learnsync)
const canonical = (raw) => {
  try {
    const url = new URL(raw);
    if (url.hostname !== "learn.microsoft.com") return null;
    return url.pathname
      .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
};

test("URLs are extracted with line numbers; comments and code placeholders are ignored", () => {
  const text = [
    "intro",
    '<LinkCard href="https://learn.microsoft.com/training/modules/a/1-x/?WT.mc_id=1" />',
    "{/*",
    '<LinkCard href="https://learn.microsoft.com/training/modules/gone/" />',
    "*/}",
    "[docs](https://learn.microsoft.com/azure/api-management/overview).",
    "<!-- https://learn.microsoft.com/azure/hidden -->",
    "https://example.com/not-learn",
    "const u = `https://learn.microsoft.com/credentials/certifications/exams/${code}`;",
    "https://learn.microsoft.com/credentials/certifications/exams/{code}/",
  ].join("\n");
  assert.deepEqual(
    extractLearnUrls(text).map((u) => [u.line, u.raw]),
    [
      [2, "https://learn.microsoft.com/training/modules/a/1-x/?WT.mc_id=1"],
      [6, "https://learn.microsoft.com/azure/api-management/overview"],
    ],
  );
  assert.equal(stripComments("a\n{/* x\ny */}\nb").split("\n").length, 4);
});

test("the repo scan finds Learn URLs with locations and skips generated trackers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-url-test-"));
  await mkdir(join(dir, "src", "content"), { recursive: true });
  await mkdir(join(dir, "src", "data_files"), { recursive: true });
  await writeFile(
    join(dir, "src", "content", "page.mdx"),
    'line one\n<LinkCard href="https://learn.microsoft.com/en-us/training/modules/m/exercise/?WT.mc_id=1" />\n',
  );
  await writeFile(
    join(dir, "src", "data_files", "applied-skills-cache.json"),
    '{"u":"https://learn.microsoft.com/credentials/applied-skills/x"}',
  );
  const map = collectRepoUrls(dir, canonical, ["src"]);
  assert.deepEqual([...map.keys()], ["/training/modules/m/exercise"]);
  assert.deepEqual(map.get("/training/modules/m/exercise").locations, [
    "src/content/page.mdx:2",
  ]);
});

test("every tracker a script writes is skipped by the repo scan, the hand-edited lists are not", async () => {
  // The data files the scripts name, minus the lists a person edits.
  const handEdited = new Set(["watched-sources", "lab-repos-ignore"]);
  const named = new Set();
  const scriptsDir = resolve(import.meta.dirname, "../../scripts");
  for (const file of readdirSync(scriptsDir).filter((f) =>
    f.endsWith(".mjs"),
  )) {
    const source = readFileSync(join(scriptsDir, file), "utf8");
    for (const match of source.matchAll(
      /src\/data_files\/([a-z0-9-]+)\.json/g,
    )) {
      named.add(match[1]);
    }
  }
  assert.ok(
    named.has("learn-content-watch") && named.has("source-watch"),
    "the scan of the scripts found the trackers",
  );
  const tracked = [...named].filter((name) => !handEdited.has(name));

  const dir = await mkdtemp(join(tmpdir(), "learn-url-test-"));
  await mkdir(join(dir, "src", "data_files"), { recursive: true });
  const url = (name) => `https://learn.microsoft.com/credentials/${name}/x`;
  for (const name of [...tracked, ...handEdited]) {
    await writeFile(
      join(dir, "src", "data_files", `${name}.json`),
      JSON.stringify({ url: url(name) }),
    );
  }
  const map = collectRepoUrls(dir, canonical, ["src"]);
  for (const name of tracked) {
    assert.ok(
      ![...map.values()].some((entry) =>
        entry.locations.some((place) => place.endsWith(`/${name}.json:1`)),
      ),
      `${name}.json is written by a script and must be skipped`,
    );
  }
  for (const name of handEdited) {
    assert.ok(
      [...map.values()].some((entry) =>
        entry.locations.includes(`src/data_files/${name}.json:1`),
      ),
      `${name}.json is edited by hand and must be scanned`,
    );
  }
  // The tracker of the Learn Content Watch, with the exam page that does not exist yet.
  await writeFile(
    join(dir, "src", "data_files", "learn-content-watch.json"),
    JSON.stringify({
      pageUrl:
        "https://learn.microsoft.com/credentials/certifications/exams/gh-700/",
    }),
  );
  assert.ok(
    ![...collectRepoUrls(dir, canonical, ["src"]).keys()].some((path) =>
      path.includes("gh-700"),
    ),
  );
});

test("the sync guard waits for queued or running learnsync runs", () => {
  const run = (extra = {}) => ({
    run_number: 7,
    status: "completed",
    conclusion: "success",
    ...extra,
  });
  assert.deepEqual(syncState({ "a.yml": [run()], "b.yml": [run()] }), {
    inFlight: [],
    failed: [],
  });
  assert.deepEqual(
    syncState({
      "a.yml": [run({ status: "in_progress", conclusion: null }), run()],
    }).inFlight,
    ["a.yml#7"],
  );
  assert.deepEqual(
    syncState({ "a.yml": [run({ status: "queued", conclusion: null })] })
      .inFlight,
    ["a.yml#7"],
  );
  assert.deepEqual(
    syncState({ "a.yml": [run({ conclusion: "failure" })] }).failed,
    ["a.yml#7 (failure)"],
  );
  // a failed run that is followed by a running one is not reported as failed
  assert.deepEqual(
    syncState({
      "a.yml": [
        run({ status: "in_progress", conclusion: null }),
        run({ conclusion: "failure" }),
      ],
    }).failed,
    [],
  );
});

test("the heartbeat check reports which learnsync sections are stale", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const status = {
    learn: { generatedAt: "2026-10-06T07:30:00.000Z" },
    docs: { generatedAt: "2026-09-28T08:40:00.000Z" },
  };
  assert.deepEqual(staleSections(status, now, 48), ["docs"]);
  assert.deepEqual(staleSections({}, now, 48), ["learn", "docs"]);
  assert.deepEqual(staleSections(undefined, now, 48), ["learn", "docs"]);
  status.docs.generatedAt = "2026-10-06T08:40:00.000Z";
  assert.deepEqual(staleSections(status, now, 48), []);
});

// The real state on 2026-10-13 06:00 UTC: the Learn heartbeat is from 2026-10-06
// 22:06 UTC, the Learn run of 2026-10-12 failed, the docs sync of 2026-10-12 finished
const WAIT_NOW = Date.parse("2026-10-13T06:00:00Z");
const waitRun = (number, conclusion, at, status = "completed") => ({
  run_number: number,
  status,
  conclusion,
  created_at: at,
  html_url: `https://github.com/mscerts/learnsync/actions/runs/${1000 + number}`,
});
const frozenRuns = (
  learnLatest = waitRun(11, "failure", "2026-10-12T16:42:57Z"),
) => ({
  "learn-catalog-monitor.yml": [
    learnLatest,
    waitRun(10, "success", "2026-10-06T22:05:49Z"),
  ],
  "docs-catalog-monitor.yml": [waitRun(4, "success", "2026-10-12T17:00:00Z")],
});
const frozenStatus = () => ({
  learn: { generatedAt: "2026-10-06T22:06:45.322Z" },
  docs: { generatedAt: "2026-10-12T17:36:55.849Z", complete: true },
});

test("a sync that failed after the last good heartbeat is found from its run, whatever the heartbeat's age", () => {
  const found = failedSyncSections(
    summarizeSyncRuns(frozenRuns()),
    frozenStatus(),
    WAIT_NOW,
    48,
  );
  assert.deepEqual(
    found.map((f) => [f.section, f.workflow, f.run.number, f.run.conclusion]),
    [["learn", "learn-catalog-monitor.yml", 11, "failure"]],
  );
  assert.equal(found[0].heartbeat, "2026-10-06T22:06:45.322Z");
  assert.equal(found[0].label, "Learn Catalog Monitor");

  const none = (summaries, status = frozenStatus()) =>
    failedSyncSections(summaries, status, WAIT_NOW, 48);
  // the latest run succeeded
  assert.deepEqual(
    none(
      summarizeSyncRuns(
        frozenRuns(waitRun(11, "success", "2026-10-12T16:42:57Z")),
      ),
    ),
    [],
  );
  // still queued or running: waited for, not failed
  assert.deepEqual(
    none(
      summarizeSyncRuns(
        frozenRuns(waitRun(11, null, "2026-10-13T05:00:00Z", "in_progress")),
      ),
    ),
    [],
  );
  // the failure is older than the last good heartbeat: it explains nothing
  assert.deepEqual(
    none(
      summarizeSyncRuns(
        frozenRuns(waitRun(11, "failure", "2026-10-05T07:10:00Z")),
      ),
    ),
    [],
  );
  // the heartbeat is still recent (a manual re-run failed a few hours after a good sync)
  assert.deepEqual(
    none(summarizeSyncRuns(frozenRuns()), {
      ...frozenStatus(),
      learn: { generatedAt: "2026-10-12T20:00:00Z" },
    }),
    [],
  );
  // no runs read, or a workflow that is not a sync workflow: nothing to say
  assert.deepEqual(none(null), []);
  assert.deepEqual(
    none([
      {
        workflow: "other.yml",
        label: "x",
        latest: waitRun(1, "failure", "2026-10-12"),
      },
    ]),
    [],
  );
  // a run without a start time still counts: it is the latest one and the data is old
  assert.equal(
    none(
      summarizeSyncRuns(
        frozenRuns({
          run_number: 12,
          status: "completed",
          conclusion: "cancelled",
        }),
      ),
    ).length,
    1,
  );
});

test("waiting only happens while it can help: running syncs, a late start, never a sync that already failed", () => {
  // the frozen state: the Learn sync failed, the docs sync is fresh. Nothing to wait for.
  const frozen = syncWaitPlan(frozenRuns(), frozenStatus(), WAIT_NOW, 48);
  assert.equal(frozen.kind, "settled");
  assert.deepEqual(frozen.inFlight, []);
  assert.deepEqual(frozen.late, []);
  assert.equal(frozen.failed[0].section, "learn");

  // a run is queued or in progress: wait for it
  const running = syncWaitPlan(
    frozenRuns(waitRun(11, null, "2026-10-13T05:30:00Z", "queued")),
    frozenStatus(),
    WAIT_NOW,
    48,
  );
  assert.equal(running.kind, "running");
  assert.deepEqual(running.inFlight, ["learn-catalog-monitor.yml#11"]);
  assert.deepEqual(running.late, ["learn"]);
  assert.deepEqual(running.failed, []);

  // the heartbeat is old, the latest run was a success, nothing is running: only a late
  // scheduled start could still refresh it, which is a short wait
  const late = syncWaitPlan(
    frozenRuns(waitRun(11, "success", "2026-10-05T07:10:00Z")),
    frozenStatus(),
    WAIT_NOW,
    48,
  );
  assert.equal(late.kind, "late");
  assert.deepEqual(late.late, ["learn"]);
  assert.deepEqual(late.failed, []);

  // one failed and one late: the late one still allows a short wait
  const mixed = syncWaitPlan(
    {
      ...frozenRuns(),
      "docs-catalog-monitor.yml": [
        waitRun(4, "success", "2026-10-05T08:10:00Z"),
      ],
    },
    { ...frozenStatus(), docs: { generatedAt: "2026-10-05T08:40:00Z" } },
    WAIT_NOW,
    48,
  );
  assert.equal(mixed.kind, "late");
  assert.deepEqual(mixed.late, ["docs"]);
  assert.equal(mixed.failed[0].section, "learn");

  // everything fresh
  const fresh = syncWaitPlan(
    frozenRuns(waitRun(11, "success", "2026-10-12T16:42:57Z")),
    { ...frozenStatus(), learn: { generatedAt: "2026-10-12T17:00:00Z" } },
    WAIT_NOW,
    48,
  );
  assert.equal(fresh.kind, "settled");
  assert.deepEqual(fresh.failed, []);
  assert.equal(DEFAULT_IDLE_WAIT_MINUTES, 30);
});

test("tracker diff separates new findings from known and resolved ones", () => {
  const open = { "https://a": {}, "https://b": {}, "https://c": {} };
  const diff = diffTracker(
    open,
    ["https://b", "https://d"],
    new Set(["https://b", "https://d", "https://a"]),
  );
  assert.deepEqual(diff.fresh, ["https://d"]);
  assert.deepEqual(diff.stillOpen, ["https://b"]);
  assert.deepEqual(diff.resolved.sort(), ["https://a", "https://c"]);
});

test("validator results become findings; unverifiable, valid and unsettled low-confidence ones do not", () => {
  const repoUrls = new Map(
    ["/a", "/b", "/c", "/d", "/e"].map((p) => [
      p,
      {
        raws: new Set([`https://learn.microsoft.com${p}`]),
        locations: [`f:${p}`],
      },
    ]),
  );
  const r = (path, verdict, extra = {}) => ({
    path,
    verdict,
    reason: "why",
    evidence: "learn-catalog",
    confidence: "high",
    suggestion: null,
    ...extra,
  });
  const findings = toFindings(
    [
      r("/a", "valid"),
      r("/b", "broken"),
      r("/c", "moved", { suggestion: "https://learn.microsoft.com/c2" }),
      r("/d", "unverifiable"),
      r("/e", "broken", { confidence: "low", liveNote: "inconclusive" }),
      r("/zzz", "broken"), // not in the repo map: ignored
    ],
    repoUrls,
  );
  assert.deepEqual(
    findings.map((f) => [f.path, f.kind]),
    [
      ["/b", "broken"],
      ["/c", "moved"],
    ],
  );
  assert.equal(findings[1].suggestion, "https://learn.microsoft.com/c2");
  assert.deepEqual(findings[0].locations, ["f:/b"]);
});

test("the issue separates broken links from moved pages", () => {
  const broken = {
    url: "https://learn.microsoft.com/training/modules/gone",
    kind: "broken",
    reason: "module removed",
    locations: ["src/a.mdx:1"],
  };
  const moved = {
    url: "https://learn.microsoft.com/azure/old",
    kind: "moved",
    reason: "redirects to /azure/new",
    locations: ["src/b.mdx:2"],
    suggestion: "https://learn.microsoft.com/azure/new",
  };
  assert.equal(
    issueTitle([broken, moved, moved], "2026-10-06"),
    "Broken Microsoft Learn links: 1 broken, 2 moved (2026-10-06)",
  );
  assert.equal(
    issueTitle([moved], "2026-10-06"),
    "Broken Microsoft Learn links: 1 moved (2026-10-06)",
  );
  const report = buildReport({
    findings: [broken, moved],
    data: {
      sha: "0123456789abcdef",
      learnGeneratedAt: "2026-10-06T07:30:00Z",
      docsGeneratedAt: "2026-10-06T08:40:00Z",
    },
    summary: {
      total: 10,
      byVerdict: { valid: 7, broken: 1, moved: 1, unverifiable: 1 },
    },
    today: "2026-10-06",
    runUrl: "https://github.com/x/y/actions/runs/1",
    notes: ["A note."],
  });
  assert.match(report, /found \*\*2\*\* links that no longer work/);
  assert.match(report, /### Broken links \(1\)/);
  assert.match(report, /### Moved pages \(1\)/);
  assert.ok(report.indexOf("Broken links") < report.indexOf("Moved pages"));
  assert.match(report, /src\/a\.mdx:1/);
  assert.match(report, /azure\/new/);
  assert.match(report, /commit `0123456`/);
  assert.match(report, /> A note\./);
  assert.match(report, /Valid: 7\. Broken: 1\. Moved: 1\./);
  assert.match(
    buildReport({
      findings: [broken],
      data: {
        sha: "0123456789",
        learnGeneratedAt: null,
        docsGeneratedAt: null,
      },
      summary: { total: 1, byVerdict: { broken: 1 } },
      today: "t",
      notes: [],
    }),
    /found \*\*1\*\* link that no longer works/,
  );
});

// A first full audit can list hundreds of links at once. GitHub rejects an issue text above
// 65,536 characters, so `gh issue create` would fail after the stale-data issue is open and
// before the tracker is written.
const auditFindings = (kind, count, extra = {}) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://learn.microsoft.com/training/modules/${kind}-${i}/1-unit`,
    kind,
    reason: `/training/modules/${kind}-${i}/1-unit was removed [gone]; first recorded 2026-09-21, last verified 2026-10-05`,
    evidence: "live-probe",
    cacheReason: null,
    locations: [
      `src/content/docs/azure/AZ-${100 + (i % 9)}.mdx:${10 + i}`,
      `src/content/docs/labs/azure/az-${100 + (i % 9)}.mdx:${20 + i}`,
    ],
    suggestion:
      kind === "moved"
        ? `https://learn.microsoft.com/training/modules/${kind}-${i}/new-unit/`
        : null,
    ...extra,
  }));
const auditReport = (findings, extra = {}) =>
  buildReport({
    findings,
    data: {
      sha: "0123456789abcdef",
      learnGeneratedAt: "2026-11-03T07:30:00Z",
      docsGeneratedAt: "2026-11-03T08:40:00Z",
    },
    summary: {
      total: 1500,
      byVerdict: {
        valid: 1500 - findings.length,
        broken: findings.filter((f) => f.kind !== "moved").length,
        moved: findings.filter((f) => f.kind === "moved").length,
      },
    },
    today: "2026-11-03",
    runUrl: "https://github.com/mscerts/hub/actions/runs/1",
    notes: [],
    ...extra,
  });
/** The rows of the table under a heading of the report. */
const tableRows = (report, heading) =>
  report
    .slice(report.indexOf(heading))
    .split("\n### ")[0]
    .split("\n")
    .filter((line) => line.startsWith("| https://"));

test("a long list is cut at 60 rows per table and stays below GitHub's size limit, with exact counts", () => {
  assert.equal(MAX_TABLE_ROWS, 60);
  const findings = [
    ...auditFindings("broken", 300),
    ...auditFindings("moved", 200),
  ];
  const report = auditReport(findings);
  assert.ok(report.length < MAX_REPORT_CHARS, `${report.length} characters`);
  // the totals are the exact ones, whatever is not shown
  assert.match(report, /found \*\*500\*\* links/);
  assert.match(report, /### Broken links \(300\)/);
  assert.match(report, /### Moved pages \(200\)/);
  assert.equal(tableRows(report, "### Broken links").length, 60);
  assert.equal(tableRows(report, "### Moved pages").length, 60);
  assert.match(
    report,
    /\.\.\. and 240 more broken links not listed here \(the log of this run lists every link\)\./,
  );
  assert.match(report, /\.\.\. and 140 more moved pages not listed here/);
  // the rows are the first ones, and what comes after the tables is still there
  assert.ok(report.includes("/training/modules/broken-59/1-unit"));
  assert.ok(!report.includes("/training/modules/broken-60/1-unit"));
  assert.match(report, /### How to fix/);
  assert.match(report, /Unique Learn URLs in the repo: \*\*1500\*\*/);
  assert.match(
    report,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/1/,
  );

  // a list that fits is shown whole, without the line; one row more than the cap says so
  const exact = auditReport(auditFindings("broken", 60));
  assert.equal(tableRows(exact, "### Broken links").length, 60);
  assert.ok(!exact.includes("not listed here"));
  const over = auditReport(auditFindings("broken", 61));
  assert.equal(tableRows(over, "### Broken links").length, 60);
  assert.match(over, /\.\.\. and 1 more broken link not listed here/);
});

test("the change-file report is cut the same way", () => {
  const report = buildReport({
    findings: [...auditFindings("broken", 150), ...auditFindings("moved", 150)],
    data: {
      sha: "89abcdef0123",
      learnGeneratedAt: null,
      docsGeneratedAt: null,
    },
    summary: null,
    today: "2026-11-03",
    runUrl: null,
    notes: [],
    mode: "changes",
    coverage: {
      total: 1500,
      recorded: 300,
      recordedRemoved: 150,
      recordedMoved: 150,
      ledgerOnly: 300,
      probed: 0,
      clearedByLive: 0,
      unsettled: 0,
      trustDays: 14,
      nextFullAudit: "2026-12-01",
      ledger: {
        sha: "89abcdef0123",
        learnStamp: "2026-11-02T19:15:57.783Z",
        docsStamp: "2026-11-02T19:55:18.359Z",
        learnEntries: 150,
        docsEntries: 150,
        total: 300,
      },
    },
  });
  assert.ok(report.length < MAX_REPORT_CHARS, `${report.length} characters`);
  assert.match(report, /### Broken links \(150\)/);
  assert.match(report, /### Moved pages \(150\)/);
  assert.match(report, /\.\.\. and 90 more broken links not listed here/);
  assert.match(report, /\.\.\. and 90 more moved pages not listed here/);
  assert.match(report, /change-file run/);
});

test("rows that are long make the tables shorter still, never the issue text too long", () => {
  const reason = `removed ${"because of a very long explanation, ".repeat(35)}`;
  const report = auditReport([
    ...auditFindings("broken", 300, { reason }),
    ...auditFindings("moved", 200, { reason }),
  ]);
  assert.ok(report.length <= MAX_REPORT_CHARS, `${report.length} characters`);
  for (const [heading, total, what] of [
    ["### Broken links", 300, "broken links"],
    ["### Moved pages", 200, "moved pages"],
  ]) {
    const shown = tableRows(report, heading).length;
    assert.ok(shown >= 1 && shown < MAX_TABLE_ROWS, `${shown} rows shown`);
    assert.ok(
      report.includes(`... and ${total - shown} more ${what} not listed here`),
      `${what}: ${shown} shown, ${total - shown} more`,
    );
  }
});

test("a text that is long for another reason than its tables is cut, not refused", () => {
  const report = auditReport(auditFindings("broken", 3), {
    notes: ["x".repeat(70_000)],
  });
  assert.ok(report.length <= MAX_REPORT_CHARS, `${report.length} characters`);
  assert.match(report, /found \*\*3\*\* links/);
  assert.match(
    report,
    /\.\.\. the report was cut to fit the size limit of an issue; the log of this run has everything\.\n$/,
  );
});

// ---------------------------------------------------------------------------
// Source selection: change files (weekly) or the full caches (monthly)
// ---------------------------------------------------------------------------
test("CHECK_SOURCE defaults to the change files and rejects typos", () => {
  assert.equal(selectCheckSource(undefined), "changes");
  assert.equal(selectCheckSource(""), "changes");
  assert.equal(selectCheckSource("  "), "changes");
  assert.equal(selectCheckSource("changes"), "changes");
  assert.equal(selectCheckSource("CACHE"), "cache");
  assert.equal(selectCheckSource(" cache "), "cache");
  assert.throws(() => selectCheckSource("full"), /Invalid CHECK_SOURCE="full"/);
  assert.throws(() => selectCheckSource("change"), /Invalid CHECK_SOURCE/);
});

test("the workflow runs the full audit on the first Tuesday and on demand, the change files otherwise", () => {
  const at = (iso) => new Date(`${iso}T06:00:00Z`);
  // scheduled: day of the month 1-7 (the first Tuesday) is the full audit
  assert.equal(isFullAuditDay(at("2026-10-06")), true);
  assert.equal(isFullAuditDay(at("2026-11-03")), true);
  assert.equal(isFullAuditDay(at("2026-10-01")), true);
  assert.equal(isFullAuditDay(at("2026-10-07")), true);
  assert.equal(isFullAuditDay(at("2026-10-08")), false);
  assert.equal(isFullAuditDay(at("2026-10-13")), false);
  assert.equal(isFullAuditDay(at("2026-10-27")), false);
  // with a full audit on record (a tracker that never recorded one is overdue: see below)
  const scheduled = (iso) =>
    chooseCheckSource({
      eventName: "schedule",
      now: at(iso),
      lastFullAudit: "2026-10-06",
    });
  assert.equal(scheduled("2026-10-06"), "cache");
  assert.equal(scheduled("2026-10-13"), "changes");
  assert.equal(scheduled("2026-10-20"), "changes");
  assert.equal(scheduled("2026-10-27"), "changes");
  assert.equal(scheduled("2026-11-03"), "cache");
  // manual: only the full_audit input asks for the full audit, whatever the day
  const manual = (fullAudit, iso = "2026-10-06") =>
    chooseCheckSource({
      eventName: "workflow_dispatch",
      fullAudit,
      now: at(iso),
    });
  assert.equal(manual("true"), "cache");
  assert.equal(manual(true, "2026-10-20"), "cache");
  assert.equal(manual("false"), "changes");
  assert.equal(manual("", "2026-10-06"), "changes");
  assert.equal(manual(undefined), "changes");
  // learnsync's repository_dispatch (any day) and anything else: change files
  for (const eventName of ["repository_dispatch", "push", "", undefined]) {
    assert.equal(
      chooseCheckSource({ eventName, now: at("2026-10-06") }),
      "changes",
    );
  }
  assert.equal(
    chooseCheckSource({
      eventName: "repository_dispatch",
      fullAudit: "true",
      now: at("2026-10-06"),
    }),
    "changes",
  );
});

test("the next scheduled full audit is the next first Tuesday once an audit is on record", () => {
  const next = (iso, last) =>
    nextFullAuditDate(new Date(`${iso}T00:00:00Z`), last);
  assert.equal(next("2026-10-06", "2026-10-06"), "2026-11-03");
  assert.equal(next("2026-10-01", "2026-09-01"), "2026-10-06");
  assert.equal(next("2026-11-04", "2026-11-03"), "2026-12-01");
  assert.equal(next("2026-12-31", "2026-12-01"), "2027-01-05");
  assert.match(FULL_AUDIT_RULE, /first Tuesday of each month/);
  assert.match(FULL_AUDIT_RULE, /full_audit/);
});

test("a full audit is overdue when none is on record or the last one is more than 35 days old, to the day", () => {
  assert.equal(FULL_AUDIT_MAX_AGE_DAYS, 35);
  const overdue = (last, iso) =>
    isFullAuditOverdue(last, new Date(`${iso}T06:00:00Z`));
  assert.equal(overdue("2026-10-06", "2026-10-06"), false);
  // the first Tuesdays of two months are 28 or 35 days apart: a month that was audited is never overdue
  assert.equal(overdue("2026-10-06", "2026-11-03"), false, "28 days");
  assert.equal(overdue("2026-12-01", "2027-01-05"), false, "35 days");
  assert.equal(overdue("2026-10-06", "2026-11-10"), false, "35 days");
  assert.equal(overdue("2026-10-06", "2026-11-11"), true, "36 days");
  assert.equal(overdue("2026-10-06", "2026-11-17"), true, "42 days");
  // whole UTC days: the time of the run does not move the limit
  assert.equal(
    isFullAuditOverdue("2026-10-06", new Date("2026-11-10T23:59:59Z")),
    false,
  );
  assert.equal(
    isFullAuditOverdue("2026-10-06", new Date("2026-11-11T00:00:00Z")),
    true,
  );
  // none on record (a tracker that never recorded an audit): overdue, so the first scheduled run does it
  for (const last of [null, undefined, ""]) {
    assert.equal(overdue(last, "2026-10-20"), true, JSON.stringify(last));
    assert.equal(overdue(last, "2026-11-17"), true, JSON.stringify(last));
  }
  // something is recorded, but nothing that says an audit is missing: a malformed or a future date
  for (const last of [
    "never",
    "last month",
    "2026-1-6",
    "20261006",
    20261006,
  ]) {
    assert.equal(overdue(last, "2026-11-17"), false, String(last));
  }
  assert.equal(overdue("2027-01-01", "2026-11-17"), false, "in the future");
  // the limit is a parameter
  assert.equal(
    isFullAuditOverdue("2026-10-06", new Date("2026-10-14T00:00:00Z"), 7),
    true,
  );
});

test("a scheduled run also does the full audit when the last one is overdue: a dropped first-Tuesday run is made up, the rule of the month stays", () => {
  const at = (iso) => new Date(`${iso}T06:00:00Z`);
  const scheduled = (iso, lastFullAudit) =>
    chooseCheckSource({ eventName: "schedule", now: at(iso), lastFullAudit });
  // a healthy month: audited on the first Tuesday, the Tuesdays after it use the change files
  assert.equal(scheduled("2026-10-13", "2026-10-06"), "changes");
  assert.equal(scheduled("2026-10-27", "2026-10-06"), "changes");
  assert.equal(scheduled("2026-11-03", "2026-10-06"), "cache");
  // 2026-11-03 did not run (dropped, or failed before the tracker was written): the audit of October
  // is 35 days old on the 10th, still inside the limit, and 42 days old on the 17th
  assert.equal(scheduled("2026-11-10", "2026-10-06"), "changes");
  assert.equal(scheduled("2026-11-17", "2026-10-06"), "cache");
  assert.equal(scheduled("2026-11-24", "2026-10-06"), "cache");
  // once it ran, the Tuesdays after it are the change files again
  assert.equal(scheduled("2026-11-24", "2026-11-17"), "changes");
  // the first-Tuesday rule does not need the tracker
  assert.equal(scheduled("2026-11-03", null), "cache");
  assert.equal(scheduled("2026-11-03", undefined), "cache");
  // no audit on record is overdue too: the first scheduled run does it, whatever the day
  assert.equal(scheduled("2026-10-20", null), "cache");
  assert.equal(scheduled("2026-11-17", null), "cache");
  assert.equal(scheduled("2026-11-17", undefined), "cache");
  assert.equal(scheduled("2026-11-17", ""), "cache");
  assert.equal(
    chooseCheckSource({ eventName: "schedule", now: at("2026-11-17") }),
    "cache",
    "a caller that passes no tracker date has none on record",
  );
  // a date that cannot be an audit (malformed, or in the future) is no evidence that one is missing
  assert.equal(scheduled("2026-11-17", "last month"), "changes");
  assert.equal(scheduled("2026-11-17", "2027-01-01"), "changes");
  // a manual run keeps its explicit choice, whatever the tracker says; so does everything unscheduled
  const dispatch = (fullAudit, lastFullAudit) =>
    chooseCheckSource({
      eventName: "workflow_dispatch",
      fullAudit,
      now: at("2026-11-17"),
      lastFullAudit,
    });
  assert.equal(dispatch("false", "2026-01-01"), "changes");
  assert.equal(dispatch(false, "2026-01-01"), "changes");
  assert.equal(dispatch("", "2026-01-01"), "changes");
  assert.equal(dispatch("false", null), "changes");
  assert.equal(dispatch("", undefined), "changes");
  assert.equal(dispatch("true", "2026-11-10"), "cache");
  for (const eventName of ["repository_dispatch", "push", "", undefined]) {
    for (const lastFullAudit of ["2026-01-01", null]) {
      assert.equal(
        chooseCheckSource({
          eventName,
          now: at("2026-11-17"),
          lastFullAudit,
        }),
        "changes",
        `${eventName} ${lastFullAudit}`,
      );
    }
  }
});

test("a tracker without a recorded audit gets one on its first scheduled run, then the monthly rhythm; an audit that fails is tried again every Tuesday", () => {
  const at = (iso) => new Date(`${iso}T06:00:00Z`);
  // The sources of the scheduled runs on these days. Only an audit that passed records its day:
  // the tracker is written at the end of a successful run.
  const timeline = (tuesdays, passes = () => true, last = null) =>
    tuesdays.map((iso) => {
      const source = chooseCheckSource({
        eventName: "schedule",
        now: at(iso),
        lastFullAudit: last,
      });
      if (source === "cache" && passes(iso)) last = iso;
      return source;
    });
  // the tracker as it is committed today has no lastFullAudit: 2026-10-20 is the first scheduled
  // run, the first Tuesday of November audits again
  assert.deepEqual(
    timeline([
      "2026-10-20",
      "2026-10-27",
      "2026-11-03",
      "2026-11-10",
      "2026-11-17",
      "2026-11-24",
      "2026-12-01",
      "2026-12-08",
    ]),
    [
      "cache",
      "changes",
      "cache",
      "changes",
      "changes",
      "changes",
      "cache",
      "changes",
    ],
  );
  // with nothing recorded, an audit that fails (the systemic guard, a crash) is tried again on
  // every Tuesday until one passes
  const failing = new Set(["2026-10-20", "2026-10-27", "2026-11-03"]);
  assert.deepEqual(
    timeline(
      ["2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"],
      (iso) => !failing.has(iso),
    ),
    ["cache", "cache", "cache", "cache", "changes"],
  );
  // with an audit on record the retries start on the first Tuesday that is more than 35 days after it
  assert.deepEqual(
    timeline(
      [
        "2026-11-03",
        "2026-11-10",
        "2026-11-17",
        "2026-11-24",
        "2026-12-01",
        "2026-12-08",
      ],
      (iso) => iso === "2026-12-01",
      "2026-10-06",
    ),
    ["cache", "changes", "cache", "cache", "cache", "changes"],
  );
});

test("the next scheduled full audit is announced the way the rule will pick it, none on record and overdue audits included", () => {
  const next = (iso, last) =>
    nextFullAuditDate(new Date(`${iso}T00:00:00Z`), last);
  // healthy: the next first Tuesday, with the date of an audit on record
  assert.equal(next("2026-10-13", "2026-10-06"), "2026-11-03");
  assert.equal(next("2026-11-04", "2026-11-03"), "2026-12-01");
  // none on record: the next scheduled run does it, 2026-10-20 being the first one after today
  assert.equal(next("2026-10-14", null), "2026-10-20");
  assert.equal(next("2026-10-20", null), "2026-10-27");
  assert.equal(next("2026-11-04", null), "2026-11-10");
  assert.equal(next("2026-11-04", undefined), "2026-11-10");
  // the audit of 2026-11-03 did not happen: the first Tuesday that is more than 35 days after
  // 2026-10-06 is the 17th
  assert.equal(next("2026-11-04", "2026-10-06"), "2026-11-17");
  assert.equal(next("2026-11-10", "2026-10-06"), "2026-11-17");
  // already overdue on a Tuesday: the next one, a week on
  assert.equal(next("2026-11-17", "2026-10-06"), "2026-11-24");
  // the rule says so too
  assert.match(FULL_AUDIT_RULE, /no full audit is on record/);
  assert.match(FULL_AUDIT_RULE, /more than 35 days old/);
});

test("the tracker's last full audit is read tolerantly, and --choose-source decides with it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-choose-"));
  scratchDirs.push(dir);
  const tracker = join(dir, "tracker.json");
  const choose = (EVENT_NAME, iso, more = {}) =>
    chooseSourceFromEnv(
      { EVENT_NAME, ...more },
      { trackerFile: tracker, now: new Date(`${iso}T06:00:00Z`) },
    );
  await writeFile(
    tracker,
    JSON.stringify({
      lastRun: "2026-11-10",
      lastMode: "changes",
      lastFullAudit: "2026-10-06",
      open: {},
      issues: {},
    }),
  );
  assert.equal(readLastFullAudit(tracker), "2026-10-06");
  assert.deepEqual(choose("schedule", "2026-11-10"), {
    source: "changes",
    lastFullAudit: "2026-10-06",
  });
  assert.deepEqual(choose("schedule", "2026-11-17"), {
    source: "cache",
    lastFullAudit: "2026-10-06",
  });
  assert.equal(choose("workflow_dispatch", "2026-11-17").source, "changes");
  assert.equal(
    choose("workflow_dispatch", "2026-11-17", { FULL_AUDIT: "true" }).source,
    "cache",
  );

  // No audit on record (the tracker of a repository that never ran one), no file, a file that
  // cannot be read: overdue, so a scheduled run does the full audit on any day, and nothing
  // throws. A manual and a repository_dispatch run are not affected.
  for (const text of [
    JSON.stringify({ lastRun: null, open: {}, issues: {} }),
    JSON.stringify({ lastFullAudit: null }),
    "{ not json",
    "",
  ]) {
    await writeFile(tracker, text);
    assert.equal(readLastFullAudit(tracker), null, text);
    for (const iso of ["2026-10-20", "2026-11-03", "2026-11-17"]) {
      assert.deepEqual(choose("schedule", iso), {
        source: "cache",
        lastFullAudit: null,
      });
    }
    assert.equal(choose("workflow_dispatch", "2026-11-17").source, "changes");
    assert.equal(choose("repository_dispatch", "2026-11-17").source, "changes");
  }
  assert.equal(readLastFullAudit(join(dir, "missing.json")), null);
  assert.equal(
    chooseSourceFromEnv(
      { EVENT_NAME: "schedule" },
      {
        trackerFile: join(dir, "missing.json"),
        now: new Date("2026-11-17T06:00:00Z"),
      },
    ).source,
    "cache",
  );

  // a value that is not a date is recorded, just not an audit date: it is read as it is, so it
  // stays malformed and is not mistaken for "none on record"
  for (const value of [20261006, "never"]) {
    await writeFile(tracker, JSON.stringify({ lastFullAudit: value }));
    assert.equal(readLastFullAudit(tracker), String(value));
    assert.deepEqual(choose("schedule", "2026-11-17"), {
      source: "changes",
      lastFullAudit: String(value),
    });
    assert.equal(choose("schedule", "2026-11-03").source, "cache");
  }
});

test("the workflow's --choose-source step reads the tracker named by TRACKER_FILE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-choose-cli-"));
  scratchDirs.push(dir);
  const tracker = join(dir, "tracker.json");
  const choose = (env) =>
    spawnSync(
      process.execPath,
      ["scripts/learn-url-check.mjs", "--choose-source"],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          EVENT_NAME: "",
          FULL_AUDIT: "",
          TRACKER_FILE: tracker,
          ...env,
        },
      },
    );
  // an audit from the year 2000 is overdue on whatever day this runs
  await writeFile(tracker, JSON.stringify({ lastFullAudit: "2000-01-01" }));
  let res = choose({ EVENT_NAME: "schedule" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "source=cache\n");
  assert.match(res.stderr, /last full audit 2000-01-01: full audit/);
  // a manual run that asks for the change files gets them
  res = choose({ EVENT_NAME: "workflow_dispatch", FULL_AUDIT: "false" });
  assert.equal(res.stdout, "source=changes\n");
  res = choose({ EVENT_NAME: "workflow_dispatch", FULL_AUDIT: "true" });
  assert.equal(res.stdout, "source=cache\n");
  // no audit on record, as in the tracker that is committed today: the scheduled run does it on
  // whatever day this runs, and a manual run that asks for the change files still gets them
  await writeFile(
    tracker,
    JSON.stringify({ lastRun: null, learnsync: null, open: {}, issues: {} }),
  );
  res = choose({ EVENT_NAME: "schedule" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "source=cache\n");
  assert.match(res.stderr, /no full audit on record: full audit/);
  res = choose({ EVENT_NAME: "workflow_dispatch", FULL_AUDIT: "false" });
  assert.equal(res.stdout, "source=changes\n");
  // choosing a source never fails because of the tracker (the check step reports a corrupt one,
  // see below): a file that cannot be read counts as no audit on record
  await writeFile(tracker, "{ not json");
  res = choose({ EVENT_NAME: "schedule" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "source=cache\n");
  assert.match(res.stderr, /no full audit on record: full audit/);
  res = choose({ EVENT_NAME: "repository_dispatch" });
  assert.equal(res.stdout, "source=changes\n");
});

test("changes mode fetches a sparse partial checkout, the full audit a full shallow clone", () => {
  const opts = { repo: "mscerts/learnsync", ref: "main", dir: "/tmp/ls" };
  const changes = checkoutCommands("changes", opts);
  assert.equal(changes.length, 2);
  const clone = changes[0].args;
  assert.deepEqual(clone.slice(0, 2), ["clone", "--depth"]);
  assert.ok(clone.includes("--filter=blob:none"));
  assert.ok(clone.includes("--sparse"));
  assert.ok(clone.includes("https://github.com/mscerts/learnsync.git"));
  assert.equal(clone.at(-1), "/tmp/ls");
  assert.equal(changes[0].inDir, undefined);
  assert.deepEqual(changes[1].args.slice(0, 3), [
    "sparse-checkout",
    "set",
    "--no-cone",
  ]);
  assert.equal(changes[1].inDir, true);
  // exactly what a changes run needs, none of the multi-MB caches
  assert.deepEqual(changes[1].args.slice(3), SPARSE_PATHS);
  assert.ok(SPARSE_PATHS.includes("/scripts/"));
  assert.ok(SPARSE_PATHS.includes("/data/changes/"));
  assert.ok(SPARSE_PATHS.includes("/data/status.json"));
  assert.ok(!SPARSE_PATHS.some((p) => /catalog|content|docs-/.test(p)));
  assert.ok(!SPARSE_PATHS.includes("/data/"));

  const full = checkoutCommands("cache", opts);
  assert.equal(full.length, 1);
  assert.ok(!full[0].args.includes("--sparse"));
  assert.ok(!full[0].args.includes("--filter=blob:none"));
  assert.ok(full[0].args.includes("--depth"));
});

// ---------------------------------------------------------------------------
// Changes mode: freshness of the change files, trust rules
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-10-06T08:00:00Z");
const ledgerOf = (sources) => ({
  removed: { sources, entries: [] },
  moved: { sources, entries: [] },
});

test("change files whose source stamp is older than 10 days are stale, with an issue note", () => {
  const fresh = ledgerFreshness(
    ledgerOf({
      learn: "2026-10-05T19:15:57.783Z",
      docs: "2026-10-05T19:55:18.359Z",
    }),
    NOW,
    10,
  );
  assert.deepEqual(fresh.staleFamilies, []);
  assert.equal(fresh.learn.stale, false);
  assert.deepEqual(ledgerNotes(fresh, 10), []);

  // docs refreshed 25 days ago: stale; exactly 10 days is still fresh
  const docsOld = ledgerFreshness(
    ledgerOf({
      learn: "2026-10-05T19:15:57.783Z",
      docs: "2026-09-11T08:00:00.000Z",
    }),
    NOW,
    10,
  );
  assert.deepEqual(docsOld.staleFamilies, ["docs"]);
  assert.equal(docsOld.docs.ageDays, 25);
  const notes = ledgerNotes(docsOld, 10);
  assert.equal(notes.length, 1);
  assert.match(
    notes[0],
    /docs entries of the change files were last refreshed 2026-09-11/,
  );
  assert.match(notes[0], /25 days ago, limit 10/);
  assert.match(notes[0], /live-confirmed before it was reported/);
  assert.equal(
    ledgerFreshness(
      ledgerOf({
        learn: "2026-09-26T08:00:00.000Z",
        docs: "2026-09-26T08:00:00.000Z",
      }),
      NOW,
      10,
    ).staleFamilies.length,
    0,
  );
  assert.deepEqual(
    ledgerFreshness(
      ledgerOf({
        learn: "2026-09-26T07:59:00.000Z",
        docs: "2026-09-26T08:00:00.000Z",
      }),
      NOW,
      10,
    ).staleFamilies,
    ["learn"],
  );

  // never refreshed (no stamp at all) is stale and says so
  const never = ledgerFreshness(ledgerOf({ learn: null, docs: null }), NOW, 10);
  assert.deepEqual(never.staleFamilies, ["learn", "docs"]);
  assert.match(
    ledgerNotes(never, 10)[0],
    /no Learn refresh stamp \(sources\.learn is null\)/,
  );
  assert.deepEqual(
    ledgerFreshness({ removed: {}, moved: undefined }, NOW, 10).staleFamilies,
    ["learn", "docs"],
  );

  // the two files are judged by the older stamp; a missing stamp in one file is ignored
  const split = ledgerFreshness(
    {
      removed: { sources: { learn: "2026-10-05T00:00:00Z", docs: null } },
      moved: {
        sources: {
          learn: "2026-09-01T00:00:00Z",
          docs: "2026-10-05T00:00:00Z",
        },
      },
    },
    NOW,
    10,
  );
  assert.equal(split.learn.stamp, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(split.staleFamilies, ["learn"]);
  assert.equal(split.docs.stamp, "2026-10-05T00:00:00.000Z");
});

test("the heartbeat notes cover a missing, old or incomplete learnsync sync", () => {
  assert.match(heartbeatNotes(null, NOW, 48)[0], /no heartbeat/);
  const ok = {
    learn: { generatedAt: "2026-10-05T19:00:00Z" },
    docs: { generatedAt: "2026-10-05T19:55:00Z", complete: true },
  };
  assert.deepEqual(heartbeatNotes(ok, NOW, 48), []);
  const old = heartbeatNotes(
    { learn: { generatedAt: "2026-10-01T00:00:00Z" }, docs: {} },
    NOW,
    48,
  );
  assert.match(old[0], /Learn sync heartbeat is 128 hours old \(limit 48\)/);
  assert.match(old[1], /no docs heartbeat yet/);
  assert.match(
    heartbeatNotes(
      { ...ok, docs: { ...ok.docs, complete: false } },
      NOW,
      48,
    )[0],
    /docs index was incomplete.*removal detection was off/,
  );
});

test("a ledger entry is trusted without a probe only when it was verified within 14 days", () => {
  assert.equal(recentlyVerified("2026-10-06", "2026-10-06", 14), true);
  assert.equal(recentlyVerified("2026-09-22", "2026-10-06", 14), true);
  assert.equal(recentlyVerified("2026-09-21", "2026-10-06", 14), false);
  assert.equal(recentlyVerified(null, "2026-10-06", 14), false);
  assert.equal(recentlyVerified("yesterday", "2026-10-06", 14), false);
  assert.equal(recentlyVerified("2026-10-07", "2026-10-06", 14), false); // from the future: not evidence

  const entry = (extra = {}) => ({
    outcome: "gone",
    family: "learn",
    lastVerified: "2026-10-05",
    ...extra,
  });
  const hit = (extra = {}, over = {}) => ({
    state: "removed",
    confidence: "high",
    entry: entry(),
    final: entry(),
    ...over,
    ...extra,
  });
  const opts = { today: "2026-10-06", trustDays: 14, staleFamilies: [] };
  assert.equal(needsLiveConfirmation(hit(), opts), false);
  // low confidence (inherited move, cycle, truncated chain, unverified) is always confirmed
  assert.equal(needsLiveConfirmation(hit({ confidence: "low" }), opts), true);
  assert.equal(
    needsLiveConfirmation(
      hit(
        {},
        { entry: entry({ outcome: "unverified", lastVerified: "2026-10-05" }) },
      ),
      opts,
    ),
    true,
  );
  // never verified or verified long ago
  assert.equal(
    needsLiveConfirmation(
      hit(
        {},
        {
          entry: entry({ lastVerified: null }),
          final: entry({ lastVerified: null }),
        },
      ),
      opts,
    ),
    true,
  );
  assert.equal(
    needsLiveConfirmation(
      hit({}, { final: entry({ lastVerified: "2026-08-01" }) }),
      opts,
    ),
    true,
  );
  // a chain is only as fresh as its oldest entry
  assert.equal(
    needsLiveConfirmation(
      hit({}, { entry: entry({ lastVerified: "2026-08-01" }) }),
      opts,
    ),
    true,
  );
  // a stale family is never trusted from the file alone
  assert.equal(
    needsLiveConfirmation(hit(), { ...opts, staleFamilies: ["learn"] }),
    true,
  );
  assert.equal(
    needsLiveConfirmation(hit(), { ...opts, staleFamilies: ["docs"] }),
    false,
  );
  assert.equal(
    needsLiveConfirmation(
      hit(
        {},
        { entry: entry({ family: "docs" }), final: entry({ family: "docs" }) },
      ),
      { ...opts, staleFamilies: ["docs"] },
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Changes mode: findings from a fixture ledger. `lookup` is learnsync's
// lookupChange; these hits have exactly the shape it returns (taken from the
// real library over the same fixture), see the test with the real library below.
// ---------------------------------------------------------------------------
const e = (path, outcome, extra = {}) => ({
  path,
  kind: "module",
  family: "learn",
  outcome,
  to: null,
  title: null,
  parent: null,
  firstSeen: "2026-09-21",
  lastVerified: "2026-10-05",
  evidence: "tombstone",
  status: 404,
  ...extra,
});
const GONE = e("/training/modules/gone", "gone");
const MOVED_BLOB = e("/training/modules/blob", "moved", {
  to: "/training/modules/blob-v2",
  evidence: "rename",
  firstSeen: "2026-10-02",
  status: 301,
});
const MOVED_PWD = e("/training/modules/pwd", "moved", {
  to: "/training/modules/pwd-dead",
  evidence: "rename",
  status: 301,
});
const PWD_DEAD = e("/training/modules/pwd-dead", "gone");
const UNVERIFIED = e("/training/modules/maybe", "unverified", {
  lastVerified: null,
  status: null,
  firstSeen: "2026-10-04",
});
const OLD_UNIT = e("/training/modules/m/7-old", "gone", {
  kind: "unit",
  parent: "/training/modules/m",
  evidence: "unit-diff",
  firstSeen: "2026-07-20",
  lastVerified: "2026-08-01",
});
const DOCS_MOVED = e("/azure/old-page", "moved", {
  kind: "docs",
  family: "docs",
  to: "/azure/new-page",
  evidence: "docs-redirect",
  status: 301,
  lastVerified: "2026-10-04",
});
// removed links that Learn still answers by sending visitors somewhere else: `to` is where they land, not a replacement
const LANDING_MODULE = e("/training/modules/landing-mod", "landing", {
  to: "/training/browse",
  status: 301,
});
const LANDING_UNIT = e("/training/modules/m2/5-old", "landing", {
  kind: "unit",
  parent: "/training/modules/m2",
  to: "/training/modules/m2",
  evidence: "unit-diff",
  status: 301,
});
const LANDING_DOCS = e("/azure/old/page", "landing", {
  kind: "docs",
  family: "docs",
  to: "/azure/old",
  evidence: "docs-redirect",
  status: 301,
  lastVerified: "2026-10-04",
});
const landingHit = (entry) => ({
  state: "removed",
  outcome: "landing",
  confidence: "high",
  match: "exact",
  entry,
  final: entry,
  to: entry.to,
  chain: [entry.path],
  cycle: false,
  truncated: false,
  reason: `${entry.path} was removed [landing]`,
});

const HITS = {
  // exact hit: removed
  "/training/modules/gone": {
    state: "removed",
    outcome: "gone",
    confidence: "high",
    match: "exact",
    entry: GONE,
    final: GONE,
    to: null,
    chain: ["/training/modules/gone"],
    cycle: false,
    truncated: false,
    reason: "/training/modules/gone was removed [gone]",
  },
  // a unit of a removed module is removed (inherited)
  "/training/modules/gone/3-exercise": {
    state: "removed",
    outcome: "gone",
    confidence: "high",
    match: "ancestor",
    entry: GONE,
    final: GONE,
    to: null,
    chain: ["/training/modules/gone/3-exercise"],
    cycle: false,
    truncated: false,
    reason: "its module /training/modules/gone was removed [gone]",
  },
  // a unit of a moved module probably moved too: low confidence
  "/training/modules/blob/9-sim": {
    state: "moved",
    outcome: "moved",
    confidence: "low",
    match: "ancestor",
    entry: MOVED_BLOB,
    final: MOVED_BLOB,
    to: "/training/modules/blob-v2/9-sim",
    chain: ["/training/modules/blob/9-sim", "/training/modules/blob-v2/9-sim"],
    cycle: false,
    truncated: false,
    reason:
      "moved to /training/modules/blob-v2/9-sim (its module /training/modules/blob moved to /training/modules/blob-v2)",
  },
  // an exact move is high confidence
  "/training/modules/blob": {
    state: "moved",
    outcome: "moved",
    confidence: "high",
    match: "exact",
    entry: MOVED_BLOB,
    final: MOVED_BLOB,
    to: "/training/modules/blob-v2",
    chain: ["/training/modules/blob", "/training/modules/blob-v2"],
    cycle: false,
    truncated: false,
    reason: "moved to /training/modules/blob-v2",
  },
  // the destination of a move was removed: the link counts as removed
  "/training/modules/pwd": {
    state: "removed",
    outcome: "gone",
    confidence: "high",
    match: "exact",
    entry: MOVED_PWD,
    final: PWD_DEAD,
    to: null,
    chain: ["/training/modules/pwd", "/training/modules/pwd-dead"],
    cycle: false,
    truncated: false,
    reason: "moved to /training/modules/pwd-dead, which was removed [gone]",
  },
  "/training/modules/maybe": {
    state: "removed",
    outcome: "unverified",
    confidence: "low",
    match: "exact",
    entry: UNVERIFIED,
    final: UNVERIFIED,
    to: null,
    chain: ["/training/modules/maybe"],
    cycle: false,
    truncated: false,
    reason: "/training/modules/maybe was removed [unverified]",
  },
  "/training/modules/m/7-old": {
    state: "removed",
    outcome: "gone",
    confidence: "high",
    match: "exact",
    entry: OLD_UNIT,
    final: OLD_UNIT,
    to: null,
    chain: ["/training/modules/m/7-old"],
    cycle: false,
    truncated: false,
    reason: "/training/modules/m/7-old was removed [gone]",
  },
  "/azure/old-page": {
    state: "moved",
    outcome: "moved",
    confidence: "high",
    match: "exact",
    entry: DOCS_MOVED,
    final: DOCS_MOVED,
    to: "/azure/new-page",
    chain: ["/azure/old-page", "/azure/new-page"],
    cycle: false,
    truncated: false,
    reason: "moved to /azure/new-page",
  },
  "/training/modules/landing-mod": landingHit(LANDING_MODULE),
  "/training/modules/m2/5-old": landingHit(LANDING_UNIT),
  "/azure/old/page": landingHit(LANDING_DOCS),
};

const repoOf = (paths) =>
  new Map(
    paths.map((p, i) => [
      p,
      {
        raws: new Set([`https://learn.microsoft.com${p}`]),
        locations: [`src/page${i}.mdx:${i + 1}`],
      },
    ]),
  );

/** Stand-in for learnsync's liveLayer: records what it was asked to probe; `answers` maps a path to a live outcome. */
function fakeLiveLayer(answers) {
  const calls = [];
  const layer = async (results, options) => {
    calls.push({ paths: results.map((r) => r.path), options });
    return {
      probed: results.length,
      results: results.map((r) => {
        const a = answers[r.path] ?? { verdict: "unknown" };
        const base = { ...r, cacheVerdict: r.verdict, cacheReason: r.reason };
        if (a.verdict === "ok") {
          return {
            ...base,
            verdict: "valid",
            evidence: "live-probe",
            reason: "live check: page is reachable",
            confidence: "high",
            redirectsTo: null,
            suggestion: null,
          };
        }
        if (a.verdict === "broken" || a.verdict === "moved") {
          const destination = a.to
            ? `https://learn.microsoft.com${a.to}`
            : null;
          return {
            ...base,
            verdict: a.verdict,
            evidence: "live-probe",
            reason: `live check: ${a.detail}`,
            confidence: "high",
            redirectsTo: a.to ?? null,
            // like learnsync's applyProbe: a broken verdict keeps the suggestion it came with, a moved one has only the live destination
            suggestion:
              a.verdict === "broken"
                ? (destination ?? r.suggestion ?? null)
                : destination,
          };
        }
        return {
          ...base,
          liveNote: "live check inconclusive (HTTP 429); cached verdict kept",
        };
      }),
    };
  };
  layer.calls = calls;
  return layer;
}

const run = (paths, answers = {}, extra = {}) => {
  const liveLayer = fakeLiveLayer(answers);
  const repoUrls = repoOf(paths);
  return evaluateChanges({
    repoUrls,
    lookup: (p) => HITS[p] ?? null,
    liveLayer,
    today: "2026-10-06",
    trustDays: 14,
    staleFamilies: [],
    ...extra,
  }).then((out) => ({ ...out, liveLayer, repoUrls }));
};

test("a recorded change verified recently is a finding without a live probe; no change recorded is never probed", async () => {
  const { results, stats, liveLayer, repoUrls } = await run([
    "/training/modules/gone", // exact removal
    "/training/modules/gone/3-exercise", // inherited from the removed module
    "/training/modules/pwd", // moved to something that was removed
    "/training/modules/blob", // exact move
    "/training/modules/never-changed", // no recorded change
    "/azure/untouched",
  ]);
  assert.equal(liveLayer.calls.length, 0, "nothing needed a live probe");
  const findings = toFindings(results, repoUrls);
  assert.deepEqual(
    findings.map((f) => [f.path, f.kind, f.evidence]),
    [
      ["/training/modules/gone", "broken", "changes-ledger"],
      ["/training/modules/gone/3-exercise", "broken", "changes-ledger"],
      ["/training/modules/pwd", "broken", "changes-ledger"],
      ["/training/modules/blob", "moved", "changes-ledger"],
    ],
  );
  assert.match(
    findings[0].reason,
    /\/training\/modules\/gone was removed \[gone\]; first recorded 2026-09-21, last verified 2026-10-05/,
  );
  assert.match(
    findings[1].reason,
    /its module \/training\/modules\/gone was removed/,
  );
  assert.match(
    findings[2].reason,
    /moved to \/training\/modules\/pwd-dead, which was removed/,
  );
  assert.equal(
    findings[3].suggestion,
    "https://learn.microsoft.com/training/modules/blob-v2",
  );
  assert.deepEqual(findings[0].locations, ["src/page0.mdx:1"]);
  assert.equal(
    findings[0].url,
    "https://learn.microsoft.com/training/modules/gone",
  );
  assert.deepEqual(stats, {
    total: 6,
    recorded: 4,
    recordedRemoved: 3,
    recordedMoved: 1,
    ledgerOnly: 4,
    probed: 0,
    clearedByLive: 0,
    unsettled: 0,
  });
});

test("low-confidence, unverified, old and stale-family entries are live-confirmed first", async () => {
  const paths = [
    "/training/modules/blob/9-sim", // inherited move: low confidence
    "/training/modules/maybe", // never verified
    "/training/modules/m/7-old", // last verified 2026-08-01
    "/training/modules/gone", // fresh and high confidence: not probed
    "/azure/old-page", // docs entry, verified recently
  ];
  const { results, liveLayer, stats, cleared, repoUrls } = await run(
    paths,
    {
      "/training/modules/blob/9-sim": {
        verdict: "moved",
        detail: "redirects to /training/modules/blob-v2/9-sim",
        to: "/training/modules/blob-v2/9-sim",
      },
      "/training/modules/maybe": { verdict: "ok" }, // the page works: the ledger was wrong
      "/training/modules/m/7-old": { verdict: "broken", detail: "HTTP 404" },
    },
    { staleFamilies: ["docs"] },
  );
  assert.equal(liveLayer.calls.length, 1);
  assert.deepEqual(liveLayer.calls[0].paths.sort(), [
    "/azure/old-page", // stale docs family: never reported from the file alone
    "/training/modules/blob/9-sim",
    "/training/modules/m/7-old",
    "/training/modules/maybe",
  ]);
  assert.equal(liveLayer.calls[0].options.confirmLive, true);
  assert.equal(
    liveLayer.calls[0].options.probeUnverifiable,
    false,
    "a changes run never probes unrecorded kinds",
  );
  const findings = toFindings(results, repoUrls);
  const byPath = Object.fromEntries(findings.map((f) => [f.path, f]));
  // the live probe confirmed these: labelled live-probe, the ledger's reason is kept for context
  assert.equal(byPath["/training/modules/blob/9-sim"].evidence, "live-probe");
  assert.equal(byPath["/training/modules/blob/9-sim"].kind, "moved");
  assert.match(
    byPath["/training/modules/blob/9-sim"].cacheReason,
    /its module \/training\/modules\/blob moved/,
  );
  assert.equal(byPath["/training/modules/m/7-old"].evidence, "live-probe");
  assert.equal(byPath["/training/modules/m/7-old"].kind, "broken");
  // untouched by any probe
  assert.equal(byPath["/training/modules/gone"].evidence, "changes-ledger");
  // the live probe says the link works: dropped, and the tracker may resolve it
  assert.equal(byPath["/training/modules/maybe"], undefined);
  assert.deepEqual([...cleared], ["/training/modules/maybe"]);
  // the stale-family docs entry went through the probe, which could not settle it: a
  // high-confidence ledger verdict is kept (with the live note), as the cache path does
  assert.equal(byPath["/azure/old-page"].kind, "moved");
  assert.equal(byPath["/azure/old-page"].evidence, "changes-ledger");
  assert.deepEqual(stats, {
    total: 5,
    recorded: 5,
    recordedRemoved: 3,
    recordedMoved: 2,
    ledgerOnly: 1,
    probed: 4,
    clearedByLive: 1,
    unsettled: 0,
  });
});

test("a low-confidence entry the live check cannot settle is dropped, never reported from the file alone", async () => {
  const { results, stats, cleared, repoUrls } = await run(
    ["/training/modules/blob/9-sim", "/training/modules/maybe"],
    {}, // every probe is inconclusive (429 / timeout)
  );
  assert.deepEqual(toFindings(results, repoUrls), []);
  assert.equal(stats.recorded, 2);
  assert.equal(stats.probed, 2);
  assert.equal(stats.unsettled, 2);
  assert.equal(stats.clearedByLive, 0);
  // not cleared either: a tracked URL stays open
  assert.equal(cleared.size, 0);
});

test("a ledger hit becomes a validator-shaped result for the shared findings and live layer", () => {
  const info = repoOf(["/training/modules/blob"]).get("/training/modules/blob");
  const result = ledgerResult(
    "/training/modules/blob",
    info,
    HITS["/training/modules/blob"],
  );
  assert.deepEqual(
    {
      verdict: result.verdict,
      evidence: result.evidence,
      confidence: result.confidence,
      kind: result.kind,
      redirectsTo: result.redirectsTo,
    },
    {
      verdict: "moved",
      evidence: "changes-ledger",
      confidence: "high",
      kind: "module",
      redirectsTo: "/training/modules/blob-v2",
    },
  );
  const gone = ledgerResult(
    "/training/modules/gone",
    info,
    HITS["/training/modules/gone"],
  );
  assert.equal(gone.verdict, "broken");
  assert.equal(gone.suggestion, null);
});

test("a removed link's landing page is its destination at most, never the suggested fix; only a high-confidence move suggests", async () => {
  const info = repoOf(["/x"]).get("/x");
  // removed + landing (module -> Browse all training, unit -> its module root, docs -> an ancestor page)
  for (const path of [
    "/training/modules/landing-mod",
    "/training/modules/m2/5-old",
    "/azure/old/page",
  ]) {
    const result = ledgerResult(path, info, HITS[path]);
    assert.equal(result.verdict, "broken", path);
    assert.equal(
      result.suggestion,
      null,
      `${path}: a landing page is not a replacement`,
    );
    assert.equal(
      result.redirectsTo,
      HITS[path].to,
      `${path}: it may still say where visitors land`,
    );
  }
  // a low-confidence (inherited) move is a guess: neither destination nor suggestion until a live probe names one
  const inherited = ledgerResult(
    "/training/modules/blob/9-sim",
    info,
    HITS["/training/modules/blob/9-sim"],
  );
  assert.deepEqual(
    [inherited.verdict, inherited.redirectsTo, inherited.suggestion],
    ["moved", null, null],
  );
  // an unverified removal has no destination either
  assert.equal(
    ledgerResult(
      "/training/modules/maybe",
      info,
      HITS["/training/modules/maybe"],
    ).suggestion,
    null,
  );
  // a high-confidence move does
  const moved = ledgerResult(
    "/training/modules/blob",
    info,
    HITS["/training/modules/blob"],
  );
  assert.deepEqual(
    [moved.redirectsTo, moved.suggestion],
    [
      "/training/modules/blob-v2",
      "https://learn.microsoft.com/training/modules/blob-v2",
    ],
  );
  // a move whose destination was removed counts as removed: no suggestion, whatever `to` says
  assert.equal(
    ledgerResult("/training/modules/pwd", info, HITS["/training/modules/pwd"])
      .suggestion,
    null,
  );

  // through the whole pipeline, recorded and live-confirmed alike (the live layer keeps what it was given when the page is
  // still gone, so a landing page that leaked into `suggestion` here would reach the issue)
  const recorded = await run([
    "/training/modules/landing-mod",
    "/training/modules/m2/5-old",
  ]);
  assert.equal(
    recorded.liveLayer.calls.length,
    0,
    "fresh and high confidence: reported as recorded",
  );
  assert.deepEqual(
    toFindings(recorded.results, recorded.repoUrls).map((f) => [
      f.path,
      f.kind,
      f.suggestion,
    ]),
    [
      ["/training/modules/landing-mod", "broken", null],
      ["/training/modules/m2/5-old", "broken", null],
    ],
  );
  const stale = await run(
    ["/training/modules/landing-mod"],
    {
      "/training/modules/landing-mod": {
        verdict: "broken",
        detail: "removed (redirects to Browse all training)",
      },
    },
    { today: "2026-12-01" },
  );
  assert.equal(
    stale.liveLayer.calls.length,
    1,
    "verified long ago: live-confirmed first",
  );
  const [confirmed] = toFindings(stale.results, stale.repoUrls);
  assert.deepEqual(
    [confirmed.evidence, confirmed.kind, confirmed.suggestion],
    ["live-probe", "broken", null],
  );
});

test("the issue's table shows no suggested fix for a removed link that only lands on a hub page", () => {
  const url = "https://learn.microsoft.com/training/modules/landing-mod";
  const results = [
    ledgerResult(
      "/training/modules/landing-mod",
      { raws: new Set([url]) },
      HITS["/training/modules/landing-mod"],
    ),
    ledgerResult(
      "/training/modules/blob",
      { raws: new Set(["https://learn.microsoft.com/training/modules/blob"]) },
      HITS["/training/modules/blob"],
    ),
  ];
  const repoUrls = new Map([
    [
      "/training/modules/landing-mod",
      { raws: new Set([url]), locations: ["src/a.mdx:1"] },
    ],
    [
      "/training/modules/blob",
      {
        raws: new Set(["https://learn.microsoft.com/training/modules/blob"]),
        locations: ["src/b.mdx:2"],
      },
    ],
  ]);
  const report = buildReport({
    findings: toFindings(results, repoUrls),
    data: {
      sha: "89abcdef0123",
      learnGeneratedAt: null,
      docsGeneratedAt: null,
    },
    summary: null,
    today: "2026-10-06",
    runUrl: null,
    notes: [],
    mode: "changes",
    coverage: {
      total: 2,
      recorded: 2,
      recordedRemoved: 1,
      recordedMoved: 1,
      ledgerOnly: 2,
      probed: 0,
      clearedByLive: 0,
      unsettled: 0,
      trustDays: 14,
      nextFullAudit: null,
      ledger: {
        sha: "89abcdef0123",
        learnStamp: null,
        docsStamp: null,
        learnEntries: 2,
        docsEntries: 0,
        total: 2,
      },
    },
  });
  const rowOf = (needle) =>
    report
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(needle));
  assert.match(rowOf(url), /\| — \|$/, "the removed link: nothing to suggest");
  assert.ok(!rowOf(url).includes("/training/browse"));
  assert.match(
    rowOf("/training/modules/blob"),
    /\| https:\/\/learn\.microsoft\.com\/training\/modules\/blob-v2 \|$/,
    "the moved link: its new address",
  );
});

test("tracked URLs a changes run has no opinion on stay open; cleared, flagged and removed ones do not", () => {
  const open = {
    "https://learn.microsoft.com/a": {}, // typo from a full audit: no ledger entry, still in the repo
    "https://learn.microsoft.com/b": {}, // flagged again now
    "https://learn.microsoft.com/c": {}, // live probe says it works
    "https://learn.microsoft.com/d": {}, // no longer in the repo
    "https://learn.microsoft.com/E/": {}, // other spelling of a path that is flagged now
  };
  const present = new Set([
    "https://learn.microsoft.com/a",
    "https://learn.microsoft.com/b",
    "https://learn.microsoft.com/c",
    "https://learn.microsoft.com/E/",
  ]);
  const kept = carryOver(open, {
    present,
    flaggedPaths: new Set(["/b", "/e"]),
    clearedPaths: new Set(["/c"]),
    pathOf: (u) => canonical(u) || "",
  });
  assert.deepEqual(kept, ["https://learn.microsoft.com/a"]);
});

test("the change-file report says what the run checked, what it did not and how fresh the ledger is", () => {
  const finding = {
    url: "https://learn.microsoft.com/training/modules/gone",
    path: "/training/modules/gone",
    kind: "broken",
    reason:
      "/training/modules/gone was removed [gone]; first recorded 2026-09-21, last verified 2026-10-05",
    evidence: "changes-ledger",
    locations: ["src/a.mdx:1"],
    suggestion: null,
  };
  const live = {
    url: "https://learn.microsoft.com/training/modules/m/7-old",
    path: "/training/modules/m/7-old",
    kind: "broken",
    reason: "live check: HTTP 404",
    cacheReason:
      "/training/modules/m/7-old was removed [gone]; first recorded 2026-07-20, last verified 2026-08-01",
    evidence: "live-probe",
    locations: ["src/b.mdx:2"],
    suggestion: null,
  };
  const coverage = {
    total: 1400,
    recorded: 12,
    recordedRemoved: 9,
    recordedMoved: 3,
    ledgerOnly: 6,
    probed: 6,
    clearedByLive: 4,
    unsettled: 1,
    trustDays: 14,
    nextFullAudit: "2026-11-03",
    ledger: {
      sha: "89abcdef0123",
      learnStamp: "2026-10-05T19:15:57.783Z",
      docsStamp: "2026-09-20T08:00:00.000Z",
      learnEntries: 7,
      docsEntries: 1,
      total: 8,
    },
  };
  const report = buildReport({
    findings: [finding, live],
    data: {
      sha: "89abcdef0123",
      learnGeneratedAt: null,
      docsGeneratedAt: null,
    },
    summary: null,
    today: "2026-10-06",
    runUrl: null,
    notes: [
      "The docs entries of the change files were last refreshed 2026-09-20.",
    ],
    mode: "changes",
    coverage,
  });
  // what was looked up and found
  assert.match(report, /change-file run/);
  assert.match(report, /looked up: \*\*1400\*\*/);
  assert.match(
    report,
    /recorded change[^\n]*\*\*12\*\* \(9 removed, 3 moved\)/,
  );
  assert.match(
    report,
    /without a live probe[^\n]*within the last 14 days\): 6/,
  );
  assert.match(
    report,
    /Live-confirmed on 2026-10-06[^\n]*: 6\. Of these 4 turned out to work/,
  );
  // what it did not check
  assert.match(
    report,
    /Not probed at all: every URL with no recorded change\. "No change recorded" is not "valid"/,
  );
  assert.match(report, /Not covered by change-file runs/);
  for (const kind of [
    "shows",
    "collections",
    "practice assessments",
    "legacy `/certifications/` paths",
    "credentials support pages",
    "typos",
  ]) {
    assert.ok(report.includes(kind), `coverage names ${kind}`);
  }
  assert.match(
    report,
    /Only the monthly full audit checks those: the first Tuesday of each month/,
  );
  assert.match(report, /`full_audit` input/);
  assert.match(report, /next scheduled one is 2026-11-03/);
  // ledger freshness and commit
  assert.match(
    report,
    /learnsync commit `89abcde`, Learn entries refreshed 2026-10-05T19:15:57\.783Z, docs entries refreshed 2026-09-20/,
  );
  assert.match(report, /8 entries recorded \(7 Learn, 1 docs\)/);
  assert.match(report, /change files at commit `89abcde`/);
  // evidence per finding, the ledger's view next to a live verdict, the stale note
  assert.match(report, /evidence: `changes-ledger`/);
  assert.match(report, /evidence: `live-probe`/);
  assert.match(
    report,
    /live check: HTTP 404 \(change files said: \/training\/modules\/m\/7-old was removed/,
  );
  assert.match(
    report,
    /> The docs entries of the change files were last refreshed 2026-09-20\./,
  );
  // the cache-mode wording is not used
  assert.ok(!/Valid: \d+\./.test(report));
  assert.ok(!/validator at commit/.test(report));
  assert.match(report, /### How to fix/);
});

test("the full-audit report keeps its original wording", () => {
  const report = buildReport({
    findings: [
      {
        url: "https://learn.microsoft.com/training/modules/gone",
        kind: "broken",
        reason: "module removed",
        evidence: "live-probe",
        cacheReason: "old",
        locations: ["src/a.mdx:1"],
      },
    ],
    data: { sha: "0123456789", learnGeneratedAt: "L", docsGeneratedAt: "D" },
    summary: { total: 4, byVerdict: { valid: 2, broken: 1, unverifiable: 1 } },
    today: "2026-10-06",
    notes: [],
  });
  assert.match(
    report,
    /validator at commit `0123456` \(Learn data generated L, docs data generated D\)\. Every link below was re-confirmed against the live site on 2026-10-06\./,
  );
  assert.match(
    report,
    /Unique Learn URLs in the repo: \*\*4\*\*\. Valid: 2\. Broken: 1\. Moved: 0\. Could not be verified by any cache or live probe: 1\./,
  );
  assert.ok(!report.includes("change-file run"));
  assert.ok(!report.includes("evidence:"));
  assert.ok(!report.includes("change files said"));
});

// ---------------------------------------------------------------------------
// The same ledger through learnsync's REAL library, when a checkout is at hand
// (LEARNSYNC_DIR=<learnsync checkout with scripts/lib/changes.mjs>). Skipped
// otherwise: the lookup logic lives in learnsync and is covered there.
// ---------------------------------------------------------------------------
const realLib = process.env.LEARNSYNC_DIR
  ? join(process.env.LEARNSYNC_DIR, "scripts", "lib", "changes.mjs")
  : null;

test(
  "findings from a fixture ledger through learnsync's real lookupChange",
  { skip: !realLib || !existsSync(realLib) },
  async () => {
    const lib = await import(pathToFileURL(realLib).href);
    const dir = await mkdtemp(join(tmpdir(), "learn-url-ledger-"));
    await mkdir(join(dir, "changes"), { recursive: true });
    const stamp = {
      learn: "2026-10-05T19:15:57.783Z",
      docs: "2026-10-05T19:55:18.359Z",
    };
    const file = (entries) => ({
      schemaVersion: 1,
      generatedAt: stamp.docs,
      sources: stamp,
      entries,
    });
    const strip = ({ ...x }) => x;
    await writeFile(
      join(dir, "changes", "removed.json"),
      JSON.stringify(
        file([
          strip(GONE),
          strip(PWD_DEAD),
          strip(UNVERIFIED),
          strip(LANDING_MODULE),
        ]),
      ),
    );
    await writeFile(
      join(dir, "changes", "moved.json"),
      JSON.stringify(file([strip(MOVED_BLOB), strip(MOVED_PWD)])),
    );
    const changes = lib.loadChanges(dir);
    const index = lib.indexChanges(changes);
    const liveLayer = fakeLiveLayer({
      "/training/modules/maybe": { verdict: "ok" },
    });
    const repoUrls = repoOf([
      "/training/modules/gone",
      "/training/modules/gone/3-exercise",
      "/training/modules/blob/9-sim",
      "/training/modules/pwd",
      "/training/modules/landing-mod",
      "/training/modules/maybe",
      "/training/modules/clean",
    ]);
    const out = await evaluateChanges({
      repoUrls,
      lookup: (p) => lib.lookupChange(p, index),
      liveLayer,
      today: "2026-10-06",
      trustDays: 14,
      staleFamilies: ledgerFreshness(changes, NOW, 10).staleFamilies,
    });
    assert.deepEqual(liveLayer.calls[0].paths.sort(), [
      "/training/modules/blob/9-sim",
      "/training/modules/maybe",
    ]);
    assert.deepEqual(
      toFindings(out.results, repoUrls).map((f) => [
        f.path,
        f.kind,
        f.evidence,
      ]),
      [
        ["/training/modules/gone", "broken", "changes-ledger"],
        ["/training/modules/gone/3-exercise", "broken", "changes-ledger"],
        // inherited move: low confidence, the unsettled live probe drops it
        ["/training/modules/pwd", "broken", "changes-ledger"],
        // a removed module that Learn sends to Browse all training: a broken link with nothing to suggest
        ["/training/modules/landing-mod", "broken", "changes-ledger"],
      ],
    );
    const landing = out.results.find(
      (r) => r.path === "/training/modules/landing-mod",
    );
    assert.deepEqual(
      [landing.redirectsTo, landing.suggestion],
      ["/training/browse", null],
    );
    assert.equal(out.stats.recorded, 6);
    assert.deepEqual([...out.cleared], ["/training/modules/maybe"]);
  },
);

// ---------------------------------------------------------------------------
// End to end: the real script against a fake learnsync checkout (LEARNSYNC_DIR)
// and a scratch repo (REPO_ROOT). The fake libraries only implement the few
// functions the client calls; the real ones are covered in learnsync.
// ---------------------------------------------------------------------------
const FAKE_LIBS = {
  "canonical.mjs": `
export function canonicalPath(input) {
  try {
    const u = new URL(input);
    if (u.hostname !== "learn.microsoft.com") return null;
    return (u.pathname.replace(/^\\/[a-z]{2}-[a-z]{2}(?=\\/)/i, "").replace(/\\/+$/, "") || "/").toLowerCase();
  } catch { return null; }
}`,
  "changes.mjs": `
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const read = (dir, f) => existsSync(join(dir, "changes", f))
  ? JSON.parse(readFileSync(join(dir, "changes", f), "utf8"))
  : { sources: { learn: null, docs: null }, entries: [] };
export function loadChanges(dataDir) { return { removed: read(dataDir, "removed.json"), moved: read(dataDir, "moved.json") }; }
export function indexChanges(c) {
  const byPath = new Map();
  for (const [file, set] of Object.entries(c)) for (const entry of set.entries) byPath.set(entry.path, { file, entry });
  return { byPath };
}
export function lookupChange(path, index) {
  const hit = index.byPath.get(path);
  if (!hit) return null;
  const removed = hit.file === "removed";
  return { state: removed ? "removed" : "moved", outcome: hit.entry.outcome,
    confidence: hit.entry.outcome === "unverified" ? "low" : "high", match: "exact",
    entry: hit.entry, final: hit.entry, to: hit.entry.to ?? null, chain: [path], cycle: false, truncated: false,
    reason: removed ? path + " was removed [" + hit.entry.outcome + "]" : "moved to " + hit.entry.to };
}
export function summarizeChanges(c) {
  const n = (file, family) => c[file].entries.filter((e) => e.family === family).length;
  return { byFamily: { learn: { removed: n("removed", "learn"), moved: n("moved", "learn") }, docs: { removed: n("removed", "docs"), moved: n("moved", "docs") } } };
}`,
  "live-probe.mjs": `
import { appendFileSync } from "node:fs";
export async function liveLayer(results, options) {
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ options, paths: results.map((r) => r.path) }) + "\\n");
  return { probed: results.length, results: results.map((r) => r.path.includes("works")
    ? { ...r, cacheVerdict: r.verdict, cacheReason: r.reason, verdict: "valid", evidence: "live-probe", reason: "live check: page is reachable", confidence: "high" }
    : r) };
}`,
  "validate.mjs": `
export function loadData() { return { missing: [] }; }
export function summarize(results) {
  const byVerdict = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return { total: results.length, byVerdict, byKind: {} };
}
export function validateUrls(urls) {
  const results = urls.map((url) => {
    const path = new URL(url).pathname.replace(/\\/+$/, "").toLowerCase();
    return { url, path, kind: "module", verdict: path.includes("dead") ? "broken" : "valid", reason: "tombstoned", evidence: "learn-catalog", confidence: "high", suggestion: null };
  });
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  return { results, summary: summarize(results), freshness: { missingFiles: [], learnGeneratedAt: ago(Number(process.env.FAKE_CACHE_LEARN_DAYS || 0.4)), learnAgeHours: 10, docsGeneratedAt: ago(0.4), docsAgeHours: 9, docsComplete: true, unitUrlsCached: true } };
}`,
};

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const todayIso = new Date().toISOString().slice(0, 10);
const daysAgo = (n) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const stampAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const U = (path) => `https://learn.microsoft.com${path}`;
// the tracker keys a URL as the scanner saw it: no query, with the trailing slash the page used
const T = (path) => `${U(path)}/`;

// A fake `gh` (run with node through GH_CLI_SCRIPT) that logs every call as one JSON line:
// the arguments, the --body / --body-file text, and the tracker file as it was at that moment.
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.GH_LOG;
const arg = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const bodyFile = arg("--body-file");
const body = arg("--body") ?? (bodyFile ? readFileSync(bodyFile, "utf8") : null);
const tracker = existsSync(process.env.TRACKER_FILE) ? readFileSync(process.env.TRACKER_FILE, "utf8") : null;
const previous = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean) : [];
appendFileSync(log, JSON.stringify({ args, body, comment: arg("--comment"), tracker }) + "\\n");
const command = args.slice(0, 2).join(" ");
if (process.env.FAKE_GH_FAIL && command === process.env.FAKE_GH_FAIL) {
  console.error("fake gh: " + command + " failed on purpose");
  process.exit(1);
}
if (command === "issue list") {
  const list = JSON.parse(process.env.FAKE_GH_OPEN || "[]");
  // FAKE_GH_PAD: one more issue with a title this long, for a listing larger than spawnSync's default 1 MiB buffer
  if (process.env.FAKE_GH_PAD) list.push({ number: 1, title: "x".repeat(Number(process.env.FAKE_GH_PAD)) });
  console.log(JSON.stringify(list));
} else if (command === "issue create") {
  console.log("https://github.com/mscerts/hub/issues/" + (100 + previous.filter((l) => JSON.parse(l).args.slice(0, 2).join(" ") === "issue create").length));
}
`;

const learnsyncRun = (number, conclusion, day, status = "completed") => ({
  run_number: number,
  status,
  conclusion,
  event: "schedule",
  created_at: `${day}T16:42:57Z`,
  html_url: `https://github.com/mscerts/learnsync/actions/runs/${1000 + number}`,
});

async function scenario({
  links,
  removed = [],
  moved = [],
  sources = { learn: stampAgo(1), docs: stampAgo(1) },
  status = {
    schemaVersion: 1,
    learn: { generatedAt: stampAgo(1) },
    docs: { generatedAt: stampAgo(1), complete: true },
  },
  api = {},
  tracker = null,
  // the tracker file as text, for a file that is not JSON
  trackerText = null,
  withChangeFiles = true,
  // the command line of the script: ["--check"], ["--publish"] or none (both halves in one run)
  args = [],
  // a plan file (text) that is there before the run, for --publish
  planText = null,
  env = {},
}) {
  const base = await mkdtemp(join(tmpdir(), "learn-url-e2e-"));
  scratchDirs.push(base);
  const hub = join(base, "hub");
  const learnsync = join(base, "learnsync");
  await mkdir(join(hub, "src", "content"), { recursive: true });
  await mkdir(join(learnsync, "scripts", "lib"), { recursive: true });
  await mkdir(join(learnsync, "data", "changes"), { recursive: true });
  await writeFile(
    join(hub, "src", "content", "page.mdx"),
    links.map((l) => `<LinkCard href="${U(l)}/?WT.mc_id=1" />`).join("\n") +
      "\n",
  );
  for (const [name, code] of Object.entries(FAKE_LIBS)) {
    await writeFile(join(learnsync, "scripts", "lib", name), code);
  }
  if (withChangeFiles) {
    const file = (entries) =>
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: stampAgo(1),
        sources,
        entries,
      });
    await writeFile(
      join(learnsync, "data", "changes", "removed.json"),
      file(removed),
    );
    await writeFile(
      join(learnsync, "data", "changes", "moved.json"),
      file(moved),
    );
  }
  await writeFile(
    join(learnsync, "data", "status.json"),
    JSON.stringify(status),
  );
  const paths = {
    tracker: join(base, "tracker.json"),
    report: join(base, "report.md"),
    staleReport: join(base, "stale-report.md"),
    error: join(base, "error.md"),
    plan: join(base, "plan.json"),
    output: join(base, "output.txt"),
    probes: join(base, "probes.log"),
    fakeGh: join(base, "fake-gh.mjs"),
    ghLog: join(base, "gh.log"),
  };
  await writeFile(paths.fakeGh, FAKE_GH);
  // a local stand-in for the GitHub API: learnsync's workflow runs and open issues
  const apiRequests = [];
  const server = createServer((req, res) => {
    apiRequests.push(req.url);
    if (api.fail) {
      res.writeHead(500).end("{}");
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    const workflow = path.match(/\/actions\/workflows\/([^/]+)\/runs$/)?.[1];
    // the raw.githubusercontent.com stand-in (RAW_GITHUB_URL): learnsync's heartbeat
    const body = path.endsWith("/data/status.json")
      ? (api.rawStatus ?? status)
      : workflow
        ? { workflow_runs: api.runs?.[workflow] ?? [] }
        : path.endsWith("/issues")
          ? (api.issues ?? [])
          : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    paths.tracker,
    trackerText ??
      JSON.stringify(
        tracker ?? { lastRun: null, learnsync: null, open: {}, issues: {} },
      ),
  );
  await writeFile(paths.probes, "");
  if (planText !== null) await writeFile(paths.plan, planText);
  // an async spawn: the API stand-in above lives in this process and must keep answering
  const res = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["scripts/learn-url-check.mjs", ...args],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GITHUB_ACTIONS: "",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          CREATE_ISSUES: "0",
          DRY_RUN: "0",
          WAIT_FOR_SYNC: "0",
          REPO_ROOT: hub,
          LEARNSYNC_DIR: learnsync,
          TRACKER_FILE: paths.tracker,
          REPORT_FILE: paths.report,
          STALE_REPORT_FILE: paths.staleReport,
          ERROR_FILE: paths.error,
          PLAN_FILE: paths.plan,
          GITHUB_OUTPUT: paths.output,
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          RAW_GITHUB_URL: `http://127.0.0.1:${server.address().port}`,
          GH_CLI_SCRIPT: paths.fakeGh,
          GH_LOG: paths.ghLog,
          FAKE_GH_OPEN: "",
          FAKE_GH_FAIL: "",
          FAKE_GH_PAD: "",
          PROBE_LOG: paths.probes,
          ...env,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  await new Promise((done) => server.close(done));
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const lines = (p) =>
    (read(p) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const probeCalls = lines(paths.probes);
  const ghCalls = lines(paths.ghLog);
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    report: read(paths.report),
    staleReport: read(paths.staleReport),
    error: read(paths.error),
    planText: read(paths.plan),
    plan: read(paths.plan) === null ? null : JSON.parse(read(paths.plan)),
    output: read(paths.output) ?? "",
    tracker: trackerText === null ? JSON.parse(read(paths.tracker)) : null,
    trackerFile: read(paths.tracker),
    originalTracker: tracker,
    probeCalls,
    probedPaths: probeCalls.flatMap((c) => c.paths).sort(),
    ghCalls,
    ghCommands: ghCalls.map((c) => c.args.slice(0, 2).join(" ")),
    apiRequests,
  };
}

const learnEntry = (path, outcome, extra = {}) =>
  e(path, outcome, {
    firstSeen: daysAgo(10),
    lastVerified: daysAgo(1),
    ...extra,
  });

test("a changes run reports recorded changes, probes only the doubtful ones and keeps tracked URLs it cannot judge", async () => {
  const tracked = (extra = {}) => ({
    firstSeen: "2026-09-01",
    lastSeen: "2026-09-01",
    kind: "broken",
    reason: "old",
    issue: 7,
    ...extra,
  });
  const r = await scenario({
    links: [
      "/training/modules/recent-gone",
      "/training/modules/typo-tracked",
      "/training/modules/works-now",
      "/training/modules/fine",
    ],
    removed: [
      learnEntry("/training/modules/recent-gone", "gone"),
      // verified a month ago: live-confirmed first, and the live probe says it works
      learnEntry("/training/modules/works-now", "gone", {
        lastVerified: daysAgo(30),
      }),
    ],
    tracker: {
      lastRun: "2026-09-29",
      lastMode: "cache",
      lastFullAudit: "2026-09-01",
      learnsync: null,
      open: {
        [T("/training/modules/typo-tracked")]: tracked(),
        [T("/training/modules/works-now")]: tracked(),
        [T("/training/modules/left-the-repo")]: tracked(),
      },
      issues: {
        7: [
          T("/training/modules/typo-tracked"),
          T("/training/modules/works-now"),
          T("/training/modules/left-the-repo"),
        ],
      },
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Check source: changes/);
  assert.match(r.output, /check_failed=false/);
  assert.match(r.output, /new_count=1/);
  assert.match(r.output, /tracker_updated=true/);
  // only the old entry was probed; the recent one, the untouched and the tracked typo were not
  assert.deepEqual(r.probedPaths, ["/training/modules/works-now"]);
  assert.equal(r.probeCalls[0].options.probeUnverifiable, false);
  // the issue body
  assert.match(r.report, /change-file run/);
  assert.match(r.report, /recent-gone/);
  assert.ok(!r.report.includes("typo-tracked"));
  assert.ok(!r.report.includes("works-now"));
  assert.match(r.report, /looked up: \*\*4\*\*/);
  assert.match(r.report, /Only the monthly full audit checks those/);
  // the tracker: the new finding and the carried typo; the cleared and the removed one are resolved
  const open = Object.keys(r.tracker.open).sort();
  assert.deepEqual(open, [
    T("/training/modules/recent-gone"),
    T("/training/modules/typo-tracked"),
  ]);
  assert.equal(
    r.tracker.open[T("/training/modules/typo-tracked")].reason,
    "old",
  );
  assert.equal(
    r.tracker.open[T("/training/modules/typo-tracked")].lastSeen,
    "2026-09-01",
  );
  assert.equal(
    r.tracker.open[T("/training/modules/recent-gone")].firstSeen,
    todayIso,
  );
  assert.deepEqual(
    Object.keys(r.tracker.issues),
    ["7"],
    "the tracked typo keeps issue 7 open",
  );
  assert.equal(r.tracker.lastMode, "changes");
  assert.equal(
    r.tracker.lastFullAudit,
    "2026-09-01",
    "only a full audit moves lastFullAudit",
  );
  assert.equal(r.tracker.lastRun, todayIso);
});

test("a stale change-file family is stated in the issue and its entries are always live-confirmed", async () => {
  const r = await scenario({
    links: ["/training/modules/recent-gone", "/azure/docs-works/page"],
    removed: [learnEntry("/training/modules/recent-gone", "gone")],
    moved: [
      learnEntry("/azure/docs-works/page", "moved", {
        kind: "docs",
        family: "docs",
        to: "/azure/docs-works/new-page",
        evidence: "docs-redirect",
      }),
    ],
    sources: { learn: stampAgo(1), docs: stampAgo(25) },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(
    r.report,
    /docs entries of the change files were last refreshed/,
  );
  assert.match(r.report, /25 days ago, limit 10/);
  assert.match(r.report, /recent-gone/);
  // the docs entry was verified yesterday but its family is stale: probed (the fake probe says it works)
  assert.deepEqual(r.probedPaths, ["/azure/docs-works/page"]);
  assert.ok(!r.report.includes("docs-works"));
  assert.match(
    r.report,
    /Live-confirmed on [\d-]+[^\n]*: 1\. Of these 1 turned out to work/,
  );
});

test("a changes run fails loudly when learnsync has no change files yet", async () => {
  const r = await scenario({
    links: ["/training/modules/a"],
    withChangeFiles: false,
  });
  assert.equal(r.status, 1);
  assert.match(r.output, /check_failed=true/);
  assert.match(r.error, /no data\/changes\/removed\.json or moved\.json/);
  assert.match(r.error, /CHECK_SOURCE=cache/);
  assert.equal(r.report, null);
});

test("an unknown CHECK_SOURCE fails instead of silently picking a mode", async () => {
  const r = await scenario({
    links: ["/training/modules/a"],
    env: { CHECK_SOURCE: "everything" },
  });
  assert.equal(r.status, 1);
  assert.match(r.error, /Invalid CHECK_SOURCE="everything"/);
  assert.match(r.output, /check_failed=true/);
});

test("a tracker that cannot be read still fails the check loudly, in either mode: choosing the source gave it a full audit, but nothing is fetched or opened", async () => {
  for (const CHECK_SOURCE of ["cache", "changes"]) {
    const r = await scenario({
      links: ["/training/modules/fine"],
      trackerText: "{ not json",
      env: { CREATE_ISSUES: "1", CHECK_SOURCE },
    });
    assert.equal(r.status, 1, CHECK_SOURCE);
    assert.match(r.error, /The Learn URL check failed: SyntaxError/);
    assert.match(r.stderr, /The Learn URL check failed: SyntaxError/);
    assert.match(r.output, /check_failed=true/);
    assert.match(r.output, /tracker_updated=false/);
    assert.equal(r.trackerFile, "{ not json", "never rewritten");
    assert.deepEqual(r.ghCommands, [], "no issue was touched");
    assert.deepEqual(r.apiRequests, [], "nothing of learnsync was read");
    assert.equal(r.report, null);
  }
});

test("the systemic guard also stops a changes run that flags too much, naming the change files", async () => {
  const r = await scenario({
    links: ["/training/modules/one-gone", "/training/modules/two-gone"],
    removed: [
      learnEntry("/training/modules/one-gone", "gone"),
      learnEntry("/training/modules/two-gone", "gone"),
    ],
    env: { MAX_FLAGGED: "1" },
  });
  assert.equal(r.status, 1);
  assert.match(r.error, /flagged 2 of 2 URLs as broken in one run \(limit 1\)/);
  assert.match(r.error, /bad change file/);
  assert.match(r.error, /full_audit input/);
  assert.equal(r.report, null);
  assert.match(r.output, /tracker_updated=false/);
});

test("the full audit (CHECK_SOURCE=cache) still validates against the caches and records itself", async () => {
  const r = await scenario({
    links: ["/training/modules/dead-one", "/training/modules/fine"],
    env: { CHECK_SOURCE: "cache" },
    tracker: {
      lastRun: null,
      lastMode: "changes",
      lastFullAudit: "2026-09-01",
      learnsync: null,
      open: {},
      issues: {},
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Check source: cache/);
  assert.match(r.output, /new_count=1/);
  assert.match(r.report, /validator at commit/);
  assert.match(
    r.report,
    /Unique Learn URLs in the repo: \*\*2\*\*\. Valid: 1\. Broken: 1\./,
  );
  assert.ok(!r.report.includes("change-file run"));
  assert.equal(r.probeCalls[0].options.probeUnverifiable, true);
  assert.equal(r.tracker.lastMode, "cache");
  assert.equal(r.tracker.lastFullAudit, todayIso);
  assert.deepEqual(Object.keys(r.tracker.open), [
    T("/training/modules/dead-one"),
  ]);
});

// ---------------------------------------------------------------------------
// The "learnsync data is stale" alert: is the data fresh, and the one hub issue
// that says so (opened, commented on, closed; never duplicated)
// ---------------------------------------------------------------------------
const STALE_NOW = Date.parse("2026-10-13T06:00:00Z");
const hoursBefore = (hours, now = STALE_NOW) =>
  new Date(now - hours * 3_600_000).toISOString();
const freshStatus = () => ({
  learn: { generatedAt: hoursBefore(14) },
  docs: { generatedAt: hoursBefore(13), complete: true },
});
const freshLedger = () =>
  ledgerFreshness(
    ledgerOf({ learn: hoursBefore(14), docs: hoursBefore(13) }),
    STALE_NOW,
    10,
  );
const judge = (status, ledger = freshLedger(), extra = {}) =>
  learnsyncStaleness({ status, ledger, now: STALE_NOW, ...extra });

test("fresh heartbeats, a complete docs index and fresh change files are not stale", () => {
  const out = judge(freshStatus());
  assert.equal(out.stale, false);
  assert.deepEqual(out.problems, []);
  assert.equal(out.facts.learnAt, hoursBefore(14));
  assert.equal(out.facts.docsComplete, true);
  assert.deepEqual(out.limits, { heartbeatDays: 6, changesDays: 10 });
  assert.equal(DEFAULT_STALE_ALERT_DAYS, 6);
  // a full audit has no change files to judge
  assert.equal(judge(freshStatus(), null).stale, false);
  // docs.complete missing (an older schema) is not "incomplete"
  const status = freshStatus();
  delete status.docs.complete;
  assert.equal(judge(status).stale, false);
});

test("a Learn or docs heartbeat older than 6 days is stale; exactly 6 days is not", () => {
  const exactly = freshStatus();
  exactly.learn.generatedAt = hoursBefore(6 * 24);
  assert.equal(judge(exactly).stale, false);

  const justOver = freshStatus();
  justOver.docs.generatedAt = hoursBefore(6 * 24 + 1);
  const over = judge(justOver);
  assert.equal(over.stale, true);
  assert.deepEqual(
    over.problems.map((p) => p.id),
    ["docs-old"],
  );

  // the replay that motivated 6 instead of 8: at the Tuesday 2026-10-13 06:00 UTC
  // check the Learn heartbeat (2026-10-06 22:06 UTC) was 6.3 days old, and an
  // 8-day limit would not have listed it until 2026-10-20
  const replayDefault = learnsyncStaleness({
    status: frozenStatus(),
    ledger: null,
    now: WAIT_NOW,
  });
  assert.deepEqual(
    replayDefault.problems.map((p) => p.id),
    ["learn-old"],
  );
  assert.match(
    replayDefault.problems[0].text,
    /finished 2026-10-06 22:06 UTC \(6\.3 days ago; the limit is 6\)/,
  );
  assert.equal(
    learnsyncStaleness({
      status: frozenStatus(),
      ledger: null,
      now: WAIT_NOW,
      maxAgeDays: 8,
    }).stale,
    false,
    "the old default of 8 days misses it",
  );

  // the real freeze: Learn last synced 2026-10-06 22:06 UTC, a Tuesday check 12+ days later
  const frozen = judge(
    {
      learn: { generatedAt: "2026-09-30T22:06:45.322Z" },
      docs: { generatedAt: hoursBefore(13), complete: true },
    },
    freshLedger(),
  );
  assert.deepEqual(
    frozen.problems.map((p) => p.id),
    ["learn-old"],
  );
  assert.match(
    frozen.problems[0].text,
    /Learn data:\*\* the last good Learn sync finished 2026-09-30 22:06 UTC \(12\.3 days ago; the limit is 6\)/,
  );
  assert.equal(frozen.problems[0].since, "2026-09-30T22:06:45.322Z");

  // both old: both reported, each with its own date
  const both = judge({
    learn: { generatedAt: hoursBefore(300) },
    docs: { generatedAt: hoursBefore(400), complete: true },
  });
  assert.deepEqual(
    both.problems.map((p) => p.id),
    ["learn-old", "docs-old"],
  );
});

test("a failed latest sync run is a stale cause in its own right, before the heartbeat is old enough", () => {
  const summaries = summarizeSyncRuns(frozenRuns());
  // heartbeat 3 days old: inside the 6-day limit, but past the 48 hours a healthy week
  // never reaches, and the Learn run after it failed
  const status = {
    learn: {
      generatedAt: new Date(STALE_NOW - 3 * 24 * 3_600_000).toISOString(),
    },
    docs: { generatedAt: hoursBefore(13), complete: true },
  };
  const out = judge(status, freshLedger(), { syncRuns: summaries });
  assert.equal(out.stale, true);
  assert.deepEqual(
    out.problems.map((p) => p.id),
    ["learn-sync-failed"],
  );
  assert.match(
    out.problems[0].text,
    /^\*\*Learn sync failed:\*\* the latest Learn Catalog Monitor run 11 failed on 2026-10-12 \(\[open run\]\(https:\/\/github\.com\/mscerts\/learnsync\/actions\/runs\/1011\)\), after the last good Learn sync \(2026-10-10 06:00 UTC\), so nothing has refreshed the Learn data since\.$/,
  );
  assert.equal(out.problems[0].since, "2026-10-12T16:42:57Z");

  // both causes at once (the heartbeat is also over the limit): each is listed
  const both = judge(frozenStatus(), freshLedger(), { syncRuns: summaries });
  assert.deepEqual(
    both.problems.map((p) => p.id),
    ["learn-old", "learn-sync-failed"],
  );

  // the Actions API could not be read: the cause is skipped, it is never evidence
  assert.equal(judge(status, freshLedger(), { syncRuns: null }).stale, false);
  // a sync that succeeded since, or a fresh heartbeat, is not stale
  assert.equal(
    judge(status, freshLedger(), {
      syncRuns: summarizeSyncRuns(
        frozenRuns(waitRun(11, "success", "2026-10-12T16:42:57Z")),
      ),
    }).stale,
    false,
  );
  assert.equal(
    judge(freshStatus(), freshLedger(), { syncRuns: summaries }).stale,
    false,
    "the heartbeat is hours old: a failed manual re-run does not make the data stale",
  );
  // the 48 hours are a parameter
  assert.equal(
    judge(status, freshLedger(), { syncRuns: summaries, maxDataAgeHours: 96 })
      .stale,
    false,
  );
});

test("the heartbeat limit is a parameter and a typo in it throws instead of disabling the alert", () => {
  const status = freshStatus();
  status.learn.generatedAt = hoursBefore(4 * 24);
  assert.equal(judge(status).stale, false);
  assert.equal(judge(status, freshLedger(), { maxAgeDays: 3 }).stale, true);

  assert.equal(parseStaleAlertDays(undefined), 6);
  assert.equal(parseStaleAlertDays(""), 6);
  assert.equal(parseStaleAlertDays("  "), 6);
  assert.equal(parseStaleAlertDays("5"), 5);
  assert.equal(parseStaleAlertDays("0.5"), 0.5);
  for (const bad of ["abc", "0", "-1", "Infinity", "8 days"]) {
    assert.throws(
      () => parseStaleAlertDays(bad),
      /Invalid LEARNSYNC_STALE_DAYS/,
      bad,
    );
  }
});

test("docs.complete false is stale on its own, with the counts the heartbeat gives", () => {
  // the docs heartbeat as learnsync wrote it on 2026-10-12 (the Learn heartbeat is inside the limit)
  const out = judge({
    learn: { generatedAt: "2026-10-10T22:06:45.322Z" },
    docs: {
      generatedAt: "2026-10-12T17:36:55.849Z",
      complete: false,
      pendingNew: 11893,
      deferredChanged: 3506,
      deferredMissing: 0,
      sitemapFailures: 0,
    },
  });
  assert.equal(out.stale, true);
  assert.deepEqual(
    out.problems.map((p) => p.id),
    ["docs-incomplete"],
  );
  const text = out.problems[0].text;
  assert.match(text, /Docs index incomplete/);
  assert.match(text, /2026-10-12 17:36 UTC/);
  assert.match(text, /`docs\.complete: false`/);
  assert.match(
    text,
    /11893 new URLs still to be downloaded, 3506 changed URLs deferred, 0 missing URLs deferred, 0 sitemap file failures/,
  );
  assert.match(text, /removal detection was off/);
  assert.equal(out.facts.docsComplete, false);
  // no counts in the heartbeat: the sentence still stands
  const bare = judge({
    learn: { generatedAt: hoursBefore(14) },
    docs: { generatedAt: hoursBefore(13), complete: false },
  });
  assert.match(bare.problems[0].text, /`docs\.complete: false`\. Its removal/);
});

test("change files with a stale or missing source stamp make the data stale (changes mode)", () => {
  const ledger = ledgerFreshness(
    ledgerOf({ learn: hoursBefore(14), docs: hoursBefore(25 * 24) }),
    STALE_NOW,
    10,
  );
  const out = judge(freshStatus(), ledger);
  assert.deepEqual(
    out.problems.map((p) => p.id),
    ["docs-changes-stale"],
  );
  assert.match(
    out.problems[0].text,
    /Change files \(docs\):\*\* last refreshed 2026-09-18 06:00 UTC \(25 days ago; the limit is 10\)/,
  );
  assert.equal(out.problems[0].since, hoursBefore(25 * 24));

  const never = judge(
    freshStatus(),
    ledgerFreshness(ledgerOf({ learn: null, docs: null }), STALE_NOW, 10),
  );
  assert.deepEqual(
    never.problems.map((p) => p.id),
    ["learn-changes-stale", "docs-changes-stale"],
  );
  assert.match(never.problems[0].text, /no refresh stamp/);
  // the change-file limit has its own parameter
  assert.equal(
    judge(freshStatus(), ledger, { ledgerMaxAgeDays: 30 }).stale,
    true,
    "the ledger's own stale flag (computed with its limit) decides, not this parameter",
  );
});

test("a missing, unreadable or half-empty heartbeat is stale: no sync can be shown to have finished", () => {
  for (const status of [null, undefined, "text"]) {
    const out = judge(status);
    assert.equal(out.stale, true);
    assert.deepEqual(
      out.problems.map((p) => p.id),
      ["heartbeat-missing"],
    );
    assert.match(out.problems[0].text, /no readable `data\/status\.json`/);
  }
  const half = judge({ learn: { generatedAt: "not a date" } });
  assert.deepEqual(
    half.problems.map((p) => p.id),
    ["learn-heartbeat-missing", "docs-heartbeat-missing"],
  );
  assert.match(half.problems[0].text, /`learn\.generatedAt`/);
});

test("learnsync's runs are summarised from the Actions API, newest first", () => {
  const run = (number, conclusion, extra = {}) => ({
    run_number: number,
    status: "completed",
    conclusion,
    event: "schedule",
    created_at: "2026-10-12T16:42:57Z",
    html_url: `https://github.com/mscerts/learnsync/actions/runs/${number}`,
    ...extra,
  });
  const [learn, docs, other] = summarizeSyncRuns({
    "learn-catalog-monitor.yml": [run(11, "failure"), run(10, "success")],
    "docs-catalog-monitor.yml": [
      run(7, null, { status: "in_progress" }),
      run(6, "success", { html_url: "https://evil.example/x" }),
    ],
    "something-else.yml": [],
  });
  assert.equal(learn.label, "Learn Catalog Monitor");
  assert.equal(learn.latest.number, 11);
  assert.equal(learn.latest.conclusion, "failure");
  assert.equal(learn.lastSuccess.number, 10);
  assert.equal(docs.latest.status, "in_progress");
  assert.equal(docs.lastSuccess.number, 6);
  assert.equal(docs.lastSuccess.url, null, "only github.com links are kept");
  assert.equal(other.label, "something-else.yml");
  assert.equal(other.latest, null);
  assert.equal(other.lastSuccess, null);
  assert.deepEqual(summarizeSyncRuns(null), []);
});

test("text from learnsync is made harmless before it goes into a hub issue", () => {
  assert.equal(plain("  Sync   failed \n again "), "Sync failed again");
  const hostile = plain(
    "@maintainer <script>alert(1)</script> [click](https://x.example) fixes #5 `rm`",
  );
  assert.ok(!/[<>[\]`]/.test(hostile));
  assert.ok(!hostile.includes("@m"));
  assert.ok(!/#5/.test(hostile));
  assert.match(hostile, /@​maintainer/);
  assert.match(hostile, /#​5/);
  assert.equal(plain("x".repeat(500), 20), `${"x".repeat(17)}...`);
  assert.equal(plain(undefined), "");
});

const staleRuns = () =>
  summarizeSyncRuns({
    "learn-catalog-monitor.yml": [
      {
        run_number: 11,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-10-12T16:42:57Z",
        html_url: "https://github.com/mscerts/learnsync/actions/runs/1011",
      },
      {
        run_number: 10,
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-06T22:05:49Z",
        html_url: "https://github.com/mscerts/learnsync/actions/runs/1010",
      },
    ],
    "docs-catalog-monitor.yml": [
      {
        run_number: 4,
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-12T17:00:00Z",
        html_url: "https://github.com/mscerts/learnsync/actions/runs/1004",
      },
    ],
  });
const staleIssues = () => [
  {
    number: 11,
    title: "Microsoft Learn Catalog Sync Failed",
    html_url: "https://github.com/mscerts/learnsync/issues/11",
    created_at: "2026-10-12T16:43:20Z",
  },
];
const staleState = () =>
  judge({
    learn: { generatedAt: "2026-09-30T22:06:45.322Z" },
    docs: { generatedAt: hoursBefore(13), complete: false, pendingNew: 12 },
  });

test("the stale-data issue says what is stale, what learnsync reports and what the maintainer can do", () => {
  const body = buildStaleReport({
    staleness: staleState(),
    runs: staleRuns(),
    issues: staleIssues(),
    today: "2026-10-13",
    runUrl: "https://github.com/mscerts/hub/actions/runs/42",
  });
  assert.match(body, /takes its data from \[mscerts\/learnsync\]/);
  assert.match(body, /"no broken link found" means little/);
  assert.match(body, /### What is stale \(2026-10-13\)/);
  assert.match(body, /last good Learn sync finished 2026-09-30 22:06 UTC/);
  assert.match(body, /Docs index incomplete/);
  assert.match(body, /### What learnsync reports/);
  assert.match(
    body,
    /Learn Catalog Monitor: latest run 11 failed on 2026-10-12 \(\[open run\]\(https:\/\/github\.com\/mscerts\/learnsync\/actions\/runs\/1011\)\); last success run 10 succeeded on 2026-10-06/,
  );
  assert.match(body, /Docs Catalog Monitor: latest run 4 succeeded/);
  // the latest run is also the last success: said once
  assert.ok(!/Docs Catalog Monitor:[^\n]*last success/.test(body), body);
  assert.match(body, /backlog that the next syncs work off/);
  assert.match(
    body,
    /\[mscerts\/learnsync#11\]\(https:\/\/github\.com\/mscerts\/learnsync\/issues\/11\) Microsoft Learn Catalog Sync Failed \(opened 2026-10-12\)/,
  );
  assert.match(body, /### What you can do/);
  assert.match(body, /Watch \[mscerts\/learnsync\]/);
  assert.match(body, /`HUB_DISPATCH_TOKEN`/);
  assert.match(body, /Optional/);
  assert.match(body, /This alert does not need it/);
  assert.match(body, /own Tuesday schedule/);
  assert.match(body, /label `broken-link`/);
  assert.match(body, /closes it with a comment once the data is fresh again/);
  assert.match(
    body,
    /heartbeats at most 6 days old, docs index complete, change files refreshed within 10 days/,
  );
  assert.match(
    body,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/42/,
  );
  // nothing in the text can link to a hub issue or run by accident
  assert.ok(!/(^|[^/\w])#\d/m.test(body), body);
});

test("the stale-data comment repeats the state without the advice; unreadable API data only changes the wording", () => {
  const comment = buildStaleReport({
    staleness: staleState(),
    runs: staleRuns(),
    issues: [],
    today: "2026-10-20",
    kind: "comment",
  });
  assert.match(comment, /^\*\*Still stale on 2026-10-20\.\*\*/);
  assert.match(comment, /### What is stale \(2026-10-20\)/);
  assert.match(comment, /mscerts\/learnsync has no open issue labelled `bug`/);
  assert.ok(!comment.includes("What you can do"));
  assert.ok(!comment.includes("HUB_DISPATCH_TOKEN"));

  const blind = buildStaleReport({
    staleness: staleState(),
    runs: null,
    issues: null,
    errors: {
      runs: "GitHub API /repos/x -> HTTP 403 <b>",
      issues: "GitHub API /repos/y -> HTTP 500",
    },
    today: "2026-10-13",
  });
  assert.match(
    blind,
    /workflow runs of mscerts\/learnsync could not be read through the GitHub API \(GitHub API \/repos\/x - HTTP 403 b\); check \[its Actions page\]\(https:\/\/github\.com\/mscerts\/learnsync\/actions\)/,
  );
  assert.match(blind, /open issues of mscerts\/learnsync could not be read/);
  // still says what is stale and what to do
  assert.match(blind, /### What is stale/);
  assert.match(blind, /### What you can do/);

  // an issue title anyone can write is neutralised
  const hostile = buildStaleReport({
    staleness: staleState(),
    runs: staleRuns(),
    issues: [
      {
        number: 12,
        title: "@teriaavibes <img src=x> fixes #1",
        html_url: "https://github.com/mscerts/learnsync/issues/12",
        created_at: "2026-10-12",
      },
      {
        number: 13,
        title: "not a github link",
        html_url: "https://evil.example/13",
      },
    ],
    today: "2026-10-13",
  });
  assert.ok(!hostile.includes("<img"));
  assert.ok(!hostile.includes("@t"));
  assert.ok(!hostile.includes("evil.example"));
  assert.match(hostile, /an issue not a github link/);
});

test("the 'fresh again' comment quotes the facts that ended the alert", () => {
  const fresh = judge(freshStatus());
  const text = buildFreshComment({
    staleness: fresh,
    today: "2026-10-20",
    runUrl: "https://github.com/mscerts/hub/actions/runs/43",
  });
  assert.match(text, /^learnsync data is fresh again as of 2026-10-20: /);
  assert.match(text, /Learn heartbeat 2026-10-12 16:00 UTC/);
  assert.match(text, /docs heartbeat 2026-10-12 17:00 UTC \(index complete\)/);
  assert.match(text, /change files refreshed 2026-10-12 16:00 UTC \(Learn\)/);
  assert.match(text, /Closing this issue/);
  assert.match(
    text,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/43/,
  );
  // a full audit has no change files
  assert.ok(
    !buildFreshComment({
      staleness: judge(freshStatus(), null),
      today: "2026-10-20",
    }).includes("change files"),
  );
});

// An in-process stand-in for the gh CLI: records the arguments of every call.
function stubGh({ open = [], fail = {}, labels = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    if (fail[command]) throw new Error(`gh ${command} failed: boom`);
    if (command === "issue list") return JSON.stringify(open);
    if (command === "label list") {
      return JSON.stringify(labels.map((name) => ({ name })));
    }
    if (command === "issue create") {
      return "https://github.com/mscerts/hub/issues/77\n";
    }
    return "";
  };
  gh.calls = calls;
  gh.commands = () => calls.map((c) => c.slice(0, 2).join(" "));
  return gh;
}
const openIssue = (number, title = STALE_ISSUE_TITLE) => ({
  number,
  title,
  url: `https://github.com/mscerts/hub/issues/${number}`,
});
const reconcile = (gh, extra = {}) =>
  reconcileStaleIssue({
    stale: true,
    enabled: true,
    gh,
    issueBody: "ISSUE BODY",
    commentBody: "COMMENT BODY",
    closeComment: "CLOSE COMMENT",
    ...extra,
  });

test("stale data and no open issue opens exactly one, with the stable title and the bug label", () => {
  assert.equal(STALE_ISSUE_TITLE, "Learn URL Check: learnsync data is stale");
  assert.equal(STALE_ISSUE_LABEL, "bug");
  const gh = stubGh();
  const out = reconcile(gh);
  assert.deepEqual(out, {
    action: "created",
    number: 77,
    closed: [],
    error: null,
  });
  assert.deepEqual(gh.commands(), [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.deepEqual(gh.calls[0], [
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "bug",
    "--limit",
    "200",
    "--json",
    // the shared listing asks for the number and the title only: nothing here reads the url
    "number,title",
  ]);
  assert.deepEqual(gh.calls[2], [
    "issue",
    "create",
    "--title",
    STALE_ISSUE_TITLE,
    "--label",
    "bug",
    "--body",
    "ISSUE BODY",
  ]);
  // no --force on the label: the repository's own bug label is left alone
  assert.ok(!gh.calls[1].includes("--force"));
});

test("stale data with an open issue adds one comment and never a second issue", () => {
  const gh = stubGh({ open: [openIssue(40)] });
  const out = reconcile(gh);
  assert.equal(out.action, "commented");
  assert.equal(out.number, 40);
  assert.deepEqual(gh.commands(), ["issue list", "issue comment"]);
  assert.deepEqual(gh.calls[1], [
    "issue",
    "comment",
    "40",
    "--body",
    "COMMENT BODY",
  ]);

  // several open copies (someone opened one by hand): still one comment, on the oldest
  const many = stubGh({ open: [openIssue(52), openIssue(40), openIssue(47)] });
  const outMany = reconcile(many);
  assert.equal(outMany.number, 40);
  assert.equal(many.commands().filter((c) => c === "issue comment").length, 1);
  assert.ok(!many.commands().includes("issue create"));

  // an open issue with another title is not ours
  const other = stubGh({
    open: [openIssue(41, "Learn URL Check: something else")],
  });
  assert.equal(reconcile(other).action, "created");
  assert.deepEqual(
    listOpenStaleIssues(stubGh({ open: [openIssue(3), openIssue(1)] })).map(
      (i) => i.number,
    ),
    [1, 3],
  );
});

test("fresh data closes every open stale-data issue with a comment, and does nothing else", () => {
  const none = stubGh();
  assert.equal(reconcile(none, { stale: false }).action, "none");
  assert.deepEqual(none.commands(), ["issue list"]);

  const one = stubGh({ open: [openIssue(40)] });
  const out = reconcile(one, { stale: false });
  assert.deepEqual(out, {
    action: "closed",
    number: 40,
    closed: [40],
    error: null,
  });
  assert.deepEqual(one.commands(), ["issue list", "issue close"]);
  assert.deepEqual(one.calls[1], [
    "issue",
    "close",
    "40",
    "--comment",
    "CLOSE COMMENT",
  ]);

  const two = stubGh({ open: [openIssue(40), openIssue(47)] });
  assert.deepEqual(reconcile(two, { stale: false }).closed, [40, 47]);
});

test("a dry run or a run without issue creation touches nothing, not even to read", () => {
  for (const stale of [true, false]) {
    const gh = stubGh({ open: [openIssue(40)] });
    const out = reconcile(gh, { stale, enabled: false });
    assert.equal(out.action, stale ? "skipped" : "none");
    assert.equal(out.number, null);
    assert.deepEqual(gh.calls, []);
  }
});

test("a failed lookup or write fails a stale run loudly; for fresh data it is only reported", () => {
  assert.throws(
    () => reconcile(stubGh({ fail: { "issue list": true } })),
    /gh issue list failed/,
  );
  assert.throws(
    () => reconcile(stubGh({ fail: { "issue create": true } })),
    /gh issue create failed/,
  );
  assert.throws(
    () =>
      reconcile(
        stubGh({ open: [openIssue(40)], fail: { "issue comment": true } }),
      ),
    /gh issue comment failed/,
  );
  // a label that cannot be created because it exists already does not stop the issue
  const gh = stubGh({ fail: { "label create": true }, labels: ["bug"] });
  assert.equal(reconcile(gh).action, "created");
  assert.deepEqual(gh.commands(), [
    "issue list",
    "label create",
    "label list",
    "issue create",
  ]);
  // any other failure to create it is not swallowed, and no issue is opened without its label
  const noLabel = stubGh({ fail: { "label create": true } });
  assert.throws(() => reconcile(noLabel), /gh label create failed/);
  assert.ok(!noLabel.commands().includes("issue create"));

  const lookup = reconcile(stubGh({ fail: { "issue list": true } }), {
    stale: false,
  });
  assert.equal(lookup.action, "lookup-failed");
  assert.match(lookup.error, /gh issue list failed/);
  const close = reconcile(
    stubGh({ open: [openIssue(40)], fail: { "issue close": true } }),
    { stale: false },
  );
  assert.equal(close.action, "close-failed");
  assert.deepEqual(close.closed, []);
  assert.match(close.error, /gh issue close failed/);
});

// ---------------------------------------------------------------------------
// End to end: the stale-data alert in the real script (fake gh, local API stand-in)
// ---------------------------------------------------------------------------
const staleLearnStatus = (extra = {}) => ({
  schemaVersion: 1,
  learn: { generatedAt: stampAgo(12) },
  docs: { generatedAt: stampAgo(1), complete: true },
  ...extra,
});
// dates relative to now, so the failed Learn run stays newer than the 12-day-old heartbeat whenever this runs
const learnsyncApi = () => ({
  runs: {
    "learn-catalog-monitor.yml": [
      learnsyncRun(11, "failure", daysAgo(1)),
      learnsyncRun(10, "success", daysAgo(12)),
    ],
    "docs-catalog-monitor.yml": [learnsyncRun(4, "success", daysAgo(1))],
  },
  issues: [
    {
      number: 11,
      title: "Microsoft Learn Catalog Sync Failed",
      html_url: "https://github.com/mscerts/learnsync/issues/11",
      created_at: "2026-10-12T16:43:20Z",
    },
    {
      number: 99,
      title: "a pull request, not an issue",
      html_url: "https://github.com/mscerts/learnsync/pull/99",
      pull_request: {},
    },
  ],
});
const openTracker = () => ({
  lastRun: "2026-10-06",
  lastMode: "changes",
  lastFullAudit: "2026-10-06",
  learnsync: null,
  open: {},
  issues: {},
});

test("a stale Learn heartbeat opens ONE issue before the broken-link issue and the tracker write, and the check still reports", async () => {
  const r = await scenario({
    links: ["/training/modules/recent-gone", "/training/modules/fine"],
    removed: [learnEntry("/training/modules/recent-gone", "gone")],
    status: staleLearnStatus(),
    api: learnsyncApi(),
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // stale issue first (lookup, label, create), then the broken-link issue (label, create)
  assert.deepEqual(r.ghCommands, [
    "issue list",
    "label create",
    "issue create",
    "label create",
    "issue create",
  ]);
  const [, , staleCreate, , linkCreate] = r.ghCalls;
  const titleOf = (call) => call.args[call.args.indexOf("--title") + 1];
  assert.equal(titleOf(staleCreate), STALE_ISSUE_TITLE);
  assert.equal(
    staleCreate.args[staleCreate.args.indexOf("--label") + 1],
    "bug",
  );
  assert.match(titleOf(linkCreate), /^Broken Microsoft Learn links: 1 broken/);
  // the issue text: what is stale, learnsync's runs and issues, the advice
  assert.match(staleCreate.body, /last good Learn sync finished/);
  assert.match(staleCreate.body, /\(12 days ago; the limit is 6\)/);
  // the failed run is a cause of its own, next to the age of the heartbeat
  assert.match(
    staleCreate.body,
    new RegExp(
      `Learn sync failed:\\*\\* the latest Learn Catalog Monitor run 11 failed on ${daysAgo(1)}`,
    ),
  );
  assert.match(
    staleCreate.body,
    new RegExp(`Learn Catalog Monitor: latest run 11 failed on ${daysAgo(1)}`),
  );
  assert.match(
    staleCreate.body,
    new RegExp(`last success run 10 succeeded on ${daysAgo(12)}`),
  );
  assert.match(staleCreate.body, /\[mscerts\/learnsync#11\]/);
  assert.ok(!staleCreate.body.includes("a pull request, not an issue"));
  assert.match(staleCreate.body, /HUB_DISPATCH_TOKEN/);
  assert.equal(r.staleReport, staleCreate.body, "the file is the issue text");
  // nothing was written to the tracker when either issue was created
  for (const call of [staleCreate, linkCreate]) {
    assert.deepEqual(JSON.parse(call.tracker), r.originalTracker);
  }
  // the check itself ran on the data it has and carries the caveat, pointing at the stale issue
  assert.match(r.output, /new_count=1/);
  assert.match(r.output, /learnsync_stale=true/);
  assert.match(r.output, /check_failed=false/);
  assert.match(
    r.report,
    /learnsync's data is stale, so this report may be incomplete: see #100\./,
  );
  assert.match(r.report, /Learn sync heartbeat is \d+ hours old \(limit 48\)/);
  assert.deepEqual(Object.keys(r.tracker.open), [
    T("/training/modules/recent-gone"),
  ]);
  assert.equal(r.tracker.open[T("/training/modules/recent-gone")].issue, 101);
  // three read-only API calls: both sync workflows (read once, used for the cause and the text) and the open bug issues
  assert.equal(r.apiRequests.length, 3);
  assert.match(r.stdout, /learnsync data is stale \(2 problems\)/);
});

test("an already open stale-data issue gets one comment per run, not a second issue", async () => {
  const r = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({
      docs: { generatedAt: stampAgo(1), complete: false, pendingNew: 7 },
    }),
    api: learnsyncApi(),
    env: {
      CREATE_ISSUES: "1",
      FAKE_GH_OPEN: JSON.stringify([
        { number: 40, title: STALE_ISSUE_TITLE, url: "https://x/40" },
        {
          number: 41,
          title: "Broken Microsoft Learn links: 2 broken (2026-10-06)",
        },
      ]),
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, ["issue list", "issue comment"]);
  assert.deepEqual(r.ghCalls[1].args.slice(0, 3), ["issue", "comment", "40"]);
  assert.match(r.ghCalls[1].body, /^\*\*Still stale on /);
  assert.match(r.ghCalls[1].body, /Docs index incomplete/);
  assert.match(r.ghCalls[1].body, /\(7 new URLs still to be downloaded\)/);
  assert.ok(!r.ghCalls[1].body.includes("What you can do"));
  assert.match(r.output, /new_count=0/);
  assert.match(r.output, /learnsync_stale=true/);
});

test("fresh data closes the open stale-data issue with a comment and makes no API calls", async () => {
  const r = await scenario({
    links: ["/training/modules/fine"],
    api: learnsyncApi(),
    env: {
      CREATE_ISSUES: "1",
      FAKE_GH_OPEN: JSON.stringify([{ number: 40, title: STALE_ISSUE_TITLE }]),
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, ["issue list", "issue close"]);
  assert.deepEqual(r.ghCalls[1].args.slice(0, 3), ["issue", "close", "40"]);
  assert.match(r.ghCalls[1].comment, /^learnsync data is fresh again as of /);
  assert.match(r.ghCalls[1].comment, /docs heartbeat .* \(index complete\)/);
  assert.deepEqual(
    r.apiRequests.map((url) =>
      url.replace(/\?.*/, "").replace(/.*\/workflows\//, ""),
    ),
    ["learn-catalog-monitor.yml/runs", "docs-catalog-monitor.yml/runs"],
    "only the two sync workflows are read (to judge a failed sync); no issues, nothing to explain",
  );
  assert.equal(r.staleReport, null);
  assert.match(r.output, /learnsync_stale=false/);
  assert.match(r.stdout, /learnsync data is fresh\./);
});

test("fresh data and no open issue costs one lookup and creates nothing", async () => {
  const r = await scenario({
    links: ["/training/modules/fine"],
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, ["issue list"]);
  assert.equal(r.apiRequests.length, 2, "the two sync workflows, nothing else");
  assert.ok(!r.apiRequests.some((url) => url.includes("/issues")));
  assert.equal(r.staleReport, null);
  assert.match(r.output, /learnsync_stale=false/);
});

test("a dry run or CREATE_ISSUES=0 never touches issues, but still writes what it would send", async () => {
  for (const env of [
    { DRY_RUN: "1", CREATE_ISSUES: "1" },
    { DRY_RUN: "0", CREATE_ISSUES: "0" },
  ]) {
    const r = await scenario({
      links: ["/training/modules/recent-gone"],
      removed: [learnEntry("/training/modules/recent-gone", "gone")],
      status: staleLearnStatus(),
      api: learnsyncApi(),
      tracker: openTracker(),
      env: {
        ...env,
        FAKE_GH_OPEN: JSON.stringify([
          { number: 40, title: STALE_ISSUE_TITLE },
        ]),
      },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.ghCalls, [], JSON.stringify(env));
    assert.match(r.staleReport, /last good Learn sync finished/);
    assert.match(r.stdout, /Stale-data issue not touched/);
    assert.match(r.output, /learnsync_stale=true/);
    assert.match(r.report, /recent-gone/);
    // the caveat is there, but the stale issue number is unknown, so there is no pointer to it
    assert.match(
      r.report,
      /learnsync's data is stale, so this report may be incomplete\./,
    );
    assert.ok(!r.report.includes("may be incomplete: see #"));
  }
});

test("a failed stale-data issue step fails the run with nothing written, so a re-run reports everything again", async () => {
  for (const failing of ["issue create", "issue list"]) {
    const r = await scenario({
      links: ["/training/modules/recent-gone"],
      removed: [learnEntry("/training/modules/recent-gone", "gone")],
      status: staleLearnStatus(),
      api: learnsyncApi(),
      tracker: openTracker(),
      env: { CREATE_ISSUES: "1", FAKE_GH_FAIL: failing },
    });
    assert.equal(r.status, 1, failing);
    assert.match(r.error, new RegExp(`gh ${failing} failed`));
    assert.match(r.output, /check_failed=true/);
    assert.match(r.output, /tracker_updated=false/);
    assert.deepEqual(r.tracker, r.originalTracker, "tracker untouched");
    assert.equal(r.report, null, "the broken-link issue was not even built");
    assert.ok(
      !r.ghCommands
        .slice(r.ghCommands.indexOf(failing) + 1)
        .includes("issue create"),
      "no issue after the failed step",
    );
  }
});

test("a failed lookup while the data is fresh is only a warning; the run goes on", async () => {
  const r = await scenario({
    links: ["/training/modules/recent-gone"],
    removed: [learnEntry("/training/modules/recent-gone", "gone")],
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1", FAKE_GH_FAIL: "issue list" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /Could not look for an open .* issue to close/);
  assert.match(r.output, /new_count=1/);
  assert.ok(r.ghCommands.includes("issue create"));
});

test("on a GitHub runner a note is a workflow annotation with the check's title; elsewhere it is a plain line", async () => {
  const run = (env) =>
    scenario({
      links: ["/training/modules/recent-gone"],
      removed: [learnEntry("/training/modules/recent-gone", "gone")],
      tracker: openTracker(),
      env: { CREATE_ISSUES: "1", FAKE_GH_FAIL: "issue list", ...env },
    });
  const actions = await run({ GITHUB_ACTIONS: "true" });
  assert.equal(actions.status, 0, actions.stderr + actions.stdout);
  assert.match(
    actions.stdout,
    /^::warning title=Learn URL check::Could not look for an open "Learn URL Check: learnsync data is stale" issue to close \(gh issue list failed: .*\); the next run tries again\.$/m,
  );
  assert.doesNotMatch(actions.stderr, /Note: Could not look for/);
  const plainRun = await run({});
  assert.doesNotMatch(plainRun.stdout, /::warning/);
  assert.match(plainRun.stderr, /^Note: Could not look for an open /m);
});

test("a very long list of open issues does not overflow the output buffer of gh", async () => {
  // 2 MiB of issue titles: spawnSync's default buffer is 1 MiB, and a listing that is cut off
  // there fails the whole run
  const r = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus(),
    api: learnsyncApi(),
    env: {
      CREATE_ISSUES: "1",
      FAKE_GH_PAD: String(2 * 1024 * 1024),
      FAKE_GH_OPEN: JSON.stringify([{ number: 40, title: STALE_ISSUE_TITLE }]),
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, ["issue list", "issue comment"]);
  assert.deepEqual(r.ghCalls[1].args.slice(0, 3), ["issue", "comment", "40"]);
});

test("an output the workflow reads that cannot be written fails the run, and the failure is still reported", async () => {
  // GITHUB_OUTPUT names a directory, so no output can be appended. The tracker commit depends on
  // these outputs: a quiet green run with lost outputs would drop the tracker for good.
  const r = await scenario({
    links: ["/training/modules/fine"],
    env: { GITHUB_OUTPUT: tmpdir() },
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /The Learn URL check failed: .*(EISDIR|EPERM|EACCES)/s,
  );
  assert.match(r.stderr, /Could not write the step outputs: /);
  assert.match(r.error, /The Learn URL check failed/);
});

test("unreadable learnsync runs only change the wording of the issue, not whether it is raised", async () => {
  const r = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus(),
    api: { fail: true },
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(
    r.ghCalls[2].body,
    /workflow runs of mscerts\/learnsync could not be read through the GitHub API \(GitHub API .* HTTP 500\)/,
  );
  assert.match(
    r.ghCalls[2].body,
    /open issues of mscerts\/learnsync could not be read/,
  );
  assert.match(r.ghCalls[2].body, /### What you can do/);
});

test("stale change files alone raise the alert in a changes run", async () => {
  const r = await scenario({
    links: ["/training/modules/fine"],
    sources: { learn: stampAgo(1), docs: stampAgo(25) },
    api: learnsyncApi(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(r.ghCalls[2].body, /Change files \(docs\):\*\* last refreshed/);
  assert.match(r.ghCalls[2].body, /25 days ago; the limit is 10/);
  assert.ok(!r.ghCalls[2].body.includes("Learn data:"));
});

test("the full audit judges the validator's freshness the same way", async () => {
  const stale = await scenario({
    links: ["/training/modules/fine"],
    api: learnsyncApi(),
    env: {
      CHECK_SOURCE: "cache",
      CREATE_ISSUES: "1",
      FAKE_CACHE_LEARN_DAYS: "20",
    },
  });
  assert.equal(stale.status, 0, stale.stderr + stale.stdout);
  assert.deepEqual(stale.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(
    stale.ghCalls[2].body,
    /Learn data:\*\* the last good Learn sync/,
  );
  assert.match(stale.ghCalls[2].body, /\(20 days ago; the limit is 6\)/);
  assert.ok(!stale.ghCalls[2].body.includes("Change files"));

  const fresh = await scenario({
    links: ["/training/modules/fine"],
    env: { CHECK_SOURCE: "cache", CREATE_ISSUES: "1" },
  });
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  assert.deepEqual(fresh.ghCommands, ["issue list"]);
});

test("a failed Learn sync is reported on the first check after it, before the heartbeat is old enough to alarm", async () => {
  // the 2026-10-13 replay: heartbeat 6.3 days old, the run after it failed
  const replay = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(6.3) } }),
    api: learnsyncApi(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.deepEqual(replay.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(replay.ghCalls[2].body, /\(6\.3 days ago; the limit is 6\)/);
  assert.match(
    replay.ghCalls[2].body,
    /Learn sync failed:\*\* the latest Learn Catalog Monitor run 11 failed/,
  );

  // a heartbeat 3 days old is inside the limit; only the failed run after it makes the data stale
  const failed = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(3) } }),
    api: learnsyncApi(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(failed.status, 0, failed.stderr + failed.stdout);
  assert.deepEqual(failed.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(failed.stdout, /learnsync data is stale \(1 problem\)/);
  assert.match(failed.ghCalls[2].body, /Learn sync failed:\*\*/);
  assert.ok(!failed.ghCalls[2].body.includes("Learn data:"));
  assert.match(failed.output, /learnsync_stale=true/);

  // the Actions API cannot be read: a failed read is never evidence, so the cause is skipped
  const blind = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(3) } }),
    api: { fail: true },
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(blind.status, 0, blind.stderr + blind.stdout);
  assert.deepEqual(blind.ghCommands, ["issue list"]);
  assert.match(blind.output, /learnsync_stale=false/);
});

test("waiting: a frozen learnsync costs no wait, a running sync gets the long wait, a late start the short one", async () => {
  const wait = {
    WAIT_FOR_SYNC: "1",
    POLL_MINUTES: "0.005",
    // minutes: 1.2 seconds for a late start, 3.6 seconds for a running sync
    IDLE_WAIT_MINUTES: "0.02",
    SYNC_WAIT_MINUTES: "0.06",
  };
  // the latest Learn run failed: nothing will refresh the heartbeat, so nothing to wait for
  const startedFrozen = Date.now();
  const frozen = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(3) } }),
    api: learnsyncApi(),
    env: { ...wait, SYNC_WAIT_MINUTES: "150", IDLE_WAIT_MINUTES: "30" },
  });
  assert.equal(frozen.status, 0, frozen.stderr + frozen.stdout);
  assert.ok(
    Date.now() - startedFrozen < 20_000,
    "did not sleep through the 30 or 150 minute budgets",
  );
  assert.ok(!frozen.stdout.includes("Waiting for learnsync"), frozen.stdout);
  assert.match(
    frozen.stderr,
    /The latest learnsync sync failed \(learn-catalog-monitor\.yml#11 \(failure\)\)/,
  );

  // a heartbeat older than 48 hours, the latest run a success and nothing running:
  // only a late scheduled start could refresh it, which is the short wait
  const quietRuns = {
    runs: {
      "learn-catalog-monitor.yml": [learnsyncRun(10, "success", daysAgo(3))],
      "docs-catalog-monitor.yml": [learnsyncRun(4, "success", daysAgo(1))],
    },
  };
  const late = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(3) } }),
    api: quietRuns,
    env: wait,
  });
  assert.equal(late.status, 0, late.stderr + late.stdout);
  assert.match(
    late.stdout,
    /Waiting for learnsync \(learn data not refreshed in the last 48h\)/,
  );
  assert.match(
    late.stderr,
    /still not synced after 0\.02 minutes \(learn data not refreshed in the last 48h\)/,
  );
  assert.ok(!late.stderr.includes("sync failed"));

  // a run in progress: the long budget applies (0.06 minutes, not the idle 0.02)
  const running = await scenario({
    links: ["/training/modules/fine"],
    status: staleLearnStatus({ learn: { generatedAt: stampAgo(3) } }),
    api: {
      runs: {
        "learn-catalog-monitor.yml": [
          { ...learnsyncRun(11, null, daysAgo(0), "in_progress") },
        ],
        "docs-catalog-monitor.yml": [learnsyncRun(4, "success", daysAgo(1))],
      },
    },
    env: wait,
  });
  assert.equal(running.status, 0, running.stderr + running.stdout);
  assert.match(running.stdout, /learn-catalog-monitor\.yml#11 running/);
  assert.match(running.stderr, /still not synced after 0\.06 minutes/);

  // fresh data and nothing running: no wait at all
  const fresh = await scenario({
    links: ["/training/modules/fine"],
    api: quietRuns,
    env: wait,
  });
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  assert.ok(!fresh.stdout.includes("Waiting for learnsync"));
  assert.ok(!fresh.stderr.includes("still not synced"));
});

test("LEARNSYNC_STALE_DAYS moves the limit, and a typo in it fails the run instead of disabling the alert", async () => {
  const status = staleLearnStatus({ learn: { generatedAt: stampAgo(5) } });
  const quiet = await scenario({
    links: ["/training/modules/fine"],
    status,
    env: { CREATE_ISSUES: "1" },
  });
  assert.deepEqual(quiet.ghCommands, ["issue list"]);
  const strict = await scenario({
    links: ["/training/modules/fine"],
    status,
    api: learnsyncApi(),
    env: { CREATE_ISSUES: "1", LEARNSYNC_STALE_DAYS: "3" },
  });
  assert.deepEqual(strict.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.match(strict.ghCalls[2].body, /the limit is 3/);

  const typo = await scenario({
    links: ["/training/modules/fine"],
    env: { LEARNSYNC_STALE_DAYS: "eight" },
  });
  assert.equal(typo.status, 1);
  assert.match(typo.error, /Invalid LEARNSYNC_STALE_DAYS="eight"/);
  assert.match(typo.output, /check_failed=true/);
});

const WORKFLOW = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    ".github",
    "workflows",
    "learn-url-check.yml",
  ),
  "utf8",
);

/** The text of one job of the workflow, from its key to the next job (or the end). */
function jobText(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `no job ${name}`);
  const next = WORKFLOW.slice(start + 3).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0
    ? WORKFLOW.slice(start)
    : WORKFLOW.slice(start, start + 3 + next);
}

test("the check job is read-only and the publish job raises the alerts ahead of the tracker commit", () => {
  const check = jobText("check");
  const publish = jobText("publish");
  // the long job holds no token that can write issues or push
  assert.match(check, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(check, /issues: write|contents: write|CREATE_ISSUES/);
  assert.match(check, /persist-credentials: false/);
  assert.match(check, /run: node scripts\/learn-url-check\.mjs --check/);
  // its plan reaches the publish job, also when the check failed
  const upload = check.slice(
    check.indexOf("- name: Hand the plan to the publish job"),
  );
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(check, /\/tmp\/learn-url-check-plan\.json/);
  assert.match(check, /\/tmp\/learn-url-check-error\.md/);
  // the publish job is the only one that writes, and it runs after a failed check too
  assert.match(publish, /needs: check/);
  assert.match(publish, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(
    publish,
    /permissions:\n {6}contents: write\n {6}issues: write\n/,
  );
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(publish, /run: node scripts\/learn-url-check\.mjs --publish/);
  // the issues are created inside the publish step, ahead of the tracker commit
  const issueStep = publish.indexOf(
    "name: Open the issues and write the tracker",
  );
  const commit = publish.indexOf("name: Commit updated tracker");
  assert.ok(issueStep > 0 && commit > issueStep);
  assert.match(publish, /CREATE_ISSUES: "1"/);
  // the tracker commit only runs when the publish step succeeded: no always()/failure() in its condition
  const commitStep = publish.slice(
    commit,
    publish.indexOf("- name:", commit + 10),
  );
  assert.match(
    commitStep,
    /if: steps\.publish\.outputs\.tracker_updated == 'true'/,
  );
  assert.ok(!/always\(\)|failure\(\)/.test(commitStep));
  // the issues are already open when the commit runs: a rejected push is retried on top of
  // whatever another monitor pushed, instead of failing and duplicating the issue on a re-run
  assert.match(commitStep, /for attempt in 1 2 3; do/);
  assert.match(commitStep, /git pull --rebase && git push && exit 0/);
  assert.match(commitStep, /git rebase --abort/);
  assert.match(commitStep, /sleep \$\(\(attempt \* 5\)\)/);
  assert.match(commitStep, /exit 1\s*$/);
  assert.match(commitStep, /git diff --cached --quiet && exit 0/);
  // the stale limit named in the workflow comment is the script's default
  assert.match(
    WORKFLOW,
    new RegExp(`LEARNSYNC_STALE_DAYS, ${DEFAULT_STALE_ALERT_DAYS} by default`),
  );
  // issues can be listed, opened, commented on and closed with the job token
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(WORKFLOW, /STALE_REPORT_FILE: \/tmp\/learn-url-check-stale\.md/);
  // the dispatch token is documented as optional
  assert.match(WORKFLOW, /HUB_DISPATCH_TOKEN/);
  assert.match(WORKFLOW, /optional/i);
  assert.match(WORKFLOW, /learnsync data is stale/);
});

test("a report-only dispatch that errors opens no failure issue; a scheduled run and a normal dispatch do", () => {
  const publish = jobText("publish");
  const step = publish.slice(
    publish.indexOf("- name: Create issue if the check failed"),
  );
  const condition = step.match(/^\s+if: (.+)$/m)[1];
  // The condition is evaluated like the runner does: failure() (also true when the check job, an
  // ancestor, failed), the check job's output, the publish step's output and the inputs, where
  // dry_run is a boolean for a manual run and empty for every other event.
  const opens = ({
    failed = true,
    checkJob = "true",
    publishStep = "false",
    dryRun,
  }) =>
    new Function(
      "failure",
      "needs",
      "steps",
      "inputs",
      `return Boolean(${condition});`,
    )(
      () => failed,
      { check: { outputs: { check_failed: checkJob } } },
      { publish: { outputs: { check_failed: publishStep } } },
      { dry_run: dryRun },
    );
  assert.equal(opens({ dryRun: undefined }), true, "a scheduled run");
  assert.equal(opens({ dryRun: false }), true, "a manual run, issues on");
  assert.equal(opens({ dryRun: true }), false, "a report-only run");
  assert.equal(opens({ dryRun: false, failed: false }), false);
  assert.equal(
    opens({ dryRun: false, checkJob: "false", publishStep: "false" }),
    false,
    "nothing failed in the check",
  );
  assert.equal(
    opens({ dryRun: false, checkJob: "false", publishStep: "true" }),
    true,
    "the publish step itself reported a failure",
  );
  // the publish step reads the same input the same way, so a dry run never touches the issues
  assert.match(publish, /DRY_RUN: \$\{\{ inputs\.dry_run && '1' \|\| '0' \}\}/);
});

// ---------------------------------------------------------------------------
// The two halves of a run: --check writes a plan, --publish applies it
// ---------------------------------------------------------------------------
const SPLIT_INPUT = () => ({
  links: ["/training/modules/recent-gone", "/training/modules/fine"],
  removed: [learnEntry("/training/modules/recent-gone", "gone")],
  status: staleLearnStatus(),
  api: learnsyncApi(),
  tracker: openTracker(),
});

test("--check reads and decides but touches no issue and no tracker, and leaves a plan", async () => {
  const r = await scenario({
    ...SPLIT_INPUT(),
    args: ["--check"],
    // even with issue creation switched on by mistake, this half never calls gh
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, []);
  assert.deepEqual(JSON.parse(r.trackerFile), r.originalTracker);
  assert.equal(
    r.report,
    null,
    "the broken-link issue text is written by the publish half",
  );
  assert.match(r.output, /plan_written=true/);
  assert.match(r.output, /check_failed=false/);
  assert.match(r.output, /tracker_updated=false/);
  assert.match(r.output, /new_count=1/);
  assert.match(r.output, /learnsync_stale=true/);
  // the plan is plain data: what the stale-data issue says, the new finding, what the tracker needs
  const plan = r.plan;
  assert.equal(plan.version, 1);
  assert.equal(plan.source, "changes");
  assert.equal(plan.failure, null);
  assert.equal(plan.stale.stale, true);
  assert.match(plan.stale.issueBody, /last good Learn sync finished/);
  assert.deepEqual(
    plan.report.findings.map((f) => f.url),
    [T("/training/modules/recent-gone")],
  );
  assert.deepEqual(plan.tracker.newUrls, [T("/training/modules/recent-gone")]);
  assert.deepEqual(plan.tracker.before, r.originalTracker);
  assert.equal(
    r.staleReport,
    plan.stale.issueBody,
    "the stale text is still written by the check",
  );
});

test("--check then --publish does exactly what one run does: the same issues in the same order, the same tracker", async () => {
  const whole = await scenario({
    ...SPLIT_INPUT(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(whole.status, 0, whole.stderr + whole.stdout);
  const checked = await scenario({ ...SPLIT_INPUT(), args: ["--check"] });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  const published = await scenario({
    links: [],
    args: ["--publish"],
    planText: checked.planText,
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(published.status, 0, published.stderr + published.stdout);
  assert.deepEqual(published.ghCommands, whole.ghCommands);
  // two runs of the scenario differ only by the folders they use and the time they were made
  const same = (text) =>
    String(text ?? "")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
      .replace(/\S*learn-url-e2e-\w+[\\/]/g, "<dir>/");
  assert.deepEqual(
    published.ghCalls.map((c) => [same(c.args.join(" ")), same(c.body)]),
    whole.ghCalls.map((c) => [same(c.args.join(" ")), same(c.body)]),
  );
  assert.equal(same(published.report), same(whole.report));
  const trackerOf = (r) => JSON.parse(same(JSON.stringify(r.tracker)));
  assert.deepEqual(trackerOf(published), trackerOf(whole));
  assert.match(published.output, /tracker_updated=true/);
  assert.match(published.output, /new_count=1/);
  assert.match(published.output, /check_failed=false/);
  // the pointer to the stale-data issue is added by the publish half, once the number is known
  assert.match(
    published.report,
    /learnsync's data is stale, so this report may be incomplete: see #100\./,
  );
});

test("--publish with DRY_RUN touches no issue and no tracker, but still writes the text it would send", async () => {
  const checked = await scenario({ ...SPLIT_INPUT(), args: ["--check"] });
  const r = await scenario({
    links: [],
    args: ["--publish"],
    planText: checked.planText,
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1", DRY_RUN: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.ghCommands, []);
  assert.deepEqual(r.tracker, r.originalTracker);
  assert.match(r.report, /^The weekly Microsoft Learn URL check found/);
  assert.match(r.output, /tracker_updated=false/);
});

test("a tripped systemic guard fails the check half, and the publish half still raises the stale-data issue and exits 0", async () => {
  const input = {
    ...SPLIT_INPUT(),
    removed: Array.from({ length: 4 }, (_, i) =>
      learnEntry(`/training/modules/gone-${i}`, "gone"),
    ),
    links: Array.from({ length: 4 }, (_, i) => `/training/modules/gone-${i}`),
    env: { MAX_FLAGGED: "1" },
  };
  const checked = await scenario({ ...input, args: ["--check"] });
  assert.equal(checked.status, 1);
  assert.match(checked.output, /check_failed=true/);
  assert.match(checked.output, /plan_written=true/);
  assert.match(
    checked.error,
    /flagged 4 of 4 URLs as broken in one run \(limit 1\)/,
  );
  assert.match(checked.plan.failure.message, /limit 1/);
  assert.equal(checked.plan.report, null);
  assert.equal(checked.plan.tracker, null);

  const published = await scenario({
    links: [],
    args: ["--publish"],
    planText: checked.planText,
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1" },
  });
  // only the stale-data issue: no broken-link issue, no tracker write; the job is already red because of the check
  assert.equal(published.status, 0, published.stderr + published.stdout);
  assert.deepEqual(published.ghCommands, [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.deepEqual(published.tracker, published.originalTracker);
  assert.match(published.output, /check_failed=true/);
  assert.match(published.output, /tracker_updated=false/);
});

test("--publish with no plan says so and publishes nothing; a plan of another version is refused", async () => {
  const none = await scenario({
    links: [],
    args: ["--publish"],
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(none.status, 0, none.stderr + none.stdout);
  assert.match(none.stdout, /No plan at .*nothing to publish/);
  assert.deepEqual(none.ghCommands, []);
  assert.match(none.output, /tracker_updated=false/);

  const checked = await scenario({ ...SPLIT_INPUT(), args: ["--check"] });
  const plan = { ...checked.plan, version: 99 };
  const wrong = await scenario({
    links: [],
    args: ["--publish"],
    planText: JSON.stringify(plan),
    tracker: openTracker(),
    env: { CREATE_ISSUES: "1" },
  });
  assert.equal(wrong.status, 1);
  assert.match(wrong.error, /has version 99, this script reads version 1/);
  assert.deepEqual(wrong.ghCommands, []);
});
