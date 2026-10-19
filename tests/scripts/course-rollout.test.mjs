import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { main } from "../../scripts/course-rollout.mjs";
import {
  PICKS_PER_TASK,
  areaOf,
  describeTable,
  guideChangesSoon,
  rolloutRow,
  rolloutTable,
  statusMap,
} from "../../scripts/lib/course-rollout.mjs";
import { learnInputs, readGuideFixture } from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const TODAY = "2026-10-17";
const guide = (code) => readGuideFixture(code);

/** A scope map with `modules` modules, `linked` of them with harvested links. */
const scope = (modules, linked = modules, courses = 1) => ({
  courses: Array.from({ length: courses }, () => ({})),
  modules: Array.from({ length: modules }, () => ({})),
  inputs: { resourceModules: linked },
});

const row = (code, extra = {}) =>
  rolloutRow({
    code,
    guide: guide(code),
    scope: scope(12),
    status: null,
    today: TODAY,
    ...extra,
  });

test("areas follow the hub's prefixes", () => {
  assert.equal(areaOf("AZ-104"), "azure");
  assert.equal(areaOf("DP-700"), "azure");
  assert.equal(areaOf("GH-900"), "github");
  assert.equal(areaOf("XX-100"), null);
});

test("the exam statuses are read as code -> badge text", () => {
  const map = statusMap({
    azure: { "AZ-401": { text: "BETA" }, "AZ-800": { text: "RETIRED" } },
    power: {},
  });
  assert.equal(map.get("AZ-401"), "BETA");
  assert.equal(map.size, 2);
  assert.equal(statusMap(undefined).size, 0);
});

test("a guide changes soon only while its 'as of' day is still ahead; a month counts from its first day", () => {
  assert.equal(guideChangesSoon({ iso: "2026-10-27" }, "2026-10-17"), true);
  assert.equal(guideChangesSoon({ iso: "2026-10-17" }, "2026-10-17"), false);
  assert.equal(guideChangesSoon({ iso: "2026-11" }, "2026-10-31"), true);
  assert.equal(guideChangesSoon({ iso: "2026-10" }, "2026-10-17"), false);
  assert.equal(guideChangesSoon({ iso: null }, "2026-10-17"), false);
  assert.equal(guideChangesSoon(null, "2026-10-17"), false);
});

test("a stable exam with a parsed guide and an official course is in the first wave, with its size", () => {
  const r = row("GH-900");
  assert.equal(r.wave, 1);
  assert.equal(r.area, "github");
  assert.deepEqual(r.why, ["1 guide warning"]);
  assert.equal(r.guide.ok, true);
  assert.equal(r.guide.tasks, 36);
  assert.equal(r.guide.groups, 8);
  assert.deepEqual(r.scope, { courses: 1, modules: 12, withResources: 12 });
  assert.equal(r.estimate.judgeBatches, 8);
  assert.equal(r.estimate.expectedPicks, Math.round(36 * PICKS_PER_TASK));
  assert.equal(
    r.estimate.expectedQueue,
    Math.round(36 * PICKS_PER_TASK * 0.25),
  );
  assert.ok(!("reviewMinutes" in r.estimate));
  assert.equal(
    rolloutRow({
      code: "GH-900",
      guide: guide("GH-900"),
      scope: scope(12),
      status: null,
      today: TODAY,
      minutesPerItem: 2,
    }).estimate.reviewMinutes,
    r.estimate.expectedQueue * 2,
  );
});

test("the wave of an exam follows its status, its guide and what Learn offers it", () => {
  assert.equal(row("AZ-104", { pilot: true }).wave, "pilot");
  assert.equal(row("AZ-104", { status: "NEW" }).wave, 2);
  for (const status of ["BETA", "UPCOMING", "AT RISK", "RETIRING"]) {
    const r = row("AZ-104", { status });
    assert.equal(r.wave, "later", status);
    assert.match(r.why[0], new RegExp(status));
  }
  assert.equal(row("AZ-104", { status: "RETIRED" }).wave, "skip");
  assert.equal(row("AZ-104", { scope: null }).wave, "decide");
  assert.equal(row("AZ-104", { scope: scope(0, 0, 0) }).wave, "decide");
  const thin = row("AZ-104", { scope: scope(3) });
  assert.equal(thin.wave, "decide");
  assert.match(
    thin.why[0],
    /only 3 modules in the official course \(threshold 6\)/,
  );
  assert.equal(row("AZ-104", { scope: scope(3), thinModules: 3 }).wave, 1);
  assert.match(row("AZ-104", { scope: scope(1) }).why[0], /only 1 module in/);
  const unlinked = row("AZ-104", { scope: scope(10, 0) });
  assert.equal(unlinked.wave, "decide");
  assert.match(
    unlinked.why[0],
    /no module of the official course has harvested links/,
  );
  const some = row("AZ-104", { scope: scope(10, 6) });
  assert.equal(some.wave, 1);
  assert.ok(some.why.includes("no harvested links in 4 of 10 modules"));
});

