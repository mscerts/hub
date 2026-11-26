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
  addGoneLinks,
  canonicalUrl,
  checkAvailability,
  checkReport,
  collectYoutubeLinks,
  goneReason,
  oembedVerdict,
  youtubeTarget,
} from "../../scripts/youtube-availability.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repoRoot, "scripts", "youtube-availability.mjs");

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "youtube-availability-"));
  temps.push(d);
  return d;
};

const VIDEO = "https://www.youtube.com/watch?v=W805zXcn2sg";
const GONE_VIDEO = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const PLAYLIST = "https://www.youtube.com/playlist?list=PLX_83qt6TA00";
const GONE_PLAYLIST =
  "https://www.youtube.com/playlist?list=PL-0x45utTwSoWlA6dHxgKVAIl0xSn1d-C";
const ok = (url) => ({ url, status: { text: "OK", code: 200 } });

/** A lychee report in the shape lychee v0.24.2 writes it at verbose level. */
function report({ success = {}, errors = {} } = {}) {
  const count = (map) =>
    Object.values(map).reduce((n, list) => n + list.length, 0);
  return {
    total: count(success) + count(errors),
    successful: count(success),
    errors: count(errors),
    timeouts: 0,
    unknown: 0,
    excludes: 0,
    redirects: 0,
    error_map: errors,
    timeout_map: {},
    success_map: success,
  };
}

test("youtubeTarget: videos and playlists under every form of address, nothing else", () => {
  assert.deepEqual(youtubeTarget(VIDEO), { kind: "video", id: "W805zXcn2sg" });
  assert.deepEqual(youtubeTarget("https://youtu.be/W805zXcn2sg?t=10"), {
    kind: "video",
    id: "W805zXcn2sg",
  });
  assert.deepEqual(youtubeTarget("https://m.youtube.com/watch?v=W805zXcn2sg"), {
    kind: "video",
    id: "W805zXcn2sg",
  });
  assert.deepEqual(
    youtubeTarget("https://www.youtube.com/live/dLFlXzJJVoU?si=x"),
    { kind: "video", id: "dLFlXzJJVoU" },
  );
  assert.deepEqual(youtubeTarget("https://www.youtube.com/embed/W805zXcn2sg"), {
    kind: "video",
    id: "W805zXcn2sg",
  });
  assert.deepEqual(youtubeTarget(PLAYLIST), {
    kind: "playlist",
    id: "PLX_83qt6TA00",
  });
  // a watch address with a list is a video; the playlist is not asked about
  assert.deepEqual(
    youtubeTarget(
      "https://www.youtube.com/watch?v=W805zXcn2sg&list=PLX_83qt6TA00",
    ),
    { kind: "video", id: "W805zXcn2sg" },
  );
  for (const not of [
    "https://www.youtube.com/@MicrosoftLearn",
    "https://www.youtube.com/@IntuneTraining/playlists",
    "https://www.youtube.com/channel/UCabc",
    "https://www.youtube.com/favicon.ico",
    "https://youtu.be/favicon.ico",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/playlist",
    "https://www.youtube.com/results?search_query=az-104",
    "https://example.com/watch?v=W805zXcn2sg",
    "https://notyoutube.com/watch?v=W805zXcn2sg",
    "mailto:someone@youtube.com",
    "not a url",
  ])
    assert.equal(youtubeTarget(not), null, not);
});

test("canonicalUrl: the same video or playlist is asked about once, whatever the address", () => {
  assert.equal(
    canonicalUrl(youtubeTarget("https://youtu.be/W805zXcn2sg?t=3")),
    VIDEO,
  );
  assert.equal(canonicalUrl(youtubeTarget(PLAYLIST)), PLAYLIST);
});

test("oembedVerdict: 200 is fine, 404 and 400 are gone, everything else says nothing", () => {
  assert.equal(oembedVerdict(200), "ok");
  assert.equal(oembedVerdict(404), "gone");
  // an id that was never valid answers 400 (a well-formed id that does not exist)
  assert.equal(oembedVerdict(400), "gone");
  // 401 is a private video or one with embedding off: a playlist that plays fine answers it too
  for (const status of [401, 403, 429, 500, 502, 503, 301, 204])
    assert.equal(oembedVerdict(status), "unknown", String(status));
});

