import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  buildIssueTitle,
  buildProduct,
  buildReport,
  classifyProduct,
  countListing,
  diffHubState,
  diffProducts,
  extractAssignedJson,
  findExamPages,
  isBundle,
  isRetired,
  isTracked,
  loadConfig,
  pageUrl,
  parseListingPage,
  parseToolbar,
  retryDelayMs,
  safeText,
  scanHubLinks,
  stripComments,
  suggestReplacements,
} from "../../scripts/measureup-check.mjs";
import {
  bashSkipReason,
  findBash,
  makeScratchRemote,
  runBash,
} from "./helpers/git-remote.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/measureup-check.mjs");
const FIXTURE = readFileSync(
  join(root, "tests/fixtures/measureup/listing-page.html"),
  "utf8",
);
const SITE = "https://www.measureup.com";

const tempDirs = [];
async function tempDir(prefix = "measureup-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// A fake MeasureUp: the catalog listing (12 products a page, a toolbar, the
// dl4Objects data and the product tiles) and the product pages themselves
// ---------------------------------------------------------------------------
const TITLES = {
  assessment: (code) => `Assessment ${code}: Exam ${code}`,
  "practice-test": (code) => `Microsoft Practice Test ${code}: Exam ${code}`,
  certkit: (code) => `CertKit ${code}: Exam ${code}`,
  bundle: (code) => `Bundle ${code} + AZ-900`,
};
const CATEGORY = {
  assessment: "Microsoft Assessments",
  "practice-test": "Microsoft Practice Tests",
  certkit: "Microsoft CertKits",
};

/**
 * One product. The URL is unrelated to the name on purpose (as MeasureUp's are),
 * so a test that finds it in a report proves it was read from the product tile.
 */
function product(id, { kind, code, retired = false } = {}) {
  const k = kind ?? ["assessment", "practice-test", "certkit"][id % 3];
  const c = code ?? `AZ-${id}`;
  return {
    id: String(id),
    kind: k,
    code: c,
    retired,
    name: (retired ? "[Retired Exam] " : "") + TITLES[k](c),
    path: `/mu-${id}-${k}.html`,
  };
}

/** Products with ids from..to. */
const range = (from, to, options = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => product(from + i, options));

function dlItem(p, index) {
  return {
    item_name: p.name,
    item_id: p.id,
    price: "64.35",
    item_brand: "Microsoft",
    item_category: p.retired ? "Retired Exams" : "Microsoft",
    ...(p.kind === "bundle"
      ? {}
      : {
          item_category2: "Microsoft Technical",
          item_category3: p.retired
            ? "Microsoft Practice Tests"
            : CATEGORY[p.kind],
        }),
    item_list_name: "Microsoft",
    index: index + 1,
    currency: "USD",
  };
}

function tile(p, origin) {
  return (
    `<li class="product product__item product--grid "><div class="product__inner item">` +
    `<a href="${origin}${p.path}" class="product__photo product photo product-item-photo"></a>` +
    `<form><input type="hidden" name="product" value="${p.id}"></form>` +
    `<h3 class="product__name"><a class="product__link product-item-link" href="${origin}${p.path}">` +
    `${p.name}   </a></h3><div class="price-box" data-product-id="${p.id}"></div></div></li>`
  );
}

/** One listing page; `shown` are the products, the toolbar says `from`-`to` of `total`. */
function listingHtml(shown, { from, to, total, origin }) {
  const data = [{ pageName: "Page", ecommerce: { items: shown.map(dlItem) } }];
  return (
    `<html><body><div class="toolbar-amount">Items <span class="toolbar-number">${from}</span>-` +
    `<span class="toolbar-number">${to}</span> of <span class="toolbar-number">${total}</span></div>` +
    `<ol class="products list items product-items product__items">${shown.map((p) => tile(p, origin)).join("")}</ol>` +
    `<script>var dl4Objects = ${JSON.stringify(data)};</script></body></html>`
  );
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byId = (a, b) => Number(a.id) - Number(b.id);

/**
 * `site.catalog` is what the listing shows, `site.pages` the product pages that
 * answer (path -> {status, location}); every other path is a 404. `site.listing`
 * may take over a listing page: (pageNumber, url, site) -> html | {status, body}.
 */
async function fakeSite(catalog, { pageSize = 12 } = {}) {
  const site = {
    catalog,
    pageSize,
    origin: "",
    hits: [],
    listingHits: [],
    scans: 0,
    pages: new Map(),
    listing: null,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    site.hits.push(url.pathname + url.search);
    if (url.pathname === "/microsoft.html") {
      const page = Number(url.searchParams.get("p") ?? 1);
      const order = url.searchParams.get("product_list_order");
      if (page === 1) site.scans++;
      site.listingHits.push({ page, order });
      const custom = site.listing?.(page, url, site);
      if (custom !== undefined && custom !== null) {
        const reply = typeof custom === "string" ? { body: custom } : custom;
        response.statusCode = reply.status ?? 200;
        return response.end(reply.body ?? "");
      }
      const sorted = [...site.catalog].sort(order === "name" ? byName : byId);
      const shown = sorted.slice((page - 1) * pageSize, page * pageSize);
      const from = (page - 1) * pageSize + 1;
      response.setHeader("content-type", "text/html");
      return response.end(
        listingHtml(shown, {
          from,
          to: from + shown.length - 1,
          total: sorted.length,
          origin: site.origin,
        }),
      );
    }
    const page = site.pages.get(url.pathname);
    if (page?.status >= 300 && page.status < 400) {
      response.statusCode = page.status;
      response.setHeader("location", page.location);
      return response.end();
    }
    if (page) {
      response.statusCode = page.status ?? 200;
      return response.end("product page");
    }
    if (site.catalog.some((p) => p.path === url.pathname)) {
      return response.end("product page");
    }
    response.statusCode = 404;
    return response.end("not found");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  site.origin = `http://127.0.0.1:${server.address().port}`;
  site.close = () => new Promise((done) => server.close(done));
  site.probes = () =>
    site.hits.filter((hit) => !hit.startsWith("/microsoft.html"));
  return site;
}

/** The record a baseline keeps for a product of the fake site. */
const stored = (p, origin) => ({
  name: p.name.replace("[Retired Exam] ", ""),
  id: p.id,
  examCode: p.code,
  type: p.kind,
  url: `${origin}${p.path}`,
});

async function writeBaseline(file, products, origin, extra = {}) {
  const body = {
    lastChecked: "2026-06-29T18:22:49Z",
    totalProducts: products.length,
    ...extra,
    products: products.map((p) => stored(p, origin)),
  };
  await writeFile(file, JSON.stringify(body, null, 2) + "\n");
  return readFile(file, "utf8");
}

/** A docs tree with the given exam pages: { "azure/AZ-104.mdx": "text" }. */
async function writeDocs(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
}

const link = (path, title = "MeasureUp Assessment") =>
  `<LinkCard title="${title}" href="${SITE}${path}#u44" target="_blank"/>`;

/** Runs the real script against the fake site; resolves with everything it left behind. */
async function runMonitor(site, dir, env = {}) {
  const files = {
    baseline: join(dir, "baseline.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "github-output"),
    docs: join(dir, "docs"),
  };
  await mkdir(files.docs, { recursive: true });
  await writeFile(files.output, "");
  const child = spawn("node", [script], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "",
      BASE_URL: `${site.origin}/microsoft.html`,
      BASELINE_FILE: files.baseline,
      DOCS_DIR: files.docs,
      REPORT_FILE: files.report,
      ERROR_FILE: files.error,
      GITHUB_OUTPUT: files.output,
      FETCH_DELAY_MS: "0",
      RETRY_BASE_MS: "0",
      FETCH_ATTEMPTS: "2",
      TODAY: "2026-10-13",
      FORCE_BASELINE: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("close", done));
  const read = async (file) => readFile(file, "utf8").catch(() => null);
  const output = Object.fromEntries(
    (await readFile(files.output, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const baselineText = await read(files.baseline);
  return {
    code,
    stdout,
    stderr,
    output,
    report: await read(files.report),
    error: await read(files.error),
    baselineText,
    baseline: (() => {
      try {
        return JSON.parse(baselineText);
      } catch {
        return null;
      }
    })(),
    files,
  };
}

// ---------------------------------------------------------------------------
// Parsing the listing (real markup)
// ---------------------------------------------------------------------------
test("a real listing page yields its products with the URL of the tile, not one made up from the name", () => {
  const page = parseListingPage(FIXTURE, SITE);
  assert.equal(page.items.length, 6);
  assert.deepEqual(page.toolbar, { from: 157, to: 162, total: 162 });
  const products = page.items.map((item) => buildProduct(item, page.links));
  const sc200 = products.find((p) => p.id === "7809");
  assert.equal(
    sc200.name,
    "Microsoft Practice Test SC-200: Microsoft Security Operations Analyst",
  );
  assert.equal(
    sc200.url,
    "https://www.measureup.com/microsoft-practice-test-sc-200-microsoft-security-operations-analyst.html",
  );
  assert.equal(sc200.type, "practice-test");
  assert.equal(sc200.examCode, "SC-200");
  assert.equal(sc200.retired, false);
  assert.ok(
    products.every(
      (p) => p.url.startsWith(`${SITE}/`) && p.url.endsWith(".html"),
    ),
    "every tile has its URL",
  );
});

test("the product data is found even when a name holds brackets and quotes", () => {
  const html =
    'x <script>var dl4Objects = [{"ecommerce":{"items":[{"item_name":"A \\"]; B\\" [x]","item_id":"1"}]}}]; var later = [1];</script>';
  const page = parseListingPage(html, SITE);
  assert.equal(page.items[0].item_name, 'A "]; B" [x]');
  assert.equal(
    extractAssignedJson('var y = {"a": [1, {"b": 2}]}; z', "var y"),
    '{"a": [1, {"b": 2}]}',
  );
  assert.throws(() => extractAssignedJson("nothing", "var y"), /missing/);
  assert.throws(
    () =>
      parseListingPage("<script>var dl4Objects = [invalid];</script>", SITE),
    /not valid JSON/,
  );
  assert.throws(
    () =>
      parseListingPage('<script>var dl4Objects = [{"a":1}];</script>', SITE),
    /ecommerce\.items must be a list/,
  );
});

test("the toolbar gives the page range and the total", () => {
  assert.deepEqual(
    parseToolbar(
      'Items <span class="toolbar-number">13</span>-<span class="toolbar-number">24</span> of <span class="toolbar-number">162</span>',
    ),
    { from: 13, to: 24, total: 162 },
  );
  assert.deepEqual(
    parseToolbar('<span class="toolbar-number">9</span> Items'),
    {
      from: 1,
      to: 9,
      total: 9,
    },
  );
  assert.equal(parseToolbar("<div>nothing</div>"), null);
});

test("retired products are recognised by name or by category, bundles by name", () => {
  assert.equal(
    isRetired({
      item_name: "[Retired Exam] Microsoft Practice Test AZ-204: X",
    }),
    true,
  );
  assert.equal(
    isRetired({
      item_name: "Microsoft Practice Test AZ-204: X",
      item_category: "Retired Exams",
    }),
    true,
  );
  assert.equal(
    isRetired({
      item_name: "Assessment AZ-104: X",
      item_category: "Microsoft",
      item_category2: "Microsoft Technical",
    }),
    false,
  );
  assert.equal(
    classifyProduct({
      item_name: "Bundle Azure Administrator (AZ-900 + AZ-104)",
    }),
    "bundle",
  );
  assert.equal(
    classifyProduct({ item_name: "Microsoft Assessment AZ-800: X" }),
    "assessment",
  );
  assert.equal(
    classifyProduct({
      item_name: "CertKit AZ-104: X",
      item_category: "Microsoft",
      item_category2: "Microsoft CertKits",
    }),
    "certkit",
  );
  assert.equal(classifyProduct({ item_name: "Something else" }), "unknown");
  assert.equal(
    isBundle({
      type: "unknown",
      name: "Bundle Power Platform Developer (PL-900 + PL-400)",
    }),
    true,
  );
  assert.equal(
    isTracked({
      type: "practice-test",
      name: "Microsoft Practice Test X",
      retired: false,
    }),
    true,
  );
  assert.equal(
    isTracked({ type: "practice-test", name: "X", retired: true }),
    false,
  );
  assert.equal(
    isTracked({ type: "bundle", name: "Bundle X", retired: false }),
    false,
  );
});

test("the listing URL asks for a stable order, and a page number from the second page on", () => {
  const cfg = loadConfig({
    BASE_URL: "https://www.measureup.com/microsoft.html",
  });
  assert.equal(
    pageUrl(cfg, 1),
    "https://www.measureup.com/microsoft.html?product_list_order=name",
  );
  assert.equal(
    pageUrl(cfg, 3),
    "https://www.measureup.com/microsoft.html?product_list_order=name&p=3",
  );
  const siteDefault = loadConfig({
    BASE_URL: "https://www.measureup.com/microsoft.html",
    LISTING_SORT: "",
  });
  assert.equal(
    pageUrl(siteDefault, 1),
    "https://www.measureup.com/microsoft.html",
  );
  assert.equal(
    pageUrl(siteDefault, 2),
    "https://www.measureup.com/microsoft.html?p=2",
  );
});

test("retries wait as long as the server says, up to a cap, and otherwise back off exponentially", () => {
  const base = { baseMs: 5000, maxMs: 60000 };
  assert.equal(retryDelayMs({ attempt: 1, ...base }), 5000);
  assert.equal(retryDelayMs({ attempt: 2, ...base }), 10000);
  // The wait doubles with every try (it used to grow in steps of the base: 15000).
  assert.equal(retryDelayMs({ attempt: 3, ...base }), 20000);
  assert.equal(retryDelayMs({ attempt: 5, ...base }), 60000, "capped");
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "7", ...base }), 7000);
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "9999", ...base }),
    60000,
  );
  // Retry-After may also be a date (measured against an injected clock).
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Tue, 13 Oct 2026 00:00:30 GMT",
      now: Date.parse("2026-10-13T00:00:00Z"),
      ...base,
    }),
    30000,
  );
});

