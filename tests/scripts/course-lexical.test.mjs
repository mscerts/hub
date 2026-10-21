import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_WEIGHT,
  LexicalIndex,
  contentStems,
  queryTerms,
  stem,
  words,
  termCoverage,
} from "../../scripts/lib/course-lexical.mjs";

test("the stemmer makes route, routes, routing and routed one term, and keeps different words apart", () => {
  const forms = ["route", "routes", "routing", "routed"].map(stem);
  assert.equal(new Set(forms).size, 1);
  assert.equal(stem("define"), stem("defined"));
  assert.equal(stem("policies"), stem("policy"));
  assert.equal(stem("machines"), stem("machine"));
  assert.equal(stem("access"), "access", "ss is not a plural");
  assert.equal(stem("365"), "365");
  assert.equal(stem("networking"), stem("networks"));
  assert.notEqual(stem("storage"), stem("route"));
});

test("words splits on anything that is not a letter or digit, so user-defined is two words", () => {
  assert.deepEqual(words("Configure user-defined routes (UDR)"), [
    "configure",
    "user",
    "defined",
    "routes",
    "udr",
  ]);
  assert.deepEqual(words("It's Microsoft.Network/virtualNetworks"), [
    "its",
    "microsoft",
    "network",
    "virtualnetworks",
  ]);
  assert.deepEqual(words(null), []);
});

test("contentStems drops the stopwords and keeps the order", () => {
  assert.deepEqual(contentStems("How to use the Routes of a network"), [
    "rout",
    "network",
  ]);
});

test("a query weighs the guide's action verbs down, drops stopwords and adds the group's words as context", () => {
  const q = queryTerms("Configure user-defined routes for a network", {
    context: "Configure and manage virtual networks",
  });
  const byWord = Object.fromEntries(q.terms.map((t) => [t.word, t]));
  assert.equal(byWord.configure.weight, GENERIC_WEIGHT);
  assert.equal(byWord.user.weight, 1);
  assert.equal(byWord.routes.weight, 1);
  assert.equal(byWord.for, undefined, "stopword");
  assert.equal(byWord.virtual.context, true);
  assert.equal(byWord.virtual.weight, 0.4);
  assert.equal(byWord.manage, undefined, "a generic verb is no context");
  assert.equal(
    byWord.network.context,
    undefined,
    "a word of the task is not context",
  );
  assert.deepEqual(
    q.bigrams,
    [
      ["user", "defin"],
      ["defin", "rout"],
      ["rout", "network"],
    ],
    "neighbouring non-generic terms of the task, the verb excluded",
  );
});

test("a stem the task and its group both have keeps the task's weight", () => {
  const q = queryTerms("Manage external users", {
    context: "Manage Microsoft Entra users and groups",
  });
  const users = q.terms.filter((t) => t.term === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].weight, 1);
  assert.notEqual(users[0].context, true);
});

function index(docs, options) {
  const ix = new LexicalIndex(options);
  for (const [id, title, extra] of docs)
    ix.add(id, [
      { text: title, weight: 3, phrase: true },
      { text: extra ?? "", weight: 1 },
    ]);
  return ix.finalize();
}

const DOCS = [
  ["a", "User-defined routes overview"],
  ["b", "Create a route table", "assign user-defined routes to a subnet"],
  ["c", "Network security groups"],
  ["d", "Routes of a virtual wan"],
  ["e", "Storage accounts overview"],
];

test("a page that has the rare words ranks above one that has the common ones, and the title counts more than the description", () => {
  const ix = index(DOCS);
  const { hits } = ix.search(queryTerms("user-defined routes"), {});
  assert.deepEqual(
    hits.map((h) => h.id).slice(0, 2),
    ["a", "b"],
    "the title match first, then the description match",
  );
  assert.ok(hits[0].score > hits[1].score);
  const ids = hits.map((h) => h.id);
  assert.ok(ids.indexOf("a") < ids.indexOf("d"));
  assert.ok(!ids.includes("e"), "no shared word, not a hit");
});

test("coverage is the share of the task's terms a page contains, weighed by rarity; the group's context does not count", () => {
  const ix = index(DOCS);
  const q = queryTerms("user-defined routes", {
    context: "virtual network storage",
  });
  const { hits } = ix.search(q, {});
  const a = hits.find((h) => h.id === "a");
  assert.equal(a.coverage, 1, "all of the task's terms, context ignored");
  assert.deepEqual(
    a.matched,
    ["user defined routes"],
    "the alias group is reported as the phrase the task wrote",
  );
  const d = hits.find((h) => h.id === "d");
  assert.ok(d.coverage > 0 && d.coverage < 0.6, "only routes");
  const strict = ix.search(q, { minCoverage: 0.9 });
  assert.deepEqual(
    strict.hits.map((h) => h.id),
    ["a", "b"],
  );
});

test("a word no page has still counts against coverage, and a page that only shares the verb is no hit", () => {
  const ix = index([...DOCS, ["f", "Configure the thing"]]);
  const { hits } = ix.search(queryTerms("user-defined routes zzyzx"), {});
  assert.equal(hits[0].id, "a");
  assert.ok(hits[0].coverage < 1 && hits[0].coverage > 0.4);
  const verb = ix.search(queryTerms("Configure zzyzx"), {});
  assert.deepEqual(verb.hits, [], "the verb alone is not a match");
  const group = ix.search(
    queryTerms("zzyzx", { context: "storage accounts" }),
    {},
  );
  assert.deepEqual(group.hits, [], "the group's words alone are not a match");
});