test("a guide that does not parse is blocked whatever else is true", () => {
  const broken = rolloutRow({
    code: "AZ-104",
    guide: { lines: ["# nothing here"] },
    scope: scope(12),
    status: "RETIRED",
    today: TODAY,
    pilot: true,
  });
  assert.equal(broken.wave, "blocked");
  assert.equal(broken.guide.ok, false);
  assert.deepEqual(broken.why, [
    "the study guide does not parse completely (no domains found: the guide has neither a skills-at-a-glance list nor weighted headings)",
  ]);
});

test("a guide with a day ahead does not wait: it is noted, because the stored text is already that version", () => {
  const r = row("AB-100", { today: "2026-10-10" });
  assert.equal(r.guide.changesSoon, true);
  assert.equal(r.guide.asOf, "October 14, 2026");
  assert.equal(r.wave, 1, "the new version is the one stored");
  assert.ok(
    r.why.some((w) =>
      /takes effect on October 14, 2026 \(the stored text is that version/.test(
        w,
      ),
    ),
  );
  const later = rolloutRow({
    code: "AB-100",
    guide: guide("AB-100"),
    scope: scope(12),
    status: null,
    today: "2026-10-20",
  });
  assert.equal(later.guide.changesSoon, false);
  assert.ok(!later.why.some((w) => /takes effect/.test(w)));
});

function table(extra = {}) {
  const guides = new Map(
    ["AB-100", "AZ-104", "GH-900", "MB-310"].map((c) => [c, guide(c)]),
  );
  const scopes = {
    "AB-100": scope(11, 11),
    "AZ-104": scope(28, 26),
    "GH-900": scope(16, 15),
    "MB-310": scope(37, 4),
  };
  return rolloutTable({
    guides,
    statuses: { dynamics: { "MB-310": { text: "BETA" } } },
    scopeOf: (code) => scopes[code],
    today: "2026-10-01",
    ...extra,
  });
}

test("the table lists the exams wave by wave, the exams with the most linked modules first, then totals", () => {
  const t = table({ pilot: ["az-104"] });
  assert.deepEqual(
    t.rows.map((r) => `${r.code}:${r.wave}`),
    ["AZ-104:pilot", "GH-900:1", "AB-100:1", "MB-310:later"],
  );
  assert.deepEqual(t.unknownPilot, []);
  assert.deepEqual(
    t.waves.map((w) => [w.wave, w.exams]),
    [
      ["pilot", 1],
      [1, 2],
      ["later", 1],
    ],
  );
  const pilot = t.waves[0];
  assert.equal(pilot.tasks, 82);
  assert.equal(pilot.judgeBatches, 15);
  assert.equal(t.waves[1].tasks, 36 + 74);
  assert.ok(!("reviewMinutes" in pilot));
});

test("the table adds up the review minutes when a time per queue item is given, and names unknown pilot exams", () => {
  const t = table({ pilot: ["AZ-104", "ZZ-999"], minutesPerItem: 1.5 });
  assert.deepEqual(t.unknownPilot, ["ZZ-999"]);
  const sum = t.rows
    .filter((r) => r.wave === 1)
    .reduce((n, r) => n + r.estimate.reviewMinutes, 0);
  assert.equal(t.waves.find((w) => w.wave === 1).reviewMinutes, sum);
  assert.ok(sum > 0);
});

test("the table as text: a heading per wave, a line per exam, the totals", () => {
  const text = describeTable(table({ pilot: ["AZ-104"] })).join("\n");
  assert.match(
    text,
    /== pilot ==\nAZ-104 +82 tasks 15 groups +28 modules \(26 with links\)/,
  );
  assert.match(text, /== wave 1 ==/);
  assert.match(text, /== later ==\nMB-310 +BETA +96 tasks/);
  assert.match(
    text,
    /Totals by wave:\n {2}pilot +1 exams, +82 tasks, +15 judge batches/,
  );
  assert.ok(!/ h of review/.test(text));
  assert.match(
    describeTable(table({ minutesPerItem: 2 }), { minutesPerItem: 2 }).join(
      "\n",
    ),
    / h of review\)/,
  );
});

