import assert from "node:assert/strict";
import test from "node:test";
import { buildCourse, routePicks } from "../../scripts/lib/course-build.mjs";
import { validateCourse } from "../../scripts/lib/course-format.mjs";
import { gateJudged } from "../../scripts/lib/course-gates.mjs";
import { guideOf, scopeOf } from "./helpers/example-candidates.mjs";
import { TASKS, exampleJudged } from "./helpers/example-judging.mjs";

const KEYS = ["d/g/t1", "d/g/t2", "d/g/t3"];
const row = (path, over = {}, itemOver = {}) => ({
  pick: {
    target: { kind: "docs", path },
    title: `Page ${path}`,
    class: "core",
    source: "P1",
    ...over,
  },
  item: {
    judge: { confidence: "high" },
    coverage: 0.5,
    ...itemOver,
  },
});
const accepted = (map) => new Map(Object.entries(map));
const pathsAt = (result, key) =>
  (result.accepted.get(key) ?? []).map((r) => r.pick.target.path);
const route = (map) => routePicks({ accepted: accepted(map), taskKeys: KEYS });

test("a page that fits one task stays where it is, and nothing is reported", () => {
  const result = route({
    "d/g/t1": [row("/a"), row("/b")],
    "d/g/t2": [row("/c")],
  });
  assert.deepEqual(pathsAt(result, "d/g/t1").sort(), ["/a", "/b"]);
  assert.deepEqual(pathsAt(result, "d/g/t2"), ["/c"]);
  assert.deepEqual(result.repeats, []);
  assert.deepEqual(result.handsOn, []);
});

test("core beats supporting, a sure judgement beats an unsure one, the exam's own course beats other sources", () => {
  const core = route({
    "d/g/t1": [row("/a", { class: "supporting", relation: "deeper" })],
    "d/g/t2": [row("/a")],
  });
  assert.deepEqual(pathsAt(core, "d/g/t2"), ["/a"]);
  assert.deepEqual(pathsAt(core, "d/g/t1"), []);
  const sure = route({
    "d/g/t1": [row("/a", {}, { judge: { confidence: "low" } })],
    "d/g/t2": [row("/a")],
  });
  assert.deepEqual(pathsAt(sure, "d/g/t2"), ["/a"]);
  const source = route({
    "d/g/t1": [row("/a", { source: "P4" })],
    "d/g/t2": [row("/a", { source: "P1" })],
  });
  assert.deepEqual(pathsAt(source, "d/g/t2"), ["/a"]);
});

test("a tie goes to the task with the fewest picks, then to the better quote, then to the earlier task", () => {
  const load = route({
    "d/g/t1": [row("/a"), row("/x"), row("/y")],
    "d/g/t2": [row("/a"), row("/z")],
    "d/g/t3": [row("/a")],
  });
  assert.deepEqual(pathsAt(load, "d/g/t3"), ["/a"], "the emptiest task");
  const quote = route({
    "d/g/t1": [
      row("/a", {}, { judge: { confidence: "high", quoteTermCoverage: 0.4 } }),
    ],
    "d/g/t2": [
      row("/a", {}, { judge: { confidence: "high", quoteTermCoverage: 0.9 } }),
    ],
  });
  assert.deepEqual(pathsAt(quote, "d/g/t2"), ["/a"]);
  const earlier = route({ "d/g/t2": [row("/a")], "d/g/t1": [row("/a")] });
  assert.deepEqual(pathsAt(earlier, "d/g/t1"), ["/a"]);
});

test("every repeat is reported with the task it stays under and the tasks it also fits, in the guide's order", () => {
  const result = route({
    "d/g/t3": [row("/a")],
    "d/g/t1": [row("/a")],
    "d/g/t2": [row("/a")],
  });
  assert.equal(result.repeats.length, 1);
  const [repeat] = result.repeats;
  assert.equal(repeat.path, "/a");
  assert.equal(
    [repeat.shownUnder, ...repeat.alsoFits].sort().join(","),
    "d/g/t1,d/g/t2,d/g/t3",
  );
  const order = repeat.alsoFits.map((k) => KEYS.indexOf(k));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.equal(
    KEYS.map((k) => pathsAt(result, k).length).reduce((a, b) => a + b, 0),
    1,
  );
});

