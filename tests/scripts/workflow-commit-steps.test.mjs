// Runs the commit step of EVERY workflow that pushes to main, for real, against a
// scratch git remote (helpers/git-remote.mjs). The bash of the step is taken out
// of the workflow file, so what runs here is what the runner runs. Per workflow
// the step must
//   - make no commit when its tracker is unchanged,
//   - commit and push only the tracker path(s) it `git add`s,
//   - rebase onto a push that landed on main meanwhile,
//   - try a push that was rejected once again, and
//   - fail (exit code not 0) when the push is rejected three times.
// The monitors' own tests do the same for their own step (copy-pasted); this file
// is the generic version. The workflows are found by their `git push`, so a new
// pushing workflow is covered the day it is added.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  bashSkipReason,
  exec,
  findBash,
  gitDir,
  makeScratchRemote,
  pushAttempts,
  rejectFirstPushes,
  runBash,
} from "./helpers/git-remote.mjs";
import { codeOf, commitStepsOf, loadWorkflows } from "./helpers/workflows.mjs";

const workflows = loadWorkflows();
const commitSteps = workflows.flatMap((workflow) =>
  commitStepsOf(workflow).map(({ job, step }) => ({ workflow, job, step })),
);

const bash = findBash();
const skip = bashSkipReason(bash);
const gitSkip =
  spawnSync("git", ["--version"]).status === 0 ? false : "git is not available";

// ---------------------------------------------------------------------------
// What the harness needs to know about a commit step
// ---------------------------------------------------------------------------

// Expressions of the workflow language mean nothing outside GitHub Actions, so
// the ones a commit step uses are replaced by fixed values (a token, the name of
// the repository) before the script runs. An expression that is not listed here
// fails the test and names itself: stripping it would silently change what the
// script does (`git push origin ${{ github.ref_name }}` would push nothing).
const EXPRESSIONS = new Map([
  ["github.token", "test-token"],
  ["secrets.GITHUB_TOKEN", "test-token"],
  ["github.repository", "mscerts/hub"],
  ["github.run_id", "1"],
  ["github.actor", "github-actions[bot]"],
]);

function evaluate(text, where) {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    assert.ok(
      EXPRESSIONS.has(expression),
      `${where} uses \${{ ${expression} }}, which this test cannot evaluate: add it to EXPRESSIONS in tests/scripts/workflow-commit-steps.test.mjs`,
    );
    return EXPRESSIONS.get(expression);
  });
}

/** `$NAME` and `${NAME}` of a shell word, from the env of the step. */
function expand(text, env, where) {
  return text.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
    const name = braced ?? bare;
    assert.ok(name in env, `${where}: $${name} is not set by the step`);
    return env[name];
  });
}

// The only URL a step may give `origin` (the Link Checker's checkout keeps no
// credential, so its commit step does): this repository on github.com with the
// job token.
const JOB_TOKEN_URL =
  "https://x-access-token:test-token@github.com/mscerts/hub.git";

/** The script of a commit step as the runner sees it, and what it adds, commits and commits as. */
function describeStep({ workflow, job, step }) {
  const where = `${workflow.name} "${step.name}"`;
  const env = {};
  for (const [name, value] of Object.entries({ ...job.env, ...step.env })) {
    env[name] = evaluate(value, `${where} (env ${name})`);
  }
  const script = evaluate(step.run, where);
  const code = codeOf(script);
  const added = [...code.matchAll(/^\s*git add (.+?)\s*$/gm)].flatMap((match) =>
    match[1].split(/\s+/),
  );
  assert.ok(added.length > 0, `${where} never runs "git add <path>"`);
  for (const path of added) {
    assert.match(
      path,
      /^\w[\w./-]*$/,
      `${where} stages "${path}": a commit step stages its named tracker file(s) only, never "git add ." or "-A" (it would commit whatever else is in the work tree)`,
    );
  }
  const message = code.match(/^\s*git commit -m "([^"]+)"\s*$/m)?.[1];
  assert.ok(message, `${where} has no "git commit -m" line`);
  const name = code.match(/^\s*git config user\.name "([^"]+)"\s*$/m)?.[1];
  const email = code.match(/^\s*git config user\.email "([^"]+)"\s*$/m)?.[1];
  assert.ok(
    name && email,
    `${where} must set user.name and user.email (a runner has no git identity)`,
  );
  // A step that points `origin` at github.com is run unchanged: the scratch git
  // configuration sends that URL to the scratch origin.
  const url = code.match(
    /^\s*git remote set-url origin "?([^"\n]+?)"?\s*$/m,
  )?.[1];
  return {
    where,
    script,
    env,
    added,
    message,
    author: { name, email },
    remoteUrl: url ? expand(url, env, where) : null,
  };
}

