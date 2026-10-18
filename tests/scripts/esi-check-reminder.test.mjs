import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  ISSUE_LABEL,
  ISSUE_TITLE,
  areaOf,
  buildReport,
  esiSearchUrl,
  readEsiList,
  remind,
  statusOf,
} from "../../scripts/esi-check-reminder.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "esi-check-reminder.mjs");
const tempDir = mkdtempSync(join(tmpdir(), "esi-check-reminder-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const lf = (text) => text.replace(/\r\n/g, "\n");
const DAY = "2026-10-16";
const RUN = "https://github.com/mscerts/hub/actions/runs/42";

/** An in-memory `gh` that knows the few commands the reminder uses. */
function memoryGh(seed = []) {
  const issues = seed.map((issue, i) => ({
    number: i + 1,
    labels: [ISSUE_LABEL],
    state: "open",
    comments: [],
    ...issue,
  }));
  const calls = [];
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push(command);
    if (command === "issue list") {
      return JSON.stringify(
        issues
          .filter(
            (issue) =>
              issue.state === flag(args, "--state") &&
              issue.labels.includes(flag(args, "--label")),
          )
          .map(({ number, title }) => ({ number, title })),
      );
    }
    if (command === "issue create") {
      const issue = {
        number: issues.length + 1,
        title: flag(args, "--title"),
        labels: [flag(args, "--label")],
        body: input,
        state: "open",
        comments: [],
      };
      issues.push(issue);
      return `https://github.com/mscerts/hub/issues/${issue.number}`;
    }
    const find = () => issues.find((issue) => issue.number === Number(args[2]));
    if (command === "issue comment") find().comments.push(input);
    if (command === "issue close") {
      find().state = "closed";
      find().comments.push(flag(args, "--comment"));
    }
    return ""; // label create / label list: the label already exists or is created
  };
  return { gh, issues, calls };
}

const base = { today: DAY, repository: "mscerts/hub", runUrl: RUN };

test("the ESI address of an exam is the search the exam pages already use", () => {
  assert.equal(
    esiSearchUrl("AZ-104"),
    "https://esi.microsoft.com/Search?q=AZ-104&avail=Available&learningoption=Advanced+Role+Based",
  );
  // the same shape as every ESI card on the exam pages
  const page = lf(
    readFileSync(join(root, "src/content/docs/azure/AZ-104.mdx"), "utf8"),
  );
  assert.ok(page.includes(`href="${esiSearchUrl("AZ-104")}"`));
});

test("an exam code finds its area and its badge", () => {
  assert.equal(areaOf("AZ-104"), "azure");
  assert.equal(areaOf("AB-650"), "aibusiness");
  assert.equal(areaOf("XX-100"), null);
  const statuses = { aibusiness: { "AB-650": { text: "BETA" } } };
  assert.equal(statusOf("AB-650", statuses), "BETA");
  assert.equal(statusOf("AB-210", statuses), "");
  assert.equal(statusOf("XX-100", statuses), "");
});

test("the list is read sorted by area prefix and number, and anything unusual is an error", () => {
  assert.deepEqual(
    readEsiList(
      JSON.stringify({
        "Microsoft ESI": ["SC-900", "AB-210", "AB-100", "AB-210"],
      }),
    ),
    ["AB-100", "AB-210", "SC-900"],
  );
  assert.deepEqual(readEsiList(JSON.stringify({ "Microsoft ESI": [] })), []);
  assert.throws(() => readEsiList("{"), /not valid JSON/);
  assert.throws(() => readEsiList("{}"), /no "Microsoft ESI" list/);
  assert.throws(
    () => readEsiList(JSON.stringify({ "Microsoft ESI": "AB-100" })),
    /no "Microsoft ESI" list/,
  );
  assert.throws(
    () => readEsiList(JSON.stringify({ "Microsoft ESI": ["AB-100", "nope"] })),
    /"nope" .* is not an exam code/,
  );
});

test("the report has one checklist line per exam, with its search address, page and badge", () => {
  const statuses = { aibusiness: { "AB-650": { text: "BETA" } } };
  const report = buildReport({
    ...base,
    codes: ["AB-210", "AB-650"],
    statuses,
  });
  assert.match(report, /^2 exam pages have no ESI card as of 2026-10-16\./);
  assert.ok(
    report.includes(
      `- [ ] [AB-210](${esiSearchUrl("AB-210")}) · [page](https://github.com/mscerts/hub/blob/main/src/content/docs/aibusiness/AB-210.mdx)`,
    ),
  );
  assert.ok(
    report.includes(
      `- [ ] [AB-650](${esiSearchUrl("AB-650")}) (BETA) · [page]`,
    ),
  );
  assert.ok(report.includes("`scripts/lib/audit-exemptions.mjs`"));
  assert.ok(report.endsWith(`Run: ${RUN}`));
  // singular, and no run link without one
  const one = buildReport({
    ...base,
    runUrl: null,
    codes: ["AB-210"],
    statuses,
  });
  assert.match(one, /^1 exam page has no ESI card/);
  assert.ok(!one.includes("Run:"));
  // a later round says the last one is still open
  const again = buildReport({
    ...base,
    codes: ["AB-210"],
    statuses,
    followUp: true,
  });
  assert.match(
    again,
    /^The last round of this check is still open\. 1 exam page has no ESI card/,
  );
});

test("exams to check and no issue open: the issue is created with the checklist", () => {
  const { gh, issues } = memoryGh();
  const result = remind({ gh, ...base, codes: ["AB-210", "SC-900"] });
  assert.deepEqual(result, { action: "created", number: 1 });
  assert.equal(issues[0].title, ISSUE_TITLE);
  assert.deepEqual(issues[0].labels, [ISSUE_LABEL]);
  assert.ok(issues[0].body.includes(esiSearchUrl("SC-900")));
});

test("the last round still open: the refreshed list is a comment, not a second issue", () => {
  const { gh, issues } = memoryGh([{ title: ISSUE_TITLE }]);
  const result = remind({ gh, ...base, codes: ["AB-210"] });
  assert.deepEqual(result, { action: "commented", number: 1 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].comments.length, 1);
  assert.match(
    issues[0].comments[0],
    /^The last round of this check is still open\./,
  );
  // an issue of the same title but another label is not ours
  const other = memoryGh([{ title: ISSUE_TITLE, labels: ["bug"] }]);
  assert.equal(
    remind({ gh: other.gh, ...base, codes: ["AB-210"] }).action,
    "created",
  );
});

test("nothing left to check: an open issue is closed with a comment, no issue means nothing to do", () => {
  const open = memoryGh([{ title: ISSUE_TITLE }, { title: "Something else" }]);
  const closed = remind({ gh: open.gh, ...base, codes: [] });
  assert.equal(closed.action, "closed");
  assert.deepEqual(closed.closed, [1]);
  assert.equal(open.issues[0].state, "closed");
  assert.match(open.issues[0].comments[0], /nothing to check/);
  assert.equal(open.issues[1].state, "open");
  const none = remind({ gh: memoryGh().gh, ...base, codes: [] });
  assert.equal(none.action, "none");
});

test("an issue that cannot be closed makes the run fail instead of passing quietly", () => {
  const { gh } = memoryGh([{ title: ISSUE_TITLE }]);
  const failing = (args, input) => {
    if (args[0] === "issue" && args[1] === "close")
      throw new Error("gh issue close failed");
    return gh(args, input);
  };
  assert.throws(
    () => remind({ gh: failing, ...base, codes: [] }),
    /Could not close the issue/,
  );
});

function run(env) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
  });
}