// ---------------------------------------------------------------------------
// The comparison: by set, never by count
// ---------------------------------------------------------------------------
const listed = (products, { complete = true } = {}) => ({
  listed: new Map(
    products.map((p) => [
      p.id,
      { ...stored(p, SITE), retired: p.retired, url: `${SITE}${p.path}` },
    ]),
  ),
  complete,
});
const baselineOf = (products) => products.map((p) => stored(p, SITE));

test("the same number of products with another set is a change", () => {
  const before = range(1, 120);
  const after = [...range(1, 119), product(900)];
  const diff = diffProducts(baselineOf(before), listed(after));
  assert.deepEqual(
    diff.added.map((p) => p.id),
    ["900"],
  );
  assert.deepEqual(
    diff.removed.map((p) => p.id),
    ["120"],
  );
  assert.equal(diff.next.length, 120);
});

test("fewer active products than before still reports the new ones", () => {
  // The incident: 145 in the baseline, 162 listed of which 52 retired, 110 active.
  const before = range(1, 145);
  const live = [
    ...range(1, 101),
    ...range(102, 112, { retired: true }),
    ...range(300, 340, { retired: true }),
    ...range(500, 508),
  ];
  assert.equal(live.length, 162);
  const diff = diffProducts(baselineOf(before), listed(live));
  assert.equal(diff.active.length, 110);
  assert.equal(diff.added.length, 9);
  assert.equal(diff.removed.length, 44);
  assert.equal(diff.removed.filter((p) => p.reason === "retired").length, 11);
  assert.equal(diff.removed.filter((p) => p.reason === "unlisted").length, 33);
  assert.equal(
    diff.next.length,
    110,
    "the refreshed baseline is the active set",
  );
});

