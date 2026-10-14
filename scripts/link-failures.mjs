#!/usr/bin/env node
// Judges the scheduled EXTERNAL link check (see docs/monitors/link-checker.md).
//
// The weekly Link Checker workflow runs lychee over the built site (every .html
// file under dist/) for the host allowlist in lychee-external.toml and writes
// lychee's JSON report. This script turns that report into one stable,
// deduplicated alert:
//
//   - a link counts as dead only after it failed on TWO consecutive runs (the
//     tracker keeps the links that failed last time), so a host that was down for
//     an hour or a rate-limited answer never opens an issue;
//   - 403, 429, 5xx, timeouts and unclear network errors are warnings (job summary
//     only), never failures, and never change what the tracker knows about a link;
//   - ONE issue (stable title, label broken-link) lists the confirmed dead links
//     with the source files that contain them (file:line) and what to do. A later
//     run edits that issue and comments when links are added or fixed instead of
//     opening another one, and closes it when nothing is left;
//   - a run that cannot be trusted (lychee crashed or wrote nothing, far too few
//     links checked, a quarter of all links DEAD or timing out at once) judges nothing,
//     leaves the tracker alone and raises a separate "external check failed" issue
//     (stable title, one comment per further failed run) that names the failing hosts.
//     403, 429, 5xx and unclear network errors do not count toward that quarter: they
//     are warnings, and a family of bot-blocking hosts must not stop the check from
//     judging the GitHub repository links it exists for. A corrupt tracker and a crash
//     of the judging itself raise the same issue;
//   - the REDIRECT CHECK: lychee reports a link that now redirects to a parent page of its own
//     site (a retired programme page that answers 301 to the events hub) as 200 OK. lychee
//     lists the redirect chains in `redirect_map` when it runs verbose (`verbose = "info"` in
//     lychee-external.toml). A link whose chain ends on a PROPER PREFIX of its own path on the
//     same site (the site root included), after at least one permanent hop (301, 308), is
//     "probably gone": same tracker (the `redirects` map), same two-runs rule, a second table in
//     the same running issue. Temporary hops only (302, 303, 307) are a warning in the job
//     summary. Other redirects (http to https, www, a trailing slash, a locale, a query; another
//     site; another page of the same site) are only counted. A run without usable redirect
//     data (no verbose, REDIRECT_CHECK=0, more than MAX_REDIRECT_FINDINGS candidates at once)
//     leaves what the check knew as it was. A link that still is the right page goes into
//     .lycheeignore (a regular expression per line): the redirect check skips what it matches.
//
// The first run is a silent baseline: nothing has failed twice yet. The issue is
// created BEFORE the tracker is written (the workflow only commits the tracker when
// this script succeeded), so a failed issue step loses no alert: the next run
// reports it again.
//
// Usage:
//   node scripts/link-failures.mjs          judge lychee's JSON report (the default)
//   node scripts/link-failures.mjs list     print the links the allowlist selects in dist/ (no network)
//   node scripts/link-failures.mjs check    lychee-free runner for a local run: checks those links with
//                                           fetch() (following redirects by hand, 10 hops at most, and
//                                           recording them) and writes a report in lychee's JSON shape
//
// Local run without lychee (after `pnpm build`):
//   node scripts/link-failures.mjs check && DRY_RUN=1 node scripts/link-failures.mjs
// Local run with lychee, the same command CI uses (options: lychee-external.toml):
//   lychee --config lychee-external.toml --root-dir dist --format json \
//     --output lychee/external.json 'dist/**/*.html'; \
//     DRY_RUN=1 LYCHEE_EXIT_CODE=$? node scripts/link-failures.mjs
//
// Env overrides (defaults shown):
//   LYCHEE_JSON          lychee/external.json   (check: where the report is written)
//   LYCHEE_EXIT_CODE     (unset)  lychee's exit code: 0 and 2 are normal, anything else fails the check
//   TRACKER_FILE         src/data_files/link-failures.json
//   SRC_DIR              src      (where a link is looked up for file:line)
//   DIST_DIR             dist     (list / check: the built site)
//   CONFIG_FILE          lychee-external.toml   (list / check: the allowlist is its `include`)
//   LYCHEE_IGNORE_FILE   .lycheeignore   (the redirect check skips the links its lines match)
//   REPORT_FILE          <tmpdir>/link-failures-report.md   (the issue text, written whenever there is one)
//   ERROR_FILE           <tmpdir>/link-failures-error.md    (why the check could not be trusted)
//   MIN_LINKS_CHECKED    300      (fewer links answered = the check is broken, nothing is judged)
//   MAX_FAILED_PCT       25       (more links dead, unreachable or timing out than this = outage, nothing is judged)
//   REPORT_AFTER_RUNS    2        (consecutive failing runs before a link is reported)
//   STREAK_MAX_GAP_DAYS  15       (a first failure older than this does not count as "the run before")
//   REDIRECT_CHECK       1        (0 = skip the redirect check: what it knew stays as it was)
//   MAX_REDIRECT_FINDINGS 25      (more permanent redirects to a parent page than this in one run = a change of
//                                  the site, not retired pages: none is reported, the state stays as it was)
//   TODAY                (unset)  tests only: the date of the run, YYYY-MM-DD
//   CREATE_ISSUES        0        (1 = create, edit, comment on and close issues with the gh CLI)
//   DRY_RUN              0        (1 = do not touch issues or the tracker)
//   GH_TOKEN / GITHUB_REPOSITORY / GITHUB_SERVER_URL / GITHUB_RUN_ID   used for the gh CLI and run links
//   GH_CLI_SCRIPT        (unset)  tests only: run this Node script instead of the gh CLI
//   REPO_ROOT            (unset)  tests only: use another tree for the relative paths above
//   check only: INCLUDE_PATTERNS (JSON array replacing the toml `include`), FETCH_DELAY_MS (500),
//               CHECK_TIMEOUT_MS (20000), CHECK_RETRIES (2), CHECK_RETRY_WAIT_MS (2000)
//
// Writes GITHUB_OUTPUT keys: tracker_updated, reported_count (the links of both tables of the
// issue), warning_count, check_failed.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { STATUS_CODES } from "node:http";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { annotate, appendStepSummary, writeOutput } from "./lib/actions.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one issue that lists the confirmed dead links: runs find the open one by this exact title. */
export const DEAD_LINKS_ISSUE_TITLE = "Link Checker: dead external links";
export const DEAD_LINKS_ISSUE_LABEL = "broken-link";
/** The issue that says the external check itself could not be trusted. */
export const CHECK_FAILED_ISSUE_TITLE = "Link Checker: external check failed";
export const CHECK_FAILED_ISSUE_LABEL = "bug";
export const DEFAULT_REPORT_AFTER_RUNS = 2;
export const DEFAULT_STREAK_MAX_GAP_DAYS = 15;
export const DEFAULT_MIN_LINKS_CHECKED = 300;
export const DEFAULT_MAX_FAILED_PCT = 25;
export const DEFAULT_MAX_REDIRECT_FINDINGS = 25;
/** The marker line in the issue body that carries the listed links (read back to see what changed). */
export const URLS_MARKER = "link-failures-urls";
/** The same for the links of the second table, the ones that now redirect to a parent page. */
export const REDIRECTS_MARKER = "link-failures-redirects";
/** The heading of that second table in the running issue. */
export const REDIRECTS_HEADING =
  "Links that now redirect to a parent page (the page is probably gone)";

/** Answers that say "no" to a visitor without a browser or an account, not "this page is gone". */
const WARNING_CODES = new Set([401, 403, 405, 406, 407, 408, 429]);

/** File types searched for the place that holds a dead link. */
const SOURCE_EXTENSIONS = new Set([
  ".mdx",
  ".md",
  ".astro",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".html",
  ".yml",
  ".yaml",
]);

/** The tracker holds every dead link it knows: it must not count as a place that contains one. */
const TRACKER_BASENAME = "link-failures.json";