test("on the command line a dry run prints the checklist and touches nothing", () => {
  const file = join(tempDir, "missing.json");
  writeFileSync(
    file,
    JSON.stringify({ "Microsoft ESI": ["AB-210", "SC-900"] }),
  );
  const report = join(tempDir, "report.md");
  // a gh that would fail the run if it were ever called
  const res = run({
    MISSING_FILE: file,
    REPORT_FILE: report,
    TODAY: DAY,
    DRY_RUN: "1",
    CREATE_ISSUES: "1",
    GH_CLI_SCRIPT: join(tempDir, "no-such-gh.mjs"),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(
    res.stdout,
    /Not touching GitHub \(DRY_RUN\): 2 exam\(s\) to check\./,
  );
  assert.ok(readFileSync(report, "utf8").includes(esiSearchUrl("AB-210")));
  // without CREATE_ISSUES it is a dry run too
  const local = run({
    MISSING_FILE: file,
    TODAY: DAY,
    CREATE_ISSUES: "",
    DRY_RUN: "",
  });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /CREATE_ISSUES is not 1/);
});

test("on the command line a list that cannot be read is a red run", () => {
  const bad = join(tempDir, "bad.json");
  writeFileSync(bad, "{}");
  const res = run({ MISSING_FILE: bad, CREATE_ISSUES: "1" });
  assert.equal(res.status, 1);
  assert.match(
    res.stderr,
    /::error::The audit file has no "Microsoft ESI" list/,
  );
  const missing = run({
    MISSING_FILE: join(tempDir, "absent.json"),
    CREATE_ISSUES: "1",
  });
  assert.equal(missing.status, 1);
});

test("the committed audit file has the list the reminder reads", () => {
  const text = readFileSync(
    join(root, "src/data_files/missing-resources.json"),
    "utf8",
  );
  assert.doesNotThrow(() => readEsiList(text));
});

test("the workflow runs the audit before the reminder, every second month, and writes nothing to the repository", () => {
  const yml = lf(
    readFileSync(
      join(root, ".github/workflows/esi-check-reminder.yml"),
      "utf8",
    ),
  );
  assert.match(yml, /cron: "20 9 1 \*\/2 \*"/);
  assert.ok(
    yml.indexOf("node scripts/audit-missing-resources.mjs") <
      yml.indexOf("node scripts/esi-check-reminder.mjs"),
  );
  assert.match(yml, /issues: write/);
  assert.match(yml, /contents: read/);
  assert.ok(!yml.includes("git push") && !yml.includes("contents: write"));
  assert.match(yml, /DRY_RUN: \$\{\{ inputs\.dry_run && '1' \|\| '' \}\}/);
});
