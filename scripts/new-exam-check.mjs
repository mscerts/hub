#!/usr/bin/env node
/**
 * Daily check for new exams (and certifications) published to Microsoft Learn,
 * for changed study guides of the exams the hub covers, and for DRIFT: hub exam
 * pages that no longer say what Learn says (see "Hub vs Learn drift" below).
 *
 * Usage:
 *   node scripts/new-exam-check.mjs
 *
 * Microsoft publishes new exams, usually as a beta with a short discounted
 * voucher window, without any feed. This monitor lists every credential on
 * Microsoft Learn, reads each certification page to find the exams behind it,
 * and diffs the result against src/data_files/learn-exams.json. An exam code
 * (or certification slug) that is not in the tracker yet is reported once in a
 * GitHub issue so the maintainers can create the exam page quickly.
 *
 * Study guides (/credentials/certifications/resources/study-guides/<code>) are
 * watched in two ways, both driven by the credentials sitemap:
 *   (A) A guide for a code that is not a tracked exam is an EARLIER new-exam
 *       signal (a guide can be published before any certification page lists
 *       the exam). The code is alerted like any new exam and recorded in the
 *       tracker with `certifications: []`, so the certification page that lists
 *       it later enriches the same record instead of alerting a second time.
 *   (B) For an exam the hub already covers (src/content/docs/<area>/<CODE>.mdx
 *       exists) the "Notices" (callout boxes), "Updates to the exam" and "Skills
 *       measured" text of its guide is hashed. Every covered guide is read every
 *       run, with a conditional request (If-Modified-Since, the Last-Modified of
 *       the last read) so an unchanged page answers 304 without a body: the
 *       sitemap <lastmod> lags the page, so it cannot be the trigger (it only
 *       forces a full read). A changed hash of the normalized text is the
 *       decision, and the report shows a compact line diff of what changed. The
 *       normalized lines are stored in the tracker because a hash alone cannot
 *       produce a diff.
 *
 * Data sources (all on learn.microsoft.com, no authentication):
 *   1. Listing: /api/contentbrowser/search/credentials?locale=en-us&$top=100,
 *      followed through "@nextLink". Gives every certification (uid, title,
 *      products, a partial `exams` array) and 19 standalone "examination"
 *      items (uid exam.<code>, official name). Applied Skills are ignored; the
 *      Applied Skills monitor owns them.
 *   2. Certification pages: /en-us/credentials/certifications/<slug>/ for every
 *      certification. The exams behind a certification come from the union of
 *      what a page exposes: <meta name="learn_exam"> and exam cards (new
 *      layout only, these carry the official name and the "(beta)" marker),
 *      and the `examUid=exam.<CODE>` of the "Schedule through Pearson VUE"
 *      link (every layout; classic pages publish no exam name at all). Callout
 *      boxes with an external link about a beta or new exam become
 *      announcement links.
 *   3. Exam page, then study guide (only for a NEW exam that is about to be
 *      alerted and lacks a name, a beta status or a confirmed exam page): the
 *      exam page title "Exam <CODE>: <name> (beta)" gives the name, the beta
 *      marker and proves the exam page exists (many exams have none: the URL
 *      then 404s or redirects to the certification page). The study guide title
 *      "Study guide for Exam <CODE>: <name>" only gives the name; it never
 *      carries the "(beta)" marker.
 *   4. Study guides: the sitemap index /_sitemaps/sitemapindex.xml, then every
 *      credentials_en-us_<n>.xml it lists (the file name is never hard-coded;
 *      only the path of an entry is used, always against LEARN_BASE_URL). Each
 *      certification study guide URL gives an exam code and its <lastmod>; the
 *      Applied Skills guides (.../applied-skills/resources/study-guides/apl-NNNN)
 *      are ignored. A guide page is /en-us/credentials/certifications/resources/
 *      study-guides/<code>; it is only fetched for an exam the hub covers, every
 *      run (see (B)). Its notices, "Updates to the exam" ("About the exam" on
 *      newer guides) and "Skills measured" sections (see parseStudyGuide) become
 *      normalized text lines, which are hashed.
 *
 * Rules applied every run:
 *   - First run (no tracker, or an empty one): record everything as a silent
 *     baseline. No issue is opened. The first run that finds no study guide in
 *     the tracker (an older tracker) baselines the guides the same way, silently,
 *     and never counts them toward the "too many new exams" failsafe.
 *   - A "new exam" is a code that is not in the tracker; a "new certification"
 *     is a slug that is not in the tracker (even if it lists no exam yet).
 *   - A new exam is alerted unless its prefix is in IGNORED_PREFIXES (Office/MOS
 *     MO-*, legacy 77-*, 98-*, ...) or it already has a page in
 *     src/content/docs/<area>/<CODE>.mdx. A prefix that is neither mapped to a
 *     hub area (AREA_BY_PREFIX) nor ignored is a NEW exam family: it is alerted
 *     with a note to map or ignore the prefix, never silenced. New MOS
 *     certifications and certifications whose exams are all in ignored families
 *     are tracked without an alert.
 *   - The beta status is only stated when a source positively knows it (exam
 *     card, standalone listing item, exam page title, beta callout, a beta
 *     certification with a single exam). Otherwise the report says "unknown".
 *   - The exam link in the tracker and the report is the exam page only when
 *     it is confirmed (exam card link, standalone listing item, or an exam page
 *     that answers with an "Exam <CODE>:" title); otherwise the report links the
 *     certification page and the tracker `url` stays empty.
 *   - A fetch failure is never evidence of anything: a certification page that
 *     cannot be read, or that lists no exam although the tracker knew some,
 *     keeps the exam list from the previous tracker (with a warning).
 *   - Exams that disappear from Learn stay in the tracker; the retiring-exam
 *     tracker owns retirements.
 *   - Study guide codes the tracker does not know are new exams (alerted by the
 *     same rules; evidence "study guide") and are recorded with
 *     `certifications: []`, so the certification page that lists them later only
 *     enriches the record. The report marks the evidence of every new exam:
 *     "certification page", "study guide" or both.
 *   - A study guide of a covered exam alerts only when the HASH of its
 *     normalized text changed. The text is the "Updates to the exam" and "Skills
 *     measured" sections plus the notices of the guide: the warning, note and
 *     important boxes outside those sections (before the first heading and under
 *     "Purpose of this document"), where Microsoft announces a retirement, a
 *     transition to another exam, a certification rename or a cancelled beta
 *     (see parseStudyGuide). A moved date (sitemap, page) with identical text is
 *     recorded silently. The first hash of a guide is recorded silently. A guide
 *     that cannot be fetched or parsed keeps its previous record (a fetch
 *     failure is never evidence of anything). A guide that lost a section it had
 *     keeps its previous record too, with no alert: it warns loudly, every run,
 *     until the section is back or FORCE_GUIDE_BASELINE accepts the new text
 *     (the loss may be a broken page rather than a change).
 *   - A sitemap problem (index or file unreadable, fewer than MIN_STUDY_GUIDES
 *     guides) skips all study guide logic for the run with a loud warning (log,
 *     workflow annotation, job summary); the exam detection is not affected, and
 *     guide_check_failed=skipped says that no guide was checked.
 *   - The study guide failsafe below never blocks the exam detection either:
 *     it discards the guide results of the run, keeps every guide record as it
 *     was, and reports itself (guide_check_failed=true, ERROR_FILE, log, job
 *     summary) while new exams and certifications are alerted and tracked as
 *     usual.
 *   - Nothing taken from a guide is ever a beta start date: the report quotes
 *     dated statements verbatim as "from the study guide".
 *
 * Failsafes that fail the run (no tracker write, extraction_failed=true):
 *   - listing unreachable / unparsable, or fewer than MIN_CERTIFICATIONS;
 *   - more than (100 - MIN_PAGE_OK_PCT)% of the certification pages unreadable
 *     (a baseline needs MIN_BASELINE_PAGE_OK_PCT), checked while fetching so a
 *     degraded Learn stops the run early;
 *   - RUN_DEADLINE_MS spent on the listing and the certification pages;
 *   - more than MAX_EMPTY_PAGE_PCT of the certifications the tracker knew exams
 *     for were read but yielded no exam (the exam markup probably changed);
 *   - more than MAX_NEW_EXAMS / MAX_NEW_CERTS, or MAX_NEW_PCT of the tracked
 *     records, are new at once (a structure change, not news); only exams that
 *     would be alerted count, so Office and legacy families (MO-*, 70-*), which
 *     come in bunches, and exams that already have a hub page do not;
 *   - a corrupt tracker.
 *
 * Failsafe that only stops the study guide part (guide_check_failed=true, exit
 * code 0, guide records untouched, no guide alert):
 *   - more than MAX_GUIDE_CHANGES covered study guides (or, with at least 10
 *     tracked, more than MAX_GUIDE_CHANGE_PCT of them) look different in one
 *     run: a changed text hash, a page that no longer parses, or a lost section.
 *     That is a markup or normalization change on Learn, not news. The way out
 *     is FORCE_GUIDE_BASELINE, which re-reads every covered guide in full and
 *     records the new text silently (a lost section is accepted too) without
 *     touching the exam detection. A page that does not parse is never
 *     recorded: a few of them only warn, many of them keep tripping the
 *     failsafe until the parser is fixed.
 *
 * Hub vs Learn drift ("Step 7", see evaluateDrift). Everything above compares
 * Learn with its OWN previous copy; this step compares what Learn says NOW with
 * what the hub pages say, for every exam that has a hub page, and keeps ONE
 * running GitHub issue ("Learn drift: hub pages need updating", label
 * enhancement, no assignee) in line with the differences, through `gh`
 * (CREATE_ISSUES=1 and a GH_TOKEN; never with DRY_RUN=1), like
 * scripts/voucher-review-check.mjs: created when there is something to fix or
 * check, its text edited and a comment added when the set of rows changes,
 * closed with a comment when nothing is left. It uses facts the run already has
 * (tracker, scan, study guide text) plus the hub files (exam pages,
 * exam-status.mjs, beta-exams.json, retiring-exams.json); the only extra
 * requests are the exam pages of the exams the hub marks BETA or UPCOMING (at
 * most 8) and, for an UPCOMING exam the sitemap does not list, its study guide
 * page (published before the sitemap lists it: GH-700). Kinds of drift:
 *   - NAME: the study guide title (and heading) and the certification page or
 *     listing name vs the hub description and Get Started card title;
 *   - CERTIFICATION: a certification that lists a hub exam was renamed since the
 *     last run (old -> new, kept CERT_RENAME_DAYS); the hub text vs Learn only
 *     as an informational row;
 *   - BETA: Learn marks the exam beta and the hub does not, or the hub says BETA
 *     (exam-status.mjs, beta-exams.json) and Learn shows no marker; evidence
 *     that disagrees is "unclear", never a definite mismatch;
 *   - NOTICE: a retirement date, a transition to another exam, a certification
 *     rename or a cancellation in the notices of a study guide vs the badge,
 *     retiring-exams.json and the page banner (a date already tracked correctly
 *     raises nothing); the row names the edits, the script never edits a file;
 *   - STATUS: the RETIRING / RETIRED badge against the retirement date. An exam
 *     still RETIRING whose retirement date (retiring-exams.json, or Learn's
 *     notice when the hub tracks none) is before today (UTC, the cut-off of the
 *     RetirementBanner and of the retiring monitor) -> "switch the badge to
 *     RETIRED"; an exam already RETIRED whose date (the tracker's or Learn's)
 *     has not passed -> "badge ahead of date". A RETIRED badge is treated like a
 *     RETIRING one by the NOTICE check (Learn's retired notice raises nothing
 *     when the tracker has its date);
 *   - UPCOMING / AT RISK: an UPCOMING exam that shows up on Learn (exam page,
 *     certification page, study guide in the sitemap or as a page of its own,
 *     listing), an AT RISK banner that calls an
 *     exam "potential" that Learn lists now;
 *   - EFFECTIVE DATES: dated statements of the notices, "Updates to the exam" and
 *     the skills heading ("Skills measured as of <date>", "registration closes
 *     <date>") are stored; a row appears EFFECTIVE_LEAD_DAYS before the date and
 *     leaves EFFECTIVE_GRACE_DAYS after it.
 * Acknowledged drift: src/data_files/drift-acknowledged.json is a hand-kept list
 * of [{ code, kind, reason, since }] ("AB-210", "beta", "maintainer: GA, Learn
 * callout is stale", "2026-10-14") that silences one drift kind (name, beta,
 * notice, status, upcoming, at-risk, certification, effective) for one exam when
 * the maintainers have decided that the hub is right and Learn is stale or
 * wrong. Every item of that kind for that exam is dropped from the issue, the
 * failsafe count and drift_items; each run lists what it suppressed as
 * "acknowledged" in the log and the job summary, and an acknowledgement that
 * matched nothing is listed as well, so none is forgotten. The file is validated
 * on every run: invalid JSON, a missing or unknown key, an unknown kind, a code
 * that is not an exam code, a `since` that is not a real day or a duplicate
 * (code, kind) pair is a DriftInputError, i.e. the drift check does not run and
 * the "could not run" issue says why (loud, never a silent no-op). A missing
 * file is an empty list.
 * A fetch failure, a guide carried forward from an earlier read or a missing
 * field is never drift. The first run reports the problems that already exist
 * (only the NEW-exam alerts are silent then). Failsafe: more than MAX_DRIFT new
 * rows (rows the running issue does not list yet, or the one a maintainer closed
 * by hand while it still holds a new issue back, see below), or MAX_DRIFT_DATES
 * new dated reminders, at once = a naming or markup change, not news: the
 * running issue is not touched and a bug issue ("Learn drift: the check could
 * not run") says so (drift_check_failed=true, DRIFT_ERROR_FILE); FORCE_DRIFT=1
 * accepts the list.
 * The drift step never fails the exam or study guide checks: when `gh` fails
 * while its issues are kept up to date (lookup, create, edit, comment or close,
 * each is annotated), the run still writes its outputs (the exam issue and the
 * tracker commit go ahead) and sets drift_issue_failed=true, which fails the
 * workflow at its last step; the next run does the work again.
 * A maintainer who closes the drift issue by hand while rows remain is not
 * answered with a new issue every day: none is created for DRIFT_REMINDER_DAYS
 * (7) unless a row is new, and the monitor clears the row list in the text of
 * an issue it closes itself so a relapse after that opens one at once.
 *
 * Tracker (src/data_files/learn-exams.json), sorted by code / slug:
 *   { lastSynced, certifications: [{ slug, title, beta, products, exams,
 *     firstSeen, lastSeen }], exams: [{ code, name, beta, betaEvidence,
 *     certifications, products, url, announcements, firstSeen, lastSeen }],
 *     studyGuides: [{ code, name?, headingName?, lastmod, hash, updatedAt,
 *     lastModified?, firstSeen, lastChanged, missing?, lines? }],
 *     certRenames: [{ slug, from, to, firstSeen }],
 *     effectiveDates: [{ code, date, sentence, firstSeen }] }
 *   The file is only rewritten when something other than lastSynced / lastSeen
 *   changed, so an unchanged Learn never produces a daily diff. `lastSeen` is
 *   refreshed whenever the file is rewritten for another reason: it means
 *   "still listed on that date or later", and a record that stopped being
 *   listed keeps its old date. `name` is empty when Learn does not publish it
 *   on the certification page and no lookup supplied it; `url` is empty until
 *   an exam page is confirmed; `beta` is false while the status is unknown.
 *   Study guide records: `lastmod` is the sitemap date, `hash` the SHA-256 of
 *   the normalized text (the "Notices" boxes, "Updates to the exam" and "Skills
 *   measured"; null until the guide was fetched: guides of exams the hub does
 *   not cover are tracked by date only), `updatedAt` the page's
 *   <meta name="updated_at">, `lastModified` the Last-Modified header of the
 *   page when it was last read (sent back as If-Modified-Since; it moves when
 *   Learn republishes the page, with or without a text change), `lastChanged`
 *   the day the hash last changed (null at baseline), `missing` the sections
 *   not found in the markup ("updates", "skills") and `lines` the normalized
 *   text the hash covers, kept to render the diff. A tracker without
 *   `studyGuides` is valid and gets them baselined. `name` is the exam name of
 *   the guide's page title ("Study guide for Exam CODE: name") and `headingName`
 *   the one of the page's own heading, stored only when the two differ (neither
 *   is part of the hash; the drift check compares them with the hub page).
 *   Drift facts: an exam's `betaEvidence` is what the pages read this run said
 *   about its beta status ("card:beta", "card:ga", "listing:beta",
 *   "listing:ga", "callout:beta", "certification-title:beta", "exam-page:beta",
 *   "exam-page:ga"; unlike `beta` it is not sticky, except that the exam-page
 *   tags of an exam whose exam page probe got no answer stay: a failed probe is
 *   never evidence); `certRenames` are the
 *   certification title changes seen, kept CERT_RENAME_DAYS days;
 *   `effectiveDates` are the dated statements of the covered guides from
 *   EFFECTIVE_GRACE_DAYS ago to EFFECTIVE_HORIZON_DAYS ahead. A tracker written
 *   before the drift check has none of these and loads fine.
 *
 * Env overrides (defaults shown):
 *   LEARN_BASE_URL       https://learn.microsoft.com
 *   TRACKER_FILE         src/data_files/learn-exams.json
 *   DOCS_DIR             src/content/docs
 *   REPORT_FILE          <tmpdir>/new-exam-report.md
 *   ERROR_FILE           <tmpdir>/new-exam-error.md
 *   GITHUB_OUTPUT        <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY  unset (when set, a baseline run appends the exams it
 *                        swallowed silently to it, and a run appends what the
 *                        study guide check wants seen: a skipped check, a
 *                        tripped failsafe, a guide baseline, unreadable,
 *                        unparsable or degraded guides)
 *   MIN_CERTIFICATIONS   50
 *   MIN_PAGE_OK_PCT      80
 *   MIN_BASELINE_PAGE_OK_PCT 95  (a silent baseline is permanent: it needs
 *                        nearly every page)
 *   MAX_EMPTY_PAGE_PCT   25
 *   MAX_NEW_EXAMS        15  (only exams that would be alerted count)
 *   MAX_NEW_CERTS        15  (MOS certifications do not count)
 *   MAX_NEW_PCT          25
 *   MIN_STUDY_GUIDES     40  (fewer certification guides in the sitemap = the
 *                        sitemap is not trusted, study guide logic is skipped)
 *   MAX_GUIDE_CHANGES    15  (covered guides that look different in one run)
 *   MAX_GUIDE_CHANGE_PCT 25  (same, as a share of the covered guides)
 *   MAX_GUIDE_FETCH_FAILURES 10 (stop reading guides after this many failures)
 *   FORCE_BASELINE       unset (1 = skip the MAX_NEW_* failsafes and record
 *                        every new exam and certification silently, e.g. after
 *                        a bulk change; it also does what FORCE_GUIDE_BASELINE
 *                        does; the workflow sets it from its `force_baseline`
 *                        input)
 *   FORCE_GUIDE_BASELINE unset (1 = re-read every covered study guide in full
 *                        and record its new text silently, a lost section
 *                        included, e.g. after a bulk update or a markup change;
 *                        new exams and certifications are still alerted; the
 *                        workflow sets it from its `force_guide_baseline`
 *                        input)
 *   FETCH_DELAY_MS       600  (per worker, between requests; 2 workers)
 *   FETCH_ATTEMPTS       3
 *   RETRY_BASE_MS        3000 (backoff base for 429/5xx/network errors)
 *   MAX_RETRY_AFTER_MS   60000 (cap for a Retry-After header and the backoff)
 *   FETCH_TIMEOUT_MS     30000
 *   RUN_DEADLINE_MS      900000 (listing + certification pages, from start)
 *   LOOKUP_DEADLINE_MS   180000 (exam page / study guide lookups)
 *   GUIDE_DEADLINE_MS    300000 (study guide sitemap + covered guides)
 *   TODAY                today's UTC date (YYYY-MM-DD), for tests
 *   EXAM_STATUS_FILE     src/data_files/exam-status.mjs (hub badges)
 *   BETA_EXAMS_FILE      src/data_files/beta-exams.json
 *   RETIRING_EXAMS_FILE  src/data_files/retiring-exams.json
 *   DRIFT_ACKNOWLEDGED_FILE src/data_files/drift-acknowledged.json (drift kinds
 *                        the maintainers silenced for an exam; may be absent)
 *   CREATE_ISSUES        unset (1 = the drift step may create, edit, comment on
 *                        and close its issues through `gh`; the workflow sets it
 *                        and a GH_TOKEN; DRY_RUN=1 wins and touches nothing)
 *   DRY_RUN              unset (1 = never touch an issue, even with CREATE_ISSUES)
 *   DRIFT_CHECK          1  (0 = skip the hub-vs-Learn comparison: tests of the
 *                        other checks, local debugging; touches no issue)
 *   DRIFT_REPORT_FILE    <tmpdir>/new-exam-drift-report.md (the issue text)
 *   DRIFT_ERROR_FILE     <tmpdir>/new-exam-drift-error.md (why the check did
 *                        not run: unreadable hub files, the failsafe)
 *   MAX_DRIFT            25  (new rows at once before the failsafe stops the
 *                        drift step; dated reminders are counted apart)
 *   MAX_DRIFT_DATES      40  (new dated reminders at once)
 *   FORCE_DRIFT          unset (1 = skip the drift failsafe and write the full
 *                        list; the workflow sets it from `force_drift`)
 *   EFFECTIVE_LEAD_DAYS  7   (a dated statement is listed this many days before)
 *   EFFECTIVE_GRACE_DAYS 2   (... and until this many days after its date)
 *   EFFECTIVE_HORIZON_DAYS 30 (dates further ahead are picked up later)
 *   CERT_RENAME_DAYS     30  (how long a certification rename stays a row)
 *   DRIFT_REMINDER_DAYS  7   (a new drift issue is held back this long after one
 *                        was closed by hand, while no row is new; 0 = never;
 *                        the rows of that issue do not count for the failsafe
 *                        either)
 *   PROBE_DEADLINE_MS    60000 (exam page probes of BETA / UPCOMING exams, and
 *                        the study guide pages of UPCOMING ones)
 *   GH_CLI_SCRIPT        unset (tests only: a Node script run instead of `gh`)
 *
 * Writes GITHUB_OUTPUT keys: changes_found (a new exam, a new certification or
 * a changed study guide to report in the exam issue; the drift issue is kept by
 * the script itself and never sets it), baseline_updated, extraction_failed,
 * guide_check_failed ("true": the study guide failsafe stopped the guide part,
 * the message is in ERROR_FILE; "false": the guide check ran; "skipped": it did
 * not run, because the sitemap could not be read or the run failed first),
 * drift_check_failed (the drift step did not run; the message is in
 * DRIFT_ERROR_FILE and in the "could not run" issue), drift_issue_failed (a `gh`
 * call for the drift issues failed; the exam alert and the commit went ahead),
 * drift_items (rows to fix or check in the running drift issue),
 * study_guides_changed (number of study guides in the report), issue_title (raw,
 * not lowercased).
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  appendStepSummary,
  warnLoud as warnWithTitle,
  writeOutput,
} from "./lib/actions.mjs";
import { AREA_BY_PREFIX } from "./lib/areas.mjs";
import { listOpenIssues, makeGh, readIssueBody } from "./lib/gh.mjs";
import { retryDelayMs } from "./lib/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Exam code prefix -> hub area directory: the map scripts/new-exam.mjs reads too
// (scripts/lib/areas.mjs; the area mapping in AGENTS.md, "Exam Pages", follows
// it). A code whose prefix is neither listed there nor in IGNORED_PREFIXES is a
// new exam family and is alerted.
export { AREA_BY_PREFIX };

// Families the hub deliberately does not cover (Office/MOS and legacy exam
// numbers): tracked, never alerted. Anything else outside AREA_BY_PREFIX is
// news: a new family such as AB- or GH- once was.
export const IGNORED_PREFIXES = new Set(["MO", "77", "98", "70", "62"]);

const CONCURRENCY = 2;
const MAX_LISTING_PAGES = 10;
// Study guides: the sitemap index (the credentials_en-us_<n>.xml entries are
// read from it; the file name is never hard-coded), and the sections hashed.
const SITEMAP_INDEX_PATH = "/_sitemaps/sitemapindex.xml";
const SITEMAP_FILE_RE = /^\/_sitemaps\/credentials_en-us_(\d+)\.xml$/i;
// A percentage of a handful of guides says nothing: below this many tracked
// covered guides only the absolute MAX_GUIDE_CHANGES limit applies.
const GUIDE_PCT_MIN_BASE = 10;
// Report limits. GitHub rejects an issue body above 65,536 characters.
const REPORT_MAX_CHARS = 60000;
const DIFF_LINE_MAX_CHARS = 300;
const DIFF_LIMITS = [
  { perGuide: 30, total: 150 },
  { perGuide: 15, total: 60 },
  { perGuide: 5, total: 20 },
  { perGuide: 0, total: 0 },
];
const MAX_DATED_STATEMENTS = 6;
const DATED_STATEMENT_MAX_CHARS = 400;
const TRACKING = "?WT.mc_id=studentamb_165290";
const PUBLIC_BASE = "https://learn.microsoft.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CODE_SOURCE = "[A-Za-z0-9]{2,5}-\\d{2,4}[A-Za-z]?";
const ANNOUNCEMENT_RE =
  /\bbeta\b|\bnew (?:exam|certification|credential)s?\b|\bannounce/i;

class ExtractionError extends Error {}
/** The study guide sitemap is unusable: skip the study guide logic, keep the rest. */
class SitemapError extends Error {}

// Counts every HTTP request the run makes (retries included), for the log.
const stats = { requests: 0 };

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

