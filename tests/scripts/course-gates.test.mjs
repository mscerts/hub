import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_DEFAULTS,
  ageInDays,
  applyAnswers,
  buildQueue,
  emptyDecisions,
  gateItem,
  gateJudged,
  indexDecisions,
  learnUrl,
  validateDecisions,
} from "../../scripts/lib/course-gates.mjs";
import { exampleJudged } from "./helpers/example-judging.mjs";

const TASK = {
  key: "domain/group/manage-external-users",
  text: "Manage external users",
  group: "Manage users",
};
const TODAY = "2026-10-17";

/** An entry of a judged file, as course-judge.mjs merge writes it, with `over` merged into it. */
function judgedItem(over = {}) {
  const { judge, skeptic, ...rest } = over;
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
    skeptic: { stance: "uphold", reason: "Could not refute it.", ...skeptic },
    agreement: "agree",
    flags: [],
    ...rest,
  };
  if (skeptic === null) delete item.skeptic;
  return item;
}
const gate = (over, ctx = {}) =>
  gateItem(TASK, judgedItem(over), { today: TODAY, ...ctx });
const withStore = (decisions = [], excludedFamilies = []) =>
  indexDecisions({ ...emptyDecisions("X"), decisions, excludedFamilies });

test("a clean pick of the exam's own course is accepted by the gates: judge and skeptic agree, nothing flagged", () => {
  for (const source of ["P1", "P2"]) {
    const g = gate({ source });
    assert.equal(g.decision, "accept", source);
    assert.equal(g.class, "core");
    assert.equal(g.by, "gates");
    assert.match(
      g.reasons[0],
      new RegExp(`${source}, the judge and the skeptic agree`),
    );
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

test("what the approval policy of the course format reserves for the maintainer is queued, whatever the judges say", () => {
  const p4 = gate({ source: "P4" });
  assert.equal(p4.decision, "queue");
  assert.match(p4.reasons[0], /found by search only \(P4\)/);
  const p3core = gate({ source: "P3" });
  assert.equal(p3core.decision, "queue");
  assert.match(
    p3core.reasons[0],
    /core material of another exam's course \(P3\)/,
  );
  const deeper = gate({
    source: "P2",
    judge: { verdict: "supporting", relation: "deeper" },
  });
  assert.equal(deeper.decision, "queue");
  assert.match(deeper.reasons[0], /a deeper dive/);
});

test("a skeptic that refuted or downgraded a pick sends it to the queue, and a downgrade proposes supporting", () => {
  const refuted = gate({
    agreement: "disagree",
    skeptic: { stance: "refute", reason: "Another product area." },
  });
  assert.equal(refuted.decision, "queue");
  assert.equal(refuted.class, "core", "the proposal stays the judge's");
  assert.match(
    refuted.reasons.join(),
    /the skeptic refuted it: Another product area\./,
  );
  const downgraded = gate({
    agreement: "disagree",
    skeptic: {
      stance: "downgrade",
      relation: "operate",
      reason: "Not what the guide asks.",
    },
  });
  assert.equal(downgraded.decision, "queue");
  assert.equal(downgraded.class, "supporting");
  assert.equal(downgraded.relation, "operate");
  assert.match(downgraded.reasons.join(), /the skeptic downgraded it/);
});

test("a pick nobody challenged, a low confidence, a flag, a quote that is not in the evidence or says little of the task each queue it", () => {
  const reasons = (over) => gate(over).reasons.join(" | ");
  assert.match(
    reasons({ skeptic: null, agreement: "unchallenged" }),
    /no skeptic has challenged it/,
  );
  assert.match(reasons({ judge: { confidence: "low" } }), /low confidence/);
  assert.equal(gate({ judge: { confidence: "medium" } }).decision, "accept");
  const flagged = gate({ flags: ["preview", "level-mismatch"] });
  assert.equal(flagged.decision, "queue");
  assert.match(flagged.reasons.join(), /flagged: preview, level-mismatch/);
  assert.match(
    reasons({ judge: { quoteVerified: false } }),
    /the quote is not in the evidence/,
  );
  assert.match(
    reasons({ judge: { quoteTermCoverage: 0.25 } }),
    /the quote carries 25% of the task's words/,
  );
  assert.equal(
    gate({ judge: { quoteTermCoverage: 0.5 } }).decision,
    "accept",
    "half is enough",
  );
  assert.equal(
    gate(
      { judge: { quoteTermCoverage: 0.25 } },
      { options: { coreQuoteCoverage: 0.2 } },
    ).decision,
    "accept",
    "an option",
  );
  assert.equal(GATE_DEFAULTS.coreQuoteCoverage, 0.5);
});

test("a candidate of another sub-product than the task's anchor is queued", () => {
  for (const [signals, text] of [
    [{ foreignFamily: true }, /a family the exam's course does not list/],
    [{ siblingSection: true }, /a section the exam's course does not list/],
    [{ anchored: false }, /another sub-product than the task's anchor/],
  ]) {
    const g = gate({
      source: "P3",
      judge: { verdict: "supporting", relation: "prerequisite" },
      signals,
    });
    assert.equal(g.decision, "queue");
    assert.match(g.reasons.join(), text);
  }
  assert.equal(
    gate({
      source: "P3",
      judge: { verdict: "supporting", relation: "prerequisite" },
      signals: { anchored: true },
    }).decision,
    "accept",
  );
});

test("a page that has not been modified for 24 months is queued; an unknown age is not", () => {
  const old = gate({}, { ageOf: () => 731 });
  assert.equal(old.decision, "queue");
  assert.match(old.reasons.join(), /not modified for 24 months/);
  assert.equal(gate({}, { ageOf: () => 730 }).decision, "accept");
  assert.equal(gate({}, { ageOf: () => null }).decision, "accept");
  assert.equal(
    gate({}, { ageOf: () => 400, options: { maxAgeDays: 365 } }).decision,
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

test("the entitlement management card is caught: queued when the judge missed it, rejected and remembered when the judge saw it", () => {
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
    agreement: "disagree",
    skeptic: {
      stance: "refute",
      reason: "Identity governance is not an Azure administrator's job.",
    },
  });
  assert.equal(missed.decision, "queue");
  assert.ok(missed.reasons.length >= 4);
  const seen = gate({
    ...card,
    judge: {
      verdict: "reject",
      why: "Identity governance, not part of this job.",
      flags: ["other-sub-product"],
    },
    agreement: "unchallenged",
    skeptic: null,
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
  // a P4 that the judge flagged and the skeptic refuted: the maintainer's accept stands
  const accepted = gate(
    {
      source: "P4",
      flags: ["preview"],
      agreement: "disagree",
      skeptic: { stance: "refute", reason: "no" },
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
  // the same page under another task is not decided
  const other = gateItem(
    { ...TASK, key: "domain/group/another" },
    judgedItem({ source: "P4" }),
    { today: TODAY, decisions },
  );
  assert.equal(other.decision, "queue");
});

const judgedFiles = () => [exampleJudged()];

test("gating a judged file: a decision for every candidate in task and path order, and the numbers", () => {
  const files = judgedFiles();
  const { items, stats } = gateJudged(files, { today: TODAY });
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
  const gated = gateJudged(judgedFiles(), { today: TODAY });
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
  assert.ok(
    queue.items.every((i) => i.skeptic === undefined || i.skeptic.stance),
  );
});

const queueOf = () =>
  buildQueue("NET-100", gateJudged(judgedFiles(), { today: TODAY }), {
    builtAt: TODAY,
  });
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
  const first = gateJudged(files, { today: TODAY });
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
  const second = gateJudged(files, { today: TODAY, decisions: store });
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
    gateJudged(files, { today: TODAY, decisions: store }).stats,
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
