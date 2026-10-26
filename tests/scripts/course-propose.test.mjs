import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WHY_CHARS,
  buildProposalBatches,
  buildResolver,
  mergeProposals,
  normalizeTitle,
  probeLiveMoves,
  proposalPrompt,
  resolveProposal,
  validateProposals,
} from "../../scripts/lib/course-propose.mjs";
import {
  EXAM,
  candidatesFile,
  worldPools,
} from "./helpers/example-judging.mjs";

const T0 = "networking/configure/t0"; // Configure user-defined routes
const T1 = "networking/configure/t1"; // Manage external users

const tasks = [
  {
    key: T0,
    text: "Configure user-defined routes",
    domain: "Networking",
    group: "Configure virtual networks",
  },
  {
    key: T1,
    text: "Manage external users",
    domain: "Networking",
    group: "Configure virtual networks",
  },
  {
    key: "identity/users/t0",
    text: "Create users",
    domain: "Identity",
    group: "Manage users",
  },
];

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------
test("one batch per skill group; only the tasks go to the model", () => {
  const batches = buildProposalBatches({ tasks, exam: EXAM, guideHash: "h1" });
  assert.deepEqual(
    batches.map((b) => b.batchId),
    ["networking/configure", "identity/users"],
  );
  assert.equal(batches[0].kind, "propose");
  assert.deepEqual(batches[0].tasks, [
    { key: T0, text: "Configure user-defined routes" },
    { key: T1, text: "Manage external users" },
  ]);
  assert.deepEqual(batches[0].inputs, { guideHash: "h1" });
  assert.deepEqual(batches[0].group, {
    domain: "Networking",
    title: "Configure virtual networks",
  });
});

test("the prompt names the exam, the group and every task by its key, asks for no limit and says what happens to a wrong address", () => {
  const [batch] = buildProposalBatches({ tasks, exam: EXAM });
  const prompt = proposalPrompt(batch);
  assert.match(prompt, /NET-100: Network Administrator/);
  assert.match(prompt, /skill group \*\*Configure virtual networks\*\*/);
  assert.match(prompt, new RegExp(`\`${T0}\`: Configure user-defined routes`));
  assert.match(prompt, new RegExp(`\`${T1}\`: Manage external users`));
  assert.match(prompt, /no limit and no minimum/);
  assert.match(prompt, /Do not open files, browse or search/);
  assert.match(prompt, /a wrong guess costs nothing/);
  assert.match(prompt, /"kind": "proposals"/);
  assert.match(prompt, /"batchId": "networking\/configure"/);
  // nothing the word search found is in it
  assert.doesNotMatch(prompt, /candidate|P1|P4|score|coverage/i);
});

// ---------------------------------------------------------------------------
// Checking an answer
// ---------------------------------------------------------------------------
const [batch] = buildProposalBatches({ tasks, exam: EXAM });
const answer = (over = {}) => ({
  schemaVersion: 1,
  kind: "proposals",
  batchId: batch.batchId,
  proposedBy: "test",
  tasks: [
    { task: T0, pages: [{ path: "/azure/x", title: "X", why: "Shows how." }] },
    { task: T1, pages: [] },
  ],
  ...over,
});

test("a valid answer gives the pages of each task; a task left out has none", () => {
  const ok = validateProposals(batch, answer());
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.tasks.get(T0), [
    { path: "/azure/x", title: "X", why: "Shows how." },
  ]);
  assert.deepEqual(ok.tasks.get(T1), []);
  const left = validateProposals(
    batch,
    answer({ tasks: [{ task: T0, pages: [] }] }),
  );
  assert.deepEqual(left.problems, []);
  assert.equal(left.tasks.has(T1), false);
  // a page may have an address or a title alone
  const partial = validateProposals(
    batch,
    answer({
      tasks: [
        { task: T0, pages: [{ title: "Only a title" }, { path: "/azure/y" }] },
      ],
    }),
  );
  assert.deepEqual(partial.problems, []);
  assert.deepEqual(partial.tasks.get(T0), [
    { path: "", title: "Only a title", why: "" },
    { path: "/azure/y", title: "", why: "" },
  ]);
});

