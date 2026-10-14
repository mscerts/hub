#!/usr/bin/env node
/**
 * Tests Review Reminder: a ONE-TIME issue that asks the maintainer to decide
 * whether the unit tests of the monitors (the top-level tests/ directory) can go.
 *
 * The tests only matter until every monitor has shown in production that it
 * works, i.e. has raised a real alert at least once. This script derives that
 * from GitHub alone (no tracker, no commit, no state of its own):
 *
 *   1. An issue titled ISSUE_TITLE in ANY state (open or closed) means "already
 *      raised": exit 0, nothing else is read or written.
 *   2. For every monitor in MONITORS: the oldest issue whose title is one of its
 *      ALERT titles (its failure/bug issues are left out on purpose; titles from
 *      before a monitor was rewritten are in, so past real alerts count), and the
 *      number of successful scheduled runs of its workflow. A workflow that is not
 *      on GitHub yet is "not deployed" and counts as not fired.
 *   3. The evidence table is printed (and added to the job summary). The issue is
 *      raised when EVERY monitor has fired, or when BACKSTOP_DATE has passed (the
 *      UTC date of the run is after it).
 *
 * Environment (all optional):
 *   GH_TOKEN             the job token (issues: write, actions: read, contents: read)
 *   GITHUB_REPOSITORY    owner/name (default mscerts/hub)
 *   BACKSTOP_DATE        YYYY-MM-DD (default 2027-01-12, 90 days after 2026-10-14)
 *   TODAY                YYYY-MM-DD, the date the run pretends it is
 *   CREATE_ISSUES        1 = really create the issue (the workflow sets it)
 *   DRY_RUN              1 = never create; print the issue instead
 *   AGENTS_FILE          AGENTS.md (read to list the sections that mention the tests)
 *   DOCS_DIR             docs (every .md under it is read for the same list)
 *   REPORT_FILE          write the issue body here when the issue is due
 *   GITHUB_STEP_SUMMARY  Actions job summary file
 *   GH_CLI_SCRIPT        run this Node script instead of the gh CLI (proofs only)
 *   FORCE_ALL_FIRED      1 = treat every monitor as fired. A proof override: it
 *                        refuses to run with CREATE_ISSUES=1 unless DRY_RUN=1.
 *
 * Without CREATE_ISSUES=1 (a local run) nothing is created. A failing `gh`, a
 * malformed date or an unreadable answer ends the run with exit code 1 and an
 * `::error` line: it never passes silently as "not due".
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { annotate, appendStepSummary } from "./lib/actions.mjs";
import { makeGh } from "./lib/gh.mjs";

const env = process.env;
const ISSUE_TITLE = "Monitor tests: decide whether to remove them";
const REPO = env.GITHUB_REPOSITORY || "mscerts/hub";
const BACKSTOP_DATE = env.BACKSTOP_DATE || "2027-01-12";
const TODAY = env.TODAY || new Date().toISOString().slice(0, 10);
const DRY_RUN = env.DRY_RUN === "1";
const CREATE_ISSUES = env.CREATE_ISSUES === "1";
const FORCE_ALL_FIRED = env.FORCE_ALL_FIRED === "1";

/**
 * One row per monitor: its workflow file and a pattern for the titles of the
 * issues it opens as an ALERT ("something changed"). Failure issues ("... Failed",
 * "the check failed", "sources need attention", "learnsync data is stale", ...)
 * are not alerts and are not matched. Read from the monitor scripts and from the
 * issue history; when a monitor's title changes, change its pattern here.
 */
