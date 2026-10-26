import assert from "node:assert/strict";
import test from "node:test";
import { buildCourse } from "../../scripts/lib/course-build.mjs";
import {
  CONCEPT_TITLE,
  buildPools,
  generateCandidates,
} from "../../scripts/lib/course-candidates.mjs";
import {
  FOUNDATION_CLASS,
  flattenFoundations,
  foundationKey,
  groupKeyOf,
  isFoundationKey,
  orderFoundations,
  taskIndexOf,
} from "../../scripts/lib/course-foundations.mjs";
import {
  eachPick,
  courseStats,
  pickProblems,
  validateCourse,
} from "../../scripts/lib/course-format.mjs";
import {
  applyAnswers,
  emptyDecisions,
  gateJudged,
  validateDecisions,
} from "../../scripts/lib/course-gates.mjs";
import {
  FOUNDATION_VERDICTS,
  buildBatches,
  judgePrompt,
  validateJudgments,
} from "../../scripts/lib/course-judge.mjs";
import {
  numberReview,
  renderCourse,
} from "../../scripts/lib/course-render.mjs";
import { rebuildPlan } from "../../scripts/lib/course-status.mjs";
import {
  candidateWorld,
  guideOf,
  scopeOf,
} from "./helpers/example-candidates.mjs";
import {
  TASKS,
  batches,
  candidatesFile,
  judgedFor,
  judgmentsFor,
} from "./helpers/example-judging.mjs";

const TODAY = "2026-10-21";
const KEY = "networking/configure/@foundations";
const guide = () => ({ ...guideOf(TASKS), ok: true });

test("the fundamentals of a skill group have a pseudo-task key of their own, and one exists per group", () => {
  assert.equal(groupKeyOf("networking/configure/t0"), "networking/configure");
  assert.equal(foundationKey("networking/configure"), KEY);
  assert.ok(isFoundationKey(KEY));
  assert.ok(!isFoundationKey("networking/configure/t0"));
  const found = flattenFoundations(guideOf(TASKS));
  assert.deepEqual(found, [
    {
      key: KEY,
      text: "Configure virtual networks",
      domain: "Networking",
      group: "Configure virtual networks",
      tasks: TASKS,
      foundation: true,
    },
  ]);
  assert.deepEqual(flattenFoundations({ domains: [] }), []);
  assert.deepEqual(
    flattenFoundations({
      domains: [{ title: "D", groups: [{ title: "G", tasks: [] }] }],
    }),
    [],
    "a group without tasks has no fundamentals",
  );
});

test("the generator shortlists the fundamentals of every skill group, liberally, and leaves hands-on pages to the lab page", () => {
  const { candidates } = candidatesFile(TASKS, { foundations: true });
  assert.equal(candidates.foundations.length, 1);
  const f = candidates.foundations[0];
  assert.equal(f.key, KEY);
  assert.equal(f.foundation, true);
  assert.deepEqual(f.tasks, TASKS);
  assert.ok(f.candidates.length > 0);
  // more than the tasks' own shortlists: the group's words and looser thresholds
  const own = new Set(
    candidates.tasks.flatMap((t) => t.candidates.map((c) => c.target.path)),
  );
  assert.ok(
    f.candidates.some((c) => own.has(c.target.path)),
    "the same pages can be on both",
  );
  // no hands-on page: the tutorial the exam's modules list is counted, never listed
  assert.ok(!f.candidates.some((c) => /tutorial/i.test(c.title)));
  assert.ok(f.dropped["hands-on"].count >= 1);
  assert.deepEqual(candidates.stats.foundations.groups, 1);
  assert.equal(
    candidates.stats.foundations.candidates,
    f.candidates.length,
    "counted in the stats",
  );
  assert.ok(
    candidates.params.foundationCoverage.P1 < 0.34,
    "looser than a task",
  );
});

