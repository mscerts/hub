import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  fetchRetry,
  loadConfig,
  pickModulesToRead,
  run,
  signatureOf,
} from "../../scripts/lab-registry-sync.mjs";
import {
  buildReport,
  buildUniverse,
  cardIndex,
  checkLabPages,
  classifyDocs,
  classifyModule,
  classifyUnit,
  comparable,
  covers,
  demoHostsIn,
  docsFamily,
  emptyRegistry,
  examOfLabPage,
  examsByModule,
  familiesFromContent,
  familiesFromModuleLinks,
  isUnitPath,
  keyOf,
  labPageCards,
  moduleOf,
  parseRegistry,
  serializeRegistry,
  stripPosition,
  summarize,
  syncRegistry,
  worklist,
} from "../../scripts/lib/lab-registry.mjs";

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
test("a unit's key has no position number, a module's and a docs page's key is the plain address", () => {
  assert.equal(
    stripPosition("/training/modules/a/6-exercise-x"),
    "/training/modules/a/exercise-x",
  );
  // Learn's own letters after the number ("7a-") stay: they tell two units apart.
  assert.equal(
    stripPosition("/training/modules/a/7a-exercise"),
    "/training/modules/a/7a-exercise",
  );
  assert.equal(
    keyOf(
      "https://learn.microsoft.com/en-us/training/modules/a/6-Exercise-X/?WT.mc_id=studentamb_165290",
      { unit: true },
    ),
    "/training/modules/a/exercise-x",
  );
  assert.equal(
    keyOf("https://learn.microsoft.com/azure/virtual-network/quickstart/"),
    "/azure/virtual-network/quickstart",
  );
  assert.equal(moduleOf("/training/modules/a/6-x"), "/training/modules/a");
  assert.equal(moduleOf("/training/modules/a"), "/training/modules/a");
  assert.equal(moduleOf("/training/saas/b/x"), "/training/saas/b");
  assert.equal(moduleOf("/training/paths/a"), null);
  assert.equal(moduleOf("/azure/x"), null);
  assert.equal(isUnitPath("/training/modules/a/6-x"), true);
  assert.equal(isUnitPath("/training/modules/a"), false);
});

// ---------------------------------------------------------------------------
// What counts as hands-on
// ---------------------------------------------------------------------------
test("the unit rules: exercise by title, exercise by address, lab, simulation, demonstration; reading is not", () => {
  const unit = (title, slug, moduleTitle = "A module") =>
    classifyUnit({
      unitPath: `/training/modules/m/${slug}`,
      title,
      moduleTitle,
    });
  assert.equal(
    unit("Exercise - Create a VM", "3-exercise-create-vm"),
    "exercise",
  );
  assert.equal(unit("Optional exercise: tune it", "4-tune"), "exercise");
  assert.equal(unit("Lab - Configure DNS", "5-lab-dns"), "lab");
  assert.equal(unit("Simulation - Create a policy", "6-sim"), "simulation");
  // The title lacks the word, the address has it.
  assert.equal(
    unit("Monitor VM host data", "3-exercise-create-virtual-machine"),
    "exercise",
  );
  assert.equal(
    unit(
      "Tour and use the Power BI service",
      "4-exercise-touring-and-using-power-bi",
    ),
    "exercise",
  );
  // ... except a set-up unit.
  assert.equal(
    unit(
      "Prepare for the exercises - Set up your environment",
      "prepare-exercises",
    ),
    null,
  );
  // Demonstrations: the title starts with it, or the address does ("5-demo-manage-...").
  assert.equal(
    unit("Demonstration - Create a fixed asset", "9-demo"),
    "demonstration",
  );
  assert.equal(
    unit("Demo of the maker portal experience", "2-demo"),
    "demonstration",
  );
  assert.equal(
    unit("Demo: Troubleshoot access", "5-troubleshoot-demo"),
    "demonstration",
  );
  assert.equal(
    unit("Explore pass-through authentication", "5-demo-manage-pass-through"),
    "demonstration",
  );
  // Not a demonstration: a demo company or a demo site.
  assert.equal(
    unit("Set up a demo company with sample data", "4-set-up-demo-company"),
    null,
  );
  assert.equal(
    unit("Deploy an agent to the demo website", "3-deploy-demo-website"),
    null,
  );
  // Reading.
  assert.equal(unit("Introduction", "1-introduction"), null);
  assert.equal(unit("Knowledge check", "7-knowledge-check"), null);
  assert.equal(
    unit("Understand DLP deployment and simulation mode", "x"),
    null,
  );
  // The units of a project are not entries: the module is.
  assert.equal(
    classifyUnit({
      unitPath: "/training/modules/guided-project-x/2-step",
      title: "Build the API",
      moduleTitle: "Guided project - Build an API",
    }),
    null,
  );
  assert.equal(
    classifyModule({
      path: "/training/modules/guided-project-x",
      title: "Guided project - Build an API",
    }),
    "guided project",
  );
  assert.equal(
    classifyModule({
      path: "/training/modules/c",
      title: "Challenge Project - Secure it",
    }),
    "challenge project",
  );
  assert.equal(
    classifyModule({ path: "/training/modules/c", title: "Concepts" }),
    null,
  );
  // A module that is one guided exercise is an exercise as a whole.
  assert.equal(
    classifyModule({
      path: "/training/modules/guided-exercise-manage-arc",
      title: "Guided exercise - Manage servers by using Azure Arc",
    }),
    "exercise",
  );
});

