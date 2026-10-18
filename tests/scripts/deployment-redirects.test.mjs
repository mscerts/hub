import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { redirectRules } from "../../src/utils/deployment-redirects.mjs";

test("legacy HTML and Markdown URLs reach canonical pages, with renames taking precedence", () => {
  const rules = redirectRules(
    {
      "/power/pl-400": "/certs/aibusiness/ab-400/",
      "/vouchers/ab650beta/": "/certs/vouchers/betaexams/",
    },
    [
      "certs/azure/az-104/",
      "certs/aibusiness/ab-400/",
      "certs/vouchers/betaexams/",
    ],
  );
  const lookup = new Map(
    rules
      .trim()
      .split("\n")
      .map((line) => line.split(" ").slice(0, 2)),
  );
  for (const prefix of ["/", "/wiki/", "/wiki-next/"]) {
    assert.equal(lookup.get(`${prefix}azure/az-104/`), "/certs/azure/az-104/");
    assert.equal(
      lookup.get(`${prefix}azure/az-104.md`),
      "/certs/azure/az-104.md",
    );
    assert.equal(
      lookup.get(`${prefix}power/pl-400.md`),
      "/certs/aibusiness/ab-400.md",
    );
  }
  assert.equal(
    lookup.get("/vouchers/ab650beta/"),
    "/certs/vouchers/betaexams/",
  );
  assert.equal(lookup.get("/wiki/"), "/certs/");
  assert.equal(lookup.get("/unknown/"), undefined);
});

test("GA4 loader pushes native Arguments objects rather than arrays", () => {
  const source = readFileSync(
    new URL("../../src/layouts/MainLayout.astro", import.meta.url),
    "utf8",
  );
  const declaration = source.match(
    /function gtag\(\.\.\._args: unknown\[\]\) \{[^}]+\}/,
  )?.[0];
  assert.ok(declaration, "consent loader defines the GA4 function");
  const context = { analyticsWindow: { dataLayer: [] } };
  vm.runInNewContext(
    declaration.replace(": unknown[]", "") + '; gtag("config", "G-TEST");',
    context,
  );
  const [entry] = context.analyticsWindow.dataLayer;
  assert.equal(Object.prototype.toString.call(entry), "[object Arguments]");
  assert.deepEqual(Array.from(entry), ["config", "G-TEST"]);
});