test("collectYoutubeLinks: the YouTube links of the successful answers, with their pages, not the ones lychee already found dead", () => {
  const links = collectYoutubeLinks(
    report({
      success: {
        "dist/a/index.html": [
          ok(VIDEO),
          ok(PLAYLIST),
          ok("https://www.youtube.com/@MicrosoftLearn"),
          ok("https://github.com/microsoft/vscode"),
        ],
        "dist/b/index.html": [ok(VIDEO), ok("https://youtu.be/W805zXcn2sg")],
      },
      errors: {
        "dist/a/index.html": [
          { url: GONE_VIDEO, status: { text: "Not Found", code: 404 } },
        ],
      },
    }),
  );
  assert.deepEqual(
    [...links.keys()].sort(),
    ["https://youtu.be/W805zXcn2sg", PLAYLIST, VIDEO].sort(),
  );
  assert.deepEqual(
    [...links.get(VIDEO).pages],
    ["dist/a/index.html", "dist/b/index.html"],
  );
  assert.equal(collectYoutubeLinks({}).size, 0, "a report without maps");
  assert.equal(
    collectYoutubeLinks({ success_map: { x: "not a list" } }).size,
    0,
  );
});

/** A fetch that answers by the id inside the `url` parameter. */
function fakeFetch(statusById, calls = []) {
  return async (endpoint) => {
    const asked = new URL(endpoint).searchParams.get("url");
    calls.push(asked);
    const id =
      new URL(asked).searchParams.get("v") ??
      new URL(asked).searchParams.get("list");
    const status = statusById[id];
    if (status === "throw") throw new Error("network down");
    return { status: status ?? 200, body: null };
  };
}

test("checkAvailability: one request per distinct video or playlist, a verdict for each, errors are unknown", async () => {
  const links = collectYoutubeLinks(
    report({
      success: {
        "dist/a/index.html": [
          ok(VIDEO),
          ok("https://youtu.be/W805zXcn2sg"),
          ok(GONE_VIDEO),
          ok(PLAYLIST),
          ok(GONE_PLAYLIST),
          ok("https://www.youtube.com/watch?v=privateVid1"),
          ok("https://www.youtube.com/watch?v=timedOut001"),
        ],
      },
    }),
  );
  const calls = [];
  const answers = await checkAvailability(links, {
    intervalMs: 0,
    fetchImpl: fakeFetch(
      {
        aaaaaaaaaaa: 400,
        "PL-0x45utTwSoWlA6dHxgKVAIl0xSn1d-C": 404,
        privateVid1: 401,
        timedOut001: "throw",
      },
      calls,
    ),
  });
  assert.equal(calls.length, 6, "the video asked twice is asked once");
  assert.ok(calls.every((url) => url.startsWith("https://www.youtube.com/")));
  const verdict = (address) => answers.get(address).verdict;
  assert.equal(verdict(VIDEO), "ok");
  assert.equal(verdict(GONE_VIDEO), "gone");
  assert.equal(verdict(PLAYLIST), "ok");
  assert.equal(verdict(GONE_PLAYLIST), "gone");
  assert.equal(
    verdict("https://www.youtube.com/watch?v=privateVid1"),
    "unknown",
  );
  const timedOut = answers.get("https://www.youtube.com/watch?v=timedOut001");
  assert.equal(timedOut.verdict, "unknown");
  assert.equal(timedOut.status, null);
});

