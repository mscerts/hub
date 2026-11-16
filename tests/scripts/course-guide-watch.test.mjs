import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
  ISSUE_LABEL,
  MAX_NEW_ISSUES,
  applyIssue,
  buildReport,
  checkCourse,
  describe,
  fingerprintIn,
  fingerprintOf,
  issueTitle,
  main,
  planIssue,
  prettyDay,
  readCourses,
  versionsFor,
  whenSentence,
} from "../../scripts/course-guide-watch.mjs";
import { parseGuide } from "../../scripts/lib/course-guide.mjs";
import { domains, guide } from "../fixtures/study-guide-changes/guides.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "course-guide-watch.mjs");
const tempDir = mkdtempSync(join(tmpdir(), "course-guide-watch-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const CODE = "DP-700";
const NOW = new Date("2026-11-15T12:00:00Z");
const TODAY = "2026-11-15";
const RUN = "https://github.com/mscerts/hub/actions/runs/42";

// The guide the course was built for, and what Microsoft made of it: one task added, one removed, one reworded,
// one moved to another skill group.
const V1 = guide({ asOf: "2026-06-01", domains: domains() });
const changedDomains = () =>
  domains((d) => {
    const settings = d[0].groups[0].tasks;
    settings.push("Configure data workflow workspace settings"); // added
    const lifecycle = d[0].groups[1].tasks;
    lifecycle.splice(lifecycle.indexOf("Implement database projects"), 1); // removed
    const loading = d[1].groups[0].tasks;
    loading[1] =
      "Prepare data for loading into a dimensional model or a lakehouse"; // reworded
    const monitor = d[2].groups[0].tasks;
    monitor.splice(monitor.indexOf("Monitor semantic model refresh"), 1);
    lifecycle.push("Monitor semantic model refresh"); // moved
  });
const v2 = (asOf) => guide({ asOf, domains: changedDomains() });

/** A history file with these versions (each `{ lines, asOf, firstSeen }`). */
const history = (...versions) => ({
  schemaVersion: 1,
  code: CODE,
  versions: versions.map((v, i) => ({ n: i + 1, ...v })),
});
const version = (lines, asOf, firstSeen) => ({ asOf, firstSeen, lines });

/** A course file with the tasks of a guide and two picks under every task. */
function courseOf(lines, asOfText = "June 1, 2026") {
  const tree = parseGuide(lines);
  assert.equal(tree.ok, true, "the fixture guide parses");
  return {
    schemaVersion: 1,
    code: CODE,
    name: "Example",
    inputs: { guideAsOf: asOfText },
    domains: tree.domains.map((d) => ({
      title: d.title,
      ...(d.weight ? { weight: d.weight } : {}),
      groups: d.groups.map((g) => ({
        title: g.title,
        tasks: g.tasks.map((t) => ({
          key: t.key,
          text: t.text,
          picks: [{ title: "a" }, { title: "b" }],
        })),
      })),
    })),
    rejected: [],
  };
}

/** An in-memory `gh` that knows the commands the watch uses. */
function memoryGh(seed = []) {
  const issues = seed.map((issue, i) => ({
    number: i + 1,
    labels: [ISSUE_LABEL],
    state: "open",
    comments: [],
    body: "",
    ...issue,
  }));
  const calls = [];
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push(command);
    if (command === "issue list")
      return JSON.stringify(
        issues
          .filter(
            (issue) =>
              issue.state === flag(args, "--state") &&
              issue.labels.includes(flag(args, "--label")),
          )
          .map(({ number, title }) => ({ number, title })),
      );
    const find = () => issues.find((issue) => issue.number === Number(args[2]));
    if (command === "issue view") return JSON.stringify({ body: find().body });
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
    if (command === "issue edit") find().body = input;
    if (command === "issue comment") find().comments.push(input);
    if (command === "issue close") {
      find().state = "closed";
      find().comments.push(flag(args, "--comment"));
    }
    return ""; // label list / label create
  };
  return { gh, issues, calls };
}

/** Plan and carry out the issue step of one course, as main does. */
function sync(gh, course, hist, now = NOW, today = TODAY) {
  const result = checkCourse({ course, history: hist, now });
  const step = planIssue({
    gh,
    result,
    report: result.plan ? buildReport({ result, course, runUrl: RUN }) : null,
  });
  return {
    result,
    step,
    outcome: applyIssue({ gh, result, step, today, runUrl: RUN }),
  };
}

test("a day is written the way the repository writes it", () => {
  assert.equal(prettyDay("2026-10-30"), "October 30, 2026");
  assert.equal(prettyDay("2027-01-05"), "January 5, 2027");
});

test("a course with the tasks of its guide is current, and a new date, new weights or another audience change nothing", () => {
  const course = courseOf(V1);
  const same = checkCourse({
    course,
    history: history(version(V1, "2026-06-01", "2026-06-02")),
    now: NOW,
  });
  assert.equal(same.status, "current");
  assert.equal(same.plan, undefined);
  // the same tasks under a new date, with other weights and another audience profile
  const redated = guide({
    asOf: "2026-10-01",
    domains: domains((d) => {
      d[0].min = 20;
      d[0].max = 25;
    }),
    audience: ["### Audience profile", "Someone else entirely."],
  });
  const result = checkCourse({
    course,
    history: history(
      version(V1, "2026-06-01", "2026-06-02"),
      version(redated, "2026-10-01", "2026-10-02"),
    ),
    now: NOW,
  });
  assert.equal(result.status, "current");
});

test("a version dated ahead with other tasks is an upcoming change: what is measured today and what comes are kept apart", () => {
  const hist = history(
    version(V1, "2026-06-01", "2026-06-02"),
    version(v2("2027-01-15"), "2027-01-15", "2026-11-10"),
  );
  const { measured, upcoming } = versionsFor({ history: hist, now: NOW });
  assert.equal(measured.asOf, "2026-06-01");
  assert.equal(upcoming.asOf, "2027-01-15");
  const result = checkCourse({ course: courseOf(V1), history: hist, now: NOW });
  assert.equal(result.status, "upcoming");
  assert.deepEqual(result.effective, { day: "2027-01-15", basis: "stated" });
  assert.equal(result.followsMeasured, true);
  assert.deepEqual(
    result.plan.added.map((t) => t.text),
    ["Configure data workflow workspace settings"],
  );
  assert.deepEqual(
    result.plan.removed.map((t) => t.text),
    ["Implement database projects"],
  );
  assert.deepEqual(
    result.plan.renameHints.map((h) => [h.from.text, h.to.text]),
    [
      [
        "Prepare data for loading into a dimensional model",
        "Prepare data for loading into a dimensional model or a lakehouse",
      ],
    ],
  );
  assert.deepEqual(
    result.plan.moved.map((m) => [m.from.text, m.to.group]),
    [["Monitor semantic model refresh", "Implement lifecycle management"]],
  );
  // 12 tasks: one gone, one reworded, one moved; nine stay
  assert.equal(result.tasks, 12);
  assert.equal(result.staying, 9);
  assert.match(
    describe(result),
    /^DP-700: the skills change on January 15, 2027: 1 new, 1 gone, 1 reworded, 1 moved$/,
  );
});

test("once the day has come the same change is in effect, and a course that was updated early is current", () => {
  const hist = history(
    version(V1, "2026-06-01", "2026-06-02"),
    version(v2("2027-01-15"), "2027-01-15", "2026-11-10"),
  );
  const later = new Date("2027-01-15T12:00:00Z");
  const behind = checkCourse({
    course: courseOf(V1),
    history: hist,
    now: later,
  });
  assert.equal(behind.status, "changed");
  assert.deepEqual(behind.effective, { day: "2027-01-15", basis: "stated" });
  assert.match(whenSentence(behind), /in effect since January 15, 2027/);
  // the course already has the new tasks: nothing to do, before the day (it is ahead) and after it
  const updated = courseOf(v2("2027-01-15"), "January 15, 2027");
  const early = checkCourse({ course: updated, history: hist, now: NOW });
  assert.equal(early.status, "current");
  assert.equal(early.ahead, true);
  assert.match(describe(early), /not in effect yet/);
  const onTime = checkCourse({ course: updated, history: hist, now: later });
  assert.equal(onTime.status, "current");
  assert.equal(onTime.ahead, undefined);
});

test("an undated version, or one dated before the version it replaced, took effect when the hub first saw it", () => {
  const undated = checkCourse({
    course: courseOf(V1),
    history: history(
      version(V1, "2026-06-01", "2026-06-02"),
      version(v2(null), null, "2026-11-03"),
    ),
    now: NOW,
  });
  assert.equal(undated.status, "changed");
  assert.deepEqual(undated.effective, { day: "2026-11-03", basis: "seen" });
  assert.match(
    whenSentence(undated),
    /first saw this version on November 3, 2026/,
  );
  const earlier = checkCourse({
    course: courseOf(V1),
    history: history(
      version(V1, "2026-06-01", "2026-06-02"),
      version(v2("2026-03-11"), "2026-03-11", "2026-11-03"),
    ),
    now: NOW,
  });
  assert.deepEqual(earlier.effective, { day: "2026-11-03", basis: "seen" });
});

test("without a recorded history the guide the tracker stores is what is measured; with nothing readable the course is unknown", () => {
  const empty = { schemaVersion: 1, code: CODE, versions: [] };
  const fromTracker = checkCourse({
    course: courseOf(V1),
    history: empty,
    stored: v2("2026-10-01"),
    now: NOW,
  });
  assert.equal(fromTracker.status, "changed");
  assert.equal(fromTracker.effective, null);
  assert.match(whenSentence(fromTracker), /in effect now/);
  assert.equal(
    checkCourse({ course: courseOf(V1), history: empty, now: NOW }).status,
    "unknown",
  );
  // a version that does not parse as a guide says nothing either
  const broken = history(
    version(["## Skills measured", "nothing"], null, "2026-11-03"),
  );
  assert.equal(
    checkCourse({ course: courseOf(V1), history: broken, now: NOW }).status,
    "unknown",
  );
});

test("the issue says when the new skills count, what changes task by task with the picks at stake, and what to do", () => {
  const course = courseOf(V1);
  const result = checkCourse({
    course,
    history: history(
      version(V1, "2026-06-01", "2026-06-02"),
      version(v2("2027-01-15"), "2027-01-15", "2026-11-10"),
    ),
    now: NOW,
  });
  const report = buildReport({ result, course, runUrl: RUN });
  assert.equal(fingerprintIn(report), fingerprintOf(result));
  assert.match(
    report,
    /measured from \*\*January 15, 2027\*\*\. They are not in effect yet/,
  );
  assert.match(report, /built for the skills measured as of June 1, 2026/);
  assert.match(report, /https:\/\/msfthub\.com\/certs\/courses\/dp-700\//);
  assert.match(report, /https:\/\/msfthub\.com\/certs\/changelog\/dp-700\//);
  assert.match(
    report,
    /1 task is new, 1 task is gone, 1 task looks reworded, 1 task moved to another place in the guide\. 9 tasks of 12 stay as they are\./,
  );
  assert.match(
    report,
    /- Configure data workflow workspace settings _\(Configure workspace settings\)_/,
  );
  assert.match(
    report,
    /- Implement database projects _\(Implement lifecycle management; 2 picks\)_/,
  );
  assert.match(
    report,
    /is now "Prepare data for loading into a dimensional model or a lakehouse" _\(\d+% of the words; 2 picks\)_/,
  );
  assert.match(
    report,
    /- Monitor semantic model refresh: from _Monitor Fabric items_ to _Implement lifecycle management_/,
  );
  assert.match(report, /node scripts\/course-status\.mjs DP-700/);
  assert.match(report, /course-decisions\/DP-700\.json/);
  assert.match(report, /Do not replace the page before January 15, 2027/);
  assert.match(
    report,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/42$/,
  );
  // in effect: the last step says to merge, and the day is not a reason to wait
  const now = new Date("2027-02-01T12:00:00Z");
  const late = checkCourse({
    course,
    history: history(
      version(V1, "2026-06-01", "2026-06-02"),
      version(v2("2027-01-15"), "2027-01-15", "2026-11-10"),
    ),
    now,
  });
  const lateReport = buildReport({ result: late, course });
  assert.match(lateReport, /Merge it as soon as it is ready/);
  assert.doesNotMatch(lateReport, /Do not replace the page/);
  assert.notEqual(fingerprintIn(lateReport), fingerprintIn(report));
});

test("one issue per exam: created once, silent while nothing changes, rewritten when the day comes, closed when the course follows", () => {
  const { gh, issues, calls } = memoryGh();
  const hist = history(
    version(V1, "2026-06-01", "2026-06-02"),
    version(v2("2027-01-15"), "2027-01-15", "2026-11-10"),
  );
  const course = courseOf(V1);
  const first = sync(gh, course, hist);
  assert.equal(first.outcome.action, "created");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, issueTitle(CODE));
  assert.deepEqual(issues[0].labels, [ISSUE_LABEL]);
  assert.match(issues[0].body, /measured from \*\*January 15, 2027\*\*/);

  // the next day: the same thing to say, so nothing is written
  const before = calls.length;
  const second = sync(
    gh,
    course,
    hist,
    new Date("2026-11-16T12:00:00Z"),
    "2026-11-16",
  );
  assert.equal(second.outcome.action, "keep");
  assert.deepEqual(
    calls.slice(before).filter((c) => !/^issue (list|view)$/.test(c)),
    [],
  );
  assert.equal(issues[0].comments.length, 0);

  // the day comes: the text is rewritten in place and a comment says so
  const third = sync(
    gh,
    course,
    hist,
    new Date("2027-01-15T12:00:00Z"),
    "2027-01-15",
  );
  assert.equal(third.outcome.action, "updated");
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /in effect since January 15, 2027/);
  assert.equal(issues[0].comments.length, 1);
  assert.match(
    issues[0].comments[0],
    /rewritten on January 15, 2027.*in effect since January 15, 2027/s,
  );

  // the course is updated: the issue closes itself
  const updated = courseOf(v2("2027-01-15"), "January 15, 2027");
  const fourth = sync(
    gh,
    updated,
    hist,
    new Date("2027-01-20T12:00:00Z"),
    "2027-01-20",
  );
  assert.equal(fourth.outcome.action, "closed");
  assert.equal(issues[0].state, "closed");
  assert.match(
    issues[0].comments.at(-1),
    /has the tasks of the newest version/,
  );
  // and nothing happens after that
  const fifth = sync(
    gh,
    updated,
    hist,
    new Date("2027-01-21T12:00:00Z"),
    "2027-01-21",
  );
  assert.equal(fifth.outcome.action, "none");
});

test("a part of the course that was updated rewrites the issue with what is left", () => {
  const { gh, issues } = memoryGh();
  const hist = history(
    version(V1, "2026-06-01", "2026-06-02"),
    version(v2("2026-10-01"), "2026-10-01", "2026-09-20"),
  );
  const course = courseOf(V1);
  assert.equal(sync(gh, course, hist).outcome.action, "created");
  // the removed task leaves the course; the rest is still to do
  const lifecycle = course.domains[0].groups[1].tasks;
  lifecycle.splice(
    lifecycle.findIndex((t) => t.text === "Implement database projects"),
    1,
  );
  const again = sync(gh, course, hist);
  assert.equal(again.outcome.action, "updated");
  assert.doesNotMatch(issues[0].body, /Tasks that are gone/);
  assert.match(issues[0].body, /New tasks \(they need picks\)/);
});

/** A folder with course files, history files and a tracker, for main. */
function world(name, entries) {
  const dir = join(tempDir, name);
  const courses = join(dir, "courses");
  const histories = join(dir, "history");
  mkdirSync(courses, { recursive: true });
  mkdirSync(histories, { recursive: true });
  for (const { code, course, hist } of entries) {
    writeFileSync(
      join(courses, `${code}.json`),
      typeof course === "string" ? course : JSON.stringify({ ...course, code }),
    );
    if (hist)
      writeFileSync(
        join(histories, `${code}.json`),
        JSON.stringify({ ...hist, code }),
      );
  }
  return {
    COURSES_DIR: courses,
    HISTORY_DIR: histories,
    LEARN_EXAMS_FILE: join(dir, "no-tracker.json"),
    TODAY,
    ERROR_FILE: join(dir, "error.md"),
    REPORT_FILE: join(dir, "report.md"),
    GITHUB_OUTPUT: join(dir, "output.txt"),
  };
}
const behindEntry = (code) => ({
  code,
  course: courseOf(V1),
  hist: history(
    version(V1, "2026-06-01", "2026-06-02"),
    version(v2("2026-10-01"), "2026-10-01", "2026-09-20"),
  ),
});

test("without CREATE_ISSUES the run only prints: the report, and the text each issue would have", () => {
  const env = world("dry", [
    behindEntry("DP-700"),
    {
      code: "AZ-104",
      course: courseOf(V1),
      hist: history(version(V1, "2026-06-01", "2026-06-02")),
    },
  ]);
  const result = main(env);
  assert.equal(result.action, "dry-run");
  assert.deepEqual(
    result.results.map((r) => [r.code, r.status]),
    [
      ["AZ-104", "current"],
      ["DP-700", "changed"],
    ],
  );
  const report = readFileSync(env.REPORT_FILE, "utf8");
  assert.match(report, /2 courses, 1 with other skills than their guide/);
  assert.match(
    report,
    /- DP-700: the skills changed \(in effect since October 1, 2026\)/,
  );
  assert.doesNotMatch(report, /AZ-104/);
  const output = readFileSync(env.GITHUB_OUTPUT, "utf8");
  assert.match(output, /check_failed=false/);
  assert.match(output, /changed=1/);
});

test("a course file or a history that cannot be read stops the run before any issue is touched", () => {
  const env = world("broken", [
    behindEntry("DP-700"),
    { code: "AZ-104", course: "{ not json" },
  ]);
  const { rows, problems } = readCourses({
    coursesDir: env.COURSES_DIR,
    historyDir: env.HISTORY_DIR,
    examsFile: env.LEARN_EXAMS_FILE,
  });
  assert.equal(rows.length, 1);
  assert.equal(problems.length, 1);
  assert.throws(
    () => main({ ...env, CREATE_ISSUES: "1" }),
    /AZ-104\.json cannot be read/,
  );
  assert.match(
    readFileSync(env.ERROR_FILE, "utf8"),
    /stopped and changed no issue/,
  );
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /check_failed=true/);
  // a history file that is not one
  const bad = world("bad-history", [
    { code: "DP-700", course: courseOf(V1), hist: { versions: "none" } },
  ]);
  assert.throws(
    () => main(bad),
    /study guide history of DP-700 cannot be read/,
  );
});

