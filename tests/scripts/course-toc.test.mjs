import assert from "node:assert/strict";
import test from "node:test";
import {
  CONCEPT_SLUG,
  buildTocLookup,
  isConceptPath,
} from "../../scripts/lib/course-toc.mjs";

const FILE = {
  schemaVersion: 1,
  tocs: [
    {
      path: "/entra/fundamentals",
      groups: [
        { title: [], landing: null, pages: ["/entra/fundamentals"] },
        {
          title: ["Add users and groups", "Groups"],
          landing: null,
          pages: [
            "/entra/fundamentals/concept-learn-about-groups",
            "/entra/fundamentals/how-to-manage-groups",
          ],
        },
      ],
    },
    {
      path: "/entra/identity/users",
      groups: [
        {
          title: ["How-to guides", "Groups"],
          landing: "/entra/identity/users/groups-overview",
          pages: [
            "/entra/identity/users/groups-settings-v2-cmdlets",
            "/entra/fundamentals/how-to-manage-groups",
          ],
        },
      ],
    },
  ],
  noToc: {},
};

test("the lookup finds the pages that sit in the same sidebar group: how-to-manage-groups brings concept-learn-about-groups", () => {
  const lookup = buildTocLookup(FILE);
  assert.equal(lookup.pages, 5);
  assert.deepEqual(
    lookup
      .groupsOf("/entra/fundamentals/how-to-manage-groups")
      .map((g) => g.title),
    [
      ["Add users and groups", "Groups"],
      ["How-to guides", "Groups"],
    ],
    "a page can be in the groups of several tocs",
  );
  assert.deepEqual(
    lookup.siblingsOf("/entra/fundamentals/how-to-manage-groups"),
    [
      "/entra/fundamentals/concept-learn-about-groups",
      "/entra/identity/users/groups-overview",
      "/entra/identity/users/groups-settings-v2-cmdlets",
    ],
  );
  assert.deepEqual(lookup.siblingsOf("/entra/nowhere"), []);
  assert.deepEqual(lookup.groupsOf("/entra/nowhere"), []);
});

test("a file that is not a docs-toc gives an empty lookup, never an error", () => {
  for (const file of [
    null,
    undefined,
    {},
    { tocs: "no" },
    { tocs: [null, { path: "/x" }] },
  ]) {
    const lookup = buildTocLookup(file);
    assert.equal(lookup.pages, 0);
    assert.deepEqual(lookup.siblingsOf("/x"), []);
  }
});

test("Microsoft's concept articles are named by convention: concept-, what-is-, -overview, introduction, about-", () => {
  for (const path of [
    "/entra/fundamentals/concept-learn-about-groups",
    "/entra/fundamentals/what-is-entra",
    "/azure/virtual-network/virtual-networks-overview",
    "/azure/virtual-network/overview",
    "/azure/x/introduction-to-y",
    "/azure/x/about-y",
    "/azure/x/routing-concepts",
  ])
    assert.equal(isConceptPath(path), true, path);
  for (const path of [
    "/entra/fundamentals/how-to-manage-groups",
    "/azure/virtual-network/tutorial-create-route-table",
    "/azure/virtual-network/manage-route-table",
    "/azure/x/create-y",
    "/azure/x/conceptual-model-of-y",
  ])
    assert.equal(isConceptPath(path), false, path);
  assert.ok(CONCEPT_SLUG instanceof RegExp);
});