test("docs tutorials and quickstarts count in a family the hub uses, without the Entra app gallery", () => {
  const families = new Set(["azure/virtual-network", "entra/identity"]);
  assert.equal(
    docsFamily("/azure/virtual-network/quick-create-portal"),
    "azure/virtual-network",
  );
  assert.equal(
    classifyDocs(
      {
        path: "/azure/virtual-network/quick-create-portal",
        title: "Create a virtual network",
      },
      families,
    ),
    "quickstart",
  );
  assert.equal(
    classifyDocs(
      {
        path: "/azure/virtual-network/tutorial-filter",
        title: "Tutorial: Filter traffic",
      },
      families,
    ),
    "tutorial",
  );
  assert.equal(
    classifyDocs(
      { path: "/azure/other-product/quickstart-x", title: "Quickstart: X" },
      families,
    ),
    null,
    "a family the hub does not use",
  );
  assert.equal(
    classifyDocs(
      {
        path: "/entra/identity/saas-apps/box-tutorial",
        title: "Tutorial: Integrate Box",
      },
      families,
    ),
    null,
    "the app gallery tutorials",
  );
  for (const title of [
    "Azure Vision documentation - Quickstarts, Tutorials, API Reference - Foundry Tools",
    "Deployment Overview",
    "Overview of How to Deploy a Python Web App",
    "Password Policy Overview and Frequently Asked Questions",
  ])
    assert.equal(
      classifyDocs(
        { path: "/azure/virtual-network/tutorial-x", title },
        families,
      ),
      null,
      `${title}: a landing or overview page`,
    );
  assert.equal(
    classifyDocs(
      {
        path: "/azure/virtual-network/tutorial-overview-events",
        title: "Monitor capacity with Capacity Overview Events",
      },
      families,
    ),
    "tutorial",
    "overview in the middle of a title is not a landing page",
  );
  assert.equal(
    classifyDocs(
      { path: "/entra/identity/enterprise-apps/overview", title: "Overview" },
      families,
    ),
    null,
  );
  assert.deepEqual(
    [
      ...familiesFromContent([
        "[a](https://learn.microsoft.com/en-us/azure/virtual-network/overview?WT.mc_id=x) [b](https://learn.microsoft.com/training/modules/y) [c](https://learn.microsoft.com/credentials/z) https://learn.microsoft.com/entra/identity/x/y",
      ]),
    ].sort(),
    ["azure/virtual-network", "entra/identity"],
  );
});

test("the docs families of the exam courses are the ones their modules link, docs links only", () => {
  const moduleLinks = {
    modules: [
      {
        path: "/training/modules/a",
        links: [
          { kind: "docs", path: "/azure/virtual-network/overview" },
          { kind: "docs", path: "/entra/identity/x/y" },
          { kind: "external", url: "https://example.com/azure/zzz/x" },
          { kind: "training", path: "/training/modules/b" },
        ],
      },
      {
        path: "/training/modules/other",
        links: [{ kind: "docs", path: "/azure/skipped/x" }],
      },
    ],
  };
  assert.deepEqual(
    [...familiesFromModuleLinks(moduleLinks, ["/training/modules/a"])].sort(),
    ["azure/virtual-network", "entra/identity"],
  );
  assert.deepEqual(
    [...familiesFromModuleLinks(null, ["/training/modules/a"])],
    [],
  );
});

test("demo hosts are found by address in the page text", () => {
  assert.deepEqual(
    demoHostsIn(
      '<a href="https://mslearn.cloudguides.com/guides/x?azure-portal=true">go</a>',
    ),
    ["cloudguides"],
  );
  assert.deepEqual(
    demoHostsIn("https://app.highlights.guide/start/abc?link=0&amp;token=t"),
    ["highlights"],
  );
  assert.deepEqual(
    demoHostsIn(
      "see https://www.cloudguides.com/series/x and https://app.highlights.guide/start/y",
    ),
    ["cloudguides", "highlights"],
  );
  assert.deepEqual(
    demoHostsIn("<p>nothing cloudguides.com here without a scheme</p>"),
    [],
  );
  assert.deepEqual(demoHostsIn("https://notcloudguides.com.example/x"), []);
});

// ---------------------------------------------------------------------------
// The universe
// ---------------------------------------------------------------------------
const mod = (slug, title, units, extra = {}) => ({
  uid: `learn.${slug}`,
  path: `/training/modules/${slug}`,
  title,
  units: units.map((u) => u[0]),
  unitUrls: units.map((u) => `/training/modules/${slug}/${u[1]}`),
  unitSig: `sig-${slug}`,
  ...extra,
});

const CATALOG = {
  lastChecked: "2026-10-20T00:00:00Z",
  modules: [
    mod("admin-basics", "Administer the basics", [
      ["Introduction", "1-introduction"],
      ["Exercise - Create a VM", "2-exercise-create-vm"],
      ["Knowledge check", "3-knowledge-check"],
      ["Monitor VM data", "4-exercise-monitor-vm"],
      ["Prepare for the exercises", "5-prepare-exercises"],
    ]),
    mod("guided-project-build-api", "Guided project - Build an API", [
      ["Introduction", "1-introduction"],
      ["Build the API", "2-build"],
    ]),
    mod("concepts", "Concepts", [
      ["Introduction", "1-introduction"],
      ["Summary", "2-summary"],
    ]),
    mod("guests-demo", "Guest users", [
      ["Introduction", "1-introduction"],
      ["Demo - manage guest users", "2-demo-guest-users"],
    ]),
    mod("copilot-tour", "Tour of Copilot", [
      ["Introduction", "1-introduction"],
      ["Explore the capabilities of Copilot", "2-explore-capabilities"],
    ]),
  ],
};
const SKILLS = {
  active: [
    {
      name: "Deploy Azure Monitor",
      url: "https://learn.microsoft.com/credentials/applied-skills/deploy-azure-monitor/?WT.mc_id=studentamb_165290",
      products: ["Azure"],
      labPages: ["labs/azure/az-104"],
    },
  ],
  new: [],
  retiring: [
    {
      name: "Old skill",
      url: "https://learn.microsoft.com/credentials/applied-skills/old-skill/?WT.mc_id=studentamb_165290",
      products: [],
      labPages: [],
    },
  ],
};