test("the fundamentals can be left out, or given stricter thresholds", () => {
  const off = candidatesFile(TASKS).candidates;
  assert.deepEqual(off.foundations, []);
  assert.equal(off.params.foundationCoverage, null);
  const { candidates, pools } = candidatesFile(TASKS, { foundations: true });
  const strict = generateCandidates({
    code: "NET-100",
    guide: guideOf(TASKS),
    scope: scopeOf(),
    pools,
    options: {
      genericProductShare: 0.6,
      foundations: { minCoverage: { P1: 1.01, P2: 1.01, P3: 1.01, P4: 1.01 } },
    },
  });
  assert.equal(strict.params.foundationCoverage.P1, 1.01);
  assert.ok(
    candidates.params.foundationCoverage.P1 <
      strict.params.foundationCoverage.P1,
  );
});

test("the judge gets the fundamentals as the last task of the group, with their own rules and verdicts", () => {
  const { batches: bs } = batches(TASKS, { foundations: true });
  const batch = bs[0];
  const last = batch.tasks.at(-1);
  assert.equal(last.key, KEY);
  assert.equal(last.foundation, true);
  assert.deepEqual(last.groupTasks, TASKS);
  assert.deepEqual(
    batch.group.tasks,
    TASKS,
    "the group's tasks do not list the fundamentals",
  );
  assert.ok(batch.tasks.slice(0, -1).every((t) => !t.foundation));
  const prompt = judgePrompt(batch);
  assert.match(prompt, /## Fundamentals/);
  assert.match(prompt, /Be \*\*liberal\*\*/);
  assert.match(prompt, /only `foundation` and `reject` are allowed/i);
  // a batch without fundamentals has the old prompt
  assert.ok(!/## Fundamentals/.test(judgePrompt(batches(TASKS).batches[0])));
  assert.deepEqual([...FOUNDATION_VERDICTS], ["foundation", "reject"]);
});

test("a fundamentals candidate is judged foundation or reject, with a quote; core, supporting and a relation are sent back", () => {
  const { batches: bs } = batches(TASKS, { foundations: true });
  const batch = bs[0];
  const ok = validateJudgments(batch, judgmentsFor(batch));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.unverified, []);
  const bad = (edit) =>
    validateJudgments(
      batch,
      judgmentsFor(batch, (j, c, task) => (task.foundation ? edit(j, c) : j)),
    ).errors.join("\n");
  assert.match(
    bad((j) => (j.verdict === "foundation" ? { ...j, verdict: "core" } : j)),
    /verdict must be one of foundation, reject/,
  );
  assert.match(
    bad((j) =>
      j.verdict === "foundation"
        ? { ...j, verdict: "supporting", relation: "deeper" }
        : j,
    ),
    /verdict must be one of foundation, reject/,
  );
  assert.match(
    bad((j) => (j.verdict === "foundation" ? { ...j, relation: "deeper" } : j)),
    /only a supporting pick has a relation/,
  );
  assert.match(
    bad((j) => (j.verdict === "foundation" ? { ...j, quote: undefined } : j)),
    /a pick needs a quote/,
  );
  const unverified = validateJudgments(
    batch,
    judgmentsFor(batch, (j, c, task) =>
      task.foundation && j.verdict === "foundation"
        ? { ...j, quote: "not in the evidence" }
        : j,
    ),
  );
  assert.ok(unverified.unverified.length > 0, "a made-up quote is listed");
  // and a real task still cannot be judged foundation
  const wrong = validateJudgments(
    batch,
    judgmentsFor(batch, (j, c, task) =>
      !task.foundation && j.verdict === "core"
        ? { ...j, verdict: "foundation" }
        : j,
    ),
  );
  assert.match(
    wrong.errors.join("\n"),
    /verdict must be one of core, supporting, reject/,
  );
});

test("a fundamentals pick has the class foundation, a why and evidence and no relation, and only the fundamentals have it", () => {
  const pick = {
    target: {
      kind: "docs",
      path: "/azure/virtual-network/virtual-networks-overview",
    },
    title: "Virtual networks",
    class: FOUNDATION_CLASS,
    source: "P1",
    why: "Teaches what a virtual network is.",
    evidence: "Virtual networks",
    decision: { by: "auto", at: TODAY },
  };
  assert.deepEqual(pickProblems(pick, { foundation: true }), []);
  assert.match(
    pickProblems(pick).join("\n"),
    /class must be one of core, supporting/,
    "not a task pick",
  );
  const problems = (over) =>
    pickProblems({ ...pick, ...over }, { foundation: true }).join("\n");
  assert.match(
    problems({ class: "core" }),
    /fundamentals pick has the class foundation/,
  );
  assert.match(problems({ relation: "deeper" }), /no relation/);
  assert.match(problems({ why: "" }), /which concept it teaches/);
  assert.match(problems({ evidence: undefined }), /evidence is required/);
});

test("a decision for the fundamentals of a group is a foundation accept; a decision for a task never is", () => {
  const decision = (task, over) => ({
    task,
    target: "/azure/a",
    decision: "accept",
    class: "foundation",
    reason: "x",
    by: "maintainer",
    at: TODAY,
    ...over,
  });
  const store = (d) => ({ ...emptyDecisions("NET-100"), decisions: [d] });
  assert.deepEqual(validateDecisions(store(decision(KEY)), "NET-100"), []);
  assert.match(
    validateDecisions(store(decision(KEY, { class: "core" })), "NET-100").join(
      "\n",
    ),
    /needs a class \(foundation\)/,
  );
  assert.match(
    validateDecisions(
      store(decision("networking/configure/t0")),
      "NET-100",
    ).join("\n"),
    /needs a class \(core, supporting\)/,
  );
  assert.match(
    validateDecisions(
      store(decision(KEY, { relation: "deeper" })),
      "NET-100",
    ).join("\n"),
    /only a supporting accept has a relation/,
  );
  // the answers of a queue: accepting a fundamentals page takes the class foundation
  const queue = {
    kind: "queue",
    code: "NET-100",
    items: [
      {
        id: "q1",
        task: KEY,
        target: { kind: "docs", path: "/azure/a" },
        proposal: { class: "foundation" },
        decision: "accept",
        class: null,
        relation: null,
        excludeFamily: false,
        note: "",
      },
      {
        id: "q2",
        task: KEY,
        target: { kind: "docs", path: "/azure/b" },
        proposal: { class: "foundation" },
        decision: "accept",
        class: "core",
        relation: null,
        excludeFamily: false,
        note: "",
      },
    ],
  };
  const result = applyAnswers(emptyDecisions("NET-100"), queue, {
    today: TODAY,
  });
  assert.match(result.problems.join("\n"), /q2.*class must be foundation/);
  const one = applyAnswers(
    emptyDecisions("NET-100"),
    { ...queue, items: [queue.items[0]] },
    { today: TODAY },
  );
  assert.deepEqual(one.problems, []);
  assert.equal(one.store.decisions[0].class, "foundation");
});

/** The invented exam, judged with its fundamentals, gated and built. */
function builtWithFoundations({ edit } = {}) {
  const { batches: bs } = batches(TASKS, { foundations: true });
  const judged = judgedFor(bs[0], { judge: edit });
  const { items } = gateJudged([judged], { today: TODAY });
  const gated = {
    schemaVersion: 1,
    kind: "gated",
    code: "NET-100",
    builtAt: TODAY,
    inputs: judged.inputs,
    items,
  };
  const result = buildCourse({
    code: "NET-100",
    name: "Network Administrator",
    guide: guide(),
    scope: scopeOf(),
    gated,
    today: TODAY,
  });
  return { result, items };
}

test("the builder puts the accepted fundamentals into the group, shows a page once and passes the validator", () => {
  const { result, items } = builtWithFoundations();
  assert.equal(result.ok, true, result.problems.join("\n"));
  const group = result.course.domains[0].groups[0];
  assert.ok(group.foundations.length > 0);
  for (const pick of group.foundations) {
    assert.equal(pick.class, FOUNDATION_CLASS);
    assert.ok(pick.why && pick.evidence);
    assert.equal(pick.relation, undefined);
    assert.deepEqual(pickProblems(pick, { foundation: true }), []);
  }
  // a page that is core for a task stays under the task, whatever the fundamentals say about it
  const taskPaths = new Set(
    group.tasks.flatMap((t) => t.picks.map((p) => p.target.path)),
  );
  for (const pick of group.foundations)
    assert.ok(
      !taskPaths.has(pick.target.path),
      pick.target.path + " is shown twice",
    );
  const repeat = result.routing.repeats.find((r) => r.alsoFits.includes(KEY));
  assert.ok(
    repeat,
    "a page of the fundamentals that is also core for a task is listed in the routing",
  );
  assert.ok(!repeat.shownUnder.endsWith("@foundations"));
  // the P3 and P4 modules the fundamentals use are recorded like any other
  assert.ok(
    items.some((i) => i.task.key === KEY && i.gate.decision === "accept"),
  );
  const checked = validateCourse(result.course, { guide: guide() });
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.stats.foundation, group.foundations.length);
  assert.equal(courseStats(result.course).foundation, group.foundations.length);
  assert.ok(
    checked.stats.picks > checked.stats.core + checked.stats.supporting,
  );
});

