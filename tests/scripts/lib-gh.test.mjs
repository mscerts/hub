import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  GH_MAX_BUFFER,
  GH_TIMEOUT_MS,
  ensureLabel,
  listOpenIssues,
  makeGh,
  readIssueBody,
} from "../../scripts/lib/gh.mjs";

const root = resolve(import.meta.dirname, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "lib-gh-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

let counter = 0;
const nextName = (prefix) => `${prefix}-${counter++}`;

/** A throwaway Node script standing in for the `gh` CLI. */
function fakeScript(source) {
  const file = join(tempDir, `${nextName("gh")}.mjs`);
  writeFileSync(file, source);
  return file;
}

const ghFor = (source, options = {}) =>
  makeGh({ ghCliScript: fakeScript(source), ...options });

/** Runs `fn` with a PATH that has no `gh` on it. */
function withoutGh(fn) {
  const saved = process.env.PATH;
  const empty = join(tempDir, nextName("empty"));
  mkdirSync(empty);
  process.env.PATH = empty;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------
test("the limits are 64 MiB of output and two minutes", () => {
  assert.equal(GH_MAX_BUFFER, 64 * 1024 * 1024);
  assert.equal(GH_TIMEOUT_MS, 120_000);
});

test("makeGh returns the trimmed output of the CLI", () => {
  const padded = ghFor("process.stdout.write('\\n  42 issues \\n\\n');");
  assert.equal(padded(["issue", "list"]), "42 issues");
  const lines = ghFor("process.stdout.write('line 1\\nline 2\\n');");
  assert.equal(lines(["issue", "view"]), "line 1\nline 2");
});

test("makeGh passes every argument through untouched, no shell in between", () => {
  const echo = ghFor("console.log(JSON.stringify(process.argv.slice(2)));");
  const args = [
    "issue",
    "create",
    "--title",
    'New "beta" exam: AZ-104 & more | 100% <b>',
    "--body",
    "",
    "--label",
    "it's",
    "C:\\some folder\\",
    "ünï — ✓",
    "*",
    "$HOME",
    "--",
    "-x",
  ];
  assert.deepEqual(JSON.parse(echo(args)), args);
});

test("makeGh writes `input` to the stdin of the CLI", () => {
  const cat = ghFor(
    'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(0, "utf8"));',
  );
  const body = "### Title\r\n\r\nläuft — ✓\n\n```\ncode\n```\n";
  assert.equal(
    cat(["issue", "comment", "7", "--body-file", "-"], body),
    body.trim(),
  );
  assert.equal(cat(["issue", "list"]), "", "no input: an empty stdin");
});

test("a CLI that fails throws `gh <command> failed:` with its error text", () => {
  const failing = ghFor(
    'console.error("HTTP 422: Validation Failed\\nsecond line"); process.exitCode = 1;',
  );
  assert.throws(
    () => failing(["issue", "create", "--title", "a secret title"]),
    {
      message:
        "gh issue create failed: HTTP 422: Validation Failed\nsecond line\n",
    },
  );
  // Without error text the output is the detail, and without that the exit code.
  const noisy = ghFor('console.log("partial answer"); process.exitCode = 2;');
  assert.throws(() => noisy(["issue", "list"]), {
    message: "gh issue list failed: partial answer\n",
  });
  const silent = ghFor("process.exitCode = 4;");
  assert.throws(() => silent(["issue", "list"]), {
    message: "gh issue list failed: exit code 4",
  });
});

test("a CLI that cannot be started throws with the reason", () => {
  assert.throws(() => withoutGh(() => makeGh()(["issue", "list"])), {
    message: "gh issue list failed: spawnSync gh ENOENT",
  });
  // The cfg of a monitor has an empty ghCliScript: that means the real CLI.
  assert.throws(
    () => withoutGh(() => makeGh({ ghCliScript: "" })(["label", "create"])),
    { message: "gh label create failed: spawnSync gh ENOENT" },
  );
});

test("a CLI that fails before it has read a long input still says why", () => {
  // The write of the input then fails (EPIPE or EOF) and hides the exit code.
  const early = ghFor(
    'console.error("unknown flag --nope"); process.exitCode = 1;',
  );
  assert.throws(
    () =>
      early(
        ["issue", "comment", "7", "--body-file", "-"],
        "y".repeat(8 * 1024 * 1024),
      ),
    { message: /^gh issue comment failed: [\s\S]*unknown flag --nope\n$/ },
  );
});

test("a CLI that hangs is stopped after timeoutMs, and the error says so", () => {
  const hung = ghFor("setTimeout(() => process.exit(0), 20000);", {
    timeoutMs: 400,
  });
  const started = Date.now();
  assert.throws(() => hung(["issue", "list"]), {
    message: "gh issue list failed: timed out after 400 ms",
  });
  assert.ok(Date.now() - started < 10000, "it did not wait for the CLI");
});

test("output beyond maxBuffer is reported as an overflow, not cut short", () => {
  const chatty = ghFor('process.stdout.write("x".repeat(100000));', {
    maxBuffer: 1024,
  });
  assert.throws(() => chatty(["issue", "list"]), {
    message:
      "gh issue list failed: the output is larger than the 1024 byte buffer (ENOBUFS)",
  });
});

test("with the default buffer a listing larger than 1 MiB is no problem", () => {
  // 3 MiB: three times what spawnSync allows without maxBuffer.
  const big = ghFor('process.stdout.write("x".repeat(3 * 1024 * 1024));');
  assert.equal(big(["issue", "list"]).length, 3 * 1024 * 1024);
});

test("options: other keys are ignored, a bad number means the default", () => {
  const file = fakeScript('process.stdout.write("ok");');
  assert.equal(typeof makeGh(), "function");
  assert.equal(typeof makeGh(null), "function");
  assert.equal(makeGh({ ghCliScript: file })(["a", "b"]), "ok");
  for (const bad of [0, -5, NaN, Infinity, "soon", null, undefined]) {
    const gh = makeGh({
      ghCliScript: file,
      timeoutMs: bad,
      maxBuffer: bad,
      fetchDelayMs: 600,
      runUrl: "https://github.com/mscerts/hub/actions/runs/1",
      dryRun: true,
    });
    assert.equal(gh(["a", "b"]), "ok", String(bad));
  }
});

test("the arguments must be a list", () => {
  const gh = ghFor('process.stdout.write("ok");');
  assert.throws(() => gh("issue list"), TypeError);
  assert.throws(() => gh(), TypeError);
});

// ---------------------------------------------------------------------------
// Issues and labels, against a fake CLI that keeps state
// ---------------------------------------------------------------------------
// It keeps issues and labels in state.json next to it and logs every call to
// calls.jsonl. Like the real CLI, `--json` returns only the fields asked for,
// `issue list` is newest first and takes --limit, a label name is case
// insensitive, creating a label twice fails and so does `issue create` with a
// label that does not exist. state.fail maps a command ("issue list") to the
// error text it prints and exits with.
const FAKE_GH = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(join(home, "calls.jsonl"), JSON.stringify({ command, args, stdin }) + "\n");

const stateFile = join(home, "state.json");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const fields = () => (arg("--json") ?? "number,title").split(",");
const pick = (item) => Object.fromEntries(fields().map((field) => [field, item[field]]));
const limit = () => Number(arg("--limit") ?? 30);
const hasLabel = (name) => state.labels.some((label) => label.name.toLowerCase() === name.toLowerCase());

if (state.fail[command]) {
  console.error(state.fail[command]);
  process.exitCode = 1;
} else if (command === "issue list") {
  const label = arg("--label");
  const wanted = arg("--state") ?? "open";
  const listed = state.issues
    .filter((issue) => issue.state === wanted && issue.labels.includes(label))
    .sort((a, b) => b.number - a.number)
    .slice(0, limit())
    .map(pick);
  console.log(JSON.stringify(listed));
} else if (command === "issue view") {
  console.log(JSON.stringify(pick(state.issues.find((issue) => issue.number === Number(args[2])))));
} else if (command === "issue create") {
  const label = arg("--label");
  if (!hasLabel(label)) {
    console.error("could not add label: '" + label + "' not found");
    process.exitCode = 1;
  } else {
    const issue = { number: state.next++, title: arg("--title"), labels: [label], body: stdin, state: "open" };
    state.issues.push(issue);
    save();
    console.log("https://github.com/mscerts/hub/issues/" + issue.number);
  }
} else if (command === "label create") {
  const name = args[2];
  if (hasLabel(name)) {
    console.error('label with name "' + name + '" already exists; use --force to update its color and description');
    process.exitCode = 1;
  } else {
    state.labels.push({ name, color: arg("--color"), description: arg("--description") });
    save();
  }
} else if (command === "label list") {
  const search = (arg("--search") ?? "").toLowerCase();
  console.log(JSON.stringify(
    state.labels
      .filter((label) => (label.name + " " + (label.description ?? "")).toLowerCase().includes(search))
      .slice(0, limit())
      .map(pick),
  ));
}
`;

function world({ issues = [], labels = [], fail = {} } = {}) {
  const home = join(tempDir, nextName("world"));
  mkdirSync(home);
  writeFileSync(join(home, "gh.mjs"), FAKE_GH);
  const stateFile = join(home, "state.json");
  writeFileSync(stateFile, JSON.stringify({ next: 100, issues, labels, fail }));
  const logFile = join(home, "calls.jsonl");
  const calls = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  return {
    gh: makeGh({ ghCliScript: join(home, "gh.mjs") }),
    calls,
    commands: () => calls().map((call) => call.command),
    labels: () => state().labels,
    issues: () => state().issues,
  };
}

const issue = (number, title, extra = {}) => ({
  number,
  title,
  labels: ["bug"],
  state: "open",
  body: `text of #${number}`,
  ...extra,
});
const RUNNING = "Running issue";

