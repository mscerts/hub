import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULTS,
  buildPools,
  docFamily,
  generateCandidates,
  hardFilter,
  officialModuleIndex,
} from "../../scripts/lib/course-candidates.mjs";
import {
  candidateWorld,
  guideOf,
  scopeOf,
} from "./helpers/example-candidates.mjs";

// the invented world is tiny, so "generic product" (share of all modules) is read generously
const OPTIONS = { genericProductShare: 0.6 };

function run({
  tasks,
  world = candidateWorld(),
  options = {},
  withDocs = true,
}) {
  const pools = buildPools({
    catalog: world.catalog,
    courses: world.courses,
    learningPaths: world.learningPaths,
    moduleLinks: world.moduleLinks,
    docs: withDocs ? world.docs : null,
    docPaths: withDocs ? world.docPaths : null,
    redirects: withDocs ? world.redirects : null,
    boilerplateModules: 2,
  });
  return generateCandidates({
    code: "NET-100",
    guide: guideOf(tasks),
    scope: scopeOf(world),
    pools,
    options: { ...OPTIONS, ...options },
  });
}

const paths = (task, source, kind) =>
  task.candidates
    .filter((c) => c.source === source && (!kind || c.target.kind === kind))
    .map((c) => c.target.path);

test("a documentation family is the first two path segments, three for the roots that name a service deeper", () => {
  assert.equal(
    docFamily("/azure/virtual-network/x/y"),
    "/azure/virtual-network",
  );
  assert.equal(
    docFamily("/entra/id-governance/overview"),
    "/entra/id-governance",
  );
  assert.equal(docFamily("/cli/azure/vm/create"), "/cli/azure/vm");
  assert.equal(
    docFamily("/rest/api/storageservices/x"),
    "/rest/api/storageservices",
  );
  assert.equal(docFamily("/azure"), "/azure");
  assert.equal(docFamily("/"), "/");
});

test("the official modules know every course that lists them, by course number and exam", () => {
  const world = candidateWorld();
  world.courses[1].study_guide.push({ uid: "learn.manage-traffic-routes" });
  const index = officialModuleIndex({
    courses: world.courses,
    learningPaths: world.learningPaths,
    modules: world.catalog.modules,
  });
  assert.deepEqual(index.get("/training/modules/manage-traffic-routes"), [
    { number: "NET-100T00", exam: "NET-100" },
    { number: "NET-700T00", exam: "NET-700" },
  ]);
  assert.equal(index.has("/training/modules/sap-routes"), false);
});

test("P1: the exam's own module and unit, the unit as a deep link with its module", () => {
  const out = run({ tasks: ["Configure user-defined routes"] });
  const task = out.tasks[0];
  assert.equal(task.noP1, false);
  assert.equal(task.anchor.basis, "p1-top");
  assert.equal(
    task.anchor.modules[0].path,
    "/training/modules/manage-traffic-routes",
  );
  assert.deepEqual(task.anchor.families, ["/azure/virtual-network"]);
  assert.deepEqual(paths(task, "P1", "module"), [
    "/training/modules/manage-traffic-routes",
  ]);
  const unit = task.candidates.find(
    (c) => c.target.kind === "unit" && c.source === "P1",
  );
  assert.equal(unit.title, "Create custom user-defined routes");
  assert.equal(
    unit.target.path,
    "/training/modules/manage-traffic-routes/3-unit",
  );
  assert.deepEqual(unit.module, {
    path: "/training/modules/manage-traffic-routes",
    title: "Manage and control traffic flow with routes",
  });
  assert.equal(unit.unitSig, "sig-manage-traffic-routes");
  assert.deepEqual(unit.courses, ["NET-100T00"]);
  assert.ok(unit.coverage >= 0.8);
});

test("P2: a documentation page a module lists carries that module as `via`, and a page listed by many modules is boilerplate", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const overview = task.candidates.find(
    (c) =>
      c.target.path === "/azure/virtual-network/virtual-networks-udr-overview",
  );
  assert.equal(overview.source, "P2");
  assert.equal(overview.target.kind, "docs");
  assert.equal(overview.via, "/training/modules/manage-traffic-routes");
  assert.equal(overview.family, "/azure/virtual-network");
  assert.equal(
    task.candidates.some((c) => c.target.path === "/azure/community/join"),
    false,
  );
  assert.ok(task.dropped.boilerplate.count >= 1);
  assert.equal(
    task.dropped.boilerplate.samples[0].path,
    "/azure/community/join",
  );
});