test("the universe holds the hands-on pages: units, project modules, listed Applied Skills and docs of a used family", () => {
  const docs = [
    {
      title: "Tutorial: Filter traffic",
      url: "https://learn.microsoft.com/azure/virtual-network/tutorial-filter",
    },
    {
      title: "Overview",
      url: "https://learn.microsoft.com/azure/virtual-network/overview",
    },
    {
      title: "Tutorial: Other",
      url: "https://learn.microsoft.com/azure/other/tutorial-x",
    },
    {
      title: "Tutorial: Box",
      url: "https://learn.microsoft.com/entra/identity/saas-apps/box-tutorial",
    },
    { title: "Hub", url: "https://docs.github.com/tutorial-x" },
  ];
  const { entries, modules, stats } = buildUniverse({
    catalog: CATALOG,
    docs,
    skills: SKILLS,
    families: new Set(["azure/virtual-network", "entra/identity"]),
  });
  assert.deepEqual(
    [...entries.keys()].sort(),
    [
      "/azure/virtual-network/tutorial-filter",
      "/credentials/applied-skills/deploy-azure-monitor",
      "/training/modules/admin-basics/exercise-create-vm",
      "/training/modules/admin-basics/exercise-monitor-vm",
      "/training/modules/guests-demo/demo-guest-users",
      "/training/modules/guided-project-build-api",
    ].sort(),
  );
  assert.equal(
    entries.get("/training/modules/guided-project-build-api").kind,
    "module",
  );
  assert.equal(
    entries.get("/training/modules/admin-basics/exercise-monitor-vm").why,
    "exercise",
  );
  assert.equal(
    entries.get("/training/modules/guests-demo/demo-guest-users").why,
    "demonstration",
  );
  assert.equal(
    entries.get("/azure/virtual-network/tutorial-filter").why,
    "tutorial",
  );
  assert.deepEqual(stats, { units: 3, projects: 1, docs: 1, skills: 1 });
  assert.equal(modules.length, 5);
  assert.equal(modules[0].units.length, 5);
  assert.equal(
    modules[0].units[1].key,
    "/training/modules/admin-basics/exercise-create-vm",
  );
});

// ---------------------------------------------------------------------------
// Lab page cards and coverage
// ---------------------------------------------------------------------------
test("a lab page covers an entry by the unit at any position, by its module, or by the same address", () => {
  const mdx = `
{/* <LinkCard title="Commented" href="https://learn.microsoft.com/training/modules/hidden/1-exercise" /> */}
<LinkCard title="A" href="https://learn.microsoft.com/training/modules/admin-basics/9-exercise-create-vm?WT.mc_id=studentamb_165290" />
<LinkCard title="B" href="https://learn.microsoft.com/training/modules/whole-module/?WT.mc_id=studentamb_165290" />
<LinkCard title="C" href="https://learn.microsoft.com/training/modules/guided-project-build-api/3-step" />
<LinkCard title="D" href="https://learn.microsoft.com/azure/virtual-network/tutorial-filter" />
<LinkCard title="E" href="https://github.com/MicrosoftLearning/x" />
`;
  const cards = labPageCards(mdx);
  assert.deepEqual([...cards].sort(), [
    "/azure/virtual-network/tutorial-filter",
    "/training/modules/admin-basics/9-exercise-create-vm",
    "/training/modules/guided-project-build-api/3-step",
    "/training/modules/whole-module",
  ]);
  const index = cardIndex(cards);
  const unit = (key) => ({ kind: "unit", key });
  assert.equal(
    covers(unit("/training/modules/admin-basics/exercise-create-vm"), index),
    true,
  );
  assert.equal(
    covers(unit("/training/modules/admin-basics/exercise-other"), index),
    false,
  );
  assert.equal(
    covers(unit("/training/modules/whole-module/exercise-anything"), index),
    true,
    "a module link covers its units",
  );
  assert.equal(
    covers(
      { kind: "module", key: "/training/modules/guided-project-build-api" },
      index,
    ),
    true,
    "any unit of a project",
  );
  assert.equal(
    covers({ kind: "module", key: "/training/modules/other-project" }, index),
    false,
  );
  assert.equal(
    covers(
      { kind: "docs", key: "/azure/virtual-network/tutorial-filter" },
      index,
    ),
    true,
  );
  assert.equal(
    covers(
      { kind: "applied-skill", key: "/credentials/applied-skills/x" },
      index,
    ),
    false,
  );
  assert.equal(examOfLabPage("labs/azure/az-104"), "AZ-104");
  assert.equal(examOfLabPage("labs/azure/labtemplate"), null);
});

// ---------------------------------------------------------------------------
// The registry file
// ---------------------------------------------------------------------------
const entry = (key, extra = {}) => ({
  key,
  kind: "unit",
  why: "exercise",
  title: key,
  path: key,
  exams: {},
  state: "new",
  firstSeen: "2026-10-21",
  ...extra,
});

test("the registry round-trips as one entry per line, sorted by key, and refuses what is wrong", () => {
  const registry = {
    ...emptyRegistry(),
    lastSynced: "2026-10-21",
    reported: { signature: "abc", date: "2026-10-21" },
    scanned: { "/training/modules/b": "s2", "/training/modules/a": "s1" },
    entries: [
      entry("/training/modules/b/exercise-b", {
        exams: { "AZ-104": "course" },
        state: "active",
      }),
      entry("/training/modules/a/exercise-a", {
        demo: ["cloudguides"],
        skip: ["AZ-305"],
      }),
    ],
  };
  const text = serializeRegistry(registry);
  assert.ok(text.indexOf("exercise-a") < text.indexOf("exercise-b"));
  assert.equal(text.split("\n").filter((l) => l.startsWith("    {")).length, 2);
  const back = parseRegistry(text);
  assert.equal(serializeRegistry(back), text);
  assert.deepEqual(Object.keys(back.scanned), [
    "/training/modules/a",
    "/training/modules/b",
  ]);
  assert.equal(
    comparable({ ...registry, lastSynced: "2027-01-01" }),
    comparable(registry),
  );
  assert.notEqual(
    comparable({ ...registry, reported: null }),
    comparable(registry),
  );

  const bad = (change, message) => {
    const copy = JSON.parse(JSON.stringify(back));
    change(copy);
    assert.throws(() => parseRegistry(JSON.stringify(copy)), message);
  };
  assert.throws(() => parseRegistry("{"), /not valid JSON/);
  assert.throws(
    () => parseRegistry(JSON.stringify({ schemaVersion: 9, entries: [] })),
    /schemaVersion/,
  );
  bad((r) => (r.entries[1].exams = { "az-104": "course" }), /not an exam code/);
  bad((r) => (r.entries[1].exams = { "AZ-104": "guess" }), /unknown origin/);
  bad((r) => (r.entries[0].state = "active"), /needs an exam/);
  bad((r) => (r.entries[0].kind = "page"), /unknown kind/);
  bad((r) => (r.entries[0].why = "reading"), /unknown why/);
  bad((r) => (r.entries[0].state = "done"), /unknown state/);
  bad((r) => r.entries.push({ ...r.entries[0] }), /appears twice/);
  bad((r) => (r.entries[0].key = "training/x"), /canonical address/);
});

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------
function universeOf(extraUnits = []) {
  const catalog = {
    ...CATALOG,
    modules: [...CATALOG.modules, ...extraUnits],
  };
  return buildUniverse({
    catalog,
    docs: null,
    skills: SKILLS,
    families: new Set(),
  });
}
const scopeFor = (map) => (code) => ({
  ok: true,
  modules: (map[code] ?? []).map((path) => ({ path })),
});

