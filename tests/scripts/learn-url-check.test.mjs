import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import {
  FULL_AUDIT_RULE,
  SPARSE_PATHS,
  buildReport,
  carryOver,
  checkoutCommands,
  chooseCheckSource,
  collectRepoUrls,
  diffTracker,
  evaluateChanges,
  extractLearnUrls,
  heartbeatNotes,
  isFullAuditDay,
  issueTitle,
  ledgerFreshness,
  ledgerNotes,
  ledgerResult,
  needsLiveConfirmation,
  nextFullAuditDate,
  recentlyVerified,
  selectCheckSource,
  staleSections,
  stripComments,
  syncState,
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
  const scheduled = (iso) =>
    chooseCheckSource({ eventName: "schedule", now: at(iso) });
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

test("the next scheduled full audit is the next first Tuesday", () => {
  const next = (iso) => nextFullAuditDate(new Date(`${iso}T00:00:00Z`));
  assert.equal(next("2026-10-06"), "2026-11-03");
  assert.equal(next("2026-10-01"), "2026-10-06");
  assert.equal(next("2026-11-04"), "2026-12-01");
  assert.equal(next("2026-12-31"), "2027-01-05");
  assert.match(FULL_AUDIT_RULE, /first Tuesday of each month/);
  assert.match(FULL_AUDIT_RULE, /full_audit/);
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
          const destination = a.to ? `https://learn.microsoft.com${a.to}` : null;
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
    assert.equal(result.suggestion, null, `${path}: a landing page is not a replacement`);
    assert.equal(result.redirectsTo, HITS[path].to, `${path}: it may still say where visitors land`);
  }
  // a low-confidence (inherited) move is a guess: neither destination nor suggestion until a live probe names one
  const inherited = ledgerResult("/training/modules/blob/9-sim", info, HITS["/training/modules/blob/9-sim"]);
  assert.deepEqual([inherited.verdict, inherited.redirectsTo, inherited.suggestion], ["moved", null, null]);
  // an unverified removal has no destination either
  assert.equal(ledgerResult("/training/modules/maybe", info, HITS["/training/modules/maybe"]).suggestion, null);
  // a high-confidence move does
  const moved = ledgerResult("/training/modules/blob", info, HITS["/training/modules/blob"]);
  assert.deepEqual([moved.redirectsTo, moved.suggestion], ["/training/modules/blob-v2", "https://learn.microsoft.com/training/modules/blob-v2"]);
  // a move whose destination was removed counts as removed: no suggestion, whatever `to` says
  assert.equal(ledgerResult("/training/modules/pwd", info, HITS["/training/modules/pwd"]).suggestion, null);

  // through the whole pipeline, recorded and live-confirmed alike (the live layer keeps what it was given when the page is
  // still gone, so a landing page that leaked into `suggestion` here would reach the issue)
  const recorded = await run(["/training/modules/landing-mod", "/training/modules/m2/5-old"]);
  assert.equal(recorded.liveLayer.calls.length, 0, "fresh and high confidence: reported as recorded");
  assert.deepEqual(
    toFindings(recorded.results, recorded.repoUrls).map((f) => [f.path, f.kind, f.suggestion]),
    [
      ["/training/modules/landing-mod", "broken", null],
      ["/training/modules/m2/5-old", "broken", null],
    ],
  );
  const stale = await run(["/training/modules/landing-mod"], { "/training/modules/landing-mod": { verdict: "broken", detail: "removed (redirects to Browse all training)" } }, { today: "2026-12-01" });
  assert.equal(stale.liveLayer.calls.length, 1, "verified long ago: live-confirmed first");
  const [confirmed] = toFindings(stale.results, stale.repoUrls);
  assert.deepEqual([confirmed.evidence, confirmed.kind, confirmed.suggestion], ["live-probe", "broken", null]);
});

