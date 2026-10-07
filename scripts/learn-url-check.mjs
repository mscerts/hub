#!/usr/bin/env node
/**
 * Check of every Microsoft Learn URL in this repo against
 * https://github.com/mscerts/learnsync, run AFTER learnsync has synced.
 *
 * Usage:
 *   node scripts/learn-url-check.mjs
 *   node scripts/learn-url-check.mjs --choose-source   (prints source=changes|cache for the workflow)
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
 *   cache              FULL AUDIT, monthly (first Tuesday) or on demand. Clones all
 *                      of learnsync and asks its validator (scripts/lib/validate.mjs)
 *                      for a verdict per URL against the complete caches, and probes
 *                      the page kinds no cache can answer (practice assessments,
 *                      shows, collections, legacy /certifications/ paths, ...).
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
 * both syncs finished within MAX_DATA_AGE_HOURS.
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
 *   SYNC_WAIT_MINUTES    150
 *   POLL_MINUTES         5
 *   MAX_DATA_AGE_HOURS   48        (heartbeat age limit, both modes)
 *   CHANGES_TRUST_DAYS   14        (changes: report a ledger entry verified this recently without a probe)
 *   CHANGES_STALE_DAYS   10        (changes: a change-file source stamp older than this is stale)
 *   PROBE_UNVERIFIABLE   1         (cache: probe page kinds no cache covers)
 *   LIVE_CONCURRENCY     3
 *   LIVE_DELAY_MS        500
 *   MAX_FLAGGED          80        (more broken links than this in one run = systemic, no issue)
 *   MAX_FLAGGED_PCT      25        (percent of all URLs)
 *   CREATE_ISSUES        0         (1 = create/close issues with the gh CLI)
 *   DRY_RUN              0         (1 = do not write the tracker or touch issues)
 *   GH_TOKEN / GITHUB_REPOSITORY   used for the gh CLI and the GitHub API
 *   --choose-source reads EVENT_NAME (github.event_name) and FULL_AUDIT (the full_audit input).
 *
 * Writes GITHUB_OUTPUT keys: tracker_updated, new_count, check_failed.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
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

const CONFIG = {
  repo: env.LEARNSYNC_REPO ?? "mscerts/learnsync",
  ref: env.LEARNSYNC_REF ?? "main",
  dir: env.LEARNSYNC_DIR ? resolveFromRoot(env.LEARNSYNC_DIR) : null,
  trackerFile: resolveFromRoot(
    env.TRACKER_FILE ?? "src/data_files/learn-url-check.json",
  ),
  reportFile: env.REPORT_FILE ?? join(tmpdir(), "learn-url-check-report.md"),
  errorFile: env.ERROR_FILE ?? join(tmpdir(), "learn-url-check-error.md"),
  githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
  waitForSync: (env.WAIT_FOR_SYNC ?? "1") !== "0",
  syncWaitMinutes: Number(env.SYNC_WAIT_MINUTES ?? 150),
  pollMinutes: Number(env.POLL_MINUTES ?? 5),
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

/** The monthly full audit: the first Tuesday of the month, i.e. a scheduled run on day 1-7. */
export const FULL_AUDIT_RULE =
  "the first Tuesday of each month (the scheduled run on day 1 to 7 of the month), or on demand with the `full_audit` input of the workflow";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Scan only content that this repo owns. Generated trackers/caches and the
// scripts that themselves contain Learn API URLs are excluded.
const SCAN_ROOTS = ["src"];
const SCAN_EXT = /\.(mdx?|astro|ts|tsx|js|mjs|json)$/;
const SCAN_SKIP =
  /(node_modules|[\\/]dist[\\/]|[\\/]\.astro[\\/]|[\\/]data_files[\\/](applied-skills-cache|measureup-products|missing-resources|voucher-challenges|beta-exams|retiring-exams|partner-designations|learn-url-check)\.json)/;

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

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/**
 * The source the workflow gives a run: a monthly full audit on the first
 * Tuesday, a manual run with `full_audit`, the change files for every other
 * scheduled, manual or repository_dispatch run.
 */