test("checkAvailability: out of time, the links not asked yet stay unanswered", async () => {
  const links = collectYoutubeLinks(
    report({ success: { "dist/a/index.html": [ok(VIDEO), ok(PLAYLIST)] } }),
  );
  const calls = [];
  const answers = await checkAvailability(links, {
    intervalMs: 0,
    deadlineMs: -1,
    fetchImpl: fakeFetch({}, calls),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    [...answers.values()].map((a) => a.verdict),
    ["unknown", "unknown"],
  );
});

test("addGoneLinks: one dead link per page that has it, the counters follow, the reason says what YouTube said", () => {
  const rep = report({
    success: {
      "dist/a/index.html": [ok(GONE_PLAYLIST), ok(VIDEO)],
      "dist/b/index.html": [ok(GONE_PLAYLIST)],
    },
  });
  const links = collectYoutubeLinks(rep);
  const answers = new Map([
    [
      GONE_PLAYLIST,
      { target: youtubeTarget(GONE_PLAYLIST), status: 404, verdict: "gone" },
    ],
    [VIDEO, { target: youtubeTarget(VIDEO), status: 200, verdict: "ok" }],
  ]);
  const result = addGoneLinks(rep, links, answers);
  assert.deepEqual(result, { added: 2, links: [GONE_PLAYLIST] });
  assert.equal(rep.errors, 2);
  assert.equal(rep.successful, 1);
  assert.deepEqual(Object.keys(rep.error_map), [
    "dist/a/index.html",
    "dist/b/index.html",
  ]);
  const entry = rep.error_map["dist/a/index.html"][0];
  assert.equal(entry.url, GONE_PLAYLIST);
  assert.equal(entry.status.code, 404);
  assert.match(entry.status.text, /playlist does not exist or was removed/);
  assert.match(
    goneReason(youtubeTarget(VIDEO), 404),
    /this video does not exist or was removed \(oEmbed answered 404\)/,
  );
  // nothing gone: the report is not touched
  const untouched = report({ success: { "dist/a/index.html": [ok(VIDEO)] } });
  const before = JSON.stringify(untouched);
  assert.deepEqual(
    addGoneLinks(
      untouched,
      collectYoutubeLinks(untouched),
      new Map([[VIDEO, { target: youtubeTarget(VIDEO), verdict: "ok" }]]),
    ),
    { added: 0, links: [] },
  );
  assert.equal(JSON.stringify(untouched), before);
});

test("a link added to the report is judged as a dead link by the link failure check, with the reason", () => {
  const rep = report({
    success: { "dist/a/index.html": [ok(GONE_PLAYLIST), ok(VIDEO)] },
  });
  const links = collectYoutubeLinks(rep);
  addGoneLinks(
    rep,
    links,
    new Map([
      [
        GONE_PLAYLIST,
        { target: youtubeTarget(GONE_PLAYLIST), status: 404, verdict: "gone" },
      ],
    ]),
  );
  const { results } = collectResults(parseLycheeReport(JSON.stringify(rep)));
  assert.deepEqual([...results.keys()], [GONE_PLAYLIST]);
  const result = results.get(GONE_PLAYLIST);
  assert.equal(result.kind, "broken");
  assert.equal(result.code, 404);
  assert.match(result.reason, /YouTube: this playlist does not exist/);
});

test("checkReport: a few missing links are added; a flood of them is not trusted", async () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) =>
      ok(`https://www.youtube.com/watch?v=video${String(i).padStart(6, "0")}`),
    );
  // 2 of 30 gone: added
  const fine = report({ success: { "dist/a/index.html": many(30) } });
  const some = await checkReport(fine, {
    intervalMs: 0,
    fetchImpl: fakeFetch({ video000000: 404, video000001: 404 }),
  });
  assert.equal(some.asked, 30);
  assert.equal(some.gone, 2);
  assert.equal(some.tooMany, false);
  assert.equal(some.added, 2);
  assert.equal(fine.errors, 2);
  // 12 of 30 gone: more than MAX_GONE (10), nothing is added
  const flooded = report({ success: { "dist/a/index.html": many(30) } });
  const statuses = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `video${String(i).padStart(6, "0")}`,
      404,
    ]),
  );
  const flood = await checkReport(flooded, {
    intervalMs: 0,
    fetchImpl: fakeFetch(statuses),
  });
  assert.equal(flood.tooMany, true);
  assert.equal(flood.added, 0);
  assert.equal(flooded.errors, 0);
  // a share over 25% of 20 or more links, below MAX_GONE, is a flood too
  const shared = report({ success: { "dist/a/index.html": many(20) } });
  const share = await checkReport(shared, {
    intervalMs: 0,
    maxGone: 100,
    fetchImpl: fakeFetch(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `video${String(i).padStart(6, "0")}`,
          404,
        ]),
      ),
    ),
  });
  assert.equal(share.tooMany, true);
  // 2 of 5 is a small sample: the share is not judged, the count is
  const small = report({ success: { "dist/a/index.html": many(5) } });
  const few = await checkReport(small, {
    intervalMs: 0,
    fetchImpl: fakeFetch({ video000000: 404, video000001: 404 }),
  });
  assert.equal(few.tooMany, false);
  assert.equal(few.added, 2);
  // no YouTube link at all
  const none = await checkReport(
    report({
      success: { "dist/a/index.html": [ok("https://github.com/x/y")] },
    }),
    { intervalMs: 0, fetchImpl: fakeFetch({}) },
  );
  assert.equal(none.asked, 0);
});

// --- the command line, against a local stand-in for oEmbed ------------------------------------------------