const MAX_TABLE_ROWS = 80;
const MAX_BODY_CHARS = 60_000;
const MAX_MARKER_CHARS = 15_000;
const MAX_LOCATIONS_PER_LINK = 5;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Read the settings of one run from the environment (a function, so tests can pass their own). */
export function loadConfig(e = process.env) {
  const root = e.REPO_ROOT ? resolve(e.REPO_ROOT) : join(__dirname, "..");
  const fromRoot = (path) => (isAbsolute(path) ? path : join(root, path));
  const num = (value, fallback) => {
    const n = Number(value);
    return value !== undefined && value !== "" && Number.isFinite(n)
      ? n
      : fallback;
  };
  return {
    root,
    lycheeJson: fromRoot(e.LYCHEE_JSON || "lychee/external.json"),
    lycheeExitCode: e.LYCHEE_EXIT_CODE ?? "",
    trackerFile: fromRoot(
      e.TRACKER_FILE || "src/data_files/link-failures.json",
    ),
    srcDir: fromRoot(e.SRC_DIR || "src"),
    distDir: fromRoot(e.DIST_DIR || "dist"),
    configFile: fromRoot(e.CONFIG_FILE || "lychee-external.toml"),
    lycheeIgnoreFile: fromRoot(e.LYCHEE_IGNORE_FILE || ".lycheeignore"),
    reportFile: e.REPORT_FILE || join(tmpdir(), "link-failures-report.md"),
    errorFile: e.ERROR_FILE || join(tmpdir(), "link-failures-error.md"),
    minLinksChecked: num(e.MIN_LINKS_CHECKED, DEFAULT_MIN_LINKS_CHECKED),
    maxFailedPct: num(e.MAX_FAILED_PCT, DEFAULT_MAX_FAILED_PCT),
    reportAfterRuns: num(e.REPORT_AFTER_RUNS, DEFAULT_REPORT_AFTER_RUNS),
    streakMaxGapDays: num(e.STREAK_MAX_GAP_DAYS, DEFAULT_STREAK_MAX_GAP_DAYS),
    redirectCheck: e.REDIRECT_CHECK !== "0",
    maxRedirectFindings: num(
      e.MAX_REDIRECT_FINDINGS,
      DEFAULT_MAX_REDIRECT_FINDINGS,
    ),
    today: /^\d{4}-\d{2}-\d{2}$/.test(e.TODAY ?? "")
      ? e.TODAY
      : new Date().toISOString().slice(0, 10),
    createIssues: e.CREATE_ISSUES === "1",
    dryRun: e.DRY_RUN === "1",
    ghCliScript: e.GH_CLI_SCRIPT || "",
    githubOutput: e.GITHUB_OUTPUT || "",
    stepSummary: e.GITHUB_STEP_SUMMARY || "",
    inGithubActions: e.GITHUB_ACTIONS === "true",
    runUrl:
      e.GITHUB_SERVER_URL && e.GITHUB_REPOSITORY && e.GITHUB_RUN_ID
        ? `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Reading lychee's report
// ---------------------------------------------------------------------------

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Parse lychee's `--format json` report (verified against lychee v0.24.2, lychee-bin
 * formatters/stats/json.rs): counters, `error_map` (failed responses) and
 * `timeout_map` (timed out responses), each `{ <input file>: [ { url, status } ] }`
 * where status is `{ text, code }` for an HTTP answer and `{ text, details }` otherwise.
 * Throws when the shape is not lychee's, so a format change fails the check loudly.
 *
 * `redirect_map` (`{ <input file>: [ { origin, redirects: [ { url, code } ] } ] }`) and
 * `success_map` are only filled when lychee runs verbose, while the counter `redirects` is
 * always set: the redirect check needs them, but an absent or malformed one is `null` (no
 * information), not an error, so that it can never fail the judging of the failures.
 */
export function parseLycheeReport(text) {
  let stats;
  try {
    stats = JSON.parse(text);
  } catch (err) {
    throw new Error(`lychee's report is not valid JSON (${err.message})`);
  }
  if (!isPlainObject(stats) || !isPlainObject(stats.error_map)) {
    throw new Error(
      "lychee's report has no `error_map` (not lychee's JSON format, or the format changed)",
    );
  }
  const timeoutMap = stats.timeout_map ?? {};
  if (!isPlainObject(timeoutMap)) {
    throw new Error(
      "lychee's report has a `timeout_map` that is not an object",
    );
  }
  const n = (key) => (Number.isFinite(stats[key]) ? stats[key] : 0);
  const counts = {
    total: n("total"),
    successful: n("successful"),
    errors: n("errors"),
    timeouts: n("timeouts"),
    unknown: n("unknown"),
    excludes: n("excludes"),
    redirects: n("redirects"),
  };
  const entries = (map) =>
    Object.values(map).reduce(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0,
    );
  if (counts.errors > 0 && entries(stats.error_map) === 0) {
    throw new Error(
      `lychee's report counts ${counts.errors} errors but lists none in \`error_map\` (the format changed?)`,
    );
  }
  return {
    counts,
    errorMap: stats.error_map,
    timeoutMap,
    redirectMap: isPlainObject(stats.redirect_map) ? stats.redirect_map : null,
    successMap: isPlainObject(stats.success_map) ? stats.success_map : {},
  };
}

/** One line of plain text: no markup, no mentions, no issue references. */
export function plain(value, max = 160) {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>[\]`|\\]/g, "")
    .replace(/@/g, "@\u200b")
    .replace(/#(?=\d)/g, "#\u200b")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Classify one failed response.
 *   broken       the page is gone: HTTP 4xx other than the "not for you / slow down" ones
 *   unreachable  the host is gone or unsafe: DNS lookup failed, connection failed (what lychee
 *                says on Linux for a domain that does not resolve), connection refused, bad certificate
 *   warning      anything that says nothing about the page: 401/403/405/406/407/408/429, 5xx,
 *                timeouts, redirect loops, other network errors
 * Only broken and unreachable can become a report, and only after two runs in a row.
 */
export function classifyStatus(status, { timedOut = false } = {}) {
  const text = plain(status?.text, 200);
  const details = plain(status?.details, 200);
  const code = Number.isInteger(status?.code) ? status.code : null;
  if (timedOut) {
    return { kind: "warning", code, reason: "timed out", timedOut: true };
  }
  if (code !== null) {
    const reason =
      text.replace(/^Rejected status code:\s*/i, "") || `HTTP ${code}`;
    if (code >= 500 || WARNING_CODES.has(code) || code < 400) {
      return { kind: "warning", code, reason };
    }
    return { kind: "broken", code, reason };
  }
  const haystack = `${text} ${details}`;
  if (
    /DNS resolution failed|failed to lookup address|nodename nor servname/i.test(
      haystack,
    )
  ) {
    return {
      kind: "unreachable",
      code,
      reason: "DNS lookup failed (the domain may be gone)",
    };
  }
  if (/SSL certificate/i.test(haystack)) {
    return {
      kind: "unreachable",
      code,
      reason: `TLS certificate problem: ${text.replace(/^Network error:\s*/i, "")}`,
    };
  }
  if (/Connection refused/i.test(haystack)) {
    return { kind: "unreachable", code, reason: "connection refused" };
  }
  // lychee 0.24.2 on Linux words an unresolvable domain like this, not as a DNS failure
  if (/Connection failed\. Check network connectivity/i.test(haystack)) {
    return {
      kind: "unreachable",
      code,
      reason: "connection failed (the domain may be gone)",
    };
  }
  return { kind: "warning", code, reason: text || details || "network error" };
}

/** What lychee prints for a failure it already reported for the same link on another page. */
const CACHED_ANSWER = /\(cached\)/i;

const KIND_RANK = { broken: 0, unreachable: 1, warning: 2 };

/**
 * The answer that stands for a link that failed on several pages. lychee asks a host once and
 * reports every further occurrence of the link as cached: an HTTP answer keeps its code and text
 * ("Rejected status code: 404 Not Found" on every page), but any other failure (refused connection,
 * bad certificate, unresolvable domain) is only "Error (cached)" on all but one page, and which page
 * keeps the real text changes from run to run. So an answer that is not a cached repeat wins; among
 * equals the harder verdict, then the text: the pick never depends on the order of the input.
 */
function chooseAnswer(answers) {
  const key = ({ cached, verdict: v }) =>
    `${cached ? 1 : 0}${KIND_RANK[v.kind]}${v.timedOut ? 1 : 0}|${v.reason}|${v.code}`;
  return answers.reduce((best, a) => (key(a) < key(best) ? a : best)).verdict;
}

/**
 * Group lychee's failed responses by link, in the order of the links. `pages` are the built
 * pages (lychee inputs) that contain the link, sorted: the order lychee lists them in changes
 * from run to run. Links that are not http(s) are not this check's business (the internal check
 * owns local links) and are counted in `ignored`.
 */
export function collectResults(report) {
  const found = new Map();
  let ignored = 0;
  const add = (map, timedOut) => {
    for (const [source, list] of Object.entries(map)) {
      if (!Array.isArray(list)) continue;
      for (const body of list) {
        if (!body || typeof body.url !== "string") continue;
        if (!/^https?:\/\//i.test(body.url)) {
          ignored++;
          continue;
        }
        const entry = found.get(body.url) ?? { answers: [], pages: new Set() };
        found.set(body.url, entry);
        entry.answers.push({
          cached: CACHED_ANSWER.test(String(body.status?.text ?? "")),
          verdict: classifyStatus(body.status, { timedOut }),
        });
        entry.pages.add(source);
      }
    }
  };
  add(report.errorMap, false);
  add(report.timeoutMap, true);
  const results = new Map();
  for (const url of [...found.keys()].sort()) {
    const { answers, pages } = found.get(url);
    results.set(url, {
      url,
      ...chooseAnswer(answers),
      pages: new Set([...pages].sort()),
    });
  }
  return { results, ignored };
}

/** How many links a result stands for: the built pages that contain it (at least one). */
const occurrences = (result) => Math.max(1, result.pages?.size ?? 1);

/**
 * The failed answers of one run by kind, counted per link per page like lychee's own totals:
 * `hard` (dead or unreachable: HTTP 4xx other than the "not for you" ones, DNS failure, failed or
 * refused connection, bad certificate), `timedOut`, and `other` (403, 429, 5xx, redirect loops,
 * unclear network errors: inconclusive answers that say nothing about the page).
 */
export function failureTally(results) {
  const tally = { hard: 0, timedOut: 0, other: 0 };
  for (const result of results.values()) {
    const n = occurrences(result);
    if (result.kind !== "warning") tally.hard += n;
    else if (result.timedOut) tally.timedOut += n;
    else tally.other += n;
  }
  return tally;
}

/**
 * The failed answers by host, most failures first: `{ host, total, hard, timedOut, other, codes }`
 * where `codes` is a Map of the inconclusive answers (HTTP code or short text) to their count.
 */
export function failuresByHost(results) {
  const hosts = new Map();
  for (const result of results.values()) {
    const host = hostOf(result.url);
    const entry = hosts.get(host) ?? {
      host,
      total: 0,
      hard: 0,
      timedOut: 0,
      other: 0,
      codes: new Map(),
    };
    const n = occurrences(result);
    entry.total += n;
    if (result.kind !== "warning") entry.hard += n;
    else if (result.timedOut) entry.timedOut += n;
    else {
      entry.other += n;
      const key = Number.isInteger(result.code)
        ? `HTTP ${result.code}`
        : plain(result.reason, 40);
      entry.codes.set(key, (entry.codes.get(key) ?? 0) + n);
    }
    hosts.set(host, entry);
  }
  return [...hosts.values()].sort(
    (a, b) => b.total - a.total || a.host.localeCompare(b.host),
  );
}

/** One markdown bullet per host (at most `max`), naming what its failed answers were. */
export function describeHostFailures(hosts, max = 15) {
  const lines = hosts.slice(0, max).map((h) => {
    const parts = [
      `${h.hard} dead or unreachable`,
      `${h.timedOut} timed out`,
      h.other
        ? `${h.other} inconclusive (${[...h.codes]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([key, n]) => `${key} x${n}`)
            .join(", ")})`
        : "0 inconclusive",
    ];
    return `- ${code(h.host)}: ${h.total} failed answer${h.total === 1 ? "" : "s"} (${parts.join(", ")})`;
  });
  if (hosts.length > max) lines.push(`- and ${hosts.length - max} more hosts`);
  return lines;
}

/**
 * Can this run be trusted at all? Returns the reason it cannot, or null. A run that
 * cannot be trusted judges no link: a failure of the checker is never evidence.
 *
 * The share of failed links is counted over HARD failures (dead or unreachable) and
 * timeouts only. 403, 429, 5xx and unclear network errors are warnings that never
 * advance or reset a link's streak, so they cannot make the verdict wrong; counting them
 * made one bot-blocking host family (the commercial training sites answer 403 or 429 to
 * datacenter addresses) enough to declare the whole run untrustworthy and judge no
 * GitHub repository link either. `results` is collectResults(report).results.
 */
export function untrustworthyReason(
  report,
  cfg,
  results = collectResults(report).results,
) {
  const { successful, errors, timeouts, unknown } = report.counts;
  const checked = successful + errors + timeouts + unknown;
  if (checked < cfg.minLinksChecked) {
    return `lychee answered for only ${checked} links (at least ${cfg.minLinksChecked} are expected). The allowlist in lychee-external.toml selects roughly 800 links of the built site, so the build, the input glob or the allowlist is probably broken.`;
  }
  const tally = failureTally(results);
  const failed = tally.hard + tally.timedOut;
  const pct = (failed / checked) * 100;
  if (pct > cfg.maxFailedPct) {
    return `${failed} of ${checked} links (${Math.round(pct)}%) failed hard in one run (${tally.hard} dead or unreachable, ${tally.timedOut} timed out), more than the ${cfg.maxFailedPct}% limit. That looks like an outage of the runner's network or a changed lychee output, not ${failed} dead links, so no link was judged.${tally.other ? ` Another ${tally.other} answered 403, 429, 5xx or with a network error; those are warnings and do not count toward the limit.` : ""}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redirects: links that still answer, but now land on a parent page