test("hands-on pages leave the picks and are listed once with all their tasks and the module they are in", () => {
  const exercise = () =>
    row(
      "/training/modules/m/3-exercise-x",
      {
        target: { kind: "unit", path: "/training/modules/m/3-exercise-x" },
        title: "Exercise - X",
      },
      { module: { path: "/training/modules/m", title: "Module M" } },
    );
  const result = route({
    "d/g/t2": [exercise(), row("/b")],
    "d/g/t1": [exercise()],
  });
  assert.deepEqual(pathsAt(result, "d/g/t1"), []);
  assert.deepEqual(pathsAt(result, "d/g/t2"), ["/b"]);
  assert.deepEqual(result.handsOn, [
    {
      path: "/training/modules/m/3-exercise-x",
      kind: "unit",
      title: "Exercise - X",
      reason: "exercise",
      module: "/training/modules/m",
      moduleTitle: "Module M",
      tasks: ["d/g/t1", "d/g/t2"],
    },
  ]);
  assert.deepEqual(result.repeats, [], "a hands-on page is not a repeat");
});

test("the result is the same whatever order the rows come in", () => {
  const a = route({
    "d/g/t1": [row("/a"), row("/b")],
    "d/g/t2": [row("/b"), row("/a")],
  });
  const b = route({
    "d/g/t2": [row("/a"), row("/b")],
    "d/g/t1": [row("/b"), row("/a")],
  });
  const view = (r) => KEYS.map((k) => pathsAt(r, k).sort());
  assert.deepEqual(view(a), view(b));
});

// through the builder, on the invented exam of the other course tests
const TODAY = "2026-10-17";
const guide = () => ({ ...guideOf(TASKS), ok: true });
function gatedFile(change, options) {
  const judged = exampleJudged(options);
  const { items } = gateJudged([judged], { decisions: null, today: TODAY });
  return {
    schemaVersion: 1,
    kind: "gated",
    code: "NET-100",
    builtAt: TODAY,
    inputs: judged.inputs,
    items: change(items),
  };
}
const build = (change, options) =>
  buildCourse({
    code: "NET-100",
    name: "Network Administrator",
    guide: guide(),
    scope: scopeOf(),
    gated: gatedFile(change, options),
    today: TODAY,
  });
const picksOf = (course) =>
  course.domains.flatMap((d) =>
    d.groups.flatMap((g) =>
      g.tasks.flatMap((t) => t.picks.map((p) => ({ task: t.key, pick: p }))),
    ),
  );
const acceptedOf = (items) => items.filter((i) => i.gate.decision === "accept");

test("the builder leaves a hands-on page out of the course and lists it in the routing", () => {
  let target;
  let taskKeysOf;
  const result = build(
    (items) => {
      target = acceptedOf(items).find((i) => i.target.kind === "unit");
      taskKeysOf = acceptedOf(items)
        .filter((i) => i.target.path === target.target.path)
        .map((i) => i.task.key);
      for (const i of items)
        if (i.target.path === target.target.path)
          i.title = "Exercise - Create a custom route";
      return items;
    },
    { units: "all" },
  );
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(
    !picksOf(result.course).some(
      (p) => p.pick.target.path === target.target.path,
    ),
  );
  assert.deepEqual(
    result.routing.handsOn.map((e) => [e.path, e.kind, e.reason, e.title]),
    [
      [
        target.target.path,
        "unit",
        "exercise",
        "Exercise - Create a custom route",
      ],
    ],
  );
  assert.deepEqual(
    result.routing.handsOn[0].tasks,
    taskKeysOf.filter((k) => k !== undefined),
    "every task it was accepted for",
  );
  assert.deepEqual(
    validateCourse(result.course, { guide: guide() }).errors,
    [],
  );
});

test("the builder shows a page once, under the task where it fits best, and the routing says where else it fits", () => {
  let original;
  let copy;
  const result = build((items) => {
    original = acceptedOf(items).find((i) => i.gate.class === "core");
    const other = items.find((i) => i.task.key !== original.task.key);
    copy = structuredClone(original);
    copy.task = other.task;
    copy.gate = {
      ...copy.gate,
      class: "supporting",
      relation: "prerequisite",
    };
    return [...items, copy];
  });
  assert.equal(result.ok, true, result.problems.join("\n"));
  const holders = picksOf(result.course).filter(
    (p) => p.pick.target.path === original.target.path,
  );
  assert.equal(holders.length, 1, "once in the whole course");
  assert.equal(holders[0].task, original.task.key, "the core fit keeps it");
  assert.deepEqual(
    result.routing.repeats.find((r) => r.path === original.target.path),
    {
      path: original.target.path,
      title: holders[0].pick.title,
      shownUnder: original.task.key,
      alsoFits: [copy.task.key],
    },
  );
});

