import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const helper = join(root, "scripts", "tasks.mjs");

async function fixture(t, { graphqlError = null, launchFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-helper-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(
    join(dir, ".tasks.local.json"),
    JSON.stringify({
      owner: "mscerts",
      project: 1,
      projectId: "PVT_project",
      me: "agent",
      meId: "U_agent",
      defaultStatus: "Planned future fixes/changes",
      doneStatus: "Done",
      fields: {
        Status: {
          id: "F_status",
          type: "ProjectV2SingleSelectField",
          options: { "Planned future fixes/changes": "O_status" },
        },
      },
    }),
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const callLog = join(dir, "calls.jsonl");
  const fakeGh = join(dir, "fake-gh.mjs");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const stdin = await new Promise((resolve) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => resolve(value)); });
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({args, stdin}) + "\\n");
if (${JSON.stringify(launchFailure)}) process.exit(7);
if (process.env.FAKE_GH_LAUNCH_FAILURE === "1") process.exit(7);
if (args[0] === "api" && args[1] === "graphql") {
  const payload = JSON.parse(stdin);
  if (${JSON.stringify(graphqlError)} && (payload.query.includes("updateProjectV2DraftIssue") || payload.query.includes("addProjectV2DraftIssue"))) {
    process.stderr.write(${JSON.stringify(graphqlError)});
    process.exit(1);
  }
  if (payload.query.includes("addProjectV2DraftIssue")) {
    console.log(JSON.stringify({data:{addProjectV2DraftIssue:{projectItem:{id:"DI_created-draft"}}}}));
  } else if (payload.query.includes("updateProjectV2DraftIssue")) {
    const body = payload.variables.body ?? "";
    console.log(JSON.stringify({data:{updateProjectV2DraftIssue:{draftIssue:{id:"DI_draft",body}}}}));
  }
  process.exit(0);
}
if (args[0] === "project" && args[1] === "item-list") {
  console.log(JSON.stringify({items:[]}));
  process.exit(0);
}
if (args[0] === "project" && args[1] === "item-edit") process.exit(0);
process.stderr.write("unexpected gh invocation: " + args.join(" "));
process.exit(2);
`,
  );
  (await import("node:fs/promises")).chmod(fakeGh, 0o755);
  const copiedHelper = join(dir, "scripts", "tasks.mjs");
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(helper, "utf8"),
  );
  writeFileSync(copiedHelper, source);
  const pathDir = join(dir, "bin");
  mkdirSync(pathDir);
  writeFileSync(
    join(pathDir, "gh"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGh)} "$@"\n`,
  );
  (await import("node:fs/promises")).chmod(join(pathDir, "gh"), 0o755);
  t.after(() => {
    // Test fixtures are intentionally left to the OS temp cleaner.
  });
  return { dir, fakeGh, callLog, copiedHelper };
}

function run(fx, args) {
  const result = spawnSync(process.execPath, [fx.copiedHelper, ...args], {
    cwd: fx.dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(fx.dir, "bin")}:${process.env.PATH}` },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result;
}

test("add sends a large Unicode body over GraphQL stdin, not argv", async (t) => {
  const fx = await fixture(t);
  const body = `Unicode 🧪\n${"Long body — 漢字 — ".repeat(12000)}`;
  const bodyFile = join(fx.dir, "body.txt");
  writeFileSync(bodyFile, body);
  const result = run(fx, ["add", "Large task", "--body-file", bodyFile]);
  assert.equal(
    result.status,
    0,
    `${result.error?.stack ?? ""}\n${result.stderr}\n${result.stdout}`,
  );
  const calls = readFileSync(fx.callLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(calls.length, 3);
  const apiCall = calls.find(({ args }) => args[0] === "api");
  assert.ok(apiCall);
  assert.deepEqual(apiCall.args.slice(-2), ["--input", "-"]);
  assert.equal(apiCall.stdin.length > 100_000, true);
  const payload = JSON.parse(apiCall.stdin);
  assert.equal(payload.variables.body, body);
  assert.equal(
    calls.some(({ args }) => args.includes(body)),
    false,
  );
});

test("GraphQL API errors are reported without an authentication hint", async (t) => {
  const fx = await fixture(t, { graphqlError: "body exceeds maximum size" });
  const bodyFile = join(fx.dir, "body.txt");
  writeFileSync(bodyFile, "x");
  const result = run(fx, ["add", "Large task", "--body-file", bodyFile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /body exceeds maximum size/);
  assert.doesNotMatch(result.stderr, /auth status/);
  assert.doesNotMatch(result.stderr, /Created .*could not set its body/);
});

test("process launch failures report the process cause", async (t) => {
  const fx = await fixture(t);
  const result = spawnSync(process.execPath, [fx.copiedHelper, "list"], {
    cwd: fx.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fx.dir, "bin")}:${process.env.PATH}`,
      FAKE_GH_LAUNCH_FAILURE: "1",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit 7/);
  assert.doesNotMatch(result.stderr, /auth status/);
});
