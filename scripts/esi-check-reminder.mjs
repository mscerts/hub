#!/usr/bin/env node
/**
 * Every other month: ask a maintainer to check by hand which exams have Microsoft
 * Organizational Skilling (ESI) training.
 *
 * esi.microsoft.com is not public (its page is a script shell and needs a sign-in),
 * so nothing can tell a script whether ESI has training for an exam. What a script
 * can do is know which exam pages have no ESI card yet: the "Microsoft ESI" list of
 * the Missing Resources Audit (scripts/audit-missing-resources.mjs). This script
 * turns that list into ONE issue, a checklist with the search address each exam
 * would have on ESI, so the maintainer opens the addresses instead of building them:
 *
 *   node scripts/audit-missing-resources.mjs      # refreshes the list from the pages
 *   node scripts/esi-check-reminder.mjs
 *
 * - The list is empty: nothing to check; an open issue is closed with a comment.
 * - The list has exams and no issue is open: the issue is created.
 * - The list has exams and the issue is still open (the last round was not done):
 *   the refreshed list is added as a comment, so it does not pile up copies.
 * An exam leaves the list when its page gets the ESI card, or when the audit exempts
 * it (scripts/lib/audit-exemptions.mjs) after a check found no training.
 *
 * The list is read from the file the audit wrote; a file that cannot be read or has
 * no "Microsoft ESI" list is an error (red run), never an empty list: a run that
 * could not look must not close the issue.
 *
 * Environment: GH_TOKEN (the job token; `issues: write`), CREATE_ISSUES=1 (without
 * it nothing is created, commented or closed, the issue text is only printed),
 * DRY_RUN=1 (the same, whatever CREATE_ISSUES says), MISSING_FILE (default
 * src/data_files/missing-resources.json), TODAY (YYYY-MM-DD), REPORT_FILE (the text
 * of the issue is also written there), GITHUB_REPOSITORY (default mscerts/hub),
 * GITHUB_SERVER_URL / GITHUB_RUN_ID (a link to the run), GITHUB_STEP_SUMMARY,
 * GH_CLI_SCRIPT (tests only: a Node script run instead of the `gh` CLI).
 *
 * Exit code: 0 when the issue is in the wanted state (or nothing was touched on
 * purpose), 1 when the list cannot be read or `gh` failed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { examStatuses } from "../src/data_files/exam-status.mjs";
import { closeOpenIssues, raiseIssue } from "./failure-issue.mjs";
import { appendStepSummary } from "./lib/actions.mjs";
import { AREA_BY_PREFIX } from "./lib/areas.mjs";
import { makeGh } from "./lib/gh.mjs";

export const ISSUE_TITLE = "ESI: check which exams have training";
export const ISSUE_LABEL = "enhancement";
export const LIST_KEY = "Microsoft ESI";

/** The address an exam's ESI card has on the exam pages: a search by exam code. */
export function esiSearchUrl(code) {
  return `https://esi.microsoft.com/Search?q=${encodeURIComponent(code)}&avail=Available&learningoption=Advanced+Role+Based`;
}

/** The hub area folder of an exam code (AZ-104 -> azure), or null for a prefix the hub does not know. */
export function areaOf(code) {
  return AREA_BY_PREFIX[code.split("-")[0]] ?? null;
}

/** The sidebar badge text of an exam (BETA, NEW, RETIRING, ...), or "". */
export function statusOf(code, statuses = examStatuses) {
  const area = areaOf(code);
  return (area && statuses[area]?.[code]?.text) || "";
}

/**
 * The exam codes of the "Microsoft ESI" list, sorted by area and number. Throws
 * when the file has no such list or it holds something that is not an exam code.
 */
export function readEsiList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`The audit file is not valid JSON: ${error.message}`);
  }
  const list = data?.[LIST_KEY];
  if (!Array.isArray(list)) {
    throw new Error(
      `The audit file has no "${LIST_KEY}" list (run node scripts/audit-missing-resources.mjs first).`,
    );
  }
  for (const code of list) {
    if (typeof code !== "string" || !/^[A-Z]{2,3}-\d{3}$/.test(code)) {
      throw new Error(
        `"${String(code)}" in the "${LIST_KEY}" list is not an exam code.`,
      );
    }
  }
  return [...new Set(list)].sort((a, b) => {
    const [pa, na] = a.split("-");
    const [pb, nb] = b.split("-");
    return pa.localeCompare(pb) || Number(na) - Number(nb);
  });
}