test("listOpenIssues finds the open issues with exactly this title and label, oldest first", () => {
  const { gh, calls } = world({
    issues: [
      issue(5, RUNNING),
      issue(2, `  ${RUNNING}  `),
      issue(9, `${RUNNING} 2`),
      issue(3, "running issue"),
      issue(4, RUNNING, { labels: ["enhancement"] }),
      issue(7, RUNNING, { state: "closed" }),
      issue(1, "Something else"),
    ],
  });
  assert.deepEqual(listOpenIssues(gh, { title: RUNNING, label: "bug" }), [
    { number: 2, title: `  ${RUNNING}  ` },
    { number: 5, title: RUNNING },
  ]);
  // The listing asks for the numbers and titles of up to 200 open issues, nothing else.
  assert.deepEqual(
    calls().map((call) => call.args),
    [
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "bug",
        "--limit",
        "200",
        "--json",
        "number,title",
      ],
    ],
  );
});

test("the title to look for is trimmed as well", () => {
  const { gh } = world({ issues: [issue(5, RUNNING)] });
  assert.deepEqual(
    listOpenIssues(gh, { title: `\n ${RUNNING} \t`, label: "bug" }).map(
      (found) => found.number,
    ),
    [5],
  );
});

test("listOpenIssues passes the limit on, and nothing open is an empty list", () => {
  const { gh, calls } = world({
    issues: [1, 2, 3, 4, 5].map((number) => issue(number, RUNNING)),
  });
  assert.deepEqual(
    listOpenIssues(gh, { title: RUNNING, label: "bug", limit: 3 }).map(
      (found) => found.number,
    ),
    [3, 4, 5],
    "gh answers with the newest three",
  );
  assert.equal(calls()[0].args[calls()[0].args.indexOf("--limit") + 1], "3");
  assert.deepEqual(listOpenIssues(gh, { title: "No such", label: "bug" }), []);
  assert.deepEqual(
    listOpenIssues(gh, { title: RUNNING, label: "no-such-label" }),
    [],
  );
});

