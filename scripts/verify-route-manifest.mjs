import { access, readFile, readdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("src/data_files/public-routes.json", root);
const read = (file) => readFile(new URL(`dist/${file}`, root), "utf8");
const sitemap = await read("sitemap-0.xml");
const redirects = new Map(
  (await read("_redirects"))
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/).slice(0, 2)),
);
const update = process.argv.includes("--update");
const previousManifest = JSON.parse(
  await readFile(manifestUrl, "utf8").catch((error) => {
    if (update && error.code === "ENOENT") return '{"paths":[]}';
    throw error;
  }),
);
const wikiNextIndex = redirects.get("/wiki-next/*");
const isWikiNextChild = (path) => path.startsWith("/wiki-next/");
// The review copy of a course page (docs/courses.md, "<name>-review") is regenerated and deleted as the maintainer
// reviews a course: it is an ordinary page of the site, but not part of the baseline, so adding or removing one needs no
// baseline update.
const isReviewCopy = (path) =>
  /^(?:\/(?:certs|wiki|wiki-next))?\/courses\/[^/]+-review(?:\.md|\/)?$/.test(
    path,
  );
const paths = [
  ...new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => new URL(match[1]).pathname)
      .concat(
        [...redirects.keys()].filter((path) => path !== "/wiki-next/*"),
        wikiNextIndex ? previousManifest.paths.filter(isWikiNextChild) : [],
      ),
  ),
]
  .filter((path) => !isReviewCopy(path))
  .sort();
if (update) {
  await writeFile(manifestUrl, JSON.stringify({ paths }, null, 2) + "\n");
  console.log(
    `Updated public route baseline: ${paths.length} paths. Review its diff before committing.`,
  );
}
const manifest = update ? { paths } : previousManifest;
const missingFromBaseline = paths.filter(
  (path) => !manifest.paths.includes(path),
);
const removedFromSite = manifest.paths.filter((path) => !paths.includes(path));
assert.deepEqual(
  { missingFromBaseline, removedFromSite },
  { missingFromBaseline: [], removedFromSite: [] },
  "Public route set changed. Review the routes, then update src/data_files/public-routes.json with `node scripts/verify-route-manifest.mjs --update`.",
);
for (const original of manifest.paths) {
  let path = original;
  const seen = new Set();
  while (redirects.has(path) || (wikiNextIndex && isWikiNextChild(path))) {
    assert.ok(!seen.has(path), `Redirect loop: ${original}`);
    seen.add(path);
    path = redirects.get(path) ?? wikiNextIndex;
  }
  if (path.startsWith("https://")) continue;
  assert.ok(
    path.startsWith("/") && !path.includes(".."),
    `Unsafe route: ${path}`,
  );
  const file = path.endsWith("/") ? `${path}index.html` : path;
  await access(new URL(`dist${file}`, root)).catch(() => {
    throw new Error(`Public route disappeared without a redirect: ${original}`);
  });
}
const constants = await readFile(
  new URL("src/data_files/constants.ts", root),
  "utf8",
);
const scripts = await readdir(new URL("dist/_astro/", root));
const bundles = (
  await Promise.all(
    scripts
      .filter((file) => file.endsWith(".js"))
      .map((file) => read(`_astro/${file}`)),
  )
).join("\n");
const html = await read("certs/index.html");
for (const name of ["googleAnalytics", "googleTagManager"]) {
  const id = constants.match(new RegExp(`${name}:\\s*"([^"]+)"`))?.[1];
  assert.ok(id, `Missing analytics constant: ${name}`);
  assert.ok(
    (html + bundles).includes(id),
    `Analytics ID missing from build: ${name}`,
  );
}
console.log(
  `Verified ${manifest.paths.length} public routes and built GA/GTM IDs.`,
);