test("an answer that is not the batch's is sent back with the reason", () => {
  const problems = (file) => validateProposals(batch, file).problems;
  assert.deepEqual(problems(null), ["the answer is not a JSON object"]);
  assert.ok(
    problems(answer({ kind: "judgments" })).includes(
      'kind must be "proposals"',
    ),
  );
  assert.ok(
    problems(answer({ schemaVersion: 2 })).includes("schemaVersion must be 1"),
  );
  assert.ok(
    problems(answer({ batchId: "other" })).some((p) =>
      /batchId must be "networking\/configure"/.test(p),
    ),
  );
  assert.ok(problems(answer({ tasks: "x" })).includes("tasks must be a list"));
  assert.ok(
    problems(answer({ tasks: [{ task: "nope", pages: [] }] })).some((p) =>
      /"nope" is not a task of this batch/.test(p),
    ),
  );
  assert.ok(
    problems(
      answer({
        tasks: [
          { task: T0, pages: [] },
          { task: T0, pages: [] },
        ],
      }),
    ).some((p) => /answered twice/.test(p)),
  );
  assert.ok(
    problems(answer({ tasks: [{ task: T0, pages: "x" }] })).some((p) =>
      /pages must be a list/.test(p),
    ),
  );
  assert.ok(
    problems(answer({ tasks: [{ task: T0, pages: [{}] }] })).some((p) =>
      /needs a path or a title/.test(p),
    ),
  );
  assert.ok(
    problems(
      answer({ tasks: [{ task: T0, pages: [{ path: 3, title: "T" }] }] }),
    ).some((p) => /path must be text/.test(p)),
  );
  assert.ok(
    problems(
      answer({
        tasks: [
          {
            task: T0,
            pages: [{ path: "/a", why: "x".repeat(MAX_WHY_CHARS + 1) }],
          },
        ],
      }),
    ).some((p) => /why is over 200 characters/.test(p)),
  );
});

// ---------------------------------------------------------------------------
// Looking a page up
// ---------------------------------------------------------------------------
const { pools, world } = worldPools();
const udrNew = "/azure/virtual-network/udr-new";
// the world, plus the page the invented move points at
const movedPools = {
  ...pools,
  docMeta: new Map([
    ...pools.docMeta,
    [udrNew, { path: udrNew, title: "User-defined routes", description: "" }],
  ]),
  docPaths: new Set([...pools.docPaths, udrNew]),
};
const resolver = buildResolver(movedPools, world.redirects);
// a live page the catalog has no record of
const poolsNoText = {
  ...pools,
  docPaths: new Set([...pools.docPaths, "/azure/live/no-text"]),
};
const look = (path, title = "") => resolveProposal({ path, title }, resolver);

test("normalizeTitle compares titles by their letters and digits", () => {
  assert.equal(
    normalizeTitle("  Create, change, or delete a route-table! "),
    "create change or delete a route table",
  );
  assert.equal(normalizeTitle(null), "");
});

test("a documentation page is found by its address, however Learn's address is written", () => {
  for (const written of [
    "/azure/virtual-network/manage-route-table",
    "https://learn.microsoft.com/en-us/azure/virtual-network/manage-route-table/?view=azure-cli#section",
    "azure/virtual-network/manage-route-table",
    "/AZURE/Virtual-Network/Manage-Route-Table",
  ]) {
    const r = look(written);
    assert.equal(r.status, "ok", written);
    assert.equal(r.path, "/azure/virtual-network/manage-route-table");
    assert.equal(r.kind, "docs");
    assert.equal(r.how, "path");
  }
});

test("a page that moved is found at its new address, ahead of the old one", () => {
  const r = look("/azure/virtual-network/udr-moved");
  assert.deepEqual([r.status, r.path, r.how], ["ok", udrNew, "moved"]);
  // without the new page in the catalog the old address is the page, and a hard filter drops it
  const old = resolveProposal(
    { path: "/azure/virtual-network/udr-moved" },
    buildResolver(pools, world.redirects),
  );
  assert.deepEqual([old.status, old.reason], ["dropped", "moved"]);
});

