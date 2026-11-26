import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseLycheeReport,
  collectResults,
} from "../../scripts/link-failures.mjs";
import {
  addGoneCourses,
  checkCourses,
  checkReport,
  collectLevelupLinks,
  courseTitle,
  courseVerdict,
  goneReason,
  levelupCourse,
  textLines,
} from "../../scripts/levelup-availability.mjs";
import {
  addDeadEntries,
  looksLikeAChange,
} from "../../scripts/lib/report-dead-links.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repoRoot, "scripts", "levelup-availability.mjs");

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "levelup-availability-"));
  temps.push(d);
  return d;
};

// The shape of the real pages (checked 2026-11-26): a navigation that ends with "Login", then for a
// course the breadcrumb Home / Courses / title, for a removed course the home page.
const NAV = `<html><head><title>Home – LevelUp</title><style>.x{}</style><script>var a = "Home";</script></head>
<body><nav><a>Home</a><a>Courses</a><a>Solution Area</a><button>Login</button></nav>`;
const COURSE = (title) =>
  `${NAV}<ol><li>Home</li><li>Courses</li><li>${title}</li></ol><h1>${title}</h1></body></html>`;
const HOME = `${NAV}<section><span>LIVE ACCELERATOR</span><h2>Frontier Transformation Accelerator:</h2></section></body></html>`;

const GOOD = "https://skillupwithlevelup.com/course-detail/2426785";
const GONE = "https://skillupwithlevelup.com/course-detail/99999999";
const ok = (url) => ({ url, status: { text: "OK", code: 200 } });
const report = (success) => ({
  total: 0,
  successful: Object.values(success).flat().length,
  errors: 0,
  timeouts: 0,
  unknown: 0,
  excludes: 0,
  redirects: 0,
  error_map: {},
  timeout_map: {},
  success_map: success,
});

test("levelupCourse: only the course pages, whatever the form of the address", () => {
  assert.deepEqual(levelupCourse(GOOD), { id: "2426785" });
  assert.deepEqual(
    levelupCourse("https://www.skillupwithlevelup.com/course-detail/12/"),
    { id: "12" },
  );
  assert.deepEqual(levelupCourse(`${GOOD}?lang=fr#top`), { id: "2426785" });
  for (const not of [
    "https://skillupwithlevelup.com/journeys/13",
    "https://skillupwithlevelup.com/titan",
    "https://skillupwithlevelup.com/course-detail/",
    "https://skillupwithlevelup.com/course-detail/abc",
    "https://skillupwithlevelup.com/course-detail/12/extra",
    "https://example.com/course-detail/12",
    "https://notskillupwithlevelup.com/course-detail/12",
    "not a url",
  ])
    assert.equal(levelupCourse(not), null, not);
});

test("textLines and courseTitle: the breadcrumb after the navigation says whether it is a course", () => {
  assert.deepEqual(textLines("<p>a &amp; b</p><script>x</script> <i>c</i>"), [
    "a & b",
    "c",
  ]);
  assert.equal(courseTitle(COURSE("AB-100: Architect")), "AB-100: Architect");
  assert.equal(
    courseTitle(HOME),
    "",
    "the home page has a navigation, no breadcrumb",
  );
  // "Home" and "Courses" in the navigation itself, before "Login", are not the breadcrumb
  assert.equal(courseTitle(`${NAV}<p>Home</p><p>Courses</p></body>`), "");
  assert.equal(courseTitle("<html><body>Just a moment...</body></html>"), null);
  assert.equal(courseTitle(""), null);
  assert.equal(
    courseTitle(
      `${NAV}<ol><li>Home</li><li>All Courses</li><li>Title</li></ol>`,
    ),
    "Title",
  );
  assert.equal(
    courseTitle(`${NAV}<ol><li>Home</li><li>Courses</li></ol>`),
    "",
    "a breadcrumb without a title is not a course",
  );
});

test("courseVerdict: 404, 410 and the home page are gone; a course is ok; everything else says nothing", () => {
  assert.equal(courseVerdict(404).verdict, "gone");
  assert.equal(courseVerdict(410).verdict, "gone");
  assert.deepEqual(courseVerdict(200, COURSE("AB-100")), {
    verdict: "ok",
    title: "AB-100",
  });
  assert.equal(courseVerdict(200, HOME).verdict, "gone");
  assert.match(courseVerdict(200, HOME).why, /home page/);
  // a page of another layout or a challenge page: nothing can be said
  assert.equal(
    courseVerdict(200, "<html>Checking your browser</html>").verdict,
    "unknown",
  );
  for (const status of [301, 401, 403, 429, 500, 502, 503])
    assert.equal(
      courseVerdict(status, HOME).verdict,
      "unknown",
      String(status),
    );
  assert.match(
    goneReason("HTTP 404"),
    /LevelUp: this course page no longer exists \(HTTP 404\)/,
  );
});

/** A fetch that answers by the course id of the address. */
function fakeFetch(pages, calls = []) {
  return async (address) => {
    calls.push(address);
    const id = new URL(address).pathname.split("/").pop();
    const page = pages[id];
    if (page === "throw") throw new Error("network down");
    const [status, html] = page ?? [200, COURSE(`Course ${id}`)];
    return { status, text: async () => html, body: null };
  };
}