test("a page found as P2 is not offered again as P4", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const all = task.candidates.map((c) => c.target.path);
  assert.equal(new Set(all).size, all.length);
  assert.ok(
    !paths(task, "P4", "docs").includes(
      "/azure/virtual-network/virtual-networks-udr-overview",
    ),
  );
});

test("P3: another exam's module and its units; P4: a module no course uses, found by its specific product", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const p3 = task.candidates.find(
    (c) => c.source === "P3" && c.target.kind === "module",
  );
  assert.equal(p3.target.path, "/training/modules/route-between-networks");
  assert.deepEqual(p3.courses, ["NET-700T00"]);
  assert.ok(
    task.candidates.some((c) => c.source === "P3" && c.target.kind === "unit"),
    "its units come too",
  );
  assert.ok(
    paths(task, "P4", "module").includes("/training/modules/routes-deep-dive"),
  );
});

test("the product constraint drops other product areas and counts them: SAP, Cosmos DB, identity governance", () => {
  const out = run({
    tasks: ["Configure user-defined routes", "Manage external users"],
  });
  const [routes, external] = out.tasks;
  const everything = (t) => t.candidates.map((c) => c.target.path);
  assert.ok(!everything(routes).includes("/training/modules/sap-routes"));
  assert.ok(!everything(routes).includes("/training/modules/cosmos-routes"));
  assert.ok(!everything(routes).includes("/azure/sap/workloads/routes"));
  assert.ok(routes.dropped["out-of-scope-product"].count >= 3);
  // the entitlement management module belongs to another exam's job: not for an external users task
  assert.ok(
    !everything(external).includes("/training/modules/plan-entitlement"),
  );
  assert.ok(
    !everything(external).includes(
      "/entra/id-governance/entitlement-management-external-users",
    ),
  );
  const dropped = external.dropped["out-of-scope-product"];
  assert.ok(dropped.count >= 2);
  assert.ok(
    dropped.samples.some((s) =>
      /plan-entitlement|entitlement-management/.test(s.path),
    ),
  );
});

test("every hard filter drops its page and counts it by reason", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const reason = (r) => task.dropped[r]?.samples.map((s) => s.path) ?? [];
  assert.ok(
    reason("retired").includes("/previous-versions/azure/virtual-network/udr"),
  );
  assert.ok(
    reason("retired").includes("/azure/virtual-network/udr-deprecated"),
  );
  assert.deepEqual(reason("moved"), ["/azure/virtual-network/udr-moved"]);
  assert.deepEqual(reason("not-in-cache"), [
    "/azure/virtual-network/udr-ghost",
  ]);
  assert.deepEqual(reason("not-english"), ["/azure/virtual-network/udr-ja"]);
  assert.deepEqual(reason("removed"), ["/training/modules/gone-routes"]);
  const everything = task.candidates.map((c) => c.target.path);
  for (const path of [
    "/previous-versions/azure/virtual-network/udr",
    "/azure/virtual-network/udr-deprecated",
    "/azure/virtual-network/udr-moved",
    "/azure/virtual-network/udr-ghost",
    "/azure/virtual-network/udr-ja",
    "/training/modules/gone-routes",
  ])
    assert.ok(!everything.includes(path), path);
});

test("hardFilter on its own: locale, retired markers, cache, moves and boilerplate", () => {
  const pools = buildPools({
    ...candidateWorld(),
    docs: candidateWorld().docs,
    docPaths: candidateWorld().docPaths,
    redirects: candidateWorld().redirects,
    boilerplateModules: 2,
  });
  const ask = (kind, path, title) => hardFilter({ kind, path, title }, pools);
  assert.equal(ask("docs", "/ja-jp/azure/x", "Routes"), "not-english");
  assert.equal(ask("docs", "/azure/x", "Retired: routes"), "retired");
  assert.equal(ask("docs", "/azure/x", "Routes [deprecated]"), "retired");
  assert.equal(
    ask("module", "/training/modules/x", "Retirement of routes"),
    null,
  );
  assert.equal(
    ask("docs", "/azure/virtual-network/udr-moved", "Routes"),
    "moved",
  );
  assert.equal(ask("docs", "/azure/community/join", "Join"), "boilerplate");
  assert.equal(
    ask("docs", "/azure/virtual-network/udr-ghost", "Routes"),
    "not-in-cache",
  );
  assert.equal(ask("module", "/training/modules/x", "Routes"), null);
});