export function loadConfig(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);

  return {
    baseUrl: (env.LEARN_BASE_URL || PUBLIC_BASE).replace(/\/+$/, ""),
    trackerFile: resolveFromRoot(
      env.TRACKER_FILE ?? "src/data_files/learn-exams.json",
    ),
    docsDir: resolveFromRoot(env.DOCS_DIR ?? "src/content/docs"),
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "new-exam-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "new-exam-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    stepSummary: env.GITHUB_STEP_SUMMARY || "",
    minCertifications: num("MIN_CERTIFICATIONS", 50),
    minPageOkPct: num("MIN_PAGE_OK_PCT", 80),
    minBaselinePageOkPct: num("MIN_BASELINE_PAGE_OK_PCT", 95),
    maxEmptyPagePct: num("MAX_EMPTY_PAGE_PCT", 25),
    maxNewExams: num("MAX_NEW_EXAMS", 15),
    maxNewCerts: num("MAX_NEW_CERTS", 15),
    maxNewPct: num("MAX_NEW_PCT", 25),
    minStudyGuides: num("MIN_STUDY_GUIDES", 40),
    maxGuideChanges: num("MAX_GUIDE_CHANGES", 15),
    maxGuideChangePct: num("MAX_GUIDE_CHANGE_PCT", 25),
    maxGuideFetchFailures: num("MAX_GUIDE_FETCH_FAILURES", 10),
    forceBaseline: env.FORCE_BASELINE === "1",
    forceGuideBaseline: env.FORCE_GUIDE_BASELINE === "1",
    // Hub-vs-Learn drift (see "Step 7").
    examStatusFile: resolveFromRoot(
      env.EXAM_STATUS_FILE ?? "src/data_files/exam-status.mjs",
    ),
    betaExamsFile: resolveFromRoot(
      env.BETA_EXAMS_FILE ?? "src/data_files/beta-exams.json",
    ),
    retiringExamsFile: resolveFromRoot(
      env.RETIRING_EXAMS_FILE ?? "src/data_files/retiring-exams.json",
    ),
    driftAcknowledgedFile: resolveFromRoot(
      env.DRIFT_ACKNOWLEDGED_FILE ?? "src/data_files/drift-acknowledged.json",
    ),
    driftReportFile:
      env.DRIFT_REPORT_FILE ?? join(tmpdir(), "new-exam-drift-report.md"),
    driftErrorFile:
      env.DRIFT_ERROR_FILE ?? join(tmpdir(), "new-exam-drift-error.md"),
    maxDrift: num("MAX_DRIFT", 25),
    maxDriftDates: num("MAX_DRIFT_DATES", 40),
    forceDrift: env.FORCE_DRIFT === "1",
    // DRIFT_CHECK=0 switches the hub-vs-Learn comparison off (tests of the
    // exam and study guide checks, local debugging). It touches no issue.
    driftCheck: env.DRIFT_CHECK !== "0",
    effectiveLeadDays: num("EFFECTIVE_LEAD_DAYS", 7),
    effectiveGraceDays: num("EFFECTIVE_GRACE_DAYS", 2),
    effectiveHorizonDays: num("EFFECTIVE_HORIZON_DAYS", 30),
    certRenameDays: num("CERT_RENAME_DAYS", 30),
    // How long after a maintainer closed the drift issue by hand a new one is
    // held back while no row is new (0 = never held back).
    driftReminderDays: num("DRIFT_REMINDER_DAYS", 7),
    probeDeadlineMs: num("PROBE_DEADLINE_MS", 60 * 1000),
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    fetchDelayMs: num("FETCH_DELAY_MS", 600),
    fetchAttempts: num("FETCH_ATTEMPTS", 3),
    retryBaseMs: num("RETRY_BASE_MS", 3000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60000),
    timeoutMs: num("FETCH_TIMEOUT_MS", 30000),
    deadlineMs: num("RUN_DEADLINE_MS", 15 * 60 * 1000),
    lookupDeadlineMs: num("LOOKUP_DEADLINE_MS", 3 * 60 * 1000),
    guideDeadlineMs: num("GUIDE_DEADLINE_MS", 5 * 60 * 1000),
    today,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/**
 * A silent baseline swallows every exam Learn already lists. Showing the ones
 * in the hub areas without a page (and the unmapped families) in the job
 * summary lets the maintainers review what the baseline did not report.
 */
function writeStepSummary(
  cfg,
  { label, certifications, exams, uncovered, unmappedFamilies },
) {
  if (!cfg.stepSummary) return;
  const list = (codes) =>
    codes.length ? codes.map((code) => `\`${code}\``).join(", ") : "none";
  const text = [
    `### New Exam Monitor: ${label}`,
    "",
    `Recorded ${certifications} certifications and ${exams} exams silently. No issue is opened for anything Microsoft Learn already lists.`,
    "",
    `- Exams in the hub areas without a hub page (create a page for any you want; the monitor will not report them): ${list(uncovered)}`,
    `- Exams in families the hub neither maps nor ignores (decide on \`AREA_BY_PREFIX\` in \`scripts/lib/areas.mjs\` or \`IGNORED_PREFIXES\`): ${list(unmappedFamilies)}`,
  ].join("\n");
  appendStepSummary(cfg.stepSummary, `${text}\n`);
}

/**
 * The study guide part of the job summary. Written whenever there is something
 * to see: the guide check was skipped (the loud warning also lands here), a
 * baseline recorded guides silently, or a guide could not be read or parsed.
 * A quiet run writes nothing.
 */
function writeGuideSummary(cfg, info) {
  if (!cfg.stepSummary) return;
  const list = (codes) =>
    codes.length ? codes.map((code) => `\`${code}\``).join(", ") : "none";
  const applied = info.applied;
  const lines = [];

  if (info.skipped) {
    lines.push(
      `- **Study guides were not checked this run:** ${info.skipped}. New study guides and changed guide text are not reported until the sitemap works again; the exam check above is not affected.`,
    );
  }
  if (info.failsafe) {
    lines.push(
      `- **The study guide failsafe stopped the guide check this run:** ${info.failsafe}`,
    );
  }
  if (applied) {
    if (info.baseline) {
      lines.push(
        `- Recorded ${info.tracked} study guides silently (${info.hashed} with a text hash). No issue is opened for them.`,
        `- Exams the hub covers without a study guide in the sitemap: ${list(info.coveredWithoutGuide)}`,
      );
    }
    if (info.quietExams.length > 0) {
      lines.push(
        `- Study guides of exams the tracker did not know, recorded silently as exams. Without a hub page (create a page for any you want; the monitor will not report them): ${list(info.quietExams)}`,
      );
    }
    if (applied.rebaselined.length > 0) {
      lines.push(
        `- Text hash re-recorded silently (FORCE_GUIDE_BASELINE or FORCE_BASELINE) for: ${list(applied.rebaselined)}`,
      );
    }
    for (const entry of applied.failed) {
      lines.push(
        `- Could not read the study guide of \`${entry.code}\` (${entry.reason}); its previous state was kept and it is retried next run.`,
      );
    }
    for (const entry of applied.unparsed) {
      lines.push(
        `- The study guide of \`${entry.code}\` could not be parsed (${entry.reason}); its previous state was kept.`,
      );
    }
    for (const entry of applied.degraded) {
      lines.push(
        `- The study guide of \`${entry.code}\` lost its ${entry.sections.join(" and ")} section in the markup; its previous state was kept and no change is reported for it. Check the guide by hand; run the workflow with \`force_guide_baseline\` enabled to accept the new text.`,
      );
    }
  }
  if (lines.length === 0) return;

  appendStepSummary(
    cfg.stepSummary,
    `### New Exam Monitor: study guides\n\n${lines.join("\n")}\n`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A problem that does not fail the run but must not go unnoticed: on stderr and,
// on a GitHub runner, as a warning annotation (scripts/lib/actions.mjs).
const warnLoud = (message) =>
  warnWithTitle(message, { title: "New Exam Monitor" });

// Plain code-point order, independent of the runner's locale.
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedStrings = (values) => [...new Set(values)].sort(byCodePoint);

export function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&hellip;/g, "…")
    .replace(/&bull;/g, "•")
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      safeCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a trailing "(beta)" marker off a title or exam name. */
export function splitBeta(text) {
  const clean = collapse(decodeEntities(String(text ?? "")));
  const beta = /\s*\(beta\)$/i.test(clean);
  return { text: clean.replace(/\s*\(beta\)$/i, "").trim(), beta };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "exam.ab-650" -> "AB-650"; null for anything that is not an exam uid. */
export function examCodeFromUid(uid) {
  const match = String(uid ?? "")
    .trim()
    .match(new RegExp(`^exam\\.(${CODE_SOURCE})$`, "i"));
  return match ? match[1].toUpperCase() : null;
}

export function areaForCode(code) {
  return AREA_BY_PREFIX[code.split("-")[0]] ?? null;
}

/** True for the families the hub deliberately skips (MO-*, 77-*, ...). */
export function isIgnoredCode(code) {
  return IGNORED_PREFIXES.has(code.split("-")[0]);
}

/** A family that is neither mapped to a hub area nor ignored: new, needs a decision. */
export function isUnmappedFamily(code) {
  return areaForCode(code) === null && !isIgnoredCode(code);
}

/**
 * The exam page URL in the repo's form. Only a confirmed exam page may be
 * stored or linked with it: many exams have no page under /exams/<code>.
 */
export function examUrl(code) {
  return `${PUBLIC_BASE}/credentials/certifications/exams/${code.toLowerCase()}${TRACKING}`;
}

export function certificationUrl(slug) {
  return `${PUBLIC_BASE}/credentials/certifications/${slug}/${TRACKING}`;
}

/** The study guide in the repo's URL form (no locale, tracking parameter kept). */
export function studyGuideUrl(code) {
  return `${PUBLIC_BASE}/credentials/certifications/resources/study-guides/${code.toLowerCase()}${TRACKING}`;
}

function hubPagePath(code) {
  const area = areaForCode(code);
  return area ? `src/content/docs/${area}/${code}.mdx` : null;
}

function hasHubPage(cfg, code) {
  const area = areaForCode(code);
  return area !== null && existsSync(join(cfg.docsDir, area, `${code}.mdx`));
}

/** Every exam code that has a page in the hub areas (for a coverage overview). */
function listHubCodes(cfg) {
  const codes = [];
  for (const area of new Set(Object.values(AREA_BY_PREFIX))) {
    let files = [];
    try {
      files = readdirSync(join(cfg.docsDir, area));
    } catch {
      continue; // an area directory that does not exist covers nothing
    }
    for (const file of files) {
      const match = file.match(new RegExp(`^(${CODE_SOURCE})\\.mdx$`));
      if (match && areaForCode(match[1]) === area) codes.push(match[1]);
    }
  }
  return codes.sort(byCodePoint);
}

// ---------------------------------------------------------------------------
// Fetching (polite: bounded concurrency, delay, retry with Retry-After)
// ---------------------------------------------------------------------------
/** A wall-clock budget shared by every request of a phase. */
export function makeDeadline(ms, now = Date.now) {
  const at = now() + ms;
  return {
    expired: () => now() >= at,
    remaining: () => Math.max(0, at - now()),
  };
}

/**
 * GET with retries. `headers` are extra request headers (a conditional
 * `If-Modified-Since`); with `notModified` a 304 answer is a result of its own
 * ({ ok: false, status: 304, notModified: true }), not a failure. A successful
 * answer carries the `Last-Modified` header value ("" when absent).
 */
async function fetchText(
  cfg,
  url,
  deadline = null,
  { headers = {}, notModified = false } = {},
) {
  let status;
  let error;

  for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
    // Out of time: no further attempt, no sleeping past the deadline.
    if (deadline?.expired()) {
      return { ok: false, status, error, deadline: true };
    }
    let retryAfter = null;
    try {
      stats.requests++;
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          ...headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(
          deadline
            ? Math.max(1, Math.min(cfg.timeoutMs, deadline.remaining()))
            : cfg.timeoutMs,
        ),
      });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text: await response.text(),
          url: response.url,
          lastModified: response.headers.get("last-modified") ?? "",
        };
      }
      if (notModified && response.status === 304) {
        return { ok: false, status: 304, notModified: true };
      }

      status = response.status;
      error = undefined;
      retryAfter = response.headers.get("retry-after");
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${response.status})`,
      );
      // Only rate limits and server errors are worth another try.
      if (status !== 429 && status < 500) return { ok: false, status };
    } catch (err) {
      error = err;
      status = undefined;
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${err.message})`,
      );
    }

    if (attempt < cfg.fetchAttempts) {
      const delay = retryDelayMs({
        attempt,
        retryAfter,
        baseMs: cfg.retryBaseMs,
        maxMs: cfg.maxRetryAfterMs,
      });
      await sleep(deadline ? Math.min(delay, deadline.remaining()) : delay);
    }
  }

  return { ok: false, status, error, deadline: Boolean(deadline?.expired()) };
}

/**
 * Runs fn over items with `concurrency` workers, each pausing between
 * requests. Once `shouldStop()` is true no further item is started (items
 * already running finish); the results of items never started stay undefined.
 */
async function mapPool(
  items,
  concurrency,
  delayMs,
  fn,
  shouldStop = () => false,
) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    let first = true;
    for (;;) {
      if (shouldStop()) return;
      const index = next++;
      if (index >= items.length) return;
      if (!first && delayMs > 0) {
        await sleep(delayMs);
        if (shouldStop()) return;
      }
      first = false;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Step 1: the credentials listing
// ---------------------------------------------------------------------------
export function parseListing(results) {
  const certifications = [];
  const examinations = [];
  const seenSlugs = new Set();
  const seenCodes = new Set();

  for (const item of results) {
    if (!item || item.hidden === true) continue;
    const types = Array.isArray(item.credential_types)
      ? item.credential_types
      : [];
    const products = sortedStrings(
      (item.display_products?.length
        ? item.display_products
        : (item.products ?? [])
      ).map(collapse),
    ).filter(Boolean);

    if (types.includes("certification")) {
      const slug = String(item.url ?? "").match(
        /\/credentials\/certifications\/([a-z0-9][a-z0-9-]*)\/?$/i,
      )?.[1];
      if (!slug || seenSlugs.has(slug.toLowerCase())) continue;
      seenSlugs.add(slug.toLowerCase());
      const { text, beta } = splitBeta(item.title);
      const examCodes = (item.exams ?? [])
        .map(
          (exam) =>
            examCodeFromUid(exam?.uid) ?? validCode(exam?.display_name) ?? null,
        )
        .filter(Boolean);
      certifications.push({
        slug: slug.toLowerCase(),
        uid: item.uid ?? `certification.${slug}`,
        title: text,
        beta,
        products,
        types,
        examCodes: sortedStrings(examCodes),
      });
    } else if (types.includes("examination")) {
      const code =
        examCodeFromUid(item.uid) ?? validCode(item.exam_display_name);
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);
      const { text, beta } = splitBeta(item.title);
      // The listing links a standalone exam to its own exam page: that one exists.
      const examPage = new RegExp(
        `/credentials/certifications/exams/${escapeRegExp(code.toLowerCase())}/?$`,
        "i",
      ).test(String(item.url ?? ""));
      examinations.push({ code, name: text, beta, products, examPage });
    }
  }

  return { certifications, examinations };
}

function validCode(value) {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  return new RegExp(`^${CODE_SOURCE}$`).test(code) ? code : null;
}

function deadlineMessage(cfg, what) {
  return (
    `The run deadline (RUN_DEADLINE_MS=${cfg.deadlineMs}) was reached while ${what}. ` +
    "Microsoft Learn may be throttling or hanging; the tracker was not modified."
  );
}

async function fetchListing(cfg, deadline) {
  const origin = new URL(cfg.baseUrl).origin;
  const items = [];
  const visited = new Set();
  let count = null;
  let url = `${cfg.baseUrl}/api/contentbrowser/search/credentials?locale=en-us&$top=100`;

  for (let page = 0; url; page++) {
    if (page >= MAX_LISTING_PAGES) {
      throw new ExtractionError(
        `The credentials listing did not end after ${MAX_LISTING_PAGES} pages. ` +
          "The API shape may have changed; the tracker was not modified.",
      );
    }
    if (page > 0) await sleep(cfg.fetchDelayMs);
    visited.add(url);

    const response = await fetchText(cfg, url, deadline);
    if (!response.ok) {
      if (response.deadline) {
        throw new ExtractionError(
          deadlineMessage(cfg, "fetching the credentials listing"),
        );
      }
      throw new ExtractionError(
        `Failed to fetch the credentials listing from Microsoft Learn (status ${
          response.status ?? "network error"
        }). The API may be down, blocking requests, or its shape may have changed; ` +
          "the tracker was not modified.",
      );
    }

    let json;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new ExtractionError(
        "Failed to parse the credentials listing as JSON. The API may have changed or " +
          "returned an error page; the tracker was not modified.",
      );
    }
    if (!Array.isArray(json?.results)) {
      throw new ExtractionError(
        "The credentials listing has no `results` array. The API shape may have changed; " +
          "the tracker was not modified.",
      );
    }

    if (count === null && Number.isFinite(json.count)) count = json.count;
    items.push(...json.results);

    const next = json["@nextLink"];
    if (!next || json.results.length === 0) break;
    const nextUrl = new URL(next, url);
    if (nextUrl.origin !== origin || visited.has(nextUrl.href)) {
      throw new ExtractionError(
        `The credentials listing pointed to an unexpected next page (${nextUrl.href}); ` +
          "the tracker was not modified.",
      );
    }
    url = nextUrl.href;
  }

  if (count !== null && items.length < count) {
    console.error(
      `WARNING: the listing reports ${count} items but only ${items.length} were returned.`,
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// Step 2: certification pages
// ---------------------------------------------------------------------------
function attributesOf(source) {
  const attrs = {};
  for (const match of source.matchAll(
    /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g,
  )) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2]);
  }
  return attrs;
}

function metaTags(html) {
  return [...html.matchAll(/<meta\b([^>]*?)\/?>/gi)].map((match) =>
    attributesOf(match[1]),
  );
}

export function isCertificationPage(html) {
  return metaTags(html).some(
    (meta) =>
      (meta.name === "uid" && /^certification\./i.test(meta.content ?? "")) ||
      (meta.name === "schema" && /^certification$/i.test(meta.content ?? "")) ||
      (meta.name === "page_kind" &&
        /^certification$/i.test(meta.content ?? "")),
  );
}

/**
 * Reads one certification page: its title, the exams it lists and announcement
 * links. Per exam: `name`; `beta`; `betaKnown` (the page positively tells the
 * status: an exam card carries the "(beta)" marker or its absence, a beta
 * callout names the exam; a bare scheduling link or learn_exam meta says
 * nothing); `examPage` (the page links the exam's own page, so it exists).
 */
export function parseCertificationPage(html) {
  const metas = metaTags(html);
  const uid = metas.find((meta) => meta.name === "uid")?.content ?? null;

  const rawTitle = html.match(/<title>([\s\S]*?)<\/title>/i);
  const pageTitle = rawTitle
    ? stripTags(rawTitle[1])
        .replace(/\s*\|\s*Microsoft Learn$/i, "")
        .replace(/\s+-\s+Certifications$/i, "")
    : "";
  const { text: title, beta } = splitBeta(pageTitle);

  const exams = new Map();
  const addExam = (code) => {
    if (!exams.has(code)) {
      exams.set(code, {
        code,
        name: "",
        beta: false,
        betaKnown: false,
        examPage: false,
        evidence: [],
      });
    }
    return exams.get(code);
  };
  // What this page says about the beta status, as tags ("card:beta",
  // "card:ga", "callout:beta"). A bare scheduling link or learn_exam meta says
  // nothing, and neither does a classic page without a callout.
  const addEvidence = (exam, tag) => {
    if (!exam.evidence.includes(tag)) exam.evidence.push(tag);
  };

  // New layout: one learn_exam meta per exam.
  for (const meta of metas) {
    if (meta.name !== "learn_exam") continue;
    const code = examCodeFromUid(meta.content);
    if (code) addExam(code);
  }

  // New layout: exam cards carry the official name and the beta marker.
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributesOf(anchor[1]);
    if (!/(?:^|\s)exam-card-title(?:\s|$)/.test(attrs.class ?? "")) continue;
    const text = stripTags(anchor[2]);
    const prefix = text.match(new RegExp(`^(${CODE_SOURCE})(?![\\w-])`));
    const hrefCode = validCode(
      (attrs.href ?? "").match(
        new RegExp(`exams/(${CODE_SOURCE})/?`, "i"),
      )?.[1],
    );
    let code = prefix ? prefix[1].toUpperCase() : hrefCode;
    let rest = text;
    if (prefix) {
      rest = text.slice(prefix[1].length).replace(/^\s*[:\-–—]?\s*/, "");
    }
    if (!code) continue;
    const exam = addExam(code);
    const named = splitBeta(rest);
    if (named.text) exam.name = named.text;
    if (named.beta) exam.beta = true;
    exam.betaKnown = true; // a card states "(beta)" when it applies
    addEvidence(exam, named.beta ? "card:beta" : "card:ga");
    if (hrefCode === code) exam.examPage = true;
  }

  // Every layout: the Pearson VUE scheduling link names the exam.
  for (const match of html.matchAll(/examUid=([^&"'\s]+)/gi)) {
    const code = examCodeFromUid(match[1]);
    if (code) addExam(code);
  }

  // Callout boxes: external links about a beta or new exam.
  const announcements = new Map();
  for (const box of html.matchAll(
    /<div class="(?:IMPORTANT|NOTE|TIP|WARNING|CAUTION)">([\s\S]*?)<\/div>/g,
  )) {
    for (const block of box[1].matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const blockText = stripTags(block[2]);
      for (const anchor of block[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = attributesOf(anchor[1]).href;
        let parsed;
        try {
          parsed = new URL(href);
        } catch {
          continue; // relative link: learn.microsoft.com itself
        }
        if (!/^https?:$/.test(parsed.protocol)) continue;
        if (parsed.hostname === "learn.microsoft.com") continue;
        const text = stripTags(anchor[2]);
        if (!ANNOUNCEMENT_RE.test(text) && !ANNOUNCEMENT_RE.test(blockText)) {
          continue;
        }
        if (!announcements.has(href)) announcements.set(href, text);
      }
    }
  }

  // A page that lists no exam any other way still says which exam it is for: a
  // beta certification whose scheduling is not open yet has no scheduling link,
  // learn_exam meta or exam card, but its callout reads "Learn more about the
  // beta exam GH-700" and its resources have an "Exam GH-700 study guide" card
  // (GH-700 on 2026-10-14). Only for such a page: where an exam is listed, a
  // code in a callout may belong to another exam (a replacement, say) and stays
  // ignored unless the page lists it too.
  if (exams.size === 0) {
    const named = new RegExp(
      `\\b(?:beta|new|upcoming)\\s+exam\\s+(${CODE_SOURCE})(?![\\w-])`,
      "gi",
    );
    for (const text of announcements.values()) {
      for (const match of text.matchAll(named)) {
        const code = validCode(match[1]);
        if (code) addExam(code);
      }
    }
    for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (
        !/(?:^|\s)card-title(?:\s|$)/.test(attributesOf(anchor[1]).class ?? "")
      ) {
        continue;
      }
      const match = stripTags(anchor[2]).match(
        new RegExp(`^Exam\\s+(${CODE_SOURCE})\\s+study guide$`, "i"),
      );
      const code = match ? validCode(match[1]) : null;
      if (code) addExam(code);
    }
  }

  const announcementList = [...announcements].map(([url, text]) => {
    const codes = sortedStrings(
      [...text.matchAll(new RegExp(`\\b(${CODE_SOURCE})\\b`, "g"))]
        .map((match) => match[1].toUpperCase())
        .filter((code) => exams.has(code)),
    );
    // A link that calls a named exam a beta exam is a beta signal for it.
    if (/\bbeta\b/i.test(text)) {
      for (const code of codes) {
        exams.get(code).beta = true;
        exams.get(code).betaKnown = true;
        addEvidence(exams.get(code), "callout:beta");
      }
    }
    return { url, text, codes };
  });

  return {
    uid,
    title,
    beta,
    exams: [...exams.values()],
    announcements: announcementList,
  };
}

// ---------------------------------------------------------------------------
// Step 3: tracker (load, normalize, scan -> merge)
// ---------------------------------------------------------------------------
function emptyTracker() {
  return {
    lastSynced: null,
    certifications: [],
    exams: [],
    studyGuides: [],
    certRenames: [],
    effectiveDates: [],
  };
}

/**
 * One study guide record. Key order is fixed so the file stays byte-stable.
 * `hash` is null until the guide was fetched (guides of exams the hub does not
 * cover are tracked by sitemap date only); `lastModified` is the page's
 * `Last-Modified` header, sent back as `If-Modified-Since` so an unchanged page
 * answers 304 (only present once the guide was fetched and the server sent one);
 * `lines` is the normalized text the hash was computed from (kept for the
 * diff); `missing` is only present when a section could not be found in the page.
 * `name` is the exam name of the page title ("Study guide for Exam CODE: name")
 * and `headingName` the one of the page's own heading, stored only when the
 * two differ (the hub-vs-Learn drift check compares them with the hub page).
 * Neither is part of the hash.
 */
function normalizeGuide(guide, today) {
  const hash = typeof guide.hash === "string" && guide.hash ? guide.hash : null;
  const lastModified =
    hash && typeof guide.lastModified === "string"
      ? guide.lastModified.trim()
      : "";
  const name =
    hash && typeof guide.name === "string" ? collapse(guide.name) : "";
  const headingName =
    name && typeof guide.headingName === "string"
      ? collapse(guide.headingName)
      : "";
  const record = {
    code: String(guide.code).toUpperCase(),
    ...(name ? { name } : {}),
    ...(headingName && headingName !== name ? { headingName } : {}),
    lastmod: typeof guide.lastmod === "string" ? guide.lastmod : "",
    hash,
    updatedAt: typeof guide.updatedAt === "string" ? guide.updatedAt : "",
    ...(lastModified ? { lastModified } : {}),
    firstSeen: guide.firstSeen ?? today,
    lastChanged: guide.lastChanged ?? null,
  };
  const missing = Array.isArray(guide.missing)
    ? sortedStrings(guide.missing.map(String))
    : [];
  if (missing.length > 0) record.missing = missing;
  if (hash && Array.isArray(guide.lines))
    record.lines = guide.lines.map(String);
  return record;
}

function normalizeExam(exam, today) {
  return {
    code: String(exam.code),
    name: collapse(exam.name),
    beta: exam.beta === true,
    // What the pages said about the beta status the last time they were read
    // ("card:beta", "card:ga", "listing:beta", "listing:ga", "callout:beta",
    // "certification-title:beta", "exam-page:beta", "exam-page:ga"). Unlike
    // `beta` it is not sticky: a page that stops saying "beta" empties it.
    betaEvidence: sortedStrings(exam.betaEvidence ?? []),
    certifications: (exam.certifications ?? [])
      .filter((cert) => typeof cert?.slug === "string")
      .map((cert) => ({ slug: cert.slug, title: collapse(cert.title) }))
      .sort((a, b) => byCodePoint(a.slug, b.slug)),
    products: sortedStrings(exam.products ?? []),
    url: exam.url || "", // a confirmed exam page only, never a guess
    announcements: sortedStrings(exam.announcements ?? []),
    firstSeen: exam.firstSeen ?? today,
    lastSeen: exam.lastSeen ?? exam.firstSeen ?? today,
  };
}

function normalizeCertification(cert, today) {
  return {
    slug: String(cert.slug),
    title: collapse(cert.title),
    beta: cert.beta === true,
    products: sortedStrings(cert.products ?? []),
    exams: sortedStrings(cert.exams ?? []),
    firstSeen: cert.firstSeen ?? today,
    lastSeen: cert.lastSeen ?? cert.firstSeen ?? today,
  };
}

export function normalizeTracker(parsed, today) {
  return {
    lastSynced: parsed.lastSynced ?? null,
    certifications: parsed.certifications
      .filter((cert) => typeof cert?.slug === "string")
      .map((cert) => normalizeCertification(cert, today))
      .sort((a, b) => byCodePoint(a.slug, b.slug)),
    exams: parsed.exams
      .filter((exam) => typeof exam?.code === "string")
      .map((exam) => normalizeExam(exam, today))
      .sort((a, b) => byCodePoint(a.code, b.code)),
    // Trackers written before the study guide check have no such array.
    studyGuides: (Array.isArray(parsed.studyGuides) ? parsed.studyGuides : [])
      .filter((guide) => typeof guide?.code === "string")
      .map((guide) => normalizeGuide(guide, today))
      .sort((a, b) => byCodePoint(a.code, b.code)),
    // Trackers written before the drift check have neither array.
    certRenames: (Array.isArray(parsed.certRenames) ? parsed.certRenames : [])
      .filter(
        (event) =>
          typeof event?.slug === "string" &&
          typeof event.from === "string" &&
          typeof event.to === "string",
      )
      .map((event) => ({
        slug: event.slug,
        from: collapse(event.from),
        to: collapse(event.to),
        firstSeen: event.firstSeen ?? today,
      }))
      .sort(
        (a, b) =>
          byCodePoint(a.slug, b.slug) ||
          byCodePoint(a.firstSeen, b.firstSeen) ||
          byCodePoint(a.to, b.to),
      ),
    effectiveDates: (Array.isArray(parsed.effectiveDates)
      ? parsed.effectiveDates
      : []
    )
      .filter(
        (entry) =>
          typeof entry?.code === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? ""),
      )
      .map((entry) => ({
        code: entry.code.toUpperCase(),
        date: entry.date,
        sentence: collapse(entry.sentence),
        firstSeen: entry.firstSeen ?? today,
      }))
      .sort(
        (a, b) => byCodePoint(a.code, b.code) || byCodePoint(a.date, b.date),
      ),
  };
}

function loadTracker(cfg) {
  if (!existsSync(cfg.trackerFile)) return emptyTracker();
  const raw = readFileSync(cfg.trackerFile, "utf8").trim();
  if (!raw) return emptyTracker();

  const where = relative(root, cfg.trackerFile);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExtractionError(
      `Corrupt tracker at ${where} (invalid JSON). The tracker was not modified.`,
    );
  }
  if (!Array.isArray(parsed?.certifications) || !Array.isArray(parsed?.exams)) {
    throw new ExtractionError(
      `Corrupt tracker at ${where} (missing certifications/exams array). ` +
        "The tracker was not modified.",
    );
  }
  if (parsed.studyGuides !== undefined && !Array.isArray(parsed.studyGuides)) {
    throw new ExtractionError(
      `Corrupt tracker at ${where} (studyGuides is not an array). ` +
        "The tracker was not modified.",
    );
  }
  return normalizeTracker(parsed, cfg.today);
}

/**
 * Combines the listing and the parsed pages into the current picture of
 * Learn: certifications and the exams behind them. `pages` maps a slug to its
 * parsed page; a slug without an entry could not be read.
 *
 * Besides the records it returns what a health check needs:
 *   - `noExamPages`: slugs whose page was read but yielded no exam;
 *   - `knownWithExams`: how many listed certifications the tracker knew exams
 *     for, and `emptyPages`: those among them whose page yielded none now (the
 *     exam markup probably changed when this is a large share).
 *
 * `guideCodes` are the exam codes that have a study guide in the sitemap. A code
 * the tracker does not know yet becomes an exam of its own (`guideOnly` while no
 * certification page or listing item shows it); a known code is left alone. Every
 * exam records where it was seen (`viaCert`, `viaListing`, `studyGuide`) for the
 * report's evidence column.
 *
 * `probes` are the exam page probes that answered (see probeExamPages) and
 * `probeCodes` the exams whose exam page was asked for. A probe that got no
 * answer (429, 5xx, a timeout, the deadline) is no evidence: the `exam-page:*`
 * tags the tracker has for that exam stay, whatever the certification page said.
 */