test("a phrase in the title ranks above the same words apart", () => {
  const ix = index([
    ["apart", "Routes for every user that is defined"],
    ["phrase", "User defined routes"],
  ]);
  const { hits } = ix.search(queryTerms("user-defined routes"), {});
  assert.equal(hits[0].id, "phrase");
  assert.ok(hits[0].score > hits[1].score);
});

test("include is a silent pool filter and classify counts the pages a hard filter drops, with samples", () => {
  const ix = index(DOCS);
  const q = queryTerms("routes");
  const out = ix.search(q, {
    include: (id) => id !== "d",
    classify: (id) => (id === "b" ? "retired" : null),
  });
  assert.deepEqual(
    out.hits.map((h) => h.id),
    ["a"],
  );
  assert.equal(out.dropped.get("retired").count, 1);
  assert.equal(out.dropped.get("retired").samples[0].id, "b");
  assert.equal(
    [...out.dropped.keys()].includes("d"),
    false,
    "an excluded id is not counted as dropped",
  );
});

test("limit and scan bound the work, and a tie is broken by id so the order never changes", () => {
  const ix = index([
    ["z", "route table"],
    ["m", "route table"],
    ["a", "route table"],
  ]);
  const q = queryTerms("route table");
  assert.deepEqual(
    ix.search(q, {}).hits.map((h) => h.id),
    ["a", "m", "z"],
  );
  assert.equal(ix.search(q, { limit: 2 }).hits.length, 2);
  const scanned = ix.search(q, { scan: 1, classify: () => "no" });
  assert.equal(scanned.examined, 1);
  assert.equal(scanned.dropped.get("no").count, 1);
});

test("the index must be finalized before it is searched and cannot be added to after", () => {
  const ix = new LexicalIndex();
  ix.add("a", [{ text: "route", weight: 1 }]);
  assert.throws(() => ix.search(queryTerms("route")), /finalize/);
  ix.finalize();
  assert.throws(() => ix.add("b", [{ text: "route", weight: 1 }]), /finalized/);
  assert.equal(ix.size, 1);
});

test("an abbreviation and its long form are one concept, in a page and in a task", () => {
  assert.deepEqual(contentStems("Azure RBAC").slice(-1), ["@rbac"]);
  assert.deepEqual(
    contentStems("Overview of role-based access control").slice(-1),
    ["@rbac"],
  );
  assert.ok(contentStems("Create VMs in a VNet").includes("@vm"));
  assert.ok(contentStems("Create VMs in a VNet").includes("@vnet"));
  assert.ok(
    contentStems("Sign in to Microsoft Entra ID").includes("@entra-id"),
  );
  assert.ok(!contentStems("Storage accounts").some((s) => s.startsWith("@")));
  const abbreviation = queryTerms("Configure RBAC");
  assert.deepEqual(
    abbreviation.terms.map((t) => t.term),
    ["configur", "@rbac"],
  );
  const longForm = queryTerms(
    "Assign permissions with role-based access control",
  );
  const concept = longForm.terms.find((t) => t.term === "@rbac");
  assert.equal(concept.role, "concept");
  assert.equal(concept.word, "role based access control");
  const parts = longForm.terms.filter(
    (t) => t.group === concept.group && t.role === "part",
  );
  assert.deepEqual(
    parts.map((p) => p.word),
    ["role", "based", "access", "control"],
  );
});

test("a page with the abbreviation covers the long form, a page with some of its words covers part of it, and either way the match counts", () => {
  const ix = new LexicalIndex();
  const add = (id, title) =>
    ix.add(id, [{ text: title, weight: 3, phrase: true }]);
  add("abbreviation", "Assign Azure roles using the Azure portal - Azure RBAC");
  add("longform", "Overview of role-based access control");
  add("partial", "Access control lists");
  add("other", "Storage accounts");
  ix.finalize();
  const cover = (text) =>
    Object.fromEntries(
      ix.search(queryTerms(text), {}).hits.map((h) => [h.id, h.coverage]),
    );
  const long = cover("role-based access control");
  assert.equal(long.abbreviation, 1);
  assert.equal(long.longform, 1);
  assert.ok(long.partial > 0 && long.partial < 0.6, "only some of the words");
  assert.equal(long.other, undefined);
  const short = cover("RBAC");
  assert.equal(short.abbreviation, 1);
  assert.equal(short.longform, 1);
  assert.equal(
    short.partial,
    undefined,
    "the abbreviation alone is the whole concept",
  );
});

test("termCoverage counts a task's distinctive words in a text, can leave out the words of a group's title, and treats a long form as one", () => {
  assert.equal(termCoverage("Manage external users", "External sign-in"), 0.5);
  assert.equal(
    termCoverage("Manage", "anything"),
    1,
    "a task without distinctive words is covered",
  );
  assert.equal(termCoverage("Manage", "anything", { emptyIs: 0 }), 0);
  // the words of the group's title do not count, and neither does a long form that contains one of them
  const without = new Set(
    queryTerms("Manage Microsoft Entra users and groups").terms.map(
      (t) => t.term,
    ),
  );
  assert.equal(
    termCoverage(
      "Manage licenses in Microsoft Entra ID",
      "Understand Microsoft Entra ID",
      { without },
    ),
    0,
  );
  assert.equal(
    termCoverage(
      "Manage licenses in Microsoft Entra ID",
      "Overview of licensing",
      { without },
    ),
    1,
  );
  assert.equal(
    termCoverage(
      "Manage licenses in Microsoft Entra ID",
      "Overview of licensing",
      { without, minWordLength: 3 },
    ),
    1,
  );
});