// The wait between the tries (5, 10 and 15 seconds on the runner) is cut to
// nothing by a function that shadows `sleep`; the script itself is not touched.
const SLEEPLESS = "sleep() { :; }\n";

const STRAY_TRACKED = "src/stray-tracked.json";
const content = (path, revision) =>
  `{"tracker":"${path}","revision":${revision}}\n`;

async function setUp(info, prefix) {
  const files = { [STRAY_TRACKED]: "{}\n" };
  for (const path of info.added) files[path] = content(path, 0);
  const remote = await makeScratchRemote({ prefix, files });
  if (info.remoteUrl) await remote.redirect(info.remoteUrl);
  return remote;
}

function contextFor(remote, info, script = info.script) {
  return {
    remote,
    info,
    revision: 1,
    run: () =>
      runBash(bash, SLEEPLESS + script, {
        cwd: remote.work,
        env: { ...remote.env, ...info.env },
      }),
  };
}

/** The monitor found something new: its tracker(s) change. Every call writes new content. */
async function writeTrackers(context) {
  const { remote, info } = context;
  const revision = context.revision++;
  for (const path of info.added) {
    await remote.write(remote.work, path, content(path, revision));
  }
  return revision;
}

const failure = (result) =>
  `exit code ${result.code}: ${result.stderr.trim() || "(no stderr)"}`;

// Each scenario starts from a work tree that is level with the origin and leaves
// it that way (the last one leaves its rejected commit behind), so they can run
// one after the other on one scratch remote and each on a fresh one.
const scenarios = {
  async unchanged(context) {
    const { remote, run } = context;
    const before = await remote.subjects();
    // Other changes in the work tree: a tracked file and an untracked one. They
    // are none of the step's business.
    await remote.write(remote.work, STRAY_TRACKED, '{"stray":true}\n');
    await remote.write(remote.work, "stray.txt", "x\n");
    const result = await run();
    assert.equal(
      result.code,
      0,
      `an unchanged tracker must end the step with success; ${failure(result)}`,
    );
    assert.deepEqual(
      await remote.subjects(),
      before,
      "an unchanged tracker must not be pushed (a step that stages more than its tracker would commit the stray files)",
    );
    assert.equal(
      await remote.git(remote.work, "rev-list", "--count", "@{upstream}..HEAD"),
      "0",
      "an unchanged tracker must not be committed at all",
    );
    await remote.git(remote.work, "checkout", "--", STRAY_TRACKED);
    await rm(join(remote.work, "stray.txt"));
  },

  async commitsAndRebases(context) {
    const { remote, info, run } = context;
    const before = await remote.subjects();
    await remote.concurrentPush(); // a push to main after the checkout
    const revision = await writeTrackers(context);
    await remote.write(remote.work, "stray.txt", "x\n");
    const result = await run();
    assert.equal(
      result.code,
      0,
      `the step must push its commit on top of the push that landed meanwhile; ${failure(result)}`,
    );
    assert.deepEqual(
      await remote.subjects(),
      [info.message, "elsewhere", ...before],
      "main must hold one new commit with the message of the step, on top of the concurrent push",
    );
    assert.deepEqual(
      (await remote.changedFiles()).sort(),
      [...info.added].sort(),
      "the pushed commit must hold the tracker path(s) the step adds and nothing else",
    );
    for (const path of info.added) {
      assert.equal(
        await remote.show(path),
        content(path, revision).trim(),
        `${path} on main must be the tracker the step committed`,
      );
    }
    const files = await remote.files();
    assert.ok(files.includes("elsewhere.txt"), "the concurrent push is lost");
    assert.ok(!files.includes("stray.txt"), "a stray file was committed");
    assert.equal(
      await gitDir(remote, "log", "-1", "--format=%an <%ae>"),
      `${info.author.name} <${info.author.email}>`,
      "the commit must be made as the user the step configures",
    );
    await rm(join(remote.work, "stray.txt"));
  },

  async retriesOnce(context) {
    const { remote, info, run } = context;
    const before = await remote.subjects();
    await rejectFirstPushes(remote, 1);
    await writeTrackers(context);
    const result = await run();
    assert.equal(
      result.code,
      0,
      `a push rejected once must be tried again; ${failure(result)}`,
    );
    assert.deepEqual(
      await remote.subjects(),
      [info.message, ...before],
      "the second try must put the commit on main",
    );
    assert.equal(
      await pushAttempts(remote),
      2,
      "the origin must have seen two pushes: the one it rejected and the one it accepted",
    );
  },

  async failsAfterThree(context) {
    const { remote, run } = context;
    const before = await remote.subjects();
    await rejectFirstPushes(remote, 3);
    await writeTrackers(context);
    const result = await run();
    assert.notEqual(
      result.code,
      0,
      "a push rejected three times must fail the step: the run turns red and the next run tries again",
    );
    assert.deepEqual(
      await remote.subjects(),
      before,
      "nothing may reach main when every push is rejected",
    );
    assert.equal(
      await pushAttempts(remote),
      3,
      "the step must try exactly three times",
    );
  },
};

