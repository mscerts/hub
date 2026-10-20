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
    skeptic: { stance: "uphold" },
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
  const downgraded = route({
    "d/g/t1": [row("/a", {}, { skeptic: { stance: "downgrade" } })],
    "d/g/t2": [row("/a")],
  });
  assert.deepEqual(pathsAt(downgraded, "d/g/t2"), ["/a"]);
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
function gatedFile(change) {
  const judged = exampleJudged();
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
const build = (change) =>
  buildCourse({
    code: "NET-100",
    name: "Network Administrator",
    guide: guide(),
    scope: scopeOf(),
    gated: gatedFile(change),
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
  const result = build((items) => {
    target = acceptedOf(items).find((i) => i.target.kind === "unit");
    taskKeysOf = acceptedOf(items)
      .filter((i) => i.target.path === target.target.path)
      .map((i) => i.task.key);
    for (const i of items)
      if (i.target.path === target.target.path)
        i.title = "Exercise - Create a custom route";
    return items;
  });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(
    !picksOf(result.course).some((p) => p.pick.target.path === target.target.path),
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
  assert.deepEqual(validateCourse(result.course, { guide: guide() }).errors, []);
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
