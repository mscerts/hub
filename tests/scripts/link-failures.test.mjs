// Tests for scripts/link-failures.mjs and the Link Checker workflow around it.
// Fully offline: lychee's report is a fixture (lychee-v0.24.2-sample.json was built from
// lychee v0.24.2's source, lychee-v0.24.2-captured.json holds answers of a real run), `gh` is
// a fake Node script that keeps issues in a file, and the lychee-free `check` runner is
// pointed at a local HTTP server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  advanceRedirects,
  advanceTracker,
  analyzeRedirects,
  buildChangeComment,
  buildCheckFailedBody,
  buildCloseComment,
  buildDeadLinksBody,
  buildSourceIndex,
  classifyStatus,
  collectDistLinks,
  collectResults,
  emptyTracker,
  extractListedRedirects,
  extractListedUrls,
  loadConfig,
  lookupLocations,
  normalizeUrl,
  pageFromInput,
  parseLycheeReport,
  parseTracker,
  plain,
  readIgnorePatterns,
  readIncludePatterns,
  redirectRelation,
  reportableEntries,
  reportableRedirects,
  serializeTracker,
  describeHostFailures,
  failureTally,
  failuresByHost,
  syncIssue,
  untrustworthyReason,
  urlVariants,
} from "../../scripts/link-failures.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/link-failures.mjs");
const fixtures = join(repoRoot, "tests/fixtures/link-failures");
const realToml = readFileSync(join(repoRoot, "lychee-external.toml"), "utf8");