test("a wrong address is rescued by the title, when the title names one page in the area asked for", () => {
  const r = look(
    "/azure/virtual-network/route-tables",
    "Create, change, or delete a route table",
  );
  assert.deepEqual(
    [r.status, r.path, r.how],
    ["ok", "/azure/virtual-network/manage-route-table", "title"],
  );
  // the title of the catalog ends in the product: the model's usually does not
  const product = buildResolver(
    {
      ...pools,
      docMeta: new Map([
        [
          "/azure/rbac/assign",
          {
            path: "/azure/rbac/assign",
            title: "Assign roles using the portal - Azure RBAC",
            description: "",
          },
        ],
      ]),
      docPaths: new Set(["/azure/rbac/assign"]),
    },
    [],
  );
  const p = resolveProposal(
    { path: "/azure/rbac/wrong", title: "Assign roles using the portal" },
    product,
  );
  assert.deepEqual(
    [p.status, p.path, p.how],
    ["ok", "/azure/rbac/assign", "title"],
  );
  // another area is another page
  const other = look("/entra/wrong", "Create, change, or delete a route table");
  assert.deepEqual(
    [other.status, other.reason],
    ["unresolved", "ambiguous-title"],
  );
  // a title alone is enough when it names one page
  const alone = resolveProposal(
    { title: "Create, change, or delete a route table" },
    resolver,
  );
  assert.equal(alone.path, "/azure/virtual-network/manage-route-table");
});

test("the same title on several pages: the closest address wins, a tie is not guessed", () => {
  const dup = (paths) =>
    buildResolver(
      {
        ...pools,
        docMeta: new Map(
          paths.map((p) => [
            p,
            { path: p, title: "Overview", description: "" },
          ]),
        ),
        docPaths: new Set(paths),
      },
      [],
    );
  const near = resolveProposal(
    { path: "/azure/a/b/wrong", title: "Overview" },
    dup(["/azure/a/b/one", "/azure/z/other"]),
  );
  assert.equal(near.path, "/azure/a/b/one");
  const tie = resolveProposal(
    { path: "/azure/wrong", title: "Overview" },
    dup(["/azure/a/one", "/azure/b/two"]),
  );
  assert.deepEqual([tie.status, tie.reason], ["unresolved", "ambiguous-title"]);
});

test("training modules: by address, a unit of an official module, the module of an unknown unit; learning paths are not pages", () => {
  const m = look("/training/modules/configure-peering");
  assert.deepEqual([m.status, m.kind, m.how], ["ok", "module", "path"]);
  const u = look("/training/modules/configure-peering/2-unit");
  assert.deepEqual(
    [u.status, u.kind, u.path],
    ["ok", "unit", "/training/modules/configure-peering/2-unit"],
  );
  const unknownUnit = look("/training/modules/configure-peering/99-nothing");
  assert.deepEqual(
    [unknownUnit.status, unknownUnit.kind, unknownUnit.how],
    ["ok", "module", "unit"],
  );
  assert.equal(unknownUnit.path, "/training/modules/configure-peering");
  assert.equal(look("/training/paths/some-path").reason, "not-a-page");
  assert.equal(look("/credentials/certifications/az-104").reason, "not-a-page");
  const gone = look("/training/modules/gone-routes");
  assert.deepEqual([gone.status, gone.reason], ["dropped", "removed"]);
  // a module is found by its title when the address is wrong
  const byTitle = look(
    "/training/modules/peering-wrong",
    "Configure virtual network peering",
  );
  assert.deepEqual(
    [byTitle.status, byTitle.path, byTitle.how],
    ["ok", "/training/modules/configure-peering", "title"],
  );
});

