import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  MAX_BODY_CHARS,
  UsageError,
  clearFailureIssue,
  closeOpenIssues,
  parseArgs,
  raiseFailureIssue,
  raiseIssue,
} from "../../scripts/failure-issue.mjs";
import { listOpenIssues } from "../../scripts/lib/gh.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "failure-issue.mjs");

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// An in-memory `gh`
// ---------------------------------------------------------------------------
// Like the real one, it refuses `issue create --label X` for a label the
// repository does not have ("could not add label: 'X' not found") and
// `label create` for one it has. `labels` is what the repository starts with
// (names or { name, color, description }); `denyLabels` is a token that may not
// create labels.
function memoryGh(
  seed = [],
  { labels: seedLabels = ["bug"], denyLabels = false } = {},
) {
  const issues = seed.map((issue, i) => ({
    number: i + 1,
    labels: ["bug"],
    state: "open",
    comments: [],
    updatedAt: "2026-10-01T00:00:00Z",
    ...issue,
  }));
  const labels = seedLabels.map((label) =>
    typeof label === "string" ? { name: label } : { ...label },
  );
  const calls = [];
  let next = issues.length + 1;
  const flag = (args, name) => {
    const at = args.indexOf(name);
    return at < 0 ? null : args[at + 1];
  };
  const hasLabel = (name) =>
    labels.some((label) => label.name.toLowerCase() === name.toLowerCase());
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, args, input });
    const find = () => issues.find((issue) => issue.number === Number(args[2]));
    if (command === "issue list") {
      const fields = flag(args, "--json").split(",");
      return JSON.stringify(
        issues
          .filter(
            (issue) =>
              issue.state === flag(args, "--state") &&
              issue.labels.includes(flag(args, "--label")),
          )
          .map((issue) =>
            Object.fromEntries(fields.map((field) => [field, issue[field]])),
          ),
      );
    }
    if (command === "issue view") {
      const fields = flag(args, "--json").split(",");
      return JSON.stringify(
        Object.fromEntries(fields.map((field) => [field, find()[field]])),
      );
    }
    if (command === "label create") {
      if (denyLabels) {
        throw new Error(
          "gh label create failed: HTTP 403: Resource not accessible by integration",
        );
      }
      if (hasLabel(args[2])) {
        throw new Error(
          `gh label create failed: label ${args[2]} already exists`,
        );
      }
      labels.push({
        name: args[2],
        color: flag(args, "--color"),
        description: flag(args, "--description"),
      });
      return "";
    }
    if (command === "label list") {
      const search = flag(args, "--search").toLowerCase();
      return JSON.stringify(
        labels.filter((label) => label.name.toLowerCase().includes(search)),
      );
    }
    if (command === "issue create") {
      if (!hasLabel(flag(args, "--label"))) {
        throw new Error(
          `gh issue create failed: could not add label: '${flag(args, "--label")}' not found`,
        );
      }
      const issue = {
        number: next++,
        title: flag(args, "--title"),
        labels: [flag(args, "--label")],
        body: input,
        state: "open",
        comments: [],
        updatedAt: "2026-10-14T00:00:00Z",
      };
      issues.push(issue);
      return `https://github.com/mscerts/hub/issues/${issue.number}`;
    }
    if (command === "issue comment") find().comments.push(input);
    if (command === "issue close") {
      const issue = find();
      if (issue.failClose) throw new Error("gh issue close failed");
      issue.state = "closed";
      issue.comments.push(flag(args, "--comment"));
    }
    return "";
  };
  return { gh, issues, labels, calls };
}

