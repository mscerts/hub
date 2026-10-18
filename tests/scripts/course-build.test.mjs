import assert from "node:assert/strict";
import test from "node:test";
import { buildCourse } from "../../scripts/lib/course-build.mjs";
import { validateCourse } from "../../scripts/lib/course-format.mjs";
import { emptyDecisions, gateJudged } from "../../scripts/lib/course-gates.mjs";
import { renderCourse } from "../../scripts/lib/course-render.mjs";
import { rebuildPlan } from "../../scripts/lib/course-status.mjs";
import {
  guideOf,
  scopeOf,
  candidateWorld,
} from "./helpers/example-candidates.mjs";
import { TASKS, exampleJudged } from "./helpers/example-judging.mjs";

const TODAY = "2026-10-17";
const NAME = "Network Administrator";

const guide = () => ({ ...guideOf(TASKS), ok: true });

/** The gated file the gates would write for the invented exam, with the maintainer's decisions applied. */
function gatedFile({
  decisions = null,
  edit = () => {},
  change = (items) => items,
} = {}) {
  const judged = exampleJudged();
  edit(judged);
  const { items } = gateJudged([judged], { decisions, today: TODAY });
  return {
    schemaVersion: 1,
    kind: "gated",
    code: "NET-100",
    builtAt: TODAY,
    inputs: judged.inputs,
    items: change(items),
  };
}

const build = (over = {}) =>
  buildCourse({
    code: "NET-100",
    name: NAME,
    guide: guide(),
    scope: scopeOf(),
    gated: gatedFile(),
    today: TODAY,
    ...over,
  });

const picksOf = (course) =>
  course.domains.flatMap((d) =>
    d.groups.flatMap((g) =>
      g.tasks.flatMap((t) => t.picks.map((p) => ({ task: t.key, pick: p }))),
    ),
  );
const find = (course, source, kind) =>
  picksOf(course).find(
    ({ pick }) =>
      pick.source === source && (!kind || pick.target.kind === kind),
  )?.pick;

/** A decisions file with `decisions` for the invented exam. */
const store = (decisions, excludedFamilies = []) => ({
  ...emptyDecisions("NET-100"),
  decisions,
  excludedFamilies,
});
const decided = (task, target, over) => ({
  task,
  target,
  decision: "accept",
  class: "supporting",
  relation: "same-workflow",
  reason: "Worth knowing.",
  by: "maintainer",
  at: "2026-10-16",
  ...over,
});

test("the accepted picks become a course file that passes the validator, with the guide's tree", () => {
  const result = build();
  assert.equal(result.ok, true, result.problems.join("\n"));
  const { course } = result;
  assert.equal(course.schemaVersion, 1);
  assert.equal(course.code, "NET-100");
  assert.equal(course.name, NAME);
  assert.deepEqual(
    course.domains.flatMap((d) =>
      d.groups.flatMap((g) => g.tasks.map((t) => t.text)),
    ),
    TASKS,
  );
  assert.deepEqual(validateCourse(course, { guide: guide() }).errors, []);
  assert.ok(result.stats.picks > 0);
  assert.equal(result.stats.picks, picksOf(course).length);
  assert.deepEqual(JSON.parse(JSON.stringify(course)), course, "plain data");
});

test("what was inputs to the candidates is what the course records: guide hash, scope snapshot and fingerprint", () => {
  const scope = scopeOf();
  const { course } = build({ scope });
  assert.equal(course.inputs.guideHash, "guide-hash");
  assert.equal(course.inputs.scopeFingerprint, scope.inputs.fingerprint);
  assert.deepEqual(course.inputs.scope, scope.inputs.snapshot);
  assert.notEqual(course.inputs.scope, scope.inputs.snapshot, "a copy");
  assert.equal(course.inputs.builtAt, TODAY);
  assert.equal(
    course.inputs.guideAsOf,
    undefined,
    "the invented guide has no date",
  );
  const dated = build({
    guide: { ...guide(), asOf: { text: "April 17, 2026" } },
  });
  assert.equal(dated.course.inputs.guideAsOf, "April 17, 2026");
});