const MONITORS = [
  [
    "Beta Exam Monitor",
    "beta-exam-monitor.yml",
    /^Beta Exam Status Change Detected\b/,
  ],
  [
    "Retiring Exam Monitor",
    "retiring-exam-monitor.yml",
    // The old "Exam Retirement Notification — <run id>" and the current titles.
    /^(Exam Retirement Notification\b|Exam retirement (schedule|approaching): |Microsoft Learn announced a retirement: )/i,
  ],
  [
    "Applied Skills Monitor",
    "applied-skills-monitor.yml",
    /^Applied Skills Changes Detected\b/,
  ],
  [
    "MeasureUp Monitor",
    "measureup-monitor.yml",
    /^(New MeasureUp Products Detected\b|MeasureUp: )/,
  ],
  [
    "Partner Designations Monitor",
    "partner-designations-monitor.yml",
    // The old "Partner Designation Page Changed — <run id>" and the current titles.
    /^(Partner Center pages? changed: |Partner Designation Page Changed\b)/,
  ],
  [
    "Voucher Challenge Monitor",
    "voucher-challenge-monitor.yml",
    /^New Voucher Challenge Detected\b/,
  ],
  [
    "Voucher Review",
    "voucher-review.yml",
    // The running issue has a stable title; "Voucher review <date>: ..." is only the report's headline.
    /^Voucher review: pages need attention$/,
  ],
  [
    "New Exam Monitor",
    "new-exam-monitor.yml",
    // New exam or certification, study guide updated, hub-vs-Learn drift.
    /^(New Microsoft Learn (exams?|certifications?): |Microsoft Learn study guide updated: |Learn drift: hub pages need updating$)/,
  ],
  ["Learn URL Check", "learn-url-check.yml", /^Broken Microsoft Learn links: /],
  [
    "Link Checker",
    "link-checker.yml",
    // The current title and the two reports of the version before the rewrite.
    /^(Link Checker: dead external links$|(External )?Link Checker Report$)/,
  ],
  [
    "Skills Hub Watch",
    "skills-hub-watch.yml",
    /^Skills Hub (post|posts \(\d+\)): /,
  ],
  ["Source Watch", "source-watch.yml", /^Watched sources? changed: /],
  [
    "Lab Repo Check",
    "lab-repos-check.yml",
    /^Lab repos: linked repositories need attention$/,
  ],
  ["Learn Content Watch", "learn-content-watch.yml", /^Learn content watch: /],
];

const gh = makeGh({ ghCliScript: env.GH_CLI_SCRIPT });

const oldestFirst = (a, b) =>
  a.createdAt.localeCompare(b.createdAt) || a.number - b.number;

/** The workflow files that exist on GitHub (a workflow nobody pushed yet is not listed). */
function deployedWorkflows() {
  const out = gh([
    "api",
    "--paginate",
    `repos/${REPO}/actions/workflows?per_page=100`,
    "--jq",
    ".workflows[].path",
  ]);
  const files = out.split(/\r?\n/).filter(Boolean);
  if (files.length === 0) throw new Error("GitHub lists no workflows at all.");
  return new Set(files.map((path) => path.split("/").pop()));
}

function scheduledSuccesses(workflow) {
  const out = gh([
    "api",
    `repos/${REPO}/actions/workflows/${workflow}/runs?event=schedule&status=success&per_page=1`,
    "--jq",
    ".total_count",
  ]);
  const count = Number(out);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Unexpected run count "${out}" for ${workflow}.`);
  }
  return count;
}

const alertCell = (row) =>
  row.runs === null
    ? "not deployed"
    : row.alert
      ? `#${row.alert.number}, ${row.alert.createdAt.slice(0, 10)}`
      : "not fired yet";

function evidenceTable(rows) {
  return [
    "| Monitor | Workflow | First real alert | Successful scheduled runs |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.name} | \`${row.workflow}\` | ${alertCell(row)} | ${row.runs ?? "n/a"} |`,
    ),
  ].join("\n");
}

/** The files of tests/scripts that do not test a monitor: they test the site code, the workflows and the beta exam pages. */
const KEPT_TESTS = [
  "automation.test.mjs",
  "beta-pages.test.mjs",
  "lib-beta-note.test.mjs",
  "workflow-commit-steps.test.mjs",
  "workflows.test.mjs",
];
const keptTestsList = () => KEPT_TESTS.map((name) => `\`${name}\``).join(", ");

/** The monitor test files as repository paths: every tests/scripts/*.test.mjs except KEPT_TESTS (empty when unreadable). */
function monitorTestFiles() {
  try {
    return readdirSync("tests/scripts")
      .filter(
        (name) => name.endsWith(".test.mjs") && !KEPT_TESTS.includes(name),
      )
      .sort()
      .map((name) => `tests/scripts/${name}`);
  } catch {
    return [];
  }
}

const TEST_MENTION =
  /tests\/|\.test\.mjs|test:scripts|GH_CLI_SCRIPT|\bfixtures?\b|\b(?:a|unit|offline) tests?\b|\btests?,? (?:only|fully|in)\b/i;

/** The `.md` files under `dir`, recursively, as `/` paths in sorted order. Throws when a folder cannot be read. */
function markdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

/** The sections of one Markdown file that mention the test suite, as "`file > section` (N lines)". `headingPattern` picks the headings that start a section. */
function mentioningSections(file, text, headingPattern) {
  const counts = new Map();
  let heading = "(before the first heading)";
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(headingPattern);
    if (h) heading = h[1].trim();
    else if (TEST_MENTION.test(line))
      counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }
  return [...counts].map(
    ([name, n]) => `\`${file} > ${name}\` (${n} line${n === 1 ? "" : "s"})`,
  );
}