export function buildScan({
  certifications,
  examinations,
  pages,
  previous,
  guideCodes = [],
  probes = new Map(),
  probeCodes = [],
}) {
  const warnings = [];
  const exams = new Map();
  const certs = new Map();
  const noExamPages = [];
  const emptyPages = [];
  let knownWithExams = 0;
  const previousCerts = new Map(
    previous.certifications.map((cert) => [cert.slug, cert]),
  );

  const ensureExam = (code) => {
    if (!exams.has(code)) {
      exams.set(code, {
        code,
        name: "",
        beta: false,
        betaKnown: false,
        examPage: false,
        certs: new Map(),
        products: new Set(),
        announcements: new Map(),
        viaCert: false,
        viaListing: false,
        viaExamPage: false,
        studyGuide: false,
        guideOnly: false,
        // What the pages read this run say about the beta status (tags, see
        // normalizeExam) and whether that is a fresh reading: evidence of an
        // exam whose certification page could not be read is carried forward.
        evidence: new Set(),
        evidenceFresh: false,
      });
    }
    return exams.get(code);
  };

  for (const item of examinations) {
    const exam = ensureExam(item.code);
    exam.viaListing = true;
    if (item.name) exam.name = item.name;
    if (item.beta) exam.beta = true;
    exam.betaKnown = true;
    exam.evidence.add(item.beta ? "listing:beta" : "listing:ga");
    exam.evidenceFresh = true;
    if (item.examPage) exam.examPage = true;
    item.products.forEach((product) => exam.products.add(product));
  }

  for (const item of certifications) {
    const page = pages.get(item.slug);
    const before = previousCerts.get(item.slug);
    const codes = new Set(item.examCodes);
    if (page) page.exams.forEach((exam) => codes.add(exam.code));

    if (page && codes.size === 0) noExamPages.push(item.slug);
    if (before && before.exams.length > 0) {
      knownWithExams++;
      if (page && codes.size === 0) emptyPages.push(item.slug);
    }

    // Nothing to go on this run: keep what the tracker knew.
    if (before && before.exams.length > 0 && (!page || codes.size === 0)) {
      before.exams.forEach((code) => codes.add(code));
      warnings.push(
        page
          ? `"${item.slug}" lists no exam although the tracker knew ${before.exams.join(", ")}; kept the previous exam list.`
          : `Could not read the page of "${item.slug}"; kept the previous exam list.`,
      );
    }

    const beta = item.beta || (page?.beta ?? false);
    certs.set(item.slug, {
      slug: item.slug,
      title: item.title || page?.title || before?.title || item.slug,
      beta,
      products: item.products,
      types: item.types,
      exams: codes,
      pageRead: Boolean(page),
    });

    for (const code of codes) {
      const exam = ensureExam(code);
      exam.viaCert = true;
      exam.certs.set(item.slug, certs.get(item.slug).title);
      item.products.forEach((product) => exam.products.add(product));
    }

    if (!page) continue;

    // A page that was read gives a fresh reading for every exam it lists, even
    // when that reading is "nothing said about the beta status".
    for (const code of new Set([
      ...item.examCodes,
      ...page.exams.map((pageExam) => pageExam.code),
    ])) {
      ensureExam(code).evidenceFresh = true;
    }
    for (const pageExam of page.exams) {
      const exam = ensureExam(pageExam.code);
      if (pageExam.name) exam.name = pageExam.name;
      if (pageExam.beta) exam.beta = true;
      // A bare scheduling link or learn_exam meta tells nothing about the status.
      if (pageExam.betaKnown || pageExam.beta) exam.betaKnown = true;
      if (pageExam.examPage) exam.examPage = true;
      (pageExam.evidence ?? []).forEach((tag) => exam.evidence.add(tag));
    }
    // A beta certification with a single exam: that exam is the beta one.
    if (beta && codes.size === 1) {
      const exam = ensureExam([...codes][0]);
      exam.beta = true;
      exam.betaKnown = true;
      exam.evidence.add("certification-title:beta");
    }
    for (const announcement of page.announcements) {
      const targets = announcement.codes.length
        ? announcement.codes
        : [...codes];
      for (const code of targets) {
        ensureExam(code).announcements.set(announcement.url, announcement.text);
      }
    }
  }

  // A study guide is an exam signal of its own, but only for a code nobody
  // tracked yet: a known exam that no certification lists any more is not
  // touched (that would rewrite its certification links for no reason).
  const previousCodes = new Set(previous.exams.map((exam) => exam.code));
  for (const code of guideCodes) {
    if (!exams.has(code) && previousCodes.has(code)) continue;
    const exam = ensureExam(code);
    exam.studyGuide = true;
    exam.guideOnly = !exam.viaCert && !exam.viaListing;
  }

  // An exam page found by probing the exams the hub marks BETA or UPCOMING (see
  // probeExamPages): the exam page title is the most direct word on the beta
  // status, and for an exam nothing else lists yet it is the first sign of it.
  for (const [code, probe] of probes) {
    if (probe?.page) {
      const exam = ensureExam(code);
      exam.viaExamPage = true;
      exam.guideOnly = false;
      exam.examPage = true;
      if (probe.name && !exam.name) exam.name = probe.name;
      if (probe.beta) exam.beta = true;
      exam.betaKnown = true;
      exam.evidence.add(probe.beta ? "exam-page:beta" : "exam-page:ga");
      exam.evidenceFresh = true;
    }
    // A study guide page the sitemap does not list yet (probeExamPages): the
    // exam is on Learn, the sitemap just lags. Its title only gives a name.
    if (probe?.guide) {
      const exam = ensureExam(code);
      exam.studyGuide = true;
      exam.guideOnly = !exam.viaCert && !exam.viaListing && !exam.viaExamPage;
      if (probe.guideName && !exam.name) exam.name = probe.guideName;
    }
  }

  // A probe that got no answer is no evidence either way: the exam page tags of
  // the previous reading stay, whatever the certification page said this run (a
  // single 5xx must not rewrite the tracker or turn a beta exam "unconfirmed").
  for (const code of probeCodes) {
    const exam = exams.get(code);
    if (!exam || typeof probes.get(code)?.page === "boolean") continue;
    const before = previous.exams.find((candidate) => candidate.code === code);
    for (const tag of before?.betaEvidence ?? []) {
      if (typeof tag === "string" && tag.startsWith("exam-page:")) {
        exam.evidence.add(tag);
      }
    }
  }

  return { certs, exams, warnings, noExamPages, emptyPages, knownWithExams };
}

/** Where Learn showed an exam, for the report: "certification page", "study guide", or both. */
export function evidenceOf(seen) {
  const evidence = [];
  if (seen?.viaCert) evidence.push("certification page");
  else if (seen?.viaListing) evidence.push("exam listing");
  if (seen?.viaExamPage) evidence.push("exam page");
  if (seen?.studyGuide) evidence.push("study guide");
  return evidence;
}

/** Merges the scan into the previous tracker; records not seen are kept as they were. */
export function mergeTracker(previous, scan, today) {
  const previousExams = new Map(
    previous.exams.map((exam) => [exam.code, exam]),
  );
  const previousCerts = new Map(
    previous.certifications.map((cert) => [cert.slug, cert]),
  );
  const exams = new Map(previousExams);
  const certs = new Map(previousCerts);

  for (const [code, seen] of scan.exams) {
    const before = previousExams.get(code);
    exams.set(code, {
      code,
      name: seen.name || before?.name || "",
      beta: seen.betaKnown ? seen.beta : (before?.beta ?? seen.beta),
      // A fresh reading replaces the evidence (a callout that was taken down
      // must not keep an exam "beta"); an unread page keeps what was known.
      betaEvidence: seen.evidenceFresh
        ? sortedStrings([...seen.evidence])
        : (before?.betaEvidence ?? []),
      // Links to certifications missing from today's listing are kept, so a
      // listing that drops an item for a day does not rewrite the tracker twice.
      certifications: [
        ...[...seen.certs].map(([slug, title]) => ({ slug, title })),
        ...(before?.certifications ?? []).filter(
          (cert) => !scan.certs.has(cert.slug),
        ),
      ].sort((a, b) => byCodePoint(a.slug, b.slug)),
      products: sortedStrings(seen.products),
      // Only a confirmed exam page; an earlier confirmation is kept.
      url: seen.examPage ? examUrl(code) : (before?.url ?? ""),
      announcements: sortedStrings([
        ...(before?.announcements ?? []),
        ...seen.announcements.keys(),
      ]),
      firstSeen: before?.firstSeen ?? today,
      lastSeen: today,
    });
  }

  for (const [slug, seen] of scan.certs) {
    const before = previousCerts.get(slug);
    certs.set(slug, {
      slug,
      title: seen.title,
      beta: seen.beta,
      products: sortedStrings(seen.products),
      exams: sortedStrings(seen.exams),
      firstSeen: before?.firstSeen ?? today,
      lastSeen: today,
    });
  }

  return {
    certifications: [...certs.values()].sort((a, b) =>
      byCodePoint(a.slug, b.slug),
    ),
    exams: [...exams.values()].sort((a, b) => byCodePoint(a.code, b.code)),
  };
}

/** The tracker without lastSynced / lastSeen: what decides whether to rewrite it. */
export function trackerContent(tracker) {
  return JSON.stringify({
    certifications: tracker.certifications.map(({ lastSeen, ...rest }) => rest),
    exams: tracker.exams.map(({ lastSeen, ...rest }) => rest),
    studyGuides: tracker.studyGuides ?? [],
    certRenames: tracker.certRenames ?? [],
    effectiveDates: tracker.effectiveDates ?? [],
  });
}

// ---------------------------------------------------------------------------
// Step 4: what to alert on
// ---------------------------------------------------------------------------
/**
 * Splits the new records into alerts and silent entries. An exam is silent
 * when its family is ignored (IGNORED_PREFIXES) or it already has a hub page;
 * everything else is alerted, including a prefix that is neither mapped to a
 * hub area nor ignored (a new exam family). A certification is silent when it
 * is a MOS certification or all its exams are in ignored families; one that
 * lists no exam yet, or any other exam, is alerted.
 */
export function selectAlerts({ newExamCodes, newCertSlugs, scan, hubPage }) {
  const alertExams = [];
  const silentExams = [];
  for (const code of newExamCodes) {
    if (isIgnoredCode(code)) {
      silentExams.push({ code, reason: "outside the hub areas" });
    } else if (hubPage(code)) {
      silentExams.push({ code, reason: "hub page already exists" });
    } else {
      alertExams.push(code);
    }
  }

  const alertCerts = [];
  const silentCerts = [];
  for (const slug of newCertSlugs) {
    const cert = scan.certs.get(slug);
    const codes = [...cert.exams];
    if (cert.types.includes("mos")) {
      silentCerts.push({ slug, reason: "MOS certification" });
    } else if (codes.length > 0 && codes.every(isIgnoredCode)) {
      silentCerts.push({ slug, reason: "exams outside the hub areas" });
    } else {
      alertCerts.push(slug);
    }
  }

  return { alertExams, silentExams, alertCerts, silentCerts };
}

/**
 * "Study guide for Exam AZ-104: Name | Microsoft Learn" or "Exam AB-650: Name
 * (beta) - Certifications | Microsoft Learn" -> { name, beta }. Only the exam
 * page title carries the "(beta)" marker. A few study guides drop the word
 * "Exam" ("Study guide for PL-600: Name"); an exam page title always has it.
 */
export function parseExamNameFromTitle(html, code) {
  const rawTitle = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!rawTitle) return null;
  const title = stripTags(rawTitle[1])
    .replace(/\s*\|\s*Microsoft Learn$/i, "")
    .replace(/\s+-\s+Certifications$/i, "");
  const match = title.match(
    new RegExp(
      `^(?:Study guide for\\s+(?:Exam\\s+)?|Exam\\s+)${escapeRegExp(code)}\\s*:\\s*(.+)$`,
      "i",
    ),
  );
  if (!match) return null;
  const { text, beta } = splitBeta(match[1]);
  return text ? { name: text, beta } : null;
}

/**
 * Looks up what the certification page did not say about an exam that is about
 * to be alerted: the exam page first (its title gives the name and the beta
 * marker and proves the page exists; a redirect to the certification page has
 * a different title and counts as "no exam page"), then the study guide for a
 * name only. Best effort: a lookup that fails or runs out of time just leaves
 * the fields unknown, and the report says so.
 */