test("a scan that is not complete reports what is new but removes nothing", () => {
  const before = range(1, 20);
  const live = [...range(1, 15), product(77)];
  const diff = diffProducts(
    baselineOf(before),
    listed(live, { complete: false }),
  );
  assert.deepEqual(
    diff.added.map((p) => p.id),
    ["77"],
  );
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.carried.length, 5);
  assert.equal(diff.next.length, 21, "carried products stay in the baseline");
  // A product the scan shows as retired is removed even then.
  const retiring = diffProducts(
    baselineOf(before),
    listed([...range(1, 14), product(15, { retired: true })], {
      complete: false,
    }),
  );
  assert.deepEqual(
    retiring.removed.map((p) => [p.id, p.reason]),
    [["15", "retired"]],
  );
});

test("bundles are neither new nor removed: they are not tracked", () => {
  const bundle = product(50, { kind: "bundle", code: "AZ-104" });
  const olderBundle = {
    ...stored(product(51, { kind: "bundle" }), SITE),
    type: "unknown",
  };
  const diff = diffProducts(
    [...baselineOf(range(1, 3)), olderBundle],
    listed([...range(1, 3), bundle]),
  );
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.next.length, 3);
  const counts = countListing(
    listed([...range(1, 3), bundle, product(9, { retired: true })]),
    diff,
  );
  assert.deepEqual(counts, { listed: 5, tracked: 3, retired: 1, bundles: 1 });
});