// ---------------------------------------------------------------------------

/** A permanent redirect says "this address is gone for good"; 302, 303 and 307 do not. */
const PERMANENT_REDIRECT_CODES = new Set([301, 308]);
/** The locale segment that starts many Microsoft paths: en-us, cs-cz (the hyphenated form only). */
const LOCALE_SEGMENT = /^[a-z]{2}-[a-z]{2}$/i;
/** A last path segment that only names the default document of a directory: /x/index.html is /x/. */
const DEFAULT_DOCUMENT = /^(?:index|default)\.(?:html?|aspx?|php)$/;

/**
 * What tells whether two addresses are the same page of the same site: the host in lower case
 * without a leading `www.`, and the path as lower-case segments without a leading locale
 * (`en-us`, `cs-cz`; a bare two-letter segment such as `de` stays) and without a trailing default
 * document (`index.html`). Scheme, query, fragment, case and a trailing slash do not count.
 * null for anything but an http(s) address.
 */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.length > 0 && LOCALE_SEGMENT.test(segments[0])) {
    segments.shift();
  }
  if (
    segments.length > 0 &&
    DEFAULT_DOCUMENT.test(segments[segments.length - 1])
  ) {
    segments.pop();
  }
  return {
    host: parsed.hostname.toLowerCase().replace(/^www\./, ""),
    segments,
  };
}

/**
 * How the final address of a redirect chain relates to the link it started from:
 *   same          the same page (http to https, www, a slash, a locale, a query: nothing to say)
 *   redirect-hub  the final path is a PROPER PREFIX of the link's: a parent page of the same site,
 *                 the site root included (a link to the root itself can never be demoted)
 *   moved         another page of the same site
 *   other-site    another host (a short link, a domain move): not judged
 *   unknown       an address that is not http(s)
 */
export function redirectRelation(origin, final) {
  const from = normalizeUrl(origin);
  const to = normalizeUrl(final);
  if (!from || !to) return "unknown";
  if (from.host !== to.host) return "other-site";
  const prefix =
    to.segments.length <= from.segments.length &&
    to.segments.every((segment, i) => segment === from.segments[i]);
  if (!prefix) return "moved";
  return to.segments.length === from.segments.length ? "same" : "redirect-hub";
}

/** One `{ origin, redirects: [ { url, code } ] }` of lychee's `redirect_map`, or null when it has another shape. */
function chainOf(item) {
  if (!isPlainObject(item) || typeof item.origin !== "string") return null;
  if (!Array.isArray(item.redirects) || item.redirects.length === 0) {
    return null;
  }
  const hops = [];
  for (const hop of item.redirects) {
    if (!isPlainObject(hop) || typeof hop.url !== "string") return null;
    hops.push({
      url: hop.url,
      code: Number.isInteger(hop.code) ? hop.code : null,
    });
  }
  return { origin: item.origin, hops };
}

/**
 * The regular expressions of a `.lycheeignore` text: one per line, blank lines and `#` comments
 * skipped. A line that is not a valid expression is returned in `invalid`.
 */
export function readIgnorePatterns(text) {
  const patterns = [];
  const invalid = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      patterns.push(new RegExp(line));
    } catch {
      invalid.push(line);
    }
  }
  return { patterns, invalid };
}

const unusableRedirects = (reason) => ({
  usable: false,
  reason,
  redirecting: 0,
  ignored: 0,
  same: 0,
  otherSite: 0,
  unknown: 0,
  moved: [],
  candidates: [],
  permanent: 0,
  tooMany: false,
  hosts: [],
});

/**
 * Judge the redirect chains of lychee's report (`report` is parseLycheeReport's result,
 * `results` collectResults(report).results).
 *
 * A link counts when its chain is in `redirect_map` and its final answer is a success (the
 * links of `results` failed or timed out: the failure logic owns them) and no pattern of
 * `ignore` (the .lycheeignore lines) matches it. The same link on several pages is ONE link: its
 * pages are the union of the pages of its chains and, because lychee asks a host once and
 * reports the repeats as cached without the chain, of the pages `success_map` lists it on
 * (`pageOf` turns a page into what is stored and shown). Chains that differ for one link: the one
 * that sorts first. Each link is then judged by redirectRelation of its address and the last hop.
 *
 * `usable` is false when there is nothing to judge from: no `redirect_map`, or lychee counted
 * redirects but lists none (it only lists them when run verbose). An empty map next to a count
 * of 0 is usable and means that nothing redirects. A candidate (`redirect-hub`) is `permanent`
 * when at least one hop is a 301 or a 308. `tooMany` is set when more than `maxFindings`
 * permanent candidates stand in one run.
 */
export function analyzeRedirects(
  report,
  results = collectResults(report).results,
  {
    maxFindings = DEFAULT_MAX_REDIRECT_FINDINGS,
    ignore = [],
    pageOf = (page) => page,
  } = {},
) {
  if (!report.redirectMap) {
    return unusableRedirects("the report has no `redirect_map`");
  }
  const byOrigin = new Map();
  for (const [page, list] of Object.entries(report.redirectMap)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const chain = chainOf(item);
      if (!chain) continue;
      const entry = byOrigin.get(chain.origin) ?? {
        chains: [],
        pages: new Set(),
      };
      byOrigin.set(chain.origin, entry);
      entry.chains.push(chain.hops);
      entry.pages.add(page);
    }
  }
  if (report.counts.redirects > 0 && byOrigin.size === 0) {
    return unusableRedirects(
      `lychee counted ${report.counts.redirects} redirects but lists none in \`redirect_map\` (it only lists them when it runs verbose: verbose = "info" in lychee-external.toml)`,
    );
  }
  for (const [page, list] of Object.entries(report.successMap ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item?.url === "string")
        byOrigin.get(item.url)?.pages.add(page);
    }
  }

  const analysis = {
    usable: true,
    reason: null,
    redirecting: 0,
    ignored: 0,
    same: 0,
    otherSite: 0,
    unknown: 0,
    moved: [],
    candidates: [],
    permanent: 0,
    tooMany: false,
    hosts: [],
  };
  for (const origin of [...byOrigin.keys()].sort()) {
    if (results.has(origin)) continue;
    analysis.redirecting++;
    if (ignore.some((pattern) => pattern.test(origin))) {
      analysis.ignored++;
      continue;
    }
    const { chains, pages } = byOrigin.get(origin);
    const hops = chains
      .map((chain) => ({ chain, key: JSON.stringify(chain) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0].chain;
    const final = hops.at(-1).url;
    const seen = {
      url: origin,
      final,
      codes: hops.map((hop) => hop.code),
      pages: [...new Set([...pages].map(pageOf))].sort(),
    };
    const relation = redirectRelation(origin, final);
    if (relation === "same") analysis.same++;
    else if (relation === "other-site") analysis.otherSite++;
    else if (relation === "unknown") analysis.unknown++;
    else if (relation === "moved") analysis.moved.push(seen);
    else {
      analysis.candidates.push({
        ...seen,
        permanent: seen.codes.some((c) => PERMANENT_REDIRECT_CODES.has(c)),
      });
    }
  }
  const permanent = analysis.candidates.filter((c) => c.permanent);
  analysis.permanent = permanent.length;
  analysis.tooMany = permanent.length > maxFindings;
  const byHost = new Map();
  for (const c of permanent) {
    const host = hostOf(c.url);
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  analysis.hosts = [...byHost]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  return analysis;
}

// ---------------------------------------------------------------------------
// Tracker: the links that failed on the last run(s)
// ---------------------------------------------------------------------------

export const emptyTracker = () => ({ failing: {} });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The days and the count that every record of the tracker has. */
const validStreak = (entry) =>
  isPlainObject(entry) &&
  ISO_DAY.test(entry.firstSeen ?? "") &&
  ISO_DAY.test(entry.lastSeen ?? "") &&
  Number.isInteger(entry.runs) &&
  entry.runs >= 1;

/** A record of a link that now redirects: where it lands, the codes of the chain, the built pages. */
const validRedirect = (entry) =>
  validStreak(entry) &&
  typeof entry.final === "string" &&
  Array.isArray(entry.codes) &&
  entry.codes.every((c) => c === null || Number.isInteger(c)) &&
  (entry.pages === undefined ||
    (Array.isArray(entry.pages) &&
      entry.pages.every((page) => typeof page === "string")));

/** Validate the tracker file's text. Throws on a corrupt file (a failsafe, not a silent reset). */
export function parseTracker(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`The tracker is not valid JSON (${err.message})`);
  }
  if (!isPlainObject(data) || !isPlainObject(data.failing)) {
    throw new Error('The tracker has no "failing" object');
  }
  const failing = {};
  for (const [url, entry] of Object.entries(data.failing)) {
    if (!validStreak(entry)) {
      throw new Error(`The tracker entry for ${plain(url, 100)} is malformed`);
    }
    failing[url] = {
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      runs: entry.runs,
      reason: String(entry.reason ?? ""),
    };
  }
  // `redirects` is newer than the file: a tracker without it is an old one, not a corrupt one
  if (data.redirects === undefined) return { failing };
  if (!isPlainObject(data.redirects)) {
    throw new Error('The tracker has a "redirects" that is not an object');
  }
  const redirects = {};
  for (const [url, entry] of Object.entries(data.redirects)) {
    if (!validRedirect(entry)) {
      throw new Error(
        `The tracker entry for ${plain(url, 100)} (redirects) is malformed`,
      );
    }
    redirects[url] = {
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      runs: entry.runs,
      final: entry.final,
      codes: entry.codes,
      pages: entry.pages ?? [],
    };
  }
  return Object.keys(redirects).length > 0
    ? { failing, redirects }
    : { failing };
}