test("with `body` the text of the oldest match is read by its number, never listed", () => {
  const { gh, calls, commands } = world({
    issues: [
      issue(8, RUNNING, { body: "newer text" }),
      issue(6, RUNNING, { body: "line 1\r\nline 2\n" }),
    ],
  });
  const [oldest, newer, ...rest] = listOpenIssues(gh, {
    title: RUNNING,
    label: "bug",
    body: true,
  });
  assert.deepEqual(oldest, {
    number: 6,
    title: RUNNING,
    body: "line 1\r\nline 2\n",
  });
  assert.deepEqual(newer, { number: 8, title: RUNNING });
  assert.deepEqual(rest, []);
  assert.deepEqual(commands(), ["issue list", "issue view"]);
  assert.deepEqual(calls()[1].args, ["issue", "view", "6", "--json", "body"]);

  const none = world({ issues: [] });
  assert.deepEqual(
    listOpenIssues(none.gh, { title: RUNNING, label: "bug", body: true }),
    [],
  );
  assert.deepEqual(none.commands(), ["issue list"], "nothing to read");
});

test("listOpenIssues throws what gh failed with, and what is not a list of issues", () => {
  const down = world({ fail: { "issue list": "HTTP 502: Bad Gateway" } });
  assert.throws(
    () => listOpenIssues(down.gh, { title: RUNNING, label: "bug" }),
    { message: "gh issue list failed: HTTP 502: Bad Gateway\n" },
  );
  const html = ghFor('console.log("<html>rate limited</html>");');
  assert.throws(
    () => listOpenIssues(html, { title: RUNNING, label: "bug" }),
    /gh issue list did not answer with JSON: <html>rate limited<\/html>/,
  );
  const object = ghFor('console.log(\'{"message":"nope"}\');');
  assert.throws(
    () => listOpenIssues(object, { title: RUNNING, label: "bug" }),
    /gh issue list did not answer with the expected JSON shape/,
  );
  const empty = ghFor("");
  assert.deepEqual(
    listOpenIssues(empty, { title: RUNNING, label: "bug" }),
    [],
    "no output at all is no issue",
  );
});

