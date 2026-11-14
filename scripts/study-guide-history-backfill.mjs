#!/usr/bin/env node
/**
 * Builds the study guide history (src/data_files/study-guide-history/) from the git history of
 * src/data_files/learn-exams.json: every commit of the New Exam Monitor's tracker holds the guide text
 * of that day, so replaying them oldest to newest, with the day of each commit as "the day we saw it",
 * gives every version the monitor has ever seen. Run it once to seed the history (and again only to
 * rebuild it from scratch); from then on the New Exam Monitor keeps the files current.
 * Runbook: docs/study-guide-changes.md.
 *
 *   node scripts/study-guide-history-backfill.mjs [--ref origin/main] [--dir <folder>] [--write]
 *
 * Without --write nothing is written: the summary shows what would be. The files of the exams it
 * finds are replaced; files of other exams stay.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyHistory,
  recordVersion,
  writeHistory,
} from "./lib/guide-history.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER = "src/data_files/learn-exams.json";

/**
 * Replay trackers, oldest first. `commits` is `[{ day, tracker }]` (`tracker` is the parsed
 * learn-exams.json). Returns `Map<code, history>` and the list of events (`{ day, code, kind, n }`).
 */
export function replayCommits(commits) {
  const histories = new Map();
  const events = [];
  for (const { day, tracker } of commits) {
    for (const guide of tracker?.studyGuides ?? []) {
      if (!guide?.code || !Array.isArray(guide.lines) || !guide.hash) continue;
      const before = histories.get(guide.code) ?? emptyHistory(guide.code);
      const { history, event } = recordVersion(before, guide.lines, day);
      if (!event) continue;
      histories.set(guide.code, history);
      events.push({ day, code: guide.code, ...event });
    }
  }
  return { histories, events };
}

/** The commits that touched the tracker on `ref`, oldest first, with the parsed tracker of each. */
export function readTrackerCommits({ ref = "HEAD", cwd = root } = {}) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const log = git([
    "log",
    ref,
    "--reverse",
    "--format=%H %cI",
    "--",
    TRACKER,
  ]).trim();
  if (!log) return [];
  const commits = [];
  for (const row of log.split("\n")) {
    const [hash, committed] = row.split(" ");
    let tracker;
    try {
      tracker = JSON.parse(git(["show", `${hash}:${TRACKER}`]));
    } catch {
      continue; // a commit whose tracker is not valid JSON has no guides to read
    }
    commits.push({
      day: new Date(committed).toISOString().slice(0, 10),
      hash,
      tracker,
    });
  }
  return commits;
}

function main(argv) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const ref = arg("--ref", "HEAD");
  const dir = resolve(root, arg("--dir", "src/data_files/study-guide-history"));
  const write = argv.includes("--write");

  const commits = readTrackerCommits({ ref });
  const { histories, events } = replayCommits(commits);
  console.log(
    `${commits.length} tracker commits on ${ref} (${commits[0]?.day ?? "-"} to ${commits.at(-1)?.day ?? "-"}), ${histories.size} guides, ${events.length} recorded events.`,
  );
  const multi = [...histories.values()].filter((h) => h.versions.length > 1);
  console.log(`${multi.length} guides have more than one version:`);
  for (const history of multi)
    console.log(
      `  ${history.code}: ${history.versions
        .map((v) => `v${v.n} ${v.asOf ?? "undated"} (seen ${v.firstSeen})`)
        .join(
          " > ",
        )}${history.versions.some((v) => v.corrections) ? " [corrected]" : ""}`,
    );
  if (!write) {
    console.log("Dry run: nothing written. Add --write to write the files.");
    return;
  }
  for (const history of histories.values()) writeHistory(dir, history);
  console.log(`Wrote ${histories.size} files to ${dir}.`);
  if (existsSync(join(dir, "..", "learn-exams.json")))
    console.log(
      "Review them (git diff), then commit src/data_files/study-guide-history/.",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