// ---- a module is placed once, as a module, in the first skill group where it was accepted (docs/courses.md)
const GROUP_KEYS = ["d/g1/t1", "d/g1/t2", "d/g2/t1", "d/g2/t2"];
const routeGroups = (map) =>
  routePicks({ accepted: accepted(map), taskKeys: GROUP_KEYS });
const moduleRow = (path, over = {}, itemOver = {}) =>
  row(
    path,
    { target: { kind: "module", path }, title: `Module ${path}`, ...over },
    itemOver,
  );
const unitRow = (path, over = {}, itemOver = {}) =>
  row(
    path,
    { target: { kind: "unit", path }, title: `Unit ${path}`, ...over },
    {
      module: {
        path: path.split("/").slice(0, 4).join("/"),
        title: "The module",
      },
      ...itemOver,
    },
  );

test("a module stays in the first skill group where it was accepted, even when it fits a later group better", () => {
  const result = routeGroups({
    "d/g1/t2": [
      moduleRow("/training/modules/m", {
        class: "supporting",
        relation: "deeper",
      }),
    ],
    "d/g2/t1": [moduleRow("/training/modules/m")],
  });
  assert.deepEqual(pathsAt(result, "d/g1/t2"), ["/training/modules/m"]);
  assert.deepEqual(pathsAt(result, "d/g2/t1"), []);
  assert.deepEqual(result.repeats, [
    {
      path: "/training/modules/m",
      title: "Module /training/modules/m",
      shownUnder: "d/g1/t2",
      alsoFits: ["d/g2/t1"],
    },
  ]);
});

test("inside that first group the page rules still choose the task: core before supporting", () => {
  const result = routeGroups({
    "d/g1/t1": [
      moduleRow("/training/modules/m", {
        class: "supporting",
        relation: "deeper",
      }),
    ],
    "d/g1/t2": [moduleRow("/training/modules/m")],
    "d/g2/t1": [moduleRow("/training/modules/m")],
  });
  assert.deepEqual(pathsAt(result, "d/g1/t2"), ["/training/modules/m"]);
  assert.deepEqual(pathsAt(result, "d/g1/t1"), []);
  assert.deepEqual(result.repeats[0].alsoFits, ["d/g1/t1", "d/g2/t1"]);
});

test("the fundamentals of a group count as that group: a module in the fundamentals of group 1 is not repeated in group 2", () => {
  const result = routePicks({
    accepted: accepted({
      "d/g1/@foundations": [
        moduleRow("/training/modules/m", {
          class: "foundation",
          why: "Theory.",
        }),
      ],
      "d/g2/t1": [moduleRow("/training/modules/m")],
    }),
    taskKeys: ["d/g1/@foundations", "d/g1/t1", "d/g2/t1"],
  });
  assert.deepEqual(pathsAt(result, "d/g1/@foundations"), [
    "/training/modules/m",
  ]);
  assert.deepEqual(pathsAt(result, "d/g2/t1"), []);
});

test("a documentation page is not subject to the first-group rule: it stays where it fits best", () => {
  const result = routeGroups({
    "d/g1/t1": [row("/azure/x", { class: "supporting", relation: "deeper" })],
    "d/g2/t1": [row("/azure/x")],
  });
  assert.deepEqual(pathsAt(result, "d/g2/t1"), ["/azure/x"]);
  assert.deepEqual(pathsAt(result, "d/g1/t1"), []);
});

