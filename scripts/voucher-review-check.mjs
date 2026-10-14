#!/usr/bin/env node
/**
 * Daily review of the voucher pages: which offers need a second look.
 *
 * Usage:
 *   node scripts/voucher-review-check.mjs
 *
 * Voucher offers end without any feed, so an offer that is temporary by design
 * carries its dates itself, in the frontmatter of its page, and this monitor
 * reads them. It replaces the old voucher-expiry check, which guessed an end
 * date from the latest date in the page text and opened a pull request. Nothing
 * here touches the network: every finding comes from the repository, so a
 * failed fetch can never be mistaken for evidence.
 *
 * It reads the frontmatter of every page in src/content/docs/vouchers/ that has
 * a `voucherCategory` (those are the pages on the voucher index and the
 * landing page; an ended offer leaves them by losing the category) and looks
 * at three optional fields (validated by src/utils/voucher-fields.ts):
 *
 *   voucherEnds: 2026-10-31   last day of the offer, from the official source
 *   reviewBy:    2026-12-01   day to re-check a temporary offer that has no stated end date
 *   linkedExam:  AB-650       exam the offer is tied to (beta / upcoming exam)
 *
 * A page is reviewed only for what it declares. A stable offer (a standing
 * programme such as the student discount) carries none of the three fields: it
 * is silently fine, nothing is asked of it and no report lists it.
 *
 * It reports in ONE running issue (see "Issues" below) that lists:
 *   - pages whose voucherEnds or reviewBy has passed (days overdue);
 *   - pages whose linkedExam is no longer BETA/UPCOMING in
 *     src/data_files/exam-status.mjs, is flagged GA by the beta exam tracker
 *     (beta-exams.json) while the hub still says BETA, is retiring or retired
 *     (a RETIRING or RETIRED badge in exam-status.mjs, or a retiring-exams.json
 *     entry; a RETIRED badge, or a retirement date before today, counts as
 *     retired), or has no exam page;
 *   - malformed dates / exam codes (the site build rejects them too);
 *   - the exam pages of the beta exams in beta-exams.json (every entry that is
 *     not flaggedGA), whose `announcement` says what the page note promises
 *     about the Skills Hub blog post with the discount code: "pending" for
 *     more than PENDING_ANNOUNCEMENT_DAYS after `betaStart` (an announcement is
 *     overdue from day 8), no valid `betaStart` / `announcement`, or a beta
 *     voucher page (its title contains "(beta)", as in `Exam AB-650 (beta)`)
 *     that links the exam (linkedExam) while the announcement is still
 *     "pending" or "unannounced". A voucher page that links the exam without
 *     "(beta)" in its title, an event voucher say, is not matched.
 * Every finding comes with what to edit (how the repo handled ended offers
 * before).
 *
 * Rules applied every run:
 *   - "Passed" means the UTC date of the run is after the date: an offer that
 *     ends on the 31st is still fine on the 31st.
 *   - Dedupe: the tracker (src/data_files/voucher-review.json) keeps, per
 *     flagged page, the problems last reported and the date. The same
 *     problems are reported again only after REMINDER_DAYS (7); a NEW problem
 *     (another date, another reason) is reported at once. A page that is fine
 *     again leaves the tracker, so a later relapse is reported at once.
 *   - There is no silent baseline: a tracker that was never written reports
 *     every finding at once (they are facts the maintainers wrote down, not a
 *     flood of things Microsoft already published), and a quiet first run
 *     writes nothing. REPORT_ALL=1 reports every open finding now, ignoring
 *     what an earlier run reported.
 *   - The tracker is only rewritten when something in it changed, so a quiet
 *     day never produces a commit. A tracker that still holds the
 *     `lastInventory` key of an older version of this monitor loads without
 *     any complaint, whatever the key holds, and is rewritten once without it.
 *   - The issue is handled inside this script, BEFORE the workflow commits the
 *     tracker: a failed issue step fails the run, the commit is skipped, the old
 *     tracker stays on main and the next run reports the same pages again.
 *
 * Issues (only with CREATE_ISSUES=1 and not DRY_RUN=1; the gh CLI, GH_TOKEN):
 *   - ONE running issue with the stable title REVIEW_ISSUE_TITLE (label
 *     enhancement). When a day has something to report and no such issue is
 *     open, it is created with the report; when one is open the report is added
 *     as a comment instead, so a reminder never piles up as a new issue. It is
 *     closed with a comment on the first run where no page has a problem,
 *     however many pages carry no date.
 *   - A failure of the check itself (corrupt tracker, unreadable inputs) raises
 *     ONE issue with the stable title FAILED_ISSUE_TITLE (label bug), a comment
 *     for every further failed run instead of one issue per run, and closes it
 *     with a comment after the next healthy run.
 *   - The state is the open issue, not the tracker: every run derives it again.
 *   - Nothing is guessed: a missing or unreadable input file is a failure of
 *     the check (extraction_failed), never a finding.
 *
 * Env overrides (defaults shown):
 *   DOCS_DIR              src/content/docs
 *   TRACKER_FILE          src/data_files/voucher-review.json
 *   EXAM_STATUS_FILE      src/data_files/exam-status.mjs   (read when a page has a linkedExam)
 *   BETA_EXAMS_FILE       src/data_files/beta-exams.json   (read on every run)
 *   RETIRING_EXAMS_FILE   src/data_files/retiring-exams.json   (read when a page has a linkedExam)
 *   SIDEBAR_FILE          src/data_files/docs-sidebar.ts
 *   SITE_URL              https://msfthub.com
 *   TODAY                 YYYY-MM-DD, default today (UTC)
 *   REMINDER_DAYS         7
 *   REPORT_ALL            1 reports every open finding now, ignoring what an earlier run reported
 *   REPORT_FILE           <tmpdir>/voucher-review-report.md
 *   ERROR_FILE            <tmpdir>/voucher-review-error.md
 *   GITHUB_OUTPUT         <tmpdir>/github-output
 *   CREATE_ISSUES         0   1 = create, comment on and close the issues with the gh CLI
 *   DRY_RUN               0   1 = touch no issue (the report and the tracker are still written locally)
 *   GH_TOKEN / GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID   used for the gh CLI and run links
 *   GH_CLI_SCRIPT         (unset)  tests only: run this Node script instead of the gh CLI
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated,
 * extraction_failed, issue_title (the headline of the day's report; the
 * issue's own title is the stable REVIEW_ISSUE_TITLE).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { writeOutput } from "./lib/actions.mjs";
import { AREA_BY_PREFIX, EXAM_AREAS } from "./lib/areas.mjs";
import {
  PENDING_ANNOUNCEMENT_DAYS,
  SKILLS_HUB_BLOG_URL,
  announcementState,
} from "./lib/beta-note.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

// How paths are written in the issue, whatever DOCS_DIR is.
const DISPLAY_VOUCHER_DIR = "src/content/docs/vouchers";
const DISPLAY_DOCS_DIR = "src/content/docs";
const EXAM_CODE_RE = /^[A-Z]{2}-\d{3}$/;

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
    docsDir: resolveFromRoot(env.DOCS_DIR ?? "src/content/docs"),
    trackerFile: resolveFromRoot(
      env.TRACKER_FILE ?? "src/data_files/voucher-review.json",
    ),
    examStatusFile: resolveFromRoot(
      env.EXAM_STATUS_FILE ?? "src/data_files/exam-status.mjs",
    ),
    betaExamsFile: resolveFromRoot(
      env.BETA_EXAMS_FILE ?? "src/data_files/beta-exams.json",
    ),
    retiringExamsFile: resolveFromRoot(
      env.RETIRING_EXAMS_FILE ?? "src/data_files/retiring-exams.json",
    ),
    sidebarFile: resolveFromRoot(
      env.SIDEBAR_FILE ?? "src/data_files/docs-sidebar.ts",
    ),
    siteUrl: (env.SITE_URL || "https://msfthub.com").replace(/\/+$/, ""),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "voucher-review-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "voucher-review-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    reminderDays: num("REMINDER_DAYS", 7),
    reportAll: env.REPORT_ALL === "1",
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    today,
  };
}

/** A failure of the check itself (not a finding about a page). */
export class ReviewError extends Error {}

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

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * The value of a `key: value` line: quotes removed, a trailing comment dropped.
 * An unquoted timestamp at midnight (2026-10-31T00:00:00Z, 2026-10-31 00:00:00)
 * is read as its day: YAML turns it into the same UTC-midnight Date as a bare
 * 2026-10-31 and the site schema accepts it (src/utils/voucher-fields.ts). Any
 * other time of day stays as written, and so is not a date here, as in the schema.
 */
function readScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let out = "";
    for (let i = 1; i < value.length; i++) {
      const char = value[i];
      if (char === "\\" && i + 1 < value.length) {
        out += value[++i];
      } else if (char === '"') {
        return out;
      } else {
        out += char;
      }
    }
    return out;
  }
  if (value.startsWith("'")) {
    let out = "";
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "'") {
        if (value[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          return out;
        }
      } else {
        out += value[i];
      }
    }
    return out;
  }
  const unquoted = value.replace(/\s+#.*$/, "").trim();
  return /^\d{4}-\d{2}-\d{2}[T ]00:00:00(\.0+)?Z?$/.test(unquoted)
    ? unquoted.slice(0, 10)
    : unquoted;
}

/**
 * The top-level `key: scalar` pairs of a page's frontmatter, or null when the
 * page has no frontmatter block. Nested keys, lists and block scalars are not
 * needed here and are skipped (their lines are indented or have no scalar).
 */
export function parseFrontmatter(source) {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!pair) continue;
    fields[pair[1]] = readScalar(pair[2] ?? "");
  }
  return fields;
}

/**
 * One voucher page: its identity, what the review needs from the frontmatter,
 * or `unreadable` when the file has no frontmatter block.
 */
export function readVoucherPage(file) {
  const base = basename(file, extname(file));
  const page = {
    id: `vouchers/${base}`,
    slug: base,
    path: `${DISPLAY_VOUCHER_DIR}/${basename(file)}`,
    title: base,
    draft: false,
    category: "",
    voucherEnds: undefined,
    reviewBy: undefined,
    linkedExam: undefined,
    unreadable: "",
  };
  let fields;
  try {
    fields = parseFrontmatter(readFileSync(file, "utf8"));
  } catch (error) {
    page.unreadable = `the file could not be read (${error.message})`;
    return page;
  }
  if (!fields) {
    page.unreadable = "the file has no frontmatter block";
    return page;
  }
  page.title = fields.title || base;
  page.draft = fields.draft === "true";
  page.category = fields.voucherCategory ?? "";
  page.voucherEnds = fields.voucherEnds;
  page.reviewBy = fields.reviewBy;
  page.linkedExam = fields.linkedExam;
  return page;
}

/** Voucher pages in the folder, sorted by file name. */
export function listVoucherPages(voucherDir) {
  let names;
  try {
    names = readdirSync(voucherDir);
  } catch (error) {
    throw new ReviewError(
      `The voucher folder ${DISPLAY_VOUCHER_DIR} could not be read (${error.message}); the check is not run, ` +
        "no page was reviewed.",
    );
  }
  const files = names
    .filter((name) => /\.mdx?$/.test(name) && !name.startsWith("_"))
    .sort()
    .map((name) => join(voucherDir, name))
    .filter((file) => statSync(file).isFile());
  if (files.length === 0) {
    throw new ReviewError(
      `No voucher page (.md or .mdx) was found in ${DISPLAY_VOUCHER_DIR}; the folder probably moved or was emptied, ` +
        "so no page was reviewed.",
    );
  }
  const pages = files.map(readVoucherPage);
  if (pages.every((page) => page.unreadable)) {
    throw new ReviewError(
      `None of the ${pages.length} voucher pages in ${DISPLAY_VOUCHER_DIR} has a readable frontmatter block; ` +
        "the page layout probably changed, so no page was reviewed.",
    );
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Exam state (exam-status.mjs, beta-exams.json, retiring-exams.json)
// ---------------------------------------------------------------------------

// `because` says why the file is needed: it ends the message of a failure.
const readJson = (file, label, because) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ReviewError(
      `${label} could not be read as JSON (${error.message}); ${because}, ` +
        "so the check is not run rather than guessing the exam's state.",
    );
  }
  if (!parsed || !Array.isArray(parsed.exams)) {
    throw new ReviewError(
      `${label} has no "exams" list; ${because}, so the check is not run rather than ` +
        "guessing the exam's state.",
    );
  }
  return parsed.exams;
};

