import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  akamsCode,
  cardCovers,
  buildIssueTitle,
  buildReport,
  classifyRedirect,
  codesFromCatalog,
  courseCode,
  diffCourses,
  diffHubState,
  evaluateHubCards,
  fetchPlaylistTitle,
  findExamPages,
  findLinkCards,
  hubKey,
  loadConfig,
  parseLearnPage,
  playlistOfUrl,
  probeCode,
  retryDelayMs,
  safeText,
  scanHubCards,
  shortLink,
  stripComments,
  titleCode,
} from "../../scripts/course-videos-check.mjs";
import {
  placementWorld,
  writeGuidesFile,
  writeLearnsync,
} from "./helpers/example-placement.mjs";
import {
  bashSkipReason,
  findBash,
  makeScratchRemote,
  runBash,
} from "./helpers/git-remote.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/course-videos-check.mjs");
const fixture = (name) =>
  readFileSync(join(root, "tests/fixtures/course-videos", name), "utf8");
const LEARN_PAGE = fixture("learn-page.html");
const CATALOG = JSON.parse(fixture("catalog.json"));

const tempDirs = [];
async function tempDir(prefix = "course-videos-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Playlist ids look like YouTube's (PL + a long tail); the tests only need them
// to be valid and different.
const pl = (name) => `PLtest${String(name).replace(/\W/g, "").padEnd(20, "0")}`;
const youtube = (playlist) =>
  `https://www.youtube.com/playlist?list=${playlist}`;

// ---------------------------------------------------------------------------
// Course codes and the addresses that carry them
// ---------------------------------------------------------------------------
test("courseCode turns a course number into the code of its short link", () => {
  assert.equal(courseCode("AZ-104T00"), "AZ-104");
  assert.equal(courseCode("az-104t00-a"), "AZ-104");
  assert.equal(courseCode("MB-230T01"), "MB-230");
  // A four-digit course has no T00 part.
  assert.equal(courseCode("SC-5006"), "SC-5006");
  assert.equal(courseCode("AI-3016-A"), "AI-3016");
  assert.equal(courseCode("AZ-1003T00"), "AZ-1003");
  // Real catalog entries that are not a course code at all.
  for (const junk of [
    "MSLEAIBootcampFUN",
    "",
    "AZ-104",
    "AZ-10",
    "T00",
    null,
  ]) {
    assert.equal(courseCode(junk), "", String(junk));
  }
});

test("codesFromCatalog reads the courses of the Learn catalog and nothing else", () => {
  const courses = codesFromCatalog(CATALOG);
  assert.deepEqual(
    [...courses.keys()],
    ["AZ-104", "AZ-900", "SC-5006", "SC-401", "AZ-2008", "AB-100", "MB-230"],
  );
  assert.equal(courses.get("AZ-104").title, "Microsoft Azure Administrator");
  assert.equal(courses.get("SC-5006").uid, "course.sc-5006");
  // The first entry of a code wins.
  const twice = codesFromCatalog({
    courses: [
      { course_number: "AZ-104T00", title: "First" },
      { course_number: "AZ-104T01", title: "Second" },
    ],
  });
  assert.equal(twice.get("AZ-104").title, "First");
  assert.throws(() => codesFromCatalog({}), /no courses list/);
  assert.throws(() => codesFromCatalog({ courses: "x" }), /no courses list/);
});

test("akamsCode reads the code of a short link and refuses everything else", () => {
  assert.equal(akamsCode("https://aka.ms/AZ-104onYouTube"), "AZ-104");
  assert.equal(akamsCode("http://aka.ms/az-104onyoutube/"), "AZ-104");
  assert.equal(akamsCode(" https://aka.ms/AI-3016onYouTube?x=1 "), "AI-3016");
  for (const other of [
    "https://aka.ms/AZ-104",
    "https://aka.ms/azure-free",
    "https://example.com/AZ-104onYouTube",
    "https://aka.ms/AZ-104onYouTubeMore",
    "",
    undefined,
  ]) {
    assert.equal(akamsCode(other), "", String(other));
  }
  assert.equal(shortLink("SC-401"), "https://aka.ms/SC-401onYouTube");
});

test("playlistOfUrl finds the playlist of a YouTube address", () => {
  const id = "PLahhVEj9XNTcj4dwEwRHozO3xcxI_UHYG";
  assert.equal(playlistOfUrl(youtube(id)), id);
  assert.equal(
    playlistOfUrl(`https://youtube.com/playlist?list=${id}&feature=shared`),
    id,
  );
  assert.equal(playlistOfUrl(`https://youtu.be/abc123?list=${id}`), id);
  // YouTube's shorter, newer ids are valid too.
  assert.equal(playlistOfUrl(youtube("PLWkuMDqdJEw4")), "PLWkuMDqdJEw4");
  for (const other of [
    "https://www.youtube.com/watch?v=u7BRLaPh8_s",
    "https://www.youtube.com/playlist?list=short",
    "https://example.com/playlist?list=PLahhVEj9XNTcj4dwEwRHozO3xcxI",
    "not a url",
    "",
  ]) {
    assert.equal(playlistOfUrl(other), "", other);
  }
});

test("parseLearnPage reads the short links of the real course videos page, cards and plain links alike", () => {
  const codes = parseLearnPage(LEARN_PAGE);
  assert.deepEqual([...codes.keys()], ["AZ-900", "SC-900", "MS-4007"]);
  assert.equal(codes.get("AZ-900"), "Azure Fundamentals");
  assert.equal(
    codes.get("MS-4007"),
    "Microsoft 365 User enablement specialist (MS-4007)",
  );
  assert.equal(parseLearnPage("<p>nothing here</p>").size, 0);
  // A link to a playlist (not a short link) is not a course video of the page.
  assert.equal(
    parseLearnPage(`<a href="${youtube(pl("a"))}">AZ-104</a>`).size,
    0,
  );
});

test("titleCode only reads the titles of the Microsoft Learn course cards", () => {
  assert.equal(
    titleCode("Microsoft Learn AZ-2008 Course on YouTube"),
    "AZ-2008",
  );
  assert.equal(
    titleCode("AZ-400: Microsoft Learn AZ-2008 Course on YouTube"),
    "AZ-2008",
  );
  assert.equal(
    titleCode("AZ-500: Microsoft Learn Course on YouTube"),
    "AZ-500",
  );
  assert.equal(titleCode("AZ-900: John Savill's Study Cram on YouTube"), "");
  assert.equal(titleCode("Microsoft Learn Practice Assessment"), "");
});

// ---------------------------------------------------------------------------
// What aka.ms says
// ---------------------------------------------------------------------------
test("classifyRedirect tells a playlist from a missing course from a failed request", () => {
  const base = "https://aka.ms/AZ-104onYouTube";
  const id = pl("a");
  assert.deepEqual(classifyRedirect(301, youtube(id), base), {
    state: "playlist",
    playlist: id,
  });
  assert.deepEqual(
    classifyRedirect(
      302,
      `https://youtube.com/playlist?list=${id}&feature=shared`,
      base,
    ),
    { state: "playlist", playlist: id },
  );
  // aka.ms sends a name it does not know to a Bing page (checked 2026-10-20).
  assert.deepEqual(
    classifyRedirect(
      302,
      "https://www.bing.com?ref=aka&shorturl=XY-123onYouTube",
      base,
    ),
    { state: "none" },
  );
  assert.deepEqual(classifyRedirect(404, null, base), { state: "none" });
  assert.deepEqual(classifyRedirect(410, null, base), { state: "none" });
  assert.deepEqual(classifyRedirect(200, null, base), { state: "none" });
  // YouTube, but not a playlist: not followed, but not ignored either.
  assert.deepEqual(
    classifyRedirect(302, "https://www.youtube.com/watch?v=u7BRLaPh8_s", base),
    {
      state: "youtube-other",
      location: "https://www.youtube.com/watch?v=u7BRLaPh8_s",
    },
  );
  // A relative Location is read against the short link.
  assert.deepEqual(classifyRedirect(302, "/elsewhere", base), {
    state: "none",
  });
  // Nothing here proves a recording is missing.
  for (const [status, location] of [
    [429, null],
    [500, null],
    [503, null],
    [403, null],
    [301, null],
  ]) {
    assert.equal(
      classifyRedirect(status, location, base).state,
      "unverified",
      String(status),
    );
  }
});

// ---------------------------------------------------------------------------
// The hub's cards
// ---------------------------------------------------------------------------
test("findLinkCards reads attributes by hand: quotes, expressions, entities, a '>' in a description", () => {
  const text = [
    "intro",
    `<LinkCard title="A &amp; B" href="https://aka.ms/AZ-104onYouTube" target="_blank" description="Use a > b and a /> too"/>`,
    `<LinkCard title='Single' href={'https://x.test'} />`,
    "<LinkCard",
    '  title="Multi"',
    '  href="https://example.com/x"',
    "/>",
    `<LinkCardGrid title="not a card" href="https://example.com/no"/>`,
  ].join("\n");
  const cards = findLinkCards(text);
  assert.deepEqual(cards, [
    { title: "A & B", href: "https://aka.ms/AZ-104onYouTube", line: 2 },
    { title: "Single", href: "", line: 3 },
    { title: "Multi", href: "https://example.com/x", line: 4 },
  ]);
});

test("stripComments blanks MDX and HTML comments and keeps the line numbers", () => {
  const text = "a\n{/* <LinkCard href='x'/> */}\n<!-- two\nlines -->\nb";
  const stripped = stripComments(text);
  assert.equal(stripped.split("\n").length, text.split("\n").length);
  assert.doesNotMatch(stripped, /LinkCard|two/);
});

async function writeDocs(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
}

const card = (title, href) =>
  `<LinkCard title="${title}" href="${href}" target="_blank"/>`;

test("scanHubCards keeps the short links and the YouTube playlists, with file and line, and ignores comments", async () => {
  const dir = await tempDir();
  const id = pl("p");
  await writeDocs(dir, {
    "azure/AZ-104.mdx": [
      "---",
      "title: x",
      "---",
      card("Microsoft Learn AZ-104 Course on YouTube", shortLink("AZ-104")),
      card("Savill", "https://www.youtube.com/watch?v=u7BRLaPh8_s"),
      `{/* ${card("Hidden", shortLink("AZ-999"))} */}`,
      card("Direct", youtube(id)),
      card("Docs", "https://learn.microsoft.com/training/"),
    ].join("\r\n"),
    "github/GH-200.mdx": card("Other", shortLink("gh-200")),
  });
  const cards = scanHubCards(dir);
  assert.deepEqual(
    cards.map(({ file, line, code, playlist }) => ({
      file,
      line,
      code,
      playlist,
    })),
    [
      {
        file: "src/content/docs/azure/AZ-104.mdx",
        line: 4,
        code: "AZ-104",
        playlist: "",
      },
      {
        file: "src/content/docs/azure/AZ-104.mdx",
        line: 7,
        code: "",
        playlist: id,
      },
      {
        file: "src/content/docs/github/GH-200.mdx",
        line: 1,
        code: "GH-200",
        playlist: "",
      },
    ],
  );
});

test("cardCovers: the card of a course is its short link, its playlist, or the short link of a code with the same recording", () => {
  const courses = {
    "AI-900": { playlist: pl("ai") },
    "AI-901": { playlist: pl("ai") },
    "AZ-104": { playlist: pl("az") },
  };
  const short = (code) => ({ code, playlist: "" });
  const direct = (playlist) => ({ code: "", playlist });
  assert.ok(cardCovers(short("AI-901"), "AI-901", pl("ai"), courses));
  assert.ok(cardCovers(short("AI-901"), "AI-900", pl("ai"), courses));
  assert.ok(cardCovers(direct(pl("ai")), "AI-900", pl("ai"), courses));
  assert.ok(!cardCovers(short("AZ-104"), "AI-900", pl("ai"), courses));
  assert.ok(!cardCovers(short("AI-901"), "AI-900", pl("ai"), {}));
  assert.ok(!cardCovers(direct(pl("other")), "AI-900", pl("ai"), courses));
  // a course without a playlist is covered by its own short link only
  assert.ok(!cardCovers(short("AI-901"), "AI-900", "", courses));
});

test("findExamPages maps the exam pages of the seven areas and nothing else", async () => {
  const dir = await tempDir();
  await writeDocs(dir, {
    "azure/AZ-104.mdx": "x",
    "azure/readme.mdx": "x",
    "labs/azure/az-104.mdx": "x",
    "guide/AZ-999.mdx": "x",
    "aibusiness/AB-100.mdx": "x",
  });
  const pages = findExamPages(dir);
  assert.deepEqual([...pages].sort(), [
    ["AB-100", "src/content/docs/aibusiness/AB-100.mdx"],
    ["AZ-104", "src/content/docs/azure/AZ-104.mdx"],
  ]);
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------
const TODAY = "2026-10-20";
const playlist = (id) => ({ state: "playlist", playlist: id });

test("diffCourses compares by set of codes: new, changed, gone after two runs, carried on a failed request", () => {
  const previous = {
    "AZ-104": { playlist: pl("a"), since: "2026-01-01" },
    "AZ-900": { playlist: pl("b"), since: "2026-01-02" },
    "SC-200": { playlist: pl("c"), since: "2026-01-03", missed: 1 },
    "SC-300": { playlist: pl("d"), since: "2026-01-04" },
    "SC-400": { playlist: pl("e"), since: "2026-01-05" },
    "DP-900": { playlist: pl("f"), since: "2026-01-06", missed: 1 },
    "PL-300": { playlist: pl("g"), since: "2026-01-07" },
  };
  const probes = new Map([
    ["ZZ-0000", { state: "none" }],
    ["AZ-104", playlist(pl("a"))], // unchanged
    ["AZ-900", playlist(pl("B2"))], // another playlist now
    ["SC-200", { state: "none" }], // second miss: gone
    ["SC-300", { state: "none" }], // first miss: pending
    ["SC-400", { state: "unverified", reason: "HTTP 503" }], // proves nothing
    ["DP-900", playlist(pl("f"))], // recovered after a first miss
    ["AZ-401", playlist(pl("n"))], // new
    ["AZ-500", { state: "none" }], // never was a course: nothing
    ["AZ-305", { state: "youtube-other" }], // not a playlist: nothing
  ]);
  const diff = diffCourses(previous, probes, TODAY);
  assert.deepEqual(diff.added, [{ code: "AZ-401", playlist: pl("n") }]);
  assert.deepEqual(diff.changed, [
    { code: "AZ-900", from: pl("b"), to: pl("B2") },
  ]);
  assert.deepEqual(diff.gone, [{ code: "SC-200", playlist: pl("c") }]);
  assert.deepEqual(diff.pending, [{ code: "SC-300", playlist: pl("d") }]);
  // PL-300 was not asked at all (it is carried over like a failed request).
  assert.deepEqual(diff.carried, ["PL-300", "SC-400"]);
  assert.deepEqual(diff.next, {
    "AZ-104": { playlist: pl("a"), since: "2026-01-01" },
    "AZ-401": { playlist: pl("n"), since: TODAY },
    "AZ-900": { playlist: pl("B2"), since: TODAY },
    "DP-900": { playlist: pl("f"), since: "2026-01-06" },
    "PL-300": { playlist: pl("g"), since: "2026-01-07" },
    "SC-300": { playlist: pl("d"), since: "2026-01-04", missed: 1 },
    "SC-400": { playlist: pl("e"), since: "2026-01-05" },
  });
  // The control code never ends up anywhere.
  assert.ok(!("ZZ-0000" in diff.next));
});

const hubCard = (over) => ({
  title: "",
  href: "",
  line: 5,
  file: "src/content/docs/azure/AZ-104.mdx",
  code: "",
  playlist: "",
  ...over,
});

test("evaluateHubCards flags a direct link, an old playlist and a dead short link, and leaves the rest", () => {
  const courses = {
    "AZ-104": { playlist: pl("a"), since: TODAY },
    "AZ-900": { playlist: pl("new900"), since: TODAY },
    "DP-900": { playlist: pl("f"), since: TODAY, missed: 1 },
    "AZ-400": { playlist: pl("x"), since: TODAY },
  };
  const previous = {
    "AZ-900": { playlist: pl("old900"), since: "2026-01-01" },
  };
  const probes = new Map([
    ["AZ-104", playlist(pl("a"))],
    ["XX-999", { state: "none" }],
    ["DP-300", { state: "unverified", reason: "HTTP 503" }],
    ["DP-900", { state: "none" }],
    ["YY-111", { state: "youtube-other" }],
  ]);
  const cards = [
    hubCard({ code: "AZ-104", href: shortLink("AZ-104") }), // fine
    hubCard({ playlist: pl("a"), href: youtube(pl("a")), title: "x" }), // use-short-link
    hubCard({ playlist: pl("old900"), href: youtube(pl("old900")) }), // moved
    hubCard({ code: "XX-999", href: shortLink("XX-999") }), // broken
    hubCard({ code: "YY-111", href: shortLink("YY-111") }), // broken (not a playlist)
    hubCard({ code: "DP-300", href: shortLink("DP-300") }), // skipped: unverified
    hubCard({ code: "DP-900", href: shortLink("DP-900") }), // skipped: first miss
    hubCard({
      playlist: pl("zzz"),
      href: youtube(pl("zzz")),
      title: "AZ-400: Microsoft Learn Course on YouTube",
    }), // moved, by the title
    hubCard({
      playlist: pl("savill"),
      href: youtube(pl("savill")),
      title: "AZ-400: John Savill's course",
    }), // a creator's playlist: ignored
    hubCard({
      playlist: pl("nocourse"),
      href: youtube(pl("nocourse")),
      title: "Microsoft Learn QQ-100 Course on YouTube",
    }), // the code has no recording: nothing to compare with
  ];
  const { findings, skipped } = evaluateHubCards(
    cards,
    courses,
    previous,
    probes,
  );
  assert.deepEqual(
    findings.map(({ card, code, problem, suggestion }) => [
      cards.indexOf(card),
      code,
      problem,
      suggestion ?? null,
    ]),
    [
      [1, "AZ-104", "use-short-link", shortLink("AZ-104")],
      [2, "AZ-900", "moved", shortLink("AZ-900")],
      [3, "XX-999", "broken", null],
      [4, "YY-111", "broken", null],
      [7, "AZ-400", "moved", shortLink("AZ-400")],
    ],
  );
  assert.deepEqual(
    skipped.map((c) => cards.indexOf(c)),
    [5, 6],
  );
});

test("diffHubState reports a finding once, forgets a fixed one and keeps what it could not check", () => {
  const a = hubCard({ href: "https://x.test/a" });
  const b = hubCard({ href: "https://x.test/b", line: 9 });
  const c = hubCard({ href: "https://x.test/c" });
  const previous = {
    [hubKey(a)]: { problem: "use-short-link", since: "2026-09-01" },
    [hubKey(c)]: { problem: "broken", since: "2026-09-02" },
  };
  const finding = (card, problem) => ({ card, code: "AZ-104", problem });
  const result = diffHubState(
    previous,
    [finding(a, "use-short-link"), finding(b, "moved")],
    [c],
    TODAY,
  );
  assert.deepEqual(
    result.fresh.map((f) => f.card),
    [b],
  );
  assert.equal(result.known, 2);
  assert.deepEqual(result.next, {
    [hubKey(a)]: { problem: "use-short-link", since: "2026-09-01" },
    [hubKey(b)]: { problem: "moved", since: TODAY },
    [hubKey(c)]: { problem: "broken", since: "2026-09-02" },
  });
  // The problem of a card changed: reported again, with a new date.
  const changed = diffHubState(previous, [finding(a, "moved")], [], TODAY);
  assert.equal(changed.fresh.length, 1);
  assert.equal(changed.next[hubKey(a)].since, TODAY);
  // A fixed card (no finding, not skipped) drops out.
  assert.deepEqual(diffHubState(previous, [], [], TODAY).next, {});
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
test("safeText takes mentions, references, tables and code out of a name from the web", () => {
  assert.equal(
    safeText("A|B `x` <b>@octocat</b> #123 [l](u)"),
    "A B x b @​octocat /b 123 l (u)".replace("123", "#​123"),
  );
});

test("buildIssueTitle names the new courses and the cards to review", () => {
  assert.equal(
    buildIssueTitle({ added: [{ code: "AZ-401" }], fresh: [] }),
    "Course videos: 1 new course video (AZ-401)",
  );
  assert.equal(
    buildIssueTitle({
      added: [
        "AZ-401",
        "AB-330",
        "AI-3036",
        "SC-5010",
        "DP-3050",
        "MS-4040",
      ].map((code) => ({ code })),
      fresh: [{}, {}],
    }),
    "Course videos: 6 new course videos (AB-330, AI-3036, AZ-401, DP-3050, +2 more); 2 cards to review",
  );
  assert.equal(
    buildIssueTitle({ added: [], fresh: [{}] }),
    "Course videos: 1 card to review",
  );
});

test("buildReport gives every new course its exam page, the cards that exist and the card to add", () => {
  const text = buildReport({
    cfg: { today: TODAY },
    diff: {
      added: [
        { code: "AZ-401", playlist: pl("n") },
        { code: "SC-5010", playlist: pl("s") },
      ],
      changed: [{ code: "AZ-900", from: pl("b"), to: pl("B2") }],
      gone: [{ code: "DP-203", playlist: pl("g") }],
    },
    hubFresh: [
      {
        card: hubCard({ title: "AZ-104 @x | y", line: 34 }),
        code: "AZ-104",
        problem: "use-short-link",
        detail: "links the playlist of AZ-104 directly",
        suggestion: shortLink("AZ-104"),
      },
      {
        card: hubCard({ title: "Dead", line: 40 }),
        code: "XX-999",
        problem: "broken",
        detail: "aka.ms/XX-999onYouTube does not resolve to a YouTube playlist",
      },
    ],
    hubKnown: 3,
    details: new Map([
      [
        "AZ-401",
        {
          catalogTitle: "Agentic DevOps",
          playlistTitle: "AZ-401: Agentic DevOps | cram",
        },
      ],
    ]),
    examPages: new Map([["AZ-401", "src/content/docs/azure/AZ-401.mdx"]]),
    hubCards: [
      hubCard({
        code: "SC-5010",
        file: "src/content/docs/security/SC-500.mdx",
      }),
    ],
    checked: 109,
    resolving: 52,
  });
  assert.match(text, /^## Course video changes detected/);
  assert.match(text, /109 course codes, 52 of them resolve/);
  assert.match(text, /### New course videos \(2\)/);
  assert.match(
    text,
    /\| AZ-401 \| Agentic DevOps \| AZ-401: Agentic DevOps cram \| `src\/content\/docs\/azure\/AZ-401\.mdx` \| — \| no card \| \[aka\.ms\/AZ-401onYouTube\]\(https:\/\/aka\.ms\/AZ-401onYouTube\) \|/,
  );
  assert.match(
    text,
    /\| SC-5010 \| — \| — \| no exam page \| not available \| `src\/content\/docs\/security\/SC-500\.mdx` \|/,
  );
  assert.ok(
    text.includes(
      '<LinkCard title="Microsoft Learn AZ-401 Course on YouTube" href="https://aka.ms/AZ-401onYouTube" target="_blank"/>',
    ),
  );
  assert.match(
    text,
    /### Short links that now point at another playlist \(1, informational\)/,
  );
  assert.match(text, /### Exam page cards to review \(2\)/);
  assert.match(
    text,
    /use the short link \(links the playlist of AZ-104 directly\)/,
  );
  assert.match(text, /Use `https:\/\/aka\.ms\/AZ-104onYouTube`/);
  assert.match(text, /src\/content\/docs\/azure\/AZ-104\.mdx:34/);
  assert.match(text, /3 cards reported in an earlier run are still unchanged/);
  assert.match(text, /### Courses that stopped resolving \(1, informational\)/);
  assert.match(text, /### What to do/);
  assert.match(text, /docs\/monitors\/course-videos\.md/);
  assert.doesNotMatch(text, /@octocat|\| y \|/);
});

test("loadConfig reads the environment and falls back to the live addresses", () => {
  const cfg = loadConfig({
    TODAY: "2026-10-20",
    FETCH_DELAY_MS: "0",
    MAX_NEW_PCT: "x",
  });
  assert.equal(
    cfg.learnPageUrl,
    "https://learn.microsoft.com/training/course-videos-on-shows",
  );
  assert.equal(
    cfg.catalogUrl,
    "https://learn.microsoft.com/api/catalog/?type=courses",
  );
  assert.equal(cfg.akamsOrigin, "https://aka.ms");
  assert.equal(cfg.fetchDelayMs, 0);
  assert.equal(cfg.maxNewPct, 50);
  assert.equal(cfg.forceBaseline, false);
  assert.equal(
    loadConfig({ AKAMS_ORIGIN: "http://h.test///", FORCE_BASELINE: "1" })
      .akamsOrigin,
    "http://h.test",
  );
  assert.equal(loadConfig({ FORCE_BASELINE: "1" }).forceBaseline, true);
  assert.equal(retryDelayMs({ attempt: 2, baseMs: 5, maxMs: 100 }), 10);
});

// ---------------------------------------------------------------------------
// A fake aka.ms, Learn catalog, Learn page and oEmbed endpoint
// ---------------------------------------------------------------------------
async function startSite() {
  const site = {
    origin: "",
    hits: [],
    catalog: () => ({
      body: JSON.stringify(CATALOG),
      type: "application/json",
    }),
    page: () => ({ body: LEARN_PAGE, type: "text/html" }),
    // code -> playlist id; or a function (code, hit) -> reply for a special case
    courses: new Map(),
    replies: new Map(),
    titles: new Map(),
    oembed: null,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    site.hits.push(url.pathname);
    const send = (reply) => {
      response.statusCode = reply.status ?? 200;
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        response.setHeader(name, value);
      }
      if (reply.type) response.setHeader("content-type", reply.type);
      response.end(reply.body ?? "");
    };
    if (url.pathname === "/catalog") return send(site.catalog(site));
    if (url.pathname === "/learn") return send(site.page(site));
    if (url.pathname === "/oembed") {
      const id = new URL(url.searchParams.get("url")).searchParams.get("list");
      site.oembedHits = [...(site.oembedHits ?? []), id];
      if (site.oembed) return send(site.oembed(id, site));
      const title = site.titles.get(id);
      return title
        ? send({
            type: "application/json",
            body: JSON.stringify({ title, author_name: "Microsoft Learn" }),
          })
        : send({ status: 404 });
    }
    const code = /^\/([A-Z]{1,4}-\d{3,4})onYouTube$/.exec(url.pathname)?.[1];
    if (code) {
      const hits = site.hits.filter((hit) => hit === url.pathname).length;
      const special = site.replies.get(code);
      if (special) return send(special(hits));
      const id = site.courses.get(code);
      return id
        ? send({ status: 301, headers: { location: youtube(id) } })
        : send({
            status: 302,
            headers: {
              location: `https://www.bing.com?ref=aka&shorturl=${code}onYouTube`,
            },
          });
    }
    send({ status: 404, body: "not found" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  site.origin = `http://127.0.0.1:${server.address().port}`;
  site.close = () => new Promise((done) => server.close(done));
  site.asked = (code) =>
    site.hits.filter((hit) => hit === `/${code}onYouTube`).length;
  return site;
}

/** The scenario most tests start from: four courses with a recording. */
function scenario(site) {
  site.courses.set("AZ-104", pl("104"));
  site.courses.set("AZ-900", pl("900"));
  site.courses.set("SC-5006", pl("5006"));
  site.courses.set("AB-100", pl("100"));
  return site;
}

const DOCS = {
  "azure/AZ-104.mdx": card(
    "Microsoft Learn AZ-104 Course on YouTube",
    shortLink("AZ-104"),
  ),
  "azure/AZ-900.mdx": "# AZ-900\n",
  "azure/AZ-401.mdx": "# AZ-401\n",
  "aibusiness/AB-100.mdx": "# AB-100\n",
};

/** Runs the real script against the fake site; resolves with everything it left behind. */
async function run(site, dir, env = {}) {
  const files = {
    baseline: join(dir, "baseline.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "github-output"),
    summary: join(dir, "summary.md"),
    docs: join(dir, "docs"),
  };
  await mkdir(files.docs, { recursive: true });
  await writeFile(files.output, "");
  await writeFile(files.summary, "");
  const child = spawn("node", [script], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      LEARN_PAGE_URL: `${site.origin}/learn`,
      CATALOG_URL: `${site.origin}/catalog`,
      AKAMS_ORIGIN: site.origin,
      OEMBED_URL: `${site.origin}/oembed`,
      BASELINE_FILE: files.baseline,
      DOCS_DIR: files.docs,
      REPORT_FILE: files.report,
      ERROR_FILE: files.error,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      MIN_CATALOG: "1",
      MIN_PAGE_CODES: "1",
      FETCH_DELAY_MS: "0",
      RETRY_BASE_MS: "0",
      FETCH_ATTEMPTS: "2",
      TODAY,
      FORCE_BASELINE: "",
      // the suggested exam pages need the learnsync data: switched on by their own tests
      PLACEMENT: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("close", done));
  const read = (file) => readFile(file, "utf8").catch(() => null);
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
    summary: await read(files.summary),
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

async function started(prefix) {
  const site = scenario(await startSite());
  const dir = await tempDir(prefix);
  await writeDocs(join(dir, "docs"), DOCS);
  after(() => site.close());
  return { site, dir };
}

const playlistsOf = (baseline) =>
  Object.fromEntries(
    Object.entries(baseline.courses).map(([k, v]) => [k, v.playlist]),
  );

test("the first run records what aka.ms resolves silently: no issue, a baseline of the real recordings", async () => {
  const { site, dir } = await started();
  const first = await run(site, dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.output.changes_found, "false");
  assert.equal(first.output.baseline_updated, "true");
  assert.equal(first.output.extraction_failed, "false");
  assert.equal(first.output.new_courses, "0");
  assert.equal(first.report, null);
  assert.deepEqual(playlistsOf(first.baseline), {
    "AB-100": pl("100"),
    "AZ-104": pl("104"),
    "AZ-900": pl("900"),
    "SC-5006": pl("5006"),
  });
  assert.equal(first.baseline.totalCourses, 4);
  assert.equal(first.baseline.courses["AZ-104"].since, TODAY);
  assert.equal(first.baseline.staleHubCards, undefined);
  // Every source of codes was asked: the catalog (MB-230, SC-401, AZ-2008),
  // the Learn page (MS-4007, SC-900), the exam pages (AZ-401), and the control.
  for (const code of [
    "MB-230",
    "SC-401",
    "AZ-2008",
    "MS-4007",
    "SC-900",
    "AZ-401",
    "ZZ-0000",
  ]) {
    assert.equal(site.asked(code), 1, code);
  }
  // Nothing new was announced, so nothing asked YouTube about a playlist.
  assert.deepEqual(site.oembedHits ?? [], []);
  // The job summary says how complete the Learn page is.
  assert.match(first.summary, /### Course Videos Monitor/);
  assert.match(
    first.summary,
    /Learn page: lists 3 course videos; 3 that resolve are not on it \(AB-100, AZ-104, SC-5006\); 2 on it do not resolve \(SC-900, MS-4007\)/,
  );
});

test("a quiet run writes nothing: no report, the baseline file stays byte for byte", async () => {
  const { site, dir } = await started();
  const first = await run(site, dir);
  const second = await run(site, dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.output.changes_found, "false");
  assert.equal(second.output.baseline_updated, "false");
  assert.equal(second.report, null);
  assert.equal(second.baselineText, first.baselineText);
});

test("a course that starts resolving opens an issue with its exam page, its playlist title and the card to add", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  site.courses.set("AZ-401", pl("401"));
  site.titles.set(
    pl("401"),
    "AZ-401: Designing and Implementing Microsoft Agentic DevOps",
  );
  const second = await run(site, dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.output.changes_found, "true");
  assert.equal(second.output.baseline_updated, "true");
  assert.equal(second.output.new_courses, "1");
  assert.equal(
    second.output.issue_title,
    "Course videos: 1 new course video (AZ-401)",
  );
  assert.match(second.report, /### New course videos \(1\)/);
  assert.match(
    second.report,
    /\| AZ-401 \| — \| AZ-401: Designing and Implementing Microsoft Agentic DevOps \| `src\/content\/docs\/azure\/AZ-401\.mdx` \| — \| no card \|/,
  );
  assert.ok(
    second.report.includes(
      '<LinkCard title="Microsoft Learn AZ-401 Course on YouTube" href="https://aka.ms/AZ-401onYouTube" target="_blank"/>',
    ),
  );
  assert.equal(second.baseline.courses["AZ-401"].playlist, pl("401"));
  assert.equal(second.baseline.courses["AZ-401"].since, TODAY);
  assert.deepEqual(site.oembedHits, [pl("401")]);
  // Reported once: the next run is quiet.
  const third = await run(site, dir);
  assert.equal(third.output.changes_found, "false");
  assert.equal(third.report, null);
});

test("a new course found in the catalog only (no exam page) is reported with 'no exam page'", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  site.courses.set("AZ-2008", pl("2008"));
  const second = await run(site, dir);
  assert.equal(
    second.output.issue_title,
    "Course videos: 1 new course video (AZ-2008)",
  );
  assert.match(
    second.report,
    /\| AZ-2008 \| DevOps Foundations: The Core Principles and Practices \| — \| no exam page \| not available \| no card \|/,
  );
});

/** The scenario with the invented Learn corner of the placement tests behind the catalog and the study guides. */
async function placementStarted() {
  const { site, dir } = await started("course-videos-placement-");
  const world = placementWorld();
  site.catalog = () => ({
    body: JSON.stringify({ courses: world.courses }),
    type: "application/json",
  });
  const learnsync = await writeLearnsync(join(dir, "learnsync"), world);
  const guides = await writeGuidesFile(join(dir, "learn-exams.json"));
  const env = {
    PLACEMENT: "1",
    LEARNSYNC_DIR: learnsync,
    LEARN_EXAMS_FILE: guides,
  };
  await run(site, dir, env); // the silent baseline
  return { site, dir, env };
}

test("a new course without an exam page gets the exam pages it could go on, with the evidence", async () => {
  const { site, dir, env } = await placementStarted();
  site.courses.set("XX-1001", pl("1001"));
  site.courses.set("AZ-401", pl("401"));
  const second = await run(site, dir, env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.output.new_courses, "2");
  // The course with a suggestion: the exam it shares a module with, and why.
  assert.match(
    second.report,
    /\| XX-1001 \| Extend virtual networks with routes and peering \| — \| no exam page \| AZ-104, strong \(shares 1 of 2 modules with its official course; guide match #​1: [^|]*\)<br>/,
  );
  // An exam page is its own placement: nothing is suggested for it.
  assert.match(
    second.report,
    /\| AZ-401 \| — \| — \| `src\/content\/docs\/azure\/AZ-401\.mdx` \| — \|/,
  );
  assert.match(second.report, /the suggestions column lists the candidates/);
});

test("a course the catalog does not list is placed by its playlist title", async () => {
  const { site, dir, env } = await placementStarted();
  await writeFile(
    join(dir, "docs/azure/AZ-900.mdx"),
    card("Microsoft Learn XX-7007 Course on YouTube", shortLink("XX-7007")),
  );
  // it is a candidate through the card, then starts to resolve
  site.courses.set("XX-7007", pl("7007"));
  site.titles.set(
    pl("7007"),
    "XX-7007: Create users and groups in Microsoft Entra",
  );
  const second = await run(site, dir, env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    second.output.issue_title,
    "Course videos: 1 new course video (XX-7007)",
  );
  assert.match(
    second.report,
    /\| XX-7007 \| — \| XX-7007: Create users and groups in Microsoft Entra \| no exam page \| AZ-104, possible \(guide match #​1: [^|]*\)<br>/,
  );
});

test("suggestions are a courtesy: when the study guides cannot be read the issue is written without them", async () => {
  const { site, dir, env } = await placementStarted();
  site.courses.set("XX-1001", pl("1001"));
  const second = await run(site, dir, {
    ...env,
    LEARNSYNC_DIR: join(dir, "no-such-learnsync"),
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.output.changes_found, "true");
  assert.match(
    second.stderr,
    /could not suggest exam pages for the new courses/,
  );
  assert.match(
    second.report,
    /\| XX-1001 \| .* \| no exam page \| not available \|/,
  );
  // The baseline recorded the course all the same.
  assert.equal(second.baseline.courses["XX-1001"].playlist, pl("1001"));
});

test("a card that links a playlist directly is reported once, then forgotten when it is fixed", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  const page = join(dir, "docs/azure/AZ-900.mdx");
  await writeFile(
    page,
    card("Microsoft Learn AZ-900 Course on YouTube", youtube(pl("900"))),
  );
  const second = await run(site, dir);
  assert.equal(second.output.changes_found, "true");
  assert.equal(second.output.hub_findings, "1");
  assert.equal(second.output.new_courses, "0");
  assert.equal(second.output.issue_title, "Course videos: 1 card to review");
  assert.match(second.report, /### Exam page cards to review \(1\)/);
  assert.match(second.report, /src\/content\/docs\/azure\/AZ-900\.mdx:1/);
  assert.match(second.report, /Use `https:\/\/aka\.ms\/AZ-900onYouTube`/);
  const key = "src/content/docs/azure/AZ-900.mdx|" + youtube(pl("900"));
  assert.equal(second.baseline.staleHubCards[key].problem, "use-short-link");
  // Not repeated.
  const third = await run(site, dir);
  assert.equal(third.output.changes_found, "false");
  assert.equal(third.output.baseline_updated, "false");
  // Fixed: the memory drops it, still without an issue.
  await writeFile(
    page,
    card("Microsoft Learn AZ-900 Course on YouTube", shortLink("AZ-900")),
  );
  const fourth = await run(site, dir);
  assert.equal(fourth.output.changes_found, "false");
  assert.equal(fourth.output.baseline_updated, "true");
  assert.equal(fourth.baseline.staleHubCards, undefined);
});

test("a playlist that changes updates the baseline quietly, and opens an issue when a card still links the old one", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  site.courses.set("AZ-900", pl("900b"));
  const quiet = await run(site, dir);
  assert.equal(quiet.output.changes_found, "false");
  assert.equal(quiet.output.baseline_updated, "true");
  assert.equal(quiet.baseline.courses["AZ-900"].playlist, pl("900b"));
  assert.equal(quiet.baseline.courses["AZ-900"].since, TODAY);

  // Now the same for a course whose old playlist a card still links directly.
  await writeFile(
    join(dir, "docs/azure/AZ-900.mdx"),
    card("Microsoft Learn AZ-900 Course on YouTube", youtube(pl("900b"))),
  );
  await run(site, dir); // reports the direct link once
  site.courses.set("AZ-900", pl("900c"));
  site.titles.set(pl("900c"), "AZ-900: Azure Fundamentals");
  const moved = await run(site, dir);
  assert.equal(moved.output.changes_found, "true");
  assert.match(
    moved.report,
    /### Short links that now point at another playlist \(1, informational\)/,
  );
  assert.match(moved.report, /points at an older playlist/);
  assert.match(moved.report, /AZ-900: Azure Fundamentals/);
});

test("a course that stops resolving is dropped only when the next run says the same", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  site.courses.delete("SC-5006");
  const first = await run(site, dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.output.changes_found, "false");
  assert.equal(first.baseline.courses["SC-5006"].missed, 1);
  assert.match(
    first.stdout,
    /Did not resolve this run \(confirmed by the next\): SC-5006/,
  );
  // A glitch that heals: the mark goes away again, still no issue.
  site.courses.set("SC-5006", pl("5006"));
  const healed = await run(site, dir);
  assert.equal(healed.output.changes_found, "false");
  assert.equal(healed.baseline.courses["SC-5006"].missed, undefined);
  // The real thing: two runs in a row.
  site.courses.delete("SC-5006");
  await run(site, dir);
  const second = await run(site, dir);
  assert.equal(second.output.changes_found, "false");
  assert.equal(second.baseline.courses["SC-5006"], undefined);
  assert.match(second.stdout, /Stopped resolving: SC-5006/);
});

test("a short link on an exam page that never resolved is reported once as broken", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  await writeFile(
    join(dir, "docs/azure/AZ-401.mdx"),
    card("Microsoft Learn AZ-401 Course on YouTube", shortLink("AZ-401")),
  );
  const second = await run(site, dir);
  assert.equal(second.output.issue_title, "Course videos: 1 card to review");
  assert.match(second.report, /short link does not resolve/);
  const third = await run(site, dir);
  assert.equal(third.output.changes_found, "false");
  // Once the course exists the card is fine, the new course is reported, the memory is cleared.
  site.courses.set("AZ-401", pl("401"));
  const fourth = await run(site, dir);
  assert.equal(
    fourth.output.issue_title,
    "Course videos: 1 new course video (AZ-401)",
  );
  assert.equal(fourth.baseline.staleHubCards, undefined);
  assert.match(fourth.report, /`src\/content\/docs\/azure\/AZ-401\.mdx`/);
});

test("a request that fails is retried, and one that keeps failing proves nothing", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  let calls = 0;
  site.replies.set("AZ-104", () => {
    calls++;
    return calls === 1
      ? { status: 429, headers: { "retry-after": "0" } }
      : { status: 301, headers: { location: youtube(pl("104")) } };
  });
  site.replies.set("AZ-900", () => ({ status: 503 }));
  const second = await run(site, dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(calls, 2);
  assert.equal(second.output.changes_found, "false");
  // The unconfirmed course is kept exactly as it was.
  assert.equal(second.baseline.courses["AZ-900"].playlist, pl("900"));
  assert.equal(second.baseline.courses["AZ-900"].missed, undefined);
  assert.match(
    second.stderr,
    /1 short link not confirmed this run, so left as they were: AZ-900 \(HTTP 503\)/,
  );
});

test("the Learn page is a second opinion: when it cannot be read the run goes on with a warning", async () => {
  const { site, dir } = await started();
  site.page = () => ({ status: 500, body: "oops" });
  const first = await run(site, dir);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /WARNING: .*Learn course videos page.*ignored/);
  assert.match(first.summary, /Learn page: not available this run/);
  assert.equal(first.baseline.totalCourses, 4);
  // A page whose layout changed (no short links) is ignored too.
  site.page = () => ({ body: "<p>redesigned</p>", type: "text/html" });
  const second = await run(site, dir, { MIN_PAGE_CODES: "2" });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /lists only 0 course videos/);
});

test("the playlist title is a courtesy: a refused oEmbed leaves a dash, a title that does not start with the code is flagged", async () => {
  const { site, dir } = await started();
  await run(site, dir);
  site.courses.set("AZ-401", pl("401"));
  const refused = await run(site, dir);
  assert.equal(refused.code, 0, refused.stderr);
  assert.match(refused.report, /\| AZ-401 \| — \| — \| /);
  const { site: site2, dir: dir2 } = await started("course-videos-title-");
  await run(site2, dir2);
  site2.courses.set("AZ-401", pl("401"));
  site2.titles.set(pl("401"), "Some other playlist");
  const wrong = await run(site2, dir2);
  assert.match(
    wrong.stderr,
    /playlist of AZ-401 is titled "Some other playlist", which does not start with the code/,
  );
  assert.match(wrong.report, /Some other playlist/);
});

test("fetchPlaylistTitle and probeCode answer for themselves and never throw", async () => {
  const site = scenario(await startSite());
  after(() => site.close());
  site.titles.set(pl("104"), "AZ-104: Azure Administrator");
  const cfg = loadConfig({
    AKAMS_ORIGIN: site.origin,
    OEMBED_URL: `${site.origin}/oembed`,
    FETCH_ATTEMPTS: "1",
    RETRY_BASE_MS: "0",
  });
  assert.deepEqual(await fetchPlaylistTitle(cfg, pl("104")), {
    state: "ok",
    title: "AZ-104: Azure Administrator",
  });
  assert.deepEqual(await fetchPlaylistTitle(cfg, pl("nope")), {
    state: "unreadable",
    status: 404,
  });
  site.oembed = () => ({ status: 503 });
  assert.equal((await fetchPlaylistTitle(cfg, pl("104"))).state, "unverified");
  site.oembed = () => ({ type: "application/json", body: "{}" });
  assert.equal((await fetchPlaylistTitle(cfg, pl("104"))).state, "unverified");
  assert.deepEqual(await probeCode(cfg, "AZ-104"), {
    state: "playlist",
    playlist: pl("104"),
  });
  assert.deepEqual(await probeCode(cfg, "QQ-100"), { state: "none" });
  const dead = loadConfig({
    AKAMS_ORIGIN: "http://127.0.0.1:9",
    FETCH_ATTEMPTS: "1",
  });
  assert.equal((await probeCode(dead, "AZ-104")).state, "unverified");
});

// ---------------------------------------------------------------------------
// Failsafes: nothing is written
// ---------------------------------------------------------------------------
async function failed(run, pattern) {
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.equal(run.output.extraction_failed, "true");
  assert.equal(run.output.changes_found, "false");
  assert.equal(run.output.baseline_updated, "false");
  assert.match(run.error, pattern);
  assert.equal(run.report, null);
}

test("a catalog that cannot be read, is not JSON or has too few courses stops the run", async () => {
  const { site, dir } = await started();
  site.catalog = () => ({ status: 500 });
  const down = await run(site, dir);
  await failed(down, /Failed to fetch the Learn catalog \(HTTP 500\)/);
  assert.equal(down.baselineText, null);
  site.catalog = () => ({ body: "<html>", type: "text/html" });
  await failed(await run(site, dir), /not valid JSON/);
  site.catalog = () => ({ body: "{}", type: "application/json" });
  await failed(await run(site, dir), /no courses list/);
  site.catalog = undefined;
  site.catalog = () => ({
    body: JSON.stringify(CATALOG),
    type: "application/json",
  });
  await failed(
    await run(site, dir, { MIN_CATALOG: "50" }),
    /gave 7 course codes \(expected at least 50\)/,
  );
});

test("an aka.ms that answers the control code, or fails for most codes, stops the run", async () => {
  const { site, dir } = await started();
  const first = await run(site, dir);
  assert.equal(first.code, 0, first.stderr);
  const before = first.baselineText;
  site.courses.set("ZZ-0000", pl("control"));
  const every = await run(site, dir);
  await failed(every, /control code ZZ-0000onYouTube, which cannot exist/);
  assert.equal(every.baselineText, before);
  site.courses.delete("ZZ-0000");
  for (const code of [
    "AZ-104",
    "AZ-900",
    "SC-5006",
    "AB-100",
    "MB-230",
    "SC-401",
  ]) {
    site.replies.set(code, () => ({ status: 503 }));
  }
  const blocked = await run(site, dir);
  await failed(
    blocked,
    /requests to aka\.ms failed .* aka\.ms is unreachable or blocking requests/,
  );
  assert.equal(blocked.baselineText, before);
});

/** A baseline with `count` codes of the fake site's own making. */
async function writeBaseline(file, codes, extra = {}) {
  const courses = Object.fromEntries(
    codes.map((code) => [code, { playlist: pl(code), since: "2026-01-01" }]),
  );
  await writeFile(
    file,
    JSON.stringify(
      {
        lastChecked: "2026-10-01T00:00:00Z",
        totalCourses: codes.length,
        ...extra,
        courses,
      },
      null,
      2,
    ) + "\n",
  );
  return readFile(file, "utf8");
}

const TEN = [
  "AA-101",
  "AA-102",
  "AA-103",
  "AA-104",
  "AA-105",
  "AA-106",
  "AA-107",
  "AA-108",
  "AA-109",
  "AA-110",
];

test("too many new courses at once, or too many gone at once, stop the run unless the baseline is forced", async () => {
  const { site, dir } = await started();
  const baselineFile = join(dir, "baseline.json");
  // Twelve more courses of the catalog resolve at once: 16 new ones (with the
  // four of the scenario) against a baseline of ten.
  let text = await writeBaseline(baselineFile, TEN);
  const extra = Array.from({ length: 12 }, (_, n) => `BB-${200 + n}`);
  site.catalog = () => ({
    type: "application/json",
    body: JSON.stringify({
      courses: [
        ...CATALOG.courses,
        ...extra.map((code) => ({
          uid: `course.${code.toLowerCase()}t00`,
          course_number: `${code}T00`,
          title: code,
        })),
      ],
    }),
  });
  for (const code of extra) site.courses.set(code, pl(code));
  const many = await run(site, dir);
  await failed(
    many,
    /course videos are new at once \(\d+% of the 10 in the baseline, threshold 50%\)/,
  );
  assert.equal(many.baselineText, text);
  // Forced: accepted silently, no issue.
  const forced = await run(site, dir, { FORCE_BASELINE: "1" });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(forced.output.changes_found, "false");
  assert.equal(forced.output.baseline_updated, "true");
  assert.match(
    forced.stdout,
    /FORCE_BASELINE: \d+ course videos accepted silently/,
  );

  // Gone: a baseline of ten that aka.ms does not resolve any more.
  const { site: quietSite, dir: dir2 } = await started("course-videos-gone-");
  quietSite.courses.clear();
  text = await writeBaseline(join(dir2, "baseline.json"), TEN);
  const gone = await run(quietSite, dir2);
  await failed(
    gone,
    /10 of the 10 course videos in the baseline stopped resolving at once/,
  );
  assert.equal(gone.baselineText, text);
});

test("a corrupt baseline stops the run and is left alone", async () => {
  const { site, dir } = await started();
  await writeFile(join(dir, "baseline.json"), "{not json");
  await failed(
    await run(site, dir),
    /Corrupt course videos baseline .*invalid JSON/,
  );
  assert.equal(await readFile(join(dir, "baseline.json"), "utf8"), "{not json");
  await writeFile(join(dir, "baseline.json"), JSON.stringify({ courses: [] }));
  await failed(await run(site, dir), /missing courses object/);
  await writeFile(
    join(dir, "baseline.json"),
    JSON.stringify({ courses: { "AZ-104": {} } }),
  );
  await failed(await run(site, dir), /entry "AZ-104" has no valid playlist/);
});

test("a stale report or error from an earlier run never survives", async () => {
  const { site, dir } = await started();
  await writeFile(join(dir, "report.md"), "old report");
  await writeFile(join(dir, "error.md"), "old error");
  const first = await run(site, dir);
  assert.equal(first.report, null);
  assert.equal(first.error, null);
});

// ---------------------------------------------------------------------------
// The workflow: its step order and manual input are part of the contract
// ---------------------------------------------------------------------------
// A checkout with core.autocrlf (this repo's maintainer works on Windows) turns
// the line ends of the workflow into CRLF; the patterns below are written for LF.
const workflowSource = readFileSync(
  join(root, ".github", "workflows", "course-videos-monitor.yml"),
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

const STEP_CHECK = "Check the Microsoft Learn course videos on YouTube";
const STEP_ISSUE = "Create issue if course videos or exam page cards changed";
const STEP_COMMIT = "Commit updated course videos baseline";
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
  // commit is skipped when the issue step fails and the course is still new on
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
    /^ {6}REPORT_FILE: \/tmp\/course-videos-report\.md$/m,
  );
  assert.match(
    workflowSource,
    /^ {6}ERROR_FILE: \/tmp\/course-videos-error\.md$/m,
  );
  assert.equal(file(STEP_ISSUE), "/tmp/course-videos-report.md");
  const failed = workflowStep(STEP_FAILED).text;
  assert.match(
    failed,
    /node scripts\/failure-issue\.mjs raise --title "Course Videos Monitor Failed" --label bug --file \/tmp\/course-videos-error\.md/,
  );
  assert.match(failed, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflowSource, /github\.run_id/);
  const close = workflowStep(STEP_CLOSE_FAILED);
  assert.equal(
    close.condition,
    "steps.check.outputs.extraction_failed == 'false'",
  );
  assert.match(
    close.text,
    /node scripts\/failure-issue\.mjs clear --title "Course Videos Monitor Failed" --label bug --comment "[^"]+"/,
  );
  // The job may commit the baseline and open issues, and nothing else.
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(workflowSource, /^ {4}timeout-minutes: 20$/m);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /run: node scripts\/course-videos-check\.mjs/,
  );
});

test("a run is not cancelled between the issue and the baseline commit", () => {
  assert.match(
    workflowSource,
    /^concurrency:\n {2}group: course-videos-monitor\n {2}cancel-in-progress: false$/m,
  );
});

test("it runs daily, and a manual run can force a re-baseline with the input the failsafe message names", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/m);
  assert.match(dispatch, /type: boolean/);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  assert.match(workflowSource, /^ {4}- cron: "40 5 \* \* \*"/m);
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
    const baseline = "src/data_files/course-videos.json";
    const remote = await makeScratchRemote({
      prefix: "course-videos-workflow-",
      files: { [baseline]: '{"courses":{}}\n' },
    });
    t.after(() => remote.cleanup());
    const script = commitScript();
    assert.match(
      script,
      /git add src\/data_files\/course-videos\.json$/m,
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
    await remote.write(remote.work, baseline, '{"courses":{"AZ-104":{}}}\n');
    await remote.write(remote.work, "stray.txt", "x\n");
    const pushed = await runStep();
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.deepEqual(await remote.subjects(), [
      "Update course videos baseline",
      "elsewhere",
      "init",
    ]);
    assert.equal(await remote.show(baseline), '{"courses":{"AZ-104":{}}}');
    assert.deepEqual(await remote.changedFiles(), [baseline]);
    assert.ok(!(await remote.files()).includes("stray.txt"));
  },
);