test("an accepted unit that is not hands-on becomes its module, and the routing says so", () => {
  const result = routeGroups({
    "d/g1/t1": [unitRow("/training/modules/m/3-unit")],
    "d/g1/t2": [unitRow("/training/modules/m/4-unit")],
  });
  assert.deepEqual(pathsAt(result, "d/g1/t1"), ["/training/modules/m"]);
  assert.deepEqual(pathsAt(result, "d/g1/t2"), []);
  const pick = result.accepted.get("d/g1/t1")[0].pick;
  assert.deepEqual(pick.target, {
    kind: "module",
    path: "/training/modules/m",
  });
  assert.equal(pick.title, "The module", "the module's title, not the unit's");
  assert.deepEqual(result.collapsed, [
    {
      path: "/training/modules/m/3-unit",
      module: "/training/modules/m",
      title: "Unit /training/modules/m/3-unit",
      moduleTitle: "The module",
      tasks: ["d/g1/t1"],
    },
    {
      path: "/training/modules/m/4-unit",
      module: "/training/modules/m",
      title: "Unit /training/modules/m/4-unit",
      moduleTitle: "The module",
      tasks: ["d/g1/t2"],
    },
  ]);
});

test("several units of one module accepted for the same task are one pick, and the module's own row wins over a unit's", () => {
  const result = routeGroups({
    "d/g1/t1": [
      unitRow("/training/modules/m/2-unit", {
        class: "supporting",
        relation: "deeper",
      }),
      unitRow("/training/modules/m/3-unit"),
      moduleRow("/training/modules/m", {
        class: "supporting",
        relation: "prerequisite",
      }),
    ],
  });
  const picks = result.accepted.get("d/g1/t1");
  assert.equal(picks.length, 1);
  assert.equal(
    picks[0].pick.class,
    "supporting",
    "the module's own row is the pick",
  );
  assert.equal(picks[0].pick.relation, "prerequisite");
});

test("a unit whose module the maintainer rejected for that task is not collapsed: the module must not come back", () => {
  const result = routePicks({
    accepted: accepted({
      "d/g1/t1": [unitRow("/training/modules/m/3-unit")],
      "d/g1/t2": [unitRow("/training/modules/m/3-unit")],
    }),
    taskKeys: GROUP_KEYS,
    rejected: new Map([["d/g1/t1|/training/modules/m", { reason: "no" }]]),
  });
  assert.deepEqual(pathsAt(result, "d/g1/t1"), []);
  assert.deepEqual(pathsAt(result, "d/g1/t2"), ["/training/modules/m"]);
  assert.deepEqual(result.blocked, [
    {
      path: "/training/modules/m/3-unit",
      module: "/training/modules/m",
      title: "Unit /training/modules/m/3-unit",
      tasks: ["d/g1/t1"],
    },
  ]);
  assert.deepEqual(result.collapsed[0].tasks, ["d/g1/t2"]);
});

test("a hands-on unit is not collapsed: it stays out of the course and on the lab page", () => {
  const result = routeGroups({
    "d/g1/t1": [
      unitRow("/training/modules/m/3-exercise-x", { title: "Exercise - X" }),
    ],
  });
  assert.deepEqual(pathsAt(result, "d/g1/t1"), []);
  assert.equal(result.handsOn.length, 1);
  assert.deepEqual(result.collapsed, []);
});

test("through the builder: an older gated file with unit picks gives a valid course with modules only, and says what it collapsed", () => {
  const result = build((items) => items, { units: "all" });
  assert.equal(result.ok, true, result.problems.join("\n"));
  const kinds = new Set(picksOf(result.course).map((p) => p.pick.target.kind));
  assert.ok(!kinds.has("unit"), "a course has no unit pick");
  assert.ok(result.routing.collapsed.length > 0);
  for (const c of result.routing.collapsed) {
    assert.match(c.module, /^\/training\/modules\/[^/]+$/);
    assert.ok(
      picksOf(result.course).some((p) => p.pick.target.path === c.module),
      `${c.module} is in the course`,
    );
  }
  // no module twice
  const paths = picksOf(result.course).map((p) => p.pick.target.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(
    validateCourse(result.course, { guide: guide() }).errors,
    [],
  );
  // with the generator's default there is nothing to collapse
  const clean = build((items) => items);
  assert.deepEqual(clean.routing.collapsed, []);
});

test("a collapsed unit whose module has no title in the gated file is built with the unit's title, with a warning", () => {
  const result = build(
    (items) => {
      for (const i of items) if (i.module) delete i.module.title;
      return items;
    },
    { units: "all" },
  );
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(result.warnings.some((w) => /has no title for the module/.test(w)));
});