test("eachPick lists the fundamentals of a group before its tasks, under the pseudo-task of the group", () => {
  const { result } = builtWithFoundations();
  const rows = [...eachPick(result.course)];
  const first = rows[0];
  assert.equal(first.task.key, KEY);
  assert.equal(first.task.foundation, true);
  assert.equal(first.pick.class, FOUNDATION_CLASS);
  const lastFoundation = rows
    .map((r) => r.task.foundation === true)
    .lastIndexOf(true);
  assert.ok(rows.slice(lastFoundation + 1).every((r) => r.task.key !== KEY));
});

test("the validator refuses a page that is both a fundamentals page and a task pick, or a fundamentals pick of the wrong class", () => {
  const { result } = builtWithFoundations();
  const course = structuredClone(result.course);
  const group = course.domains[0].groups[0];
  group.tasks[0].picks.push({
    ...structuredClone(group.foundations[0]),
    class: "core",
  });
  delete group.tasks[0].picks.at(-1).why;
  const errors = validateCourse(course, { guide: guide() }).errors.join("\n");
  assert.match(
    errors,
    /is already shown under .*@foundations: a page appears once in a course/,
  );
  const wrong = structuredClone(result.course);
  wrong.domains[0].groups[0].foundations[0].class = "core";
  assert.match(
    validateCourse(wrong, { guide: guide() }).errors.join("\n"),
    /fundamentals pick has the class foundation/,
  );
  const notList = structuredClone(result.course);
  notList.domains[0].groups[0].foundations = "x";
  assert.match(
    validateCourse(notList, { guide: guide() }).errors.join("\n"),
    /foundations must be a list of picks/,
  );
});

