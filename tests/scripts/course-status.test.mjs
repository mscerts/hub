import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { describePlan, main } from "../../scripts/course-status.mjs";
import {
  planGuideChanges,
  rebuildPlan,
} from "../../scripts/lib/course-status.mjs";
import {
  exampleCourse,
  learnInputs,
  readGuideFixture,
  scopeMapFor,
} from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const tasksOf = (tree) =>
  tree.domains.flatMap((d) => d.groups.flatMap((g) => g.tasks));

/** The plan for the example course against a (possibly changed) guide and Learn. */
function plan({ change = () => {}, learn = () => {}, isCurrent } = {}) {
  const { course, guide } = exampleCourse();
  const inputs = learnInputs();
  change(guide, course);
  learn(inputs);
  return rebuildPlan({
    course,
    guide,
    scopeMap: scopeMapFor(inputs),
    catalog: inputs.modules,
    isCurrent,
  });
}

test("nothing changed: the course is current and no task needs work", () => {
  const p = plan();
  assert.equal(p.status, "current");
  assert.deepEqual(p.reasons, []);
  assert.deepEqual(p.reviewReasons, []);
  assert.deepEqual(p.picks, { hard: [], soft: [] });
  assert.equal(p.work.unchanged, 36);
  assert.deepEqual(p.work.tasksToBuild, []);
  assert.equal(p.scope.fingerprintChanged, false);
});

test("a changed guide text, date or hash with the same tasks is information, never a rebuild", () => {
  const p = plan({
    change: (guide) => (
      (guide.hash = "another-hash"),
      (guide.asOf = { text: "March 3, 2027", iso: "2027-03-03" })
    ),
  });
  assert.equal(p.status, "current");
  assert.equal(p.guide.hashChanged, true);
  assert.deepEqual(p.guide.asOf, { from: "January 2026", to: "March 3, 2027" });
  assert.equal(p.guide.treeChanged, false);
});

test("a task the guide added needs picks; a task it removed drops its picks", () => {
  const added = plan({
    change: (guide) =>
      guide.domains[0].groups[0].tasks.push({
        key: "understand-git-and-github-basics/version-control-fundamentals/a-new-task",
        text: "A new task",
      }),
  });
  assert.equal(added.status, "stale");
  assert.deepEqual(
    added.guide.added.map((t) => t.text),
    ["A new task"],
  );
  assert.deepEqual(added.work.tasksToBuild, [
    "understand-git-and-github-basics/version-control-fundamentals/a-new-task",
  ]);
  assert.equal(added.work.unchanged, 36);
  assert.match(added.reasons.join("|"), /1 task\(s\) added to the study guide/);

  const removed = plan({
    change: (guide) => guide.domains[0].groups[0].tasks.shift(),
  });
  assert.equal(removed.status, "stale");
  assert.equal(removed.guide.removed.length, 1);
  assert.equal(
    removed.guide.removed[0].text,
    "Describe the purpose and benefits of version control",
  );
  assert.match(removed.reasons.join("|"), /1 task\(s\) removed/);
});

test("a task with the same wording in a new place (a renamed group) is moved, and keeps its picks", () => {
  const p = plan({
    change: (guide) => {
      guide.domains[0].groups[0].title = "Version control basics";
      for (const t of guide.domains[0].groups[0].tasks)
        t.key = t.key.replace(
          "/version-control-fundamentals/",
          "/version-control-basics/",
        );
    },
  });
  assert.equal(p.status, "stale");
  assert.equal(p.guide.moved.length, 3);
  assert.deepEqual(p.guide.added, []);
  assert.deepEqual(p.guide.removed, []);
  assert.equal(p.work.carriedOver.length, 3);
  assert.deepEqual(p.work.tasksToBuild, []);
});

test("similar wording is a rename hint: the maintainer decides whether the picks carry over", () => {
  const p = plan({
    change: (guide) => {
      const task = guide.domains[0].groups[0].tasks[0];
      task.text = "Describe the purpose and benefits of using version control";
      task.key = `${task.key}-using`;
    },
  });
  assert.equal(p.guide.renameHints.length, 1);
  assert.equal(
    p.guide.renameHints[0].from.text,
    "Describe the purpose and benefits of version control",
  );
  assert.ok(p.guide.renameHints[0].similarity >= 0.6);
  assert.equal(p.status, "stale");
  // wording that is not similar gets no hint
  const unrelated = plan({
    change: (guide) => {
      const task = guide.domains[0].groups[0].tasks[0];
      task.text = "Configure webhooks for deployment pipelines";
      task.key = "x/y/webhooks";
    },
  });
  assert.deepEqual(unrelated.guide.renameHints, []);
});

