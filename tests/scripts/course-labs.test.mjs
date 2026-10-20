import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { main } from "../../scripts/course-labs.mjs";
import {
  cardLine,
  cardTitle,
  compareWithLabPage,
  labPagePaths,
  onLabPage,
  tabLabels,
} from "../../scripts/lib/course-labs.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const LAB_PAGE = `---
title: NET-100 Labs
---
import { LinkCard, CardGrid } from '@components/docs';
import { Tabs, TabItem } from '@components/docs';

<Tabs>
  <TabItem label="Microsoft Learn">
<Tabs>
  <TabItem label="Networking">
<CardGrid>
  <LinkCard title="Create custom routes" href="https://learn.microsoft.com/training/modules/control-traffic/3-exercise-create-custom-routes/?WT.mc_id=studentamb_165290" />
  <LinkCard title="Guided one" href="https://learn.microsoft.com/training/modules/guided-project-share-files/2-exercise-create-storage?WT.mc_id=studentamb_165290" />
  <LinkCard title="A tutorial" href="https://learn.microsoft.com/azure/virtual-network/tutorial-filter-network-traffic?WT.mc_id=studentamb_165290" />
</CardGrid>
</TabItem>
</Tabs>
  </TabItem>
  <TabItem label="Microsoft GitHub">
<CardGrid>
  <LinkCard title="Lab 1" href="https://microsoftlearning.github.io/NET-100/Instructions/Labs/LAB_01.html" />
</CardGrid>
  </TabItem>
