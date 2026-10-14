import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { monitorRunner } from "../fixtures/legacy-monitors/harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const preload = join(
  root,
  "tests",
  "fixtures",
  "legacy-monitors",
  "fake-fetch.mjs",
);
const TRACKING = "?WT.mc_id=studentamb_165290";
const LISTING_URL = "https://listing.invalid/applied-skills";
const OLD_SYNC = "2000-01-01T00:00:00Z";

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const listed = (slug, title, products = ["Azure"]) => ({
  url: `https://learn.microsoft.com/en-us/credentials/applied-skills/${slug}/`,
  title: `Microsoft Applied Skills: ${title}`,
  display_products: products,
});
const detailUrl = (slug) =>
  `https://learn.microsoft.com/credentials/applied-skills/${slug}/`;
const detailPage = (title) =>
  `<html><body><h1>Microsoft Applied Skills: ${title}</h1><a href="https://learn.microsoft.com/credentials/browse/?products=azure&amp;credential_types=applied%20skills">Azure</a></body></html>`;

const A = ["skill-a", "Skill A"];
const B = ["skill-b", "Skill B"];
const C = ["skill-c", "Skill C"];

/**
 * The script copied into a scratch tree of its own, with the lab pages and the
 * cache that are the test's: it finds them relative to its own location, and
 * only the cache has an environment variable. The Learn addresses it fetches are
 * answered by tests/fixtures/legacy-monitors/fake-fetch.mjs (a preload) from a
 * routes file the test rewrites before each run.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "applied-skills-sync-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(root, "scripts", "applied-skills-sync.mjs"),
    join(dir, "scripts", "applied-skills-sync.mjs"),
  );
  cpSync(join(root, "scripts", "lib"), join(dir, "scripts", "lib"), {
    recursive: true,
  });
  // one lab page that links two of the skills
  const labs = join(dir, "src", "content", "docs", "labs", "azure");
  mkdirSync(labs, { recursive: true });
  writeFileSync(
    join(labs, "lab-a.mdx"),
    `---\ntitle: Lab A\n---\n\n[Skill A](https://learn.microsoft.com/credentials/applied-skills/skill-a/${TRACKING})\n\n[Skill B](https://learn.microsoft.com/credentials/applied-skills/skill-b/${TRACKING})\n`,
  );
  const cacheFile = join(dir, "applied-skills-cache.json");
  const routesFile = join(dir, "routes.json");
  const monitor = monitorRunner({
    script: join(dir, "scripts", "applied-skills-sync.mjs"),
    dir,
    execArgv: ["--import", pathToFileURL(preload).href],
    env: {
      LISTING_URL,
      BASELINE_FILE: cacheFile,
      FAKE_FETCH_ROUTES: routesFile,
      MIN_SKILLS: "2",
      FETCH_DELAY_MS: "0",
    },
  });
  return {
    run: monitor.run,
    /** What Learn says: the listing, and the page of each skill (a number is an HTTP status). */
    serve: ({ listing, pages = {}, listingBody }) => {
      const routes = {
        [LISTING_URL]: {
          body:
            listingBody ??
            JSON.stringify({ count: listing.length, results: listing }),
        },
      };
      for (const [slug, page] of Object.entries(pages)) {
        routes[detailUrl(slug)] =
          typeof page === "number" ? { status: page } : { body: page };
      }
      writeFileSync(routesFile, JSON.stringify(routes));
    },
    cacheText: () => readFileSync(cacheFile, "utf8"),
    cache: () => JSON.parse(readFileSync(cacheFile, "utf8")),
    /** Makes the last sync look old: a rewrite of the cache would show in it. */
    ageCache: () => {
      const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
      writeFileSync(
        cacheFile,
        JSON.stringify({ ...cache, lastSynced: OLD_SYNC }, null, 2) + "\n",
      );
      return readFileSync(cacheFile, "utf8");
    },
  };
}

const QUIET = {
  changes_found: "false",
  baseline_updated: "false",
  extraction_failed: "false",
};
const names = (entries) => entries.map((entry) => entry.name);