test("a task the exam's own course does not cover is anchored on the whole exam and says so", () => {
  const task = run({
    tasks: ["Configure cost alerts"],
    options: { groupCoverage: 2 },
  }).tasks[0];
  assert.equal(task.anchor.basis, "exam");
  assert.deepEqual(task.anchor.modules, []);
  assert.equal(task.noP1, true);
  assert.deepEqual(task.candidates, []);
});

test("a task with no module of its own is offered the modules of its skill group, marked as such", () => {
  const out = run({ tasks: ["Configure cost alerts"] });
  const task = out.tasks[0];
  assert.equal(task.noP1, true, "still says the task has no module of its own");
  assert.equal(task.viaGroup, true);
  assert.ok(task.candidates.length > 0);
  for (const c of task.candidates) {
    assert.equal(c.source, "P1");
    assert.equal(c.target.kind, "module");
    assert.equal(c.viaGroup, true);
  }
  assert.equal(
    task.candidates[0].target.path,
    "/training/modules/configure-peering",
    '"Configure virtual networks" is the group',
  );
  // a task with a module of its own is not offered the group's
  const own = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  assert.equal(own.viaGroup, undefined);
  assert.ok(own.candidates.every((c) => !c.viaGroup));
});

test("without a good module of its own a task may use other families of the exam's roots, but must cover the task much better", () => {
  const next = "/azure/network-watcher/next-hop-overview";
  const other = "/power-platform/admin/routes";
  const weak = (task) =>
    run({ tasks: [task], options: { anchorCoverage: 2 } }).tasks[0]; // forced: no module counts as an anchor
  const routes = weak("Configure user-defined routes");
  assert.equal(routes.anchor.basis, "exam");
  const strong = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  assert.ok(!strong.candidates.some((c) => c.target.path === next));
  assert.ok(strong.dropped["out-of-scope-product"].samples.length > 0);
  for (const c of routes.candidates.filter(
    (c) => c.source === "P4" || c.source === "P3",
  ))
    assert.ok(c.coverage >= 0.8, `${c.target.path} covers ${c.coverage}`);
  // a family no module of the exam lists is demoted: it is flagged and ranks after the pages of the exam's own
  // families (nothing is cut for being lower, but the judge and the gates see the flag)...
  const own = routes.candidates.find(
    (c) => c.target.path === "/azure/virtual-network/manage-route-table",
  );
  const foreign = routes.candidates.find((c) => c.target.path === next);
  assert.ok(own, "a page of the exam's own families is listed");
  assert.equal(own.foreignFamily, undefined);
  assert.equal(foreign.foreignFamily, true);
  assert.ok(foreign.rank > own.rank, "demoted below the exam's own pages");
  // ...but it shows when nothing from them covers the task, marked
  const hop = weak("Configure next hop");
  const neighbour = hop.candidates.find((c) => c.target.path === next);
  assert.ok(neighbour, "a neighbouring family under /azure is allowed");
  assert.equal(neighbour.source, "P4");
  assert.equal(
    neighbour.foreignFamily,
    true,
    "marked: no module of the exam lists that family",
  );
  // a root the exam does not touch stays out either way
  for (const task of [routes, hop])
    assert.ok(!task.candidates.some((c) => c.target.path === other));
  assert.ok(routes.dropped["out-of-scope-product"].count > 0);
});

test("a candidate inside the anchor is flagged and ranks above one outside it", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const docs = task.candidates.filter(
    (c) => c.source === "P4" && c.target.kind === "docs",
  );
  assert.ok(docs.length > 0);
  for (const c of docs)
    assert.equal(
      c.anchored,
      c.family === "/azure/virtual-network",
      c.target.path,
    );
  assert.equal(
    task.candidates.find((c) => c.source === "P1").anchored,
    undefined,
  );
});

