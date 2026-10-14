// Readers for the workflow files, shared by the tests that look at all of them
// (workflows.test.mjs and workflow-commit-steps.test.mjs). The repository has no
// YAML library as a dependency, and `pnpm format:check` keeps the workflows in
// Prettier's layout (two-space indentation: jobs at 2, job keys at 4, steps
// ("- ") at 6, step keys at 8), so the readers rely on that layout.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../../..");
export const workflowDir = join(root, ".github", "workflows");

export const readText = (path) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** The workflow files of a directory. GitHub runs `.yml` and `.yaml` alike. */
export function listWorkflowFiles(dir = workflowDir) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

/** The text without its comment-only lines: what the patterns of the tests look at. */
export const codeOf = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/^(\s*)#.*$/, "$1"))
    .join("\n");

/** Whether a piece of workflow code pushes a commit (the checkouts are of main). */
export const pushesToMain = (code) => /git push/.test(code);

/** Every workflow file with its text, its text without comments, and whether it pushes to main. */
export function loadWorkflows(dir = workflowDir) {
  return listWorkflowFiles(dir).map((name) => {
    const source = readText(join(dir, name));
    const code = codeOf(source);
    return { name, source, code, pushes: pushesToMain(code) };
  });
}

/** A YAML scalar as text: without its quotes and without a trailing comment. */
export function scalar(value = "") {
  const quoted =
    value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/) ??
    value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  return quoted ? quoted[1] : value.replace(/\s+#.*$/, "").trim();
}

/** The keys at one indentation of a block: key -> { inline value, the more indented lines below it }. */
function readKeys(lines, indent) {
  const keys = new Map();
  const keyLine = new RegExp(`^ {${indent}}([\\w-]+):(?: +(.*?))?\\s*$`);
  const deeper = " ".repeat(indent + 1);
  let current = null;
  for (const line of lines) {
    const key = line.match(keyLine);
    if (key) {
      current = { inline: key[2] ?? "", lines: [] };
      keys.set(key[1], current);
    } else if (current && (line.trim() === "" || line.startsWith(deeper))) {
      current.lines.push(line);
    }
  }
  return keys;
}

/** The `KEY: value` lines of an `env:`, `with:` or `permissions:` block. */
function mapOf(block, indent) {
  const map = {};
  const entry = new RegExp(`^ {${indent}}([\\w.-]+):(?: +(.*))?$`);
  for (const line of block?.lines ?? []) {
    const match = line.match(entry);
    if (match) map[match[1]] = scalar(match[2] ?? "");
  }
  return map;
}

/** The lines of a block scalar without their common indentation and without trailing blank lines. */
function dedent(lines) {
  const body = [...lines];
  while (body.length > 0 && body.at(-1).trim() === "") body.pop();
  const indents = body
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^ */)[0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return body.map((line) => line.slice(indent));
}

function parseStep(chunk, index) {
  // The first key shares the line with the dash: put it at the indentation of the others.
  const lines = chunk.map((line, at) =>
    at === 0 ? line.replace(/^ {6}- /, " ".repeat(8)) : line,
  );
  const keys = readKeys(lines, 8);
  const inline = (key) => keys.get(key)?.inline;
  const uses = inline("uses")?.match(/^(\S+)(?:\s+#\s*(.*?))?\s*$/);
  let run = null;
  const runKey = keys.get("run");
  if (runKey) {
    if (/^\|[+-]?$/.test(runKey.inline)) {
      run =
        dedent(runKey.lines).join("\n") +
        (runKey.inline.endsWith("-") ? "" : "\n");
    } else if (/^[>|]/.test(runKey.inline) || runKey.inline === "") {
      throw new Error(
        `step ${index + 1}: this reader only understands "run: |" blocks and one-line commands`,
      );
    } else {
      run = scalar(runKey.inline);
    }
  }
  return {
    index,
    text: chunk.join("\n"),
    name: scalar(inline("name")),
    id: scalar(inline("id")),
    condition: scalar(inline("if")),
    continueOnError: scalar(inline("continue-on-error")) === "true",
    uses: uses ? { ref: uses[1], comment: uses[2] ?? "" } : null,
    run,
    env: mapOf(keys.get("env"), 10),
    with: mapOf(keys.get("with"), 10),
  };
}

/** The steps of one job (the text below its header), in order. */
export function stepsOf(jobText) {
  const lines = jobText.split("\n");
  const start = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (start < 0) return [];
  const chunks = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}[^\s#]/.test(line)) break; // the next key of the job
    if (/^ {6}- /.test(line)) chunks.push([line]);
    else chunks.at(-1)?.push(line);
  }
  return chunks.map((chunk, index) => parseStep(chunk, index));
}

/** The jobs of a workflow: id, the text below the header, timeout-minutes, permissions, env and steps. */
export function jobsOf(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break; // the next top-level key
    const header = line.match(/^ {2}([\w-]+):\s*(?:#.*)?$/);
    if (header) jobs.push({ id: header[1], lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs.map(({ id, lines: body }) => {
    const keys = readKeys(body, 4);
    const text = body.join("\n");
    return {
      id,
      text,
      timeoutMinutes: keys.has("timeout-minutes")
        ? scalar(keys.get("timeout-minutes").inline)
        : null,
      permissions: mapOf(keys.get("permissions"), 6),
      env: mapOf(keys.get("env"), 6),
      steps: stepsOf(text),
    };
  });
}

/** Every step that runs `git push`: { job, step }. These are the commit steps of the monitors. */
export function commitStepsOf(workflow) {
  return jobsOf(workflow.source).flatMap((job) =>
    job.steps
      .filter((step) => step.run !== null && pushesToMain(codeOf(step.run)))
      .map((step) => ({ job, step })),
  );
}