test("the issue's table shows no suggested fix for a removed link that only lands on a hub page", () => {
  const url = "https://learn.microsoft.com/training/modules/landing-mod";
  const results = [
    ledgerResult("/training/modules/landing-mod", { raws: new Set([url]) }, HITS["/training/modules/landing-mod"]),
    ledgerResult("/training/modules/blob", { raws: new Set(["https://learn.microsoft.com/training/modules/blob"]) }, HITS["/training/modules/blob"]),
  ];
  const repoUrls = new Map([
    ["/training/modules/landing-mod", { raws: new Set([url]), locations: ["src/a.mdx:1"] }],
    ["/training/modules/blob", { raws: new Set(["https://learn.microsoft.com/training/modules/blob"]), locations: ["src/b.mdx:2"] }],
  ]);
  const report = buildReport({
    findings: toFindings(results, repoUrls),
    data: { sha: "89abcdef0123", learnGeneratedAt: null, docsGeneratedAt: null },
    summary: null,
    today: "2026-10-06",
    runUrl: null,
    notes: [],
    mode: "changes",
    coverage: {
      total: 2, recorded: 2, recordedRemoved: 1, recordedMoved: 1, ledgerOnly: 2, probed: 0, clearedByLive: 0, unsettled: 0, trustDays: 14, nextFullAudit: null,
      ledger: { sha: "89abcdef0123", learnStamp: null, docsStamp: null, learnEntries: 2, docsEntries: 0, total: 2 },
    },
  });
  const rowOf = (needle) => report.split("\n").find((line) => line.startsWith("|") && line.includes(needle));
  assert.match(rowOf(url), /\| — \|$/, "the removed link: nothing to suggest");
  assert.ok(!rowOf(url).includes("/training/browse"));
  assert.match(rowOf("/training/modules/blob"), /\| https:\/\/learn\.microsoft\.com\/training\/modules\/blob-v2 \|$/, "the moved link: its new address");
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
    const landing = out.results.find((r) => r.path === "/training/modules/landing-mod");
    assert.deepEqual([landing.redirectsTo, landing.suggestion], ["/training/browse", null]);
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
import { join } from "node:path";
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
  return { results, summary: summarize(results), freshness: { missingFiles: [], learnGeneratedAt: "2026-10-05T19:04:00.000Z", learnAgeHours: 10, docsGeneratedAt: "2026-10-05T19:55:00.000Z", docsAgeHours: 9, docsComplete: true, unitUrlsCached: true } };
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

async function scenario({
  links,
  removed = [],
  moved = [],
  sources = { learn: stampAgo(1), docs: stampAgo(1) },
  tracker = null,
  withChangeFiles = true,
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
    JSON.stringify({
      schemaVersion: 1,
      learn: { generatedAt: stampAgo(1) },
      docs: { generatedAt: stampAgo(1), complete: true },
    }),
  );
  const paths = {
    tracker: join(base, "tracker.json"),
    report: join(base, "report.md"),
    error: join(base, "error.md"),
    output: join(base, "output.txt"),
    probes: join(base, "probes.log"),
  };
  await writeFile(
    paths.tracker,
    JSON.stringify(
      tracker ?? { lastRun: null, learnsync: null, open: {}, issues: {} },
    ),
  );
  await writeFile(paths.probes, "");
  const res = spawnSync(process.execPath, ["scripts/learn-url-check.mjs"], {
    cwd: join(import.meta.dirname, "..", ".."),
    encoding: "utf8",
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
      ERROR_FILE: paths.error,
      GITHUB_OUTPUT: paths.output,
      PROBE_LOG: paths.probes,
      ...env,
    },
  });
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const probeCalls = (read(paths.probes) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    report: read(paths.report),
    error: read(paths.error),
    output: read(paths.output) ?? "",
    tracker: JSON.parse(read(paths.tracker)),
    probeCalls,
    probedPaths: probeCalls.flatMap((c) => c.paths).sort(),
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
