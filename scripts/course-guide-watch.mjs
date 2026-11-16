#!/usr/bin/env node
/**
 * Course Guide Watch (docs/monitors/course-guide-watch.md): when the skills an exam measures change, ask for the
 * exam's course to be brought to the new version.
 *
 * A course (src/data_files/courses/<CODE>.json, docs/courses.md) follows a study guide task for task. The New Exam
 * Monitor records every version of every covered guide (src/data_files/study-guide-history/<CODE>.json), with the
 * day the version says its skills are measured from. This script compares every course with the versions of its
 * guide and keeps ONE issue per exam:
 *
 *   node scripts/course-guide-watch.mjs
 *
 * - The course follows the newest version: nothing to do; an open issue is closed with a comment.
 * - The newest version is dated in the future and has other tasks than the course ("upcoming"): the issue says
 *   from which day the new skills are measured and what changes for the course. The course stays as it is until
 *   that day; the new version is prepared meanwhile.
 * - The version the exam measures today has other tasks than the course ("changed"): the issue says since when.
 * - The issue is still open and what it says changed (the day came, Microsoft changed the guide again, a part of
 *   the course was updated): its text is rewritten and a comment says so. A run that changes nothing is silent.
 *
 * Only the TASKS count (added, removed, moved to another skill group, reworded, reordered). A new date, new
 * weights, a changed audience profile or a changed notice alone never open an issue: the course's tasks are still
 * the guide's. Nothing is written into the repository and the script keeps no tracker: what it reports follows
 * from the course files and the history files, so a run is repeatable.
 *
 * Failsafes: a course file or a history file that cannot be read, and more new issues in one run than
 * COURSE_GUIDE_WATCH_MAX_NEW (default 5; a change in how guides are read would touch every course at once), stop
 * the run with exit code 1 before anything is created, changed or closed. FORCE=1 skips the second one.
 *
 * Environment: GH_TOKEN (the job token; `issues: write`), CREATE_ISSUES=1 (without it nothing is created, changed
 * or closed: the report is only printed), DRY_RUN=1 (the same, whatever CREATE_ISSUES says), FORCE=1,
 * COURSE_GUIDE_WATCH_MAX_NEW, COURSES_DIR (default src/data_files/courses), HISTORY_DIR (default
 * src/data_files/study-guide-history), LEARN_EXAMS_FILE (default src/data_files/learn-exams.json: the stored
 * guide of an exam whose history is not recorded yet), TODAY (YYYY-MM-DD), SITE_URL (default https://msfthub.com),
 * REPORT_FILE (the report of the run), ERROR_FILE (what went wrong, for the failure issue), GITHUB_REPOSITORY,
 * GITHUB_SERVER_URL / GITHUB_RUN_ID (a link to the run), GITHUB_OUTPUT (`check_failed`, `changed`),
 * GITHUB_STEP_SUMMARY, GH_CLI_SCRIPT (tests only: a Node script run instead of the `gh` CLI).
 *
 * Exit code: 0 when every issue is in the wanted state (or nothing was touched on purpose), 1 when a file cannot
 * be read, a failsafe stopped the run or `gh` failed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { versionState } from "../src/utils/guide-changes/state.mjs";
import { closeOpenIssues } from "./failure-issue.mjs";
import { appendStepSummary, writeOutput } from "./lib/actions.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { flattenTasks, planGuideChanges } from "./lib/course-status.mjs";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";
import { readHistory } from "./lib/guide-history.mjs";

export const ISSUE_LABEL = "courses";
const LABEL_LOOK = {
  color: "0e8a16",
  description: "The study guide courses of the exams",
};
/** The title of an exam's issue: stable, so one issue is kept and rewritten. */
export const issueTitle = (code) =>
  `Course ${code}: the study guide's skills changed`;
/** More new issues than this in one run is not believed (a change in how guides are read touches every course). */
export const MAX_NEW_ISSUES = 5;
/** How many tasks of one kind an issue lists before it says "and N more". */
const LIST_LIMIT = 40;

