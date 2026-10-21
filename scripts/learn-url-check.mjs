#!/usr/bin/env node
/**
 * Check of every Microsoft Learn URL in this repo against
 * https://github.com/mscerts/learnsync, run AFTER learnsync has synced.
 *
 * Usage:
 *   node scripts/learn-url-check.mjs
 *   node scripts/learn-url-check.mjs --choose-source   (prints source=changes|cache for the workflow)
 *   node scripts/learn-url-check.mjs --check           (the read-only half: writes PLAN_FILE, touches no issue and no tracker)
 *   node scripts/learn-url-check.mjs --publish         (the write half: reads PLAN_FILE, opens/updates/closes the issues, writes the tracker)
 *
 * Without --check or --publish both halves run in one process (a local run, the tests). The
 * workflow runs them as two jobs, so the long job that waits for learnsync and reads Learn holds
 * no token that can write issues or push: the plan is plain JSON passed as an artifact (stale-data
 * alert, inputs of the broken-link issue, what the tracker write needs; see runCheck).
 *
 * This script is a thin client: the logic that knows what a Learn URL is, what
 * changed and where it went lives in learnsync (scripts/lib/*.mjs, documented in
 * its DATA_CONTRACT.md) and is imported from the checkout, never reimplemented.
 * It runs in one of two modes (CHECK_SOURCE):
 *
 *   changes (default)  FAST PATH, weekly. Reads only learnsync's two small change
 *                      files (data/changes/removed.json and moved.json) through its
 *                      lookupChange(): a URL with a recorded change becomes a
 *                      finding, a URL with none is NOT probed ("no change recorded"
 *                      is not "valid"). Uses a sparse, partial checkout
 *                      (scripts/, data/changes/, data/status.json), so the multi-MB
 *                      caches are never downloaded.
 *   cache              FULL AUDIT, monthly (first Tuesday) or on demand. Also done by a
 *                      scheduled run later in the month when no full audit is on record
 *                      (the tracker's lastFullAudit is empty: the first scheduled run) or
 *                      the last one is more than 35 days old: a first-Tuesday run that was
 *                      dropped or failed is made up at the next scheduled run, not a month
 *                      later. A full audit that fails (the systemic guard, a crash) records
 *                      nothing, so the next scheduled run does it again: one that keeps
 *                      failing fails every Tuesday until it passes. Clones all of learnsync
 *                      and asks its validator (scripts/lib/validate.mjs) for a verdict per
 *                      URL against the complete caches, and probes the page kinds no cache
 *                      can answer (practice assessments, shows, collections, legacy
 *                      /certifications/ paths, ...).
 *
 * Both modes then: extract every learn.microsoft.com URL from src/ (with
 * file:line), wait until learnsync's data is fresh (see below), re-confirm the
 * doubtful findings against the live site with learnsync's live layer (verdicts
 * labelled evidence "live-probe"), open ONE issue per run for newly found links
 * (label broken-link: a "Broken links" table and a lower-urgency "Moved pages"
 * table), close issues whose links are all fixed, and track reported URLs in
 * src/data_files/learn-url-check.json so nothing is reported twice.
 *
 * Changes mode, what is reported and how it is trusted:
 *   - a recorded entry verified by learnsync within CHANGES_TRUST_DAYS (14) is
 *     reported as is (evidence "changes-ledger"), no live probe;
 *   - older, never-verified ("unverified") and low-confidence entries (an inherited
 *     module move, a redirect cycle, a truncated chain) are live-confirmed first
 *     and dropped if the live probe says the link works;
 *   - change files whose sources.learn / sources.docs stamp is older than
 *     CHANGES_STALE_DAYS (10) are stale: that is stated in the issue, the entries
 *     of a stale family are always live-confirmed, never reported from silent
 *     stale data;
 *   - tracked URLs the change files have no opinion on stay open until the next
 *     full audit (or until the link leaves the repo): a changes run cannot tell
 *     that a tracked typo was fixed upstream, only that it is still in the repo.
 *
 * "After it syncs": learnsync's scheduled runs start 6-8 hours after their cron
 * time, so a clock time proves nothing. Unless WAIT_FOR_SYNC=0 the script waits
 * (up to SYNC_WAIT_MINUTES) while a learnsync sync is queued or running AND
 * until data/status.json (the heartbeat both syncs write on every run) shows
 * both syncs finished within MAX_DATA_AGE_HOURS. It waits only while waiting can
 * help: up to SYNC_WAIT_MINUTES while a run is queued or in progress, up to
 * IDLE_WAIT_MINUTES (30) when nothing is running and a scheduled run could still
 * start late, not at all for a sync whose latest run already failed (a frozen
 * learnsync no longer costs 150 minutes on every scheduled run).
 *
 * "Stale data" alert: the check can only be as good as learnsync's data, and a
 * frozen learnsync (a failed sync, an unwatched repo, no dispatch token) used to
 * be invisible unless some link problem happened to exist. After the wait, a run
 * judges the data it is about to use: the Learn or docs heartbeat older than
 * LEARNSYNC_STALE_DAYS (6), a sync whose latest run failed after the last good
 * heartbeat while that heartbeat is already older than MAX_DATA_AGE_HOURS (the
 * Actions API read is never evidence: if it fails this cause is skipped),
 * `docs.complete` false, no heartbeat at all, or (changes
 * mode) change files whose sources stamps are stale. Then it opens ONE hub issue
 * with the stable title STALE_ISSUE_TITLE (label bug), comments on the open one
 * instead of opening a duplicate (at most one comment per run), and closes it with
 * a comment once the data is fresh again. The state is the open issue itself, not
 * the tracker, so the alert is re-derived by every run and a failed issue step
 * loses nothing. The step runs BEFORE the broken-link issue and the tracker write:
 * when it fails the run fails with nothing written, the workflow's tracker commit
 * is skipped, and a re-run reports everything again. The check itself still runs
 * on the data it has and its findings carry the stale-data caveat.
 *
 * Rate limits, timeouts and 5xx never produce a finding.
 *
 * Env overrides (defaults shown):
 *   CHECK_SOURCE         changes   changes | cache (the workflow chooses, see --choose-source)
 *   LEARNSYNC_REPO       mscerts/learnsync
 *   LEARNSYNC_REF        main
 *   LEARNSYNC_DIR        (unset)   use this full or partial checkout instead of cloning
 *   REPO_ROOT            (unset)   scan this tree instead of the repo (tests)
 *   TRACKER_FILE         src/data_files/learn-url-check.json
 *   REPORT_FILE          <tmpdir>/learn-url-check-report.md
 *   ERROR_FILE           <tmpdir>/learn-url-check-error.md
 *   GITHUB_OUTPUT        <tmpdir>/github-output
 *   WAIT_FOR_SYNC        1
 *   SYNC_WAIT_MINUTES    150       (longest wait while a learnsync run is queued or in progress)
 *   IDLE_WAIT_MINUTES    30        (longest wait when no run is in flight and only a late scheduled start could refresh the data)
 *   POLL_MINUTES         5
 *   RAW_GITHUB_URL       https://raw.githubusercontent.com   (tests only: serve data/status.json from a local server)
 *   MAX_DATA_AGE_HOURS   48        (heartbeat age limit, both modes)
 *   CHANGES_TRUST_DAYS   14        (changes: report a ledger entry verified this recently without a probe)
 *   CHANGES_STALE_DAYS   10        (changes: a change-file source stamp older than this is stale)
 *   LEARNSYNC_STALE_DAYS 6         (heartbeat age that raises the "learnsync data is stale" issue, both modes)
 *   STALE_REPORT_FILE    <tmpdir>/learn-url-check-stale.md   (the stale-data issue text, written whenever the data is stale)
 *   PLAN_FILE            <tmpdir>/learn-url-check-plan.json  (--check writes it, --publish reads it)
 *   PROBE_UNVERIFIABLE   1         (cache: probe page kinds no cache covers)
 *   LIVE_CONCURRENCY     3
 *   LIVE_DELAY_MS        500
 *   MAX_FLAGGED          80        (more broken links than this in one run = systemic, no issue)
 *   MAX_FLAGGED_PCT      25        (percent of all URLs)
 *   CREATE_ISSUES        0         (1 = create/close issues with the gh CLI)
 *   DRY_RUN              0         (1 = do not write the tracker or touch issues)
 *   GH_TOKEN / GITHUB_REPOSITORY   used for the gh CLI and the GitHub API
 *   GITHUB_API_URL       https://api.github.com   (set by Actions; tests point it at a local server)
 *   GH_CLI_SCRIPT        (unset)   tests only: run this Node script instead of the gh CLI
 *   --choose-source reads EVENT_NAME (github.event_name), FULL_AUDIT (the full_audit input) and the
 *   tracker's lastFullAudit.
 *
 * Writes GITHUB_OUTPUT keys: tracker_updated, new_count, check_failed, learnsync_stale (and plan_written with --check).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { annotate, writeOutput } from "./lib/actions.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT (tests only) points the scan and the tracker at another tree
const root = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = process.env;
const resolveFromRoot = (path) => (isAbsolute(path) ? path : join(root, path));

/**
 * A learnsync heartbeat older than this many days raises the stale-data issue
 * (LEARNSYNC_STALE_DAYS). Six, not eight: the Tuesday 06:00 check of a healthy
 * week sees a heartbeat that is at most about a day and a half old, while the
 * heartbeat that one missed weekly sync leaves behind is 6.3 to 7.9 days old at
 * the next Tuesday check (checked 2026-10-13: Learn heartbeat 2026-10-06 22:06 UTC
 * was 6.3 days old). A limit of 8 only noticed that a week later. A manual run on
 * a Sunday can see a healthy 6.x-day-old heartbeat; the issue closes itself at the
 * next fresh check.
 */
export const DEFAULT_STALE_ALERT_DAYS = 6;
/** The most that a run waits for a sync that nothing is running for (IDLE_WAIT_MINUTES). */
export const DEFAULT_IDLE_WAIT_MINUTES = 30;
/** The stable title of the stale-data issue: runs find the open one by this exact title. */
export const STALE_ISSUE_TITLE = "Learn URL Check: learnsync data is stale";
export const STALE_ISSUE_LABEL = "bug";