/**
 * The beta exam tracker, by exam code (upper case). Read on every run, because
 * the announcement state of every beta exam is checked, not only that of the
 * exams a voucher page links; a file that cannot be read fails the check.
 */
export function loadBetaExams(cfg) {
  const entries = readJson(
    cfg.betaExamsFile,
    "src/data_files/beta-exams.json",
    "the announcement state of every beta exam is checked",
  );
  return new Map(
    entries.map((exam) => [String(exam?.code).toUpperCase(), exam]),
  );
}

/**
 * The lifecycle state of exams, from the three files the hub maintains. Only
 * loaded when a voucher page has a linkedExam, and a file that cannot be read
 * fails the check: an unknown state is never evidence that an exam went GA.
 * `beta` is the result of loadBetaExams when the caller has it already.
 */
export async function loadExamContext(cfg, beta = loadBetaExams(cfg)) {
  let examStatuses;
  try {
    ({ examStatuses } = await import(pathToFileURL(cfg.examStatusFile).href));
  } catch (error) {
    throw new ReviewError(
      `src/data_files/exam-status.mjs could not be loaded (${error.message}); a voucher page links an exam, ` +
        "so the check is not run rather than guessing the exam's state.",
    );
  }
  if (!examStatuses || typeof examStatuses !== "object") {
    throw new ReviewError(
      "src/data_files/exam-status.mjs exports no examStatuses object; the check is not run.",
    );
  }
  const statuses = new Map();
  for (const exams of Object.values(examStatuses)) {
    for (const [code, status] of Object.entries(exams ?? {})) {
      statuses.set(code.toUpperCase(), String(status?.text ?? ""));
    }
  }

  const retiring = new Map(
    readJson(
      cfg.retiringExamsFile,
      "src/data_files/retiring-exams.json",
      "a voucher page links an exam",
    ).map((exam) => [String(exam.code).toUpperCase(), exam]),
  );

  const hubPages = new Set();
  for (const area of EXAM_AREAS) {
    let names = [];
    try {
      names = readdirSync(join(cfg.docsDir, area));
    } catch {
      continue; // an area folder that does not exist has no exam pages
    }
    for (const name of names) {
      const match = /^([A-Za-z]{2}-\d{3})\.mdx?$/.exec(name);
      if (match) hubPages.add(match[1].toUpperCase());
    }
  }
  if (hubPages.size === 0) {
    throw new ReviewError(
      `No exam page (<area>/<CODE>.mdx) was found under ${cfg.docsDir}; the docs folder probably moved, ` +
        "so a linked exam cannot be checked.",
    );
  }
  return { statuses, beta, retiring, hubPages };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const code = (text) =>
  `\`${String(text)
    .replace(/[`\r\n]+/g, " ")
    .trim()}\``;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clip = (text, max = 40) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What is wrong with one linked exam, if anything. A finding is
 * { kind, signature, message }; the signature is stable text that changes when
 * the problem changes (another date, another reason) and is what the dedupe
 * compares.
 */
export function examFinding(examCode, ctx, today) {
  const status = ctx.statuses.get(examCode) ?? "";
  const retiringEntry = ctx.retiring.get(examCode);
  const betaEntry = ctx.beta.get(examCode);

  if (status === "RETIRING" || status === "RETIRED" || retiringEntry) {
    const date = isRealIsoDate(retiringEntry?.retirementDate)
      ? retiringEntry.retirementDate
      : "";
    // A RETIRED badge is the hub saying the exam is retired; otherwise the
    // retirement date decides (retired once it is before today).
    const retired = status === "RETIRED" || (Boolean(date) && date < today);
    const replacement = retiringEntry?.replacementCode
      ? ` (replacement: ${code(retiringEntry.replacementCode)})`
      : "";
    const hasBadge = status === "RETIRING" || status === "RETIRED";
    const source = retiringEntry
      ? `${code("retiring-exams.json")}${hasBadge ? " and " + code("exam-status.mjs") : ""}`
      : code("exam-status.mjs");
    const when = date
      ? // RETIRED with a date that has not passed yet: the badge is ahead of the date.
        status === "RETIRED" && date >= today
        ? `is marked RETIRED although its retirement date ${date} has not passed`
        : `${retired ? "retired on" : "retires on"} ${date}`
      : `is marked ${status || "RETIRING"}`;
    const kind = retired ? "exam-retired" : "exam-retiring";
    return {
      kind,
      signature: `${kind}:${examCode}:${date}`,
      message: `linked exam ${code(examCode)} ${when}${replacement} per ${source}`,
    };
  }

  if (!ctx.hubPages.has(examCode)) {
    return {
      kind: "exam-unknown",
      signature: `exam-unknown:${examCode}`,
      message:
        `linked exam ${code(examCode)} has no exam page (${code("<area>/" + examCode + ".mdx")}) ` +
        "(a typo, or the exam page was never created)",
    };
  }

  if (status === "BETA") {
    if (betaEntry?.flaggedGA === true) {
      const flagged = isRealIsoDate(betaEntry.flaggedAt)
        ? ` on ${betaEntry.flaggedAt}`
        : "";
      return {
        kind: "exam-learn-ga",
        signature: `exam-learn-ga:${examCode}`,
        message:
          `Microsoft Learn no longer shows the beta marker of linked exam ${code(examCode)} ` +
          `(flagged GA${flagged} in ${code("beta-exams.json")}) but the hub still lists it as BETA: ` +
          "the beta voucher window is closing or closed",
      };
    }
    return null;
  }
  if (status === "UPCOMING") return null;

  return {
    kind: "exam-ga",
    signature: `exam-ga:${examCode}`,
    message:
      `linked exam ${code(examCode)} is no longer BETA or UPCOMING in ${code("exam-status.mjs")}` +
      `${status ? ` (status: ${status})` : ""}: it is generally available, so the beta voucher window has most likely closed`,
  };
}

