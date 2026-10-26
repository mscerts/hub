import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_DEFAULTS,
  ageInDays,
  answersFromReview,
  applyAnswers,
  buildQueue,
  emptyDecisions,
  gateItem,
  gateJudged,
  gateStats,
  indexDecisions,
  learnUrl,
  parseNumbers,
  validateDecisions,
} from "../../scripts/lib/course-gates.mjs";
import { exampleJudged } from "./helpers/example-judging.mjs";

const TASK = {
  key: "domain/group/manage-external-users",
  text: "Manage external users",
  group: "Manage users",
};
const TODAY = "2026-10-17";
// the review-sheet mode of 2026-10-21: the picks the judge is unsure of wait in the queue (the default marks them for the course page)
const SHEET = { queueUnsure: true };

/** An entry of a judged file, as course-judge.mjs merge writes it, with `over` merged into it. */
function judgedItem(over = {}) {
  const { judge, ...rest } = over;
  const item = {
    target: { kind: "docs", path: "/azure/storage/blobs/x" },
    title: "A page",
    source: "P1",
    signals: {},
    judge: {
      verdict: "core",
      why: "Covers the task.",
      quote: "words from the page",
      quoteVerified: true,
      quoteTermCoverage: 1,
      flags: [],
      confidence: "high",
      ...judge,
    },
    flags: [],
    ...rest,
  };
  return item;
}
const gate = (over, ctx = {}) =>
  gateItem(TASK, judgedItem(over), { today: TODAY, ...ctx });
const withStore = (decisions = [], excludedFamilies = []) =>
  indexDecisions({ ...emptyDecisions("X"), decisions, excludedFamilies });

test("a clean pick of the exam's own course is accepted by the gates: the judge picked it", () => {
  for (const source of ["P1", "P2"]) {
    const g = gate({ source });
    assert.equal(g.decision, "accept", source);
    assert.equal(g.class, "core");
    assert.equal(g.by, "gates");
    assert.match(g.reasons[0], new RegExp(`${source}, the judge picked it`));
  }
  const supporting = gate({
    source: "P3",
    judge: {
      verdict: "supporting",
      relation: "prerequisite",
      quoteTermCoverage: 0.1,
    },
  });
  assert.equal(supporting.decision, "accept");
  assert.equal(supporting.class, "supporting");
  assert.equal(supporting.relation, "prerequisite");
  assert.match(supporting.reasons[0], /same sub-product/);
  assert.equal(
    gate({
      source: "P1",
      judge: {
        verdict: "supporting",
        relation: "operate",
        quoteTermCoverage: 0,
      },
    }).decision,
    "accept",
    "a supporting pick is not held to the task's words",
  );
});

test("a pick of any source or class is accepted: search only, a model, core of another course, a deeper dive", () => {
  for (const source of ["P3", "P4", "P5"]) {
    const g = gate({ source });
    assert.equal(g.decision, "accept", source);
    assert.equal(g.class, "core");
    assert.equal(g.by, "gates");
    assert.match(g.reasons[0], new RegExp(`^${source}, the judge picked it`));
  }
  const deeper = gate({
    source: "P2",
    judge: { verdict: "supporting", relation: "deeper" },
  });
  assert.equal(deeper.decision, "accept");
  assert.equal(deeper.relation, "deeper");
});

test("a pick the judge is unsure of is accepted and marked for review; in sheet mode it waits for the maintainer", () => {
  for (const source of ["P1", "P4", "P5"]) {
    const g = gate({ source, judge: { confidence: "low" } });
    assert.equal(g.decision, "accept", source);
    assert.equal(g.class, "core");
    assert.equal(g.by, "gates");
    assert.deepEqual(g.review, ["the judge is not sure (low confidence)"]);
    assert.equal(g.warnings, undefined, "not a warning: a mark");
  }
  assert.equal(gate({ judge: { confidence: "medium" } }).review, undefined);
  assert.equal(gate({ judge: { confidence: "high" } }).review, undefined);
  // the review sheets of 2026-10-21: the same pick waits, with the judge's class as the proposal
  const sheet = gate({ judge: { confidence: "low" } }, { options: SHEET });
  assert.equal(sheet.decision, "queue");
  assert.equal(sheet.class, "core", "the proposal is the judge's");
  assert.deepEqual(sheet.reasons, ["the judge is not sure (low confidence)"]);
  assert.equal(GATE_DEFAULTS.queueUnsure, false);
});

test("the stats count the accepted picks that carry a warning, by kind of warning", () => {
  const items = [
    gate({ flags: ["outdated"] }),
    gate({ judge: { quoteTermCoverage: 0.1 } }),
    gate({ judge: { quoteTermCoverage: 0.2 } }),
    gate({ signals: { foreignFamily: true } }),
    gate({}),
    gate({ judge: { confidence: "low" } }),
    gate({ flags: ["other-role"] }),
    gate({ judge: { quoteVerified: false } }),
  ].map((g) => ({ gate: g, judge: { verdict: "core" } }));
  const stats = gateStats(items);
  assert.equal(stats.accepted, 7);
  assert.equal(stats.acceptedWithWarnings, 4);
  assert.equal(stats.acceptedForReview, 2, "the unsure and the flagged pick");
  assert.deepEqual(stats.acceptedWarnings, {
    "the quote carries N of the task's words": 2,
    flagged: 1,
    "another sub-product than the task's anchor": 1,
  });
  assert.equal(stats.queued, 1);
  assert.deepEqual(stats.queueReasons, {
    "the quote is not in the evidence": 1,
  });
});