</Tabs>
`;

const entry = (over) => ({
  path: "/training/modules/control-traffic/3-exercise-create-custom-routes",
  kind: "unit",
  title: "Exercise - Create custom routes",
  reason: "exercise",
  tasks: ["networking/configure/routes"],
  ...over,
});

test("the lab page's Learn paths and tab labels are read from its cards and tabs", () => {
  const paths = labPagePaths(LAB_PAGE);
  assert.ok(paths.has("/training/modules/control-traffic/3-exercise-create-custom-routes"));
  assert.ok(paths.has("/azure/virtual-network/tutorial-filter-network-traffic"));
  assert.ok(!paths.has("https://microsoftlearning.github.io/NET-100/Instructions/Labs/LAB_01.html"));
  assert.deepEqual(tabLabels(LAB_PAGE), ["Microsoft Learn", "Networking", "Microsoft GitHub"]);
});

test("a hands-on page is on the lab page when the page, the same unit under another number, or (for a project module) any unit of it is there", () => {
  const paths = labPagePaths(LAB_PAGE);
  assert.equal(onLabPage(entry(), paths), true, "the same address");
  assert.equal(
    onLabPage(entry({ path: "/training/modules/control-traffic/4-exercise-create-custom-routes" }), paths),
    true,
    "the unit moved to another position",
  );
  assert.equal(
    onLabPage(entry({ path: "/training/modules/control-traffic/3-exercise-other" }), paths),
    false,
  );
  assert.equal(
    onLabPage(
      entry({ kind: "module", path: "/training/modules/guided-project-share-files" }),
      paths,
    ),
    true,
    "a guided project whose exercises are listed",
  );
  assert.equal(
    onLabPage(entry({ kind: "module", path: "/training/modules/guided-project-other" }), paths),
    false,
  );
  assert.equal(
    onLabPage(
      entry({ kind: "docs", path: "/azure/virtual-network/tutorial-filter-network-traffic" }),
      paths,
    ),
    true,
  );
});

test("a card is titled like the lab page's own: no Exercise or Simulation prefix, a capital first letter; a tutorial keeps its name", () => {
  assert.equal(cardTitle({ title: "Exercise - add groups in Microsoft Entra ID" }), "Add groups in Microsoft Entra ID");
  assert.equal(cardTitle({ title: "Simulation - Provide storage" }), "Provide storage");
  assert.equal(cardTitle({ title: "Exercise configure SSPR" }), "Configure SSPR");
  assert.equal(cardTitle({ title: "Tutorial: Connect virtual networks with peering" }), "Tutorial: Connect virtual networks with peering");
  assert.equal(cardTitle({ title: 'Quote "this"' }), "Quote 'this'");
  assert.equal(cardTitle({ title: "Exercise" }), "Exercise", "nothing left after the prefix: keep the title");
});

test("the card is one line with the hub's tracking parameter and no description", () => {
  assert.equal(
    cardLine(entry({ path: "/training/modules/m/3-exercise-x", title: "Exercise - X y" })),
    '  <LinkCard title="X y" href="https://learn.microsoft.com/training/modules/m/3-exercise-x?WT.mc_id=studentamb_165290" />',
  );
});

test("compareWithLabPage splits the pages into those on the lab page and those missing, missing ones by domain and title", () => {
  const handsOn = [
    entry({ tasks: ["networking/configure/routes"] }),
    entry({
      path: "/azure/dns/tutorial-b",
      kind: "docs",
      title: "Tutorial: B",
      reason: "tutorial",
      tasks: ["networking/dns/x"],
    }),
    entry({
      path: "/azure/backup/tutorial-a",
      kind: "docs",
      title: "Tutorial: A",
      reason: "tutorial",
      tasks: ["monitor/backup/y"],
    }),
    entry({
      path: "/azure/dns/tutorial-a",
      kind: "docs",
      title: "Tutorial: A",
      reason: "tutorial",
      tasks: ["networking/dns/z"],
    }),
  ];
  const { present, missing } = compareWithLabPage({ handsOn, mdx: LAB_PAGE });
  assert.deepEqual(present.map((e) => e.path), [handsOn[0].path]);
  assert.deepEqual(
    missing.map((e) => [e.domain, e.path]),
    [
      ["monitor", "/azure/backup/tutorial-a"],
      ["networking", "/azure/dns/tutorial-a"],
      ["networking", "/azure/dns/tutorial-b"],
    ],
  );
});

function world({ lab = true, routing = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "course-labs-"));
  temps.push(root);
  const labDir = join(root, "src", "content", "docs", "labs", "azure");
  mkdirSync(labDir, { recursive: true });
  if (lab) writeFileSync(join(labDir, "az-104.mdx"), LAB_PAGE);
  const file = join(root, "az-104.routing.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      kind: "routing",
      code: "AZ-104",
      builtAt: "2026-10-20",
      handsOn: [
        entry(),
        entry({
          path: "/azure/dns/tutorial-a",
          kind: "docs",
          title: "Tutorial: A",
          reason: "tutorial",
          tasks: ["implement-and-manage-virtual-networking/dns/z"],
        }),
      ],
      repeats: [],
      ...routing,
    }),
  );
  return { root, file };
}

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) };
};

test("the command lists what the lab page lacks as ready cards and changes nothing", () => {
  const w = world();
  const c = capture();
  assert.equal(main(["AZ-104", "--routing", w.file], { root: w.root, log: c.log, error: c.error }), 0, c.err.join("\n"));
  const text = c.out.join("\n");
  assert.match(text, /AZ-104: 2 hands-on pages were accepted for the course; 1 are on the lab page already, 1 are missing\./);
  assert.match(text, /Its tabs: Microsoft Learn, Networking, Microsoft GitHub/);
  assert.match(text, /# implement-and-manage-virtual-networking\n  <LinkCard title="Tutorial: A" href="https:\/\/learn\.microsoft\.com\/azure\/dns\/tutorial-a\?WT\.mc_id=studentamb_165290" \/>   <!-- tutorial; docs -->/);
  assert.match(text, /Missing by kind: 1 tutorial\./);
});

test("input problems are exit code 2: usage, a missing or wrong routing file, a missing lab page", () => {
  const w = world();
  const cases = [
    [[], /An exam code is required/],
    [["AZ-104"], /--routing FILE is required/],
    [["AZ-104", "--nope"], /Unknown option --nope/],
    [["AZ-104", "--routing", join(w.root, "none.json")], /Cannot read the routing file/],
    [["AZ-900", "--routing", w.file], /is for AZ-104, not AZ-900/],
  ];
  for (const [argv, message] of cases) {
    const c = capture();
    assert.equal(main(argv, { root: w.root, log: c.log, error: c.error }), 2, argv.join(" "));
    assert.match(c.err.join("\n"), message);
  }
  const bad = world({ routing: { kind: "queue" } });
  const c = capture();
  assert.equal(main(["AZ-104", "--routing", bad.file], { root: bad.root, log: c.log, error: c.error }), 2);
  assert.match(c.err.join("\n"), /is not a routing file/);
  const none = world({ lab: false });
  const c2 = capture();
  assert.equal(main(["AZ-104", "--routing", none.file], { root: none.root, log: c2.log, error: c2.error }), 2);
  assert.match(c2.err.join("\n"), /AZ-104 has no lab page/);
});