test("listOpenIssues needs a title and a label: gh would list the wrong issues without", () => {
  const { gh, calls } = world();
  assert.throws(() => listOpenIssues(gh), TypeError);
  assert.throws(() => listOpenIssues(gh, { label: "bug" }), TypeError);
  assert.throws(
    () => listOpenIssues(gh, { title: "  ", label: "bug" }),
    TypeError,
  );
  assert.throws(() => listOpenIssues(gh, { title: RUNNING }), TypeError);
  assert.throws(
    () => listOpenIssues(gh, { title: RUNNING, label: "" }),
    TypeError,
  );
  assert.deepEqual(calls(), []);
});

test("a listing of more than 1 MiB is read with the default buffer", () => {
  const long = "x".repeat(8 * 1024);
  const issues = Array.from({ length: 199 }, (_, index) =>
    issue(index + 1, `${long} ${index + 1}`),
  );
  issues.push(issue(300, RUNNING));
  assert.ok(JSON.stringify(issues).length > 1024 * 1024);
  const { gh } = world({ issues });
  assert.deepEqual(listOpenIssues(gh, { title: RUNNING, label: "bug" }), [
    { number: 300, title: RUNNING },
  ]);
});

test("readIssueBody reads the text of one issue by its number, as it is", () => {
  const { gh, calls } = world({
    issues: [
      issue(7, RUNNING, { body: "line 1\r\nline 2\n" }),
      issue(8, RUNNING, { body: null }),
    ],
  });
  assert.equal(readIssueBody(gh, 7), "line 1\r\nline 2\n");
  assert.equal(readIssueBody(gh, "7"), "line 1\r\nline 2\n");
  assert.equal(readIssueBody(gh, 8), "", "an issue without a text");
  assert.deepEqual(calls()[0].args, ["issue", "view", "7", "--json", "body"]);

  const down = world({ fail: { "issue view": "HTTP 404: Not Found" } });
  assert.throws(() => readIssueBody(down.gh, 7), {
    message: "gh issue view failed: HTTP 404: Not Found\n",
  });
  const silent = ghFor("");
  assert.equal(readIssueBody(silent, 7), "");
});