const TITLE = "Skills Hub Watch Failed";
const DAY = "2026-10-14";
const RUN = "https://github.com/mscerts/hub/actions/runs/42";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
test("arguments: raise needs a file, clear a comment, both a title, nothing unknown", () => {
  assert.deepEqual(
    parseArgs([
      "raise",
      "--title",
      "T",
      "--file",
      "f.md",
      "--repeat-hours",
      "24",
    ]),
    {
      command: "raise",
      label: "bug",
      repeatHours: 24,
      title: "T",
      file: "f.md",
    },
  );
  assert.deepEqual(
    parseArgs([
      "clear",
      "--title",
      "T",
      "--comment",
      "ok",
      "--label",
      "enhancement",
    ]),
    {
      command: "clear",
      label: "enhancement",
      repeatHours: 0,
      title: "T",
      comment: "ok",
    },
  );
  for (const bad of [
    [],
    ["close", "--title", "T"],
    ["raise", "--title", "T"],
    ["raise", "--file", "f.md"],
    ["clear", "--title", "T"],
    ["raise", "--title", "T", "--file", "f.md", "--assignee", "x"],
    ["raise", "--title", "T", "--file"],
    ["raise", "--title", "T", "--file", "f.md", "--repeat-hours", "-1"],
    ["raise", "--title", "  ", "--file", "f.md"],
  ]) {
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Raising
// ---------------------------------------------------------------------------
test("the first failure creates the issue with a stable title and the label, no assignee", () => {
  const memory = memoryGh();
  const result = raiseFailureIssue({
    gh: memory.gh,
    title: TITLE,
    message: "The feed answered 500.",
    today: DAY,
    runUrl: RUN,
  });
  assert.deepEqual(result, { action: "created", number: 1 });
  const [issue] = memory.issues;
  assert.equal(issue.title, TITLE);
  assert.deepEqual(issue.labels, ["bug"]);
  assert.match(
    issue.body,
    /^The feed answered 500\.\n\nRun: https:\/\/github\.com/,
  );
  assert.match(issue.body, /one comment for a further failed run/);
  for (const call of memory.calls) {
    assert.ok(!call.args.includes("--assignee"), call.command);
  }
});

test("every further failure is a comment on the same issue, never a second issue", () => {
  const memory = memoryGh();
  for (const message of ["first", "second", "third"]) {
    raiseFailureIssue({
      gh: memory.gh,
      title: TITLE,
      message,
      today: DAY,
      runUrl: RUN,
    });
  }
  assert.equal(memory.issues.length, 1);
  assert.deepEqual(
    memory.issues[0].comments.map((c) => c.split("\n\n")[1]),
    ["second", "third"],
  );
  assert.match(memory.issues[0].comments[0], /^It failed again on 2026-10-14:/);
  assert.match(
    memory.issues[0].comments[0],
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/42$/,
  );
});

test("only an open issue with exactly this title and label counts, and only the oldest copy gets the comment", () => {
  const memory = memoryGh([
    { title: "Skills Hub Watch Failed — 123" },
    { title: TITLE, labels: ["enhancement"] },
    { title: TITLE, state: "closed" },
    { title: ` ${TITLE} ` },
    { title: TITLE },
  ]);
  assert.deepEqual(
    listOpenIssues(memory.gh, { title: TITLE, label: "bug" }).map(
      (i) => i.number,
    ),
    [4, 5],
  );
  const result = raiseFailureIssue({
    gh: memory.gh,
    title: TITLE,
    message: "again",
    today: DAY,
  });
  assert.deepEqual(result, { action: "commented", number: 4 });
  assert.equal(memory.issues[3].comments.length, 1);
  assert.equal(memory.issues[4].comments.length, 0);
  assert.equal(memory.issues.length, 5, "no issue was created");
});

test("--repeat-hours keeps a check that fails every few hours from commenting every time", () => {
  const memory = memoryGh([
    { title: TITLE, updatedAt: "2026-10-14T01:00:00Z" },
  ]);
  const at = (hour) => Date.parse(`2026-10-14T${hour}:00:00Z`);
  const raise = (now) =>
    raiseFailureIssue({
      gh: memory.gh,
      title: TITLE,
      message: "still failing",
      today: DAY,
      repeatHours: 24,
      now,
    });
  assert.equal(
    raise(at("07")).action,
    "quiet",
    "6 hours after the last activity",
  );
  assert.equal(raise(at("23")).action, "quiet");
  assert.equal(memory.issues[0].comments.length, 0);
  assert.equal(
    raiseFailureIssue({
      gh: memory.gh,
      title: TITLE,
      message: "still failing",
      today: "2026-10-15",
      repeatHours: 24,
      now: Date.parse("2026-10-15T02:00:00Z"),
    }).action,
    "commented",
    "more than 24 hours after the last activity",
  );
  // No repeat limit: always a comment. Unreadable activity time: a comment, never silence.
  assert.equal(
    raiseFailureIssue({
      gh: memory.gh,
      title: TITLE,
      message: "m",
      today: DAY,
      now: at("02"),
    }).action,
    "commented",
  );
  memory.issues[0].updatedAt = "garbage";
  assert.equal(raise(at("03")).action, "commented");
});

test("a message too long for an issue is cut, with a note", () => {
  const memory = memoryGh();
  raiseFailureIssue({
    gh: memory.gh,
    title: TITLE,
    message: "x".repeat(MAX_BODY_CHARS * 2),
    today: DAY,
  });
  assert.ok(memory.issues[0].body.length < 65536);
  assert.match(
    memory.issues[0].body,
    /\(cut: the message was longer than an issue may be\)/,
  );
});

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------
test("a repository without the label gets it before the first issue, with GitHub's own look for bug", () => {
  const memory = memoryGh([], { labels: [] });
  const result = raiseFailureIssue({
    gh: memory.gh,
    title: TITLE,
    message: "The feed answered 500.",
    today: DAY,
  });
  assert.deepEqual(result, { action: "created", number: 1 });
  assert.deepEqual(
    memory.calls.map((call) => call.command),
    ["issue list", "label create", "issue create"],
  );
  assert.deepEqual(memory.labels, [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
  ]);
  assert.deepEqual(memory.issues[0].labels, ["bug"]);
});

test("a label the repository has is never touched, and a comment needs no label call", () => {
  const mine = {
    name: "bug",
    color: "ededed",
    description: "My own bug label",
  };
  const memory = memoryGh([], { labels: [mine] });
  for (const message of ["first", "second", "third"]) {
    raiseFailureIssue({ gh: memory.gh, title: TITLE, message, today: DAY });
  }
  assert.deepEqual(memory.labels, [mine], "color and description stay");
  assert.deepEqual(
    memory.calls.map((call) => call.command),
    [
      // The creation: `label create` is refused (it exists), the lookup finds it.
      "issue list",
      "label create",
      "label list",
      "issue create",
      "issue list",
      "issue comment",
      "issue list",
      "issue comment",
    ],
  );
  for (const call of memory.calls) {
    assert.ok(!call.args.includes("--force"), call.command);
  }
});

test("a label that cannot be created and is not there is an error, and no issue is made", () => {
  const memory = memoryGh([], { labels: [], denyLabels: true });
  assert.throws(
    () =>
      raiseFailureIssue({
        gh: memory.gh,
        title: TITLE,
        message: "m",
        today: DAY,
      }),
    /gh label create failed: HTTP 403/,
  );
  assert.deepEqual(memory.issues, []);
});

test("raiseIssue and closeOpenIssues are the steps source-watch shares: their own texts and label look, a stuck close is reported and not thrown", () => {
  const memory = memoryGh([], { labels: [] });
  const raise = () =>
    raiseIssue({
      gh: memory.gh,
      title: "Running issue",
      label: "attention",
      labelColor: "ff0000",
      labelDescription: "Needs a look",
      body: "the body",
      commentBody: "the comment",
    });
  assert.deepEqual(raise(), { action: "created", number: 1 });
  assert.deepEqual(raise(), { action: "commented", number: 1 });
  assert.equal(memory.issues[0].body, "the body");
  assert.deepEqual(memory.issues[0].comments, ["the comment"]);
  assert.deepEqual(memory.labels, [
    { name: "attention", color: "ff0000", description: "Needs a look" },
  ]);

  const stuck = memoryGh([
    { title: "Running issue", failClose: true },
    { title: "Running issue" },
  ]);
  assert.deepEqual(
    closeOpenIssues({ gh: stuck.gh, title: "Running issue", comment: "done" }),
    { found: 2, closed: [2], failures: ["gh issue close failed"] },
  );
  assert.deepEqual(stuck.issues[1].comments, ["done"]);
  assert.deepEqual(
    closeOpenIssues({ gh: stuck.gh, title: "No such", comment: "x" }),
    { found: 0, closed: [], failures: [] },
  );
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------
test("a healthy run closes every open copy with a comment, and does nothing when none is open", () => {
  const memory = memoryGh([
    { title: TITLE },
    { title: TITLE },
    { title: "Other" },
  ]);
  const result = clearFailureIssue({
    gh: memory.gh,
    title: TITLE,
    comment: "It runs again.",
    runUrl: RUN,
  });
  assert.deepEqual(result, { action: "closed", closed: [1, 2] });
  assert.deepEqual(
    memory.issues.map((i) => i.state),
    ["closed", "closed", "open"],
  );
  assert.match(memory.issues[0].comments[0], /^It runs again\.\n\nRun: /);
  const again = clearFailureIssue({
    gh: memory.gh,
    title: TITLE,
    comment: "x",
  });
  assert.deepEqual(again, { action: "none", closed: [] });
  assert.deepEqual(
    memory.calls.slice(-1).map((c) => c.command),
    ["issue list"],
    "only a lookup",
  );
});

test("an issue that cannot be closed is an error, so a stuck issue is seen and the next run tries again", () => {
  const memory = memoryGh([
    { title: TITLE, failClose: true },
    { title: TITLE },
  ]);
  assert.throws(
    () => clearFailureIssue({ gh: memory.gh, title: TITLE, comment: "x" }),
    /Could not close 1 of 2 open copies/,
  );
  assert.equal(
    memory.issues[1].state,
    "closed",
    "the other copy was still closed",
  );
});

// ---------------------------------------------------------------------------
// The command line, against a fake gh
// ---------------------------------------------------------------------------
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ command, args, stdin }) + "\\n");
if (process.env.FAKE_GH_FAIL === command) { console.error("fake gh: " + command + " failed"); process.exit(1); }
const file = process.env.FAKE_GH_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { next: 1, issues: [], labels: ["bug"] };
const save = () => writeFileSync(file, JSON.stringify(state));
const find = () => state.issues.find((i) => i.number === Number(args[2]));
const hasLabel = (name) => state.labels.some((l) => l.toLowerCase() === name.toLowerCase());
if (command === "issue list") {
  const fields = arg("--json").split(",");
  console.log(JSON.stringify(state.issues
    .filter((i) => i.state === arg("--state") && i.labels.includes(arg("--label")))
    .map((i) => Object.fromEntries(fields.map((f) => [f, i[f]])))));
} else if (command === "issue view") {
  const fields = arg("--json").split(",");
  console.log(JSON.stringify(Object.fromEntries(fields.map((f) => [f, find()[f]]))));
} else if (command === "label create") {
  if (hasLabel(args[2])) { console.error("label " + args[2] + " already exists"); process.exit(1); }
  state.labels.push(args[2]); save();
} else if (command === "label list") {
  const search = arg("--search").toLowerCase();
  console.log(JSON.stringify(state.labels.filter((l) => l.toLowerCase().includes(search)).map((name) => ({ name }))));
} else if (command === "issue create") {
  if (!hasLabel(arg("--label"))) { console.error("could not add label: '" + arg("--label") + "' not found"); process.exit(1); }
  const issue = { number: state.next++, title: arg("--title"), labels: [arg("--label")], body: stdin, state: "open", comments: [], updatedAt: new Date().toISOString() };
  state.issues.push(issue); save();
  console.log("https://github.com/mscerts/hub/issues/" + issue.number);
} else if (command === "issue comment") { find().comments.push(stdin); find().updatedAt = new Date().toISOString(); save(); }
else if (command === "issue close") { const i = find(); i.state = "closed"; i.comments.push(arg("--comment")); save(); }
`;

/** A temporary repository for the command line; `labels` are the labels it starts with. */
async function world({ labels = ["bug"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "failure-issue-"));
  tempDirs.push(dir);
  const fake = join(dir, "fake-gh.mjs");
  await writeFile(fake, FAKE_GH);
  await writeFile(join(dir, "error.md"), "The check failed: boom.\n");
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ next: 1, issues: [], labels }),
  );
  const env = {
    ...process.env,
    GH_CLI_SCRIPT: fake,
    FAKE_GH_STATE: join(dir, "state.json"),
    FAKE_GH_LOG: join(dir, "log.jsonl"),
    TODAY: DAY,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "mscerts/hub",
    GITHUB_RUN_ID: "42",
  };
  delete env.DRY_RUN;
  const run = (args, extra = {}) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: { ...env, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
  const read = async (key) => {
    try {
      return JSON.parse(await readFile(join(dir, "state.json"), "utf8"))[key];
    } catch {
      return [];
    }
  };
  return {
    dir,
    run,
    state: () => read("issues"),
    labels: () => read("labels"),
    error: join(dir, "error.md"),
  };
}

test("end to end: in a repository without the label the first raise creates it, and a label that cannot be created fails the step", async () => {
  const { run, state, labels, error } = await world({ labels: [] });
  const failing = await run(["raise", "--title", TITLE, "--file", error], {
    FAKE_GH_FAIL: "label create",
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /ERROR: gh label create failed/);
  assert.deepEqual(await state(), [], "no issue without its label");

  const first = await run(["raise", "--title", TITLE, "--file", error]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(
    first.stdout,
    /Issue "Skills Hub Watch Failed": created \(#1\)\./,
  );
  assert.deepEqual(await labels(), ["bug"]);
  assert.deepEqual((await state())[0].labels, ["bug"]);
  // The next failure only comments: the label is there.
  const again = await run(["raise", "--title", TITLE, "--file", error]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await state()).length, 1);
});

test("end to end: three failed runs make one issue with two comments, a healthy run closes it, and nothing is assigned", async () => {
  const { dir, run, state, error } = await world();
  const raise = () =>
    run(["raise", "--title", TITLE, "--label", "bug", "--file", error]);
  const first = await raise();
  assert.equal(first.code, 0, first.stderr);
  assert.match(
    first.stdout,
    /Issue "Skills Hub Watch Failed": created \(#1\)\./,
  );
  await raise();
  await raise();
  let issues = await state();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].comments.length, 2);
  assert.match(issues[0].comments[0], /The check failed: boom\./);

  const healthy = await run([
    "clear",
    "--title",
    TITLE,
    "--comment",
    "It runs again.",
  ]);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.match(healthy.stdout, /closed \(#1\)/);
  issues = await state();
  assert.equal(issues[0].state, "closed");
  assert.match(
    issues[0].comments.at(-1),
    /^It runs again\.\n\nRun: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/42/,
  );

  // A new failure after that is a new issue.
  await raise();
  assert.equal((await state()).length, 2);

  const log = (await readFile(join(dir, "log.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const call of log) {
    assert.ok(!call.args.includes("--assignee"), call.command);
  }
});

test("end to end: --repeat-hours, DRY_RUN, a failing gh and wrong arguments", async () => {
  const { dir, run, state, error } = await world();
  await run(["raise", "--title", TITLE, "--file", error]);
  // The issue was just created by the fake: activity is seconds old.
  const quiet = await run([
    "raise",
    "--title",
    TITLE,
    "--file",
    error,
    "--repeat-hours",
    "24",
  ]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /quiet/);
  assert.equal((await state())[0].comments.length, 0);

  // DRY_RUN touches nothing, not even to read.
  const before = (await readFile(join(dir, "log.jsonl"), "utf8")).length;
  const dry = await run(["clear", "--title", TITLE, "--comment", "x"], {
    DRY_RUN: "1",
  });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /DRY_RUN: would clear the issue/);
  assert.equal((await readFile(join(dir, "log.jsonl"), "utf8")).length, before);
  assert.equal((await state())[0].state, "open");

  // gh failing is a failed step, with the reason.
  const failing = await run(["raise", "--title", TITLE, "--file", error], {
    FAKE_GH_FAIL: "issue list",
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /ERROR: gh issue list failed/);

  // Wrong arguments and a missing file.
  const usage = await run(["raise", "--title", TITLE]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /raise needs --file/);
  const missing = await run([
    "raise",
    "--title",
    TITLE,
    "--file",
    join(dir, "nope.md"),
  ]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

// ---------------------------------------------------------------------------
// The workflows that use it
// ---------------------------------------------------------------------------
const readWorkflow = (name) =>
  readFileSync(join(root, ".github", "workflows", name), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** The steps of the first job with the comments removed: { name, condition, text }. */
function stepsOf(source) {
  const text = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const at = text.indexOf("\n    steps:\n");
  assert.ok(at >= 0, "the job has steps");
  return text
    .slice(at + "\n    steps:\n".length)
    .split(/\n(?=      - )/)
    .map((step) => ({
      text: step,
      name: step.match(/^\s*(?:- )?name: (.+)$/m)?.[1] ?? "",
      condition: step.match(/^\s+if: (.+)$/m)?.[1] ?? "",
    }));
}

const WORKFLOWS = [
  {
    file: "new-exam-monitor.yml",
    issues: [
      {
        title: "New Exam Monitor Failed",
        raiseWhen:
          "failure() && steps.check.outputs.extraction_failed == 'true'",
        clearWhen: "steps.check.outputs.extraction_failed == 'false'",
        errorFile: "/tmp/new-exam-error.md",
      },
      {
        title: "New Exam Monitor: study guide check stopped",
        raiseWhen: "steps.check.outputs.guide_check_failed == 'true'",
        clearWhen: "steps.check.outputs.guide_check_failed == 'false'",
        errorFile: "/tmp/new-exam-error.md",
      },
    ],
  },
  {
    file: "skills-hub-watch.yml",
    issues: [
      {
        title: "Skills Hub Watch Failed",
        raiseWhen:
          "${{ !cancelled() && steps.check.outputs.extraction_failed == 'true' }}",
        clearWhen:
          "steps.check.outputs.extraction_failed == 'false' && steps.check.outputs.feed_read == 'true'",
        errorFile: "/tmp/skills-hub-error.md",
        repeat: "--repeat-hours 24",
      },
    ],
  },
  {
    file: "learn-content-watch.yml",
    issues: [
      {
        title: "Learn Content Watch Failed",
        raiseWhen:
          "failure() && steps.check.outputs.extraction_failed == 'true'",
        clearWhen: "steps.check.outputs.extraction_failed == 'false'",
        errorFile: "/tmp/learn-content-watch-error.md",
      },
    ],
  },
  {
    file: "measureup-monitor.yml",
    issues: [
      {
        title: "MeasureUp Monitor Failed",
        raiseWhen:
          "failure() && steps.check.outputs.extraction_failed == 'true'",
        clearWhen: "steps.check.outputs.extraction_failed == 'false'",
        errorFile: "/tmp/measureup-error.md",
      },
    ],
  },
];

test("the failure issues of the workflows have a stable title, a comment per failed run, and are closed by a healthy run", () => {
  for (const { file, issues } of WORKFLOWS) {
    const source = readWorkflow(file);
    const steps = stepsOf(source);
    // Nothing in the workflow opens an issue with the run id in its title any more.
    assert.doesNotMatch(source, /Failed — \$\{\{ github\.run_id \}\}/, file);
    assert.doesNotMatch(source, /stopped — \$\{\{ github\.run_id \}\}/, file);
    assert.match(source, /issues: write/, file);
    for (const issue of issues) {
      const raise = steps.find((step) =>
        step.text.includes(`failure-issue.mjs raise --title "${issue.title}"`),
      );
      assert.ok(raise, `${file}: no raise step for "${issue.title}"`);
      assert.equal(raise.condition, issue.raiseWhen, `${file} ${issue.title}`);
      assert.match(raise.text, new RegExp(`--file ${issue.errorFile}`), file);
      assert.match(raise.text, /GH_TOKEN: \$\{\{ github\.token \}\}/, file);
      assert.match(raise.text, /--label bug/, file);
      if (issue.repeat) assert.ok(raise.text.includes(issue.repeat), file);
      assert.doesNotMatch(raise.text, /create-issue-from-file/, file);

      const clear = steps.find((step) =>
        step.text.includes(`failure-issue.mjs clear --title "${issue.title}"`),
      );
      assert.ok(clear, `${file}: no clear step for "${issue.title}"`);
      assert.equal(clear.condition, issue.clearWhen, `${file} ${issue.title}`);
      assert.match(clear.text, /--comment "/, file);
      assert.match(clear.text, /GH_TOKEN: \$\{\{ github\.token \}\}/, file);
      // The closing step keeps the implicit success(): it never runs after a failed step.
      assert.doesNotMatch(
        clear.condition,
        /failure\(\)|always\(\)|!cancelled\(\)/,
        file,
      );
      // Raising comes before closing.
      assert.ok(steps.indexOf(raise) < steps.indexOf(clear), file);
    }
    // The script is checked out and Node is set up before the failure steps.
    const names = steps.map((step) => step.text);
    assert.ok(
      names.findIndex((text) => text.includes("actions/setup-node")) <
        names.findIndex((text) => text.includes("failure-issue.mjs")),
      file,
    );
  }
});

test("the order the monitors rely on is kept: the issue and the tracker commit come before the failure steps", () => {
  for (const file of ["new-exam-monitor.yml", "skills-hub-watch.yml"]) {
    const steps = stepsOf(readWorkflow(file)).map((step) => step.name);
    const commit = steps.findIndex((name) => /^Commit updated/.test(name));
    const issue = steps.findIndex((name) =>
      /^Create issue if (a new|the Skills Hub)/.test(name),
    );
    assert.ok(
      issue >= 0 && commit > issue,
      `${file}: the issue comes before the commit`,
    );
  }
});