test("the page opens every skill group with its fundamentals, before the tasks, and says so in its note", () => {
  const { result } = builtWithFoundations();
  const page = renderCourse(result.course);
  const at = (text) => page.indexOf(text);
  assert.ok(at("### Configure virtual networks") < at("#### Fundamentals"));
  assert.ok(at("#### Fundamentals") < at("#### Configure user-defined routes"));
  assert.match(
    page,
    /The concepts behind the tasks of this skill group\. Work through them first/,
  );
  assert.match(
    page,
    /Each skill group opens with its fundamentals, the theory behind its tasks/,
  );
  const block = page.slice(
    at("#### Fundamentals"),
    at("#### Configure user-defined routes"),
  );
  assert.match(block, /<Tabs>/);
  assert.equal(
    (block.match(/<LinkCard/g) ?? []).length,
    result.course.domains[0].groups[0].foundations.length,
  );
  // a course without fundamentals reads as before
  const plain = structuredClone(result.course);
  delete plain.domains[0].groups[0].foundations;
  assert.ok(!/Fundamentals|fundamentals/.test(renderCourse(plain)));
});

test("a fundamentals pick the judge was not sure of is marked on the review copy like any other, and numbered first", () => {
  const { result } = builtWithFoundations({
    edit: (j, c, task) =>
      task.foundation &&
      j.verdict === "foundation" &&
      c.source === "P1" &&
      c.target.kind === "module"
        ? { ...j, confidence: "low" }
        : j,
  });
  assert.equal(result.ok, true, result.problems.join("\n"));
  const marked = result.review.filter((r) => r.task === KEY);
  assert.ok(
    marked.length > 0,
    "the unsure fundamentals pick is listed for review",
  );
  assert.equal(marked[0].class, FOUNDATION_CLASS);
  const review = {
    schemaVersion: 1,
    kind: "review",
    code: "NET-100",
    picks: result.review,
  };
  const numbered = numberReview(result.course, review);
  assert.equal(numbered.length, result.review.length);
  assert.equal(
    numbered[0].task,
    KEY,
    "the fundamentals come first on the page",
  );
  const page = renderCourse(result.course, { review });
  assert.ok(
    page.indexOf('description="#1 ') <
      page.indexOf("#### Configure user-defined routes"),
  );
});