/** The file text of a tracker: sorted keys, and no `redirects` key while there is none to keep. */
export function serializeTracker(tracker) {
  const failing = {};
  for (const url of Object.keys(tracker.failing).sort()) {
    const { firstSeen, lastSeen, runs, reason } = tracker.failing[url];
    failing[url] = { firstSeen, lastSeen, runs, reason };
  }
  const file = { failing };
  const known = tracker.redirects ?? {};
  if (Object.keys(known).length > 0) {
    file.redirects = {};
    for (const url of Object.keys(known).sort()) {
      const { firstSeen, lastSeen, runs, final, codes, pages } = known[url];
      file.redirects[url] = { firstSeen, lastSeen, runs, final, codes, pages };
    }
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

const dayNumber = (isoDate) =>
  Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

/**
 * The record of a link that is seen in this run (`seen`: what this run saw of it, kept in the
 * record), after the streak rules that dead and redirecting links share:
 *   no record, or a first sighting older than the gap  -> runs 1 (first sighting)
 *   record from an earlier day                          -> runs + 1
 *   record from today (a second run on the same day)    -> unchanged: one day counts once
 *   confirmed record (runs >= reportAfterRuns)          -> unchanged, so a link that stays
 *                                                          the same causes no weekly commit
 */
function advanceEntry(old, seen, today, { reportAfterRuns, gapDays }) {
  if (old && old.runs >= reportAfterRuns) return old;
  if (old && dayNumber(today) - dayNumber(old.lastSeen) <= gapDays) {
    return dayNumber(today) <= dayNumber(old.lastSeen)
      ? old
      : { ...old, ...seen, lastSeen: today, runs: old.runs + 1 };
  }
  return { firstSeen: today, lastSeen: today, runs: 1, ...seen };
}

const streakOptions = (options) => ({
  reportAfterRuns: options.reportAfterRuns ?? DEFAULT_REPORT_AFTER_RUNS,
  gapDays: options.streakMaxGapDays ?? DEFAULT_STREAK_MAX_GAP_DAYS,
});

/**
 * The tracker after this run.
 *   hard failure (broken / unreachable)                    -> advanceEntry
 *   warning        an inconclusive answer: the record, if any, is kept exactly as it was
 *   not in this run (fine again, or removed from the site)  -> dropped
 * The `redirects` of the tracker are advanced by advanceRedirects.
 */
export function advanceTracker(previous, results, today, options = {}) {
  const streak = streakOptions(options);
  const failing = {};
  for (const result of results.values()) {
    const old = previous.failing[result.url];
    if (result.kind === "warning") {
      if (old) failing[result.url] = old;
      continue;
    }
    failing[result.url] = advanceEntry(
      old,
      { reason: result.reason },
      today,
      streak,
    );
  }
  return { failing };
}

/**
 * The `redirects` of the tracker after this run: the links that now redirect to a parent page,
 * by the same streak rules as the dead links (advanceEntry). `previous` is the tracker's
 * `redirects`, `analysis` analyzeRedirects(), `results` the failed links of the run.
 *   permanent candidate                          -> advanceEntry, with what this run saw
 *                                                   (where it lands, the codes, the pages)
 *   candidate with temporary hops only           -> the record, if any, is kept as it was
 *   a link with an inconclusive answer this run  -> the record is kept as it was
 *   anything else (it does not redirect to a parent page any more, it is ignored, it failed
 *   for good, it left the site)                  -> dropped
 * With nothing to judge from (analysis not usable: no verbose, switched off) or a flood of
 * candidates (analysis.tooMany) nothing is learned and nothing is lost: `previous` as it was.
 */
export function advanceRedirects(
  previous,
  analysis,
  results,
  today,
  options = {},
) {
  if (!analysis.usable || analysis.tooMany) return previous;
  const streak = streakOptions(options);
  const redirects = {};
  for (const candidate of analysis.candidates) {
    const old = previous[candidate.url];
    if (!candidate.permanent) {
      if (old) redirects[candidate.url] = old;
      continue;
    }
    redirects[candidate.url] = advanceEntry(
      old,
      {
        final: candidate.final,
        codes: candidate.codes,
        pages: candidate.pages,
      },
      today,
      streak,
    );
  }
  for (const [url, old] of Object.entries(previous)) {
    if (!(url in redirects) && results.get(url)?.kind === "warning") {
      redirects[url] = old;
    }
  }
  return redirects;
}

/** The links of a tracker that have failed on enough consecutive runs to be reported. */
export function reportableEntries(
  tracker,
  reportAfterRuns = DEFAULT_REPORT_AFTER_RUNS,
) {
  return Object.entries(tracker.failing)
    .filter(([, entry]) => entry.runs >= reportAfterRuns)
    .map(([url, entry]) => ({ url, ...entry }))
    .sort(
      (a, b) =>
        a.firstSeen.localeCompare(b.firstSeen) || a.url.localeCompare(b.url),
    );
}

/** The redirecting links of a tracker that were seen on enough consecutive runs to be reported. */
export function reportableRedirects(
  tracker,
  reportAfterRuns = DEFAULT_REPORT_AFTER_RUNS,
) {
  return Object.entries(tracker.redirects ?? {})
    .filter(([, entry]) => entry.runs >= reportAfterRuns)
    .map(([url, entry]) => ({ url, ...entry }))
    .sort(
      (a, b) =>
        a.firstSeen.localeCompare(b.firstSeen) || a.url.localeCompare(b.url),
    );
}

// ---------------------------------------------------------------------------
// Where does a dead link live? (file:line in src/, and the built page)
// ---------------------------------------------------------------------------

function walkFiles(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

/** Read every text source that can hold a link once; `lookupLocations` searches it per link. */
export function buildSourceIndex(srcDir, root = dirname(srcDir)) {
  const files = [];
  for (const path of walkFiles(srcDir)) {
    const dot = path.lastIndexOf(".");
    if (!SOURCE_EXTENSIONS.has(dot < 0 ? "" : path.slice(dot).toLowerCase())) {
      continue;
    }
    if (basename(path) === TRACKER_BASENAME) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    files.push({
      file: relative(root, path).split("\\").join("/"),
      text,
    });
  }
  return files;
}

/** The spellings a link can have in a source file next to the normalised one lychee reports. */
export function urlVariants(url) {
  const variants = new Set([url]);
  variants.add(url.split("#")[0]);
  for (const v of [...variants]) {
    if (v.endsWith("/")) variants.add(v.slice(0, -1));
    variants.add(v.replace(/&/g, "&amp;"));
    try {
      variants.add(decodeURI(v));
    } catch {
      /* not decodable: keep the others */
    }
  }
  return [...variants].filter((v) => v.length >= 10);
}

/** Does the link end at `end` in `text`, or does it continue (a longer address, a path, a query)? */
function endsUrlAt(text, end) {
  const c = text[end];
  if (c === undefined) return true;
  if (/[A-Za-z0-9_%~\-/?&=+:@;!*$]/.test(c)) return false;
  if (c === "." && /[A-Za-z0-9]/.test(text[end + 1] ?? "")) return false;
  return true;
}

/** `src/...:line` for every place in the index that contains the link (at most `max`, plus the total). */
export function lookupLocations(index, url, max = MAX_LOCATIONS_PER_LINK) {
  const variants = urlVariants(url);
  const hits = [];
  for (const { file, text } of index) {
    for (const variant of variants) {
      let found = false;
      let from = 0;
      for (;;) {
        const at = text.indexOf(variant, from);
        if (at < 0) break;
        from = at + variant.length;
        if (!endsUrlAt(text, at + variant.length)) continue;
        const place = `${file}:${text.slice(0, at).split("\n").length}`;
        if (!hits.includes(place)) hits.push(place);
        found = true;
      }
      if (found) break;
    }
  }
  return { places: hits.slice(0, max), total: hits.length };
}

/** `dist/certs/security/sc-100/index.html` -> `/certs/security/sc-100/` */
export function pageFromInput(input, distName = "dist") {
  const normal = String(input).replace(/\\/g, "/");
  const escaped = distName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = normal.match(new RegExp(`(?:^|/)${escaped}/(.*)$`));
  if (!match) return normal;
  return `/${match[1]}`.replace(/index\.html$/, "").replace(/\.html$/, "");
}

// ---------------------------------------------------------------------------
// Issue texts
// ---------------------------------------------------------------------------

const code = (value) =>
  `\`${String(value)
    .replace(/`/g, "%60")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")}\``;
const cell = (value) => String(value).replace(/\|/g, "\\|");
const shorten = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** URLs that go into the marker: no `-->` can close the comment early. */
const encodeMarker = (urls) =>
  JSON.stringify(urls).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** The marker line with as many links as fit in its budget (a longer list is cut at a link). */
function markerLine(urls, name = URLS_MARKER) {
  const kept = [];
  let size = 2;
  for (const url of urls) {
    const add = encodeMarker(url).length + 1;
    if (size + add > MAX_MARKER_CHARS) break;
    kept.push(url);
    size += add;
  }
  return `<!-- ${name}: ${encodeMarker(kept)} -->`;
}

/** The links of one marker line of an issue body (an absent or unreadable marker lists none). */
function readMarker(body, name) {
  const match = String(body ?? "").match(new RegExp(`<!-- ${name}: (.*?) -->`));
  if (!match) return [];
  try {
    const urls = JSON.parse(match[1]);
    return Array.isArray(urls) ? urls.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** The dead links an issue body lists, read back from its marker line. */
export function extractListedUrls(body) {
  return readMarker(body, URLS_MARKER);
}

/** The links of the second table (redirecting to a parent page) an issue body lists: none for an issue that has no such table. */
export function extractListedRedirects(body) {
  return readMarker(body, REDIRECTS_MARKER);
}

/** One line of text for a table cell: a line break would end the row. */
const oneLine = (value) => String(value).replace(/[\r\n\t]+/g, " ");

const DEAD_INTRO =
  "These links failed the weekly external link check of the built site on two runs in a row, so they are very likely really gone and not a passing outage. The list is the current state: the next weekly run edits it, comments here when links are added or fixed, and closes this issue when none is left.";
const REDIRECTS_ONLY_INTRO =
  "The weekly external link check of the built site found no dead link. The list is the current state: the next weekly run edits it, comments here when links are added or fixed, and closes this issue when none is left.";
const REDIRECTS_INTRO =
  "These links still answer, but a permanent redirect now sends them to a parent page of their own site (often the site root or a hub page) on two runs in a row. That usually means the page behind the link was retired. They are less urgent than a dead link: nothing fails for a visitor, but the card no longer leads where it says.";
const REDIRECTS_STEP =
  "For a link that redirects to a parent page: open it. If the page is gone, remove the card (and anything on the page that depends on it) or use the verified replacement; never guess an address. If it is still the right page, add its URL to `.lycheeignore` (one regular expression per line, dots escaped): that excludes it from the redirect check, and the next run drops it from this list.";
const BUILD_STEP =
  "Run `pnpm build`. The check runs again next Monday; you can also start the Link Checker workflow by hand.";
const UNLISTED_DEAD =
  "Links that fail only once, and answers like 403, 429, 5xx or a timeout, are not listed: they say little about the page.";
const UNLISTED_REDIRECTS =
  "Redirects that only change the form of the address (http to https, `www`, a trailing slash, a locale, a query), that lead to another site or to another page of the same site, or that are only temporary, are not listed either.";

/**
 * The text of the running issue: the table of the dead links and, when there are any, a second,
 * lower-urgency one with the links that now redirect to a parent page (`redirects`: the
 * confirmed entries of the tracker's `redirects`). It depends only on the confirmed links (no
 * dates or run links), so an unchanged situation yields an identical text and no edit; with no
 * `redirects` it is exactly the text of the dead links alone.
 * `locations` maps a link to `{ places, total }`, `pages` maps it to site paths (shown sorted;
 * a redirecting link carries its own pages).
 * The text always stays below GitHub's size limit: a long list shows fewer rows (the
 * job summary has them all) and the markers keep as many links as their budgets allow.
 */
export function buildDeadLinksBody(
  entries,
  { locations, pages, redirects = [] },
) {
  const marker = markerLine(entries.map((e) => e.url));
  const redirectMarker =
    redirects.length > 0
      ? markerLine(
          redirects.map((e) => e.url),
          REDIRECTS_MARKER,
        )
      : null;
  const fixIn = (entry) => {
    const found = locations.get(entry.url) ?? { places: [], total: 0 };
    const on = [...(entry.pages ?? pages.get(entry.url) ?? [])].sort();
    const where = found.places.length
      ? `${found.places.map(code).join(", ")}${found.total > found.places.length ? ` and ${found.total - found.places.length} more` : ""}`
      : "not found in `src/` as written (a generated or redirected link?)";
    const pageNote = on.length
      ? ` Built page${on.length > 1 ? "s" : ""}: ${on.slice(0, 3).map(code).join(", ")}${on.length > 3 ? ` and ${on.length - 3} more` : ""}.`
      : "";
    return `${cell(where)}${cell(pageNote)}`;
  };
  const assemble = (rowLimit) => {
    const lines = [];
    if (entries.length > 0) {
      const rows = entries
        .slice(0, rowLimit)
        .map(
          (entry) =>
            `| ${cell(code(shorten(entry.url, 300)))} | ${cell(plain(entry.reason, 120))} | ${entry.firstSeen} | ${fixIn(entry)} |`,
        );
      lines.push(
        DEAD_INTRO,
        "",
        "| Link | Problem | Failing since | Fix it in |",
        "| --- | --- | --- | --- |",
        ...rows,
      );
      if (entries.length > rows.length) {
        lines.push(
          "",
          `${entries.length - rows.length} more links are not shown here; the job summary of the latest run lists all of them.`,
        );
      }
    } else {
      lines.push(REDIRECTS_ONLY_INTRO);
    }
    if (redirects.length > 0) {
      const rows = redirects
        .slice(0, rowLimit)
        .map(
          (entry) =>
            `| ${cell(code(shorten(oneLine(entry.url), 300)))} | ${cell(code(shorten(oneLine(entry.final), 300)))} | ${entry.codes.map((c) => c ?? "?").join(" -> ")} | ${entry.firstSeen} | ${fixIn(entry)} |`,
        );
      lines.push(
        "",
        `### ${REDIRECTS_HEADING}`,
        "",
        REDIRECTS_INTRO,
        "",
        "| Link | Now lands on | Redirects | First detected | Fix it in |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
      );
      if (redirects.length > rows.length) {
        lines.push(
          "",
          `${redirects.length - rows.length} more links are not shown here; the job summary of the latest run lists all of them.`,
        );
      }
    }
    const steps = [];
    if (entries.length > 0) {
      steps.push(
        "Open the link. If the page moved, replace it with the verified new address and keep the tracking parameters (`?WT.mc_id=studentamb_165290`, `#u44`). If a repository was replaced, use its successor (see Lab Pages in `AGENTS.md`). If nothing replaces it, remove the card and anything on the page that depends on it. Never guess a replacement address.",
        "A link that works in a browser but is reported here means the host blocks this checker. Do not edit the page: remove the host from `include` in `lychee-external.toml`.",
      );
    }
    if (redirects.length > 0) steps.push(REDIRECTS_STEP);
    steps.push(BUILD_STEP);
    lines.push(
      "",
      "### What to do",
      "",
      ...steps.map((step, i) => `${i + 1}. ${step}`),
      "",
      redirects.length > 0
        ? `${UNLISTED_DEAD} ${UNLISTED_REDIRECTS} The job summary of each run shows them.`
        : `${UNLISTED_DEAD} The job summary of each run shows them.`,
      "",
      marker,
    );
    if (redirectMarker) lines.push(redirectMarker);
    return lines.join("\n");
  };
  for (let rowLimit = MAX_TABLE_ROWS; ; rowLimit = Math.floor(rowLimit / 2)) {
    const body = assemble(rowLimit);
    if (body.length <= MAX_BODY_CHARS || rowLimit <= 1) return body;
  }
}

/**
 * The comment that says what a run changed in the lists of the issue. `added` and `removed`
 * are the dead links, `addedRedirects` and `removedRedirects` the links of the second table.
 */
export function buildChangeComment({
  added,
  removed,
  addedRedirects = [],
  removedRedirects = [],
  today,
  runUrl,
}) {
  const list = (urls) => urls.slice(0, 20).map((u) => `- ${code(u)}`);
  const lines = [
    `Link check of ${today}${runUrl ? ` ([run](${runUrl}))` : ""}:`,
  ];
  const section = (title, urls) => {
    if (!urls.length) return;
    lines.push("", `${title} (${urls.length}):`, ...list(urls));
    if (urls.length > 20) lines.push(`- and ${urls.length - 20} more`);
  };
  section("Newly confirmed dead", added);
  section("Fixed or gone", removed);
  section("Newly redirecting to a parent page", addedRedirects);
  section("No longer redirecting to a parent page, or gone", removedRedirects);
  lines.push("", "The list in the issue text is up to date.");
  return lines.join("\n");
}

export function buildCloseComment({ today, runUrl }) {
  return `No link has failed on two consecutive runs and none redirects to a parent page in the link check of ${today}${runUrl ? ` ([run](${runUrl}))` : ""}, so there is nothing left to fix. Closing this issue; a link that fails twice in a row, or that redirects to a parent page twice in a row, opens a new one.`;
}

export function buildCheckFailedBody({
  reason,
  today,
  runUrl,
  hostLines = [],
}) {
  const lines = [
    `The scheduled external link check could not give a trustworthy result on ${today}. No link was judged and the tracker was left as it was, so nothing was lost: the next healthy run continues where the last one stopped.`,
    "",
    `**Why:** ${reason}`,
  ];
  if (hostLines.length) {
    lines.push(
      "",
      "**Failed answers by host (most first):**",
      "",
      ...hostLines,
    );
  }
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  const steps = [
    "Open the run and read the lychee step. A configuration or download error means `lychee-external.toml` or the workflow needs a fix.",
    "An outage or blocking of the runner usually passes: start the Link Checker workflow by hand once it is over.",
    "Try the same check locally: see `docs/monitors/link-checker.md`.",
  ];
  if (hostLines.length) {
    steps.splice(
      1,
      0,
      "If one host accounts for most of the failed answers and they are 403 or 429, that host blocks the runner: remove it from `include` in `lychee-external.toml`.",
    );
  }
  lines.push(
    "",
    "### What to do",
    "",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "This issue gets one comment per failed run and closes itself after the next healthy run.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Issues (through the gh CLI)
// ---------------------------------------------------------------------------

const normalizeBody = (text) =>
  String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

/**
 * Bring one hub issue in line with the state, through `gh(args, stdin)`:
 *   active, none open   create ONE issue (title, label), the label first if it does not exist;
 *   active, one open    edit its text if it changed and add the comment `changeComment(issue)`
 *                       returns, if any (never a second issue; with several open copies, only
 *                       the oldest is touched);
 *   inactive, some open close each with `closeComment`.
 * The state is the open issue, not the tracker: every run re-derives it. When the issue is
 * needed a failed lookup or write throws (nothing was written yet); when it is only being
 * closed a failure is reported and the next run tries again. The text of the open issue is
 * read (one `gh issue view`) only when the issue is needed: the listing never carries texts.
 */
export function syncIssue({
  gh,
  enabled,
  title,
  label,
  labelColor,
  labelDescription,
  active,
  body,
  changeComment = () => null,
  closeComment,
}) {
  const result = (action, extra = {}) => ({
    action,
    number: null,
    closed: [],
    error: null,
    ...extra,
  });
  if (!enabled) return result(active ? "skipped" : "none");
  let open;
  try {
    open = listOpenIssues(gh, { title, label, body: active });
  } catch (err) {
    if (active) throw err;
    return result("lookup-failed", { error: err.message });
  }
  if (active) {
    if (open.length) {
      const issue = open[0];
      const changed = normalizeBody(issue.body) !== normalizeBody(body);
      if (changed) {
        gh(["issue", "edit", String(issue.number), "--body-file", "-"], body);
      }
      const comment = changeComment(issue);
      if (comment) {
        gh(
          ["issue", "comment", String(issue.number), "--body-file", "-"],
          comment,
        );
      }
      return result(changed || comment ? "updated" : "unchanged", {
        number: issue.number,
      });
    }
    ensureLabel(gh, label, {
      color: labelColor,
      description: labelDescription,
    });
    const out = gh(
      [
        "issue",
        "create",
        "--title",
        title,
        "--label",
        label,
        "--body-file",
        "-",
      ],
      body,
    );
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

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** A workflow annotation in Actions, a plain line elsewhere: a note must be visible even without an issue. */
function annotateRun(cfg, level, message) {
  if (cfg.inGithubActions) {
    annotate(level, message, { title: "External link check" });
  } else {
    console.warn(`${level === "error" ? "Error" : "Note"}: ${message}`);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid URL)";
  }
}

/** One markdown bullet for a link of the redirect lists: the link, where it lands and the codes of the chain. */
const redirectBullet = (r, state = "") =>
  `- ${state}${code(shorten(oneLine(r.url), 200))} -> ${code(shorten(oneLine(r.final), 200))} (${r.codes.map((c) => c ?? "?").join(" -> ")})`;

/**
 * The "Redirects" section of the job summary, as lines: what the redirect check saw, or why it did
 * not look. `redirects` is `{ status, reason, analysis, maxFindings }` where status is "off",
 * "unusable" (no data to judge from), "too-many" (a flood of permanent redirects to a parent
 * page: none is reported) or "ok"; `tracker` is the tracker after the run and `confirmed` the set
 * of redirecting links that are reported.
 */
export function buildRedirectSummary({ redirects, tracker, confirmed }) {
  const { status, reason, analysis, maxFindings } = redirects;
  const lines = ["", "### Redirects", ""];
  if (status === "off") {
    lines.push(
      "The redirect check is switched off (`REDIRECT_CHECK=0`). What it knew was left as it was.",
    );
    return lines;
  }
  if (status === "unusable") {
    lines.push(
      `The redirect check had nothing to judge from this run: ${reason}. What it knew was left as it was.`,
    );
    return lines;
  }
  const a = analysis;
  if (a.redirecting === 0) {
    lines.push("No link answered through a redirect.");
    return lines;
  }
  const parts = [
    `${a.same} only changed the form of the address (http to https, \`www\`, a trailing slash, a locale, a query)`,
    `${a.otherSite} lead to another site (not judged)`,
    `${a.moved.length} to another page of the same site`,
    `${a.candidates.length} to a parent page of their own site`,
  ];
  if (a.unknown) parts.push(`${a.unknown} to an address that is not http(s)`);
  if (a.ignored) parts.push(`${a.ignored} skipped (.lycheeignore)`);
  lines.push(
    `${a.redirecting} links answered through a redirect: ${parts.join(", ")}.`,
  );
  if (status === "too-many") {
    lines.push(
      "",
      `**Too many at once:** ${a.permanent} links now redirect permanently to a parent page of their own site, more than the limit of ${maxFindings} (\`MAX_REDIRECT_FINDINGS\`). That looks like a change of the site, not ${a.permanent} retired pages, so none of them was reported and what the redirect check knew was left as it was. By host:`,
      "",
      ...a.hosts.slice(0, 15).map((h) => `- ${code(h.host)}: ${h.count}`),
    );
  }
  const permanent = a.candidates.filter((c) => c.permanent);
  const temporary = a.candidates.filter((c) => !c.permanent);
  if (permanent.length && status === "ok") {
    lines.push(
      "",
      `**Probably gone: a permanent redirect to a parent page (${permanent.length})**`,
      "",
    );
    for (const r of permanent.slice(0, 100)) {
      const entry = tracker.redirects?.[r.url];
      lines.push(
        redirectBullet(
          r,
          `${confirmed.has(r.url) ? "**confirmed**" : "first sighting"}: `,
        ) + (entry ? `, since ${entry.firstSeen}` : ""),
      );
    }
  }
  if (temporary.length) {
    lines.push(
      "",
      `**Only temporary redirects to a parent page (${temporary.length}): warnings, never reported**`,
      "",
      ...temporary.slice(0, 20).map((r) => redirectBullet(r)),
    );
    if (temporary.length > 20) {
      lines.push(`- and ${temporary.length - 20} more`);
    }
  }
  if (a.moved.length) {
    lines.push(
      "",
      `**Moved to another page of the same site (${a.moved.length}): not reported${a.moved.length > 20 ? ", first 20" : ""}**`,
      "",
      ...a.moved.slice(0, 20).map((r) => redirectBullet(r)),
    );
  }
  return lines;
}

/** The markdown shown on the run's summary page. */
export function buildSummary({
  counts,
  results,
  tracker,
  reportable,
  today,
  redirects = null,
  redirectReportable = [],
}) {
  const hard = [...results.values()].filter((r) => r.kind !== "warning");
  const warnings = [...results.values()].filter((r) => r.kind === "warning");
  const confirmed = new Set(reportable.map((r) => r.url));
  const answered =
    counts.successful + counts.errors + counts.timeouts + counts.unknown;
  const lines = [
    `## External link check, ${today}`,
    "",
    "| Answered | OK | Failed | Timed out | Dead links this run | Confirmed dead (two runs) | Warnings |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    `| ${answered} | ${counts.successful} | ${counts.errors} | ${counts.timeouts} | ${hard.length} | ${reportable.length} | ${warnings.length} |`,
  ];
  if (hard.length) {
    lines.push("", "### Dead links", "");
    for (const r of hard.slice(0, 100)) {
      const entry = tracker.failing[r.url];
      lines.push(
        `- ${confirmed.has(r.url) ? "**confirmed**" : "first failure"}: ${code(r.url)} (${plain(r.reason, 100)})${entry ? `, since ${entry.firstSeen}` : ""}`,
      );
    }
  }
  if (warnings.length) {
    const byHost = new Map();
    for (const w of warnings) {
      const host = hostOf(w.url);
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
    }
    lines.push(
      "",
      "### Warnings (403, 429, 5xx, timeouts, network errors): not failures, never reported",
      "",
    );
    for (const [host, n] of [...byHost]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)) {
      lines.push(`- ${host}: ${n}`);
    }
    lines.push(
      "",
      "A host that shows up here every week cannot be verified by this check: remove it from `include` in `lychee-external.toml`.",
    );
  }
  if (redirects) {
    lines.push(
      ...buildRedirectSummary({
        redirects,
        tracker,
        confirmed: new Set(redirectReportable.map((r) => r.url)),
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The report command
// ---------------------------------------------------------------------------

/**
 * The "external check failed" issue: ONE issue with a stable title, a comment on it for
 * every further failed run (never a second issue), closed by the next healthy run. Used for
 * a report that cannot be trusted, a corrupt tracker and a crash of the judging itself.
 */
export function raiseCheckFailedIssue(cfg, gh, { enabled, body, reason }) {
  const runNote = cfg.runUrl ? ` ([run](${cfg.runUrl}))` : "";
  return syncIssue({
    gh,
    enabled,
    title: CHECK_FAILED_ISSUE_TITLE,
    label: CHECK_FAILED_ISSUE_LABEL,
    labelColor: "d73a4a",
    labelDescription: "Something isn't working",
    active: true,
    body,
    changeComment: () =>
      `The external link check failed again on ${cfg.today}${runNote}:\n\n${reason}`,
  });
}

/** The `.lycheeignore` patterns of the hub; a file that cannot be read is a note, never a failed check. */
function readLycheeIgnore(cfg) {
  try {
    if (!existsSync(cfg.lycheeIgnoreFile)) return [];
    const { patterns, invalid } = readIgnorePatterns(
      readFileSync(cfg.lycheeIgnoreFile, "utf8"),
    );
    if (invalid.length) {
      annotateRun(
        cfg,
        "warning",
        `${basename(cfg.lycheeIgnoreFile)} has lines that are not valid regular expressions (${invalid.length}); the redirect check skipped them (first: ${invalid[0].slice(0, 80)}).`,
      );
    }
    return patterns;
  } catch (err) {
    annotateRun(
      cfg,
      "warning",
      `${basename(cfg.lycheeIgnoreFile)} could not be read (${plain(err.message, 100)}); the redirect check does not skip any link.`,
    );
    return [];
  }
}

/**
 * The redirect check of one run: analyse the chains of lychee's report and advance the
 * tracker's `redirects`. Returns `{ status, reason, analysis, maxFindings, redirects }` where
 * `redirects` is the tracker's new `redirects` (unchanged when the check is off, has nothing to
 * judge from, or found a flood of candidates).
 */
function judgeRedirects(cfg, report, results, previous) {
  const known = previous.redirects ?? {};
  if (!cfg.redirectCheck) {
    return { status: "off", redirects: known };
  }
  const analysis = analyzeRedirects(report, results, {
    maxFindings: cfg.maxRedirectFindings,
    ignore: readLycheeIgnore(cfg),
    pageOf: (page) => pageFromInput(page, basename(cfg.distDir)),
  });
  return {
    status: !analysis.usable
      ? "unusable"
      : analysis.tooMany
        ? "too-many"
        : "ok",
    reason: analysis.reason,
    analysis,
    maxFindings: cfg.maxRedirectFindings,
    redirects: advanceRedirects(known, analysis, results, cfg.today, cfg),
  };
}

/** What a person should look at after the redirect check: nothing for a quiet run. */
function annotateRedirects(cfg, run) {
  if (run.status === "unusable") {
    annotateRun(
      cfg,
      "warning",
      `The redirect check had nothing to judge from (${run.reason}); what it knew was left as it was.`,
    );
  } else if (run.status === "too-many") {
    const { analysis, maxFindings } = run;
    const hosts = analysis.hosts
      .slice(0, 5)
      .map((h) => `${h.host} (${h.count})`)
      .join(", ");
    annotateRun(
      cfg,
      "warning",
      `${analysis.permanent} links now redirect permanently to a parent page of their own site, more than the limit of ${maxFindings} (MAX_REDIRECT_FINDINGS): none was reported and what the redirect check knew was left as it was. Hosts: ${hosts}.`,
    );
  } else if (run.status === "ok") {
    const temporary = run.analysis.candidates.filter(
      (c) => !c.permanent,
    ).length;
    if (temporary) {
      annotateRun(
        cfg,
        "warning",
        `${temporary} links redirect only temporarily to a parent page of their own site; they are warnings only, never reported (see the job summary).`,
      );
    }
  }
}

/**
 * Judge lychee's report. Returns `{ exitCode, outputs }`; throws when an issue that is
 * needed could not be written (the run fails visibly, the tracker stays as it was).
 */
export function runReport(cfg) {
  const gh = makeGh({ ghCliScript: cfg.ghCliScript });
  const enabled = cfg.createIssues && !cfg.dryRun;
  const runNote = cfg.runUrl ? ` ([run](${cfg.runUrl}))` : "";

  const checkFailed = (reason, hostLines = []) => {
    const body = buildCheckFailedBody({
      reason,
      today: cfg.today,
      runUrl: cfg.runUrl,
      hostLines,
    });
    writeFileSync(cfg.errorFile, `${body}\n`);
    annotateRun(cfg, "error", reason);
    // the job summary names the failing hosts, so the host to remove from `include` is visible
    // without opening the raw lychee log
    appendStepSummary(
      cfg.stepSummary,
      `## External link check failed, ${cfg.today}\n\n${reason}${hostLines.length ? `\n\n${hostLines.join("\n")}` : ""}`,
    );
    raiseCheckFailedIssue(cfg, gh, { enabled, body, reason });
    return {
      exitCode: 1,
      outputs: {
        tracker_updated: false,
        reported_count: 0,
        warning_count: 0,
        check_failed: true,
      },
    };
  };

  // 1. lychee's report, and whether it can be trusted
  if (cfg.lycheeExitCode !== "" && !["0", "2"].includes(cfg.lycheeExitCode)) {
    return checkFailed(
      `lychee itself failed (exit code ${plain(cfg.lycheeExitCode, 10)}; 0 means every link is fine, 2 means some links failed, anything else is a crash or a configuration error). Read the lychee step of the run.`,
    );
  }
  let report;
  try {
    if (!existsSync(cfg.lycheeJson)) {
      throw new Error(
        `lychee wrote no report at ${cfg.lycheeJson}. Read the lychee step of the run.`,
      );
    }
    report = parseLycheeReport(readFileSync(cfg.lycheeJson, "utf8"));
  } catch (err) {
    return checkFailed(err.message);
  }
  const { results, ignored } = collectResults(report);
  const untrustworthy = untrustworthyReason(report, cfg, results);
  if (untrustworthy) {
    return checkFailed(
      untrustworthy,
      describeHostFailures(failuresByHost(results)),
    );
  }

  // 2. the tracker and the confirmed links
  let previous;
  try {
    previous = existsSync(cfg.trackerFile)
      ? parseTracker(readFileSync(cfg.trackerFile, "utf8"))
      : emptyTracker();
  } catch (err) {
    // a corrupt tracker is never reset silently (that would restart every streak), and it
    // must not be a red run that nobody reads either
    return checkFailed(
      `The tracker src/data_files/link-failures.json cannot be read (${plain(err.message, 200)}). It is never reset automatically: restore it from the git history or fix it by hand, then run the Link Checker workflow again.`,
    );
  }
  const advanced = advanceTracker(previous, results, cfg.today, cfg);
  const reportable = reportableEntries(advanced, cfg.reportAfterRuns);
  const redirectRun = judgeRedirects(cfg, report, results, previous);
  const next =
    Object.keys(redirectRun.redirects).length > 0
      ? { ...advanced, redirects: redirectRun.redirects }
      : advanced;
  const redirectReportable = reportableRedirects(next, cfg.reportAfterRuns);
  const issueActive = reportable.length > 0 || redirectReportable.length > 0;

  // 3. the dead-links issue (BEFORE the tracker is written)
  const locations = new Map();
  const pages = new Map();
  if (issueActive) {
    const index = buildSourceIndex(cfg.srcDir, cfg.root);
    for (const entry of [...reportable, ...redirectReportable]) {
      locations.set(entry.url, lookupLocations(index, entry.url));
    }
    for (const entry of reportable) {
      pages.set(
        entry.url,
        [...(results.get(entry.url)?.pages ?? [])].map((p) =>
          pageFromInput(p, basename(cfg.distDir)),
        ),
      );
    }
  }
  const body = issueActive
    ? buildDeadLinksBody(reportable, {
        locations,
        pages,
        redirects: redirectReportable,
      })
    : "";
  if (issueActive) writeFileSync(cfg.reportFile, `${body}\n`);
  const issue = syncIssue({
    gh,
    enabled,
    title: DEAD_LINKS_ISSUE_TITLE,
    label: DEAD_LINKS_ISSUE_LABEL,
    labelColor: "d93f0b",
    labelDescription: "A link on the site no longer works",
    active: issueActive,
    body,
    changeComment: (open) => {
      const change = (listed, now) => {
        const before = new Set(listed);
        const current = new Set(now.map((r) => r.url));
        return {
          added: [...current].filter((u) => !before.has(u)),
          removed: [...before].filter((u) => !current.has(u)),
        };
      };
      const dead = change(extractListedUrls(open.body), reportable);
      const redirecting = change(
        extractListedRedirects(open.body),
        redirectReportable,
      );
      return dead.added.length ||
        dead.removed.length ||
        redirecting.added.length ||
        redirecting.removed.length
        ? buildChangeComment({
            ...dead,
            addedRedirects: redirecting.added,
            removedRedirects: redirecting.removed,
            today: cfg.today,
            runUrl: cfg.runUrl,
          })
        : null;
    },
    closeComment: buildCloseComment({ today: cfg.today, runUrl: cfg.runUrl }),
  });
  if (issue.error) {
    annotateRun(
      cfg,
      "warning",
      `Could not close the dead-links issue (${issue.error}); the next run tries again.`,
    );
  }
  // a healthy run ends the "check failed" alert
  const recovered = syncIssue({
    gh,
    enabled,
    title: CHECK_FAILED_ISSUE_TITLE,
    label: CHECK_FAILED_ISSUE_LABEL,
    active: false,
    closeComment: `The external link check ran normally on ${cfg.today}${runNote}. Closing this issue.`,
  });
  if (recovered.error) {
    annotateRun(
      cfg,
      "warning",
      `Could not close the "check failed" issue (${recovered.error}); the next run tries again.`,
    );
  }

  // 4. the tracker (only when something changed: no churn commits)
  const serialized = serializeTracker(next);
  const stored = existsSync(cfg.trackerFile)
    ? readFileSync(cfg.trackerFile, "utf8")
    : null;
  const trackerUpdated = !cfg.dryRun && serialized !== stored;
  if (trackerUpdated) {
    mkdirSync(dirname(cfg.trackerFile), { recursive: true });
    writeFileSync(cfg.trackerFile, serialized);
  }

  // 5. what a person looking at the run sees
  const warningCount = [...results.values()].filter(
    (r) => r.kind === "warning",
  ).length;
  const summary = buildSummary({
    counts: report.counts,
    results,
    tracker: next,
    reportable,
    today: cfg.today,
    redirects: redirectRun,
    redirectReportable,
  });
  appendStepSummary(cfg.stepSummary, summary);
  console.log(summary);
  if (ignored) {
    console.log(
      `${ignored} failed non-web links were ignored (the internal check owns them).`,
    );
  }
  if (warningCount) {
    annotateRun(
      cfg,
      "warning",
      `${warningCount} links answered with 403, 429, 5xx, a timeout or a network error; they are warnings only (see the job summary).`,
    );
  }
  annotateRedirects(cfg, redirectRun);
  if (cfg.dryRun && issueActive) {
    console.log(`DRY_RUN: the issue would say:\n\n${body}\n`);
  }
  console.log(
    `Issue "${DEAD_LINKS_ISSUE_TITLE}": ${issue.action}${issue.number ? ` (#${issue.number})` : ""}; tracker ${trackerUpdated ? "updated" : "unchanged"}`,
  );
  return {
    exitCode: 0,
    outputs: {
      tracker_updated: trackerUpdated,
      reported_count: reportable.length + redirectReportable.length,
      warning_count: warningCount,
      check_failed: false,
    },
  };
}

// ---------------------------------------------------------------------------
// list / check: the lychee-free runner for a local run
// ---------------------------------------------------------------------------

/** The strings of the top-level `include` array of lychee-external.toml (TOML literal or basic strings). */
export function readIncludePatterns(tomlText) {
  const start = tomlText.search(/^include\s*=\s*\[/m);
  if (start < 0) {
    throw new Error("No `include = [` array found in the lychee config");
  }
  const patterns = [];
  for (let i = tomlText.indexOf("[", start) + 1; i < tomlText.length; i++) {
    const c = tomlText[i];
    if (c === "]") return patterns;
    if (c === "#") {
      while (i < tomlText.length && tomlText[i] !== "\n") i++;
    } else if (c === "'") {
      const end = tomlText.indexOf("'", i + 1);
      if (end < 0) break;
      patterns.push(tomlText.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let end = i + 1;
      while (end < tomlText.length && tomlText[end] !== '"') {
        end += tomlText[end] === "\\" ? 2 : 1;
      }
      patterns.push(JSON.parse(tomlText.slice(i, end + 1)));
      i = end;
    }
  }
  throw new Error("The `include` array of the lychee config is not closed");
}

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Every http(s) link in the built pages that the allowlist selects, as lychee would see
 * it: `Map<normalised URL, Set<page file relative to the repo, e.g. dist/certs/x/index.html>>`.
 * The fragment is dropped (it is never sent to the server).
 */
export function collectDistLinks(
  distDir,
  includePatterns,
  root = dirname(distDir),
) {
  const include = includePatterns.map((p) => new RegExp(p));
  const links = new Map();
  for (const path of walkFiles(distDir)) {
    if (!path.toLowerCase().endsWith(".html")) continue;
    const page = relative(root, path).split("\\").join("/");
    const html = readFileSync(path, "utf8");
    for (const m of html.matchAll(
      /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
    )) {
      const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
      if (!/^https?:\/\//i.test(raw)) continue;
      let href;
      try {
        const url = new URL(raw);
        url.hash = "";
        href = url.href;
      } catch {
        continue;
      }
      if (!include.some((re) => re.test(href))) continue;
      if (!links.has(href)) links.set(href, new Set());
      links.get(href).add(page);
    }
  }
  return links;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** lychee's own limit (`max_redirects`): a longer chain is a loop. */
const MAX_REDIRECT_HOPS = 10;

/**
 * One link, followed hop by hop (`redirect: "manual"`) so that the chain is known, like lychee's
 * `redirect_map`: for every hop the address it led to and the status of the response that
 * redirected there. One timeout covers the whole chain. `tooMany` is set after MAX_REDIRECT_HOPS.
 */
async function requestChain(url, options) {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const hops = [];
  let current = url;
  for (;;) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": options.userAgent, accept: "text/html,*/*" },
      signal,
    });
    await res.body?.cancel();
    const location = REDIRECT_STATUSES.has(res.status)
      ? res.headers.get("location")
      : null;
    let target = null;
    try {
      if (location) target = new URL(location, current).href;
    } catch {
      // a Location that is no address: the redirect status itself is the answer
    }
    if (!target) return { res, hops, tooMany: false };
    if (hops.length >= MAX_REDIRECT_HOPS) return { res, hops, tooMany: true };
    hops.push({ url: target, code: res.status });
    current = target;
  }
}

/** One link, with retries for what may pass: network errors, timeouts, 429 and 5xx. */
async function fetchStatus(url, options) {
  let last;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) await sleep(options.retryWaitMs);
    try {
      const { res, hops, tooMany } = await requestChain(url, options);
      if (tooMany) {
        return {
          status: {
            text: "Network error: Too many redirects - check for redirect loops",
            details: "Too many redirects",
          },
        };
      }
      if (res.ok) return { ok: true, redirects: hops };
      last = {
        status: {
          text: `Rejected status code: ${res.status} ${STATUS_CODES[res.status] ?? "Unknown status code"}`,
          code: res.status,
        },
      };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (err) {
      const cause = String(
        err?.cause?.code ?? err?.cause?.message ?? err?.message,
      );
      let text = `Network error: ${cause}`;
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        last = {
          timedOut: true,
          status: { text: "Timeout", details: "Request timed out" },
        };
        continue;
      }
      if (/ENOTFOUND|EAI_AGAIN/.test(cause)) {
        text = "Network error: DNS resolution failed - check hostname spelling";
      } else if (/ECONNREFUSED/.test(cause)) {
        text =
          "Network error: Connection refused - server may be down or port blocked";
      } else if (/CERT|SSL|TLS/i.test(cause)) {
        text =
          "Network error: SSL certificate error. Check certificate validity";
      }
      last = { status: { text, details: cause } };
    }
  }
  return last;
}

/**
 * Check the selected links with fetch(): one lane per host (a pause between two requests
 * to the same host), hosts in parallel. Returns a report in lychee's JSON shape.
 */
export async function checkLinks(links, options) {
  const started = Date.now();
  const byHost = new Map();
  for (const url of links.keys()) {
    const host = new URL(url).host;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(url);
  }
  const answers = new Map();
  await Promise.all(
    [...byHost.values()].map(async (urls) => {
      for (const [i, url] of urls.entries()) {
        if (i > 0) await sleep(options.delayMs);
        answers.set(url, await fetchStatus(url, options));
      }
    }),
  );
  const report = {
    total: 0,
    unique: links.size,
    successful: 0,
    unknown: 0,
    unsupported: 0,
    timeouts: 0,
    redirects: 0,
    remaps: 0,
    excludes: 0,
    errors: 0,
    cached: 0,
    success_map: {},
    error_map: {},
    timeout_map: {},
    suggestion_map: {},
    redirect_map: {},
    excluded_map: {},
    duration: { secs: Math.round((Date.now() - started) / 1000), nanos: 0 },
    detailed_stats: true,
    runner: "scripts/link-failures.mjs check (fetch, not lychee)",
  };
  for (const [url, pages] of links) {
    const answer = answers.get(url);
    for (const page of pages) {
      report.total++;
      if (answer.ok) {
        report.successful++;
        const hops = answer.redirects ?? [];
        (report.success_map[page] ??= []).push({
          url,
          status: { text: "200 OK", code: 200 },
          ...(hops.length > 0
            ? { redirects: { origin: url, redirects: hops } }
            : {}),
          span: { line: 0, column: 0 },
        });
        if (hops.length > 0) {
          report.redirects++;
          (report.redirect_map[page] ??= []).push({
            origin: url,
            redirects: hops,
          });
        }
        continue;
      }
      if (answer.timedOut) report.timeouts++;
      else report.errors++;
      const map = answer.timedOut ? report.timeout_map : report.error_map;
      (map[page] ??= []).push({
        url,
        status: answer.status,
        span: { line: 0, column: 0 },
      });
    }
  }
  return report;
}

async function runCheckCommand(cfg, e, listOnly) {
  if (!existsSync(cfg.distDir)) {
    throw new Error(`${cfg.distDir} does not exist: run \`pnpm build\` first`);
  }
  const patterns = e.INCLUDE_PATTERNS
    ? JSON.parse(e.INCLUDE_PATTERNS)
    : readIncludePatterns(readFileSync(cfg.configFile, "utf8"));
  const links = collectDistLinks(cfg.distDir, patterns, cfg.root);
  const hosts = new Map();
  for (const url of links.keys()) {
    const host = new URL(url).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  console.log(
    `${links.size} links on ${hosts.size} host${hosts.size === 1 ? "" : "s"} selected by the allowlist:`,
  );
  for (const [host, n] of [...hosts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${host}`);
  }
  if (listOnly) {
    for (const url of links.keys()) console.log(url);
    return;
  }
  const num = (value, fallback) =>
    value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;
  const report = await checkLinks(links, {
    delayMs: num(e.FETCH_DELAY_MS, 500),
    timeoutMs: num(e.CHECK_TIMEOUT_MS, 20_000),
    retries: num(e.CHECK_RETRIES, 2),
    retryWaitMs: num(e.CHECK_RETRY_WAIT_MS, 2000),
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 msfthub-link-checker",
  });
  mkdirSync(dirname(cfg.lycheeJson), { recursive: true });
  writeFileSync(cfg.lycheeJson, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Checked ${report.total} links: ${report.successful} fine, ${report.errors} failed, ${report.timeouts} timed out. Report: ${cfg.lycheeJson}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv, e = process.env) {
  const cfg = loadConfig(e);
  const command = argv[0] ?? "report";
  if (command === "list" || command === "check") {
    await runCheckCommand(cfg, e, command === "list");
    return 0;
  }
  if (command !== "report") {
    console.error(`Unknown command "${command}" (report, list or check)`);
    return 2;
  }
  const { exitCode, outputs } = runReport(cfg);
  writeOutput(cfg.githubOutput, outputs);
  return exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2), process.env).then(
    (exitCode) => process.exit(exitCode),
    (err) => {
      const msg = `The link failure check failed: ${err.stack ?? err.message}\n`;
      try {
        const cfg = loadConfig(process.env);
        writeFileSync(cfg.errorFile, msg);
        writeOutput(cfg.githubOutput, {
          tracker_updated: false,
          reported_count: 0,
          warning_count: 0,
          check_failed: true,
        });
        // A crash of the judging itself (a failed issue step, a bug) is a red run that
        // nobody reads: say so in the "external check failed" issue as well. If gh is the
        // thing that crashed, this fails too, and the red run is all that is left.
        try {
          const reason = `The judging step crashed: ${plain(err.message, 300)}. No link was judged and the tracker was not written. Read the "Judge the report and update the issue" step of the run.`;
          raiseCheckFailedIssue(cfg, makeGh({ ghCliScript: cfg.ghCliScript }), {
            enabled: cfg.createIssues && !cfg.dryRun,
            body: buildCheckFailedBody({
              reason,
              today: cfg.today,
              runUrl: cfg.runUrl,
            }),
            reason,
          });
        } catch {
          /* no issue could be written either */
        }
      } catch {
        /* ignore */
      }
      console.error(msg);
      process.exit(1);
    },
  );
}