test("a pick flagged as another role, another sub-product or another licensing tier is accepted and marked for review", () => {
  for (const flag of ["other-role", "other-sub-product", "licensing-tier"]) {
    const g = gate({ flags: [flag] });
    assert.equal(g.decision, "accept", flag);
    assert.equal(g.class, "core");
    assert.deepEqual(g.review, [`flagged: ${flag}`]);
    const sheet = gate({ flags: [flag] }, { options: SHEET });
    assert.equal(sheet.decision, "queue", flag);
    assert.deepEqual(sheet.reasons, [`flagged: ${flag}`]);
  }
  // the class is the judge's: a supporting pick keeps its relation
  const supporting = gate({
    judge: { verdict: "supporting", relation: "operate" },
    flags: ["other-role"],
  });
  assert.equal(supporting.class, "supporting");
  assert.equal(supporting.relation, "operate");
  // the other flags are warnings, not marks: the page is accepted and the doubt is kept
  const level = gate({ flags: ["level-mismatch", "preview"] });
  assert.equal(level.decision, "accept");
  assert.equal(level.review, undefined);
  assert.deepEqual(level.warnings, ["flagged: level-mismatch, preview"]);
  // both kinds at once: the scope flag is the mark, the other flag a warning
  const both = gate({ flags: ["other-role", "preview"] });
  assert.equal(both.decision, "accept");
  assert.deepEqual(both.review, ["flagged: other-role"]);
  assert.deepEqual(both.warnings, ["flagged: preview"]);
  // with warnings queueing again, the level flag waits
  const strict = gate(
    { flags: ["level-mismatch"] },
    { options: { acceptWithWarnings: false } },
  );
  assert.equal(strict.decision, "queue");
});

test("a pick whose quote is not in the evidence is queued; a level or preview flag or a quote that says little of the task is a warning", () => {
  const reasons = (over) => gate(over).reasons.join(" | ");
  assert.equal(gate({ judge: { confidence: "medium" } }).decision, "accept");
  assert.match(
    reasons({ judge: { quoteVerified: false } }),
    /the quote is not in the evidence/,
  );
  // a warning is accepted with, and kept in the decision
  const flagged = gate({ flags: ["preview", "level-mismatch"] });
  assert.equal(flagged.decision, "accept");
  assert.deepEqual(flagged.warnings, ["flagged: preview, level-mismatch"]);
  const weak = gate({ judge: { quoteTermCoverage: 0.25 } });
  assert.equal(weak.decision, "accept");
  assert.deepEqual(weak.warnings, [
    "the quote carries 25% of the task's words",
  ]);
  assert.equal(
    gate({ judge: { quoteTermCoverage: 0.5 } }).warnings,
    undefined,
    "half is enough",
  );
  assert.equal(
    gate(
      { judge: { quoteTermCoverage: 0.25 } },
      { options: { coreQuoteCoverage: 0.2 } },
    ).warnings,
    undefined,
    "an option",
  );
  assert.equal(GATE_DEFAULTS.coreQuoteCoverage, 0.5);
  // with acceptWithWarnings off they queue again, as before 2026-10-20
  const strict = { options: { acceptWithWarnings: false } };
  assert.match(
    gate({ flags: ["preview", "level-mismatch"] }, strict).reasons.join(),
    /flagged: preview, level-mismatch/,
  );
  assert.match(
    gate({ judge: { quoteTermCoverage: 0.25 } }, strict).reasons.join(),
    /the quote carries 25% of the task's words/,
  );
  assert.equal(GATE_DEFAULTS.acceptWithWarnings, true);
  // a queued pick lists the warnings among its reasons, for the maintainer
  const queued = gate({
    flags: ["preview"],
    judge: { confidence: "low", quoteVerified: false },
  });
  assert.deepEqual(queued.reasons, [
    "the quote is not in the evidence",
    "flagged: preview",
  ]);
  // in sheet mode the doubt is listed first among the reasons, for the maintainer
  const sheet = gate(
    { flags: ["preview"], judge: { confidence: "low" } },
    { options: SHEET },
  );
  assert.deepEqual(sheet.reasons, [
    "the judge is not sure (low confidence)",
    "flagged: preview",
  ]);
});