test("checkCourses: one request per course page, the verdict of each, errors are unknown, a deadline ends it", async () => {
  const links = collectLevelupLinks(
    report({
      "dist/a/index.html": [
        ok(GOOD),
        ok(GONE),
        ok("https://skillupwithlevelup.com/course-detail/404404"),
        ok("https://skillupwithlevelup.com/course-detail/500500"),
        ok("https://skillupwithlevelup.com/course-detail/111"),
        ok("https://skillupwithlevelup.com/journeys/13"),
        ok("https://github.com/x/y"),
      ],
      "dist/b/index.html": [ok(GOOD)],
    }),
  );
  assert.equal(links.size, 5, "journeys and other hosts are not course pages");
  assert.deepEqual(
    [...links.get(GOOD).pages],
    ["dist/a/index.html", "dist/b/index.html"],
  );
  const calls = [];
  const answers = await checkCourses(links, {
    intervalMs: 0,
    fetchImpl: fakeFetch(
      {
        99999999: [200, HOME],
        404404: [404, ""],
        500500: [503, ""],
        111: "throw",
      },
      calls,
    ),
  });
  assert.equal(calls.length, 5);
  const verdicts = Object.fromEntries(
    [...answers].map(([url, a]) => [url.split("/").pop(), a.verdict]),
  );
  assert.deepEqual(verdicts, {
    2426785: "ok",
    99999999: "gone",
    404404: "gone",
    500500: "unknown",
    111: "unknown",
  });
  const late = await checkCourses(links, {
    intervalMs: 0,
    deadlineMs: -1,
    fetchImpl: fakeFetch({}),
  });
  assert.ok([...late.values()].every((a) => a.verdict === "unknown"));
});

test("a gone course page becomes a dead link of the report, judged by the link failure check with its reason", async () => {
  const rep = report({ "dist/v/index.html": [ok(GOOD), ok(GONE)] });
  const result = await checkReport(rep, {
    intervalMs: 0,
    fetchImpl: fakeFetch({ 99999999: [200, HOME] }),
  });
  assert.deepEqual(
    { asked: result.asked, gone: result.gone, added: result.added },
    { asked: 2, gone: 1, added: 1 },
  );
  assert.equal(rep.errors, 1);
  assert.equal(rep.successful, 1);
  const { results } = collectResults(parseLycheeReport(JSON.stringify(rep)));
  assert.deepEqual([...results.keys()], [GONE]);
  assert.equal(results.get(GONE).kind, "broken");
  assert.match(
    results.get(GONE).reason,
    /LevelUp: this course page no longer exists/,
  );
});

test("a redesign that drops the breadcrumb everywhere is not read as that many removals", async () => {
  const links = Array.from({ length: 12 }, (_, i) =>
    ok(`https://skillupwithlevelup.com/course-detail/${1000 + i}`),
  );
  const rep = report({ "dist/v/index.html": links });
  const result = await checkReport(rep, {
    intervalMs: 0,
    fetchImpl: async () => ({
      status: 200,
      text: async () => HOME,
      body: null,
    }),
  });
  assert.equal(result.gone, 12);
  assert.equal(result.tooMany, true);
  assert.equal(result.added, 0);
  assert.equal(rep.errors, 0);
  // a handful asked: the count decides, not the share
  const few = report({ "dist/v/index.html": [ok(GOOD), ok(GONE)] });
  assert.equal(
    (
      await checkReport(few, {
        intervalMs: 0,
        fetchImpl: fakeFetch({ 99999999: [200, HOME] }),
      })
    ).tooMany,
    false,
  );
});

test("the shared report helpers: dead entries per page with the counters, and the flood rule", () => {
  const rep = report({
    "dist/a/index.html": [ok(GOOD)],
    "dist/b/index.html": [ok(GOOD)],
  });
  const links = collectLevelupLinks(rep);
  assert.deepEqual(
    addDeadEntries(rep, [
      { url: GOOD, pages: links.get(GOOD).pages, code: 404, text: "gone" },
    ]),
    { added: 2, links: [GOOD] },
  );
  assert.equal(rep.errors, 2);
  assert.equal(addDeadEntries(rep, []).added, 0);
  const rules = { maxGone: 10, maxGoneShare: 0.25 };
  assert.equal(looksLikeAChange({ asked: 5, gone: 2 }, rules), false);
  assert.equal(looksLikeAChange({ asked: 30, gone: 11 }, rules), true);
  assert.equal(looksLikeAChange({ asked: 20, gone: 6 }, rules), true);
  assert.equal(looksLikeAChange({ asked: 40, gone: 10 }, rules), false);
  // a link lychee already found dead is not asked about
  const dead = report({ "dist/a/index.html": [ok(GOOD)] });
  dead.error_map = {
    "dist/a/index.html": [{ url: GOOD, status: { text: "x", code: 404 } }],
  };
  assert.equal(collectLevelupLinks(dead).size, 0);
  assert.equal(addGoneCourses(rep, new Map(), new Map()).added, 0);
});