/** All findings of one page, in report order. `ctx` is only needed for a linkedExam. */
export function pageFindings(page, ctx, today) {
  const findings = [];

  if (page.unreadable) {
    findings.push({
      kind: "unreadable",
      signature: "unreadable",
      message: `the page could not be reviewed: ${page.unreadable}`,
    });
    return findings;
  }

  for (const [field, kind, label] of [
    ["voucherEnds", "ended", "the offer's last day"],
    ["reviewBy", "review", "the day to re-check the offer"],
  ]) {
    const raw = page[field];
    if (raw === undefined) continue;
    if (!isRealIsoDate(raw)) {
      findings.push({
        kind: "invalid-date",
        signature: `invalid-date:${field}:${raw}`,
        message: `${code(field)} is ${raw === "" ? "empty" : code(clip(raw))}, not a date written ${code("YYYY-MM-DD")}`,
      });
    } else if (raw < today) {
      const days = daysBetween(raw, today);
      findings.push({
        kind,
        signature: `${kind}:${raw}`,
        message: `${code(`${field}: ${raw}`)} passed ${plural(days, "day", "days")} ago (${label})`,
        days,
      });
    }
  }

  if (page.linkedExam !== undefined) {
    const examCode = page.linkedExam.toUpperCase();
    if (!/^[A-Z]{2}-\d{3}$/.test(page.linkedExam)) {
      findings.push({
        kind: "invalid-exam",
        signature: `invalid-exam:${page.linkedExam}`,
        message: `${code("linkedExam")} is ${page.linkedExam === "" ? "empty" : code(clip(page.linkedExam))}, not an exam code in capitals such as ${code("AB-650")}`,
      });
    } else {
      const finding = examFinding(examCode, ctx, today);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Beta exam announcements (beta-exams.json)
// ---------------------------------------------------------------------------

/**
 * The exam page of a beta exam, in the shape of a page the report and the
 * tracker know: src/content/docs/<area>/<CODE>.mdx. The area is the entry's own
 * or, without one, the area the exam code prefix belongs to; when neither is
 * known the page is named with `<area>` and gets no link.
 */
export function examPageOf(examCode, entry) {
  const known = EXAM_AREAS.includes(entry?.area)
    ? entry.area
    : (AREA_BY_PREFIX[examCode.slice(0, 2)] ?? "");
  const area = known || "<area>";
  return {
    id: `${area}/${examCode}`,
    kind: "exam",
    slug: examCode,
    path: `${DISPLAY_DOCS_DIR}/${area}/${examCode}.mdx`,
    route: known ? `/certs/${known}/${examCode.toLowerCase()}/` : "",
    title: examCode,
  };
}

/**
 * The beta exams whose announcement is checked: every entry of beta-exams.json
 * with a usable exam code that is not flaggedGA, sorted by code.
 */
export function trackedBetaExams(beta) {
  return [...beta]
    .filter(
      ([examCode, entry]) =>
        EXAM_CODE_RE.test(examCode) && entry && entry.flaggedGA !== true,
    )
    .sort(([a], [b]) => byText(a, b));
}

/**
 * Whether a voucher page is the beta voucher of its exam: the documented title
 * is `Exam <CODE> (beta)` ("Beta voucher format" in AGENTS.md), matched here as
 * "(beta)" in any case. A voucher page that only links the exam (an event
 * voucher whose `linkedExam` is there so the review notices when the exam
 * leaves beta) is not one.
 */
export function isBetaVoucherPage(page) {
  return /\(beta\)/i.test(page.title ?? "");
}

/**
 * What is wrong with the Skills Hub announcement of each tracked beta exam
 * (trackedBetaExams), as [{ page, findings }] for the EXAM pages, sorted by exam
 * code. `pages` are the voucher pages under review. Kinds:
 *   beta-announcement-missing   no real `betaStart` day, or no valid `announcement`
 *   beta-announcement-overdue   `announcement` is "pending" more than
 *                               PENDING_ANNOUNCEMENT_DAYS days after `betaStart`
 *                               (an announcement is overdue from day 8)
 *   beta-voucher-mismatch       a BETA voucher page (isBetaVoucherPage: its title
 *                               contains "(beta)") links the exam (linkedExam)
 *                               while `announcement` is still "pending" or
 *                               "unannounced"; a voucher page that links the exam
 *                               without "(beta)" in its title is never matched
 */
export function betaAnnouncementFindings({ beta, pages, today }) {
  const vouchers = new Map();
  for (const page of pages) {
    if (
      page.unreadable ||
      !isBetaVoucherPage(page) ||
      !EXAM_CODE_RE.test(page.linkedExam ?? "")
    )
      continue;
    if (!vouchers.has(page.linkedExam))
      vouchers.set(page.linkedExam, new Set());
    vouchers.get(page.linkedExam).add(page.slug);
  }

  const results = [];
  for (const [examCode, entry] of trackedBetaExams(beta)) {
    const start = isRealIsoDate(entry.betaStart) ? entry.betaStart : "";
    let state = null;
    try {
      state = announcementState(entry.announcement);
    } catch {
      /* not a state: reported below */
    }
    const findings = [];

    if (!start || state === null) {
      const shown = (value) =>
        value === undefined || value === null || value === ""
          ? "missing"
          : code(clip(String(value)));
      const problems = [];
      if (!start) {
        problems.push(
          `${code("betaStart")} is ${shown(entry.betaStart)}, not a date written ${code("YYYY-MM-DD")}`,
        );
      }
      if (state === null) {
        problems.push(
          `${code("announcement")} is ${shown(entry.announcement)}, not ${code("pending")}, ${code("unannounced")} or the https address of the announcement`,
        );
      }
      findings.push({
        kind: "beta-announcement-missing",
        signature: `beta-announcement-missing:${examCode}`,
        message: `${code("beta-exams.json")} has no usable entry for beta exam ${code(examCode)}: ${problems.join("; ")}`,
      });
    }

    if (start && state === "pending") {
      const days = daysBetween(start, today);
      if (days > PENDING_ANNOUNCEMENT_DAYS) {
        findings.push({
          kind: "beta-announcement-overdue",
          signature: `beta-announcement-overdue:${examCode}:${start}`,
          message:
            `the exam page note of beta exam ${code(examCode)} still promises the Skills Hub blog announcement "within a few days", ` +
            `${plural(days, "day", "days")} after the beta began on ${start} (${code("announcement")} is ${code("pending")}); check the blog: ` +
            `if the post is out, set ${code("announcement")} to its address, run ${code(`node scripts/beta-note.mjs --code ${examCode} --expects "<wording>"`)} and add the beta voucher page; ` +
            `if there is none, set ${code("announcement")} to ${code("unannounced")} and run ${code(`node scripts/beta-note.mjs --code ${examCode}`)}`,
          days,
        });
      }
    }

    if (
      (state === "pending" || state === "unannounced") &&
      vouchers.has(examCode)
    ) {
      const slugs = [...vouchers.get(examCode)].sort(byText);
      findings.push({
        kind: "beta-voucher-mismatch",
        signature: `beta-voucher-mismatch:${examCode}`,
        message:
          `${plural(slugs.length, "beta voucher page", "beta voucher pages")} (${slugs.map(code).join(", ")}) ${slugs.length === 1 ? "is" : "are"} tied to beta exam ${code(examCode)} ` +
          `(${code("linkedExam")}), but ${code("announcement")} is still ${code(state)} in ${code("beta-exams.json")}: the exam page note was not switched`,
      });
    }

    if (findings.length > 0) {
      results.push({ page: examPageOf(examCode, entry), findings });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tracker and dedupe
// ---------------------------------------------------------------------------

/** The tracker's pages with their keys in a fixed order, so equal content is equal text. */
function sortPages(pages) {
  return Object.fromEntries(
    Object.entries(pages).sort(([a], [b]) => byText(a, b)),
  );
}

export function emptyTracker() {
  return { lastSynced: null, pages: {} };
}

// Keys an older version of the monitor wrote into the tracker and nothing reads
// any more (the weekly inventory of pages without a date is gone). A tracker
// that holds one loads without a word, whatever the key holds, and is rewritten
// once without it.
const LEGACY_TRACKER_KEYS = ["lastInventory"];

/** Validates a parsed tracker; throws ReviewError on anything unexpected. */
export function normalizeTracker(parsed) {
  const bad = (why) =>
    new ReviewError(
      `Corrupt tracker src/data_files/voucher-review.json (${why}).`,
    );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bad("not an object");
  }
  const date = (value, label) => {
    if (value === null || value === undefined) return null;
    if (!isRealIsoDate(value)) throw bad(`${label} is not a YYYY-MM-DD date`);
    return value;
  };
  if (
    !parsed.pages ||
    typeof parsed.pages !== "object" ||
    Array.isArray(parsed.pages)
  ) {
    throw bad('missing "pages" object');
  }
  const pages = {};
  for (const [id, entry] of Object.entries(parsed.pages)) {
    if (!entry || typeof entry !== "object")
      throw bad(`${id} is not an object`);
    const reasons = Array.isArray(entry.reasons) ? entry.reasons : null;
    if (!reasons || reasons.some((reason) => typeof reason !== "string")) {
      throw bad(`${id} has no list of reasons`);
    }
    const lastReported = date(entry.lastReported, `${id}.lastReported`);
    if (!lastReported) throw bad(`${id} has no lastReported date`);
    pages[id] = {
      firstReported:
        date(entry.firstReported, `${id}.firstReported`) ?? lastReported,
      lastReported,
      reasons: [...new Set(reasons)].sort(),
    };
  }
  return {
    lastSynced: date(parsed.lastSynced, "lastSynced"),
    pages: sortPages(pages),
  };
}

/**
 * The tracker file as { tracker, legacy }. A file that does not exist is the
 * first run: an empty tracker. `legacy` is true when the file still holds a key
 * of an older version of the monitor (LEGACY_TRACKER_KEYS), which the run drops
 * by rewriting the file once. Throws ReviewError for a corrupt file.
 */
export function readTracker(file) {
  if (!existsSync(file)) return { tracker: emptyTracker(), legacy: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ReviewError(
      "Corrupt tracker src/data_files/voucher-review.json (invalid JSON).",
    );
  }
  const tracker = normalizeTracker(parsed);
  return {
    tracker,
    legacy: LEGACY_TRACKER_KEYS.some((key) => Object.hasOwn(parsed, key)),
  };
}

export function loadTracker(file) {
  return readTracker(file).tracker;
}

/** The tracker as written to disk: the keys of the format and nothing else. */
export function trackerContent(tracker) {
  const written = {
    lastSynced: tracker.lastSynced ?? null,
    pages: tracker.pages ?? {},
  };
  return JSON.stringify(written, null, 2) + "\n";
}

/**
 * Which flagged pages go into today's issue.
 *   new       not in the tracker
 *   changed   a problem the last report did not contain (another date, a new reason)
 *   reminder  the same problems, reminderDays or more after the last report
 * A page with the same problems reported less than reminderDays ago stays quiet.
 * Returns the reports and the pages of the next tracker (only flagged pages).
 */
export function selectReports({
  flagged,
  tracker,
  today,
  reminderDays,
  reportAll = false,
}) {
  const reports = [];
  const nextPages = {};
  for (const { page, findings } of flagged) {
    const signatures = [...new Set(findings.map((f) => f.signature))].sort();
    const previous = tracker.pages[page.id];
    let status = null;
    if (reportAll) status = previous ? "reminder" : "new";
    else if (!previous) status = "new";
    else if (signatures.some((s) => !previous.reasons.includes(s))) {
      status = "changed";
    } else if (daysBetween(previous.lastReported, today) >= reminderDays) {
      status = "reminder";
    }

    if (status) {
      reports.push({
        page,
        findings,
        status,
        firstReported: previous?.firstReported ?? today,
      });
      nextPages[page.id] = {
        firstReported: previous?.firstReported ?? today,
        lastReported: today,
        reasons: signatures,
      };
    } else {
      // Quiet today. If a problem went away, remember the shorter list so it
      // counts as new when it comes back.
      nextPages[page.id] = { ...previous, reasons: signatures };
    }
  }
  return { reports, nextPages };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** A title taken from a page, for a table cell of a public issue. */
function safeText(text) {
  return String(text)
    .replace(/[<>`[\]|]/g, " ")
    .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
    .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE)
    .replace(/\s+/g, " ")
    .trim();
}

// Astro lowercases collection IDs, so a file name with capitals is served in lowercase.
const pageUrl = (cfg, page) =>
  `${cfg.siteUrl}${page.route ?? `/certs/vouchers/${encodeURIComponent(page.slug.toLowerCase())}/`}`;

// An exam page of an area that is not known has no address to link.
const pageCell = (cfg, page) =>
  `${page.route === "" ? safeText(page.title) : `[${safeText(page.title)}](${pageUrl(cfg, page)})`}<br>${code(page.path)}`;

// The sidebar lists voucher pages; an exam page is not in it.
const sidebarCell = (page, sidebar) =>
  page.kind === "exam"
    ? "n/a"
    : sidebar
      ? sidebar.has(page.slug)
        ? "yes"
        : "no"
      : "?";

const STATUS_TEXT = {
  new: "new",
  changed: "changed since the last report",
};

const statusCell = (report) =>
  report.status === "reminder"
    ? `reminder (first reported ${report.firstReported})`
    : STATUS_TEXT[report.status];

const ENDED_OPTIONS = [
  "1. **The offer is still on or was extended:** put the official last day in the page's frontmatter as " +
    "`voucherEnds: YYYY-MM-DD` (for a temporary offer with no stated end date, the day to look at it again as " +
    "`reviewBy: YYYY-MM-DD`) and update the page text to match the official source. If it turned out to be a stable " +
    "offer (a standing programme), take the date fields off the page instead: a page that declares none is not " +
    "reviewed. The page leaves this list on the next run.",
  "2. **The offer has ended and the page stays as a record** (what commit `36e2c83d` did for `levelup`): remove " +
    "`voucherCategory` from the frontmatter, which is what takes the page off the voucher index and the " +
    "landing-page list; add `(Expired)` to the `title`; replace the availability note with a `:::caution` box " +
    "saying the offer is no longer active; and remove its entry from `voucherItems` in " +
    "`src/data_files/docs-sidebar.ts`. This monitor does not review pages that have no `voucherCategory`.",
  "3. **The offer has ended and the page goes away** (what was done for `fabricdatadays` in `12b11a4d`, " +
    "`defendersweepstakes` in `36e2c83d`, `ab650beta` in `5a447884`, `ai500beta` in `39dcb9d2` and many more): " +
    "delete the `.mdx` file; remove its entry from `voucherItems` in `src/data_files/docs-sidebar.ts`; for a page " +
    'that other sites or the blog may link to, add a redirect `"/vouchers/<slug>/": "/certs/vouchers/"` to ' +
    "`redirects` in `astro.config.mjs` (the repo has them for `fabricdatadays`, `defendersweepstakes`, " +
    "`aichallenge` and `microsoftignite`); and remove or turn into plain text every link to the page, including " +
    "exam pages and `src/content/blog/` (a dangling internal link fails the link checker on the pull request).",
];

const BETA_KINDS = [
  "beta-announcement-overdue",
  "beta-announcement-missing",
  "beta-voucher-mismatch",
];

function editSection(kinds) {
  const has = (...names) => names.some((name) => kinds.has(name));
  const lines = ["### What to edit", ""];
  // The offer's official source is the voucher pages' business; the beta
  // announcement findings come with their own advice below.
  if ([...kinds].some((kind) => !BETA_KINDS.includes(kind))) {
    lines.push(
      "Start from the offer's official source (the announcement or offer page the voucher page links to) and decide:",
      "",
    );
  }
  if (
    has(
      "ended",
      "review",
      "exam-ga",
      "exam-learn-ga",
      "exam-retired",
      "exam-retiring",
    )
  ) {
    lines.push(...ENDED_OPTIONS, "");
  }
  if (has("review")) {
    lines.push(
      'A passed `reviewBy` only means "look again": if the offer is unchanged and still temporary, move `reviewBy` to the ' +
        "next check date; if it turned out to be a stable offer, take `reviewBy` off (a page without date fields is not reviewed).",
      "",
    );
  }
  if (has("exam-ga", "exam-learn-ga", "exam-retired", "exam-retiring")) {
    lines.push(
      "For a page with a `linkedExam`: once the exam's beta is over or the exam retires, its beta voucher window is " +
        "normally over too, so treat the page as an ended offer (option 2 or 3). If the page is still valid, change or " +
        "remove `linkedExam`. When Microsoft Learn already shows the exam as generally available but `exam-status.mjs` " +
        'still says BETA, the exam page also needs the steps of "Beta exam tracker" > "Working the list" in `docs/monitors/beta-and-retiring-exams.md`.',
      "",
    );
  }
  if (has("exam-unknown", "invalid-date", "invalid-exam", "unreadable")) {
    lines.push(
      "Fix the frontmatter: dates are written `YYYY-MM-DD`, `linkedExam` is an exam code in capitals such as `AB-650` " +
        "that has a page at `src/content/docs/<area>/<CODE>.mdx`, and the page needs a frontmatter block. " +
        "The site build rejects malformed values too.",
      "",
    );
  }
  if (has("beta-announcement-overdue", "beta-voucher-mismatch")) {
    lines.push(
      `For a beta exam whose announcement is overdue or whose beta voucher page exists, open the [Skills Hub blog](${SKILLS_HUB_BLOG_URL}) ` +
        "and look for the announcement of the exam (the post with the discount code):",
      "",
      "- **The post is out:** set `announcement` of the exam in `src/data_files/beta-exams.json` to its address (with the " +
        "`?WT.mc_id=studentamb_165290` parameter), print the new note with " +
        '`node scripts/beta-note.mjs --code <CODE> --expects "<Microsoft\'s go-live wording>"` (leave out `--expects` when ' +
        "the post names no go-live date or month) and put it on the exam page in place of the old `:::note`, directly after " +
        'the beta `:::tip`. Then add the beta voucher page ("Beta voucher format" under "Voucher Pages" in `AGENTS.md`, with ' +
        "`voucherEnds` and `linkedExam`) and link it from the exam page.",
      '- **There is no post:** set `announcement` to `"unannounced"` and print the note again with ' +
        "`node scripts/beta-note.mjs --code <CODE>`, so the page stops promising a post.",
      "",
    );
  }
  if (has("beta-voucher-mismatch")) {
    lines.push(
      "A beta voucher page (its `title` contains `(beta)`, as in `Exam <CODE> (beta)`) that is tied to the exam (`linkedExam`) " +
        "while the announcement is still `pending` or `unannounced` stays in this list until `announcement` holds the address " +
        "of the post: the voucher page is the sign that the post is out. A voucher page without `(beta)` in its title, an " +
        "event voucher say, is never matched, whatever its `linkedExam`.",
      "",
    );
  }
  if (has("beta-announcement-missing")) {
    lines.push(
      "Every beta exam in `src/data_files/beta-exams.json` needs `betaStart` (`YYYY-MM-DD`, the day the beta period began, " +
        'from the official source, never guessed) and `announcement` (`"pending"`, `"unannounced"` or the address of the ' +
        "announcement). Set them and print the note with `node scripts/beta-note.mjs --code <CODE>`.",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * The issue body.
 * @param cfg        config (siteUrl, reminderDays)
 * @param today      YYYY-MM-DD
 * @param reviewed   number of pages reviewed (those with a voucherCategory)
 * @param reports    [{ page, findings, status, firstReported }]
 * @param sidebar    Set of voucher slugs linked in the sidebar, or null
 */
export function buildReport({ cfg, today, reviewed, reports, sidebar }) {
  const out = [
    `## Voucher review: ${today}`,
    "",
    `The daily voucher review (\`scripts/voucher-review-check.mjs\`) looked at the ${reviewed} pages in ` +
      `\`${DISPLAY_VOUCHER_DIR}/\` that have a \`voucherCategory\` (the ones on the voucher index and the landing page) ` +
      "and at the Skills Hub announcement of every beta exam in `src/data_files/beta-exams.json` (findings about a beta exam are about its exam page). " +
      "A voucher page is reviewed only for the dates and the linked exam it declares: a stable offer, which declares none, is not asked for anything and is not listed. " +
      `A page whose problem stays the same is listed again after ${cfg.reminderDays} days, not every day. ` +
      "This issue is a running thread: every later report is added as a comment, and the review closes it " +
      "when no page has a problem.",
    "",
  ];

  if (reports.length > 0) {
    out.push(
      `### Pages that need action (${reports.length})`,
      "",
      "| Page | What is wrong | Status | In sidebar |",
      "|------|---------------|--------|------------|",
    );
    for (const report of reports) {
      out.push(
        `| ${pageCell(cfg, report.page)} | ${report.findings.map((f) => f.message).join("<br>")} | ` +
          `${statusCell(report)} | ${sidebarCell(report.page, sidebar)} |`,
      );
    }
    const kinds = new Set(
      reports.flatMap((report) => report.findings.map((f) => f.kind)),
    );
    out.push("", editSection(kinds));
  }

  out.push(
    'See the "Voucher Review Monitor" runbook (`docs/monitors/voucher-review.md`) for how the review works and "Voucher Pages" in `AGENTS.md` for the fields.',
    "",
  );
  return out.join("\n");
}

/** Issue title: the slugs of the pages that need action (a count when they are many). */
export function buildIssueTitle({ today, reports }) {
  const joined = reports.map((report) => safeText(report.page.slug)).join(", ");
  const pages =
    joined.length <= 100
      ? joined
      : `${plural(reports.length, "page", "pages")} need action`;
  return `Voucher review ${today}: ${pages}`;
}

// ---------------------------------------------------------------------------
// Issues (through the gh CLI)
// ---------------------------------------------------------------------------

/** The running issue the reports go to: runs find the open one by this exact title. */
export const REVIEW_ISSUE_TITLE = "Voucher review: pages need attention";
export const REVIEW_ISSUE_LABEL = "enhancement";
/** The issue that says the review itself could not run. */
export const FAILED_ISSUE_TITLE = "Voucher review: the check failed";
export const FAILED_ISSUE_LABEL = "bug";

/**
 * Bring one issue in line with the state, through `gh(args, stdin)`:
 *   active, none open   create ONE issue (title, label) with `body`;
 *   active, one open    add `commentBody` as a comment, never a second issue (with
 *                       several open copies, to the oldest only);
 *   inactive, some open close each with `closeComment`.
 * Not `enabled` (no CREATE_ISSUES, or DRY_RUN): touch nothing, not even to read. When the
 * issue is needed a failed lookup or write throws (nothing else was committed yet); when
 * it is only being closed a failure is reported in the result and the next run retries.
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

/**
 * The running review issue after a successful check: report -> create or comment; no page
 * with a problem -> close, however many pages declare no date (a stable offer); anything
 * else leaves it as it is.
 */
export function syncReviewIssue(cfg, gh, result) {
  const enabled = cfg.createIssues && !cfg.dryRun;
  if (!result.changesFound && !result.allClear) {
    return { action: "none", number: null, closed: [], error: null };
  }
  return syncIssue({
    gh,
    enabled,
    title: REVIEW_ISSUE_TITLE,
    label: REVIEW_ISSUE_LABEL,
    labelColor: "a2eeef",
    labelDescription: "New feature or request",
    active: result.changesFound,
    body: result.report ?? "",
    closeComment: `No page has a problem as of ${cfg.today}, so there is nothing left to review. Closing this issue; the next finding opens a new one.${runLink(cfg)}`,
  });
}

/**
 * The failure issue: after a failed check, create it or add a comment (one issue, not one
 * per run); after a healthy check, close it. `message` is the text of the failure, or null
 * for a healthy run.
 */
export function syncFailureIssue(cfg, gh, message) {
  const enabled = cfg.createIssues && !cfg.dryRun;
  const failed = message !== null;
  return syncIssue({
    gh,
    enabled,
    title: FAILED_ISSUE_TITLE,
    label: FAILED_ISSUE_LABEL,
    labelColor: "d73a4a",
    labelDescription: "Something isn't working",
    active: failed,
    body: failed
      ? `The daily voucher review could not run on ${cfg.today}. No page was reported and the tracker was not written, so nothing was lost: the next healthy run continues where the last one stopped.\n\n**Why:** ${message}${runLink(cfg)}\n\nThis issue gets one comment per failed run and closes itself after the next healthy run.`
      : "",
    commentBody: failed
      ? `The voucher review failed again on ${cfg.today}:\n\n${message}${runLink(cfg)}`
      : "",
    closeComment: `The voucher review ran normally on ${cfg.today}. Closing this issue.${runLink(cfg)}`,
  });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** Slugs of the voucher pages linked in docs-sidebar.ts, or null when unreadable. */
export function readSidebarSlugs(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const slugs = new Set();
  for (const match of source.matchAll(
    /docsPath\(\s*["'`]vouchers\/([^"'`/)\s]+)\/?["'`]\s*\)/g,
  )) {
    slugs.add(match[1]);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * One review. Writes the report (when there is something to say) and the
 * tracker (when it changed) and returns what it decided; throws ReviewError
 * when the check itself cannot run.
 */
export async function run(cfg) {
  const { tracker, legacy } = readTracker(cfg.trackerFile);
  const pages = listVoucherPages(join(cfg.docsDir, "vouchers"));

  const live = pages.filter(
    (page) => !page.draft && (page.category !== "" || page.unreadable),
  );
  const notReviewed = pages.filter((page) => !live.includes(page));
  const needsExams = live.some(
    (page) =>
      !page.unreadable && /^[A-Z]{2}-\d{3}$/.test(page.linkedExam ?? ""),
  );
  // The beta exams are checked on every run, the rest of the exam state only
  // for the exams a voucher page links.
  const beta = loadBetaExams(cfg);
  const ctx = needsExams ? await loadExamContext(cfg, beta) : null;

  // A page is reviewed for what it declares (voucherEnds, reviewBy, linkedExam),
  // so a page that declares none is a stable offer: no finding, in no list.
  const flagged = [];
  for (const page of live) {
    const findings = pageFindings(page, ctx, cfg.today);
    if (findings.length > 0) flagged.push({ page, findings });
  }
  const betaFlagged = betaAnnouncementFindings({
    beta,
    pages: live,
    today: cfg.today,
  });
  flagged.push(...betaFlagged);

  const { reports, nextPages } = selectReports({
    flagged,
    tracker,
    today: cfg.today,
    reminderDays: cfg.reminderDays,
    reportAll: cfg.reportAll,
  });

  const next = { lastSynced: tracker.lastSynced, pages: sortPages(nextPages) };
  // A tracker that still holds a key of an older version is rewritten once,
  // without it; otherwise only a change of what it records is a change.
  const changed =
    legacy ||
    trackerContent({ ...next, lastSynced: null }) !==
      trackerContent({ ...tracker, lastSynced: null });
  if (changed) next.lastSynced = cfg.today;

  const reviewed = live.length;
  const changesFound = reports.length > 0;

  let issueTitle = "";
  let report = null;
  if (changesFound) {
    issueTitle = buildIssueTitle({ today: cfg.today, reports });
    report = buildReport({
      cfg,
      today: cfg.today,
      reviewed,
      reports,
      sidebar: readSidebarSlugs(cfg.sidebarFile),
    });
    writeFileSync(cfg.reportFile, report, "utf8");
  }
  if (changed) writeFileSync(cfg.trackerFile, trackerContent(next), "utf8");

  return {
    reviewed,
    notReviewed: notReviewed.map((page) => page.slug),
    betaChecked: trackedBetaExams(beta).length,
    betaFlagged: betaFlagged.length,
    flagged: flagged.length,
    reports,
    changesFound,
    // no page has a problem: the running issue can close
    allClear: flagged.length === 0,
    changed,
    issueTitle,
    report,
  };
}

function handleFailure(cfg, error) {
  const message =
    error instanceof ReviewError
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
  // One issue for a failing check, a comment for every further failed run. If the gh CLI is
  // what failed, this fails too and the red run is all that is left.
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

/** One line for the log about what happened to an issue. */
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

async function main(cfg) {
  console.log("=== Voucher Review ===");
  console.log(`Started: ${new Date().toISOString()} · date used: ${cfg.today}`);

  const result = await run(cfg);

  console.log(
    `Reviewed ${result.reviewed} voucher pages with a voucherCategory` +
      (result.notReviewed.length > 0
        ? ` (skipped, no voucherCategory or draft: ${result.notReviewed.join(", ")})`
        : "") +
      ".",
  );
  console.log(
    `${plural(result.flagged, "page", "pages")} with a problem, ${result.reports.length} reported today` +
      (result.reports.length > 0
        ? ` (${result.reports.map((r) => `${r.page.slug}: ${r.status}`).join(", ")})`
        : "") +
      ".",
  );
  console.log(
    `${plural(result.betaChecked, "beta exam", "beta exams")} in beta-exams.json checked for the state of the Skills Hub announcement, ` +
      `${result.betaFlagged} with a problem.`,
  );

  // The issue comes BEFORE the outputs and before the workflow commits the tracker: when it
  // fails the run fails, the commit is skipped and the next run reports the same pages again.
  const gh = makeGh({ ghCliScript: cfg.ghCliScript });
  const review = syncReviewIssue(cfg, gh, result);
  const reviewLine = describeIssue(
    `Review issue "${REVIEW_ISSUE_TITLE}"`,
    review,
    cfg,
  );
  if (reviewLine) console.log(reviewLine);
  // a healthy run ends the "check failed" alert; a failed lookup or close is only reported
  const recovered = syncFailureIssue(cfg, gh, null);
  const recoveredLine = describeIssue(
    `Failure issue "${FAILED_ISSUE_TITLE}"`,
    recovered,
    cfg,
  );
  if (recoveredLine && recovered.action !== "skipped") {
    console.log(recoveredLine);
  }

  writeOutput(cfg.githubOutput, {
    changes_found: result.changesFound,
    baseline_updated: result.changed,
    extraction_failed: false,
    issue_title: result.issueTitle,
  });
  if (result.changesFound) console.log(`Report headline: ${result.issueTitle}`);
  console.log(result.changed ? "Tracker updated" : "Tracker unchanged");
  console.log("=== Done ===");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