test("a reordered guide, and a changed domain weight", () => {
  const p = plan({
    change: (guide) => guide.domains[0].groups[0].tasks.reverse(),
  });
  assert.equal(p.guide.reordered, true);
  assert.equal(p.status, "stale");
  const w = plan({
    change: (guide) => (guide.domains[0].weight = { min: 30, max: 35 }),
  });
  assert.deepEqual(w.guide.weightChanges, [
    {
      domain: "Understand Git and GitHub basics",
      from: "25-30%",
      to: "30-35%",
    },
  ]);
  assert.equal(w.status, "current", "a weight is information");
});

test("flattenTasks-based planning works on a guide and a course alike (planGuideChanges)", () => {
  const { course, guide } = exampleCourse();
  const changes = planGuideChanges(guide, course);
  assert.equal(changes.treeChanged, false);
  assert.equal(tasksOf(guide).length, 36);
});

test("a module of the official course whose content changed makes the picks that use it worth a look (review, not stale)", () => {
  const p = plan({
    learn: (inputs) => (inputs.modules[0].unitSig = "sig-intro-2"),
  });
  assert.equal(p.status, "review");
  assert.deepEqual(p.picks.hard, []);
  assert.equal(
    p.picks.soft.length,
    2,
    "the module pick and the unit pick; the documentation pages it lists are unaffected by a content-only change",
  );
  assert.ok(
    p.picks.soft.every(
      (s) => s.reason === "the module's content changed" && s.source === "P1",
    ),
  );
  assert.match(
    p.reviewReasons.join("|"),
    /pick\(s\) rely on something that changed/,
  );
  assert.equal(p.scope.fingerprintChanged, true);
  assert.equal(p.work.tasksToBuild.length, 0);
  assert.ok(p.work.tasksToCheck.length >= 1);
});

test("a content change in a module with no pick is not even a review", () => {
  const p = plan({
    learn: (inputs) => {
      inputs.modules.push({
        uid: "learn.other",
        path: "/training/modules/other",
        title: "Other",
        unitSig: "x",
        units: [],
        unitUrls: [],
      });
      inputs.learningPaths[0].modules.push("/training/modules/other");
    },
  });
  assert.equal(p.status, "review", "a module was added to the official course");
  assert.match(
    p.reviewReasons.join("|"),
    /1 module\(s\) added to the exam's official course/,
  );
  assert.deepEqual(p.picks, { hard: [], soft: [] });
});

test("a module that left the official course breaks its picks, and those of the pages it listed", () => {
  const p = plan({
    learn: (inputs) => (
      (inputs.learningPaths[0].modules = []),
      (inputs.moduleLinks.modules = [])
    ),
  });
  assert.equal(p.status, "stale");
  const reasons = p.picks.hard.map((h) => h.reason);
  assert.ok(reasons.includes("its module left the exam's official course"));
  assert.ok(
    reasons.includes(
      "the module that lists it left the exam's official course",
    ),
  );
  assert.match(p.reasons.join("|"), /pick\(s\) have to be replaced/);
  assert.ok(p.work.tasksToBuild.length >= 3);
});

test("a documentation page the module stopped listing is a hard break; one listed under a new path is a soft one", () => {
  const dropped = plan({
    learn: (inputs) =>
      (inputs.moduleLinks.modules[0].links = [
        {
          kind: "docs",
          path: "/azure/github/branches",
          text: "About branches",
          section: "Learn more",
        },
      ]),
  });
  assert.equal(dropped.status, "stale");
  assert.deepEqual(
    dropped.picks.hard.map((h) => [h.path, h.reason]),
    [["/azure/github/overview", "the module no longer lists it"]],
  );
  const moved = plan({
    learn: (inputs) =>
      (inputs.moduleLinks.modules[0].links = [
        {
          kind: "docs",
          path: "/azure/github/overview",
          text: "What is GitHub?",
          section: "Learn more",
        },
        {
          kind: "docs",
          path: "/azure/github/new-branches",
          was: "/azure/github/branches",
          text: "About branches",
          section: "Learn more",
        },
      ]),
  });
  assert.deepEqual(moved.picks.hard, []);
  assert.deepEqual(
    moved.picks.soft
      .filter((s) => s.source === "P2")
      .map((s) => [s.path, s.reason]),
    [
      [
        "/azure/github/branches",
        "the module lists this page under a new path now",
      ],
    ],
  );
  assert.equal(moved.status, "review");
});