test("the rebuild check treats the fundamentals like any other pick: current when built, stale when a module behind one changes", () => {
  const { result } = builtWithFoundations();
  const world = candidateWorld();
  const plan = rebuildPlan({
    course: result.course,
    guide: guide(),
    scopeMap: scopeOf(),
    catalog: world.catalog.modules,
  });
  assert.equal(plan.status, "current", JSON.stringify(plan.reasons));
  // a module a fundamentals pick depends on changes its units: the plan names the pick under the fundamentals key
  const dependsOn = (result.course.inputs.picked ?? []).map(([path]) => path);
  const group = result.course.domains[0].groups[0];
  const viaModule = group.foundations.find(
    (p) =>
      p.target.kind !== "docs" &&
      dependsOn.includes(p.target.path.split("/").slice(0, 4).join("/")),
  );
  assert.ok(
    viaModule,
    "the example has a fundamentals pick of a module outside the exam course",
  );
  {
    const changed = candidateWorld().catalog.modules.map((m) =>
      m.path === viaModule.target.path.split("/").slice(0, 4).join("/")
        ? { ...m, unitSig: "changed-signature" }
        : m,
    );
    const stale = rebuildPlan({
      course: result.course,
      guide: guide(),
      scopeMap: scopeOf(),
      catalog: changed,
    });
    assert.notEqual(stale.status, "current");
    assert.ok(
      [...stale.picks.hard, ...stale.picks.soft].some((p) => p.taskKey === KEY),
    );
  }
});

const modFor = (
  slug,
  title,
  products,
  units = ["Introduction", "Summary"],
) => ({
  uid: "learn." + slug,
  path: "/training/modules/" + slug,
  title,
  products,
  units,
  unitUrls: units.map(
    (_, i) => "/training/modules/" + slug + "/" + (i + 1) + "-unit",
  ),
  unitSig: "sig-" + slug,
});