function checklist(codes, repository, statuses) {
  return codes
    .map((code) => {
      const area = areaOf(code);
      const page = area
        ? ` · [page](https://github.com/${repository}/blob/main/src/content/docs/${area}/${code}.mdx)`
        : "";
      const status = statusOf(code, statuses);
      return `- [ ] [${code}](${esiSearchUrl(code)})${status ? ` (${status})` : ""}${page}`;
    })
    .join("\n");
}

/** The text of the issue (and of the comment on a later round): what to do and one search address per exam. */
export function buildReport({
  codes,
  today,
  repository = "mscerts/hub",
  runUrl = null,
  statuses = examStatuses,
  followUp = false,
}) {
  const lead = followUp
    ? `The last round of this check is still open. ${codes.length} exam page${codes.length === 1 ? " has" : "s have"} no ESI card as of ${today}:`
    : `${codes.length} exam page${codes.length === 1 ? " has" : "s have"} no ESI card as of ${today}. ESI (\`esi.microsoft.com\`) is not public, so it has to be checked by hand whether it has training for these exams. Each link below is the search the card would use:`;
  return [
    lead,
    "",
    checklist(codes, repository, statuses),
    "",
    "**What to do**",
    "",
    "1. Open each link on ESI and look at the results.",
    '2. Training found: add the card to the Videos tab of the exam page, after the other Microsoft cards of that grid: `<LinkCard title="Microsoft Enterprise Skills Initiative Instructor-led course" href="<the link>" target="_blank"/>`.',
    "3. Nothing found: add the exam to `scripts/lib/audit-exemptions.mjs` under `Microsoft ESI`, with the date of the check in the reason, so it stops being listed. For an exam that is BETA or NEW you may prefer to leave it and look again at the next round.",
    "4. Run `node scripts/audit-missing-resources.mjs` and commit the regenerated `src/data_files/missing-resources.json` with the page edits.",
    "",
    "The issue closes itself at the first round where every exam has its card or an exemption. If it is still open at the next round, that round is added as a comment.",
    runUrl ? `\nRun: ${runUrl}` : "",
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Create the issue, comment on the open one, or close it when nothing is left.
 * Returns { action: "created" | "commented" | "closed" | "none" | "dry-run", number? }.
 */
export function remind({
  gh,
  codes,
  today,
  repository,
  runUrl = null,
  statuses = examStatuses,
}) {
  if (codes.length === 0) {
    const { closed, failures } = closeOpenIssues({
      gh,
      title: ISSUE_TITLE,
      label: ISSUE_LABEL,
      comment: `Every exam page has an ESI card or an exemption as of ${today}, so there is nothing to check.${runUrl ? `\n\nRun: ${runUrl}` : ""}`,
    });
    if (failures.length > 0) {
      throw new Error(`Could not close the issue: ${failures.join("; ")}`);
    }
    return { action: closed.length ? "closed" : "none", closed };
  }
  return raiseIssue({
    gh,
    title: ISSUE_TITLE,
    label: ISSUE_LABEL,
    body: buildReport({ codes, today, repository, runUrl, statuses }),
    commentBody: buildReport({
      codes,
      today,
      repository,
      runUrl,
      statuses,
      followUp: true,
    }),
  });
}

export function main(env = process.env) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);
  const repository = env.GITHUB_REPOSITORY || "mscerts/hub";
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  const file = env.MISSING_FILE || "src/data_files/missing-resources.json";
  const codes = readEsiList(readFileSync(file, "utf8"));

  const report = codes.length
    ? buildReport({ codes, today, repository, runUrl })
    : "Every exam page has an ESI card or an exemption: nothing to check.";
  console.log(report);
  if (env.REPORT_FILE) writeFileSync(env.REPORT_FILE, `${report}\n`);
  appendStepSummary(env.GITHUB_STEP_SUMMARY, `### ESI check\n\n${report}\n`);

  if (env.DRY_RUN === "1" || env.CREATE_ISSUES !== "1") {
    console.log(
      `\nNot touching GitHub (${env.DRY_RUN === "1" ? "DRY_RUN" : "CREATE_ISSUES is not 1"}): ${codes.length} exam(s) to check.`,
    );
    return { action: "dry-run" };
  }
  const result = remind({
    gh: makeGh({ ghCliScript: env.GH_CLI_SCRIPT }),
    codes,
    today,
    repository,
    runUrl,
  });
  console.log(
    `\nIssue "${ISSUE_TITLE}": ${result.action}${result.number ? ` (#${result.number})` : ""}.`,
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