test("classic material is rejected by the gates and nobody is asked, whatever the judge said", () => {
  const classic = gate({
    title: "Create a classic file share",
    target: { kind: "docs", path: "/azure/storage/files/create-classic-share" },
  });
  assert.equal(classic.decision, "reject");
  assert.equal(classic.via, "classic");
  assert.equal(classic.by, "gates");
  assert.equal(
    gate({
      target: { kind: "docs", path: "/azure/x/classic/page" },
      judge: { confidence: "low" },
    }).via,
    "classic",
  );
});

test("hands-on material is decided without asking: a page the judge picked is accepted for the lab page, one it rejected is rejected", () => {
  const exercise = {
    title: "Exercise - Create a virtual network",
    target: {
      kind: "unit",
      path: "/training/modules/vnets/3-exercise-create-a-virtual-network",
    },
  };
  const picked = gate(exercise);
  assert.equal(picked.decision, "accept");
  assert.equal(picked.via, "hands-on");
  assert.match(picked.reasons[0], /hands-on \(exercise\).*lab page/);
  // however unsure the judge is, the maintainer is not asked about the course
  const unsure = gate({
    ...exercise,
    judge: { confidence: "low" },
    flags: ["level-mismatch"],
  });
  assert.equal(unsure.decision, "accept");
  assert.equal(unsure.via, "hands-on");
  assert.deepEqual(unsure.warnings, [
    "the judge is not sure (low confidence)",
    "flagged: level-mismatch",
  ]);
  for (const confidence of ["low", "high"]) {
    const rejected = gate({
      ...exercise,
      judge: { verdict: "reject", why: "Another task.", confidence },
    });
    assert.equal(rejected.decision, "reject", confidence);
    assert.equal(rejected.via, "hands-on");
  }
  // a quote that is not in the evidence cannot be built into a pick: rejected, not asked
  assert.equal(
    gate({ ...exercise, judge: { quoteVerified: false } }).decision,
    "reject",
  );
  // a tutorial page and a unit of a guided project are hands-on too
  assert.equal(
    gate({
      title: "Tutorial: Filter network traffic",
      target: {
        kind: "docs",
        path: "/azure/virtual-network/tutorial-filter-network-traffic",
      },
    }).via,
    "hands-on",
  );
  assert.equal(
    gate({
      title: "Introduction",
      module: { path: "/training/modules/m", title: "Guided project: X" },
      target: { kind: "unit", path: "/training/modules/m/1-introduction" },
    }).via,
    "hands-on",
  );
  // what the maintainer already decided comes first
  const decided = gate(exercise, {
    decisions: withStore([
      {
        task: TASK.key,
        target: exercise.target.path,
        decision: "reject",
        reason: "No.",
        by: "maintainer",
        at: TODAY,
      },
    ]),
  });
  assert.equal(decided.via, "remembered");
});

