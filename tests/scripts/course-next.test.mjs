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
import { join } from "node:path";
import test, { after } from "node:test";
import { main as renderMain } from "../../scripts/course-file.mjs";
import { main } from "../../scripts/course-next.mjs";
import { renderCourseVersions } from "../../scripts/lib/course-render.mjs";
import {
  CARRY_SIMILARITY,
  MAJOR_SHARE,
  buildNext,
  confirmPending,
  isComplete,
  mergeBuilt,
  pairTasks,
  planNext,
  rejectPending,
  rekeyDecisions,
  versionLabels,
  versionMarks,
} from "../../scripts/lib/course-next.mjs";
import { validateCourse } from "../../scripts/lib/course-format.mjs";
import { parseGuide } from "../../scripts/lib/course-guide.mjs";
import { asOfOfHeading } from "../../scripts/lib/guide-history.mjs";
import { domains, guide } from "../fixtures/study-guide-changes/guides.mjs";
import { exampleCourse } from "./helpers/example-course.mjs";

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CODE = "DP-700";
const VERSION = { n: 2, asOf: "2026-12-01", firstSeen: "2026-11-10" };

/** A course with the tasks of a guide and two picks under every task (the format is not checked here). */
function courseOf(lines) {
  const tree = parseGuide(lines);
  assert.equal(tree.ok, true, "the fixture guide parses");
  return {
    schemaVersion: 1,
    code: CODE,
    name: "Example",
    inputs: {
      guideHash: "abc",
      guideAsOf: "June 1, 2026",
      builtAt: "2026-06-02",
    },
    domains: tree.domains.map((d) => ({
      title: d.title,
      ...(d.weight ? { weight: d.weight } : {}),
      groups: d.groups.map((g) => ({
        title: g.title,
        foundations: [{ title: `Fundamentals of ${g.title}` }],
        tasks: g.tasks.map((t) => ({
          key: t.key,
          text: t.text,
          picks: [{ title: `${t.text} one` }, { title: `${t.text} two` }],
        })),
      })),
    })),
    rejected: [],
  };
}

const V1 = guide({ asOf: "2026-06-01", domains: domains() });
const upcoming = (edit = () => {}) =>
  parseGuide(guide({ asOf: "2026-12-01", domains: domains(edit) }));

// one task added, one removed, one reworded with most of its words, one reworded with few of them,
// one moved to another skill group
const edits = (d) => {
  d[0].groups[0].tasks.push("Configure data workflow workspace settings"); // added
  const lifecycle = d[0].groups[1].tasks;
  lifecycle.splice(lifecycle.indexOf("Implement database projects"), 1); // removed
  const loading = d[1].groups[0].tasks;
  loading[1] =
    "Prepare data for loading into a dimensional model or a lakehouse"; // 80% of the words
  const monitor = d[2].groups[0].tasks;
  monitor[1] = "Monitor transformation of data workloads"; // 60%
  monitor.splice(monitor.indexOf("Monitor semantic model refresh"), 1);
  lifecycle.push("Monitor semantic model refresh"); // moved
};

// every task of the guide is another one
const rewriteEdit = (d) => {
  for (const group of d.flatMap((x) => x.groups))
    group.tasks = group.tasks.map(
      (t) =>
        `Something else entirely about ${t.split(" ").at(-1)} topics ${t.length}`,
    );
};

const keyOf = (tree, text) =>
  tree.domains
    .flatMap((d) => d.groups.flatMap((g) => g.tasks))
    .find((t) => t.text === text).key;

