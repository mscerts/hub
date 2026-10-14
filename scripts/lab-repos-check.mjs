#!/usr/bin/env node
/**
 * Daily check of the GitHub repositories the content pages link, and of the
 * MicrosoftLearning organisation for new labs of the hub's exams.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/lab-repos-check.mjs
 *
 * Why it exists: the "Microsoft GitHub" tab of the lab pages links hundreds of
 * microsoftlearning.github.io pages. When Microsoft archives a lab repository
 * (AZ400-DesigningandImplementingMicrosoftDevOpsSolutions, mslearn-ai-services)
 * or deletes one (Azure/AzureArchitectureExampleScenarios), its GitHub Pages
 * site keeps answering HTTP 200, so no link checker ever notices. And new
 * instructor-led-training lab repos for hub exams (AB-650T00_..., AB-620T00_...)
 * appear without any announcement. This check reads the GitHub REST API, which
 * does tell.
 *
 * What it does every run (the workflow token is enough, nothing from Learn):
 *   1. Extracts every github.com/<owner>/<repo>, <owner>.github.io/<repo> and
 *      raw.githubusercontent.com/<owner>/<repo> reference from the content pages
 *      (src/content/docs, MDX and HTML comments stripped, line numbers kept).
 *      Owners that are Microsoft-owned (see MICROSOFT_OWNERS) or the hub's own
 *      organisation get every check below; any other owner is third-party and
 *      is only checked for gone / archived.
 *   2. GET /repos/{owner}/{repo} for each distinct repository:
 *        404 (or 451 blocked)          gone
 *        archived                      archived
 *        disabled                      disabled
 *        full_name differs from link   renamed (to the new name)
 *        has_pages false, linked as a
 *          .github.io page             no-pages (the Pages links return 404)
 *      and, for first-party owners, the first README_LINES lines of the README:
 *      a replacement notice ("will be archived", "no longer maintained",
 *      "moved to", ...) is a `notice` for a repository that is not archived yet
 *      and a hint for one that is. GitHub repository links found next to the
 *      notice are SUGGESTED successors (their existence is checked, never
 *      their suitability: always open them first).
 *   3. Lists the MicrosoftLearning organisation (DISCOVERY_ORGS) and flags
 *      non-localised, non-archived repositories whose name contains a watched
 *      exam code (AB-650, AZ400, AB-650T00_..., case and hyphen insensitive) and
 *      that no content page links (`new-repo`). Watched codes are the hub's exam
 *      pages plus the exams the pages announce without having a page yet: a
 *      Learn exam link on a content page (PL-400 links AB-400) and the
 *      `replacementCode` of retiring-exams.json. "Linked" means linked from any
 *      content page, not only the exam's own: a repository that the AZ-802 page
 *      carries for AZ-800 must not be reported for AZ-800. The repositories that
 *      already exist on the first run are the baseline (linked ones too, so
 *      dropping a link to a live repository never makes it look new) and are
 *      recorded silently; the exams' lab pages are named in the report. The
 *      "microsoft" organisation is not listed: it holds thousands of
 *      repositories, and the search API (30 requests a minute, one per exam
 *      code, ~60 codes) is not cheap. Conditional requests (ETag) are not used
 *      either: the ~130 requests are far inside the workflow token's 1,000 an
 *      hour, and stored ETags would change the tracker whenever any lab
 *      repository is pushed to.
 *
 * Issues (only with CREATE_ISSUES=1 and not DRY_RUN=1; the gh CLI, GH_TOKEN):
 *   - ONE running issue with the stable title ISSUE_TITLE (label enhancement,
 *     no assignee). The state is derived again every run: it lists every linked
 *     repository that has a problem now and every unlinked hub-code repository
 *     that is not in the baseline. It is created when the list becomes
 *     non-empty, gets a comment (what was added, what is resolved, the full
 *     list) when the set changes, is re-created as a reminder after
 *     REMINDER_DAYS (7) when somebody closed it while problems remain, and is
 *     closed with a comment when nothing is left. A problem the maintainer
 *     decided to keep goes into src/data_files/lab-repos-ignore.json with a
 *     reason; those are not reported.
 *   - A failure of the check itself raises ONE issue with the stable title
 *     FAILED_ISSUE_TITLE (label bug), a comment for every further failed run,
 *     and is closed by the next healthy run.
 *   - The issue is written BEFORE the tracker (the workflow commits the tracker
 *     only when this script succeeded): a failed issue step fails the run, the
 *     commit is skipped and the next run reports the same state again.
 *
 * Fetch failures are never evidence: a repository whose lookup fails (network,
 * 5xx, odd 4xx) keeps the findings from the tracker, warns, and never creates
 * or clears a finding; a run in which more than MAX_UNKNOWN_PCT of the lookups
 * failed, the rate limit is exhausted, the token is rejected or the content or
 * the organisation listing looks wrong fails instead.
 *
 * Failsafes (a bug issue and nothing written; every limit has an override):
 *   - no GH_TOKEN/GITHUB_TOKEN (the unauthenticated limit of 60 requests an hour
 *     cannot cover ~130), HTTP 401, a rate limit that does not reset within
 *     MAX_RETRY_AFTER_MS;
 *   - fewer than MIN_REFERENCES (10) repositories found in the content, fewer
 *     than MIN_ORG_REPOS (100) repositories listed for an organisation, no hub
 *     exam page found;
 *   - more than MAX_UNKNOWN_PCT (25%) of the lookups failed;
 *   - more than MAX_PROBLEMS (20) problems on linked repositories at once, or
 *     more than MAX_NEW_REPOS (20) new unlinked hub-code repositories at once:
 *     probably an API or naming change, not news. Raise the limit for one run
 *     with the workflow's max_problems input, or for new repositories accept
 *     them silently with FORCE_BASELINE=1 (the workflow's force_baseline).
 *
 * Env overrides (defaults shown):
 *   DOCS_DIR             src/content/docs
 *   TRACKER_FILE         src/data_files/lab-repos.json
 *   IGNORE_FILE          src/data_files/lab-repos-ignore.json
 *   RETIRING_EXAMS_FILE  src/data_files/retiring-exams.json (source of replacement exam codes; optional)
 *   GITHUB_API_URL       https://api.github.com
 *   GH_TOKEN / GITHUB_TOKEN   the token (required)
 *   DISCOVERY_ORGS       MicrosoftLearning   (comma separated)
 *   README_LINES         60
 *   REQUEST_DELAY_MS     300  pause between requests (one request at a time)
 *   FETCH_ATTEMPTS       3    RETRY_BASE_MS 2000   MAX_RETRY_AFTER_MS 60000
 *   FETCH_TIMEOUT_MS     30000
 *   RUN_DEADLINE_MS      600000  (from the first request: no request is made
 *                        after it, the lookups left count as failed and the
 *                        failure issue says so; the job times out at 15 minutes)
 *   MAX_PROBLEMS 20, MAX_NEW_REPOS 20, MAX_UNKNOWN_PCT 25, MIN_REFERENCES 10, MIN_ORG_REPOS 100
 *   REMINDER_DAYS        7
 *   FORCE_BASELINE       1 records the current hub-code repositories as the baseline silently
 *   REPORT_ALL           1 also lists the baselined, unlinked hub-code repositories now (once)
 *                        and reports even when nothing changed
 *   TODAY                YYYY-MM-DD, default today (UTC)
 *   REPORT_FILE          <tmpdir>/lab-repos-report.md
 *   ERROR_FILE           <tmpdir>/lab-repos-error.md
 *   GITHUB_OUTPUT        <tmpdir>/github-output
 *   GITHUB_STEP_SUMMARY  (unset: no job summary)
 *   CREATE_ISSUES        0   1 = create, comment on and close the issues with the gh CLI
 *   DRY_RUN              0   1 = touch no issue (the report and the tracker are still written locally)
 *   GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID   used for run links
 *   GH_CLI_SCRIPT        (unset)  tests only: run this Node script instead of the gh CLI
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed,
 * issue_title (the headline of the day's report; the issue's own title is the
 * stable ISSUE_TITLE).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { annotate, appendStepSummary, writeOutput } from "./lib/actions.mjs";
import { EXAM_AREAS } from "./lib/areas.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

// How paths are written in the issue, whatever DOCS_DIR is.
const DISPLAY_DOCS_DIR = "src/content/docs";

export const ISSUE_TITLE = "Lab repos: linked repositories need attention";
export const ISSUE_LABEL = "enhancement";
export const FAILED_ISSUE_TITLE = "Lab repos: the check failed";
export const FAILED_ISSUE_LABEL = "bug";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Problems, most severe first. `new-repo` is the only one about a repository
 * the content does not link yet.
 */
export const KINDS = [
  "gone",
  "archived",
  "disabled",
  "renamed",
  "no-pages",
  "notice",
  "new-repo",
];
const LINKED_KINDS = KINDS.filter((kind) => kind !== "new-repo");

/**
 * Microsoft-owned GitHub owners (compared in lowercase), plus any owner whose
 * name starts with "microsoft". Derived from what the content links (checked
 * 2026-10-14: MicrosoftLearning, microsoft, github) and from the other
 * Microsoft owners the lab pages could plausibly link. An owner that is missing
 * here is checked as third-party (gone / archived only); the run's log and job
 * summary list every owner found so a missing one is visible.
 */
export const MICROSOFT_OWNERS = new Set([
  "microsoftlearning",
  "microsoft",
  "microsoftdocs",
  "microsoftgraph",
  "azure",
  "azure-samples",
  "github",
  "powershell",
  "dotnet",
  "officedev",
]);
/** The hub's own organisation: every check applies, it is not a third party. */
export const HUB_OWNERS = new Set(["mscerts"]);

export function ownerClass(owner) {
  const lower = String(owner).toLowerCase();
  if (MICROSOFT_OWNERS.has(lower) || lower.startsWith("microsoft")) {
    return "microsoft";
  }
  if (HUB_OWNERS.has(lower)) return "hub";
  return "third-party";
}