test("ranks run 1.. inside each provenance and kind, scores are rounded and the matched words are task words", () => {
  const task = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  const groups = new Map();
  for (const c of task.candidates) {
    const key = `${c.source} ${c.target.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), c.rank]);
    assert.equal(c.score, Math.round(c.score * 100) / 100);
    for (const w of c.matched) assert.ok(/^[a-z ]+$/.test(w));
  }
  for (const ranks of groups.values())
    assert.deepEqual(
      ranks,
      ranks.map((_, i) => i + 1),
    );
});

test("the result is the same every time, plain data, and echoes what it was built from", () => {
  const first = run({
    tasks: ["Configure user-defined routes", "Manage external users"],
  });
  const second = run({
    tasks: ["Configure user-defined routes", "Manage external users"],
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.inputs.guideHash, "guide-hash");
  assert.match(first.inputs.scopeFingerprint, /^[0-9a-f]{40}$/);
  assert.equal(first.inputs.docsCatalog, true);
  assert.equal(first.stats.tasks, 2);
  assert.equal(
    first.stats.candidates,
    first.tasks.reduce((n, t) => n + t.candidates.length, 0),
  );
  assert.deepEqual(first.exam.families, [
    "/azure/virtual-network",
    "/entra/identity",
  ]);
});

test("without the documentation catalog only the pages modules list are candidates, and it says so", () => {
  const out = run({
    tasks: ["Explain virtual network traffic routing"],
    withDocs: false,
  });
  assert.ok(out.warnings.some((w) => /no docs-catalog\.json/.test(w)));
  assert.ok(out.warnings.some((w) => /no docs-urls\.txt/.test(w)));
  const task = out.tasks[0];
  assert.deepEqual(paths(task, "P4", "docs"), []);
  const overview = task.candidates.find((c) => c.source === "P2");
  assert.equal(overview.titleFromLink, true, "the title is the link text");
});

test("an exam with no official course gets no P1 or P2, and a warning", () => {
  const world = candidateWorld();
  const pools = buildPools({
    catalog: world.catalog,
    courses: world.courses,
    learningPaths: world.learningPaths,
    moduleLinks: world.moduleLinks,
    docs: world.docs,
    docPaths: world.docPaths,
    redirects: world.redirects,
  });
  const out = generateCandidates({
    code: "ZZ-999",
    guide: guideOf(["Configure user-defined routes"]),
    scope: scopeOf(world, "ZZ-999"),
    pools,
    options: OPTIONS,
  });
  assert.ok(out.warnings.some((w) => /no official course/.test(w)));
  assert.equal(out.tasks[0].noP1, true);
  assert.equal(
    out.tasks[0].candidates.filter((c) => c.source === "P2").length,
    0,
  );
});

test("nothing is limited by default: every relevant page is a candidate, however many there are", () => {
  // forced weak anchor: eleven documentation pages cover the task, more than the 6 the old default allowed
  const out = run({
    tasks: ["Configure user-defined routes"],
    options: { anchorCoverage: 2 },
  });
  assert.equal(paths(out.tasks[0], "P4", "docs").length, 11);
  const capped = run({
    tasks: ["Configure user-defined routes"],
    options: { anchorCoverage: 2, limits: { p4Docs: 6 } },
  });
  assert.equal(paths(capped.tasks[0], "P4", "docs").length, 6);
  for (const [name, value] of Object.entries(out.params.limits))
    assert.equal(value, null, `${name} has no limit (null in the file)`);
  assert.equal(out.params.scan, null);
  assert.equal(out.params.relativeFloor, 0);
  assert.ok(Object.values(DEFAULTS.limits).every((n) => n === Infinity));
});

test("a limit can still be asked for, to look at a short list", () => {
  const out = run({
    tasks: ["Configure user-defined routes"],
    options: { limits: { p4Docs: 1, p1Unit: 1 } },
  });
  const task = out.tasks[0];
  assert.ok(paths(task, "P4", "docs").length <= 1);
  assert.ok(paths(task, "P1", "unit").length <= 1);
  assert.equal(out.params.limits.p4Docs, 1);
  assert.equal(out.params.limits.p2Docs, null, "the others stay unlimited");
});

test("a task that finds nothing is searched once more with the thresholds scaled down, and says so", () => {
  const strict = { P1: 0.95, P2: 0.95, P3: 0.95, P4: 0.95 };
  const tasks = ["Configure user-defined routes, billing alerts and budgets"];
  const first = run({
    tasks,
    options: { minCoverage: strict, relaxFactor: 1, groupCoverage: 2 },
  }).tasks[0];
  assert.deepEqual(first.candidates, [], "no page covers all of it");
  assert.equal(first.relaxed, undefined);
  const second = run({
    tasks,
    options: { minCoverage: strict, relaxFactor: 0.2, groupCoverage: 2 },
  }).tasks[0];
  assert.equal(second.relaxed, true);
  assert.ok(second.candidates.length > 0);
  for (const c of second.candidates) {
    assert.equal(c.relaxed, true);
    assert.ok(c.coverage >= 0.19, `${c.target.path} covers ${c.coverage}`);
  }
  // a task that found something in the first pass is not searched again
  const found = run({ tasks: ["Configure user-defined routes"] }).tasks[0];
  assert.equal(found.relaxed, undefined);
});

test("a module without documentation links is placed by the pages that best match its title, not by its product tag", () => {
  const sap = "/training/modules/mislabeled-sap";
  const task = "Configure user-defined routes";
  // tagged "Virtual Network" like the exam's own modules: with no documentation catalog the tag is all there is
  const byTag = run({ tasks: [task], withDocs: false }).tasks[0];
  assert.ok(paths(byTag, "P4", "module").includes(sap));
  // with it, the pages that match its title (/azure/sap/...) say what it is about
  const byPages = run({ tasks: [task] }).tasks[0];
  assert.ok(!paths(byPages, "P4", "module").includes(sap));
  assert.ok(byPages.dropped["out-of-scope-product"].count >= 1);
  assert.ok(
    paths(byPages, "P4", "module").includes(
      "/training/modules/routes-deep-dive",
    ),
  );
});

test("a module that one of the exam's modules recommends ranks higher and says who recommends it", () => {
  const task = "Configure user-defined routes";
  const find = (out) =>
    out.tasks[0].candidates.find(
      (c) =>
        c.source === "P3" &&
        c.target.path === "/training/modules/route-between-networks",
    );
  const boosted = find(run({ tasks: [task] }));
  const plain = find(run({ tasks: [task], options: { recommendBoost: 1 } }));
  assert.deepEqual(boosted.recommendedBy, [
    "/training/modules/configure-peering",
  ]);
  assert.deepEqual(
    plain.recommendedBy,
    boosted.recommendedBy,
    "the fact is stated whatever the boost",
  );
  assert.ok(Math.abs(boosted.score / plain.score - 1.3) < 0.02);
  const unit = run({ tasks: [task] }).tasks[0].candidates.find(
    (c) => c.source === "P3" && c.target.kind === "unit",
  );
  assert.deepEqual(unit.recommendedBy, ["/training/modules/configure-peering"]);
});

test("a section of a family that no module of the exam lists ranks lower and is marked", () => {
  const world = candidateWorld();
  const pools = buildPools({
    ...world,
    boilerplateModules: 2,
  });
  assert.equal(
    pools.sectionOf("/azure/virtual-network/customers/udr-1"),
    "/azure/virtual-network/customers",
  );
  assert.equal(
    pools.sectionOf("/azure/virtual-network/manage-route-table"),
    "/azure/virtual-network",
    "a page directly under the family has no section",
  );
  assert.equal(
    pools.sectionOf("/azure/sap/workloads/routes"),
    "/azure/sap",
    "fewer than five pages: not a section",
  );
  assert.equal(pools.sectionOf("/cli/azure/vm/create"), "/cli/azure/vm");
  const task = "Configure user-defined routes";
  const docsOf = (out) =>
    out.tasks[0].candidates.filter(
      (c) => c.source === "P4" && c.target.kind === "docs",
    );
  const marked = docsOf(run({ tasks: [task] }));
  const customers = marked.filter((c) => c.target.path.includes("/customers/"));
  assert.ok(customers.length > 0);
  for (const c of customers) assert.equal(c.siblingSection, true);
  for (const c of marked.filter((c) => !c.target.path.includes("/customers/")))
    assert.equal(c.siblingSection, undefined);
  const plain = docsOf(
    run({ tasks: [task], options: { siblingSectionFactor: 1 } }),
  );
  const first = (list) =>
    list.find((c) => c.target.path === customers[0].target.path);
  assert.ok(Math.abs(first(marked).score / first(plain).score - 0.6) < 0.02);
  assert.ok(
    run({ tasks: [task] }).exam.sections.includes("/azure/virtual-network"),
  );
});