/** The sections of AGENTS.md (`##`) and of every .md file under docs/ (`#` and `##`) that mention the test suite, with the number of lines. */
function testMentionSections() {
  const agentsFile = env.AGENTS_FILE || "AGENTS.md";
  const docsDir = (env.DOCS_DIR || "docs").replace(/[\\/]+$/, "");
  const found = [];
  const unreadable = [];
  try {
    found.push(
      ...mentioningSections(
        agentsFile,
        readFileSync(agentsFile, "utf8"),
        /^## (?!#)(.+)/,
      ),
    );
  } catch {
    unreadable.push("AGENTS.md");
  }
  try {
    for (const file of markdownFiles(docsDir)) {
      if (file.endsWith("/tests-review-reminder.md")) continue; // removed by its own step
      found.push(
        ...mentioningSections(
          file,
          readFileSync(file, "utf8"),
          /^#{1,2} (?!#)(.+)/,
        ),
      );
    }
  } catch {
    unreadable.push(`${docsDir}/`);
  }
  const notes = unreadable.map(
    (name) => `${name} could not be read here; search it for "tests/".`,
  );
  if (found.length === 0 && notes.length === 0) return "none found.";
  return [found.length > 0 ? `${found.join(", ")}.` : "", ...notes]
    .filter(Boolean)
    .join(" ");
}

/** ": `git rm -r tests/fixtures <the monitor test files that exist today>`", or "" when none can be listed. */
function monitorTestsCommand() {
  const files = monitorTestFiles();
  return files.length === 0
    ? ""
    : `: \`git rm -r tests/fixtures ${files.join(" ")}\``;
}

function buildBody(rows, reason) {
  return [
    `This is a one-time reminder. It was raised because ${reason}.`,
    "",
    `## Evidence (${TODAY})`,
    "",
    evidenceTable(rows),
    "",
    `"First real alert" is the oldest issue (open or closed) with one of the monitor's alert titles; its failure issues do not count, titles from before a monitor was rewritten do. "not deployed" means the workflow is not on GitHub yet, which counts as not fired.`,
    "",
    "## What the tests are",
    "",
    "- The monitor tests are the `tests/scripts/*.test.mjs` files of the monitor scripts, and `tests/fixtures/`, saved samples of real pages that only those tests read (the monitors never use them).",
    `- Some files in \`tests/scripts/\` are not monitor tests and are not part of this decision: \`automation.test.mjs\` (tests of site code, \`src/utils/link-rel.ts\` and the icon resolver, and of \`scripts/sitemap-check.sh\`), \`workflows.test.mjs\` and \`workflow-commit-steps.test.mjs\` (check ALL workflow files: valid YAML, no two workflows that push to \`main\` start in the same minute, every push is retried and every commit step works against a scratch remote), and \`beta-pages.test.mjs\` with \`lib-beta-note.test.mjs\` (the beta exam pages and their timeline notes against \`beta-exams.json\`). They protect the site, the workflows and the content, so they stay unless you decide otherwise.`,
    "- The monitor tests never run in production. They run in the `pnpm test:scripts` step of CI on pull requests and when someone runs `pnpm test` locally.",
    "- They only matter when someone edits a monitor script (they catch a regression without waiting for Learn to change) or before a monitor's first deploy. Once a monitor has raised a real alert, production has shown what they show.",
    "- `mcp-worker/tests` is a separate suite for the MCP worker and is not part of this.",
    "",
    "## Decide",
    "",
    "**Keeping the tests is a valid choice**, for example if the monitors will still be edited. Closing this issue without removing anything is fine: the reminder looks for this title in any state (open or closed) and never raises it again.",
    "",
    "## Removal checklist",
    "",
    "Run from the repository root.",
    "",
    "- [ ] 1. Optional: keep a copy outside the repository (`tar -czf ../monitor-tests.tgz tests`). The files stay in git history either way.",
    `- [ ] 2. Delete the monitor tests and their fixtures, that is \`tests/fixtures/\` and every \`*.test.mjs\` in \`tests/scripts/\` except ${keptTestsList()}${monitorTestsCommand()}. Do not touch \`mcp-worker/tests\`.`,
    "- [ ] 3. Leave `package.json` (the `test:scripts` script, the `'tests/**/*.mjs'` patterns of `format` and `format:check`) and the `- run: pnpm test:scripts` step of the `quality` job in `.github/workflows/ci.yml` as they are: the files you kept still run through them. Only if you also deleted those files (nothing is left in `tests/`): delete the `test:scripts` script, change `test` to `\"pnpm test:mcp\"`, remove the `'tests/**/*.mjs'` patterns, and remove that CI step.",
    `- [ ] 4. In \`AGENTS.md\` and the runbooks in \`docs/\`: remove the mentions of the deleted tests (their file paths, "tests:" notes, test-only hooks such as \`GH_CLI_SCRIPT\`); mentions of the kept files stay. Sections that mention tests (grep run on ${TODAY}): ${testMentionSections()}`,
    "- [ ] 5. Delete this reminder: `.github/workflows/tests-review-reminder.yml`, `scripts/tests-review-reminder.mjs`, its runbook `docs/monitors/tests-review-reminder.md` and its rows in `docs/monitors/README.md` and in the Monitors table of `AGENTS.md`.",
    '- [ ] 6. Run `pnpm build`, `pnpm format:check` and `pnpm test:scripts`. `git grep -n -E "tests/|test:scripts" -- . ":(exclude)mcp-worker" ":(exclude)pnpm-lock.yaml"` lists what is left: comments in script headers that name the tests are harmless, but text a monitor writes into its own issues (for example the retiring-exam monitor\'s "page changed shape" steps) should be edited.',
  ].join("\n");
}