// ---------------------------------------------------------------------------
// Every workflow that pushes to main
// ---------------------------------------------------------------------------

test("every workflow that pushes to main has a commit step that this file runs", () => {
  const pushers = workflows
    .filter((workflow) => workflow.pushes)
    .map((workflow) => workflow.name);
  const covered = [
    ...new Set(commitSteps.map(({ workflow }) => workflow.name)),
  ];
  assert.ok(pushers.length > 0, "no workflow that pushes was found");
  assert.deepEqual(
    covered,
    pushers,
    "a workflow runs `git push` somewhere this file does not find a step with a run script",
  );
});

test("a commit step is plain git and bash, so it can be run outside GitHub Actions", () => {
  for (const entry of commitSteps) {
    const info = describeStep(entry);
    assert.doesNotMatch(
      entry.step.text,
      /^(?: {8}| {6}- )(?:working-directory|shell):/m,
      `${info.where}: the scratch run uses the work tree root and the default shell`,
    );
    if (info.remoteUrl !== null) {
      assert.equal(
        info.remoteUrl,
        JOB_TOKEN_URL,
        `${info.where} gives origin a URL that is not this repository with the job token`,
      );
    }
  }
});

describe(
  "the commit step of every workflow that pushes to main, run against a scratch remote",
  { concurrency: 4 },
  () => {
    for (const entry of commitSteps) {
      test(
        `${entry.workflow.name}: "${entry.step.name}"`,
        { skip },
        async (t) => {
          const info = describeStep(entry);
          const remote = await setUp(
            info,
            `${entry.workflow.name.replace(/\.ya?ml$/, "")}-`,
          );
          t.after(() => remote.cleanup());
          const context = contextFor(remote, info);
          await t.test("makes no commit when its tracker is unchanged", () =>
            scenarios.unchanged(context),
          );
          await t.test(
            "commits and pushes only the tracker path(s) it adds, rebased onto a concurrent push",
            () => scenarios.commitsAndRebases(context),
          );
          await t.test("tries a push that was rejected once again", () =>
            scenarios.retriesOnce(context),
          );
          await t.test(
            "fails the step when the push is rejected three times",
            () => scenarios.failsAfterThree(context),
          );
        },
      );
    }
  },
);

// ---------------------------------------------------------------------------
// The scenarios must be able to fail: each of these broken commit steps has to be
// caught by the scenario that exists for it
// ---------------------------------------------------------------------------