const CONFIG = {
  repo: env.LEARNSYNC_REPO ?? "mscerts/learnsync",
  ref: env.LEARNSYNC_REF ?? "main",
  dir: env.LEARNSYNC_DIR ? resolveFromRoot(env.LEARNSYNC_DIR) : null,
  trackerFile: resolveFromRoot(
    env.TRACKER_FILE ?? "src/data_files/learn-url-check.json",
  ),
  reportFile: env.REPORT_FILE ?? join(tmpdir(), "learn-url-check-report.md"),
  errorFile: env.ERROR_FILE ?? join(tmpdir(), "learn-url-check-error.md"),
  staleReportFile:
    env.STALE_REPORT_FILE ?? join(tmpdir(), "learn-url-check-stale.md"),
  planFile: env.PLAN_FILE ?? join(tmpdir(), "learn-url-check-plan.json"),
  githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
  waitForSync: (env.WAIT_FOR_SYNC ?? "1") !== "0",
  syncWaitMinutes: Number(env.SYNC_WAIT_MINUTES ?? 150),
  idleWaitMinutes: Number(env.IDLE_WAIT_MINUTES ?? DEFAULT_IDLE_WAIT_MINUTES),
  pollMinutes: Number(env.POLL_MINUTES ?? 5),
  // tests only: serve data/status.json from a local server
  rawBaseUrl: (
    env.RAW_GITHUB_URL || "https://raw.githubusercontent.com"
  ).replace(/\/+$/, ""),
  maxDataAgeHours: Number(env.MAX_DATA_AGE_HOURS ?? 48),
  changesTrustDays: Number(env.CHANGES_TRUST_DAYS ?? 14),
  changesStaleDays: Number(env.CHANGES_STALE_DAYS ?? 10),
  probeUnverifiable: (env.PROBE_UNVERIFIABLE ?? "1") !== "0",
  liveConcurrency: Number(env.LIVE_CONCURRENCY ?? 3),
  liveDelayMs: Number(env.LIVE_DELAY_MS ?? 500),
  maxFlagged: Number(env.MAX_FLAGGED ?? 80),
  maxFlaggedPct: Number(env.MAX_FLAGGED_PCT ?? 25),
  createIssues: env.CREATE_ISSUES === "1",
  dryRun: env.DRY_RUN === "1",
  label: "broken-link",
};

const SYNC_WORKFLOWS = [
  "learn-catalog-monitor.yml",
  "docs-catalog-monitor.yml",
];

/** What a changes-mode run needs from learnsync: its code, the change files and the heartbeat. Nothing else. */
export const SPARSE_PATHS = [
  "/package.json",
  "/scripts/",
  "/data/changes/",
  "/data/status.json",
];
const CHANGE_FILE_NAMES = ["removed.json", "moved.json"];

/** A scheduled run does the full audit whenever none is on record or the last one is older than this many days. */
export const FULL_AUDIT_MAX_AGE_DAYS = 35;

/**
 * The monthly full audit: the first Tuesday of the month, i.e. a scheduled run on day 1-7.
 * A scheduled run later in the month does it too when none is on record (the tracker never
 * recorded one) or the last one is more than FULL_AUDIT_MAX_AGE_DAYS old (a dropped or
 * failed first-Tuesday run is made up at the next scheduled run, not a month later).
 */
export const FULL_AUDIT_RULE = `the first Tuesday of each month (the scheduled run on day 1 to 7 of the month; a scheduled run later in the month does it too when no full audit is on record or the last one is more than ${FULL_AUDIT_MAX_AGE_DAYS} days old), or on demand with the \`full_audit\` input of the workflow`;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Scan only content that this repo owns. Generated trackers/caches and the
// scripts that themselves contain Learn API URLs are excluded: a tracker a
// script rewrites holds Learn addresses (pages it watches, text it stored) that
// a person cannot fix by hand. The hand-edited watch list (watched-sources.json)
// and the lab repository ignore list stay in, a dead address there is worth
// flagging; a test keeps this list in step with the trackers the scripts write.
const SCAN_ROOTS = ["src"];
const SCAN_EXT = /\.(mdx?|astro|ts|tsx|js|mjs|json)$/;
const SCAN_SKIP =
  /(node_modules|[\\/]dist[\\/]|[\\/]\.astro[\\/]|[\\/]data_files[\\/](applied-skills-cache|course-videos|measureup-products|missing-resources|public-routes|resource-favicons|voucher-challenges|beta-exams|retiring-exams|retirement-schedule|partner-designations|learn-exams|learn-content-watch|learn-url-check|source-watch|skills-hub-posts|lab-repos|link-failures|voucher-review)\.json)/;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Blank out MDX/HTML comments but keep newlines so line numbers stay right. */
export function stripComments(text) {
  return text.replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, (m) =>
    m.replace(/[^\n]/g, ""),
  );
}

/**
 * All real learn.microsoft.com URLs in a text, with 1-based line numbers.
 * URLs that contain template-literal or placeholder characters (`${...}`,
 * `{code}`, `%7B`) come from code, not content, and are not links.
 */
export function extractLearnUrls(text) {
  const found = [];
  const re = /https?:\/\/learn\.microsoft\.com\/[^\s"'<>)\]}`\\]*/gi;
  stripComments(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const match of line.matchAll(re)) {
        const raw = match[0].replace(/[.,;:!?]+$/, "");
        if (/[${}]|%7b|%24/i.test(raw)) continue;
        found.push({ raw, line: i + 1 });
      }
    });
  return found;
}

/**
 * Where learnsync's scheduled syncs stand. GitHub starts scheduled runs 6-8
 * hours after their cron time, so "after it syncs" cannot be a clock time:
 * wait while a run is queued or in progress.
 */
export function syncState(runsByWorkflow) {
  const inFlight = [];
  const failed = [];
  for (const [workflow, runs] of Object.entries(runsByWorkflow)) {
    const active = runs.filter((r) => r.status !== "completed");
    for (const r of active) inFlight.push(`${workflow}#${r.run_number}`);
    const done = runs.find((r) => r.status === "completed");
    if (!active.length && done && done.conclusion !== "success") {
      failed.push(`${workflow}#${done.run_number} (${done.conclusion})`);
    }
  }
  return { inFlight, failed };
}

/**
 * Is learnsync's heartbeat (data/status.json) fresh? Both syncs must have
 * finished within maxAgeHours. Returns the sections that are still stale.
 */
export function staleSections(status, now = Date.now(), maxAgeHours = 48) {
  const stale = [];
  for (const section of ["learn", "docs"]) {
    const at = Date.parse(status?.[section]?.generatedAt ?? "");
    if (Number.isNaN(at) || now - at > maxAgeHours * 3_600_000) {
      stale.push(section);
    }
  }
  return stale;
}

/** Which heartbeat section (data/status.json) each learnsync sync workflow writes. */
const SYNC_SECTION = {
  "learn-catalog-monitor.yml": "learn",
  "docs-catalog-monitor.yml": "docs",
};

/**
 * The syncs that failed and left their data behind: `summaries` is
 * summarizeSyncRuns() output. A sync counts when its section's heartbeat is
 * older than maxAgeHours (the bar the wait uses for "not refreshed"), its latest
 * run has completed without success (a run still queued or running is waited
 * for, not failed) and that run started after the last good heartbeat, so nothing
 * has refreshed the data since. That is what a frozen learnsync looks like on the
 * first check after the failure, however old the heartbeat is yet: on 2026-10-13
 * the Learn heartbeat was 6.3 days old and the failed run 11 was a day old.
 * Returns [{ section, workflow, label, run, heartbeat }].
 */
export function failedSyncSections(
  summaries,
  status,
  now = Date.now(),
  maxAgeHours = 48,
) {
  const stale = new Set(staleSections(status, now, maxAgeHours));
  const out = [];
  for (const summary of summaries ?? []) {
    const section = SYNC_SECTION[summary?.workflow];
    const run = summary?.latest;
    if (!section || !run || !stale.has(section)) continue;
    if (run.status !== "completed" || run.conclusion === "success") continue;
    const beat = Date.parse(status?.[section]?.generatedAt ?? "");
    const at = Date.parse(run.at ?? "");
    // a failure from before the last good sync explains nothing about the data
    if (!Number.isNaN(beat) && !Number.isNaN(at) && at <= beat) continue;
    out.push({
      section,
      workflow: summary.workflow,
      label: summary.label,
      run,
      heartbeat: Number.isNaN(beat) ? null : new Date(beat).toISOString(),
    });
  }
  return out;
}

/**
 * What waiting for learnsync can still achieve. `inFlight` runs will write a
 * heartbeat; a stale section whose latest run failed will not (`failed`, nothing
 * to wait for); any other stale section (`late`) may still be refreshed by a
 * scheduled run that GitHub has not started yet. kind is "running" while a run is
 * queued or in progress (wait up to SYNC_WAIT_MINUTES), "late" when only a late
 * start is possible (wait up to IDLE_WAIT_MINUTES), "settled" when waiting cannot
 * help: a frozen learnsync used to cost 150 minutes on every scheduled run.
 */
export function syncWaitPlan(
  runsByWorkflow,
  status,
  now = Date.now(),
  maxAgeHours = 48,
) {
  const { inFlight } = syncState(runsByWorkflow);
  const failed = failedSyncSections(
    summarizeSyncRuns(runsByWorkflow),
    status,
    now,
    maxAgeHours,
  );
  const failedSections = new Set(failed.map((f) => f.section));
  const late = staleSections(status, now, maxAgeHours).filter(
    (section) => !failedSections.has(section),
  );
  return {
    inFlight,
    failed,
    late,
    kind: inFlight.length ? "running" : late.length ? "late" : "settled",
  };
}

/** Compare flagged URLs with the tracker. */
export function diffTracker(trackerOpen, flaggedUrls, presentUrls) {
  const flagged = new Set(flaggedUrls);
  const fresh = flaggedUrls.filter((u) => !(u in trackerOpen));
  const stillOpen = Object.keys(trackerOpen).filter((u) => flagged.has(u));
  const resolved = Object.keys(trackerOpen).filter(
    (u) => !flagged.has(u) || !presentUrls.has(u),
  );
  return { fresh, stillOpen, resolved };
}

// ---------------------------------------------------------------------------
// Which source a run uses: change files (weekly fast path) or the full caches
// ---------------------------------------------------------------------------

/** CHECK_SOURCE: unset or blank = "changes"; anything but changes|cache is a typo and throws. */
export function selectCheckSource(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!v) return "changes";
  if (v === "changes" || v === "cache") return v;
  throw new Error(
    `Invalid CHECK_SOURCE=${JSON.stringify(value)} (expected "changes" or "cache")`,
  );
}

/** Scheduled runs happen on Tuesdays, so day 1-7 of the month (UTC) is the first Tuesday. */
export function isFullAuditDay(now = new Date()) {
  return now.getUTCDate() <= 7;
}

/**
 * Is the last full audit (`lastFullAudit`, YYYY-MM-DD, from the tracker) overdue on the UTC
 * day of `now`? Yes when none is on record (null, undefined or empty: a tracker that never
 * recorded one, so the first scheduled run does it) and when it is more than
 * FULL_AUDIT_MAX_AGE_DAYS old. The first Tuesdays of two months are 28 or 35 days apart, so a
 * month that was audited is never overdue; one whose scheduled run was dropped or failed is.
 * A malformed or a future date is not overdue: something is recorded, just nothing that says
 * an audit is missing.
 */