test("a pick keeps the class, relation and decider the gates gave it, with its reason and evidence where the format wants them", () => {
  const { course } = build();
  const core = find(course, "P1", "unit");
  assert.equal(core.class, "core");
  assert.deepEqual(core.decision, { by: "auto", at: TODAY });
  assert.equal(core.relation, undefined);
  assert.equal(
    core.why,
    undefined,
    "a core pick of the exam's own course needs neither",
  );
  assert.equal(core.evidence, undefined);
  const p2 = find(course, "P2");
  assert.equal(p2.via, "/training/modules/manage-traffic-routes");
  assert.equal(p2.target.kind, "docs");
  const p3 = find(course, "P3", "module");
  assert.equal(p3.class, "supporting");
  assert.equal(p3.relation, "prerequisite");
  assert.equal(p3.why, "Covers the task as the guide words it.");
  assert.ok(
    p3.evidence,
    "supporting and P3/P4 picks carry the judge's verified quote",
  );
  assert.deepEqual(p3.decision, { by: "auto", at: TODAY });
});

test("picks are ordered core before supporting, then by source, kind and how well they matched", () => {
  const { course } = build();
  for (const task of course.domains.flatMap((d) =>
    d.groups.flatMap((g) => g.tasks),
  )) {
    const rank = (p) =>
      (p.class === "core" ? 0 : 1) * 1000 +
      { P1: 0, P2: 1, P3: 2, P4: 3 }[p.source] * 100 +
      { module: 0, unit: 1, docs: 2 }[p.target.kind];
    const ranks = task.picks.map(rank);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
      task.key,
    );
  }
});

test("a module outside the exam's own course that a pick depends on is recorded with its signature", () => {
  const { course } = build();
  assert.deepEqual(course.inputs.picked, [
    ["/training/modules/route-between-networks", "sig-route-between-networks"],
  ]);
  // a P4 module and its unit the maintainer accepted: the module is recorded once
  const gated = gatedFile();
  const p4module = gated.items.find(
    (i) => i.source === "P4" && i.target.kind === "module",
  );
  const decisions = store([
    decided(p4module.task.key, p4module.target.path, {
      class: "core",
      relation: undefined,
    }),
  ]);
  delete decisions.decisions[0].relation;
  const accepted = build({ gated: gatedFile({ decisions }) });
  assert.equal(accepted.ok, true, accepted.problems.join("\n"));
  assert.deepEqual(
    accepted.course.inputs.picked.map(([path]) => path),
    [p4module.target.path, "/training/modules/route-between-networks"].sort(),
  );
  const pick = picksOf(accepted.course).find(
    ({ pick }) => pick.target.path === p4module.target.path,
  ).pick;
  assert.deepEqual(
    pick.decision,
    { by: "maintainer", at: "2026-10-16" },
    "the maintainer's day",
  );
  assert.ok(pick.evidence);
});