test("a first sync maps the pages of an official course and of a lab page, and leaves the rest new", () => {
  const universe = universeOf();
  const courseExams = examsByModule(
    ["AZ-104", "AZ-900"],
    scopeFor({ "AZ-104": ["/training/modules/admin-basics"], "AZ-900": [] }),
  );
  const pageExams = new Map([
    ["AZ-104", cardIndex(["/credentials/applied-skills/deploy-azure-monitor"])],
    ["SC-300", cardIndex(["/training/modules/guests-demo/9-demo-guest-users"])],
  ]);
  const { registry, changes } = syncRegistry({
    previous: emptyRegistry(),
    universe,
    courseExams,
    pageExams,
    today: "2026-10-21",
  });
  const byKey = new Map(registry.entries.map((e) => [e.key, e]));
  assert.deepEqual(
    byKey.get("/training/modules/admin-basics/exercise-create-vm").exams,
    { "AZ-104": "course" },
  );
  assert.deepEqual(
    byKey.get("/training/modules/admin-basics/exercise-monitor-vm").exams,
    { "AZ-104": "course" },
  );
  assert.equal(
    byKey.get("/training/modules/admin-basics/exercise-create-vm").state,
    "active",
  );
  assert.deepEqual(
    byKey.get("/credentials/applied-skills/deploy-azure-monitor").exams,
    { "AZ-104": "page" },
  );
  assert.deepEqual(
    byKey.get("/training/modules/guests-demo/demo-guest-users").exams,
    { "SC-300": "page" },
  );
  assert.equal(
    byKey.get("/training/modules/guided-project-build-api").state,
    "new",
  );
  assert.equal(
    byKey.get("/training/modules/guided-project-build-api").firstSeen,
    "2026-10-21",
  );
  assert.ok(
    !byKey.has("/credentials/applied-skills/old-skill"),
    "a retiring skill is not in the universe",
  );
  assert.equal(changes.added.length, 5);
  assert.equal(changes.mapped.length, 4);
  assert.deepEqual(summarize(registry).byKind, {
    unit: 3,
    module: 1,
    "applied-skill": 1,
  });
  // lastSynced alone is not a change.
  const again = syncRegistry({
    previous: registry,
    universe,
    courseExams,
    pageExams,
    today: "2026-10-28",
  });
  assert.equal(comparable(again.registry), comparable(registry));
  assert.equal(again.changes.added.length, 0);
});

test("decisions stay: skip, no-exam, excluded and the exams a person set are never undone", () => {
  const universe = universeOf();
  const courseExams = examsByModule(
    ["AZ-104"],
    scopeFor({ "AZ-104": ["/training/modules/admin-basics"] }),
  );
  const previous = {
    ...emptyRegistry(),
    entries: [
      entry("/training/modules/admin-basics/exercise-create-vm", {
        exams: { "SC-300": "judged" },
        skip: ["AZ-104"],
        state: "active",
      }),
      entry("/training/modules/admin-basics/exercise-monitor-vm", {
        state: "excluded",
      }),
      entry("/training/modules/guided-project-build-api", {
        kind: "module",
        why: "guided project",
        state: "no-exam",
      }),
    ],
  };
  const { registry } = syncRegistry({
    previous,
    universe,
    courseExams,
    pageExams: new Map(),
    today: "2026-10-21",
  });
  const byKey = new Map(registry.entries.map((e) => [e.key, e]));
  assert.deepEqual(
    byKey.get("/training/modules/admin-basics/exercise-create-vm").exams,
    { "SC-300": "judged" },
    "skip keeps AZ-104 out",
  );
  assert.equal(
    byKey.get("/training/modules/admin-basics/exercise-monitor-vm").state,
    "excluded",
  );
  assert.deepEqual(
    byKey.get("/training/modules/admin-basics/exercise-monitor-vm").exams,
    {},
    "an excluded page gets no exam",
  );
  assert.equal(
    byKey.get("/training/modules/guided-project-build-api").state,
    "no-exam",
  );
  // A lab page that links a no-exam page makes it active.
  const linked = syncRegistry({
    previous,
    universe,
    courseExams: new Map(),
    pageExams: new Map([
      [
        "AZ-104",
        cardIndex(["/training/modules/guided-project-build-api/2-build"]),
      ],
    ]),
    today: "2026-10-21",
  });
  assert.equal(
    linked.registry.entries.find((e) => e.kind === "module").state,
    "active",
  );
});

test("a page Learn stops listing is retiring while a lab page links it, dropped when none does, and back when listed again", () => {
  const key = "/training/modules/gone/exercise-old";
  const previous = {
    ...emptyRegistry(),
    entries: [
      entry(key, {
        exams: { "AZ-104": "course" },
        state: "active",
        path: "/training/modules/gone/3-exercise-old",
      }),
      entry("/training/modules/gone/exercise-unlinked", {
        exams: { "AZ-104": "course" },
        state: "active",
      }),
    ],
  };
  const universe = universeOf();
  const linkedPages = new Map([
    ["AZ-104", cardIndex(["/training/modules/gone/3-exercise-old"])],
  ]);
  const first = syncRegistry({
    previous,
    universe,
    pageExams: linkedPages,
    today: "2026-10-21",
  });
  const old = first.registry.entries.find((e) => e.key === key);
  assert.equal(old.state, "retiring");
  assert.equal(old.goneSince, "2026-10-21");
  assert.deepEqual(
    first.changes.retiring.map((e) => e.key),
    [key],
  );
  assert.deepEqual(
    first.changes.dropped.map((e) => e.key),
    ["/training/modules/gone/exercise-unlinked"],
  );
  // A later run keeps goneSince and does not report it again.
  const second = syncRegistry({
    previous: first.registry,
    universe,
    pageExams: linkedPages,
    today: "2026-10-28",
  });
  assert.equal(
    second.registry.entries.find((e) => e.key === key).goneSince,
    "2026-10-21",
  );
  assert.equal(second.changes.retiring.length, 0);
  // The lab page is cleaned: the entry goes.
  const third = syncRegistry({
    previous: second.registry,
    universe,
    pageExams: new Map(),
    today: "2026-11-04",
  });
  assert.ok(!third.registry.entries.some((e) => e.key === key));
  // It is listed again.
  const relisted = universeOf([
    mod("gone", "Gone", [["Exercise - Old", "3-exercise-old"]]),
  ]);
  const back = syncRegistry({
    previous: second.registry,
    universe: relisted,
    pageExams: linkedPages,
    today: "2026-11-04",
  });
  const again = back.registry.entries.find((e) => e.key === key);
  assert.equal(again.state, "active");
  assert.equal(again.goneSince, undefined);
  assert.equal(back.changes.back.length, 1);
});