export function isFullAuditOverdue(
  lastFullAudit,
  now = new Date(),
  maxAgeDays = FULL_AUDIT_MAX_AGE_DAYS,
) {
  // none on record: the first scheduled run does the audit
  if (lastFullAudit === null || lastFullAudit === undefined) return true;
  if (lastFullAudit === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastFullAudit)) return false;
  const last = Date.parse(`${lastFullAudit}T00:00:00Z`);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return (today - last) / DAY_MS > maxAgeDays;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/**
 * The source the workflow gives a run: a full audit on a scheduled run on the
 * first Tuesday of the month or later when the last full audit (`lastFullAudit`,
 * the tracker's) is overdue (none on record, or more than 35 days old), a manual
 * run with `full_audit`, the change files for every other scheduled, manual or
 * repository_dispatch run. A manual run keeps its explicit choice whatever the
 * tracker says.
 */
export function chooseCheckSource({
  eventName,
  fullAudit = false,
  now = new Date(),
  lastFullAudit = null,
} = {}) {
  if (eventName === "workflow_dispatch") {
    return truthy(fullAudit) ? "cache" : "changes";
  }
  if (eventName === "schedule") {
    return isFullAuditDay(now) || isFullAuditOverdue(lastFullAudit, now)
      ? "cache"
      : "changes";
  }
  return "changes";
}

/**
 * The date of the last full audit in the tracker file; null when there is none to be read: no
 * file, no audit on record, or a file that cannot be read (all three mean that no audit is
 * on record, which is overdue). Anything else that is there is returned as text, so that
 * a malformed value stays "malformed" for isFullAuditOverdue. Never throws: choosing a
 * source must not be what fails, and the check step itself fails on a corrupt tracker, loudly.
 */
export function readLastFullAudit(file) {
  try {
    const date = JSON.parse(readFileSync(file, "utf8"))?.lastFullAudit;
    return date === undefined || date === null ? null : String(date);
  } catch {
    return null;
  }
}

/** What --choose-source prints, from the workflow's environment (EVENT_NAME, FULL_AUDIT) and the tracker. */
export function chooseSourceFromEnv(
  e = env,
  { trackerFile = CONFIG.trackerFile, now = new Date() } = {},
) {
  const lastFullAudit = readLastFullAudit(trackerFile);
  const source = chooseCheckSource({
    eventName: e.EVENT_NAME,
    fullAudit: e.FULL_AUDIT,
    now,
    lastFullAudit,
  });
  return { source, lastFullAudit };
}

/**
 * The first scheduled full audit after `now` as YYYY-MM-DD: the next first Tuesday
 * (UTC), or an earlier Tuesday when the last full audit will be overdue by then; with no
 * audit on record (`lastFullAudit` null) that is the next Tuesday.
 */