test("a rename or a new URL refreshes the baseline without being reported", () => {
  const before = baselineOf(range(1, 3));
  const renamed = product(2);
  renamed.name = "Assessment AZ-2: Exam with a new title";
  renamed.path = "/mu-2-new.html";
  const diff = diffProducts(before, listed([product(1), renamed, product(3)]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  const next = diff.next.find((p) => p.id === "2");
  assert.equal(next.name, "Assessment AZ-2: Exam with a new title");
  assert.equal(next.url, `${SITE}/mu-2-new.html`);
});

// ---------------------------------------------------------------------------
// The hub's own links
// ---------------------------------------------------------------------------
test("hub links come from the exam pages, without comments, fragments and the listing page", async () => {
  const dir = await tempDir();
  await writeDocs(dir, {
    "azure/AZ-104.mdx": [
      link("/mu-1-assessment.html"),
      `{/* ${link("/commented-out.html")} */}`,
      `<!-- ${link("/html-commented.html")} -->`,
      link("/mu-1-assessment.html", "Again"),
      `[All tests](${SITE}/microsoft.html#u44)`,
      `<LinkCard title="MeasureUp Subscriptions" href="${SITE}/subscription-plans-for-individuals#u44"/>`,
      `[Other site](https://example.com/mu-9.html)`,
    ].join("\n"),
    "security/SC-900.mdx": link("/mu-1-assessment.html"),
    "guide/notes.md": `See ${SITE}/mu-7-certkit.html.`,
  });
  const links = scanHubLinks(dir);
  assert.deepEqual([...links.keys()].sort(), [
    "/mu-1-assessment.html",
    "/mu-7-certkit.html",
    "/subscription-plans-for-individuals",
  ]);
  const first = links.get("/mu-1-assessment.html");
  assert.deepEqual(
    first.locations.map((l) => `${l.file}:${l.line}`),
    [
      "src/content/docs/azure/AZ-104.mdx:1",
      "src/content/docs/azure/AZ-104.mdx:4",
      "src/content/docs/security/SC-900.mdx:1",
    ],
  );
  assert.equal(
    stripComments("a{/* x\ny */}b").split("\n").length,
    2,
    "line numbers survive",
  );
  const pages = findExamPages(dir);
  assert.equal(pages.get("AZ-104"), "src/content/docs/azure/AZ-104.mdx");
  assert.equal(pages.has("notes"), false);
});

test("a link is reported once, and kept while a probe fails", () => {
  const result = (path, problem) => ({
    link: { path, locations: [] },
    problem,
    detail: problem,
  });
  const first = diffHubState(
    undefined,
    [
      result("/a.html", "not-found"),
      result("/b.html", "retired"),
      result("/c.html", "open"),
    ],
    "2026-10-13",
  );
  assert.deepEqual(
    first.fresh.map((r) => r.link.path),
    ["/a.html", "/b.html"],
  );
  assert.deepEqual(first.next, {
    "/a.html": { problem: "not-found", since: "2026-10-13" },
    "/b.html": { problem: "retired", since: "2026-10-13" },
  });
  // Next week: the same findings are known, a probe failed for one of them.
  const second = diffHubState(
    first.next,
    [result("/a.html", "unverified"), result("/b.html", "retired")],
    "2026-10-20",
  );
  assert.deepEqual(second.fresh, []);
  assert.equal(second.known, 2);
  assert.deepEqual(
    second.next,
    first.next,
    "since is kept, the failed probe is no evidence",
  );
  // /b.html changed its problem: reported again; /a.html is fixed: gone.
  const third = diffHubState(
    second.next,
    [result("/a.html", "open"), result("/b.html", "not-found")],
    "2026-10-27",
  );
  assert.deepEqual(
    third.fresh.map((r) => r.link.path),
    ["/b.html"],
  );
  assert.deepEqual(third.next, {
    "/b.html": { problem: "not-found", since: "2026-10-27" },
  });
});

test("a replacement is suggested by exam code and kind only, from active products", () => {
  const scan = listed([
    product(1, { kind: "practice-test", code: "DP-300" }),
    product(2, { kind: "assessment", code: "DP-300" }),
    product(3, { kind: "practice-test", code: "DP-300", retired: true }),
    product(4, { kind: "practice-test", code: "DP-900" }),
  ]);
  const hits = suggestReplacements(
    "/microsoft-practice-test-dp-300-azure-database-administrator.html",
    scan,
  );
  assert.deepEqual(
    hits.map((p) => p.id),
    ["1"],
  );
  assert.deepEqual(
    suggestReplacements("/subscription-plans-for-individuals", scan),
    [],
  );
  assert.deepEqual(suggestReplacements("/certkit-dp-300-x.html", scan), []);
});

// ---------------------------------------------------------------------------
// Text that goes into a public issue
// ---------------------------------------------------------------------------
test("URLs and names from the web cannot break the tables of the report", () => {
  const odd = {
    id: "1",
    name: "Assessment AZ-1: A | B `c` @octocat",
    examCode: "AZ-1",
    type: "assessment",
    url: "https://www.measureup.com/a|b`c(d).html",
    retired: false,
  };
  const scan = { listed: new Map([["1", odd]]), complete: true };
  const report = buildReport({
    cfg: { today: "2026-10-13" },
    scan,
    diff: { active: [odd], added: [odd], removed: [] },
    hubFresh: [
      {
        link: { path: "/x.html", locations: [{ file: "src/a.mdx", line: 1 }] },
        problem: "redirected",
        detail: "redirects to /a%7Cb.html, which is not a listed product",
        target: "https://www.measureup.com/a|b`c.html",
        targetProduct: odd,
      },
    ],
    hubKnown: 0,
    hubLinks: new Map(),
    examPages: new Map(),
  });
  const rows = report.split("\n").filter((line) => line.startsWith("| "));
  // a header and one row for each of the two tables (separators start with "|-")
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const cells = row.replace(/`[^`]*`/g, "``").split("|").length - 2;
    assert.ok(cells === 6 || cells === 4, `${cells} cells in: ${row}`);
  }
  assert.ok(
    report.includes("https://www.measureup.com/a%7Cb%60c%28d%29.html#u44"),
  );
  assert.ok(!report.includes("@octocat"));
});

test("names from the web cannot ping users, link issues or break a table", () => {
  const text = safeText("Practice <b>Test</b> @octocat #123 | `x` [y](z)");
  assert.ok(!/[<>`|[\]]/.test(text), text);
  assert.ok(!/@octocat/.test(text) && !/#123/.test(text));
  assert.equal(
    buildIssueTitle({
      added: [
        { examCode: "AZ-104" },
        { examCode: "AZ-104" },
        { examCode: "DP-700" },
        { examCode: "" },
      ],
      fresh: [{}, {}],
    }),
    "MeasureUp: 4 new products (AZ-104, DP-700); 2 stale exam page links",
  );
  assert.equal(
    buildIssueTitle({ added: [], fresh: [{}] }),
    "MeasureUp: 1 stale exam page link",
  );
  assert.equal(
    buildIssueTitle({
      added: ["AA-1", "BB-2", "CC-3", "DD-4", "EE-5", "FF-6"].map(
        (examCode) => ({ examCode }),
      ),
      fresh: [],
    }),
    "MeasureUp: 6 new products (AA-1, BB-2, CC-3, DD-4, +2 more)",
  );
});

// ---------------------------------------------------------------------------
// The whole script against a fake MeasureUp
// ---------------------------------------------------------------------------
async function withSite(catalog, body, options) {
  const site = await fakeSite(catalog, options);
  const dir = await tempDir();
  try {
    return await body(site, dir);
  } finally {
    await site.close();
  }
}

const unchanged = (run, before) => {
  assert.equal(run.baselineText, before, "the baseline was not touched");
};

test("nine new products are reported although the active count fell from 145 to 110 (the silent period since July)", async () => {
  // The numbers of run 38257853645: 145 in the baseline, 162 listed, 52 of them
  // retired, 110 active, 9 of those new. The old gate compared 145 with 110.
  const before = range(1, 145);
  const live = [
    ...range(1, 101),
    ...range(102, 112, { retired: true }),
    ...range(300, 340, { retired: true }),
    ...range(500, 508),
  ];
  assert.equal(live.length, 162);
  await withSite(live, async (site, dir) => {
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-500.mdx": "Exam page",
      "azure/AZ-501.mdx": "Exam page",
    });
    await writeBaseline(join(dir, "baseline.json"), before, site.origin);
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "true");
    assert.equal(run.output.new_products, "9");
    assert.equal(run.output.baseline_updated, "true");
    assert.equal(run.output.extraction_failed, "false");
    assert.equal(
      run.output.issue_title,
      "MeasureUp: 9 new products (AZ-500, AZ-501, AZ-502, AZ-503, +5 more)",
    );
    assert.match(
      run.stdout,
      /Extracted 162 unique products \(110 tracked, 52 retired, 0 bundles/,
    );
    assert.match(run.report, /### New products \(9\)/);
    for (let id = 500; id <= 508; id++) {
      const p = product(id);
      assert.ok(
        run.report.includes(`${site.origin}${p.path}#u44`),
        `the report links product ${id} by its tile URL`,
      );
    }
    assert.match(run.report, /`src\/content\/docs\/azure\/AZ-500\.mdx`/);
    assert.match(run.report, /no hub page for AZ-502/);
    assert.match(
      run.report,
      /### Products no longer active \(44, informational\)/,
    );
    assert.match(run.report, /### What to do/);
    assert.equal(run.baseline.products.length, 110);
    assert.equal(run.baseline.totalProducts, 110);
    assert.ok(run.baseline.products.some((p) => p.id === "508"));
    assert.ok(!run.baseline.products.some((p) => p.id === "113"));
  });
});

test("the same number of products with another set alerts", async () => {
  const before = range(1, 120);
  const live = [...range(1, 119), product(900)];
  await withSite(live, async (site, dir) => {
    await writeBaseline(join(dir, "baseline.json"), before, site.origin);
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "true");
    assert.equal(run.output.new_products, "1");
    assert.match(
      run.output.issue_title,
      /^MeasureUp: 1 new product \(AZ-900\)$/,
    );
    assert.match(
      run.report,
      /### Products no longer active \(1, informational\)/,
    );
    assert.ok(run.baseline.products.some((p) => p.id === "900"));
    assert.ok(!run.baseline.products.some((p) => p.id === "120"));
  });
});