test("a unit that no longer exists in its module is a hard break", () => {
  const p = plan({
    learn: (inputs) =>
      (inputs.modules[0].unitUrls = inputs.modules[0].unitUrls.filter(
        (u) => !u.endsWith("2-what-is-git"),
      )),
  });
  assert.equal(p.status, "stale");
  assert.ok(
    p.picks.hard.some(
      (h) =>
        h.path === "/training/modules/intro-to-github/2-what-is-git" &&
        h.reason === "the unit no longer exists in its module",
    ),
  );
});

test("modules outside the official course (inputs.picked): gone is hard, changed is soft", () => {
  const gone = plan({
    learn: (inputs) => (
      (inputs.modules = inputs.modules.filter(
        (m) => !m.path.includes("advanced"),
      )),
      void 0
    ),
  });
  assert.deepEqual(
    gone.picks.hard.map((h) => [h.source, h.reason]),
    [["P3", "its module left the catalog"]],
  );
  assert.equal(gone.status, "stale");
  assert.deepEqual(gone.scope.picked.missing, [
    "/training/modules/advanced-git-workflows",
  ]);
  const changed = plan({
    learn: (inputs) => (inputs.modules[1].unitSig = "sig-advanced-2"),
  });
  assert.deepEqual(
    changed.picks.soft.map((s) => [s.source, s.reason]),
    [["P3", "its module's content changed"]],
  );
  assert.equal(changed.status, "review");
});

test("a target that is no longer a current Learn page (the optional URL check) is a hard break", () => {
  const p = plan({
    isCurrent: (path) =>
      path === "/azure/github/overview"
        ? { ok: false, reason: "moved to /azure/github/about" }
        : { ok: true },
  });
  assert.equal(p.status, "stale");
  assert.deepEqual(
    p.picks.hard.map((h) => h.reason),
    ["not a current Learn page (moved to /azure/github/about)"],
  );
});

test("the exam's official course list changing is a review", () => {
  const p = plan({
    learn: (inputs) =>
      (inputs.courses[0].last_modified = "2026-10-01T00:00:00Z"),
  });
  assert.equal(p.status, "review");
  assert.deepEqual(p.scope.diff.courses.changed, ["GH-900T00"]);
  assert.match(p.reviewReasons.join("|"), /official course list changed/);
});

test("describePlan prints a readable summary and caps long lists", () => {
  const p = plan({
    change: (guide) => {
      const group = guide.domains[0].groups[0];
      for (let i = 0; i < 14; i++)
        group.tasks.push({
          key: `k/${i}`,
          text: `New task ${i} about something else entirely ${i * 7}`,
        });
    },
  });
  const text = describePlan(p).join("\n");
  assert.match(text, /^GH-900: STALE - 14 task\(s\) added to the study guide/);
  assert.match(text, /Study guide: 14 task\(s\) added \(they need picks\)/);
  assert.match(text, /\.\.\. and 4 more/);
  assert.match(
    text,
    /Work: build 14 task\(s\), check 0, carry over 0, 36 untouched/,
  );
  assert.match(describePlan(plan()).join("\n"), /^GH-900: CURRENT$/);
});

// ------------------------------------------------------------------------------------------------ the command line

function world({ course = exampleCourse().course, guide = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-status-"));
  temps.push(base);
  const root = join(base, "hub");
  mkdirSync(join(root, "src", "data_files", "courses"), { recursive: true });
  const g = readGuideFixture("GH-900");
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({
      studyGuides: guide
        ? [{ code: g.code, name: g.name, hash: g.hash, lines: g.lines }]
        : [],
    }),
  );
  if (course)
    writeFileSync(
      join(root, "src", "data_files", "courses", "GH-900.json"),
      JSON.stringify(course),
    );
  const dir = join(base, "learnsync");
  mkdirSync(join(dir, "data"), { recursive: true });
  const inputs = learnInputs();
  writeFileSync(
    join(dir, "data", "learn-catalog.json"),
    JSON.stringify({ modules: inputs.modules }),
  );
  writeFileSync(
    join(dir, "data", "learn-content.json"),
    JSON.stringify({ learningPaths: inputs.learningPaths }),
  );
  writeFileSync(
    join(dir, "data", "module-links.json"),
    JSON.stringify(inputs.moduleLinks),
  );
  const fetchImpl = async () =>
    new Response(JSON.stringify({ courses: inputs.courses }), { status: 200 });
  return { root, dir, fetchImpl, inputs };
}
const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
  };
};