test("pairTasks: same, moved, reworded, added and removed tasks are told apart", () => {
  const course = courseOf(V1);
  const pairs = pairTasks(course, upcoming(edits));
  const kinds = Object.fromEntries(
    ["same", "moved", "reworded", "added", "removed"].map((k) => [
      k,
      pairs.filter((p) => p.kind === k).length,
    ]),
  );
  assert.deepEqual(kinds, {
    same: 8,
    moved: 1,
    reworded: 2,
    added: 1,
    removed: 1,
  });
  const moved = pairs.find((p) => p.kind === "moved");
  assert.equal(moved.new.text, "Monitor semantic model refresh");
  assert.notEqual(moved.old.key, moved.new.key);
  const reworded = pairs.filter((p) => p.kind === "reworded");
  assert.deepEqual(reworded.map((p) => p.similarity).sort(), [0.6, 0.8]);
  // the new tasks come in the guide's order, the removed ones last
  assert.equal(pairs.at(-1).kind, "removed");
  assert.equal(pairs.at(-1).old.text, "Implement database projects");
});

test("planNext: a small change is an update; a rewrite, a gone domain or a new group is not patched", () => {
  const course = courseOf(V1);
  const update = planNext({ course, guide: upcoming(edits) });
  assert.equal(update.major, null);
  assert.equal(update.counts.tasks, 12);
  assert.equal(update.share, 0.25);

  // every task of one group is replaced: 3 of 12 new, then more than half of them in total
  const rewrite = planNext({
    course,
    guide: upcoming(rewriteEdit),
  });
  assert.ok(
    rewrite.major.some((r) => r.includes(`more than ${MAJOR_SHARE * 100}%`)),
  );

  const gone = planNext({ course, guide: upcoming((d) => d.pop()) });
  assert.ok(gone.major.some((r) => r.includes("a domain is gone")));

  const newGroup = planNext({
    course,
    guide: upcoming((d) =>
      d[0].groups.push({
        title: "Secure the workspace",
        tasks: ["Apply sensitivity labels"],
      }),
    ),
  });
  assert.ok(
    newGroup.major.some((r) =>
      r.includes("skill group is new: Secure the workspace"),
    ),
  );
});

test("buildNext: picks and decisions carry over, new tasks wait to be built, weak rewordings wait for a look", () => {
  const course = courseOf(V1);
  const target = upcoming(edits);
  const result = buildNext({
    course,
    guide: target,
    version: { ...VERSION, lines: [] },
    today: "2026-11-16",
  });
  assert.equal(result.ok, true);
  const { next, report, rekey } = result;

  const task = (text) =>
    next.domains
      .flatMap((d) => d.groups.flatMap((g) => g.tasks))
      .find((t) => t.text === text);
  // the same task keeps its picks, a carried copy and not the very same objects
  const kept = task("Configure Spark workspace settings");
  assert.deepEqual(kept.picks, course.domains[0].groups[0].tasks[0].picks);
  assert.notEqual(kept.picks[0], course.domains[0].groups[0].tasks[0].picks[0]);
  // a moved task keeps its picks under its new key
  assert.equal(task("Monitor semantic model refresh").picks.length, 2);
  // the new task has none and is pending
  const addedKey = keyOf(target, "Configure data workflow workspace settings");
  assert.deepEqual(
    task("Configure data workflow workspace settings").picks,
    [],
  );
  assert.deepEqual(next.pending.added, [addedKey]);
  // the weak rewording is to be confirmed, the strong one is trusted
  assert.deepEqual(
    next.pending.confirm.map((c) => [c.key, c.was, c.similarity]),
    [
      [
        keyOf(target, "Monitor transformation of data workloads"),
        "Monitor data transformation",
        0.6,
      ],
    ],
  );
  assert.equal(
    task("Prepare data for loading into a dimensional model or a lakehouse")
      .picks.length,
    2,
  );
  assert.ok(0.8 >= CARRY_SIMILARITY);
  // the removed task is gone with its picks; the groups keep their fundamentals; nothing needs fundamentals
  assert.equal(task("Implement database projects"), undefined);
  assert.equal(next.domains[0].groups[0].foundations.length, 1);
  assert.equal(next.pending.foundations, undefined);
  // the version and the date: the old guide's hash and date are not the upcoming version's
  assert.equal(next.inputs.guideHash, undefined);
  assert.equal(next.inputs.guideAsOf, "December 1, 2026");
  assert.deepEqual(next.inputs.guideVersion, {
    n: 2,
    asOf: "2026-12-01",
    firstSeen: "2026-11-10",
  });
  assert.equal(next.inputs.builtAt, "2026-11-16");
  assert.equal(isComplete(next), false);
  // what changed key, for the decisions
  assert.equal(report.carried, 11);
  assert.deepEqual(report.removed, [
    keyOf(parseGuide(V1), "Implement database projects"),
  ]);
  assert.ok(
    rekey.tasks.some(
      ([from, to]) =>
        from.endsWith("monitor-semantic-model-refresh") && to !== from,
    ),
  );
});