test("a candidate of another sub-product than the task's anchor is accepted with a warning, and queued when warnings queue", () => {
  for (const [signals, text] of [
    [{ foreignFamily: true }, /a family the exam's course does not list/],
    [{ siblingSection: true }, /a section the exam's course does not list/],
    [{ anchored: false }, /another sub-product than the task's anchor/],
  ]) {
    const over = {
      source: "P3",
      judge: { verdict: "supporting", relation: "prerequisite" },
      signals,
    };
    const g = gate(over);
    assert.equal(g.decision, "accept");
    assert.match(g.warnings.join(), text);
    assert.doesNotMatch(g.reasons[0], /same sub-product/);
    const strict = gate(over, { options: { acceptWithWarnings: false } });
    assert.equal(strict.decision, "queue");
    assert.match(strict.reasons.join(), text);
  }
  const same = gate({
    source: "P3",
    judge: { verdict: "supporting", relation: "prerequisite" },
    signals: { anchored: true },
  });
  assert.equal(same.decision, "accept");
  assert.equal(same.warnings, undefined);
  assert.match(same.reasons[0], /same sub-product/);
});

test("a page that has not been modified for 24 months is a warning; an unknown age is not", () => {
  const old = gate({}, { ageOf: () => 731 });
  assert.equal(old.decision, "accept");
  assert.deepEqual(old.warnings, ["not modified for 24 months"]);
  assert.equal(gate({}, { ageOf: () => 730 }).warnings, undefined);
  assert.equal(gate({}, { ageOf: () => null }).warnings, undefined);
  assert.equal(
    gate({}, { ageOf: () => 400, options: { maxAgeDays: 365 } }).warnings
      .length,
    1,
  );
  assert.equal(
    gate({}, { ageOf: () => 731, options: { acceptWithWarnings: false } })
      .decision,
    "queue",
  );
});

test("a rejection by the judge is a rejection, remembered when it says the page is out of scope", () => {
  const generic = gate({
    judge: { verdict: "reject", why: "A generic overview." },
    flags: [],
  });
  assert.equal(generic.decision, "reject");
  assert.equal(generic.via, "judge");
  assert.equal(generic.remember, false);
  assert.match(
    generic.reasons[0],
    /rejected by the judge: A generic overview\./,
  );
  for (const flag of ["other-role", "other-sub-product", "licensing-tier"])
    assert.equal(
      gate({ judge: { verdict: "reject", why: "x" }, flags: [flag] }).remember,
      true,
      flag,
    );
  assert.equal(
    gate({ judge: { verdict: "reject", why: "x" }, flags: ["preview"] })
      .remember,
    false,
  );
});

test("a reject the judge is not sure of is never final: it waits for the maintainer, with no class proposed", () => {
  const unsure = gate({
    judge: {
      verdict: "reject",
      why: "Mentions routes only in passing.",
      confidence: "low",
    },
    flags: ["other-role"],
  });
  assert.equal(unsure.decision, "queue");
  assert.equal(unsure.by, "maintainer");
  assert.equal(unsure.class, undefined);
  assert.match(
    unsure.reasons[0],
    /the judge rejected it but is not sure \(low confidence\): Mentions routes only in passing\./,
  );
  assert.equal(unsure.remember, undefined, "nothing is remembered yet");
  // a reject the judge is sure of (or fairly sure of) is final
  for (const confidence of ["high", "medium"])
    assert.equal(
      gate({ judge: { verdict: "reject", why: "x", confidence } }).decision,
      "reject",
      confidence,
    );
  // what the maintainer decided still comes first
  const decided = gate(
    { judge: { verdict: "reject", why: "x", confidence: "low" } },
    {
      decisions: withStore([
        {
          task: TASK.key,
          target: "/azure/storage/blobs/x",
          decision: "reject",
          reason: "No.",
          by: "maintainer",
          at: "2026-10-16",
        },
      ]),
    },
  );
  assert.equal(decided.decision, "reject");
  assert.equal(decided.via, "remembered");
});

test("the queue shows an unsure reject as a question, and accepting one needs a class and the maintainer's own note", () => {
  const judged = judgedFiles();
  const item = judged[0].tasks[0].items[0];
  item.judge = {
    verdict: "reject",
    why: "Looks like another role's page.",
    confidence: "low",
    flags: ["other-role"],
  };
  const gated = gateJudged(judged, { today: TODAY });
  assert.equal(gated.stats.queuedJudgeRejects, 1);
  assert.equal(
    gated.stats.rejectedByJudge,
    gated.items.filter((i) => i.gate.via === "judge").length,
  );
  const queue = buildQueue("NET-100", gated, { builtAt: TODAY });
  const index = queue.items.findIndex(
    (q) => q.target.path === item.target.path,
  );
  const q = queue.items[index];
  assert.deepEqual(q.proposal, { verdict: "reject" });
  assert.equal(q.judge.verdict, "reject");
  const apply = (over) =>
    applyAnswers(
      emptyDecisions("NET-100"),
      answer(structuredClone(queue), index, over),
      { today: TODAY },
    );
  // accepting needs a class: there is none to take
  const noClass = apply({ decision: "accept", note: "It is relevant." });
  assert.match(
    noClass.problems[0],
    /class must be core or supporting \(the judge rejected this page/,
  );
  // ...and a note, which becomes the pick's reason
  const noNote = apply({ decision: "accept", class: "core" });
  assert.match(
    noNote.problems[0],
    /the judge rejected this page; say in note why you accept it/,
  );
  const ok = apply({
    decision: "accept",
    class: "core",
    note: "It is relevant.",
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.applied[0].reason, "It is relevant.");
  // rejecting needs nothing more
  assert.deepEqual(apply({ decision: "reject" }).problems, []);
});

test("the entitlement management card is caught: marked for review when the judge flagged it, rejected and remembered when the judge saw it", () => {
  const card = {
    source: "P4",
    target: {
      kind: "docs",
      path: "/entra/id-governance/entitlement-management-external-users",
    },
    title: "Onboard external users with entitlement management",
    flags: ["other-sub-product"],
    signals: { foreignFamily: true },
  };
  const missed = gate({
    ...card,
    judge: {
      verdict: "supporting",
      relation: "same-workflow",
      flags: ["other-sub-product"],
    },
  });
  assert.equal(missed.decision, "accept");
  assert.deepEqual(missed.review, ["flagged: other-sub-product"]);
  assert.match(
    missed.warnings.join(),
    /a family the exam's course does not list/,
    "the foreign family is a warning",
  );
  // in sheet mode the flag and the foreign family make it wait
  const waiting = gate(
    {
      ...card,
      judge: {
        verdict: "supporting",
        relation: "same-workflow",
        flags: ["other-sub-product"],
      },
    },
    { options: SHEET },
  );
  assert.equal(waiting.decision, "queue");
  assert.equal(waiting.reasons[0], "flagged: other-sub-product");
  assert.match(
    waiting.reasons.join(),
    /a family the exam's course does not list/,
  );
  const seen = gate({
    ...card,
    judge: {
      verdict: "reject",
      why: "Identity governance, not part of this job.",
      flags: ["other-sub-product"],
    },
  });
  assert.equal(seen.decision, "reject");
  assert.equal(seen.remember, true);
});

test("a page that is not a current Learn page is rejected before anything else, even one the maintainer accepted", () => {
  const stale = { ok: false, reason: "moved to /azure/new" };
  const isCurrent = (path) =>
    path === "/azure/storage/blobs/x" ? stale : { ok: true };
  const g = gate({}, { isCurrent });
  assert.equal(g.decision, "reject");
  assert.equal(g.via, "current");
  assert.match(
    g.reasons[0],
    /not a current Learn page \(moved to \/azure\/new\)/,
  );
  const accepted = withStore([
    {
      task: TASK.key,
      target: "/azure/storage/blobs/x",
      decision: "accept",
      class: "core",
      reason: "ok",
      by: "maintainer",
      at: TODAY,
    },
  ]);
  assert.equal(gate({}, { isCurrent, decisions: accepted }).decision, "reject");
  assert.equal(
    gate({}, { isCurrent: () => ({ ok: true }) }).decision,
    "accept",
  );
  assert.equal(gate({}, { isCurrent: () => undefined }).decision, "accept");
});

test("a sub-product the maintainer excluded rejects every documentation page of it, and nothing else", () => {
  const decisions = withStore(
    [],
    [
      {
        family: "/entra/id-governance",
        reason: "identity governance",
        at: TODAY,
      },
    ],
  );
  const inside = gate(
    { target: { kind: "docs", path: "/entra/id-governance/x/y" } },
    { decisions },
  );
  assert.equal(inside.decision, "reject");
  assert.equal(inside.via, "excluded");
  assert.match(
    inside.reasons[0],
    /in \/entra\/id-governance, which the maintainer excluded: identity governance/,
  );
  assert.equal(
    gate({ target: { kind: "docs", path: "/entra/identity/x" } }, { decisions })
      .decision,
    "accept",
  );
  assert.equal(
    gate(
      { target: { kind: "module", path: "/training/modules/id-governance" } },
      { decisions },
    ).decision,
    "accept",
    "families are for documentation pages",
  );
});

test("what the maintainer decided is applied first and is never asked again", () => {
  const decisions = withStore([
    {
      task: TASK.key,
      target: "/azure/storage/blobs/x",
      decision: "accept",
      class: "supporting",
      relation: "operate",
      reason: "worth knowing",
      by: "maintainer",
      at: TODAY,
    },
    {
      task: TASK.key,
      target: "/azure/storage/blobs/y",
      decision: "reject",
      reason: "another job",
      by: "maintainer",
      at: TODAY,
    },
  ]);
  // a P4 that the judge flagged as another role: the maintainer's accept stands
  const accepted = gate(
    {
      source: "P4",
      flags: ["other-role"],
    },
    { decisions },
  );
  assert.equal(accepted.decision, "accept");
  assert.equal(accepted.class, "supporting");
  assert.equal(accepted.relation, "operate");
  assert.equal(accepted.by, "maintainer");
  assert.equal(accepted.via, "remembered");
  const rejected = gate(
    { target: { kind: "docs", path: "/azure/storage/blobs/y" } },
    { decisions },
  );
  assert.equal(rejected.decision, "reject");
  assert.equal(rejected.by, "maintainer");
  assert.match(rejected.reasons[0], /rejected by the maintainer: another job/);
  // the same page under another task is not decided: the gates judge it on its own
  const other = gateItem(
    { ...TASK, key: "domain/group/another" },
    judgedItem({
      source: "P4",
      flags: ["other-role"],
    }),
    { today: TODAY, decisions },
  );
  assert.equal(other.decision, "accept");
  assert.equal(other.via, "gates");
  assert.deepEqual(other.review, ["flagged: other-role"]);
});

const judgedFiles = () => [exampleJudged({ units: "all" })];

test("gating a judged file: a decision for every candidate in task and path order, and the numbers", () => {
  const files = judgedFiles();
  const { items, stats } = gateJudged(files, { today: TODAY, options: SHEET });
  const total = files[0].tasks.reduce((n, t) => n + t.items.length, 0);
  assert.equal(items.length, total);
  assert.equal(stats.candidates, total);
  assert.equal(stats.accepted + stats.rejected + stats.queued, total);
  const keys = items.map((i) => `${i.task.key}|${i.target.path}`);
  assert.deepEqual(keys, [...keys].sort());
  for (const item of items) {
    assert.ok(["accept", "reject", "queue"].includes(item.gate.decision));
    assert.ok(item.gate.reasons.length > 0);
    assert.equal(item.task.group, "Configure virtual networks");
  }
  assert.equal(stats.rejectedByJudge, files[0].stats.reject);
  assert.ok(
    stats.queued > 0,
    "the P4 and P3 core candidates wait for the maintainer",
  );
  assert.equal(
    Object.values(stats.queueReasons).reduce((a, b) => a + b, 0) >=
      stats.queued,
    true,
  );
  assert.equal(stats.acceptedCore + stats.acceptedSupporting, stats.accepted);
  assert.deepEqual(JSON.parse(JSON.stringify(items)), items, "plain data");
});

test("the queue lists what waits, with what the maintainer needs and empty answers", () => {
  const gated = gateJudged(judgedFiles(), { today: TODAY, options: SHEET });
  const queue = buildQueue("NET-100", gated, { builtAt: TODAY });
  assert.equal(queue.kind, "queue");
  assert.equal(queue.code, "NET-100");
  assert.equal(queue.items.length, gated.stats.queued);
  assert.deepEqual(queue.items.map((q) => q.id).slice(0, 2), ["q001", "q002"]);
  const q = queue.items[0];
  assert.match(q.url, /^https:\/\/learn\.microsoft\.com\//);
  assert.equal(q.url, learnUrl(q.target.path));
  assert.ok(q.reasons.length > 0);
  assert.ok(q.judge.why && q.judge.confidence);
  assert.ok(["core", "supporting"].includes(q.proposal.class));
  assert.deepEqual(
    {
      decision: q.decision,
      class: q.class,
      relation: q.relation,
      excludeFamily: q.excludeFamily,
      note: q.note,
    },
    {
      decision: null,
      class: null,
      relation: null,
      excludeFamily: false,
      note: "",
    },
  );
  assert.ok(queue.items.every((i) => i.skeptic === undefined));
});

const queueOf = () =>
  buildQueue(
    "NET-100",
    gateJudged(judgedFiles(), { today: TODAY, options: SHEET }),
    {
      builtAt: TODAY,
    },
  );
const answer = (queue, i, over) => {
  Object.assign(queue.items[i], over);
  return queue;
};

test("answers become decisions: an accept takes the proposed class, a reject takes the note as its reason", () => {
  const store = emptyDecisions("NET-100");
  const queue = queueOf();
  const p4 = queue.items.findIndex((q) => q.source === "P4");
  const other = queue.items.findIndex((q) => q.source !== "P4");
  assert.ok(p4 >= 0 && other >= 0);
  answer(queue, other, { decision: "accept", note: "Part of the job." });
  answer(queue, p4, { decision: "reject", note: "Another product area." });
  const result = applyAnswers(store, queue, { today: TODAY });
  assert.deepEqual(result.problems, []);
  assert.equal(result.applied.length, 2);
  assert.equal(result.pending, queue.items.length - 2);
  const accepted = result.store.decisions.find((d) => d.decision === "accept");
  assert.equal(accepted.class, queue.items[other].proposal.class);
  assert.equal(accepted.reason, "Part of the job.");
  assert.equal(accepted.by, "maintainer");
  assert.equal(accepted.at, TODAY);
  const rejected = result.store.decisions.find((d) => d.decision === "reject");
  assert.equal(rejected.reason, "Another product area.");
  assert.equal(rejected.class, undefined);
  assert.deepEqual(validateDecisions(result.store, "NET-100"), []);
  assert.deepEqual(
    store,
    emptyDecisions("NET-100"),
    "the input is not changed",
  );
});

test("the maintainer can accept as another class, and exclude a whole sub-product by rejecting one of its pages", () => {
  const queue = queueOf();
  const doc = queue.items.findIndex((q) => q.target.kind === "docs");
  const module = queue.items.findIndex((q) => q.target.kind !== "docs");
  answer(queue, doc, {
    decision: "reject",
    note: "Identity governance.",
    excludeFamily: true,
  });
  const result = applyAnswers(emptyDecisions("NET-100"), queue, {
    today: TODAY,
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.store.excludedFamilies, [
    {
      family: result.store.excludedFamilies[0].family,
      reason: "Identity governance.",
      at: TODAY,
    },
  ]);
  assert.match(
    result.store.excludedFamilies[0].family,
    /^\/[a-z0-9-]+\/[a-z0-9-]+/,
  );

  const toSupporting = queueOf();
  answer(toSupporting, 0, {
    decision: "accept",
    class: "supporting",
    relation: "same-workflow",
  });
  const ok = applyAnswers(emptyDecisions("NET-100"), toSupporting, {
    today: TODAY,
  });
  assert.equal(ok.store.decisions[0].class, "supporting");
  assert.equal(ok.store.decisions[0].relation, "same-workflow");
  if (module >= 0) {
    const bad = queueOf();
    answer(bad, module, { decision: "reject", excludeFamily: true });
    assert.match(
      applyAnswers(emptyDecisions("NET-100"), bad, {
        today: TODAY,
      }).problems.join(),
      /only a documentation page can exclude a family/,
    );
  }
});

test("an answer that cannot be applied stops everything and nothing is written", () => {
  const store = emptyDecisions("NET-100");
  const problem = (edit) => {
    const queue = queueOf();
    answer(queue, 0, { decision: "accept" });
    edit(queue);
    const r = applyAnswers(store, queue, { today: TODAY });
    assert.deepEqual(r.applied, []);
    assert.equal(r.store, store);
    return r.problems.join("\n");
  };
  assert.match(
    problem((q) => answer(q, 0, { decision: "yes" })),
    /decision must be "accept" or "reject"/,
  );
  assert.match(
    problem((q) => answer(q, 0, { class: "extra" })),
    /class must be core or supporting/,
  );
  assert.match(
    problem((q) =>
      answer(q, 0, {
        class: "supporting",
        relation: null,
        proposal: { class: "core" },
      }),
    ),
    /a supporting accept needs a relation/,
  );
  assert.match(
    problem((q) => answer(q, 0, { class: "core", relation: "operate" })),
    /a core accept has no relation/,
  );
  assert.match(
    problem((q) => answer(q, 0, { excludeFamily: true })),
    /excludeFamily goes with a reject/,
  );
  assert.match(
    problem((q) => (q.code = "OTHER-1")),
    /the queue is for OTHER-1, the decisions are NET-100/,
  );
  assert.match(
    applyAnswers(store, { kind: "x" }, { today: TODAY }).problems[0],
    /not a queue file/,
  );
});

test("an item that is already decided is a problem unless the maintainer changes it on purpose", () => {
  const queue = queueOf();
  answer(queue, 0, { decision: "accept" });
  const first = applyAnswers(emptyDecisions("NET-100"), queue, {
    today: TODAY,
  });
  const again = queueOf();
  answer(again, 0, { decision: "reject", note: "Changed my mind." });
  const refused = applyAnswers(first.store, again, { today: TODAY });
  assert.match(
    refused.problems.join(),
    /already decided \(use --replace to change it\)/,
  );
  const replaced = applyAnswers(first.store, again, {
    today: TODAY,
    replace: true,
  });
  assert.deepEqual(replaced.problems, []);
  assert.equal(replaced.store.decisions.length, 1);
  assert.equal(replaced.store.decisions[0].decision, "reject");
});

test("a re-run does not ask again: what was decided leaves the queue and the gates use it", () => {
  const files = judgedFiles();
  const first = gateJudged(files, { today: TODAY, options: SHEET });
  const queue = buildQueue("NET-100", first, { builtAt: TODAY });
  const p4 = queue.items.find(
    (q) => q.source === "P4" && q.target.kind === "docs",
  );
  const core = queue.items.find((q) => q !== p4);
  answer(queue, queue.items.indexOf(p4), {
    decision: "reject",
    note: "Not this job.",
    excludeFamily: true,
  });
  answer(queue, queue.items.indexOf(core), {
    decision: "accept",
    note: "Yes.",
  });
  const { store } = applyAnswers(emptyDecisions("NET-100"), queue, {
    today: TODAY,
  });
  const second = gateJudged(files, {
    today: TODAY,
    options: SHEET,
    decisions: store,
  });
  const requeue = buildQueue("NET-100", second, { builtAt: TODAY });
  const asked = new Set(requeue.items.map((q) => `${q.task}|${q.target.path}`));
  for (const q of [p4, core])
    assert.ok(
      !asked.has(`${q.task}|${q.target.path}`),
      `${q.title} is not asked again`,
    );
  assert.ok(requeue.items.length < queue.items.length);
  const decided = second.items.find(
    (i) => i.target.path === p4.target.path && i.task.key === p4.task,
  );
  assert.equal(decided.gate.decision, "reject");
  assert.equal(decided.gate.via, "remembered");
  const accepted = second.items.find(
    (i) => i.target.path === core.target.path && i.task.key === core.task,
  );
  assert.equal(accepted.gate.decision, "accept");
  assert.equal(accepted.gate.by, "maintainer");
  assert.equal(second.stats.rejectedRemembered >= 1, true);
  assert.equal(second.stats.acceptedByMaintainer >= 1, true);
  // and a third run gives the same
  assert.deepEqual(
    gateJudged(files, { today: TODAY, options: SHEET, decisions: store }).stats,
    second.stats,
  );
});

test("a decisions file is checked", () => {
  const good = {
    ...emptyDecisions("NET-100"),
    decisions: [
      {
        task: "t",
        target: "/a",
        decision: "accept",
        class: "supporting",
        relation: "operate",
        reason: "x",
        by: "maintainer",
        at: TODAY,
      },
      {
        task: "t",
        target: "/b",
        decision: "reject",
        reason: "y",
        by: "maintainer",
        at: TODAY,
      },
    ],
    excludedFamilies: [
      { family: "/entra/id-governance", reason: "z", at: TODAY },
    ],
  };
  assert.deepEqual(validateDecisions(good, "NET-100"), []);
  const errors = (edit) => {
    const copy = JSON.parse(JSON.stringify(good));
    edit(copy);
    return validateDecisions(copy, "NET-100").join("\n");
  };
  assert.match(validateDecisions(null)[0], /not a JSON object/);
  assert.match(
    errors((s) => (s.schemaVersion = 2)),
    /schemaVersion must be 1/,
  );
  assert.match(
    errors((s) => (s.code = "XX-1")),
    /code is "XX-1", expected "NET-100"/,
  );
  assert.match(
    errors((s) => (s.decisions = "no")),
    /decisions must be a list/,
  );
  assert.match(
    errors((s) => (s.excludedFamilies = {})),
    /excludedFamilies must be a list/,
  );
  assert.match(
    errors((s) => s.decisions.push({ ...s.decisions[0] })),
    /decided twice/,
  );
  assert.match(
    errors((s) => (s.decisions[0].decision = "maybe")),
    /decision must be accept or reject/,
  );
  assert.match(
    errors((s) => delete s.decisions[0].class),
    /an accept needs a class/,
  );
  assert.match(
    errors((s) => delete s.decisions[0].relation),
    /a supporting accept needs a relation/,
  );
  assert.match(
    errors((s) => (s.decisions[0].class = "core")),
    /only a supporting accept has a relation/,
  );
  assert.match(
    errors((s) => (s.decisions[1].class = "core")),
    /only an accept has a class or a relation/,
  );
  assert.match(
    errors((s) => (s.decisions[1].reason = "")),
    /reason is required/,
  );
  assert.match(
    errors((s) => (s.decisions[1].by = "auto")),
    /by must be "maintainer"/,
  );
  assert.match(
    errors((s) => (s.decisions[1].at = "2026-02-31")),
    /at must be a YYYY-MM-DD day/,
  );
  assert.match(
    errors((s) => (s.decisions[1] = { decision: "reject" })),
    /needs a task and a target/,
  );
  assert.match(
    errors((s) => (s.excludedFamilies[0].family = "entra")),
    /an excluded family needs a path/,
  );
  assert.match(
    errors((s) => s.excludedFamilies.push({ ...s.excludedFamilies[0] })),
    /excluded twice/,
  );
  assert.match(
    errors((s) => (s.excludedFamilies[0].reason = "")),
    /reason is required/,
  );
});

test("age in days counts from a day or a timestamp and says nothing when there is none", () => {
  assert.equal(ageInDays("2026-10-07", "2026-10-17"), 10);
  assert.equal(ageInDays("2024-10-17T08:00:00Z", "2026-10-17"), 730);
  assert.equal(ageInDays("-", "2026-10-17"), null);
  assert.equal(ageInDays(undefined, "2026-10-17"), null);
  assert.equal(ageInDays("not a date", "2026-10-17"), null);
});

test("a list of numbers is read as numbers and ranges, sorted, and must be on the page", () => {
  assert.deepEqual(parseNumbers("3, 8,19", 40), [3, 8, 19]);
  assert.deepEqual(parseNumbers("10-12,3,11", 40), [3, 10, 11, 12]);
  assert.deepEqual(parseNumbers("7", 7), [7]);
  for (const bad of ["0", "41", "5-", "a", "3;4", "9-5", ""])
    assert.throws(() => parseNumbers(bad, 40), undefined, bad);
  assert.throws(() => parseNumbers("38-41", 40), /not on the page/);
});

test("the answers on the review copy: the dropped numbers are rejected, every other marked pick is kept with its class", () => {
  const numbered = [
    { n: 1, task: "d/g/t1", kind: "docs", path: "/azure/a", class: "core" },
    {
      n: 2,
      task: "d/g/t1",
      kind: "module",
      path: "/training/modules/b",
      class: "supporting",
      relation: "deeper",
    },
    { n: 3, task: "d/g/t2", kind: "docs", path: "/azure/a", class: "core" },
  ];
  const queue = answersFromReview("NET-100", numbered, [2], {});
  assert.equal(queue.kind, "queue");
  assert.deepEqual(
    queue.items.map((q) => [q.id, q.decision]),
    [
      ["r001", "accept"],
      ["r002", "reject"],
      ["r003", "accept"],
    ],
  );
  const result = applyAnswers(emptyDecisions("NET-100"), queue, {
    today: TODAY,
  });
  assert.deepEqual(result.problems, []);
  const byPath = new Map(
    result.store.decisions.map((d) => [`${d.task}|${d.target}`, d]),
  );
  assert.equal(byPath.get("d/g/t1|/azure/a").class, "core");
  assert.equal(byPath.get("d/g/t1|/azure/a").by, "maintainer");
  const dropped = byPath.get("d/g/t1|/training/modules/b");
  assert.equal(dropped.decision, "reject");
  assert.equal(dropped.reason, "dropped on the review copy of the course page");
  // the same page under another task is its own decision
  assert.equal(byPath.get("d/g/t2|/azure/a").decision, "accept");
  // a note of the maintainer is the reason of every drop
  const noted = answersFromReview("NET-100", numbered, [1, 2], {
    note: "Not for this exam.",
  });
  assert.deepEqual(
    noted.items.filter((q) => q.decision === "reject").map((q) => q.note),
    ["Not for this exam.", "Not for this exam."],
  );
  // supporting keeps its relation, so applyAnswers accepts it
  assert.equal(byPath.get("d/g/t1|/training/modules/b").relation, undefined);
  const kept = applyAnswers(
    emptyDecisions("NET-100"),
    answersFromReview("NET-100", numbered, [], {}),
    { today: TODAY },
  );
  assert.equal(
    kept.store.decisions.find((d) => d.target === "/training/modules/b")
      .relation,
    "deeper",
  );
});