test("a unit found by its page is an entry; it stays while the unit is listed and goes when a re-read no longer finds the link", () => {
  const universe = universeOf();
  const found = new Map([
    [
      "/training/modules/copilot-tour/explore-capabilities",
      {
        hosts: ["highlights"],
        path: "/training/modules/copilot-tour/2-explore-capabilities",
        title: "Explore the capabilities of Copilot",
        module: "/training/modules/copilot-tour",
      },
    ],
  ]);
  const first = syncRegistry({
    previous: emptyRegistry(),
    universe,
    demoUnits: found,
    scanned: new Map([["/training/modules/copilot-tour", "sig-copilot-tour"]]),
    today: "2026-10-21",
  });
  const demo = first.registry.entries.find((e) =>
    e.key.endsWith("explore-capabilities"),
  );
  assert.equal(demo.why, "demo link");
  assert.deepEqual(demo.demo, ["highlights"]);
  assert.equal(
    first.registry.scanned["/training/modules/copilot-tour"],
    "sig-copilot-tour",
  );
  // A later run that did not read the module keeps it.
  const kept = syncRegistry({
    previous: first.registry,
    universe,
    today: "2026-10-28",
  });
  assert.ok(
    kept.registry.entries.some(
      (e) => e.key.endsWith("explore-capabilities") && e.state === "new",
    ),
  );
  // A run that read the module again and found nothing lets it go (nobody links it).
  const gone = syncRegistry({
    previous: first.registry,
    universe,
    scanned: new Map([
      ["/training/modules/copilot-tour", "sig-copilot-tour-2"],
    ]),
    today: "2026-11-04",
  });
  assert.ok(
    !gone.registry.entries.some((e) => e.key.endsWith("explore-capabilities")),
  );
  // A unit that is hands-on by title AND has a demo host keeps its own type.
  const both = syncRegistry({
    previous: emptyRegistry(),
    universe,
    demoUnits: new Map([
      [
        "/training/modules/guests-demo/demo-guest-users",
        {
          hosts: ["cloudguides"],
          path: "x",
          title: "x",
          module: "/training/modules/guests-demo",
        },
      ],
    ]),
    today: "2026-10-21",
  });
  const guest = both.registry.entries.find((e) =>
    e.key.endsWith("demo-guest-users"),
  );
  assert.equal(guest.why, "demonstration");
  assert.deepEqual(guest.demo, ["cloudguides"]);
  // Modules that left the catalog are forgotten in `scanned`.
  const forgotten = syncRegistry({
    previous: {
      ...first.registry,
      scanned: { ...first.registry.scanned, "/training/modules/vanished": "s" },
    },
    universe,
    today: "2026-11-04",
  });
  assert.ok(!("/training/modules/vanished" in forgotten.registry.scanned));
});

// ---------------------------------------------------------------------------
// The check and the report
// ---------------------------------------------------------------------------
test("the check lists the pairs a lab page lacks, the cards no entry accounts for, and exams without a page", () => {
  const registry = {
    ...emptyRegistry(),
    entries: [
      entry("/training/modules/a/exercise-one", {
        exams: { "AZ-104": "course", "AB-100": "course" },
        state: "active",
      }),
      entry("/training/modules/a/exercise-two", {
        exams: { "AZ-104": "course" },
        state: "active",
      }),
      entry("/training/modules/b/exercise-three", { state: "new" }),
    ],
  };
  const pageExams = new Map([
    [
      "AZ-104",
      cardIndex([
        "/training/modules/a/2-exercise-one",
        "/training/modules/a/3-reading-unit",
        "/training/paths/a-path",
        "/azure/some/how-to",
        "/training/modules/concepts",
      ]),
    ],
  ]);
  const check = checkLabPages({
    registry,
    pageExams,
    hasLabPage: (exam) => pageExams.has(exam),
  });
  assert.deepEqual(
    check.missing.map((m) => `${m.exam} ${m.key}`),
    ["AZ-104 /training/modules/a/exercise-two"],
  );
  assert.equal(check.pairs, 2);
  assert.equal(check.covered, 1);
  assert.deepEqual(check.noPage, ["AB-100"]);
  assert.deepEqual(check.extras.get("AZ-104"), [
    "/azure/some/how-to",
    "/training/modules/a/3-reading-unit",
    "/training/modules/concepts",
    "/training/paths/a-path",
  ]);
});

