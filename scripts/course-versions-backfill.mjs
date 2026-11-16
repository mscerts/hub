#!/usr/bin/env node
/**
 * Record, in every course file, which version of its study guide the course follows (inputs.guideVersion).
 *
 *   node scripts/course-versions-backfill.mjs            says what it would write
 *   node scripts/course-versions-backfill.mjs --write    writes it
 *
 * A course names the version in the history of its guide (src/data_files/study-guide-history/<CODE>.json) so it
 * can be checked against that version and not against the live page, which may already carry an upcoming one
 * (docs/courses.md, "The two versions"). The version is found by the tasks: of the versions with the course's
 * tasks, the newest one the hub had seen on the day the course was built. A course that no version matches is
 * reported and left alone (it is out of date, or its history is missing); one that names a version already is
 * not touched. The files are written the way the course builder writes them.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  builtForVersion,
  versionRef,
  withVersion,
} from "./lib/course-version.mjs";
import { readHistory } from "./lib/guide-history.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What to do with each course of a folder: [{ code, file, action, ref? }] where action is "set", "already",
 * "no-match" or "no-history". `course` is the parsed file; nothing is written here.
 */
export function plan({ coursesDir, historyDir }) {
  const rows = [];
  for (const name of readdirSync(coursesDir).sort()) {
    if (!/^[A-Z]{2,3}-\d{3}\.json$/.test(name)) continue;
    const file = join(coursesDir, name);
    const course = JSON.parse(readFileSync(file, "utf8"));
    if (course.inputs?.guideVersion !== undefined) {
      rows.push({ code: course.code, file, course, action: "already" });
      continue;
    }
    let history = null;
    try {
      history = readHistory(historyDir, course.code);
    } catch {
      history = null;
    }
    if (!history?.versions?.length) {
      rows.push({ code: course.code, file, course, action: "no-history" });
      continue;
    }
    const version = builtForVersion(history, course);
    rows.push(
      version
        ? {
            code: course.code,
            file,
            course,
            action: "set",
            ref: versionRef(version),
          }
        : { code: course.code, file, course, action: "no-match" },
    );
  }
  return rows;
}

export function main(
  argv,
  { log = console.log, error = console.error, root = repoRoot } = {},
) {
  const write = argv.includes("--write");
  const unknown = argv.filter((a) => a !== "--write");
  if (unknown.length) {
    error(`Unknown option ${unknown[0]}`);
    return 2;
  }
  const coursesDir = join(root, "src", "data_files", "courses");
  const historyDir = join(root, "src", "data_files", "study-guide-history");
  if (!existsSync(coursesDir)) {
    log("No course files: nothing to do.");
    return 0;
  }
  const rows = plan({ coursesDir, historyDir });
  for (const row of rows) {
    if (row.action === "set") {
      const { n, asOf, firstSeen } = row.ref;
      log(
        `${row.code}: version ${n} (as of ${asOf ?? "not stated"}, first seen ${firstSeen})`,
      );
      if (write)
        writeFileSync(
          row.file,
          `${JSON.stringify(withVersion(row.course, row.ref), null, 2)}\n`,
        );
    } else if (row.action === "already")
      log(`${row.code}: already names a version`);
    else if (row.action === "no-history")
      log(`${row.code}: no study guide history, left alone`);
    else
      log(
        `${row.code}: no recorded version has the course's tasks, left alone (the course is out of date)`,
      );
  }
  const count = (a) => rows.filter((r) => r.action === a).length;
  log(
    `\n${rows.length} courses: ${count("set")} ${write ? "written" : "to write"}, ${count("already")} already named, ${count("no-match")} without a matching version, ${count("no-history")} without history.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