export function chooseCheckSource({
  eventName,
  fullAudit = false,
  now = new Date(),
} = {}) {
  if (eventName === "workflow_dispatch") {
    return truthy(fullAudit) ? "cache" : "changes";
  }
  if (eventName === "schedule")
    return isFullAuditDay(now) ? "cache" : "changes";
  return "changes";
}

/** The first scheduled full audit after `now` (the next first Tuesday, UTC) as YYYY-MM-DD. */
export function nextFullAuditDate(now = new Date()) {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  for (let i = 0; i < 45; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 2 && d.getUTCDate() <= 7) {
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
    suggestion: destination && hit.state === "moved" ? `https://learn.microsoft.com${destination}` : null,
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
  const problem = (f) => {
    if (!changes) return esc(f.reason);
    const said = f.cacheReason ? ` (change files said: ${f.cacheReason})` : "";
    return `${esc(f.reason + said)}<br>evidence: \`${f.evidence}\``;
  };
  const table = (rows) => {
    lines.push(
      "| Link | Problem | Where it is used | Suggested fix |",
      "|---|---|---|---|",
    );
    for (const f of rows) {
      const where = f.locations
        .slice(0, 4)
        .map((l) => `\`${l}\``)
        .join("<br>");
      const more =
        f.locations.length > 4 ? `<br>+${f.locations.length - 4} more` : "";
      lines.push(
        `| ${esc(f.url)} | ${problem(f)} | ${where}${more} | ${esc(f.suggestion ?? "—")} |`,
      );
    }
  };
  const broken = findings.filter((f) => f.kind !== "moved");
  const moved = findings.filter((f) => f.kind === "moved");
  if (broken.length) {
    lines.push("", `### Broken links (${broken.length})`, "");
    table(broken);
  }
  if (moved.length) {
    lines.push(
      "",
      `### Moved pages (${moved.length}): still reachable through a redirect, update when convenient`,
      "",
    );
    table(moved);
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
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeOutput(obj) {
  const lines = Object.entries(obj)
    .map(([k, v]) => `${k}=${String(v).toLowerCase()}\n`)
    .join("");
  try {
    appendFileSync(CONFIG.githubOutput, lines);
  } catch {
    /* not in CI */
  }
}

function ghHeaders() {
  const h = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghApi(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: ghHeaders(),
  });
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
    `https://raw.githubusercontent.com/${CONFIG.repo}/${CONFIG.ref}/data/status.json?t=${Date.now()}`,
    { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" } },
  );
  if (!res.ok) throw new Error(`status.json -> HTTP ${res.status}`);
  return res.json();
}

async function waitForSync(notes) {
  if (!CONFIG.waitForSync) return;
  const deadline = Date.now() + CONFIG.syncWaitMinutes * 60_000;
  for (;;) {
    let state;
    let stale;
    try {
      state = syncState(await fetchSyncRuns());
      stale = staleSections(
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
    const waiting = [
      ...state.inFlight.map((r) => `${r} running`),
      ...stale.map(
        (s) => `${s} data not refreshed in the last ${CONFIG.maxDataAgeHours}h`,
      ),
    ];
    if (!waiting.length) {
      if (state.failed.length) {
        notes.push(
          `The latest learnsync sync failed (${state.failed.join(", ")}), so the cache may be a week or more old.`,
        );
      }
      return;
    }
    if (Date.now() > deadline) {
      notes.push(
        `learnsync was still not synced after ${CONFIG.syncWaitMinutes} minutes (${waiting.join("; ")}); this check used the data as it was at that moment.`,
      );
      return;
    }
    console.log(
      `Waiting for learnsync (${waiting.join("; ")}); next check in ${CONFIG.pollMinutes} min...`,
    );
    await sleep(CONFIG.pollMinutes * 60_000);
  }
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

function gh(args, input) {
  const res = spawnSync("gh", args, { encoding: "utf8", input });
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

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
async function checkFromChanges(ls, repoUrls, today, notes) {
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
      nextFullAudit: nextFullAuditDate(new Date(`${today}T00:00:00Z`)),
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
    systemicCause:
      "a bad change file (for example a learnsync run that recorded far too many removals) or a live-probe outage",
    systemicRemedy:
      "Re-run the workflow with the full_audit input to compare it with the complete caches",
  };
}

/** A workflow annotation in Actions, a plain line elsewhere: a note must be visible even when no issue is opened. */
function annotate(message) {
  if (env.GITHUB_ACTIONS === "true") {
    const data = message
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    console.log(`::warning title=Learn URL check::${data}`);
  } else {
    console.warn(`Note: ${message}`);
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const source = selectCheckSource(env.CHECK_SOURCE);
  const notes = [];
  const tracker = loadTracker();
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
        ? await checkFromChanges(ls, repoUrls, today, notes)
        : await checkFromCache(ls, repoUrls, notes);
    const { findings, summary, coverage, dataInfo } = run;
    notes.forEach(annotate);

    // 3. systemic-failure guard (moved pages never count)
    const brokenCount = findings.filter((f) => f.kind !== "moved").length;
    const limit = Math.min(
      CONFIG.maxFlagged,
      Math.ceil((run.total * CONFIG.maxFlaggedPct) / 100),
    );
    if (brokenCount > limit) {
      const msg = `The Learn URL check flagged ${brokenCount} of ${run.total} URLs as broken in one run (limit ${limit}). That looks like ${run.systemicCause} rather than real breakage, so no per-link issue was created. ${run.systemicRemedy} and spot-check a few links.\n`;
      writeFileSync(CONFIG.errorFile, msg);
      writeOutput({ check_failed: true, new_count: 0, tracker_updated: false });
      console.error(msg);
      process.exitCode = 1;
      return;
    }

    // 4. tracker diff, issues, tracker write
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

    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null;
    let issueNumber = null;
    if (newFindings.length) {
      const report = buildReport({
        findings: newFindings,
        data: dataInfo,
        summary,
        today,
        runUrl,
        notes,
        mode: source,
        coverage,
      });
      writeFileSync(CONFIG.reportFile, report);
      if (CONFIG.createIssues && !CONFIG.dryRun) {
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
          issueTitle(newFindings, today),
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
    const nextOpen = {};
    for (const f of findings) {
      nextOpen[f.url] = tracker.open[f.url] ?? {
        firstSeen: today,
        issue: issueNumber,
      };
      nextOpen[f.url].lastSeen = today;
      nextOpen[f.url].kind = f.kind;
      nextOpen[f.url].reason = f.reason;
    }
    for (const u of carried) nextOpen[u] ??= tracker.open[u];
    const nextIssues = { ...tracker.issues };
    if (issueNumber) nextIssues[issueNumber] = newFindings.map((f) => f.url);
    // close issues whose URLs are all resolved
    for (const [num, urls] of Object.entries(nextIssues)) {
      if (urls.every((u) => !(u in nextOpen))) {
        if (CONFIG.createIssues && !CONFIG.dryRun) {
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
      learnsync: {
        sha: ls.sha,
        learnGeneratedAt: dataInfo.learnGeneratedAt,
        docsGeneratedAt: dataInfo.docsGeneratedAt,
      },
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
    writeOutput({
      tracker_updated: updated,
      new_count: newFindings.length,
      check_failed: false,
    });
  } finally {
    ls.cleanup();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes("--choose-source")
) {
  // used by the workflow: which source does this run use? (stdout: source=<x>, ready for $GITHUB_OUTPUT)
  const source = chooseCheckSource({
    eventName: env.EVENT_NAME,
    fullAudit: env.FULL_AUDIT,
  });
  console.error(
    `Event ${env.EVENT_NAME || "(none)"}, full_audit ${env.FULL_AUDIT || "(unset)"}, day of month ${new Date().getUTCDate()} (UTC): ${source === "cache" ? "full audit" : "change files"}`,
  );
  console.log(`source=${source}`);
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    const msg = `The Learn URL check failed: ${err.stack ?? err.message}\n`;
    try {
      writeFileSync(CONFIG.errorFile, msg);
    } catch {
      /* ignore */
    }
    writeOutput({ check_failed: true, new_count: 0, tracker_updated: false });
    console.error(msg);
    process.exit(1);
  });
}
