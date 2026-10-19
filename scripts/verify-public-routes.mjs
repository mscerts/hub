import { access, readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const read = (path) =>
  readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
const [index, sitemap, redirects] = await Promise.all([
  read("certs/index.html"),
  read("sitemap-0.xml"),
  read("_redirects"),
]);
assert.match(index, /Microsoft Exam Study Materials/);
for (const area of [
  "azure",
  "github",
  "aibusiness",
  "dynamics",
  "microsoft365",
  "power",
  "security",
]) {
  assert.match(
    index,
    new RegExp(`href="/certs/${area}/[^"/]+/"`),
    `missing ${area} exam listing`,
  );
}
assert.doesNotMatch(sitemap, /<loc>[^<]*\/(?:wiki|wiki-next)\//);
assert.doesNotMatch(sitemap, /<loc>[^<]*\/certs\/guide\/markdown\//);
const rules = new Map(
  redirects
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/).slice(0, 2)),
);
for (const [source, target] of [
  ["/azure/az-104/", "/certs/azure/az-104/"],
  ["/azure/az-104.md", "/certs/azure/az-104.md"],
  ["/wiki/azure/az-104.md", "/certs/azure/az-104.md"],
  ["/wiki/", "/certs/"],
  ["/vouchers/ab650beta/", "/certs/vouchers/betaexams/"],
])
  assert.equal(rules.get(source), target, source);
assert.ok(
  rules.size <= 2000,
  "Cloudflare Pages permits at most 2000 static redirects",
);
for (const target of new Set(rules.values())) {
  if (!target.startsWith("/")) continue;
  const file = target.endsWith("/") ? `${target}index.html` : target;
  await access(new URL(`../dist${file}`, import.meta.url));
}
for (const [, href] of index.matchAll(/href="(\/certs\/[^"?#]+\/)"/g)) {
  await access(new URL(`../dist${href}index.html`, import.meta.url));
}
console.log(
  `Verified exam index, sitemap exclusions, and ${rules.size} deployment redirects.`,
);
