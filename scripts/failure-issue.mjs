#!/usr/bin/env node
/**
 * One failure issue per problem instead of one per failed run.
 *
 * The monitors whose workflows used to open "<Monitor> Failed — <run id>" made a
 * new bug issue for every failing run: a check that fails every 6 hours (a tracker
 * that needs a force_baseline, a failsafe that stays tripped) filled the issue list
 * with 4 issues a day, and a study guide check that stays stopped with one a day.
 * The monitors that look after their own issues (Retiring Exam Monitor, Voucher
 * Review Monitor, Lab Repo Check, Source Watch) use ONE issue with a stable title, a
 * comment for every further failed run, and close it after the next healthy run.
 * This script does the same for the workflows that only have a message file, with
 * the `gh` CLI and nothing else:
 *
 *   node scripts/failure-issue.mjs raise --title "<title>" --file <message.md> \
 *        [--label bug] [--repeat-hours 24]
 *       No open issue with exactly this title and label: create the label when the
 *       repository lacks it (`gh issue create --label` fails for a missing one),
 *       then the issue with the message. One is open: add the message as a
 *       comment, unless the issue had activity within --repeat-hours (default 0 =
 *       always comment), so a check that fails every 6 hours does not add 4
 *       comments a day. With several open copies only the oldest gets the comment.
 *
 *   node scripts/failure-issue.mjs clear --title "<title>" --comment "<text>" \
 *        [--label bug]
 *       Close every open issue with exactly this title and label, with the
 *       comment. Nothing open: nothing to do.
 *
 * The create-or-comment and close-every-copy steps are the two functions
 * raiseIssue and closeOpenIssues, which scripts/source-watch.mjs uses for its
 * running issues as well: only the wording and what a stuck close means differ
 * (here it is an error, so the step is red; there it is reported and the run goes
 * on).
 *
 * Environment: GH_TOKEN (the job token; `issues: write`), TODAY (YYYY-MM-DD, tests),
 * GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (a link to the run),
 * DRY_RUN=1 (print what would be done, touch nothing), GH_CLI_SCRIPT (tests only: a
 * Node script run instead of the `gh` CLI). No assignee is ever set.
 *
 * Exit code: 0 when the issue is in the wanted state (or DRY_RUN), 1 when `gh`
 * failed or the arguments are wrong. A failing `raise` is a red step in a run that
 * is red anyway; a failing `clear` is red too, so a stuck issue is seen, and the
 * next healthy run tries again.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ensureLabel, listOpenIssues, makeGh } from "./lib/gh.mjs";

// The text of an issue or comment may not pass this many characters (GitHub
// rejects 65,536); the message of a failure is cut well below it.
export const MAX_BODY_CHARS = 60000;

// How a label looks when it has to be created: GitHub's own `bug` label.
const LABEL_LOOKS = {
  bug: { color: "d73a4a", description: "Something isn't working" },
};

export class UsageError extends Error {}

/** { command, title, label, file, comment, repeatHours } from the argument list. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "raise" && command !== "clear") {
    throw new UsageError(
      'The first argument must be "raise" or "clear" (see the header of scripts/failure-issue.mjs).',
    );
  }
  const options = { command, label: "bug", repeatHours: 0 };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value.`);
    if (flag === "--title") options.title = value;
    else if (flag === "--label") options.label = value;
    else if (flag === "--file") options.file = value;
    else if (flag === "--comment") options.comment = value;
    else if (flag === "--repeat-hours") {
      const hours = Number(value);
      if (!Number.isFinite(hours) || hours < 0) {
        throw new UsageError(
          "--repeat-hours must be a number of hours (0 or more).",
        );
      }
      options.repeatHours = hours;
    } else throw new UsageError(`Unknown option ${flag}.`);
  }
  if (!options.title?.trim()) throw new UsageError("--title is required.");
  if (command === "raise" && !options.file) {
    throw new UsageError("raise needs --file (the message of the failure).");
  }
  if (command === "clear" && !options.comment) {
    throw new UsageError("clear needs --comment (why the issue is closed).");
  }
  return options;
}

const runLine = (runUrl) => (runUrl ? `\n\nRun: ${runUrl}` : "");

const clip = (text) =>
  text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n\n_(cut: the message was longer than an issue may be)_`
    : text;

/**
 * Create the issue (after its label: `gh issue create --label` fails for a label
 * the repository does not have) with `body`, or add `commentBody` as a comment to
 * the oldest open issue with exactly this title and label. With `repeatHours` an
 * issue that had activity within that many hours is left alone. The label looks
 * like GitHub's own `bug` label when it has to be created (`labelColor` and
 * `labelDescription` name another look). Returns
 * { action: "created" | "commented" | "quiet", number }; every gh failure throws.
 */