const scratch = [];
after(async () => {
  for (const dir of scratch) {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- builders -----------------------------------------------------------------

const DEAD = "https://github.com/Azure/AzureArchitectureExampleScenarios";
const DEAD2 = "https://old-trainer.example.net/az-104";
const VIDEO = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const SC100_PAGE = "dist/certs/security/sc-100/index.html";
const AZ104_PAGE = "dist/certs/azure/az-104/index.html";

const http = (code, phrase) => ({
  text: `Rejected status code: ${code} ${phrase}`,
  code,
});
const NOT_FOUND = http(404, "Not Found");
const FORBIDDEN = http(403, "Forbidden");
const UNAVAILABLE = http(503, "Service Unavailable");
const DNS = {
  text: "Network error: DNS resolution failed - check hostname spelling (error sending request)",
  details: "DNS resolution failed - check hostname spelling",
};

/** A lychee report in the JSON shape of v0.24.2: `failures` are { page, url, status, timeout? }. */
function lycheeReport({ successful = 700, failures = [] } = {}) {
  const error_map = {};
  const timeout_map = {};
  let errors = 0;
  let timeouts = 0;
  for (const f of failures) {
    const map = f.timeout ? timeout_map : error_map;
    if (f.timeout) timeouts++;
    else errors++;
    (map[f.page ?? SC100_PAGE] ??= []).push({
      url: f.url,
      status: f.status,
      span: { line: 171, column: 100 },
      duration: { secs: 0, nanos: 1 },
    });
  }
  return {
    total: successful + errors + timeouts,
    unique: successful,
    successful,
    unknown: 0,
    unsupported: 0,
    timeouts,
    redirects: 0,
    remaps: 0,
    excludes: 4000,
    errors,
    cached: 0,
    success_map: {},
    error_map,
    timeout_map,
    suggestion_map: {},
    redirect_map: {},
    excluded_map: {},
    duration: { secs: 100, nanos: 0 },
    detailed_stats: false,
  };
}

const fail = (url, status, page) => ({ url, status, page });

// --- classification -------------------------------------------------------------

test("a 404 or 410 is broken, a DNS failure or bad certificate is unreachable", () => {
  assert.deepEqual(classifyStatus(NOT_FOUND), {
    kind: "broken",
    code: 404,
    reason: "404 Not Found",
  });
  assert.equal(classifyStatus(http(410, "Gone")).kind, "broken");
  assert.equal(classifyStatus(http(400, "Bad Request")).kind, "broken");
  assert.equal(classifyStatus(DNS).kind, "unreachable");
  assert.match(classifyStatus(DNS).reason, /DNS lookup failed/);
  assert.equal(
    classifyStatus({
      text: "Network error: SSL certificate expired. Site needs to renew certificate",
    }).kind,
    "unreachable",
  );
  assert.equal(
    classifyStatus({
      text: "Network error: Connection refused - server may be down or port blocked",
    }).kind,
    "unreachable",
  );
});

test("403, 429, 5xx, timeouts and unclear network errors are only warnings", () => {
  for (const code of [
    401, 403, 405, 406, 407, 408, 429, 500, 502, 503, 504, 999,
  ]) {
    assert.equal(
      classifyStatus({ text: `Rejected status code: ${code} x`, code }).kind,
      "warning",
      `HTTP ${code}`,
    );
  }
  assert.equal(
    classifyStatus(
      { text: "Timeout", details: "Request timed out" },
      { timedOut: true },
    ).kind,
    "warning",
  );
  // a timeout is told apart from the other inconclusive answers (the failsafe counts it)
  assert.equal(
    classifyStatus({ text: "Timeout" }, { timedOut: true }).timedOut,
    true,
  );
  assert.equal(classifyStatus(FORBIDDEN).timedOut, undefined);
  for (const text of [
    "Network error: DNS temporarily unavailable. Try again later",
    "Network error: Too many redirects - check for redirect loops",
    "Network error: TLS handshake failed. Check SSL/TLS configuration",
    "Network error: Connection closed unexpectedly. Server terminated early",
  ]) {
    assert.equal(classifyStatus({ text }).kind, "warning", text);
  }
  // an unexpected non-error code (a rejected 3xx) says nothing about the page either
  assert.equal(
    classifyStatus({ text: "Rejected status code: 300 x", code: 300 }).kind,
    "warning",
  );
});

test("text from lychee is neutralised before it reaches an issue", () => {
  const dirty = "<script>x</script>\n@octocat see #123 `rm` | a";
  const clean = plain(dirty);
  assert.doesNotMatch(clean, /[<>`|\n]/);
  assert.doesNotMatch(clean, /@octocat/);
  assert.doesNotMatch(clean, /#123/);
  assert.equal(plain("x".repeat(500), 20).length, 20);
});

// --- reading lychee's report ------------------------------------------------------

test("the sample report in lychee's v0.24.2 shape is parsed and grouped by link", () => {
  const report = parseLycheeReport(
    readFileSync(join(fixtures, "lychee-v0.24.2-sample.json"), "utf8"),
  );
  assert.equal(report.counts.successful, 600);
  assert.equal(report.counts.errors, 4);
  const { results, ignored } = collectResults(report);
  assert.equal(ignored, 0);
  assert.equal(results.size, 4);
  assert.equal(results.get(DEAD).kind, "broken");
  assert.deepEqual([...results.get(DEAD).pages], [SC100_PAGE]);
  assert.equal(results.get(DEAD2).kind, "unreachable");
  const pluralsight =
    "https://www.pluralsight.com/paths/microsoft-azure-administrator-az-104";
  assert.equal(results.get(pluralsight).kind, "warning");
  assert.deepEqual(
    [...results.get(pluralsight).pages].sort(),
    [AZ104_PAGE, SC100_PAGE].sort(),
  );
  assert.equal(results.get("https://slow.example.org/").kind, "warning");
  assert.equal(results.get("https://slow.example.org/").reason, "timed out");
});

test("a report that is not lychee's JSON fails loudly", () => {
  assert.throws(() => parseLycheeReport("not json"), /not valid JSON/);
  assert.throws(() => parseLycheeReport("[]"), /no `error_map`/);
  assert.throws(() => parseLycheeReport('{"errors":0}'), /no `error_map`/);
  assert.throws(
    () => parseLycheeReport('{"error_map":{},"timeout_map":[]}'),
    /timeout_map/,
  );
  assert.throws(
    () => parseLycheeReport('{"errors":3,"error_map":{}}'),
    /counts 3 errors but lists none/,
  );
  // lychee omits nothing, but an older/newer report without timeout_map still parses
  const ok = parseLycheeReport('{"successful":5,"error_map":{}}');
  assert.equal(ok.counts.successful, 5);
  assert.deepEqual(ok.timeoutMap, {});
});

test("links that are not web links are ignored, not judged", () => {
  const report = parseLycheeReport(
    JSON.stringify(
      lycheeReport({
        failures: [
          fail("file:///work/dist/certs/x/", { text: "File not found" }),
          fail("https://a.example/", NOT_FOUND),
        ],
      }),
    ),
  );
  const { results, ignored } = collectResults(report);
  assert.equal(ignored, 1);
  assert.deepEqual([...results.keys()], ["https://a.example/"]);
});

// --- one link on several pages ------------------------------------------------------------

// lychee-v0.24.2-captured.json holds answers as a real lychee v0.24.2 wrote them on Linux
// (2026-10-14): one refused address on three pages (the page that lychee lists first keeps the
// real answer, the others only say "Error (cached)", and which page that is changes from run
// to run), a 404 that keeps its code and text on all three pages, a domain that does not
// resolve (lychee words it "Connection failed. Check network connectivity and firewall
// settings") and an expired certificate. The page names and the address of the 404 are stand-ins.
const REFUSED = "http://127.0.0.1:9/closed";
const GONE_404 = "https://example.com/does-not-exist";
const NO_DOMAIN = "http://this-domain-should-not-exist-9f8e7d6c5b4a.com/page";
const EXPIRED = "https://expired.badssl.com/";
const PL300_PAGE = "dist/certs/power/pl-300/index.html";
const CACHED = { text: "Error (cached)", details: "Error (cached)" };
const capturedReport = () =>
  JSON.parse(
    readFileSync(join(fixtures, "lychee-v0.24.2-captured.json"), "utf8"),
  );

const permutations = (items) =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );

/** The report with its pages listed in `order` and, with `reverse`, the answers of every page backwards. */
function listed(report, order, reverse = false) {
  const error_map = {};
  for (const page of order) {
    const answers = [...report.error_map[page]];
    error_map[page] = reverse ? answers.reverse() : answers;
  }
  return { ...report, error_map };
}

/** Every order in which lychee could list the pages and the answers of the captured report. */
const allListings = (report) =>
  permutations(Object.keys(report.error_map)).flatMap((order) => [
    listed(report, order),
    listed(report, order, true),
  ]);

const judgedLinks = (report) =>
  [
    ...collectResults(
      parseLycheeReport(JSON.stringify(report)),
    ).results.values(),
  ].map(({ url, kind, code, reason, timedOut, pages }) => ({
    url,
    kind,
    code,
    reason,
    timedOut: timedOut ?? false,
    pages: [...pages],
  }));

const THREE_PAGES = [AZ104_PAGE, PL300_PAGE, SC100_PAGE];
const CAPTURED_VERDICTS = [
  {
    url: REFUSED,
    kind: "unreachable",
    code: null,
    reason: "connection refused",
    timedOut: false,
    pages: THREE_PAGES,
  },
  {
    url: NO_DOMAIN,
    kind: "unreachable",
    code: null,
    reason: "connection failed (the domain may be gone)",
    timedOut: false,
    pages: [AZ104_PAGE],
  },
  {
    url: GONE_404,
    kind: "broken",
    code: 404,
    reason: "404 Not Found",
    timedOut: false,
    pages: THREE_PAGES,
  },
  {
    url: EXPIRED,
    kind: "unreachable",
    code: null,
    reason:
      "TLS certificate problem: SSL certificate expired. Site needs to renew certificate (error sending request for url (https://expired.badssl.com/))",
    timedOut: false,
    pages: [AZ104_PAGE],
  },
];

test("a link on several pages is judged by its real answer, not by lychee's cached repeats, whichever page comes first", () => {
  const listings = allListings(capturedReport());
  assert.equal(
    listings.length,
    12,
    "3 pages in every order, answers both ways",
  );
  for (const report of listings) {
    assert.deepEqual(
      judgedLinks(report),
      CAPTURED_VERDICTS,
      Object.keys(report.error_map).join(" "),
    );
  }
  // the refused address and the 404 keep all three pages, in site order, from every listing
  const [refused, , notFound] = judgedLinks(capturedReport());
  assert.deepEqual(refused.pages, THREE_PAGES);
  assert.deepEqual(notFound.pages, THREE_PAGES);
});

test("a 404 keeps its code and its text on every page: nothing changes for answers that are not cached repeats", () => {
  // as lychee wrote it in the captured report: the same answer on all three pages
  const captured = capturedReport();
  for (const page of THREE_PAGES) {
    assert.deepEqual(
      captured.error_map[page].find((f) => f.url === GONE_404).status,
      NOT_FOUND,
    );
  }
  const { results } = collectResults(
    parseLycheeReport(
      JSON.stringify(
        lycheeReport({
          failures: THREE_PAGES.map((page) => fail(GONE_404, NOT_FOUND, page)),
        }),
      ),
    ),
  );
  const gone = results.get(GONE_404);
  assert.deepEqual(
    [gone.kind, gone.code, gone.reason, [...gone.pages]],
    ["broken", 404, "404 Not Found", THREE_PAGES],
  );
  assert.deepEqual(failureTally(results), { hard: 3, timedOut: 0, other: 0 });
});

test("when every answer for a link is a cached repeat one is kept, the same whatever the order; a real timeout outranks the repeats", () => {
  const allCached = (order) =>
    parseLycheeReport(
      JSON.stringify(
        lycheeReport({
          failures: order.map((page) => fail(REFUSED, CACHED, page)),
        }),
      ),
    );
  const outcomes = permutations(THREE_PAGES).map((order) =>
    collectResults(allCached(order)).results.get(REFUSED),
  );
  for (const result of outcomes) {
    assert.equal(result.kind, "warning");
    assert.equal(result.reason, "Error (cached)");
    assert.deepEqual([...result.pages], THREE_PAGES);
  }
  // lychee puts a timeout in timeout_map and its repeats in error_map as cached errors
  const timedOutOnce = (order) =>
    parseLycheeReport(
      JSON.stringify(
        lycheeReport({
          failures: order.map((page) =>
            page === AZ104_PAGE
              ? {
                  url: REFUSED,
                  status: { text: "Timeout" },
                  timeout: true,
                  page,
                }
              : fail(REFUSED, CACHED, page),
          ),
        }),
      ),
    );
  for (const order of permutations(THREE_PAGES)) {
    const { results } = collectResults(timedOutOnce(order));
    const result = results.get(REFUSED);
    assert.equal(result.timedOut, true, order.join(" "));
    assert.equal(result.reason, "timed out");
    assert.deepEqual([...result.pages], THREE_PAGES);
    // the failsafe counts all three answers as timeouts, not as unclear network errors
    assert.deepEqual(failureTally(results), { hard: 0, timedOut: 3, other: 0 });
  }
});

test("a domain that does not resolve is unreachable, in the words lychee uses on Linux too", () => {
  const status = {
    text: "Network error: Connection failed. Check network connectivity and firewall settings (error sending request for url (http://this-domain-should-not-exist-9f8e7d6c5b4a.com/page))",
    details:
      "Connection failed. Check network connectivity and firewall settings",
  };
  assert.deepEqual(classifyStatus(status), {
    kind: "unreachable",
    code: null,
    reason: "connection failed (the domain may be gone)",
  });
  // the wording is read from the details too, and the other network errors stay warnings
  assert.equal(
    classifyStatus({
      details:
        "Connection failed. Check network connectivity and firewall settings",
    }).kind,
    "unreachable",
  );
  assert.equal(
    classifyStatus({
      text: "Network error: Connection closed unexpectedly. Server terminated early",
    }).kind,
    "warning",
  );
  // a failed connection that timed out is a timeout, whatever its text
  assert.equal(classifyStatus(status, { timedOut: true }).kind, "warning");
});

test("the pages of a link are listed sorted, so the issue text does not depend on the order lychee lists them in", () => {
  const entries = [
    {
      url: GONE_404,
      firstSeen: "2026-10-12",
      lastSeen: "2026-10-19",
      runs: 2,
      reason: "404 Not Found",
    },
  ];
  const pagesOf = (...order) => new Map([[GONE_404, order]]);
  const body = (...order) =>
    buildDeadLinksBody(entries, {
      locations: new Map(),
      pages: pagesOf(...order),
    });
  const sorted = body("/a/", "/b/", "/c/", "/d/", "/e/");
  assert.match(sorted, /Built pages: `\/a\/`, `\/b\/`, `\/c\/` and 2 more\./);
  for (const order of permutations(["/a/", "/b/", "/c/", "/d/", "/e/"])) {
    assert.equal(body(...order), sorted, order.join(" "));
  }
});

test("a run with too few answers or too many failures is not trusted", () => {
  const cfg = { minLinksChecked: 300, maxFailedPct: 25 };
  const parse = (o) => parseLycheeReport(JSON.stringify(o));
  assert.equal(untrustworthyReason(parse(lycheeReport()), cfg), null);
  assert.match(
    untrustworthyReason(parse(lycheeReport({ successful: 20 })), cfg),
    /only 20 links/,
  );
  const mass = lycheeReport({
    successful: 700,
    failures: Array.from({ length: 300 }, (_, i) =>
      fail(`https://h.example/${i}`, NOT_FOUND),
    ),
  });
  assert.match(untrustworthyReason(parse(mass), cfg), /30%/);
});

test("403, 429 and 5xx answers do not make a run untrustworthy; dead links and timeouts do", () => {
  const cfg = { minLinksChecked: 300, maxFailedPct: 25 };
  const parse = (o) => parseLycheeReport(JSON.stringify(o));
  let seq = 0; // every failure gets its own link, across all groups
  const many = (count, status, extra = {}) =>
    Array.from({ length: count }, () => ({
      url: `https://h${seq % 8}.example/${seq++}`,
      status,
      ...extra,
    }));
  // 400 of 1100 answers (36%) are bot-blocking answers: the commercial training sites
  // answer 403 or 429 to datacenter addresses. The run is still judged.
  const blocked = parse(
    lycheeReport({
      successful: 700,
      failures: [...many(250, FORBIDDEN), ...many(150, http(429, "Too Many"))],
    }),
  );
  assert.equal(untrustworthyReason(blocked, cfg), null);
  // so is an outage of one host family (503) and a pile of slow answers below the limit
  const flaky = parse(
    lycheeReport({ successful: 700, failures: many(400, UNAVAILABLE) }),
  );
  assert.equal(untrustworthyReason(flaky, cfg), null);

  // timeouts count, together with dead and unreachable links
  const slow = parse(
    lycheeReport({
      successful: 700,
      failures: many(300, { text: "Timeout" }, { timeout: true }),
    }),
  );
  const slowReason = untrustworthyReason(slow, cfg);
  assert.match(slowReason, /300 of 1000 links \(30%\) failed hard/);
  assert.match(slowReason, /0 dead or unreachable, 300 timed out/);
  const mixed = parse(
    lycheeReport({
      successful: 600,
      failures: [
        ...many(100, NOT_FOUND),
        ...many(100, DNS),
        ...many(100, { text: "Timeout" }, { timeout: true }),
        ...many(200, FORBIDDEN),
      ],
    }),
  );
  const mixedReason = untrustworthyReason(mixed, cfg);
  assert.match(mixedReason, /300 of 1100 links \(27%\) failed hard/);
  assert.match(mixedReason, /200 dead or unreachable, 100 timed out/);
  assert.match(mixedReason, /Another 200 answered 403, 429, 5xx/);
  // the limit is a parameter
  assert.equal(untrustworthyReason(mixed, { ...cfg, maxFailedPct: 30 }), null);
});

test("the failed answers are tallied by kind and by host, with the answers that were inconclusive", () => {
  const report = parseLycheeReport(
    JSON.stringify(
      lycheeReport({
        failures: [
          fail("https://www.whizlabs.com/a", FORBIDDEN, AZ104_PAGE),
          fail("https://www.whizlabs.com/a", FORBIDDEN, SC100_PAGE),
          fail("https://www.whizlabs.com/b", http(429, "Too Many")),
          fail("https://www.whizlabs.com/c", FORBIDDEN),
          fail("https://www.whizlabs.com/dead", NOT_FOUND),
          fail("https://slow.example.org/", { text: "Timeout" }),
          fail("https://down.example.net/", DNS),
          {
            url: "https://slow.example.org/x",
            status: { text: "Timeout" },
            timeout: true,
          },
        ],
      }),
    ),
  );
  const { results } = collectResults(report);
  // per link per page, like lychee's own totals
  assert.deepEqual(failureTally(results), { hard: 2, timedOut: 1, other: 5 });
  const hosts = failuresByHost(results);
  assert.deepEqual(
    hosts.map((h) => [h.host, h.total, h.hard, h.timedOut, h.other]),
    [
      ["www.whizlabs.com", 5, 1, 0, 4],
      ["slow.example.org", 2, 0, 1, 1],
      ["down.example.net", 1, 1, 0, 0],
    ],
  );
  assert.deepEqual(
    [...hosts[0].codes],
    [
      ["HTTP 403", 3],
      ["HTTP 429", 1],
    ],
  );
  assert.deepEqual(describeHostFailures(hosts), [
    "- `www.whizlabs.com`: 5 failed answers (1 dead or unreachable, 0 timed out, 4 inconclusive (HTTP 403 x3, HTTP 429 x1))",
    "- `slow.example.org`: 2 failed answers (0 dead or unreachable, 1 timed out, 1 inconclusive (Timeout x1))",
    "- `down.example.net`: 1 failed answer (1 dead or unreachable, 0 timed out, 0 inconclusive)",
  ]);
  // a long list is cut with a count
  const many = Array.from({ length: 20 }, (_, i) => ({
    host: `h${i}.example`,
    total: 1,
    hard: 1,
    timedOut: 0,
    other: 0,
    codes: new Map(),
  }));
  const cut = describeHostFailures(many, 15);
  assert.equal(cut.length, 16);
  assert.equal(cut.at(-1), "- and 5 more hosts");
});

// --- the tracker -------------------------------------------------------------------

const results = (...entries) =>
  new Map(
    entries.map(([url, status, timedOut]) => [
      url,
      { url, ...classifyStatus(status, { timedOut }), pages: new Set() },
    ]),
  );

test("a link is reported only when it failed on two consecutive days, once per day", () => {
  let tracker = emptyTracker();
  tracker = advanceTracker(tracker, results([DEAD, NOT_FOUND]), "2026-10-12");
  assert.deepEqual(tracker.failing[DEAD], {
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-12",
    runs: 1,
    reason: "404 Not Found",
  });
  assert.deepEqual(reportableEntries(tracker), []);
  // a second run on the same day counts as the same observation
  const sameDay = advanceTracker(
    tracker,
    results([DEAD, NOT_FOUND]),
    "2026-10-12",
  );
  assert.deepEqual(sameDay, tracker);
  tracker = advanceTracker(tracker, results([DEAD, NOT_FOUND]), "2026-10-19");
  assert.equal(tracker.failing[DEAD].runs, 2);
  assert.equal(tracker.failing[DEAD].firstSeen, "2026-10-12");
  assert.deepEqual(
    reportableEntries(tracker).map((e) => e.url),
    [DEAD],
  );
});

test("a confirmed link is frozen, so a link that stays dead causes no weekly change", () => {
  const confirmed = advanceTracker(
    advanceTracker(emptyTracker(), results([DEAD, NOT_FOUND]), "2026-10-12"),
    results([DEAD, NOT_FOUND]),
    "2026-10-19",
  );
  const later = advanceTracker(
    confirmed,
    results([DEAD, http(410, "Gone")]),
    "2026-10-26",
  );
  assert.equal(serializeTracker(later), serializeTracker(confirmed));
});

test("a link that works again, or is removed from the site, is forgotten", () => {
  const tracker = advanceTracker(
    emptyTracker(),
    results([DEAD, NOT_FOUND], [DEAD2, DNS]),
    "2026-10-12",
  );
  const next = advanceTracker(tracker, results([DEAD2, DNS]), "2026-10-19");
  assert.deepEqual(Object.keys(next.failing), [DEAD2]);
  assert.equal(next.failing[DEAD2].runs, 2);
  assert.deepEqual(
    advanceTracker(next, results(), "2026-10-26"),
    emptyTracker(),
  );
});

test("an inconclusive answer neither advances nor resets what is known", () => {
  const tracker = advanceTracker(
    emptyTracker(),
    results([DEAD, NOT_FOUND]),
    "2026-10-12",
  );
  for (const status of [
    FORBIDDEN,
    UNAVAILABLE,
    http(429, "Too Many Requests"),
  ]) {
    assert.deepEqual(
      advanceTracker(tracker, results([DEAD, status]), "2026-10-19"),
      tracker,
    );
  }
  assert.deepEqual(
    advanceTracker(
      tracker,
      results([DEAD, { text: "Timeout" }, true]),
      "2026-10-19",
    ),
    tracker,
  );
  // a warning for a link the tracker does not know is not recorded
  assert.deepEqual(
    advanceTracker(emptyTracker(), results([VIDEO, UNAVAILABLE]), "2026-10-19"),
    emptyTracker(),
  );
  // ... and the streak goes on after the inconclusive run
  const after = advanceTracker(
    tracker,
    results([DEAD, NOT_FOUND]),
    "2026-10-26",
  );
  assert.equal(after.failing[DEAD].runs, 2);
});

test("a first failure from long ago does not count as the run before", () => {
  const old = {
    failing: {
      [DEAD]: {
        firstSeen: "2026-08-01",
        lastSeen: "2026-08-01",
        runs: 1,
        reason: "404 Not Found",
      },
    },
  };
  const next = advanceTracker(old, results([DEAD, NOT_FOUND]), "2026-10-12");
  assert.deepEqual(next.failing[DEAD], {
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-12",
    runs: 1,
    reason: "404 Not Found",
  });
  // inside the gap it is the run before
  const near = advanceTracker(old, results([DEAD, NOT_FOUND]), "2026-08-10");
  assert.equal(near.failing[DEAD].runs, 2);
});

test("the tracker file is validated and written with sorted keys", () => {
  const text = serializeTracker(
    advanceTracker(
      emptyTracker(),
      results([DEAD2, DNS], [DEAD, NOT_FOUND]),
      "2026-10-12",
    ),
  );
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(Object.keys(JSON.parse(text).failing), [DEAD, DEAD2].sort());
  assert.deepEqual(parseTracker(text), JSON.parse(text));
  assert.equal(serializeTracker(emptyTracker()), '{\n  "failing": {}\n}\n');
  assert.throws(() => parseTracker("{"), /not valid JSON/);
  assert.throws(() => parseTracker("{}"), /no "failing" object/);
  assert.throws(
    () => parseTracker('{"failing":{"https://a.example/":{"runs":0}}}'),
    /malformed/,
  );
});

// --- where a dead link lives ---------------------------------------------------------

const sourceIndex = () => buildSourceIndex(join(fixtures, "src"), fixtures);

test("a dead link is found in the sources with file and line, never in the tracker file", () => {
  const index = sourceIndex();
  assert.ok(index.every((f) => !f.file.endsWith("link-failures.json")));
  assert.deepEqual(lookupLocations(index, DEAD), {
    places: ["src/content/docs/security/SC-100.mdx:13"],
    total: 1,
  });
  // a longer address that starts like the link is a different link
  assert.ok(
    !lookupLocations(index, DEAD).places.some((p) => p.endsWith(":14")),
  );
  const trainer = lookupLocations(index, DEAD2);
  assert.deepEqual(trainer.places.sort(), [
    "src/components/links.ts:2",
    "src/content/docs/azure/AZ-104.mdx:7",
  ]);
  assert.deepEqual(lookupLocations(index, "https://nowhere.example/page"), {
    places: [],
    total: 0,
  });
});

test("a link is found however the source spells it", () => {
  // lychee reports the decoded address, MDX holds it with a bare &, HTML with &amp;
  const esi = "https://esi.microsoft.com/Search?q=AZ-204&avail=Available";
  assert.deepEqual(lookupLocations(sourceIndex(), esi).places, [
    "src/content/docs/security/SC-100.mdx:19",
  ]);
  const files = [
    {
      file: "a.html",
      text: 'x <a href="https://e.example/a?b=1&amp;c=2">y</a>',
    },
    { file: "b.mdx", text: "[x](https://e.example/dir)\n" },
    {
      file: "c.mdx",
      text: "see https://e.example/dir/ and https://e.example/dir/more",
    },
  ];
  assert.deepEqual(
    lookupLocations(files, "https://e.example/a?b=1&c=2").places,
    ["a.html:1"],
  );
  assert.deepEqual(lookupLocations(files, "https://e.example/dir/").places, [
    "b.mdx:1",
    "c.mdx:1",
  ]);
  // the fragment of a source link does not matter to the request
  assert.deepEqual(
    lookupLocations(
      [{ file: "d.mdx", text: "https://e.example/page#u44 and more" }],
      "https://e.example/page",
    ).places,
    ["d.mdx:1"],
  );
  assert.ok(
    urlVariants("https://e.example/a/").includes("https://e.example/a"),
  );
  const many = Array.from({ length: 9 }, (_, i) => ({
    file: `f${i}.mdx`,
    text: "https://e.example/common",
  }));
  const capped = lookupLocations(many, "https://e.example/common", 3);
  assert.equal(capped.places.length, 3);
  assert.equal(capped.total, 9);
});

test("the built page of a link is shown as its site path", () => {
  assert.equal(pageFromInput(SC100_PAGE), "/certs/security/sc-100/");
  assert.equal(
    pageFromInput("C:\\work\\hub\\dist\\certs\\azure\\az-104\\index.html"),
    "/certs/azure/az-104/",
  );
  assert.equal(pageFromInput("dist/404.html"), "/404");
  assert.equal(pageFromInput("elsewhere/page.html"), "elsewhere/page.html");
});

// --- issue texts -----------------------------------------------------------------------

function sampleEntries() {
  return [
    {
      url: DEAD,
      firstSeen: "2026-10-12",
      lastSeen: "2026-10-19",
      runs: 2,
      reason: "404 Not Found",
    },
    {
      url: DEAD2,
      firstSeen: "2026-10-19",
      lastSeen: "2026-10-26",
      runs: 2,
      reason: "DNS lookup failed (the domain may be gone)",
    },
  ];
}

test("the dead-links issue names the link, the problem, the date, the source line and the fix", () => {
  const index = sourceIndex();
  const entries = sampleEntries();
  const body = buildDeadLinksBody(entries, {
    locations: new Map(
      entries.map((e) => [e.url, lookupLocations(index, e.url)]),
    ),
    pages: new Map([
      [DEAD, ["/certs/security/sc-100/"]],
      [DEAD2, ["/certs/azure/az-104/", "/a/", "/b/", "/c/"]],
    ]),
  });
  assert.match(body, /two runs in a row/);
  assert.match(
    body,
    /`https:\/\/github\.com\/Azure\/AzureArchitectureExampleScenarios`/,
  );
  assert.match(body, /404 Not Found \| 2026-10-12/);
  assert.match(body, /`src\/content\/docs\/security\/SC-100\.mdx:13`/);
  assert.match(body, /Built page: `\/certs\/security\/sc-100\/`/);
  assert.match(body, /and 1 more/);
  assert.match(body, /### What to do/);
  assert.match(body, /WT\.mc_id=studentamb_165290/);
  assert.doesNotMatch(body, /Archive/);
  // the text depends on the situation only: no date, no run link, so an unchanged state is no edit
  assert.equal(
    body,
    buildDeadLinksBody(entries, {
      locations: new Map(
        entries.map((e) => [e.url, lookupLocations(index, e.url)]),
      ),
      pages: new Map([
        [DEAD, ["/certs/security/sc-100/"]],
        [DEAD2, ["/certs/azure/az-104/", "/a/", "/b/", "/c/"]],
      ]),
    }),
  );
  assert.deepEqual(extractListedUrls(body), [DEAD, DEAD2]);
});

test("a link without a source location, and hostile text, stay harmless in the issue", () => {
  const nasty = "https://e.example/a|b`c--><script>x";
  const body = buildDeadLinksBody(
    [
      {
        url: nasty,
        firstSeen: "2026-10-12",
        lastSeen: "2026-10-19",
        runs: 2,
        reason: "<img src=x onerror=1> @octocat #123 | x",
      },
    ],
    { locations: new Map(), pages: new Map() },
  );
  assert.match(body, /not found in `src\/` as written/);
  assert.doesNotMatch(body, /<img|<script|@octocat(?!\u200b)|#123/);
  assert.match(body, /a\\\|b%60c--%3E%3Cscript%3Ex/);
  // the marker survives a link that contains the comment terminator, and closes only once
  assert.deepEqual(extractListedUrls(body), [nasty]);
  assert.equal(body.split("-->").length, 2);
});

test("a very long list is cut below GitHub's size limit, keeping the marker", () => {
  const entries = Array.from({ length: 900 }, (_, i) => ({
    url: `https://example.org/${"x".repeat(80)}/${i}`,
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-19",
    runs: 2,
    reason: "404 Not Found",
  }));
  const body = buildDeadLinksBody(entries, {
    locations: new Map(),
    pages: new Map(),
  });
  assert.ok(body.length < 65_000, `body is ${body.length} characters`);
  assert.match(body, /more links are not shown here/);
  assert.ok(extractListedUrls(body).length > 0);
});

test("the check-failed issue says why and what to do", () => {
  const body = buildCheckFailedBody({
    reason: "lychee wrote no report.",
    today: "2026-10-19",
    runUrl: "https://github.com/mscerts/hub/actions/runs/1",
  });
  assert.match(body, /\*\*Why:\*\* lychee wrote no report\./);
  assert.match(
    body,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/1/,
  );
  assert.match(body, /tracker was left as it was/);
  // without a host list the text is the short one
  assert.doesNotMatch(body, /by host/);
  assert.match(body, /\n3\. Try the same check locally/);
});

test("the check-failed issue names the failing hosts and says which one to remove when a host blocks the runner", () => {
  const body = buildCheckFailedBody({
    reason: "300 of 1000 links failed hard.",
    today: "2026-10-19",
    runUrl: null,
    hostLines: [
      "- `www.whizlabs.com`: 39 failed answers (0 dead or unreachable, 0 timed out, 39 inconclusive (HTTP 403 x39))",
    ],
  });
  assert.match(
    body,
    /\*\*Failed answers by host \(most first\):\*\*\n\n- `www\.whizlabs\.com`: 39 failed answers/,
  );
  assert.match(
    body,
    /\n2\. If one host accounts for most of the failed answers and they are 403 or 429, that host blocks the runner: remove it from `include` in `lychee-external\.toml`\./,
  );
  assert.match(
    body,
    /\n3\. An outage or blocking of the runner usually passes/,
  );
  assert.match(body, /\n4\. Try the same check locally/);
});

// --- syncIssue against a stub gh ---------------------------------------------------------

function stubGh({ open = [], fail = "", labels = [] } = {}) {
  const calls = [];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, args, input });
    if (fail && command === fail) throw new Error(`${fail} failed`);
    // like the real listing: the number and the title, never the text
    if (command === "issue list") {
      return JSON.stringify(
        open.map(({ number, title }) => ({ number, title })),
      );
    }
    if (command === "issue view") {
      const issue = open.find((i) => i.number === Number(args[2]));
      return JSON.stringify({ body: issue?.body ?? "" });
    }
    if (command === "label list") {
      return JSON.stringify(labels.map((name) => ({ name })));
    }
    if (command === "issue create") return "https://github.com/o/r/issues/7";
    return "";
  };
  return { gh, calls };
}

const syncArgs = {
  enabled: true,
  title: "T",
  label: "L",
  labelColor: "ffffff",
  labelDescription: "d",
  body: "BODY",
  closeComment: "bye",
};

test("syncIssue creates one issue, then only edits and comments on it", () => {
  const created = stubGh();
  const a = syncIssue({ ...syncArgs, gh: created.gh, active: true });
  assert.equal(a.action, "created");
  assert.equal(a.number, 7);
  assert.deepEqual(
    created.calls.map((c) => c.command),
    ["issue list", "label create", "issue create"],
  );
  assert.equal(created.calls[2].input, "BODY");

  const open = [
    { number: 3, title: "T", body: "OLD" },
    { number: 9, title: "T", body: "OLDER COPY" },
    { number: 4, title: "other", body: "x" },
  ];
  const updated = stubGh({ open });
  const b = syncIssue({
    ...syncArgs,
    gh: updated.gh,
    active: true,
    changeComment: () => "CHANGED",
  });
  assert.equal(b.action, "updated");
  assert.equal(b.number, 3);
  // the listing carries no texts: only the text of the oldest copy is read, by its number
  assert.deepEqual(
    updated.calls.map((c) => [c.command, c.args[2]]),
    [
      ["issue list", "--state"],
      ["issue view", "3"],
      ["issue edit", "3"],
      ["issue comment", "3"],
    ],
  );
  assert.equal(updated.calls[0].args.at(-1), "number,title");
  assert.equal(updated.calls[3].input, "CHANGED");

  const same = stubGh({ open: [{ number: 3, title: "T", body: "BODY\r\n" }] });
  const c = syncIssue({ ...syncArgs, gh: same.gh, active: true });
  assert.equal(c.action, "unchanged");
  assert.deepEqual(
    same.calls.map((x) => x.command),
    ["issue list", "issue view"],
  );
});

test("syncIssue closes every open copy when nothing is left, and never throws for that", () => {
  const closing = stubGh({
    open: [
      { number: 3, title: "T", body: "" },
      { number: 5, title: "T", body: "" },
    ],
  });
  const r = syncIssue({ ...syncArgs, gh: closing.gh, active: false });
  assert.equal(r.action, "closed");
  assert.deepEqual(r.closed, [3, 5]);
  assert.deepEqual(
    closing.calls.map((c) => c.command),
    ["issue list", "issue close", "issue close"],
    "closing needs no text, so none is read",
  );
  assert.deepEqual(closing.calls[1].args, [
    "issue",
    "close",
    "3",
    "--comment",
    "bye",
  ]);

  const failing = stubGh({
    open: [{ number: 3, title: "T", body: "" }],
    fail: "issue close",
  });
  assert.equal(
    syncIssue({ ...syncArgs, gh: failing.gh, active: false }).action,
    "close-failed",
  );
  const lookup = stubGh({ fail: "issue list" });
  assert.equal(
    syncIssue({ ...syncArgs, gh: lookup.gh, active: false }).action,
    "lookup-failed",
  );
  assert.throws(
    () => syncIssue({ ...syncArgs, gh: lookup.gh, active: true }),
    /issue list failed/,
  );
  // a text that cannot be read is a failed lookup too: the issue is needed, so the run fails
  const unreadable = stubGh({
    open: [{ number: 3, title: "T", body: "x" }],
    fail: "issue view",
  });
  assert.throws(
    () => syncIssue({ ...syncArgs, gh: unreadable.gh, active: true }),
    /issue view failed/,
  );
  assert.ok(!unreadable.calls.some((c) => c.command === "issue edit"));
  const off = stubGh();
  assert.equal(
    syncIssue({ ...syncArgs, gh: off.gh, enabled: false, active: true }).action,
    "skipped",
  );
  assert.equal(off.calls.length, 0);
});

test("a label that cannot be created is forgiven only when it exists; any other failure stops the issue", () => {
  // the label is there already, so gh refuses to create it again: the issue is still created
  const exists = stubGh({ fail: "label create", labels: ["L"] });
  assert.equal(
    syncIssue({ ...syncArgs, gh: exists.gh, active: true }).action,
    "created",
  );
  assert.deepEqual(
    exists.calls.map((c) => c.command),
    ["issue list", "label create", "label list", "issue create"],
  );
  // a creation that fails for another reason (a token without the right) is not swallowed
  const broken = stubGh({ fail: "label create" });
  assert.throws(
    () => syncIssue({ ...syncArgs, gh: broken.gh, active: true }),
    /label create failed/,
  );
  assert.ok(!broken.calls.some((c) => c.command === "issue create"));
});

// --- the allowlist in lychee-external.toml ---------------------------------------------------

test("the real allowlist selects resource links and skips share buttons, Learn and the rest", () => {
  const patterns = readIncludePatterns(realToml);
  assert.ok(patterns.length >= 15, `${patterns.length} patterns`);
  for (const p of patterns) new RegExp(p); // every pattern is valid for the JS engine too
  // the fixture site is not called dist/ (the repo's .gitignore would drop it); the pages are
  // named relative to it
  const site = join(fixtures, "built-site");
  const links = collectDistLinks(site, patterns, site);
  assert.deepEqual([...links.keys()].sort(), [
    "https://aka.ms/AI-3016onYouTube",
    "https://certiace.com/practice/AZ-104",
    "https://esi.microsoft.com/Search?q=AZ-204&avail=Available",
    "https://github.com/Azure/AzureArchitectureExampleScenarios",
    "https://github.com/MicrosoftLearning/AZ-104-MicrosoftAzureAdministrator/blob/master/Instructions/Labs/LAB_01-Manage_Entra_ID_Identities.md",
    "https://github.com/mscerts/hub",
    "https://microsoftlearning.github.io/AZ-104-MicrosoftAzureAdministrator/Instructions/Labs/LAB_01-Manage_Entra_ID_Identities.html",
    "https://www.pluralsight.com/paths/microsoft-azure-administrator-az-104",
    "https://www.youtube.com/watch?v=MCIon6epv74",
  ]);
  // the same lab on two pages is one link with two pages
  assert.deepEqual(
    [
      ...links.get(
        "https://microsoftlearning.github.io/AZ-104-MicrosoftAzureAdministrator/Instructions/Labs/LAB_01-Manage_Entra_ID_Identities.html",
      ),
    ].sort(),
    ["certs/azure/az-104/index.html", "certs/security/sc-100/index.html"],
  );
});

test("lychee-external.toml keeps the settings the filter logic depends on", () => {
  // includes win over excludes and a URL matching neither is checked once .lycheeignore adds
  // an exclude, so the catch-all exclude and the scheme filter must stay
  assert.match(realToml, /^exclude = \['\^https\?:\/\/'\]\r?$/m);
  assert.match(realToml, /^scheme = \["https", "http"\]\r?$/m);
  assert.doesNotMatch(
    realToml,
    /learn\\\.microsoft\\\.com/,
    "Learn is covered by the Learn URL Check",
  );
  assert.doesNotMatch(realToml, /^\s*'.*(udemy|measureup|amzn)/m);
  assert.doesNotMatch(realToml, /^cache\s*=\s*true/m);
  assert.match(realToml, /^\[hosts\."github\.com"\]$/m);
  // lychee puts the redirect chains into its JSON report (`redirect_map`) only when it runs
  // verbose; without this line the redirect check has no data and says so on every run
  assert.match(realToml, /^verbose = "info"\s*$/m);
});

test("lychee-external.toml allows a silent link one timeout and no retry, so even the biggest host fits the step's limit and lychee writes its report", () => {
  const setting = (key) =>
    Number(realToml.match(new RegExp(`^${key} = (\\d+)\\s*$`, "m"))?.[1]);
  const timeout = setting("timeout");
  const retries = setting("max_retries");
  // Timeouts, 403, 429 and 5xx are warnings that never advance a streak and a dead link needs
  // two runs anyway: a retry buys nothing. Without retries there is no wait before one.
  assert.deepEqual([timeout, retries], [15, 0]);
  assert.doesNotMatch(realToml, /^retry_wait_time\b/m, "no retry, no wait");
  // every attempt of a link that never answers runs into the timeout; the wait before a retry
  // doubles each time
  const wait = retries > 0 ? setting("retry_wait_time") : 0;
  let perLink = (retries + 1) * timeout;
  for (let i = 0; i < retries; i++) perLink += wait * 2 ** i;
  assert.equal(perLink, 15, "it was 155 s with a timeout of 30 and 3 retries");

  // The lanes of a host: host_concurrency, or the concurrency of its [hosts."..."] table.
  const lanes = { default: setting("host_concurrency") };
  let table = null;
  for (const line of realToml.split("\n")) {
    const header = line.match(/^\[hosts\."([^"]+)"\]\s*$/);
    if (header) table = header[1];
    else if (/^\[/.test(line)) table = null;
    const own = table && line.match(/^concurrency = (\d+)\s*$/);
    if (own) lanes[table] = Number(own[1]);
  }
  // lychee writes its report only when it has finished, and the workflow stops the step after
  // this long: then there is no report to judge.
  const stepLimit = Number(
    readFileSync(
      join(repoRoot, ".github/workflows/link-checker.yml"),
      "utf8",
    ).match(
      /- name: Check external links\n\s+id: lychee\n\s+timeout-minutes: (\d+)/,
    )?.[1],
  );
  assert.equal(stepLimit, 25);
  // A host whose links all stay silent takes ceil(links / lanes) x the cost of one link; the
  // hosts run side by side. The biggest hosts of the built site, counted with
  // `node scripts/link-failures.mjs list` on 2026-10-14:
  for (const [host, links, minutes] of [
    ["microsoftlearning.github.io", 338, 21],
    ["github.com", 111, 14],
    ["www.youtube.com", 87, 11],
  ]) {
    const worst = Math.ceil(links / (lanes[host] ?? lanes.default)) * perLink;
    assert.equal(Math.round(worst / 60), minutes, `${host}: ${worst} s`);
    assert.ok(
      worst < stepLimit * 60,
      `${host} must fit the ${stepLimit} minutes`,
    );
  }
});

test("readIncludePatterns handles comments, quotes and brackets inside patterns", () => {
  const toml = [
    'scheme = ["https"]',
    "include = [",
    "  # a comment with 'quotes' and ] a bracket",
    "  '^https://a\\.example/[^/?#]+/', # trailing comment",
    '  "^https://b\\\\.example/",',
    "]",
    "exclude = ['x']",
  ].join("\n");
  assert.deepEqual(readIncludePatterns(toml), [
    "^https://a\\.example/[^/?#]+/",
    "^https://b\\.example/",
  ]);
  assert.throws(() => readIncludePatterns("exclude = []"), /No `include/);
  assert.throws(() => readIncludePatterns("include = [\n'a'"), /not closed/);
});

// --- the command, end to end with a fake gh ----------------------------------------------------

const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, issues: [], labels: [] };
const arg = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ command, args, stdin }) + "\\n");
if (process.env.FAKE_GH_FAIL && process.env.FAKE_GH_FAIL.split(",").includes(command)) {
  console.error("fake gh: " + command + " failed on purpose");
  process.exit(1);
}
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const find = () => state.issues.find((i) => i.number === Number(args[2]));
// like gh --json: only the fields asked for
const fields = (arg("--json") ?? "").split(",").filter(Boolean);
const pick = (issue) => Object.fromEntries(fields.map((f) => [f, issue[f]]));
if (command === "issue list") {
  const label = arg("--label");
  console.log(JSON.stringify(state.issues.filter((i) => i.state === "open" && i.labels.includes(label)).map(pick)));
} else if (command === "issue view") {
  console.log(JSON.stringify(pick(find())));
} else if (command === "label list") {
  console.log(JSON.stringify(state.labels.map((name) => ({ name }))));
} else if (command === "label create") {
  state.labels.push(args[2]); save();
} else if (command === "issue create") {
  const issue = { number: state.next++, title: arg("--title"), labels: [arg("--label")], body: stdin, state: "open", comments: [] };
  state.issues.push(issue); save();
  console.log("https://github.com/mscerts/hub/issues/" + issue.number);
} else if (command === "issue edit") {
  find().body = stdin; save();
} else if (command === "issue comment") {
  find().comments.push(stdin); save();
} else if (command === "issue close") {
  const issue = find(); issue.state = "closed"; issue.comments.push(arg("--comment")); save();
}
`;

const WRITE_COMMANDS = [
  "label create",
  "issue create",
  "issue edit",
  "issue comment",
  "issue close",
];

async function makeWorld() {
  const base = await mkdtemp(join(tmpdir(), "link-failures-"));
  scratch.push(base);
  const hub = join(base, "hub");
  await cp(fixtures, hub, { recursive: true });
  // the fixture site becomes the hub's dist/
  await rename(join(hub, "built-site"), join(hub, "dist"));
  // the committed fixture tracker only exists to prove it is never searched
  await rm(join(hub, "src/data_files/link-failures.json"));
  const world = {
    hub,
    lychee: join(base, "lychee-external.json"),
    tracker: join(hub, "src/data_files/link-failures.json"),
    report: join(base, "report.md"),
    error: join(base, "error.md"),
    output: join(base, "output.txt"),
    fakeGh: join(base, "fake-gh.mjs"),
    ghState: join(base, "gh-state.json"),
    ghLog: join(base, "gh.log"),
  };
  await writeFile(world.fakeGh, FAKE_GH);
  await writeFile(world.ghLog, "");
  return world;
}

const readText = (path) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;
const readJson = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "(not JSON)";
  }
};

/** One run of `node scripts/link-failures.mjs`; returns what it printed, wrote and asked gh to do. */
function judge(world, { report: data, today, env = {}, raw } = {}) {
  if (raw !== undefined) writeFileSync(world.lychee, raw);
  else if (data) writeFileSync(world.lychee, JSON.stringify(data));
  writeFileSync(world.output, "");
  const before = readText(world.ghLog).split("\n").filter(Boolean).length;
  const res = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      REPO_ROOT: world.hub,
      LYCHEE_JSON: world.lychee,
      LYCHEE_EXIT_CODE: "",
      REPORT_FILE: world.report,
      ERROR_FILE: world.error,
      GITHUB_OUTPUT: world.output,
      GITHUB_STEP_SUMMARY: "",
      GITHUB_ACTIONS: "",
      GH_CLI_SCRIPT: world.fakeGh,
      FAKE_GH_STATE: world.ghState,
      FAKE_GH_LOG: world.ghLog,
      FAKE_GH_FAIL: "",
      CREATE_ISSUES: "1",
      DRY_RUN: "0",
      TODAY: today,
      ...env,
    },
  });
  const calls = readText(world.ghLog)
    .split("\n")
    .filter(Boolean)
    .slice(before)
    .map((l) => JSON.parse(l));
  const outputs = Object.fromEntries(
    readText(world.output)
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=")),
  );
  const state = readJson(world.ghState) ?? { issues: [] };
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    outputs,
    calls,
    writes: calls.filter((c) => WRITE_COMMANDS.includes(c.command)),
    tracker: readJson(world.tracker),
    issues: state.issues,
  };
}