export function loadConfig(env = process.env, overrides = {}) {
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
      env.TRACKER_FILE ?? "src/data_files/lab-repos.json",
    ),
    ignoreFile: resolveFromRoot(
      env.IGNORE_FILE ?? "src/data_files/lab-repos-ignore.json",
    ),
    retiringFile: resolveFromRoot(
      env.RETIRING_EXAMS_FILE ?? "src/data_files/retiring-exams.json",
    ),
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(
      /\/+$/,
      "",
    ),
    token: env.GH_TOKEN || env.GITHUB_TOKEN || "",
    discoveryOrgs: (env.DISCOVERY_ORGS || "MicrosoftLearning")
      .split(",")
      .map((org) => org.trim())
      .filter(Boolean),
    readmeLines: num("README_LINES", 60),
    requestDelayMs: num("REQUEST_DELAY_MS", 300),
    fetchAttempts: Math.max(1, num("FETCH_ATTEMPTS", 3)),
    retryBaseMs: num("RETRY_BASE_MS", 2000),
    maxRetryAfterMs: num("MAX_RETRY_AFTER_MS", 60_000),
    fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 30_000),
    // From the first request on: the job's own timeout is 15 minutes.
    runDeadlineMs: num("RUN_DEADLINE_MS", 10 * 60_000),
    maxProblems: num("MAX_PROBLEMS", 20),
    maxNewRepos: num("MAX_NEW_REPOS", 20),
    maxUnknownPct: num("MAX_UNKNOWN_PCT", 25),
    minReferences: num("MIN_REFERENCES", 10),
    minOrgRepos: num("MIN_ORG_REPOS", 100),
    reminderDays: num("REMINDER_DAYS", 7),
    forceBaseline: env.FORCE_BASELINE === "1",
    reportAll: env.REPORT_ALL === "1",
    reportFile: env.REPORT_FILE ?? join(tmpdir(), "lab-repos-report.md"),
    errorFile: env.ERROR_FILE ?? join(tmpdir(), "lab-repos-error.md"),
    githubOutput: env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output"),
    summaryFile: env.GITHUB_STEP_SUMMARY ?? "",
    createIssues: env.CREATE_ISSUES === "1",
    dryRun: env.DRY_RUN === "1",
    ghCliScript: env.GH_CLI_SCRIPT || "",
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    today,
    fetch: overrides.fetch ?? globalThis.fetch,
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** A failure of the check itself (not a finding about a repository). */
export class CheckError extends Error {}
/** The API rate limit is exhausted and does not reset soon enough. */
export class RateLimitError extends CheckError {}

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
// Text helpers (everything from a page or an API response is untrusted)
// ---------------------------------------------------------------------------

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Text taken from the API or a README, for a table cell of a public issue. */
export function safeText(text) {
  return String(text ?? "")
    .replace(/[<>`[\]|]/g, " ")
    .replace(/@(?=\w)/g, "@" + ZERO_WIDTH_SPACE)
    .replace(/#(?=\d)/g, "#" + ZERO_WIDTH_SPACE)
    .replace(/\s+/g, " ")
    .trim();
}

const code = (text) =>
  `\`${String(text)
    .replace(/[`\r\n|]+/g, " ")
    .trim()}\``;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** A repository as a link; anything that is not a plain owner/name is shown as inert text. */
export function repoLink(fullName) {
  return FULL_NAME.test(fullName)
    ? `[${fullName}](https://github.com/${fullName})`
    : code(safeText(fullName));
}

// ---------------------------------------------------------------------------
// Extraction of repository references from the content pages
// ---------------------------------------------------------------------------

/** github.com first path segments that are site pages, not owners. */
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "community",
  "contact",
  "copilot",
  "customer-stories",
  "education",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "models",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "premium-support",
  "pricing",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "settings",
  "signup",
  "site",
  "solutions",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
  "users",
  "watching",
  "why-github",
]);

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * { owner, repo, via } for a URL that points into a GitHub repository, else
 * null. `via` is "repo" (github.com), "pages" (<owner>.github.io/<repo>) or
 * "raw" (raw.githubusercontent.com). An account's user site
 * (<owner>.github.io with no path) maps to <owner>/<owner>.github.io.
 */
export function parseRepoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segs = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });

  let owner;
  let repo;
  let via;
  if (host === "github.com" || host === "www.github.com") {
    if (segs.length < 2) return null; // an organisation or account page
    [owner, repo] = segs;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    repo = repo.replace(/\.git$/i, "");
    via = "repo";
  } else if (host.endsWith(".github.io") && host !== "github.io") {
    owner = host.slice(0, -".github.io".length);
    if (owner.includes(".")) return null;
    repo = segs.length > 0 ? segs[0] : `${owner}.github.io`;
    via = "pages";
  } else if (host === "raw.githubusercontent.com") {
    if (segs.length < 2) return null;
    [owner, repo] = segs;
    via = "raw";
  } else {
    return null;
  }
  if (!OWNER_NAME.test(owner) || !REPO_NAME.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  return { owner, repo, via };
}

/** Comments replaced by their newlines, so line numbers stay true. */
export function stripComments(source) {
  const blank = (match) => match.replace(/[^\r\n]+/g, " ");
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

const URL_PATTERN = /https?:\/\/[^\s"'<>`)\]}\\]+/gi;

/** Every http(s) URL in a text with its 1-based line, trailing punctuation removed. */
export function extractUrls(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(URL_PATTERN)) {
      out.push({ url: match[0].replace(/[.,;:!?*_]+$/, ""), line: i + 1 });
    }
  }
  return out;
}

/** Pages (.md/.mdx, not starting with "_") under a folder, sorted. */
export function listContentFiles(dir) {
  const out = [];
  (function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.mdx?$/.test(entry.name) && !entry.name.startsWith("_")) {
        out.push(path);
      }
    }
  })(dir);
  return out;
}

/**
 * Every repository the content pages reference:
 * Map<lowercase owner/repo, { key, owner, repo, display, exactCase, ownerClass,
 * vias:Set, locations:[{ file, line, url }] }>. `display` keeps the casing of a
 * github.com link when there is one (the GitHub API ignores case anyway).
 */
export function extractReferences(docsDir) {
  const refs = new Map();
  const files = listContentFiles(docsDir);
  for (const file of files) {
    const rel = `${DISPLAY_DOCS_DIR}/${relative(docsDir, file).split(sep).join("/")}`;
    const text = stripComments(readFileSync(file, "utf8").replace(/^﻿/, ""));
    for (const { url, line } of extractUrls(text)) {
      const parsed = parseRepoUrl(url);
      if (!parsed) continue;
      const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      let ref = refs.get(key);
      if (!ref) {
        ref = {
          key,
          owner: parsed.owner,
          repo: parsed.repo,
          display: `${parsed.owner}/${parsed.repo}`,
          // a github.io host is always lowercase: the owner's real casing is only known from a github.com link
          exactCase: parsed.via !== "pages",
          ownerClass: ownerClass(parsed.owner),
          vias: new Set(),
          locations: [],
        };
        refs.set(key, ref);
      } else if (!ref.exactCase && parsed.via !== "pages") {
        ref.owner = parsed.owner;
        ref.repo = parsed.repo;
        ref.display = `${parsed.owner}/${parsed.repo}`;
        ref.exactCase = true;
      }
      ref.vias.add(parsed.via);
      ref.locations.push({ file: rel, line, url });
    }
  }
  return { refs, fileCount: files.length };
}

/** The owners found, with their class and number of distinct repositories. */
export function summarizeOwners(refs) {
  const owners = new Map();
  for (const ref of refs.values()) {
    const lower = ref.owner.toLowerCase();
    const entry = owners.get(lower) ?? {
      owner: ref.owner,
      ownerClass: ref.ownerClass,
      repos: 0,
      links: 0,
    };
    entry.repos += 1;
    entry.links += ref.locations.length;
    owners.set(lower, entry);
  }
  return [...owners.values()].sort(
    (a, b) => b.repos - a.repos || a.owner.localeCompare(b.owner),
  );
}

// ---------------------------------------------------------------------------
// The hub's exams
// ---------------------------------------------------------------------------

/** Map<CODE, { code, area, examPath, labPath|null }> from <area>/<CODE>.mdx. */
export function loadHubExams(docsDir) {
  const exams = new Map();
  for (const area of EXAM_AREAS) {
    let names = [];
    try {
      names = readdirSync(join(docsDir, area));
    } catch {
      continue; // an area folder that does not exist has no exam pages
    }
    for (const name of names) {
      const match = /^([A-Za-z]{2}-\d{3})\.mdx?$/.exec(name);
      if (!match) continue;
      const examCode = match[1].toUpperCase();
      const labName = `${examCode.toLowerCase()}.mdx`;
      exams.set(examCode, {
        code: examCode,
        area,
        examPath: `${DISPLAY_DOCS_DIR}/${area}/${name}`,
        labPath: existsSync(join(docsDir, "labs", area, labName))
          ? `${DISPLAY_DOCS_DIR}/labs/${area}/${labName}`
          : null,
      });
    }
  }
  return exams;
}

const EXAM_LINK =
  /credentials\/certifications\/exams\/([a-z]{2}-\d{3})(?!\d)/gi;

/**
 * Exam codes the hub names without having an exam page for them (yet), so that
 * the labs of an announced successor are not invisible: PL-400 links
 * ".../exams/ab-400" and is about to become AB-400, and a retiring exam's
 * `replacementCode` in retiring-exams.json is the exam its learners move to.
 * Map<CODE, { code, area: null, examPath: null, labPath: null, namedOn }>;
 * `namedOn` is the first place that names it (file:line, or the tracker).
 * A missing or unreadable retiring-exams.json only drops that source.
 */
