// Properties of ALL workflows, and of the ones that push to main as one set: a
// monitor's own test can only compare itself with the others it knows about.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import * as prettier from "prettier";
import {
  codeOf,
  commitStepsOf,
  jobsOf,
  listWorkflowFiles,
  loadWorkflows,
  pushesToMain,
  readText as read,
  root,
  workflowDir,
} from "./helpers/workflows.mjs";

/** Every workflow file (.yml and .yaml) with its text, and whether it pushes to main. */
const workflows = loadWorkflows();
const pushing = workflows.filter((workflow) => workflow.pushes);

// A cron field as a sorted list of numbers: "5", "1,3", "1-3", "*" and steps
// ("every 6", "2-10 every 4").
function expand(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const step = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (part === "*") for (let n = min; n <= max; n++) out.add(n);
    else if (step) {
      const [from, to] =
        step[1] === "*" ? [min, max] : step[1].split("-").map(Number);
      for (let n = from; n <= to; n += Number(step[2])) out.add(n);
    } else if (/^\d+-\d+$/.test(part)) {
      const [from, to] = part.split("-").map(Number);
      for (let n = from; n <= to; n++) out.add(n);
    } else if (/^\d+$/.test(part)) out.add(Number(part));
    else throw new Error(`cannot read the cron field "${field}"`);
  }
  return [...out].sort((a, b) => a - b);
}