export function nextFullAuditDate(now = new Date(), lastFullAudit = null) {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  for (let i = 0; i < 45; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (
      d.getUTCDay() === 2 &&
      (d.getUTCDate() <= 7 || isFullAuditOverdue(lastFullAudit, d))
    ) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

/** git commands that fetch learnsync for a source; cwd "dir" means run inside the clone. */
export function checkoutCommands(source, { repo, ref, dir }) {
  const url = `https://github.com/${repo}.git`;
  if (source === "cache") {
    return [{ args: ["clone", "--depth", "1", "--branch", ref, url, dir] }];
  }
  return [
    {
      args: [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        ref,
        url,
        dir,
      ],
    },
    {
      args: ["sparse-checkout", "set", "--no-cone", ...SPARSE_PATHS],
      inDir: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Changes mode: freshness of the change files, trust rules, findings
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

/** The older of the two change files' stamps for a family (null when neither has one). */
function ledgerStamp(changes, family) {
  const times = ["removed", "moved"]
    .map((file) => Date.parse(changes?.[file]?.sources?.[family] ?? ""))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * How fresh the change files are, per family: the `sources.learn` /
 * `sources.docs` stamps say when learnsync last refreshed those entries. A
 * missing stamp or one older than maxAgeDays is stale.
 */
export function ledgerFreshness(changes, now = Date.now(), maxAgeDays = 10) {
  const out = { staleFamilies: [] };
  for (const family of ["learn", "docs"]) {
    const stamp = ledgerStamp(changes, family);
    const exactDays =
      stamp === null ? null : (now - Date.parse(stamp)) / DAY_MS;
    // the limit is judged on the exact age; the rounded one is for display
    const stale = stamp === null || exactDays > maxAgeDays;
    const ageDays = exactDays === null ? null : Math.round(exactDays * 10) / 10;
    out[family] = { stamp, ageDays, stale };
    if (stale) out.staleFamilies.push(family);
  }
  return out;
}

/** Issue notes for stale change-file families (empty when both are fresh). */
export function ledgerNotes(freshness, maxAgeDays = 10) {
  const notes = [];
  for (const [family, label] of [
    ["learn", "Learn"],
    ["docs", "docs"],
  ]) {
    const f = freshness[family];
    if (!f.stale) continue;
    notes.push(
      f.stamp === null
        ? `The change files carry no ${label} refresh stamp (sources.${family} is null), so "no change recorded" says nothing about ${label} links; every recorded ${label} change was live-confirmed before it was reported.`
        : `The ${label} entries of the change files were last refreshed ${f.stamp.slice(0, 10)} (${Math.floor(f.ageDays)} days ago, limit ${maxAgeDays}), so "no change recorded" is not reliable for ${label} links; every recorded ${label} change was live-confirmed before it was reported.`,
    );
  }
  return notes;
}

/** Issue notes from learnsync's heartbeat (data/status.json) in a changes run. */
export function heartbeatNotes(status, now = Date.now(), maxAgeHours = 48) {
  if (!status) {
    return [
      "learnsync has no heartbeat (data/status.json), so the freshness of its sync could not be judged.",
    ];
  }
  const notes = [];
  for (const [section, label] of [
    ["learn", "Learn"],
    ["docs", "docs"],
  ]) {
    const at = Date.parse(status?.[section]?.generatedAt ?? "");
    if (Number.isNaN(at)) {
      notes.push(`learnsync has no ${label} heartbeat yet.`);
    } else if (now - at > maxAgeHours * 3_600_000) {
      notes.push(
        `The ${label} sync heartbeat is ${Math.round((now - at) / 3_600_000)} hours old (limit ${maxAgeHours}).`,
      );
    }
  }
  if (status?.docs?.complete === false) {
    notes.push(
      "The docs index was incomplete in the latest learnsync run (a sitemap file failed or work was deferred), so its removal detection was off and recent docs changes may be missing from the change files.",
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// "learnsync data is stale": is the data this run uses fresh, and the one hub
// issue that says so (opened, commented on, closed; never duplicated)
// ---------------------------------------------------------------------------

/**
 * LEARNSYNC_STALE_DAYS: unset or blank is the default; anything that is not a
 * positive number throws, because a typo (NaN never compares as "older") must not
 * silently switch the alert off.
 */
export function parseStaleAlertDays(
  value,
  fallback = DEFAULT_STALE_ALERT_DAYS,
) {
  const v = String(value ?? "").trim();
  if (!v) return fallback;
  const days = Number(v);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(
      `Invalid LEARNSYNC_STALE_DAYS=${JSON.stringify(value)} (expected a positive number of days)`,
    );
  }
  return days;
}

const utcStamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const roundDays = (ms) => Math.round((ms / DAY_MS) * 10) / 10;

/**
 * Is the data this run uses stale? `status` is learnsync's data/status.json (or
 * the same shape built from the validator's freshness in a full audit); `ledger`
 * is ledgerFreshness() of the change files (changes mode only, else null).
 * Stale means any of: no heartbeat, a Learn or docs heartbeat older than
 * maxAgeDays (exactly maxAgeDays is still fresh), a sync whose latest run failed
 * after the last good heartbeat while that heartbeat is already older than
 * maxDataAgeHours (`syncRuns` is summarizeSyncRuns() output, null when the
 * Actions API could not be read: a failed read is never evidence), `docs.complete`
 * false, a change file source stamp missing or older than ledgerMaxAgeDays.
 * Returns the problems in the words the issue uses, and the facts the "fresh
 * again" comment quotes.
 */
export function learnsyncStaleness({
  status,
  ledger = null,
  syncRuns = null,
  now = Date.now(),
  maxAgeDays = DEFAULT_STALE_ALERT_DAYS,
  maxDataAgeHours = 48,
  ledgerMaxAgeDays = 10,
} = {}) {
  const problems = [];
  const facts = {
    learnAt: null,
    docsAt: null,
    docsComplete: null,
    ledgerLearnAt: ledger?.learn?.stamp ?? null,
    ledgerDocsAt: ledger?.docs?.stamp ?? null,
  };
  if (!status || typeof status !== "object") {
    problems.push({
      id: "heartbeat-missing",
      text: "**Heartbeat:** learnsync has no readable `data/status.json`, so no sync can be shown to have finished.",
      since: null,
    });
  } else {
    for (const [section, label] of [
      ["learn", "Learn"],
      ["docs", "docs"],
    ]) {
      const at = Date.parse(status[section]?.generatedAt ?? "");
      if (Number.isNaN(at)) {
        problems.push({
          id: `${section}-heartbeat-missing`,
          text: `**${label} data:** learnsync has no ${label} heartbeat (\`${section}.generatedAt\` in \`data/status.json\`), so no ${label} sync can be shown to have finished.`,
          since: null,
        });
        continue;
      }
      const iso = new Date(at).toISOString();
      facts[`${section}At`] = iso;
      if (now - at > maxAgeDays * DAY_MS) {
        problems.push({
          id: `${section}-old`,
          text: `**${label} data:** the last good ${label} sync finished ${utcStamp(iso)} (${roundDays(now - at)} days ago; the limit is ${maxAgeDays}).`,
          since: iso,
        });
      }
    }
    for (const failed of failedSyncSections(
      syncRuns,
      status,
      now,
      maxDataAgeHours,
    )) {
      const label = failed.section === "learn" ? "Learn" : "docs";
      problems.push({
        id: `${failed.section}-sync-failed`,
        text: `**${label} sync failed:** the latest ${failed.label} ${describeRun(failed.run)}, after the last good ${label} sync${failed.heartbeat ? ` (${utcStamp(failed.heartbeat)})` : ""}, so nothing has refreshed the ${label} data since.`,
        since: failed.run.at ?? null,
      });
    }
    facts.docsComplete = status.docs?.complete ?? null;
    if (status.docs?.complete === false) {
      const d = status.docs;
      const counts = [
        [d.pendingNew, "new URLs still to be downloaded"],
        [d.deferredChanged, "changed URLs deferred"],
        [d.deferredMissing, "missing URLs deferred"],
        [d.sitemapFailures, "sitemap file failures"],
      ]
        .filter(([n]) => Number.isFinite(n))
        .map(([n, what]) => `${n} ${what}`);
      problems.push({
        id: "docs-incomplete",
        text: `**Docs index incomplete:** the latest docs sync${facts.docsAt ? ` (${utcStamp(facts.docsAt)})` : ""} reports \`docs.complete: false\`${counts.length ? ` (${counts.join(", ")})` : ""}. Its removal detection was off, so recent docs removals and moves may be missing from the change files.`,
        since: facts.docsAt,
      });
    }
  }
  for (const [family, label] of [
    ["learn", "Learn"],
    ["docs", "docs"],
  ]) {
    const f = ledger?.[family];
    if (!f?.stale) continue;
    problems.push({
      id: `${family}-changes-stale`,
      text:
        f.stamp === null
          ? `**Change files (${label}):** no refresh stamp (\`sources.${family}\` is null), so "no change recorded" says nothing about ${label} links.`
          : `**Change files (${label}):** last refreshed ${utcStamp(f.stamp)} (${f.ageDays} days ago; the limit is ${ledgerMaxAgeDays}), so "no change recorded" is not reliable for ${label} links.`,
      since: f.stamp,
    });
  }
  return {
    stale: problems.length > 0,
    problems,
    facts,
    limits: { heartbeatDays: maxAgeDays, changesDays: ledgerMaxAgeDays },
  };
}

const SYNC_WORKFLOW_LABELS = {
  "learn-catalog-monitor.yml": "Learn Catalog Monitor",
  "docs-catalog-monitor.yml": "Docs Catalog Monitor",
};

/** Only links to github.com are put into an issue, whatever an API answer says. */
const githubUrl = (url) =>
  typeof url === "string" && /^https:\/\/github\.com\//.test(url) ? url : null;

/**
 * Text from learnsync (issue titles anyone can write, API error messages) goes
 * into a hub issue: no HTML, no brackets or backticks, no mentions or issue
 * references that would ping or link someone, clipped to `max` characters.
 */
export function plain(value, max = 200) {
  const text = String(value ?? "")
    .replace(/[<>[\]`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@/g, "@​")
    .replace(/#(?=\d)/g, "#​");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The latest run and the latest successful run of each learnsync sync workflow, from the Actions API (newest first). */
export function summarizeSyncRuns(runsByWorkflow) {
  const brief = (r) =>
    r
      ? {
          number: r.run_number,
          status: r.status,
          conclusion: r.conclusion ?? null,
          event: r.event ?? null,
          at: r.created_at ?? null,
          url: githubUrl(r.html_url),
        }
      : null;
  return Object.entries(runsByWorkflow ?? {}).map(([workflow, runs]) => ({
    workflow,
    label: SYNC_WORKFLOW_LABELS[workflow] ?? workflow,
    latest: brief((runs ?? [])[0]),
    lastSuccess: brief(
      (runs ?? []).find(
        (r) => r.status === "completed" && r.conclusion === "success",
      ),
    ),
  }));
}

const RUN_VERBS = {
  success: "succeeded",
  failure: "failed",
  cancelled: "was cancelled",
  timed_out: "timed out",
  skipped: "was skipped",
  startup_failure: "failed to start",
};

/** The YYYY-MM-DD of an API timestamp, or null. */
const dayOf = (iso) =>
  /^\d{4}-\d{2}-\d{2}/.test(String(iso ?? ""))
    ? String(iso).slice(0, 10)
    : null;

// "run 11", never "#11": a #number in a hub issue would link to a hub issue
function describeRun(run) {
  const verb =
    run.status !== "completed"
      ? `is ${plain(run.status, 30).replace(/_/g, " ")}`
      : (RUN_VERBS[run.conclusion] ??
        `ended with ${plain(run.conclusion ?? "no conclusion", 40)}`);
  const when = dayOf(run.at) ? ` on ${dayOf(run.at)}` : "";
  const link = run.url ? ` ([open run](${run.url}))` : "";
  return `run ${plain(run.number, 12)} ${verb}${when}${link}`;
}

/**
 * The text of the stale-data issue (kind "issue": what is stale, what learnsync
 * reports, what to do) or of the comment added to the open one (kind "comment":
 * the same state without the advice). `runs` is summarizeSyncRuns() output and
 * `issues` learnsync's open `bug` issues, either null when the GitHub API could
 * not be read (`errors.runs` / `errors.issues` say why): that only changes the
 * wording, never whether the alert is raised.
 */
export function buildStaleReport({
  staleness,
  runs = null,
  issues = null,
  errors = {},
  today,
  runUrl = null,
  repo = "mscerts/learnsync",
  kind = "issue",
}) {
  const repoLink = `[${repo}](https://github.com/${repo})`;
  const lines = [];
  if (kind === "issue") {
    lines.push(
      `The weekly Learn URL Check takes its data from ${repoLink}, and that data is stale. While it is, "no broken link found" means little: the check can only report links that learnsync has already recorded as removed or moved.`,
      "",
    );
  } else {
    lines.push(`**Still stale on ${today}.**`, "");
  }
  lines.push(`### What is stale (${today})`, "");
  lines.push(...staleness.problems.map((p) => `- ${p.text}`));
  lines.push("", "### What learnsync reports", "");
  if (runs) {
    for (const r of runs) {
      // the latest run is often also the last success (a docs sync that finished but left work deferred)
      const success = !r.lastSuccess
        ? "; no successful run among the latest 10"
        : r.latest?.number === r.lastSuccess.number
          ? ""
          : `; last success ${describeRun(r.lastSuccess)}`;
      lines.push(
        `- ${r.label}: ${r.latest ? `latest ${describeRun(r.latest)}` : "no run found"}${success}.`,
      );
    }
  } else {
    lines.push(
      `- The workflow runs of ${repo} could not be read through the GitHub API${errors.runs ? ` (${plain(errors.runs)})` : ""}; check [its Actions page](https://github.com/${repo}/actions).`,
    );
  }
  if (issues && issues.length) {
    lines.push(`- Open issues of ${repo} labelled \`bug\`:`);
    for (const i of issues.slice(0, 5)) {
      const url = githubUrl(i.html_url);
      const ref = url ? `[${repo}#${plain(i.number, 12)}](${url})` : "an issue";
      lines.push(
        `  - ${ref} ${plain(i.title)}${dayOf(i.created_at) ? ` (opened ${dayOf(i.created_at)})` : ""}`,
      );
    }
  } else if (issues) {
    lines.push(`- ${repo} has no open issue labelled \`bug\`.`);
  } else {
    lines.push(
      `- The open issues of ${repo} could not be read through the GitHub API${errors.issues ? ` (${plain(errors.issues)})` : ""}; check [its issues](https://github.com/${repo}/issues).`,
    );
  }
  if (kind === "issue") {
    lines.push(
      "",
      "### What you can do",
      "",
      `1. Open the failed run or issue above in ${repoLink} and fix its cause (a failsafe that needs a data or allowlist change, say). An incomplete docs index with no failed run is a backlog that the next syncs work off. Either way the first check that finds the data fresh closes this issue.`,
      `2. Watch ${repoLink} (Watch, Custom, Issues): its failure alerts are issues in that repository, so nobody sees them otherwise.`,
      "3. Optional: the repository secret `HUB_DISPATCH_TOKEN` in learnsync (a token that may create repository dispatch events on this repository) only makes a successful sync trigger this check immediately. This alert does not need it: without the secret the check runs on its own Tuesday schedule and raises this issue the same way.",
      "",
      "### What this check still did",
      "",
      `It ran on the data it has. Broken or moved links it found are in their own issue (label \`broken-link\`) and carry the same stale-data caveat. This issue gets one comment per check run while the data stays stale, and the check closes it with a comment once the data is fresh again (heartbeats at most ${staleness.limits.heartbeatDays} days old, docs index complete, change files refreshed within ${staleness.limits.changesDays} days).`,
    );
  }
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  return lines.join("\n") + "\n";
}

/** The closing comment: the fresh facts that ended the alert. */
export function buildFreshComment({ staleness, today, runUrl = null }) {
  const f = staleness.facts;
  const at = (iso) => (iso ? utcStamp(iso) : "unknown");
  const parts = [
    `Learn heartbeat ${at(f.learnAt)}`,
    `docs heartbeat ${at(f.docsAt)}${f.docsComplete === true ? " (index complete)" : ""}`,
  ];
  if (f.ledgerLearnAt || f.ledgerDocsAt) {
    parts.push(
      `change files refreshed ${at(f.ledgerLearnAt)} (Learn) and ${at(f.ledgerDocsAt)} (docs)`,
    );
  }
  return `learnsync data is fresh again as of ${today}: ${parts.join(", ")}. Closing this issue; the next check that finds the data stale opens a new one.${runUrl ? `\n\nRun: ${runUrl}` : ""}`;
}

/** The open stale-data issues of this repo (exact title match, oldest first). Throws when gh fails. */
export function listOpenStaleIssues(gh) {
  return listOpenIssues(gh, {
    title: STALE_ISSUE_TITLE,
    label: STALE_ISSUE_LABEL,
  });
}

/**
 * Bring the hub's issues in line with the data's state, through `gh(args)`
 * (spawns the gh CLI, throws on failure):
 *   stale, none open   create ONE issue (title STALE_ISSUE_TITLE, label bug);
 *   stale, one open    add ONE comment to it, never a second issue (with several
 *                      open copies, to the oldest only);
 *   fresh, some open   close each with the "fresh again" comment;
 *   not `enabled`      (DRY_RUN or CREATE_ISSUES=0) touch nothing, not even to read.
 * The state is the open issue, not the tracker: every run re-derives it, so a
 * failed step loses nothing. When the data is stale a failed lookup or write
 * throws (the run fails visibly, nothing else was written yet); when it is fresh
 * a failed lookup or close is only reported, the next run tries again.
 */
export function reconcileStaleIssue({
  stale,
  enabled,
  gh,
  issueBody,
  commentBody,
  closeComment,
}) {
  const result = (action, extra = {}) => ({
    action,
    number: null,
    closed: [],
    error: null,
    ...extra,
  });
  if (!enabled) return result(stale ? "skipped" : "none");
  let open;
  try {
    open = listOpenStaleIssues(gh);
  } catch (err) {
    if (stale) throw err;
    return result("lookup-failed", { error: err.message });
  }
  if (stale) {
    if (open.length) {
      const number = open[0].number;
      gh(["issue", "comment", String(number), "--body", commentBody]);
      return result("commented", { number });
    }
    // "bug" exists in almost every repo; a failed creation only matters when it does not
    ensureLabel(gh, STALE_ISSUE_LABEL, {
      color: "d73a4a",
      description: "Something isn't working",
    });
    const out = gh([
      "issue",
      "create",
      "--title",
      STALE_ISSUE_TITLE,
      "--label",
      STALE_ISSUE_LABEL,
      "--body",
      issueBody,
    ]);
    return result("created", {
      number: Number(out.match(/\/issues\/(\d+)/)?.[1]) || null,
    });
  }
  const closed = [];
  const failures = [];
  for (const issue of open) {
    try {
      gh(["issue", "close", String(issue.number), "--comment", closeComment]);
      closed.push(issue.number);
    } catch (err) {
      failures.push(err.message);
    }
  }
  return result(
    closed.length ? "closed" : failures.length ? "close-failed" : "none",
    { number: closed[0] ?? null, closed, error: failures.join("; ") || null },
  );
}

/** Was `date` (YYYY-MM-DD) at most `days` days before `today`? A missing, malformed or future date is not recent. */
export function recentlyVerified(date, today, days = 14) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return false;
  const diff =
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
    DAY_MS;
  return diff >= 0 && diff <= days;
}

/**
 * May this recorded change be reported without a live probe? Only a
 * high-confidence one whose every entry (the one the path matched and the one
 * that decided) was verified by learnsync recently, is not "unverified" and
 * belongs to a family whose change files are fresh. Everything else is
 * live-confirmed first.
 */
export function needsLiveConfirmation(
  hit,
  { today, trustDays = 14, staleFamilies = [] } = {},
) {
  if (hit.confidence !== "high") return true;
  const stale = new Set(staleFamilies);
  return [hit.entry, hit.final].some(
    (e) =>
      !e ||
      e.outcome === "unverified" ||
      stale.has(e.family) ||
      !recentlyVerified(e.lastVerified, today, trustDays),
  );
}

/**
 * A lookupChange() hit as a validator-shaped result, so toFindings() and the live layer treat it like a cache verdict.
 * The destination rules are learnsync's own (its validator's enrichWithChange): only a high-confidence record
 * gives a `redirectsTo`, and only a MOVED one a `suggestion`. For a removed link `to` is where Learn sends visitors
 * (Browse all training, a learning path, the module root or an ancestor page): that is not a replacement, so it is
 * never offered as the "Suggested fix". An inherited (low-confidence) move is a guess; only the live probe may name
 * its destination.
 */
export function ledgerResult(path, info, hit) {
  const verified = hit.final?.lastVerified ?? "never";
  const destination = hit.confidence === "high" && hit.to ? hit.to : null;
  return {
    url: [...info.raws][0],
    path,
    kind: hit.entry.kind,
    verdict: hit.state === "removed" ? "broken" : "moved",
    reason: `${hit.reason}; first recorded ${hit.entry.firstSeen}, last verified ${verified}`,
    evidence: "changes-ledger",
    confidence: hit.confidence,
    redirectsTo: destination,
    suggestion:
      destination && hit.state === "moved"
        ? `https://learn.microsoft.com${destination}`
        : null,
  };
}

/**
 * Look every repo URL up in the change files (`lookup(path)` is learnsync's
 * lookupChange over its index). A URL with no recorded change is not probed.
 * A recorded one that needsLiveConfirmation() goes through learnsync's live
 * layer (`liveLayer`); the rest is reported as recorded.
 */
export async function evaluateChanges({
  repoUrls,
  lookup,
  liveLayer,
  today,
  trustDays = 14,
  staleFamilies = [],
  live = {},
}) {
  const recorded = [];
  for (const [path, info] of repoUrls) {
    const hit = lookup(path);
    if (!hit) continue;
    recorded.push({
      hit,
      result: ledgerResult(path, info, hit),
      confirm: needsLiveConfirmation(hit, { today, trustDays, staleFamilies }),
    });
  }
  const confirm = recorded.filter((r) => r.confirm);
  let probed = 0;
  if (confirm.length) {
    const out = await liveLayer(
      confirm.map((r) => r.result),
      { confirmLive: true, probeUnverifiable: false, ...live },
    );
    probed = out.probed;
    confirm.forEach((r, i) => {
      r.result = out.results[i];
    });
  }
  const results = recorded.map((r) => r.result);
  const cleared = results.filter((r) => r.verdict === "valid");
  const unsettled = results.filter(
    (r) => r.verdict !== "valid" && r.confidence === "low" && r.liveNote,
  );
  return {
    results,
    cleared: new Set(cleared.map((r) => r.path)),
    stats: {
      total: repoUrls.size,
      recorded: recorded.length,
      recordedRemoved: recorded.filter((r) => r.hit.state === "removed").length,
      recordedMoved: recorded.filter((r) => r.hit.state === "moved").length,
      ledgerOnly: recorded.length - confirm.length,
      probed,
      clearedByLive: cleared.length,
      unsettled: unsettled.length,
    },
  };
}

/**
 * Tracked URLs a changes run cannot judge and must keep open: still in the repo
 * and neither flagged now nor positively cleared by a live probe. (The change
 * files only list what learnsync saw change, so a tracked typo or a page kind no
 * cache covers is simply absent from them; the next full audit settles it.)
 */
export function carryOver(
  trackerOpen,
  { present, flaggedPaths, clearedPaths, pathOf },
) {
  return Object.keys(trackerOpen).filter((url) => {
    if (!present.has(url)) return false;
    const path = pathOf(url);
    return !flaggedPaths.has(path) && !clearedPaths.has(path);
  });
}

/**
 * Turn validator results into findings. Valid and unverifiable results are not
 * findings; a low-confidence negative that the live check could not settle is
 * dropped too (sitemaps and catalogs lag new pages, so it is not evidence).
 */
export function toFindings(results, repoUrls) {
  const findings = [];
  for (const r of results) {
    if (r.verdict !== "broken" && r.verdict !== "moved") continue;
    if (r.confidence === "low" && r.liveNote) continue;
    const info = repoUrls.get(r.path);
    if (!info) continue;
    findings.push({
      url: [...info.raws][0],
      path: r.path,
      kind: r.verdict === "moved" ? "moved" : "broken",
      reason: r.reason,
      cacheReason: r.cacheReason ?? null,
      evidence: r.evidence,
      locations: info.locations,
      suggestion: r.suggestion ?? null,
    });
  }
  return findings;
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "Broken Microsoft Learn links: 3 broken, 2 moved (2026-10-06)". */
export function issueTitle(findings, today) {
  const moved = findings.filter((f) => f.kind === "moved").length;
  const broken = findings.length - moved;
  const parts = [];
  if (broken) parts.push(`${broken} broken`);
  if (moved) parts.push(`${moved} moved`);
  return `Broken Microsoft Learn links: ${parts.join(", ")} (${today})`;
}

/** The "Coverage of this run" section of a changes-mode issue: what was and was not checked. */
function changesCoverage(coverage, today) {
  const c = coverage;
  const l = c.ledger;
  const lines = [
    "This was a **change-file run**: it read learnsync's two change files (`data/changes/removed.json` and `moved.json`) instead of the full caches, so it only reports links that learnsync has already recorded as removed or moved.",
    "",
    `- Unique Learn URLs in the repo that were looked up: **${c.total}**.`,
    `- URLs with a recorded change (an entry for the URL itself or for its module): **${c.recorded}** (${c.recordedRemoved} removed, ${c.recordedMoved} moved).`,
    `- Reported as recorded, without a live probe (learnsync verified them within the last ${c.trustDays} days): ${c.ledgerOnly}.`,
    `- Live-confirmed on ${today} (older, never verified or low-confidence entries): ${c.probed}. Of these ${c.clearedByLive} turned out to work and were dropped; ${c.unsettled} low-confidence ones could not be settled by the live check and were dropped.`,
    `- Not probed at all: every URL with no recorded change. "No change recorded" is not "valid".`,
    "",
    `**Not covered by change-file runs:** page kinds no cache lists, which therefore never appear in the change files (Learn shows, collections, practice assessments, legacy \`/certifications/\` paths, credentials support pages, documentation pages outside learnsync's docs scope), and links that were never in a cache (typos, brand-new pages). Only the monthly full audit checks those: ${FULL_AUDIT_RULE}${c.nextFullAudit ? `; the next scheduled one is ${c.nextFullAudit}` : ""}.`,
    "",
    `Change files: learnsync commit \`${l.sha.slice(0, 7)}\`, Learn entries refreshed ${l.learnStamp ?? "never"}, docs entries refreshed ${l.docsStamp ?? "never"}; ${l.total} entries recorded (${l.learnEntries} Learn, ${l.docsEntries} docs).`,
  ];
  return lines;
}

/** The most rows each table of the issue shows: the longest list of a first full audit must not make GitHub refuse the issue. */
export const MAX_TABLE_ROWS = 60;
/** The most characters the issue text has (GitHub rejects a body above 65,536). */
export const MAX_REPORT_CHARS = 60_000;

export function buildReport({
  findings,
  data,
  summary,
  today,
  runUrl,
  notes,
  mode = "cache",
  coverage = null,
}) {
  const changes = mode === "changes";
  const problem = (f) => {
    if (!changes) return esc(f.reason);
    const said = f.cacheReason ? ` (change files said: ${f.cacheReason})` : "";
    return `${esc(f.reason + said)}<br>evidence: \`${f.evidence}\``;
  };
  const row = (f) => {
    const where = f.locations
      .slice(0, 4)
      .map((l) => `\`${l}\``)
      .join("<br>");
    const more =
      f.locations.length > 4 ? `<br>+${f.locations.length - 4} more` : "";
    return `| ${esc(f.url)} | ${problem(f)} | ${where}${more} | ${esc(f.suggestion ?? "—")} |`;
  };
  const broken = findings.filter((f) => f.kind !== "moved");
  const moved = findings.filter((f) => f.kind === "moved");
  // Every table shows at most `rowLimit` rows and says how many it leaves out: the counts in the
  // headings and in the "... and N more" lines are exact whatever is cut.
  const assemble = (rowLimit) => {
    const lines = [];
    lines.push(
      findings.length === 1
        ? "The weekly Microsoft Learn URL check found **1** link that no longer works, points at removed content or has moved."
        : `The weekly Microsoft Learn URL check found **${findings.length}** links that no longer work, point at removed content or have moved.`,
      "",
      changes
        ? `Checked against the [learnsync](https://github.com/${CONFIG.repo}) change files at commit \`${data.sha.slice(0, 7)}\` (Learn changes refreshed ${coverage.ledger.learnStamp ?? "never"}, docs changes refreshed ${coverage.ledger.docsStamp ?? "never"}). Entries learnsync verified within the last ${coverage.trustDays} days are reported as recorded (evidence \`changes-ledger\`); older, never verified and low-confidence entries were re-confirmed against the live site on ${today} (evidence \`live-probe\`).`
        : `Checked with the [learnsync](https://github.com/${CONFIG.repo}) validator at commit \`${data.sha.slice(0, 7)}\` (Learn data generated ${data.learnGeneratedAt ?? "unknown"}, docs data generated ${data.docsGeneratedAt ?? "unknown"}). Every link below was re-confirmed against the live site on ${today}.`,
    );
    const table = (rows, [one, many]) => {
      lines.push(
        "| Link | Problem | Where it is used | Suggested fix |",
        "|---|---|---|---|",
        ...rows.slice(0, rowLimit).map(row),
      );
      const rest = rows.length - rowLimit;
      if (rest > 0) {
        lines.push(
          "",
          `... and ${rest} more ${rest === 1 ? one : many} not listed here (the log of this run lists every link).`,
        );
      }
    };
    if (broken.length) {
      lines.push("", `### Broken links (${broken.length})`, "");
      table(broken, ["broken link", "broken links"]);
    }
    if (moved.length) {
      lines.push(
        "",
        `### Moved pages (${moved.length}): still reachable through a redirect, update when convenient`,
        "",
      );
      table(moved, ["moved page", "moved pages"]);
    }
    lines.push(
      "",
      "### How to fix",
      "",
      "- **Unit links** (`/training/modules/<module>/<unit>/`): Microsoft renumbers and renames unit slugs. Open the module page, copy the live unit URL, keep `?WT.mc_id=studentamb_165290`. If the same exercise is already listed on the page, delete the dead duplicate instead of replacing it.",
      "- **Removed modules** (the link redirects to *Browse all training*, a docs page or a learning path): remove the card, or find the module that replaced it. Do not leave the dead link in place.",
      "- **Moved pages** (the link answers HTTP 200 but redirects to a different page): if the suggested destination is the same content, update the URL to it; if it is a generic landing page or unrelated, find the right page or remove the link.",
      "- **Documentation pages**: search Learn for the page title; if the page moved, update the URL, otherwise remove the link.",
      "- Lab pages must keep only verified hands-on exercises (see AGENTS.md, Lab Pages). Run `pnpm build` after editing.",
      "",
      "### Coverage of this run",
      "",
    );
    if (changes) {
      lines.push(...changesCoverage(coverage, today));
    } else {
      const v = summary.byVerdict;
      lines.push(
        `Unique Learn URLs in the repo: **${summary.total}**. Valid: ${v.valid ?? 0}. Broken: ${v.broken ?? 0}. Moved: ${v.moved ?? 0}. Could not be verified by any cache or live probe: ${v.unverifiable ?? 0}.`,
      );
    }
    if (notes.length) lines.push("", ...notes.map((n) => `> ${n}`));
    if (runUrl) lines.push("", `Run: ${runUrl}`);
    return lines.join("\n") + "\n";
  };
  // long rows (many places, long reasons) halve the rows of both tables until the text fits
  let report;
  for (let rowLimit = MAX_TABLE_ROWS; ; rowLimit = Math.floor(rowLimit / 2)) {
    report = assemble(rowLimit);
    if (report.length <= MAX_REPORT_CHARS || rowLimit <= 1) break;
  }
  // a text that is long for another reason (a note) is cut: GitHub must never refuse the issue
  if (report.length > MAX_REPORT_CHARS) {
    report = `${report.slice(0, MAX_REPORT_CHARS - 200)}\n\n... the report was cut to fit the size limit of an issue; the log of this run has everything.\n`;
  }
  return report;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The step outputs of the workflow (GITHUB_OUTPUT), booleans and counts in lower case as
 * always. A file that cannot be written is an error: the workflow decides from these
 * outputs whether to commit the tracker, so a lost output must not pass for a quiet run.
 */
const setOutputs = (values) =>
  writeOutput(CONFIG.githubOutput, values, { lowercase: true });

function ghHeaders() {
  const h = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghApi(path) {
  // GITHUB_API_URL is set by Actions; tests point it at a local server
  const res = await fetch(
    `${(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "")}${path}`,
    { headers: ghHeaders(), signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status}`);
  return res.json();
}

function walk(path, out = []) {
  if (!existsSync(path)) return out;
  if (statSync(path).isFile()) {
    if (SCAN_EXT.test(path) && !SCAN_SKIP.test(path)) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (SCAN_SKIP.test(full)) continue;
    walk(full, out);
  }
  return out;
}

/**
 * Map canonical path -> { raws:Set, locations:string[] } for the whole repo.
 * `canonical` comes from learnsync (its canonicalPath), so both repos agree.
 */
export function collectRepoUrls(rootDir, canonical, scanRoots = SCAN_ROOTS) {
  const map = new Map();
  for (const scanRoot of scanRoots) {
    for (const file of walk(join(rootDir, scanRoot))) {
      const rel = relative(rootDir, file).split(sep).join("/");
      for (const { raw, line } of extractLearnUrls(
        readFileSync(file, "utf8"),
      )) {
        const path = canonical(raw);
        if (!path) continue;
        if (!map.has(path)) map.set(path, { raws: new Set(), locations: [] });
        const entry = map.get(path);
        entry.raws.add(raw.split(/[?#]/)[0]);
        entry.locations.push(`${rel}:${line}`);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// learnsync: wait for fresh data, then check out code and data together
// ---------------------------------------------------------------------------
async function fetchSyncRuns() {
  const runs = {};
  for (const wf of SYNC_WORKFLOWS) {
    const data = await ghApi(
      `/repos/${CONFIG.repo}/actions/workflows/${wf}/runs?per_page=10`,
    );
    runs[wf] = data.workflow_runs ?? [];
  }
  return runs;
}

async function fetchStatus() {
  const res = await fetch(
    `${CONFIG.rawBaseUrl}/${CONFIG.repo}/${CONFIG.ref}/data/status.json?t=${Date.now()}`,
    { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" } },
  );
  if (!res.ok) throw new Error(`status.json -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Wait for the learnsync sync this check depends on, but only while waiting can
 * help (see syncWaitPlan): up to SYNC_WAIT_MINUTES while a run is queued or in
 * progress, up to IDLE_WAIT_MINUTES for a scheduled run that GitHub has not
 * started yet, not at all for a sync that already failed. A frozen learnsync (the
 * case the stale-data alert is for) therefore no longer delays every scheduled run
 * by 150 minutes.
 */
async function waitForSync(notes) {
  if (!CONFIG.waitForSync) return;
  const started = Date.now();
  let failedNoted = false;
  for (;;) {
    let plan;
    try {
      plan = syncWaitPlan(
        await fetchSyncRuns(),
        await fetchStatus(),
        Date.now(),
        CONFIG.maxDataAgeHours,
      );
    } catch (err) {
      notes.push(
        `Could not read learnsync's sync state (${err.message}); the check ran without waiting for a sync.`,
      );
      return;
    }
    if (plan.failed.length && !failedNoted) {
      failedNoted = true;
      notes.push(
        `The latest learnsync sync failed (${plan.failed.map((f) => `${f.workflow}#${f.run.number} (${f.run.conclusion})`).join(", ")}), so the data may be a week or more old.`,
      );
    }
    if (plan.kind === "settled") return;
    const waiting = [
      ...plan.inFlight.map((r) => `${r} running`),
      ...plan.late.map(
        (s) => `${s} data not refreshed in the last ${CONFIG.maxDataAgeHours}h`,
      ),
    ];
    const minutes = Math.min(
      plan.kind === "running" ? CONFIG.syncWaitMinutes : CONFIG.idleWaitMinutes,
      CONFIG.syncWaitMinutes,
    );
    if (Date.now() > started + minutes * 60_000) {
      notes.push(
        `learnsync was still not synced after ${minutes} minutes (${waiting.join("; ")}); this check used the data as it was at that moment.`,
      );
      return;
    }
    console.log(
      `Waiting for learnsync (${waiting.join("; ")}); next check in ${CONFIG.pollMinutes} min...`,
    );
    await sleep(CONFIG.pollMinutes * 60_000);
  }
}

/**
 * learnsync's workflow runs for the stale-data check, summarized. A failed read
 * is returned as an error, not thrown: it is never evidence, so it only means
 * that the "latest sync failed" cause cannot be judged this run.
 */
async function readSyncRuns() {
  try {
    return { runs: summarizeSyncRuns(await fetchSyncRuns()), error: null };
  } catch (err) {
    return { runs: null, error: err.message };
  }
}

/**
 * What learnsync's Actions runs and open `bug` issues say, for the stale-data
 * issue. Only enriches the text: a failed read leaves that part null (the issue
 * then says it could not be read) and never decides whether the alert is raised.
 * `runsRead` is readSyncRuns(), already fetched by the caller.
 */
async function fetchLearnsyncContext(runsRead) {
  const context = {
    runs: runsRead.runs,
    issues: null,
    errors: runsRead.error ? { runs: runsRead.error } : {},
  };
  try {
    const list = await ghApi(
      `/repos/${CONFIG.repo}/issues?state=open&labels=bug&per_page=10`,
    );
    context.issues = (Array.isArray(list) ? list : []).filter(
      (i) => i && !i.pull_request,
    );
  } catch (err) {
    context.errors.issues = err.message;
  }
  return context;
}

/**
 * Judge the data this run used and bring the hub's stale-data issue in line:
 * open, comment on, or close it (reconcileStaleIssue). Runs BEFORE the
 * broken-link issue and the tracker write, so a failure here fails the run with
 * nothing written. The issue text is also written to STALE_REPORT_FILE whenever
 * the data is stale, so a dry run shows what would be sent.
 */
/**
 * The check half of the stale-data alert: is learnsync's data stale, and what would the issue
 * say? Reads learnsync (two read-only API calls) and writes STALE_REPORT_FILE, but never
 * touches an issue: `applyStaleIssue` does that, in the job that may write issues.
 */
async function assessStaleData({ heartbeat, staleDays, today, runUrl }) {
  // learnsync's runs are read on every run (two read-only API calls): a sync that
  // failed after the last good heartbeat is a stale cause in its own right
  const runsRead = await readSyncRuns();
  const staleness = learnsyncStaleness({
    ...heartbeat,
    syncRuns: runsRead.runs,
    now: Date.now(),
    maxAgeDays: staleDays,
    maxDataAgeHours: CONFIG.maxDataAgeHours,
    ledgerMaxAgeDays: CONFIG.changesStaleDays,
  });
  let issueBody = "";
  let commentBody = "";
  if (staleness.stale) {
    const context = await fetchLearnsyncContext(runsRead);
    const args = { staleness, ...context, today, runUrl, repo: CONFIG.repo };
    issueBody = buildStaleReport({ ...args, kind: "issue" });
    commentBody = buildStaleReport({ ...args, kind: "comment" });
    writeFileSync(CONFIG.staleReportFile, issueBody);
    console.log(
      `learnsync data is stale (${staleness.problems.length} problem${staleness.problems.length === 1 ? "" : "s"}):\n${staleness.problems.map((p) => ` - ${p.text}`).join("\n")}`,
    );
  } else {
    console.log("learnsync data is fresh.");
  }
  return {
    stale: staleness.stale,
    problemIds: staleness.problems.map((p) => p.id),
    issueBody,
    commentBody,
    closeComment: buildFreshComment({ staleness, today, runUrl }),
  };
}

/** The write half of the stale-data alert: open, comment on or close the one hub issue that says so. */
function applyStaleIssue(stale) {
  const enabled = CONFIG.createIssues && !CONFIG.dryRun;
  const result = reconcileStaleIssue({
    stale: stale.stale,
    enabled,
    gh,
    issueBody: stale.issueBody,
    commentBody: stale.commentBody,
    closeComment: stale.closeComment,
  });
  if (result.action === "skipped") {
    console.log(
      `Stale-data issue not touched (${CONFIG.dryRun ? "DRY_RUN" : "CREATE_ISSUES is not 1"}); the text it would carry is in ${CONFIG.staleReportFile}`,
    );
  } else if (result.action === "lookup-failed") {
    annotateRun(
      `Could not look for an open "${STALE_ISSUE_TITLE}" issue to close (${result.error}); the next run tries again.`,
    );
  } else if (result.action === "close-failed") {
    annotateRun(
      `Could not close the "${STALE_ISSUE_TITLE}" issue (${result.error}); the next run tries again.`,
    );
  } else if (result.action !== "none") {
    console.log(
      `Stale-data issue ${result.action}${result.number ? ` (#${result.number})` : ""}`,
    );
  }
  if (stale.stale) {
    annotateRun(
      `learnsync data is stale: ${stale.problemIds.join(", ")}${result.number ? `; see issue #${result.number}` : ""}.`,
    );
  }
  return result;
}

function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

function tryGit(args, opts) {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

/**
 * Get learnsync for a source and import the parts of it that run needs.
 * cache: a full shallow clone and its validator and data. changes: a sparse,
 * partial clone (scripts/, data/changes/, data/status.json, no multi-MB cache is
 * downloaded) and its change-file library. LEARNSYNC_DIR uses an existing full or
 * partial checkout instead of cloning.
 */
async function loadLearnsync(source) {
  let dir = CONFIG.dir;
  let cleanup = () => {};
  if (!dir) {
    const tmp = mkdtempSync(join(tmpdir(), "learnsync-"));
    dir = tmp;
    cleanup = () => rmSync(tmp, { recursive: true, force: true });
    try {
      for (const { args, inDir } of checkoutCommands(source, {
        repo: CONFIG.repo,
        ref: CONFIG.ref,
        dir: tmp,
      })) {
        git(args, inDir ? { cwd: tmp } : {});
      }
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  const lib = (name) =>
    import(pathToFileURL(join(dir, "scripts", "lib", name)).href);
  const sha = tryGit(["rev-parse", "HEAD"], { cwd: dir }) ?? "unknown";
  try {
    if (source === "cache") {
      const [validate, probe, canonicalLib] = await Promise.all([
        lib("validate.mjs"),
        lib("live-probe.mjs"),
        lib("canonical.mjs"),
      ]);
      return {
        source,
        dir,
        sha,
        cleanup,
        validate,
        probe,
        canonicalPath: canonicalLib.canonicalPath,
        data: validate.loadData(join(dir, "data")),
      };
    }
    if (!existsSync(join(dir, "scripts", "lib", "changes.mjs"))) {
      throw new Error(
        `learnsync at ${sha} has no scripts/lib/changes.mjs, so it cannot serve change files yet. Run the full audit instead (CHECK_SOURCE=cache, or the full_audit input of the workflow).`,
      );
    }
    const missingChangeFiles = CHANGE_FILE_NAMES.filter(
      (f) => !existsSync(join(dir, "data", "changes", f)),
    );
    if (missingChangeFiles.length === CHANGE_FILE_NAMES.length) {
      throw new Error(
        `learnsync at ${sha} has no data/changes/removed.json or moved.json yet (nothing has recorded changes there). Run the full audit instead (CHECK_SOURCE=cache, or the full_audit input of the workflow).`,
      );
    }
    const [changesLib, probe, canonicalLib] = await Promise.all([
      lib("changes.mjs"),
      lib("live-probe.mjs"),
      lib("canonical.mjs"),
    ]);
    let status = null;
    try {
      status = JSON.parse(
        readFileSync(join(dir, "data", "status.json"), "utf8"),
      );
    } catch {
      /* no heartbeat: reported as a note */
    }
    return {
      source,
      dir,
      sha,
      cleanup,
      probe,
      canonicalPath: canonicalLib.canonicalPath,
      changesLib,
      // throws ChangesFileError for a corrupt file: fail, never judge from it
      changes: changesLib.loadChanges(join(dir, "data")),
      missingChangeFiles,
      status,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function loadTracker() {
  if (!existsSync(CONFIG.trackerFile)) {
    return {
      lastRun: null,
      lastMode: null,
      lastFullAudit: null,
      learnsync: null,
      open: {},
      issues: {},
    };
  }
  const t = JSON.parse(readFileSync(CONFIG.trackerFile, "utf8"));
  return {
    lastRun: t.lastRun ?? null,
    lastMode: t.lastMode ?? null,
    lastFullAudit: t.lastFullAudit ?? null,
    learnsync: t.learnsync ?? null,
    open: t.open ?? {},
    issues: t.issues ?? {},
  };
}

// GH_CLI_SCRIPT (tests only) runs a fake gh written in Node instead of the real CLI
const gh = makeGh({ ghCliScript: env.GH_CLI_SCRIPT });

/** Notes a reader of the issue needs to judge how far to trust this run. */
function freshnessNotes(freshness, maxAgeHours) {
  const notes = [];
  if (freshness.missingFiles.length) {
    notes.push(
      `learnsync data files missing: ${freshness.missingFiles.join(", ")}; those URL kinds could not be checked.`,
    );
  }
  for (const [label, age] of [
    ["Learn", freshness.learnAgeHours],
    ["docs", freshness.docsAgeHours],
  ]) {
    if (age == null) notes.push(`learnsync has no ${label} heartbeat yet.`);
    else if (age > maxAgeHours) {
      notes.push(
        `The ${label} data is ${Math.round(age)} hours old (limit ${maxAgeHours}).`,
      );
    }
  }
  if (freshness.docsComplete === false) {
    notes.push(
      "The docs index was incomplete in the latest learnsync run (a sitemap file failed or work was deferred); pages missing from it were confirmed live.",
    );
  }
  if (!freshness.unitUrlsCached) {
    notes.push(
      "learnsync has not cached unit URLs yet, so unit links were confirmed live only.",
    );
  }
  return notes;
}

/**
 * Full audit (CHECK_SOURCE=cache): learnsync's validator over the complete
 * caches, then the live layer for every negative and every page kind no cache
 * can answer.
 */
async function checkFromCache(ls, repoUrls, notes) {
  const urls = [...repoUrls.values()].map((v) => [...v.raws][0]);
  const validated = ls.validate.validateUrls(urls, ls.data);
  const { freshness } = validated;
  notes.push(...freshnessNotes(freshness, CONFIG.maxDataAgeHours));
  console.log(`Cache verdicts: ${JSON.stringify(validated.summary.byVerdict)}`);

  const live = await ls.probe.liveLayer(validated.results, {
    confirmLive: true,
    probeUnverifiable: CONFIG.probeUnverifiable,
    concurrency: CONFIG.liveConcurrency,
    delayMs: CONFIG.liveDelayMs,
  });
  const results = live.results;
  const summary = ls.validate.summarize(results);
  console.log(
    `Live probes: ${live.probed}. Final verdicts: ${JSON.stringify(summary.byVerdict)}`,
  );
  return {
    findings: toFindings(results, repoUrls),
    total: summary.total,
    summary,
    coverage: null,
    cleared: new Set(),
    dataInfo: {
      sha: ls.sha,
      learnGeneratedAt: freshness.learnGeneratedAt,
      docsGeneratedAt: freshness.docsGeneratedAt,
    },
    // what the staleness judgement needs, in the shape of data/status.json
    heartbeat: {
      status: {
        learn: { generatedAt: freshness.learnGeneratedAt },
        docs: {
          generatedAt: freshness.docsGeneratedAt,
          complete: freshness.docsComplete,
        },
      },
      ledger: null,
    },
    systemicCause: "a rate limit, a Learn outage or a changed API",
    systemicRemedy: "Re-run the workflow manually",
  };
}

/**
 * Fast path (CHECK_SOURCE=changes): look every URL up in learnsync's change
 * files with its own lookupChange(); only a recorded change is a finding, and
 * only doubtful ones are probed live. A URL with no recorded change is not
 * probed ("no change recorded" is not "valid", see the coverage section).
 */
async function checkFromChanges(
  ls,
  repoUrls,
  today,
  notes,
  lastFullAudit = null,
) {
  const now = Date.now();
  const { changesLib } = ls;
  const ledger = ledgerFreshness(ls.changes, now, CONFIG.changesStaleDays);
  notes.push(
    ...heartbeatNotes(ls.status, now, CONFIG.maxDataAgeHours),
    ...ledgerNotes(ledger, CONFIG.changesStaleDays),
  );
  for (const file of ls.missingChangeFiles) {
    notes.push(
      `data/changes/${file} is missing in learnsync, so none of its changes could be recorded.`,
    );
  }
  const index = changesLib.indexChanges(ls.changes);
  const evaluated = await evaluateChanges({
    repoUrls,
    lookup: (path) => changesLib.lookupChange(path, index),
    liveLayer: ls.probe.liveLayer,
    today,
    trustDays: CONFIG.changesTrustDays,
    staleFamilies: ledger.staleFamilies,
    live: { concurrency: CONFIG.liveConcurrency, delayMs: CONFIG.liveDelayMs },
  });
  const s = evaluated.stats;
  console.log(
    `Change files: ${s.recorded} of ${s.total} URLs have a recorded change (${s.recordedRemoved} removed, ${s.recordedMoved} moved); ${s.ledgerOnly} reported as recorded, ${s.probed} live-confirmed (${s.clearedByLive} cleared, ${s.unsettled} unsettled)`,
  );
  const counts = changesLib.summarizeChanges(ls.changes).byFamily;
  const entries = (family) => counts[family].removed + counts[family].moved;
  return {
    findings: toFindings(evaluated.results, repoUrls),
    total: s.total,
    summary: null,
    coverage: {
      ...s,
      trustDays: CONFIG.changesTrustDays,
      nextFullAudit: nextFullAuditDate(
        new Date(`${today}T00:00:00Z`),
        lastFullAudit,
      ),
      ledger: {
        sha: ls.sha,
        learnStamp: ledger.learn.stamp,
        docsStamp: ledger.docs.stamp,
        learnEntries: entries("learn"),
        docsEntries: entries("docs"),
        total: entries("learn") + entries("docs"),
      },
    },
    cleared: evaluated.cleared,
    dataInfo: {
      sha: ls.sha,
      learnGeneratedAt: ls.status?.learn?.generatedAt ?? null,
      docsGeneratedAt: ls.status?.docs?.generatedAt ?? null,
    },
    heartbeat: { status: ls.status, ledger },
    systemicCause:
      "a bad change file (for example a learnsync run that recorded far too many removals) or a live-probe outage",
    systemicRemedy:
      "Re-run the workflow with the full_audit input to compare it with the complete caches",
  };
}

/** A workflow annotation in Actions, a plain line elsewhere: a note must be visible even when no issue is opened. */
function annotateRun(message) {
  if (env.GITHUB_ACTIONS === "true") {
    annotate("warning", message, { title: "Learn URL check" });
  } else {
    console.warn(`Note: ${message}`);
  }
}

/** The version of the plan file that `--check` writes and `--publish` reads. */
export const PLAN_VERSION = 1;

/**
 * The check half of a run: reads the repo and learnsync, decides what to report and writes
 * nothing to GitHub and nothing to the tracker. What it returns is the PLAN, plain JSON
 * (`--check` saves it to PLAN_FILE; the default run hands it straight to `applyPlan`):
 *   stale    what the stale-data issue would say (`assessStaleData`)
 *   notes    the notes the broken-link issue carries
 *   failure  null, or { message } when the systemic-failure guard tripped
 *   report   null, or the inputs of the broken-link issue: the new findings, data, summary, coverage
 *   tracker  null, or what the tracker write needs: the tracker as read, the findings, the URLs
 *            carried over and the new ones, learnsync's commit and data stamps
 */
async function runCheck() {
  const today = new Date().toISOString().slice(0, 10);
  const source = selectCheckSource(env.CHECK_SOURCE);
  const staleDays = parseStaleAlertDays(env.LEARNSYNC_STALE_DAYS);
  const notes = [];
  const tracker = loadTracker();
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  console.log(
    `Check source: ${source}${source === "changes" ? ` (change files only; the full audit runs ${FULL_AUDIT_RULE})` : " (full audit against the complete caches)"}`,
  );

  await waitForSync(notes);
  const ls = await loadLearnsync(source);
  try {
    // 1. every Learn URL in the repo
    const repoUrls = collectRepoUrls(root, ls.canonicalPath);
    console.log(`Learn URLs in repo: ${repoUrls.size}`);

    // 2. findings from the change files or from the full caches, then the live layer
    const run =
      source === "changes"
        ? await checkFromChanges(
            ls,
            repoUrls,
            today,
            notes,
            tracker.lastFullAudit,
          )
        : await checkFromCache(ls, repoUrls, notes);
    const { findings, summary, coverage, dataInfo } = run;
    notes.forEach((note) => annotateRun(note));

    // 2b. is learnsync's data stale? What the one hub issue that says so would carry.
    const stale = await assessStaleData({
      heartbeat: run.heartbeat,
      staleDays,
      today,
      runUrl,
    });
    const plan = {
      version: PLAN_VERSION,
      today,
      source,
      runUrl,
      stale,
      notes,
      failure: null,
      report: null,
      tracker: null,
    };

    // 3. systemic-failure guard (moved pages never count)
    const brokenCount = findings.filter((f) => f.kind !== "moved").length;
    const limit = Math.min(
      CONFIG.maxFlagged,
      Math.ceil((run.total * CONFIG.maxFlaggedPct) / 100),
    );
    if (brokenCount > limit) {
      const msg = `The Learn URL check flagged ${brokenCount} of ${run.total} URLs as broken in one run (limit ${limit}). That looks like ${run.systemicCause} rather than real breakage, so no per-link issue was created. ${run.systemicRemedy} and spot-check a few links.\n`;
      writeFileSync(CONFIG.errorFile, msg);
      console.error(msg);
      plan.failure = { message: msg };
      return plan;
    }

    // 4. tracker diff: what is new, what is resolved, what a changes run keeps open
    const flaggedUrls = findings.map((f) => f.url);
    const present = new Set([...repoUrls.values()].flatMap((v) => [...v.raws]));
    const diff = diffTracker(tracker.open, flaggedUrls, present);
    const { fresh } = diff;
    // a changes run only resolves what it can positively clear
    const carried =
      source === "changes"
        ? carryOver(tracker.open, {
            present,
            flaggedPaths: new Set(findings.map((f) => f.path)),
            clearedPaths: run.cleared,
            pathOf: ls.canonicalPath,
          })
        : [];
    const resolved = diff.resolved.filter((u) => !carried.includes(u));
    const newFindings = findings.filter((f) => fresh.includes(f.url));
    console.log(
      `Flagged: ${findings.length} (new ${newFindings.length}, resolved ${resolved.length}${source === "changes" ? `, kept open for the full audit ${carried.length}` : ""})`,
    );
    for (const f of findings) {
      console.log(
        ` - [${f.kind}] ${f.url}\n   ${f.reason}${f.suggestion ? `\n   suggested: ${f.suggestion}` : ""}`,
      );
    }
    if (newFindings.length) {
      plan.report = {
        findings: newFindings,
        data: dataInfo,
        summary,
        coverage,
      };
    }
    plan.tracker = {
      before: tracker,
      findings: findings.map((f) => ({
        url: f.url,
        kind: f.kind,
        reason: f.reason,
      })),
      carried,
      newUrls: newFindings.map((f) => f.url),
      learnsync: {
        sha: ls.sha,
        learnGeneratedAt: dataInfo.learnGeneratedAt,
        docsGeneratedAt: dataInfo.docsGeneratedAt,
      },
    };
    return plan;
  } finally {
    ls.cleanup();
  }
}

/**
 * The write half of a run: everything that touches GitHub or the tracker file, in the order the
 * workflow relies on. The stale-data issue comes first, then the broken-link issue, then the
 * tracker: a failed issue step throws, so nothing is written and a re-run reports everything again
 * (committing the tracker first would lose the alert: the links would already be tracked).
 */
async function applyPlan(plan) {
  const enabled = CONFIG.createIssues && !CONFIG.dryRun;
  const stale = applyStaleIssue(plan.stale);

  if (plan.failure) {
    setOutputs({
      check_failed: true,
      new_count: 0,
      tracker_updated: false,
      learnsync_stale: plan.stale.stale,
    });
    return;
  }

  // the caveat is always there; the pointer only when an issue exists to point at
  const notes = [...plan.notes];
  if (plan.stale.stale) {
    notes.push(
      `learnsync's data is stale, so this report may be incomplete${stale.number ? `: see #${stale.number}` : ""}.`,
    );
  }
  const { today, source } = plan;
  const t = plan.tracker;
  let issueNumber = null;
  if (plan.report) {
    const report = buildReport({
      ...plan.report,
      today,
      runUrl: plan.runUrl,
      notes,
      mode: source,
    });
    writeFileSync(CONFIG.reportFile, report);
    if (enabled) {
      gh([
        "label",
        "create",
        CONFIG.label,
        "--color",
        "D93F0B",
        "--description",
        "A link on the site no longer works",
        "--force",
      ]);
      const out = gh([
        "issue",
        "create",
        "--title",
        issueTitle(plan.report.findings, today),
        "--label",
        CONFIG.label,
        "--body-file",
        CONFIG.reportFile,
      ]);
      issueNumber = Number(out.match(/\/issues\/(\d+)/)?.[1]);
      console.log(`Created issue #${issueNumber}`);
    }
  }

  // update the tracker
  const tracker = t.before;
  const nextOpen = {};
  for (const f of t.findings) {
    nextOpen[f.url] = tracker.open[f.url] ?? {
      firstSeen: today,
      issue: issueNumber,
    };
    nextOpen[f.url].lastSeen = today;
    nextOpen[f.url].kind = f.kind;
    nextOpen[f.url].reason = f.reason;
  }
  for (const u of t.carried) nextOpen[u] ??= tracker.open[u];
  const nextIssues = { ...tracker.issues };
  if (issueNumber) nextIssues[issueNumber] = t.newUrls;
  // close issues whose URLs are all resolved
  for (const [num, urls] of Object.entries(nextIssues)) {
    if (urls.every((u) => !(u in nextOpen))) {
      if (enabled) {
        try {
          gh([
            "issue",
            "close",
            num,
            "--comment",
            `All links in this report are fixed or no longer present as of the ${today} check.`,
          ]);
          console.log(`Closed issue #${num}`);
        } catch (err) {
          console.error(err.message);
        }
      }
      delete nextIssues[num];
    }
  }
  const next = {
    lastRun: today,
    lastMode: source,
    lastFullAudit: source === "cache" ? today : tracker.lastFullAudit,
    learnsync: t.learnsync,
    open: nextOpen,
    issues: nextIssues,
  };
  const before = JSON.stringify({ ...tracker, lastRun: null });
  const after = JSON.stringify({ ...next, lastRun: null });
  let updated = false;
  if (!CONFIG.dryRun && before !== after) {
    writeFileSync(CONFIG.trackerFile, JSON.stringify(next, null, 2) + "\n");
    updated = true;
  }
  setOutputs({
    tracker_updated: updated,
    new_count: t.newUrls.length,
    check_failed: false,
    learnsync_stale: plan.stale.stale,
  });
}

/** The default run (a local run, the tests): check, then apply, in one process. */
async function main() {
  const plan = await runCheck();
  await applyPlan(plan);
  if (plan.failure) process.exitCode = 1;
}

/** `--check`: the read-only half. Saves the plan for `--publish` and fails the job when the guard tripped. */
async function mainCheck() {
  const plan = await runCheck();
  writeFileSync(CONFIG.planFile, JSON.stringify(plan) + "\n");
  setOutputs({
    plan_written: true,
    check_failed: Boolean(plan.failure),
    new_count: plan.tracker?.newUrls.length ?? 0,
    tracker_updated: false,
    learnsync_stale: plan.stale.stale,
  });
  console.log(`Plan written to ${CONFIG.planFile}`);
  if (plan.failure) process.exitCode = 1;
}

/**
 * `--publish`: the half that may write issues and the tracker. A guard failure is already a red
 * job (the check job failed), so it only opens the stale-data issue here and still exits 0.
 */
async function mainPublish() {
  if (!existsSync(CONFIG.planFile)) {
    console.log(
      `No plan at ${CONFIG.planFile}: the check did not get far enough to write one, so there is nothing to publish.`,
    );
    setOutputs({
      tracker_updated: false,
      new_count: 0,
      check_failed: false,
      learnsync_stale: false,
    });
    return;
  }
  const plan = JSON.parse(readFileSync(CONFIG.planFile, "utf8"));
  if (plan.version !== PLAN_VERSION) {
    throw new Error(
      `The plan at ${CONFIG.planFile} has version ${plan.version}, this script reads version ${PLAN_VERSION}.`,
    );
  }
  await applyPlan(plan);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes("--choose-source")
) {
  // used by the workflow: which source does this run use? (stdout: source=<x>, ready for $GITHUB_OUTPUT)
  const { source, lastFullAudit } = chooseSourceFromEnv(env);
  console.error(
    `Event ${env.EVENT_NAME || "(none)"}, full_audit ${env.FULL_AUDIT || "(unset)"}, day of month ${new Date().getUTCDate()} (UTC), ${lastFullAudit ? `last full audit ${lastFullAudit}` : "no full audit on record"}: ${source === "cache" ? "full audit" : "change files"}`,
  );
  console.log(`source=${source}`);
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const phase = process.argv.includes("--check")
    ? mainCheck
    : process.argv.includes("--publish")
      ? mainPublish
      : main;
  phase().catch((err) => {
    const msg = `The Learn URL check failed: ${err.stack ?? err.message}\n`;
    try {
      writeFileSync(CONFIG.errorFile, msg);
    } catch {
      /* ignore */
    }
    try {
      setOutputs({ check_failed: true, new_count: 0, tracker_updated: false });
    } catch (writeError) {
      console.error(`Could not write the step outputs: ${writeError.message}`);
    }
    console.error(msg);
    process.exit(1);
  });
}
