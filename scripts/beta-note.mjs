#!/usr/bin/env node
/**
 * Writes the beta exam note of an exam page: the `:::note` box with the beta
 * timeline that goes directly after the beta `:::tip` (AGENTS.md, "Beta Exam
 * Pages"). The dates are calculated from the day the beta period began and the
 * wording follows the state of the Skills Hub announcement. Nothing is fetched
 * and nothing is written: the note (or the dates) go to stdout, and nothing else
 * does, so the output can be piped or pasted into the page.
 *
 * Usage:
 *   node scripts/beta-note.mjs --code AZ-401 [--expects "<go-live wording>"]
 *       The note for the entry with that code in src/data_files/beta-exams.json:
 *       its `betaStart` and `announcement` ("pending", "unannounced" or the URL).
 *   node scripts/beta-note.mjs --start 2026-10-14 --state pending
 *   node scripts/beta-note.mjs --start 2026-10-14 --state unannounced
 *   node scripts/beta-note.mjs --start 2026-07-28 --state announced \
 *        --announcement-url <https URL> [--expects "<go-live wording>"]
 *       The note for a beta start and a state, without reading the tracker.
 *   node scripts/beta-note.mjs --timeline --start 2026-10-14
 *   node scripts/beta-note.mjs --timeline --code AZ-401
 *       The calculated dates as four lines: go-live from/to, scores from/to.
 *
 * --expects is Microsoft's own go-live wording from the announcement, only for
 * an announced note: a fragment that continues "Microsoft's announcement
 * expects ...", for example "general availability of this certification in
 * October 2026", without a final period. Without it the note only says that
 * Microsoft announced the exam.
 *
 * Environment: BETA_EXAMS_FILE (the tracker, default
 * src/data_files/beta-exams.json; a relative path starts at the repository root).
 *
 * Exit code: 0, or 1 with `ERROR: <message>` on stderr (and nothing on stdout)
 * for bad input: an unknown code, a missing or invalid betaStart or
 * announcement, an invalid date, options that do not fit together.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BETA_NOTE_STATES,
  betaTimeline,
  buildBetaNote,
} from "./lib/beta-note.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TRACKER = "src/data_files/beta-exams.json";

export const USAGE = `Usage:
  node scripts/beta-note.mjs --code <CODE> [--expects "<go-live wording>"]
  node scripts/beta-note.mjs --start <YYYY-MM-DD> --state pending|unannounced
  node scripts/beta-note.mjs --start <YYYY-MM-DD> --state announced --announcement-url <https URL> [--expects "<go-live wording>"]
  node scripts/beta-note.mjs --timeline (--start <YYYY-MM-DD> | --code <CODE>)`;

export class UsageError extends Error {}

const VALUE_OPTIONS = new Map([
  ["--code", "code"],
  ["--start", "start"],
  ["--state", "state"],
  ["--announcement-url", "announcementUrl"],
  ["--expects", "expects"],
]);
const SWITCHES = new Map([
  ["--timeline", "timeline"],
  ["--help", "help"],
  ["-h", "help"],
]);

/** { code, start, state, announcementUrl, expects, timeline, help } from the argument list. */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (SWITCHES.has(flag)) {
      if (equals >= 0) throw new UsageError(`${flag} takes no value.`);
      options[SWITCHES.get(flag)] = true;
    } else if (VALUE_OPTIONS.has(flag)) {
      const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
      if (!value || (equals < 0 && value.startsWith("--"))) {
        throw new UsageError(`${flag} needs a value.`);
      }
      options[VALUE_OPTIONS.get(flag)] = value;
    } else {
      throw new UsageError(`Unknown option ${arg}.`);
    }
  }
  return options;
}