// --- the command line, against a local stand-in for the site -------------------------------------------

async function levelupServer(pages) {
  const asked = [];
  const server = createServer((request, response) => {
    const id = request.url.split("/").pop();
    asked.push({ id, agent: request.headers["user-agent"] });
    const [status, html] = pages[id] ?? [200, COURSE(`Course ${id}`)];
    response.statusCode = status;
    response.end(html);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    asked,
    close: () => new Promise((done) => server.close(done)),
  };
}

// The server of these tests lives in this process, so the child must run without blocking it.
const run = (env) =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...env },
      cwd: repoRoot,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });

test("the command adds a removed course page to the report, says who asks, and leaves the rest alone", async () => {
  const dir = tempDir();
  const file = join(dir, "external.json");
  const rep = report({
    "dist/vouchers/levelup/index.html": [
      ok(GOOD),
      ok(GONE),
      ok("https://github.com/microsoft/vscode"),
    ],
  });
  writeFileSync(file, JSON.stringify(rep));
  const server = await levelupServer({ 99999999: [200, HOME] });
  try {
    const summary = join(dir, "summary.md");
    const result = await run({
      LYCHEE_JSON: file,
      LEVELUP_BASE_URL: server.url,
      REQUEST_INTERVAL_MS: "0",
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.errors, 1);
    assert.equal(
      written.error_map["dist/vouchers/levelup/index.html"][0].url,
      GONE,
    );
    assert.deepEqual(written.success_map, rep.success_map);
    assert.equal(server.asked.length, 2, "the GitHub link is not asked about");
    assert.match(server.asked[0].agent, /msfthub-link-check/);
    assert.match(result.stdout, /2 LevelUp course pages: 1 no longer exist/);
    assert.match(readFileSync(summary, "utf8"), /course-detail\/99999999/);
  } finally {
    await server.close();
  }
});

test("the command writes nothing in a dry run, switched off, without a report or with nothing to check, and never fails", async () => {
  const dir = tempDir();
  const file = join(dir, "external.json");
  const text = JSON.stringify(
    report({ "dist/a/index.html": [ok(GOOD), ok(GONE)] }),
  );
  const server = await levelupServer({ 99999999: [200, HOME] });
  try {
    const base = {
      LYCHEE_JSON: file,
      LEVELUP_BASE_URL: server.url,
      REQUEST_INTERVAL_MS: "0",
    };
    writeFileSync(file, text);
    const dry = await run({ ...base, DRY_RUN: "1" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /no longer exist/);
    assert.equal(readFileSync(file, "utf8"), text);
    const off = await run({ ...base, LEVELUP_CHECK: "0" });
    assert.match(off.stdout, /switched off/);
    assert.equal(readFileSync(file, "utf8"), text);
    const missing = await run({ ...base, LYCHEE_JSON: join(dir, "none.json") });
    assert.equal(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /No lychee report/);
    writeFileSync(file, "not json");
    const broken = await run(base);
    assert.equal(broken.status, 0);
    assert.match(broken.stdout + broken.stderr, /not valid JSON/);
    writeFileSync(
      file,
      JSON.stringify(
        report({ "dist/a/index.html": [ok("https://github.com/x/y")] }),
      ),
    );
    const none = await run(base);
    assert.match(none.stdout, /No LevelUp course page link/);
    // a site that is down: nothing is added and the job is not failed
    writeFileSync(file, text);
    const down = await run({
      ...base,
      LEVELUP_BASE_URL: "http://127.0.0.1:9",
      REQUEST_TIMEOUT_MS: "2000",
    });
    assert.equal(down.status, 0, down.stderr);
    assert.match(down.stdout, /2 gave no clear answer/);
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    await server.close();
  }
});

// --- the workflow and the docs ---------------------------------------------------------------------------

test("the external job fetches the LevelUp course pages between lychee and the judging, like the YouTube step", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/link-checker.yml"),
    "utf8",
  );
  const external = workflow.slice(workflow.indexOf("  external:"));
  const lychee = external.indexOf("lycheeverse/lychee-action");
  const step = external.indexOf("node scripts/levelup-availability.mjs");
  const judge = external.indexOf("node scripts/link-failures.mjs");
  assert.ok(lychee > 0 && lychee < step && step < judge);
  const block = external.slice(
    external.lastIndexOf("- name:", step),
    external.indexOf("- name:", step),
  );
  assert.match(block, /timeout-minutes: \d+/);
  assert.match(block, /!cancelled\(\) && steps\.build\.outcome == 'success'/);
  assert.doesNotMatch(
    block,
    /GH_TOKEN|GITHUB_TOKEN|github\.token|secrets\.|continue-on-error/,
  );
});

test("the check is documented where the Link Checker is", () => {
  const runbook = readFileSync(
    join(repoRoot, "docs", "monitors", "link-checker.md"),
    "utf8",
  );
  assert.match(runbook, /scripts\/levelup-availability\.mjs/);
  assert.match(runbook, /scripts\/lib\/report-dead-links\.mjs/);
});