test("ensureLabel creates a label that does not exist yet, with its color and description", () => {
  const { gh, calls, labels } = world();
  ensureLabel(gh, "bug", {
    color: "d73a4a",
    description: "Something isn't working",
  });
  assert.deepEqual(
    calls().map((call) => call.args),
    [
      [
        "label",
        "create",
        "bug",
        "--color",
        "d73a4a",
        "--description",
        "Something isn't working",
      ],
    ],
  );
  assert.deepEqual(labels(), [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
  ]);
});

test("color and description are optional", () => {
  const { gh, calls } = world();
  ensureLabel(gh, "enhancement");
  ensureLabel(gh, "broken-link", { color: "e99695" });
  assert.deepEqual(
    calls().map((call) => call.args),
    [
      ["label", "create", "enhancement"],
      ["label", "create", "broken-link", "--color", "e99695"],
    ],
  );
});

test("ensureLabel leaves a label that exists alone, however often it is called", () => {
  const mine = {
    name: "bug",
    color: "ededed",
    description: "My own bug label",
  };
  const { gh, calls, labels } = world({ labels: [mine] });
  for (let run = 0; run < 3; run++) {
    assert.doesNotThrow(() =>
      ensureLabel(gh, "bug", {
        color: "d73a4a",
        description: "Something isn't working",
      }),
    );
  }
  assert.deepEqual(labels(), [mine], "color and description are not touched");
  assert.ok(
    calls().every((call) => !call.args.includes("--force")),
    "never --force",
  );
  // A name differing in case is the same label on GitHub.
  assert.doesNotThrow(() => ensureLabel(gh, "BUG"));
  assert.deepEqual(labels(), [mine]);
});

test("ensureLabel before every `gh issue create --label`: the label a fresh repository lacks no longer fails the run", () => {
  const { gh, labels, issues } = world();
  const create = (title) =>
    gh(
      [
        "issue",
        "create",
        "--title",
        title,
        "--label",
        "bug",
        "--body-file",
        "-",
      ],
      "text",
    );
  // What failure-issue.mjs ran into.
  assert.throws(() => create("First"), /could not add label: 'bug' not found/);

  for (const title of ["First", "Second"]) {
    ensureLabel(gh, "bug", { color: "d73a4a", description: "Something" });
    assert.match(create(title), /\/issues\/10[01]$/);
  }
  assert.equal(labels().length, 1);
  assert.deepEqual(
    issues().map((found) => found.title),
    ["First", "Second"],
  );
});

test("ensureLabel does not swallow a real failure", () => {
  const forbidden = "HTTP 403: Resource not accessible by integration";
  const { gh, commands, labels } = world({
    fail: { "label create": forbidden },
  });
  assert.throws(() => ensureLabel(gh, "bug", { color: "d73a4a" }), {
    message: `gh label create failed: ${forbidden}\n`,
  });
  assert.deepEqual(commands(), ["label create", "label list"]);
  assert.deepEqual(labels(), []);

  // Not even when the lookup that follows fails too: the creation error is the one to see.
  const both = world({
    fail: { "label create": forbidden, "label list": "HTTP 500" },
  });
  assert.throws(() => ensureLabel(both.gh, "bug"), {
    message: `gh label create failed: ${forbidden}\n`,
  });

  // A label that merely looks like it is not the label: "debug" contains "bug".
  const similar = world({
    labels: [{ name: "debug", color: "ededed", description: "" }],
    fail: { "label create": forbidden },
  });
  assert.throws(() => ensureLabel(similar.gh, "bug"), /gh label create failed/);
});

test("ensureLabel accepts a failed creation only when the label is there afterwards", () => {
  // Whatever the wording of the error: it is the lookup that decides.
  const { gh } = world({
    labels: [{ name: "bug", color: "ededed", description: "" }],
    fail: { "label create": "some wording gh may use one day" },
  });
  assert.doesNotThrow(() => ensureLabel(gh, "bug"));
});

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------
test("the module imports only node: built-ins, so the monitors run without pnpm install", () => {
  const source = readFileSync(join(root, "scripts/lib/gh.mjs"), "utf8");
  const specifiers = [
    ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g),
  ].map((match) => match[1] ?? match[2]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);
});