test("the command: a current course exits 0, a stale one exits 1 and prints the plan, --json prints it as data", async () => {
  const w = world();
  const c = capture();
  assert.equal(
    await main(["gh-900"], {
      root: w.root,
      env: { LEARNSYNC_DIR: w.dir },
      fetchImpl: w.fetchImpl,
      log: c.log,
      error: c.error,
    }),
    0,
    c.err.join("\n"),
  );
  assert.deepEqual(c.out, ["GH-900: CURRENT"]);

  const stale = world({
    course: (() => {
      const { course } = exampleCourse();
      course.domains[0].groups[0].tasks.pop();
      return course;
    })(),
  });
  const s = capture();
  assert.equal(
    await main(["GH-900"], {
      root: stale.root,
      env: { LEARNSYNC_DIR: stale.dir },
      fetchImpl: stale.fetchImpl,
      log: s.log,
      error: s.error,
    }),
    1,
  );
  assert.match(
    s.out.join("\n"),
    /GH-900: STALE - 1 task\(s\) added to the study guide/,
  );

  const j = capture();
  await main(["GH-900", "--json"], {
    root: stale.root,
    env: { LEARNSYNC_DIR: stale.dir },
    fetchImpl: stale.fetchImpl,
    log: j.log,
    error: j.error,
  });
  const parsed = JSON.parse(j.out.join("\n"));
  assert.equal(parsed.code, "GH-900");
  assert.equal(parsed.status, "stale");
  assert.equal(parsed.guide.added.length, 1);
});

test("--all with no course files says so; with one it summarises", async () => {
  const none = world({ course: null });
  const c = capture();
  assert.equal(
    await main(["--all"], {
      root: none.root,
      env: { LEARNSYNC_DIR: none.dir },
      fetchImpl: none.fetchImpl,
      log: c.log,
      error: c.error,
    }),
    0,
  );
  assert.deepEqual(c.out, ["No course files: nothing to check."]);
  const one = world();
  const d = capture();
  assert.equal(
    await main(["--all"], {
      root: one.root,
      env: { LEARNSYNC_DIR: one.dir },
      fetchImpl: one.fetchImpl,
      log: d.log,
      error: d.error,
    }),
    0,
  );
  assert.equal(d.out.length, 1, "a single course prints no total line");
});

test("--urls asks the URL check about every pick: a page that is not current makes the course stale", async () => {
  const w = world();
  const c = capture();
  const verdictsFor = async (paths) =>
    new Map(
      paths.map((p) => [
        p,
        p === "/azure/github/branches"
          ? {
              path: p,
              verdict: "moved",
              redirectsTo: "/azure/github/about",
              reason: "redirects",
            }
          : { path: p, verdict: "valid" },
      ]),
    );
  assert.equal(
    await main(["GH-900", "--urls"], {
      root: w.root,
      env: { LEARNSYNC_DIR: w.dir },
      fetchImpl: w.fetchImpl,
      log: c.log,
      error: c.error,
      verdictsFor,
    }),
    1,
  );
  assert.match(
    c.out.join("\n"),
    /\/azure\/github\/branches .*not a current Learn page \(moved to \/azure\/github\/about: redirects\)/,
  );
});

test("input problems exit 2: usage, no course file, no stored guide, no Learn data", async () => {
  const w = world();
  for (const [argv, expected] of [
    [[], /An exam code or --all is required/],
    [["GH-900", "AZ-104"], /Only one exam code/],
    [["GH-900", "--all"], /not both/],
    [["GH-900", "--nope"], /Unknown option --nope/],
  ]) {
    const c = capture();
    assert.equal(
      await main(argv, { root: w.root, env: {}, log: c.log, error: c.error }),
      2,
      argv.join(" "),
    );
    assert.match(c.err.join("\n"), expected);
  }
  const missing = capture();
  assert.equal(
    await main(["AZ-104"], {
      root: w.root,
      env: { LEARNSYNC_DIR: w.dir },
      fetchImpl: w.fetchImpl,
      log: missing.log,
      error: missing.error,
    }),
    2,
  );
  assert.match(missing.err.join("\n"), /it does not exist/);
  const noGuide = world({ guide: false });
  const g = capture();
  assert.equal(
    await main(["GH-900"], {
      root: noGuide.root,
      env: { LEARNSYNC_DIR: noGuide.dir },
      fetchImpl: noGuide.fetchImpl,
      log: g.log,
      error: g.error,
    }),
    2,
  );
  assert.match(g.err.join("\n"), /No stored study guide text for GH-900/);
  const down = capture();
  assert.equal(
    await main(["GH-900"], {
      root: w.root,
      env: { LEARNSYNC_DIR: w.dir },
      fetchImpl: async () => new Response("", { status: 503 }),
      log: down.log,
      error: down.error,
    }),
    2,
  );
  assert.match(down.err.join("\n"), /Cannot load the inputs: .* HTTP 503/);
});