test("the weekly lifecycle: baseline, confirmation, quiet weeks, change, fix", async () => {
  const world = await makeWorld();
  const dnsFail = fail(DEAD2, DNS, AZ104_PAGE);
  const w = (...failures) => ({ report: lycheeReport({ failures }) });

  // week 1: a silent baseline; warnings are counted but not tracked
  let r = judge(world, {
    ...w(
      fail(DEAD, NOT_FOUND),
      dnsFail,
      fail(VIDEO, UNAVAILABLE),
      fail("https://p.example/", FORBIDDEN),
    ),
    today: "2026-10-12",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(Object.keys(r.tracker.failing).sort(), [DEAD, DEAD2].sort());
  assert.equal(r.tracker.failing[DEAD].runs, 1);
  assert.deepEqual(r.outputs, {
    tracker_updated: "true",
    reported_count: "0",
    warning_count: "2",
    check_failed: "false",
  });

  // the same day again: nothing new, nothing written
  r = judge(world, {
    ...w(fail(DEAD, NOT_FOUND), dnsFail),
    today: "2026-10-12",
  });
  assert.equal(r.outputs.tracker_updated, "false");
  assert.deepEqual(r.writes, []);

  // week 2: DEAD failed twice -> ONE issue; the DNS failure is gone, a 503 stays a warning
  r = judge(world, {
    ...w(fail(DEAD, NOT_FOUND), fail(VIDEO, UNAVAILABLE)),
    today: "2026-10-19",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["label create", "issue create"],
  );
  assert.equal(r.issues.length, 1);
  const issue = r.issues[0];
  assert.equal(issue.title, "Link Checker: dead external links");
  assert.deepEqual(issue.labels, ["broken-link"]);
  assert.match(issue.body, new RegExp(DEAD.replace(/[.]/g, "\\.")));
  assert.match(issue.body, /src\/content\/docs\/security\/SC-100\.mdx:13/);
  assert.match(issue.body, /`\/certs\/security\/sc-100\/`/);
  assert.match(issue.body, /404 Not Found \| 2026-10-12/);
  assert.doesNotMatch(
    issue.body,
    /old-trainer|youtube|Archive|link-failures\.json/,
  );
  assert.deepEqual(Object.keys(r.tracker.failing), [DEAD]);
  assert.equal(r.tracker.failing[DEAD].runs, 2);
  assert.equal(r.outputs.reported_count, "1");
  assert.equal(r.outputs.tracker_updated, "true");
  assert.match(readText(world.report), /404 Not Found/);

  // weeks 3: still dead -> no new issue, no comment, no tracker change (no churn commit)
  r = judge(world, { ...w(fail(DEAD, NOT_FOUND)), today: "2026-10-26" });
  assert.deepEqual(r.writes, []);
  assert.equal(r.outputs.tracker_updated, "false");
  assert.equal(r.issues.length, 1);
  // the listings never ask for texts; the one open issue's text is read once, by its number
  assert.deepEqual(
    r.calls.map((c) => c.command),
    ["issue list", "issue view", "issue list"],
  );
  for (const call of r.calls.filter((c) => c.command === "issue list")) {
    assert.equal(call.args.at(-1), "number,title");
  }

  // week 4: a second dead link appears; it is only a first failure, so the issue stays as it is
  r = judge(world, {
    ...w(fail(DEAD, NOT_FOUND), dnsFail),
    today: "2026-11-02",
  });
  assert.deepEqual(r.writes, []);
  assert.equal(r.tracker.failing[DEAD2].runs, 1);
  assert.equal(r.outputs.tracker_updated, "true");

  // week 5: DEAD is fixed, DEAD2 is confirmed -> the issue text and ONE comment say so
  r = judge(world, { ...w(dnsFail), today: "2026-11-09" });
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["issue edit", "issue comment"],
  );
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].body, /old-trainer\.example\.net/);
  assert.doesNotMatch(r.issues[0].body, /AzureArchitectureExampleScenarios/);
  assert.match(r.issues[0].body, /src\/components\/links\.ts:2/);
  const comment = r.issues[0].comments.at(-1);
  assert.match(comment, /Newly confirmed dead \(1\)/);
  assert.match(comment, /Fixed or gone \(1\)/);
  assert.deepEqual(Object.keys(r.tracker.failing), [DEAD2]);

  // week 6: all fine -> the issue is closed and the tracker is empty
  r = judge(world, { ...w(), today: "2026-11-16" });
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["issue close"],
  );
  assert.equal(r.issues[0].state, "closed");
  assert.match(r.issues[0].comments.at(-1), /nothing left to fix/);
  assert.deepEqual(r.tracker, { failing: {} });
  assert.equal(r.outputs.tracker_updated, "true");

  // week 7: a new failure starts over silently, and a later confirmation opens a NEW issue
  r = judge(world, { ...w(fail(DEAD, NOT_FOUND)), today: "2026-11-23" });
  assert.deepEqual(r.writes, []);
  r = judge(world, { ...w(fail(DEAD, NOT_FOUND)), today: "2026-11-30" });
  assert.equal(r.issues.length, 2);
  assert.equal(r.issues[1].state, "open");
});