/** Print a line, and add it to the job summary when there is one. */
function log(text) {
  console.log(text);
  appendStepSummary(env.GITHUB_STEP_SUMMARY, text);
}

function main() {
  for (const [name, value] of [
    ["BACKSTOP_DATE", BACKSTOP_DATE],
    ["TODAY", TODAY],
  ]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} must be YYYY-MM-DD, got "${value}".`);
    }
  }
  if (FORCE_ALL_FIRED && CREATE_ISSUES && !DRY_RUN) {
    throw new Error(
      "FORCE_ALL_FIRED=1 is a proof override: it must not run with CREATE_ISSUES=1 unless DRY_RUN=1.",
    );
  }

  const issues = JSON.parse(
    gh([
      "issue",
      "list",
      "--repo",
      REPO,
      "--state",
      "all",
      "--limit",
      "5000",
      "--json",
      "number,title,createdAt,state",
    ]) || "[]",
  );
  const raised = issues
    .filter((issue) => issue.title.trim() === ISSUE_TITLE)
    .sort(oldestFirst)[0];
  if (raised) {
    log(
      `already raised: #${raised.number} (${raised.state.toLowerCase()}); nothing to do.`,
    );
    return;
  }

  const deployed = deployedWorkflows();
  const rows = MONITORS.map(([name, workflow, title]) => {
    const alert = issues
      .filter((issue) => title.test(issue.title.trim()))
      .sort(oldestFirst)[0];
    const runs = deployed.has(workflow) ? scheduledSuccesses(workflow) : null;
    const fired = FORCE_ALL_FIRED || (runs !== null && Boolean(alert));
    return { name, workflow, alert, runs, fired };
  });
  const fired = rows.filter((row) => row.fired).length;
  const allFired = fired === rows.length;

  log(`## Tests review reminder (${TODAY})\n\n${evidenceTable(rows)}\n`);
  if (FORCE_ALL_FIRED)
    log("FORCE_ALL_FIRED=1: every monitor counts as fired (proof only).");
  if (!allFired && TODAY <= BACKSTOP_DATE) {
    log(
      `not raised: ${fired} of ${rows.length} monitors fired; the backstop ${BACKSTOP_DATE} has not passed (today ${TODAY}).`,
    );
    return;
  }

  const reason = allFired
    ? `all ${rows.length} monitors have raised at least one real alert${FORCE_ALL_FIRED ? " (FORCE_ALL_FIRED proof override)" : ""}`
    : `the backstop date ${BACKSTOP_DATE} has passed (today is ${TODAY}); ${fired} of ${rows.length} monitors have fired`;
  const body = buildBody(rows, reason);
  if (env.REPORT_FILE) writeFileSync(env.REPORT_FILE, `${body}\n`);

  if (DRY_RUN || !CREATE_ISSUES) {
    log(
      `would raise "${ISSUE_TITLE}" (${DRY_RUN ? "DRY_RUN=1" : "CREATE_ISSUES is not 1"}): ${reason}.\n\n---\n${body}\n---`,
    );
    return;
  }
  const url = gh(
    [
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      ISSUE_TITLE,
      "--label",
      "enhancement",
      "--body-file",
      "-",
    ],
    body,
  );
  log(`raised: ${url} (${reason}).`);
}

try {
  main();
} catch (error) {
  const message = String(error?.message ?? error)
    .replace(/\s+/g, " ")
    .trim();
  annotate("error", message, { title: "Tests Review Reminder" });
  process.exitCode = 1;
}
