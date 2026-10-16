#!/usr/bin/env node
/**
 * Daily Retiring Exam Monitor: finds retirements on Microsoft Learn and
 * notifies once a tracked retirement has passed.
 *
 * Usage:
 *   node scripts/retiring-exam-check.mjs
 *
 * Before this version the monitor only did date math on retiring-exams.json,
 * which a person types in by hand, so it could never learn about a retirement.
 * It now reads the two pages where Microsoft Learn publishes them:
 *
 *   https://learn.microsoft.com/en-us/credentials/support/retired-certification-exams
 *       "Exams scheduled to retire" (exam number, name, date), "Recently retired
 *       exams", and the Applied Skills assessment lab sections
 *   https://learn.microsoft.com/en-us/credentials/support/credential-retirement
 *       "Certifications scheduled to retire", "Recently retired Certifications"
 *       and the Applied Skills credential sections
 *
 * and keeps three kinds of alert (details under "Issues"):
 *
 *   1. Findings, from comparing Learn's rows with the hub. A row concerns the hub
 *      when it names an exam that has a hub page (src/content/docs/<area>/<CODE>.mdx)
 *      or is tracked, when a certification row maps to such an exam (through the
 *      slug in the exam rows' links, the optional learn-exams.json tracker or a
 *      certification page the hub links), or when it is an Applied Skill that a
 *      lab page links. A finding is raised when the exam is NOT tracked in
 *      retiring-exams.json with the date Learn gives, when Learn dropped a
 *      tracked, still future retirement from its schedule, when exam-status.mjs
 *      says RETIRING or RETIRED for an exam the tracker does not know, and when a lab page
 *      links an Applied Skill that Learn lists as retiring or retired. Rows that do
 *      not concern the hub are only recorded.
 *   2. Two notifications for a tracked retirement, each sent exactly once. One ON the
 *      retirement day itself ("Exam retires today"; the exam is still RETIRING that
 *      day). One AFTER the date (yesterday UTC or earlier), only when Microsoft
 *      Learn's tables list the exam as retired and the hub does not show RETIRED
 *      yet; an exam the hub already switched is marked as notified without an issue,
 *      and one Learn does not list as retired yet waits until it does. There is
 *      deliberately no reminder before the date: the issue on the day is the one
 *      that matters.
 *   3. An informational announcement for a certification row that appeared (or
 *      changed date) as "scheduled to retire" and that no reliable mapping ties to
 *      an exam (the row has no exam code and its certification address is not the
 *      one an exam row, a hub exam page or the Learn exam tracker links to an exam).
 *      Reported once; nothing is announced on the first run.
 *
 * Trackers (this script is the only writer):
 *   src/data_files/retiring-exams.json     the hand-kept list; the script sets
 *                                          `notifiedOnDay`, `notifiedOnDayAt`,
 *                                          `notified` and `notifiedAt`
 *   src/data_files/retirement-schedule.json  { lastSynced, format, failures, reported, rows }
 *       format    SCHEDULE_FORMAT, the version of what the rows were extracted with
 *       rows      every parsed Learn row { source, kind, status, code?, slug?, name,
 *                 date } (and nothing else from the pages), sorted so that Learn
 *                 re-ordering a table never causes a commit
 *       failures  per page the number of consecutive days it could not be read
 *       reported  the findings already reported (signature and dates), which is
 *                 what stops a repeat and what schedules a weekly reminder
 *   The file is rewritten only when something other than `lastSynced` changed.
 *
 * Rules applied every run:
 *   - A fetch failure is never evidence. A page that cannot be fetched, is not an
 *     article, lacks a required section or looks restructured (more than
 *     MAX_ROW_CHANGES rows and MAX_ROW_CHANGE_PCT of its rows changing at once, or
 *     more than half of its current rows disappearing, for a page with at least 10
 *     of them; rows dated more than 12 months ago leaving do not count, Learn
 *     drops those as housekeeping, and neither does an exam moving from "scheduled"
 *     to "recently retired", however many make the move on one day, unless its
 *     date changed too) keeps the rows of
 *     the previous run and only warns. A page with an unrecognised retirement table or a row it cannot
 *     read still contributes the rows it did read, and counts as a problem.
 *   - A page with a problem on FAILING_RUNS (3) different days in a row raises the
 *     issue "Microsoft Learn retirement pages cannot be read" (per page, not only
 *     when both pages fail: one blind page is a blind spot), commented on every
 *     further day and closed when both pages read cleanly again.
 *   - The first run (no retirement-schedule.json) records every row silently, but
 *     the findings it makes are actionable facts and are reported at once.
 *   - A schedule written in another `format` (a file from before the field has
 *     none) is re-baselined silently: its rows are compared with nothing, so a
 *     change of the extraction announces no row, flags no vanished retirement and
 *     trips no failsafe; the findings, the failure counters and the reported
 *     findings carry on as they were.
 *   - Rows that roll off "Recently retired" after 12 months, rows of exams the hub
 *     does not cover and the lifecycle move from "scheduled" to "recently retired"
 *     never alert.
 *   - The date arithmetic is whole UTC days. "Retired" keeps the old cut-off:
 *     retirementDate is yesterday (UTC) or earlier, so a missed run never skips it.
 *
 * Issues (only with CREATE_ISSUES=1 and not DRY_RUN=1; the gh CLI, GH_TOKEN). They
 * are made inside this script BEFORE the trackers are written, so a failed issue
 * fails the run, the workflow's commit step is skipped, main keeps the old
 * trackers and the next run reports the same things again (a duplicate beats a
 * lost alert):
 *   - "Exam retirement schedule: hub does not match Microsoft Learn" (enhancement):
 *     ONE running issue for the findings, created with the report, a comment for
 *     every later report, closed with a comment when no finding is left.
 *   - "Exam retires today: <codes>" (enhancement): one issue per day with the
 *     exams whose retirement date is today (`notifiedOnDay` is set, once).
 *   - "Exam retirement notification: <codes>" (enhancement): one issue per day
 *     with the exams that passed their date, are listed as retired on Learn and
 *     are not RETIRED on the hub yet (`notified` is set, once).
 *   - "Microsoft Learn announced a retirement: <names>" (enhancement): one issue per
 *     day with the new rows no exam could be mapped to (alert 3 above).
 *   - "Retiring Exam Monitor: Microsoft Learn retirement pages cannot be read" and
 *     "Retiring Exam Monitor: the check failed" (bug): one issue each, a comment
 *     for every further failing day instead of an issue per run, closed after a
 *     healthy run. The second one covers a corrupt tracker or unreadable repo file.
 *
 * Env overrides (defaults shown):
 *   EXAMS_FILE            src/data_files/retiring-exams.json
 *   SCHEDULE_FILE         src/data_files/retirement-schedule.json
 *   DOCS_DIR              src/content/docs
 *   EXAM_STATUS_FILE      src/data_files/exam-status.mjs
 *   LEARN_EXAMS_FILE      src/data_files/learn-exams.json  (optional)
 *   LEARN_BASE_URL        https://learn.microsoft.com
 *   TODAY                 YYYY-MM-DD, default today (UTC)
 *   FETCH_DELAY_MS        1000    pause between the two page requests
 *   FETCH_ATTEMPTS        3
 *   RETRY_BASE_MS         2000
 *   MAX_RETRY_AFTER_MS    60000
 *   FETCH_TIMEOUT_MS      30000
 *   MAX_ROW_CHANGES       20      failsafe: rows of one page changing at once ...
 *   MAX_ROW_CHANGE_PCT    50      ... and this share of its previous rows
 *   FAILING_RUNS          3       days in a row before the "cannot be read" issue
 *   REMINDER_DAYS         7       how often an unresolved finding is reported again
 *   FORCE_BASELINE        1 records the rows of both pages as they are (skips the
 *                         restructured-page failsafe and announces no new row, there
 *                         is no "since" to compare with); findings are still reported
 *   REPORT_FILE           <tmpdir>/retiring-exam-report.md
 *   ERROR_FILE            <tmpdir>/retiring-exam-error.md
 *   GITHUB_OUTPUT         <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY   (unset)  appended with a short summary of the run
 *   CREATE_ISSUES         0   1 = create, comment on and close the issues with the gh CLI
 *   DRY_RUN               0   1 = touch no issue (the report and trackers are still written)
 *   GH_TOKEN / GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID   gh CLI and run links
 *   GH_CLI_SCRIPT         (unset)  tests only: run this Node script instead of the gh CLI
 *
 * Writes GITHUB_OUTPUT keys: changes_found (an alert was produced),
 * baseline_updated (a tracker file changed), extraction_failed, issue_title.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { appendStepSummary, warnLoud, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

export { retryDelayMs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * The version of what parseRetirementPage, classifyHeading and storedRow turn a
 * page into. Bump it when they change: a schedule written in another format is
 * re-baselined silently instead of showing the change of the extraction as news.
 */
export const SCHEDULE_FORMAT = 1;

/** Learn lists a retirement for 12 months; a row older than this is expected to leave. */
export const ROLL_OFF_DAYS = 366;

/** Where Learn publishes retirements. `required` sections must exist or the page is unreadable. */
export const PAGES = [
  {
    id: "exams",
    title: "Exam and assessment lab retirement",
    path: "/en-us/credentials/support/retired-certification-exams",
    required: [
      { kind: "exam", status: "scheduled" },
      { kind: "exam", status: "retired" },
    ],
  },
  {
    id: "credentials",
    title: "Credential retirement",
    path: "/en-us/credentials/support/credential-retirement",
    required: [
      { kind: "certification", status: "scheduled" },
      { kind: "certification", status: "retired" },
    ],
  },
];

/** What the production pages are called in an issue, whatever LEARN_BASE_URL is. */
const LEARN_PUBLIC_URL = "https://learn.microsoft.com";

/** The running issue for the findings (the state: Learn versus the hub). */
export const FINDINGS_ISSUE_TITLE =
  "Exam retirement schedule: hub does not match Microsoft Learn";
export const FINDINGS_ISSUE_LABEL = "enhancement";
/** The issue that says a Learn page cannot be read. */
export const PAGES_ISSUE_TITLE =
  "Retiring Exam Monitor: Microsoft Learn retirement pages cannot be read";
/** The issue that says the check itself could not run. */
export const FAILED_ISSUE_TITLE = "Retiring Exam Monitor: the check failed";
export const BUG_LABEL = "bug";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function loadConfig(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const today = isRealIsoDate(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    examsFile: resolveFromRoot(
      env.EXAMS_FILE ?? "src/data_files/retiring-exams.json",
    ),
    scheduleFile: resolveFromRoot(
      env.SCHEDULE_FILE ?? "src/data_files/retirement-schedule.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? "src/content/docs"),
    examStatusFile: resolveFromRoot(
      env.EXAM_STATUS_FILE ?? "src/data_files/exam-status.mjs",
    ),
    learnExamsFile: resolveFromRoot(
      env.LEARN_EXAMS_FILE ?? "src/data_files/learn-exams.json",
    ),
    learnBaseUrl: (env.LEARN_BASE_URL || LEARN_PUBLIC_URL).replace(/\/+$/, ""),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "retiring-exam-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "retiring-exam-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    summaryFile: env.GITHUB_STEP_SUMMARY || "",
    fetchDelayMs: num("FETCH_DELAY_MS", 1000),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 2000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    maxRowChanges: num("MAX_ROW_CHANGES", 20),
    maxRowChangePct: num("MAX_ROW_CHANGE_PCT", 50),
    failingRuns: Math.max(1, num("FAILING_RUNS", 3)),
    reminderDays: num("REMINDER_DAYS", 7),
    forceBaseline: env.FORCE_BASELINE === "1",
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    today,
    // tests only: an injected fetch
    fetchImpl: null,
  };
}

/** A failure of the check itself (not a finding). */
export class CheckError extends Error {}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** True for YYYY-MM-DD that is a real calendar day (not a rolled-over 2026-02-31). */
export function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysBetween(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  );
}