async function lookUpExamDetails(cfg, targets, deadline) {
  const found = new Map();
  for (const { code, needsName } of targets) {
    if (deadline.expired()) {
      console.error(
        `WARNING: the lookup deadline (LOOKUP_DEADLINE_MS=${cfg.lookupDeadlineMs}) was reached before ${code}.`,
      );
      break;
    }
    const lower = code.toLowerCase();
    const info = { name: "", beta: false, betaKnown: false, examPage: false };

    await sleep(cfg.fetchDelayMs);
    const page = await fetchText(
      cfg,
      `${cfg.baseUrl}/credentials/certifications/exams/${lower}/`,
      deadline,
    );
    const parsed = page.ok ? parseExamNameFromTitle(page.text, code) : null;
    if (parsed) {
      Object.assign(info, {
        name: parsed.name,
        beta: parsed.beta,
        betaKnown: true,
        examPage: true,
      });
    }

    if (needsName && !info.name) {
      await sleep(cfg.fetchDelayMs);
      const guide = await fetchText(
        cfg,
        `${cfg.baseUrl}/credentials/certifications/resources/study-guides/${lower}`,
        deadline,
      );
      const named = guide.ok ? parseExamNameFromTitle(guide.text, code) : null;
      if (named) {
        info.name = named.name;
        // Its title does not carry "(beta)" for beta exams, so only a marker counts.
        if (named.beta) Object.assign(info, { beta: true, betaKnown: true });
      }
    }

    if (needsName && !info.name) {
      console.error(`WARNING: could not find an official name for ${code}.`);
    }
    found.set(code, info);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step 4b: study guides (sitemap, page text, line diff)
// ---------------------------------------------------------------------------
const GUIDE_PATH_RE = new RegExp(
  `^/(?:en-us/)?credentials/certifications/resources/study-guides/(${CODE_SOURCE})/?$`,
  "i",
);

function sitemapLoc(entry) {
  const loc = entry.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
  if (!loc) return null;
  try {
    return new URL(decodeEntities(loc), PUBLIC_BASE).pathname;
  } catch {
    return null;
  }
}

/**
 * The credentials_en-us_<n>.xml files a sitemap index lists, as paths in
 * numeric order. Only the path is kept: the files are fetched from the
 * configured base URL, so an index can never send the monitor off-site.
 */
export function parseSitemapIndex(xml) {
  const files = new Map();
  for (const entry of String(xml).matchAll(
    /<sitemap>([\s\S]*?)<\/sitemap>/gi,
  )) {
    const path = sitemapLoc(entry[1]);
    const match = path?.match(SITEMAP_FILE_RE);
    if (match) files.set(path, Number(match[1]));
  }
  return [...files]
    .sort((a, b) => a[1] - b[1] || byCodePoint(a[0], b[0]))
    .map(([path]) => path);
}

/**
 * Certification study guides in a credentials sitemap: Map of exam code to the
 * sitemap <lastmod> (YYYY-MM-DD, "" when absent). The Applied Skills study
 * guides (/credentials/applied-skills/resources/study-guides/apl-NNNN) are
 * another monitor's business and never match.
 */
export function parseCredentialsSitemap(xml) {
  const guides = new Map();
  for (const entry of String(xml).matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const match = sitemapLoc(entry[1])?.match(GUIDE_PATH_RE);
    if (!match) continue;
    const code = match[1].toUpperCase();
    const lastmod =
      entry[1].match(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? "";
    const before = guides.get(code);
    if (before === undefined || lastmod > before) guides.set(code, lastmod);
  }
  return guides;
}

function describeFailure(response) {
  if (response.deadline) return "deadline reached";
  return `status ${response.status ?? response.error?.message ?? "network error"}`;
}

/**
 * The sitemap index, then every credentials_en-us_<n>.xml it lists (two small
 * requests today). Throws SitemapError when the guides cannot be trusted: any
 * file unreadable, or fewer than MIN_STUDY_GUIDES certification guides found
 * (the sitemap shape probably changed). The caller then skips all study guide
 * logic for the run.
 */
async function fetchStudyGuideSitemap(cfg, deadline) {
  const index = await fetchText(
    cfg,
    `${cfg.baseUrl}${SITEMAP_INDEX_PATH}`,
    deadline,
  );
  if (!index.ok) {
    throw new SitemapError(
      `the sitemap index ${SITEMAP_INDEX_PATH} could not be fetched (${describeFailure(index)})`,
    );
  }
  const files = parseSitemapIndex(index.text);
  if (files.length === 0) {
    throw new SitemapError(
      `the sitemap index lists no credentials_en-us_<n>.xml file`,
    );
  }

  const guides = new Map();
  for (const path of files) {
    await sleep(cfg.fetchDelayMs);
    const response = await fetchText(cfg, `${cfg.baseUrl}${path}`, deadline);
    if (!response.ok) {
      throw new SitemapError(
        `${path} could not be fetched (${describeFailure(response)})`,
      );
    }
    for (const [code, lastmod] of parseCredentialsSitemap(response.text)) {
      const before = guides.get(code);
      if (before === undefined || lastmod > before) guides.set(code, lastmod);
    }
  }
  if (guides.size < cfg.minStudyGuides) {
    throw new SitemapError(
      `the credentials sitemap lists only ${guides.size} certification study guides (expected at least ` +
        `${cfg.minStudyGuides}); its shape or the guide URLs probably changed`,
    );
  }
  return { guides, files };
}

const BLOCK_TAGS = [
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "blockquote",
  "section",
  "article",
  "aside",
  "details",
  "summary",
  "pre",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "nav",
  "header",
  "footer",
  "form",
  "fieldset",
  "main",
  "address",
];
const BLOCK_TAG_RE = new RegExp(
  `</?(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`,
  "gi",
);
// No-break and thin spaces count as spaces; soft hyphens, zero-width characters
// and the byte order mark are dropped. Built from code points on purpose: the
// characters are invisible in a source file.
const SPACE_LIKE_RE = new RegExp(
  `[${String.fromCharCode(0xa0, 0x2007, 0x202f)}]`,
  "g",
);
const INVISIBLE_RE = new RegExp(
  `[${String.fromCharCode(0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)}]`,
  "g",
);

/**
 * A fragment of a study guide as normalized text lines, so that re-wrapped
 * paragraphs, entities, extra whitespace, link targets, ids and classes cannot
 * change what is compared. One line per block: headings keep their level
 * ("### Title"), list items start with "- ", table rows join their cells with
 * " | ". Only the text of the page ever reaches the lines.
 */
export function htmlToLines(fragment) {
  const text = decodeEntities(
    String(fragment)
      // Source line breaks are only how Learn wraps its Markdown: they are
      // whitespace, never a block boundary (those are added below).
      .replace(/\s*[\r\n]+\s*/g, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(
        /<h([1-6])\b[^>]*>/gi,
        (_, level) => `\n${"#".repeat(Number(level))} `,
      )
      .replace(/<\/h[1-6]\s*>/gi, "\n")
      .replace(/<li\b[^>]*>(?:\s*<(?:p|div)\b[^>]*>)?/gi, "\n- ")
      .replace(/<\/t[dh]\s*>/gi, " | ")
      .replace(/<tr\b[^>]*>/gi, "\n")
      .replace(/<\/tr\s*>/gi, "\n")
      .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
      .replace(BLOCK_TAG_RE, "\n")
      .replace(/<[^>]*>/g, ""),
  );

  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .normalize("NFC")
      .replace(SPACE_LIKE_RE, " ")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*\|$/, "");
    // An empty heading or list item carries no text.
    if (!line || line === "-" || /^#{1,6}$/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

/** Index of the </div> that closes the block a position is in (or the end). */
function contentEnd(html, from) {
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 0;
  for (let tag; (tag = tags.exec(html));) {
    if (!tag[1]) {
      depth++;
    } else if (depth === 0) {
      return tag.index;
    } else {
      depth--;
    }
  }
  return html.length;
}

const UPDATES_SECTION_RE = /^(?:updates-to-the-exam|about-the-exam)$/i;
// Headings that end whatever section was open: Learn page chrome and the parts
// of a guide that are not hashed (links churn, the change log restates the
// skills in a table).
const GUIDE_BOUNDARY_RE =
  /^(?:ms--|purpose-of-this-document$|study-resources|change-log)/i;
// The callout boxes of Learn's Markdown ("> [!WARNING]"): <div class="WARNING">.
const CALLOUT_OPEN_RE =
  /<div\b[^>]*\bclass="(?:[^"]*\s)?(?:NOTE|IMPORTANT|WARNING|TIP|CAUTION)(?:\s[^"]*)?"[^>]*>/g;
const CONTENT_BLOCK_OPEN_RE =
  /<div\b[^>]*\bclass\s*=\s*["'](?:[^"']*\s)?content(?:\s[^"']*)?["'][^>]*>/gi;

/** The `<div class="content">` blocks of a page: [{ start, end }]. */
function contentBlocks(source) {
  return [...source.matchAll(CONTENT_BLOCK_OPEN_RE)].map((open) => ({
    start: open.index,
    end: contentEnd(source, open.index + open[0].length),
  }));
}

/**
 * The text of the callout boxes that sit in the content of a guide but outside
 * the hashed sections: before the first heading (AZ-801: "This exam was retired
 * on ...", PL-400: "PL-400 is transitioning to AB-400") and under "Purpose of
 * this document" (MS-102: "This exam will retire on ..."). Microsoft announces a
 * retirement, a transition, a certification rename or a cancelled beta there,
 * not in the "Updates to the exam" text. Boxes under the study resources and the
 * change log, and in the page chrome, are not guide text and are left out; boxes
 * inside a hashed section are already part of it.
 */
function guideNotices(source, headings, blocks) {
  const notices = [];
  let lastEnd = -1;
  for (const open of source.matchAll(CALLOUT_OPEN_RE)) {
    if (open.index < lastEnd) continue; // a box inside a box
    const block = blocks.find(
      (candidate) => candidate.start < open.index && open.index < candidate.end,
    );
    if (!block) continue;
    let region = "notices";
    for (const heading of headings) {
      if (heading.index > block.start && heading.index < open.index) {
        region = heading.region;
      }
    }
    if (region !== "notices") continue;
    lastEnd = contentEnd(source, open.index + open[0].length);
    notices.push(...htmlToLines(source.slice(open.index, lastEnd)));
  }
  return notices;
}

/**
 * Reads one study guide page: { ok, reason, name, updatedAt, missing, lines,
 * hash }. The text that is hashed is the notices of the guide (callout boxes
 * outside the sections below, see guideNotices; under a fixed "## Notices"
 * heading), the "Updates to the exam" section (also named "About the exam" on
 * newer guides) and every "Skills measured" section, normalized by htmlToLines.
 * Verified against all 84 guides on 2026-10-09:
 *   - the skills heading id carries a date ("skills-measured-as-of-<date>"; 70
 *     of 84) or is plain "skills-measured", and a guide may hold two versions
 *     ("...-prior-to-<date>", sometimes after the change log);
 *   - stray <h2> headings inside the skills text (GH-500, SC-730, PL-600) and a
 *     skills part under "Domains" without any "skills-measured" id (GH-900) are
 *     part of the skills, so a section runs to the next boundary heading
 *     (study resources, change log, page chrome) or the end of the content
 *     block, not to the next <h2>.
 * Never throws: a page that is not that study guide, or that holds neither
 * section (notices alone do not make a guide), comes back with ok=false and
 * nothing to hash.
 */
export function parseStudyGuide(html, code) {
  const source = String(html ?? "");
  const named = parseExamNameFromTitle(source, code);
  const updatedAt =
    metaTags(source)
      .find((meta) => meta.name === "updated_at")
      ?.content?.trim() ?? "";

  const blocks = contentBlocks(source);
  const blockOf = (index) =>
    blocks.findIndex((block) => block.start < index && index < block.end);
  // `region` says what a callout box under a heading belongs to: "hashed" (a
  // section that is hashed anyway), "notices" (guide text outside the sections)
  // or "skip" (study resources, change log, page chrome).
  const headings = [
    ...source.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2\s*>/gi),
  ].map((match) => ({
    index: match.index,
    id: attributesOf(match[1]).id ?? "",
    text: stripTags(match[2]),
    region: "skip",
  }));

  const updatesLines = [];
  const skillsLines = [];
  let mode = null;
  let limit = -1;
  let region = "skip";
  let lastBlock = -2;
  headings.forEach((heading, position) => {
    const block = blockOf(heading.index);
    if (block !== lastBlock) {
      // A new content block starts with its own preamble.
      region = block < 0 ? "skip" : "notices";
      lastBlock = block;
    }
    // A heading beyond the content block (page chrome) opens nothing.
    if (limit >= 0 && heading.index >= limit) mode = null;
    if (GUIDE_BOUNDARY_RE.test(heading.id)) {
      mode = null;
      region = /^purpose-of-this-document$/i.test(heading.id)
        ? "notices"
        : "skip";
      heading.region = region;
      return;
    }
    let kind = null;
    if (UPDATES_SECTION_RE.test(heading.id)) kind = "updates";
    else if (
      /^skills-measured/i.test(heading.id) ||
      /^skills measured\b/i.test(heading.text)
    ) {
      kind = "skills";
    } else if (mode === "skills" || mode === "updates") {
      // A heading inside the skills text, or the first one after the update
      // notes (GH-900 names it "Domains").
      kind = "skills";
    }
    if (!kind) {
      heading.region = region;
      return;
    }
    mode = kind;
    region = "hashed";
    heading.region = region;

    const blockEnd = contentEnd(source, heading.index);
    limit = blockEnd;
    const end = Math.min(
      headings[position + 1]?.index ?? source.length,
      blockEnd,
    );
    const lines = htmlToLines(source.slice(heading.index, end));
    if (lines.length === 0) return;
    if (kind === "updates") {
      // The heading wording differs between guides ("About the exam"): the
      // section is the same one, so its label is fixed.
      if (/^## /.test(lines[0])) lines.shift();
      updatesLines.push("## Updates to the exam", ...lines);
    } else {
      skillsLines.push(...lines);
    }
  });

  const notices = guideNotices(source, headings, blocks);
  const lines = [
    ...(notices.length > 0 ? ["## Notices", ...notices] : []),
    ...updatesLines,
    ...skillsLines,
  ];
  const missing = [];
  if (updatesLines.length === 0) missing.push("updates");
  if (skillsLines.length === 0) missing.push("skills");

  let reason = "";
  if (!named) reason = `not the study guide page of ${code}`;
  else if (updatesLines.length + skillsLines.length === 0) {
    reason =
      "found neither an Updates to the exam nor a Skills measured section";
  }
  // The page's own heading usually repeats the exam name; on a few guides
  // (AB-620) it words it differently than the title does.
  const heading = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const headingMatch = heading
    ? stripTags(heading[1]).match(
        new RegExp(
          `^Study guide for\\s+(?:Exam\\s+)?${escapeRegExp(code)}\\s*:\\s*(.+)$`,
          "i",
        ),
      )
    : null;
  return {
    ok: reason === "",
    reason,
    name: named?.name ?? "",
    headingName: headingMatch ? splitBeta(headingMatch[1]).text : "",
    updatedAt,
    missing,
    lines,
    hash: reason === "" ? hashLines(lines) : null,
  };
}

export function hashLines(lines) {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Line diff of two normalized texts: [{ t: "=" | "-" | "+", line }]. Common
 * head and tail are trimmed, the rest is a longest-common-subsequence diff
 * (guides are a few hundred lines); a pathological size falls back to "all old
 * lines removed, all new lines added" for the differing middle.
 */
export function diffLines(oldLines, newLines) {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > head &&
    newEnd > head &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const a = oldLines.slice(head, oldEnd);
  const b = newLines.slice(head, newEnd);

  const ops = oldLines.slice(0, head).map((line) => ({ t: "=", line }));
  if (a.length * b.length > 4_000_000) {
    ops.push(...a.map((line) => ({ t: "-", line })));
    ops.push(...b.map((line) => ({ t: "+", line })));
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ t: "=", line: a[i] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ t: "-", line: a[i++] });
      } else {
        ops.push({ t: "+", line: b[j++] });
      }
    }
    while (i < a.length) ops.push({ t: "-", line: a[i++] });
    while (j < b.length) ops.push({ t: "+", line: b[j++] });
  }
  ops.push(...oldLines.slice(oldEnd).map((line) => ({ t: "=", line })));
  return ops;
}

/**
 * The changed lines of two normalized texts, grouped into hunks that each carry
 * the heading path they sit under: { added, removed, entries } with entries
 * { kind: "hunk", context } and { kind: "-" | "+", line }.
 */
export function summarizeDiff(oldLines, newLines) {
  const entries = [];
  const path = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;
  const enter = (line) => {
    const heading = line.match(/^(#{1,6}) (.*)$/);
    if (!heading) return;
    const level = heading[1].length;
    path.length = level - 1;
    path[level - 1] = heading[2];
  };
  // The headings a hunk sits under; a hunk that starts with a heading sits
  // under that heading's parents only.
  const context = (first) => {
    const level = first.match(/^(#{1,6}) /)?.[1].length ?? 7;
    return path
      .slice(0, level - 1)
      .filter(Boolean)
      .slice(-2)
      .join(" > ");
  };

  for (const { t, line } of diffLines(oldLines, newLines)) {
    if (t === "=") {
      inHunk = false;
      enter(line);
      continue;
    }
    if (!inHunk) {
      entries.push({ kind: "hunk", context: context(line) });
      inHunk = true;
    }
    entries.push({ kind: t, line });
    if (t === "+") {
      added++;
      enter(line);
    } else {
      removed++;
    }
  }
  return { added, removed, entries };
}

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The diff as the lines of a fenced `diff` block: "@@ heading path @@" before a
 * hunk, then "- old" / "+ new" lines, at most `maxLines` of them. Returns the
 * text, how many changed lines it shows and how many it left out.
 */
export function renderDiff(entries, maxLines) {
  const out = [];
  let shown = 0;
  let omitted = 0;
  let hunk = null;
  for (const entry of entries) {
    if (entry.kind === "hunk") {
      hunk = entry;
      continue;
    }
    if (shown >= maxLines) {
      omitted++;
      continue;
    }
    if (hunk) {
      out.push(
        `@@ ${clip(hunk.context || "top of the compared text", 160)} @@`,
      );
      hunk = null;
    }
    out.push(
      `${entry.kind} ${clip(entry.line, DIFF_LINE_MAX_CHARS).replace(/`{3,}/g, "'''")}`,
    );
    shown++;
  }
  return { text: out.join("\n"), shown, omitted };
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DATED_RE = new RegExp(
  `\\b(?:${MONTHS})\\s+(?:\\d{1,2},\\s*)?\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  "i",
);

/**
 * Added lines that state a date ("Skills measured as of October 14, 2026"),
 * verbatim without the heading / bullet marker this script adds. They are
 * quoted in the report as "from the study guide": they are never an exam date
 * or a beta start date.
 */
export function datedStatements(entries) {
  const found = [];
  for (const entry of entries) {
    if (entry.kind !== "+") continue;
    const text = entry.line.replace(/^#{1,6} /, "").replace(/^- /, "");
    if (DATED_RE.test(text) && !found.includes(text)) found.push(text);
    if (found.length >= MAX_DATED_STATEMENTS) break;
  }
  return found;
}

/**
 * Which guides to read this run: [{ code, ifModifiedSince }], by code. Only
 * guides of exams the hub covers are ever read, and every one of them is read
 * every run: the sitemap `<lastmod>` lags the page (a guide can publish new
 * skills a month before the sitemap date moves), so it cannot be the trigger.
 * The `Last-Modified` the server sent last time keeps this cheap: sent back as
 * `ifModifiedSince`, an unchanged page answers 304 without a body. A guide is
 * read without it (a full read) when there is no hash or validator yet, when its
 * sitemap date moved, and for a baseline or forced re-baseline (`fetchAll`), so
 * a changed normalization cannot hide behind a server that says "not modified".
 * The hash of the text, never a date, decides whether anything changed.
 */
export function selectGuidesToFetch({
  sitemap,
  previousGuides,
  covered,
  fetchAll,
}) {
  const selected = [];
  for (const [code, lastmod] of sitemap) {
    if (!covered(code)) continue;
    const before = previousGuides.get(code);
    const full =
      fetchAll ||
      !before?.hash ||
      !before.lastModified ||
      !before.name ||
      before.lastmod !== lastmod;
    selected.push({ code, ifModifiedSince: full ? "" : before.lastModified });
  }
  return selected.sort((a, b) => byCodePoint(a.code, b.code));
}

/**
 * Turns the guide reads into the new study guide records and the findings.
 * `results` maps a code to { status: "ok" | "notModified" | "failed" |
 * "unparsed", guide?, reason? }; a selected code without a result was never
 * started. Rules:
 *   - a fetch failure (or a guide never started) keeps the previous record and
 *     is retried next run; it is never evidence of a change;
 *   - "not modified" (the server confirmed the stored Last-Modified) keeps the
 *     record and mirrors the sitemap date;
 *   - a guide that cannot be parsed, or that lost a section it had before, keeps
 *     its record too and is only reported as a warning (see `degraded`);
 *   - the first hash of a guide is recorded silently; a date that moved with
 *     identical text is recorded silently; a different hash is a change;
 *   - `silent` (a baseline, FORCE_GUIDE_BASELINE) records a different hash
 *     silently instead (`rebaselined`), a lost section included; only a page
 *     that does not parse is never recorded;
 *   - guides missing from today's sitemap stay as they were.
 */
export function applyGuideResults({
  sitemap,
  previousGuides,
  selected,
  results,
  silent,
  today,
}) {
  const guides = new Map(previousGuides);
  const out = {
    guides: [],
    changes: [],
    dateOnly: [],
    republished: [],
    unchanged: [],
    baselined: [],
    rebaselined: [],
    failed: [],
    unparsed: [],
    degraded: [],
  };

  for (const [code, lastmod] of sitemap) {
    const before = previousGuides.get(code);
    const stub = () =>
      before ?? {
        code,
        lastmod,
        hash: null,
        updatedAt: "",
        firstSeen: today,
        lastChanged: null,
      };
    if (!selected.has(code)) {
      // Not fetched: the record mirrors the sitemap date.
      guides.set(code, before ? { ...before, lastmod } : stub());
      continue;
    }

    const result = results.get(code);
    if (result?.status === "notModified" && before?.hash) {
      guides.set(code, { ...before, lastmod });
      out.unchanged.push(code);
      continue;
    }
    if (
      !result ||
      result.status === "failed" ||
      result.status === "notModified"
    ) {
      guides.set(code, stub());
      out.failed.push({
        code,
        reason:
          result?.status === "notModified"
            ? "answered 304 without a stored text"
            : (result?.reason ?? "not fetched (deadline or too many failures)"),
      });
      continue;
    }
    if (result.status === "unparsed") {
      guides.set(code, stub());
      out.unparsed.push({ code, reason: result.reason });
      continue;
    }

    const { guide } = result;
    const fresh = (lastChanged) =>
      normalizeGuide(
        {
          code,
          name: guide.name,
          headingName: guide.headingName,
          lastmod,
          hash: guide.hash,
          updatedAt: guide.updatedAt,
          lastModified: guide.lastModified,
          firstSeen: before?.firstSeen ?? today,
          lastChanged,
          missing: guide.missing,
          lines: guide.lines,
        },
        today,
      );

    if (!before?.hash) {
      guides.set(code, fresh(before?.lastChanged ?? null));
      out.baselined.push(code);
    } else if (before.hash === guide.hash) {
      const record = fresh(before.lastChanged);
      guides.set(code, record);
      if (before.lastmod !== lastmod) {
        out.dateOnly.push({ code, from: before.lastmod, to: lastmod });
      } else if (
        before.updatedAt !== record.updatedAt ||
        (before.lastModified ?? "") !== (record.lastModified ?? "")
      ) {
        // Republished with the same text (a template rebuild, a renamed
        // title): recorded so the server's validator stays current.
        out.republished.push({
          code,
          from: before.updatedAt,
          to: record.updatedAt,
          modifiedFrom: before.lastModified ?? "",
          modifiedTo: record.lastModified ?? "",
        });
      }
    } else if (silent) {
      guides.set(code, fresh(before.lastChanged));
      out.rebaselined.push(code);
    } else {
      const lost = ["updates", "skills"].filter(
        (section) =>
          !(before.missing ?? []).includes(section) &&
          guide.missing.includes(section),
      );
      if (lost.length > 0) {
        guides.set(code, before);
        out.degraded.push({ code, sections: lost });
      } else {
        guides.set(code, fresh(today));
        out.changes.push({
          code,
          name: guide.name,
          lastmodBefore: before.lastmod,
          lastmod,
          updatedAtBefore: before.updatedAt,
          updatedAt: guide.updatedAt,
          missing: guide.missing,
          diff: Array.isArray(before.lines)
            ? summarizeDiff(before.lines, guide.lines)
            : null,
        });
      }
    }
  }

  out.guides = [...guides.values()].sort((a, b) => byCodePoint(a.code, b.code));
  // The sitemap lists the guides in no useful order; the findings are sorted.
  for (const key of [
    "changes",
    "dateOnly",
    "republished",
    "failed",
    "unparsed",
    "degraded",
  ]) {
    out[key].sort((a, b) => byCodePoint(a.code, b.code));
  }
  out.unchanged.sort(byCodePoint);
  out.baselined.sort(byCodePoint);
  out.rebaselined.sort(byCodePoint);
  return out;
}

/**
 * Fetches and parses one study guide: { code, status, guide?, reason? }.
 * `ifModifiedSince` makes it a conditional request; "notModified" is the 304.
 */
async function readStudyGuide(cfg, code, ifModifiedSince, deadline) {
  const response = await fetchText(
    cfg,
    `${cfg.baseUrl}/en-us/credentials/certifications/resources/study-guides/${code.toLowerCase()}`,
    deadline,
    ifModifiedSince
      ? {
          headers: { "If-Modified-Since": ifModifiedSince },
          notModified: true,
        }
      : {},
  );
  if (response.notModified) return { code, status: "notModified" };
  if (!response.ok) {
    return { code, status: "failed", reason: describeFailure(response) };
  }
  const guide = parseStudyGuide(response.text, code);
  return guide.ok
    ? {
        code,
        status: "ok",
        guide: { ...guide, lastModified: response.lastModified },
      }
    : { code, status: "unparsed", reason: guide.reason };
}

/**
 * Reads the covered guides and applies the results. When too many covered
 * guides look different in one run (a changed hash, a page that no longer
 * parses or a lost section on more than MAX_GUIDE_CHANGES guides, or on more
 * than MAX_GUIDE_CHANGE_PCT of them) that is a markup or normalization change on
 * Learn, not news: the failsafe discards the study guide results of the run
 * (every guide record stays as it was, nothing is reported for them) and
 * returns its message as `failsafe`. It never throws, so the exam detection is
 * not affected. `silent` (FORCE_GUIDE_BASELINE, FORCE_BASELINE, a baseline)
 * accepts new text and lost sections, so only pages that do not parse count.
 */
async function checkStudyGuides(
  cfg,
  { sitemap, previous, covered, silent, deadline },
) {
  const previousGuides = new Map(
    previous.studyGuides.map((guide) => [guide.code, guide]),
  );
  const selected = selectGuidesToFetch({
    sitemap: sitemap.guides,
    previousGuides,
    covered,
    fetchAll: silent,
  });

  const results = new Map();
  let failures = 0;
  await mapPool(
    selected,
    CONCURRENCY,
    cfg.fetchDelayMs,
    async ({ code, ifModifiedSince }) => {
      const result = await readStudyGuide(cfg, code, ifModifiedSince, deadline);
      if (result.status === "failed") failures++;
      results.set(code, result);
    },
    () => deadline.expired() || failures >= cfg.maxGuideFetchFailures,
  );

  const applied = applyGuideResults({
    sitemap: sitemap.guides,
    previousGuides,
    selected: new Set(selected.map((entry) => entry.code)),
    results,
    silent,
    today: cfg.today,
  });

  const coveredTracked = [...sitemap.guides.keys()].filter(
    (code) => covered(code) && previousGuides.get(code)?.hash,
  ).length;
  const base = Math.max(coveredTracked, selected.length);
  const suspicious =
    applied.changes.length + applied.unparsed.length + applied.degraded.length;
  const pct = base > 0 ? (suspicious * 100) / base : 0;
  let failsafe = null;
  if (
    suspicious > cfg.maxGuideChanges ||
    (base >= GUIDE_PCT_MIN_BASE && pct > cfg.maxGuideChangePct)
  ) {
    const examples = [
      ...applied.changes.map((change) => change.code),
      ...applied.unparsed.map((entry) => entry.code),
      ...applied.degraded.map((entry) => entry.code),
    ].slice(0, 5);
    failsafe =
      `${suspicious} of the ${base} covered study guides looked different in one run ` +
      `(${applied.changes.length} changed text, ${applied.unparsed.length} no longer parse, ` +
      `${applied.degraded.length} lost a section; ${pct.toFixed(1)}%, limits MAX_GUIDE_CHANGES ${cfg.maxGuideChanges} / ` +
      `MAX_GUIDE_CHANGE_PCT ${cfg.maxGuideChangePct}%). That points to a markup or normalization change on ` +
      "Microsoft Learn, not news. The study guide results of this run were discarded: every study guide record " +
      "stays as it was and nothing is reported for the guides; the exam check ran as usual. " +
      `Examples: ${examples.join(", ")}. If the changes are real, run the workflow manually with ` +
      "`force_guide_baseline` enabled (or run the script locally with FORCE_GUIDE_BASELINE=1 and commit the " +
      "tracker): it re-reads every covered guide and records the new text silently, a lost section included. " +
      "A page that does not parse is never recorded, so many of them keep tripping this check until the parser " +
      "is fixed. FORCE_BASELINE does the same, but also records every new exam and certification silently.";
  }
  if (failsafe) {
    return {
      ...applied,
      guides: previous.studyGuides,
      changes: [],
      dateOnly: [],
      republished: [],
      unchanged: [],
      baselined: [],
      rebaselined: [],
      selected,
      results,
      failsafe,
    };
  }

  return { ...applied, selected, results, failsafe: null };
}

// ---------------------------------------------------------------------------
// Step 5: report
// ---------------------------------------------------------------------------
const cell = (text) =>
  collapse(text).replace(/\|/g, "\\|").replace(/[[\]]/g, "\\$&") || "—";
const plainCell = (text) => collapse(text).replace(/\|/g, "\\|") || "—";

// A URL from a Learn page goes into a Markdown link: keep it from ending the link early.
function markdownUrl(url) {
  return url.replace(
    /[()\s]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function shellQuote(text) {
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * "New Microsoft Learn exam: AB-651; study guide updated: AZ-104, SC-300". Names
 * the exams, the certifications and the updated study guides, at most 200
 * characters: when the full list does not fit, fewer codes are named (with "+N
 * more") before anything is cut, so the study guide part survives a long list
 * of new exams.
 */
export function buildIssueTitle({ exams, certs, guides = [] }) {
  const limit = 200;
  const clean = (text) => collapse(text.replace(/[\u0000-\u001f\u007f]/g, " "));
  const build = (maxCodes) => {
    const parts = [];
    if (exams.length > 0) {
      const shown = exams
        .slice(0, maxCodes)
        .map((exam) => (exam.beta ? `${exam.code} (beta)` : exam.code));
      const more = exams.length - shown.length;
      let part =
        `New Microsoft Learn ${exams.length === 1 ? "exam" : "exams"}: ${shown.join(", ")}` +
        (more > 0 ? ` +${more} more` : "");
      if (certs.length > 0) {
        part += `; ${certs.length} new certification${certs.length === 1 ? "" : "s"}`;
      }
      parts.push(part);
    } else if (certs.length > 0) {
      const shown = certs
        .slice(0, Math.min(2, maxCodes))
        .map((c) => safeText(c.title));
      const more = certs.length - shown.length;
      parts.push(
        `New Microsoft Learn certification${certs.length === 1 ? "" : "s"}: ${shown.join(", ")}` +
          (more > 0 ? ` +${more} more` : ""),
      );
    }
    if (guides.length > 0) {
      const shown = guides.slice(0, maxCodes).map((guide) => guide.code);
      const more = guides.length - shown.length;
      parts.push(
        `${parts.length > 0 ? "study guide" : "Microsoft Learn study guide"} updated: ${shown.join(", ")}` +
          (more > 0 ? ` +${more} more` : ""),
      );
    }
    return clean(parts.join("; "));
  };

  for (const maxCodes of [6, 4, 3, 2, 1]) {
    const title = build(maxCodes);
    if (title.length <= limit) return title;
  }
  return `${build(1).slice(0, limit - 1)}…`;
}

/**
 * "BETA", "GA", or an honest "unknown": GA is only printed when a source
 * positively said so (`exam.betaKnown`). A beta certification is worth a hint.
 */
function statusCell(exam, scan) {
  if (exam.beta) return "BETA";
  if (exam.betaKnown) return "GA";
  const certificationBeta = exam.certifications.some(
    (cert) => scan.certs?.get(cert.slug)?.beta,
  );
  return certificationBeta
    ? "unknown (its certification is BETA), check Learn"
    : "unknown, check Learn";
}

/**
 * The confirmed exam page, else the certification page, else (an exam only a
 * study guide shows so far) the study guide, else nothing.
 */
function examLinkCell(exam) {
  if (exam.url) return `[Exam page](${markdownUrl(exam.url)})`;
  const cert = exam.certifications[0];
  if (cert) {
    return `[Certification page](${markdownUrl(certificationUrl(cert.slug))}) (no exam page confirmed)`;
  }
  return (exam.evidence ?? []).includes("study guide")
    ? `[Study guide](${markdownUrl(studyGuideUrl(exam.code))}) (no exam page confirmed)`
    : "—";
}

/** "2026-03-19 → 2026-10-08", with "—" for a value that is not known. */
const arrowCell = (before, now) => `${before || "—"} → ${now || "—"}`;

const GUIDE_STEPS =
  "#### What to do\n\n" +
  "1. Open the study guide and the hub exam page from the table and read the changes in context.\n" +
  "2. Check the exam page's resources (Learn courses and paths, labs, videos, tests) against the changed skills. Add, " +
  'replace or remove a resource only after verifying it on Microsoft Learn ("Content Rules" in `AGENTS.md`); never ' +
  "infer a course, lab or URL.\n" +
  '3. If a "Notices" box (a warning, note or important box of the guide, where Microsoft announces a retirement, a ' +
  'transition to another exam, a certification rename or a cancelled beta) or the "Updates to the exam" text announces ' +
  "a retirement or replacement, follow the retirement rules in " +
  '`docs/monitors/beta-and-retiring-exams.md` ("Retiring exam tracker", "Adding a new exam to either tracker") and "At Risk Exam Treatment" in `AGENTS.md`: the ' +
  "`:::caution` banner, the `RETIRING` badge in `src/data_files/exam-status.mjs` and the entry in " +
  "`src/data_files/retiring-exams.json`. Do not invent dates: take them from the official announcement.\n" +
  '4. Dates quoted from a study guide are labelled "from the study guide". Never use one as the beta start date of an ' +
  'exam: that date must come from the official announcement ("Beta Exam Pages" in `AGENTS.md`).\n' +
  "5. If you changed resources, run `node scripts/audit-missing-resources.mjs`, commit the regenerated " +
  "`src/data_files/missing-resources.json`, then run `pnpm build`.\n\n" +
  'See the "New Exam Monitor" runbook (`docs/monitors/new-exam-monitor.md`) for the full process.';

// Stops GitHub from turning "@name" into a mention or "#123" into a reference.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * A name taken from a Learn page, for a heading or a table cell of a public
 * issue: no HTML, links or code spans, and no @mention or #123 cross-reference
 * (a zero-width space after the sign stops GitHub from linking it).
 */
function safeText(text) {
  return collapse(
    collapse(text)
      .replace(/[<>`[\]]/g, " ")
      .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
      .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE),
  );
}

/** Learn text in a table cell or a link text: safeText, and the pipe escaped. */
const learnCell = (text) => plainCell(safeText(text));

/** The "Study guides updated" section: table, per guide diff, steps. */
function buildGuideSection(guides, { perGuide, total }, shortened) {
  const sorted = [...guides].sort((a, b) => byCodePoint(a.code, b.code));
  const rows = sorted.map((guide) => {
    const hubPath = hubPagePath(guide.code);
    const lines = guide.diff
      ? `+${guide.diff.added} / -${guide.diff.removed}`
      : "not stored";
    return (
      `| ${guide.code}${guide.name ? ` ${learnCell(guide.name)}` : ""} | ` +
      `[Study guide](${markdownUrl(studyGuideUrl(guide.code))}) | ` +
      `${hubPath ? `\`${hubPath}\`` : "—"} | ${lines} | ` +
      `${arrowCell(guide.lastmodBefore, guide.lastmod)} | ` +
      `${arrowCell(guide.updatedAtBefore, guide.updatedAt)} |`
    );
  });

  let remaining = total;
  const blocks = sorted.map((guide) => {
    const parts = [
      `#### ${guide.code}${guide.name ? `: ${safeText(guide.name)}` : ""}`,
    ];
    if (!guide.diff) {
      parts.push(
        "The previous text was not stored, so there is no line diff. Compare the study guide with the exam page.",
      );
    } else if (guide.diff.added + guide.diff.removed === 0) {
      parts.push(
        "No line differs from the stored text (the stored hash did not match it).",
      );
    } else {
      const rendered = renderDiff(
        guide.diff.entries,
        Math.min(perGuide, remaining),
      );
      remaining -= rendered.shown;
      parts.push(
        `Changed text, from the study guide (\`-\` removed, \`+\` added; ${guide.diff.added} added and ${guide.diff.removed} removed lines):`,
      );
      if (rendered.shown > 0) {
        parts.push("```diff\n" + rendered.text + "\n```");
      }
      if (rendered.omitted > 0) {
        parts.push(
          `${rendered.omitted} more changed line${rendered.omitted === 1 ? " is" : "s are"} not shown here ` +
            `(at most ${perGuide} lines per study guide, ${total} in total, to stay under GitHub's issue size limit). ` +
            "Open the study guide for the rest.",
        );
      }
      const dated = datedStatements(guide.diff.entries);
      if (dated.length > 0) {
        // In a code fence: guide text can hold @mentions, #123 references, links
        // or HTML, which must not come alive in a public issue.
        parts.push(
          "Dated statements in the added lines (from the study guide, quoted verbatim; they are not exam or beta start dates):\n\n" +
            "```text\n" +
            dated
              .map(
                (text) =>
                  `- "${clip(text, DATED_STATEMENT_MAX_CHARS)
                    .replace(/\r?\n/g, " ")
                    .replace(/`{3,}/g, "'''")}"`,
              )
              .join("\n") +
            "\n```",
        );
      }
    }
    if ((guide.missing ?? []).length > 0) {
      parts.push(
        `Not found in the page markup: ${guide.missing
          .map((section) =>
            section === "updates"
              ? 'the "Updates to the exam" section'
              : 'the "Skills measured" section',
          )
          .join(" and ")}.`,
      );
    }
    return parts.join("\n\n");
  });

  return [
    `### Study guides updated (${guides.length})`,
    'The "Notices" (the warning, note and important boxes of the guide), "Updates to the exam" or "Skills measured" ' +
      "text of the study guide changed for an exam the hub covers. " +
      "A change of a date alone (Microsoft Learn sitemap, page) is not reported, only a change of the text. " +
      "**Sitemap lastmod** and **updated_at** are when Learn says it modified the page; they are not exam dates. " +
      "Every date quoted below is from the study guide and is not confirmed anywhere else." +
      (shortened
        ? " The diffs are shortened to keep this issue under GitHub's size limit."
        : ""),
    "| Exam | Study guide | Hub page | Changed lines | Sitemap lastmod | Page updated_at |\n" +
      "|------|-------------|----------|---------------|-----------------|-----------------|\n" +
      rows.join("\n"),
    ...blocks,
    GUIDE_STEPS,
  ].join("\n\n");
}

/**
 * An exam the new certifications list that is already tracked (so it is not
 * reported as new again) and still has no hub page: typically an exam reported
 * earlier from its study guide, before any certification page listed it. The
 * certification page now adds its status and announcements, which the earlier
 * issue could not show. Shaped like an alerted exam so the same table and
 * checklist serve it.
 */
function followUpExam(code, scan, trackedExams) {
  const seen = scan.exams?.get(code);
  const tracked = trackedExams.get(code);
  return {
    code,
    name: seen?.name || tracked?.name || "",
    beta: Boolean(seen?.beta || tracked?.beta),
    betaKnown: Boolean(seen?.betaKnown || seen?.beta || tracked?.beta),
    certifications: seen
      ? [...seen.certs].map(([slug, title]) => ({ slug, title }))
      : (tracked?.certifications ?? []),
    products: seen ? [...seen.products] : (tracked?.products ?? []),
    url: tracked?.url || (seen?.examPage ? examUrl(code) : ""),
    announcements: [],
    firstSeen: tracked?.firstSeen ?? "",
    evidence: seen ? evidenceOf(seen) : [],
  };
}

const EXAM_TABLE_HEADER =
  "| Code | Official name | Status | Certification | Products | Page to create | Exam link | Announcement | Evidence | First detected |\n" +
  "|------|---------------|--------|---------------|----------|----------------|-----------|--------------|----------|----------------|\n";

/** One row of the exams table. */
function examRow(exam, scan) {
  const announced = [...(scan.exams?.get(exam.code)?.announcements ?? [])];
  const announcementLinks = announced.length
    ? announced
        .map(
          ([url, text]) =>
            `[${learnCell(text || "Announcement")}](${markdownUrl(url)})`,
        )
        .join("<br>")
    : "—";
  const certificationLinks = exam.certifications.length
    ? exam.certifications
        .map(
          (cert) =>
            `[${learnCell(cert.title)}](${certificationUrl(cert.slug)})`,
        )
        .join("<br>")
    : "—";
  const pagePath = hubPagePath(exam.code);
  // No certification lists an exam that only a study guide shows so far.
  const missingName =
    exam.certifications.length > 0
      ? "_not published on the certification page, check the study guide_"
      : "_not found yet, check the study guide_";
  return (
    `| ${exam.code} | ${exam.name ? learnCell(exam.name) : missingName} | ` +
    `${statusCell(exam, scan)} | ${certificationLinks} | ${learnCell(exam.products.join(", "))} | ` +
    `${pagePath ? `\`${pagePath}\`` : "_no hub area for this prefix, see below_"} | ${examLinkCell(exam)} | ${announcementLinks} | ` +
    `${(exam.evidence ?? []).join(" + ") || "—"} | ${exam.firstSeen || "—"} |`
  );
}

export function buildReport({
  exams,
  certs,
  guides = [],
  scan,
  today,
  hubPage = () => false,
  trackedExams = new Map(),
}) {
  const hasNew = exams.length > 0 || certs.length > 0;
  const sections = hasNew
    ? [
        "## New on Microsoft Learn",
        `Detected by the New Exam Monitor on ${today} (UTC). **First detected** is the day this monitor first saw ` +
          "the exam or certification listed on Microsoft Learn. It is not the day the beta began or the day " +
          "Microsoft announced it.",
      ]
    : [
        "## Study guides updated on Microsoft Learn",
        `Detected by the New Exam Monitor on ${today} (UTC).`,
      ];

  if (exams.length > 0) {
    sections.push(
      `### New exams (${exams.length})\n\n` +
        "**Evidence** is what showed the exam on Microsoft Learn: a certification page that lists it, a published study guide, " +
        "or both. A study guide can appear before any certification page lists its exam; the certification page then adds " +
        "the certification, the status and the announcements (the exam is not reported again as a new exam; the issue " +
        "for that certification lists it then).\n\n" +
        EXAM_TABLE_HEADER +
        exams.map((exam) => examRow(exam, scan)).join("\n"),
    );
  }

  if (certs.length > 0) {
    const rows = certs.map(
      (cert) =>
        `| [${learnCell(cert.title)}](${certificationUrl(cert.slug)}) | ${cert.beta ? "BETA" : "GA"} | ` +
        `${cert.exams.length ? cert.exams.map((code) => (hubPage(code) ? `${code} (hub page exists)` : isUnmappedFamily(code) ? `${code} (no hub area)` : code)).join(", ") : "none listed yet"} | ${learnCell(cert.products.join(", "))} | ${cert.firstSeen} |`,
    );
    sections.push(
      `### New certifications (${certs.length})\n\n` +
        "| Certification | Status | Exams | Products | First detected |\n" +
        "|---------------|--------|-------|----------|----------------|\n" +
        rows.join("\n"),
    );
  }

  // Exams the new certifications list that are already tracked, so not new, and
  // still have no page: shown with what the certification page now says.
  const reported = new Set(exams.map((exam) => exam.code));
  const followUps = [];
  for (const cert of certs) {
    for (const code of cert.exams) {
      if (
        reported.has(code) ||
        isIgnoredCode(code) ||
        hubPagePath(code) === null ||
        hubPage(code)
      ) {
        continue;
      }
      reported.add(code);
      followUps.push(followUpExam(code, scan, trackedExams));
    }
  }
  if (followUps.length > 0) {
    sections.push(
      `### Exams the new certifications list that still have no hub page (${followUps.length})\n\n` +
        "These exams are already tracked, so they are not reported as new again (for example an exam reported earlier " +
        "from its study guide, before a certification page listed it). They have no hub page yet. The status and the " +
        "announcements below are what the certification page says now.\n\n" +
        EXAM_TABLE_HEADER +
        followUps.map((exam) => examRow(exam, scan)).join("\n"),
    );
  }

  const unmapped = exams.filter((exam) => hubPagePath(exam.code) === null);
  if (unmapped.length > 0) {
    sections.push(
      "### Exam families without a hub area\n\n" +
        unmapped
          .map(
            (exam) =>
              `- \`${exam.code}\` (prefix \`${exam.code.split("-")[0]}\`)`,
          )
          .join("\n") +
        "\n\nNo hub area covers these prefixes, so no page can be scaffolded yet. If the hub should cover the " +
        "family, add the prefix to `AREA_BY_PREFIX` in `scripts/lib/areas.mjs` (the one map the monitor and " +
        '`scripts/new-exam.mjs` read; the area mapping under "Exam Pages" in `AGENTS.md` follows it), then create the page. ' +
        "If not, add it to `IGNORED_PREFIXES` in `scripts/new-exam-check.mjs` so it stays tracked but is not " +
        "reported again.",
    );
  }

  const scaffoldable = [...exams, ...followUps].filter(
    (exam) => hubPagePath(exam.code) !== null,
  );
  if (scaffoldable.length > 0) {
    const commands = scaffoldable
      .map(
        (exam) =>
          `node scripts/new-exam.mjs --code ${exam.code} --name ${shellQuote(exam.name || "<official exam name>")}${exam.beta ? " --beta --beta-start <YYYY-MM-DD>" : ""}`,
      )
      .join("\n");
    sections.push(
      "### Checklist\n\n" +
        '1. Verify the official exam name on Microsoft Learn (see "Exam Pages" in `AGENTS.md`), then create each page. ' +
        "The commands add `--beta --beta-start <YYYY-MM-DD>` only where the Status column says BETA: for an exam whose status is unknown, " +
        'look for "(beta)" in its exam title on Microsoft Learn first and add both if it is there. `--beta` needs ' +
        "`--beta-start`, the day the beta period began: take it from the official announcement or the maintainers, " +
        '**not** from the "First detected" date above.\n\n' +
        "   ```bash\n" +
        commands
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n") +
        "\n   ```\n\n" +
        "   The scaffold guesses the `Exam` link of the Get Started card as `…/certifications/exams/<code>`, which " +
        "is a 404 for many exams. Replace it with the link from the **Exam link** column (the exam page where it is " +
        "confirmed, otherwise the certification page, or the study guide for an exam only a study guide shows so far; " +
        'see "URL Formats" in `AGENTS.md`).\n' +
        '2. If an exam is in beta: add `{ text: "BETA", variant: "tip" }` to `src/data_files/exam-status.mjs` and an ' +
        'entry to `src/data_files/beta-exams.json` ("Adding a new exam to either tracker" in `docs/monitors/beta-and-retiring-exams.md`) ' +
        'with `betaStart` (the `--beta-start` day) and `announcement`: `"pending"` while the Skills Hub announcement is ' +
        'still due (at most 7 days after the beta start), `"unannounced"` after 7 days without one, or the announcement ' +
        "URL. `--beta` scaffolds the standard `:::tip` beta text and the separate `:::note` beta timeline box " +
        '("Beta Exam Pages") in the variant that fits the start date. Never compute the dates of the note by hand: ' +
        "`node scripts/beta-note.mjs --code <CODE>` prints the note for the entry (once the announcement exists, set " +
        '`announcement` to its URL, add `--expects "<its go-live wording>"` if it names a date or month, and replace the ' +
        "note on the page). If the announcement has a beta voucher, add " +
        'a voucher page ("Voucher Pages").\n' +
        "3. Run `node scripts/audit-missing-resources.mjs` and commit the regenerated `src/data_files/missing-resources.json`.\n" +
        "4. Run `pnpm build`.\n\n" +
        'See the "New Exam Monitor" runbook (`docs/monitors/new-exam-monitor.md`) for the full process.',
    );
  } else if (exams.length > 0) {
    sections.push(
      'See the "New Exam Monitor" runbook (`docs/monitors/new-exam-monitor.md`) for the full process.',
    );
  } else if (certs.length > 0) {
    // Only reached when no listed exam needs a page (see followUps above).
    const listsExams = certs.some((cert) => cert.exams.length > 0);
    sections.push(
      "### Checklist\n\n" +
        "No new exam page is needed for the certification(s) above right now: " +
        (listsExams
          ? "every exam they list already has a hub page or is outside the hub areas. "
          : "they list no exam yet. ") +
        "The monitor reports a new exam in its own issue as soon as Learn lists one. " +
        "Check the certification page for an exam code or an announcement.\n\n" +
        'See the "New Exam Monitor" runbook (`docs/monitors/new-exam-monitor.md`) for the full process.',
    );
  }

  if (guides.length === 0) return sections.join("\n\n") + "\n";

  // The diffs are what makes a report long: try the full limits first and
  // shorten them step by step until it fits under GitHub's issue size limit.
  // Next to new exams the guide section is a top-level section of its own.
  const guideHeading = hasNew
    ? ["## Study guides updated on Microsoft Learn"]
    : [];
  let report = "";
  for (const [step, limits] of DIFF_LIMITS.entries()) {
    report =
      [
        ...sections,
        ...guideHeading,
        buildGuideSection(guides, limits, step > 0),
      ].join("\n\n") + "\n";
    if (report.length <= REPORT_MAX_CHARS) return report;
  }
  const note =
    "\n\n_The report was cut at the size limit of a GitHub issue; open the study guides and certification pages for the rest._\n";
  return (
    report.slice(0, REPORT_MAX_CHARS - note.length).replace(/\n[^\n]*$/, "") +
    note
  );
}

// ---------------------------------------------------------------------------
// Step 7: hub vs Learn drift
//
// The checks above compare Learn with its OWN previous copy. This step compares
// what Learn says now with what the hub pages say, and keeps ONE running issue
// ("Learn drift: hub pages need updating") in line with the differences. It
// reads facts the run already has (tracker, scan, guide text) plus the hub
// files; the only extra requests are the exam pages of the exams the hub marks
// BETA or UPCOMING (probeExamPages).
// ---------------------------------------------------------------------------
/** The hub inputs of the drift check could not be read: the check is not run. */
class DriftInputError extends Error {}

export const DRIFT_ISSUE_TITLE = "Learn drift: hub pages need updating";
export const DRIFT_ISSUE_LABEL = "enhancement";
export const DRIFT_FAILED_ISSUE_TITLE = "Learn drift: the check could not run";
export const DRIFT_FAILED_ISSUE_LABEL = "bug";

const MONTH_INDEX = new Map(
  MONTHS.split("|").map((name, index) => [name.toLowerCase(), index]),
);
const FULL_DATE_RE = new RegExp(
  `\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b|\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`,
  "gi",
);
const pad2 = (value) => String(value).padStart(2, "0");

/** True for a YYYY-MM-DD that is a real calendar day. */
export function isRealIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const time = new Date(Date.UTC(y, m - 1, d));
  return (
    time.getUTCFullYear() === y &&
    time.getUTCMonth() === m - 1 &&
    time.getUTCDate() === d
  );
}

/**
 * Full dates in a text, in order: "October 30, 2026" (also "October 30 2026" and
 * "October 30th, 2026") and "2026-10-30". A month and a year alone ("July 2026")
 * name no day and are not dates here. Impossible days are ignored.
 */
export function parseDates(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(FULL_DATE_RE)) {
    let year;
    let month;
    let day;
    if (match[1]) {
      month = MONTH_INDEX.get(match[1].toLowerCase());
      day = Number(match[2]);
      year = Number(match[3]);
    } else {
      year = Number(match[4]);
      month = Number(match[5]) - 1;
      day = Number(match[6]);
    }
    const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    if (isRealIsoDate(iso)) found.push({ iso, index: match.index });
  }
  return found;
}

/** "2026-10-30" -> "October 30, 2026" (the way the rest of the repo writes dates). */
export function formatDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTHS.split("|")[month - 1]} ${day}, ${year}`;
}

const dayNumber = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
};
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
export function addDays(iso, days) {
  return new Date((dayNumber(iso) + days) * 86400000)
    .toISOString()
    .slice(0, 10);
}

const normalizeName = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
const shortHash = (text) =>
  createHash("sha256").update(String(text)).digest("hex").slice(0, 8);

// --- the hub side ----------------------------------------------------------
function unquoteYaml(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function stripComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * What the drift check needs from one hub exam page: the exam name of the
 * frontmatter description (the template "certification exam CODE: NAME.
 * Contains official ..."; null when the page words it differently, like the
 * GH-700 placeholder), the name of the Get Started "Exam CODE: NAME" card, the
 * text without comments, and the first `:::caution` banner.
 */
export function parseHubPage(source, code) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  const descriptionLine = front?.[1].match(/^description:[ \t]*(.*)$/m);
  const description = descriptionLine ? unquoteYaml(descriptionLine[1]) : null;
  const nameMatch = description?.match(
    /certification exam\s+[A-Za-z0-9-]+:\s*(.+?)\.\s+Contains official\b/,
  );
  const body = stripComments(front ? text.slice(front[0].length) : text);
  const card = body.match(
    new RegExp(
      `<LinkCard\\b[^>]*?\\btitle="Exam\\s+${escapeRegExp(code)}:\\s*([^"]+)"`,
      "i",
    ),
  );
  const caution = body.match(/^:::caution[^\n]*\n([\s\S]*?)^:::[ \t]*$/m);
  return {
    description,
    descriptionName: nameMatch ? normalizeName(nameMatch[1]) : null,
    cardName: card ? normalizeName(decodeEntities(card[1])) : null,
    text: body,
    caution: caution ? caution[1] : "",
  };
}