const MONTHS = [
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
/** 2026-10-30 as "October 30, 2026", the way the rest of the repository writes a day. */
export function prettyDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A version of a guide (a history version, or the tracker's stored text) as { n, asOf, firstSeen, guide }. */
function readVersion(version) {
  if (!version || !Array.isArray(version.lines)) return null;
  const guide = parseGuide(version.lines);
  return {
    n: version.n ?? null,
    asOf: version.asOf ?? null,
    firstSeen: version.firstSeen ?? null,
    onPage: version.onPage === true,
    guide,
    readable: guide.ok === true,
  };
}

/**
 * The versions a course is compared with on `now`:
 *   measured  what the exam measures today: the newest version not dated in the future; when the only recorded
 *             version is dated ahead, the "Skills measured prior to" section Microsoft's page carried with it
 *   upcoming  the newest version, when its date is still ahead
 * `stored` is the guide's lines in the tracker (learn-exams.json), used when no history is recorded yet. Returns
 * { measured, upcoming, earlierThanPrevious }: either may be null, and a version that does not parse as a guide
 * has `readable: false`.
 */
export function versionsFor({ history, stored = null, now = new Date() }) {
  if (!history?.versions?.length)
    return {
      measured: stored ? readVersion({ lines: stored }) : null,
      upcoming: null,
      earlierThanPrevious: false,
    };
  const state = versionState(history, now);
  const measured = state.current ?? (state.upcoming ? state.previous : null);
  // "The page wins, whatever the dates say": a version dated before the one it replaced took effect when it appeared
  const earlierThanPrevious = Boolean(
    state.current?.asOf &&
    state.previousSource === "recorded" &&
    state.previous?.asOf &&
    state.current.asOf < state.previous.asOf,
  );
  return {
    measured: readVersion(measured),
    upcoming: readVersion(state.upcoming),
    earlierThanPrevious,
  };
}

/**
 * planGuideChanges lists a reworded task twice: as a removed and an added task, and as a rename hint that pairs
 * the two. Here each task is in one list only: added, removed, reworded (the hints) or moved.
 */
function disjoint(plan) {
  const from = new Set(plan.renameHints.map((h) => h.from.key));
  const to = new Set(plan.renameHints.map((h) => h.to.key));
  return {
    ...plan,
    added: plan.added.filter((t) => !to.has(t.key)),
    removed: plan.removed.filter((t) => !from.has(t.key)),
  };
}

const picksByTask = (course) =>
  new Map(
    (course.domains ?? []).flatMap((d) =>
      (d.groups ?? []).flatMap((g) =>
        (g.tasks ?? []).map((t) => [t.key, (t.picks ?? []).length]),
      ),
    ),
  );

/**
 * Where a course stands against its guide on `now`. Returns
 *   { code, status, version?, effective?, plan?, followsMeasured?, tasks, staying }
 * `status` is
 *   "current"   the course has the tasks of the newest version
 *   "upcoming"  the newest version is dated ahead and has other tasks: `effective` is { day, basis: "stated" }
 *   "changed"   the version measured today has other tasks: `effective` is { day, basis: "stated" | "seen" }
 *               (the day the version states, else the day the monitor first saw it), or null when neither is known
 *   "unknown"   no version of the guide can be read: nothing is said, and nothing is closed
 * `plan` is planGuideChanges of the version to follow; `followsMeasured` says, for an upcoming change, whether the
 * course has the tasks of what is measured today (null when that version cannot be read); `ahead` is true when the
 * course already has the tasks of an upcoming version that differ from today's.
 */
export function checkCourse({
  course,
  history,
  stored = null,
  now = new Date(),
}) {
  const code = course.code;
  const { measured, upcoming, earlierThanPrevious } = versionsFor({
    history,
    stored,
    now,
  });
  const tasks = flattenTasks(course).length;
  const planOf = (version) =>
    version?.readable
      ? disjoint(planGuideChanges(version.guide, course))
      : null;
  const planNow = planOf(measured);
  const planNext = planOf(upcoming);
  const result = (status, extra = {}) => ({ code, status, tasks, ...extra });
  const staying = (plan) =>
    tasks - plan.removed.length - plan.moved.length - plan.renameHints.length;

  if (upcoming?.readable) {
    if (!planNext.treeChanged)
      return result("current", {
        version: upcoming,
        ahead: Boolean(planNow?.treeChanged),
      });
    return result("upcoming", {
      version: upcoming,
      effective: { day: upcoming.asOf, basis: "stated" },
      plan: planNext,
      followsMeasured: planNow ? !planNow.treeChanged : null,
      staying: staying(planNext),
    });
  }
  if (!measured?.readable) return result("unknown");
  if (!planNow.treeChanged) return result("current", { version: measured });
  const stated = measured.asOf && !earlierThanPrevious;
  const day = stated ? measured.asOf : measured.firstSeen;
  return result("changed", {
    version: measured,
    effective: day ? { day, basis: stated ? "stated" : "seen" } : null,
    plan: planNow,
    staying: staying(planNow),
  });
}

/** A short fingerprint of what an issue says: it changes when the issue has to be rewritten, and with nothing else. */
export function fingerprintOf(result) {
  const p = result.plan;
  const data = {
    status: result.status,
    effective: result.effective ?? null,
    version: [result.version?.n ?? null, result.version?.asOf ?? null],
    followsMeasured: result.followsMeasured ?? null,
    added: p.added.map((t) => t.key),
    removed: p.removed.map((t) => t.key),
    moved: p.moved.map((m) => [m.from.key, m.to.key]),
    reworded: p.renameHints.map((h) => [h.from.key, h.to.key]),
    reordered: p.reordered,
    weights: p.weightChanges,
  };
  return createHash("sha1")
    .update(JSON.stringify(data))
    .digest("hex")
    .slice(0, 12);
}

const MARKER = /<!-- course-guide-watch:([0-9a-f]{12}) -->/;
/** The fingerprint an issue text carries, or null. */
export const fingerprintIn = (body) =>
  MARKER.exec(String(body ?? ""))?.[1] ?? null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (rows, line) => {
  const shown = rows.slice(0, LIST_LIMIT).map(line);
  if (rows.length > LIST_LIMIT)
    shown.push(`- ... and ${rows.length - LIST_LIMIT} more`);
  return shown.join("\n");
};

/** The sentence that says when the new skills count. */
export function whenSentence(result) {
  const e = result.effective;
  if (result.status === "upcoming")
    return `The new skills are measured from **${prettyDay(e.day)}**. They are not in effect yet: until that day the exam measures the skills of the version before.`;
  if (!e) return "The new skills are **in effect now**.";
  return e.basis === "stated"
    ? `The new skills are **in effect since ${prettyDay(e.day)}**.`
    : `The new skills are **in effect now**. The guide states no usable date; the hub first saw this version on ${prettyDay(e.day)}.`;
}

/**
 * The text of an exam's issue: when the new skills count, what changes for the course task by task, and what to do.
 * `result` is a checkCourse result with the status "upcoming" or "changed"; `course` is the course file.
 */
export function buildReport({
  result,
  course,
  siteUrl = "https://msfthub.com",
  runUrl = null,
}) {
  const { code, plan } = result;
  const slug = code.toLowerCase();
  const picks = picksByTask(course);
  const n = (key) => plural(picks.get(key) ?? 0, "pick");
  const builtFor = course.inputs?.guideAsOf
    ? `the skills measured as of ${course.inputs.guideAsOf}`
    : "a version of the guide that states no date";
  const upcoming = result.status === "upcoming";
  const counts = [
    plan.added.length &&
      `${plural(plan.added.length, "task")} ${plan.added.length === 1 ? "is" : "are"} new`,
    plan.removed.length &&
      `${plural(plan.removed.length, "task")} ${plan.removed.length === 1 ? "is" : "are"} gone`,
    plan.renameHints.length &&
      `${plural(plan.renameHints.length, "task")} ${plan.renameHints.length === 1 ? "looks" : "look"} reworded`,
    plan.moved.length &&
      `${plural(plan.moved.length, "task")} moved to another place in the guide`,
    plan.reordered && "the order of the tasks changed",
  ].filter(Boolean);
  const sections = [];
  if (plan.added.length)
    sections.push(
      `**New tasks (they need picks)**\n\n${listed(plan.added, (t) => `- ${t.text} _(${t.group})_`)}`,
    );
  if (plan.removed.length)
    sections.push(
      `**Tasks that are gone (their picks leave the course)**\n\n${listed(plan.removed, (t) => `- ${t.text} _(${t.group}; ${n(t.key)})_`)}`,
    );
  if (plan.renameHints.length)
    sections.push(
      `**Reworded, by the look of it (most of the words are the same: decide whether the picks carry over)**\n\n${listed(plan.renameHints, (h) => `- "${h.from.text}" is now "${h.to.text}" _(${Math.round(h.similarity * 100)}% of the words; ${n(h.from.key)})_`)}`,
    );
  if (plan.moved.length)
    sections.push(
      `**Moved (the same wording in another place: the picks carry over)**\n\n${listed(plan.moved, (m) => `- ${m.from.text}: from _${m.from.group}_ to _${m.to.group}_ _(${n(m.from.key)})_`)}`,
    );
  if (plan.weightChanges.length)
    sections.push(
      `**Weights (shown on the page, no pick depends on them)**\n\n${listed(plan.weightChanges, (w) => `- ${w.domain}: ${w.from ?? "none"} to ${w.to ?? "none"}`)}`,
    );

  const steps = [
    `1. \`node scripts/course-status.mjs ${code}\` prints this plan again, with what Learn changed for the picks since the course was built.`,
    `2. Run the chain of \`docs/course-playbook.md\` for the exam (candidates, judging, gates). The remembered decisions (\`src/data_files/course-decisions/${code}.json\`) are applied by themselves to every task whose key is unchanged, the hand-placed picks and pointer notes included (\`docs/course-gates.md\`).`,
    "3. A decision is remembered per task key, and a reworded or moved task has a new key: for each one listed above, copy the decisions that should carry over to the new key in the decisions file, and leave out what no longer fits.",
    `4. \`node scripts/course-build.mjs ${code}\`, move the result to \`src/data_files/courses/${code}.json\`, then \`node scripts/course-file.mjs validate ${code} --live\` and \`node scripts/course-file.mjs render ${code} --out src/content/docs/courses/${slug}.mdx\`.`,
    upcoming
      ? `5. **Do not replace the page before ${prettyDay(result.effective.day)}**: until then it must follow what the exam measures. Prepare the new version on a branch and merge it on that day.`
      : "5. Merge it as soon as it is ready: the page is behind the exam.",
  ];
  const notes = [];
  if (upcoming && result.followsMeasured === false)
    notes.push(
      "The course does not have the tasks of the version measured today either, so it is already behind.",
    );

  return [
    `<!-- course-guide-watch:${fingerprintOf(result)} -->`,
    `The study guide of **${code}** measures other skills than the hub's course follows.`,
    "",
    `- ${whenSentence(result)}`,
    `- The course ([${siteUrl}/certs/courses/${slug}/](${siteUrl}/certs/courses/${slug}/)) was built for ${builtFor}.`,
    `- Every difference between the versions, word for word: [${code} Study Guide Changes](${siteUrl}/certs/changelog/${slug}/).`,
    ...notes.map((note) => `- ${note}`),
    "",
    "### What changes for the course",
    "",
    `${counts.join(", ")}. ${plural(Math.max(result.staying, 0), "task")} of ${result.tasks} ${result.staying === 1 ? "stays" : "stay"} as ${result.staying === 1 ? "it is" : "they are"}.`,
    "",
    sections.join("\n\n"),
    "",
    "### What to do",
    "",
    steps.join("\n"),
    "",
    "This issue is rewritten when what it says changes (the day comes, Microsoft changes the guide again, a part of the course is updated) and closes itself once the course has the tasks of the newest version.",
    runUrl ? `\nRun: ${runUrl}` : "",
  ]
    .join("\n")
    .trimEnd();
}

/**
 * What a run has to do with the issue of one exam, read-only:
 *   { action: "create" | "update" | "keep" | "close" | "none", number?, body? }
 * "keep" is an open issue that already says what the report says; "none" is nothing to say and nothing open.
 */
export function planIssue({ gh, result, report }) {
  const title = issueTitle(result.code);
  const wanted = result.status === "upcoming" || result.status === "changed";
  const open = listOpenIssues(gh, {
    title,
    label: ISSUE_LABEL,
    body: wanted,
  });
  if (!wanted) return { action: open.length ? "close" : "none" };
  if (open.length === 0) return { action: "create", body: report };
  const same = fingerprintIn(open[0].body) === fingerprintIn(report);
  return {
    action: same ? "keep" : "update",
    number: open[0].number,
    body: report,
  };
}

/** Carry out a planIssue step. Returns { action, number? }; a `gh` failure throws. */
export function applyIssue({ gh, result, step, today, runUrl = null }) {
  const title = issueTitle(result.code);
  const run = runUrl ? `\n\nRun: ${runUrl}` : "";
  if (step.action === "create") {
    ensureLabel(gh, ISSUE_LABEL, LABEL_LOOK);
    const out = gh(
      [
        "issue",
        "create",
        "--title",
        title,
        "--label",
        ISSUE_LABEL,
        "--body-file",
        "-",
      ],
      step.body,
    );
    return {
      action: "created",
      number: Number(out.match(/\/issues\/(\d+)/)?.[1]) || null,
    };
  }
  if (step.action === "update") {
    gh(["issue", "edit", String(step.number), "--body-file", "-"], step.body);
    gh(
      ["issue", "comment", String(step.number), "--body-file", "-"],
      `The text of this issue was rewritten on ${prettyDay(today)}, because what it has to say changed. ${whenSentence(result)}${run}`,
    );
    return { action: "updated", number: step.number };
  }
  if (step.action === "close") {
    const { closed, failures } = closeOpenIssues({
      gh,
      title,
      label: ISSUE_LABEL,
      comment: `The course has the tasks of the newest version of the study guide as of ${prettyDay(today)}, so there is nothing left to do.${run}`,
    });
    if (failures.length)
      throw new Error(
        `Could not close the issue of ${result.code}: ${failures.join("; ")}`,
      );
    return { action: "closed", closed };
  }
  return { action: step.action, number: step.number };
}

const STATUS_TEXT = {
  current: "follows the newest version",
  upcoming: "the skills change",
  changed: "the skills changed",
  unknown: "no version of the guide can be read",
};

/** One line of the run's report for a course. */
export function describe(result) {
  const when =
    result.status === "upcoming"
      ? ` on ${prettyDay(result.effective.day)}`
      : result.status === "changed" && result.effective
        ? ` (${result.effective.basis === "stated" ? "in effect since" : "first seen on"} ${prettyDay(result.effective.day)})`
        : "";
  const p = result.plan;
  const what = p
    ? `: ${p.added.length} new, ${p.removed.length} gone, ${p.renameHints.length} reworded, ${p.moved.length} moved`
    : result.ahead
      ? " (it already has the tasks of a version that is not in effect yet)"
      : "";
  return `${result.code}: ${STATUS_TEXT[result.status]}${when}${what}`;
}

/** Read every course with its history. Returns { rows: [{ course, history, stored }], problems: [text] }. */
export function readCourses({ coursesDir, historyDir, examsFile }) {
  const problems = [];
  const rows = [];
  let stored = new Map();
  if (examsFile && existsSync(examsFile)) {
    try {
      const tracker = JSON.parse(readFileSync(examsFile, "utf8"));
      stored = new Map(
        (tracker.studyGuides ?? [])
          .filter((g) => Array.isArray(g.lines))
          .map((g) => [g.code, g.lines]),
      );
    } catch (error) {
      problems.push(`${examsFile} cannot be read: ${error.message}`);
    }
  }
  if (!existsSync(coursesDir)) return { rows, problems };
  for (const name of readdirSync(coursesDir).sort()) {
    if (!/^[A-Z]{2,3}-\d{3}\.json$/.test(name)) continue;
    const file = join(coursesDir, name);
    let course;
    try {
      course = JSON.parse(readFileSync(file, "utf8"));
      if (
        course?.code !== name.replace(".json", "") ||
        !Array.isArray(course.domains)
      )
        throw new Error("it is not a course file of that exam");
    } catch (error) {
      problems.push(`${file} cannot be read: ${error.message}`);
      continue;
    }
    let history;
    try {
      history = readHistory(historyDir, course.code);
    } catch (error) {
      problems.push(
        `The study guide history of ${course.code} cannot be read: ${error.message}`,
      );
      continue;
    }
    rows.push({ course, history, stored: stored.get(course.code) ?? null });
  }
  return { rows, problems };
}

export function main(env = process.env) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);
  const now = new Date(`${today}T12:00:00Z`);
  const siteUrl = (env.SITE_URL || "https://msfthub.com").replace(/\/$/, "");
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  const fail = (message) => {
    if (env.ERROR_FILE)
      writeFileSync(
        env.ERROR_FILE,
        `The Course Guide Watch stopped and changed no issue.\n\n${message}\n${runUrl ? `\nRun: ${runUrl}\n` : ""}`,
      );
    writeOutput(env.GITHUB_OUTPUT, { check_failed: "true" });
    throw new Error(message);
  };

  const { rows, problems } = readCourses({
    coursesDir: env.COURSES_DIR || "src/data_files/courses",
    historyDir: env.HISTORY_DIR || "src/data_files/study-guide-history",
    examsFile: env.LEARN_EXAMS_FILE || "src/data_files/learn-exams.json",
  });
  const results = rows.map(({ course, history, stored }) => ({
    course,
    result: checkCourse({ course, history, stored, now }),
  }));
  const changed = results.filter(({ result }) =>
    ["upcoming", "changed"].includes(result.status),
  );
  const lines = [
    `Course Guide Watch, ${prettyDay(today)}: ${plural(results.length, "course")}, ${changed.length} with other skills than their guide.`,
    "",
    ...results
      .filter(({ result }) => result.status !== "current" || result.ahead)
      .map(({ result }) => `- ${describe(result)}`),
  ];
  const report = lines.join("\n").trimEnd();
  console.log(report);
  if (env.REPORT_FILE) writeFileSync(env.REPORT_FILE, `${report}\n`);
  appendStepSummary(
    env.GITHUB_STEP_SUMMARY,
    `### Course Guide Watch\n\n${report}\n`,
  );

  // a file that cannot be read is never "nothing changed": the run stops before it touches an issue
  if (problems.length) fail(problems.join("\n"));

  if (env.DRY_RUN === "1" || env.CREATE_ISSUES !== "1") {
    for (const { course, result } of changed)
      console.log(
        `\n----- ${issueTitle(result.code)} -----\n${buildReport({ result, course, siteUrl, runUrl })}`,
      );
    console.log(
      `\nNot touching GitHub (${env.DRY_RUN === "1" ? "DRY_RUN" : "CREATE_ISSUES is not 1"}).`,
    );
    writeOutput(env.GITHUB_OUTPUT, {
      check_failed: "false",
      changed: String(changed.length),
    });
    return { action: "dry-run", results: results.map((r) => r.result) };
  }

  const gh = makeGh({ ghCliScript: env.GH_CLI_SCRIPT });
  let steps;
  try {
    steps = results
      .filter(({ result }) => result.status !== "unknown")
      .map(({ course, result }) => ({
        result,
        step: planIssue({
          gh,
          result,
          report: result.plan
            ? buildReport({ result, course, siteUrl, runUrl })
            : null,
        }),
      }));
  } catch (error) {
    return fail(`The open issues cannot be read: ${error.message}`);
  }
  const limit = Number(env.COURSE_GUIDE_WATCH_MAX_NEW) || MAX_NEW_ISSUES;
  const creating = steps.filter(({ step }) => step.action === "create");
  if (creating.length > limit && env.FORCE !== "1")
    fail(
      `${creating.length} courses would get a new issue in one run (${creating.map(({ result }) => result.code).join(", ")}), more than the ${limit} that are believed. A change in how the study guides are read touches every course at once: look at one of them (\`node scripts/course-status.mjs <CODE>\`). When the changes are real, run the workflow by hand with "force" ticked.`,
    );

  const done = [];
  try {
    for (const { result, step } of steps) {
      const outcome = applyIssue({ gh, result, step, today, runUrl });
      done.push({ code: result.code, ...outcome });
      if (!["none", "keep"].includes(outcome.action))
        console.log(
          `Issue "${issueTitle(result.code)}": ${outcome.action}${outcome.number ? ` (#${outcome.number})` : ""}.`,
        );
    }
  } catch (error) {
    return fail(error.message);
  }
  writeOutput(env.GITHUB_OUTPUT, {
    check_failed: "false",
    changed: String(changed.length),
  });
  return { action: "done", results: results.map((r) => r.result), done };
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