describe(
  "the scenarios catch a commit step that is broken in the ways they exist for",
  { concurrency: 4 },
  () => {
    const mutate = (script, from, to) => {
      assert.ok(script.includes(from), `the step has no "${from}" to break`);
      return script.replace(from, to);
    };
    const broken = [
      [
        "stages everything in the work tree",
        "unchanged",
        (info) =>
          mutate(info.script, `git add ${info.added.join(" ")}`, "git add -A"),
        /must not be pushed/,
      ],
      [
        "commits although nothing was staged",
        "unchanged",
        (info) =>
          mutate(info.script, "git diff --cached --quiet && exit 0\n", ""),
        /unchanged tracker must end the step with success/,
      ],
      [
        "does not rebase onto what landed meanwhile",
        "commitsAndRebases",
        (info) =>
          mutate(
            info.script,
            "git pull --rebase && git push && exit 0",
            "git push && exit 0",
          ),
        /on top of the push that landed meanwhile/,
      ],
      [
        "gives up after the first rejection",
        "retriesOnce",
        (info) =>
          mutate(
            info.script,
            "for attempt in 1 2 3; do",
            "for attempt in 1; do",
          ),
        /rejected once must be tried again/,
      ],
      [
        "tries four times instead of three",
        "failsAfterThree",
        (info) =>
          mutate(
            info.script,
            "for attempt in 1 2 3; do",
            "for attempt in 1 2 3 4; do",
          ),
        /rejected three times must fail/,
      ],
    ];
    for (const [title, scenario, change, expected] of broken) {
      test(
        `${scenario} fails for a step that ${title}`,
        { skip },
        async (t) => {
          const info = describeStep(commitSteps[0]);
          const remote = await setUp(info, "mutation-");
          t.after(() => remote.cleanup());
          const context = contextFor(remote, info, change(info));
          await assert.rejects(scenarios[scenario](context), (error) => {
            assert.equal(error.name, "AssertionError", String(error));
            assert.match(error.message, expected);
            return true;
          });
        },
      );
    }
  },
);

// ---------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------

