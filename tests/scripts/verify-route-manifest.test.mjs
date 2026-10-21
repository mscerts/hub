import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "public-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["scripts", "dist/certs", "dist/_astro", "src/data_files"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, "scripts/check.mjs"),
    await readFile(
      new URL("../../scripts/verify-route-manifest.mjs", import.meta.url),
    ),
  );
  await writeFile(
    join(root, "dist/sitemap-0.xml"),
    "<urlset><url><loc>https://example.org/certs/</loc></url></urlset>",
  );
  await writeFile(join(root, "dist/_redirects"), "/old/ /certs/ 301\n");
  await writeFile(join(root, "dist/certs/index.html"), "<h1>Exams</h1>");
  await writeFile(
    join(root, "dist/_astro/app.js"),
    'const ids=["G-EXAMPLE","GTM-EXAMPLE"];',
  );
  await writeFile(
    join(root, "src/data_files/constants.ts"),
    'export const ANALYTICS={googleAnalytics: "G-EXAMPLE", googleTagManager: "GTM-EXAMPLE"};',
  );
  const run = (...args) =>
    spawnSync(process.execPath, [join(root, "scripts/check.mjs"), ...args], {
      encoding: "utf8",
    });
  assert.equal(run("--update").status, 0);
  return { root, run };
}

test("a disappeared page fails even when its route is still in the sitemap", async (t) => {
  const { root, run } = await fixture(t);
  await unlink(join(root, "dist/certs/index.html"));
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Public route disappeared/);
});
test("new or removed public routes require an explicit baseline update", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(
    join(root, "dist/_redirects"),
    "/old/ /certs/ 301\n/new/ /certs/ 301\n",
  );
  assert.match(run().stderr, /Public route set changed/);
  assert.equal(run("--update").status, 0);
  await writeFile(join(root, "dist/_redirects"), "/new/ /certs/ 301\n");
  assert.match(run().stderr, /Public route set changed/);
});
test("redirect loops and missing built analytics IDs fail the build guard", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, "dist/_redirects"), "/old/ /old/ 301\n");
  assert.match(run().stderr, /Redirect loop/);
  await writeFile(join(root, "dist/_redirects"), "/old/ /certs/ 301\n");
  await writeFile(join(root, "dist/_astro/app.js"), 'const id="G-EXAMPLE";');
  assert.match(
    run().stderr,
    /Analytics ID missing from build: googleTagManager/,
  );
});

test("the review copy of a course page is not part of the baseline", async (t) => {
  const { root, run } = await fixture(t);
  const sitemap = (...paths) =>
    "<urlset>" +
    ["/certs/", ...paths]
      .map((path) => "<url><loc>https://example.org" + path + "</loc></url>")
      .join("") +
    "</urlset>";
  await writeFile(
    join(root, "dist/sitemap-0.xml"),
    sitemap("/certs/courses/az-104course-review/"),
  );
  await writeFile(
    join(root, "dist/_redirects"),
    [
      "/old/ /certs/ 301",
      "/courses/az-104course-review/ /certs/ 301",
      "/wiki-next/courses/az-104course-review /certs/ 301",
      "",
    ].join("\n"),
  );
  assert.equal(run().status, 0, "adding a review copy needs no update");
  // an ordinary course page still does
  await writeFile(
    join(root, "dist/sitemap-0.xml"),
    sitemap("/certs/courses/az-104course-v9/"),
  );
  assert.match(run().stderr, /Public route set changed/);
});