/** The (weekday, hour, minute) slots of every `- cron:` line of a workflow (day of month and month are taken as "every", the cautious reading). */
function slotsOf(workflow) {
  const slots = [];
  for (const match of workflow.code.matchAll(
    /^\s*- cron: "(\S+) (\S+) (\S+) (\S+) (\S+)"/gm,
  )) {
    const [, minute, hour, , , weekday] = match;
    for (const d of expand(weekday.replace(/^7$/, "0"), 0, 6)) {
      for (const h of expand(hour, 0, 23)) {
        for (const m of expand(minute, 0, 59)) {
          slots.push(
            `${d} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
          );
        }
      }
    }
  }
  return slots;
}

test("every workflow file is valid YAML", async () => {
  // GitHub rejects a workflow it cannot parse and runs nothing, and the
  // monitors' own tests read the steps with regular expressions, so a syntax
  // error would pass them all. A plain scalar with a colon and a space in it
  // (`run: node x --title "Monitor: stopped"`) is the classic mistake: it needs
  // a block scalar or quotes. Prettier's YAML parser throws on such a file.
  for (const workflow of workflows) {
    await assert.doesNotReject(
      prettier.format(workflow.source, { parser: "yaml" }),
      workflow.name,
    );
  }
  // And the parser does reject that mistake.
  await assert.rejects(
    prettier.format(
      [
        "steps:",
        "  - name: x",
        '    run: node a.mjs --title "Monitor: stopped"',
        "",
      ].join("\n"),
      { parser: "yaml" },
    ),
    /Nested mappings are not allowed/,
  );
});

const KNOWN_PUSHERS = [
  "applied-skills-monitor.yml",
  "beta-exam-monitor.yml",
  "lab-repos-check.yml",
  "learn-content-watch.yml",
  "learn-url-check.yml",
  "link-checker.yml",
  "measureup-monitor.yml",
  "new-exam-monitor.yml",
  "partner-designations-monitor.yml",
  "retiring-exam-monitor.yml",
  "skills-hub-watch.yml",
  "source-watch.yml",
  "voucher-challenge-monitor.yml",
  "voucher-review.yml",
];

test("the workflows that push to main are the ones the other tests know about", () => {
  // The set is derived from `git push` in the files (.yml and .yaml) and compared
  // with the list above.
  const found = pushing.map((workflow) => workflow.name);
  const added = found.filter((name) => !KNOWN_PUSHERS.includes(name));
  const gone = KNOWN_PUSHERS.filter((name) => !found.includes(name));
  assert.deepEqual(
    found,
    KNOWN_PUSHERS,
    `a workflow that starts pushing must be listed here on purpose (the slot, retry, permission, issue-order and commit-step tests then cover it). Pushes but is not listed: [${added.join(", ")}]. Listed but no longer pushes: [${gone.join(", ")}]`,
  );
  // The step reader agrees: the workflows with a run script that pushes are these.
  assert.deepEqual(
    workflows
      .filter((workflow) => commitStepsOf(workflow).length > 0)
      .map((workflow) => workflow.name),
    found,
    "`git push` appears in a workflow outside the run script of a step (or in a layout the step reader does not understand)",
  );
});

test("no two workflows that push to main start in the same minute on the same weekday", () => {
  const owner = new Map();
  for (const workflow of pushing) {
    const slots = slotsOf(workflow);
    assert.ok(slots.length > 0, `${workflow.name} has a schedule`);
    for (const slot of slots) {
      const other = owner.get(slot);
      assert.ok(
        !other || other === workflow.name,
        `${workflow.name} and ${other} both start at ${slot} (weekday 0 = Sunday, UTC)`,
      );
      owner.set(slot, workflow.name);
    }
  }
});

test("the cron expansion reads lists, ranges, steps and the weekday forms the workflows use", () => {
  assert.deepEqual(expand("*", 0, 6), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(expand("1,3", 0, 6), [1, 3]);
  assert.deepEqual(expand("1-3", 0, 6), [1, 2, 3]);
  assert.deepEqual(expand("*/6", 0, 23), [0, 6, 12, 18]);
  assert.deepEqual(expand("2-10/4", 0, 23), [2, 6, 10]);
  assert.throws(() => expand("MON", 0, 6), /cannot read/);
  const fake = {
    code: '    - cron: "20 0 * * *"\n    - cron: "20 6 * * 1"\n',
  };
  const slots = slotsOf(fake);
  assert.equal(slots.length, 7 + 1);
  assert.ok(slots.includes("3 00:20") && slots.includes("1 06:20"));
});

test("every workflow that pushes retries the push on top of what landed on main meanwhile", () => {
  for (const workflow of pushing) {
    assert.match(
      workflow.code,
      /for attempt in 1 2 3; do\n\s+git pull --rebase && git push && exit 0\n\s+git rebase --abort 2>\/dev\/null \|\| true\n\s+sleep \$\(\(attempt \* 5\)\)\n\s+done\n\s+exit 1/,
      `${workflow.name} pushes without the three tries`,
    );
  }
  // The retry is what protects two runs that do start together: a scheduled run
  // is often started hours late (several hours, observed in this repository), so
  // the distinct minutes above are a convenience and this loop is the protection.
});

// What documents and comments may not claim. "No other workflow that pushes to
// main starts at minute 20" was false: source-watch (08:20) and
// learn-content-watch (09:20) start at minute 20 too.
const SLOT_CLAIM =
  /no other (?:pushing )?(?:workflow|monitor)[^.\n]*starts at minute \d+/i;

/**
 * AGENTS.md first, then every Markdown file under docs/ (recursive, in name
 * order). No file is listed by name: the guidance about the workflows moves
 * between AGENTS.md and the runbooks in docs/monitors/, and a new file there is
 * read the day it is added. Without a docs/ folder there is only AGENTS.md.
 */
function agentDocFiles(base = root) {
  const files = [join(base, "AGENTS.md")];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
    }
  };
  walk(join(base, "docs"));
  return files;
}

/** AGENTS.md and every Markdown file under docs/ as one text (line endings normalised). */
const readAgentDocs = (base = root) =>
  agentDocFiles(base)
    .map((file) => read(file))
    .join("\n");

/** The files of AGENTS.md and docs/ whose text matches, relative to `base`: what a failure message names. */
const claimedIn = (pattern, base = root) =>
  agentDocFiles(base)
    .filter((file) => pattern.test(read(file)))
    .map((file) => relative(base, file).replace(/\\/g, "/"));

test("comments and documentation claim only what the slot test above enforces", () => {
  // What is true, and tested, is that no two workflows that push start at the
  // same time.
  for (const workflow of workflows) {
    assert.doesNotMatch(workflow.source, SLOT_CLAIM, workflow.name);
  }
  // The guidance lives in AGENTS.md and in the runbooks under docs/ and moves
  // between them, so all of it is read, whatever the files are called.
  if (SLOT_CLAIM.test(readAgentDocs())) {
    assert.fail(
      `${claimedIn(SLOT_CLAIM).join(", ")} claims that no other workflow starts at minute N, which is false: say that no two workflows that push start at the same time`,
    );
  }
  // The Skills Hub Watch states the true version.
  const skills = workflows.find(
    (workflow) => workflow.name === "skills-hub-watch.yml",
  );
  assert.match(
    skills.source,
    /No other workflow that pushes to main starts at the same time/,
  );
});

test("the docs the claim check reads are AGENTS.md and every Markdown file under docs/, however deep and whatever they are called", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "agent-docs-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const put = async (path, text) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), text);
  };
  await put("AGENTS.md", "agents text\n");
  await put("docs/top.md", "top text\n");
  await put("docs/monitors/a-name-nobody-listed.md", "runbook text\r\n");
  await put("docs/monitors/deeper/still/UPPER.MD", "deep text\n");
  // Not read: other file types, Markdown outside docs/ and another docs folder.
  await put("docs/notes.txt", "not markdown\n");
  await put("docs/monitors/figure.png", "not markdown either\n");
  await put("README.md", "outside docs\n");
  await put("src/docs/inner.md", "docs folder elsewhere\n");

  const text = readAgentDocs(base);
  for (const expected of [
    "agents text",
    "top text",
    "runbook text\n",
    "deep text",
  ]) {
    assert.ok(text.includes(expected), `"${expected.trim()}" was not read`);
  }
  for (const skipped of [
    "not markdown",
    "outside docs",
    "docs folder elsewhere",
  ]) {
    assert.ok(!text.includes(skipped), `"${skipped}" must not be read`);
  }
  assert.ok(!text.includes("\r"), "line endings are normalised");
  assert.deepEqual(
    agentDocFiles(base).map((file) => relative(base, file).replace(/\\/g, "/")),
    [
      "AGENTS.md",
      "docs/monitors/a-name-nobody-listed.md",
      "docs/monitors/deeper/still/UPPER.MD",
      "docs/top.md",
    ],
  );

  // What is true is accepted, the false claim is found in a file nobody listed,
  // and the files are named.
  assert.ok(!SLOT_CLAIM.test(text));
  await put(
    "docs/monitors/true.md",
    "No other workflow that pushes to `main` starts at the same time.\n",
  );
  assert.ok(!SLOT_CLAIM.test(readAgentDocs(base)));
  await put(
    "docs/monitors/deeper/still/a-new-runbook.md",
    "- No other workflow that pushes to `main` starts at minute 20.\n",
  );
  assert.ok(SLOT_CLAIM.test(readAgentDocs(base)));
  assert.deepEqual(claimedIn(SLOT_CLAIM, base), [
    "docs/monitors/deeper/still/a-new-runbook.md",
  ]);
  await put("AGENTS.md", "No other monitor that pushes starts at minute 5.\n");
  assert.deepEqual(claimedIn(SLOT_CLAIM, base), [
    "AGENTS.md",
    "docs/monitors/deeper/still/a-new-runbook.md",
  ]);

  // Without a docs/ folder there is only AGENTS.md.
  await rm(join(base, "docs"), { recursive: true });
  assert.equal(
    readAgentDocs(base),
    "No other monitor that pushes starts at minute 5.\n",
  );

  // And the real repository: AGENTS.md first, every file read exists.
  const real = agentDocFiles();
  assert.equal(real[0], join(root, "AGENTS.md"));
  assert.ok(real.every((file) => existsSync(file) && /\.md$/i.test(file)));
});

// Said once, and false: every workflow that pushes has the three tries (the test
// above), and GitHub often starts scheduled runs hours late, so a start minute of
// its own orders nothing. The protection is the retry; distinct minutes are only
// a convenience.
const FALSE_CLAIMS = [
  /\bwithout a retry\b/i,
  /\bno retry\b/i,
  /\bnever committed together\b/i,
  /\bso (?:both|all) can push\b/i,
  /\bcould make it fail\b/i,
  /\bwithout a long wait\b/i,
];

/** The lines of a text that make one of those claims, as "name:line: text". */
const falseClaimLines = (name, text) =>
  text
    .split("\n")
    .flatMap((line, index) =>
      FALSE_CLAIMS.some((claim) => claim.test(line))
        ? [`${name}:${index + 1}: ${line.trim()}`]
        : [],
    );

test("no workflow comment says that a pusher has no retry, or that its start minute keeps the pushes apart", () => {
  assert.deepEqual(
    workflows.flatMap((workflow) =>
      falseClaimLines(workflow.name, workflow.source),
    ),
    [],
    "these comments contradict the retry test and the way GitHub starts scheduled runs: say that the push retry is the protection and that distinct start minutes are only a convenience",
  );
  // The check finds the sentences that were removed from the comments, line by
  // line as they stood, and leaves the true ones alone.
  for (const line of [
    "# Mondays and pushes to main without a retry, so a push of this one in the",
    "# same minute could make it fail.",
    '- cron: "30 6 * * 1" # Monday 06:30 UTC (offset from the MeasureUp monitor so both can push)',
    '- cron: "0 8 * * 1" # Monday 08:00 UTC (offset from the other Monday monitors so all can push)',
    "# minute (a test keeps it that way), so two trackers are never committed together.",
    "# New Exam Monitor (06:45) push their trackers to main without a long wait.",
    "# the Applied Skills monitor has no retry",
  ]) {
    assert.equal(falseClaimLines("old.yml", line).length, 1, line);
  }
  for (const line of [
    "# Distinct start times are only a convenience, GitHub often starts runs hours late: the",
    "# push retry below, which every pusher has, is the protection.",
    "# No other workflow that pushes to main starts at the same time",
    "# retried on top of whatever landed meanwhile.",
    "# A push can land on main between the checkout and here: retry on top of it.",
  ]) {
    assert.deepEqual(falseClaimLines("ok.yml", line), [], line);
  }
});

// ---------------------------------------------------------------------------
// Supply chain, runner time, permissions, cancelling, and the order of issue and
// commit. Each rule is a function that returns the problems of one workflow; the
// tests assert that the real workflows have none and, further down, that the rule
// finds the mistake it exists for in a sample workflow.
// ---------------------------------------------------------------------------

function timeoutProblems(workflow) {
  const jobs = jobsOf(workflow.source);
  if (jobs.length === 0) {
    return [
      `${workflow.name}: no jobs were found (is the file still in Prettier's layout?)`,
    ];
  }
  return jobs
    .filter((job) => !/^[1-9]\d*$/.test(job.timeoutMinutes ?? ""))
    .map(
      (job) =>
        `${workflow.name}: job "${job.id}" has no timeout-minutes (GitHub's default is 360 minutes, so a hung step holds the runner for six hours)`,
    );
}

function pinProblems(workflow) {
  const problems = [];
  for (const [, ref, rest] of workflow.source.matchAll(
    /^\s*(?:- )?uses:[ \t]*(\S+)(.*)$/gm,
  )) {
    if (ref.startsWith("./")) continue; // an action of this repository
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) {
      problems.push(
        `${workflow.name}: "${ref}" is not pinned to a full 40-character commit SHA (a tag can be moved to other code, and these jobs hold tokens that can push to main)`,
      );
    } else if (!/^\s+#\s*v\d+(?:\.\d+){0,2}\s*$/.test(rest)) {
      problems.push(
        `${workflow.name}: "${ref}" has no "# vN" comment that names the version the SHA stands for`,
      );
    }
  }
  return problems;
}

function permissionProblems(workflow) {
  const problems = [];
  if (/^\s*contents:\s*write\b/m.test(workflow.code) && !workflow.pushes) {
    problems.push(
      `${workflow.name} has contents: write but never runs git push: only a job that pushes may hold a token that can push to main`,
    );
  }
  for (const job of jobsOf(workflow.source)) {
    const pushes = job.steps.some(
      (step) => step.run !== null && pushesToMain(codeOf(step.run)),
    );
    if (pushes && job.permissions.contents !== "write") {
      problems.push(
        `${workflow.name}: job "${job.id}" runs git push without contents: write, so the push would be refused`,
      );
    }
  }
  return problems;
}

function cancelProblems(workflow) {
  return workflow.pushes &&
    /^\s*cancel-in-progress:\s*true\b/m.test(workflow.code)
    ? [
        `${workflow.name} pushes to main and has cancel-in-progress: true: a newer run would cancel it between the issue and the tracker commit and the alert would be lost (use false: the newer run waits)`,
      ]
    : [];
}

function nodeVersionProblems(workflow) {
  const problems = [];
  if (/^\s*(?:- )?node-version:/m.test(workflow.code)) {
    problems.push(
      `${workflow.name} has a literal "node-version:" (use "node-version-file: .node-version": that file is the one place that names the Node version, so CI, the monitors and the engines of package.json cannot drift apart)`,
    );
  }
  for (const job of jobsOf(workflow.source)) {
    for (const step of job.steps) {
      if (
        step.uses?.ref.startsWith("actions/setup-node@") &&
        step.with["node-version-file"] !== ".node-version"
      ) {
        problems.push(
          `${workflow.name}: the setup-node step of job "${job.id}" must use node-version-file: .node-version`,
        );
      }
    }
  }
  return problems;
}

// A monitor that opens an issue about what it found AND records that in a
// tracker it commits must open the issue first. The tracker is what keeps the next
// run from reporting the same thing, so a tracker that is on main before the issue
// exists loses the alert for good when the issue step fails or the run is
// cancelled. The rule, precisely:
//   An ISSUE STEP is a step that opens or updates an issue: `uses:
//   peter-evans/create-issue-from-file`, a `run` with `gh issue ...`, a `run` with
//   `failure-issue.mjs raise`, or a step with the env CREATE_ISSUES (the monitor
//   script opens its issues itself, with gh).
//   A FAILURE REPORT is an issue step that says the check itself failed or
//   stopped: every `failure-issue.mjs raise` step (one issue with a stable title,
//   de-duplicated by that title and not by the tracker; the New Exam Monitor
//   raises "study guide check stopped" after its commit on purpose) and every
//   issue step whose `if` calls failure(). They may come after the commit.
//   An ALERT STEP is an issue step that is not a failure report: it tells what
//   the check found.
// In a job that has a commit step (a run script with `git push`) and an issue step:
//   1. every alert step comes BEFORE the commit step,
//   2. the commit step has no status-check function in its `if` (always(),
//      failure(), success(), cancelled()), so an earlier step that failed skips it, and
//   3. no alert step has continue-on-error (a failed issue step must stop the commit).
const STATUS_FUNCTION = /\b(?:always|failure|success|cancelled)\s*\(\s*\)/;

function issueMechanism(step) {
  const script = codeOf(step.run ?? "");
  if (step.uses?.ref.startsWith("peter-evans/create-issue-from-file@")) {
    return "create-issue-from-file";
  }
  if (/\bgh issue \w/.test(script)) return "gh issue";
  if (/failure-issue\.mjs raise\b/.test(script)) return "failure-issue raise";
  if (step.env.CREATE_ISSUES) return "CREATE_ISSUES";
  return null;
}

const isFailureReport = (step) =>
  issueMechanism(step) === "failure-issue raise" ||
  /\bfailure\s*\(\s*\)/.test(step.condition);

const isAlertStep = (step) =>
  issueMechanism(step) !== null && !isFailureReport(step);

function orderProblems(workflow) {
  const problems = [];
  for (const job of jobsOf(workflow.source)) {
    const commits = job.steps.filter(
      (step) => step.run !== null && pushesToMain(codeOf(step.run)),
    );
    if (commits.length === 0) continue;
    if (!job.steps.some((step) => issueMechanism(step) !== null)) continue;
    for (const commit of commits) {
      if (STATUS_FUNCTION.test(commit.condition)) {
        problems.push(
          `${workflow.name}: the commit step "${commit.name}" has a status-check function in its if (${commit.condition}), so it also runs after a failed issue step: the tracker would be on main and the alert lost`,
        );
      }
      for (const step of job.steps.filter(isAlertStep)) {
        if (step.index > commit.index) {
          problems.push(
            `${workflow.name}: "${step.name}" opens an issue AFTER the commit step "${commit.name}": when it fails or the run is cancelled the tracker is already on main and the alert is lost; open the issue first`,
          );
        }
        if (step.continueOnError) {
          problems.push(
            `${workflow.name}: "${step.name}" has continue-on-error, so a failed issue step would not stop the commit`,
          );
        }
      }
    }
  }
  return problems;
}

test("every job has a timeout-minutes", () => {
  assert.deepEqual(workflows.flatMap(timeoutProblems), []);
});

test("every action is pinned to a full commit SHA with a # vN comment", () => {
  assert.deepEqual(workflows.flatMap(pinProblems), []);
  assert.ok(
    workflows.some((workflow) =>
      /uses: \S+@[0-9a-f]{40} # v\d/.test(workflow.source),
    ),
    "no pinned action was found: is the pattern still reading the workflows?",
  );
});

test("contents: write is only for the jobs that push", () => {
  assert.deepEqual(workflows.flatMap(permissionProblems), []);
});

test("a workflow that pushes to main is never cancelled half way", () => {
  assert.ok(pushing.length > 0);
  assert.deepEqual(workflows.flatMap(cancelProblems), []);
});

test("a monitor opens its issue before it commits its tracker, and a failed issue step skips the commit", () => {
  assert.deepEqual(pushing.flatMap(orderProblems), []);
  // The rule looked at something: the issue steps of the pushing workflows are recognised.
  const recognised = pushing
    .filter((workflow) =>
      jobsOf(workflow.source).some((job) => job.steps.some(isAlertStep)),
    )
    .map((workflow) => workflow.name);
  for (const legacy of [
    "applied-skills-monitor.yml",
    "beta-exam-monitor.yml",
    "voucher-challenge-monitor.yml",
  ]) {
    assert.ok(
      recognised.includes(legacy),
      `${legacy}: its issue step is not recognised, so the order rule checks nothing there`,
    );
  }
  assert.ok(
    recognised.length >= 11,
    `the order rule recognised an issue step in only ${recognised.length} of ${pushing.length} pushing workflows: ${recognised.join(", ")}`,
  );
});

test("every Node setup reads .node-version, and no workflow names a Node version itself", () => {
  assert.deepEqual(workflows.flatMap(nodeVersionProblems), []);
  const setups = workflows.flatMap((workflow) =>
    jobsOf(workflow.source).flatMap((job) =>
      job.steps.filter((step) =>
        step.uses?.ref.startsWith("actions/setup-node@"),
      ),
    ),
  );
  assert.ok(setups.length > 0, "no setup-node step was found");
  // .node-version is also what package.json promises in its engines.
  const major = Number(read(join(root, ".node-version")).trim().split(".")[0]);
  assert.ok(major > 0, ".node-version does not start with a version number");
  const { engines } = JSON.parse(read(join(root, "package.json")));
  assert.equal(
    engines.node,
    `>=${major} <${major + 1}`,
    "the engines of package.json and .node-version name different Node versions",
  );
});

test("the workflow files are found whatever their extension, .yml or .yaml", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["b.yaml", "a.yml", "c.txt", "d.yml.bak", "e.md"]) {
    await writeFile(join(dir, name), "name: x\non: push\njobs: {}\n");
  }
  assert.deepEqual(listWorkflowFiles(dir), ["a.yml", "b.yaml"]);
  assert.deepEqual(
    loadWorkflows(dir).map((workflow) => workflow.name),
    ["a.yml", "b.yaml"],
  );
  // And the real folder is read the same way: every file that GitHub would run is in the set.
  assert.deepEqual(
    workflows.map((workflow) => workflow.name),
    listWorkflowFiles(workflowDir),
  );
  assert.ok(workflows.length > 0);
});

// Sample workflows in the layout the readers expect, for the tests of the rules.
const sample = (steps, header = ["    timeout-minutes: 10"]) => ({
  name: "sample.yml",
  source: [
    "name: Sample",
    "",
    "on:",
    "  workflow_dispatch:",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    ...header,
    "    steps:",
    ...steps,
    "",
  ].join("\n"),
  get code() {
    return codeOf(this.source);
  },
  get pushes() {
    return pushesToMain(this.code);
  },
});
const CHECK = [
  "      - name: Check",
  "        id: check",
  "        run: node scripts/check.mjs",
];
const ISSUE_ACTION =
  "peter-evans/create-issue-from-file@fca9117c27cdc29c6c4db3b86c48e4115a786710 # v6";
const ISSUE = [
  "      - name: Create issue",
  "        if: steps.check.outputs.changes_found == 'true'",
  `        uses: ${ISSUE_ACTION}`,
  "        with:",
  "          title: Changes",
];
const commit = (
  condition = "steps.check.outputs.baseline_updated == 'true'",
) => [
  "      - name: Commit",
  `        if: ${condition}`,
  "        run: |",
  "          git add tracker.json",
  '          git commit -m "Update"',
  "          git pull --rebase && git push && exit 0",
];

test("the step reader understands the shapes the workflows use", () => {
  const { source } = sample(
    [
      `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`,
      "",
      "      # A comment between two steps.",
      "      - name: Commit",
      "        id: commit",
      "        if: ${{ !cancelled() && steps.check.outputs.baseline_updated == 'true' }}",
      "        continue-on-error: true",
      "        env:",
      "          GH_TOKEN: ${{ github.token }}",
      '          CREATE_ISSUES: "1"',
      "        run: |",
      "          # a comment of the script",
      '          git commit -m "x"',
      "",
      "          for attempt in 1 2 3; do sleep $((attempt * 5)); done",
      "",
      "      - run: node scripts/x.mjs # why",
    ],
    [
      "    timeout-minutes: 15",
      "    permissions:",
      "      contents: write",
      "      issues: write",
      "    env:",
      "      REPORT_FILE: /tmp/r.md",
    ],
  );
  const [job] = jobsOf(source);
  assert.equal(job.id, "check");
  assert.equal(job.timeoutMinutes, "15");
  assert.deepEqual(job.permissions, { contents: "write", issues: "write" });
  assert.deepEqual(job.env, { REPORT_FILE: "/tmp/r.md" });
  assert.equal(job.steps.length, 3);
  const [checkout, step, plain] = job.steps;
  assert.deepEqual(checkout.uses, {
    ref: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    comment: "v7",
  });
  assert.equal(checkout.run, null);
  assert.equal(step.name, "Commit");
  assert.equal(step.id, "commit");
  assert.equal(
    step.condition,
    "${{ !cancelled() && steps.check.outputs.baseline_updated == 'true' }}",
  );
  assert.equal(step.continueOnError, true);
  assert.deepEqual(step.env, {
    GH_TOKEN: "${{ github.token }}",
    CREATE_ISSUES: "1",
  });
  assert.equal(
    step.run,
    '# a comment of the script\ngit commit -m "x"\n\nfor attempt in 1 2 3; do sleep $((attempt * 5)); done\n',
  );
  assert.equal(plain.run, "node scripts/x.mjs");
  assert.equal(plain.uses, null);
});

test("the rules find the mistakes they exist for", () => {
  const problemsOf = (rule, workflow) => rule(workflow).join("\n");

  // A job without timeout-minutes.
  assert.deepEqual(timeoutProblems(sample(CHECK)), []);
  assert.match(
    problemsOf(timeoutProblems, sample(CHECK, [])),
    /job "check" has no timeout-minutes/,
  );

  // Actions that are not pinned, or pinned without the version they stand for.
  const uses = (ref) => sample([`      - uses: ${ref}`]);
  assert.deepEqual(
    pinProblems(uses(`actions/checkout@${"a".repeat(40)} # v7`)),
    [],
  );
  assert.deepEqual(pinProblems(uses("./local-action")), []);
  for (const ref of [
    "actions/checkout@v7",
    "actions/checkout@main",
    `actions/checkout@${"a".repeat(39)} # v7`,
    "docker://alpine:3",
  ]) {
    assert.match(
      problemsOf(pinProblems, uses(ref)),
      /is not pinned to a full 40-character commit SHA/,
      ref,
    );
  }
  for (const rest of ["", " # latest", " # the checkout"]) {
    assert.match(
      problemsOf(
        pinProblems,
        uses(`actions/checkout@${"a".repeat(40)}${rest}`),
      ),
      /has no "# vN" comment/,
      rest,
    );
  }

  // contents: write without a push, and a push without contents: write.
  const writer = [
    "    timeout-minutes: 10",
    "    permissions:",
    "      contents: write",
  ];
  assert.deepEqual(
    permissionProblems(sample([...CHECK, ...commit()], writer)),
    [],
  );
  assert.match(
    problemsOf(permissionProblems, sample(CHECK, writer)),
    /has contents: write but never runs git push/,
  );
  assert.match(
    problemsOf(permissionProblems, sample([...CHECK, ...commit()])),
    /runs git push without contents: write/,
  );

  // A workflow that pushes and cancels the run in progress.
  const concurrency = (value) => ({
    ...sample([...CHECK, ...commit()]),
    code: `concurrency:\n  group: x\n  cancel-in-progress: ${value}\n${codeOf(sample([...CHECK, ...commit()]).source)}`,
    pushes: true,
  });
  assert.deepEqual(cancelProblems(concurrency("false")), []);
  assert.match(
    problemsOf(cancelProblems, concurrency("true")),
    /pushes to main and has cancel-in-progress: true/,
  );

  // A literal Node version, and a setup that does not read the file.
  const setup = (...lines) =>
    sample([
      "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
      "        with:",
      ...lines,
    ]);
  assert.deepEqual(
    nodeVersionProblems(setup("          node-version-file: .node-version")),
    [],
  );
  assert.match(
    problemsOf(nodeVersionProblems, setup("          node-version: 22")),
    /has a literal "node-version:"/,
  );
  assert.match(
    problemsOf(nodeVersionProblems, setup("          cache: pnpm")),
    /must use node-version-file: \.node-version/,
  );
});

test("the order rule accepts issue-first workflows and rejects the legacy order and a commit that survives a failed step", () => {
  const FAILURE_REPORT = [
    "      - name: Create issue if the check failed",
    "        if: failure() && steps.check.outputs.extraction_failed == 'true'",
    `        uses: ${ISSUE_ACTION}`,
  ];
  const RAISE = (condition) => [
    "      - name: Raise the stable issue",
    `        if: ${condition}`,
    "        run: |",
    '          node scripts/failure-issue.mjs raise --title "Failed" --file /tmp/e.md',
  ];
  const checkWithIssues = [
    "      - name: Check",
    "        id: check",
    "        env:",
    '          CREATE_ISSUES: "1"',
    "        run: node scripts/check.mjs",
  ];
  const problems = (steps) => orderProblems(sample(steps));

  // Accepted: the shapes of the 11 workflows that were issue-first, and of the 3 fixed ones.
  assert.deepEqual(problems([...CHECK, ...ISSUE, ...commit()]), []);
  assert.deepEqual(problems([...checkWithIssues, ...commit()]), []);
  assert.deepEqual(
    problems([...CHECK, ...ISSUE, ...commit(), ...FAILURE_REPORT]),
    [],
    "a report that the check failed may come after the commit",
  );
  assert.deepEqual(
    problems([
      ...CHECK,
      ...ISSUE,
      ...commit(),
      ...RAISE("steps.check.outputs.guide_check_failed == 'true'"),
    ]),
    [],
    "so may the stable-title issue of failure-issue.mjs raise",
  );
  assert.deepEqual(
    problems([
      ...CHECK,
      ...ISSUE,
      ...RAISE(
        "${{ !cancelled() && steps.check.outputs.extraction_failed == 'true' }}",
      ),
      ...commit(),
    ]),
    [],
  );
  // A pushing job without any issue step is not this rule's business.
  assert.deepEqual(problems([...CHECK, ...commit("always()")]), []);

  // The order of the three monitors before they were fixed: commit, then issue.
  assert.match(
    problems([...CHECK, ...commit(), ...ISSUE]).join("\n"),
    /"Create issue" opens an issue AFTER the commit step "Commit"/,
  );
  assert.match(
    problems([
      ...CHECK,
      ...commit(),
      "      - name: Open it with gh",
      "        run: gh issue create --title x --body-file /tmp/r.md",
    ]).join("\n"),
    /AFTER the commit step/,
  );
  assert.match(
    problems([
      ...CHECK,
      ...commit(),
      "      - name: Check again",
      "        env:",
      '          CREATE_ISSUES: "1"',
      "        run: node scripts/check.mjs",
    ]).join("\n"),
    /AFTER the commit step/,
  );
  // A commit that also runs after a failed step.
  for (const condition of [
    "always() && steps.check.outputs.baseline_updated == 'true'",
    "failure() && steps.check.outputs.baseline_updated == 'true'",
    "success() && steps.check.outputs.baseline_updated == 'true'",
    "${{ !cancelled() && steps.check.outputs.baseline_updated == 'true' }}",
  ]) {
    assert.match(
      problems([...CHECK, ...ISSUE, ...commit(condition)]).join("\n"),
      /status-check function in its if/,
      condition,
    );
  }
  // A failed issue step that does not stop the run.
  assert.match(
    problems([
      ...CHECK,
      ...ISSUE.slice(0, 3),
      "        continue-on-error: true",
      ...ISSUE.slice(3),
      ...commit(),
    ]).join("\n"),
    /has continue-on-error/,
  );
});

test("CI runs on pull requests, on pushes to main and by hand", () => {
  // A push made with GITHUB_TOKEN (the monitors') starts no workflow, so only
  // pushes of people run CI on main.
  const ci = workflows.find((workflow) => workflow.name === "ci.yml");
  assert.ok(ci, "no ci.yml");
  assert.match(ci.code, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(ci.code, /^ {2}pull_request:$/m);
  assert.match(ci.code, /^ {2}workflow_dispatch:$/m);
});

test("Dependabot keeps the pinned actions current, in one pull request", async () => {
  const text = read(join(root, ".github", "dependabot.yml"));
  await assert.doesNotReject(prettier.format(text, { parser: "yaml" }));
  assert.match(text, /^version: 2$/m);
  const entry = text
    .split(/^ {2}- /m)
    .find((part) => /^package-ecosystem: github-actions$/m.test(part));
  assert.ok(entry, "no update entry for the github-actions ecosystem");
  assert.match(entry, /^ {4}directory: "\/"$/m);
  assert.match(entry, /^ {4}schedule:\n {6}interval: weekly$/m);
  assert.match(entry, /^ {4}open-pull-requests-limit: 5$/m);
  assert.match(
    entry,
    /^ {4}groups:\n {6}[\w-]+:\n {8}patterns:\n {10}- "\*"$/m,
  );
});

test("the format scripts quote their globs so that cmd.exe, PowerShell and sh pass them on to Prettier alike", () => {
  const { scripts } = JSON.parse(read(join(root, "package.json")));
  const patterns = (name) =>
    scripts[name].replace(/^prettier --(?:write|check) /, "");
  for (const name of ["format", "format:check"]) {
    assert.doesNotMatch(
      scripts[name],
      /'/,
      `${name}: pnpm runs scripts with cmd.exe on Windows, which keeps single quotes as part of the pattern ("No files matching the pattern")`,
    );
    assert.doesNotMatch(
      scripts[name].replace(/"[^"]*"/g, ""),
      /[*?{}[\]]/,
      `${name}: a glob outside double quotes is expanded by sh and not at all by cmd.exe`,
    );
  }
  assert.equal(
    patterns("format"),
    patterns("format:check"),
    "format and format:check must cover the same files",
  );
  const covered = patterns("format").split(" ");
  for (const pattern of [
    '"scripts/**/*.mjs"',
    '"tests/**/*.mjs"',
    '".github/workflows/*.yml"',
    ".github/dependabot.yml",
    "package.json",
  ]) {
    assert.ok(covered.includes(pattern), `${pattern} is not formatted`);
  }
});

test("nothing uses linkinator any more, so it is not a dependency", () => {
  // The Link Checker runs lychee; linkinator crawled five pages and was dropped.
  const manifest = JSON.parse(read(join(root, "package.json")));
  assert.ok(
    !(
      "linkinator" in { ...manifest.dependencies, ...manifest.devDependencies }
    ),
    "linkinator is still in package.json: run pnpm remove linkinator",
  );
  assert.doesNotMatch(
    read(join(root, "pnpm-lock.yaml")),
    /linkinator/,
    "pnpm-lock.yaml still mentions linkinator",
  );
});