/** Does a hub page text show this date, in any of the ways the pages write one? */
export function mentionsDate(text, iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const name = MONTHS.split("|")[month - 1];
  const pattern = new RegExp(
    `${iso}|\\b${name}\\s+${day}(?:st|nd|rd|th)?,?\\s+${year}\\b`,
    "i",
  );
  return pattern.test(text);
}

const mentions = (text, phrase) =>
  Boolean(phrase) &&
  normalizeName(text)
    .toLowerCase()
    .includes(normalizeName(phrase).toLowerCase());

const CERT_PREFIX_RE =
  /^(?:Microsoft(?: 365| Dynamics 365)?|GitHub)\s+Certified:\s*/i;
const stripCertPrefix = (title) =>
  normalizeName(title).replace(CERT_PREFIX_RE, "");

/**
 * The hub files the drift check compares with: the exam pages, the badges of
 * exam-status.mjs and the two trackers. Throws DriftInputError when one cannot
 * be read: an unknown hub state is never evidence of drift.
 */
export async function loadHubContext(cfg) {
  let examStatuses;
  try {
    const version = statSync(cfg.examStatusFile).mtimeMs;
    ({ examStatuses } = await import(
      `${pathToFileURL(cfg.examStatusFile).href}?v=${version}`
    ));
  } catch (error) {
    throw new DriftInputError(
      `src/data_files/exam-status.mjs could not be loaded (${error.message})`,
    );
  }
  if (!examStatuses || typeof examStatuses !== "object") {
    throw new DriftInputError(
      "src/data_files/exam-status.mjs exports no examStatuses object",
    );
  }
  const statuses = new Map();
  for (const [area, exams] of Object.entries(examStatuses)) {
    for (const [code, status] of Object.entries(exams ?? {})) {
      statuses.set(code.toUpperCase(), {
        area,
        text: String(status?.text ?? ""),
      });
    }
  }

  const readList = (file, label) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new DriftInputError(
        `${label} could not be read (${error.message})`,
      );
    }
    if (!Array.isArray(parsed?.exams)) {
      throw new DriftInputError(`${label} has no "exams" list`);
    }
    return new Map(
      parsed.exams
        .filter((exam) => typeof exam?.code === "string")
        .map((exam) => [exam.code.toUpperCase(), exam]),
    );
  };
  const beta = readList(cfg.betaExamsFile, "src/data_files/beta-exams.json");
  const retiring = readList(
    cfg.retiringExamsFile,
    "src/data_files/retiring-exams.json",
  );

  const pages = new Map();
  for (const code of listHubCodes(cfg)) {
    const area = areaForCode(code);
    let source;
    try {
      source = readFileSync(join(cfg.docsDir, area, `${code}.mdx`), "utf8");
    } catch (error) {
      throw new DriftInputError(
        `the hub page of ${code} could not be read (${error.message})`,
      );
    }
    const lab = join("labs", area, `${code.toLowerCase()}.mdx`);
    pages.set(code, {
      code,
      area,
      path: `src/content/docs/${area}/${code}.mdx`,
      labPath: existsSync(join(cfg.docsDir, lab))
        ? `src/content/docs/${lab.replace(/\\/g, "/")}`
        : null,
      ...parseHubPage(source, code),
    });
  }
  if (pages.size === 0) {
    throw new DriftInputError(
      `no exam page (<area>/<CODE>.mdx) was found under ${cfg.docsDir}; the docs folder probably moved`,
    );
  }
  return {
    statuses,
    beta,
    retiring,
    pages,
    acknowledged: loadAcknowledged(cfg),
  };
}

// --- acknowledged drift -------------------------------------------------------
const ACKNOWLEDGED_LABEL = "src/data_files/drift-acknowledged.json";
const ACKNOWLEDGED_KEYS = ["code", "kind", "reason", "since"];

/**
 * The acknowledged drift of a drift-acknowledged.json text: [{ code, kind,
 * reason, since }], each a decision of the maintainers that one kind of drift of
 * one exam is not to be reported (the hub is right, Learn is stale). Throws
 * DriftInputError for anything it does not understand: a file that silently
 * stopped suppressing (or suppressed too much) would be worse than a loud stop.
 */
export function parseAcknowledged(source, label = ACKNOWLEDGED_LABEL) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new DriftInputError(`${label} is not valid JSON (${error.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new DriftInputError(
      `${label} must be a list of { code, kind, reason, since } entries`,
    );
  }
  const seen = new Set();
  return parsed.map((entry, index) => {
    const where = `${label}, entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DriftInputError(
        `${where} must be an object { code, kind, reason, since }`,
      );
    }
    const unknown = Object.keys(entry).filter(
      (key) => !ACKNOWLEDGED_KEYS.includes(key),
    );
    if (unknown.length > 0) {
      throw new DriftInputError(
        `${where} has the unknown key(s) ${unknown.join(", ")} (allowed: ${ACKNOWLEDGED_KEYS.join(", ")})`,
      );
    }
    for (const key of ACKNOWLEDGED_KEYS) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new DriftInputError(
          `${where} needs a non-empty text for "${key}"`,
        );
      }
    }
    if (!/^[A-Z0-9]{2,5}-\d{1,4}[A-Z]?$/.test(entry.code)) {
      throw new DriftInputError(
        `${where}: "code" is ${JSON.stringify(entry.code)}, not an exam code in capitals such as AB-210`,
      );
    }
    if (!KIND_ORDER.includes(entry.kind)) {
      throw new DriftInputError(
        `${where}: "kind" is ${JSON.stringify(entry.kind)}, not one of ${KIND_ORDER.join(", ")}`,
      );
    }
    if (!isRealIsoDate(entry.since)) {
      throw new DriftInputError(
        `${where}: "since" is ${JSON.stringify(entry.since)}, not a day written YYYY-MM-DD`,
      );
    }
    const key = `${entry.kind}:${entry.code}`;
    if (seen.has(key)) {
      throw new DriftInputError(
        `${where} repeats the acknowledgement of ${entry.kind} drift for ${entry.code}`,
      );
    }
    seen.add(key);
    return {
      code: entry.code,
      kind: entry.kind,
      reason: entry.reason.trim(),
      since: entry.since,
    };
  });
}

/** The acknowledged drift the file holds; an absent file is an empty list. */
function loadAcknowledged(cfg) {
  if (!existsSync(cfg.driftAcknowledgedFile)) return [];
  let source;
  try {
    source = readFileSync(cfg.driftAcknowledgedFile, "utf8");
  } catch (error) {
    throw new DriftInputError(
      `${ACKNOWLEDGED_LABEL} could not be read (${error.message})`,
    );
  }
  return parseAcknowledged(source);
}

/**
 * Drops the acknowledged drift from the items: { kept, acknowledged, unmatched }.
 * `acknowledged` is [{ entry, items }] for each acknowledgement that suppressed
 * something (in the order of the file), `unmatched` the ones that suppressed
 * nothing today (the hub and Learn agree now, or the exam has no page): both
 * are shown in the job summary so an acknowledgement is not forgotten. A
 * different exam or a different kind is never affected.
 */
export function applyAcknowledgements(items, entries = []) {
  const byKey = new Map(
    entries.map((entry) => [`${entry.kind}:${entry.code}`, entry]),
  );
  const hits = new Map();
  const kept = [];
  for (const item of items) {
    const entry = byKey.get(`${item.kind}:${item.code}`);
    if (!entry) {
      kept.push(item);
      continue;
    }
    if (!hits.has(entry)) hits.set(entry, []);
    hits.get(entry).push(item);
  }
  return {
    kept,
    acknowledged: entries
      .filter((entry) => hits.has(entry))
      .map((entry) => ({ entry, items: hits.get(entry) })),
    unmatched: entries.filter((entry) => !hits.has(entry)),
  };
}

// --- the notices of a study guide -------------------------------------------
const NOTICE_LABELS = new Set([
  "Warning",
  "Note",
  "Important",
  "Tip",
  "Caution",
]);

/** The callout boxes under the "Notices" heading of the stored guide text: [{ label, lines }]. */
export function noticeBoxes(lines) {
  const start = (lines ?? []).indexOf("## Notices");
  if (start < 0) return [];
  const boxes = [];
  let current = null;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (NOTICE_LABELS.has(lines[i])) {
      current = { label: lines[i], lines: [] };
      boxes.push(current);
    } else {
      if (!current) {
        current = { label: "", lines: [] };
        boxes.push(current);
      }
      current.lines.push(lines[i]);
    }
  }
  return boxes;
}