test("retired products never alert, refresh the baseline once, and a quiet week writes nothing", async () => {
  const before = range(1, 120).map((p, i) => ({
    ...p,
    path: `/old-${i}.html`,
  }));
  // 110 active, 4 now marked retired, 6 no longer listed.
  const live = [...range(1, 110), ...range(111, 114, { retired: true })];
  await withSite(live, async (site, dir) => {
    await writeBaseline(join(dir, "baseline.json"), before, site.origin);
    await writeFile(join(dir, "report.md"), "stale report of an earlier run");
    const first = await runMonitor(site, dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.output.changes_found, "false");
    assert.equal(first.output.new_products, "0");
    assert.equal(first.output.baseline_updated, "true");
    assert.equal(first.report, null, "no report, and the stale one is gone");
    assert.equal(first.baseline.products.length, 110);
    assert.match(first.stdout, /No longer active: .* \(marked retired\)/);
    assert.match(first.stdout, /No longer active: .* \(not listed\)/);
    // The made-up URLs of the old baseline are replaced by the tile URLs.
    assert.ok(
      first.baseline.products.every(
        (p) => p.url === `${site.origin}${product(Number(p.id)).path}`,
      ),
    );

    const second = await runMonitor(site, dir);
    assert.equal(second.output.changes_found, "false");
    assert.equal(second.output.baseline_updated, "false");
    assert.equal(
      second.baselineText,
      first.baselineText,
      "no churn on a quiet week",
    );
  });
});

test("the first run records a silent baseline without bundles and retired products", async () => {
  const live = [
    ...range(1, 120),
    ...range(121, 123, { retired: true }),
    product(130, { kind: "bundle", code: "AZ-104" }),
    product(131, { kind: "bundle", code: "AZ-305" }),
  ];
  await withSite(live, async (site, dir) => {
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-104.mdx": link("/gone.html"),
    });
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "false");
    assert.equal(run.output.baseline_updated, "true");
    assert.equal(run.report, null);
    assert.equal(run.baseline.products.length, 120);
    assert.match(
      run.stdout,
      /Created it with 120 products; no issue is opened/,
    );
    // Even a stale link found on the first run is recorded, not reported.
    assert.deepEqual(Object.keys(run.baseline.staleHubLinks), ["/gone.html"]);
    assert.match(run.stdout, /2 bundles not tracked|2 bundles/);
  });
});

test("a flood of new products is a changed page, not news: nothing is written unless forced", async () => {
  const before = range(1, 120);
  const live = [...range(1, 40), ...range(1000, 1119)];
  await withSite(live, async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      before,
      site.origin,
    );
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 1);
    assert.equal(run.output.extraction_failed, "true");
    assert.equal(run.output.changes_found, "false");
    assert.equal(run.output.baseline_updated, "false");
    assert.match(run.error, /120 new products \(75% of 160 active\)/);
    assert.match(run.error, /force_baseline/);
    assert.equal(run.report, null);
    unchanged(run, text);

    const forced = await runMonitor(site, dir, { FORCE_BASELINE: "1" });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.output.changes_found, "false");
    assert.equal(forced.output.baseline_updated, "true");
    assert.equal(forced.baseline.products.length, 160);
    assert.match(
      forced.stdout,
      /FORCE_BASELINE: 120 new products accepted silently/,
    );
  });
});

test("most of the baseline vanishing at once is a changed page, not news", async () => {
  const before = range(1, 120);
  const live = [...range(1, 50), ...range(51, 120, { retired: true })];
  await withSite(live, async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      before,
      site.origin,
    );
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 1);
    assert.match(
      run.error,
      /70 of 120 baseline products vanished at once \(58%/,
    );
    unchanged(run, text);
  });
});

test("a page whose product count collapses fails loudly and leaves the baseline alone", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      range(1, 130),
      site.origin,
    );
    site.listing = (page, _url, s) => {
      if (page !== 3) return null;
      const sorted = [...s.catalog].sort(byName);
      return listingHtml(sorted.slice(24, 26), {
        from: 25,
        to: 36,
        total: sorted.length,
        origin: s.origin,
      });
    };
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 1);
    assert.equal(run.output.extraction_failed, "true");
    assert.match(
      run.error,
      /page 3 of 11 yielded 2 of the 12 products expected there/,
    );
    assert.match(run.error, /collapsed/);
    unchanged(run, text);
  });
});

test("malformed product data is rejected without changing the baseline", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      range(1, 130),
      site.origin,
    );
    site.listing = () =>
      'toolbar-number">1</span>\n<script>var dl4Objects = [invalid];</script>';
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 1);
    assert.equal(run.output.extraction_failed, "true");
    assert.match(run.error, /malformed/);
    unchanged(run, text);

    site.listing = () => "<html>a page without product data</html>";
    const bare = await runMonitor(site, dir);
    assert.equal(bare.code, 1);
    assert.match(
      bare.error,
      /page 1 with product data \(the page has no product data\)/,
    );
    unchanged(bare, text);
  });
});

test("an unreachable listing and a corrupt baseline are failures, not changes", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      range(1, 130),
      site.origin,
    );
    site.listing = () => ({ status: 503, body: "busy" });
    const down = await runMonitor(site, dir);
    assert.equal(down.code, 1);
    assert.match(
      down.error,
      /Failed to fetch MeasureUp page 1 with product data \(HTTP 503\)/,
    );
    assert.equal(site.listingHits.length, 2, "two attempts, then it gives up");
    unchanged(down, text);

    site.listing = null;
    site.scans = 0;
    await writeFile(join(dir, "baseline.json"), "{ not json");
    const corrupt = await runMonitor(site, dir);
    assert.equal(corrupt.code, 1);
    assert.match(corrupt.error, /Corrupt MeasureUp baseline/);
    assert.equal(corrupt.baselineText, "{ not json");
    assert.equal(site.scans, 0, "nothing was read from the site for it");
  });
});