export function loadRelatedExams(docsDir, hubExams, retiringFile = "") {
  const related = new Map();
  const add = (examCode, namedOn) => {
    if (hubExams.has(examCode) || related.has(examCode)) return;
    related.set(examCode, {
      code: examCode,
      area: null,
      examPath: null,
      labPath: null,
      namedOn,
    });
  };
  for (const file of listContentFiles(docsDir)) {
    const rel = `${DISPLAY_DOCS_DIR}/${relative(docsDir, file).split(sep).join("/")}`;
    const text = stripComments(readFileSync(file, "utf8").replace(/^﻿/, ""));
    text.split(/\r?\n/).forEach((lineText, index) => {
      for (const match of lineText.matchAll(EXAM_LINK)) {
        add(match[1].toUpperCase(), `${rel}:${index + 1}`);
      }
    });
  }
  if (retiringFile && existsSync(retiringFile)) {
    try {
      const parsed = JSON.parse(readFileSync(retiringFile, "utf8"));
      for (const exam of Array.isArray(parsed?.exams) ? parsed.exams : []) {
        const replacement = String(exam?.replacementCode ?? "").toUpperCase();
        if (/^[A-Z]{2}-\d{3}$/.test(replacement)) {
          add(
            replacement,
            `src/data_files/retiring-exams.json (replaces ${String(exam.code ?? "?").slice(0, 10)})`,
          );
        }
      }
    } catch {
      /* the retiring-exam monitor reports a corrupt tracker; this check goes on without it */
    }
  }
  return related;
}

/** A repository name contains a code: AB-650, AB650, AB-650T00_...; never AB-6500. */
export function codePattern(examCode) {
  const [prefix, digits] = examCode.split("-");
  return new RegExp(`(?<![a-z0-9])${prefix}-?${digits}(?!\\d)`, "i");
}

/** Localised copies (name.ja-jp) and broken import copies (https-github.com-...). */
export function isLocalised(name) {
  return /^https?-/i.test(name) || /\.[a-z]{2,3}-[a-z0-9]{2,4}$/i.test(name);
}

// ---------------------------------------------------------------------------
// GitHub API client
// ---------------------------------------------------------------------------

/**
 * A client that makes one request at a time, REQUEST_DELAY_MS apart, retries
 * 5xx and network errors with backoff, waits out a short rate limit and throws
 * RateLimitError / CheckError when it cannot go on. get() resolves to
 * { status, headers, json, text }; status 0 means the request never got an
 * answer (the caller treats it as "unknown", never as evidence).
 */
export function makeClient(cfg) {
  const baseOrigin = new URL(cfg.apiUrl).origin;
  let lastRequest = 0;
  let limit = null;
  const stats = { requests: 0, retries: 0 };
  // A hanging API must not run the job into its timeout without a word: past
  // the deadline no request is made, every call answers status 0 ("no answer",
  // never evidence) and the caller's own "too many lookups failed" check ends
  // the run with a failure issue.
  const deadlineAt =
    cfg.runDeadlineMs > 0 ? Date.now() + cfg.runDeadlineMs : Infinity;
  const expired = () => Date.now() >= deadlineAt;
  const noAnswer = (error) => ({
    status: 0,
    headers: new Headers(),
    json: null,
    text: "",
    error,
  });
  const deadlineError = `the run deadline (RUN_DEADLINE_MS=${cfg.runDeadlineMs}) was reached`;

  async function pace() {
    const wait = lastRequest + cfg.requestDelayMs - Date.now();
    if (wait > 0) await cfg.sleep(wait);
    lastRequest = Date.now();
  }

  async function get(path, { raw = false } = {}) {
    const url = /^https?:\/\//i.test(path) ? path : cfg.apiUrl + path;
    if (new URL(url).origin !== baseOrigin) {
      throw new CheckError(
        `Refusing to send the GitHub token to ${new URL(url).origin}, which is not the API ${baseOrigin}.`,
      );
    }
    let lastError = "";
    for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
      if (expired()) return noAnswer(deadlineError);
      if (limit && limit.remaining === 0 && limit.reset * 1000 > Date.now()) {
        const wait = limit.reset * 1000 - Date.now() + 1000;
        if (wait > cfg.maxRetryAfterMs) {
          throw new RateLimitError(
            `The GitHub API rate limit is used up and resets in ${Math.round(wait / 1000)} s, more than the ${Math.round(cfg.maxRetryAfterMs / 1000)} s this run waits.`,
          );
        }
        await cfg.sleep(wait);
      }
      await pace();
      let res;
      let text;
      try {
        res = await cfg.fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: raw
              ? "application/vnd.github.raw+json"
              : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${cfg.token}`,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
        });
        text = await res.text();
      } catch (error) {
        lastError = error?.message ?? String(error);
        if (attempt < cfg.fetchAttempts) {
          stats.retries += 1;
          await cfg.sleep(cfg.retryBaseMs * 2 ** (attempt - 1));
        }
        continue;
      }
      stats.requests += 1;

      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (remaining !== null && Number.isFinite(reset)) {
        limit = { remaining: Number(remaining), reset };
      }

      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        if (attempt < cfg.fetchAttempts) {
          stats.retries += 1;
          await cfg.sleep(cfg.retryBaseMs * 2 ** (attempt - 1));
        }
        continue;
      }

      let json = null;
      if (!raw || res.status !== 200) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (res.status === 401) {
        throw new CheckError(
          "GitHub rejected the token (HTTP 401): GH_TOKEN/GITHUB_TOKEN is invalid or expired.",
        );
      }
      if (res.status === 403 || res.status === 429) {
        if (json?.block) {
          // "Repository access blocked": a legal or policy block, the page is gone for visitors too
          return { status: 451, headers: res.headers, json, text };
        }
        const retryAfter = res.headers.get("retry-after");
        const limited =
          retryAfter !== null ||
          remaining === "0" ||
          res.status === 429 ||
          /rate limit|abuse/i.test(String(json?.message ?? ""));
        if (limited) {
          const wait =
            retryAfter !== null && Number.isFinite(Number(retryAfter))
              ? Number(retryAfter) * 1000
              : Number.isFinite(reset) && reset * 1000 > Date.now()
                ? reset * 1000 - Date.now() + 1000
                : 60_000;
          if (wait <= cfg.maxRetryAfterMs && attempt < cfg.fetchAttempts) {
            stats.retries += 1;
            limit = null;
            await cfg.sleep(wait);
            continue;
          }
          throw new RateLimitError(
            `The GitHub API rate limit was hit (HTTP ${res.status}); waiting ${Math.round(wait / 1000)} s is beyond what this run waits. Try again later.`,
          );
        }
      }
      return { status: res.status, headers: res.headers, json, text };
    }
    return {
      status: 0,
      headers: new Headers(),
      json: null,
      text: "",
      error: lastError,
    };
  }

  /**
   * A plain GET of a public GitHub Pages address (https://<owner>.github.io/...),
   * without the token, paced and retried like get(). Resolves to { status } with
   * status 0 for "no answer" (never evidence). The body is not read.
   */
  async function getPage(url) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      !/\.github\.io$/i.test(target.hostname)
    ) {
      throw new CheckError(
        `Refusing to request ${target.origin}: only https://<owner>.github.io pages are asked for.`,
      );
    }
    let lastError = "";
    for (let attempt = 1; attempt <= cfg.fetchAttempts; attempt++) {
      if (expired()) return noAnswer(deadlineError);
      await pace();
      let res;
      try {
        res = await cfg.fetch(target.href, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
          redirect: "follow",
          signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
        });
        // The body is not needed; do not wait for the stream to close.
        res.body?.cancel().catch(() => {});
      } catch (error) {
        lastError = error?.message ?? String(error);
        if (attempt < cfg.fetchAttempts) {
          stats.retries += 1;
          await cfg.sleep(cfg.retryBaseMs * 2 ** (attempt - 1));
        }
        continue;
      }
      stats.requests += 1;
      if (res.status >= 500 || res.status === 429) {
        lastError = `HTTP ${res.status}`;
        if (attempt < cfg.fetchAttempts) {
          stats.retries += 1;
          await cfg.sleep(cfg.retryBaseMs * 2 ** (attempt - 1));
        }
        continue;
      }
      return { status: res.status, headers: res.headers, json: null, text: "" };
    }
    return noAnswer(lastError);
  }

  return { get, getPage, stats, expired };
}

/** The URL of rel="next" in a Link header, or null. */
export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// README hints and suggested successors
// ---------------------------------------------------------------------------

const HINT_PATTERNS = [
  /\b(?:is|are|was|has\s+been|have\s+been|will\s+be|being|to\s+be|be)\s+(?:\*\*|__)?(?:archived|deprecated|retired|decommissioned|sunset)\b/i,
  // scoped to the repository or course itself: AZ-140 says two legacy *tracks* are
  // no longer maintained, which is not a notice about the repository
  /\b(?:this|the)\s+(?:repo|repository|course|labs?|project|content|material)s?\b[^.\n]{0,60}\bno\s+longer\s+(?:maintained|supported|updated|available)\b/i,
  /\b(?:new|updated|replacement)\s+(?:lab\s+)?(?:repo|repository)\b/i,
  /\b(?:has|have|was|were|been)\s+(?:moved|migrated|transferred)\b/i,
  /\b(?:moved|migrated|transferred)\s+to\b/i,
  /\b(?:replaced|superseded)\s+by\b/i,
  /\bplease\s+(?:use|visit|see|refer\s+to|switch\s+to)\s+(?:the\s+)?(?:new|updated|latest|current)\b/i,
];

const MAX_SUCCESSORS = 3;

/**
 * The first line of a README's head that announces a replacement, with the
 * GitHub repositories linked around it as SUGGESTED successors (never the
 * repository itself). null when no line does.
 */