test("an inconclusive week in between does not break the streak", async () => {
  const world = await makeWorld();
  const run = (status, today) =>
    judge(world, {
      report: lycheeReport({ failures: [fail(DEAD, status)] }),
      today,
    });
  assert.equal(run(NOT_FOUND, "2026-10-12").tracker.failing[DEAD].runs, 1);
  const between = run(UNAVAILABLE, "2026-10-19");
  assert.equal(between.tracker.failing[DEAD].runs, 1);
  assert.deepEqual(between.writes, []);
  const confirmed = run(NOT_FOUND, "2026-10-26");
  assert.equal(confirmed.tracker.failing[DEAD].runs, 2);
  assert.equal(confirmed.issues.length, 1);
});

test("the captured answers give the same tracker and the same issue text however lychee lists them: a repeated run edits nothing", async () => {
  const world = await makeWorld();
  const captured = capturedReport();
  const [az, pl, sc] = THREE_PAGES;
  // four runs, four orders: the page with the real answer for the refused address comes first,
  // in the middle, last and first again, and the answers of a page are listed backwards twice
  const weeks = [
    [listed(captured, [az, sc, pl]), "2026-10-12"],
    [listed(captured, [sc, pl, az], true), "2026-10-19"],
    [listed(captured, [pl, az, sc]), "2026-10-26"],
    [listed(captured, [pl, sc, az], true), "2026-11-02"],
  ];
  const run = ([report, today]) =>
    judge(world, { report, today, env: { LYCHEE_EXIT_CODE: "2" } });

  // week 1: four first failures, a silent baseline
  let r = run(weeks[0]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    Object.keys(r.tracker.failing).sort(),
    [REFUSED, NO_DOMAIN, GONE_404, EXPIRED].sort(),
  );
  assert.equal(r.tracker.failing[REFUSED].reason, "connection refused");
  assert.equal(
    r.tracker.failing[NO_DOMAIN].reason,
    "connection failed (the domain may be gone)",
  );
  assert.deepEqual(r.writes, []);

  // week 2: the pages come in another order and all four are confirmed in ONE issue
  r = run(weeks[1]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.reported_count, "4");
  assert.equal(r.issues.length, 1);
  const issueText = r.issues[0].body;
  for (const url of [REFUSED, NO_DOMAIN, GONE_404, EXPIRED]) {
    assert.ok(issueText.includes(url), url);
  }
  assert.match(issueText, /connection refused/);
  assert.match(issueText, /connection failed \(the domain may be gone\)/);
  assert.match(issueText, /TLS certificate problem: SSL certificate expired/);
  assert.match(issueText, /404 Not Found/);
  assert.match(
    issueText,
    /Built pages: `\/certs\/azure\/az-104\/`, `\/certs\/power\/pl-300\/`, `\/certs\/security\/sc-100\/`\./,
  );
  const trackerText = readText(world.tracker);

  // weeks 3 and 4: other orders again, nothing changed, so nothing is edited, commented or committed
  for (const week of weeks.slice(2)) {
    r = run(week);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.writes, [], week[1]);
    assert.equal(r.outputs.tracker_updated, "false", week[1]);
    assert.equal(readText(world.tracker), trackerText, week[1]);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].body, issueText, week[1]);
  }
});

test("a dead link on five pages is described in site order whatever order lychee lists them in, so the issue is not edited for nothing", async () => {
  const world = await makeWorld();
  const pages = ["a", "b", "c", "d", "e"].map(
    (name) => `dist/certs/area/${name}/index.html`,
  );
  const week = (order, today) =>
    judge(world, {
      report: lycheeReport({
        failures: order.map((page) => fail(DEAD, NOT_FOUND, page)),
      }),
      today,
    });
  week(pages, "2026-10-12");
  const confirmed = week([...pages].reverse(), "2026-10-19");
  assert.equal(confirmed.issues.length, 1);
  assert.match(
    confirmed.issues[0].body,
    /Built pages: `\/certs\/area\/a\/`, `\/certs\/area\/b\/`, `\/certs\/area\/c\/` and 2 more\./,
  );
  const orders = [
    [pages[2], pages[0], pages[4], pages[1], pages[3]],
    [pages[3], pages[1], pages[4], pages[0], pages[2]],
  ];
  for (const [i, order] of orders.entries()) {
    const again = week(order, i === 0 ? "2026-10-26" : "2026-11-02");
    assert.deepEqual(again.writes, [], order.join(" "));
    assert.equal(again.issues[0].body, confirmed.issues[0].body);
  }
});

test("an open issue with a huge text is not listed: its text is read by its number and the run still edits it", async () => {
  const world = await makeWorld();
  const data = { report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }) };
  judge(world, { ...data, today: "2026-10-12" });
  // somebody pasted a 3 MiB log into the issue: a listing that carried the texts of the open
  // issues overflowed gh's 1 MiB output buffer, which fails the run
  writeFileSync(
    world.ghState,
    JSON.stringify({
      next: 2,
      issues: [
        {
          number: 1,
          title: "Link Checker: dead external links",
          labels: ["broken-link"],
          body: "x".repeat(3 * 1024 * 1024),
          state: "open",
          comments: [],
        },
      ],
      labels: ["broken-link"],
    }),
  );
  const r = judge(world, { ...data, today: "2026-10-19" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.map((c) => c.command),
    ["issue list", "issue view", "issue edit", "issue comment", "issue list"],
  );
  assert.equal(r.calls[0].args.at(-1), "number,title");
  assert.match(r.issues[0].body, /AzureArchitectureExampleScenarios/);
  assert.equal(r.issues.length, 1);
});

test("lychee's real-shaped sample report: only the page and host problems are tracked", async () => {
  const world = await makeWorld();
  const raw = readFileSync(
    join(fixtures, "lychee-v0.24.2-sample.json"),
    "utf8",
  );
  const r = judge(world, {
    raw,
    today: "2026-10-12",
    env: { LYCHEE_EXIT_CODE: "2" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.tracker.failing).sort(), [DEAD, DEAD2].sort());
  assert.equal(r.outputs.warning_count, "2");
  assert.match(r.stdout, /Warnings/);
  assert.match(r.stdout, /www\.pluralsight\.com: 1/);
});

test("a run that cannot be trusted judges nothing and raises one separate, self-closing alert", async () => {
  const world = await makeWorld();
  const seeded = judge(world, {
    report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }),
    today: "2026-10-12",
  });
  const trackerBefore = readText(world.tracker);
  assert.equal(seeded.tracker.failing[DEAD].runs, 1);

  const mass = lycheeReport({
    failures: Array.from({ length: 400 }, (_, i) =>
      fail(`https://h.example/${i}`, NOT_FOUND),
    ),
  });
  let r = judge(world, { report: mass, today: "2026-10-15" });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.check_failed, "true");
  assert.equal(r.outputs.tracker_updated, "false");
  assert.equal(
    readText(world.tracker),
    trackerBefore,
    "the tracker is untouched",
  );
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, "Link Checker: external check failed");
  assert.deepEqual(r.issues[0].labels, ["bug"]);
  assert.match(readText(world.error), /no link was judged/);

  // failing again: a comment, not a second issue
  r = judge(world, { report: mass, today: "2026-10-16" });
  assert.equal(r.status, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].comments.length, 1);

  // healthy again: the alert closes, and the streak continues from the old tracker
  r = judge(world, {
    report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }),
    today: "2026-10-19",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.issues[0].state, "closed");
  assert.equal(r.tracker.failing[DEAD].runs, 2);
  assert.equal(r.issues.length, 2, "and the dead link is reported now");
});

test("lychee failing, writing nothing or writing something else is a failed check, not a verdict", async () => {
  const world = await makeWorld();
  const good = {
    report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }),
    today: "2026-10-12",
  };

  let r = judge(world, { ...good, env: { LYCHEE_EXIT_CODE: "1" } });
  assert.equal(r.status, 1);
  assert.match(readText(world.error), /lychee itself failed \(exit code 1/);
  assert.equal(r.tracker, null);

  r = judge(world, { ...good, env: { LYCHEE_EXIT_CODE: "3" } });
  assert.equal(r.status, 1);

  for (const code of ["0", "2"]) {
    r = judge(world, { ...good, env: { LYCHEE_EXIT_CODE: code } });
    assert.equal(r.status, 0, `exit code ${code} is normal`);
  }

  const missing = await makeWorld();
  r = judge(missing, { today: "2026-10-12" });
  assert.equal(r.status, 1);
  assert.match(readText(missing.error), /wrote no report/);

  r = judge(missing, { raw: "<html>", today: "2026-10-12" });
  assert.equal(r.status, 1);
  assert.match(readText(missing.error), /not valid JSON/);

  r = judge(missing, { raw: '{"error_map":[]}', today: "2026-10-12" });
  assert.equal(r.status, 1);
  assert.match(readText(missing.error), /no `error_map`/);

  r = judge(missing, {
    report: lycheeReport({ successful: 10 }),
    today: "2026-10-12",
  });
  assert.equal(r.status, 1);
  assert.match(readText(missing.error), /only 10 links/);
});