test("the concept pass adds theory-titled modules on the group's own product and pages in its families, with no word in common", () => {
  const world = candidateWorld();
  const peering = world.catalog.modules.find(
    (m) => m.path === "/training/modules/configure-peering",
  );
  peering.products = ["Virtual Network", "Hub Spoke"];
  world.catalog.modules.push(
    modFor("describe-peering-concepts", "Describe peering concepts", [
      "Hub Spoke",
    ]),
    modFor(
      "understand-network-connection",
      "Understand how data moves between sites",
      ["Hub Spoke"],
    ),
    modFor("describe-sap-concepts", "Describe SAP concepts", ["SAP"]),
    modFor("peering-step-by-step", "Configure peering step by step", [
      "Hub Spoke",
    ]),
  );
  // a module of another exam's course: P3
  world.learningPaths
    .find((lp) => lp.uid === "learn.path-700")
    .modules.push("/training/modules/understand-network-connection");
  world.docs.push({
    title: "Overview of virtual connectivity and traffic flow",
    url: "https://learn.microsoft.com/azure/virtual-network/networking-overview",
    product: null,
    subproduct: null,
    description: "",
  });
  world.docPaths.add("/azure/virtual-network/networking-overview");
  const pools = buildPools({ ...world, boilerplateModules: 2 });
  const result = generateCandidates({
    code: "NET-100",
    guide: guideOf(TASKS),
    scope: scopeOf(world),
    pools,
    options: {
      genericProductShare: 0.6,
      // the word search finds no P4 page, so the concept pass is the only way a P4 page gets in
      foundations: { minCoverage: { P4: 1.01 } },
    },
  });
  const f = result.foundations[0];
  const byPath = new Map(f.candidates.map((c) => [c.target.path, c]));
  const concept = (path) => byPath.get(path);
  const peeringConcepts = concept(
    "/training/modules/describe-peering-concepts",
  );
  assert.equal(peeringConcepts.concept, true);
  assert.equal(peeringConcepts.source, "P4", "no course uses it");
  assert.equal(peeringConcepts.unitSig, "sig-describe-peering-concepts");
  const connect = concept("/training/modules/understand-network-connection");
  assert.equal(connect.source, "P3", "a module of another exam's course");
  assert.deepEqual(connect.courses, ["NET-700T00"]);
  assert.equal(connect.concept, true);
  assert.ok(
    !concept("/training/modules/describe-sap-concepts"),
    "another product",
  );
  assert.ok(
    !concept("/training/modules/peering-step-by-step"),
    "a how-to title is not theory",
  );
  const doc = concept("/azure/virtual-network/networking-overview");
  assert.equal(doc.concept, true);
  assert.equal(doc.source, "P4");
  assert.ok(f.candidates.every((c) => c.rank > 0));
  // rank, score and coverage are filled so the rest of the chain reads them like any candidate
  assert.equal(typeof peeringConcepts.rank, "number");
  assert.equal(peeringConcepts.coverage, 0);
});

test("a title reads like theory when it describes, explains or introduces, or says concepts, overview or basics", () => {
  for (const yes of [
    "Describe identity concepts",
    "Introduction to Microsoft Entra ID",
    "Understand Microsoft Entra ID",
    "What is Microsoft Entra ID?",
    "Virtual network overview",
    "Networking basics",
    "Explore identity in Microsoft Entra ID",
  ])
    assert.ok(CONCEPT_TITLE.test(yes), yes);
  for (const no of [
    "Configure peering step by step",
    "Create users and groups",
    "Manage external users",
    "Exercise - Deploy a template",
  ])
    assert.ok(!CONCEPT_TITLE.test(no), no);
});