/** A server that answers oEmbed by id, as YouTube does: 200, 404, 400 or 401. */
async function oembedServer(statusById) {
  const asked = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const target = new URL(url.searchParams.get("url"));
    const id = target.searchParams.get("v") ?? target.searchParams.get("list");
    asked.push(id);
    response.statusCode = statusById[id] ?? 200;
    response.end(statusById[id] ? "" : '{"title":"x"}');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/oembed`,
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

test("the command adds a missing playlist to the report and leaves the rest of it alone", async () => {
  const dir = tempDir();
  const file = join(dir, "external.json");
  const rep = report({
    success: {
      "dist/power/pl-900/index.html": [
        ok(GONE_PLAYLIST),
        ok(VIDEO),
        ok("https://www.youtube.com/watch?v=privateVid1"),
        ok("https://github.com/microsoft/vscode"),
      ],
    },
  });
  writeFileSync(file, JSON.stringify(rep));
  const server = await oembedServer({
    "PL-0x45utTwSoWlA6dHxgKVAIl0xSn1d-C": 404,
    privateVid1: 401,
  });
  try {
    const summary = join(dir, "summary.md");
    const result = await run({
      LYCHEE_JSON: file,
      OEMBED_URL: server.url,
      REQUEST_INTERVAL_MS: "0",
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(written.error_map), [
      "dist/power/pl-900/index.html",
    ]);
    assert.equal(written.error_map["dist/power/pl-900/index.html"].length, 1);
    assert.equal(written.errors, 1);
    // the other links are as lychee left them; 401 added nothing
    assert.deepEqual(written.success_map, rep.success_map);
    assert.equal(server.asked.length, 3, "the GitHub link is not asked about");
    assert.match(result.stdout, /3 videos and playlists: 1 do not exist/);
    assert.match(
      readFileSync(summary, "utf8"),
      /PL-0x45utTwSoWlA6dHxgKVAIl0xSn1d-C/,
    );
  } finally {
    await server.close();
  }
});

test("the command writes nothing in a dry run or when nothing is missing, and does what it can without a report", async () => {
  const dir = tempDir();
  const file = join(dir, "external.json");
  const rep = report({
    success: { "dist/a/index.html": [ok(GONE_PLAYLIST), ok(VIDEO)] },
  });
  const text = JSON.stringify(rep);
  const server = await oembedServer({
    "PL-0x45utTwSoWlA6dHxgKVAIl0xSn1d-C": 404,
  });
  try {
    const base = {
      LYCHEE_JSON: file,
      OEMBED_URL: server.url,
      REQUEST_INTERVAL_MS: "0",
    };
    writeFileSync(file, text);
    const dry = await run({ ...base, DRY_RUN: "1" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /do not exist/);
    assert.equal(readFileSync(file, "utf8"), text, "a dry run writes nothing");
    const off = await run({ ...base, YOUTUBE_CHECK: "0" });
    assert.equal(off.status, 0);
    assert.match(off.stdout, /switched off/);
    assert.equal(readFileSync(file, "utf8"), text);
    // no report, a report that is not JSON: a warning and success, the judging step says what is wrong
    const missing = await run({ ...base, LYCHEE_JSON: join(dir, "none.json") });
    assert.equal(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /No lychee report/);
    writeFileSync(file, "not json");
    const broken = await run(base);
    assert.equal(broken.status, 0);
    assert.match(broken.stdout + broken.stderr, /not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "not json");
    // a report without YouTube links
    writeFileSync(
      file,
      JSON.stringify(
        report({
          success: { "dist/a/index.html": [ok("https://github.com/x/y")] },
        }),
      ),
    );
    const none = await run(base);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No YouTube video or playlist link/);
  } finally {
    await server.close();
  }
});

test("the command never fails the job: a dead endpoint only means nothing is added", async () => {
  const dir = tempDir();
  const file = join(dir, "external.json");
  const text = JSON.stringify(
    report({ success: { "dist/a/index.html": [ok(VIDEO), ok(PLAYLIST)] } }),
  );
  writeFileSync(file, text);
  const result = await run({
    LYCHEE_JSON: file,
    OEMBED_URL: "http://127.0.0.1:9/oembed",
    REQUEST_INTERVAL_MS: "0",
    REQUEST_TIMEOUT_MS: "2000",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 gave no clear answer/);
  assert.equal(readFileSync(file, "utf8"), text);
});

// --- the workflow -----------------------------------------------------------------------------------------

test("the external job asks about YouTube between lychee and the judging, with no token and no way to fail the job", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/link-checker.yml"),
    "utf8",
  );
  const external = workflow.slice(workflow.indexOf("  external:"));
  const lychee = external.indexOf("lycheeverse/lychee-action");
  const step = external.indexOf("node scripts/youtube-availability.mjs");
  const judge = external.indexOf("node scripts/link-failures.mjs");
  assert.ok(lychee > 0 && lychee < step && step < judge);
  const block = external.slice(
    external.lastIndexOf("- name:", step),
    external.indexOf("- name:", step),
  );
  assert.match(block, /timeout-minutes: \d+/);
  assert.match(block, /!cancelled\(\) && steps\.build\.outcome == 'success'/);
  assert.doesNotMatch(block, /GH_TOKEN|GITHUB_TOKEN|github\.token|secrets\./);
  assert.doesNotMatch(block, /continue-on-error/);
});

test("the check is documented where the Link Checker is", () => {
  const runbook = readFileSync(
    join(repoRoot, "docs", "monitors", "link-checker.md"),
    "utf8",
  );
  assert.match(runbook, /scripts\/youtube-availability\.mjs/);
  assert.match(runbook, /oEmbed/);
});
