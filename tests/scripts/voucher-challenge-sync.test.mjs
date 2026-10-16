import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  monitorRunner,
  startServer,
} from "../fixtures/legacy-monitors/harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "voucher-challenge-sync.mjs");
const TRACKING = "?WT.mc_id=studentamb_165290";

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// The TOC of Learn's credentials area: sections of the site (with children of
// their own) and the promotional pages, which are bare top-level items.
const section = (n) => ({
  toc_title: `Evergreen section ${n}`,
  children: [{ toc_title: "A child page", href: `evergreen-${n}/child` }],
});
const promo = (title, href) => ({ toc_title: title, href });
const toc = (...items) => ({
  items: [section(1), section(2), section(3), ...items],
});

const IGNITE = promo("Microsoft Ignite Challenge", "ignite-challenge/");
// a sweepstakes page that only has children: the Official Rules one is its address
const SPRING = {
  toc_title: "Spring Voucher Sweepstakes",
  children: [
    { toc_title: "FAQ", href: "spring-sweepstakes/faq" },
    { toc_title: "Official Rules", href: "spring-sweepstakes/official-rules" },
  ],
};
const BUILD = promo("Build Cloud Skills Challenge", "build-challenge/");

const known = (title, href, firstSeen = "2025-01-15") => ({
  title,
  href,
  firstSeen,
});
const IGNITE_KNOWN = known(IGNITE.toc_title, IGNITE.href);
const SPRING_KNOWN = known(
  SPRING.toc_title,
  "spring-sweepstakes/official-rules",
  "2025-03-02",
);
const OLD_SYNC = "2000-01-01T00:00:00Z";