test("the report names what needs a person, caps its tables and says nothing when nothing does", () => {
  const registry = {
    ...emptyRegistry(),
    entries: [
      ...Array.from({ length: 5 }, (_, i) =>
        entry(`/training/modules/n/exercise-${i}`, {
          title: `Exercise | ${i} <b>`,
          firstSeen: `2026-10-0${i + 1}`,
        }),
      ),
      entry("/training/modules/r/exercise-r", {
        state: "retiring",
        exams: { "AZ-104": "page" },
        goneSince: "2026-10-20",
      }),
    ],
  };
  const pageExams = new Map([
    ["AZ-104", cardIndex(["/training/modules/r/1-exercise-r"])],
  ]);
  const work = worklist(registry, pageExams);
  assert.equal(work.unmapped.length, 5);
  assert.equal(work.unmapped[0].firstSeen, "2026-10-05", "newest first");
  assert.deepEqual(
    work.retiring.map((r) => r.pages),
    [["AZ-104"]],
  );
  const check = {
    missing: [
      {
        exam: "AZ-104",
        key: "k",
        title: "Missing one",
        path: "/training/modules/m/x",
        why: "exercise",
      },
    ],
    extras: new Map([["AZ-104", ["/x"]]]),
    pairs: 4,
    covered: 3,
    noPage: [],
  };
  const changes = {
    added: [1, 2],
    mapped: [],
    retiring: [],
    back: [],
    dropped: [],
    changed: [],
  };
  const text = buildReport({
    registry,
    work,
    check,
    changes,
    date: "2026-10-21",
    maxRows: 3,
    notes: ["a note"],
  });
  assert.match(text, /^## Lab registry 2026-10-21/);
  assert.match(
    text,
    /### Lab pages that lack a page the registry ties to their exam \(1\)/,
  );
  assert.match(text, /3 of 4 pairs are on their page/);
  assert.match(text, /### Hands-on pages without an exam \(5\)/);
  assert.match(text, /…and 2 more\./);
  assert.match(
    text,
    /### Pages Learn no longer lists that a lab page still links \(1\)/,
  );
  assert.match(
    text,
    /### Cards on lab pages that are not in the registry \(1, information\)/,
  );
  assert.match(text, /> a note/);
  assert.ok(
    !text.includes("Exercise | 4"),
    "a pipe in a title cannot break a table",
  );
  assert.ok(!text.includes("<b>"), "markup in a title is defused");
  const quiet = buildReport({
    registry: {
      ...emptyRegistry(),
      entries: [
        entry("/training/modules/q/exercise-q", {
          exams: { "AZ-104": "course" },
          state: "active",
        }),
      ],
    },
    work: { unmapped: [], retiring: [] },
    check: { missing: [], extras: new Map(), pairs: 1, covered: 1, noPage: [] },
    changes,
    date: "2026-10-21",
  });
  assert.equal(quiet, "");
});

// ---------------------------------------------------------------------------
// The run, end to end with a fake Learn and an in-memory gh
// ---------------------------------------------------------------------------
async function world({
  registry = null,
  labCards = [],
  catalog = CATALOG,
  coursesCount = 1,
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "lab-registry-test-"));
  tempDirs.push(base);
  const put = (rel, text) => {
    const path = join(base, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const learnsync = join(base, "learnsync");
  put("learnsync/learn-catalog.json", JSON.stringify(catalog));
  put("learnsync/learn-content.json", JSON.stringify({ learningPaths: [] }));
  put(
    "learnsync/docs-catalog.json",
    JSON.stringify([
      {
        title: "Tutorial: Filter traffic",
        url: "https://learn.microsoft.com/azure/virtual-network/tutorial-filter",
      },
      {
        title: "Tutorial: Other product",
        url: "https://learn.microsoft.com/azure/other-product/tutorial-x",
      },
    ]),
  );
  put(
    "learnsync/module-links.json",
    JSON.stringify({
      modules: [
        {
          path: "/training/modules/admin-basics",
          links: [
            { kind: "docs", path: "/azure/virtual-network/overview" },
            {
              kind: "external",
              url: "https://example.com/azure/other-product/x",
            },
            { kind: "training", path: "/training/modules/x" },
          ],
        },
        {
          path: "/training/modules/not-in-a-course",
          links: [{ kind: "docs", path: "/azure/other-product/overview" }],
        },
      ],
    }),
  );
  put(
    "courses.json",
    JSON.stringify({
      courses: [
        {
          course_number: "AZ-104T00",
          title: "Admin",
          study_guide: [
            { uid: "learn.admin-basics" },
            { uid: "learn.copilot-tour" },
          ],
        },
      ],
    }),
  );
  put(
    "docs/azure/AZ-104.mdx",
    "---\ntitle: AZ-104 Study Materials\n---\nbody\n",
  );
  put(
    "docs/azure/AZ-900.mdx",
    "---\ntitle: AZ-900 Study Materials\n---\nbody\n",
  );
  put(
    "docs/labs/azure/az-104.mdx",
    `---\ntitle: AZ-104 Labs\n---\n${labCards.map((href) => `<LinkCard title="x" href="${href}" />`).join("\n")}\n`,
  );
  put("skills.json", JSON.stringify(SKILLS));
  const registryFile = join(base, "lab-registry.json");
  if (registry) writeFileSync(registryFile, registry);
  const env = {
    LEARNSYNC_DIR: learnsync,
    COURSES_FILE: join(base, "courses.json"),
    DOCS_DIR: join(base, "docs"),
    APPLIED_SKILLS_FILE: join(base, "skills.json"),
    REGISTRY_FILE: registryFile,
    REPORT_FILE: join(base, "report.md"),
    ERROR_FILE: join(base, "error.md"),
    GITHUB_OUTPUT: join(base, "output"),
    MIN_MODULES: "1",
    MIN_COURSES: String(coursesCount),
    PAGE_DELAY_MS: "0",
    RETRY_BASE_MS: "0",
    FETCH_ATTEMPTS: "2",
    TODAY: "2026-10-21",
    CREATE_ISSUES: "1",
  };
  return {
    base,
    env,
    registryFile,
    read: (rel) => readFileSync(join(base, rel), "utf8"),
  };
}

/** A fake Learn: unit pages are plain, except the ones in `pages` (path -> html) and `fail` (path -> status). */
function fakeLearn({ pages = {}, fail = {} } = {}) {
  const requests = [];
  const impl = async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    const status = fail[path] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => pages[path] ?? "<html><body>plain</body></html>",
      json: async () => ({}),
    };
  };
  return { impl, requests };
}

/** A gh with open issues in memory: list, label, create, comment, close. */
function memoryGh() {
  const issues = [];
  const calls = [];
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push(command);
    if (command === "issue list") {
      return JSON.stringify(
        issues
          .filter(
            (i) => i.state === "open" && i.label === flag(args, "--label"),
          )
          .map((i) => ({ number: i.number, title: i.title })),
      );
    }
    if (command === "label create") return "";
    if (command === "issue create") {
      issues.push({
        number: issues.length + 1,
        title: flag(args, "--title"),
        label: flag(args, "--label"),
        body: input,
        state: "open",
        comments: [],
      });
      return `https://github.com/mscerts/hub/issues/${issues.length}`;
    }
    if (command === "issue comment")
      issues.find((i) => i.number === Number(args[2])).comments.push(input);
    if (command === "issue close")
      issues.find((i) => i.number === Number(args[2])).state = "closed";
    return "";
  };
  return { gh, issues, calls };
}