test("buildNext: a rewrite builds nothing unless it is forced", () => {
  const course = courseOf(V1);
  const target = upcoming((d) => d.pop());
  const refused = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.plan.major.length > 0);
  const forced = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
    force: true,
  });
  assert.equal(forced.ok, true);
});

test("buildNext: a group without a counterpart needs its fundamentals, and the overlaps follow the new keys", () => {
  const course = courseOf(V1);
  const first = course.domains[0].groups[0].tasks[1];
  const second = course.domains[0].groups[0].tasks[0];
  first.overlaps = [{ path: "/m", title: "m", shownUnder: second.key }];
  const target = upcoming(); // the same tasks
  const unchanged = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
  });
  assert.equal(
    unchanged.next.pending,
    undefined,
    "an unchanged tree is complete",
  );
  assert.deepEqual(unchanged.next.domains[0].groups[0].tasks[1].overlaps, [
    { path: "/m", title: "m", shownUnder: second.key },
  ]);
  const forced = buildNext({
    course,
    guide: upcoming((d) => {
      d[0].groups.push({
        title: "Secure the workspace",
        tasks: ["Apply sensitivity labels"],
      });
    }),
    version: VERSION,
    today: "2026-11-16",
    force: true,
  });
  assert.equal(forced.next.pending.foundations.length, 1);
  assert.match(forced.next.pending.foundations[0], /secure-the-workspace$/);
});

test("confirm, reject and merge clear the pending list, and an empty list leaves no pending at all", () => {
  const course = courseOf(V1);
  const target = upcoming(edits);
  const { next } = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
  });
  const confirmKey = next.pending.confirm[0].key;

  const unknown = confirmPending(next, { keys: ["nope"] });
  assert.deepEqual(unknown.unknown, ["nope"]);
  const confirmed = confirmPending(next, { keys: [confirmKey] });
  assert.equal(confirmed.confirmed, 1);
  assert.equal(confirmed.next.pending.confirm, undefined);
  assert.equal(confirmed.next.pending.added.length, 1);

  // reject: the carried picks go, the task becomes one to build
  const rejected = rejectPending(next, confirmKey);
  assert.equal(rejected.rejected, true);
  const rejectedTask = rejected.next.domains
    .flatMap((d) => d.groups.flatMap((g) => g.tasks))
    .find((t) => t.key === confirmKey);
  assert.deepEqual(rejectedTask.picks, []);
  assert.ok(rejected.next.pending.added.includes(confirmKey));
  assert.equal(rejected.next.pending.confirm, undefined);
  assert.equal(rejectPending(next, "nope").rejected, false);

  // merge: the picks a build made for the tasks still to be built come in
  const addedKey = next.pending.added[0];
  const built = structuredClone(next);
  built.domains
    .flatMap((d) => d.groups.flatMap((g) => g.tasks))
    .find((t) => t.key === addedKey).picks = [
    { title: "Built for the new task" },
  ];
  const merged = mergeBuilt(confirmed.next, built);
  assert.deepEqual(merged.merged.tasks, [addedKey]);
  assert.deepEqual(merged.missing, []);
  assert.equal(merged.next.pending, undefined, "nothing is left");
  assert.equal(isComplete(merged.next), true);
  const mergedTask = merged.next.domains
    .flatMap((d) => d.groups.flatMap((g) => g.tasks))
    .find((t) => t.key === addedKey);
  assert.equal(mergedTask.picks[0].title, "Built for the new task");
  // a task the build does not have stays pending and is reported
  const empty = mergeBuilt(next, { domains: [] });
  assert.equal(empty.missing.length, next.pending.added.length);
  assert.equal(empty.next.pending.added.length, next.pending.added.length);
});