test("what does not exist, or is not allowed, is told apart", () => {
  assert.deepEqual(
    [
      look("https://example.com/x").status,
      look("https://example.com/x").reason,
    ],
    ["unresolved", "not-learn"],
  );
  assert.equal(look("http://[bad").reason, "not-an-address");
  assert.equal(
    look("/azure/virtual-network/doesnotexist", "Does not exist anywhere")
      .reason,
    "not-found",
  );
  assert.equal(look("/azure/virtual-network/doesnotexist").reason, "not-found");
  assert.equal(
    resolveProposal({ title: "No such page" }, resolver).reason,
    "no-address",
  );
  // live but nothing to read about it
  assert.equal(
    resolveProposal(
      { path: "/azure/live/no-text" },
      buildResolver(poolsNoText, []),
    ).reason,
    "no-catalog-text",
  );
  // exists, and a hard filter says no
  const retired = look("/azure/virtual-network/udr-deprecated");
  assert.deepEqual([retired.status, retired.reason], ["dropped", "retired"]);
  const ghost = look(
    "/azure/virtual-network/udr-ghost",
    "User-defined routes ghost",
  );
  assert.deepEqual([ghost.status, ghost.reason], ["dropped", "not-in-cache"]);
});

// ---------------------------------------------------------------------------
// Merging into the candidates
// ---------------------------------------------------------------------------
const answerOf = (pagesByTask) => ({
  tasks: new Map(Object.entries(pagesByTask)),
});
const page = (path, why = "", title = "") => ({ path, title, why });

function merged(pagesByTask, options = {}) {
  const { candidates } = candidatesFile(undefined, { units: "all" });
  const before = JSON.stringify(candidates);
  const result = mergeProposals({
    candidates,
    answers: [answerOf(pagesByTask)],
    pools,
    redirects: world.redirects,
    ...options,
  });
  assert.equal(
    JSON.stringify(candidates),
    before,
    "the input candidates are not changed",
  );
  return result;
}

test("a proposed page the word search had is marked, a new one becomes a P5 candidate after the others", () => {
  const { candidates, report } = merged({
    [T0]: [
      page("/azure/virtual-network/virtual-networks-udr-overview", "Overview."), // P2 already
      page("/training/modules/manage-traffic-routes"), // P1 module already
      page("/training/modules/route-between-networks/2-unit"), // P3 unit already
      page(
        "/azure/network-watcher/next-hop-overview",
        "Finds the next hop of a route.",
      ), // new docs
      page("/training/modules/configure-peering"), // new module
      page("/training/modules/configure-peering/2-unit"), // new unit
    ],
  });
  const t0 = candidates.tasks.find((t) => t.key === T0);
  const flagged = t0.candidates
    .filter((c) => c.alsoProposed)
    .map((c) => c.target.path)
    .sort();
  assert.deepEqual(flagged, [
    "/azure/virtual-network/virtual-networks-udr-overview",
    "/training/modules/manage-traffic-routes",
    "/training/modules/route-between-networks/2-unit",
  ]);
  const p5 = t0.candidates.filter((c) => c.source === "P5");
  assert.deepEqual(
    p5.map((c) => `${c.target.kind}:${c.target.path}`),
    [
      "docs:/azure/network-watcher/next-hop-overview",
      "module:/training/modules/configure-peering",
      "unit:/training/modules/configure-peering/2-unit",
    ],
  );
  assert.deepEqual(
    p5.map((c) => c.rank),
    [1, 2, 3],
  );
  assert.equal(p5[0].title, "Next hop for user-defined routes");
  assert.equal(p5[0].family, "/azure/network-watcher");
  assert.equal(p5[0].proposal.why, "Finds the next hop of a route.");
  assert.equal(p5[0].proposal.how, "path");
  assert.ok(p5[0].coverage > 0, "the word search's score is kept as a hint");
  assert.ok(
    typeof p5[1].unitSig === "string",
    "a module carries its signature",
  );
  // P5 comes after P4 in the task's list
  const order = t0.candidates.map((c) => c.source);
  assert.equal(order.at(-1), "P5");
  assert.ok(order.lastIndexOf("P4") < order.indexOf("P5"));
  // the report says what happened
  assert.equal(report.proposed, 6);
  assert.equal(report.ok, 6);
  assert.equal(report.alreadyCandidates, 3);
  assert.equal(report.added, 3);
  assert.deepEqual(report.addedByKind, { module: 1, unit: 1, docs: 1 });
  assert.equal(report.tasksWithNew, 1);
  assert.equal(report.tasksAnswered, 1);
  // the stats count the new source
  assert.equal(candidates.stats.bySource.P5, 3);
  assert.equal(
    candidates.stats.candidates,
    candidates.tasks.reduce((n, t) => n + t.candidates.length, 0),
  );
});