test("listing pages that repeat each other are read again once, then fail", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      range(1, 130),
      site.origin,
    );
    const first = (s) => {
      const sorted = [...s.catalog].sort(byName);
      return listingHtml(sorted.slice(0, 12), {
        from: 1,
        to: 12,
        total: sorted.length,
        origin: s.origin,
      });
    };
    // Every page after the first shows the first one again.
    site.listing = (page, _url, s) => (page > 1 ? first(s) : null);
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 1);
    assert.match(run.error, /page 2 of 11 shows items 1-12 instead of 13-24/);
    assert.equal(site.scans, 2, "SCAN_ATTEMPTS=2 reads the listing twice");
    unchanged(run, text);

    site.scans = 0;
    const once = await runMonitor(site, dir, { SCAN_ATTEMPTS: "1" });
    assert.equal(once.code, 1);
    assert.equal(site.scans, 1);

    // A listing that is wrong the first time only is read again and accepted.
    site.scans = 0;
    site.listing = (page, _url, s) =>
      s.scans === 1 && page > 1 ? first(s) : null;
    const flaky = await runMonitor(site, dir);
    assert.equal(flaky.code, 0, flaky.stderr);
    assert.equal(site.scans, 2);
    assert.match(flaky.stderr, /listing scan 1 of 2 was incomplete/);
    assert.equal(flaky.output.changes_found, "false");
  });
});

// A listing whose page 5 repeats the last product of page 4 instead of its own
// last one: the scan reads 129 of the 130 products.
const repeatsAProduct = (page, _url, s) => {
  if (page !== 5) return null;
  const sorted = [...s.catalog].sort(byName);
  const shown = sorted.slice(48, 60);
  shown[11] = sorted[47];
  return listingHtml(shown, {
    from: 49,
    to: 60,
    total: sorted.length,
    origin: s.origin,
  });
};

test("a scan that misses a product reports the new ones but removes nothing", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    site.listing = repeatsAProduct;
    const missing = [...range(1, 130)].sort(byName)[59];
    await writeBaseline(join(dir, "baseline.json"), range(1, 130), site.origin);
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /read 129 of 130 announced products/);
    assert.equal(run.output.changes_found, "false");
    assert.equal(run.output.baseline_updated, "false");
    assert.ok(
      run.baseline.products.some((p) => p.id === missing.id),
      "the product the scan did not see stays in the baseline",
    );
    assert.doesNotMatch(run.stdout, /No longer active/);
  });
});

test("on a GitHub runner a warning is an annotation and the job summary is written under the monitor's heading", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    site.listing = repeatsAProduct;
    await writeBaseline(join(dir, "baseline.json"), range(1, 130), site.origin);
    const summary = join(dir, "summary.md");
    const run = await runMonitor(site, dir, {
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(run.code, 0, run.stderr);
    const message =
      "the scan read 129 of 130 announced products (1 duplicates, probably a product added while the pages were read): " +
      "new products are reported, but no product is removed from the baseline this run.";
    assert.ok(run.stderr.includes(`WARNING: ${message}`), run.stderr);
    assert.ok(
      run.stdout
        .split("\n")
        .includes(`::warning title=MeasureUp Monitor::${message}`),
      run.stdout,
    );
    const text = await readFile(summary, "utf8");
    assert.match(
      text,
      /^### MeasureUp Monitor\n\n- Listed 129 products: 129 tracked, 0 retired, 0 bundles \(not tracked\)\.\n/,
    );
    assert.match(text, /\n- Baseline unchanged\.\n\n$/);
    // Off a runner there is no annotation.
    const local = await runMonitor(site, dir, { GITHUB_ACTIONS: "" });
    assert.ok(!local.stdout.includes("::warning"), local.stdout);
  });
});

test("the listing is asked for in a stable order, one page after the other", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    await writeBaseline(join(dir, "baseline.json"), range(1, 130), site.origin);
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      site.listingHits.map((hit) => hit.page),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    assert.ok(site.listingHits.every((hit) => hit.order === "name"));

    site.listingHits.length = 0;
    const plain = await runMonitor(site, dir, { LISTING_SORT: "" });
    assert.equal(plain.code, 0, plain.stderr);
    assert.ok(site.listingHits.every((hit) => hit.order === null));
  });
});

test("the position order of the site, which ties, is what the stable order replaces", async () => {
  // A site that serves the same products twice when asked in its default order:
  // the scan only works because the pages are asked for by name.
  await withSite(range(1, 130), async (site, dir) => {
    site.listing = (page, url, s) => {
      if (url.searchParams.get("product_list_order") === "name") return null;
      const sorted = [...s.catalog].sort(byId);
      const shown = sorted.slice(0, 12);
      return listingHtml(shown, {
        from: (page - 1) * 12 + 1,
        to: page * 12,
        total: sorted.length,
        origin: s.origin,
      });
    };
    await writeBaseline(join(dir, "baseline.json"), range(1, 130), site.origin);
    const named = await runMonitor(site, dir);
    assert.equal(named.code, 0, named.stderr);
    assert.equal(named.output.changes_found, "false");
    const position = await runMonitor(site, dir, {
      LISTING_SORT: "",
      SCAN_ATTEMPTS: "1",
    });
    assert.equal(position.code, 1);
  });
});

// ---------------------------------------------------------------------------
// The hub's own links, end to end
// ---------------------------------------------------------------------------
function hubSetup(site) {
  const retired = product(200, { retired: true });
  site.catalog.push(retired);
  site.pages.set("/old-slug.html", { status: 302, location: product(7).path });
  site.pages.set("/subscription-plans-for-individuals", { status: 200 });
  return {
    retired,
    docs: {
      "azure/AZ-1.mdx": [
        "Exam page one",
        link("/gone-slug.html"),
        link(product(5).path, "MeasureUp Practice Test"),
        link(retired.path),
        link("/old-slug.html"),
        `{/* ${link("/commented-out.html")} */}`,
      ].join("\n"),
      "azure/AZ-2.mdx": [
        link("/gone-slug.html", "Same dead link again"),
        `<LinkCard title="MeasureUp Subscriptions" href="${SITE}/subscription-plans-for-individuals#u44"/>`,
      ].join("\n"),
    },
  };
}