// ---- the command line -------------------------------------------------------------------------------------------

function world() {
  const root = mkdtempSync(join(tmpdir(), "course-rollout-"));
  temps.push(root);
  mkdirSync(join(root, "src", "data_files"), { recursive: true });
  const g = guide("GH-900");
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({
      studyGuides: [
        { code: g.code, name: g.name, hash: g.hash, lines: g.lines },
      ],
    }),
  );
  return root;
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
  };
}

const inputs = () => {
  const l = learnInputs();
  return {
    courses: l.courses,
    learnsync: {
      warnings: ["module-links.json is old"],
      content: { learningPaths: l.learningPaths },
      catalog: { modules: l.modules },
      moduleLinks: l.moduleLinks,
    },
  };
};

const run = async (argv, root = world(), extra = {}) => {
  const io = capture();
  const code = await main(argv, {
    root,
    env: {},
    now: () => new Date("2026-10-17T10:00:00Z"),
    statuses: {},
    loadInputs: async () => inputs(),
    ...io,
    ...extra,
  });
  return { code, text: io.out.join("\n"), errors: io.err.join("\n") };
};

test("the command prints the table for the stored guides and Learn's data, and writes nothing", async () => {
  const r = await run([]);
  assert.equal(r.code, 0, r.errors);
  assert.match(r.text, /warning: module-links.json is old/);
  assert.match(
    r.text,
    /== decide ==\nGH-900 +36 tasks +8 groups +1 module +\(1 with links\)/,
  );
  assert.match(r.text, /only 1 module in the official course \(threshold 6\)/);
  assert.match(
    r.text,
    /1 exams\. The estimates assume 4\.3 picks per task and 25% of the picks in the queue/,
  );
});

test("--thin, --pilot, --picks-per-task, --queue-share and --minutes-per-item change the table", async () => {
  const r = await run([
    "--thin",
    "2",
    "--pilot",
    "gh-900",
    "--picks-per-task",
    "2",
    "--queue-share",
    "0.5",
    "--minutes-per-item",
    "3",
  ]);
  assert.equal(r.code, 0, r.errors);
  assert.match(r.text, /== pilot ==\nGH-900 /);
  assert.match(r.text, /~36 queue items/, "36 tasks x 2 picks x 50%");
  assert.match(r.text, /~2 h of review/, "36 items x 3 minutes");
  assert.match(r.text, /assume 2 picks per task and 50% of the picks/);
  const wave1 = await run(["--thin", "1"]);
  assert.match(wave1.text, /== wave 1 ==\nGH-900/);
});

test("--json prints the whole table, and the statuses come from exam-status.mjs", async () => {
  const r = await run(["--json", "--thin", "1"], world(), {
    statuses: { github: { "GH-900": { text: "BETA" } } },
  });
  assert.equal(r.code, 0, r.errors);
  const t = JSON.parse(r.text);
  assert.equal(t.rows[0].code, "GH-900");
  assert.equal(t.rows[0].wave, "later");
  assert.equal(t.rows[0].status, "BETA");
});

test("input problems are exit code 2: usage, an unknown pilot exam, the guides or Learn unreadable", async () => {
  for (const [argv, expected] of [
    [["--nope"], /Unknown option or argument --nope/],
    [["--thin"], /--thin needs a value/],
    [["--thin", "x"], /--thin must be a number/],
    [["--queue-share", "2"], /--queue-share must be a number from 0 to 1/],
    [["--today", "tomorrow"], /--today must be a YYYY-MM-DD day/],
    [["--pilot", "ZZ-999"], /No stored study guide for the pilot exam ZZ-999/],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.errors, expected);
  }
  const empty = mkdtempSync(join(tmpdir(), "course-rollout-"));
  temps.push(empty);
  const noGuides = await run([], empty);
  assert.equal(noGuides.code, 2);
  assert.match(noGuides.errors, /Cannot load the inputs: Cannot read /);
  const noLearn = await run([], world(), {
    loadInputs: async () => {
      throw new Error("the catalog API answered HTTP 503");
    },
  });
  assert.equal(noLearn.code, 2);
  assert.match(
    noLearn.errors,
    /Cannot load the inputs: the catalog API answered HTTP 503/,
  );
});