test("a proposed module is already there when one of its units is a candidate", () => {
  // manage-traffic-routes is a candidate of "Manage external users" only through one of its units
  const { candidates, report } = merged({
    [T1]: [page("/training/modules/manage-traffic-routes")],
  });
  assert.equal(report.alreadyCandidates, 1);
  assert.equal(report.added, 0);
  const unit = candidates.tasks
    .find((t) => t.key === T1)
    .candidates.find(
      (c) => c.target.path === "/training/modules/manage-traffic-routes/3-unit",
    );
  assert.equal(unit.alsoProposed, true);
});

test("pages that do not exist or are dropped are counted by reason and listed, never added", () => {
  const { candidates, report } = merged(
    {
      [T1]: [
        page("https://example.com/x"),
        page("/azure/virtual-network/doesnotexist", "", "No such page"),
        page("/azure/live/no-text"),
        page("/previous-versions/azure/virtual-network/udr"),
        page(
          "/azure/virtual-network/udr-ghost",
          "",
          "User-defined routes ghost",
        ),
        page("/azure/virtual-network/manage-route-table"),
        page("/azure/virtual-network/manage-route-table"), // twice
      ],
    },
    { pools: poolsNoText },
  );
  assert.equal(report.proposed, 7);
  assert.deepEqual(report.unresolved, {
    "not-learn": 1,
    "not-found": 1,
    "no-catalog-text": 1,
  });
  assert.deepEqual(report.dropped, { retired: 1, "not-in-cache": 1 });
  assert.equal(report.ok, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.added, 1);
  assert.equal(report.unresolvedPages.length, 3);
  assert.deepEqual(report.droppedPages.map((d) => d.reason).sort(), [
    "not-in-cache",
    "retired",
  ]);
  assert.deepEqual(
    candidates.tasks
      .find((t) => t.key === T1)
      .candidates.filter((c) => c.source === "P5")
      .map((c) => c.target.path),
    ["/azure/virtual-network/manage-route-table"],
  );
});

test("a page found through a move or a title says so", () => {
  const withNew = {
    ...pools,
    docMeta: movedPools.docMeta,
    docPaths: movedPools.docPaths,
  };
  const { candidates } = candidatesFile();
  const { report, candidates: out } = mergeProposals({
    candidates,
    answers: [
      answerOf({
        [T1]: [
          page("/azure/virtual-network/udr-moved"),
          page(
            "/azure/virtual-network/route-tables",
            "",
            "Create, change, or delete a route table",
          ),
        ],
      }),
    ],
    pools: withNew,
    redirects: world.redirects,
  });
  assert.deepEqual(report.how, {
    path: 0,
    moved: 1,
    live: 0,
    unit: 0,
    title: 1,
  });
  const p5 = out.tasks
    .find((t) => t.key === T1)
    .candidates.filter((c) => c.source === "P5");
  assert.deepEqual(p5.map((c) => c.proposal.how).sort(), ["moved", "title"]);
  assert.ok(
    p5.every((c) => c.proposal.asked),
    "the address the model wrote is kept",
  );
});

test("onlyNew keeps just the new P5 candidates, to judge them without the rest", () => {
  const { candidates, report } = merged(
    {
      [T0]: [
        page("/azure/virtual-network/virtual-networks-udr-overview"),
        page("/azure/network-watcher/next-hop-overview"),
      ],
    },
    { onlyNew: true },
  );
  assert.equal(report.added, 1);
  assert.deepEqual(
    candidates.tasks.flatMap((t) => t.candidates).map((c) => c.target.path),
    ["/azure/network-watcher/next-hop-overview"],
  );
  assert.equal(
    candidates.tasks.length,
    2,
    "every task stays, so a skill group keeps its tasks",
  );
  assert.equal(candidates.stats.candidates, 1);
});

