/**
 * Study guide version history: the store behind the "Study Guide Changes" pages.
 * Pure rules plus a small file layer. Runbook: docs/study-guide-changes.md.
 *
 * One file per exam, `src/data_files/study-guide-history/<CODE>.json`, holds every version of the
 * exam's study guide the New Exam Monitor has seen. The input is the guide text the monitor already
 * stores (`studyGuides[].lines` of src/data_files/learn-exams.json): one string per line, headings as
 * `## Title`, bullets as `- text`.
 *
 * What a version is
 * - The version live on Microsoft's page is the FIRST "## Skills measured ..." section of the guide.
 *   A page can carry a second one ("## Skills measured prior to <date>"); that is Microsoft's own
 *   previous version, kept as `priorOnPage` of the version that carried it.
 * - A version is identified by the date the guide shows ("Skills measured as of October 14, 2026"),
 *   because that is what a visitor sees. `asOf` is that date as YYYY-MM-DD, or null when the heading
 *   states none (21 of the 57 guides in October 2026). `firstSeen` is the day we first saw the
 *   version (UTC).
 * - Only the skills part is kept (audience profile, skills at a glance, domains, groups, tasks).
 *   Notices and "Updates to the exam" are left out: the change pages do not show them.
 *
 * What a change is (`recordVersion`)
 * - the same text again: nothing happens;
 * - a different `asOf` (also when only the date changed): a new version, appended;
 * - the same `asOf` but different text: a correction of that version, made in place, and the lines
 *   it had are kept in `corrections` so History can still show the edit;
 * - two undated versions are never "the same date", so every text change of an undated guide is a
 *   new version.
 * An `asOf` EARLIER than the previous version's is still a new version: the page wins, whatever the
 * dates say (DP-750 and DP-800 went from "October 19, 2026" to "March 11/12, 2026" on 2026-10-29).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const HISTORY_SCHEMA_VERSION = 1;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const SKILLS_HEADING = /^## Skills measured\b/;

/** "Skills measured as of October 14, 2026" -> "2026-10-14"; a heading without a date -> null. */
export function asOfOfHeading(heading) {
  const match = String(heading).match(
    /\bas of\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month === -1) return null;
  const day = Number(match[2]);
  const date = new Date(Date.UTC(Number(match[3]), month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * The sections of a stored guide: `[{ heading, lines }]`, one per "## Skills measured ..." heading,
 * `lines` starting with the heading. The first is the live version.
 */
export function skillsSections(lines) {
  if (!Array.isArray(lines)) return [];
  const starts = [];
  lines.forEach((line, index) => {
    if (SKILLS_HEADING.test(line)) starts.push(index);
  });
  return starts.map((start, i) => {
    const slice = lines.slice(start, starts[i + 1] ?? lines.length);
    return { heading: slice[0].replace(/^## /, ""), lines: slice };
  });
}

const sameLines = (a, b) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/** An empty history for an exam. */
export function emptyHistory(code) {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, code, versions: [] };
}

function newVersion(n, section, prior, today) {
  const version = {
    n,
    asOf: asOfOfHeading(section.heading),
    firstSeen: today,
    lines: section.lines,
  };
  if (prior)
    version.priorOnPage = {
      asOf: asOfOfHeading(prior.heading),
      lines: prior.lines,
    };
  return version;
}

/**
 * Record the guide as it is today. Returns `{ history, event }`: `event` is null when nothing
 * changed, else `{ kind: "first" | "new" | "corrected", n }`. The input is not modified.
 */
export function recordVersion(history, lines, today) {
  const [live, prior] = skillsSections(lines);
  if (!live) return { history, event: null };
  const next = structuredClone(history);
  const latest = next.versions.at(-1);

  if (!latest) {
    next.versions.push(newVersion(1, live, prior, today));
    return { history: next, event: { kind: "first", n: 1 } };
  }
  if (sameLines(latest.lines, live.lines)) return { history, event: null };

  const asOf = asOfOfHeading(live.heading);
  if (latest.asOf !== null && asOf === latest.asOf) {
    (latest.corrections ??= []).push({ day: today, before: latest.lines });
    latest.lines = live.lines;
    if (prior)
      latest.priorOnPage = {
        asOf: asOfOfHeading(prior.heading),
        lines: prior.lines,
      };
    return { history: next, event: { kind: "corrected", n: latest.n } };
  }

  const version = newVersion(latest.n + 1, live, prior, today);
  next.versions.push(version);
  return { history: next, event: { kind: "new", n: version.n } };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const historyFileName = (code) => `${code}.json`;

/** JSON with every `lines` array on one row per line, so a git diff of a version change is readable. */
export function serializeHistory(history) {
  const lineArray = (lines, indent) =>
    `[\n${lines.map((line) => `${indent}  ${JSON.stringify(line)}`).join(",\n")}\n${indent}]`;
  const version = (v) => {
    const parts = [
      `      "n": ${v.n}`,
      `      "asOf": ${JSON.stringify(v.asOf)}`,
      `      "firstSeen": ${JSON.stringify(v.firstSeen)}`,
      `      "lines": ${lineArray(v.lines, "      ")}`,
    ];
    if (v.priorOnPage)
      parts.push(
        `      "priorOnPage": {\n        "asOf": ${JSON.stringify(v.priorOnPage.asOf)},\n        "lines": ${lineArray(v.priorOnPage.lines, "        ")}\n      }`,
      );
    if (v.corrections?.length)
      parts.push(
        `      "corrections": [\n${v.corrections
          .map(
            (c) =>
              `        {\n          "day": ${JSON.stringify(c.day)},\n          "before": ${lineArray(c.before, "          ")}\n        }`,
          )
          .join(",\n")}\n      ]`,
      );
    return `    {\n${parts.join(",\n")}\n    }`;
  };
  return (
    `{\n  "schemaVersion": ${history.schemaVersion},\n  "code": ${JSON.stringify(history.code)},\n` +
    `  "versions": [\n${history.versions.map(version).join(",\n")}\n  ]\n}\n`
  );
}

/** Check a parsed file; throws with the reason. Returns the history. */
export function validateHistory(history, where = "history") {
  const fail = (reason) => {
    throw new Error(`Corrupt study guide history ${where}: ${reason}.`);
  };
  if (!history || typeof history !== "object") fail("not an object");
  if (history.schemaVersion !== HISTORY_SCHEMA_VERSION)
    fail(
      `schemaVersion is ${history.schemaVersion}, expected ${HISTORY_SCHEMA_VERSION}`,
    );
  if (!/^[A-Z]{2,3}-\d{2,4}$/.test(history.code ?? ""))
    fail("code is not an exam code");
  if (!Array.isArray(history.versions)) fail("versions is not an array");
  history.versions.forEach((v, index) => {
    if (v.n !== index + 1) fail(`version ${index + 1} has n ${v.n}`);
    if (v.asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v.asOf ?? ""))
      fail(`version ${v.n} asOf`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.firstSeen ?? ""))
      fail(`version ${v.n} firstSeen`);
    if (
      !Array.isArray(v.lines) ||
      !v.lines.length ||
      !SKILLS_HEADING.test(v.lines[0])
    )
      fail(`version ${v.n} lines do not start with a Skills measured heading`);
  });
  return history;
}

export function readHistory(dir, code) {
  const file = join(dir, historyFileName(code));
  if (!existsSync(file)) return emptyHistory(code);
  return validateHistory(JSON.parse(readFileSync(file, "utf8")), file);
}

export function writeHistory(dir, history) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, historyFileName(history.code));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeHistory(history), "utf8");
  renameSync(tmp, file);
  return file;
}

/** Every history in a folder, sorted by exam code. */
export function readAllHistories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[A-Z]{2,3}-\d{2,4}\.json$/.test(name))
    .sort()
    .map((name) =>
      validateHistory(JSON.parse(readFileSync(join(dir, name), "utf8")), name),
    );
}

/**
 * Record the live version of every stored guide (`guides` is `studyGuides` of the tracker) and write
 * the files that changed. Returns `[{ code, kind, n }]` for the exams that changed.
 */
export function recordGuides({ dir, guides, today }) {
  const events = [];
  for (const guide of guides) {
    if (!guide?.code || !Array.isArray(guide.lines) || !guide.hash) continue;
    const before = readHistory(dir, guide.code);
    const { history, event } = recordVersion(before, guide.lines, today);
    if (!event) continue;
    writeHistory(dir, history);
    events.push({ code: guide.code, ...event });
  }
  return events;
}