/** The day before `iso`, as YYYY-MM-DD. */
export function dayBefore(iso) {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// The retirement badges of exam-status.mjs
// ---------------------------------------------------------------------------

/** RETIRING until the retirement date has passed, RETIRED after it. */
export const RETIREMENT_BADGES = {
  RETIRING: { text: "RETIRING", variant: "danger" },
  RETIRED: { text: "RETIRED", variant: "note" },
};

/** Does the exam-status.mjs badge belong to a retirement (RETIRING or RETIRED)? */
export const isRetirementBadge = (badge) =>
  Object.hasOwn(RETIREMENT_BADGES, badge?.text);

/**
 * The badge an exam should carry for a retirement date: RETIRED once the date is
 * before today (UTC), the same cut-off as the notification after the date and as
 * the RetirementBanner component, RETIRING before that (also on the day itself).
 */
export function expectedBadgeText(dateIso, today) {
  return isRealIsoDate(dateIso) && daysBetween(today, dateIso) < 0
    ? "RETIRED"
    : "RETIRING";
}

/** The badge as the line to put into exam-status.mjs: { text: "RETIRED", variant: "note" }. */
export const badgeSnippet = (text) =>
  `{ text: "${text}", variant: "${RETIREMENT_BADGES[text].variant}" }`;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthNumber(word) {
  const lower = word.toLowerCase().replace(/\.$/, "");
  if (lower.length < 3) return null;
  const index = MONTH_NAMES.findIndex((name) =>
    name.toLowerCase().startsWith(lower),
  );
  return index === -1 ? null : index + 1;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Learn's date text ("November 30, 2026", "June 01, 2026", "30 November 2026",
 * "2026-11-30") as YYYY-MM-DD, or null when it is not one real calendar day.
 */
export function parseLearnDate(text) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let year;
  let month;
  let day;
  let match;
  if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    [, year, month, day] = match;
  } else if (
    (match = value.match(
      /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/,
    ))
  ) {
    month = monthNumber(match[1]);
    day = match[2];
    year = match[3];
  } else if (
    (match = value.match(
      /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?,? (\d{4})$/,
    ))
  ) {
    day = match[1];
    month = monthNumber(match[2]);
    year = match[3];
  } else {
    return null;
  }
  if (!month) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return isRealIsoDate(iso) ? iso : null;
}

/** YYYY-MM-DD as "November 30, 2026", the way the repo writes dates. */
export function formatLongDate(iso) {
  if (!isRealIsoDate(iso)) return String(iso);
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

// ---------------------------------------------------------------------------
// HTML helpers (Learn pages are server rendered, the tables are plain <table>s)
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  shy: "",
  zwnj: "",
  zwj: "",
};

function safeCodePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : "";
}

export function decodeEntities(str) {
  return String(str).replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,
    (whole, dec, hex, name) => {
      if (dec !== undefined) return safeCodePoint(Number(dec));
      if (hex !== undefined) return safeCodePoint(parseInt(hex, 16));
      const key = name.toLowerCase();
      // hasOwn: "&constructor;" must stay text
      return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : whole;
    },
  );
}

const INVISIBLE = /[­​-‍⁠﻿]/g;