/** Hands the tracker entry with this code to `build`; every problem is reported as "<CODE> in <file>: ...". */
function fromTracker(code, env, build) {
  const shown = env.BETA_EXAMS_FILE || DEFAULT_TRACKER;
  const file = isAbsolute(shown) ? shown : join(root, shown);
  let tracker;
  try {
    tracker = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      error.code === "ENOENT"
        ? `The tracker file ${shown} does not exist.`
        : `The tracker file ${shown} is not valid JSON: ${error.message}`,
    );
  }
  if (!Array.isArray(tracker?.exams)) {
    throw new Error(`The tracker file ${shown} has no "exams" array.`);
  }
  const wanted = code.trim().toUpperCase();
  const entry = tracker.exams.find(
    (exam) => String(exam?.code).toUpperCase() === wanted,
  );
  if (!entry) {
    const known = tracker.exams.map((exam) => exam?.code).filter(Boolean);
    throw new Error(
      `No beta exam ${wanted} in ${shown} (it lists ${known.length > 0 ? known.join(", ") : "no exams"}).`,
    );
  }
  try {
    return build(entry);
  } catch (error) {
    throw new Error(`${wanted} in ${shown}: ${error.message}`);
  }
}

function betaStartOf(entry) {
  if (!entry.betaStart) {
    throw new Error(
      "no betaStart: add the day the beta period began (YYYY-MM-DD, from the official beta announcement or the exam's Microsoft Learn page; never guess it)",
    );
  }
  return entry.betaStart;
}

function announcementOf(entry) {
  if (!entry.announcement) {
    throw new Error(
      'no announcement: set "pending", "unannounced" or the URL of the announcement',
    );
  }
  return entry.announcement;
}
function timelineLines(start) {
  const timeline = betaTimeline(start);
  return [
    `go-live from: ${timeline.goLiveFromText}`,
    `go-live to: ${timeline.goLiveToText}`,
    `scores from: ${timeline.scoresFromText}`,
    `scores to: ${timeline.scoresToText}`,
  ].join("\n");
}

/** The text to print for an argument list; throws for bad input. */
export function run(argv, env = process.env) {
  const options = parseArgs(argv);
  if (options.help) return USAGE;
  const { code, start, state, announcementUrl, expects, timeline } = options;

  if (timeline) {
    if (
      state !== undefined ||
      announcementUrl !== undefined ||
      expects !== undefined
    ) {
      throw new UsageError("--timeline only takes --start or --code.");
    }
    if ((start === undefined) === (code === undefined)) {
      throw new UsageError(
        "--timeline needs --start <YYYY-MM-DD> or --code <CODE> (one of them).",
      );
    }
    return code === undefined
      ? timelineLines(start)
      : fromTracker(code, env, (entry) => timelineLines(betaStartOf(entry)));
  }

  if (code !== undefined) {
    if (
      start !== undefined ||
      state !== undefined ||
      announcementUrl !== undefined
    ) {
      throw new UsageError(
        "--code reads the start and the announcement from the tracker: do not combine it with --start, --state or --announcement-url.",
      );
    }
    return fromTracker(code, env, (entry) =>
      buildBetaNote({
        start: betaStartOf(entry),
        announcement: announcementOf(entry),
        expects,
      }),
    );
  }

  if (start === undefined || state === undefined) {
    throw new UsageError(
      "Give --code <CODE>, or --start <YYYY-MM-DD> with --state.",
    );
  }
  if (!BETA_NOTE_STATES.includes(state)) {
    throw new UsageError(
      `--state must be one of ${BETA_NOTE_STATES.join(", ")} (got "${state}").`,
    );
  }
  if (state === "announced" && announcementUrl === undefined) {
    throw new UsageError("--state announced needs --announcement-url <URL>.");
  }
  if (state !== "announced" && announcementUrl !== undefined) {
    throw new UsageError(
      "--announcement-url only goes with --state announced.",
    );
  }
  return buildBetaNote({
    start,
    announcement: state === "announced" ? announcementUrl : state,
    expects,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `ERROR: ${error.message}${error instanceof UsageError ? `\n${USAGE}` : ""}`,
    );
    process.exitCode = 1;
  }
}
