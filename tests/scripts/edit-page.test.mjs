import test from "node:test";
import assert from "node:assert/strict";
import { editPageUrl } from "../../src/utils/edit-page.mjs";

test("edit links preserve actual filename case and collection location", () => {
  const root = "/checkout";
  for (const path of [
    "src/content/docs/azure/AZ-104.mdx",
    "src/content/docs/labs/azure/az-104.mdx",
    "src/content/archive/azure/AZ-104.mdx",
    "src/pages/certs/index.astro",
  ]) {
    assert.equal(
      editPageUrl(`${root}/${path}`, root),
      `https://github.com/mscerts/hub/edit/main/${path}`,
    );
    assert.equal(editPageUrl(path, root), editPageUrl(`${root}/${path}`, root));
  }
});

test("missing source paths omit the link and paths outside source are rejected", () => {
  assert.equal(editPageUrl(undefined), undefined);
  assert.throws(() => editPageUrl("/outside/file.mdx", "/checkout"));
  assert.throws(() => editPageUrl("src/../private.txt"));
  assert.equal(
    editPageUrl("src/content/docs/a space.mdx"),
    "https://github.com/mscerts/hub/edit/main/src/content/docs/a%20space.mdx",
  );
});