test("answers for the same task from several batches add up", () => {
  const { candidates } = candidatesFile();
  const out = mergeProposals({
    candidates,
    answers: [
      answerOf({ [T1]: [page("/azure/virtual-network/manage-route-table")] }),
      answerOf({ [T1]: [page("/azure/network-watcher/next-hop-overview")] }),
    ],
    pools,
    redirects: world.redirects,
  });
  assert.equal(out.report.added, 2);
});

// ---------------------------------------------------------------------------
// Learn's own redirects
// ---------------------------------------------------------------------------
test("a move that a live request found resolves a page and is called live; a module moves too", () => {
  const live = (from, to) => ({ from, to, kind: "moved", live: true });
  const r = buildResolver(movedPools, [
    ...world.redirects,
    live(
      "/azure/virtual-network/old-route-table",
      "/azure/virtual-network/manage-route-table",
    ),
    live(
      "/training/modules/old-peering",
      "/training/modules/configure-peering",
    ),
    live(
      "/azure/virtual-network/old-page",
      "/training/modules/configure-peering",
    ),
    live(
      "/azure/virtual-network/elsewhere",
      "/azure/virtual-network/not-in-the-catalog",
    ),
  ]);
  const doc = resolveProposal(
    { path: "/azure/virtual-network/old-route-table" },
    r,
  );
  assert.deepEqual(
    [doc.status, doc.path, doc.how],
    ["ok", "/azure/virtual-network/manage-route-table", "live"],
  );
  const mod = resolveProposal({ path: "/training/modules/old-peering" }, r);
  assert.deepEqual(
    [mod.status, mod.kind, mod.path, mod.how],
    ["ok", "module", "/training/modules/configure-peering", "live"],
  );
  // a documentation address can move to a module
  const crossed = resolveProposal(
    { path: "/azure/virtual-network/old-page" },
    r,
  );
  assert.deepEqual(
    [crossed.kind, crossed.path, crossed.how],
    ["module", "/training/modules/configure-peering", "live"],
  );
  // a move to a page the catalogs do not have is no help
  assert.equal(
    resolveProposal({ path: "/azure/virtual-network/elsewhere" }, r).reason,
    "not-found",
  );
  // a move of the catalogs is still "moved"
  assert.equal(
    resolveProposal({ path: "/azure/virtual-network/udr-moved" }, r).how,
    "moved",
  );
});

test("probeLiveMoves asks Learn once for each address and keeps the ones that end up elsewhere", async () => {
  const asked = [];
  const answers = {
    "/azure/a/moved": {
      ok: true,
      url: "https://learn.microsoft.com/en-us/azure/a/new-place?view=x",
    },
    "/azure/a/here": {
      ok: true,
      url: "https://learn.microsoft.com/en-us/azure/a/here",
    },
    "/azure/a/gone": {
      ok: false,
      status: 404,
      url: "https://learn.microsoft.com/en-us/azure/a/gone",
    },
  };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    if (path === "/azure/a/down") throw new Error("socket hang up");
    return { body: { cancel: async () => {} }, ...answers[path] };
  };
  const { moves, failed } = await probeLiveMoves({
    paths: [
      "/azure/a/moved",
      "/azure/a/here",
      "/azure/a/gone",
      "/azure/a/down",
      "/azure/a/moved",
    ],
    fetchImpl,
    delayMs: 0,
  });
  assert.deepEqual(asked, [
    "/azure/a/moved",
    "/azure/a/here",
    "/azure/a/gone",
    "/azure/a/down",
  ]);
  assert.deepEqual(moves, [
    {
      from: "/azure/a/moved",
      to: "/azure/a/new-place",
      kind: "moved",
      live: true,
    },
  ]);
  assert.deepEqual(failed, [
    { path: "/azure/a/gone", status: 404 },
    { path: "/azure/a/down", error: "socket hang up" },
  ]);
});