test("the commit steps are read the way the runner reads them, expressions and several tracker paths included", () => {
  const byName = (name) =>
    describeStep(
      commitSteps.find(({ workflow }) => workflow.name === name) ??
        assert.fail(`${name} has no commit step`),
    );
  // Two tracker files in one `git add`.
  assert.deepEqual(byName("retiring-exam-monitor.yml").added, [
    "src/data_files/retiring-exams.json",
    "src/data_files/retirement-schedule.json",
  ]);
  // The Link Checker's checkout keeps no credential: its commit step puts the
  // job token (an env of the step) and the repository name (an expression of the
  // script) into the URL of origin, and the scratch run sends that URL to the
  // scratch origin.
  const link = byName("link-checker.yml");
  assert.equal(link.env.GH_TOKEN, "test-token");
  assert.equal(link.remoteUrl, JOB_TOKEN_URL);
  assert.doesNotMatch(link.script, /\$\{\{/);
  const measureup = byName("measureup-monitor.yml");
  assert.deepEqual(measureup.added, ["src/data_files/measureup-products.json"]);
  assert.equal(measureup.remoteUrl, null);
  assert.equal(measureup.message, "Update MeasureUp product baseline");
});

test("an expression the harness does not know fails with its name instead of being stripped", () => {
  assert.equal(
    evaluate("${{ github.repository }} ${{secrets.GITHUB_TOKEN}}", "x"),
    "mscerts/hub test-token",
  );
  assert.throws(
    () => evaluate("git push origin ${{ github.ref_name }}", "x.yml"),
    /x\.yml uses \$\{\{ github\.ref_name \}\}, which this test cannot evaluate/,
  );
  assert.throws(
    () => expand("${NOPE}", {}, "x.yml"),
    /\$NOPE is not set by the step/,
  );
  assert.equal(expand("a-${A}-$B", { A: "1", B: "2" }, "x"), "a-1-2");
});

test("findBash takes Git for Windows' bash on Windows, never the WSL launcher on PATH", () => {
  const present = (...paths) => {
    const files = new Set(paths);
    return (path) => files.has(path);
  };
  const tried = [];
  const works = (candidate) => {
    tried.push(candidate);
    return true;
  };
  const wsl = "C:\\Windows\\System32\\bash.exe";

  // The usual install: found next to git.exe although the WSL launcher is first on PATH.
  assert.equal(
    findBash({
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
        ProgramFiles: "C:\\Program Files",
      },
      exists: present(
        wsl,
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
      ),
      works,
    }),
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
  assert.ok(!tried.includes(wsl), "the WSL launcher must never be tried");

  // Another install folder, derived from where git.exe lives (also the mingw64 layout).
  for (const gitExe of [
    "D:\\Tools\\Git\\cmd\\git.exe",
    "D:\\Tools\\Git\\mingw64\\bin\\git.exe",
  ]) {
    assert.equal(
      findBash({
        platform: "win32",
        env: { PATH: `"${gitExe.replace(/\\git\.exe$/, "")}"` },
        exists: present(gitExe, "D:\\Tools\\Git\\bin\\bash.exe"),
        works,
      }),
      "D:\\Tools\\Git\\bin\\bash.exe",
      gitExe,
    );
  }

  // git.exe is a shim somewhere else: the default install folder is the fallback.
  assert.equal(
    findBash({
      platform: "win32",
      env: {
        PATH: "C:\\Users\\me\\scoop\\shims",
        ProgramFiles: "C:\\Program Files",
      },
      exists: present(
        "C:\\Users\\me\\scoop\\shims\\git.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
      ),
      works,
    }),
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );

  // Nothing suitable: null, and the callers skip with a reason.
  assert.equal(
    findBash({
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32" },
      exists: present(wsl),
      works,
    }),
    null,
  );
  assert.equal(
    findBash({
      platform: "win32",
      env: { Path: "C:\\Program Files\\Git\\cmd" },
      exists: present(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
      ),
      works: () => false,
    }),
    null,
    "a bash that does not run git is no bash",
  );

  // Linux and macOS: bash from PATH.
  assert.equal(
    findBash({ platform: "linux", works: (name) => name === "bash" }),
    "bash",
  );
  assert.equal(findBash({ platform: "darwin", works: () => false }), null);

  assert.equal(bashSkipReason("bash"), false);
  assert.match(bashSkipReason(null), /no bash that runs git was found/);
});

test("the bash found on this machine is not the WSL launcher", () => {
  // Without a bash the scratch tests above are reported as skipped, with the
  // reason; they never pass without running.
  if (bash === null) {
    assert.match(skip, /no bash that runs git was found/);
    return;
  }
  assert.equal(skip, false);
  if (process.platform === "win32") {
    assert.match(bash, /[\\/]bin[\\/]bash\.exe$/i);
    assert.doesNotMatch(
      bash,
      /System32|WindowsApps/i,
      "the WSL launcher cannot push to a Windows path",
    );
  }
});

test(
  "the scratch remote rejects exactly the pushes it is told to, with an executable hook, and is read with --git-dir only",
  { skip: gitSkip },
  async (t) => {
    const remote = await makeScratchRemote({ prefix: "remote-helper-" });
    t.after(() => remote.cleanup());
    await rejectFirstPushes(remote, 2);
    if (process.platform !== "win32") {
      assert.ok(
        statSync(join(remote.origin, "hooks", "pre-receive")).mode & 0o111,
        "without the exec bit Linux git skips the hook and nothing is rejected",
      );
    }
    const push = async (name) => {
      await remote.write(remote.work, name, `${name}\n`);
      await remote.git(remote.work, "add", ".");
      await remote.git(
        remote.work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-m",
        name,
      );
      return exec(remote.work, "git", ["push"], remote.env);
    };
    assert.notEqual((await push("one")).code, 0, "the first push is rejected");
    assert.notEqual((await push("two")).code, 0, "the second is rejected");
    assert.equal((await push("three")).code, 0, "the third goes through");
    assert.equal(await pushAttempts(remote), 3);
    assert.deepEqual(await remote.subjects(), ["three", "two", "one", "init"]);
    assert.deepEqual(await remote.changedFiles(), ["three"]);

    // The scratch git configuration sets safe.bareRepository=explicit, as
    // hardened machines do: the bare origin is only usable through --git-dir, so
    // a test that looks into it from inside fails everywhere, not only there.
    // (Git before 2.38 does not know the setting.)
    const version = spawnSync("git", ["--version"], { encoding: "utf8" });
    const [, major, minor] = version.stdout.match(/(\d+)\.(\d+)/) ?? [];
    if (Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38)) {
      await assert.rejects(
        remote.git(remote.origin, "log", "--format=%s", "main"),
        /bare repository|safe\.bareRepository|explicit/i,
      );
    }
    assert.equal(
      await gitDir(remote, "rev-parse", "--is-bare-repository"),
      "true",
    );
  },
);