const splitSentences = (text) =>
  text
    .split(/(?<=[.!?])\s+(?=[A-Z“"(\d-])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/**
 * What a notice box announces: [{ type, date, to, newName, sentence, dates }].
 * type is "retirement" (date: the day named in the sentence that talks about
 * the retirement, or null), "transition" (to: the exam it moves to), "rename"
 * (a certification rename; date: the day it takes effect, newName: the new
 * certification name) or "cancellation". A box can announce several. Nothing is
 * guessed: a type needs its own words, a date needs a full date next to them.
 */
export function classifyNotice(box) {
  const text = box.lines.join(" ");
  const sentences = splitSentences(text);
  const dates = [...new Set(parseDates(text).map((entry) => entry.iso))];
  const found = [];

  const retire = sentences.find((sentence) =>
    /\bretir(?:e|es|ed|ing|ement)\b/i.test(sentence),
  );
  if (retire) {
    found.push({
      type: "retirement",
      date: parseDates(retire)[0]?.iso ?? null,
      to: null,
      newName: null,
      sentence: retire,
      dates,
    });
  }

  const transition = text.match(
    new RegExp(
      `\\b(?:transition(?:ing|s|ed)?\\s+to|replaced\\s+by)\\s+(${CODE_SOURCE})\\b`,
      "i",
    ),
  );
  if (transition) {
    const to = transition[1].toUpperCase();
    found.push({
      type: "transition",
      date: null,
      to,
      newName: null,
      sentence:
        sentences.find((sentence) => sentence.toUpperCase().includes(to)) ??
        text,
      dates,
    });
  }

  const rename = sentences.find(
    (sentence) =>
      /\brenam(?:e|es|ed|ing)\b/i.test(sentence) ||
      /\b(?:updat|chang)\w*\b[^.]{0,80}\bname\b/i.test(sentence),
  );
  if (rename) {
    const effect = sentences.find((sentence) =>
      /\b(?:go(?:es)? into effect|take[s]? effect|effective)\b/i.test(sentence),
    );
    const named = sentences
      .filter(
        (sentence) =>
          /\bcertification\b/i.test(sentence) && /\bwill be\b/i.test(sentence),
      )
      .map((sentence) =>
        sentence.match(
          /\bwill be\s+(?:(?:Microsoft(?: 365| Dynamics 365)?|GitHub)\s+Certified:\s*)?([^.]+?)\.?$/i,
        ),
      )
      .find(Boolean);
    found.push({
      type: "rename",
      date: parseDates(effect ?? rename)[0]?.iso ?? dates[0] ?? null,
      to: null,
      newName: named ? normalizeName(named[1]) : null,
      sentence: rename,
      dates,
    });
  }

  const cancel = sentences.find((sentence) =>
    /\b(?:cancel+ed|cancellation|discontinued)\b/i.test(sentence),
  );
  if (cancel) {
    found.push({
      type: "cancellation",
      date: parseDates(cancel)[0]?.iso ?? null,
      to: null,
      newName: null,
      sentence: cancel,
      dates,
    });
  }
  return found;
}

// --- dated statements (the effective dates) ---------------------------------
const EFFECTIVE_WORDS_RE =
  /\b(?:as of|effective|beginning|begins?|starting|starts?|closes?|opens?|through|until|take[s]? effect|go(?:es)? into effect)\b/i;

/**
 * Statements of a stored guide text that say when something takes effect:
 * [{ date, sentence }], one per date, from the headings ("Skills measured as of
 * October 27, 2026"), the "Updates to the exam" text and the notice boxes that
 * do not announce a retirement, transition, rename or cancellation (those are
 * the notice checks' business). The sentence is the line of the guide that
 * carries the date; it is never an exam date or a beta start date.
 */
export function extractEffectiveDates(lines) {
  const list = lines ?? [];
  const candidates = [];

  // Headings anywhere (the skills version heading carries the day).
  for (const line of list) {
    if (/^#{1,6} /.test(line)) candidates.push(line.replace(/^#{1,6} /, ""));
  }
  // "Updates to the exam" text.
  const updates = list.indexOf("## Updates to the exam");
  if (updates >= 0) {
    for (let i = updates + 1; i < list.length; i++) {
      if (/^## /.test(list[i]) || /^#{3,6} /.test(list[i])) break;
      candidates.push(list[i]);
    }
  }
  // Notice boxes that announce no retirement, transition, rename or cancellation.
  for (const box of noticeBoxes(list)) {
    if (classifyNotice(box).length > 0) continue;
    candidates.push(...box.lines);
  }

  const byDate = new Map();
  for (const line of candidates) {
    const sentence = normalizeName(line.replace(/^- /, ""));
    if (!EFFECTIVE_WORDS_RE.test(sentence)) continue;
    for (const { iso } of parseDates(sentence)) {
      if (!byDate.has(iso)) {
        byDate.set(iso, clip(sentence, DATED_STATEMENT_MAX_CHARS));
      }
    }
  }
  return [...byDate]
    .map(([date, sentence]) => ({ date, sentence }))
    .sort((a, b) => byCodePoint(a.date, b.date));
}

/**
 * The tracker's effectiveDates after a run: for guides whose text was verified
 * this run (read in full or confirmed unchanged) the entries are rebuilt from
 * the text; every other guide keeps its entries. Only dates from `grace` days
 * ago up to `horizon` days ahead are kept: an older date has nothing left to
 * remind of, a date further out is picked up when it comes within the horizon.
 */
export function reconcileEffectiveDates({
  previous,
  guides,
  verified,
  today,
  horizonDays,
  graceDays,
}) {
  const earliest = addDays(today, -graceDays);
  const latest = addDays(today, horizonDays);
  const inRange = (date) => date >= earliest && date <= latest;
  const kept = new Map(
    previous
      .filter((entry) => !verified.has(entry.code) && entry.date >= earliest)
      .map((entry) => [`${entry.code}|${entry.date}`, entry]),
  );
  const before = new Map(
    previous.map((entry) => [`${entry.code}|${entry.date}`, entry]),
  );
  for (const guide of guides) {
    if (!verified.has(guide.code) || !Array.isArray(guide.lines)) continue;
    for (const { date, sentence } of extractEffectiveDates(guide.lines)) {
      if (!inRange(date)) continue;
      const key = `${guide.code}|${date}`;
      kept.set(key, {
        code: guide.code,
        date,
        sentence,
        firstSeen: before.get(key)?.firstSeen ?? today,
      });
    }
  }
  return [...kept.values()].sort(
    (a, b) => byCodePoint(a.code, b.code) || byCodePoint(a.date, b.date),
  );
}

/**
 * Certification renames seen this run: a certification whose title differs
 * from the tracker's. The tracker keeps each event for `days` days (it is
 * old -> new news, not a state), as long as the certification still has the
 * new title.
 */
export function mergeCertRenames({ previous, scan, today, days }) {
  const before = new Map(previous.certifications.map((c) => [c.slug, c]));
  const events = previous.certRenames.filter((event) => {
    if (daysBetween(event.firstSeen, today) > days) return false;
    // Renamed again since: the older event is stale.
    const now = scan.certs.get(event.slug)?.title;
    return now === undefined || normalizeName(now) === event.to;
  });
  for (const [slug, cert] of scan.certs) {
    const was = before.get(slug);
    if (!was || !was.title || !cert.title) continue;
    if (normalizeName(was.title) === normalizeName(cert.title)) continue;
    if (
      events.some(
        (event) =>
          event.slug === slug &&
          event.from === normalizeName(was.title) &&
          event.to === normalizeName(cert.title),
      )
    ) {
      continue;
    }
    events.push({
      slug,
      from: normalizeName(was.title),
      to: normalizeName(cert.title),
      firstSeen: today,
    });
  }
  return events.sort(
    (a, b) =>
      byCodePoint(a.slug, b.slug) ||
      byCodePoint(a.firstSeen, b.firstSeen) ||
      byCodePoint(a.to, b.to),
  );
}

// --- the exam pages of BETA and UPCOMING exams ----------------------------------
/**
 * The exams worth a look at their own exam page: those the hub marks BETA or
 * UPCOMING and that have a hub page. The exam page title carries the "(beta)"
 * marker, and for an UPCOMING exam it is the first place that may show up.
 */
export function probeTargets(hub, limit = 8) {
  return [...hub.statuses]
    .filter(
      ([code, status]) =>
        hub.pages.has(code) &&
        (status.text === "BETA" || status.text === "UPCOMING"),
    )
    .map(([code]) => code)
    .sort(byCodePoint)
    .slice(0, limit);
}

/**
 * The codes whose study guide page is worth a request of its own: the exams the
 * hub marks UPCOMING (an upcoming exam may have a published study guide before
 * the credentials sitemap lists it, GH-700 on 2026-10-14) that the sitemap read
 * this run does not list. An exam that has a guide in the sitemap needs no
 * extra request, and neither does a BETA exam, which Learn already lists.
 */
export function guideProbeTargets(hub, targets, sitemapCodes = new Set()) {
  return new Set(
    targets.filter(
      (code) =>
        hub.statuses.get(code)?.text === "UPCOMING" && !sitemapCodes.has(code),
    ),
  );
}

/**
 * Fetches the exam page of each code: Map of code -> { page, name, beta } for
 * an exam page that exists (the title reads "Exam CODE: name (beta)"), or
 * { page: false } when Learn says there is none (404, or a redirect to another
 * page). A code in `guideCodes` also gets its study guide page asked for
 * (`guide: true` with the `guideName` of its title "Study guide for Exam CODE:
 * name", or `guide: false` for a 404): the page may exist before the sitemap
 * lists it. A failure that proves nothing (429, 5xx, timeout) leaves that part
 * out: a fetch failure is never evidence.
 */
async function probeExamPages(cfg, codes, deadline, guideCodes = new Set()) {
  const probes = new Map();
  for (const code of codes) {
    if (deadline.expired()) {
      console.error(
        `WARNING: the probe deadline (PROBE_DEADLINE_MS=${cfg.probeDeadlineMs}) was reached before ${code}.`,
      );
      break;
    }
    const lower = code.toLowerCase();
    await sleep(cfg.fetchDelayMs);
    const response = await fetchText(
      cfg,
      `${cfg.baseUrl}/credentials/certifications/exams/${lower}/`,
      deadline,
    );
    if (response.ok) {
      const parsed = parseExamNameFromTitle(response.text, code);
      probes.set(
        code,
        parsed
          ? { page: true, name: parsed.name, beta: parsed.beta }
          : { page: false },
      );
    } else if (response.status === 404 || response.status === 410) {
      probes.set(code, { page: false });
    } else {
      console.error(
        `WARNING: could not probe the exam page of ${code} (${describeFailure(response)}); it is left out.`,
      );
    }

    if (!guideCodes.has(code)) continue;
    if (deadline.expired()) {
      console.error(
        `WARNING: the probe deadline (PROBE_DEADLINE_MS=${cfg.probeDeadlineMs}) was reached before the study guide of ${code}.`,
      );
      break;
    }
    await sleep(cfg.fetchDelayMs);
    const guide = await fetchText(
      cfg,
      `${cfg.baseUrl}/credentials/certifications/resources/study-guides/${lower}`,
      deadline,
    );
    // Only a page that really is that study guide counts: a bot-check page or a
    // redirect has another title and proves nothing either way.
    const named = guide.ok ? parseExamNameFromTitle(guide.text, code) : null;
    if (named || guide.status === 404 || guide.status === 410) {
      probes.set(code, {
        ...probes.get(code),
        guide: Boolean(named),
        guideName: named?.name ?? "",
      });
    } else {
      console.error(
        `WARNING: could not probe the study guide of ${code} (${guide.ok ? "the page is not that study guide" : describeFailure(guide)}); it is left out.`,
      );
    }
  }
  return probes;
}

// --- the drift items ----------------------------------------------------------
// severity: "fix" (Learn and the hub differ for sure), "check" (needs a human
// look: ambiguous evidence, or a date arriving), "info" (nothing to do; shown
// next to the items so a human sees how Learn words things).
const SEVERITY_ORDER = { fix: 0, check: 1, info: 2 };
const KIND_ORDER = [
  "name",
  "beta",
  "notice",
  "status",
  "upcoming",
  "at-risk",
  "certification",
  "effective",
];
const KIND_LABELS = {
  name: "Exam name",
  beta: "Beta status",
  notice: "Retirement or transition notice",
  status: "Retirement badge",
  upcoming: "Upcoming exam",
  "at-risk": "AT RISK banner",
  certification: "Certification",
  effective: "Takes effect",
};
const BETA_EVIDENCE_WORDS = {
  "card:beta": 'the exam card on the certification page is marked "(beta)"',
  "card:ga": "the exam card on the certification page has no beta marker",
  "listing:beta": 'the credentials listing marks the exam "(beta)"',
  "listing:ga": "the credentials listing has no beta marker for the exam",
  "certification-title:beta": 'the certification title carries "(beta)"',
  "callout:beta":
    "a callout on the certification page calls it a beta exam (the page title does not say so)",
  "exam-page:beta": 'the exam page title carries "(beta)"',
  "exam-page:ga": "the exam page title has no beta marker",
};

function driftItem({
  kind,
  severity,
  code,
  detail,
  summary,
  hubFiles,
  learn,
  edit,
}) {
  // The id goes into a marker of the issue text: letters, digits and :_.- only.
  const safeDetail = /^[A-Za-z0-9:_.-]+$/.test(detail)
    ? detail
    : shortHash(detail);
  return {
    id: `${kind}:${code}:${safeDetail}`,
    kind,
    severity,
    code,
    summary,
    hubFiles,
    learn,
    edit,
  };
}

const examLearnLink = (code, exam) =>
  exam?.url
    ? { label: "Exam page", url: exam.url }
    : exam?.certifications?.[0]
      ? {
          label: "Certification page",
          url: certificationUrl(exam.certifications[0].slug),
        }
      : { label: "Study guide", url: studyGuideUrl(code) };

function nameItems({ code, page, guide, exam }) {
  const learn = [];
  const add = (source, name, link) => {
    const clean = normalizeName(name);
    if (clean) learn.push({ source, name: clean, link });
  };
  const guideLink = { label: "Study guide", url: studyGuideUrl(code) };
  add("the study guide title", guide?.name, guideLink);
  add("the study guide heading", guide?.headingName, guideLink);
  add(
    "the exam name on the certification page or listing",
    exam?.name,
    examLearnLink(code, exam),
  );

  const hubNames = [];
  if (page.descriptionName) {
    hubNames.push({
      where: "frontmatter description",
      name: page.descriptionName,
    });
  }
  if (page.cardName) {
    hubNames.push({ where: "Get Started card title", name: page.cardName });
  }
  // A missing field is no evidence: nothing to compare, nothing to report.
  if (learn.length === 0 || hubNames.length === 0) return [];

  const distinct = [...new Set(learn.map((entry) => entry.name))];
  const links = [
    ...new Map(learn.map((entry) => [entry.link.url, entry.link])).values(),
  ];
  const hubFiles = [page.path, ...(page.labPath ? [page.labPath] : [])];
  const edit =
    `Check the exam name on Microsoft Learn, then update it in ${page.path} (the description and the ` +
    `Get Started card title)${page.labPath ? ` and in the description of ${page.labPath}` : ""}. ` +
    'Always use the official exam name ("Exam Pages" in AGENTS.md).';
  const learnText = learn
    .map((entry) => `${entry.source}: "${entry.name}"`)
    .join("; ");
  const hubText = hubNames
    .map((entry) => `${entry.where}: "${entry.name}"`)
    .join("; ");

  if (distinct.length === 1) {
    const wrong = hubNames.filter((entry) => entry.name !== distinct[0]);
    if (wrong.length === 0) return [];
    return [
      driftItem({
        kind: "name",
        severity: "fix",
        code,
        detail: shortHash(
          `${distinct[0]}|${wrong.map((e) => e.name).join("|")}`,
        ),
        summary: `The hub names the exam differently than Learn does. Learn: "${distinct[0]}". Hub: ${wrong
          .map((entry) => `${entry.where}: "${entry.name}"`)
          .join("; ")}.`,
        hubFiles,
        learn: links,
        edit,
      }),
    ];
  }
  // Learn words the name in more than one way (AB-620: the page title and the
  // page heading differ): never a definite mismatch.
  const hubMatches = hubNames.every((entry) => distinct.includes(entry.name));
  return [
    driftItem({
      kind: "name",
      severity: hubMatches ? "info" : "check",
      code,
      detail: shortHash(
        `${distinct.join("|")}|${hubNames.map((e) => e.name).join("|")}`,
      ),
      summary: hubMatches
        ? `Learn words the exam name in more than one way (${learnText}); the hub uses one of them (${hubText}). Nothing to do unless Learn settles on the other wording.`
        : `Learn words the exam name in more than one way (${learnText}) and the hub matches neither (${hubText}). Open the pages and decide which one is the official name.`,
      hubFiles,
      learn: links,
      edit: hubMatches ? "No edit needed now." : edit,
    }),
  ];
}

function betaItems({ code, page, status, exam, betaEntry }) {
  if (status === "UPCOMING") return []; // the upcoming check owns it
  const evidence = exam?.betaEvidence ?? [];
  const strongBeta = evidence.some((tag) =>
    /^(?:card|listing|certification-title|exam-page):beta$/.test(tag),
  );
  const weakBeta = evidence.includes("callout:beta");
  const ga = evidence.some((tag) =>
    /^(?:card|listing|exam-page):ga$/.test(tag),
  );
  const hubBeta =
    status === "BETA" || Boolean(betaEntry && betaEntry.flaggedGA !== true);
  const hubSays = hubBeta
    ? "BETA (" +
      [
        status === "BETA" ? "badge in exam-status.mjs" : null,
        betaEntry && betaEntry.flaggedGA !== true ? "beta-exams.json" : null,
      ]
        .filter(Boolean)
        .join(", ") +
      ")"
    : "not marked beta";
  const words = evidence
    .map((tag) => BETA_EVIDENCE_WORDS[tag] ?? tag)
    .join("; ");
  const links = [examLearnLink(code, exam)];
  const hubFiles = [
    page.path,
    "src/data_files/exam-status.mjs",
    "src/data_files/beta-exams.json",
  ];
  const make = (severity, tag, summary, edit) =>
    driftItem({
      kind: "beta",
      severity,
      code,
      detail: tag,
      summary,
      hubFiles,
      learn: links,
      edit,
    });

  if (!hubBeta && strongBeta) {
    return [
      make(
        "fix",
        "started",
        `Learn shows ${code} as a beta exam (${words}); the hub shows it as ${hubSays}.`,
        `Add { text: "BETA", variant: "tip" } for ${code} to src/data_files/exam-status.mjs and an entry to src/data_files/beta-exams.json with betaStart and announcement (pending, unannounced or the announcement URL; ` +
          '"Adding a new exam to either tracker" in docs/monitors/beta-and-retiring-exams.md), put the beta :::tip and the separate :::note timeline box on the page ("Beta Exam Pages"), ' +
          `and print the note with node scripts/beta-note.mjs --code ${code} instead of computing its dates. ` +
          "The beta start date comes from the official announcement or the maintainers, never from this issue or a guess. Add a voucher page if the announcement has a beta voucher.",
      ),
    ];
  }
  if (!hubBeta && weakBeta && !ga) {
    return [
      make(
        "check",
        "unclear",
        `Only a callout on the certification page calls ${code} a beta exam (${words}); neither the exam card nor the exam page title says beta. The hub shows it as ${hubSays}. Unclear, check the exam page and the announcement.`,
        `Open the certification page and the announcement it links. If the exam is in beta, handle it like any beta exam (exam-status.mjs badge, beta-exams.json entry with betaStart and announcement, :::tip and :::note boxes with the note printed by node scripts/beta-note.mjs --code ${code}, voucher page); if the callout is stale, nothing to do.`,
      ),
    ];
  }
  if (hubBeta && ga && !strongBeta && !weakBeta) {
    return [
      make(
        "fix",
        "ended",
        `The hub shows ${code} as ${hubSays}, but Learn no longer marks it beta (${words}).`,
        'Follow "Beta exam tracker" > "Working the list" in docs/monitors/beta-and-retiring-exams.md: verify the exam is generally available on Microsoft Learn, remove the BETA badge from src/data_files/exam-status.mjs, ' +
          "replace the :::tip beta banner and remove the :::note timeline box on the page, and update or delete the beta-exams.json entry.",
      ),
    ];
  }
  if (hubBeta && !strongBeta && !weakBeta && !ga) {
    return [
      make(
        "check",
        "unconfirmed",
        `The hub shows ${code} as ${hubSays}, but no Learn page read today shows a beta marker for it. Unclear, check the exam page title.`,
        'Open the exam page on Microsoft Learn. If its title no longer says "(beta)" the exam is generally available: follow "Beta exam tracker" > "Working the list" in docs/monitors/beta-and-retiring-exams.md.',
      ),
    ];
  }
  return [];
}

// The two badges of a retirement (exam-status.mjs): RETIRING until the date has
// passed, RETIRED after it.
const RETIRING_BADGE = '{ text: "RETIRING", variant: "danger" }';
const RETIRED_BADGE = '{ text: "RETIRED", variant: "note" }';
const isRetirementStatus = (status) =>
  status === "RETIRING" || status === "RETIRED";

function noticeItems({ code, page, status, guide, retiringEntry, today }) {
  if (!Array.isArray(guide?.lines)) return [];
  const retirementBadge = isRetirementStatus(status);
  const items = [];
  const guideLink = { label: "Study guide", url: studyGuideUrl(code) };
  const hubFiles = [
    page.path,
    "src/data_files/exam-status.mjs",
    "src/data_files/retiring-exams.json",
  ];
  const seen = new Set();
  for (const box of noticeBoxes(guide.lines)) {
    for (const announcement of classifyNotice(box)) {
      const sentence = clip(announcement.sentence, 300);
      const quoted = `Learn's notice: "${sentence}"`;
      let item = null;

      if (announcement.type === "retirement") {
        const date = announcement.date;
        if (!date) {
          if (retirementBadge || retiringEntry) continue;
          item = {
            severity: "check",
            tag: "retirement:undated",
            summary: `The study guide announces a retirement without a date I could read. ${quoted} The hub shows no RETIRING badge and no retiring-exams.json entry.`,
            edit: 'Open the study guide. If the retirement is confirmed, follow "Retiring exam tracker" in docs/monitors/beta-and-retiring-exams.md (RETIRING badge, retiring-exams.json entry, banner) with the date from the official source.',
          };
        } else {
          // A date already tracked correctly raises nothing.
          if (retiringEntry?.retirementDate === date) continue;
          const steps = [];
          if (!retirementBadge) {
            // The badge that fits the date: RETIRED once it is before today.
            const badge = date < today ? RETIRED_BADGE : RETIRING_BADGE;
            steps.push(
              status === "AT RISK"
                ? `replace the AT RISK badge of ${code} with ${badge} in src/data_files/exam-status.mjs`
                : `add ${badge} for ${code} to src/data_files/exam-status.mjs`,
            );
          }
          if (!retiringEntry) {
            steps.push(
              `add an entry for ${code} to src/data_files/retiring-exams.json (retirementDate ${date}, replacementCode if the notice names one, notified false)`,
            );
          } else {
            steps.push(
              `change retirementDate of ${code} in src/data_files/retiring-exams.json from ${retiringEntry.retirementDate} to ${date}`,
            );
          }
          if (!mentionsDate(page.text, date)) {
            steps.push(
              `show the date ${formatDate(date)} in the banner of ${page.path} (RetirementBanner or :::caution, see "Retiring exam tracker" in docs/monitors/beta-and-retiring-exams.md)`,
            );
          }
          const was = retiringEntry
            ? `retiring-exams.json says ${retiringEntry.retirementDate}`
            : "there is no retiring-exams.json entry";
          item = {
            severity: "fix",
            tag: `retirement:${date}`,
            summary: `The study guide announces a retirement on ${formatDate(date)}. ${quoted} The hub: ${status ? `badge ${status}` : "no badge"}, ${was}.`,
            edit: `${steps.map((step, i) => `${i + 1}. ${step}`).join(" ")} Dates come from the official source, never from a guess.`,
          };
        }
      } else if (announcement.type === "transition") {
        const to = announcement.to;
        if (retiringEntry?.replacementCode?.toUpperCase() === to) continue;
        const steps = [];
        if (!retirementBadge) {
          steps.push(
            status === "AT RISK"
              ? `replace the AT RISK badge of ${code} with ${RETIRING_BADGE} in src/data_files/exam-status.mjs`
              : `add ${RETIRING_BADGE} for ${code} to src/data_files/exam-status.mjs`,
          );
        }
        steps.push(
          `add an entry for ${code} to src/data_files/retiring-exams.json (replacementCode ${to}, notified false; retirementDate is the last day the old exam can be taken, take it from the notice: ${
            announcement.dates.length
              ? announcement.dates.map(formatDate).join(", ")
              : "no date found"
          })`,
        );
        if (!mentions(page.text, to)) {
          steps.push(`mention ${to} in the banner of ${page.path}`);
        }
        item = {
          severity: "fix",
          tag: `transition:${to}`,
          summary: `The study guide announces that ${code} is transitioning to ${to}. ${quoted} The hub: ${status ? `badge ${status}` : "no badge"}, no retiring-exams.json entry naming ${to}.`,
          edit: `${steps.map((step, i) => `${i + 1}. ${step}`).join(" ")} Dates come from the official source, never from a guess.`,
        };
      } else if (announcement.type === "rename") {
        const shown = announcement.newName
          ? mentions(page.text, announcement.newName)
          : announcement.date
            ? mentionsDate(page.text, announcement.date)
            : false;
        if (shown) continue;
        item = {
          severity: announcement.newName || announcement.date ? "fix" : "check",
          tag: `rename:${announcement.newName ?? ""}:${announcement.date ?? ""}`,
          summary: `The study guide announces a certification rename${announcement.date ? ` effective ${formatDate(announcement.date)}` : ""}${announcement.newName ? ` to "${announcement.newName}"` : ""}. ${quoted} The page does not show it.`,
          edit: `Add a short :::note or :::caution to ${page.path} that names the new certification${announcement.date ? ` and the date ${formatDate(announcement.date)}` : ""}, with the source link, and check the exam name in the description.`,
        };
      } else if (announcement.type === "cancellation") {
        if (mentions(page.text, "cancel")) continue;
        item = {
          severity: "check",
          tag: "cancellation",
          summary: `The study guide announces a cancellation. ${quoted} The page does not mention it.`,
          edit: `Open the study guide and the announcement; if it applies to this exam, say so in a banner on ${page.path} and update the exam status badges.`,
        };
      }

      if (!item || seen.has(item.tag)) continue;
      seen.add(item.tag);
      items.push(
        driftItem({
          kind: "notice",
          severity: item.severity,
          code,
          detail: item.tag,
          summary: item.summary,
          hubFiles,
          learn: [guideLink],
          edit: item.edit,
        }),
      );
    }
  }
  return items;
}

/**
 * The retirement announcements with a date in the notices of a stored guide:
 * [{ date, sentence }]. The sentence is Learn's, the date the one it names.
 */
function datedRetirements(guide) {
  if (!Array.isArray(guide?.lines)) return [];
  return noticeBoxes(guide.lines)
    .flatMap((box) => classifyNotice(box))
    .filter((announcement) => announcement.type === "retirement")
    .filter((announcement) => announcement.date)
    .map(({ date, sentence }) => ({ date, sentence }));
}

/**
 * The RETIRING / RETIRED badge against the retirement date. The cut-off is the
 * one of the RetirementBanner and of the retiring monitor: an exam has retired
 * once its date is before today (UTC); on the day itself it is still retiring.
 *   RETIRING, date passed   [fix] "switch the badge to RETIRED". The date is the
 *                           retiring-exams.json one, or Learn's notice when the
 *                           hub tracks none (a different date in the notice is
 *                           the NOTICE check's business, not repeated here).
 *   RETIRED, date not passed [fix] "badge ahead of date". The dates in play are
 *                           the tracker's and Learn's notice dates.
 * Nothing is guessed: no date, no row.
 */
function statusItems({ code, page, status, guide, retiringEntry, today }) {
  if (!isRetirementStatus(status) || !today) return [];
  const trackerDate = isRealIsoDate(retiringEntry?.retirementDate)
    ? retiringEntry.retirementDate
    : null;
  const learn = datedRetirements(guide);
  const quote = (entry) => `Learn's notice: "${clip(entry.sentence, 300)}"`;
  const hubFiles = [
    page.path,
    "src/data_files/exam-status.mjs",
    "src/data_files/retiring-exams.json",
  ];
  const guideLink = { label: "Study guide", url: studyGuideUrl(code) };

  if (status === "RETIRING") {
    const noticed = trackerDate ? null : learn.find((e) => e.date < today);
    const date = trackerDate ?? noticed?.date ?? null;
    if (!date || date >= today) return [];
    // Learn names a date that has not passed: the exam is not retired, and the
    // notice row already says that the tracker date is wrong.
    if (learn.some((entry) => entry.date >= today)) return [];
    const bannerNote = /<RetirementBanner\b/.test(page.text ?? "")
      ? `The RetirementBanner on ${page.path} words itself in the past tense by itself.`
      : `Reword the retirement note on ${page.path} in the past tense.`;
    return [
      driftItem({
        kind: "status",
        severity: "fix",
        code,
        detail: `retired:${date}`,
        summary: trackerDate
          ? `The hub still shows ${code} as RETIRING, but its retirement date has passed: retiring-exams.json says ${formatDate(date)}.${learn[0] ? ` ${quote(learn[0])}` : ""}`
          : `The hub still shows ${code} as RETIRING, but Learn says it has retired on ${formatDate(date)}, and retiring-exams.json has no entry. ${quote(noticed)}`,
        hubFiles,
        learn: [guideLink],
        edit:
          `Switch the badge to RETIRED: replace the RETIRING badge of ${code} with ${RETIRED_BADGE} in src/data_files/exam-status.mjs. ` +
          `Keep the ${code} entry in src/data_files/retiring-exams.json as history${trackerDate ? " (the retiring monitor sets notified itself)" : " (add it first, with the date of the official source)"}. ${bannerNote} ` +
          "Dates come from the official source, never from a guess.",
      }),
    ];
  }

  // RETIRED: every date in play that has not passed makes the badge premature.
  const open = [];
  if (trackerDate && trackerDate >= today) {
    open.push({
      date: trackerDate,
      text: `retiring-exams.json says ${formatDate(trackerDate)}`,
    });
  }
  for (const entry of learn) {
    if (entry.date >= today) {
      open.push({ date: entry.date, text: quote(entry) });
    }
  }
  if (open.length === 0) return [];
  const latest = open
    .map((entry) => entry.date)
    .sort(byCodePoint)
    .at(-1);
  return [
    driftItem({
      kind: "status",
      severity: "fix",
      code,
      detail: `ahead:${latest}`,
      summary: `The RETIRED badge of ${code} is ahead of the date: the exam has not retired yet. ${open.map((entry) => entry.text).join("; ")}.`,
      hubFiles,
      learn: [guideLink],
      edit:
        `Check the retirement date on Microsoft Learn. If the exam is still open, change the badge of ${code} back to ${RETIRING_BADGE} in src/data_files/exam-status.mjs until the date has passed; ` +
        "if Microsoft moved the date, correct retirementDate in src/data_files/retiring-exams.json and the banner to the official date. " +
        "Dates come from the official source, never from a guess.",
    }),
  ];
}

function upcomingItems({ code, page, status, exam, guide, probe }) {
  if (status !== "UPCOMING" || (!exam && !guide && !probe?.guide)) return [];
  const evidence = [];
  if (exam?.certifications?.length) {
    evidence.push(
      `certification page (${exam.certifications.map((cert) => cert.title).join("; ")})`,
    );
  }
  if (exam?.url) evidence.push("exam page");
  if (guide) evidence.push("study guide in the sitemap");
  else if (probe?.guide) {
    evidence.push("study guide page (the sitemap does not list it yet)");
  }
  // A tracked exam with nothing else to show for it: the listing, or a study
  // guide page an earlier run found and today's probe could not confirm.
  if (evidence.length === 0) {
    evidence.push("exam listing or study guide page seen by an earlier run");
  }
  const betaWords = (exam?.betaEvidence ?? []).some((tag) => /:beta$/.test(tag))
    ? " Learn marks it as a beta exam."
    : "";
  return [
    driftItem({
      kind: "upcoming",
      severity: "fix",
      code,
      detail: "now-on-learn",
      summary: `The hub shows ${code} as UPCOMING, but it is now on Microsoft Learn: ${evidence.join(", ")}.${betaWords}`,
      hubFiles: [
        page.path,
        "src/data_files/exam-status.mjs",
        "src/data_files/beta-exams.json",
      ],
      learn: [
        examLearnLink(code, exam),
        ...(guide || probe?.guide
          ? [{ label: "Study guide", url: studyGuideUrl(code) }]
          : []),
      ],
      edit:
        `Fill the placeholder page ${page.path} with verified official resources per "Exam Page Anatomy" in AGENTS.md, ` +
        'replace the UPCOMING badge in src/data_files/exam-status.mjs with BETA (or remove it for a generally available exam), and for a beta exam add the beta-exams.json entry (betaStart and announcement: pending, unannounced or the announcement URL), the :::tip and :::note boxes ("Beta Exam Pages") and a voucher page if the announcement has one. ' +
        `Print the note with node scripts/beta-note.mjs --code ${code} instead of computing its dates; the beta start date comes from the official announcement or the maintainers, never from this issue.`,
    }),
  ];
}

function atRiskItems({ code, page, status, exams }) {
  if (status !== "AT RISK" || !page.caution) return [];
  if (
    !/\b(?:potential|exploring|not (?:been )?confirmed|neither|may replace|survey)\b/i.test(
      page.caution,
    )
  ) {
    return [];
  }
  const items = [];
  const codes = new Set(
    [...page.caution.matchAll(new RegExp(`\\b(${CODE_SOURCE})\\b`, "g"))].map(
      (match) => match[1].toUpperCase(),
    ),
  );
  for (const other of [...codes].sort(byCodePoint)) {
    const listed = other !== code ? exams.get(other) : null;
    if (!listed) continue;
    items.push(
      driftItem({
        kind: "at-risk",
        severity: "fix",
        code,
        detail: other,
        summary:
          `The AT RISK banner of ${code} calls ${other} a potential, unconfirmed exam, but Learn lists it: ` +
          `"${listed.name || "name not published"}"${listed.betaEvidence.some((tag) => /:beta$/.test(tag)) ? ", marked beta" : ""}` +
          `${listed.certifications.length ? `, certification "${listed.certifications.map((cert) => cert.title).join('"; "')}"` : ""}.`,
        hubFiles: [page.path, "src/data_files/exam-status.mjs"],
        learn: [examLearnLink(other, listed)],
        edit:
          `Update the banner of ${page.path}: ${other} exists now. Check the announcement for whether ${code} retires or changes ` +
          'and follow "At Risk Exam Treatment" in AGENTS.md and "Retiring exam tracker" in docs/monitors/beta-and-retiring-exams.md accordingly; keep or drop the AT RISK badge as "At Risk Exam Treatment" says.',
      }),
    );
  }
  return items;
}

function certificationItems({
  code,
  page,
  exam,
  certRenames,
  today,
  renameDays,
}) {
  const items = [];
  const slugs = new Set((exam?.certifications ?? []).map((cert) => cert.slug));
  for (const event of certRenames) {
    if (
      !slugs.has(event.slug) ||
      daysBetween(event.firstSeen, today) > renameDays
    ) {
      continue;
    }
    const oldName = stripCertPrefix(event.from);
    const newName = stripCertPrefix(event.to);
    const mentionsOld = mentions(page.text, oldName);
    const mentionsNew = mentions(page.text, newName);
    if (mentionsNew) continue; // the page already shows the new name
    items.push(
      driftItem({
        kind: "certification",
        severity: mentionsOld ? "fix" : "info",
        code,
        detail: `renamed:${shortHash(`${event.from}|${event.to}`)}`,
        summary: `Learn renamed the certification "${event.from}" to "${event.to}" (first seen ${event.firstSeen}). ${
          mentionsOld
            ? "The hub page still shows the old name."
            : "The hub page does not show either name."
        }`,
        hubFiles: [page.path],
        learn: [
          {
            label: "Certification page",
            url: certificationUrl(event.slug),
          },
        ],
        edit: mentionsOld
          ? `Replace the old certification name in ${page.path} with the new one, and check the Get Started link to the certification page (the address may have changed).`
          : `Nothing in ${page.path} names the certification; check the Get Started link to the certification page still works.`,
      }),
    );
  }

  // The certification names the page itself uses, against what Learn lists now.
  const learnTitles = new Set(
    (exam?.certifications ?? []).map((cert) => stripCertPrefix(cert.title)),
  );
  if (learnTitles.size > 0) {
    const phrases = new Set(
      [
        ...page.text.matchAll(
          /(?:Microsoft(?: 365| Dynamics 365)?|GitHub)\s+Certified:\s*([A-Za-z0-9 .&+/'’-]+?\b(?:Associate|Expert|Specialty|Fundamentals|Professional|Leader))\b/g,
        ),
      ].map((match) => normalizeName(match[1])),
    );
    for (const phrase of [...phrases].sort(byCodePoint)) {
      if (learnTitles.has(phrase)) continue;
      items.push(
        driftItem({
          kind: "certification",
          severity: "info",
          code,
          detail: `text:${shortHash(phrase)}`,
          summary: `${page.path} names the certification "${phrase}"; Learn lists the exam under ${[...learnTitles].map((t) => `"${t}"`).join(", ")}. Informational: the page may be quoting the former name on purpose.`,
          hubFiles: [page.path],
          learn: exam?.certifications?.[0]
            ? [
                {
                  label: "Certification page",
                  url: certificationUrl(exam.certifications[0].slug),
                },
              ]
            : [],
          edit: "No edit needed unless the name is out of date.",
        }),
      );
    }
  }
  return items;
}

function effectiveItems({ entries, hub, today, leadDays, graceDays }) {
  const items = [];
  for (const entry of entries) {
    const page = hub.pages.get(entry.code);
    if (!page) continue;
    if (
      today < addDays(entry.date, -leadDays) ||
      today > addDays(entry.date, graceDays)
    ) {
      continue;
    }
    items.push({
      ...driftItem({
        kind: "effective",
        severity: "check",
        code: entry.code,
        detail: entry.date,
        summary: `Learn says a change takes effect on ${formatDate(entry.date)}: "${entry.sentence}"`,
        hubFiles: [page.path, ...(page.labPath ? [page.labPath] : [])],
        learn: [{ label: "Study guide", url: studyGuideUrl(entry.code) }],
        edit: `Re-check ${page.path} against the study guide on that day: the skills measured, the courses, labs and tests, and the Get Started links. Nothing to edit if it is already current.`,
      }),
      date: entry.date,
    });
  }
  return items;
}

/**
 * Every difference between the hub and what Microsoft Learn says now, as
 * [{ id, kind, severity, code, summary, hubFiles, learn, edit }], sorted
 * (fix, check, info; then by kind and code). Pure: it reads the post-merge
 * tracker and the hub context, never the network. A missing field is no
 * evidence: a guide without a stored name, a description that does not follow
 * the template or an exam without beta evidence just produce no item, and a
 * guide kept from an earlier read (a failed fetch) keeps the facts of that read,
 * so a fetch failure neither raises nor clears an item.
 */
export function evaluateDrift({
  today,
  hub,
  tracker,
  probes = new Map(),
  leadDays = 7,
  graceDays = 2,
  renameDays = 30,
}) {
  const exams = new Map(tracker.exams.map((exam) => [exam.code, exam]));
  const guides = new Map(
    tracker.studyGuides.map((guide) => [guide.code, guide]),
  );
  const items = [];

  for (const [code, page] of [...hub.pages].sort((a, b) =>
    byCodePoint(a[0], b[0]),
  )) {
    const status = hub.statuses.get(code)?.text ?? "";
    const exam = exams.get(code);
    const guide = guides.get(code);
    const common = {
      code,
      page,
      status,
      exam,
      guide,
      probe: probes.get(code),
      today,
    };
    const retiringEntry = hub.retiring.get(code);
    items.push(
      ...nameItems(common),
      ...betaItems({ ...common, betaEntry: hub.beta.get(code) }),
      ...noticeItems({ ...common, retiringEntry }),
      ...statusItems({ ...common, retiringEntry }),
      ...upcomingItems(common),
      ...atRiskItems({ ...common, exams }),
      ...certificationItems({
        ...common,
        certRenames: tracker.certRenames ?? [],
        today,
        renameDays,
      }),
    );
  }
  items.push(
    ...effectiveItems({
      entries: tracker.effectiveDates ?? [],
      hub,
      today,
      leadDays,
      graceDays,
    }),
  );

  const unique = new Map();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      byCodePoint(a.code, b.code) ||
      byCodePoint(a.id, b.id),
  );
}

// --- the running issue -------------------------------------------------------
const DRIFT_MARKER_RE =
  /<!--\s*learn-drift:v1\s+a=(\S*)\s+b=(\S*)\s+h=(\S*)\s*-->/;
const DRIFT_BODY_LIMITS = [
  { summary: 1200, edit: 1000 },
  { summary: 320, edit: 240 },
  { summary: 160, edit: 0 },
];
const DRIFT_STEPS =
  "### What to do\n\n" +
  "1. Open the Learn source of a row and confirm what it says. The rows say what the hub shows and what Learn shows today; nothing here is an official announcement.\n" +
  '2. Edit the hub files named in the row ("What to edit"). Take names, dates and numbers from Microsoft Learn or the official announcement; ' +
  'never invent them, and never use a date from this issue as the start of a beta ("Beta Exam Pages" in `AGENTS.md`).\n' +
  "3. A change of the beta or retirement state (beta, retirement, transition) also touches `src/data_files/exam-status.mjs`, `src/data_files/beta-exams.json` and `src/data_files/retiring-exams.json` " +
  '("Beta exam tracker", "Retiring exam tracker", "Adding a new exam to either tracker" in `docs/monitors/beta-and-retiring-exams.md`). ' +
  "A beta entry has `betaStart` and `announcement` (`pending`, `unannounced` or the announcement URL), and the beta note on the page is printed by `node scripts/beta-note.mjs --code <CODE>`, never computed by hand.\n" +
  "4. If you changed resources, run `node scripts/audit-missing-resources.mjs`, commit the regenerated `src/data_files/missing-resources.json`, then run `pnpm build`.\n" +
  "5. Nothing needs to be dismissed: this issue is kept up to date by the New Exam Monitor (the text is edited when the list changes, every change gets a comment) and it closes itself on the first run where no row to fix or check is left. " +
  '"For information" rows never keep it open.\n\n' +
  'See the "New Exam Monitor" runbook (`docs/monitors/new-exam-monitor.md`) for the full process.';

function driftRows(items, limit) {
  return items
    .map((item) => {
      const files = item.hubFiles.map((file) => `\`${file}\``).join("<br>");
      const links = item.learn
        .map((link) => `[${cell(link.label)}](${markdownUrl(link.url)})`)
        .join("<br>");
      const edit = limit.edit > 0 ? clip(item.edit, limit.edit) : "";
      return (
        `| ${item.code} | ${KIND_LABELS[item.kind]} | ${learnCell(clip(item.summary, limit.summary))} | ` +
        `${edit ? learnCell(edit) : "see the checklist"} | ${files} | ${links || "—"} |`
      );
    })
    .join("\n");
}

const DRIFT_TABLE_HEADER =
  "| Exam | Kind | What differs | What to edit | Hub file | Learn source |\n" +
  "|------|------|--------------|--------------|----------|--------------|\n";

// A marker with more id characters than this lists a hash of them instead ("h:"
// form): no run needs hundreds of rows, but the marker must never push the issue
// text over GitHub's size limit.
const DRIFT_MARKER_IDS_MAX_CHARS = 20000;

/** The ids of the open items (a), the informational ones (b) and a hash of the rows (h): the marker in the issue text. */
export function driftSignature(items, rows = "") {
  const ids = (list) => {
    if (list.length === 0) return "-";
    const joined = list
      .map((item) => item.id)
      .sort(byCodePoint)
      .join(",");
    return joined.length > DRIFT_MARKER_IDS_MAX_CHARS
      ? `h:${shortHash(joined)}`
      : joined;
  };
  return {
    a: ids(items.filter((item) => item.severity !== "info")),
    b: ids(items.filter((item) => item.severity === "info")),
    h: shortHash(rows),
  };
}

/**
 * The text of the running issue: a table per severity, the checklist and the
 * marker. Text from Learn pages (names, notice sentences) is sanitized for a
 * table cell: no HTML, links or code spans, and no @mention or #123 reference.
 */
export function buildDriftReport({ items, today }) {
  const fix = items.filter((item) => item.severity === "fix");
  const check = items.filter((item) => item.severity === "check");
  const info = items.filter((item) => item.severity === "info");

  let text = "";
  let marker = "";
  let signature;
  for (const [step, limit] of DRIFT_BODY_LIMITS.entries()) {
    const sections = [
      "## Learn drift: hub pages need updating",
      `Found by the New Exam Monitor on ${today} (UTC) by comparing the hub pages with what Microsoft Learn says now: ` +
        `**${fix.length} to fix**, **${check.length} to check**, ${info.length} for information. ` +
        "This issue is kept up to date by the monitor: its text changes when the list changes, every change gets a comment, and it closes itself when nothing is left to fix or check." +
        (step > 0
          ? " The rows are shortened to keep this issue under GitHub's size limit."
          : ""),
    ];
    const groups = [
      [
        fix,
        "### To fix",
        "Learn and the hub differ for sure. Verify on Learn, then edit.",
      ],
      [
        check,
        "### To check",
        "Needs a human look: the evidence is ambiguous, or a date is arriving.",
      ],
      [
        info,
        "### For information",
        "Nothing to do now. Shown so you can see how Learn words things.",
      ],
    ];
    const rowsText = [];
    for (const [list, heading, lead] of groups) {
      if (list.length === 0) continue;
      const rows = driftRows(list, limit);
      rowsText.push(rows);
      sections.push(
        `${heading} (${list.length})\n\n${lead}\n\n${DRIFT_TABLE_HEADER}${rows}`,
      );
    }
    sections.push(DRIFT_STEPS);
    signature = driftSignature(items, rowsText.join("\n"));
    text = sections.join("\n\n");
    marker = `\n\n<!-- learn-drift:v1 a=${signature.a} b=${signature.b} h=${signature.h} -->\n`;
    if (text.length + marker.length <= REPORT_MAX_CHARS) {
      return { body: text + marker, signature };
    }
  }
  // Still too long after the rows were shortened: cut the text, never the marker
  // (the next run needs it to tell what changed).
  const note =
    "\n\n_The report was cut at the size limit of a GitHub issue; the monitor's log has the full list._\n";
  const room = Math.max(REPORT_MAX_CHARS - note.length - marker.length, 0);
  return {
    body:
      text.slice(0, room).replace(/\n[^\n]*$/, "") + note + marker.trimStart(),
    signature,
  };
}

/**
 * The marker of an existing issue text: { a, b, h, ids, infoIds } or null when
 * it has none. `ids` is null when the marker only holds a hash of them (a list
 * too long to spell out).
 */
export function parseDriftMarker(body) {
  const match = DRIFT_MARKER_RE.exec(String(body ?? ""));
  if (!match) return null;
  const split = (value) => {
    if (value.startsWith("h:")) return null;
    return value === "-" ? [] : value.split(",").filter(Boolean);
  };
  return {
    a: match[1],
    b: match[2],
    h: match[3],
    ids: split(match[1]),
    infoIds: split(match[2]),
  };
}

/**
 * What changed between the rows an issue text lists (`previousIds`) and the rows
 * to fix or check now: { now, added, resolved }. `previousIds` null (an
 * unreadable marker) counts every current row as added.
 */
export function driftChanges(items, previousIds) {
  const now = items.filter((item) => item.severity !== "info");
  const nowIds = new Set(now.map((item) => item.id));
  const before = new Set(previousIds ?? []);
  return {
    now,
    added: now.filter((item) => !before.has(item.id)),
    resolved: [...before].filter((id) => !nowIds.has(id)).sort(byCodePoint),
  };
}

/** A "Takes effect" row is a dated reminder: it leaves on its own once the date has passed. */
const isDatedRowId = (id) => id.startsWith("effective:");

/** The comment that goes with a change of the list. */
export function buildDriftComment({ items, previousIds, today, runUrl }) {
  const { now, added, resolved } = driftChanges(items, previousIds);
  const describe = (id) => {
    const [kind, code] = id.split(":");
    return `${KIND_LABELS[kind] ?? kind} ${code}`;
  };
  // A comment names at most this many rows of each kind of change (GitHub
  // rejects a comment over 65,536 characters).
  const SHOWN = 30;
  const more = (list) =>
    list.length > SHOWN
      ? [`- and ${list.length - SHOWN} more (see the issue text)`]
      : [];
  const lines = [
    previousIds
      ? `The list changed on ${today}: ${added.length} added, ${resolved.length} no longer listed, ${now.length} open now.`
      : `The list was rebuilt on ${today} (the list of the old text could not be read): ${now.length} open now.`,
  ];
  if (added.length > 0) {
    lines.push(
      "",
      "Added:",
      ...added
        .slice(0, SHOWN)
        .map(
          (item) =>
            `- ${KIND_LABELS[item.kind]} ${item.code}: ${safeText(clip(item.summary, 260))}`,
        ),
      ...more(added),
    );
  }
  if (resolved.length > 0) {
    lines.push(
      "",
      "No longer listed (fixed in the hub, changed on Learn, or the date has passed):",
      ...resolved.slice(0, SHOWN).map((id) => `- ${describe(id)}`),
      ...more(resolved),
    );
  }
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  return lines.join("\n");
}

/**
 * The most recently closed issue with exactly this title and label, with its
 * text, or null. A lookup that fails is "none found": it only decides whether a
 * closed issue suppresses a new one, and a missing suppression costs at most
 * one early issue, never a lost alert.
 */
function lastClosedIssue(gh, { title, label }) {
  try {
    const out = gh([
      "issue",
      "list",
      "--state",
      "closed",
      "--label",
      label,
      "--limit",
      "100",
      "--json",
      "number,title,closedAt",
    ]);
    const latest = JSON.parse(out || "[]")
      .filter((issue) => String(issue?.title ?? "").trim() === title)
      .sort(
        (a, b) =>
          String(b.closedAt ?? "").localeCompare(String(a.closedAt ?? "")) ||
          b.number - a.number,
      )[0];
    if (!latest) return null;
    return { ...latest, body: readIssueBody(gh, latest.number) };
  } catch {
    return null;
  }
}

const issueResult = (action, extra = {}) => ({
  action,
  number: null,
  closed: [],
  error: null,
  ...extra,
});
const runLine = (cfg) => (cfg.runUrl ? `\n\nRun: ${cfg.runUrl}` : "");

/**
 * Brings the ONE running drift issue in line with the items, through
 * `gh(args, stdin)`:
 *   something to fix or check, none open   create it with the report, unless a
 *                                          maintainer closed the issue by hand
 *                                          less than DRIFT_REMINDER_DAYS ago and
 *                                          no row is new since (then: nothing);
 *   something to fix or check, one open    unchanged marker: nothing at all;
 *                                          another row hash: edit the text;
 *                                          another set of rows: edit the text,
 *                                          and add a comment when a row was added
 *                                          or a row other than a dated reminder
 *                                          left (a dated reminder that only runs
 *                                          out is not news);
 *   nothing to fix or check, some open     close each with a comment (after
 *                                          clearing the marker of its text, which
 *                                          is how a close by the monitor differs
 *                                          from a close by hand).
 * Not enabled (no CREATE_ISSUES, or DRY_RUN): nothing is touched, not even read.
 * When the issue is needed, a failed lookup or write throws (the caller keeps
 * it from blocking the exam alert and fails the run at the end, and the next
 * run does it again); when it is only being closed, a failure is reported in
 * the result (`error`, action lookup-failed or close-failed) and the next run
 * retries; the caller counts that failure like a thrown one.
 */
export function syncDriftIssue(cfg, gh, { items, report }) {
  const enabled = cfg.createIssues && !cfg.dryRun;
  const active = items.some((item) => item.severity !== "info");
  if (!enabled) return issueResult(active ? "skipped" : "none");

  let open;
  try {
    open = listOpenIssues(gh, {
      title: DRIFT_ISSUE_TITLE,
      label: DRIFT_ISSUE_LABEL,
      body: active,
    });
  } catch (error) {
    if (active) throw error;
    return issueResult("lookup-failed", { error: error.message });
  }

  if (active) {
    if (open.length === 0) {
      const held = closedByHand(cfg, gh, items, report.signature);
      if (held) return issueResult("held", { number: held.number });
      const out = gh(
        [
          "issue",
          "create",
          "--title",
          DRIFT_ISSUE_TITLE,
          "--label",
          DRIFT_ISSUE_LABEL,
          "--body-file",
          "-",
        ],
        report.body,
      );
      return issueResult("created", {
        number: Number(out.match(/\/issues\/(\d+)/)?.[1]) || null,
      });
    }
    const issue = open[0];
    const marker = parseDriftMarker(issue.body);
    const sig = report.signature;
    if (
      marker &&
      marker.a === sig.a &&
      marker.b === sig.b &&
      marker.h === sig.h
    ) {
      return issueResult("unchanged", { number: issue.number });
    }
    gh(
      ["issue", "edit", String(issue.number), "--body-file", "-"],
      report.body,
    );
    if (!marker || marker.a !== sig.a) {
      // A comment is the notification: it goes out when a row was added or an
      // ordinary row left, not when a dated reminder merely ran out (that
      // would add a comment for every date that passes).
      const changes = driftChanges(items, marker ? marker.ids : null);
      const news =
        marker?.ids == null ||
        changes.added.length > 0 ||
        changes.resolved.some((id) => !isDatedRowId(id));
      if (news) {
        gh(
          ["issue", "comment", String(issue.number), "--body-file", "-"],
          buildDriftComment({
            items,
            previousIds: marker ? marker.ids : null,
            today: cfg.today,
            runUrl: cfg.runUrl,
          }),
        );
        return issueResult("commented", { number: issue.number });
      }
    }
    return issueResult("edited", { number: issue.number });
  }

  const closed = [];
  const failures = [];
  for (const issue of open) {
    try {
      // The marker of the closed issue lists no row: a maintainer who closes
      // the issue by hand leaves the rows in it, which is what holds a new
      // issue back (closedByHand).
      const body = readIssueBody(gh, issue.number);
      if (DRIFT_MARKER_RE.test(body)) {
        gh(
          ["issue", "edit", String(issue.number), "--body-file", "-"],
          body.replace(
            DRIFT_MARKER_RE,
            "<!-- learn-drift:v1 a=- b=- h=closed -->",
          ),
        );
      }
      gh([
        "issue",
        "close",
        String(issue.number),
        "--comment",
        `Nothing is left to fix or check as of ${cfg.today}: the hub pages agree with Microsoft Learn on everything this monitor compares. Closing this issue; the next difference opens a new one.${runLine(cfg)}`,
      ]);
      closed.push(issue.number);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return issueResult(
    closed.length ? "closed" : failures.length ? "close-failed" : "none",
    { number: closed[0] ?? null, closed, error: failures.join("; ") || null },
  );
}

/**
 * The drift issue a maintainer closed by hand, while it is still too early for a
 * new one: the latest closed issue with the stable title that was closed less
 * than DRIFT_REMINDER_DAYS ago and whose marker still lists rows (the monitor
 * clears the marker when it closes the issue itself, so a relapse after that
 * opens a new issue at once). Returns { issue, marker } or null.
 */
function heldIssue(cfg, gh) {
  if (!(cfg.driftReminderDays > 0)) return null;
  const closed = lastClosedIssue(gh, {
    title: DRIFT_ISSUE_TITLE,
    label: DRIFT_ISSUE_LABEL,
  });
  const marker = closed ? parseDriftMarker(closed.body) : null;
  const closedOn = String(closed?.closedAt ?? "").slice(0, 10);
  if (!marker || !/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) return null;
  const age = daysBetween(closedOn, cfg.today);
  if (age < 0 || age >= cfg.driftReminderDays) return null;
  return { issue: closed, marker };
}

/**
 * The drift issue a maintainer closed by hand, when every row to fix or check
 * now was already in it (see heldIssue). A row that is new since, or the passing
 * of the reminder time, opens a new issue. Returns the closed issue or null.
 */
function closedByHand(cfg, gh, items, signature) {
  const held = heldIssue(cfg, gh);
  if (!held) return null;
  const { issue, marker } = held;
  // Rows spelled out: held while none is new. A marker with only a hash of the
  // rows can only say "exactly the same rows".
  if (marker.ids === null) return marker.a === signature.a ? issue : null;
  if (marker.ids.length === 0) return null; // closed by the monitor itself
  const known = new Set(marker.ids);
  const fresh = items.filter(
    (item) => item.severity !== "info" && !known.has(item.id),
  );
  return fresh.length === 0 ? issue : null;
}

/**
 * The issue that says the drift check itself could not run (hub files
 * unreadable, an unexpected error, the MAX_DRIFT failsafe): created, then one
 * comment per further failed run, closed after the next healthy run.
 * `message` is the failure, or null for a healthy run.
 */
export function syncDriftFailureIssue(cfg, gh, message) {
  const enabled = cfg.createIssues && !cfg.dryRun;
  const failed = message !== null;
  if (!enabled) return issueResult(failed ? "skipped" : "none");
  let open;
  try {
    open = listOpenIssues(gh, {
      title: DRIFT_FAILED_ISSUE_TITLE,
      label: DRIFT_FAILED_ISSUE_LABEL,
    });
  } catch (error) {
    if (failed) throw error;
    return issueResult("lookup-failed", { error: error.message });
  }
  if (failed) {
    if (open.length > 0) {
      gh(
        ["issue", "comment", String(open[0].number), "--body-file", "-"],
        `The drift check could not run again on ${cfg.today}:\n\n${message}${runLine(cfg)}`,
      );
      return issueResult("commented", { number: open[0].number });
    }
    const out = gh(
      [
        "issue",
        "create",
        "--title",
        DRIFT_FAILED_ISSUE_TITLE,
        "--label",
        DRIFT_FAILED_ISSUE_LABEL,
        "--body-file",
        "-",
      ],
      `The hub-vs-Learn drift check of the New Exam Monitor could not run on ${cfg.today}. The running issue "${DRIFT_ISSUE_TITLE}" was not touched, nothing was lost, and the exam and study guide checks ran as usual.\n\n**Why:** ${message}${runLine(cfg)}\n\nThis issue gets one comment per failed run and closes itself after the next healthy run.`,
    );
    return issueResult("created", {
      number: Number(out.match(/\/issues\/(\d+)/)?.[1]) || null,
    });
  }
  const closed = [];
  const failures = [];
  for (const issue of open) {
    try {
      gh([
        "issue",
        "close",
        String(issue.number),
        "--comment",
        `The drift check ran normally on ${cfg.today}. Closing this issue.${runLine(cfg)}`,
      ]);
      closed.push(issue.number);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return issueResult(
    closed.length ? "closed" : failures.length ? "close-failed" : "none",
    { number: closed[0] ?? null, closed, error: failures.join("; ") || null },
  );
}

/**
 * The ids of the rows the running drift issue lists (the marker of its text), or
 * null when they cannot be known: issues are not enabled, none is open, its text
 * has no marker, or `gh` failed (a lookup that fails only costs the failsafe its
 * memory; the issue step reports a real gh problem).
 */
function openIssueIds(cfg, gh) {
  if (!(cfg.createIssues && !cfg.dryRun)) return null;
  try {
    const open = listOpenIssues(gh, {
      title: DRIFT_ISSUE_TITLE,
      label: DRIFT_ISSUE_LABEL,
      body: true,
    });
    const marker = open.length > 0 ? parseDriftMarker(open[0].body) : null;
    return marker?.ids ? new Set(marker.ids) : null;
  } catch {
    return null;
  }
}

/**
 * The ids of the rows of an issue a maintainer closed by hand while it still
 * holds a new one back (heldIssue), or null: with no running issue those rows are
 * as good as listed, so a list the maintainers accepted (FORCE_DRIFT) does not
 * trip the failsafe again because they closed its issue.
 */
function heldIssueIds(cfg, gh) {
  if (!(cfg.createIssues && !cfg.dryRun)) return null;
  const ids = heldIssue(cfg, gh)?.marker.ids;
  return ids?.length ? new Set(ids) : null;
}

// The rows to fix or check that a set of known ids does not list.
const unlistedRows = (items, known) =>
  items.filter((item) => item.severity !== "info" && !known?.has(item.id));

// The failsafe counts dated reminders apart from the other rows.
function driftFlood(cfg, rows) {
  const dated = rows.filter((item) => item.kind === "effective").length;
  const others = rows.length - dated;
  return {
    dated,
    others,
    over: others > cfg.maxDrift || dated > cfg.maxDriftDates,
  };
}

/**
 * Evaluates the drift and brings the issues in line. Never throws for a
 * problem of the check itself (hub files unreadable, an unexpected error, the
 * MAX_DRIFT failsafe): that is reported as `failure` and in the failure issue,
 * and the running issue is left alone. A `gh` failure while an issue is kept
 * up to date does not throw either: it is recorded in `syncErrors` (a call that
 * throws, and a lookup or close that comes back as a failed result alike), so
 * the exam alert and the tracker commit of the same run still go ahead and the
 * caller reports it (drift_issue_failed) for the workflow to fail at the end.
 */
export function runDriftCheck(
  cfg,
  { hub, inputError, tracker, gh, probes = new Map() },
) {
  const result = {
    items: [],
    // Drift the maintainers acknowledged (drift-acknowledged.json): [{ entry,
    // items }] for what was suppressed today, and the entries that suppressed
    // nothing. Neither is a row of the issue; both go to the log and the summary.
    acknowledged: [],
    unmatchedAcknowledgements: [],
    failure: null,
    report: null,
    issue: issueResult("none"),
    failureIssue: issueResult("none"),
    // `gh` failures while the issues were kept up to date (see below).
    syncErrors: [],
  };
  // A failed `gh` call must not take the exam and study guide alerts down with
  // it (they are a separate step of the workflow, and the tracker commit comes
  // after them): it is recorded here, the outputs are still written, and the
  // workflow fails at the very end (`drift_issue_failed`). Nothing is lost: the
  // drift is derived from the hub files and the tracker, so the next run does
  // the same work again.
  const guarded = (what, fn) => {
    try {
      const issue = fn();
      // A lookup or a close that failed comes back as a result, not a throw.
      if (issue.error) result.syncErrors.push(`${what}: ${issue.error}`);
      return issue;
    } catch (error) {
      const message = `${what}: ${error?.message ?? error}`;
      result.syncErrors.push(message);
      return issueResult("failed", { error: message });
    }
  };

  if (inputError) {
    result.failure = `The hub files could not be read, so nothing was compared: ${inputError}.`;
  } else {
    try {
      const found = evaluateDrift({
        today: cfg.today,
        hub,
        tracker,
        probes,
        leadDays: cfg.effectiveLeadDays,
        graceDays: cfg.effectiveGraceDays,
        renameDays: cfg.certRenameDays,
      });
      // What the maintainers acknowledged is neither a row of the issue nor
      // counted by the failsafe; the summary lists it so it is not forgotten.
      const split = applyAcknowledgements(found, hub.acknowledged ?? []);
      result.items = split.kept;
      result.acknowledged = split.acknowledged;
      result.unmatchedAcknowledgements = split.unmatched;
    } catch (error) {
      result.failure = `Unexpected error while comparing the hub with Learn: ${error?.stack ?? error}`;
    }
  }

  if (!result.failure) {
    // "At once" means rows the running issue does not list yet: a long list
    // that a maintainer already accepted (FORCE_DRIFT) must not trip the
    // failsafe again the next day. Without a readable issue every row counts,
    // except that an issue closed by hand while it holds a new one back still
    // lists its rows (only looked up when the list would trip the failsafe).
    const listed = cfg.forceDrift ? null : openIssueIds(cfg, gh);
    let fresh = unlistedRows(result.items, listed);
    let flood = driftFlood(cfg, fresh);
    if (!cfg.forceDrift && flood.over) {
      const held = heldIssueIds(cfg, gh);
      if (held) {
        fresh = unlistedRows(
          result.items,
          new Set([...(listed ?? []), ...held]),
        );
        flood = driftFlood(cfg, fresh);
      }
    }
    if (!cfg.forceDrift && flood.over) {
      const examples = fresh
        .filter((item) => item.kind !== "effective")
        .slice(0, 6)
        .map((item) => `${item.kind} ${item.code}`)
        .join(", ");
      result.failure =
        `${flood.others} new drift items (limit MAX_DRIFT ${cfg.maxDrift}) and ${flood.dated} new dated reminders (limit MAX_DRIFT_DATES ${cfg.maxDriftDates}) appeared at once. ` +
        "That points to a naming or markup change on Microsoft Learn or in the hub pages, not news, so the running issue " +
        `"${DRIFT_ISSUE_TITLE}" was not touched. Examples: ${examples || "none"}. ` +
        "If the differences are real, run the workflow manually with `force_drift` enabled (or run the script locally with FORCE_DRIFT=1): " +
        "the issue is then created or updated with the full list, and later runs only count rows that are not in it.";
    }
  }

  if (result.failure) {
    result.failureIssue = guarded(
      `the issue "${DRIFT_FAILED_ISSUE_TITLE}" could not be kept up to date`,
      () =>
        syncDriftFailureIssue(cfg, gh, safeText(result.failure).slice(0, 3000)),
    );
    return result;
  }

  result.report =
    result.items.length > 0
      ? buildDriftReport({ items: result.items, today: cfg.today })
      : null;
  result.issue = guarded(
    `the issue "${DRIFT_ISSUE_TITLE}" could not be kept up to date`,
    () =>
      syncDriftIssue(cfg, gh, {
        items: result.items,
        report: result.report,
      }),
  );
  // A healthy check ends the "could not run" alert (a failed close is only reported).
  result.failureIssue = guarded(
    `the issue "${DRIFT_FAILED_ISSUE_TITLE}" could not be closed`,
    () => syncDriftFailureIssue(cfg, gh, null),
  );
  return result;
}

/** What the drift check did, for the job summary and the log. */
function reportDrift(cfg, result) {
  const open = result.items.filter((item) => item.severity !== "info");
  const info = result.items.length - open.length;
  if (result.failure) {
    warnLoud(`The drift check did not run: ${result.failure}`);
  } else {
    console.log(
      `Drift: ${result.items.filter((i) => i.severity === "fix").length} to fix, ` +
        `${result.items.filter((i) => i.severity === "check").length} to check, ${info} for information.`,
    );
    for (const item of result.items) {
      console.log(
        `  [${item.severity}] ${item.kind} ${item.code}: ${clip(item.summary, 220)}`,
      );
    }
    for (const { entry, items } of result.acknowledged ?? []) {
      console.log(
        `  [acknowledged] ${entry.kind} ${entry.code} (since ${entry.since}; ${clip(safeText(entry.reason), 120)}): ${items.length} not reported.`,
      );
    }
    for (const entry of result.unmatchedAcknowledgements ?? []) {
      console.log(
        `  [acknowledged] ${entry.kind} ${entry.code} (since ${entry.since}): nothing to suppress today.`,
      );
    }
  }
  const describe = (label, issue) => {
    if (issue.action === "skipped") {
      return `${label} not touched (${cfg.dryRun ? "DRY_RUN" : "CREATE_ISSUES is not 1"}).`;
    }
    if (
      issue.action === "lookup-failed" ||
      issue.action === "close-failed" ||
      issue.action === "failed"
    ) {
      return `${label}: ${issue.action} (${issue.error}); the next run tries again.`;
    }
    if (issue.action === "held") {
      return `${label} not recreated: a maintainer closed it by hand less than ${cfg.driftReminderDays} days ago (#${issue.number}) and no row is new since.`;
    }
    if (issue.action === "none") return null;
    return `${label} ${issue.action}${issue.number ? ` (#${issue.number})` : ""}.`;
  };
  for (const line of [
    describe(`Drift issue "${DRIFT_ISSUE_TITLE}"`, result.issue),
    describe(
      `Drift failure issue "${DRIFT_FAILED_ISSUE_TITLE}"`,
      result.failureIssue,
    ),
  ]) {
    if (line && !/not touched/.test(line)) console.log(line);
  }
  // The exam alert and the tracker commit go ahead, but a drift issue that
  // could not be kept up to date must be seen: an annotation here, and the
  // workflow fails at its last step (drift_issue_failed).
  for (const message of result.syncErrors ?? []) {
    warnLoud(
      `${message}. The exam and study guide checks are unaffected; the next run does the drift work again, and this run fails at the end so it is seen.`,
    );
  }

  if (!cfg.stepSummary) return;
  const lines = [];
  if (result.failure) {
    lines.push(`- **The drift check did not run:** ${result.failure}`);
  } else {
    lines.push(
      `- ${open.length} rows to fix or check, ${info} for information. Issue: ${result.issue.action}${result.issue.number ? ` (#${result.issue.number})` : ""}.`,
    );
    for (const item of result.items.filter((i) => i.severity === "info")) {
      lines.push(
        `- For information, ${item.kind} ${item.code}: ${safeText(clip(item.summary, 300))}`,
      );
    }
    // Acknowledged drift never reaches the issue, so this is the only place it
    // shows: an acknowledgement is a decision to re-read now and then.
    for (const { entry, items } of result.acknowledged ?? []) {
      lines.push(
        `- **Acknowledged**, not reported: \`${entry.code}\` ${entry.kind} drift since ${entry.since} (${safeText(clip(entry.reason, 200))}). Suppressed today: ${items
          .map((item) => safeText(clip(item.summary, 220)))
          .join(" | ")}`,
      );
    }
    for (const entry of result.unmatchedAcknowledgements ?? []) {
      lines.push(
        `- **Acknowledged**, but nothing to suppress today: \`${entry.code}\` ${entry.kind} drift since ${entry.since} (${safeText(clip(entry.reason, 200))}). Remove the entry from \`src/data_files/drift-acknowledged.json\` when it is no longer needed.`,
      );
    }
  }
  for (const message of result.syncErrors ?? []) {
    lines.push(
      `- **${safeText(message)}.** The exam and study guide checks ran as usual; the next run does the drift work again.`,
    );
  }
  appendStepSummary(
    cfg.stepSummary,
    `### New Exam Monitor: hub vs Learn drift\n\n${lines.join("\n")}\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/** Fetches and parses one certification page: { cert, page } or { cert, reason }. */
async function readCertificationPage(cfg, cert, deadline) {
  const url = `${cfg.baseUrl}/en-us/credentials/certifications/${cert.slug}/`;
  const response = await fetchText(cfg, url, deadline);
  if (!response.ok) {
    return {
      cert,
      reason: response.deadline
        ? "run deadline reached"
        : `status ${response.status ?? "network error"}`,
    };
  }
  if (!isCertificationPage(response.text)) {
    return { cert, reason: "not a certification page" };
  }
  const page = parseCertificationPage(response.text);
  if (page.uid && page.uid.toLowerCase() !== cert.uid.toLowerCase()) {
    return { cert, reason: `page is ${page.uid}, expected ${cert.uid}` };
  }
  return { cert, page };
}

function handleFailure(cfg, error) {
  const message =
    error instanceof ExtractionError
      ? error.message
      : `Unexpected error: ${error?.stack ?? error}`;
  console.error(`ERROR: ${message}`);
  try {
    writeFileSync(cfg.errorFile, `${message}\n`);
  } catch {
    /* the error is already on stderr */
  }
  writeOutput(cfg.githubOutput, {
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
    guide_check_failed: "skipped",
    drift_check_failed: false,
    drift_issue_failed: false,
    drift_items: 0,
    study_guides_changed: 0,
    issue_title: "",
  });
  process.exit(1);
}

async function main(cfg) {
  console.log("=== New Exam Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);
  // Never publish a stale report or error.
  rmSync(cfg.reportFile, { force: true });
  rmSync(cfg.errorFile, { force: true });
  rmSync(cfg.driftReportFile, { force: true });
  rmSync(cfg.driftErrorFile, { force: true });

  const previous = loadTracker(cfg);
  const isBaseline =
    previous.exams.length === 0 && previous.certifications.length === 0;
  const silent = isBaseline || cfg.forceBaseline;
  // Study guides are recorded silently (and a lost section accepted) in a
  // baseline, with FORCE_BASELINE, and with FORCE_GUIDE_BASELINE, which leaves
  // the exam alerts alone.
  const guideSilent = silent || cfg.forceGuideBaseline;
  // One budget for the listing and the certification pages: a degraded Learn
  // must end in a failure issue well before the workflow's own timeout.
  const runDeadline = makeDeadline(cfg.deadlineMs);

  console.log("Fetching the credentials listing...");
  const { certifications, examinations } = parseListing(
    await fetchListing(cfg, runDeadline),
  );
  console.log(
    `Listed ${certifications.length} certifications and ${examinations.length} standalone exams.`,
  );
  if (certifications.length < cfg.minCertifications) {
    throw new ExtractionError(
      `The listing returned only ${certifications.length} certifications (expected at least ` +
        `${cfg.minCertifications}). The API shape or filter may have changed; the tracker was not modified.`,
    );
  }

  console.log("Fetching certification pages...");
  await sleep(cfg.fetchDelayMs);
  // A silent baseline is never revisited, so it needs nearly every page.
  const requiredPct = silent
    ? Math.max(cfg.minPageOkPct, cfg.minBaselinePageOkPct)
    : cfg.minPageOkPct;
  const total = certifications.length;
  let failed = 0;
  // Doomed: even if every remaining page loads, too few pages were read.
  const doomed = () =>
    total > 0 && ((total - failed) * 100) / total < requiredPct;
  const results = await mapPool(
    certifications,
    CONCURRENCY,
    cfg.fetchDelayMs,
    async (cert) => {
      const result = await readCertificationPage(cfg, cert, runDeadline);
      if (!result.page) failed++;
      return result;
    },
    () => runDeadline.expired() || doomed(),
  );

  const pages = new Map();
  let attempted = 0;
  for (const result of results) {
    if (!result) continue;
    attempted++;
    if (result.page) {
      pages.set(result.cert.slug, result.page);
    } else {
      console.error(
        `WARNING: could not read the page of "${result.cert.slug}" (${result.reason}).`,
      );
    }
  }
  if (attempted < total) {
    if (runDeadline.expired()) {
      throw new ExtractionError(
        deadlineMessage(
          cfg,
          `reading certification pages (${pages.size} of ${total} read)`,
        ),
      );
    }
    throw new ExtractionError(
      `Stopped early: ${failed} of the ${attempted} certification pages tried could not be fetched and parsed, ` +
        `so fewer than ${requiredPct}% of the ${total} can still be read${silent ? " (a baseline is never revisited and needs more)" : ""}. ` +
        "The site may be blocking requests or throttling, or its markup may have changed; the tracker was not modified.",
    );
  }
  const okPct = total > 0 ? (pages.size * 100) / total : 100;
  if (okPct < requiredPct) {
    throw new ExtractionError(
      `Only ${pages.size} of ${total} certification pages could be fetched and parsed ` +
        `(${okPct.toFixed(1)}%, expected at least ${requiredPct}%${silent ? " for a baseline, which is never revisited" : ""}). ` +
        "The site may be blocking requests or its markup may have changed; the tracker was not modified.",
    );
  }
  console.log(`Read ${pages.size} of ${total} certification pages.`);

  // Study guides: the sitemap index and the credentials sitemap. A problem here
  // never fails the exam detection: the study guide logic is skipped for the
  // run, loudly (log, workflow annotation, job summary).
  const guideDeadline = makeDeadline(cfg.guideDeadlineMs);
  const requestsBeforeGuides = stats.requests;
  let sitemap = null;
  let guideSkipped = null;
  try {
    console.log("Fetching the study guide sitemap...");
    await sleep(cfg.fetchDelayMs);
    sitemap = await fetchStudyGuideSitemap(cfg, guideDeadline);
    console.log(
      `The sitemap lists ${sitemap.guides.size} certification study guides.`,
    );
  } catch (error) {
    guideSkipped =
      error instanceof SitemapError
        ? error.message
        : `unexpected error (${error?.stack ?? error})`;
    warnLoud(`Study guides were not checked this run: ${guideSkipped}.`);
  }

  // The hub side of the drift check. A hub file that cannot be read never fails
  // the exam detection: the drift check is skipped and says so (failure issue).
  let hub = null;
  let driftInputError = null;
  try {
    if (cfg.driftCheck) hub = await loadHubContext(cfg);
  } catch (error) {
    driftInputError =
      error instanceof DriftInputError
        ? error.message
        : `unexpected error (${error?.stack ?? error})`;
    warnLoud(`The drift check cannot read the hub files: ${driftInputError}.`);
  }
  // The exam pages of the exams the hub marks BETA or UPCOMING: the exam page
  // title carries the "(beta)" marker, and an UPCOMING exam may show up there
  // first. A probe that fails proves nothing and is left out.
  let probes = new Map();
  let probed = [];
  if (hub) {
    const targets = probeTargets(hub);
    if (targets.length > 0) {
      probed = targets;
      const guideTargets = guideProbeTargets(
        hub,
        targets,
        new Set(sitemap ? sitemap.guides.keys() : []),
      );
      console.log(
        `Probing the exam pages of ${targets.join(", ")}` +
          (guideTargets.size > 0
            ? ` and the study guide pages of ${[...guideTargets].join(", ")}`
            : "") +
          "...",
      );
      probes = await probeExamPages(
        cfg,
        targets,
        makeDeadline(cfg.probeDeadlineMs),
        guideTargets,
      );
    }
  }

  const scan = buildScan({
    certifications,
    examinations,
    pages,
    previous,
    guideCodes: sitemap ? [...sitemap.guides.keys()] : [],
    probes,
    probeCodes: probed,
  });
  scan.warnings.forEach((warning) => console.error(`WARNING: ${warning}`));

  // Pages that read fine but lost their exams point to changed exam markup,
  // not to a few retired certifications: do not go blind quietly.
  if (scan.knownWithExams > 0) {
    const emptyPct = (scan.emptyPages.length * 100) / scan.knownWithExams;
    if (emptyPct > cfg.maxEmptyPagePct) {
      throw new ExtractionError(
        `${scan.emptyPages.length} of the ${scan.knownWithExams} certification pages the tracker knew exams for ` +
          `(${emptyPct.toFixed(1)}%, more than MAX_EMPTY_PAGE_PCT ${cfg.maxEmptyPagePct}%) were read but list no exam. ` +
          "Microsoft Learn's exam markup (the Pearson VUE scheduling link, learn_exam metas, exam cards) probably " +
          "changed; the tracker was not modified. Examples: " +
          `${scan.emptyPages.slice(0, 5).join(", ")}.`,
      );
    }
  }

  const knownExams = new Set(previous.exams.map((exam) => exam.code));
  const knownCerts = new Set(previous.certifications.map((cert) => cert.slug));
  // The first time study guides are recorded (the tracker has none yet), the
  // codes only a study guide shows are recorded as exams silently: they are the
  // exams Learn already had, like the baseline of the certification pages.
  const guideBaseline = previous.studyGuides.length === 0;
  const allNewExamCodes = [...scan.exams.keys()]
    .filter((code) => !knownExams.has(code))
    .sort(byCodePoint);
  const quietExams =
    silent || guideBaseline
      ? allNewExamCodes.filter((code) => scan.exams.get(code).guideOnly)
      : [];
  const newExamCodes = allNewExamCodes.filter(
    (code) => !quietExams.includes(code),
  );
  const newCertSlugs = [...scan.certs.keys()]
    .filter((slug) => !knownCerts.has(slug))
    .sort(byCodePoint);

  const hubPage = (code) => hasHubPage(cfg, code);
  const { alertExams, silentExams, alertCerts, silentCerts } = selectAlerts({
    newExamCodes,
    newCertSlugs,
    scan,
    hubPage,
  });

  if (!silent) {
    const forceHint =
      "Set FORCE_BASELINE=1 to record them silently if they are real: run the workflow manually with " +
      "`force_baseline` enabled, or run the script locally with that variable and commit the tracker.";
    // Only the exams that would be alerted count: Office and legacy families
    // (MO-*, 70-*) come in bunches and are tracked silently, like an exam that
    // already has a hub page.
    const pct = (alertExams.length * 100) / Math.max(knownExams.size, 1);
    if (alertExams.length > cfg.maxNewExams || pct > cfg.maxNewPct) {
      throw new ExtractionError(
        `${alertExams.length} new exams appeared at once (${pct.toFixed(1)}% of the ${knownExams.size} tracked; ` +
          "exams in ignored families and exams that already have a hub page are not counted), " +
          "exceeding MAX_NEW_EXAMS / MAX_NEW_PCT. That points to a structure change on Microsoft Learn, not news; " +
          `the tracker was not modified. ${forceHint}`,
      );
    }
    // Renamed slugs look like a flood of new certifications although no exam is
    // new. MOS certifications come in bunches and are silent anyway.
    const countedCerts = newCertSlugs.filter(
      (slug) => !scan.certs.get(slug).types.includes("mos"),
    );
    const certPct = (countedCerts.length * 100) / Math.max(knownCerts.size, 1);
    if (countedCerts.length > cfg.maxNewCerts || certPct > cfg.maxNewPct) {
      throw new ExtractionError(
        `${countedCerts.length} new certifications appeared at once (${certPct.toFixed(1)}% of the ${knownCerts.size} tracked), ` +
          "exceeding MAX_NEW_CERTS / MAX_NEW_PCT. That points to renamed certification URLs or a structure change on " +
          `Microsoft Learn, not news; the tracker was not modified. ${forceHint}`,
      );
    }
  }

  // Covered study guides: read every one (a conditional request, so an
  // unchanged page costs almost nothing), hash their text, find what changed. A
  // guide-wide markup change trips the guide failsafe, which discards the guide
  // results of the run and reports itself; it never blocks the exam detection.
  let guideRun = null;
  if (sitemap) {
    try {
      guideRun = await checkStudyGuides(cfg, {
        sitemap,
        previous,
        covered: hubPage,
        silent: guideSilent,
        deadline: guideDeadline,
      });
    } catch (error) {
      guideSkipped = `unexpected error while reading study guides (${error?.stack ?? error})`;
      warnLoud(`Study guides were not checked this run: ${guideSkipped}.`);
    }
  }
  if (guideRun?.failsafe) {
    warnLoud(`The study guide check stopped: ${guideRun.failsafe}`);
    try {
      writeFileSync(cfg.errorFile, `${guideRun.failsafe}\n`);
    } catch {
      /* the warning above already carries the message */
    }
  }
  // The sitemap files and the guides read: the extra requests of this feature.
  const guideRequests = stats.requests - requestsBeforeGuides;

  let next = mergeTracker(previous, scan, cfg.today);
  const nextExams = new Map(next.exams.map((exam) => [exam.code, exam]));
  const nextCerts = new Map(
    next.certifications.map((cert) => [cert.slug, cert]),
  );

  if (silent) {
    const inScope = next.exams.filter((exam) => areaForCode(exam.code));
    const uncovered = inScope.filter((exam) => !hubPage(exam.code));
    const unmappedFamilies = next.exams.filter((exam) =>
      isUnmappedFamily(exam.code),
    );
    const label = isBaseline ? "Baseline" : "FORCE_BASELINE";
    console.log(
      `${label}: ${next.certifications.length} certifications, ` +
        `${next.exams.length} exams (${next.exams.filter((exam) => exam.beta).length} beta). ` +
        `${uncovered.length} of ${inScope.length} exams in the hub areas have no hub page` +
        (uncovered.length
          ? `: ${uncovered.map((exam) => exam.code).join(", ")}.`
          : "."),
    );
    if (unmappedFamilies.length > 0) {
      console.log(
        `${unmappedFamilies.length} exams are in families the hub neither maps nor ignores: ` +
          `${unmappedFamilies.map((exam) => exam.code).join(", ")}.`,
      );
    }
    console.log(
      `${scan.noExamPages.length} of ${pages.size} certification pages list no exam ` +
        "(the mos-* and educator certifications normally list none).",
    );
    writeStepSummary(cfg, {
      label,
      certifications: next.certifications.length,
      exams: next.exams.length,
      uncovered: uncovered.map((exam) => exam.code),
      unmappedFamilies: unmappedFamilies.map((exam) => exam.code),
    });
  } else {
    for (const { code, reason } of silentExams) {
      console.log(`New exam ${code} tracked without an alert (${reason}).`);
    }
    for (const { slug, reason } of silentCerts) {
      console.log(
        `New certification ${slug} tracked without an alert (${reason}).`,
      );
    }
    for (const code of alertExams.filter(isUnmappedFamily)) {
      console.log(
        `New exam ${code} is in a family the hub neither maps nor ignores: alerting.`,
      );
    }
  }

  const alerting = silent
    ? { exams: [], certs: [] }
    : { exams: alertExams, certs: alertCerts };

  // An exam about to be alerted needs a name, a known status and, ideally, a
  // confirmed exam page. Ask the exam page and the study guide for what is missing.
  const targets = alerting.exams
    .filter((code) => {
      const seen = scan.exams.get(code);
      return (
        !nextExams.get(code).name ||
        !(seen.betaKnown || seen.beta) ||
        !nextExams.get(code).url
      );
    })
    .map((code) => ({ code, needsName: !nextExams.get(code).name }));
  if (targets.length > 0) {
    const details = await lookUpExamDetails(
      cfg,
      targets,
      makeDeadline(cfg.lookupDeadlineMs),
    );
    for (const [code, info] of details) {
      const record = nextExams.get(code);
      const seen = scan.exams.get(code);
      if (info.name && !record.name) record.name = info.name;
      if (info.betaKnown) {
        seen.betaKnown = true;
        seen.beta = seen.beta || info.beta;
        record.beta = record.beta || info.beta;
      }
      if (info.examPage) {
        seen.examPage = true;
        record.url = examUrl(code);
      }
    }
  }

  next = {
    lastSynced: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    certifications: next.certifications,
    exams: next.exams,
    studyGuides: guideRun ? guideRun.guides : previous.studyGuides,
    certRenames: mergeCertRenames({
      previous,
      scan,
      today: cfg.today,
      days: cfg.certRenameDays,
    }),
    effectiveDates: [],
  };
  // Dated statements are rebuilt from the text of the guides that were read in
  // full or confirmed unchanged this run; every other guide keeps its entries.
  const verifiedGuides = new Set();
  if (guideRun && !guideRun.failsafe) {
    const unverified = new Set(
      [...guideRun.failed, ...guideRun.unparsed, ...guideRun.degraded].map(
        (entry) => entry.code,
      ),
    );
    for (const { code } of guideRun.selected) {
      if (!unverified.has(code)) verifiedGuides.add(code);
    }
  }
  next.effectiveDates = reconcileEffectiveDates({
    previous: previous.effectiveDates,
    guides: next.studyGuides,
    verified: verifiedGuides,
    today: cfg.today,
    horizonDays: cfg.effectiveHorizonDays,
    graceDays: cfg.effectiveGraceDays,
  });
  const changed = trackerContent(previous) !== trackerContent(next);
  if (changed) {
    mkdirSync(dirname(cfg.trackerFile), { recursive: true });
    writeFileSync(
      cfg.trackerFile,
      JSON.stringify(next, null, 2) + "\n",
      "utf8",
    );
  } else if (existsSync(cfg.trackerFile)) {
    console.log("Tracker unchanged.");
  }

  // The report needs to know whether the status is known and where the exam was
  // seen; the tracker does not store that.
  const alertedExams = alerting.exams.map((code) => {
    const seen = scan.exams.get(code);
    return {
      ...nextExams.get(code),
      betaKnown: seen.betaKnown || seen.beta,
      evidence: evidenceOf(seen),
    };
  });
  const alertedCerts = alerting.certs.map((slug) => nextCerts.get(slug));
  // A silent run, a skipped check and a tripped failsafe have no changes.
  const alertedGuides = guideRun ? guideRun.changes : [];
  const changesFound =
    alertedExams.length > 0 ||
    alertedCerts.length > 0 ||
    alertedGuides.length > 0;

  let issueTitle = "";
  if (changesFound) {
    issueTitle = buildIssueTitle({
      exams: alertedExams,
      certs: alertedCerts,
      guides: alertedGuides,
    });
    writeFileSync(
      cfg.reportFile,
      buildReport({
        exams: alertedExams,
        certs: alertedCerts,
        guides: alertedGuides,
        scan,
        today: cfg.today,
        hubPage,
        trackedExams: nextExams,
      }),
      "utf8",
    );
  }

  reportStudyGuides(cfg, {
    sitemap,
    guideRun,
    guideSkipped,
    guideBaseline,
    quietExams,
    tracked: next.studyGuides,
    requests: guideRequests,
  });

  // Hub vs Learn: the running drift issue. When `gh` fails while it is kept up
  // to date the failure is recorded (drift_issue_failed), not thrown: the exam
  // issue and the tracker commit must not wait for it, and the workflow fails at
  // its last step instead. The drift is derived from the tracker facts and the
  // hub files, so nothing is lost and the next run does the work again; it also
  // runs on a baseline: the first run reports the problems that already exist
  // instead of swallowing them.
  const drift = cfg.driftCheck
    ? runDriftCheck(cfg, {
        hub,
        inputError: driftInputError,
        tracker: next,
        gh: makeGh({ ghCliScript: cfg.ghCliScript }),
        probes,
      })
    : {
        items: [],
        acknowledged: [],
        unmatchedAcknowledgements: [],
        failure: null,
        report: null,
        issue: issueResult("none"),
        failureIssue: issueResult("none"),
        syncErrors: [],
      };
  if (drift.report) {
    try {
      writeFileSync(cfg.driftReportFile, drift.report.body, "utf8");
    } catch (error) {
      console.error(
        `WARNING: could not write the drift report (${error.message}).`,
      );
    }
  }
  if (drift.failure) {
    try {
      writeFileSync(cfg.driftErrorFile, `${drift.failure}\n`, "utf8");
    } catch {
      /* the warning already carries the message */
    }
  }
  if (cfg.driftCheck) reportDrift(cfg, drift);

  // "true": the study guide failsafe stopped the guide check. "false": the guide
  // check ran. "skipped": it did not run (the sitemap could not be read, or the
  // guides failed unexpectedly), so the issue of the failsafe must neither be
  // raised nor closed on this run's word.
  const guideCheck = guideRun ? String(Boolean(guideRun.failsafe)) : "skipped";
  writeOutput(cfg.githubOutput, {
    changes_found: changesFound,
    baseline_updated: changed,
    extraction_failed: false,
    guide_check_failed: guideCheck,
    drift_check_failed: Boolean(drift.failure),
    // A `gh` call for the drift issues failed: the exam alert and the tracker
    // commit still go ahead, and the workflow fails at its last step.
    drift_issue_failed: (drift.syncErrors ?? []).length > 0,
    // The rows of the running issue: unknown (0) while the check did not run.
    drift_items: drift.failure
      ? 0
      : drift.items.filter((item) => item.severity !== "info").length,
    study_guides_changed: alertedGuides.length,
    issue_title: issueTitle,
  });

  console.log(
    `Tracked: ${next.certifications.length} certifications, ${next.exams.length} exams · ` +
      `New exams: ${newExamCodes.length} · New certifications: ${newCertSlugs.length} · ` +
      `Alerted: ${alertedExams.length} exams, ${alertedCerts.length} certifications, ` +
      `${alertedGuides.length} study guides`,
  );
  if (changesFound) console.log(`Issue title: ${issueTitle}`);
  console.log(`HTTP requests: ${stats.requests}`);
  console.log(changed ? "Tracker updated" : "Tracker unchanged");
  console.log("=== Done ===");
}

/** Logs what the study guide check did and puts anything noteworthy in the job summary. */
function reportStudyGuides(
  cfg,
  {
    sitemap,
    guideRun,
    guideSkipped,
    guideBaseline,
    quietExams,
    tracked,
    requests,
  },
) {
  if (!guideRun) {
    console.log(
      `Study guides: not checked${guideSkipped ? ` (${guideSkipped})` : ""}.`,
    );
    writeGuideSummary(cfg, { skipped: guideSkipped, applied: null });
    return;
  }

  const hashed = tracked.filter((guide) => guide.hash).length;
  const coveredWithoutGuide = listHubCodes(cfg).filter(
    (code) => !sitemap.guides.has(code),
  );
  const answers = [...guideRun.results.values()];
  const notModified = answers.filter(
    (answer) => answer.status === "notModified",
  ).length;
  const read = answers.filter(
    (answer) => answer.status === "ok" || answer.status === "unparsed",
  ).length;
  console.log(
    `Study guides: ${tracked.length} tracked, ${hashed} with a text hash · ` +
      `${guideRun.selected.length} covered guides checked (${read} read in full, ${notModified} not modified ` +
      `since the last read), ${requests} requests incl. the sitemap files · ` +
      `${guideRun.changes.length} changed, ${guideRun.dateOnly.length} date-only, ` +
      `${guideRun.republished.length} republished with the same text, ` +
      `${guideRun.baselined.length} first hashes, ${guideRun.rebaselined.length} re-recorded, ` +
      `${guideRun.failed.length} unreadable, ${guideRun.unparsed.length} unparsable, ` +
      `${guideRun.degraded.length} degraded.`,
  );
  if (coveredWithoutGuide.length > 0) {
    console.log(
      `Exams the hub covers without a study guide in the sitemap: ${coveredWithoutGuide.join(", ")}.`,
    );
  }
  for (const change of guideRun.changes) {
    console.log(
      `Study guide ${change.code} changed: ${
        change.diff
          ? `+${change.diff.added} / -${change.diff.removed} lines`
          : "previous text not stored"
      } (sitemap ${change.lastmodBefore || "?"} -> ${change.lastmod || "?"}).`,
    );
  }
  for (const entry of guideRun.dateOnly) {
    console.log(
      `Study guide ${entry.code}: the sitemap date moved (${entry.from || "?"} -> ${entry.to || "?"}), the text did not.`,
    );
  }
  for (const entry of guideRun.republished) {
    console.log(
      `Study guide ${entry.code}: the page was republished (updated_at ${entry.from || "?"} -> ${entry.to || "?"}; ` +
        `Last-Modified ${entry.modifiedFrom || "?"} -> ${entry.modifiedTo || "?"}), the text did not change.`,
    );
  }
  for (const entry of guideRun.failed) {
    console.error(
      `WARNING: could not read the study guide of ${entry.code} (${entry.reason}); kept its previous state.`,
    );
  }
  for (const entry of guideRun.unparsed) {
    warnLoud(
      `the study guide of ${entry.code} could not be parsed (${entry.reason}); kept its previous state.`,
    );
  }
  for (const entry of guideRun.degraded) {
    warnLoud(
      `the study guide of ${entry.code} lost its ${entry.sections.join(" and ")} section in the markup; kept its previous state. ` +
        "No change is reported for it until the section is back or FORCE_GUIDE_BASELINE=1 accepts the new text; check the guide by hand.",
    );
  }

  writeGuideSummary(cfg, {
    skipped: guideSkipped,
    applied: guideRun,
    failsafe: guideRun.failsafe,
    baseline: guideBaseline,
    tracked: tracked.length,
    hashed,
    coveredWithoutGuide,
    quietExams: quietExams.filter((code) => !hasHubPage(cfg, code)),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