test("on a GitHub runner a failed check is an error annotation with the check's title, elsewhere a plain line; the job summary lists what was found", async () => {
  const world = await makeWorld();
  const good = {
    report: lycheeReport({
      failures: [fail(DEAD, NOT_FOUND), fail(VIDEO, UNAVAILABLE)],
    }),
    today: "2026-10-12",
  };
  let r = judge(world, {
    ...good,
    env: { LYCHEE_EXIT_CODE: "1", GITHUB_ACTIONS: "true" },
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stdout,
    /^::error title=External link check::lychee itself failed \(exit code 1; /m,
  );
  assert.doesNotMatch(r.stderr, /^Error: lychee itself failed/m);
  r = judge(world, { ...good, env: { LYCHEE_EXIT_CODE: "1" } });
  assert.doesNotMatch(r.stdout, /::error/);
  assert.match(r.stderr, /^Error: lychee itself failed \(exit code 1; /m);

  // a healthy run: the warning is an annotation, and the summary file gets the run's table
  const summaryFile = join(world.hub, "step-summary.md");
  r = judge(world, {
    ...good,
    env: {
      LYCHEE_EXIT_CODE: "2",
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summaryFile,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^::warning title=External link check::1 links answered with 403, 429, 5xx, a timeout or a network error/m,
  );
  const summary = readText(summaryFile);
  assert.match(summary, /^## External link check, 2026-10-12/);
  assert.match(summary, /### Dead links/);
  assert.match(summary, /first failure: `https:\/\/github\.com\/Azure/);
});

test("when the issue cannot be created the tracker is not written, so the next run reports it again", async () => {
  const world = await makeWorld();
  const data = { report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }) };
  judge(world, { ...data, today: "2026-10-12" });
  const before = readText(world.tracker);

  let r = judge(world, {
    ...data,
    today: "2026-10-19",
    env: { FAKE_GH_FAIL: "issue create" },
  });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.tracker_updated, "false");
  assert.equal(r.outputs.check_failed, "true");
  assert.equal(readText(world.tracker), before);
  assert.equal(r.issues.length, 0);

  // a lookup failure while an issue is needed is the same
  r = judge(world, {
    ...data,
    today: "2026-10-19",
    env: { FAKE_GH_FAIL: "issue list" },
  });
  assert.equal(r.status, 1);
  assert.equal(readText(world.tracker), before);

  r = judge(world, { ...data, today: "2026-10-19" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.issues.length, 1);
  assert.equal(r.tracker.failing[DEAD].runs, 2);
});

test("DRY_RUN and CREATE_ISSUES=0 never touch issues, and DRY_RUN never touches the tracker", async () => {
  const world = await makeWorld();
  const data = { report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }) };
  judge(world, { ...data, today: "2026-10-12" });
  const before = readText(world.tracker);

  let r = judge(world, { ...data, today: "2026-10-19", env: { DRY_RUN: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.equal(readText(world.tracker), before);
  assert.equal(r.outputs.tracker_updated, "false");
  assert.equal(r.outputs.reported_count, "1");
  assert.match(r.stdout, /DRY_RUN: the issue would say/);
  assert.match(readText(world.report), /SC-100\.mdx:13/);

  r = judge(world, {
    ...data,
    today: "2026-10-19",
    env: { CREATE_ISSUES: "0" },
  });
  assert.deepEqual(r.calls, []);
  assert.equal(r.tracker.failing[DEAD].runs, 2, "the tracker is still written");
});

test("a corrupt tracker stops the run instead of resetting the streaks, and says so in an issue", async () => {
  const world = await makeWorld();
  await mkdir(join(world.hub, "src/data_files"), { recursive: true });
  await writeFile(world.tracker, "{not json");
  const data = { report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }) };
  let r = judge(world, { ...data, today: "2026-10-12" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tracker is not valid JSON/);
  assert.equal(
    readText(world.tracker),
    "{not json",
    "never reset or rewritten",
  );
  assert.equal(r.outputs.check_failed, "true");
  assert.equal(r.outputs.tracker_updated, "false");
  // not a red run nobody reads: the same "external check failed" issue as an untrustworthy run
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, "Link Checker: external check failed");
  assert.deepEqual(r.issues[0].labels, ["bug"]);
  assert.match(
    r.issues[0].body,
    /src\/data_files\/link-failures\.json cannot be read/,
  );
  assert.match(r.issues[0].body, /restore it from the git history/);
  assert.doesNotMatch(r.issues[0].body, /Dead links|dead external links/);

  // still corrupt next week: a comment on the same issue, not a second one
  r = judge(world, { ...data, today: "2026-10-19" });
  assert.equal(r.status, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].comments.length, 1);

  // restored: the next run is healthy and closes the alert
  await writeFile(world.tracker, serializeTracker(emptyTracker()));
  r = judge(world, { ...data, today: "2026-10-26" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.issues[0].state, "closed");
});

test("a crash of the judging itself is not only a red run: it raises the check-failed issue", async () => {
  const world = await makeWorld();
  const data = { report: lycheeReport({ failures: [fail(DEAD, NOT_FOUND)] }) };
  judge(world, { ...data, today: "2026-10-12" });
  const before = readText(world.tracker);

  // the second failure would be reported, but the report file cannot be written (a bug or a disk problem)
  const r = judge(world, {
    ...data,
    today: "2026-10-19",
    env: { REPORT_FILE: join(world.hub, "no-such-dir", "report.md") },
  });
  assert.equal(r.status, 1);
  assert.equal(r.outputs.check_failed, "true");
  assert.equal(r.outputs.tracker_updated, "false");
  assert.equal(readText(world.tracker), before);
  assert.match(r.stderr, /The link failure check failed/);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, "Link Checker: external check failed");
  assert.match(r.issues[0].body, /The judging step crashed: ENOENT/);
  assert.match(
    r.issues[0].body,
    /No link was judged and the tracker was not written/,
  );
});

test("a run in which a family of hosts answers 403 or 429 is still judged, and the dead links are still found", async () => {
  const world = await makeWorld();
  const blocking = Array.from({ length: 400 }, (_, i) =>
    fail(
      `https://host${i % 8}.example/${i}`,
      i % 3 ? FORBIDDEN : http(429, "Too Many"),
    ),
  );
  const data = (...extra) => ({
    report: lycheeReport({ failures: [...extra, ...blocking] }),
  });
  let r = judge(world, { ...data(fail(DEAD, NOT_FOUND)), today: "2026-10-12" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.check_failed, "false");
  assert.equal(r.outputs.warning_count, "400");
  assert.deepEqual(Object.keys(r.tracker.failing), [DEAD]);
  assert.deepEqual(r.writes, []);
  r = judge(world, { ...data(fail(DEAD, NOT_FOUND)), today: "2026-10-19" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.reported_count, "1");
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, "Link Checker: dead external links");
});

test("a failed run names the failing hosts in the issue, the error file and the job summary", async () => {
  const world = await makeWorld();
  const summaryFile = join(world.hub, "step-summary.md");
  const failures = [
    ...Array.from({ length: 220 }, (_, i) =>
      fail(`https://www.whizlabs.com/p/${i}`, NOT_FOUND),
    ),
    ...Array.from({ length: 120 }, (_, i) =>
      fail(`https://www.pluralsight.com/p/${i}`, DNS),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      fail(`https://www.coursera.org/p/${i}`, FORBIDDEN),
    ),
  ];
  const r = judge(world, {
    report: lycheeReport({ failures }),
    today: "2026-10-12",
    env: { GITHUB_STEP_SUMMARY: summaryFile },
  });
  assert.equal(r.status, 1);
  const hostLine =
    "- `www.whizlabs.com`: 220 failed answers (220 dead or unreachable, 0 timed out, 0 inconclusive)";
  for (const text of [
    r.issues[0].body,
    readText(world.error),
    readText(summaryFile),
  ]) {
    assert.match(text, /340 of 1070 links \(32%\) failed hard/);
    assert.ok(text.includes(hostLine), text);
    assert.match(text, /`www\.pluralsight\.com`: 120 failed answers/);
    assert.match(
      text,
      /`www\.coursera\.org`: 30 failed answers \(0 dead or unreachable, 0 timed out, 30 inconclusive \(HTTP 403 x30\)\)/,
    );
  }
  assert.match(
    readText(summaryFile),
    /^## External link check failed, 2026-10-12/,
  );
  assert.match(
    r.issues[0].body,
    /remove it from `include` in `lychee-external\.toml`/,
  );
  // the most-failing host comes first
  assert.ok(
    r.issues[0].body.indexOf("www.whizlabs.com") <
      r.issues[0].body.indexOf("www.pluralsight.com"),
  );
});

// --- the redirect check -----------------------------------------------------------------------------

// lychee-v0.24.2-redirects-captured.json is a run of the real lychee v0.24.2 (2026-10-14, with
// `verbose = "info"`, which is what puts the chains into `redirect_map`) over one built page with
// seven links: the Virtual Training Days category page of Microsoft Events with and without a
// query (302 to its locale variant, then 301 to the events hub of the same site: lychee said 200
// OK, so nobody noticed that the programme page was gone), a short link that leaves the site,
// http://github.com/microsoft (301 to https), a GitHub Pages address that gains its trailing
// slash, and two links that do not redirect. The locale of the hub (cs-cz) is where the capture
// ran; a GitHub runner is answered en-us. The rest of this section is hand-made.
const VTD =
  "https://www.microsoft.com/events/category/microsoft-virtual-training-days";
const VTD_QUERY = `${VTD}?scenario=mvtd&q=Introduction+to+Microsoft+Azure`;
const VTD_PAGE = "dist/certs/azure/az-900/index.html";
const EVENTS_HUB = "https://www.microsoft.com/en-us/events";
const redirectsCaptured = () =>
  JSON.parse(
    readFileSync(
      join(fixtures, "lychee-v0.24.2-redirects-captured.json"),
      "utf8",
    ),
  );
const analyse = (report, options) => {
  const parsedReport = parseLycheeReport(JSON.stringify(report));
  return analyzeRedirects(
    parsedReport,
    collectResults(parsedReport).results,
    options,
  );
};

/** A link and the chain lychee lists for it: hops are [code of the redirecting response, address it led to]. */
const chain = (url, hops, pages) => ({
  url,
  hops,
  ...(pages ? { pages } : {}),
});

/**
 * A report with redirect chains. Like lychee, a chain is listed under ONE page (the first of
 * `pages`) and every page has the link in `success_map`; `redirects` overrides the counter.
 */
function redirectReport(chains, { failures = [], redirects } = {}) {
  const report = lycheeReport({ failures });
  const redirect_map = {};
  const success_map = {};
  for (const { url, hops, pages = [VTD_PAGE] } of chains) {
    (redirect_map[pages[0]] ??= []).push({
      origin: url,
      redirects: hops.map(([code, to]) => ({ url: to, code })),
    });
    for (const page of pages) {
      (success_map[page] ??= []).push({
        url,
        status: { text: "200 OK", code: 200 },
        span: { line: 3, column: 10 },
      });
    }
  }
  return {
    ...report,
    redirects: redirects ?? chains.length,
    redirect_map,
    success_map,
    detailed_stats: true,
  };
}

/** The links of the capture that are not demoted: a short link, http to https, a trailing slash. */
const HARMLESS = [
  chain("https://aka.ms/MVTD_FAQ_EN", [
    [301, "https://arch-center.azureedge.net/Credentials/faq.pdf"],
  ]),
  chain("http://github.com/microsoft", [[301, "https://github.com/microsoft"]]),
  chain("https://microsoftlearning.github.io/mslearn-ai-fundamentals", [
    [301, "https://microsoftlearning.github.io/mslearn-ai-fundamentals/"],
  ]),
];

test("the captured run gives exactly the two Virtual Training Days links as redirects to a parent page", () => {
  const report = parseLycheeReport(JSON.stringify(redirectsCaptured()));
  assert.equal(report.counts.redirects, 5);
  const analysis = analyzeRedirects(report, collectResults(report).results);
  assert.equal(analysis.usable, true);
  assert.deepEqual(
    analysis.candidates.map(({ url, final, codes, permanent, pages }) => ({
      url,
      final,
      codes,
      permanent,
      pages,
    })),
    [
      {
        url: VTD,
        final: "https://www.microsoft.com/cs-cz/events",
        codes: [302, 301],
        permanent: true,
        pages: [VTD_PAGE],
      },
      {
        url: VTD_QUERY,
        final:
          "https://www.microsoft.com/cs-cz/events?scenario=mvtd&q=Introduction+to+Microsoft+Azure?scenario=mvtd&q=Introduction+to+Microsoft+Azure",
        codes: [302, 301],
        permanent: true,
        pages: [VTD_PAGE],
      },
    ],
  );
  // the others only changed the form of the address (http to https, a trailing slash) or leave
  // the site (aka.ms): nothing to say, nothing listed
  assert.deepEqual(
    {
      redirecting: analysis.redirecting,
      same: analysis.same,
      otherSite: analysis.otherSite,
      moved: analysis.moved.length,
      unknown: analysis.unknown,
      permanent: analysis.permanent,
      tooMany: analysis.tooMany,
    },
    {
      redirecting: 5,
      same: 2,
      otherSite: 1,
      moved: 0,
      unknown: 0,
      permanent: 2,
      tooMany: false,
    },
  );
  assert.deepEqual(analysis.hosts, [{ host: "www.microsoft.com", count: 2 }]);
});

test("two addresses are compared without scheme, www, case, query, fragment, trailing slash and a leading locale such as en-us or cs-cz", () => {
  const same = {
    host: "microsoft.com",
    segments: ["events", "category", "x"],
  };
  for (const url of [
    "https://www.microsoft.com/events/category/x",
    "http://microsoft.com/events/category/x/",
    "https://WWW.Microsoft.COM/Events/Category/X?scenario=a&q=b#frag",
    "https://www.microsoft.com/en-us/events/category/x",
    "https://www.microsoft.com/cs-cz/events/category/x/",
    "https://www.microsoft.com/EN-US/events/category/x",
  ]) {
    assert.deepEqual(normalizeUrl(url), same, url);
  }
  // only the hyphenated form is a locale, and only at the start
  assert.deepEqual(normalizeUrl("https://e.example/de/events"), {
    host: "e.example",
    segments: ["de", "events"],
  });
  assert.deepEqual(normalizeUrl("https://e.example/events/en-us"), {
    host: "e.example",
    segments: ["events", "en-us"],
  });
  assert.deepEqual(normalizeUrl("https://e.example/zh-hans-cn/x"), {
    host: "e.example",
    segments: ["zh-hans-cn", "x"],
  });
  for (const root of ["https://e.example", "https://e.example/en-us/"]) {
    assert.deepEqual(normalizeUrl(root), { host: "e.example", segments: [] });
  }
  // a default document is the directory itself (a 301 from /x/index.html to /x/ is no demotion),
  // but only as the last segment and only under these names
  for (const url of [
    "https://e.example/x/index.html",
    "https://e.example/x/Default.ASPX",
    "https://e.example/en-us/x/index.htm",
  ]) {
    assert.deepEqual(
      normalizeUrl(url),
      { host: "e.example", segments: ["x"] },
      url,
    );
  }
  assert.deepEqual(normalizeUrl("https://e.example/index.html"), {
    host: "e.example",
    segments: [],
  });
  assert.deepEqual(normalizeUrl("https://e.example/index.html/x"), {
    host: "e.example",
    segments: ["index.html", "x"],
  });
  assert.deepEqual(normalizeUrl("https://e.example/x/index.json"), {
    host: "e.example",
    segments: ["x", "index.json"],
  });
  assert.equal(
    redirectRelation("https://e.example/x/index.html", "https://e.example/x/"),
    "same",
  );
  assert.equal(
    redirectRelation(
      "https://e.example/x/y/index.html",
      "https://e.example/x/",
    ),
    "redirect-hub",
  );
  for (const url of [
    "mailto:a@b.example",
    "ftp://e.example/x",
    "/relative/path",
    "",
    undefined,
  ]) {
    assert.equal(normalizeUrl(url), null, String(url));
  }
});

test("a link is demoted only when its answer lands on a proper parent of its own path on the same site", () => {
  const site = "https://www.microsoft.com";
  const link = `${site}/events/category/vtd`;
  const relations = (targets) =>
    targets.map((to) => redirectRelation(link, to));
  // the same page in another form: nothing to say
  assert.deepEqual(
    relations([
      link,
      "https://microsoft.com/events/category/vtd/",
      "http://www.microsoft.com/events/category/vtd",
      `${site}/en-us/events/category/vtd`,
      `${site}/events/category/vtd?a=1#b`,
      `${site}/EVENTS/category/VTD`,
    ]),
    Array(6).fill("same"),
  );
  // a proper prefix of the path: the parent, the hub with a locale, the site root in any form
  assert.deepEqual(
    relations([
      `${site}/events/category`,
      `${site}/cs-cz/events`,
      `${site}/events/`,
      `${site}/`,
      site,
      `${site}/en-us`,
    ]),
    Array(6).fill("redirect-hub"),
  );
  // another page of the same site, also a longer path and a name that only starts alike
  assert.deepEqual(
    relations([
      `${site}/events/category/other`,
      `${site}/events/other`,
      `${site}/events/category/vtd/details`,
      `${site}/events/category/vtd2`,
      `${site}/other`,
    ]),
    Array(5).fill("moved"),
  );
  // a link to the root itself cannot be demoted
  assert.equal(redirectRelation(`${site}/`, `${site}/en-us/`), "same");
  assert.equal(redirectRelation(`${site}/`, `${site}/events`), "moved");
  // another host (a sub-domain is another host): not judged
  assert.deepEqual(
    relations([
      "https://learn.microsoft.com/",
      "https://aka.ms/x",
      "https://microsoft.example/events",
    ]),
    Array(3).fill("other-site"),
  );
  assert.equal(
    redirectRelation(
      "https://aka.ms/MVTD_FAQ_EN",
      "https://arch-center.azureedge.net/x.pdf",
    ),
    "other-site",
  );
  assert.equal(redirectRelation(link, "ftp://www.microsoft.com/"), "unknown");
});

test("only a permanent hop (301, 308) makes a redirect to a parent page a finding; temporary ones are warnings", () => {
  const origin = (n) => `https://www.microsoft.com/events/category/p${n}`;
  const analysis = analyse(
    redirectReport([
      chain(origin(1), [[301, EVENTS_HUB]]),
      chain(origin(2), [[308, EVENTS_HUB]]),
      chain(origin(3), [[302, EVENTS_HUB]]),
      chain(origin(4), [[303, EVENTS_HUB]]),
      chain(origin(5), [[307, EVENTS_HUB]]),
      // at least one permanent hop anywhere in the chain is enough
      chain(origin(6), [
        [302, `${EVENTS_HUB}/category/p6`],
        [301, EVENTS_HUB],
      ]),
      chain(origin(7), [
        [301, `${origin(7)}/`],
        [302, EVENTS_HUB],
      ]),
    ]),
  );
  const urls = (permanent) =>
    analysis.candidates
      .filter((c) => c.permanent === permanent)
      .map((c) => c.url);
  assert.deepEqual(urls(true), [1, 2, 6, 7].map(origin));
  assert.deepEqual(urls(false), [3, 4, 5].map(origin));
  assert.equal(analysis.permanent, 4);
});

test("a link that failed or timed out is left to the failure logic, whatever its chain says", () => {
  const dead = "https://www.microsoft.com/events/category/dead";
  const slow = "https://www.microsoft.com/events/category/slow";
  const analysis = analyse(
    redirectReport(
      [
        chain(dead, [[301, EVENTS_HUB]]),
        chain(slow, [[301, EVENTS_HUB]]),
        chain(VTD, [[301, EVENTS_HUB]]),
      ],
      {
        failures: [
          fail(dead, NOT_FOUND, VTD_PAGE),
          {
            ...fail(slow, { text: "Timeout", details: "Request timed out" }),
            page: VTD_PAGE,
            timeout: true,
          },
        ],
      },
    ),
  );
  assert.deepEqual(
    analysis.candidates.map((c) => c.url),
    [VTD],
  );
  assert.equal(analysis.redirecting, 1);
});

test("one link on several pages is one link: its pages are the union, and chains that differ are resolved the same way whatever the order", () => {
  const report = redirectReport([
    chain(
      VTD,
      [[301, EVENTS_HUB]],
      ["dist/b/index.html", "dist/a/index.html", "dist/c/index.html"],
    ),
  ]);
  // lychee asks a host once: the cached repeats on the other pages carry no chain. One page
  // has another chain for the same link: the first one in a fixed order wins
  report.redirect_map["dist/c/index.html"] = [
    { origin: VTD, redirects: [{ url: EVENTS_HUB, code: 302 }] },
  ];
  const options = { pageOf: (page) => pageFromInput(page) };
  const analysis = analyse(report, options);
  assert.equal(analysis.candidates.length, 1);
  assert.deepEqual(analysis.candidates[0].pages, ["/a/", "/b/", "/c/"]);
  assert.deepEqual(analysis.candidates[0].codes, [301]);
  assert.equal(analysis.candidates[0].permanent, true);
  const flipped = {
    ...report,
    redirect_map: Object.fromEntries(
      Object.entries(report.redirect_map).reverse(),
    ),
    success_map: Object.fromEntries(
      Object.entries(report.success_map).reverse(),
    ),
  };
  assert.deepEqual(analyse(flipped, options), analysis);
});

test("the findings do not depend on the order in which lychee lists the chains", () => {
  const report = redirectsCaptured();
  const baseline = JSON.stringify(analyse(report));
  const orders = permutations(report.redirect_map[VTD_PAGE]);
  assert.equal(orders.length, 120);
  for (const order of orders) {
    const shuffled = {
      ...report,
      redirect_map: { [VTD_PAGE]: order },
      success_map: { [VTD_PAGE]: [...report.success_map[VTD_PAGE]].reverse() },
    };
    assert.equal(JSON.stringify(analyse(shuffled)), baseline);
  }
});

test("an empty redirect_map is no information when lychee counted redirects (it ran without verbose); only a count of 0 means nothing redirects", () => {
  const sample = JSON.parse(
    readFileSync(join(fixtures, "lychee-v0.24.2-sample.json"), "utf8"),
  );
  assert.equal(sample.redirects, 3);
  assert.deepEqual(sample.redirect_map, {});
  const quiet = analyse(sample);
  assert.equal(quiet.usable, false);
  assert.match(quiet.reason, /counted 3 redirects but lists none/);
  assert.match(quiet.reason, /verbose/);
  assert.deepEqual(quiet.candidates, []);
  // no redirect_map at all, or one that is not made of chains
  const { redirect_map: _unused, ...without } = redirectsCaptured();
  assert.equal(analyse(without).usable, false);
  assert.match(analyse(without).reason, /no `redirect_map`/);
  assert.equal(
    analyse({ ...redirectsCaptured(), redirect_map: "text" }).usable,
    false,
  );
  assert.equal(
    analyse({ ...redirectsCaptured(), redirect_map: { page: "text" } }).usable,
    false,
  );
  // lychee counted no redirect and lists none: that is information
  const none = analyse(lycheeReport());
  assert.equal(none.usable, true);
  assert.equal(none.redirecting, 0);
  assert.deepEqual(none.candidates, []);
  // the counters and maps of the report are read without ever throwing
  const odd = parseLycheeReport(
    JSON.stringify({
      ...lycheeReport(),
      redirect_map: [],
      success_map: "x",
      redirects: "many",
    }),
  );
  assert.deepEqual(
    [odd.redirectMap, odd.successMap, odd.counts.redirects],
    [null, {}, 0],
  );
});

test(".lycheeignore lines are read as regular expressions; what they match is not judged by the redirect check", () => {
  const { patterns, invalid } = readIgnorePatterns(
    "# a comment\n\n  measureup\\.com  \r\nmicrosoft\\.com/events/category/microsoft-virtual-training-days\n[broken\n",
  );
  assert.equal(patterns.length, 2);
  assert.deepEqual(invalid, ["[broken"]);
  const analysis = analyse(redirectsCaptured(), { ignore: patterns });
  assert.deepEqual(analysis.candidates, []);
  assert.equal(analysis.ignored, 2);
  assert.equal(analysis.redirecting, 5);
  // the repository's own file is made of valid expressions
  const real = readIgnorePatterns(
    readFileSync(join(repoRoot, ".lycheeignore"), "utf8"),
  );
  assert.deepEqual(real.invalid, []);
  assert.ok(real.patterns.length > 0);
});

// --- the tracker ---------------------------------------------------------------------------------

const redirectRecord = (over = {}) => ({
  firstSeen: "2026-10-12",
  lastSeen: "2026-10-19",
  runs: 2,
  final: EVENTS_HUB,
  codes: [302, 301],
  pages: ["/certs/azure/az-900/"],
  ...over,
});

test("the tracker file keeps its old shape until a link redirects to a parent page, and the new part is validated", () => {
  const committed = readFileSync(
    join(repoRoot, "src/data_files/link-failures.json"),
    "utf8",
  );
  assert.deepEqual(parseTracker(committed), { failing: {} });
  // a file of the old shape loads without the new key and is written back byte for byte
  const old = '{\n  "failing": {}\n}\n';
  assert.equal(serializeTracker(parseTracker(old)), old);
  assert.deepEqual(parseTracker('{"failing":{},"redirects":{}}'), {
    failing: {},
  });
  const tracker = parseTracker(
    JSON.stringify({ failing: {}, redirects: { [VTD]: redirectRecord() } }),
  );
  assert.deepEqual(tracker.redirects, { [VTD]: redirectRecord() });
  // keys are sorted; writing and reading again changes nothing
  const unsorted = {
    failing: {},
    redirects: { [VTD_QUERY]: redirectRecord(), [VTD]: redirectRecord() },
  };
  const text = serializeTracker(unsorted);
  assert.deepEqual(Object.keys(JSON.parse(text).redirects), [VTD, VTD_QUERY]);
  assert.equal(serializeTracker(parseTracker(text)), text);
  // a malformed record is a corrupt file, never a silent reset
  for (const bad of [
    redirectRecord({ runs: 0 }),
    redirectRecord({ firstSeen: "yesterday" }),
    redirectRecord({ final: 5 }),
    redirectRecord({ codes: "301" }),
    redirectRecord({ codes: [301, "x"] }),
    redirectRecord({ pages: [1] }),
    "text",
  ]) {
    assert.throws(
      () =>
        parseTracker(
          JSON.stringify({ failing: {}, redirects: { [VTD]: bad } }),
        ),
      /malformed/,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => parseTracker('{"failing":{},"redirects":[]}'),
    /"redirects"/,
  );
});

test("a link that redirects to a parent page follows the streak rules of a dead link: two runs, once a day, then frozen", () => {
  const A = "https://www.microsoft.com/events/category/a";
  const candidate = (over = {}) => ({
    url: A,
    final: EVENTS_HUB,
    codes: [301],
    pages: ["/p/"],
    permanent: true,
    ...over,
  });
  const seen = (...candidates) => ({
    usable: true,
    tooMany: false,
    candidates,
  });
  const advance = (previous, analysis, today, results = new Map()) =>
    advanceRedirects(previous, analysis, results, today);
  const first = advance({}, seen(candidate()), "2026-10-12");
  assert.deepEqual(first[A], {
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-12",
    runs: 1,
    final: EVENTS_HUB,
    codes: [301],
    pages: ["/p/"],
  });
  assert.deepEqual(reportableRedirects({ failing: {}, redirects: first }), []);
  // the same day again counts once
  assert.deepEqual(advance(first, seen(candidate()), "2026-10-12"), first);
  // a week later it is the second run: reported, with what the second run saw
  const second = advance(
    first,
    seen(candidate({ pages: ["/p/", "/q/"] })),
    "2026-10-19",
  );
  assert.equal(second[A].runs, 2);
  assert.equal(second[A].firstSeen, "2026-10-12");
  assert.deepEqual(second[A].pages, ["/p/", "/q/"]);
  assert.deepEqual(
    reportableRedirects({ failing: {}, redirects: second }).map((e) => e.url),
    [A],
  );
  // then it is frozen, whatever it lands on now: no weekly commit for a persistent demotion
  const third = advance(
    second,
    seen(candidate({ final: "https://www.microsoft.com/", pages: ["/z/"] })),
    "2026-10-26",
  );
  assert.equal(
    serializeTracker({ failing: {}, redirects: third }),
    serializeTracker({ failing: {}, redirects: second }),
  );
  // a first sighting older than 15 days is not "the run before"
  const stale = advance(
    {
      [A]: redirectRecord({
        runs: 1,
        lastSeen: "2026-09-20",
        firstSeen: "2026-09-20",
      }),
    },
    seen(candidate()),
    "2026-10-19",
  );
  assert.equal(stale[A].runs, 1);
  assert.equal(stale[A].firstSeen, "2026-10-19");
});

test("a link that stops redirecting to a parent page, or leaves the site, is dropped; an inconclusive answer or a temporary redirect keeps what was known", () => {
  const A = "https://www.microsoft.com/events/category/a";
  const B = "https://www.microsoft.com/events/category/b";
  const known = {
    [A]: redirectRecord({ runs: 1 }),
    [B]: redirectRecord({ runs: 2 }),
  };
  const analysis = (...candidates) => ({
    usable: true,
    tooMany: false,
    candidates,
  });
  const cand = (url, over = {}) => ({
    url,
    final: EVENTS_HUB,
    codes: [301],
    pages: [],
    permanent: true,
    ...over,
  });
  const run = (candidates, results = new Map()) =>
    advanceRedirects(known, analysis(...candidates), results, "2026-10-26");
  // recovered, or no longer on the site: both are simply absent from this run
  assert.deepEqual(run([]), {});
  assert.deepEqual(Object.keys(run([cand(B)])), [B]);
  // it fails for good now: the failure logic owns it, the record goes
  assert.deepEqual(run([], new Map([[A, { url: A, kind: "broken" }]])), {});
  // an inconclusive answer (timeout, 429, 5xx) says nothing about the redirect
  assert.deepEqual(run([], new Map([[A, { url: A, kind: "warning" }]])), {
    [A]: known[A],
  });
  // temporary hops only: the record stays exactly as it was, and none is made
  const temporary = run([
    cand(A, { codes: [302], permanent: false }),
    cand("https://www.microsoft.com/events/category/c", {
      codes: [302],
      permanent: false,
    }),
  ]);
  assert.deepEqual(temporary, { [A]: known[A] });
  // nothing to judge from, or a flood: what was known stays, the same object
  for (const blind of [
    { usable: false, tooMany: false, candidates: [] },
    { usable: true, tooMany: true, candidates: [cand(A)] },
  ]) {
    assert.equal(
      advanceRedirects(known, blind, new Map(), "2026-10-26"),
      known,
    );
  }
});

// --- the issue texts -------------------------------------------------------------------------------

const redirectEntry = (url, over = {}) => ({
  url,
  ...redirectRecord(),
  ...over,
});

test("the issue gets a second, lower-urgency table for the links that redirect to a parent page", () => {
  const locations = new Map([
    [VTD, { places: ["src/content/docs/vouchers.mdx:3"], total: 1 }],
  ]);
  const only = buildDeadLinksBody([], {
    locations,
    pages: new Map(),
    redirects: [redirectEntry(VTD)],
  });
  assert.match(
    only,
    /\n### Links that now redirect to a parent page \(the page is probably gone\)\n/,
  );
  assert.match(
    only,
    /\| Link \| Now lands on \| Redirects \| First detected \| Fix it in \|/,
  );
  assert.ok(
    only.includes(
      `| \`${VTD}\` | \`${EVENTS_HUB}\` | 302 -> 301 | 2026-10-12 | \`src/content/docs/vouchers.mdx:3\` Built page: \`/certs/azure/az-900/\`. |`,
    ),
    only,
  );
  assert.doesNotMatch(only, /\| Link \| Problem \|/);
  assert.match(only, /found no dead link/);
  assert.match(
    only,
    /Links that fail only once[^\n]* Redirects that only change the form of the address[^\n]* are not listed either\. The job summary of each run shows them\./,
  );
  assert.match(only, /open it\. If the page is gone, remove the card/);
  assert.match(only, /never guess an address/);
  assert.match(only, /add its URL to `\.lycheeignore`/);
  assert.match(only, /\n2\. Run `pnpm build`\./);
  assert.deepEqual(extractListedRedirects(only), [VTD]);
  assert.deepEqual(extractListedUrls(only), []);

  // with dead links too: the dead table first, its steps, then the new ones
  const both = buildDeadLinksBody(sampleEntries(), {
    locations,
    pages: new Map(),
    redirects: [redirectEntry(VTD)],
  });
  assert.ok(
    both.indexOf("| Link | Problem |") <
      both.indexOf("### Links that now redirect"),
  );
  assert.match(both, /two runs in a row/);
  assert.match(both, /\n3\. For a link that redirects to a parent page/);
  assert.match(both, /\n4\. Run `pnpm build`\./);
  assert.deepEqual(extractListedUrls(both), [DEAD, DEAD2]);
  assert.deepEqual(extractListedRedirects(both), [VTD]);

  // without redirecting links the text is the old one: no mention, no marker
  const dead = buildDeadLinksBody(sampleEntries(), {
    locations,
    pages: new Map(),
  });
  assert.doesNotMatch(dead, /parent page|link-failures-redirects/);
  assert.deepEqual(extractListedRedirects(dead), []);
  assert.deepEqual(extractListedRedirects("a body without a marker"), []);
  assert.deepEqual(
    extractListedRedirects("<!-- link-failures-redirects: [not json -->"),
    [],
  );
});

test("hostile text in the redirect table stays harmless, and the same state gives the same text whatever order its pages came in", () => {
  const nasty = "https://e.example/a|b`c--><script>x\nsecond line";
  const body = buildDeadLinksBody([], {
    locations: new Map(),
    pages: new Map(),
    redirects: [
      redirectEntry(nasty, {
        final: "https://e.example/|`<img src=x onerror=1>\r\n",
        pages: ["/z/", "/a/", "/m/", "/b/"],
      }),
    ],
  });
  assert.doesNotMatch(body, /<img|<script/);
  assert.match(body, /a\\\|b%60c--%3E%3Cscript%3Ex second line/);
  assert.match(body, /e\.example\/\\\|%60%3Cimg src=x onerror=1%3E /);
  assert.match(body, /Built pages: `\/a\/`, `\/b\/`, `\/m\/` and 1 more\./);
  assert.match(body, /not found in `src\/` as written/);
  assert.deepEqual(extractListedRedirects(body), [nasty]);
  // every row is one line: a line break in an address would end the table
  const table = body.split("\n").filter((line) => line.startsWith("| `"));
  assert.equal(table.length, 1);
  assert.equal(body.split("-->").length, 3);
});

test("a very long list of redirecting links is cut below GitHub's size limit, keeping the markers", () => {
  const redirects = Array.from({ length: 500 }, (_, i) =>
    redirectEntry(`https://example.org/${"x".repeat(120)}/${i}`, {
      final: `https://example.org/${"y".repeat(250)}`,
      pages: Array.from({ length: 4 }, (_, p) => `/pages/${i}/${p}/`),
    }),
  );
  const entries = Array.from({ length: 500 }, (_, i) => ({
    url: `https://example.net/${"x".repeat(80)}/${i}`,
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-19",
    runs: 2,
    reason: "404 Not Found",
  }));
  const body = buildDeadLinksBody(entries, {
    locations: new Map(),
    pages: new Map(),
    redirects,
  });
  assert.ok(body.length < 65_000, `body is ${body.length} characters`);
  assert.equal(body.match(/more links are not shown here/g).length, 2);
  assert.ok(extractListedUrls(body).length > 0);
  assert.ok(extractListedRedirects(body).length > 0);
  // the rows of the first table are cut by the same rule as before: the second table still has some
  assert.match(body, /\| Link \| Now lands on \|/);
});

test("the change comment names what was added or fixed in either table, and the close comment says both are empty", () => {
  const comment = buildChangeComment({
    added: [DEAD],
    removed: [],
    addedRedirects: [VTD],
    removedRedirects: [VTD_QUERY],
    today: "2026-10-19",
    runUrl: null,
  });
  assert.match(
    comment,
    /Newly confirmed dead \(1\):\n- `https:\/\/github\.com\/Azure/,
  );
  assert.match(
    comment,
    /Newly redirecting to a parent page \(1\):\n- `https:\/\/www\.microsoft\.com\/events\/category\/microsoft-virtual-training-days`/,
  );
  assert.match(
    comment,
    /No longer redirecting to a parent page, or gone \(1\):\n- `[^`]*scenario=mvtd/,
  );
  assert.doesNotMatch(
    buildChangeComment({ added: [DEAD], removed: [], today: "2026-10-19" }),
    /parent page/,
  );
  const closing = buildCloseComment({
    today: "2026-11-02",
    runUrl: "https://example.invalid/run/1",
  });
  assert.match(closing, /nothing left to fix/);
  assert.match(closing, /none redirects to a parent page/);
});

// --- the redirect check, end to end ----------------------------------------------------------------

/** A hub whose sources link the two Virtual Training Days addresses (lines 3 and 4). */
async function redirectWorld() {
  const world = await makeWorld();
  await writeFile(
    join(world.hub, "src/content/docs/vouchers.mdx"),
    [
      "# Vouchers",
      "",
      `[Virtual Training Days](${VTD})`,
      `[Introduction to Azure](${VTD_QUERY})`,
      "",
    ].join("\n"),
  );
  return world;
}

/** judge() with the job summary of that run. */
function judgeWithSummary(world, options) {
  const file = join(dirname(world.lychee), "summary.md");
  writeFileSync(file, "");
  const run = judge(world, {
    ...options,
    env: { MIN_LINKS_CHECKED: "5", ...options.env, GITHUB_STEP_SUMMARY: file },
  });
  return { ...run, summary: readFileSync(file, "utf8") };
}

test("the captured redirects: unreported on the first run, reported on the second, quiet afterwards in any order, closed when they stop", async () => {
  const world = await redirectWorld();
  const captured = redirectsCaptured();
  const reversed = {
    ...captured,
    redirect_map: {
      [VTD_PAGE]: [...captured.redirect_map[VTD_PAGE]].reverse(),
    },
    success_map: { [VTD_PAGE]: [...captured.success_map[VTD_PAGE]].reverse() },
  };
  const run = (report, today) => judgeWithSummary(world, { report, today });

  // first run: there is no silent baseline to wait for, but nothing is reported before it was
  // seen twice
  let r = run(captured, "2026-10-12");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.tracker.failing, {});
  assert.deepEqual(Object.keys(r.tracker.redirects), [VTD, VTD_QUERY]);
  assert.deepEqual(r.tracker.redirects[VTD], {
    firstSeen: "2026-10-12",
    lastSeen: "2026-10-12",
    runs: 1,
    final: "https://www.microsoft.com/cs-cz/events",
    codes: [302, 301],
    pages: ["/certs/azure/az-900/"],
  });
  assert.deepEqual(r.outputs, {
    tracker_updated: "true",
    reported_count: "0",
    warning_count: "0",
    check_failed: "false",
  });
  assert.match(
    r.summary,
    /### Redirects\n\n5 links answered through a redirect: 2 only changed the form of the address .*, 1 lead to another site \(not judged\), 0 to another page of the same site, 2 to a parent page of their own site\./,
  );
  assert.match(
    r.summary,
    /first sighting: `https:\/\/www\.microsoft\.com\/events\/category\/microsoft-virtual-training-days` -> `https:\/\/www\.microsoft\.com\/cs-cz\/events` \(302 -> 301\)/,
  );

  // the same day again counts once
  r = run(captured, "2026-10-12");
  assert.equal(r.tracker.redirects[VTD].runs, 1);
  assert.equal(r.outputs.tracker_updated, "false");

  // second run, lychee lists the chains in another order: both are reported in ONE issue
  r = run(reversed, "2026-10-19");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["label create", "issue create"],
  );
  assert.equal(r.issues.length, 1);
  const issue = r.issues[0];
  assert.equal(issue.title, "Link Checker: dead external links");
  assert.deepEqual(issue.labels, ["broken-link"]);
  assert.equal(r.outputs.reported_count, "2");
  assert.equal(r.outputs.tracker_updated, "true");
  assert.match(
    issue.body,
    /### Links that now redirect to a parent page \(the page is probably gone\)/,
  );
  assert.ok(
    issue.body.includes(
      `| \`${VTD}\` | \`https://www.microsoft.com/cs-cz/events\` | 302 -> 301 | 2026-10-12 | \`src/content/docs/vouchers.mdx:3\` Built page: \`/certs/azure/az-900/\`. |`,
    ),
    issue.body,
  );
  assert.match(issue.body, /vouchers\.mdx:4/);
  assert.doesNotMatch(issue.body, /\| Link \| Problem \|/);
  assert.doesNotMatch(issue.body, /aka\.ms|github\.com\/microsoft|mslearn/);
  assert.match(r.summary, /\*\*confirmed\*\*: `https:\/\/www\.microsoft\.com/);
  assert.deepEqual(extractListedRedirects(issue.body), [VTD, VTD_QUERY]);
  const text = readText(world.tracker);

  // quiet weeks, in other orders again: nothing is edited, commented or committed
  for (const [report, today] of [
    [captured, "2026-10-26"],
    [reversed, "2026-11-02"],
  ]) {
    r = run(report, today);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.writes, [], today);
    assert.equal(r.outputs.tracker_updated, "false", today);
    assert.equal(readText(world.tracker), text, today);
    assert.equal(r.issues[0].body, issue.body, today);
  }
  assert.deepEqual(
    r.calls.map((c) => c.command),
    ["issue list", "issue view", "issue list"],
  );

  // the programme page is back (or the card is gone): the issue closes and the tracker forgets
  r = run(redirectReport(HARMLESS), "2026-11-09");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.issues[0].state, "closed");
  assert.match(r.issues[0].comments.at(-1), /nothing left to fix/);
  assert.deepEqual(r.tracker, { failing: {} });
  assert.equal(r.outputs.reported_count, "0");
});

test("a redirecting link on five pages gives the same tracker and the same issue text however lychee lists the pages and wherever it attaches the chain", async () => {
  const world = await redirectWorld();
  const pages = ["a", "b", "c", "d", "e"].map(
    (name) => `dist/certs/area/${name}/index.html`,
  );
  // lychee attaches the chain to ONE of the pages (a different one from run to run) and lists
  // the link on all of them in `success_map`
  const week = (order, today) =>
    judge(world, {
      report: redirectReport([
        chain(
          VTD,
          [
            [302, `${EVENTS_HUB}/category/microsoft-virtual-training-days`],
            [301, EVENTS_HUB],
          ],
          order,
        ),
      ]),
      today,
    });
  week(pages, "2026-10-12");
  const confirmed = week([...pages].reverse(), "2026-10-19");
  assert.equal(confirmed.issues.length, 1);
  assert.match(
    confirmed.issues[0].body,
    /Built pages: `\/certs\/area\/a\/`, `\/certs\/area\/b\/`, `\/certs\/area\/c\/` and 2 more\./,
  );
  assert.deepEqual(confirmed.tracker.redirects[VTD].pages, [
    "/certs/area/a/",
    "/certs/area/b/",
    "/certs/area/c/",
    "/certs/area/d/",
    "/certs/area/e/",
  ]);
  const text = readText(world.tracker);
  const orders = [
    [pages[2], pages[0], pages[4], pages[1], pages[3]],
    [pages[3], pages[1], pages[4], pages[0], pages[2]],
  ];
  for (const [i, order] of orders.entries()) {
    const again = week(order, i === 0 ? "2026-10-26" : "2026-11-02");
    assert.deepEqual(again.writes, [], order.join(" "));
    assert.equal(again.issues[0].body, confirmed.issues[0].body);
    assert.equal(readText(world.tracker), text);
  }
});

test("one issue holds both tables: created when either has a link, a comment per change in either, closed only when both are empty", async () => {
  const world = await redirectWorld();
  const demoted = chain(VTD, [
    [302, `${EVENTS_HUB}/category/microsoft-virtual-training-days`],
    [301, EVENTS_HUB],
  ]);
  const demotedQuery = chain(VTD_QUERY, [
    [
      302,
      `${EVENTS_HUB}/category/microsoft-virtual-training-days?scenario=mvtd`,
    ],
    [301, EVENTS_HUB],
  ]);
  const week = (today, { dead = [], redirecting = [] }) =>
    judgeWithSummary(world, {
      report: redirectReport(redirecting, {
        failures: dead.map((url) => fail(url, NOT_FOUND)),
      }),
      today,
    });

  // week 1: first sightings only
  let r = week("2026-10-12", { dead: [DEAD], redirecting: [demoted] });
  assert.deepEqual(r.writes, []);
  assert.deepEqual(Object.keys(r.tracker.failing), [DEAD]);
  assert.deepEqual(Object.keys(r.tracker.redirects), [VTD]);

  // week 2: both confirmed: one issue, dead links first, one count for both
  r = week("2026-10-19", { dead: [DEAD], redirecting: [demoted] });
  assert.equal(r.issues.length, 1);
  assert.equal(r.outputs.reported_count, "2");
  const body = r.issues[0].body;
  assert.ok(
    body.indexOf("| Link | Problem |") <
      body.indexOf("### Links that now redirect"),
  );
  assert.deepEqual(extractListedUrls(body), [DEAD]);
  assert.deepEqual(extractListedRedirects(body), [VTD]);
  assert.match(body, /src\/content\/docs\/security\/SC-100\.mdx:13/);
  assert.match(body, /src\/content\/docs\/vouchers\.mdx:3/);

  // week 3: the dead link is fixed, the demotion stays: the issue stays open and loses the first table
  r = week("2026-10-26", { redirecting: [demoted] });
  assert.equal(r.issues[0].state, "open");
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["issue edit", "issue comment"],
  );
  assert.equal(r.outputs.reported_count, "1");
  assert.doesNotMatch(r.issues[0].body, /\| Link \| Problem \|/);
  assert.match(
    r.issues[0].body,
    /^The weekly external link check of the built site found no dead link\./,
  );
  const comment = r.issues[0].comments.at(-1);
  assert.match(
    comment,
    /Fixed or gone \(1\):\n- `https:\/\/github\.com\/Azure\/AzureArchitectureExampleScenarios`/,
  );
  assert.doesNotMatch(comment, /parent page/);

  // week 4: a second demotion is only a first sighting: nothing to say
  r = week("2026-11-02", { redirecting: [demoted, demotedQuery] });
  assert.deepEqual(r.writes, []);
  assert.equal(r.issues[0].state, "open");

  // week 5: it is confirmed: only the second table changes, and the comment says so
  r = week("2026-11-09", { redirecting: [demoted, demotedQuery] });
  assert.deepEqual(
    r.writes.map((c) => c.command),
    ["issue edit", "issue comment"],
  );
  assert.equal(r.outputs.reported_count, "2");
  assert.deepEqual(extractListedRedirects(r.issues[0].body), [VTD, VTD_QUERY]);
  const added = r.issues[0].comments.at(-1);
  assert.match(
    added,
    /Newly redirecting to a parent page \(1\):\n- `[^`]*scenario=mvtd[^`]*`\n/,
  );
  assert.doesNotMatch(added, /Newly confirmed dead|Fixed or gone/);

  // week 6: a new dead link is only a first failure again
  r = week("2026-11-16", {
    dead: [DEAD2],
    redirecting: [demoted, demotedQuery],
  });
  assert.deepEqual(r.writes, []);

  // week 7: that link is confirmed while both demotions are over: both tables change in one comment
  r = week("2026-11-23", { dead: [DEAD2] });
  assert.equal(r.issues[0].state, "open");
  assert.doesNotMatch(r.issues[0].body, /### Links that now redirect/);
  assert.match(r.issues[0].body, /old-trainer\.example\.net/);
  const both = r.issues[0].comments.at(-1);
  assert.match(
    both,
    /Newly confirmed dead \(1\):\n- `https:\/\/old-trainer\.example\.net\/az-104`/,
  );
  assert.match(
    both,
    /No longer redirecting to a parent page, or gone \(2\):\n- `https:\/\/www\.microsoft\.com\/events\/category\/microsoft-virtual-training-days`\n- `[^`]*scenario=mvtd/,
  );

  // week 8: everything is fixed: now it closes
  r = week("2026-11-30", {});
  assert.equal(r.issues[0].state, "closed");
  assert.match(r.issues[0].comments.at(-1), /nothing left to fix/);
  assert.deepEqual(r.tracker, { failing: {} });
});

test("a run without redirect data neither advances nor resets what the redirect check knows", async () => {
  const world = await redirectWorld();
  const captured = redirectsCaptured();
  // lychee without verbose counts the redirects but lists none
  const blind = { ...captured, redirect_map: {}, success_map: {} };
  const run = (report, today) => judgeWithSummary(world, { report, today });
  run(captured, "2026-10-12");
  const first = readText(world.tracker);

  // not a second sighting: no issue yet, and it says why it did not look
  let r = run(blind, "2026-10-19");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readText(world.tracker), first);
  assert.equal(r.outputs.tracker_updated, "false");
  assert.deepEqual(r.writes, []);
  assert.match(
    r.summary,
    /### Redirects\n\nThe redirect check had nothing to judge from this run: lychee counted 5 redirects but lists none/,
  );
  assert.match(r.stderr, /Note: The redirect check had nothing to judge from/);

  // 14 days after the first sighting THIS is the second run (the blind one did not count)
  r = run(captured, "2026-10-26");
  assert.equal(r.outputs.reported_count, "2");
  assert.equal(r.tracker.redirects[VTD].firstSeen, "2026-10-12");
  assert.equal(r.tracker.redirects[VTD].runs, 2);
  const confirmed = readText(world.tracker);

  // blind again, and with no redirect_map at all: the issue stays open, nothing is dropped
  const { redirect_map: _unused, ...bare } = captured;
  for (const [report, today] of [
    [blind, "2026-11-02"],
    [bare, "2026-11-09"],
  ]) {
    r = run(report, today);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.writes, [], today);
    assert.equal(r.issues[0].state, "open", today);
    assert.equal(readText(world.tracker), confirmed, today);
    assert.equal(r.outputs.reported_count, "2", today);
  }

  // a report that counts no redirect and lists none IS information: everything recovered
  r = run(lycheeReport(), "2026-11-16");
  assert.equal(r.issues[0].state, "closed");
  assert.deepEqual(r.tracker, { failing: {} });
});

test("more than MAX_REDIRECT_FINDINGS demotions in one run are a change of the site: none is reported, the state stays, the check does not fail", async () => {
  const world = await redirectWorld();
  const flood = (n) =>
    redirectReport(
      Array.from({ length: n }, (_, i) =>
        i < 20
          ? chain(`https://www.microsoft.com/events/category/p${i}`, [
              [301, EVENTS_HUB],
            ])
          : chain(`https://microsoft.github.io/docs/p${i}`, [
              [301, "https://microsoft.github.io/"],
            ]),
      ),
    );
  const run = (report, today, env = {}) =>
    judgeWithSummary(world, { report, today, env });
  run(redirectsCaptured(), "2026-10-12");
  const before = readText(world.tracker);

  let r = run(flood(26), "2026-10-19", { GITHUB_ACTIONS: "true" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, {
    tracker_updated: "false",
    reported_count: "0",
    warning_count: "0",
    check_failed: "false",
  });
  assert.equal(
    readText(world.tracker),
    before,
    "neither learned nor forgotten",
  );
  assert.deepEqual(r.writes, []);
  assert.equal(existsSync(world.error), false, "not a failed check");
  assert.match(
    r.stdout,
    /::warning title=External link check::26 links now redirect permanently to a parent page of their own site, more than the limit of 25 \(MAX_REDIRECT_FINDINGS\): none was reported/,
  );
  assert.match(
    r.stdout,
    /Hosts: www\.microsoft\.com \(20\), microsoft\.github\.io \(6\)\./,
  );
  assert.match(r.summary, /\*\*Too many at once:\*\* 26 links now redirect/);
  assert.match(
    r.summary,
    /- `www\.microsoft\.com`: 20\n- `microsoft\.github\.io`: 6/,
  );

  // exactly the limit is still a normal run (and the 2 old links recovered); a raised limit
  // lets the flood through
  r = run(flood(25), "2026-10-26");
  assert.equal(Object.keys(r.tracker.redirects).length, 25);
  assert.doesNotMatch(r.summary, /Too many at once/);
  r = run(flood(26), "2026-11-02", { MAX_REDIRECT_FINDINGS: "30" });
  assert.equal(Object.keys(r.tracker.redirects).length, 26);
  assert.equal(r.outputs.reported_count, "25", "25 of them were seen twice");
  assert.equal(r.issues.length, 1);
});

test("REDIRECT_CHECK=0 skips the whole analysis and leaves what the check knew", async () => {
  const world = await redirectWorld();
  const run = (report, today, env = {}) =>
    judgeWithSummary(world, { report, today, env });
  // nothing is learned
  let r = run(redirectsCaptured(), "2026-10-12", { REDIRECT_CHECK: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.tracker, { failing: {} });
  assert.match(
    r.summary,
    /### Redirects\n\nThe redirect check is switched off/,
  );
  // nothing is forgotten, however the report looks
  run(redirectsCaptured(), "2026-10-19");
  run(redirectsCaptured(), "2026-10-26");
  const known = readText(world.tracker);
  assert.equal(JSON.parse(known).redirects[VTD].runs, 2);
  r = run(lycheeReport(), "2026-11-02", { REDIRECT_CHECK: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readText(world.tracker), known);
  assert.deepEqual(r.writes, []);
  assert.equal(r.issues[0].state, "open");
  // switched on again, the same report is information and ends it
  r = run(lycheeReport(), "2026-11-09");
  assert.equal(r.issues[0].state, "closed");
});

test("a link that only redirects temporarily to a parent page is a warning in the summary and the annotation, never a finding", async () => {
  const world = await redirectWorld();
  const temporary = redirectReport([
    chain(VTD, [[302, EVENTS_HUB]]),
    chain(VTD_QUERY, [[307, EVENTS_HUB]]),
  ]);
  const run = (report, today, env = {}) =>
    judgeWithSummary(world, { report, today, env });
  let r;
  for (const today of ["2026-10-12", "2026-10-19", "2026-10-26"]) {
    r = run(temporary, today);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.tracker, { failing: {} }, today);
    assert.deepEqual(r.writes, [], today);
    assert.equal(r.outputs.reported_count, "0", today);
  }
  assert.match(
    r.summary,
    /\*\*Only temporary redirects to a parent page \(2\): warnings, never reported\*\*\n\n- `https:\/\/www\.microsoft\.com\/events\/category\/microsoft-virtual-training-days` -> `https:\/\/www\.microsoft\.com\/en-us\/events` \(302\)/,
  );
  assert.doesNotMatch(r.summary, /Probably gone/);
  assert.match(
    r.stderr,
    /Note: 2 links redirect only temporarily to a parent page of their own site; they are warnings only, never reported/,
  );
  r = run(temporary, "2026-11-02", { GITHUB_ACTIONS: "true" });
  assert.match(
    r.stdout,
    /::warning title=External link check::2 links redirect only temporarily to a parent page/,
  );
  // when it turns permanent it starts counting from then on
  const permanent = redirectReport([chain(VTD, [[301, EVENTS_HUB]])]);
  r = run(permanent, "2026-11-09");
  assert.equal(r.tracker.redirects[VTD].runs, 1);
  r = run(permanent, "2026-11-16");
  assert.equal(r.outputs.reported_count, "1");
  assert.equal(r.issues.length, 1);
});

test("a link added to .lycheeignore leaves the redirect check and its list; a line that is no regular expression is skipped with a note", async () => {
  const world = await redirectWorld();
  const run = (today) =>
    judgeWithSummary(world, { report: redirectsCaptured(), today });
  run("2026-10-12");
  let r = run("2026-10-19");
  assert.equal(r.issues[0].state, "open");
  await writeFile(
    join(world.hub, ".lycheeignore"),
    "# the programme page is still the right page\nmicrosoft\\.com/events/category/microsoft-virtual-training-days\n[broken\n",
  );
  r = run("2026-10-26");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.issues[0].state, "closed");
  assert.deepEqual(r.tracker, { failing: {} });
  assert.match(r.summary, /2 skipped \(\.lycheeignore\)/);
  assert.match(
    r.stderr,
    /Note: \.lycheeignore has lines that are not valid regular expressions \(1\); the redirect check skipped them \(first: \[broken\)/,
  );
});

test("the job summary has a Redirects section: how many links redirect, the moved ones (first 20), the candidates and the temporary ones", async () => {
  const world = await redirectWorld();
  const name = (i) => String(i).padStart(2, "0");
  const moved = Array.from({ length: 25 }, (_, i) =>
    chain(`https://learn-ish.example/a/b/p${name(i)}`, [
      [301, `https://learn-ish.example/a/c/p${name(i)}`],
    ]),
  );
  const r = judgeWithSummary(world, {
    report: redirectReport([
      ...moved,
      chain(VTD, [[301, EVENTS_HUB]]),
      chain(VTD_QUERY, [[302, EVENTS_HUB]]),
      ...HARMLESS.slice(0, 2),
    ]),
    today: "2026-10-12",
  });
  assert.equal(r.status, 0, r.stderr);
  const section = r.summary.split("### Redirects")[1];
  assert.match(
    section,
    /^\n\n29 links answered through a redirect: 1 only changed the form of the address \(http to https, `www`, a trailing slash, a locale, a query\), 1 lead to another site \(not judged\), 25 to another page of the same site, 2 to a parent page of their own site\./,
  );
  assert.match(
    section,
    /\*\*Probably gone: a permanent redirect to a parent page \(1\)\*\*\n\n- first sighting: `https:\/\/www\.microsoft\.com\/events\/category\/microsoft-virtual-training-days` -> `https:\/\/www\.microsoft\.com\/en-us\/events` \(301\)/,
  );
  assert.match(section, /Only temporary redirects to a parent page \(1\)/);
  assert.match(
    section,
    /\*\*Moved to another page of the same site \(25\): not reported, first 20\*\*/,
  );
  const listed = section
    .split("\n")
    .filter((line) => line.startsWith("- `https://learn-ish.example/a/b/"));
  assert.equal(listed.length, 20);
  assert.ok(listed[0].includes("/p00`") && listed[19].includes("/p19`"));
  assert.deepEqual(r.tracker.redirects && Object.keys(r.tracker.redirects), [
    VTD,
  ]);
});

test("REDIRECT_CHECK and MAX_REDIRECT_FINDINGS are read from the environment", () => {
  const config = (env) => loadConfig({ REPO_ROOT: repoRoot, ...env });
  assert.equal(config({}).redirectCheck, true);
  assert.equal(config({}).maxRedirectFindings, 25);
  assert.equal(config({ REDIRECT_CHECK: "0" }).redirectCheck, false);
  assert.equal(config({ REDIRECT_CHECK: "1" }).redirectCheck, true);
  assert.equal(config({ MAX_REDIRECT_FINDINGS: "3" }).maxRedirectFindings, 3);
  assert.equal(
    config({ MAX_REDIRECT_FINDINGS: "lots" }).maxRedirectFindings,
    25,
  );
  assert.equal(
    config({ LYCHEE_IGNORE_FILE: "x/ignore" }).lycheeIgnoreFile,
    join(repoRoot, "x/ignore"),
  );
  assert.equal(config({}).lycheeIgnoreFile, join(repoRoot, ".lycheeignore"));
});

// --- list / check against a local server --------------------------------------------------------

async function startServer() {
  const hits = [];
  const state = { goneStatus: 404 };
  const server = createServer((req, res) => {
    hits.push(req.url);
    const path = req.url.split("?")[0];
    if (path === "/allowed/slow") return; // never answers
    if (path === "/allowed/gone")
      return void res.writeHead(state.goneStatus).end("x");
    if (path === "/allowed/limited") return void res.writeHead(429).end();
    if (path === "/allowed/flaky") return void res.writeHead(503).end();
    if (path === "/allowed/moved") {
      return void res.writeHead(301, { location: "/allowed/ok-moved" }).end();
    }
    // a page that is gone: a redirect to the parent page (permanent), the same but temporary,
    // a permanent redirect behind a temporary one with an absolute Location, and a loop
    if (path === "/allowed/section/retired") {
      return void res.writeHead(301, { location: "/allowed/" }).end();
    }
    if (path === "/allowed/section/paused") {
      return void res.writeHead(302, { location: "/allowed/" }).end();
    }
    if (path === "/allowed/section/old") {
      return void res
        .writeHead(302, { location: "/allowed/section/old-2" })
        .end();
    }
    if (path === "/allowed/section/old-2") {
      return void res
        .writeHead(301, { location: `http://${req.headers.host}/allowed/` })
        .end();
    }
    if (path === "/allowed/loop") {
      return void res.writeHead(302, { location: "/allowed/loop" }).end();
    }
    res.writeHead(200).end("ok");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    hits,
    state,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

function runAsync(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

test("the lychee-free check runs the whole pipeline against a local server, week after week", async () => {
  const server = await startServer();
  try {
    const world = await makeWorld();
    // a built site that links the local server: 20 good links, 4 problem links, one link the
    // allowlist must not touch, and a link to a source line
    const ok = Array.from(
      { length: 20 },
      (_, i) => `<a href="${server.origin}/allowed/ok-${i}?a=1&amp;b=2">ok</a>`,
    );
    const html = [
      "<!doctype html><html><body>",
      ...ok,
      `<a href="${server.origin}/allowed/gone">gone</a>`,
      `<a href="${server.origin}/allowed/limited">limited</a>`,
      `<a href="${server.origin}/allowed/flaky">flaky</a>`,
      `<a href="${server.origin}/allowed/slow">slow</a>`,
      `<a href="${server.origin}/allowed/moved">moved</a>`,
      `<a href="${server.origin}/private/never-requested">not allowlisted</a>`,
      '<a href="/certs/local/">internal</a>',
      "</body></html>",
    ].join("\n");
    await rm(join(world.hub, "dist"), { recursive: true });
    await mkdir(join(world.hub, "dist/certs/local"), { recursive: true });
    await writeFile(join(world.hub, "dist/certs/local/index.html"), html);
    await mkdir(join(world.hub, "src/content/docs"), { recursive: true });
    await writeFile(
      join(world.hub, "src/content/docs/local.mdx"),
      `# Local\n\n<LinkCard href="${server.origin}/allowed/gone" />\n`,
    );
    const env = {
      REPO_ROOT: world.hub,
      LYCHEE_JSON: world.lychee,
      INCLUDE_PATTERNS: JSON.stringify([
        `^${server.origin.replace(/[.]/g, "\\.")}/allowed/`,
      ]),
      FETCH_DELAY_MS: "0",
      CHECK_TIMEOUT_MS: "400",
      CHECK_RETRIES: "1",
      CHECK_RETRY_WAIT_MS: "0",
    };

    // list: nothing is requested
    const listed = await runAsync(["list"], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /25 links on 1 host selected/);
    assert.deepEqual(server.hits, []);

    const check = async () => {
      const res = await runAsync(["check"], env);
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(readFileSync(world.lychee, "utf8"));
    };
    const week = async (today) => {
      await check();
      return judge(world, {
        today,
        env: { MIN_LINKS_CHECKED: "10", LYCHEE_EXIT_CODE: "2" },
      });
    };

    // the fetch runner writes lychee's shape
    const stats = await check();
    assert.equal(stats.successful, 21, "20 links and the redirect target");
    assert.equal(stats.errors, 3);
    assert.equal(stats.timeouts, 1);
    const page = "dist/certs/local/index.html";
    const byUrl = Object.fromEntries(
      stats.error_map[page].map((e) => [
        e.url.replace(server.origin, ""),
        e.status,
      ]),
    );
    assert.deepEqual(byUrl["/allowed/gone"], {
      text: "Rejected status code: 404 Not Found",
      code: 404,
    });
    assert.equal(byUrl["/allowed/limited"].code, 429);
    assert.equal(byUrl["/allowed/flaky"].code, 503);
    assert.equal(stats.timeout_map[page][0].status.text, "Timeout");
    assert.ok(
      !server.hits.some((h) => h.startsWith("/private")),
      "only allowlisted links are requested",
    );
    assert.ok(
      server.hits.includes("/allowed/ok-moved"),
      "redirects are followed",
    );
    assert.ok(
      server.hits.includes("/allowed/ok-3?a=1&b=2"),
      "entities in the HTML are decoded",
    );

    // week 1: baseline; week 2: the 404 is confirmed, the 429/503/timeout never are
    let r = await week("2026-10-12");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(Object.keys(r.tracker.failing), [
      `${server.origin}/allowed/gone`,
    ]);
    assert.equal(r.outputs.warning_count, "3");

    r = await week("2026-10-19");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.issues.length, 1);
    assert.match(
      r.issues[0].body,
      new RegExp(`${server.origin.replace(/[.]/g, "\\.")}/allowed/gone`),
    );
    assert.match(r.issues[0].body, /src\/content\/docs\/local\.mdx:3/);
    assert.match(r.issues[0].body, /`\/certs\/local\/`/);
    assert.doesNotMatch(r.issues[0].body, /limited|flaky|slow/);

    // the page is fixed: the issue closes and the tracker is empty
    server.state.goneStatus = 200;
    r = await week("2026-10-26");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.issues[0].state, "closed");
    assert.deepEqual(r.tracker, { failing: {} });
  } finally {
    await server.close();
  }
});

test("the lychee-free check refuses to run without a built site", async () => {
  const world = await makeWorld();
  const res = await runAsync(["check"], {
    REPO_ROOT: world.hub,
    DIST_DIR: join(world.hub, "missing-dist"),
    LYCHEE_JSON: world.lychee,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /pnpm build/);
});

test("the lychee-free check writes the redirect chains in lychee's shape, so a local run gives the same findings", async () => {
  const server = await startServer();
  try {
    const world = await makeWorld();
    const to = (path) => `${server.origin}${path}`;
    const links = [
      "section/retired",
      "section/old",
      "section/paused",
      "moved",
      "loop",
      "ok-1",
    ].map((name) => `<a href="${to(`/allowed/${name}`)}">${name}</a>`);
    const pageA = "dist/certs/local/index.html";
    const pageB = "dist/certs/other/index.html";
    await rm(join(world.hub, "dist"), { recursive: true });
    for (const [page, anchors] of [
      [pageA, links],
      [pageB, [links[0]]],
    ]) {
      await mkdir(join(world.hub, dirname(page)), { recursive: true });
      await writeFile(
        join(world.hub, page),
        `<!doctype html><html><body>${anchors.join("\n")}</body></html>`,
      );
    }
    await writeFile(
      join(world.hub, "src/content/docs/local.mdx"),
      `# Local\n\n<LinkCard href="${to("/allowed/section/retired")}" />\n`,
    );
    const summaryFile = join(dirname(world.lychee), "summary.md");
    const env = {
      REPO_ROOT: world.hub,
      LYCHEE_JSON: world.lychee,
      INCLUDE_PATTERNS: JSON.stringify([
        `^${server.origin.replace(/[.]/g, "\\.")}/allowed/`,
      ]),
      FETCH_DELAY_MS: "0",
      CHECK_TIMEOUT_MS: "2000",
      CHECK_RETRIES: "1",
      CHECK_RETRY_WAIT_MS: "0",
    };
    const res = await runAsync(["check"], env);
    assert.equal(res.status, 0, res.stderr);
    const stats = JSON.parse(readFileSync(world.lychee, "utf8"));

    // lychee's shape: the chain of a link, hop by hop, with the status of the response that
    // redirected; a relative Location is made absolute; the same chain sits next to the answer
    assert.equal(stats.detailed_stats, true);
    assert.equal(stats.redirects, 5, "four on one page, one on the other");
    assert.equal(stats.successful, 6);
    const chainOf = (page, path) =>
      stats.redirect_map[page].find((c) => c.origin === to(path));
    assert.deepEqual(chainOf(pageA, "/allowed/section/retired"), {
      origin: to("/allowed/section/retired"),
      redirects: [{ url: to("/allowed/"), code: 301 }],
    });
    assert.deepEqual(chainOf(pageA, "/allowed/section/old").redirects, [
      { url: to("/allowed/section/old-2"), code: 302 },
      { url: to("/allowed/"), code: 301 },
    ]);
    assert.deepEqual(chainOf(pageA, "/allowed/section/paused").redirects, [
      { url: to("/allowed/"), code: 302 },
    ]);
    assert.deepEqual(chainOf(pageA, "/allowed/moved").redirects, [
      { url: to("/allowed/ok-moved"), code: 301 },
    ]);
    assert.equal(
      chainOf(pageB, "/allowed/section/retired").redirects.length,
      1,
    );
    assert.equal(chainOf(pageA, "/allowed/ok-1"), undefined);
    assert.deepEqual(
      stats.success_map[pageA].find(
        (e) => e.url === to("/allowed/section/old"),
      ),
      {
        url: to("/allowed/section/old"),
        status: { text: "200 OK", code: 200 },
        redirects: chainOf(pageA, "/allowed/section/old"),
        span: { line: 0, column: 0 },
      },
    );
    // at most 10 hops are followed: the 11th redirect of a loop is an error, and a loop is
    // not asked again
    assert.equal(stats.errors, 1);
    assert.equal(stats.error_map[pageA][0].url, to("/allowed/loop"));
    assert.match(stats.error_map[pageA][0].status.text, /Too many redirects/);
    assert.equal(
      server.hits.filter((h) => h === "/allowed/loop").length,
      11,
      "the address and 10 hops",
    );

    // the same judging as a lychee report: two weeks give the same findings
    const week = (today) =>
      judge(world, {
        today,
        env: {
          MIN_LINKS_CHECKED: "3",
          LYCHEE_EXIT_CODE: "2",
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      });
    let r = week("2026-10-12");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(r.tracker.redirects), [
      to("/allowed/section/old"),
      to("/allowed/section/retired"),
    ]);
    assert.deepEqual(r.writes, []);
    r = week("2026-10-19");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.reported_count, "2");
    assert.equal(r.outputs.warning_count, "1", "the loop is only a warning");
    assert.equal(r.issues.length, 1);
    const body = r.issues[0].body;
    assert.match(body, /\| 302 -> 301 \| 2026-10-12 \|/);
    assert.match(body, /src\/content\/docs\/local\.mdx:3/);
    assert.match(body, /Built pages: `\/certs\/local\/`, `\/certs\/other\/`\./);
    assert.deepEqual(extractListedRedirects(body), [
      to("/allowed/section/old"),
      to("/allowed/section/retired"),
    ]);
    assert.doesNotMatch(body, /paused|moved|loop|ok-1/);
    const summary = readFileSync(summaryFile, "utf8");
    assert.match(summary, /Only temporary redirects to a parent page \(1\)/);
    assert.match(summary, /Moved to another page of the same site \(1\)/);
  } finally {
    await server.close();
  }
});

test("an unknown command is rejected", () => {
  const res = spawnSync(process.execPath, [script, "frobnicate"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown command/);
});

// --- the workflow -----------------------------------------------------------------------------------

const workflow = readFileSync(
  join(repoRoot, ".github/workflows/link-checker.yml"),
  "utf8",
);
const at = (needle) => {
  const i = workflow.indexOf(needle);
  assert.ok(i >= 0, `the workflow has no "${needle}"`);
  return i;
};

test("the workflow keeps the internal PR gate and adds a visible, ordered external job", () => {
  // triggers: the pull request paths (what the links of the site come from), weekly schedule,
  // manual run with a dry run switch
  assert.match(
    workflow,
    /pull_request:\s+paths:\s+- "src\/content\/\*\*"\s+- "\.github\/workflows\/link-checker\.yml"\s+- "\.lycheeignore"/,
  );
  const prPaths = [
    ...workflow
      .match(/pull_request:\n\s+paths:\n((?:\s+- ".*"\n)+)/)[1]
      .matchAll(/- "(.*)"/g),
  ].map((m) => m[1]);
  // sidebar, data and component changes are links of the built site too: they were only
  // checked on Monday
  for (const path of [
    "src/content/**",
    ".github/workflows/link-checker.yml",
    ".lycheeignore",
    "src/data_files/**",
    "src/components/**",
    "src/pages/**",
    "astro.config.mjs",
    "public/**",
  ]) {
    assert.ok(prPaths.includes(path), `a pull request path: ${path}`);
  }
  assert.match(workflow, /- cron: "30 10 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+dry_run:/);
  // the internal check still fails the job, on every event, and is not masked
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /linkinator/);
  assert.doesNotMatch(workflow, /create-issue-from-file/);
  assert.match(workflow, /--exclude 'https\?:\/\/\.\*'/);
  assert.match(workflow, /--root-dir dist/);
  // the external job: never on pull requests, own permissions, own concurrency group
  const external = workflow.slice(at("  external:"));
  assert.match(external, /if: github\.event_name != 'pull_request'/);
  assert.match(external, /permissions:\s+contents: write\s+issues: write/);
  assert.match(
    external,
    /concurrency:\s+group: link-checker-external\s+cancel-in-progress: false/,
  );
  assert.match(external, /timeout-minutes: \d+/);
  const internal = workflow.slice(at("  internal:"), at("  external:"));
  assert.match(internal, /permissions:\s+contents: read/);
  assert.doesNotMatch(internal, /issues: write|contents: write/);
  // order inside the external job: build, lychee, judge + issue, then commit the tracker
  const build = external.indexOf("pnpm build");
  const lychee = external.indexOf("lychee-external.toml");
  const judge = external.indexOf("node scripts/link-failures.mjs");
  const commit = external.indexOf("git add src/data_files/link-failures.json");
  assert.ok(build >= 0 && build < lychee && lychee < judge && judge < commit);
  assert.match(external, /format: json/);
  assert.match(external, /fail: false/);
  assert.match(external, /output: lychee\/external\.json/);
  assert.match(
    external,
    /LYCHEE_EXIT_CODE: \$\{\{ steps\.lychee\.outputs\.exit_code \}\}/,
  );
  assert.match(external, /CREATE_ISSUES: "1"/);
  // the commit step must not run after a failed issue step: no status-check function in its condition
  const commitStep = external.slice(external.lastIndexOf("- name:", commit));
  assert.match(
    commitStep,
    /if: steps\.judge\.outputs\.tracker_updated == 'true'/,
  );
  assert.doesNotMatch(commitStep, /always\(\)|failure\(\)|!cancelled\(\)/);
  // the lychee step runs even when the internal job failed (separate jobs) and must not use the cache
  assert.doesNotMatch(external, /--cache(?![\w-])|actions\/cache/);
});

test("the external job, which builds the site with write permission, keeps no credential for the build to find", () => {
  const external = workflow.slice(at("  external:"));
  // The checkout keeps no token in .git/config: a dependency run by pnpm install
  // or pnpm build could push to main with it.
  const checkout = external.match(
    /- uses: actions\/checkout@\S+ # v\d+\n(?: {8}.*\n)*/,
  );
  assert.ok(checkout, "the external job checks the repository out");
  assert.match(checkout[0], /persist-credentials: false/);
  // Nothing before the judging step gets the token; the judge needs it for gh, and
  // the commit step (nothing but git) sets it on the remote itself.
  const build = external.indexOf("pnpm build");
  const judge = external.indexOf("- name: Judge the report");
  const commit = external.indexOf("- name: Commit updated link tracker");
  assert.ok(build > 0 && build < judge && judge < commit);
  assert.doesNotMatch(
    external.slice(0, judge),
    /GH_TOKEN|GITHUB_TOKEN|github\.token|secrets\./,
  );
  const commitStep = external.slice(commit);
  assert.match(commitStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const setUrl = commitStep.indexOf(
    'git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${{ github.repository }}.git"',
  );
  assert.ok(setUrl > 0, "the remote gets the token in the commit step");
  assert.ok(
    setUrl < commitStep.indexOf("git push"),
    "the remote is set before the push",
  );
  // The commit step runs git only: no package manager, no node script.
  assert.doesNotMatch(commitStep, /pnpm|npm |node |npx /);
  // The read-only internal job never had the problem and keeps its default checkout.
  assert.doesNotMatch(
    workflow.slice(at("  internal:"), at("  external:")),
    /persist-credentials/,
  );
});

test("the schedule is weekly and no other workflow that pushes to main starts in the same minute", () => {
  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (match) => match.slice(1, 6),
    );
  const [mine, ...extra] = cron(workflow);
  assert.equal(extra.length, 0, "one schedule");
  assert.deepEqual(mine.slice(2), ["*", "*", "1"], "once a week, on Monday");
  assert.match(workflow, /git push/, "this workflow pushes the tracker");

  // Two workflows starting together can reject each other's push. Every pusher retries it on
  // top of what landed meanwhile (three tries, tested in workflows.test.mjs), so a clash only
  // costs a retry; distinct slots are a convenience that keeps the retries rare.
  const dir = join(repoRoot, ".github/workflows");
  for (const name of readdirSync(dir)) {
    if (name === "link-checker.yml" || !name.endsWith(".yml")) continue;
    const other = readFileSync(join(dir, name), "utf8");
    if (!/git push/.test(other)) continue;
    for (const schedule of cron(other)) {
      assert.notDeepEqual(
        schedule.slice(0, 2),
        mine.slice(0, 2),
        `${name} starts at the same time (${schedule.slice(0, 2).join(" ")})`,
      );
    }
  }
});