export function raiseIssue({
  gh,
  title,
  label = "bug",
  labelColor,
  labelDescription,
  body,
  commentBody,
  repeatHours = 0,
  now = Date.now(),
}) {
  const open = listOpenIssues(gh, { title, label });
  if (open.length === 0) {
    const looks = LABEL_LOOKS[label] ?? {};
    ensureLabel(gh, label, {
      color: labelColor ?? looks.color,
      description: labelDescription ?? looks.description,
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
    return {
      action: "created",
      number: Number(out.match(/\/issues\/(\d+)/)?.[1]) || null,
    };
  }
  const number = open[0].number;
  if (repeatHours > 0) {
    const view = JSON.parse(
      gh(["issue", "view", String(number), "--json", "updatedAt"]) || "{}",
    );
    const last = Date.parse(view.updatedAt ?? "");
    if (Number.isFinite(last) && now - last < repeatHours * 3600 * 1000) {
      return { action: "quiet", number };
    }
  }
  gh(["issue", "comment", String(number), "--body-file", "-"], commentBody);
  return { action: "commented", number };
}

/**
 * Close every open issue with exactly this title and label, with the comment.
 * Returns { found, closed: [numbers], failures: [messages] }: a copy that cannot
 * be closed does not stop the others, and what to make of it is for the caller.
 * Throws when the issues cannot be listed.
 */
export function closeOpenIssues({ gh, title, label = "bug", comment }) {
  const open = listOpenIssues(gh, { title, label });
  const closed = [];
  const failures = [];
  for (const issue of open) {
    try {
      gh(["issue", "close", String(issue.number), "--comment", comment]);
      closed.push(issue.number);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return { found: open.length, closed, failures };
}

/**
 * Create the failure issue, or comment on the oldest open one. Returns
 * { action: "created" | "commented" | "quiet", number }.
 */
export function raiseFailureIssue({
  gh,
  title,
  label = "bug",
  message,
  today,
  runUrl = null,
  repeatHours = 0,
  now = Date.now(),
}) {
  const text = message.trim();
  return raiseIssue({
    gh,
    title,
    label,
    repeatHours,
    now,
    body: clip(
      `${text}${runLine(runUrl)}\n\nThis issue gets one comment for a further failed run and closes itself after the next healthy run.`,
    ),
    commentBody: clip(
      `It failed again on ${today}:\n\n${text}${runLine(runUrl)}`,
    ),
  });
}

/** Close every open copy with the comment. Returns { action: "closed" | "none", closed: [numbers] }. */
export function clearFailureIssue({
  gh,
  title,
  label = "bug",
  comment,
  runUrl = null,
}) {
  const { found, closed, failures } = closeOpenIssues({
    gh,
    title,
    label,
    comment: `${comment}${runLine(runUrl)}`,
  });
  if (failures.length > 0) {
    throw new Error(
      `Could not close ${failures.length} of ${found} open copies: ${failures.join("; ")}`,
    );
  }
  return { action: closed.length ? "closed" : "none", closed };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(env.TODAY ?? "")
    ? env.TODAY
    : new Date().toISOString().slice(0, 10);
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  if (env.DRY_RUN === "1") {
    console.log(
      `DRY_RUN: would ${options.command} the issue "${options.title}" (${options.label}); no issue is touched.`,
    );
    return { action: "dry-run" };
  }
  const gh = makeGh({ ghCliScript: env.GH_CLI_SCRIPT });
  if (options.command === "raise") {
    const message = readFileSync(options.file, "utf8");
    const result = raiseFailureIssue({
      gh,
      title: options.title,
      label: options.label,
      message,
      today,
      runUrl,
      repeatHours: options.repeatHours,
    });
    console.log(
      `Issue "${options.title}": ${result.action}${result.number ? ` (#${result.number})` : ""}.`,
    );
    return result;
  }
  const result = clearFailureIssue({
    gh,
    title: options.title,
    label: options.label,
    comment: options.comment,
    runUrl,
  });
  console.log(
    `Issue "${options.title}": ${result.action}${result.closed.length ? ` (#${result.closed.join(", #")})` : ""}.`,
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
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