/** The text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripNonContent(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
}

/** The inner HTML of <main> (comments, scripts and styles removed), or null. */
export function extractMain(html) {
  const match = stripNonContent(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : null;
}

function firstHref(html) {
  const match = String(html).match(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  );
  return match ? decodeEntities(match[1] ?? match[2]) : "";
}

// ---------------------------------------------------------------------------
// The retirement tables
// ---------------------------------------------------------------------------

export const KINDS = ["exam", "certification", "applied-skill"];
export const STATUSES = ["scheduled", "retired"];

const SECTION_LABELS = {
  "exam:scheduled": "Exams scheduled to retire",
  "exam:retired": "Recently retired exams",
  "certification:scheduled": "Certifications scheduled to retire",
  "certification:retired": "Recently retired Certifications",
  "applied-skill:scheduled": "Applied Skills scheduled to retire",
  "applied-skill:retired": "Recently retired Applied Skills",
};

export const sectionLabel = (kind, status) =>
  SECTION_LABELS[`${kind}:${status}`] ?? `${kind} ${status}`;

/**
 * Which table a heading introduces: { kind, status } or null. Only headings of the
 * form "<things> scheduled to retire" and "Recently retired <things>" count, so
 * the explanatory sections ("Why exams ... are retired") never turn into tables.
 */
export function classifyHeading(text) {
  const t = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  let status = null;
  if (/scheduled (?:to|for) (?:be )?retire|upcoming retirements?/.test(t)) {
    status = "scheduled";
  } else if (/^recently retired\b|\bretired (?:within|more than)\b/.test(t)) {
    status = "retired";
  }
  if (!status) return null;
  let kind = null;
  if (/applied skill|assessment lab/.test(t)) kind = "applied-skill";
  else if (/certification/.test(t)) kind = "certification";
  else if (/\bexams?\b/.test(t)) kind = "exam";
  return kind ? { kind, status } : null;
}

const EXAM_CODE = /\b((?:[A-Z]{2,3}|\d{2})-\d{3}[A-Z]?)\b/g;
const NON_SLUGS = new Set(["exams", "resources", "browse", "support"]);

function slugFromHref(href) {
  const match = String(href).match(
    /\/credentials\/(?:certifications|applied-skills)\/([a-z0-9][a-z0-9-]*)/i,
  );
  if (!match) return "";
  const slug = match[1].toLowerCase();
  return NON_SLUGS.has(slug) ? "" : slug;
}

function mapColumns(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const date = lower.findIndex((h) => /retirement date/.test(h));
  const fallbackDate = lower.findIndex((h) => /retire|date/.test(h));
  const dateIndex = date !== -1 ? date : fallbackDate;
  const code = lower.findIndex((h) => /\b(?:number|code)\b/.test(h));
  let name = lower.findIndex(
    (h, i) => i !== dateIndex && i !== code && /\bname\b/.test(h),
  );
  if (name === -1) {
    name = lower.findIndex((_, i) => i !== dateIndex && i !== code);
  }
  return dateIndex === -1 || name === -1
    ? null
    : { date: dateIndex, code, name };
}

/** One <table> as { headers: [text], rows: [[{ text, href }]] }. */
export function parseTable(tableHtml) {
  const trs = [...String(tableHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const cellsOf = (inner) =>
    [...inner.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({
      tag: m[1].toLowerCase(),
      text: htmlToText(m[2]),
      href: firstHref(m[2]),
    }));
  const all = trs.map((m) => cellsOf(m[1])).filter((cells) => cells.length > 0);
  if (all.length === 0) return { headers: [], rows: [] };
  return {
    headers: all[0].map((cell) => cell.text),
    rows: all.slice(1),
  };
}

/**
 * The rows of one section's table. `problems` collects what could not be read
 * (the rows that could are still returned).
 */
function rowsFromTable(table, section, problems) {
  const columns = mapColumns(table.headers);
  if (!columns) {
    problems.push(
      `a table in "${sectionLabel(section.kind, section.status)}" has no retirement date column (headers: ${table.headers.join(" | ") || "none"})`,
    );
    return [];
  }
  const needed = Math.max(columns.date, columns.name, columns.code);
  const rows = [];
  for (const cells of table.rows) {
    if (cells.length <= needed) {
      problems.push(
        `a row of "${sectionLabel(section.kind, section.status)}" has ${cells.length} cells, expected ${needed + 1}`,
      );
      continue;
    }
    const nameCell = cells[columns.name];
    const dateCell = cells[columns.date];
    const codeCell = columns.code === -1 ? null : cells[columns.code];
    const codes = [];
    for (const source of [
      codeCell?.text,
      section.kind === "exam" ? nameCell.text : "",
    ]) {
      for (const match of String(source ?? "").matchAll(EXAM_CODE)) {
        if (!codes.includes(match[1])) codes.push(match[1]);
      }
      if (codes.length > 0) break;
    }
    const slug =
      slugFromHref(codeCell?.href ?? "") || slugFromHref(nameCell.href);
    const date = parseLearnDate(dateCell.text);
    if (!nameCell.text && codes.length === 0) {
      problems.push(
        `a row of "${sectionLabel(section.kind, section.status)}" has no name`,
      );
      continue;
    }
    if (date === null) {
      problems.push(
        `"${nameCell.text || codes.join(", ")}" in "${sectionLabel(section.kind, section.status)}" has a date that is not one calendar day: "${dateCell.text}"`,
      );
    }
    for (const code of codes.length > 0 ? codes : [null]) {
      rows.push({
        kind: section.kind,
        status: section.status,
        code,
        slug,
        name: nameCell.text,
        date,
        dateText: dateCell.text,
      });
    }
  }
  return rows;
}

/**
 * Reads one Learn retirement page. Returns { rows, problems, fatal, updatedAt }:
 * `fatal` says the page cannot be trusted at all (not an article, a required
 * section missing), `problems` what was not understood while the rest was read.
 */
export function parseRetirementPage(html, page) {
  const fatal = [];
  const problems = [];
  const rows = [];
  const updatedAt =
    String(html).match(
      /<meta\s+name=["']updated_at["']\s+content=["']([^"']+)["']/i,
    )?.[1] ?? "";

  const main = extractMain(html);
  if (main === null) {
    return {
      rows,
      problems,
      fatal: ["the page has no <main> article (a bot-check or error page?)"],
      updatedAt,
    };
  }

  const found = new Set();
  let section = null;
  let lastHeading = "";
  const token =
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>|<table\b[\s\S]*?<\/table>/gi;
  for (const match of main.matchAll(token)) {
    if (match[1]) {
      const level = Number(match[1]);
      const text = htmlToText(match[2]);
      if (!text) continue;
      lastHeading = text;
      const classified = classifyHeading(text);
      if (classified) {
        section = classified;
        found.add(`${classified.kind}:${classified.status}`);
      } else if (level <= 2) {
        section = null;
      }
      continue;
    }
    const table = parseTable(match[0]);
    if (section) {
      rows.push(...rowsFromTable(table, section, problems));
    } else if (table.headers.some((h) => /retirement date/i.test(h))) {
      problems.push(
        `a table with a retirement date column sits under "${lastHeading}", which is not a section this monitor knows`,
      );
    }
  }

  for (const need of page.required) {
    if (!found.has(`${need.kind}:${need.status}`)) {
      fatal.push(
        `the section "${sectionLabel(need.kind, need.status)}" was not found`,
      );
    }
  }
  return { rows, problems, fatal, updatedAt };
}

// ---------------------------------------------------------------------------
// Rows: identity, storage, differences
// ---------------------------------------------------------------------------

const normalizeName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// What a row is about once its status is left out: the exam code, else the
// address of its Learn page, else its name. An empty code or address is none
// (the parser leaves "" and null where a stored row has no key at all), so a
// row has the same identity whether it was just parsed or read back from the file.
const subjectOf = (row) => row.code || row.slug || normalizeName(row.name);

/** The key a row keeps while its date or display name changes. */
export const rowIdentity = (row) =>
  [row.source, row.kind, row.status, subjectOf(row)].join("|");

const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The row as it is kept in retirement-schedule.json (key order is part of the format). */
export function storedRow(source, row) {
  const out = { source, kind: row.kind, status: row.status };
  if (row.code) out.code = row.code;
  if (row.slug) out.slug = row.slug;
  out.name = row.name;
  out.date = row.date ?? null;
  if (row.date === null || row.date === undefined) {
    out.date = null;
    out.dateText = row.dateText ?? "";
  }
  return out;
}

export function sortRows(rows) {
  return [...rows].sort(
    (a, b) =>
      byText(a.source, b.source) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      byText(a.date ?? "", b.date ?? "") ||
      byText(a.code ?? a.slug ?? a.name, b.code ?? b.slug ?? b.name) ||
      byText(a.name, b.name),
  );
}

/** What changed between two row lists of ONE source. */
export function diffRows(before, after) {
  const prev = new Map(before.map((row) => [rowIdentity(row), row]));
  const next = new Map(after.map((row) => [rowIdentity(row), row]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, row] of next) {
    const old = prev.get(key);
    if (!old) added.push(row);
    else if (old.date !== row.date) changed.push({ before: old, after: row });
  }
  for (const [key, row] of prev) if (!next.has(key)) removed.push(row);
  return { added, removed, changed };
}

/**
 * diffRows for the failsafe: a row that only moved between the "scheduled" and the
 * "recently retired" table (same source, kind and code, address or name) is the
 * same row, not a removal plus an addition. It counts as changed only when its
 * date differs too. The lifecycle move never alerts, however many exams make it on
 * the same day.
 */
export function diffRowsIgnoringStatus(before, after) {
  const { added, removed, changed } = diffRows(before, after);
  const keyOf = (row) => [row.source, row.kind, subjectOf(row)].join("|");
  const arrived = new Map();
  for (const row of added) {
    if (!arrived.has(keyOf(row))) arrived.set(keyOf(row), []);
    arrived.get(keyOf(row)).push(row);
  }
  const gone = [];
  const moved = [];
  for (const old of removed) {
    const row = arrived.get(keyOf(old))?.shift();
    if (!row) gone.push(old);
    else if (old.date !== row.date) moved.push({ before: old, after: row });
  }
  return {
    added: [...arrived.values()].flat(),
    removed: gone,
    changed: [...changed, ...moved],
  };
}

/**
 * The failsafe: a page whose rows changed so much at once that the page changed
 * shape rather than news. Returns the reason, or null.
 */
export function restructuredReason(before, after, cfg) {
  // Learn only keeps a retirement on its pages for 12 months, and the exams page
  // still lists Applied Skills from 2025. A row that old leaving is housekeeping,
  // not a page changing shape, so it counts neither as a removal nor as a row the
  // page was expected to keep. Neither does an exam moving from "scheduled" to
  // "recently retired" (diffRowsIgnoringStatus): on the day a batch of exams retires
  // they all move at once, and that is the lifecycle, not a changed page.
  const rolledOff = (row) =>
    Boolean(cfg.today) &&
    isRealIsoDate(row.date) &&
    daysBetween(row.date, cfg.today) > ROLL_OFF_DAYS;
  const current = before.filter((row) => !rolledOff(row));
  if (current.length === 0) return null;
  const { added, removed, changed } = diffRowsIgnoringStatus(before, after);
  const gone = removed.filter((row) => !rolledOff(row));
  if (current.length >= 10 && gone.length * 2 > current.length) {
    return `${gone.length} of its ${current.length} current rows disappeared at once${added.length > 0 ? ` and ${added.length} new ones appeared` : ""}`;
  }
  const changes = added.length + gone.length + changed.length;
  if (
    changes > cfg.maxRowChanges &&
    (changes * 100) / current.length > cfg.maxRowChangePct
  ) {
    return `${changes} of its ${current.length} rows changed at once (more than ${cfg.maxRowChanges} and ${cfg.maxRowChangePct}%)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trackers
// ---------------------------------------------------------------------------

export function emptySchedule() {
  return {
    lastSynced: null,
    format: SCHEDULE_FORMAT,
    failures: {},
    reported: {},
    rows: [],
  };
}

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Validates a parsed retirement-schedule.json; throws CheckError naming what is wrong. */
export function normalizeSchedule(parsed, label = "retirement-schedule.json") {
  if (!isPlainObject(parsed)) {
    throw new CheckError(`Corrupt ${label} (not a JSON object).`);
  }
  if (!Array.isArray(parsed.rows)) {
    throw new CheckError(`Corrupt ${label} (missing rows array).`);
  }
  const rows = parsed.rows.map((row, i) => {
    if (
      !isPlainObject(row) ||
      !["exams", "credentials"].includes(row.source) ||
      !KINDS.includes(row.kind) ||
      !STATUSES.includes(row.status) ||
      typeof row.name !== "string" ||
      !(row.date === null || isRealIsoDate(row.date))
    ) {
      throw new CheckError(`Corrupt ${label} (row ${i} is not a valid row).`);
    }
    return row;
  });
  const failures = {};
  for (const [id, rec] of Object.entries(parsed.failures ?? {})) {
    if (
      !isPlainObject(rec) ||
      !Number.isInteger(rec.runs) ||
      rec.runs < 1 ||
      !isRealIsoDate(rec.since) ||
      !isRealIsoDate(rec.last)
    ) {
      throw new CheckError(`Corrupt ${label} (failures.${id} is not valid).`);
    }
    failures[id] = { runs: rec.runs, since: rec.since, last: rec.last };
  }
  const reported = {};
  for (const [key, rec] of Object.entries(parsed.reported ?? {})) {
    if (
      !isPlainObject(rec) ||
      typeof rec.signature !== "string" ||
      !isRealIsoDate(rec.firstReported) ||
      !isRealIsoDate(rec.lastReported)
    ) {
      throw new CheckError(`Corrupt ${label} (reported.${key} is not valid).`);
    }
    reported[key] = {
      signature: rec.signature,
      firstReported: rec.firstReported,
      lastReported: rec.lastReported,
    };
  }
  return {
    lastSynced:
      typeof parsed.lastSynced === "string" ? parsed.lastSynced : null,
    // an older file has none: 0 is no format this script ever wrote
    format: Number.isInteger(parsed.format) ? parsed.format : 0,
    failures,
    reported,
    rows: sortRows(rows),
  };
}

/** Reads the schedule tracker; a missing file is the first run, a corrupt one an error. */
export function loadSchedule(file) {
  if (!existsSync(file)) return { schedule: emptySchedule(), existed: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CheckError(
      `Corrupt retirement-schedule.json (invalid JSON) at ${displayPath(file)}.`,
    );
  }
  return { schedule: normalizeSchedule(parsed), existed: true };
}

export function scheduleContent(schedule) {
  return (
    JSON.stringify(
      {
        lastSynced: schedule.lastSynced,
        format: schedule.format,
        failures: schedule.failures,
        reported: schedule.reported,
        rows: schedule.rows,
      },
      null,
      2,
    ) + "\n"
  );
}

const displayPath = (file) => {
  const rel = relative(root, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
};

const CODE_ONLY = /^(?:[A-Z]{2,3}|\d{2})-\d{3}[A-Z]?$/;

/** Reads retiring-exams.json (the hand-kept list); throws CheckError when it is unusable. */
export function loadRetiringExams(file) {
  if (!existsSync(file)) {
    throw new CheckError(`Tracker file not found at ${displayPath(file)}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CheckError(
      `Corrupt tracker file at ${displayPath(file)} (invalid JSON).`,
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.exams)) {
    throw new CheckError(
      `Corrupt tracker file at ${displayPath(file)} (missing exams array).`,
    );
  }
  const seen = new Set();
  for (const [i, exam] of parsed.exams.entries()) {
    if (!isPlainObject(exam) || !CODE_ONLY.test(String(exam.code ?? ""))) {
      throw new CheckError(
        `Corrupt tracker file at ${displayPath(file)} (entry ${i} has no valid exam code).`,
      );
    }
    if (!isRealIsoDate(exam.retirementDate)) {
      throw new CheckError(
        `Corrupt tracker file at ${displayPath(file)}: ${exam.code} has retirementDate ${JSON.stringify(exam.retirementDate)}, which is not a real YYYY-MM-DD day (the monitor would never notify for it).`,
      );
    }
    if (seen.has(exam.code)) {
      throw new CheckError(
        `Corrupt tracker file at ${displayPath(file)}: ${exam.code} is listed twice.`,
      );
    }
    seen.add(exam.code);
  }
  return parsed;
}

/** The key order retiring-exams-sync.mjs writes; other keys follow. */
const ENTRY_KEYS = [
  "code",
  "area",
  "name",
  "retirementDate",
  "replacementCode",
  "notifiedOnDay",
  "notifiedOnDayAt",
  "notified",
  "notifiedAt",
];

export function examsContent(tracker) {
  const ordered = (entry) => {
    const out = {};
    for (const key of ENTRY_KEYS) if (key in entry) out[key] = entry[key];
    for (const key of Object.keys(entry))
      if (!(key in out)) out[key] = entry[key];
    return out;
  };
  return (
    JSON.stringify({ ...tracker, exams: tracker.exams.map(ordered) }, null, 2) +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Notifications (retiring-exams.json)
// ---------------------------------------------------------------------------

/**
 * The notification ON the retirement day: every entry whose date is today (UTC) and
 * that nobody was told about yet gets `notifiedOnDay`. An entry whose day was missed
 * (the monitor did not run, or the entry was added late) is not announced here: the
 * follow-up below covers it.
 */
export function selectRetiresToday(exams, today) {
  const retiresToday = [];
  const next = exams.map((entry) => {
    if (
      entry.retirementDate !== today ||
      entry.notifiedOnDay === true ||
      entry.notified === true
    ) {
      return entry;
    }
    const copy = { ...entry, notifiedOnDay: true, notifiedOnDayAt: today };
    retiresToday.push(copy);
    return copy;
  });
  return { retiresToday, exams: next };
}

/**
 * The follow-up after the date (yesterday UTC or earlier, the old cut-off, so a missed
 * run never skips it): an entry that was not notified yet is reported only when
 * Microsoft Learn lists the exam as retired AND the hub does not say RETIRED yet.
 * An exam the hub already switched to RETIRED is marked as notified without an issue,
 * and one Learn does not list as retired yet is left alone until it does.
 * `learnRetired` and `hubRetired` are `(code) => boolean`; without them the old
 * behaviour is kept (every entry past its date is reported).
 */
export function selectRetired(
  exams,
  today,
  { learnRetired = () => true, hubRetired = () => false } = {},
) {
  const cutoff = dayBefore(today);
  const retired = [];
  const quiet = [];
  const next = exams.map((entry) => {
    if (entry.notified === true || entry.retirementDate > cutoff) return entry;
    if (hubRetired(entry.code)) {
      const copy = { ...entry, notified: true, notifiedAt: today };
      quiet.push(copy);
      return copy;
    }
    if (!learnRetired(entry.code)) return entry;
    const copy = { ...entry, notified: true, notifiedAt: today };
    retired.push(copy);
    return copy;
  });
  return { retired, quiet, exams: next };
}

// ---------------------------------------------------------------------------
// The repository: hub exam pages, badges, banners, lab pages
// ---------------------------------------------------------------------------

function stripMdxComments(text) {
  return String(text)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function frontmatterOf(text) {
  return text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

function listMdx(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMdx(path));
    else if (entry.name.endsWith(".mdx")) out.push(path);
  }
  return out;
}

/** The exam name in the standard description template, or "". */
export function examNameFromDescription(text, code) {
  const frontmatter = frontmatterOf(text);
  const match = frontmatter.match(
    new RegExp(
      `certification exam ${code}:\\s*(.+?)\\.\\s+Contains official`,
      "i",
    ),
  );
  return match ? match[1].trim() : "";
}

let importCounter = 0;

async function loadExamStatuses(file) {
  if (!existsSync(file)) {
    throw new CheckError(`exam-status.mjs not found at ${displayPath(file)}.`);
  }
  try {
    const module = await import(
      `${pathToFileURL(file).href}?v=${++importCounter}`
    );
    if (!isPlainObject(module.examStatuses)) {
      throw new Error("no examStatuses export");
    }
    return module.examStatuses;
  } catch (error) {
    throw new CheckError(`Cannot read ${displayPath(file)}: ${error.message}`);
  }
}

/**
 * What the repository says about exams: pages, RETIRING badges, certification pages
 * the hub links, Applied Skills the lab pages link and (optionally) the Learn exam
 * tracker's certification-to-exam map.
 */
export async function loadHubContext(cfg) {
  if (!existsSync(cfg.docsDir)) {
    throw new CheckError(
      `The docs folder was not found at ${displayPath(cfg.docsDir)}.`,
    );
  }
  const exams = new Map();
  const certLinks = new Map();
  for (const area of EXAM_AREAS) {
    const dir = join(cfg.docsDir, area);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const match = file.match(
        /^((?:[A-Za-z]{2,3}|\d{2})-\d{3}[A-Za-z]?)\.mdx$/,
      );
      if (!match) continue;
      const code = match[1].toUpperCase();
      const text = readFileSync(join(dir, file), "utf8");
      if (/^draft:\s*true\s*$/m.test(frontmatterOf(text))) continue;
      const body = stripMdxComments(text);
      exams.set(code, {
        code,
        area,
        path: `src/content/docs/${area}/${file}`,
        name: examNameFromDescription(text, code),
        text: body,
      });
      for (const m of body.matchAll(
        /credentials\/certifications\/([a-z0-9][a-z0-9-]*)/gi,
      )) {
        const slug = m[1].toLowerCase();
        if (NON_SLUGS.has(slug)) continue;
        if (!certLinks.has(slug)) certLinks.set(slug, new Set());
        certLinks.get(slug).add(code);
      }
    }
  }

  const statuses = new Map();
  const examStatuses = await loadExamStatuses(cfg.examStatusFile);
  for (const [area, entries] of Object.entries(examStatuses)) {
    for (const [code, badge] of Object.entries(entries ?? {})) {
      statuses.set(code, { area, text: badge?.text, variant: badge?.variant });
    }
  }

  const labSkills = new Map();
  const labsDir = join(cfg.docsDir, "labs");
  for (const file of listMdx(labsDir)) {
    const text = readFileSync(file, "utf8");
    if (/^draft:\s*true\s*$/m.test(frontmatterOf(text))) continue;
    const id = relative(cfg.docsDir, file)
      .replace(/\\/g, "/")
      .replace(/\.mdx$/, "");
    for (const m of stripMdxComments(text).matchAll(
      /credentials\/applied-skills\/([a-z0-9][a-z0-9-]*)/gi,
    )) {
      const slug = m[1].toLowerCase();
      if (NON_SLUGS.has(slug)) continue;
      if (!labSkills.has(slug)) labSkills.set(slug, new Set());
      labSkills.get(slug).add(id);
    }
  }

  const learnCerts = new Map();
  if (existsSync(cfg.learnExamsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(cfg.learnExamsFile, "utf8"));
      for (const cert of parsed.certifications ?? []) {
        if (typeof cert?.slug !== "string") continue;
        const codes = new Set();
        for (const exam of cert.exams ?? []) {
          const code = typeof exam === "string" ? exam : exam?.code;
          if (typeof code === "string" && CODE_ONLY.test(code)) codes.add(code);
        }
        if (codes.size > 0) learnCerts.set(cert.slug.toLowerCase(), codes);
      }
    } catch {
      // an optional file; the other mappings still work
    }
  }
  return { exams, statuses, certLinks, labSkills, learnCerts };
}

/** Does the exam page carry a retirement banner, and does it name this date? */
export function bannerState(text, dateIso) {
  const src = stripMdxComments(text);
  const component = /<RetirementBanner\b/.test(src);
  const caution = [
    ...src.matchAll(/^:::caution[^\n]*\n([\s\S]*?)^:::[ \t]*$/gm),
  ].some((m) => /retir/i.test(m[1]));
  const present = component || caution;
  let mentionsDate = null;
  if (present && isRealIsoDate(dateIso)) {
    const [year, month, day] = dateIso.split("-").map(Number);
    const name = MONTH_NAMES[month - 1];
    mentionsDate = [
      `${name} ${day}, ${year}`,
      `${name} ${pad2(day)}, ${year}`,
      dateIso,
    ].some((form) => src.includes(form));
  }
  return { present, mentionsDate };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Which exam codes a certification address (slug) stands for: the exams Learn's
 * exam rows link to it, the certification pages the hub's exam pages link and the
 * Learn exam tracker's certification list.
 */
export function slugCodeMap(rows, hub) {
  const slugToCodes = new Map();
  const add = (slug, code) => {
    if (!slug || !code) return;
    if (!slugToCodes.has(slug)) slugToCodes.set(slug, new Set());
    slugToCodes.get(slug).add(code);
  };
  for (const row of rows) if (row.kind === "exam") add(row.slug, row.code);
  for (const [slug, codes] of hub.certLinks)
    for (const c of codes) add(slug, c);
  for (const [slug, codes] of hub.learnCerts)
    for (const c of codes) add(slug, c);
  return slugToCodes;
}

/**
 * Learn's rows grouped per exam code: { examRows, certRows } where certRows are the
 * certification (and code-less exam) rows that map to the code.
 */
export function evidenceByCode(rows, hub) {
  const slugToCodes = slugCodeMap(rows, hub);

  const byCode = new Map();
  const entry = (code) => {
    if (!byCode.has(code)) byCode.set(code, { examRows: [], certRows: [] });
    return byCode.get(code);
  };
  for (const row of rows) {
    if (row.kind === "exam" && row.code) {
      entry(row.code).examRows.push(row);
    } else if (
      row.kind === "certification" ||
      (row.kind === "exam" && !row.code)
    ) {
      for (const code of slugToCodes.get(row.slug) ?? []) {
        entry(code).certRows.push(row);
      }
    }
  }
  return byCode;
}

const statusRank = (row) => (row.status === "scheduled" ? 0 : 1);
const pickRow = (rows) =>
  [...rows].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) || byText(a.date ?? "", b.date ?? ""),
  )[0];

/** The retiring-exams.json entry of a code, or undefined. */
const trackedBy = (exams) => new Map(exams.map((e) => [e.code, e]));

/**
 * Everything the hub should know about and does not. Each finding is
 * { key, kind, subject, signature, ... } and is derived from the current state, so a
 * resolved one simply stops appearing.
 *   untracked        Learn lists a hub exam, retiring-exams.json has no entry
 *   date-differs     the entry's date is not the date Learn gives
 *   dropped          a tracked, future retirement vanished from Learn's tables
 *   badge-untracked  exam-status.mjs says RETIRING or RETIRED, the tracker has no entry
 *   skill-linked     a lab page links an Applied Skill that Learn lists as retiring/retired
 */
export function computeFindings({
  rows,
  previousRows,
  okSources,
  tracked,
  hub,
  today,
}) {
  const findings = [];
  const trackedMap = trackedBy(tracked);
  const evidence = evidenceByCode(rows, hub);

  const concerned = (code) =>
    hub.exams.has(code) ||
    trackedMap.has(code) ||
    isRetirementBadge(hub.statuses.get(code));

  for (const [code, ev] of evidence) {
    if (!concerned(code)) continue;
    const entry = trackedMap.get(code);
    const via = ev.examRows.length > 0 ? "exam" : "certification";
    const row = pickRow(via === "exam" ? ev.examRows : ev.certRows);
    const certRows = ev.certRows;
    const base = { subject: code, via, row, certRows };
    if (!entry) {
      findings.push({
        ...base,
        key: `exam:${code}:untracked`,
        kind: "untracked",
        signature: `${row.status}|${row.date ?? "?"}|${via}`,
      });
    } else if (
      via === "exam" &&
      row.date &&
      entry.retirementDate !== row.date
    ) {
      findings.push({
        ...base,
        key: `exam:${code}:date-differs`,
        kind: "date-differs",
        entry,
        signature: `${row.date}|${entry.retirementDate}`,
      });
    }
  }

  // A tracked retirement that is still in the future and that Learn no longer lists.
  if (okSources.has("exams")) {
    const nowCodes = new Set(
      rows.filter((r) => r.source === "exams" && r.code).map((r) => r.code),
    );
    for (const prev of previousRows) {
      if (
        prev.source !== "exams" ||
        prev.kind !== "exam" ||
        prev.status !== "scheduled" ||
        !prev.code ||
        nowCodes.has(prev.code)
      ) {
        continue;
      }
      const entry = trackedMap.get(prev.code);
      if (
        entry &&
        entry.notified !== true &&
        daysBetween(today, entry.retirementDate) > 0
      ) {
        findings.push({
          key: `exam:${prev.code}:dropped`,
          kind: "dropped",
          subject: prev.code,
          entry,
          row: prev,
          signature: `${prev.date ?? "?"}|${entry.retirementDate}`,
        });
      }
    }
  }

  for (const [code, badge] of hub.statuses) {
    if (
      isRetirementBadge(badge) &&
      !trackedMap.has(code) &&
      // an untracked finding for the same exam already says it
      !findings.some((f) => f.kind === "untracked" && f.subject === code)
    ) {
      findings.push({
        key: `exam:${code}:badge-untracked`,
        kind: "badge-untracked",
        subject: code,
        badge: badge.text,
        signature: "badge",
      });
    }
  }

  const skills = new Map();
  for (const row of rows) {
    if (row.kind !== "applied-skill" || !row.slug) continue;
    if (!hub.labSkills.has(row.slug)) continue;
    if (!skills.has(row.slug)) skills.set(row.slug, []);
    skills.get(row.slug).push(row);
  }
  for (const [slug, list] of skills) {
    const states = [...new Set(list.map((r) => `${r.status}:${r.date ?? "?"}`))]
      .sort(byText)
      .join(",");
    findings.push({
      key: `skill:${slug}:linked`,
      kind: "skill-linked",
      subject: slug,
      rows: list,
      labs: [...hub.labSkills.get(slug)].sort(byText),
      signature: states,
    });
  }

  const order = {
    untracked: 0,
    "date-differs": 1,
    dropped: 2,
    "badge-untracked": 3,
    "skill-linked": 4,
  };
  return findings.sort(
    (a, b) => order[a.kind] - order[b.kind] || byText(a.subject, b.subject),
  );
}

/**
 * Which findings to report today. A finding is reported when it is new, when its
 * signature changed, or again `reminderDays` after the last report while nothing
 * changed. The next `reported` map only holds current findings.
 */
export function selectReports(findings, reported, today, reminderDays) {
  const reportNow = [];
  const next = {};
  for (const finding of findings) {
    const record = reported[finding.key];
    const same = record && record.signature === finding.signature;
    const reminder =
      same && daysBetween(record.lastReported, today) >= reminderDays;
    if (!same || reminder) {
      reportNow.push({
        finding,
        status: !record ? "new" : same ? "reminder" : "changed",
        firstReported: same ? record.firstReported : today,
      });
      next[finding.key] = {
        signature: finding.signature,
        firstReported: same ? record.firstReported : today,
        lastReported: today,
      };
    } else {
      next[finding.key] = record;
    }
  }
  return { reportNow, reported: next };
}

/**
 * Retirements that appeared on Learn (or moved to another date) since the last run
 * and that no reliable mapping ties to an exam: informational, reported once.
 *
 * Only certification rows (and exam rows without a code) can be unmapped: an exam
 * row names its code, so the hub either has that page (computeFindings owns it) or
 * does not care. A certification row is mapped when its address is the one an exam
 * row links, a hub exam page links or the Learn exam tracker lists for it. A page
 * whose previous rows are unknown (first run, or it could not be read before) has
 * no "since", so nothing is announced for it.
 */
export function computeAnnouncements({
  rows,
  previousRows,
  okSources,
  hub,
  skipSources = new Set(),
}) {
  const slugToCodes = slugCodeMap(rows, hub);
  const found = [];
  for (const source of okSources) {
    if (skipSources.has(source)) continue;
    const before = previousRows.filter((row) => row.source === source);
    if (before.length === 0) continue;
    const after = rows.filter((row) => row.source === source);
    const { added, changed } = diffRows(before, after);
    const candidates = [...added, ...changed.map((c) => c.after)];
    for (const row of candidates) {
      if (row.status !== "scheduled") continue;
      if (row.kind !== "certification" && !(row.kind === "exam" && !row.code)) {
        continue;
      }
      if ((slugToCodes.get(row.slug) ?? new Set()).size > 0) continue;
      found.push(row);
    }
  }
  return found.sort(
    (a, b) =>
      byText(a.date ?? "9999", b.date ?? "9999") || byText(a.name, b.name),
  );
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/** GET one page with retries for 429 and 5xx. Never throws; a failure is { ok: false, reason }. */
export async function fetchPage(cfg, page) {
  const url = `${cfg.learnBaseUrl}${page.path}`;
  const doFetch = cfg.fetchImpl ?? fetch;
  let reason = "";
  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    let retryAfter = null;
    try {
      const response = await doFetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (response.ok) {
        return {
          ok: true,
          html: await response.text(),
          finalUrl: response.url || url,
        };
      }
      reason = `HTTP ${response.status}`;
      retryAfter = response.headers.get("retry-after");
      console.error(`WARNING: ${url} attempt ${attempt} failed (${reason})`);
      // Only rate limits and server errors are worth another try.
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, reason };
      }
    } catch (error) {
      reason = `network error: ${error.message}`;
      console.error(`WARNING: ${url} attempt ${attempt} failed (${reason})`);
    }
    if (attempt < cfg.fetchAttempts) {
      await sleep(
        retryDelayMs({
          attempt,
          retryAfter,
          baseMs: cfg.retryBaseMs,
          maxMs: cfg.maxRetryAfterMs,
        }),
      );
    }
  }
  return { ok: false, reason };
}

/**
 * Reads one page and decides what to do with it. Returns
 * { id, status: "ok" | "degraded" | "failed", rows, problems, reason, updatedAt, finalUrl }.
 * `rows` are the page's rows when ok/degraded; the caller carries the previous ones
 * forward when failed.
 */
export async function readPage(cfg, page, previousRows) {
  const fetched = await fetchPage(cfg, page);
  const base = { id: page.id, page, rows: [], problems: [], updatedAt: "" };
  if (!fetched.ok) {
    return {
      ...base,
      status: "failed",
      reason: `could not be fetched (${fetched.reason})`,
    };
  }
  const parsed = parseRetirementPage(fetched.html, page);
  const result = {
    ...base,
    updatedAt: parsed.updatedAt,
    finalUrl: fetched.finalUrl,
  };
  if (parsed.fatal.length > 0) {
    return { ...result, status: "failed", reason: parsed.fatal.join("; ") };
  }
  const rows = parsed.rows.map((row) => ({ ...row, source: page.id }));
  if (!cfg.forceBaseline) {
    const reason = restructuredReason(
      previousRows,
      rows.map((row) => storedRow(page.id, row)),
      cfg,
    );
    if (reason) {
      return {
        ...result,
        status: "failed",
        reason: `the page looks restructured: ${reason}. Run the workflow with force_baseline once you checked the page`,
      };
    }
  }
  let redirect = "";
  try {
    const wanted = page.path.replace(/\/+$/, "").toLowerCase();
    const got = new URL(fetched.finalUrl).pathname
      .replace(/\/+$/, "")
      .toLowerCase();
    if (got !== wanted) redirect = fetched.finalUrl;
  } catch {
    // not a URL: no redirect note
  }
  const problems = [...parsed.problems];
  if (redirect)
    problems.push(
      `the address now redirects to ${redirect}; update PAGES in the script`,
    );
  return {
    ...result,
    status: problems.length > 0 ? "degraded" : "ok",
    rows,
    problems,
    reason: problems.join("; "),
  };
}

/** The failure counters after this run: one more day for a bad page, cleared for a good one. */
export function updateFailures(previous, outcomes, today, cap) {
  const next = {};
  for (const outcome of outcomes) {
    if (outcome.status === "ok") continue;
    const record = previous[outcome.id];
    if (!record) {
      next[outcome.id] = { runs: 1, since: today, last: today };
    } else if (record.last === today || record.runs >= cap) {
      // the same day counts once, and a streak that reached the cap is frozen
      next[outcome.id] = record;
    } else {
      next[outcome.id] = {
        runs: record.runs + 1,
        since: record.since,
        last: today,
      };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Report text
// ---------------------------------------------------------------------------

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Text from a Learn page, for a table cell of a public issue. */
export function safeText(text) {
  return String(text ?? "")
    .replace(/[<>`[\]|]/g, " ")
    .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
    .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE)
    .replace(/\s+/g, " ")
    .trim();
}

/** `value` as inline code (hub-controlled text such as paths and codes). */
const code = (value) => "`" + String(value).replace(/`/g, "'") + "`";

/** A fenced block that cannot be closed from inside. */
export function fence(text, lang = "text") {
  const body = String(text).replace(/\r/g, "");
  const longest = Math.max(
    0,
    ...[...body.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

const pageLink = (page) => `[${page.title}](${LEARN_PUBLIC_URL}${page.path})`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The row as Learn shows it, for the quote in an issue. */
export function quoteRow(row) {
  const date = row.dateText || (row.date ? formatLongDate(row.date) : "");
  return [row.code, row.name, date].filter(Boolean).join(" | ");
}

function hubFacts(code, ctx, dateIso) {
  const page = ctx.hub.exams.get(code);
  const badge = ctx.hub.statuses.get(code);
  const banner = page ? bannerState(page.text, dateIso) : null;
  return { page, badge, banner };
}

function bannerLine(facts, dateIso, today) {
  if (!facts.page) return "no hub page for this exam";
  const { banner } = facts;
  // RETIRING until the date has passed, RETIRED after it.
  const wanted = expectedBadgeText(dateIso, today);
  const badge =
    facts.badge?.text === wanted
      ? `badge ${wanted} in \`exam-status.mjs\`: yes`
      : `badge ${wanted} in \`exam-status.mjs\`: **missing**${facts.badge ? ` (it says ${code(facts.badge.text)})` : ""}`;
  const text = !banner.present
    ? "retirement banner on the page: **missing**"
    : banner.mentionsDate === false
      ? `retirement banner on the page: present, but it does not mention ${formatLongDate(dateIso)}`
      : "retirement banner on the page: yes";
  return `${badge}; ${text}`;
}

/** The successor the exam page itself names (banner prop or "replaced by [XX-123"), or "". */
export function replacementFromPage(text) {
  const src = stripMdxComments(text);
  return (
    src.match(/<RetirementBanner[^>]*\breplacementCode="([^"]+)"/)?.[1] ??
    src.match(/replaced by \[([A-Z]{2,3}-\d{3}[A-Z]?)/i)?.[1] ??
    ""
  );
}

/** Indents every line, so a code block stays inside its numbered list item. */
const indent = (text, by = "   ") =>
  String(text)
    .split("\n")
    .map((line) => (line ? by + line : line))
    .join("\n");

function entrySnippet(code_, area, name, date, notified, replacement) {
  return fence(
    [
      "{",
      `  "code": "${code_}",`,
      `  "area": "${area}",`,
      `  "name": "${(name || "<official exam name>").replace(/"/g, '\\"')}",`,
      `  "retirementDate": "${date}",`,
      replacement
        ? `  "replacementCode": "${replacement}",`
        : '  "replacementCode": "<successor exam code; leave this line out when Microsoft names none>",',
      `  "notified": ${notified}`,
      "}",
    ].join("\n"),
    "json",
  );
}

function bannerSnippet(date, certRetires) {
  return fence(
    [
      "import RetirementBanner from '../../../components/RetirementBanner.astro';",
      "",
      "<RetirementBanner",
      `  retireDate="${formatLongDate(date)}"`,
      `  certRetires={${certRetires}}`,
      "/>",
    ].join("\n"),
    "mdx",
  );
}

/** The edits for an exam that Learn lists and the tracker misses or has wrong. */
function examEdits(finding, ctx) {
  const { subject: code_, row } = finding;
  const facts = hubFacts(code_, ctx, row.date);
  const page = facts.page;
  const area = page?.area ?? facts.badge?.area ?? "<area>";
  const name = page?.name ?? "";
  const date = row.date ?? "<YYYY-MM-DD>";
  const retired = row.status === "retired";
  const certRetires =
    finding.certRows?.some((c) => c.date === row.date) ||
    finding.via === "certification";
  const replacement = page ? replacementFromPage(page.text) : "";
  const edits = [];
  const entry = finding.entry;
  edits.push(
    entry
      ? `${code("src/data_files/retiring-exams.json")}: set \`retirementDate\` of ${code(code_)} to ${code(date)} .`
      : `${code("src/data_files/retiring-exams.json")}: add this entry (keep the list in exam-code order${retired ? "; this issue is the notification, so it is already marked as notified" : ""}). ${replacement ? `\`replacementCode\` is what the exam page itself names; check it against Microsoft's announcement.` : "Fill `replacementCode` only from Microsoft's announcement or the exam's study guide, never by guess."}\n\n${indent(entrySnippet(code_, area, name, date, retired, replacement))}`,
  );
  // RETIRING until the date has passed, RETIRED after it.
  const wanted = expectedBadgeText(date, ctx.today);
  if (facts.badge?.text !== wanted) {
    edits.push(
      `${code("src/data_files/exam-status.mjs")}: under \`${area}\` ${facts.badge ? `change the badge of ${code(code_)} to` : "add"} ${code(`"${code_}": ${badgeSnippet(wanted)}`)}${wanted === "RETIRED" ? " (the date has passed; keep the tracker entry as history)" : ""}.`,
    );
  }
  if (page) {
    if (!facts.banner.present) {
      edits.push(
        `${code(page.path)}: add the retirement banner at the top (below the imports). The component words the text itself, before and after the date. Add \`replacementCode\`, \`replacementName\` and \`replacementArea\` when Microsoft names a successor exam:\n\n${indent(bannerSnippet(date, Boolean(certRetires)))}`,
      );
    } else if (facts.banner.mentionsDate === false) {
      edits.push(
        `${code(page.path)}: change the date in the retirement banner to ${formatLongDate(date)}.`,
      );
    }
  }
  return edits;
}

function findingHeading(finding) {
  switch (finding.kind) {
    case "untracked":
      return `${finding.subject}: Learn lists a retirement the hub does not track`;
    case "date-differs":
      return `${finding.subject}: the retirement date differs from Learn`;
    case "dropped":
      return `${finding.subject}: Learn no longer lists a tracked retirement`;
    case "badge-untracked":
      return `${finding.subject}: ${finding.badge ?? "RETIRING"} badge without a tracker entry`;
    default:
      return `${safeText(finding.subject)}: a lab page links a retiring Applied Skill`;
  }
}

function describeFinding(finding, ctx) {
  const lines = [`### ${findingHeading(finding)}`, ""];
  const today = ctx.today;
  const learnPage = (row) => PAGES.find((p) => p.id === row.source) ?? PAGES[0];

  if (finding.kind === "untracked" || finding.kind === "date-differs") {
    const { row } = finding;
    const when = row.date
      ? `${formatLongDate(row.date)} (${daysBetween(today, row.date) >= 0 ? `${plural(daysBetween(today, row.date), "day", "days")} from today` : `${plural(-daysBetween(today, row.date), "day", "days")} ago`})`
      : `a date this monitor could not read ("${safeText(row.dateText)}")`;
    if (finding.kind === "untracked") {
      lines.push(
        row.status === "retired"
          ? `Microsoft Learn lists ${code(finding.subject)} as **retired** on ${when}, and \`retiring-exams.json\` has no entry for it.`
          : `Microsoft Learn schedules ${code(finding.subject)} to retire on ${when}, and \`retiring-exams.json\` has no entry for it, so nothing will notify.`,
      );
      if (finding.via === "certification") {
        lines.push(
          "",
          `Learn gave this on a **certification** row (${safeText(row.name)}), not for the exam itself, and a certification retires with its last exam, so check the exam's own date on its Learn page before copying the date below.`,
        );
      }
    } else {
      lines.push(
        `Microsoft Learn gives ${when} for ${code(finding.subject)}; \`retiring-exams.json\` says ${code(finding.entry.retirementDate)} (${formatLongDate(finding.entry.retirementDate)}).`,
      );
    }
    lines.push(
      "",
      `Learn's row (${pageLink(learnPage(row))}, section "${sectionLabel(row.kind, row.status)}"):`,
      "",
      fence(quoteRow(row)),
      "",
    );
    const facts = hubFacts(
      finding.subject,
      ctx,
      row.date ?? finding.entry?.retirementDate,
    );
    lines.push(
      `Hub today: ${facts.page ? code(facts.page.path) : "no exam page"}; ${bannerLine(facts, row.date ?? finding.entry?.retirementDate ?? "", today)}.`,
      "",
      "**What to edit**",
      "",
    );
    const edits = examEdits(finding, ctx);
    edits.forEach((edit, i) => lines.push(`${i + 1}. ${edit}`, ""));
    lines.push(`${edits.length + 1}. Run \`pnpm build\`.`);
  } else if (finding.kind === "dropped") {
    lines.push(
      `${code(finding.subject)} is tracked in \`retiring-exams.json\` (${code(finding.entry.retirementDate)}) and was on Learn's "${sectionLabel("exam", "scheduled")}" table (${formatLongDate(finding.row.date ?? "")}) in the previous run, but ${pageLink(PAGES[0])} lists it in no table now.`,
      "",
      "Either Microsoft cancelled or postponed the retirement, or Learn's table is incomplete. **Do not change the page on this alone**: open the exam's Learn page and its study guide and look for the notice.",
      "",
      "**What to edit**",
      "",
      `1. Cancelled: remove the retirement banner from the exam page, the RETIRING badge from ${code("src/data_files/exam-status.mjs")} and the ${code(finding.subject)} entry from ${code("src/data_files/retiring-exams.json")}.`,
      "2. Postponed: change `retirementDate` in the entry and the date in the banner to the new date from the official source.",
      "3. Still retiring on the same date (Learn is wrong or lagging): nothing to change; this finding stops when Learn lists it again.",
    );
  } else if (finding.kind === "badge-untracked") {
    const facts = hubFacts(finding.subject, ctx, "");
    lines.push(
      `${code("src/data_files/exam-status.mjs")} marks ${code(finding.subject)} as ${finding.badge ?? "RETIRING"}, but ${code("src/data_files/retiring-exams.json")} has no entry for it, so this monitor will never remind about or announce its retirement${finding.badge === "RETIRED" ? " and the retirement has no recorded date" : ""}.`,
      "",
      "**What to edit**",
      "",
      `1. Add an entry to ${code("src/data_files/retiring-exams.json")} with the date from the page's banner${facts.page ? ` (${code(facts.page.path)})` : ""} or from Microsoft's announcement (see "Adding a new exam to either tracker" in \`docs/monitors/beta-and-retiring-exams.md\`). If the badge is a leftover, remove it from \`exam-status.mjs\` instead.`,
      "2. Run `pnpm build`.",
    );
  } else {
    const rows = finding.rows;
    lines.push(
      `Microsoft Learn lists the Applied Skill ${code(finding.subject)} as retiring or retired, and ${plural(finding.labs.length, "lab page links", "lab pages link")} it:`,
      "",
      ...finding.labs.map((lab) => `- ${code(`src/content/docs/${lab}.mdx`)}`),
      "",
      "Learn's rows:",
      "",
      fence(
        rows
          .map((r) => `${sectionLabel(r.kind, r.status)}: ${quoteRow(r)}`)
          .join("\n"),
      ),
      "",
      "**What to edit**",
      "",
      "1. Remove the `LinkCard` for this skill from each lab page above (keep the commented-out tab placeholder when the tab becomes empty).",
      "2. Run `node scripts/applied-skills-sync.mjs` and commit the regenerated `src/data_files/applied-skills-cache.json`, then `pnpm build`.",
    );
  }
  return lines.join("\n");
}

/** Titles are at most 200 characters; names beyond that are cut with a count. */
export function titleWithCodes(prefix, codes) {
  const list = [...codes];
  for (let shown = list.length; shown >= 1; shown--) {
    const rest = list.length - shown;
    const title = `${prefix}${list.slice(0, shown).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
    if (title.length <= 200) return title;
  }
  return prefix.trim().slice(0, 200);
}

const MAX_REPORT = 60_000;

function fitReport(head, parts, tail) {
  let text = [head, ...parts, tail].filter(Boolean).join("\n\n");
  if (text.length <= MAX_REPORT) return text;
  const kept = [];
  let length = head.length + tail.length + 200;
  for (const part of parts) {
    if (length + part.length + 2 > MAX_REPORT) break;
    kept.push(part);
    length += part.length + 2;
  }
  const left = parts.length - kept.length;
  text = [
    head,
    ...kept,
    `_${plural(left, "more item is", "more items are")} not shown here to keep the issue under GitHub's size limit; they come back in the next report._`,
    tail,
  ]
    .filter(Boolean)
    .join("\n\n");
  return text;
}

const sourcesLine = (ctx) => {
  const bits = ctx.pages.map((p) => {
    const link = pageLink(p.page);
    const state =
      p.status === "failed"
        ? "could not be read this run, so the previous rows were used"
        : p.updatedAt
          ? `updated ${p.updatedAt.slice(0, 10)}`
          : "read";
    return `${link} (${state})`;
  });
  return `Checked on ${ctx.today} against ${bits.join(" and ")}.`;
};

export function buildFindingsReport(ctx, reportNow) {
  const head = [
    "## Exam retirement schedule: the hub does not match Microsoft Learn",
    sourcesLine(ctx),
    ...(reportNow.some((r) => r.status === "reminder")
      ? ["Items marked as a reminder were reported before and are still open."]
      : []),
  ].join("\n\n");
  const parts = reportNow.map(({ finding, status }) => {
    const note =
      status === "reminder"
        ? "_Reminder: reported before and still open._\n\n"
        : status === "changed"
          ? "_Changed since it was last reported._\n\n"
          : "";
    return note + describeFinding(finding, ctx);
  });
  const tail =
    "This is a running issue: the next change is added as a comment, and it closes itself when nothing is left. Nothing needs to be dismissed by hand.";
  return fitReport(head, parts, tail);
}

function learnRowsFor(code_, ctx) {
  const evidence = ctx.evidence.get(code_);
  const rows = evidence?.examRows ?? [];
  return rows;
}

function learnStateLine(code_, entryDate, ctx) {
  const rows = learnRowsFor(code_, ctx);
  if (rows.length === 0) {
    return "Learn: not listed on the retirement pages (they list the last and next 12 months).";
  }
  const row = pickRow(rows);
  const same =
    row.date === entryDate
      ? "same date as the tracker"
      : `**differs** from the tracker date ${entryDate}`;
  return `Learn: listed as ${row.status === "retired" ? "retired" : "scheduled to retire"} on ${row.date ? formatLongDate(row.date) : safeText(row.dateText)} (${same}).`;
}

export function buildRetiredReport(ctx, retired) {
  const lines = [
    "## Exam(s) retired",
    "",
    "The following exam(s) passed their retirement date, Microsoft Learn lists them as retired, and the hub does not show them as `RETIRED` yet:",
    "",
    "| Code | Name | Retirement date | Replacement |",
    "|------|------|------------------|-------------|",
    ...retired.map(
      (entry) =>
        `| ${safeText(entry.code)} | ${safeText(entry.name)} | ${entry.retirementDate} | ${entry.replacementCode ? safeText(entry.replacementCode) : "—"} |`,
    ),
  ];
  for (const entry of retired) {
    const facts = hubFacts(entry.code, ctx, entry.retirementDate);
    lines.push(
      "",
      `### ${entry.code}`,
      "",
      `- Hub page: ${facts.page ? code(facts.page.path) : "no exam page found"}`,
      `- ${bannerLine(facts, entry.retirementDate, ctx.today)}`,
      `- ${learnStateLine(entry.code, entry.retirementDate, ctx)}`,
    );
  }
  lines.push(
    "",
    'See the "Beta and Retiring Exam Tracking" runbook (`docs/monitors/beta-and-retiring-exams.md`) for how to process these. **What to do** for each exam above: switch it from `RETIRING` to `RETIRED` in `src/data_files/exam-status.mjs` (`{ text: "RETIRED", variant: "note" }`). Keep the `retiring-exams.json` entry as history: the monitor sets `notified` itself and never notifies again for it. The `RetirementBanner` on the page already words itself in the past tense once the date has passed; a hand-written `:::caution` banner has to be reworded.',
  );
  return lines.join("\n");
}

/** The issue on the retirement day itself. */
export function buildRetiresTodayReport(ctx, retiresToday) {
  const lines = [
    "## Exam(s) retiring today",
    "",
    "The following exam(s) have today as their retirement date:",
    "",
    "| Code | Name | Retirement date | Replacement |",
    "|------|------|------------------|-------------|",
    ...retiresToday.map(
      (entry) =>
        `| ${safeText(entry.code)} | ${safeText(entry.name)} | ${entry.retirementDate} | ${entry.replacementCode ? safeText(entry.replacementCode) : "—"} |`,
    ),
  ];
  for (const entry of retiresToday) {
    const facts = hubFacts(entry.code, ctx, entry.retirementDate);
    lines.push(
      "",
      `### ${entry.code}`,
      "",
      `- Hub page: ${facts.page ? code(facts.page.path) : "no exam page found"}`,
      `- ${bannerLine(facts, entry.retirementDate, ctx.today)}`,
      `- ${learnStateLine(entry.code, entry.retirementDate, ctx)}`,
    );
  }
  lines.push(
    "",
    'See the "Beta and Retiring Exam Tracking" runbook (`docs/monitors/beta-and-retiring-exams.md`) for how to process these. **What to do:** the exam is still `RETIRING` today (the badge turns `RETIRED` once the date is before today, the same cut-off as the `RetirementBanner`), so nothing has to change on the hub yet: check that the exam page, its banner and its replacement are ready. The monitor opens a second issue when Microsoft Learn lists the exam as retired and the hub still shows `RETIRING`; then switch the badge to `RETIRED` in `src/data_files/exam-status.mjs` (`{ text: "RETIRED", variant: "note" }`) and keep the `retiring-exams.json` entry as history. If you switch it first, no second issue is opened.',
  );
  return lines.join("\n");
}

const MAX_ANNOUNCED_SHOWN = 25;

export function buildAnnouncementReport(ctx, rows) {
  const shown = rows.slice(0, MAX_ANNOUNCED_SHOWN);
  const lines = [
    "## Microsoft Learn announced a retirement this monitor cannot map to a hub exam",
    "",
    `${plural(rows.length, "row", "rows")} appeared in (or changed date in) a retirement table on Microsoft Learn since the last run, and no exam could be tied to ${rows.length === 1 ? "it" : "them"}: ${rows.length === 1 ? "the row names" : "the rows name"} no exam code, and ${rows.length === 1 ? "its certification address is not one" : "their certification addresses are not ones"} that an exam row on Learn, a hub exam page or the Learn exam tracker links to an exam. ${sourcesLine(ctx)}`,
    "",
    "| Section | Name | Retirement date | Learn page |",
    "|---------|------|-----------------|------------|",
    ...shown.map((row) => {
      const page = PAGES.find((p) => p.id === row.source) ?? PAGES[0];
      const date = row.date
        ? formatLongDate(row.date)
        : safeText(row.dateText) || "unreadable";
      return `| ${sectionLabel(row.kind, row.status)} | ${safeText(row.name)} | ${date} | ${pageLink(page)} |`;
    }),
  ];
  if (rows.length > shown.length) {
    lines.push(
      "",
      `_${plural(rows.length - shown.length, "more row is", "more rows are")} not listed here; they are recorded in \`src/data_files/retirement-schedule.json\`._`,
    );
  }
  lines.push(
    "",
    "**What to do**",
    "",
    "1. Open the Learn page and check which exams the certification covers.",
    '2. If one of them has a hub exam page, add it to `src/data_files/retiring-exams.json` and give the page its `RETIRING` badge and retirement banner (see "Adding a new exam to either tracker" in `docs/monitors/beta-and-retiring-exams.md`). From then on this monitor keeps the date in sync and sends the reminders.',
    "3. If none of them is on the hub, there is nothing to do. This is the only report for these rows; they are recorded, so they are not announced again.",
  );
  return lines.join("\n");
}

export function buildPagesReport(cfg, failing) {
  const lines = [
    "The Retiring Exam Monitor could not read a Microsoft Learn retirement page for several days in a row. While a page is unreadable the monitor keeps the rows it recorded earlier, so a new or changed retirement on that page is **not** seen. The notification after the date still works, because it only uses `retiring-exams.json`.",
    "",
    "| Page | Failing since | Days in a row | Why (this run) |",
    "|------|---------------|---------------|----------------|",
    ...failing.map(
      (item) =>
        `| ${pageLink(item.page)} | ${item.record.since} | ${item.record.runs} | ${safeText(item.reason || "readable now, but a problem was found earlier")} |`,
    ),
    "",
    "**What to do**",
    "",
    "1. Open the page in a browser. If it is down or moved, nothing to change here; the issue closes itself after the first clean run.",
    "2. If the page changed shape (a renamed section, a table that is no longer a table), fix `parseRetirementPage` / `classifyHeading` in `scripts/retiring-exam-check.mjs` and the fixture in `tests/fixtures/retirement-schedule/`.",
    "3. If Microsoft really restructured many rows at once and the page is fine, run the workflow once with `force_baseline` ticked.",
    `\nToday: ${cfg.today}.${cfg.runUrl ? `\n\nRun: ${cfg.runUrl}` : ""}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Issues (gh CLI)
// ---------------------------------------------------------------------------

const LABELS = {
  enhancement: { color: "a2eeef", description: "New feature or request" },
  bug: { color: "d73a4a", description: "Something isn't working" },
};

function createIssue(gh, { title, label, body }) {
  ensureLabel(gh, label, LABELS[label]);
  const out = gh(
    ["issue", "create", "--title", title, "--label", label, "--body-file", "-"],
    body,
  );
  return Number(out.match(/\/issues\/(\d+)/)?.[1]) || null;
}

/**
 * Brings one RUNNING issue in line with a state, through `gh(args, stdin)`:
 *   active, none open   create ONE issue with `body`;
 *   active, one open    add `commentBody` as a comment (several open copies: the oldest);
 *   inactive, some open close each with `closeComment`.
 * Not `enabled`: touch nothing, not even to read. When the issue is needed a failed
 * lookup or write throws (nothing is committed yet); when it is only being closed
 * a failure is reported in the result and the next run retries.
 */
export function syncIssue({
  gh,
  enabled,
  title,
  label,
  active,
  body,
  commentBody = body,
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
    open = listOpenIssues(gh, { title, label });
  } catch (error) {
    if (active) throw error;
    return result("lookup-failed", { error: error.message });
  }
  if (active) {
    if (open.length > 0) {
      const number = open[0].number;
      gh(["issue", "comment", String(number), "--body-file", "-"], commentBody);
      return result("commented", { number });
    }
    return result("created", {
      number: createIssue(gh, { title, label, body }),
    });
  }
  const closed = [];
  const failures = [];
  for (const issue of open) {
    try {
      gh(["issue", "close", String(issue.number), "--comment", closeComment]);
      closed.push(issue.number);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return result(
    closed.length ? "closed" : failures.length ? "close-failed" : "none",
    { number: closed[0] ?? null, closed, error: failures.join("; ") || null },
  );
}

const runLink = (cfg) => (cfg.runUrl ? `\n\nRun: ${cfg.runUrl}` : "");

/** A per-event issue (a retirement day): always a new issue. */
export function createEventIssue(cfg, gh, { title, body }) {
  if (!(cfg.createIssues && !cfg.dryRun)) {
    return { action: "skipped", number: null };
  }
  return {
    action: "created",
    number: createIssue(gh, { title, label: "enhancement", body }),
  };
}

export function syncFindingsIssue(cfg, gh, { reportNow, allClear, body }) {
  const active = reportNow.length > 0;
  if (!active && !allClear) {
    return { action: "none", number: null, closed: [], error: null };
  }
  return syncIssue({
    gh,
    enabled: cfg.createIssues && !cfg.dryRun,
    title: FINDINGS_ISSUE_TITLE,
    label: FINDINGS_ISSUE_LABEL,
    active,
    body,
    closeComment: `Microsoft Learn's retirement tables and the hub agree as of ${cfg.today}, so there is nothing left to do here. Closing this issue; the next difference opens a new one.${runLink(cfg)}`,
  });
}

export function syncPagesIssue(cfg, gh, { failing }) {
  const active = failing.length > 0;
  const body = active ? buildPagesReport(cfg, failing) : "";
  return syncIssue({
    gh,
    enabled: cfg.createIssues && !cfg.dryRun,
    title: PAGES_ISSUE_TITLE,
    label: BUG_LABEL,
    active,
    body,
    commentBody: active
      ? `Still unreadable on ${cfg.today}: ${failing.map((f) => `${f.page.id} (${safeText(f.reason || "problem")})`).join("; ")}.${runLink(cfg)}`
      : "",
    closeComment: `Both Microsoft Learn retirement pages were read cleanly on ${cfg.today}. Closing this issue.${runLink(cfg)}`,
  });
}

export function syncFailureIssue(cfg, gh, message) {
  const failed = message !== null;
  return syncIssue({
    gh,
    enabled: cfg.createIssues && !cfg.dryRun,
    title: FAILED_ISSUE_TITLE,
    label: BUG_LABEL,
    active: failed,
    body: failed
      ? `The Retiring Exam Monitor could not run on ${cfg.today}. No notification or finding was produced and the trackers were not written, so nothing was lost: the next healthy run continues where the last one stopped.\n\n**Why:** ${message}${runLink(cfg)}\n\nThis issue gets one comment per failed run and closes itself after the next healthy run.`
      : "",
    commentBody: failed
      ? `The Retiring Exam Monitor failed again on ${cfg.today}:\n\n${message}${runLink(cfg)}`
      : "",
    closeComment: `The Retiring Exam Monitor ran normally on ${cfg.today}. Closing this issue.${runLink(cfg)}`,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * One check. Reads the pages and the repository and decides everything, but writes
 * and creates nothing: main() does that after the issues, in the right order.
 */
export async function run(cfg) {
  const { schedule, existed } = loadSchedule(cfg.scheduleFile);
  // A schedule written in another format holds rows this script would read
  // differently today. They are compared with nothing, so the change of the
  // extraction is never news: the rows are recorded again, silently.
  const rebaselined = existed && schedule.format !== SCHEDULE_FORMAT;
  const known = rebaselined ? [] : schedule.rows;
  const tracker = loadRetiringExams(cfg.examsFile);
  const hub = await loadHubContext(cfg);

  // 1. The two Learn pages, one request at a time.
  const pages = [];
  for (const [i, page] of PAGES.entries()) {
    if (i > 0) await sleep(cfg.fetchDelayMs);
    const previous = known.filter((row) => row.source === page.id);
    pages.push(await readPage(cfg, page, previous));
  }
  for (const page of pages) {
    if (page.status !== "ok") {
      warnLoud(
        `${page.page.title} (${page.id}): ${page.status}: ${page.reason}`,
        { title: "Retiring Exam Monitor" },
      );
    }
  }

  // 2. The rows: a page that could not be read keeps the previous ones (not in
  // another format: the next good read of that page is the silent baseline).
  const okSources = new Set(
    pages.filter((p) => p.status !== "failed").map((p) => p.id),
  );
  const storedRows = [];
  const currentRows = [];
  for (const page of pages) {
    if (page.status === "failed") {
      const previous = schedule.rows.filter((row) => row.source === page.id);
      if (!rebaselined) storedRows.push(...previous);
      currentRows.push(...previous);
    } else {
      storedRows.push(...page.rows.map((row) => storedRow(page.id, row)));
      currentRows.push(
        ...page.rows.map((row) => ({ ...row, source: page.id })),
      );
    }
  }
  const failures = updateFailures(
    schedule.failures,
    pages,
    cfg.today,
    cfg.failingRuns,
  );
  const failing = pages
    .filter((p) => failures[p.id]?.runs >= cfg.failingRuns)
    .map((p) => ({ page: p.page, record: failures[p.id], reason: p.reason }));

  // 3. Findings: Learn versus the hub.
  const evidence = evidenceByCode(currentRows, hub);
  const findings = computeFindings({
    rows: currentRows,
    previousRows: known,
    okSources,
    tracked: tracker.exams,
    hub,
    today: cfg.today,
  });
  const reports = selectReports(
    findings,
    schedule.reported,
    cfg.today,
    cfg.reminderDays,
  );
  const ctx = { cfg, hub, today: cfg.today, pages, evidence };

  // New retirements no mapping ties to an exam. Nothing is announced on the first
  // run or on a forced baseline: there is no "since" to compare with.
  const announcements =
    existed && !cfg.forceBaseline
      ? computeAnnouncements({
          rows: currentRows,
          previousRows: known,
          okSources,
          hub,
        })
      : [];

  // 4. The notification on the retirement day, then the follow-up after it: an exam
  // Learn lists as retired that the hub does not show as RETIRED yet.
  const onDay = selectRetiresToday(tracker.exams, cfg.today);
  const retired = selectRetired(onDay.exams, cfg.today, {
    learnRetired: (code_) =>
      learnRowsFor(code_, ctx).some((row) => row.status === "retired"),
    hubRetired: (code_) => hub.statuses.get(code_)?.text === "RETIRED",
  });

  // 5. Report texts.
  const findingsBody =
    reports.reportNow.length > 0
      ? buildFindingsReport(ctx, reports.reportNow)
      : "";
  const retiresTodayBody =
    onDay.retiresToday.length > 0
      ? buildRetiresTodayReport(ctx, onDay.retiresToday)
      : "";
  const retiredBody =
    retired.retired.length > 0 ? buildRetiredReport(ctx, retired.retired) : "";
  const announcementBody =
    announcements.length > 0 ? buildAnnouncementReport(ctx, announcements) : "";

  // 6. The next trackers.
  const nextSchedule = {
    lastSynced: schedule.lastSynced,
    format: SCHEDULE_FORMAT,
    failures,
    reported: reports.reported,
    rows: sortRows(storedRows),
  };
  const scheduleChanged =
    scheduleContent({ ...nextSchedule, lastSynced: null }) !==
    scheduleContent({ ...schedule, lastSynced: null });
  if (scheduleChanged) nextSchedule.lastSynced = cfg.today;
  const nextTracker = { ...tracker, exams: retired.exams };
  const examsChanged = examsContent(nextTracker) !== examsContent(tracker);

  return {
    existed,
    rebaselined,
    scheduleFormat: schedule.format,
    pages,
    rows: nextSchedule.rows,
    findings,
    reportNow: reports.reportNow,
    allClear: findings.length === 0,
    retiresToday: onDay.retiresToday,
    retired: retired.retired,
    retiredQuietly: retired.quiet,
    announcements,
    failing,
    findingsBody,
    retiresTodayBody,
    retiredBody,
    announcementBody,
    nextSchedule,
    scheduleChanged,
    nextTracker,
    examsChanged,
    ctx,
  };
}

function describeIssue(label, issue, cfg) {
  if (issue.action === "skipped") {
    return `${label} not touched (${cfg.dryRun ? "DRY_RUN" : "CREATE_ISSUES is not 1"}).`;
  }
  if (issue.action === "lookup-failed" || issue.action === "close-failed") {
    return `${label}: ${issue.action} (${issue.error}); the next run tries again.`;
  }
  if (issue.action === "none") return null;
  return `${label} ${issue.action}${issue.number ? ` (#${issue.number})` : ""}.`;
}

function summaryText(result, cfg) {
  const lines = ["### Retiring Exam Monitor", ""];
  for (const page of result.pages) {
    lines.push(
      `- ${page.page.title}: **${page.status}**, ${page.rows.length} rows` +
        (page.status === "ok" ? "" : ` (${safeText(page.reason)})`),
    );
  }
  if (result.rebaselined) {
    lines.push(
      `- The schedule tracker was in format ${result.scheduleFormat}, this script writes ${SCHEDULE_FORMAT}: its rows were recorded again, silently, and compared with nothing`,
    );
  }
  lines.push(
    `- Findings: ${result.findings.length} open, ${result.reportNow.length} reported today`,
    `- Retiring today: ${result.retiresToday.length}; retired on Learn, not yet on the hub: ${result.retired.length}; new rows no exam maps to: ${result.announcements.length}`,
    `- Run date used: ${cfg.today}`,
  );
  return lines.join("\n");
}

async function main(cfg) {
  console.log("=== Retiring Exam Monitor ===");
  console.log(`Started: ${new Date().toISOString()} · date used: ${cfg.today}`);

  const result = await run(cfg);

  if (result.rebaselined) {
    console.log(
      `The schedule tracker is in format ${result.scheduleFormat}, this script writes ${SCHEDULE_FORMAT}: its rows are recorded again, silently, and compared with nothing.`,
    );
  }
  for (const page of result.pages) {
    console.log(
      `${page.id}: ${page.status}, ${page.rows.length} rows read` +
        (page.updatedAt ? `, Learn updated_at ${page.updatedAt}` : "") +
        (page.status === "ok" ? "" : ` (${page.reason})`),
    );
  }
  console.log(
    `${plural(result.findings.length, "finding", "findings")} open, ${result.reportNow.length} to report today.`,
  );
  console.log(
    `${plural(result.retiresToday.length, "exam", "exams")} retiring today.`,
  );
  console.log(
    `${plural(result.retired.length, "exam", "exams")} past the date that Learn lists as retired and the hub does not show as RETIRED.`,
  );
  if (result.retiredQuietly.length > 0) {
    console.log(
      `${plural(result.retiredQuietly.length, "exam", "exams")} past the date already marked RETIRED on the hub (${result.retiredQuietly.map((e) => e.code).join(", ")}): marked as notified without an issue.`,
    );
  }

  if (result.announcements.length > 0) {
    console.log(
      `${plural(result.announcements.length, "new retirement row", "new retirement rows")} no exam could be mapped to.`,
    );
  }

  const parts = [
    result.findingsBody,
    result.retiresTodayBody,
    result.retiredBody,
    result.announcementBody,
  ].filter(Boolean);
  if (parts.length > 0)
    writeFileSync(cfg.reportFile, parts.join("\n\n---\n\n"), "utf8");

  // The issues come BEFORE the trackers are written (and before the workflow commits
  // them): when one fails the run fails, nothing is written, and the next run reports
  // the same things again.
  const gh = makeGh({ ghCliScript: cfg.ghCliScript });
  const headline = [];

  const findingsIssue = syncFindingsIssue(cfg, gh, {
    reportNow: result.reportNow,
    allClear: result.allClear,
    body: result.findingsBody,
  });
  const findingsLine = describeIssue(
    `Findings issue "${FINDINGS_ISSUE_TITLE}"`,
    findingsIssue,
    cfg,
  );
  if (findingsLine) console.log(findingsLine);
  if (result.reportNow.length > 0) {
    headline.push(
      titleWithCodes(
        "Exam retirement schedule: ",
        result.reportNow.map((r) => r.finding.subject),
      ),
    );
  }

  if (result.retiresToday.length > 0) {
    const title = titleWithCodes(
      "Exam retires today: ",
      result.retiresToday.map((e) => e.code),
    );
    const issue = createEventIssue(cfg, gh, {
      title,
      body: result.retiresTodayBody,
    });
    console.log(describeIssue(`Retirement-day issue "${title}"`, issue, cfg));
    headline.push(title);
  }
  if (result.retired.length > 0) {
    const title = titleWithCodes(
      "Exam retirement notification: ",
      result.retired.map((e) => e.code),
    );
    const issue = createEventIssue(cfg, gh, {
      title,
      body: result.retiredBody,
    });
    console.log(describeIssue(`Notification issue "${title}"`, issue, cfg));
    headline.push(title);
  }
  if (result.announcements.length > 0) {
    const title = titleWithCodes(
      "Microsoft Learn announced a retirement: ",
      result.announcements.map((row) => safeText(row.name)),
    );
    const issue = createEventIssue(cfg, gh, {
      title,
      body: result.announcementBody,
    });
    console.log(describeIssue(`Announcement issue "${title}"`, issue, cfg));
    headline.push(title);
  }

  const pagesIssue = syncPagesIssue(cfg, gh, { failing: result.failing });
  const pagesLine = describeIssue(
    `Pages issue "${PAGES_ISSUE_TITLE}"`,
    pagesIssue,
    cfg,
  );
  if (pagesLine && pagesIssue.action !== "skipped") console.log(pagesLine);
  const recovered = syncFailureIssue(cfg, gh, null);
  const recoveredLine = describeIssue(
    `Failure issue "${FAILED_ISSUE_TITLE}"`,
    recovered,
    cfg,
  );
  if (recoveredLine && recovered.action !== "skipped")
    console.log(recoveredLine);

  // Only now are the trackers written.
  if (result.scheduleChanged) {
    writeFileSync(
      cfg.scheduleFile,
      scheduleContent(result.nextSchedule),
      "utf8",
    );
  }
  if (result.examsChanged) {
    writeFileSync(cfg.examsFile, examsContent(result.nextTracker), "utf8");
  }
  appendStepSummary(cfg.summaryFile, summaryText(result, cfg));

  const changesFound = headline.length > 0;
  writeOutput(cfg.githubOutput, {
    changes_found: changesFound,
    baseline_updated: result.scheduleChanged || result.examsChanged,
    extraction_failed: false,
    issue_title: headline[0] ?? "",
  });
  console.log(
    `Trackers: schedule ${result.scheduleChanged ? "updated" : "unchanged"}, retiring-exams ${result.examsChanged ? "updated" : "unchanged"}`,
  );
  console.log("=== Done ===");
}

function handleFailure(cfg, error) {
  const message =
    error instanceof CheckError
      ? error.message
      : `Unexpected error: ${error?.stack ?? error}`;
  console.error(`ERROR: ${message}`);
  writeFileSync(cfg.errorFile, `${message}\n`);
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
    issue_title: "",
  });
  process.exitCode = 1;
  // One issue for a failing check, a comment for every further failed run. If the gh CLI
  // is what failed, this fails too and the red run is all that is left.
  try {
    const issue = syncFailureIssue(
      cfg,
      makeGh({ ghCliScript: cfg.ghCliScript }),
      safeText(message).slice(0, 1500),
    );
    if (issue.action !== "none" && issue.action !== "skipped") {
      console.log(
        `Failure issue ${issue.action}${issue.number ? ` (#${issue.number})` : ""}`,
      );
    }
  } catch (issueError) {
    console.error(`Could not write the failure issue: ${issueError.message}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