async function setup({ baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voucher-challenge-sync-"));
  scratchDirs.push(dir);
  const server = await startServer();
  const baselineFile = join(dir, "voucher-challenges.json");
  const write = (challenges) =>
    writeFileSync(
      baselineFile,
      JSON.stringify({ lastSynced: OLD_SYNC, challenges }, null, 2) + "\n",
    );
  if (baseline) write(baseline);
  const monitor = monitorRunner({
    script,
    dir,
    env: {
      TOC_URL: `${server.origin}/toc.json`,
      BASELINE_FILE: baselineFile,
      MIN_TOP_LEVEL_ITEMS: "3",
    },
  });
  return {
    server,
    run: monitor.run,
    serveToc: (body, status = 200) =>
      server.route("/toc.json", {
        status,
        type: "application/json",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    baselineFile,
    baselineText: () => readFileSync(baselineFile, "utf8"),
    baseline: () => JSON.parse(readFileSync(baselineFile, "utf8")),
    close: () => server.close(),
  };
}

const QUIET = {
  changes_found: "false",
  baseline_updated: "false",
  extraction_failed: "false",
};

test("the first run records the promotional pages of the TOC and reports them, the sections of the site are ignored", async () => {
  const site = await setup();
  try {
    site.serveToc(toc(IGNITE, SPRING));
    const run = await site.run();
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
    });

    const baseline = site.baseline();
    assert.match(baseline.lastSynced, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(
      baseline.challenges.map(({ title, href }) => ({ title, href })),
      [
        { title: IGNITE.toc_title, href: "ignite-challenge/" },
        {
          title: SPRING.toc_title,
          href: "spring-sweepstakes/official-rules",
        },
      ],
    );
    for (const challenge of baseline.challenges) {
      assert.match(challenge.firstSeen, /^\d{4}-\d{2}-\d{2}$/);
    }

    assert.match(
      run.report,
      /^## New Microsoft voucher challenge\(s\) detected/,
    );
    assert.ok(
      run.report.includes(
        `| Microsoft Ignite Challenge | [Link](https://learn.microsoft.com/credentials/ignite-challenge/${TRACKING}) |`,
      ),
    );
    assert.ok(run.report.includes("| Spring Voucher Sweepstakes |"));
    assert.ok(!run.report.includes("Evergreen"));
  } finally {
    await site.close();
  }
});

test("a change is reported once: the next run with the same TOC reports nothing and leaves the tracker as it is", async () => {
  const site = await setup({ baseline: [IGNITE_KNOWN, SPRING_KNOWN] });
  try {
    site.serveToc(toc(IGNITE, SPRING));
    const before = site.baselineText();

    for (let day = 0; day < 2; day++) {
      const quiet = await site.run();
      assert.equal(quiet.code, 0, quiet.stderr);
      assert.deepEqual(quiet.outputs, QUIET);
      assert.equal(quiet.report, null);
      // not rewritten: not even lastSynced moved
      assert.equal(site.baselineText(), before);
    }

    // a new page appears: reported, and only that one
    site.serveToc(toc(IGNITE, SPRING, BUILD));
    const found = await site.run();
    assert.deepEqual(found.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
    });
    assert.ok(found.report.includes("Build Cloud Skills Challenge"));
    assert.ok(!found.report.includes("Ignite"));
    assert.ok(!found.report.includes("Spring"));
    const after = site.baseline();
    assert.deepEqual(
      after.challenges.map((challenge) => challenge.href),
      [
        "build-challenge/",
        "ignite-challenge/",
        "spring-sweepstakes/official-rules",
      ],
    );
    // what was known keeps its first sighting
    assert.equal(
      after.challenges.find((c) => c.href === "ignite-challenge/").firstSeen,
      "2025-01-15",
    );
    assert.notEqual(after.lastSynced, OLD_SYNC);

    // ... and the run after it has nothing to say
    const again = await site.run();
    assert.deepEqual(again.outputs, QUIET);
    assert.equal(again.report, null);
  } finally {
    await site.close();
  }
});

test("a page that leaves the TOC stays tracked, and a renamed title is refreshed without a report", async () => {
  const site = await setup({ baseline: [IGNITE_KNOWN, SPRING_KNOWN] });
  try {
    // the Spring page is gone from the TOC: the record is append-only
    site.serveToc(toc(IGNITE, BUILD));
    const gone = await site.run();
    assert.equal(gone.outputs.changes_found, "true"); // Build is new
    assert.ok(
      site.baseline().challenges.some((c) => c.href === SPRING_KNOWN.href),
    );

    // only the title changed: the tracker is updated, nobody is told
    site.serveToc(
      toc(
        { ...IGNITE, toc_title: "Microsoft Ignite Challenge 2026" },
        SPRING,
        BUILD,
      ),
    );
    const renamed = await site.run();
    assert.deepEqual(renamed.outputs, { ...QUIET, baseline_updated: "true" });
    assert.equal(renamed.report, null);
    assert.equal(
      site.baseline().challenges.find((c) => c.href === "ignite-challenge/")
        .title,
      "Microsoft Ignite Challenge 2026",
    );
  } finally {
    await site.close();
  }
});

test("a TOC that cannot be trusted fails the run, writes extraction_failed and leaves the tracker alone", async () => {
  const site = await setup({
    baseline: [
      IGNITE_KNOWN,
      SPRING_KNOWN,
      known("Old Voucher Page", "old-voucher/"),
    ],
  });
  try {
    const before = site.baselineText();
    const cases = [
      ["an HTTP error", [toc(IGNITE), 500], /status 500/],
      ["no JSON", ["<html>captcha</html>", 200], /as JSON/],
      ["no items", [{ nothing: true }, 200], /no top-level `items` array/],
      [
        "too few items",
        [{ items: [section(1), IGNITE] }, 200],
        /only 2 top-level items \(expected at least 3\)/,
      ],
      [
        // 2 of the 3 known pages vanish at once: more than MAX_DROP_PCT (50%)
        "most known pages vanishing",
        [toc(IGNITE), 200],
        /2 of 3 previously known voucher challenges vanished/,
      ],
    ];
    for (const [what, [body, status], message] of cases) {
      site.serveToc(body, status);
      const run = await site.run();
      assert.equal(run.code, 1, what);
      assert.deepEqual(
        run.outputs,
        { ...QUIET, extraction_failed: "true" },
        what,
      );
      assert.match(run.error, message, what);
      assert.equal(run.report, null, what);
      assert.equal(site.baselineText(), before, what);
    }
  } finally {
    await site.close();
  }
});

test("without a baseline file a failed run does not create one", async () => {
  const site = await setup();
  try {
    site.serveToc("nope", 503);
    const run = await site.run();
    assert.equal(run.code, 1);
    assert.equal(run.outputs.extraction_failed, "true");
    assert.ok(!existsSync(site.baselineFile));
  } finally {
    await site.close();
  }
});