test("the first run sorts the listed skills into active (linked from a lab page) and new (not linked), and reports the new one", async () => {
  const site = setup();
  site.serve({
    listing: [listed(...A), listed(...B), listed(...C)],
    pages: {
      "skill-a": detailPage("Skill A"),
      "skill-b": detailPage("Skill B"),
      "skill-c": detailPage("Skill C"),
    },
  });
  const run = await site.run();
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /FAKE FETCH/);
  assert.deepEqual(run.outputs, {
    changes_found: "true",
    baseline_updated: "true",
    extraction_failed: "false",
  });

  const cache = site.cache();
  assert.match(cache.lastSynced, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(names(cache.active), ["Skill A", "Skill B"]);
  assert.deepEqual(names(cache.new), ["Skill C"]);
  assert.deepEqual(cache.retiring, []);
  assert.deepEqual(cache.active[0], {
    name: "Skill A",
    url: `https://learn.microsoft.com/credentials/applied-skills/skill-a/${TRACKING}`,
    products: ["Azure"],
    labPages: ["labs/azure/lab-a"],
  });

  assert.match(run.report, /^## Applied Skills changes detected/);
  assert.match(
    run.report,
    /### New Applied Skills \(1\) — add to matching lab pages/,
  );
  assert.ok(run.report.includes("| Skill C | Azure | [Link]("));
  assert.ok(!run.report.includes("Retired Applied Skills"));
  assert.ok(!run.report.includes("| Skill A |"));
});

test("a change is reported once: the same listing again says nothing and does not rewrite the cache", async () => {
  const site = setup();
  const pages = {
    "skill-a": detailPage("Skill A"),
    "skill-b": detailPage("Skill B"),
    "skill-c": detailPage("Skill C"),
  };
  site.serve({
    listing: [listed(...A), listed(...B), listed(...C)],
    pages,
  });
  assert.equal((await site.run()).outputs.changes_found, "true");
  const aged = site.ageCache();

  for (let day = 0; day < 2; day++) {
    const quiet = await site.run();
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.deepEqual(quiet.outputs, QUIET);
    assert.equal(quiet.report, null);
    assert.equal(
      site.cacheText(),
      aged,
      "not rewritten: lastSynced is as it was",
    );
  }
});

test("a skill that leaves the listing while a lab page still links it is reported as retired, once, and kept for the lab page", async () => {
  const site = setup();
  const pages = {
    "skill-a": detailPage("Skill A"),
    "skill-b": detailPage("Skill B"),
    "skill-c": detailPage("Skill C"),
  };
  site.serve({
    listing: [listed(...A), listed(...B), listed(...C)],
    pages,
  });
  await site.run();
  site.ageCache();

  // Skill B is gone from the listing and from Learn (404): the lab page still has its card
  site.serve({
    listing: [listed(...A), listed(...C)],
    pages: { ...pages, "skill-b": 404 },
  });
  const retired = await site.run();
  assert.equal(retired.code, 0, retired.stderr);
  assert.deepEqual(retired.outputs, {
    changes_found: "true",
    baseline_updated: "true",
    extraction_failed: "false",
  });
  assert.match(
    retired.report,
    /### Retired Applied Skills \(1\) — remove from lab pages/,
  );
  assert.ok(
    retired.report.includes("| Skill B | — | labs/azure/lab-a | [Link]("),
  );
  assert.ok(!retired.report.includes("New Applied Skills"));
  const cache = site.cache();
  assert.deepEqual(names(cache.active), ["Skill A"]);
  assert.deepEqual(names(cache.new), ["Skill C"]);
  assert.deepEqual(names(cache.retiring), ["Skill B"]);
  assert.deepEqual(cache.retiring[0].labPages, ["labs/azure/lab-a"]);

  // the next run has nothing new to say, and leaves the cache alone
  const aged = site.ageCache();
  const quiet = await site.run();
  assert.deepEqual(quiet.outputs, QUIET);
  assert.equal(quiet.report, null);
  assert.equal(site.cacheText(), aged);
});

test("a listing or a cache that cannot be trusted fails the run with extraction_failed and leaves the cache alone", async () => {
  const site = setup();
  const pages = {
    "skill-a": detailPage("Skill A"),
    "skill-b": detailPage("Skill B"),
  };
  site.serve({ listing: [listed(...A), listed(...B)], pages });
  assert.equal((await site.run()).code, 0);
  const before = site.cacheText();

  const cases = [
    [
      "an answer that is not JSON",
      { listingBody: "<html>captcha</html>" },
      /invalid JSON response/,
    ],
    [
      "an answer without results",
      { listingBody: JSON.stringify({ count: 3 }) },
      /missing results array/,
    ],
    [
      "too few skills",
      { listing: [listed(...A)], pages },
      /returned only 1 skills \(expected at least 2\)/,
    ],
  ];
  for (const [what, serve, message] of cases) {
    site.serve(serve);
    const run = await site.run();
    assert.equal(run.code, 1, what);
    assert.deepEqual(
      run.outputs,
      { ...QUIET, extraction_failed: "true" },
      what,
    );
    assert.match(run.error, message, what);
    assert.equal(run.report, null, what);
    assert.equal(site.cacheText(), before, what);
  }
});