// A `gh` that keeps its issues in a file, so that the script can be run for real.
const fakeGh = join(tempDir, "fake-gh.mjs");
writeFileSync(
  fakeGh,
  `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_GH_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { issues: [] };
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const input = args.includes("-") ? readFileSync(0, "utf8") : "";
const command = args.slice(0, 2).join(" ");
const find = () => state.issues.find((i) => i.number === Number(args[2]));
let out = "";
if (command === "issue list")
  out = JSON.stringify(state.issues.filter((i) => i.state === "open" && i.label === flag("--label")).map(({ number, title }) => ({ number, title })));
else if (command === "issue view") out = JSON.stringify({ body: find().body });
else if (command === "issue create") {
  const issue = { number: state.issues.length + 1, title: flag("--title"), label: flag("--label"), body: input, state: "open", comments: [] };
  state.issues.push(issue);
  out = "https://github.com/mscerts/hub/issues/" + issue.number;
} else if (command === "issue edit") find().body = input;
else if (command === "issue comment") find().comments.push(input);
else if (command === "issue close") find().state = "closed";
else if (command === "label list") out = "[]";
writeFileSync(file, JSON.stringify(state));
process.stdout.write(out);
`,
);
const runScript = (env) =>
  spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env, GH_CLI_SCRIPT: fakeGh, CREATE_ISSUES: "1" },
  });