test("the first run builds the registry, reads the pages, opens ONE issue and writes the registry after it", async () => {
  const w = await world({
    labCards: [
      "https://learn.microsoft.com/training/modules/admin-basics/2-exercise-create-vm?WT.mc_id=studentamb_165290",
    ],
  });
  const learn = fakeLearn({
    pages: {
      "/training/modules/copilot-tour/2-explore-capabilities":
        '<a href="https://app.highlights.guide/start/x?token=t">demo</a>',
    },
  });
  const github = memoryGh();
  const cfg = loadConfig(w.env);
  const result = await run(cfg, { fetchImpl: learn.impl, gh: github.gh });
  assert.equal(result.extractionFailed, false);
  assert.equal(result.baselineUpdated, true);
  assert.equal(result.changesFound, true);
  const registry = parseRegistry(w.read("lab-registry.json"));
  const byKey = new Map(registry.entries.map((e) => [e.key, e]));
  assert.deepEqual(
    byKey.get("/training/modules/admin-basics/exercise-create-vm").exams,
    { "AZ-104": "course" },
  );
  assert.equal(
    byKey.get("/training/modules/copilot-tour/explore-capabilities").why,
    "demo link",
  );
  assert.deepEqual(
    byKey.get("/training/modules/copilot-tour/explore-capabilities").demo,
    ["highlights"],
  );
  assert.equal(
    byKey.get("/azure/virtual-network/tutorial-filter")?.why,
    "tutorial",
    "a family the exam course links",
  );
  assert.ok(
    !byKey.has("/azure/other-product/tutorial-x"),
    "a family nobody uses",
  );
  assert.ok(registry.reported.signature);
  // Every module the hub cares about was read: the course module and the ones with entries or lab-page links.
  assert.ok(
    learn.requests.includes("/training/modules/admin-basics/1-introduction"),
  );
  assert.ok(
    Object.keys(registry.scanned).includes("/training/modules/admin-basics"),
  );
  // One issue, created with the report, under the stable title.
  assert.equal(github.issues.length, 1);
  assert.equal(
    github.issues[0].title,
    "Lab registry: hands-on pages need attention",
  );
  assert.match(github.issues[0].body, /Hands-on pages without an exam/);
  assert.match(w.read("report.md"), /Lab registry 2026-10-21/);
  assert.match(w.read("output"), /changes_found=true/);
  assert.match(w.read("output"), /baseline_updated=true/);
});

test("a second run with nothing new changes nothing and calls gh not at all", async () => {
  const w = await world();
  const first = fakeLearn();
  await run(loadConfig(w.env), { fetchImpl: first.impl, gh: memoryGh().gh });
  const before = w.read("lab-registry.json");
  const learn = fakeLearn();
  const github = memoryGh();
  const second = await run(loadConfig({ ...w.env, TODAY: "2026-10-28" }), {
    fetchImpl: learn.impl,
    gh: github.gh,
  });
  assert.equal(second.baselineUpdated, false);
  assert.equal(second.changesFound, false);
  assert.equal(
    w.read("lab-registry.json"),
    before,
    "lastSynced alone is no change",
  );
  assert.deepEqual(
    github.calls,
    [],
    "the same list as the last report: no gh call",
  );
  assert.deepEqual(
    learn.requests,
    [],
    "no module changed, no page is read again",
  );
});