test("rekeyDecisions: decisions follow the tasks that changed key and leave with the tasks that are gone", () => {
  const rekey = {
    tasks: [["a/b/old", "a/b/new"]],
    groups: [["a/b", "a/c"]],
    removed: ["a/b/gone"],
  };
  const store = {
    schemaVersion: 1,
    code: CODE,
    decisions: [
      { task: "a/b/old", target: "/x", decision: "reject" },
      { task: "a/b/gone", target: "/y", decision: "reject" },
      { task: "a/b/same", target: "/z", decision: "reject" },
      { task: "a/b/@foundations", target: "/f", decision: "reject" },
    ],
    excludedFamilies: [],
  };
  const { store: out, moved, dropped } = rekeyDecisions(store, rekey);
  assert.deepEqual(
    out.decisions.map((d) => d.task),
    ["a/b/new", "a/b/same", "a/c/@foundations"],
  );
  assert.equal(moved, 2);
  assert.equal(dropped, 1);
});

// ---------------------------------------------------------------------------------------------------
// The command line, on the example course (a valid course on the real GH-900 guide)

/** The skills part of a guide the way the history keeps it: a "Skills measured" heading, then the guide from its glance list on. */
const skillsLines = (lines) => [
  "## Skills measured as of October 14, 2026",
  ...lines.slice(
    lines.findIndex((l) => /^#{1,6}\s+skills at a glance/i.test(l)),
  ),
];

/** A repo root with the example course for GH-900 and its guide history: version 1 is its guide, version 2 an upcoming one. */
function world({ withEdits = true } = {}) {
  const { course, fixture } = exampleCourse();
  const v1 = skillsLines(fixture.lines);
  const tree = parseGuide(v1);
  const tasks = tree.domains.flatMap((d) => d.groups.flatMap((g) => g.tasks));
  let v2 = v1.map((l) =>
    l.replace(
      /^## Skills measured.*$/,
      "## Skills measured as of December 1, 2026",
    ),
  );
  if (withEdits) {
    const reword = tasks[0].text;
    const removed = tasks[3].text;
    const added = tasks[5].text;
    v2 = v2.flatMap((l) => {
      if (l === `- ${reword}`) return [`- ${reword} and its history`];
      if (l === `- ${removed}`) return [];
      if (l === `- ${added}`) return [l, "- Describe the brand new capability"];
      return [l];
    });
  }
  const heading = v1[0];
  const asOf1 = asOfOfHeading(heading);
  const root = mkdtempSync(join(tmpdir(), "course-next-"));
  temps.push(root);
  mkdirSync(join(root, "src", "data_files", "courses"), { recursive: true });
  mkdirSync(join(root, "src", "data_files", "study-guide-history"), {
    recursive: true,
  });
  course.inputs.guideVersion = { n: 1, asOf: asOf1, firstSeen: "2026-10-15" };
  writeFileSync(
    join(root, "src", "data_files", "courses", "GH-900.json"),
    JSON.stringify(course),
  );
  writeFileSync(
    join(root, "src", "data_files", "study-guide-history", "GH-900.json"),
    JSON.stringify({
      schemaVersion: 1,
      code: "GH-900",
      versions: [
        { n: 1, asOf: asOf1, firstSeen: "2026-10-15", lines: v1 },
        { n: 2, asOf: "2026-12-01", firstSeen: "2026-11-10", lines: v2 },
      ],
    }),
  );
  return { root, course, tasks };
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
const NOW = new Date("2026-11-16T12:00:00Z");
const run = (root, argv, io = capture()) => ({
  code: main(argv, { root, now: NOW, ...io, env: {} }),
  ...io,
});
const nextPath = (root) =>
  join(root, "src", "data_files", "courses", "GH-900.next.json");

test("course-next build: says what changes and writes nothing without --write", () => {
  const { root } = world();
  const r = run(root, ["build", "GH-900"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /version 1 to 2 \(as of 2026-12-01\)/);
  assert.match(r.out.join("\n"), /Not written \(add --write\)/);
  assert.equal(existsSync(nextPath(root)), false);
});

test("course-next build --write, status, merge: the upcoming file is valid and becomes complete", () => {
  const { root } = world();
  const io = capture();
  assert.equal(
    run(root, ["build", "GH-900", "--write"], io).code,
    0,
    io.err.join("\n"),
  );
  const next = JSON.parse(readFileSync(nextPath(root), "utf8"));
  assert.deepEqual(next.inputs.guideVersion, {
    n: 2,
    asOf: "2026-12-01",
    firstSeen: "2026-11-10",
  });
  assert.equal(next.pending.added.length, 1);
  // a second --write is refused, --force replaces it
  assert.equal(run(root, ["build", "GH-900", "--write"]).code, 1);
  const status = run(root, ["status", "GH-900"]);
  assert.equal(status.code, 0, status.err.join("\n"));
  assert.match(status.out.join("\n"), /1 tasks to build/);

  // a build of the new task (the pipeline's answer: none for it) clears the list
  const built = structuredClone(next);
  writeFileSync(join(root, "built.json"), JSON.stringify(built));
  const merged = run(root, [
    "merge",
    "GH-900",
    "--from",
    join(root, "built.json"),
  ]);
  assert.equal(merged.code, 0, merged.err.join("\n"));
  assert.match(merged.out.join("\n"), /The upcoming course is complete\./);
  const after = JSON.parse(readFileSync(nextPath(root), "utf8"));
  assert.equal(after.pending, undefined);
  // the file stays valid against the version it names (the checks of the validator, with the history)
  const history = JSON.parse(
    readFileSync(
      join(root, "src", "data_files", "study-guide-history", "GH-900.json"),
      "utf8",
    ),
  );
  const guide = parseGuide(history.versions[1].lines);
  const v = validateCourse(after, { guide, history, next: true });
  assert.deepEqual(v.errors, []);
});

test("course-next: the other commands refuse what does not apply", () => {
  const { root } = world();
  assert.equal(run(root, ["status", "GH-900"]).code, 2, "no upcoming file yet");
  assert.equal(run(root, ["build", "GH-900", "--version", "9"]).code, 2);
  assert.equal(run(root, ["build"]).code, 2);
  assert.equal(run(root, ["confirm", "GH-900"]).code, 2);
  assert.equal(run(root, ["build", "GH-900", "--bogus"]).code, 2);
  // nothing is dated ahead on a later day
  const later = run(root, ["build", "GH-900"], { ...capture() });
  assert.equal(later.code, 0);
  const io = capture();
  const after = main(["build", "GH-900"], {
    root,
    now: new Date("2027-01-01T00:00:00Z"),
    ...io,
    env: {},
  });
  assert.equal(after, 0);
  assert.match(
    io.out.join("\n"),
    /no version of the study guide is dated ahead/,
  );
});

test("course-next build: a rewrite is refused with its reasons", () => {
  const { root } = world();
  // every task of the upcoming guide is another one: more than half of the tasks are new
  const file = join(
    root,
    "src",
    "data_files",
    "study-guide-history",
    "GH-900.json",
  );
  const history = JSON.parse(readFileSync(file, "utf8"));
  let inTasks = false;
  let n = 0;
  history.versions[1].lines = history.versions[1].lines.map((line) => {
    if (/^####\s/.test(line)) inTasks = true;
    return inTasks && /^- /.test(line)
      ? `- Unrelated skill number ${++n}`
      : line;
  });
  writeFileSync(file, JSON.stringify(history));
  const r = run(root, ["build", "GH-900", "--write"]);
  const said = r.err.join(" | ");
  assert.equal(r.code, 1, said);
  assert.match(said, /This is a rewrite, not an update/);
  assert.match(said, /are new or reworded \(more than 50%\)/);
  assert.equal(existsSync(nextPath(root)), false);
});

test("course-next build: a course that names no version is sent to the backfill", () => {
  const { root, course } = world();
  delete course.inputs.guideVersion;
  writeFileSync(
    join(root, "src", "data_files", "courses", "GH-900.json"),
    JSON.stringify(course),
  );
  const r = run(root, ["build", "GH-900"]);
  assert.equal(r.code, 2);
  assert.match(r.err.join("\n"), /course-versions-backfill/);
});

// ---------------------------------------------------------------------------------------------------
// The page with two versions

const pagePick = (path, title = path) => ({
  target: { kind: "docs", path },
  title,
  class: "core",
  source: "P4",
  decision: { by: "auto", at: "2026-11-01" },
});

/** The course in force and the upcoming course of the fixture guides, with picks that differ in one card. */
function twoVersions() {
  const course = courseOf(V1);
  for (const group of course.domains.flatMap((d) => d.groups))
    group.foundations = [
      {
        ...pagePick(`/f/${group.title.toLowerCase().replace(/ /g, "-")}`),
        class: "foundation",
      },
    ];
  for (const task of course.domains.flatMap((d) =>
    d.groups.flatMap((g) => g.tasks),
  ))
    task.picks = [pagePick(`/p/${task.key.split("/").at(-1)}`)];
  const target = upcoming(edits);
  const { next } = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
  });
  const taskOf = (c, text) =>
    c.domains
      .flatMap((d) => d.groups.flatMap((g) => g.tasks))
      .find((t) => t.text === text);
  // a card only the upcoming course has, and one only the course in force has
  taskOf(next, "Configure Spark workspace settings").picks.push(
    pagePick("/p/new-card", "A new card"),
  );
  taskOf(course, "Configure Spark workspace settings").picks.push(
    pagePick("/p/old-card", "An old card"),
  );
  // the new task has picks from the pipeline
  taskOf(next, "Configure data workflow workspace settings").picks = [
    pagePick("/p/workflow"),
  ];
  return { course, next };
}

test("versionMarks: new and reworded tasks, leaving tasks and the cards only one version has", () => {
  const { course, next } = twoVersions();
  const marks = versionMarks({ current: course, next });
  assert.equal(marks.largely, false);
  const target = upcoming(edits);
  const before = parseGuide(V1);
  const up = (text) => marks.upcoming.task.get(keyOf(target, text));
  const cur = (text) => marks.current.task.get(keyOf(before, text));
  assert.equal(up("Configure data workflow workspace settings"), "new");
  assert.equal(
    up("Prepare data for loading into a dimensional model or a lakehouse"),
    "reworded-upcoming",
  );
  assert.equal(cur("Implement database projects"), "leaves");
  assert.equal(cur("Monitor data transformation"), "reworded-current");
  // a moved task is not marked: its words did not change
  assert.equal(up("Monitor semantic model refresh"), undefined);
  assert.deepEqual(
    [...marks.upcoming.card],
    [
      [
        `${keyOf(upcoming(edits), "Configure Spark workspace settings")}|/p/new-card`,
        "added",
      ],
    ],
  );
  assert.deepEqual(
    [...marks.current.card],
    [
      [
        `${keyOf(parseGuide(V1), "Configure Spark workspace settings")}|/p/old-card`,
        "removed",
      ],
    ],
  );
});

test("versionMarks: a rewrite marks nothing and says so", () => {
  const course = courseOf(V1);
  const target = upcoming(rewriteEdit);
  const { next } = buildNext({
    course,
    guide: target,
    version: VERSION,
    today: "2026-11-16",
    force: true,
  });
  const marks = versionMarks({ current: course, next });
  assert.equal(marks.largely, true);
  assert.equal(
    marks.upcoming.task.size +
      marks.current.task.size +
      marks.upcoming.card.size,
    0,
  );
  assert.match(
    versionLabels({ effective: "2026-12-01", counts: marks.counts }).rewritten,
    /largely rewritten/,
  );
});

test("versionLabels: the words come from the day, with the day before for the course in force", () => {
  const labels = versionLabels({
    effective: "2026-12-01",
    counts: { added: 1, reworded: 2, tasks: 12 },
  });
  assert.equal(labels.current, "Current, until November 30, 2026");
  assert.equal(labels.upcoming, "Upcoming, from December 1, 2026");
  assert.equal(labels.leaves, "Leaves December 1, 2026");
  assert.equal(labels.cardRemoved, "Until November 30, 2026");
  assert.equal(labels.cardAdded, "New from December 1, 2026");
  assert.match(labels.rewritten, /3 of 12 tasks/);
});

test("renderCourseVersions: two slots, plain HTML headings with their own ids, and every mark in words", () => {
  const { course, next } = twoVersions();
  const marks = versionMarks({ current: course, next });
  const page = renderCourseVersions(course, next, {
    marks,
    effective: "2026-12-01",
    labels: versionLabels({ effective: "2026-12-01", counts: marks.counts }),
  });
  assert.match(
    page,
    /^import CourseVersions from '@components\/CourseVersions\.astro';$/m,
  );
  assert.match(
    page,
    /<CourseVersions effective="2026-12-01" currentLabel="Current, until November 30, 2026" upcomingLabel="Upcoming, from December 1, 2026">/,
  );
  for (const slot of ["intro", "current", "upcoming"])
    assert.match(page, new RegExp(`<div slot="${slot}">`));
  // no markdown heading: the page's table of contents would list every version
  assert.doesNotMatch(page, /^#{1,6} /m);
  assert.match(page, /<h2 id="current-[^"]+">/);
  assert.match(page, /<h2 id="upcoming-[^"]+">/);
  // the marks, as text
  assert.match(
    page,
    /<ins class="course-ins">Configure data workflow workspace settings<\/ins> <span class="course-mark course-mark--added">New from December 1, 2026<\/span>/,
  );
  assert.match(
    page,
    /<span class="course-leaves">Implement database projects<\/span> <span class="course-mark course-mark--removed">Leaves December 1, 2026<\/span>/,
  );
  assert.match(
    page,
    /title="A new card"[^>]* change="added" tag="New from December 1, 2026"\/>/,
  );
  assert.match(
    page,
    /title="An old card"[^>]* change="removed" tag="Until November 30, 2026"\/>/,
  );
  // the notes can be switched off on the day
  assert.equal((page.match(/<div class="course-legend">/g) ?? []).length, 2);
});

test("course-file render: a complete upcoming course makes the page with two versions, an incomplete one does not", async () => {
  const { root } = world();
  const out = join(root, "page.mdx");
  const io = capture();
  const render = () =>
    renderMain(["render", "GH-900", "--out", out], {
      log: io.log,
      error: io.error,
      write() {},
      env: {},
      root,
    });
  const page = () => readFileSync(out, "utf8");
  // no upcoming course: the page of the course in force
  assert.equal(await render(), 0);
  assert.doesNotMatch(page(), /CourseVersions/);
  // an upcoming course with things left to build: still that page, and the render says why
  assert.equal(run(root, ["build", "GH-900", "--write"]).code, 0);
  assert.equal(await render(), 0);
  assert.doesNotMatch(page(), /CourseVersions/);
  assert.match(io.out.join(" | "), /upcoming course is not complete/);
  // complete: the page with two versions, from the day the upcoming version names
  writeFileSync(join(root, "built.json"), readFileSync(nextPath(root)));
  assert.equal(
    run(root, ["merge", "GH-900", "--from", join(root, "built.json")]).code,
    0,
  );
  assert.equal(await render(), 0);
  assert.match(page(), /<CourseVersions effective="2026-12-01"/);
  // a broken upcoming course stops the render
  const broken = JSON.parse(readFileSync(nextPath(root), "utf8"));
  delete broken.inputs.guideVersion;
  writeFileSync(nextPath(root), JSON.stringify(broken));
  assert.equal(await render(), 1);
  assert.match(io.err.join(" | "), /upcoming course has errors/);
});