test("exam page links to products that are gone are reported once, probed once, and forgotten when fixed", async () => {
  await withSite(range(1, 120), async (site, dir) => {
    const { retired, docs } = hubSetup(site);
    await writeDocs(join(dir, "docs"), docs);
    await writeBaseline(join(dir, "baseline.json"), range(1, 120), site.origin);

    const first = await runMonitor(site, dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.output.changes_found, "true");
    assert.equal(first.output.new_products, "0");
    assert.equal(first.output.stale_links, "3");
    assert.equal(
      first.output.issue_title,
      "MeasureUp: 3 stale exam page links",
    );
    assert.match(
      first.report,
      /### Exam page links to review \(3, informational\)/,
    );
    assert.doesNotMatch(first.report, /### New products/);
    // The three problems, with where they are used.
    assert.match(
      first.report,
      /`\/gone-slug\.html` \| page not found \(HTTP 404\) \| `src\/content\/docs\/azure\/AZ-1\.mdx:2`<br>`src\/content\/docs\/azure\/AZ-2\.mdx:1`/,
    );
    assert.match(
      first.report,
      new RegExp(
        `\`${retired.path.replace(".", "\\.")}\` \\| MeasureUp lists this product as retired`,
      ),
    );
    assert.match(
      first.report,
      new RegExp(
        `\`/old-slug\\.html\` \\| redirects to ${product(7).path.replace(".", "\\.")}[^|]*\\| [^|]*\\| Use \`${site.origin}${product(7).path.replace(".", "\\.")}#u44\``,
      ),
    );
    assert.ok(!first.report.includes("commented-out"));
    assert.ok(
      !first.report.includes("/subscription-plans-for-individuals"),
      "an open page is not a finding",
    );
    // One GET per link the listing does not show, none for the listed ones.
    const count = (path) => site.probes().filter((hit) => hit === path).length;
    assert.equal(count("/gone-slug.html"), 1, "used twice, probed once");
    assert.equal(count("/old-slug.html"), 1);
    assert.equal(count("/subscription-plans-for-individuals"), 1);
    assert.equal(count(product(5).path), 0, "a listed product is not probed");
    assert.equal(
      count(retired.path),
      0,
      "a retired product is known from the listing",
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(first.baseline.staleHubLinks).map(([path, state]) => [
          path,
          state.problem,
        ]),
      ),
      {
        "/gone-slug.html": "not-found",
        "/old-slug.html": "redirected",
        [retired.path]: "retired",
      },
    );
    assert.equal(
      first.baseline.staleHubLinks["/gone-slug.html"].since,
      "2026-10-13",
    );

    // Reported once: the next run knows them.
    const second = await runMonitor(site, dir);
    assert.equal(second.output.changes_found, "false");
    assert.equal(second.output.baseline_updated, "false");
    assert.equal(second.baselineText, first.baselineText);

    // A probe that fails is no evidence that the link was fixed.
    site.pages.set("/gone-slug.html", { status: 500 });
    const flaky = await runMonitor(site, dir);
    assert.equal(flaky.output.changes_found, "false");
    assert.equal(flaky.output.baseline_updated, "false");
    assert.match(
      flaky.stderr,
      /1 hub link not confirmed this run, so left as they were: \/gone-slug\.html \(could not be checked \(HTTP 500\)\)/,
    );
    site.pages.delete("/gone-slug.html");

    // Fixed on the exam page: the finding drops out of the baseline, quietly.
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-1.mdx": docs["azure/AZ-1.mdx"].replace(
        link("/gone-slug.html"),
        link(product(6).path),
      ),
      "azure/AZ-2.mdx": docs["azure/AZ-2.mdx"].replace(
        link("/gone-slug.html", "Same dead link again"),
        "",
      ),
    });
    const fixed = await runMonitor(site, dir);
    assert.equal(fixed.output.changes_found, "false");
    assert.equal(fixed.output.baseline_updated, "true");
    assert.deepEqual(
      Object.keys(fixed.baseline.staleHubLinks).sort(),
      ["/old-slug.html", retired.path].sort(),
    );

    // Everything fixed: the key leaves the file.
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-1.mdx": link(product(5).path),
      "azure/AZ-2.mdx": "Exam page two",
    });
    const clean = await runMonitor(site, dir);
    assert.equal(clean.output.changes_found, "false");
    assert.equal(clean.output.baseline_updated, "true");
    assert.equal(clean.baseline.staleHubLinks, undefined);
  });
});

test("new products and stale links share one issue, each in its own section", async () => {
  await withSite([...range(1, 119), product(900)], async (site, dir) => {
    const { docs } = hubSetup(site);
    await writeDocs(join(dir, "docs"), docs);
    await writeBaseline(join(dir, "baseline.json"), range(1, 119), site.origin);
    const run = await runMonitor(site, dir);
    assert.equal(run.output.changes_found, "true");
    assert.equal(run.output.new_products, "1");
    assert.equal(run.output.stale_links, "3");
    assert.equal(
      run.output.issue_title,
      "MeasureUp: 1 new product (AZ-900); 3 stale exam page links",
    );
    assert.ok(
      run.report.indexOf("### New products (1)") <
        run.report.indexOf("### Exam page links to review (3"),
    );
    assert.match(run.report, /2\. For each stale link/);
  });
});

test("the number of hub probes is capped, and the check can be switched off", async () => {
  await withSite(range(1, 120), async (site, dir) => {
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-1.mdx": [
        link("/dead-1.html"),
        link("/dead-2.html"),
        link("/dead-3.html"),
      ].join("\n"),
    });
    await writeBaseline(join(dir, "baseline.json"), range(1, 120), site.origin);
    const capped = await runMonitor(site, dir, { MAX_HUB_PROBES: "1" });
    assert.equal(capped.code, 0, capped.stderr);
    assert.equal(site.probes().length, 1, "one probe, the rest is not checked");
    assert.equal(capped.output.stale_links, "1");
    assert.deepEqual(Object.keys(capped.baseline.staleHubLinks), [
      "/dead-1.html",
    ]);
    assert.match(
      capped.stderr,
      /2 hub links not confirmed this run, so left as they were: \/dead-2\.html \(not checked \(more than 1 links/,
    );

    site.hits.length = 0;
    const off = await runMonitor(site, dir, { HUB_LINK_CHECK: "0" });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(site.probes().length, 0);
    assert.equal(off.output.stale_links, "0");
    assert.deepEqual(
      Object.keys(off.baseline.staleHubLinks),
      ["/dead-1.html"],
      "what is known stays known while the check is off",
    );
  });
});