test("a local run without CREATE_ISSUES does not mark the list as reported, so the first run with issues still opens the issue", async () => {
  const w = await world();
  const local = await run(loadConfig({ ...w.env, CREATE_ISSUES: "" }), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.equal(local.extractionFailed, false);
  assert.equal(local.changesFound, false);
  assert.equal(
    parseRegistry(w.read("lab-registry.json")).reported.signature,
    null,
  );
  const github = memoryGh();
  const ci = await run(loadConfig(w.env), {
    fetchImpl: fakeLearn().impl,
    gh: github.gh,
  });
  assert.equal(ci.changesFound, true);
  assert.equal(github.issues.length, 1);
  assert.ok(parseRegistry(w.read("lab-registry.json")).reported.signature);
});

test("when nothing needs a person any more the running issue is closed", async () => {
  const w = await world();
  const github = memoryGh();
  await run(loadConfig(w.env), { fetchImpl: fakeLearn().impl, gh: github.gh });
  assert.equal(github.issues[0].state, "open");
  // The maintainer decides every open page: none belongs to an exam.
  const registry = parseRegistry(w.read("lab-registry.json"));
  for (const e of registry.entries) if (e.state === "new") e.state = "no-exam";
  for (const e of registry.entries)
    if (e.state === "active")
      e.exams = Object.fromEntries(
        Object.keys(e.exams).map((x) => [x, "course"]),
      );
  writeFileSync(w.registryFile, serializeRegistry(registry));
  // The lab page gets every active page.
  const cards = registry.entries
    .filter((e) => e.state === "active")
    .map((e) => `https://learn.microsoft.com${e.path}`);
  writeFileSync(
    join(w.base, "docs/labs/azure/az-104.mdx"),
    `---\ntitle: AZ-104 Labs\n---\n${cards.map((href) => `<LinkCard title="x" href="${href}" />`).join("\n")}\n`,
  );
  const result = await run(loadConfig({ ...w.env, TODAY: "2026-10-28" }), {
    fetchImpl: fakeLearn().impl,
    gh: github.gh,
  });
  assert.equal(result.extractionFailed, false);
  assert.equal(github.issues[0].state, "closed");
  assert.equal(
    parseRegistry(w.read("lab-registry.json")).reported.signature,
    null,
  );
});

test("a changed list adds a comment, never a second issue", async () => {
  const w = await world();
  const github = memoryGh();
  await run(loadConfig(w.env), { fetchImpl: fakeLearn().impl, gh: github.gh });
  const extra = {
    ...CATALOG,
    modules: [
      ...CATALOG.modules,
      mod("brand-new", "Brand new", [
        ["Exercise - Try it", "1-exercise-try-it"],
      ]),
    ],
  };
  const changed = await world({ catalog: extra });
  // Reuse the first world's registry and gh state: copy the registry over.
  writeFileSync(changed.registryFile, w.read("lab-registry.json"));
  const result = await run(
    loadConfig({ ...changed.env, TODAY: "2026-10-28" }),
    { fetchImpl: fakeLearn().impl, gh: github.gh },
  );
  assert.equal(result.changesFound, true);
  assert.equal(github.issues.length, 1);
  assert.equal(github.issues[0].comments.length, 1);
  assert.match(github.issues[0].comments[0], /brand-new/);
});

test("--check writes nothing and touches no issue", async () => {
  const w = await world();
  const github = memoryGh();
  const result = await run(loadConfig(w.env), {
    fetchImpl: fakeLearn().impl,
    gh: github.gh,
    checkOnly: true,
  });
  assert.equal(result.extractionFailed, false);
  assert.equal(existsSync(w.registryFile), false);
  assert.deepEqual(github.calls, []);
  assert.ok(result.report.includes("Hands-on pages without an exam"));
});

test("failsafes: a catalog or course list that is too small, a mass vanishing, a corrupt registry stop the run with nothing written", async () => {
  const small = await world();
  let result = await run(loadConfig({ ...small.env, MIN_MODULES: "50" }), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.equal(result.extractionFailed, true);
  assert.match(small.read("error.md"), /fewer than MIN_MODULES \(50\)/);
  assert.equal(existsSync(small.registryFile), false);
  assert.match(small.read("output"), /extraction_failed=true/);
  assert.match(small.read("output"), /baseline_updated=false/);

  const noCourses = await world();
  result = await run(loadConfig({ ...noCourses.env, MIN_COURSES: "5" }), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.match(noCourses.read("error.md"), /fewer than MIN_COURSES \(5\)/);

  const gone = Array.from({ length: 60 }, (_, i) =>
    entry(`/training/modules/old/exercise-${i}`, {
      exams: { "AZ-104": "course" },
      state: "active",
    }),
  );
  const registryText = serializeRegistry({ ...emptyRegistry(), entries: gone });
  const vanish = await world({ registry: registryText });
  result = await run(loadConfig(vanish.env), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.equal(result.extractionFailed, true);
  assert.match(vanish.read("error.md"), /60 of 60 hands-on pages vanished/);
  assert.equal(vanish.read("lab-registry.json"), registryText, "untouched");
  result = await run(loadConfig({ ...vanish.env, FORCE_BASELINE: "1" }), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.equal(result.extractionFailed, false);

  const corrupt = await world({ registry: "{ nope" });
  result = await run(loadConfig(corrupt.env), {
    fetchImpl: fakeLearn().impl,
    gh: memoryGh().gh,
  });
  assert.equal(result.extractionFailed, true);
  assert.match(corrupt.read("error.md"), /not valid JSON/);
});

test("a unit page that cannot be read is no evidence: the module stays unscanned and nothing is invented", async () => {
  const w = await world();
  const learn = fakeLearn({
    fail: { "/training/modules/copilot-tour/2-explore-capabilities": 500 },
  });
  const result = await run(loadConfig(w.env), {
    fetchImpl: learn.impl,
    gh: memoryGh().gh,
  });
  assert.equal(result.extractionFailed, false);
  const registry = parseRegistry(w.read("lab-registry.json"));
  assert.ok(
    !("/training/modules/copilot-tour" in registry.scanned),
    "tried again next run",
  );
  assert.ok(!registry.entries.some((e) => e.why === "demo link"));
});

test("a run reads at most MAX_PAGE_READS units, official-course modules first, and says how many modules wait", () => {
  const universe = universeOf();
  const courseExams = examsByModule(
    ["AZ-104"],
    scopeFor({ "AZ-104": ["/training/modules/admin-basics"] }),
  );
  const plan = pickModulesToRead({
    universe,
    previous: emptyRegistry(),
    courseExams,
    pageExams: new Map([
      ["AZ-104", cardIndex(["/training/modules/copilot-tour/2-x"])],
    ]),
    maxUnits: 6,
  });
  assert.deepEqual(
    plan.picked.map((m) => m.path),
    ["/training/modules/admin-basics", "/training/modules/copilot-tour"],
  );
  assert.equal(plan.pending, 1);
  assert.equal(plan.units, 7);
  // A module whose unitSig was scanned is not read again (the two that matter here: the course module and the one with a demonstration).
  const done = pickModulesToRead({
    universe,
    previous: {
      ...emptyRegistry(),
      scanned: {
        "/training/modules/admin-basics": "sig-admin-basics",
        "/training/modules/guests-demo": "sig-guests-demo",
      },
    },
    courseExams,
    pageExams: new Map(),
    maxUnits: 100,
  });
  assert.equal(done.picked.length, 0);
  assert.equal(
    pickModulesToRead({
      universe,
      previous: emptyRegistry(),
      courseExams,
      pageExams: new Map(),
      maxUnits: 0,
    }).picked.length,
    0,
  );
});

test("a request is retried on a server error and the last answer is returned after the attempts", async () => {
  const cfg = loadConfig({ FETCH_ATTEMPTS: "3", RETRY_BASE_MS: "0" });
  let calls = 0;
  const flaky = async () => {
    calls++;
    return {
      ok: calls >= 3,
      status: calls >= 3 ? 200 : 503,
      headers: { get: () => null },
    };
  };
  assert.equal((await fetchRetry("https://x.test/a", cfg, flaky)).status, 200);
  assert.equal(calls, 3);
  calls = -100;
  await assert.rejects(
    () => fetchRetry("https://x.test/a", cfg, flaky),
    /HTTP 503/,
  );
  const notFound = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
  });
  assert.equal(
    (await fetchRetry("https://x.test/a", cfg, notFound)).status,
    404,
    "a 404 is an answer, not an error",
  );
});

test("the signature changes with what needs a person and nothing else", () => {
  const base = {
    work: { unmapped: [entry("/a")], retiring: [] },
    check: { missing: [] },
  };
  const same = {
    work: { unmapped: [{ ...entry("/a"), title: "other" }], retiring: [] },
    check: { missing: [] },
  };
  const more = {
    work: { unmapped: [entry("/a"), entry("/b")], retiring: [] },
    check: { missing: [] },
  };
  assert.equal(signatureOf(base), signatureOf(same));
  assert.notEqual(signatureOf(base), signatureOf(more));
});