test("a rejection worth remembering goes into the rejected list, and an ordinary one does not", () => {
  // the judge rejects three candidates of the first task: one as out of scope, one as generic, one the maintainer
  // had already rejected themselves
  const reject = (item, flags) => {
    item.judge = {
      verdict: "reject",
      why: flags.length
        ? "Identity governance, not part of this job."
        : "A generic overview.",
      flags,
      confidence: "high",
    };
    item.flags = flags;
    item.agreement = "unchallenged";
    delete item.skeptic;
  };
  let marked;
  const edit = (judged) => {
    const items = judged.tasks[0].items;
    reject(items[0], ["other-sub-product"]);
    reject(items[1], []);
    marked = [items[0], items[1], items[2]].map((i) => ({
      task: judged.tasks[0].key,
      path: i.target.path,
    }));
  };
  const first = build({ gated: gatedFile({ edit }) });
  assert.equal(first.ok, true, first.problems.join("\n"));
  assert.deepEqual(first.course.rejected, [
    {
      taskKey: marked[0].task,
      path: marked[0].path,
      reason: "Identity governance, not part of this job.",
      at: TODAY,
    },
  ]);
  // a rejection the maintainer made earlier is remembered with their reason and day
  const decisions = store([
    {
      task: marked[2].task,
      target: marked[2].path,
      decision: "reject",
      reason: "Another job.",
      by: "maintainer",
      at: "2026-10-16",
    },
  ]);
  const remembered = build({ gated: gatedFile({ edit, decisions }) });
  assert.ok(remembered.ok, remembered.problems.join("\n"));
  assert.deepEqual(
    remembered.course.rejected.map((r) => [r.path, r.reason, r.at]),
    [
      [marked[0].path, "Identity governance, not part of this job.", TODAY],
      [marked[2].path, "Another job.", "2026-10-16"],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
});

test("what is still in the queue is not in the course, and the builder says so", () => {
  const result = build();
  const queued = gatedFile().items.filter((i) => i.gate.decision === "queue");
  assert.ok(queued.length > 0);
  for (const q of queued) {
    assert.ok(
      result.warnings.some(
        (w) => w.includes(q.target.path) && /still in the queue/.test(w),
      ),
      q.target.path,
    );
    assert.ok(
      !picksOf(result.course).some(
        ({ task, pick }) =>
          task === q.task.key && pick.target.path === q.target.path,
      ),
    );
  }
});

test("a course built on a newer guide or a newer Learn than the candidates were made from is refused, unless allowed", () => {
  const guideChanged = build({ guide: { ...guide(), hash: "another-guide" } });
  assert.equal(guideChanged.ok, false);
  assert.match(
    guideChanged.problems.join("\n"),
    /the study guide changed since the candidates were made.*run the candidates, judging and gates again, or build with --allow-stale/,
  );
  const world = candidateWorld();
  world.moduleLinks.modules[0].links.pop();
  const learnChanged = build({ scope: scopeOf(world) });
  assert.equal(learnChanged.ok, false);
  assert.match(
    learnChanged.problems.join("\n"),
    /Learn's modules for the exam changed since the candidates were made/,
  );
  const allowed = build({
    guide: { ...guide(), hash: "another-guide" },
    scope: scopeOf(world),
    allowStale: true,
  });
  assert.equal(allowed.ok, true, allowed.problems.join("\n"));
  assert.equal(
    allowed.warnings.filter((w) => /built anyway/.test(w)).length,
    2,
  );
  assert.equal(
    allowed.course.inputs.guideHash,
    "another-guide",
    "the current state is what is recorded",
  );
});

test("what cannot be built stops the build with the reasons and returns no course", () => {
  const bad = (opts) => {
    const r = build(opts);
    assert.equal(r.ok, false);
    assert.equal(r.course, null);
    return r.problems.join("\n");
  };
  assert.match(
    bad({ code: "XX-999" }),
    /the gated file is for NET-100, not XX-999/,
  );
  assert.match(
    bad({ guide: { ...guide(), ok: false } }),
    /the study guide does not parse completely/,
  );
  assert.match(
    bad({ scope: { ...scopeOf(), ok: false } }),
    /has no official course in Learn's catalog/,
  );
  const gated = gatedFile();
  assert.match(
    bad({
      gated: {
        ...gated,
        items: gated.items.map((i, n) =>
          n === 0 ? { ...i, task: { ...i.task, key: "other/task/key" } } : i,
        ),
      },
    }),
    /other\/task\/key is not a task of the study guide/,
  );
  // the maintainer accepted a candidate the judge had rejected: it has no quote, so no evidence
  const first = exampleJudged().tasks[0];
  const target = { task: first.key, path: first.items[0].target.path };
  const withDecision = gatedFile({
    edit: (judged) => {
      const item = judged.tasks[0].items[0];
      item.judge = {
        verdict: "reject",
        why: "Generic.",
        flags: [],
        confidence: "high",
      };
      item.agreement = "unchallenged";
      delete item.skeptic;
    },
    decisions: store([decided(target.task, target.path)]),
  });
  assert.match(
    bad({ gated: withDecision }),
    /accepted as supporting but the judge gave no quote, so it has no evidence/,
  );
  const noSig = gatedFile({
    change: (items) =>
      items.map((i) =>
        i.source === "P3" && i.target.kind === "module"
          ? { ...i, unitSig: undefined }
          : i,
      ),
  });
  assert.match(bad({ gated: noSig }), /its signature is not in the gated file/);
  const noQuoteP3 = gatedFile({
    change: (items) =>
      items.map((i) =>
        i.source === "P3" && i.gate.decision === "accept"
          ? { ...i, judge: { ...i.judge, quote: undefined } }
          : i,
      ),
  });
  assert.match(bad({ gated: noQuoteP3 }), /the judge gave no quote/);
});

test("the built course renders, and the rebuild check finds nothing to do the moment it is built", () => {
  const { course } = build();
  const page = renderCourse(course);
  assert.match(page, /Configure user-defined routes/);
  const plan = rebuildPlan({
    course,
    guide: guide(),
    scopeMap: scopeOf(),
    catalog: candidateWorld().catalog.modules,
  });
  assert.equal(plan.status, "current", JSON.stringify(plan.reasons));
  assert.deepEqual(plan.picks, { hard: [], soft: [] });
});