export function findReadmeHint(readme, selfKey, lineLimit = 60) {
  const lines = String(readme)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .slice(0, lineLimit);
  for (let i = 0; i < lines.length; i++) {
    if (!HINT_PATTERNS.some((pattern) => pattern.test(lines[i]))) continue;
    const successors = [];
    const window = lines.slice(Math.max(0, i - 1), i + 4).join("\n");
    for (const { url } of extractUrls(window)) {
      const parsed = parseRepoUrl(url);
      if (!parsed || parsed.via === "raw") continue;
      const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      if (key === selfKey || successors.some((s) => s.key === key)) continue;
      successors.push({
        key,
        owner: parsed.owner,
        repo: parsed.repo,
        display: `${parsed.owner}/${parsed.repo}`,
      });
      if (successors.length === MAX_SUCCESSORS) break;
    }
    return {
      line: i + 1,
      text: clip(
        safeText(lines[i].replace(/^[\s>*_#-]+/, "").replace(/\*\*|__/g, "")),
        220,
      ),
      successors,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checking a linked repository
// ---------------------------------------------------------------------------

const dateOf = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : undefined;

/** Whether a README-suggested successor exists and is current: ok | archived | missing | unknown. */
async function checkSuccessor(client, successor) {
  const res = await client.get(`/repos/${successor.owner}/${successor.repo}`);
  if (res.status === 404) return { repo: successor.display, state: "missing" };
  if (res.status !== 200 || typeof res.json?.full_name !== "string") {
    return { repo: successor.display, state: "unknown" };
  }
  return {
    repo: res.json.full_name,
    state: res.json.archived === true ? "archived" : "ok",
  };
}

/**
 * Looks one referenced repository up. Resolves to
 *   { key, status: "checked", findings, info }  or
 *   { key, status: "unknown", reason }          (never evidence of anything)
 * A finding is { key, repo, kind, thirdParty, detail }.
 */
export async function checkRepo(client, ref, cfg) {
  const thirdParty = ref.ownerClass === "third-party";
  const finding = (kind, repo, detail = {}) => ({
    key: ref.key,
    repo,
    kind,
    thirdParty,
    persist: true,
    detail,
  });
  const unknown = (reason) => ({ key: ref.key, status: "unknown", reason });

  let res = await client.get(`/repos/${ref.owner}/${ref.repo}`);

  if (res.status === 404) {
    // <owner>.github.io/<path> may be a page of the account's user site, not a project page
    const userSite = `${ref.owner}.github.io`;
    if (
      ref.vias.size === 1 &&
      ref.vias.has("pages") &&
      ref.repo.toLowerCase() !== userSite.toLowerCase()
    ) {
      const alt = await client.get(`/repos/${ref.owner}/${userSite}`);
      if (alt.status === 200) {
        // The user site repository exists (microsoft/microsoft.github.io does),
        // which proves nothing about this path: only the page itself says
        // whether it is part of that site. PartnerResources was a project that
        // is gone, and its address answers 404.
        const address = `https://${userSite.toLowerCase()}/${encodeURIComponent(ref.repo)}/`;
        const page = await client.getPage(address);
        if (page.status === 404 || page.status === 410) {
          return {
            key: ref.key,
            status: "checked",
            findings: [finding("gone", ref.display, { code: 404, page: true })],
            info: {},
          };
        }
        if (page.status >= 200 && page.status < 400) {
          return { key: ref.key, status: "checked", findings: [], info: {} };
        }
        return unknown(
          `the page ${address} answered ${page.status ? `HTTP ${page.status}` : page.error || "nothing"}`,
        );
      }
      if (alt.status !== 404) {
        return unknown(`HTTP ${alt.status || alt.error || "no answer"}`);
      }
    }
    return {
      key: ref.key,
      status: "checked",
      findings: [finding("gone", ref.display, { code: 404 })],
      info: {},
    };
  }
  if (res.status === 451) {
    return {
      key: ref.key,
      status: "checked",
      findings: [finding("gone", ref.display, { code: 451 })],
      info: {},
    };
  }
  if (
    res.status !== 200 ||
    typeof res.json?.full_name !== "string" ||
    !FULL_NAME.test(res.json.full_name)
  ) {
    return unknown(
      res.status === 0
        ? `no answer (${res.error || "network error"})`
        : `HTTP ${res.status}`,
    );
  }

  const body = res.json;
  const fullName = body.full_name;
  const findings = [];
  const info = {
    fullName,
    archived: body.archived === true,
    hasPages: body.has_pages,
    pushedAt: dateOf(body.pushed_at),
  };

  if (body.archived === true) {
    findings.push(finding("archived", fullName, { pushedAt: info.pushedAt }));
  }
  if (!thirdParty) {
    if (body.disabled === true) findings.push(finding("disabled", fullName));
    if (fullName.toLowerCase() !== ref.key) {
      findings.push(finding("renamed", fullName, { renamedTo: fullName }));
    }
    if (ref.vias.has("pages") && body.has_pages === false) {
      findings.push(finding("no-pages", fullName));
    }

    // README head: a replacement notice, with suggested successors
    const readme = await client.get(`/repos/${fullName}/readme`, { raw: true });
    if (readme.status === 200) {
      const hint = findReadmeHint(
        readme.text,
        fullName.toLowerCase(),
        cfg.readmeLines,
      );
      if (hint) {
        const successors = [];
        for (const successor of hint.successors) {
          successors.push(await checkSuccessor(client, successor));
        }
        const detail = { hint: hint.text, successors };
        const archived = findings.find((f) => f.kind === "archived");
        if (archived) {
          archived.detail = { ...archived.detail, ...detail };
        } else {
          findings.push(finding("notice", fullName, detail));
        }
      }
    }
  }
  return { key: ref.key, status: "checked", findings, info };
}

// ---------------------------------------------------------------------------
// The ignore list (repositories the maintainer decided to keep)
// ---------------------------------------------------------------------------

/**
 * src/data_files/lab-repos-ignore.json:
 *   { "ignored": [ { "repo": "owner/name", "problems": ["archived"], "reason": "why" } ] }
 * `problems` is required so a repository that later gets a worse problem
 * (gone) is reported again. A missing file is an empty list.
 */
export function loadIgnore(file) {
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CheckError(
      `src/data_files/lab-repos-ignore.json is not valid JSON (${error.message}).`,
    );
  }
  const bad = (why) =>
    new CheckError(`src/data_files/lab-repos-ignore.json: ${why}.`);
  if (!parsed || !Array.isArray(parsed.ignored)) {
    throw bad('expected an object with an "ignored" list');
  }
  const entries = new Map();
  parsed.ignored.forEach((entry, index) => {
    const where = `ignored[${index}]`;
    if (!entry || typeof entry !== "object")
      throw bad(`${where} is not an object`);
    if (typeof entry.repo !== "string" || !FULL_NAME.test(entry.repo)) {
      throw bad(`${where}.repo must be "owner/name"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw bad(`${where} (${entry.repo}) needs a non-empty "reason"`);
    }
    if (
      !Array.isArray(entry.problems) ||
      entry.problems.length === 0 ||
      entry.problems.some((kind) => !KINDS.includes(kind))
    ) {
      throw bad(
        `${where} (${entry.repo}).problems must be a non-empty list of: ${KINDS.join(", ")}`,
      );
    }
    const key = entry.repo.toLowerCase();
    const merged = entries.get(key) ?? {
      key,
      repo: entry.repo,
      problems: new Set(),
      reasons: [],
    };
    for (const kind of entry.problems) merged.problems.add(kind);
    merged.reasons.push(entry.reason.trim());
    entries.set(key, merged);
  });
  return [...entries.values()];
}

/** Findings that the ignore list does not cover, and the (repo, kind) pairs it never matched. */
export function applyIgnore(findings, ignore) {
  const used = new Set();
  const kept = [];
  let ignored = 0;
  const byKey = new Map(ignore.map((entry) => [entry.key, entry]));
  for (const f of findings) {
    const entry = byKey.get(f.key);
    if (entry?.problems.has(f.kind)) {
      used.add(`${f.key}|${f.kind}`);
      ignored += 1;
    } else {
      kept.push(f);
    }
  }
  const unused = [];
  for (const entry of ignore) {
    for (const kind of entry.problems) {
      if (!used.has(`${entry.key}|${kind}`)) {
        unused.push({ repo: entry.repo, kind });
      }
    }
  }
  return { kept, ignored, unused };
}

// ---------------------------------------------------------------------------
// Organisation listing and new-repository discovery
// ---------------------------------------------------------------------------

/** Every public repository of an organisation (deduplicated by full name). */
export async function listOrgRepos(client, org) {
  const MAX_PAGES = 40;
  const byName = new Map();
  let path = `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=created&direction=desc&type=public`;
  for (let page = 0; path; page++) {
    if (page >= MAX_PAGES) {
      throw new CheckError(
        `The listing of ${org} has more than ${MAX_PAGES} pages of repositories; the API probably changed.`,
      );
    }
    const res = await client.get(path);
    if (res.status === 404) {
      throw new CheckError(
        `The organisation ${org} was not found (HTTP 404): it may have been renamed. Set DISCOVERY_ORGS.`,
      );
    }
    if (res.status !== 200 || !Array.isArray(res.json)) {
      throw new CheckError(
        `The listing of ${org} failed (${res.status === 0 ? res.error || "no answer" : `HTTP ${res.status}`}).`,
      );
    }
    for (const item of res.json) {
      if (
        !item ||
        typeof item.name !== "string" ||
        typeof item.full_name !== "string"
      ) {
        throw new CheckError(
          `The listing of ${org} returned an item without name and full_name; the API probably changed.`,
        );
      }
      byName.set(item.full_name.toLowerCase(), item);
    }
    path = nextLink(res.headers.get("link"));
  }
  return [...byName.values()];
}

/**
 * Repositories whose name contains a hub exam code, localised copies left out.
 * Archived and disabled ones are kept (the caller decides) so the baseline
 * covers them too.
 */
export function findCandidates(orgRepos, hubExams) {
  const patterns = [...hubExams.keys()]
    .sort()
    .map((examCode) => [examCode, codePattern(examCode)]);
  const out = [];
  for (const item of orgRepos) {
    if (item.private === true || isLocalised(item.name)) continue;
    const codes = patterns
      .filter(([, pattern]) => pattern.test(item.name))
      .map(([examCode]) => examCode);
    if (codes.length === 0 || !FULL_NAME.test(item.full_name)) continue;
    out.push({
      fullName: item.full_name,
      key: item.full_name.toLowerCase(),
      codes,
      archived: item.archived === true,
      disabled: item.disabled === true,
      createdAt: dateOf(item.created_at),
      pushedAt: dateOf(item.pushed_at),
      hasPages: item.has_pages === true,
      fork: item.fork === true,
      description: clip(safeText(item.description ?? ""), 100),
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function emptyTracker() {
  return {
    lastSynced: null,
    baselineAt: null,
    baseline: null,
    problems: {},
    reported: { lastReported: null, items: [] },
  };
}

const SUCCESSOR_STATES = new Set(["ok", "archived", "missing", "unknown"]);

function normalizeDetail(detail, bad, where) {
  if (detail === undefined || detail === null) return {};
  if (typeof detail !== "object" || Array.isArray(detail)) {
    throw bad(`${where}.detail is not an object`);
  }
  const out = {};
  for (const field of ["pushedAt", "renamedTo", "hint"]) {
    if (detail[field] === undefined) continue;
    if (typeof detail[field] !== "string") {
      throw bad(`${where}.detail.${field} is not text`);
    }
    out[field] = detail[field];
  }
  if (detail.code !== undefined) {
    if (!Number.isInteger(detail.code)) {
      throw bad(`${where}.detail.code is not a number`);
    }
    out.code = detail.code;
  }
  if (detail.page !== undefined) {
    if (typeof detail.page !== "boolean") {
      throw bad(`${where}.detail.page is not true or false`);
    }
    if (detail.page) out.page = true;
  }
  if (detail.successors !== undefined) {
    if (
      !Array.isArray(detail.successors) ||
      detail.successors.some(
        (s) =>
          !s || typeof s.repo !== "string" || !SUCCESSOR_STATES.has(s.state),
      )
    ) {
      throw bad(`${where}.detail.successors is malformed`);
    }
    out.successors = detail.successors.map((s) => ({
      repo: s.repo,
      state: s.state,
    }));
  }
  return out;
}

/** Validates a parsed tracker; throws CheckError on anything unexpected. */
export function normalizeTracker(parsed) {
  const bad = (why) =>
    new CheckError(`Corrupt tracker src/data_files/lab-repos.json (${why}).`);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bad("not an object");
  }
  const date = (value, label) => {
    if (value === null || value === undefined) return null;
    if (!isRealIsoDate(value)) throw bad(`${label} is not a YYYY-MM-DD date`);
    return value;
  };

  let baseline = null;
  if (parsed.baseline !== null && parsed.baseline !== undefined) {
    if (
      !Array.isArray(parsed.baseline) ||
      parsed.baseline.some((name) => typeof name !== "string")
    ) {
      throw bad('"baseline" is not a list of repository names');
    }
    baseline = [...new Set(parsed.baseline)].sort(byText);
  }

  if (
    !parsed.problems ||
    typeof parsed.problems !== "object" ||
    Array.isArray(parsed.problems)
  ) {
    throw bad('missing "problems" object');
  }
  const problems = {};
  for (const [id, entry] of Object.entries(parsed.problems)) {
    if (!entry || typeof entry !== "object")
      throw bad(`${id} is not an object`);
    if (
      typeof entry.key !== "string" ||
      typeof entry.repo !== "string" ||
      !LINKED_KINDS.includes(entry.kind) ||
      id !== `${entry.key}|${entry.kind}`
    ) {
      throw bad(`${id} is not a problem of a linked repository`);
    }
    const firstSeen = date(entry.firstSeen, `${id}.firstSeen`);
    if (!firstSeen) throw bad(`${id} has no firstSeen date`);
    problems[id] = {
      key: entry.key,
      repo: entry.repo,
      kind: entry.kind,
      firstSeen,
      detail: normalizeDetail(entry.detail, bad, id),
    };
  }

  const reportedIn = parsed.reported ?? { lastReported: null, items: [] };
  if (
    typeof reportedIn !== "object" ||
    !Array.isArray(reportedIn.items) ||
    reportedIn.items.some((item) => typeof item !== "string")
  ) {
    throw bad('"reported" is malformed');
  }
  return {
    lastSynced: date(parsed.lastSynced, "lastSynced"),
    baselineAt: date(parsed.baselineAt, "baselineAt"),
    baseline,
    problems: Object.fromEntries(
      Object.entries(problems).sort(([a], [b]) => byText(a, b)),
    ),
    reported: {
      lastReported: date(reportedIn.lastReported, "reported.lastReported"),
      items: [...new Set(reportedIn.items)].sort(byText),
    },
  };
}

export function loadTracker(file) {
  if (!existsSync(file)) return emptyTracker();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CheckError(
      "Corrupt tracker src/data_files/lab-repos.json (invalid JSON).",
    );
  }
  return normalizeTracker(parsed);
}

export function trackerContent(tracker) {
  return JSON.stringify(tracker, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const kindRank = (kind) => KINDS.indexOf(kind);
const itemOf = (finding) => `${finding.key}|${finding.kind}`;

/** The new-repo finding for an unlinked hub-code repository. */
export function newRepoFinding(candidate, persist = true) {
  return {
    key: candidate.key,
    repo: candidate.fullName,
    kind: "new-repo",
    thirdParty: false,
    persist,
    candidate,
    detail: {},
  };
}

/** Linked-repository findings from a tracker entry (a lookup failed: carry them forward). */
export function carryForward(tracker, key) {
  return Object.values(tracker.problems)
    .filter((entry) => entry.key === key)
    .map((entry) => ({
      key: entry.key,
      repo: entry.repo,
      kind: entry.kind,
      thirdParty: false,
      persist: true,
      detail: entry.detail,
      carried: true,
    }));
}

/**
 * What changed against the last report: which items are new and which are gone.
 */
export function diffItems(previous, current) {
  const before = new Set(previous);
  const now = new Set(current);
  return {
    added: current.filter((item) => !before.has(item)),
    resolved: previous.filter((item) => !now.has(item)),
  };
}

/**
 * What the issue does this run:
 *   "close"    nothing is left: close the open issue(s)
 *   "create"   findings, no issue open, and the set changed / a reminder is due / forced
 *   "comment"  findings, an issue open, and the set changed / forced
 *   "none"     nothing to say
 */
export function decideIssueAction({
  active,
  changed,
  reminderDue,
  forced,
  openCount,
}) {
  if (!active) return openCount > 0 ? "close" : "none";
  if (openCount > 0) return changed || forced ? "comment" : "none";
  return changed || reminderDue || forced ? "create" : "none";
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const KIND_TITLE = {
  gone: "does not exist",
  archived: "archived",
  disabled: "disabled",
  renamed: "renamed",
  "no-pages": "GitHub Pages is off",
  notice: "README announces a replacement",
  "new-repo": "new, not linked",
};

const MAX_ROWS = 60;
const MAX_REPORT_CHARS = 60_000;

/** Locations grouped by file: [{ file, firstLine, count }]. */
export function groupLocations(locations) {
  const byFile = new Map();
  for (const loc of locations) {
    const entry = byFile.get(loc.file) ?? {
      file: loc.file,
      firstLine: loc.line,
      count: 0,
    };
    entry.count += 1;
    entry.firstLine = Math.min(entry.firstLine, loc.line);
    byFile.set(loc.file, entry);
  }
  return [...byFile.values()].sort((a, b) => byText(a.file, b.file));
}

function linkedFrom(ref) {
  if (!ref) return "?";
  const groups = groupLocations(ref.locations);
  const shown = groups
    .slice(0, 4)
    .map(
      (g) =>
        `${code(`${g.file}:${g.firstLine}`)}${g.count > 1 ? ` (${g.count} links)` : ""}`,
    );
  if (groups.length > shown.length) {
    shown.push(`+${groups.length - shown.length} more pages`);
  }
  return shown.join("<br>");
}

function problemCell(f) {
  const d = f.detail ?? {};
  const first = f.firstSeen ? `<br>first detected ${f.firstSeen}` : "";
  const party = f.thirdParty ? "<br>third-party owner" : "";
  switch (f.kind) {
    case "gone":
      return (
        (d.page
          ? `**${KIND_TITLE.gone}**: the repository does not exist and its GitHub Pages address returns HTTP 404 (it is not a page of the account's user site either); it was deleted, made private or moved`
          : `**${KIND_TITLE.gone}** (HTTP ${d.code === 451 ? "451, blocked" : "404"}); it was deleted, made private or moved`) +
        party +
        first
      );
    case "archived":
      return (
        `**archived**, read-only${d.pushedAt ? `, last push ${d.pushedAt}` : ""}; its GitHub Pages site may still answer HTTP 200` +
        (d.hint ? `<br>README: ${code(safeText(d.hint))}` : "") +
        party +
        first
      );
    case "disabled":
      return `**disabled** by GitHub${first}`;
    case "renamed":
      return `**renamed** to ${d.renamedTo ? repoLink(d.renamedTo) : "another name"}; the old github.com and github.io addresses stop working${first}`;
    case "no-pages":
      return `**GitHub Pages is not enabled**, so every <code>github.io</code> link into it returns 404${first}`;
    case "notice":
      return `**README announces a retirement or replacement**, but the repository is not archived yet<br>README: ${code(safeText(d.hint ?? ""))}${first}`;
    default:
      return KIND_TITLE[f.kind] ?? f.kind;
  }
}

const SUCCESSOR_STATE_TEXT = {
  ok: "exists, not archived",
  archived: "exists but is archived too",
  missing: "does not exist",
  unknown: "could not be checked",
};

function successorCell(f, refs) {
  const successors = f.detail?.successors ?? [];
  if (f.thirdParty) return "not looked for (third-party owner)";
  if (successors.length === 0) return "none named in the README";
  const lines = successors.map((s) => {
    const linked = refs.get(String(s.repo).toLowerCase());
    const alsoLinked = linked
      ? `; already linked from ${groupLocations(linked.locations)
          .slice(0, 2)
          .map((g) => code(g.file))
          .join(", ")}`
      : "";
    return `${repoLink(s.repo)} (${SUCCESSOR_STATE_TEXT[s.state]}${alsoLinked})`;
  });
  return `${lines.join("<br>")}<br>suggested from the README, not verified: open it and confirm it covers the same labs`;
}

const TODO_TEXT = {
  gone: "Open the link in a browser. If the repository moved, use the new address; otherwise remove the card. Never invent a URL.",
  archived:
    "Use the successor once you have opened it (an archived repo is not updated); if the page already links it, delete the dead duplicate.",
  disabled: "Remove the card or use the replacement repository.",
  renamed:
    "Replace the old name in every link listed (github.com and the github.io page change together).",
  "no-pages":
    "Link the repository itself or its successor instead of the github.io pages; do not keep dead cards.",
  notice:
    "Open the README. If the labs moved or the course retires, switch to the successor before the repository is archived or removed; a retiring exam's page may keep its resources (AGENTS.md).",
};

/**
 * The issue body.
 * @param ctx { cfg, today, stats, linkedFindings, newFindings, refs, hubExams,
 *             ownerSummary, ignoredCount, orgCount, baselineNote }
 */
export function buildReport(ctx) {
  const {
    cfg,
    today,
    refs,
    hubExams,
    linkedFindings,
    newFindings,
    ownerSummary,
    ignoredCount,
    orgCount,
    baselineNote,
  } = ctx;

  const microsoft = ownerSummary
    .filter((o) => o.ownerClass !== "third-party")
    .reduce((n, o) => n + o.repos, 0);
  const third = ownerSummary
    .filter((o) => o.ownerClass === "third-party")
    .reduce((n, o) => n + o.repos, 0);

  const out = [
    `## Lab repos: ${today}`,
    "",
    `The daily lab repo check (\`scripts/lab-repos-check.mjs\`) looked at the ${refs.size} GitHub repositories the content pages link ` +
      `(${microsoft} Microsoft-owned or hub-owned, checked in full; ${third} third-party, checked for gone and archived only) ` +
      `and at the ${orgCount} public repositories of ${cfg.discoveryOrgs.join(", ")} for new labs of the hub's exams. ` +
      "A repository whose GitHub Pages site still answers HTTP 200 can be archived, renamed or replaced, which no link checker sees. " +
      "This issue is a running thread: every change of the list is added as a comment, and the check closes it when nothing is left.",
    "",
  ];

  const sortedLinked = [...linkedFindings].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || byText(a.key, b.key),
  );
  if (sortedLinked.length > 0) {
    // one row per repository, its problems together
    const byRepo = new Map();
    for (const f of sortedLinked) {
      const rows = byRepo.get(f.key) ?? [];
      rows.push(f);
      byRepo.set(f.key, rows);
    }
    const repoRows = [...byRepo.values()];
    out.push(
      `### Linked repositories with a problem (${repoRows.length})`,
      "",
      "| Repository | Problem | Linked from | Suggested successor | What to do |",
      "|------------|---------|-------------|---------------------|------------|",
    );
    for (const group of repoRows.slice(0, MAX_ROWS)) {
      const ref = refs.get(group[0].key);
      const withSuccessor =
        group.find((f) => (f.detail?.successors ?? []).length > 0) ?? group[0];
      out.push(
        `| ${repoLink(group[0].repo)} | ${group.map(problemCell).join("<br><br>")} | ${linkedFrom(ref)} | ` +
          `${successorCell(withSuccessor, refs)} | ${TODO_TEXT[group[0].kind]} |`,
      );
    }
    if (repoRows.length > MAX_ROWS) {
      out.push(
        "",
        `…and ${repoRows.length - MAX_ROWS} more repositories (see the job log).`,
      );
    }
    out.push("");
  }

  const sortedNew = [...newFindings].sort((a, b) => byText(a.key, b.key));
  if (sortedNew.length > 0) {
    out.push(
      `### New repositories that look like labs of hub exams (${sortedNew.length})`,
      "",
      "Non-localised repositories of the organisation whose name contains the code of a hub exam (or of an exam a hub page names, such as a successor with no page yet) and that no content page links.",
      "",
      "| Repository | Exam | Created / last push | Pages | Lab page | Description |",
      "|------------|------|---------------------|-------|----------|-------------|",
    );
    for (const f of sortedNew.slice(0, MAX_ROWS)) {
      const c = f.candidate;
      const exams = c.codes.map((examCode) => hubExams.get(examCode));
      const labPages = exams
        .map((exam) =>
          exam.labPath
            ? code(exam.labPath)
            : exam.examPath
              ? `none yet (exam page ${code(exam.examPath)})`
              : `no hub page for ${exam.code} yet (named in ${code(exam.namedOn)})`,
        )
        .join("<br>");
      out.push(
        `| ${repoLink(c.fullName)}${f.persist ? "" : "<br>baselined, listed because of report_all"} | ` +
          `${c.codes.map(code).join(", ")} | ${c.createdAt ?? "?"} / ${c.pushedAt ?? "?"} | ` +
          `${c.hasPages ? "yes" : "no"} | ${labPages} | ${safeText(c.description) || "(none)"} |`,
      );
    }
    if (sortedNew.length > MAX_ROWS) {
      out.push(
        "",
        `…and ${sortedNew.length - MAX_ROWS} more repositories (see the job log).`,
      );
    }
    out.push("");
  }

  out.push("### What to do", "");
  if (sortedLinked.length > 0) {
    out.push(
      '1. **Linked repository with a problem** (`AGENTS.md`, "Lab Pages"): open the repository and its README first. When a lab repository was superseded, always use the new one; do not list the same lab in both the Microsoft Learn and the Microsoft GitHub tab; add only resources you verified; never invent a URL. Edit the pages in "Linked from", then run `pnpm build`.',
      "2. **A repository you decide to keep despite the warning**: add it to `src/data_files/lab-repos-ignore.json` with the problems it covers and a reason (the reason is the record of the decision). A repository that later gets a worse problem is reported again.",
      "",
    );
  }
  if (sortedNew.length > 0) {
    out.push(
      `${sortedLinked.length > 0 ? "3" : "1"}. **New repository**: open it and confirm on Microsoft Learn that it belongs to the exam. Then add it to the exam's lab page (Microsoft GitHub tab, \`AGENTS.md\` "Lab Page Workflow"; if the course has a Learn module that wraps the same lab, link the Learn one only) or, when the exam has no lab page yet, create it following "Lab Pages" (design and architect exams get none by design). Run \`pnpm build\`. If you decide not to cover it, add it to \`src/data_files/lab-repos-ignore.json\` with \`"problems": ["new-repo"]\` and a reason.`,
      "",
    );
  }
  out.push(
    ignoredCount > 0
      ? `${plural(ignoredCount, "problem is", "problems are")} kept on purpose in \`src/data_files/lab-repos-ignore.json\` and not listed.`
      : "Nothing is currently ignored (`src/data_files/lab-repos-ignore.json`).",
    "",
  );
  if (baselineNote) out.push(baselineNote, "");
  out.push(
    'See the "Lab Repo Check" runbook (`docs/monitors/lab-repo-check.md`) for how the check works.',
    "",
  );

  let report = out.join("\n");
  if (report.length > MAX_REPORT_CHARS) {
    report =
      report.slice(0, MAX_REPORT_CHARS - 200) +
      "\n\n…the report was cut to fit the size limit of an issue; see the job log for the full list.\n";
  }
  return report;
}

/** Headline of a run's report (log, output; the issue's own title is stable). */
export function buildHeadline({ today, linkedCount, newCount }) {
  const parts = [];
  if (linkedCount > 0) {
    parts.push(plural(linkedCount, "linked repository", "linked repositories"));
  }
  if (newCount > 0) {
    parts.push(plural(newCount, "new repository", "new repositories"));
  }
  return `Lab repos ${today}: ${parts.join(" and ") || "all clear"}`;
}

// ---------------------------------------------------------------------------
// Issues (through the gh CLI)
// ---------------------------------------------------------------------------

/**
 * Bring one issue in line with the state, through `gh(args, stdin)`:
 *   active, none open   create ONE issue (title, label) with `body`;
 *   active, one open    add `commentBody` as a comment, never a second issue (with
 *                       several open copies, to the oldest only);
 *   inactive, some open close each with `closeComment`.
 * `open` (the open issues, already looked up) skips the lookup. Not `enabled`
 * (no CREATE_ISSUES, or DRY_RUN): touch nothing, not even to read. When the issue
 * is needed a failed lookup or write throws (nothing else was committed yet);
 * when it is only being closed a failure is reported in the result and the next
 * run retries.
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
  open: knownOpen,
}) {
  const result = (action, extra = {}) => ({
    action,
    number: null,
    closed: [],
    error: null,
    ...extra,
  });
  if (!enabled) return result(active ? "skipped" : "none");
  let open = knownOpen;
  if (!open) {
    try {
      open = listOpenIssues(gh, { title, label });
    } catch (error) {
      if (active) throw error;
      return result("lookup-failed", { error: error.message });
    }
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
 * The running state issue after a successful check. `result.plan` carries the
 * decision inputs; nothing is touched without CREATE_ISSUES=1 (or with DRY_RUN=1).
 */
export function syncStateIssue(cfg, gh, result) {
  const enabled = cfg.createIssues && !cfg.dryRun;
  const { active, changed, reminderDue, forced } = result.plan;
  if (!enabled) {
    return {
      action: active && (changed || reminderDue || forced) ? "skipped" : "none",
      number: null,
      closed: [],
      error: null,
    };
  }
  let open;
  try {
    open = listOpenIssues(gh, { title: ISSUE_TITLE, label: ISSUE_LABEL });
  } catch (error) {
    if (active) throw error;
    return {
      action: "lookup-failed",
      number: null,
      closed: [],
      error: error.message,
    };
  }
  const action = decideIssueAction({
    active,
    changed,
    reminderDue,
    forced,
    openCount: open.length,
  });
  if (action === "none") {
    return { action: "none", number: null, closed: [], error: null };
  }
  return syncIssue({
    gh,
    enabled: true,
    open,
    title: ISSUE_TITLE,
    label: ISSUE_LABEL,
    labelColor: "a2eeef",
    labelDescription: "New feature or request",
    active: action !== "close",
    body: result.report ?? "",
    commentBody: result.commentBody ?? result.report ?? "",
    closeComment: `No linked repository has a problem and no unlinked hub-code repository is left as of ${cfg.today}, so there is nothing left to review. Closing this issue; the next finding opens a new one.${runLink(cfg)}`,
  });
}

/** The failure issue: after a failed check create it or comment; after a healthy check close it. */
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
      ? `The daily lab repo check could not run on ${cfg.today}. Nothing was reported and the tracker was not written, so nothing was lost: the next healthy run continues where the last one stopped. An open "${ISSUE_TITLE}" issue is unchanged.\n\n**Why:** ${message}${runLink(cfg)}\n\nThis issue gets one comment per failed run and closes itself after the next healthy run.`
      : "",
    commentBody: failed
      ? `The lab repo check failed again on ${cfg.today}:\n\n${message}${runLink(cfg)}`
      : "",
    closeComment: `The lab repo check ran normally on ${cfg.today}. Closing this issue.${runLink(cfg)}`,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The details of a finding for the log and the job summary. */
function findingLine(f) {
  const successors = (f.detail?.successors ?? [])
    .map((s) => `${s.repo} (${s.state})`)
    .join(", ");
  return (
    `${f.kind.padEnd(9)} ${f.repo}` +
    (f.detail?.renamedTo ? ` -> ${f.detail.renamedTo}` : "") +
    (successors ? `; suggested successor: ${successors}` : "") +
    (f.carried ? " (carried forward: lookup failed this run)" : "")
  );
}

/**
 * One check. Makes the API requests and writes the report; touches no issue and
 * not the tracker (main does, in that order). Returns what it decided; throws
 * CheckError when the check itself cannot run.
 */
export async function run(cfg) {
  if (!cfg.token) {
    throw new CheckError(
      "No GitHub token: set GH_TOKEN (or GITHUB_TOKEN). Without one the API allows 60 requests an hour, " +
        "far fewer than the ~130 this check makes, so it is not run unauthenticated.",
    );
  }
  if (typeof cfg.fetch !== "function") {
    throw new CheckError("This Node.js has no fetch(); use Node 22.");
  }
  const tracker = loadTracker(cfg.trackerFile);
  const ignore = loadIgnore(cfg.ignoreFile);
  const hubExams = loadHubExams(cfg.docsDir);
  if (hubExams.size === 0) {
    throw new CheckError(
      `No exam page (<area>/<CODE>.mdx) was found under ${cfg.docsDir}; the docs folder probably moved, so no hub exam code is known.`,
    );
  }
  const { refs, fileCount } = extractReferences(cfg.docsDir);
  if (refs.size < cfg.minReferences) {
    throw new CheckError(
      `Only ${refs.size} GitHub repositories were found in ${fileCount} content pages under ${DISPLAY_DOCS_DIR} ` +
        `(at least ${cfg.minReferences} are expected); the folder or the link format probably changed, so nothing was checked.`,
    );
  }
  const ownerSummary = summarizeOwners(refs);
  const client = makeClient(cfg);

  // 1. the linked repositories, one at a time in a fixed order
  const warnings = [];
  const unknownKeys = [];
  const rawFindings = [];
  const infoByKey = new Map();
  for (const key of [...refs.keys()].sort(byText)) {
    const ref = refs.get(key);
    const result = await checkRepo(client, ref, cfg);
    if (result.status === "unknown") {
      unknownKeys.push(key);
      warnings.push(
        `${ref.display}: the lookup failed (${result.reason}); the previous result is kept`,
      );
      rawFindings.push(...carryForward(tracker, key));
    } else {
      infoByKey.set(key, result.info);
      rawFindings.push(...result.findings);
    }
  }
  const unknownPct = (unknownKeys.length / refs.size) * 100;
  if (client.expired()) {
    warnings.push(
      `the run deadline (RUN_DEADLINE_MS=${cfg.runDeadlineMs}) was reached; the lookups after it were not made`,
    );
  }
  if (unknownPct > cfg.maxUnknownPct) {
    throw new CheckError(
      `${unknownKeys.length} of ${refs.size} repository lookups failed (${Math.round(unknownPct)}%, more than ${cfg.maxUnknownPct}%); ` +
        (client.expired()
          ? `the run deadline (RUN_DEADLINE_MS=${cfg.runDeadlineMs} ms) was reached, so the GitHub API is probably slow or hanging and the rest was not asked; `
          : "the GitHub API is probably failing, ") +
        "so no result is trusted. " +
        `Examples: ${warnings.slice(0, 3).join("; ")}.`,
    );
  }

  // first detected: kept from the tracker while the same problem stays
  for (const f of rawFindings) {
    f.firstSeen = tracker.problems[itemOf(f)]?.firstSeen ?? cfg.today;
  }
  const linkedResult = applyIgnore(rawFindings, ignore);
  const linkedFindings = linkedResult.kept;
  let ignoredCount = linkedResult.ignored;
  if (linkedFindings.length > cfg.maxProblems) {
    throw new CheckError(
      `${linkedFindings.length} problems on linked repositories at once (more than ${cfg.maxProblems}); ` +
        "that looks like an API or authentication problem, not news, so nothing is reported. " +
        "If the list is real, run the workflow with a higher max_problems (MAX_PROBLEMS).",
    );
  }

  // 2. new hub-code repositories of the organisation(s)
  const orgRepos = [];
  for (const org of cfg.discoveryOrgs) {
    const listed = await listOrgRepos(client, org);
    if (listed.length < cfg.minOrgRepos) {
      throw new CheckError(
        `The listing of ${org} returned only ${listed.length} public repositories (at least ${cfg.minOrgRepos} are expected); ` +
          "the API or the organisation probably changed, so new repositories are not judged.",
      );
    }
    orgRepos.push(...listed);
  }
  // the exams to look for in repository names: the hub's own and the ones its pages announce
  const relatedExams = loadRelatedExams(
    cfg.docsDir,
    hubExams,
    cfg.retiringFile,
  );
  const watched = new Map([...hubExams, ...relatedExams]);
  const candidates = findCandidates(orgRepos, watched);
  const firstBaseline = tracker.baseline === null || cfg.forceBaseline;
  const baselineSet = new Set(
    (tracker.baseline ?? []).map((n) => n.toLowerCase()),
  );
  const nextBaseline = firstBaseline
    ? candidates.map((c) => c.fullName).sort(byText)
    : tracker.baseline;
  const unlinked = candidates.filter(
    (c) => !c.archived && !c.disabled && !refs.has(c.key),
  );
  const newFindings = [];
  const baselined = [];
  for (const c of unlinked) {
    if (!firstBaseline && !baselineSet.has(c.key)) {
      newFindings.push(newRepoFinding(c, true));
    } else {
      baselined.push(c);
    }
  }
  const ignoredNew = applyIgnore(newFindings, ignore);
  ignoredCount += ignoredNew.ignored;
  let keptNew = ignoredNew.kept;
  if (keptNew.length > cfg.maxNewRepos) {
    throw new CheckError(
      `${keptNew.length} unlinked repositories with a hub exam code appeared at once (more than ${cfg.maxNewRepos}); ` +
        "the naming or the baseline probably changed, not news. If they are real, run the workflow with force_baseline " +
        "(FORCE_BASELINE=1) to accept them silently and read the job summary for what was swallowed.",
    );
  }
  if (cfg.reportAll) {
    const listed = applyIgnore(
      baselined.map((c) => newRepoFinding(c, false)),
      ignore,
    );
    ignoredCount += listed.ignored;
    keptNew = [...keptNew, ...listed.kept];
  }
  // an ignore entry is stale when it matches no finding of this run
  const stillUsed = new Set([
    ...rawFindings.map(itemOf),
    ...newFindings.map(itemOf),
    ...baselined.map((c) => `${c.key}|new-repo`),
  ]);
  const staleIgnore = [];
  for (const entry of ignore) {
    for (const kind of entry.problems) {
      if (!stillUsed.has(`${entry.key}|${kind}`)) {
        staleIgnore.push(`${entry.repo} (${kind})`);
      }
    }
  }

  // 3. the state, the report and the next tracker
  const persistItems = [...linkedFindings, ...keptNew]
    .filter((f) => f.persist)
    .map(itemOf)
    .sort(byText);
  const { added, resolved } = diffItems(tracker.reported.items, persistItems);
  const changed = added.length > 0 || resolved.length > 0;
  const active = linkedFindings.length + keptNew.length > 0;
  const reminderDue =
    active &&
    tracker.reported.lastReported !== null &&
    daysBetween(tracker.reported.lastReported, cfg.today) >= cfg.reminderDays;
  const forced = cfg.reportAll;

  const nextProblems = {};
  for (const f of linkedFindings) {
    const id = itemOf(f);
    nextProblems[id] = {
      key: f.key,
      repo: f.repo,
      kind: f.kind,
      firstSeen: f.firstSeen,
      detail: normalizeDetail(f.detail, (why) => new CheckError(why), id),
    };
  }
  const baselineNote = firstBaseline
    ? `The ${nextBaseline.length} repositories of ${cfg.discoveryOrgs.join(", ")} whose name contains a hub exam code were recorded as the baseline on ${cfg.today}; only repositories that appear after it are reported as new.`
    : "";
  const nextTracker = {
    lastSynced: tracker.lastSynced,
    baselineAt: firstBaseline ? cfg.today : tracker.baselineAt,
    baseline: nextBaseline,
    problems: Object.fromEntries(
      Object.entries(nextProblems).sort(([a], [b]) => byText(a, b)),
    ),
    reported: tracker.reported,
  };
  const trackerChanged =
    trackerContent({ ...nextTracker, lastSynced: null }) !==
    trackerContent({ ...tracker, lastSynced: null });

  let report = null;
  let commentBody = null;
  const shouldReport = active && (changed || reminderDue || forced);
  if (active) {
    report = buildReport({
      cfg,
      today: cfg.today,
      refs,
      hubExams: watched,
      linkedFindings,
      newFindings: keptNew,
      ownerSummary,
      ignoredCount,
      orgCount: orgRepos.length,
      baselineNote,
    });
    const note = [];
    if (added.length > 0) {
      note.push(
        `**New since the last report (${added.length}):** ${added.map((i) => code(i.replace("|", ": "))).join(", ")}`,
      );
    }
    if (resolved.length > 0) {
      note.push(
        `**Resolved since the last report (${resolved.length}):** ${resolved.map((i) => code(i.replace("|", ": "))).join(", ")}`,
      );
    }
    commentBody =
      (note.length > 0
        ? `### Update ${cfg.today}\n\n${note.join("\n\n")}\n\n---\n\n`
        : `### Reminder ${cfg.today}\n\nThe list below is unchanged.\n\n---\n\n`) +
      report;
    writeFileSync(cfg.reportFile, report, "utf8");
  }

  return {
    refs,
    fileCount,
    hubExams,
    relatedExams,
    watched,
    ownerSummary,
    requests: client.stats.requests,
    retries: client.stats.retries,
    checked: refs.size - unknownKeys.length,
    unknown: unknownKeys.length,
    warnings,
    orgCount: orgRepos.length,
    candidates: candidates.length,
    baselined,
    firstBaseline,
    linkedFindings,
    newFindings: keptNew,
    ignoredCount,
    staleIgnore,
    items: persistItems,
    added,
    resolved,
    active,
    shouldReport,
    plan: { active, changed, reminderDue, forced },
    headline: buildHeadline({
      today: cfg.today,
      linkedCount: new Set(linkedFindings.map((f) => f.key)).size,
      newCount: keptNew.length,
    }),
    report,
    commentBody,
    tracker,
    nextTracker,
    trackerChanged,
  };
}

function handleFailure(cfg, error) {
  const message =
    error instanceof CheckError
      ? error.message
      : `Unexpected error: ${error?.stack ?? error}`;
  console.error(`ERROR: ${message}`);
  try {
    writeFileSync(cfg.errorFile, `${message}\n`);
    writeOutput(cfg.githubOutput, {
      changes_found: false,
      baseline_updated: false,
      extraction_failed: true,
      issue_title: "",
    });
  } catch (writeError) {
    console.error(`Could not write the error outputs: ${writeError.message}`);
  }
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

function jobSummary(cfg, result) {
  const lines = [
    `## Lab repo check ${cfg.today}`,
    "",
    `- ${result.refs.size} distinct GitHub repositories linked from ${result.fileCount} content pages; ${result.checked} checked, ${result.unknown} lookups failed.`,
    `- ${result.orgCount} public repositories listed for ${cfg.discoveryOrgs.join(", ")}; ${result.candidates} contain the code of one of the ${result.hubExams.size} hub exams or ${result.relatedExams.size} related exams (${[...result.relatedExams.keys()].join(", ") || "none"}); localised copies left out.`,
    `- ${result.requests} API requests (${result.retries} retries).`,
    `- ${plural(new Set(result.linkedFindings.map((f) => f.key)).size, "linked repository has", "linked repositories have")} a problem; ${plural(result.newFindings.length, "new unlinked hub-code repository", "new unlinked hub-code repositories")}; ${result.ignoredCount} kept on purpose in the ignore list.`,
    "",
    "### Owners linked from the content",
    "",
    "| Owner | Class | Repositories | Links |",
    "|-------|-------|--------------|-------|",
    ...result.ownerSummary.map(
      (o) =>
        `| ${code(safeText(o.owner))} | ${o.ownerClass} | ${o.repos} | ${o.links} |`,
    ),
    "",
    "An owner classed `third-party` is only checked for gone and archived. If a Microsoft-owned owner is listed as third-party, add it to `MICROSOFT_OWNERS` in `scripts/lab-repos-check.mjs`.",
    "",
  ];
  if (result.warnings.length > 0) {
    lines.push(
      "### Lookups that failed (the previous result was kept)",
      "",
      ...result.warnings.map((w) => `- ${safeText(w)}`),
      "",
    );
  }
  if (result.staleIgnore.length > 0) {
    lines.push(
      "### Ignore entries that no longer match anything (remove them from `src/data_files/lab-repos-ignore.json`)",
      "",
      ...result.staleIgnore.map((s) => `- ${code(safeText(s))}`),
      "",
    );
  }
  if (result.firstBaseline) {
    lines.push(
      `### Hub-code repositories that exist but are not linked (recorded silently as the baseline, ${result.baselined.length})`,
      "",
      "These are never reported again. Read the list once and add the labs you want; run the workflow with `report_all` to see them in an issue.",
      "",
      "| Repository | Exam | Created | Lab page of the exam |",
      "|------------|------|---------|----------------------|",
      ...result.baselined.map(
        (c) =>
          `| ${repoLink(c.fullName)} | ${c.codes.join(", ")} | ${c.createdAt ?? "?"} | ${c.codes
            .map((examCode) => {
              const exam = result.watched.get(examCode);
              if (exam.labPath) return code(exam.labPath);
              return exam.examPath ? "none" : "no hub page yet";
            })
            .join("<br>")} |`,
      ),
      "",
    );
  }
  appendStepSummary(cfg.summaryFile, lines.join("\n"));
}

async function main(cfg) {
  console.log("=== Lab Repo Check ===");
  console.log(`Started: ${new Date().toISOString()} · date used: ${cfg.today}`);

  const result = await run(cfg);

  console.log(
    `${result.refs.size} distinct repositories in ${result.fileCount} content pages; owners: ` +
      result.ownerSummary
        .map((o) => `${o.owner} (${o.repos}, ${o.ownerClass})`)
        .join(", "),
  );
  console.log(
    `${result.checked} checked, ${result.unknown} lookups failed; ${result.requests} API requests (${result.retries} retries).`,
  );
  for (const warning of result.warnings) {
    annotate("warning", warning, { title: "Lab repo lookup failed" });
  }
  console.log(
    `${result.orgCount} organisation repositories listed; ${result.candidates} contain a hub exam code.`,
  );
  for (const f of [...result.linkedFindings, ...result.newFindings]) {
    console.log(`  ${findingLine(f)}`);
  }
  if (result.staleIgnore.length > 0) {
    annotate(
      "warning",
      `lab-repos-ignore.json entries that match nothing now: ${result.staleIgnore.join(", ")}`,
      { title: "Stale ignore entries" },
    );
  }
  if (result.firstBaseline) {
    console.log(
      `Baseline recorded: ${result.nextTracker.baseline.length} hub-code repositories; ${result.baselined.length} of them are not linked from any page (listed in the job summary).`,
    );
    for (const c of result.baselined) {
      console.log(`  baseline  ${c.fullName} (${c.codes.join(", ")})`);
    }
  }
  console.log(
    `${result.active ? result.headline : "Nothing needs attention."} ` +
      `(${result.added.length} added, ${result.resolved.length} resolved since the last report)`,
  );
  jobSummary(cfg, result);

  // The issue comes BEFORE the tracker is written and before the workflow commits it: when it
  // fails the run fails, the commit is skipped and the next run derives the same state again.
  const gh = makeGh({ ghCliScript: cfg.ghCliScript });
  const issue = syncStateIssue(cfg, gh, result);
  const line = describeIssue(`Issue "${ISSUE_TITLE}"`, issue, cfg);
  if (line) console.log(line);
  const recovered = syncFailureIssue(cfg, gh, null);
  const recoveredLine = describeIssue(
    `Failure issue "${FAILED_ISSUE_TITLE}"`,
    recovered,
    cfg,
  );
  if (recoveredLine && recovered.action !== "skipped") {
    console.log(recoveredLine);
  }

  const enabled = cfg.createIssues && !cfg.dryRun;
  const reportedNow =
    issue.action === "created" ||
    issue.action === "commented" ||
    issue.action === "closed";
  // What was reported is only remembered when GitHub really was told.
  const nextTracker = { ...result.nextTracker };
  if (enabled && (reportedNow || (!result.active && issue.action === "none"))) {
    nextTracker.reported = {
      lastReported: result.active
        ? cfg.today
        : result.tracker.reported.lastReported,
      items: result.items,
    };
  }
  const changed =
    trackerContent({ ...nextTracker, lastSynced: null }) !==
    trackerContent({ ...result.tracker, lastSynced: null });
  if (changed) {
    nextTracker.lastSynced = cfg.today;
    writeFileSync(cfg.trackerFile, trackerContent(nextTracker), "utf8");
  }

  const changesFound =
    issue.action === "created" ||
    issue.action === "commented" ||
    (issue.action === "skipped" && result.shouldReport);
  writeOutput(cfg.githubOutput, {
    changes_found: changesFound,
    baseline_updated: changed,
    extraction_failed: false,
    issue_title: changesFound ? result.headline : "",
  });
  console.log(changed ? "Tracker updated" : "Tracker unchanged");
  console.log("=== Done ===");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cfg = loadConfig();
  main(cfg).catch((error) => handleFailure(cfg, error));
}
