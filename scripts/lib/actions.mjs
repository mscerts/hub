/**
 * What the monitors tell GitHub Actions: step outputs, workflow annotations and
 * the job summary. Imports nothing but node: built-ins.
 */

import { appendFileSync } from "node:fs";

const LEVELS = ["error", "warning", "notice"];

// The escaping of @actions/core: a workflow command is one line.
const escapeData = (value) =>
  String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
const escapeProperty = (value) =>
  escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * Append `key=value` lines to the GITHUB_OUTPUT file (`file`; nothing happens
 * without one). Values are written as they are, so issue_title keeps its case;
 * a run of line breaks becomes one space, because a value (it may come from a
 * page) must never start another output. `lowercase` lower-cases every value,
 * which older monitors did to their booleans and counts.
 */
export function writeOutput(file, values, { lowercase = false } = {}) {
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value).replace(/[\r\n]+/g, " ");
    return `${key}=${lowercase ? text.toLowerCase() : text}\n`;
  });
  appendFileSync(file, lines.join(""));
}

/**
 * Print a workflow command to stdout: `::error title=T::message`, level one of
 * "error", "warning" and "notice". GitHub shows it on the run summary page and,
 * with `file` and `line`, next to the line of a file.
 */
export function annotate(level, message, { title, file, line } = {}) {
  if (!LEVELS.includes(level)) {
    throw new RangeError(
      `annotate: level must be one of ${LEVELS.join(", ")}, not "${level}".`,
    );
  }
  const properties = [
    ["title", title],
    ["file", file],
    ["line", line],
  ]
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .map(([key, value]) => `${key}=${escapeProperty(value)}`);
  const head = properties.length > 0 ? ` ${properties.join(",")}` : "";
  console.log(`::${level}${head}::${escapeData(message)}`);
}

/**
 * A problem that does not fail the run but must not go unnoticed: on stderr and,
 * on a GitHub runner (GITHUB_ACTIONS=true), as a warning annotation.
 */
export function warnLoud(message, { title } = {}) {
  console.error(`WARNING: ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    annotate("warning", message, { title });
  }
}

/**
 * Append markdown to the job summary (GITHUB_STEP_SUMMARY, `file`; nothing
 * happens without one). A summary is a courtesy: a file that cannot be written
 * is a warning on stderr, never an error. Returns whether it was written.
 */
export function appendStepSummary(file, markdown) {
  if (!file) return false;
  try {
    appendFileSync(file, `${markdown}\n`);
    return true;
  } catch (error) {
    console.error(
      `WARNING: could not write the step summary (${error.message}).`,
    );
    return false;
  }
}