test("tiles that lose their links skip the hub check instead of reporting every link", async () => {
  await withSite(range(1, 130), async (site, dir) => {
    await writeDocs(join(dir, "docs"), {
      "azure/AZ-1.mdx": link("/somewhere.html"),
    });
    const text = await writeBaseline(
      join(dir, "baseline.json"),
      range(1, 130),
      site.origin,
    );
    // The data layer is intact, the product tiles are gone.
    site.listing = (page, _url, s) => {
      const sorted = [...s.catalog].sort(byName);
      const from = (page - 1) * 12 + 1;
      const html = listingHtml(sorted.slice(from - 1, from + 11), {
        from,
        to: Math.min(from + 11, sorted.length),
        total: sorted.length,
        origin: s.origin,
      });
      return html.replace(/<ol class="products[\s\S]*?<\/ol>/, "");
    };
    const run = await runMonitor(site, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      /only 0% of the listed products have a product URL/,
    );
    assert.equal(site.probes().length, 0);
    assert.equal(run.output.changes_found, "false");
    unchanged(run, text);
  });
});

// ---------------------------------------------------------------------------
// The workflow: its step order and manual input are part of the contract
// ---------------------------------------------------------------------------
// A checkout with core.autocrlf (this repo's maintainer works on Windows) turns
// the line ends of the workflow into CRLF; the patterns below are written for LF.
const workflowSource = readFileSync(
  join(root, ".github", "workflows", "measureup-monitor.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The job's steps with comments removed: { name, condition, text }. */
function workflowSteps() {
  const text = workflowSource
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const marker = "\n    steps:\n";
  const at = text.indexOf(marker);
  assert.ok(at >= 0, "the job has no steps");
  return text
    .slice(at + marker.length)
    .split(/\n(?=      - )/)
    .map((step) => ({
      text: step,
      name: step.match(/^\s*(?:- )?name: (.+)$/m)?.[1] ?? "",
      condition: step.match(/^\s+if: (.+)$/m)?.[1] ?? "",
    }));
}

function workflowStep(name) {
  const step = workflowSteps().find((candidate) => candidate.name === name);
  assert.ok(step, `no workflow step named "${name}"`);
  return step;
}

const STEP_CHECK = "Check MeasureUp for product changes";
const STEP_ISSUE =
  "Create issue if MeasureUp products or exam page links changed";
const STEP_COMMIT = "Commit updated MeasureUp baseline";
const STEP_FAILED = "Create issue if the check failed";
const STEP_CLOSE_FAILED = "Close the failure issue once the check runs again";

test("the workflow opens the issue before it commits the baseline, so a failed issue is retried", () => {
  const names = workflowSteps().map((step) => step.name);
  const at = [
    STEP_CHECK,
    STEP_ISSUE,
    STEP_COMMIT,
    STEP_FAILED,
    STEP_CLOSE_FAILED,
  ].map((name) => names.indexOf(name));
  assert.ok(
    at[0] >= 0 && at.every((index, i) => i === 0 || index > at[i - 1]),
    `unexpected step order: ${at}`,
  );
  assert.equal(
    workflowStep(STEP_ISSUE).condition,
    "steps.check.outputs.changes_found == 'true'",
  );
  // No status-check function: the condition keeps the implicit success(), so the
  // commit is skipped when the issue step fails and the product is still new on
  // the next run.
  assert.equal(
    workflowStep(STEP_COMMIT).condition,
    "steps.check.outputs.baseline_updated == 'true'",
  );
  assert.equal(
    workflowStep(STEP_FAILED).condition,
    "failure() && steps.check.outputs.extraction_failed == 'true'",
  );
});

test("the issues are labelled, titled and read the files the script writes; the failure issue is one issue with a stable title", () => {
  const label = (name) => workflowStep(name).text.match(/labels: (\S+)/)?.[1];
  const file = (name) =>
    workflowStep(name).text.match(/content-filepath: (\S+)/)?.[1];
  assert.equal(label(STEP_ISSUE), "enhancement");
  assert.match(
    workflowStep(STEP_ISSUE).text,
    /title: "\$\{\{ steps\.check\.outputs\.issue_title \}\}"/,
  );
  assert.match(
    workflowSource,
    /^ {6}REPORT_FILE: \/tmp\/measureup-report\.md$/m,
  );
  assert.match(workflowSource, /^ {6}ERROR_FILE: \/tmp\/measureup-error\.md$/m);
  assert.equal(file(STEP_ISSUE), "/tmp/measureup-report.md");
  // A persistent block must not open a new bug issue every Monday: the failure
  // issue has a stable title (a comment for every further failed run, closed by
  // a healthy run), not one per run id.
  const failed = workflowStep(STEP_FAILED).text;
  assert.match(
    failed,
    /node scripts\/failure-issue\.mjs raise --title "MeasureUp Monitor Failed" --label bug --file \/tmp\/measureup-error\.md/,
  );
  assert.match(failed, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(failed, /create-issue-from-file/);
  assert.doesNotMatch(workflowSource, /github\.run_id/);
  const close = workflowStep(STEP_CLOSE_FAILED);
  assert.equal(
    close.condition,
    "steps.check.outputs.extraction_failed == 'false'",
    "the closing step keeps the implicit success(): it never runs after a failed step",
  );
  assert.match(
    close.text,
    /node scripts\/failure-issue\.mjs clear --title "MeasureUp Monitor Failed" --label bug --comment "[^"]+"/,
  );
  assert.match(close.text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  // The job may commit the baseline and open issues, and nothing else.
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(workflowSource, /^ {4}timeout-minutes: 30$/m);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /run: node scripts\/measureup-check\.mjs/,
  );
});

test("a run is not cancelled between the issue and the baseline commit", () => {
  assert.match(
    workflowSource,
    /^concurrency:\n {2}group: measureup-monitor\n {2}cancel-in-progress: false$/m,
  );
});

test("a manual run can force a re-baseline with the input the failsafe message names", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/m);
  assert.match(dispatch, /type: boolean/);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  assert.match(workflowSource, /^ {4}- cron: "0 6 \* \* 1"/m);
});

// The commit step is plain bash: run it for real against a scratch remote
// (tests/scripts/helpers/git-remote.mjs; the step of every pushing workflow is
// also run by workflow-commit-steps.test.mjs).
const bash = findBash();

function commitScript() {
  const body = workflowStep(STEP_COMMIT).text.split(/^\s+run: \|\n/m)[1];
  assert.ok(body, "the commit step has no run script");
  const indent = body.match(/^ +/)[0].length;
  return body
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

test(
  "the commit step pushes only the baseline, rebases onto a concurrent push and skips an unchanged baseline",
  { skip: bashSkipReason(bash) },
  async (t) => {
    const baseline = "src/data_files/measureup-products.json";
    const remote = await makeScratchRemote({
      prefix: "measureup-workflow-",
      files: { [baseline]: '{"products":[]}\n' },
    });
    t.after(() => remote.cleanup());
    const script = commitScript();
    assert.match(
      script,
      /git add src\/data_files\/measureup-products\.json$/m,
      "only the baseline is staged",
    );
    const runStep = () =>
      runBash(bash, script, { cwd: remote.work, env: remote.env });

    // Nothing changed: the step succeeds without a commit.
    const quiet = await runStep();
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.deepEqual(await remote.subjects(), ["init"]);

    // Someone pushed to main after the checkout: the step rebases onto it, and
    // a stray file next to the baseline is not committed.
    await remote.concurrentPush();
    await remote.write(remote.work, baseline, '{"products":[1]}\n');
    await remote.write(remote.work, "stray.txt", "x\n");
    const pushed = await runStep();
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.deepEqual(await remote.subjects(), [
      "Update MeasureUp product baseline",
      "elsewhere",
      "init",
    ]);
    assert.equal(await remote.show(baseline), '{"products":[1]}');
    assert.deepEqual(await remote.changedFiles(), [baseline]);
    assert.ok(!(await remote.files()).includes("stray.txt"));
  },
);
