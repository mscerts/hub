import assert from "node:assert/strict";
import test from "node:test";
import { routePicks } from "../../scripts/lib/course-build.mjs";
import { isClassic } from "../../scripts/lib/course-classic.mjs";
import { hardFilter } from "../../scripts/lib/course-candidates.mjs";
import { validateCourse } from "../../scripts/lib/course-format.mjs";
import { exampleCourse, pick } from "./helpers/example-course.mjs";

test("a page is classic when its title has the word, or an address segment does", () => {
  assert.equal(isClassic({ title: "Create a classic file share" }), true);
  assert.equal(
    isClassic({
      title: "Azure roles and classic subscription administrator roles",
    }),
    true,
  );
  assert.equal(
    isClassic({ title: "Backup Classic Alerts using Azure Backup" }),
    true,
  );
  assert.equal(
    isClassic({
      title: "Share",
      path: "/azure/storage/files/create-classic-file-share",
    }),
    true,
  );
  assert.equal(
    isClassic({
      title: "VMs",
      path: "/azure/virtual-machines/classic/migrate",
    }),
    true,
  );
  assert.equal(
    isClassic({
      title: "VMs",
      path: "/azure/virtual-machines/classic_deployment",
    }),
    true,
  );
});

test("a word that only contains classic, or a page without the word, is not classic", () => {
  assert.equal(isClassic({ title: "Classical music for builders" }), false);
  assert.equal(
    isClassic({ title: "Declassified", path: "/azure/declassified-notes" }),
    false,
  );
  assert.equal(
    isClassic({
      title: "Configure virtual networks",
      path: "/azure/virtual-network/overview",
    }),
    false,
  );
  assert.equal(isClassic({ path: "/azure/classical-guitar" }), false);
  assert.equal(isClassic(), false);
});

test("the generator's hard filter drops a classic module, unit or docs page and counts it as classic", () => {
  const pools = {
    docPaths: null,
    movedFrom: new Map(),
    boilerplate: new Set(),
  };
  assert.equal(
    hardFilter(
      {
        kind: "docs",
        path: "/azure/storage/files/create-classic-file-share",
        title: "Create a classic file share",
      },
      pools,
    ),
    "classic",
  );
  assert.equal(
    hardFilter(
      {
        kind: "module",
        path: "/training/modules/migrate-classic-resources",
        title: "Migrate",
      },
      pools,
    ),
    "classic",
  );
  assert.equal(
    hardFilter(
      {
        kind: "unit",
        path: "/training/modules/m/2-x",
        title: "Classic deployment model",
      },
      pools,
    ),
    "classic",
  );
  assert.equal(
    hardFilter(
      {
        kind: "docs",
        path: "/azure/storage/files/create-file-share",
        title: "Create a file share",
      },
      pools,
    ),
    null,
  );
});

const KEYS = ["d/g/t1", "d/g/t2"];
const row = (path, title) => ({
  pick: { target: { kind: "docs", path }, title, class: "core", source: "P1" },
  item: { judge: { confidence: "high" }, skeptic: { stance: "uphold" } },
});

test("the builder leaves an accepted classic page out and lists it, with its tasks, in the routing", () => {
  const result = routePicks({
    accepted: new Map([
      [
        "d/g/t1",
        [
          row("/azure/a/create-classic-share", "Create a classic file share"),
          row("/azure/b", "Fine"),
        ],
      ],
      [
        "d/g/t2",
        [row("/azure/a/create-classic-share", "Create a classic file share")],
      ],
    ]),
    taskKeys: KEYS,
  });
  assert.deepEqual(
    (result.accepted.get("d/g/t1") ?? []).map((r) => r.pick.target.path),
    ["/azure/b"],
  );
  assert.deepEqual(result.accepted.get("d/g/t2") ?? [], []);
  assert.deepEqual(result.classic, [
    {
      path: "/azure/a/create-classic-share",
      title: "Create a classic file share",
      tasks: ["d/g/t1", "d/g/t2"],
    },
  ]);
  assert.deepEqual(result.repeats, [], "a dropped page is not a repeat");
});

test("a course file cannot hold a classic page", () => {
  const { course, guide } = exampleCourse();
  course.domains[0].groups[0].tasks[0].picks.push(
    pick({
      target: { kind: "docs", path: "/azure/github/classic-branches" },
      title: "Classic branches",
      source: "P2",
      via: "/training/modules/intro-to-github",
    }),
  );
  assert.match(
    validateCourse(course, { guide }).errors.join("|"),
    /\/azure\/github\/classic-branches is classic material; a course leaves it out/,
  );
});