test("batches can hold the fundamentals alone, with the group's tasks only as context", () => {
  const { candidates, pools } = candidatesFile(TASKS, { foundations: true });
  const [batch, ...rest] = buildBatches({
    candidates,
    pools,
    exam: { code: "NET-100", name: null },
    foundationsOnly: true,
  });
  assert.equal(rest.length, 0);
  assert.deepEqual(
    batch.tasks.map((t) => t.key),
    [KEY],
  );
  assert.deepEqual(batch.group.tasks, TASKS);
  assert.match(judgePrompt(batch), /## Fundamentals/);
  // without fundamentals in the candidates there is nothing to batch
  const none = candidatesFile(TASKS).candidates;
  assert.deepEqual(
    buildBatches({
      candidates: none,
      pools,
      exam: { code: "NET-100", name: null },
      foundationsOnly: true,
    }),
    [],
  );
});

const pickOf = (title, why = "", evidence = "") => ({
  target: {
    kind: "docs",
    path: "/azure/x/" + title.toLowerCase().replace(/\W+/g, "-"),
  },
  title,
  why,
  evidence,
});
const GROUP_TITLE = "Manage Microsoft Entra users and groups";
const GROUP_TASKS = [
  "Create users and groups",
  "Manage user and group properties",
  "Manage licenses in Microsoft Entra ID",
  "Manage external users",
  "Configure self-service password reset (SSPR)",
];
const indexOf = (title, why = "") =>
  taskIndexOf(pickOf(title, why), GROUP_TASKS, GROUP_TITLE);

test("a fundamentals page leads into the task whose own words it covers best, or into none when it is a general concept", () => {
  // what the whole group is about is general, product name included
  assert.equal(indexOf("Understand Microsoft Entra ID"), -1);
  assert.equal(indexOf("Users, groups, and the Microsoft Entra directory"), -1);
  assert.equal(indexOf("B2B guest user properties"), 1);
  assert.equal(indexOf("Overview of group-based licensing"), 2);
  assert.equal(indexOf("Invite external users"), 3);
  assert.equal(indexOf("Describe self-service password reset"), 4);
  // a single word of a four-word task is not enough
  assert.equal(indexOf("Reset a password"), -1);
  // the judge's reason counts as well as the title
  assert.equal(
    indexOf("Fundamentals", "Teaches how licenses are assigned."),
    2,
  );
});

test("the fundamentals come in the order a learner meets them: the general concepts, then the tasks in order", () => {
  const picks = [
    pickOf("Describe self-service password reset"),
    pickOf("Understand Microsoft Entra ID"),
    pickOf("Invite external users"),
    pickOf("Overview of group-based licensing"),
    pickOf("Create users in the portal"),
    pickOf("B2B guest user properties"),
    pickOf("Reset your password with SSPR"),
    pickOf("Compare Entra ID and Active Directory"),
  ];
  const ordered = orderFoundations(picks, GROUP_TASKS, GROUP_TITLE).map(
    (p) => p.title,
  );
  assert.deepEqual(ordered, [
    // general, in the order they came in
    "Understand Microsoft Entra ID",
    "Create users in the portal",
    "Compare Entra ID and Active Directory",
    // then the tasks, in order
    "B2B guest user properties",
    "Overview of group-based licensing",
    "Invite external users",
    "Describe self-service password reset",
    "Reset your password with SSPR",
  ]);
  assert.equal(
    picks[0].title,
    "Describe self-service password reset",
    "the input is not changed",
  );
  assert.deepEqual(orderFoundations([], GROUP_TASKS, GROUP_TITLE), []);
});

test("a built group lists its fundamentals general first and then in the order of its tasks", () => {
  const { result } = builtWithFoundations();
  const group = result.course.domains[0].groups[0];
  const buckets = group.foundations.map((p) =>
    taskIndexOf(p, TASKS, group.title),
  );
  assert.deepEqual(
    buckets,
    [...buckets].sort((a, b) => a - b),
    "the task index never goes back",
  );
  assert.ok(group.foundations.length > 1);
});

// ---- the concept pages next to a page in the documentation sidebar (learnsync's docs-toc.json)
const SIDEBAR_GROUP = [
  "/azure/virtual-network/virtual-networks-udr-overview",
  "/azure/virtual-network/concept-routing-basics",
  "/azure/virtual-network/howto-create-route",
  "/azure/virtual-network/concept-routing-old",
];
function sidebarWorld({ toc = true } = {}) {
  const world = candidateWorld();
  const page = (path, title) => {
    world.docs.push({
      title,
      url: `https://learn.microsoft.com${path}`,
      product: null,
      subproduct: null,
      description: "",
    });
    world.docPaths.add(path);
  };
  page(
    "/azure/virtual-network/concept-routing-basics",
    "How traffic is routed between virtual networks",
  );
  page("/azure/virtual-network/howto-create-route", "Add a route to a table");
  page(
    "/azure/virtual-network/concept-routing-old",
    "Routing in virtual networks (retired)",
  );
  const docsToc = toc
    ? {
        schemaVersion: 1,
        tocs: [
          {
            path: "/azure/virtual-network",
            groups: [
              { title: ["Routing"], landing: null, pages: [...SIDEBAR_GROUP] },
            ],
          },
        ],
        noToc: {},
      }
    : null;
  return { ...world, docsToc };
}
const generateSidebar = (world, options = {}) =>
  generateCandidates({
    code: "NET-100",
    guide: guideOf(TASKS),
    scope: scopeOf(world),
    pools: buildPools({ ...world, boilerplateModules: 2 }),
    options: {
      genericProductShare: 0.6,
      // the word search of the fundamentals finds nothing: the sidebar is the only way a page gets in
      foundations: { minCoverage: { P1: 1.01, P2: 1.01, P3: 1.01, P4: 1.01 } },
      ...options,
    },
  });

test("a concept page that sits next to a documentation page found for the group's tasks is a candidate of its fundamentals, and says which page it sits next to", () => {
  const result = generateSidebar(sidebarWorld());
  const f = result.foundations[0];
  const sibling = f.candidates.find(
    (c) => c.target.path === "/azure/virtual-network/concept-routing-basics",
  );
  assert.ok(sibling, f.candidates.map((c) => c.target.path).join(", "));
  assert.equal(sibling.concept, true);
  assert.equal(sibling.source, "P4");
  assert.deepEqual(sibling.target, {
    kind: "docs",
    path: "/azure/virtual-network/concept-routing-basics",
  });
  assert.deepEqual(sibling.sidebar.of, [
    "/azure/virtual-network/virtual-networks-udr-overview",
  ]);
  // a how-to page of the same group is not theory: not a candidate
  assert.ok(
    !f.candidates.some(
      (c) => c.target.path === "/azure/virtual-network/howto-create-route",
    ),
  );
  assert.equal(result.stats.foundations.sidebarSiblings, 1);
  assert.equal(result.params.sidebar, true);
});

test("a sidebar neighbour that fails a hard filter (a retired page) is dropped and counted, not offered", () => {
  const f = generateSidebar(sidebarWorld()).foundations[0];
  assert.ok(
    !f.candidates.some(
      (c) => c.target.path === "/azure/virtual-network/concept-routing-old",
    ),
  );
  assert.equal(f.dropped["sidebar-pass"].count, 1);
});

test("without the sidebar data, or with the option off, the fundamentals have no neighbours; the params say so", () => {
  const none = generateSidebar(sidebarWorld({ toc: false }));
  assert.equal(none.params.sidebar, false);
  assert.equal(none.stats.foundations.sidebarSiblings, 0);
  assert.ok(!none.foundations[0].candidates.some((c) => c.sidebar));
  const off = generateSidebar(sidebarWorld(), { sidebar: false });
  assert.equal(off.params.sidebar, false);
  assert.equal(off.stats.foundations.sidebarSiblings, 0);
});

test("the judge sees where a sidebar candidate sits, and the prompt says what that means", () => {
  const world = sidebarWorld();
  const pools = buildPools({ ...world, boilerplateModules: 2 });
  const candidates = generateSidebar(world);
  const bs = buildBatches({
    candidates,
    pools,
    exam: { code: "NET-100", name: "Network Administrator" },
  });
  const task = bs
    .flatMap((b) => b.tasks)
    .find((t) => t.foundation && t.candidates.some((c) => c.signals.sidebar));
  assert.ok(task, "a fundamentals task with a sidebar candidate");
  const c = task.candidates.find((x) => x.signals.sidebar);
  assert.deepEqual(c.signals.sidebar.of, [
    "/azure/virtual-network/virtual-networks-udr-overview",
  ]);
  assert.match(
    judgePrompt(bs[0]),
    /same group of the documentation's left sidebar/,
  );
});

test("a sidebar neighbour is offered only when the docs catalog knows it: a page the toc lists but the catalog lacks is not a candidate", () => {
  const world = sidebarWorld();
  world.docsToc.tocs[0].groups[0].pages.push(
    "/azure/virtual-network/concept-not-in-the-catalog",
  );
  const f = generateSidebar(world).foundations[0];
  assert.ok(
    f.candidates.some(
      (c) => c.target.path === "/azure/virtual-network/concept-routing-basics",
    ),
  );
  assert.ok(
    !f.candidates.some(
      (c) =>
        c.target.path === "/azure/virtual-network/concept-not-in-the-catalog",
    ),
  );
});

test("a page the exam's own modules list (P2) seeds the sidebar step whatever its coverage; the seed threshold only applies to the others", () => {
  const strict = generateSidebar(sidebarWorld(), { sidebarSeedCoverage: 1.01 });
  const sibling = strict.foundations[0].candidates.find(
    (c) => c.target.path === "/azure/virtual-network/concept-routing-basics",
  );
  assert.ok(sibling, "udr-overview is P2, so it is a seed even at 1.01");
  assert.equal(strict.params.sidebarSeedCoverage, 1.01);
  assert.equal(strict.params.sidebarCoverage, 0.15);
});
