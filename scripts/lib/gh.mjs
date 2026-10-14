/**
 * The `gh` CLI as the monitors use it: one runner with a timeout and a large
 * output buffer, and the issue and label calls built on it. Imports nothing but
 * node: built-ins (the monitor workflows do not install packages).
 */

import { spawnSync } from "node:child_process";

// spawnSync allows 1 MiB of output by default: a listing of issues with long
// texts overflowed it (ENOBUFS) and failed a run.
export const GH_MAX_BUFFER = 64 * 1024 * 1024;
// A call that has not answered after this long is hung, not slow.
export const GH_TIMEOUT_MS = 120_000;

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

function failureDetail({ error, stderr }, timeoutMs, maxBuffer) {
  if (error.code === "ETIMEDOUT") return `timed out after ${timeoutMs} ms`;
  if (error.code === "ENOBUFS") {
    return `the output is larger than the ${maxBuffer} byte buffer (ENOBUFS)`;
  }
  // A CLI that fails before it has read a long input leaves EPIPE or EOF here,
  // and the reason on stderr.
  return stderr ? `${error.message}: ${stderr}` : error.message;
}

/**
 * A `gh` runner: `gh(args, input)` runs the CLI with the argument list (no
 * shell), writes `input` to its stdin and returns the trimmed stdout. It throws
 * `gh <arg0> <arg1> failed: <detail>` when the CLI cannot be started, does not
 * answer within the timeout, prints more than the buffer holds or exits non-zero.
 *
 * `options` is { ghCliScript, timeoutMs, maxBuffer }; other keys are ignored and
 * a missing or invalid number means the default (GH_TIMEOUT_MS, GH_MAX_BUFFER).
 * ghCliScript (tests only) is a Node script run instead of the CLI. Pass
 * { ghCliScript: cfg.ghCliScript }, not the whole cfg: the cfg.timeoutMs of a
 * monitor is the timeout of its page fetches.
 */
export function makeGh(options) {
  const { ghCliScript, timeoutMs, maxBuffer } = options ?? {};
  const timeout = Math.ceil(positive(timeoutMs, GH_TIMEOUT_MS));
  const limit = positive(maxBuffer, GH_MAX_BUFFER);
  return (args, input) => {
    if (!Array.isArray(args)) {
      throw new TypeError("gh takes its arguments as an array of strings.");
    }
    const [command, prefix] = ghCliScript
      ? [process.execPath, [ghCliScript]]
      : ["gh", []];
    const res = spawnSync(command, [...prefix, ...args], {
      encoding: "utf8",
      input,
      maxBuffer: limit,
      timeout,
    });
    const what = `gh ${args.slice(0, 2).join(" ")} failed`;
    if (res.error) {
      throw new Error(`${what}: ${failureDetail(res, timeout, limit)}`);
    }
    if (res.status !== 0) {
      const detail =
        res.stderr ||
        res.stdout ||
        (res.signal ? `killed by ${res.signal}` : `exit code ${res.status}`);
      throw new Error(`${what}: ${detail}`);
    }
    return res.stdout.trim();
  };
}

function parseJson(text, empty, what) {
  let value;
  try {
    value = JSON.parse(text || JSON.stringify(empty));
  } catch {
    throw new Error(`${what} did not answer with JSON: ${text.slice(0, 200)}`);
  }
  if (Array.isArray(value) !== Array.isArray(empty)) {
    throw new Error(`${what} did not answer with the expected JSON shape.`);
  }
  return value;
}

/** The text of one issue, by its number. */
export function readIssueBody(gh, number) {
  const out = gh(["issue", "view", String(number), "--json", "body"]);
  return String(parseJson(out, {}, "gh issue view")?.body ?? "");
}

/**
 * The open issues with exactly this title (compared trimmed) and label, oldest
 * first, as { number, title }. The listing asks for number and title only: the
 * text of up to `limit` issues can run to megabytes, and only the oldest match is
 * ever read. With `body`, the text of that one issue is fetched by its number and
 * added as `body` (readIssueBody). Throws when gh fails.
 */
export function listOpenIssues(
  gh,
  { title, label, limit = 200, body = false } = {},
) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new TypeError("listOpenIssues needs the title of the issue.");
  }
  if (typeof label !== "string" || label === "") {
    throw new TypeError("listOpenIssues needs the label of the issue.");
  }
  const out = gh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    String(limit),
    "--json",
    "number,title",
  ]);
  const wanted = title.trim();
  const found = parseJson(out, [], "gh issue list")
    .filter((issue) => String(issue?.title ?? "").trim() === wanted)
    .sort((a, b) => a.number - b.number);
  if (body && found.length > 0) {
    found[0] = { ...found[0], body: readIssueBody(gh, found[0].number) };
  }
  return found;
}

// Label names are case insensitive on GitHub. A lookup that fails answers "no".
function labelExists(gh, name) {
  try {
    const out = gh([
      "label",
      "list",
      "--search",
      name,
      "--json",
      "name",
      "--limit",
      "100",
    ]);
    const wanted = name.toLowerCase();
    return parseJson(out, [], "gh label list").some(
      (label) => String(label?.name ?? "").toLowerCase() === wanted,
    );
  } catch {
    return false;
  }
}

/**
 * Make sure the label exists before `gh issue create --label`: create it when it
 * does not, change nothing (never its color or description) when it does, so it
 * is safe to call before every creation. A creation that fails is an error unless
 * the label exists afterwards (it was there already, or a parallel run made it);
 * that is looked up, not read from the wording of the error.
 */
export function ensureLabel(gh, name, { color, description } = {}) {
  const args = ["label", "create", name];
  if (color) args.push("--color", color);
  if (description) args.push("--description", description);
  try {
    gh(args);
  } catch (error) {
    if (!labelExists(gh, name)) throw error;
  }
}