test("the script run for real: an issue per changed course, nothing on the next run, exit code 0", () => {
  const env = {
    ...world("real", [behindEntry("DP-700"), behindEntry("DP-600")]),
    FAKE_GH_STATE: join(tempDir, "real-state.json"),
  };
  const first = runScript(env);
  assert.equal(first.status, 0, first.stderr);
  const state = () => JSON.parse(readFileSync(env.FAKE_GH_STATE, "utf8"));
  assert.deepEqual(
    state().issues.map((i) => [i.title, i.label, i.state]),
    [
      [issueTitle("DP-600"), ISSUE_LABEL, "open"],
      [issueTitle("DP-700"), ISSUE_LABEL, "open"],
    ],
  );
  assert.match(
    first.stdout,
    /Issue "Course DP-600: the study guide's skills changed": created \(#1\)/,
  );
  const second = runScript(env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(state().issues.length, 2);
  assert.equal(state().issues[0].comments.length, 0);
  assert.doesNotMatch(second.stdout, /Issue "/);
});

test("more new issues in one run than are believed stop the run and create nothing, unless forced", () => {
  const codes = ["AZ-104", "AZ-305", "AZ-700", "DP-300", "DP-600", "DP-700"];
  assert.ok(codes.length > MAX_NEW_ISSUES);
  const env = {
    ...world("flood", codes.map(behindEntry)),
    FAKE_GH_STATE: join(tempDir, "flood-state.json"),
  };
  const stopped = runScript(env);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /6 courses would get a new issue in one run/);
  assert.match(
    readFileSync(env.ERROR_FILE, "utf8"),
    /more than the 5 that are believed/,
  );
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /check_failed=true/);
  // nothing was created: the state file was written by the listings only
  assert.deepEqual(
    JSON.parse(readFileSync(env.FAKE_GH_STATE, "utf8")).issues,
    [],
  );
  const forced = runScript({ ...env, FORCE: "1" });
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(
    JSON.parse(readFileSync(env.FAKE_GH_STATE, "utf8")).issues.length,
    6,
  );
});

test("the repository's own courses can be checked: every one is read and none is unknown", () => {
  const result = main({ TODAY, DRY_RUN: "1" });
  assert.equal(result.action, "dry-run");
  assert.ok(result.results.length > 0);
  assert.deepEqual(
    result.results.filter((r) => r.status === "unknown").map((r) => r.code),
    [],
  );
});
