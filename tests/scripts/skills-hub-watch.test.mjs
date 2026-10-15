import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BLOG_URL,
  ExtractionError,
  FEED_URL,
  RELEVANCE_RE,
  announcementUrl,
  applyFeed,
  applyProblem,
  betaAnnouncements,
  buildIssueTitle,
  buildProblemReport,
  buildReport,
  classifyCodes,
  datedStatements,
  decodeEntities,
  emptyTracker,
  extractExamCodes,
  feedPosts,
  htmlToBlocks,
  httpUrl,
  isDefiniteStatus,
  isRelevant,
  loadConfig,
  loadHubContext,
  matchedDetails,
  matchedTerms,
  normalizeTracker,
  parseDate,
  parseFeed,
  plain,
  postKey,
  readBetaWaiting,
  safeText,
  sortPosts,
  trackerContent,
  trustedLink,
} from "../../scripts/skills-hub-watch.mjs";
import { AREA_BY_PREFIX } from "../../scripts/lib/areas.mjs";
import { retryDelayMs } from "../../scripts/lib/retry.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/skills-hub-watch.mjs");
const FIXTURE = readFileSync(
  join(root, "tests/fixtures/skills-hub/feed.xml"),
  "utf8",
);
// One hand-written post that announces the beta of AZ-401 (see the comment in the file).
const BETA_FEED = readFileSync(
  join(root, "tests/fixtures/skills-hub/feed-beta-announcement.xml"),
  "utf8",
);
const BETA_ITEM = BETA_FEED.match(/ {4}<item>[\s\S]*?<\/item>\n/)[0];
const BETA_POST_URL =
  "https://techcommunity.microsoft.com/t5/the-skills-hub-blog/new-beta-exam-az-401-designing-and-implementing-microsoft/ba-p/4599401";
const TODAY = "2026-10-14";
const ZWSP = String.fromCharCode(0x200b);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const cfgOf = (extra = {}) => ({ ...loadConfig({ TODAY }), ...extra });

const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One RSS item in the shape of the real feed (entity-escaped HTML description). */
function itemXml({
  id = 9000001,
  slug = "post",
  title = "A post",
  date = "Tue, 14 Oct 2026 03:30:00 GMT",
  html = "<p>Some text.</p>",
  extra = "",
} = {}) {
  const link = `https://techcommunity.microsoft.com/t5/the-skills-hub-blog/${slug}/ba-p/${id}`;
  return (
    `    <item>\n      <title>${escapeXml(title)}</title>\n      <link>${link}</link>\n` +
    `      <description>${escapeXml(html)}</description>\n      <pubDate>${date}</pubDate>\n` +
    `      <guid>${link}</guid>\n      <dc:creator>Someone</dc:creator>\n` +
    `      <dc:date>${new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z")}</dc:date>\n${extra}    </item>\n`
  );
}

const rss = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">\n` +
  `  <channel>\n    <title>Test</title>\n    <pubDate>Tue, 14 Oct 2026 04:00:00 GMT</pubDate>\n${items.join("")}  </channel>\n</rss>\n`;

/** The fixture with extra items in front of its first one. */
const withItems = (xml, ...items) =>
  xml.replace("    <item>", items.join("") + "    <item>");

/** The first `count` items of the fixture. */
function firstItems(count, xml = FIXTURE) {
  const parts = xml.split("    <item>");
  return (
    parts[0] +
    parts
      .slice(1, count + 1)
      .map((part) => "    <item>" + part.replace(/\s*<\/channel>[\s\S]*$/, ""))
      .join("") +
    "  </channel>\n</rss>\n"
  );
}

/** A post as the parser produces it, for the pure functions. */
function mkPost(i, extra = {}) {
  const id = 4000000 + i;
  const link = `https://techcommunity.microsoft.com/t5/the-skills-hub-blog/p${i}/ba-p/${id}`;
  return {
    id: link,
    link,
    key: `tc:${id}`,
    title: `Post ${i}`,
    pubDate: `2026-09-${String(i).padStart(2, "0")}T12:00:00Z`,
    summary: "",
    bodyBlocks: [],
    categories: [],
    matched: false,
    ...extra,
  };
}

const record = (post) => ({
  id: post.id,
  title: post.title,
  pubDate: post.pubDate,
  matched: post.matched,
});

const trackerOf = (posts, extra = {}) => ({
  lastSynced: "2026-09-30",
  problem: null,
  posts: sortPosts(posts.map(record)),
  ...extra,
});

const postsOf = (xml) => feedPosts(parseFeed(xml)).posts;

const emptyContext = {
  pages: new Map(),
  statuses: new Map(),
  learn: new Set(),
  vouchers: new Map(),
  betaWaiting: null,
  notes: [],
};

/** The post of the beta announcement fixture, as the parser produces it. */
const betaPost = () => postsOf(BETA_FEED)[0];

/** The tracked beta exams that wait for their announcement: [code, state, betaStart]. */
const waiting = (...exams) =>
  new Map(
    exams.map(([code, state, betaStart = "2026-10-14"]) => [
      code,
      { code, state, betaStart },
    ]),
  );

/** A context for a report whose exam pages are known and whose beta exams wait for a post. */
const betaContext = (betaWaiting, pages = [["AZ-401", "azure"]]) => ({
  ...emptyContext,
  pages: new Map(pages),
  betaWaiting,
});

const ACTION = (code) =>
  `ACTION: this post is the announcement the beta note of ${code} is waiting for`;

// ---------------------------------------------------------------------------
// Constants and config
// ---------------------------------------------------------------------------
test("the feed address is the one the blog page links, and the relevance filter is the documented one", () => {
  assert.equal(
    FEED_URL,
    "https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog",
  );
  assert.equal(
    RELEVANCE_RE.source,
    "exam|certif|retir|beta|voucher|renew|roundup|credential|applied skill|badge|discount",
  );
  assert.equal(RELEVANCE_RE.flags, "i", "no g flag: .test() has no state");
  assert.ok(BLOG_URL.startsWith("https://techcommunity.microsoft.com/"));
});

test("the config reads its overrides and falls back for malformed numbers", () => {
  const cfg = loadConfig({
    TRACKER_FILE: "/tmp/tracker.json",
    FEED_URL: "http://127.0.0.1:1/feed",
    MIN_FEED_ITEMS: "abc",
    MAX_NEW_POSTS: "3",
    FORCE_BASELINE: "1",
    TODAY: "2026-01-02",
  });
  assert.equal(cfg.trackerFile, "/tmp/tracker.json");
  assert.equal(cfg.feedUrl, "http://127.0.0.1:1/feed");
  assert.equal(cfg.minFeedItems, 5);
  assert.equal(cfg.maxNewPosts, 3);
  assert.equal(cfg.forceBaseline, true);
  assert.equal(cfg.today, "2026-01-02");

  const defaults = loadConfig({ TODAY });
  assert.equal(defaults.feedUrl, FEED_URL);
  assert.equal(defaults.forceBaseline, false);
  assert.equal(defaults.maxNewPosts, 10);
  assert.equal(defaults.maxTrackedPosts, 200);
  assert.equal(defaults.oldPostDays, 30);
  assert.equal(defaults.definiteRuns, 2);
  assert.equal(defaults.fetchRuns, 8);
  assert.equal(defaults.reminderDays, 7);
  assert.equal(defaults.fetchAttempts, 3);
  assert.match(
    defaults.trackerFile,
    /src[\\/]data_files[\\/]skills-hub-posts\.json$/,
  );
  assert.match(
    defaults.betaExamsFile,
    /src[\\/]data_files[\\/]beta-exams\.json$/,
  );
  assert.equal(
    loadConfig({ BETA_EXAMS_FILE: "/tmp/beta.json" }).betaExamsFile,
    "/tmp/beta.json",
  );
  assert.equal(
    loadConfig({ BETA_EXAMS_FILE: "tests/x/beta.json" }).betaExamsFile,
    join(root, "tests/x/beta.json"),
    "a relative path starts at the repository root",
  );
  assert.match(
    loadConfig({ BETA_EXAMS_FILE: "" }).betaExamsFile,
    /beta-exams\.json$/,
    "empty is the default",
  );
  assert.equal(loadConfig({ TODAY: "yesterday" }).today.length, 10);
  assert.equal(loadConfig({ FORCE_BASELINE: "" }).forceBaseline, false);
});

test("Retry-After is honoured in seconds and as a date, and always capped", () => {
  const base = { attempt: 1, baseMs: 5000, maxMs: 60000, now: 0 };
  assert.equal(retryDelayMs({ ...base, retryAfter: "7" }), 7000);
  assert.equal(retryDelayMs({ ...base, retryAfter: "99999" }), 60000);
  assert.equal(retryDelayMs({ ...base, retryAfter: null }), 5000);
  assert.equal(retryDelayMs({ ...base, attempt: 3, retryAfter: null }), 20000);
  assert.equal(
    retryDelayMs({ ...base, retryAfter: new Date(30_000).toUTCString() }),
    30000,
  );
});

test("the script imports only node: built-ins and the small shared library, never another monitor (a load error there would end the run before it can report it)", () => {
  // It once imported the 6,000 lines of new-exam-check.mjs for one constant.
  const source = readFileSync(script, "utf8");
  const specifiers = [
    ...source.matchAll(/^import [^;]*? from "([^"]+)";/gm),
  ].map((match) => match[1]);
  assert.ok(specifiers.length >= 8, `${specifiers.length} imports were found`);
  for (const specifier of specifiers) {
    assert.match(
      specifier,
      /^(?:node:[a-z/]+|\.\/lib\/[\w-]+\.mjs)$/,
      specifier,
    );
  }
  assert.ok(specifiers.includes("./lib/areas.mjs"));
});

test("only a definite HTTP answer counts as evidence about the feed", () => {
  for (const status of [400, 404, 410, 418]) {
    assert.equal(isDefiniteStatus(status), true, String(status));
  }
  for (const status of [
    200, 301, 401, 403, 405, 406, 407, 408, 429, 500, 503,
  ]) {
    assert.equal(isDefiniteStatus(status), false, String(status));
  }
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
test("the real feed fixture is read: RSS 2.0, 9 items, ids, dates, titles", () => {
  const parsed = parseFeed(FIXTURE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "rss");
  assert.equal(parsed.items.length, 9);

  const { posts, skipped } = feedPosts(parsed);
  assert.equal(skipped, 0);
  assert.equal(posts.length, 9);
  const first = posts[0];
  assert.equal(
    first.title,
    "New accessibility updates for Microsoft Certification exams",
  );
  assert.equal(first.pubDate, "2026-10-12T19:08:20Z");
  assert.equal(first.key, "tc:4528354");
  assert.equal(first.id, first.link, "the guid is the permalink");
  assert.ok(
    first.summary.startsWith("Preparing for a Microsoft Certification exam?"),
  );
  assert.ok(first.summary.length <= 600);
  assert.ok(first.bodyBlocks.length > 3);
  assert.deepEqual(first.categories, [], "the real feed has no categories");
  assert.ok(posts.every((post) => /^tc:\d+$/.test(post.key)));
  assert.ok(
    posts.every((post) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(post.pubDate),
    ),
  );
  // Entities are decoded twice (the description is escaped HTML), tags are gone.
  assert.ok(!first.bodyBlocks.join(" ").includes("&nbsp;"));
  assert.ok(!first.bodyBlocks.join(" ").includes("<P"));
});

test("the same feed with CRLF line ends reads identically (the real one has them)", () => {
  const lf = postsOf(FIXTURE);
  const crlf = postsOf(FIXTURE.replace(/\n/g, "\r\n"));
  assert.deepEqual(
    crlf.map((p) => [p.key, p.title, p.pubDate, p.matched]),
    lf.map((p) => [p.key, p.title, p.pubDate, p.matched]),
  );
});

test("the relevance filter, applied to the real posts, finds the announcements and not the rest", () => {
  const relevant = postsOf(FIXTURE)
    .filter((post) => post.matched)
    .map((post) => post.title);
  assert.deepEqual(relevant, [
    "New accessibility updates for Microsoft Certification exams",
    "Updates to Azure Cosmos DB and Power Platform Developer Certifications",
    "New Microsoft 365 Certified: AI Services Administrator Associate Certification",
    "New exam for Microsoft Certified: Windows Server Administrator Associate Certification",
    "Microsoft Credentials roundup: June 2026",
    "New ways to learn and demonstrate skills",
    "New Microsoft Certified: Dynamics 365 Contact Center AI Engineer Associate Certification",
  ]);
  const quiet = postsOf(FIXTURE)
    .filter((post) => !post.matched)
    .map((post) => post.title);
  assert.deepEqual(quiet, [
    "AI-powered + human-focused: Powering workforce transformation",
    "Microsoft AI Skills Fest wraps—and the momentum continues",
  ]);
});

test("a post matches on its title, its summary (the teaser) or its categories; in the rest of the article only the stricter words count", () => {
  assert.equal(
    isRelevant({ title: "Beta news", summary: "", categories: [] }),
    true,
  );
  assert.equal(
    isRelevant({
      title: "Team news",
      summary: "A new voucher is here.",
      categories: [],
    }),
    true,
  );
  assert.equal(
    isRelevant({
      title: "Team news",
      summary: "Nothing.",
      categories: ["Certification"],
    }),
    true,
  );
  assert.equal(
    isRelevant({ title: "Team news", summary: "Nothing.", categories: [] }),
    false,
  );
  // Every alternative of the documented filter.
  for (const term of RELEVANCE_RE.source.split("|")) {
    assert.equal(
      isRelevant({
        title: `a ${term.toUpperCase()} b`,
        summary: "",
        categories: [],
      }),
      true,
      term,
    );
  }

  // The summary is the first 600 characters: a broad word deep in the article
  // does not count (matching them anywhere matched 19 of the 20 live posts)...
  const filler = "Team stories and fun events. ".repeat(40);
  const deep = rss([
    itemXml({
      id: 1,
      title: "Quiet one",
      html: `<p>${filler}A discount on swag, a badge and a certification.</p>`,
    }),
    itemXml({
      id: 2,
      title: "Quiet two",
      html: `<p>A discount on swag. ${filler}</p>`,
    }),
  ]);
  const [late, early] = postsOf(deep);
  assert.equal(late.matched, false, "broad words after the summary");
  assert.equal(early.matched, true, "'discount' in the teaser");
  assert.ok(
    late.bodyBlocks.join(" ").includes("certification"),
    "still in the body for the codes",
  );

  // ...but the stricter words count anywhere in the article: a voucher, a
  // retirement, a beta exam, an exam code.
  for (const [html, term] of [
    [`<p>${filler}A Voucher is inside.</p>`, "voucher"],
    [`<p>${filler}This exam will retire in May.</p>`, "retir"],
    [`<p>${filler}The retirement is announced.</p>`, "retir"],
    [`<p>${filler}Take the beta exam today.</p>`, "beta"],
  ]) {
    const [post] = postsOf(
      rss([itemXml({ id: 3, title: "Team stories", html })]),
    );
    assert.equal(post.matched, true, term);
    assert.deepEqual(matchedDetails(post).articleOnly, [term], term);
    assert.deepEqual(matchedDetails(post).broadTerms, [], term);
  }
  const [code] = postsOf(
    rss([
      itemXml({
        id: 4,
        title: "Team stories",
        html: `<p>${filler}The new AB‑650 is out.</p>`,
      }),
    ]),
  );
  assert.equal(code.matched, true, "an exam code in the article");
  assert.equal(matchedDetails(code).code, true);
  // Words that are only similar do not count: "beta" alone, "retired" as in a
  // person, a version like GPT-4 or a phone number.
  const [calm] = postsOf(
    rss([
      itemXml({
        id: 5,
        title: "Team stories",
        html: `<p>${filler}Our beta-tester Jo, a retiree, uses GPT-4 and room 12-345.</p>`,
      }),
    ]),
  );
  assert.equal(calm.matched, false);
  // The pieces: the broad filter alone does not look at the article.
  assert.equal(
    isRelevant({ title: "Team news", summary: "Nothing.", categories: [] }),
    false,
  );
  assert.equal(
    isRelevant({
      title: "Team news",
      summary: "Nothing.",
      categories: [],
      bodyBlocks: ["There is a voucher in the fourth section."],
    }),
    true,
  );
});

test("two real posts that announce exam vouchers deep in the article are relevant, and the report says where the match is", () => {
  // Live on 2026-10-14: the teaser of both posts is about a skills festival, the
  // free exam voucher comes in the article ("Free Microsoft Certification exam
  // vouchers" in the wrap-up, "a voucher for select Certification exams" in the
  // other). The broad filter on the title and teaser missed both.
  const posts = postsOf(
    readFileSync(
      join(root, "tests/fixtures/skills-hub/feed-voucher-in-article.xml"),
      "utf8",
    ),
  );
  assert.deepEqual(
    posts.map((post) => [post.title.slice(0, 20), post.matched]),
    [
      ["Microsoft AI Skills ", true],
      ["AI Skills Fest is ju", true],
    ],
  );
  for (const post of posts) {
    const details = matchedDetails(post);
    assert.deepEqual(details.broadTerms, [], post.title);
    assert.deepEqual(details.articleOnly, ["voucher"], post.title);
    assert.deepEqual(matchedTerms(post), ["voucher"]);
  }
  const report = buildReport(posts, emptyContext);
  assert.match(
    report,
    /- Matched on `voucher` in the article text only: the title and the teaser do not mention it, so read the whole post/,
  );
  // The checklist reads the stricter term too: a voucher page is on it.
  assert.match(report, /Voucher or discount: add or update the voucher page/);

  // The 9 posts of the older fixture keep their verdicts: the two it holds
  // without a match have nothing in their (trimmed) article either.
  assert.deepEqual(
    postsOf(FIXTURE)
      .filter((post) => !post.matched)
      .map((post) => post.title),
    [
      "AI-powered + human-focused: Powering workforce transformation",
      "Microsoft AI Skills Fest wraps—and the momentum continues",
    ],
  );
});

test("a post relevant only through its article text is reported with the stricter terms in its checklist, and a broad match lists what the article adds", () => {
  const filler = "Team stories and fun events. ".repeat(40);
  const [both] = postsOf(
    rss([
      itemXml({
        id: 6,
        title: "A new exam for administrators",
        html: `<p>${filler}The old exam will retire in May.</p>`,
      }),
    ]),
  );
  const details = matchedDetails(both);
  assert.deepEqual(details.broadTerms, ["exam"]);
  assert.deepEqual(details.articleOnly, ["retir"]);
  assert.deepEqual(details.terms, ["exam", "retir"]);
  const report = buildReport([both], emptyContext);
  assert.match(
    report,
    /- Matched the relevance filter on: `exam`; also in the article text: `retir`/,
  );
  assert.match(report, /Retirement or transition: follow the retirement rules/);
});

test("matched terms name the alternatives of the filter that occur", () => {
  assert.deepEqual(
    matchedTerms({
      title: "New exam (beta) with a Voucher",
      summary: "retirement of AZ-800",
      categories: [],
    }),
    ["exam", "retir", "beta", "voucher"],
  );
});

test("CDATA, Atom, RSS 1.0, categories and double-escaped entities are understood", () => {
  const cdata = `<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title><![CDATA[Fish & <b>chips</b> exam]]></title>
    <link>https://techcommunity.microsoft.com/t5/b/slug/ba-p/4500001</link>
    <description><![CDATA[<p>5 &lt; 6 &amp; <a href="https://x.example">link</a></p><script>alert(1)</script>]]></description>
    <category>Certification</category><category><![CDATA[Skills & more]]></category>
    <dc:subject>Credentials</dc:subject>
    <pubDate>Mon, 12 Oct 2026 19:08:20 +0200</pubDate>
  </item></channel></rss>`;
  const [c] = feedPosts(parseFeed(cdata)).posts;
  assert.equal(c.title, "Fish & chips exam");
  assert.equal(c.bodyBlocks.join(" "), "5 < 6 & link");
  assert.deepEqual(c.categories, [
    "Certification",
    "Skills & more",
    "Credentials",
  ]);
  assert.equal(
    c.pubDate,
    "2026-10-12T17:08:20Z",
    "a time zone offset is applied",
  );
  assert.equal(c.key, "tc:4500001", "no guid: the link is the id");
  assert.equal(c.id, c.link);

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
    <entry><title type="html">Atom &amp;amp; beta</title>
      <id>tag:example.com,2026:4500002</id>
      <link rel="self" href="https://example.com/self"/>
      <link rel="alternate" href="https://techcommunity.microsoft.com/blog/b/slug/4500002"/>
      <published>2026-10-01T10:00:00Z</published><updated>2026-10-02T10:00:00Z</updated>
      <summary type="html">&lt;p&gt;Teaser&lt;/p&gt;</summary>
      <content type="html">&lt;p&gt;Teaser and the whole body AB-650&lt;/p&gt;</content>
      <category term="Exams" label="Exam news"/><category term="beta"/>
    </entry></feed>`;
  const parsedAtom = parseFeed(atom);
  assert.equal(parsedAtom.ok, true);
  assert.equal(parsedAtom.format, "atom");
  const [a] = feedPosts(parsedAtom).posts;
  assert.equal(
    a.title,
    "Atom & beta",
    "a title of type html is HTML: read as text",
  );
  assert.equal(
    a.link,
    "https://techcommunity.microsoft.com/blog/b/slug/4500002",
  );
  assert.equal(a.id, "tag:example.com,2026:4500002");
  assert.equal(
    a.key,
    "tc:4500002",
    "the numeric id of the link identifies the post",
  );
  assert.equal(a.pubDate, "2026-10-01T10:00:00Z", "published before updated");
  assert.equal(a.summary, "Teaser");
  assert.deepEqual(a.bodyBlocks, ["Teaser and the whole body AB-650"]);
  assert.deepEqual(a.categories, ["Exam news", "beta"]);

  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
    <channel><title>x</title><items><rdf:Seq/></items></channel>
    <item><title>Old style</title><link>https://example.com/a</link><description>Text</description></item></rdf:RDF>`;
  const parsedRdf = parseFeed(rdf);
  assert.equal(parsedRdf.ok, true);
  assert.equal(parsedRdf.items.length, 1);
  assert.equal(feedPosts(parsedRdf).posts[0].key, "https://example.com/a");
});

test("a document that is not an RSS or Atom feed is rejected with a reason", () => {
  const cases = [
    ["", /empty/],
    ["   \n  ", /empty/],
    ["just some text", /not XML/],
    ['{"items": []}', /not XML/],
    [
      "<!DOCTYPE html><html><body>Verifying you are human</body></html>",
      /<html>, not an RSS or Atom feed/,
    ],
    [
      '<?xml version="1.0"?><error>nope</error>',
      /<error>, not an RSS or Atom feed/,
    ],
  ];
  for (const [text, reason] of cases) {
    const parsed = parseFeed(text);
    assert.equal(parsed.ok, false, text);
    assert.match(parsed.reason, reason, text);
  }
  // A BOM, a DOCTYPE and a comment before the root are fine.
  const odd =
    "\uFEFF<?xml version='1.0'?><!-- c --><!DOCTYPE rss [<!ENTITY x 'y'>]><rss version='2.0'><channel><item><title>T</title><link>https://example.com/p</link></item></channel></rss>";
  assert.equal(parseFeed(odd).ok, true);
  assert.equal(parseFeed(odd).items.length, 1);
  // Items inside a comment are not items.
  const hidden =
    "<rss><channel><!-- <item><title>Gone</title></item> --></channel></rss>";
  assert.equal(parseFeed(hidden).items.length, 0);
  // A feed without items is a feed with 0 items (the size check judges it).
  assert.deepEqual(
    parseFeed("<rss><channel><title>x</title></channel></rss>").items,
    [],
  );
});

test("an item without a title or without an id is skipped and counted, duplicates collapse", () => {
  const xml = rss([
    itemXml({ id: 4500001, title: "One" }),
    "    <item><title></title><link>https://example.com/no-title</link></item>\n",
    "    <item><title>No id</title></item>\n",
    "    <item><title>Not a url</title><link>javascript:alert(1)</link></item>\n",
    itemXml({ id: 4500001, slug: "renamed", title: "One again, edited" }),
    itemXml({ id: 4500002, title: "Two" }),
  ]);
  const { posts, skipped } = feedPosts(parseFeed(xml));
  assert.equal(skipped, 3);
  assert.deepEqual(
    posts.map((p) => p.title),
    ["One", "Two"],
  );
});

test("dates: RFC 822 and ISO are read, nonsense is null", () => {
  assert.equal(
    parseDate("Mon, 12 Oct 2026 19:08:20 GMT"),
    "2026-10-12T19:08:20Z",
  );
  assert.equal(
    parseDate("2026-10-12T19:08:20.123+00:00"),
    "2026-10-12T19:08:20Z",
  );
  assert.equal(parseDate(" 2026-10-12 "), "2026-10-12T00:00:00Z");
  for (const bad of [
    "",
    "soon",
    "Mon, 99 Foo 2026",
    "0001-01-01",
    "9999-01-01",
    null,
    undefined,
  ]) {
    assert.equal(parseDate(bad), null, String(bad));
  }
});

test("a post is identified by its numeric Tech Community id, so an edited title never makes it new", () => {
  const a =
    "https://techcommunity.microsoft.com/t5/the-skills-hub-blog/old-title/ba-p/4528354";
  const b =
    "https://techcommunity.microsoft.com/t5/the-skills-hub-blog/new-title/ba-p/4528354?x=1#top";
  const c =
    "https://techcommunity.microsoft.com/blog/skills-hub-blog/another-slug/4528354";
  assert.equal(postKey(a), "tc:4528354");
  assert.equal(postKey(b), "tc:4528354");
  assert.equal(postKey(c), "tc:4528354");
  assert.equal(
    postKey("some-opaque-guid", a),
    "tc:4528354",
    "a numeric id in the link wins over an opaque guid",
  );
  // Other feeds: the guid, else the link, lowercased, without fragment and trailing slash.
  assert.equal(
    postKey("https://Example.com/Post/#frag"),
    "https://example.com/post",
  );
  assert.equal(postKey("", "https://example.com/p/"), "https://example.com/p");
  assert.equal(postKey("", ""), "");
  assert.notEqual(
    postKey("https://example.com/a?p=1"),
    postKey("https://example.com/a?p=2"),
  );
});

test("html becomes text blocks: tags, scripts, comments and entities are gone", () => {
  assert.deepEqual(
    htmlToBlocks(
      "<H4><EM>Lead &amp; teaser</EM></H4>\n<P>&nbsp;</P><P>5 &lt; 6 &amp; more&nbsp;text<br>next</P>" +
        '<UL><LI>One</LI><LI>Two <A HREF="x">link</A></LI></UL><!-- hidden --><script>var a = 1;</script>' +
        "<img><P>soft\u00adhy\u200bphen</P>",
    ),
    [
      "Lead & teaser",
      "5 < 6 & more text",
      "next",
      "One",
      "Two link",
      "softhyphen",
    ],
  );
  // Entities are decoded once: escaped markup stays text and is never turned into a tag.
  assert.deepEqual(
    htmlToBlocks("<p>&amp;lt;b&amp;gt; and &lt;b&gt;bold&lt;/b&gt;</p>"),
    ["&lt;b&gt; and <b>bold</b>"],
  );
  assert.equal(
    decodeEntities("&amp;lt; &#x41;&#66; &bogus; &constructor;"),
    "&lt; AB &bogus; &constructor;",
  );
});

test("exam codes: two or three capitals, a hyphen, three digits; courses and noise are not codes", () => {
  assert.deepEqual(
    extractExamCodes(
      "AZ-800 and AZ-801, GH-600, ab-650 (lower case no), AZ-800T00 (a course), COVID-19, SHA-256, B-100, ABCD-100, PL-400 to AB-400, AZ-800 again",
    ),
    ["AB-400", "AZ-800", "AZ-801", "GH-600", "PL-400", "SHA-256"],
  );
  assert.deepEqual(extractExamCodes(""), []);
  // The posts often write the hyphen as a non-breaking one (U+2011) or a dash.
  assert.deepEqual(
    extractExamCodes(
      "Exam AB‑250 (beta), AZ–802, PL−400 and AI‐901 but not X‑100 or ABCD‑100",
    ),
    ["AB-250", "AI-901", "AZ-802", "PL-400"],
  );
});

test("sentences with a date and an exam, beta, voucher or availability are quoted, strongest first", () => {
  const blocks = [
    "Generally available in July 2026.",
    "The class begins on 4 November 2026 and covers the new skills.",
    "You may 3 times retry. The exam is available October 16, 2026.",
    "The first 300 people who take Exam AB-777 (beta) on or before December 1, 2026, can get 80% off.",
    "The first 300 people who take Exam AB-777 (beta) on or before December 1, 2026, can get 80% off.",
    "No date here but an exam and a voucher.",
    "Registration for PL-400 closes Oct 16 and Exam AB-400 opens.",
  ];
  const found = datedStatements(blocks, { max: 10 });
  // Strong ones (beta, voucher, retirement, registration, "generally available")
  // first, each group in the order of the post; a repeated sentence once.
  assert.deepEqual(found, [
    "Generally available in July 2026.",
    "The first 300 people who take Exam AB-777 (beta) on or before December 1, 2026, can get 80% off.",
    "Registration for PL-400 closes Oct 16 and Exam AB-400 opens.",
    "The class begins on 4 November 2026 and covers the new skills.",
    "The exam is available October 16, 2026.",
  ]);
  assert.equal(datedStatements(blocks, { max: 2 }).length, 2);
  assert.deepEqual(datedStatements(blocks, { max: 0 }), []);
  assert.ok(
    datedStatements(["x ".repeat(400) + "exam on October 16, 2026."], {
      max: 1,
      maxChars: 80,
    })[0].length <= 80,
  );
  // "may" the verb is not the month.
  assert.deepEqual(datedStatements(["The exam may 3 times fail."]), []);
  // A date alone is not enough: the sentence has to talk about an exam, a beta, a
  // voucher, a retirement or an availability. Dates of a festival, a webinar or a
  // team lunch are noise in an issue that asks for dates to be verified.
  assert.deepEqual(
    datedStatements([
      "The festival took place on June 8, 2026 in Seattle.",
      "Our team met for lunch on 4 November 2026.",
      "Join the webinar on October 16.",
    ]),
    [],
  );
  assert.deepEqual(
    datedStatements([
      "The festival took place on June 8, 2026 in Seattle.",
      "The voucher can be claimed until June 30, 2026.",
    ]),
    ["The voucher can be claimed until June 30, 2026."],
  );
});

test("httpUrl keeps only http and https URLs", () => {
  assert.equal(httpUrl(" https://example.com/a "), "https://example.com/a");
  assert.equal(httpUrl("http://example.com"), "http://example.com");
  for (const bad of [
    "javascript:alert(1)",
    "ftp://x/y",
    "//x/y",
    "https://",
    "",
    "https://a b",
    null,
  ]) {
    assert.equal(httpUrl(bad), "", String(bad));
  }
});

// ---------------------------------------------------------------------------
// Hub context
// ---------------------------------------------------------------------------
async function hubDirs() {
  const dir = await mkdtemp(join(tmpdir(), "skills-hub-ctx-"));
  const docs = join(dir, "docs");
  await mkdir(join(docs, "aibusiness"), { recursive: true });
  await mkdir(join(docs, "azure"), { recursive: true });
  await mkdir(join(docs, "vouchers"), { recursive: true });
  await writeFile(
    join(docs, "aibusiness", "AB-650.mdx"),
    "---\ntitle: x\n---\n",
  );
  await writeFile(join(docs, "azure", "AZ-802.mdx"), "---\ntitle: x\n---\n");
  await writeFile(join(docs, "azure", "notes.mdx"), "not an exam page");
  await writeFile(
    join(docs, "vouchers", "ab650beta.mdx"),
    "---\ntitle: Exam AB-650 (beta)\nvoucherCategory: Special\nlinkedExam: AB-650\nvoucherEnds: 2026-08-18\n---\nBody\n",
  );
  await writeFile(
    join(docs, "vouchers", "other.mdx"),
    '---\ntitle: Other\nlinkedExam: "AZ-802"\n---\nBody\n',
  );
  await writeFile(
    join(docs, "vouchers", "none.mdx"),
    "---\ntitle: None\n---\nlinkedExam: AB-999 in the body\n",
  );
  const status = join(dir, "exam-status.mjs");
  await writeFile(
    status,
    'export const examStatuses = { aibusiness: { "AB-650": { text: "BETA", variant: "tip" } }, azure: { "AZ-800": { text: "RETIRING", variant: "danger" } } };\n',
  );
  const learn = join(dir, "learn-exams.json");
  await writeFile(
    learn,
    JSON.stringify({
      exams: [{ code: "AB-650" }, { code: "ab-777" }, { code: "AZ-802" }],
    }),
  );
  const beta = join(dir, "beta-exams.json");
  await writeFile(
    beta,
    JSON.stringify({
      exams: [
        { code: "AZ-802", betaStart: "2026-10-14", announcement: "pending" },
        {
          code: "AB-650",
          betaStart: "2026-07-28",
          announcement: `${BETA_POST_URL}?WT.mc_id=studentamb_165290`,
        },
      ],
    }),
  );
  return { dir, docs, status, learn, beta };
}

test("the hub context reads exam pages, statuses, the Learn tracker, voucher pages and the beta exams that wait for a post", async () => {
  const { dir, docs, status, learn, beta } = await hubDirs();
  try {
    const ctx = await loadHubContext(
      cfgOf({
        docsDir: docs,
        examStatusFile: status,
        learnTrackerFile: learn,
        betaExamsFile: beta,
      }),
    );
    assert.deepEqual([...ctx.pages.entries()].sort(), [
      ["AB-650", "aibusiness"],
      ["AZ-802", "azure"],
    ]);
    assert.equal(ctx.statuses.get("AB-650"), "BETA");
    assert.equal(ctx.statuses.get("AZ-800"), "RETIRING");
    assert.deepEqual([...ctx.learn].sort(), ["AB-650", "AB-777", "AZ-802"]);
    assert.deepEqual(ctx.vouchers.get("AB-650"), ["vouchers/ab650beta"]);
    assert.deepEqual(ctx.vouchers.get("AZ-802"), ["vouchers/other"]);
    assert.equal(
      ctx.vouchers.has("AB-999"),
      false,
      "only the frontmatter counts",
    );
    assert.deepEqual(
      [...ctx.betaWaiting.values()],
      [{ code: "AZ-802", state: "pending", betaStart: "2026-10-14" }],
      "AB-650 has its announcement already",
    );
    assert.deepEqual(ctx.notes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub context that cannot be read is reported as unknown, without file paths, and never throws", async () => {
  const { dir, docs, beta } = await hubDirs();
  try {
    await writeFile(join(dir, "broken.mjs"), "export const examStatuses = ;\n");
    await writeFile(join(dir, "bad.json"), "{ nope");
    const missingLearn = await loadHubContext(
      cfgOf({
        docsDir: docs,
        examStatusFile: join(dir, "missing.mjs"),
        learnTrackerFile: join(dir, "missing.json"),
        betaExamsFile: beta,
      }),
    );
    assert.equal(missingLearn.statuses, null);
    assert.equal(missingLearn.learn, null);
    assert.equal(missingLearn.notes.length, 2);
    assert.match(missingLearn.notes[0], /exam-status\.mjs.*file not found/);
    assert.match(missingLearn.notes[1], /does not exist yet.*New Exam Monitor/);

    const broken = await loadHubContext(
      cfgOf({
        docsDir: docs,
        examStatusFile: join(dir, "broken.mjs"),
        learnTrackerFile: join(dir, "bad.json"),
        betaExamsFile: beta,
      }),
    );
    assert.match(broken.notes[0], /invalid JSON or script/);
    assert.match(broken.notes[1], /invalid JSON/);
    for (const note of [...missingLearn.notes, ...broken.notes]) {
      assert.ok(!note.includes(dir), "no absolute path in an issue text");
    }

    const noDocs = await loadHubContext(
      cfgOf({ docsDir: join(dir, "nowhere"), betaExamsFile: beta }),
    );
    assert.equal(noDocs.pages.size, 0);
    assert.match(noDocs.notes[0], /no exam page was found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a beta tracker that cannot be read is said in the notes, without a file path, and never throws", async () => {
  const { dir, docs, status, learn } = await hubDirs();
  try {
    const base = {
      docsDir: docs,
      examStatusFile: status,
      learnTrackerFile: learn,
    };
    const read = async (betaExamsFile) =>
      loadHubContext(cfgOf({ ...base, betaExamsFile }));

    const missing = await read(join(dir, "missing.json"));
    assert.equal(missing.betaWaiting, null);
    assert.deepEqual(missing.notes, [
      "`beta-exams.json` does not exist, so it is not known which beta exam is waiting for its announcement post",
    ]);

    await writeFile(join(dir, "bad-beta.json"), "{ nope");
    const invalid = await read(join(dir, "bad-beta.json"));
    assert.equal(invalid.betaWaiting, null);
    assert.match(
      invalid.notes[0],
      /^`beta-exams\.json` could not be read \(invalid JSON or script\), so it is not known which beta exam is waiting for its announcement post$/,
    );

    await writeFile(join(dir, "no-list.json"), JSON.stringify({ exams: {} }));
    const noList = await read(join(dir, "no-list.json"));
    assert.equal(noList.betaWaiting, null);
    assert.match(noList.notes[0], /could not be read \(unreadable\)/);
    for (const context of [missing, invalid, noList]) {
      assert.equal(context.notes.length, 1, "the rest of the context is fine");
      assert.ok(!context.notes[0].includes(dir), "no absolute path");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real repository context lists the hub exam pages", async () => {
  const ctx = await loadHubContext(loadConfig({ TODAY }));
  assert.ok(ctx.pages.size > 20, `${ctx.pages.size} exam pages`);
  assert.ok(ctx.statuses instanceof Map);
  assert.ok(ctx.betaWaiting instanceof Map, "the beta tracker is read");
  for (const [, area] of ctx.pages) {
    assert.ok(Object.values(AREA_BY_PREFIX).includes(area));
  }
});

test("exam codes are split by what the hub and Learn know about them", () => {
  const ctx = {
    pages: new Map([
      ["AB-650", "aibusiness"],
      ["AZ-800", "azure"],
    ]),
    statuses: new Map([["AB-650", "BETA"]]),
    learn: new Set(["AB-700"]),
    vouchers: new Map([["AB-650", ["vouchers/ab650beta"]]]),
    notes: [],
  };
  const groups = classifyCodes(
    ["AB-650", "AB-700", "AB-777", "AZ-800", "MO-100", "SHA-256"],
    ctx,
  );
  assert.deepEqual(groups.withPage, [
    {
      code: "AB-650",
      area: "aibusiness",
      status: "BETA",
      vouchers: ["vouchers/ab650beta"],
    },
    { code: "AZ-800", area: "azure", status: "", vouchers: [] },
  ]);
  assert.deepEqual(groups.learnOnly, [{ code: "AB-700" }]);
  assert.deepEqual(groups.notOnLearn, [{ code: "AB-777" }]);
  assert.deepEqual(groups.other, [{ code: "MO-100" }, { code: "SHA-256" }]);
  assert.deepEqual(groups.unknown, []);

  const unknown = classifyCodes(["AB-777"], { ...ctx, learn: null });
  assert.deepEqual(unknown.unknown, [{ code: "AB-777" }]);
  // Every hub family of the New Exam Monitor is a hub family here.
  for (const prefix of Object.keys(AREA_BY_PREFIX)) {
    assert.equal(
      classifyCodes([`${prefix}-123`], { ...ctx, learn: new Set() }).other
        .length,
      0,
      prefix,
    );
  }
});

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
test("the tracker file has a fixed shape, one line per post, and survives a round trip", () => {
  const tracker = {
    lastSynced: "2026-10-12",
    problem: {
      kind: "feed",
      runs: 2,
      definite: 2,
      since: "2026-10-10",
      reportedAt: "2026-10-11",
    },
    posts: sortPosts([
      {
        id: "https://x.example/a",
        title: 'Quote " and \\ back',
        pubDate: "2026-10-01T00:00:00Z",
        matched: true,
      },
      {
        id: "guid-b",
        title: "B",
        link: "https://x.example/b",
        pubDate: null,
        matched: false,
      },
      {
        id: "https://x.example/c",
        title: "C",
        pubDate: "2026-10-05T00:00:00Z",
        matched: false,
      },
    ]),
  };
  const text = trackerContent(tracker);
  assert.ok(text.endsWith("}\n"));
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith('    {"id"')).length, 3);
  assert.equal(lines[1], '  "lastSynced": "2026-10-12",');
  assert.equal(
    lines[2],
    '  "problem": {"kind":"feed","runs":2,"definite":2,"since":"2026-10-10","reportedAt":"2026-10-11"},',
  );
  JSON.parse(text);
  assert.equal(
    trackerContent(normalizeTracker(JSON.parse(text))),
    text,
    "byte-stable",
  );

  // Newest first, undated last.
  assert.deepEqual(
    JSON.parse(text).posts.map((p) => p.title),
    ["C", 'Quote " and \\ back', "B"],
  );
  assert.equal(
    trackerContent(emptyTracker()),
    '{\n  "lastSynced": null,\n  "problem": null,\n  "posts": []\n}\n',
  );
  assert.deepEqual(
    normalizeTracker(JSON.parse(trackerContent(emptyTracker()))),
    emptyTracker(),
  );
});

test("a damaged tracker is rejected with a reason", () => {
  const ok = { lastSynced: "2026-10-01", problem: null, posts: [] };
  assert.doesNotThrow(() => normalizeTracker(ok));
  const post = {
    id: "https://x.example/a",
    title: "A",
    pubDate: null,
    matched: true,
  };
  const bad = [
    [null, /missing posts array/],
    [{ posts: "no" }, /missing posts array/],
    [{ posts: [null] }, /not an object/],
    [{ posts: [{ ...post, id: "" }] }, /no id/],
    [{ posts: [{ ...post, title: 3 }] }, /no title/],
    [{ posts: [{ ...post, matched: "yes" }] }, /no matched flag/],
    [{ posts: [{ ...post, pubDate: 5 }] }, /malformed pubDate/],
    [
      { posts: [post, { ...post, title: "Same post again" }] },
      /repeats the post/,
    ],
    [
      {
        posts: [],
        problem: { kind: "nope", runs: 1, definite: 0, since: "2026-10-01" },
      },
      /malformed problem/,
    ],
    [
      {
        posts: [],
        problem: { kind: "feed", runs: 0, definite: 0, since: "2026-10-01" },
      },
      /malformed problem/,
    ],
    [
      {
        posts: [],
        problem: { kind: "feed", runs: 1, definite: 0, since: "yesterday" },
      },
      /malformed problem/,
    ],
    [
      {
        posts: [],
        problem: {
          kind: "feed",
          runs: 1,
          definite: 0,
          since: "2026-10-01",
          reportedAt: "x",
        },
      },
      /malformed problem/,
    ],
  ];
  for (const [value, reason] of bad) {
    assert.throws(
      () => normalizeTracker(value),
      (error) => {
        assert.ok(error instanceof ExtractionError);
        assert.match(error.message, reason);
        return true;
      },
    );
  }
  // Two entries of the same Tech Community post are one post.
  assert.throws(
    () =>
      normalizeTracker({
        posts: [
          {
            ...post,
            id: "https://techcommunity.microsoft.com/t5/b/a/ba-p/4500001",
          },
          {
            ...post,
            id: "https://techcommunity.microsoft.com/t5/b/renamed/ba-p/4500001",
          },
        ],
      }),
    /repeats the post/,
  );
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
test("the first read is a silent baseline: every post is recorded, none is reported", () => {
  const posts = [
    mkPost(3, { matched: true }),
    mkPost(2),
    mkPost(1, { matched: true }),
  ];
  const result = applyFeed(emptyTracker(), posts, cfgOf());
  assert.equal(result.baseline, true);
  assert.deepEqual(result.relevant, []);
  assert.equal(result.news.length, 3);
  assert.equal(result.changed, true);
  assert.equal(result.tracker.lastSynced, TODAY);
  assert.deepEqual(
    result.tracker.posts.map((p) => p.title),
    ["Post 3", "Post 2", "Post 1"],
  );
});

test("a second read of the same feed changes nothing, byte for byte", () => {
  const posts = [mkPost(3), mkPost(2, { matched: true }), mkPost(1)];
  const first = applyFeed(
    emptyTracker(),
    posts,
    cfgOf({ today: "2026-10-01" }),
  );
  const text = trackerContent(first.tracker);
  const second = applyFeed(
    normalizeTracker(JSON.parse(text)),
    posts,
    cfgOf({ today: "2026-10-09" }),
  );
  assert.equal(second.changed, false);
  assert.equal(second.baseline, false);
  assert.deepEqual(second.relevant, []);
  assert.equal(trackerContent(second.tracker), text, "lastSynced did not move");
  // The same feed in another order is the same feed.
  const shuffled = applyFeed(
    normalizeTracker(JSON.parse(text)),
    [...posts].reverse(),
    cfgOf(),
  );
  assert.equal(trackerContent(shuffled.tracker), text);
});

test("a new relevant post is reported; a new unrelated one is recorded without a report", () => {
  const known = [mkPost(10), mkPost(9)];
  const tracker = trackerOf(known);
  const relevant = mkPost(12, {
    matched: true,
    title: "New exam AB-777 (beta)",
  });
  const quiet = mkPost(11);
  const result = applyFeed(tracker, [relevant, quiet, ...known], cfgOf());
  assert.equal(result.baseline, false);
  assert.deepEqual(
    result.relevant.map((p) => p.title),
    ["New exam AB-777 (beta)"],
  );
  assert.deepEqual(
    result.news.map((p) => p.title),
    ["New exam AB-777 (beta)", "Post 11"],
  );
  assert.equal(result.changed, true);
  assert.equal(result.tracker.lastSynced, TODAY);
  assert.deepEqual(
    result.tracker.posts.map((p) => [p.title, p.matched]),
    [
      ["New exam AB-777 (beta)", true],
      ["Post 11", false],
      ["Post 10", false],
      ["Post 9", false],
    ],
  );
  // Reported once: the next read of the same feed finds nothing new.
  const again = applyFeed(result.tracker, [relevant, quiet, ...known], cfgOf());
  assert.deepEqual(again.relevant, []);
  assert.equal(again.changed, false);
});

test("an edited title or slug of a known post is not a new post", () => {
  const tracker = trackerOf([mkPost(5, { matched: true }), mkPost(4)]);
  const edited = mkPost(5, {
    matched: true,
    title: "A better title",
    id: "https://techcommunity.microsoft.com/t5/the-skills-hub-blog/a-better-title/ba-p/4000005",
    link: "https://techcommunity.microsoft.com/t5/the-skills-hub-blog/a-better-title/ba-p/4000005",
  });
  const result = applyFeed(tracker, [edited, mkPost(4)], cfgOf());
  assert.equal(result.fresh.length, 0);
  assert.equal(result.changed, false);
  assert.equal(trackerContent(result.tracker), trackerContent(tracker));
});

test("a stale snapshot's old posts are neither reported nor recorded; the 30 day boundary is exact", () => {
  // Verified live: a 2 June post turned up as new on the third run because the
  // CDN served a snapshot whose window of 20 reached further back.
  const known = [mkPost(28), mkPost(27)];
  const tracker = trackerOf(known);
  const oldPost = mkPost(1, {
    matched: true,
    pubDate: "2026-06-02T19:46:59Z",
    title: "Turn up the volume",
  });
  const result = applyFeed(tracker, [...known, oldPost], cfgOf());
  assert.deepEqual(
    result.older.map((p) => p.title),
    ["Turn up the volume"],
  );
  assert.deepEqual(result.news, []);
  assert.deepEqual(result.relevant, []);
  assert.equal(result.changed, false);
  assert.equal(
    trackerContent(result.tracker),
    trackerContent(tracker),
    "no commit for it",
  );

  // newest 2026-09-28T12:00Z minus 30 days = 2026-08-29T12:00Z, strictly older only.
  const exactly = mkPost(2, { matched: true, pubDate: "2026-08-29T12:00:00Z" });
  const before = mkPost(3, { matched: true, pubDate: "2026-08-29T11:59:59Z" });
  const boundary = applyFeed(tracker, [...known, exactly, before], cfgOf());
  assert.deepEqual(
    boundary.news.map((p) => p.title),
    ["Post 2"],
  );
  assert.deepEqual(
    boundary.older.map((p) => p.title),
    ["Post 3"],
  );
  assert.deepEqual(
    boundary.relevant.map((p) => p.title),
    ["Post 2"],
  );

  // Off: every unseen post is new.
  const off = applyFeed(
    tracker,
    [...known, oldPost],
    cfgOf({ oldPostDays: 0 }),
  );
  assert.deepEqual(
    off.relevant.map((p) => p.title),
    ["Turn up the volume"],
  );
  // A brand-new post is never older than the newest one, and an undated one is never judged old.
  const fresh = mkPost(30, { matched: true, pubDate: "2026-09-30T08:00:00Z" });
  const undated = mkPost(31, { matched: true, pubDate: null });
  const result2 = applyFeed(tracker, [...known, fresh, undated], cfgOf());
  assert.equal(result2.relevant.length, 2);
});

test("a flood of new posts is the feed changing shape: nothing is written unless the baseline is forced", () => {
  const known = [mkPost(1)];
  const tracker = trackerOf(known);
  const flood = Array.from({ length: 11 }, (_, i) =>
    mkPost(i + 10, { title: `Flood ${i}` }),
  );
  assert.throws(
    () => applyFeed(tracker, [...known, ...flood], cfgOf()),
    (error) => {
      assert.ok(error instanceof ExtractionError);
      assert.match(
        error.message,
        /11 of the 12 posts in the feed are new at once \(limit 10\)/,
      );
      assert.match(error.message, /force_baseline/);
      assert.match(error.message, /Flood 0/);
      return true;
    },
  );
  // Exactly the limit is fine.
  const ten = applyFeed(tracker, [...known, ...flood.slice(0, 10)], cfgOf());
  assert.equal(ten.news.length, 10);
  // Forced: recorded silently.
  const forced = applyFeed(
    tracker,
    [...known, ...flood],
    cfgOf({ forceBaseline: true }),
  );
  assert.equal(forced.baseline, true);
  assert.deepEqual(forced.relevant, []);
  assert.equal(forced.tracker.posts.length, 12);
  // A different board altogether is caught the same way.
  assert.throws(
    () => applyFeed(tracker, flood, cfgOf({ maxNewPosts: 5 })),
    /new at once/,
  );
});

test("the tracker keeps the newest posts only", () => {
  const known = Array.from({ length: 5 }, (_, i) => mkPost(i + 10));
  const result = applyFeed(
    trackerOf(known),
    [...known, mkPost(20, { matched: true }), mkPost(21)],
    cfgOf({ maxTrackedPosts: 5 }),
  );
  assert.deepEqual(
    result.tracker.posts.map((p) => p.title),
    ["Post 21", "Post 20", "Post 14", "Post 13", "Post 12"],
  );
});

test("a good read ends a counted problem", () => {
  const posts = [mkPost(3), mkPost(2)];
  const tracker = trackerOf(posts, {
    problem: { kind: "fetch", runs: 3, definite: 0, since: "2026-10-12" },
  });
  const result = applyFeed(tracker, posts, cfgOf());
  assert.equal(result.tracker.problem, null);
  assert.equal(result.changed, false);
  assert.notEqual(
    trackerContent(result.tracker),
    trackerContent(tracker),
    "the cleared counter is written",
  );
  assert.equal(
    result.tracker.lastSynced,
    "2026-09-30",
    "lastSynced moves only with posts",
  );
});

// ---------------------------------------------------------------------------
// Unusable feed: the counter
// ---------------------------------------------------------------------------
const bad = (kind = "feed", definite = true) => ({ kind, definite });

test("an unreadable feed is only an alert after two definite runs, then weekly", () => {
  const cfg = cfgOf();
  let tracker = trackerOf([mkPost(1)]);

  const one = applyProblem(tracker, bad(), cfg);
  assert.equal(one.established, false);
  assert.equal(one.alert, false);
  assert.deepEqual(one.tracker.problem, {
    kind: "feed",
    runs: 1,
    definite: 1,
    since: TODAY,
  });
  assert.deepEqual(one.tracker.posts, tracker.posts, "the posts are kept");
  tracker = one.tracker;

  const two = applyProblem(tracker, bad(), cfg);
  assert.equal(two.established, true);
  assert.equal(two.alert, true);
  assert.deepEqual(two.tracker.problem, {
    kind: "feed",
    runs: 2,
    definite: 2,
    since: TODAY,
    reportedAt: TODAY,
  });
  tracker = two.tracker;

  // Further runs: still a problem, no new alert, and the tracker does not change.
  const three = applyProblem(tracker, bad(), { ...cfg, today: "2026-10-16" });
  assert.equal(three.established, true);
  assert.equal(three.alert, false);
  assert.equal(
    trackerContent(three.tracker),
    trackerContent(tracker),
    "no commit while it lasts",
  );

  // A week after the report: again.
  const week = applyProblem(tracker, bad(), { ...cfg, today: "2026-10-21" });
  assert.equal(week.alert, true);
  assert.equal(week.tracker.problem.reportedAt, "2026-10-21");
  assert.equal(week.tracker.problem.since, TODAY, "since is the first bad run");
  const sixDays = applyProblem(tracker, bad(), { ...cfg, today: "2026-10-20" });
  assert.equal(sixDays.alert, false);
});

test("a transient failure is never evidence: it takes eight runs, and a definite answer resets the other count", () => {
  const cfg = cfgOf();
  let tracker = trackerOf([mkPost(1)]);
  for (let run = 1; run <= 7; run++) {
    const step = applyProblem(tracker, bad("fetch", false), cfg);
    assert.equal(step.established, false, `run ${run}`);
    assert.equal(step.alert, false);
    tracker = step.tracker;
  }
  assert.equal(tracker.problem.runs, 7);
  assert.equal(tracker.problem.definite, 0);
  const eighth = applyProblem(tracker, bad("fetch", false), cfg);
  assert.equal(eighth.established, true);
  assert.equal(eighth.alert, true);
  assert.equal(eighth.tracker.problem.runs, 8);
  // The count stops at its threshold.
  const ninth = applyProblem(eighth.tracker, bad("fetch", false), cfg);
  assert.equal(ninth.tracker.problem.runs, 8);
  assert.equal(trackerContent(ninth.tracker), trackerContent(eighth.tracker));

  // Three transient failures, then one definite answer: one definite run, not two.
  let mixed = trackerOf([mkPost(1)]);
  for (let run = 0; run < 3; run++)
    mixed = applyProblem(mixed, bad("fetch", false), cfg).tracker;
  const definite = applyProblem(mixed, bad("feed", true), cfg);
  assert.equal(definite.tracker.problem.definite, 1);
  assert.equal(definite.established, false);
  assert.equal(
    applyProblem(definite.tracker, bad("feed", true), cfg).established,
    true,
  );
  // A transient failure between two definite ones breaks the streak.
  const broken = applyProblem(definite.tracker, bad("fetch", false), cfg);
  assert.equal(broken.tracker.problem.definite, 0);
});

test("an established problem is frozen: more bad runs change nothing, so an outage commits nothing", () => {
  const cfg = cfgOf();
  // Established by the feed itself (two definite answers): any further failure,
  // definite or transient, leaves the record untouched.
  let tracker = trackerOf([mkPost(1)]);
  tracker = applyProblem(tracker, bad("feed", true), cfg).tracker;
  tracker = applyProblem(tracker, bad("feed", true), cfg).tracker;
  const text = trackerContent(tracker);
  for (const failure of [
    bad("feed", true),
    bad("fetch", false),
    bad("gone", true),
  ]) {
    const next = applyProblem(tracker, failure, {
      ...cfg,
      today: "2026-10-15",
    });
    assert.equal(next.established, true, `${failure.kind} ${failure.definite}`);
    assert.equal(next.alert, false);
    if (failure.definite && failure.kind === "feed") {
      assert.equal(trackerContent(next.tracker), text);
    } else if (!failure.definite) {
      assert.equal(
        trackerContent(next.tracker),
        text,
        "a timeout neither ends nor deepens it",
      );
    } else {
      assert.equal(
        next.tracker.problem.kind,
        "gone",
        "a definite answer names the kind",
      );
      assert.equal(next.tracker.problem.runs, tracker.problem.runs);
    }
  }

  // Established by transient failures alone (8 runs): a further transient one
  // changes nothing, a definite one still starts counting and names the kind.
  let slow = trackerOf([mkPost(1)]);
  for (let run = 0; run < 8; run++)
    slow = applyProblem(slow, bad("fetch", false), cfg).tracker;
  assert.equal(slow.problem.runs, 8);
  const again = applyProblem(slow, bad("fetch", false), {
    ...cfg,
    today: "2026-10-15",
  });
  assert.equal(trackerContent(again.tracker), trackerContent(slow));
  assert.equal(again.established, true);
  const definite1 = applyProblem(slow, bad("feed", true), {
    ...cfg,
    today: "2026-10-15",
  });
  assert.equal(definite1.tracker.problem.kind, "feed");
  assert.equal(definite1.tracker.problem.definite, 1);
  assert.equal(definite1.established, true, "still established");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
test("the report lists the new relevant posts with codes, hub state, excerpt and dates, and a checklist", () => {
  const posts = sortPosts(postsOf(FIXTURE).filter((post) => post.matched));
  const ctx = {
    pages: new Map([
      ["AB-650", "aibusiness"],
      ["AZ-800", "azure"],
      ["AZ-802", "azure"],
    ]),
    statuses: new Map([
      ["AB-650", "BETA"],
      ["AZ-800", "RETIRING"],
    ]),
    learn: new Set(["AB-250"]),
    vouchers: new Map([["AB-650", ["vouchers/ab650beta"]]]),
    notes: [],
  };
  const report = buildReport(posts, ctx);
  assert.ok(report.endsWith("\n"));
  assert.ok(report.length < 60000);
  assert.match(report, /^## Skills Hub: 7 new posts to review/);
  assert.match(
    report,
    /### 1\. \[New accessibility updates for Microsoft Certification exams\]\(https:\/\/techcommunity\.microsoft\.com\/t5\/the-skills-hub-blog\/new-accessibility-updates-for-microsoft-certification-exams\/ba-p\/4528354\)/,
  );
  assert.match(report, /- Published: 2026-10-12 19:08 UTC/);
  assert.match(report, /- Matched the relevance filter on: `exam`, `certif`/);
  // Hub pages with their statuses and a voucher page, and the codes without one.
  assert.match(
    report,
    /Hub page exists \(1\): \[`AB-650`\]\(https:\/\/msfthub\.com\/certs\/aibusiness\/ab-650\/\) \(BETA; voucher page: `vouchers\/ab650beta`\)/,
  );
  assert.match(
    report,
    /\[`AZ-800`\]\(https:\/\/msfthub\.com\/certs\/azure\/az-800\/\) \(RETIRING\)/,
  );
  assert.match(
    report,
    /\[`AZ-802`\]\(https:\/\/msfthub\.com\/certs\/azure\/az-802\/\)(?! \()/,
  );
  assert.match(
    report,
    /No hub page, already listed on Microsoft Learn .*: `AB-250`/,
  );
  // The excerpt is a quote block, the dates a code block labelled as unverified.
  assert.match(report, /\n> Preparing for a Microsoft Certification exam\?/);
  assert.match(
    report,
    /Dates the post states \(verbatim sentences from the post, not verified/,
  );
  assert.match(
    report,
    /```text\n(?:- .*\n)*- The first 300 people who take Exam AZ-802 \(beta\) on or before July 22, 2026, can get 80% off\./,
  );
  // The checklist points at AGENTS.md and the runbooks in docs/monitors/.
  assert.match(report, /### What to do/);
  assert.match(report, /- \[ \] Open each post and read it in full/);
  assert.match(report, /"Beta Exam Pages" in `AGENTS\.md`/);
  assert.match(
    report,
    /the day the post was published is not that date unless the post says so/,
  );
  assert.match(
    report,
    /If the post also gives an expected go-live date or month, the note states it exactly as Microsoft wrote it, linked to the post, next to the calculated 10-12 week window and not instead of it/,
  );
  assert.match(report, /"Voucher Pages" in `AGENTS\.md`/);
  assert.match(report, /`voucherEnds`.*`linkedExam`/);
  assert.match(report, /"Working the list" under "New Exam Monitor"/);
  assert.match(report, /node scripts\/new-exam\.mjs --code <CODE>/);
  assert.match(
    report,
    /See the "Skills Hub Watch" runbook \(`docs\/monitors\/skills-hub-watch\.md`\)/,
  );
  assert.ok(
    !/private|task board/i.test(report),
    "nothing about the private board",
  );
});

test("the checklist only carries the items the posts call for", () => {
  const ctx = emptyContext;
  const renew = {
    ...mkPost(1),
    title: "Renewal changes",
    summary: "How to renew your credential.",
    bodyBlocks: ["How to renew your credential."],
    matched: true,
  };
  const report = buildReport([renew], ctx);
  assert.match(report, /Renewal or credential program change/);
  assert.doesNotMatch(report, /Beta exam:/);
  assert.doesNotMatch(report, /Voucher or discount:/);
  assert.doesNotMatch(report, /Retirement or transition:/);
  assert.doesNotMatch(report, /New or renamed exam or certification:/);
  assert.match(
    report,
    /A post that is not about an exam, certification or voucher the hub covers needs no edit/,
  );

  const retire = {
    ...mkPost(2),
    title: "AZ-800 will retire",
    summary: "Retirement notice.",
    bodyBlocks: ["Retirement notice for AZ-800."],
    matched: true,
  };
  const retireReport = buildReport([retire], ctx);
  assert.match(
    retireReport,
    /Retirement or transition:.*`RETIRING`.*`src\/data_files\/retiring-exams\.json`/,
  );
  assert.match(
    retireReport,
    /New or renamed exam or certification/,
    "an exam code in the post",
  );
  assert.match(
    retireReport,
    /for a beta exam add `--beta --beta-start YYYY-MM-DD`, with the day the beta period began taken from the official announcement or the maintainers, never from this issue/,
  );
  assert.doesNotMatch(retireReport, /Beta exam:/);
});

test("context that could not be read is said so in the report", () => {
  const report = buildReport(
    [{ ...mkPost(1), matched: true, title: "Exam news" }],
    {
      ...emptyContext,
      notes: ["`learn-exams.json` does not exist yet"],
    },
  );
  assert.match(
    report,
    /Context that could not be read for this report: `learn-exams\.json` does not exist yet\./,
  );
});

test("the beta checklist item follows the states of beta-exams.json: betaStart, announcement, pending and the start date from the post only when the post states it", () => {
  const beta = {
    ...mkPost(1),
    title: "Beta news",
    summary: "A beta exam.",
    bodyBlocks: ["A beta exam."],
    matched: true,
  };
  const report = buildReport([beta], emptyContext);
  const item = report
    .split("\n")
    .find((line) => line.startsWith("- [ ] Beta exam:"));
  assert.ok(item, "the beta item is there");
  for (const part of [
    "`src/data_files/beta-exams.json` holds, for each beta exam, the day the beta period began (`betaStart`) and the state of its announcement (`announcement`: `pending`, `unannounced` or the URL of the Skills Hub post",
    '"Beta Exam Pages" in `AGENTS.md`',
    "is still `pending` or `unannounced` is the announcement its `:::note` is waiting for",
    "while an exam is `pending` no announcement exists yet, so a post that does not announce it changes nothing",
    "The beta start date comes from the post only when the post states it",
    "the day the post was published is not that date unless the post says so",
    "keep the `betaStart` of the tracker, and if the tracker has none either, ask for it instead of publishing a date",
    "an entry with `betaStart` and `announcement` to `src/data_files/beta-exams.json`",
  ]) {
    assert.ok(item.includes(part), part);
  }
  assert.doesNotMatch(
    item,
    /comes from the official announcement/,
    "the old wording that ignored the states is gone",
  );
  // The item also appears when only the beta tracker calls for it.
  const quiet = { ...mkPost(2), title: "Exam AZ-401 is open", matched: true };
  assert.doesNotMatch(buildReport([quiet], emptyContext), /Beta exam:/);
  assert.match(
    buildReport([quiet], betaContext(waiting(["AZ-401", "pending"]))),
    /- \[ \] Beta exam:/,
  );
});

// ---------------------------------------------------------------------------
// The announcement a beta exam waits for
// ---------------------------------------------------------------------------
test("the beta announcement fixture is a relevant post that names AZ-401 and states its dates", () => {
  const post = betaPost();
  assert.equal(post.key, "tc:4599401");
  assert.equal(post.matched, true);
  assert.deepEqual(
    extractExamCodes([post.title, ...post.bodyBlocks].join("\n")),
    ["AZ-401"],
  );
  const dated = datedStatements(post.bodyBlocks);
  assert.ok(dated.some((s) => /begins on October 14, 2026/.test(s)));
  assert.ok(dated.some((s) => /general availability .* January 2027/.test(s)));
});

test("readBetaWaiting lists the tracked beta exams that wait for their announcement and skips the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-hub-beta-"));
  try {
    const file = join(dir, "beta-exams.json");
    const url = `${BETA_POST_URL}?WT.mc_id=studentamb_165290`;
    await writeFile(
      file,
      JSON.stringify({
        lastSynced: "2026-10-14",
        exams: [
          { code: "AZ-401", betaStart: "2026-10-14", announcement: "pending" },
          {
            code: "gh-700",
            betaStart: "2026-10-14",
            announcement: "unannounced",
          },
          { code: "AB-650", betaStart: "2026-07-28", announcement: url },
          {
            code: "AI-500",
            betaStart: "2026-05-01",
            announcement: "pending",
            flaggedGA: true,
          },
          { code: "DP-420", betaStart: "2026-05-01" },
          { code: "SC-999", announcement: "soon" },
          { code: "bad", announcement: "pending" },
          { code: "MB-330", announcement: "pending", flaggedGA: false },
          null,
          "text",
        ],
      }),
    );
    assert.deepEqual(
      [...readBetaWaiting(file).values()],
      [
        { code: "AZ-401", state: "pending", betaStart: "2026-10-14" },
        { code: "GH-700", state: "unannounced", betaStart: "2026-10-14" },
        { code: "MB-330", state: "pending", betaStart: "" },
      ],
      "not AB-650 (a URL), AI-500 (flaggedGA), DP-420 or SC-999 (no usable announcement) or bad",
    );

    assert.throws(() => readBetaWaiting(join(dir, "missing.json")), {
      code: "ENOENT",
    });
    await writeFile(file, "{ nope");
    assert.throws(() => readBetaWaiting(file), SyntaxError);
    for (const content of [JSON.stringify({ exams: "x" }), "[]", "null"]) {
      await writeFile(file, content);
      assert.throws(() => readBetaWaiting(file), /no exams list/, content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the address that becomes `announcement` is the post's own link with the hub's tracking parameter", () => {
  const link = (url) => announcementUrl({ ...mkPost(1), link: url, id: url });
  assert.equal(
    announcementUrl(betaPost()),
    `${BETA_POST_URL}?WT.mc_id=studentamb_165290`,
  );
  assert.equal(
    link(
      "https://techcommunity.microsoft.com/blog/skills-hub-blog/x/1?a=b#top",
    ),
    "https://techcommunity.microsoft.com/blog/skills-hub-blog/x/1?a=b&WT.mc_id=studentamb_165290",
  );
  assert.equal(
    link("https://techcommunity.microsoft.com/blog/x/1?WT.mc_id=other"),
    "https://techcommunity.microsoft.com/blog/x/1?WT.mc_id=other",
  );
  assert.equal(
    announcementUrl({ ...mkPost(1), link: "", id: "https://aka.ms/x" }),
    "https://aka.ms/x?WT.mc_id=studentamb_165290",
    "the id is the address when the post has no link",
  );
  // What the note generator would refuse, or what is not Microsoft's, is never offered.
  for (const bad of [
    "https://evil.example/x",
    "http://techcommunity.microsoft.com/x",
    "https://techcommunity.microsoft.com/a(b)",
    "https://techcommunity.microsoft.com/a`b",
    "",
  ]) {
    assert.equal(link(bad), "", bad);
  }
});

test("a post names a waiting beta exam by its code in the title or the article, whatever the hyphen", () => {
  const ctx = betaContext(
    waiting(["AZ-401", "pending"], ["GH-700", "unannounced"]),
  );
  const named = (title, ...blocks) => ({
    ...mkPost(1),
    title,
    bodyBlocks: blocks,
  });
  const codes = (post, context = ctx) =>
    betaAnnouncements(post, context).map((exam) => exam.code);
  assert.deepEqual(codes(named("Exam AZ-401 (beta)")), ["AZ-401"]);
  assert.deepEqual(codes(named("News", "Now open: GH\u2011700 (beta).")), [
    "GH-700",
  ]);
  assert.deepEqual(
    codes(named("News", "GH-700 and AZ-401 are open", "AB-650 too")),
    ["AZ-401", "GH-700"],
    "in code order, not the order of the post",
  );
  assert.deepEqual(codes(named("AB-650 and AZ-402")), []);
  assert.deepEqual(
    codes(named("Exam AZ-401"), { ...ctx, betaWaiting: new Map() }),
    [],
  );
  assert.deepEqual(
    codes(named("Exam AZ-401"), { ...ctx, betaWaiting: null }),
    [],
  );
  assert.deepEqual(codes(named("Exam AZ-401"), emptyContext), []);
});

test("a new post that is the announcement a beta exam waits for starts with an ACTION line and the exact steps", () => {
  const post = betaPost();
  const report = buildReport(
    [post],
    betaContext(waiting(["AZ-401", "pending"])),
  );
  assert.ok(
    report.includes(`**${ACTION("AZ-401")}.**`),
    "a prominent line with the exam code",
  );
  const at = (text) => report.indexOf(text);
  assert.ok(
    at("### 1. [") < at("ACTION:") && at("ACTION:") < at("- Published:"),
    "right under the heading of the post, before its facts",
  );
  for (const step of [
    "`src/data_files/beta-exams.json` has `AZ-401` with `announcement` set to `pending`.",
    `- [ ] Set \`announcement\` of \`AZ-401\` in \`src/data_files/beta-exams.json\` to the URL of this post: \`${BETA_POST_URL}?WT.mc_id=studentamb_165290\`.`,
    "`betaStart` stays 2026-10-14 unless the post states another day the beta period began (the day the post was published is not that date unless the post says so).",
    '- [ ] Regenerate the note with `node scripts/beta-note.mjs --code AZ-401 --expects "<Microsoft\'s go-live wording from the post, if it gives one>"` (leave `--expects` out when the post gives no go-live date or month)',
    "replace the `:::note` that follows the beta `:::tip` on `src/content/docs/azure/AZ-401.mdx` with its output.",
    '- [ ] Add the beta voucher page (`node scripts/new-beta-voucher.mjs`, "Beta voucher format" under "Voucher Pages" in `AGENTS.md`, with `voucherEnds` and `linkedExam: AZ-401`) and link it from the exam page.',
    "- [ ] Re-run the tests (`pnpm test:scripts`).",
  ]) {
    assert.ok(report.includes(step), step);
  }
  // The new announcement is not the only thing in the entry: the usual facts follow.
  assert.match(report, /Dates the post states/);
  assert.match(report, /begins on October 14, 2026/);
  // Unannounced waits for the post as well.
  const late = buildReport(
    [post],
    betaContext(waiting(["AZ-401", "unannounced"])),
  );
  assert.ok(late.includes(ACTION("AZ-401")));
  assert.ok(late.includes("with `announcement` set to `unannounced`."));
});

test("nothing changes for a post that names no beta exam that waits for its announcement", () => {
  const post = betaPost();
  const plain = buildReport([post], emptyContext);
  assert.doesNotMatch(plain, /ACTION:/);
  // An exam the post does not name, an empty list and an unreadable tracker are the same report.
  for (const betaWaiting of [waiting(["GH-700", "pending"]), new Map(), null]) {
    assert.equal(
      buildReport([post], { ...emptyContext, betaWaiting }),
      plain,
      String(betaWaiting),
    );
  }
  // A post about another exam, with AZ-401 waiting.
  const other = { ...mkPost(1), title: "Exam AB-777 (beta)", matched: true };
  assert.doesNotMatch(
    buildReport([other], betaContext(waiting(["AZ-401", "pending"]))),
    /ACTION:/,
  );
});

test("a post that names two waiting exams gets one ACTION entry for each, in code order", () => {
  const post = {
    ...betaPost(),
    title: "New beta exams: GH-700 and AZ-401",
    bodyBlocks: ["Beta exams GH-700 and AZ-401 are open."],
  };
  const report = buildReport(
    [post],
    betaContext(waiting(["AZ-401", "pending"], ["GH-700", "unannounced"]), [
      ["AZ-401", "azure"],
      ["GH-700", "github"],
    ]),
  );
  assert.equal((report.match(/\*\*ACTION: /g) ?? []).length, 2);
  assert.ok(
    report.indexOf(ACTION("AZ-401")) < report.indexOf(ACTION("GH-700")),
  );
  assert.ok(report.includes("`src/content/docs/azure/AZ-401.mdx`"));
  assert.ok(report.includes("`src/content/docs/github/GH-700.mdx`"));
  assert.ok(report.includes("`linkedExam: GH-700`"));
  // GitHub links a bare GH-700 to issue 700: the code is a code span, except in
  // the line that is worded as the maintainers know it.
  const bare = report
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => line.includes("GH-700"));
  assert.deepEqual(bare, [`**${ACTION("GH-700")}.**`]);
});

test("the steps say what to do when the exam has no page yet, when its betaStart is missing and when the post has no usable address", () => {
  const post = betaPost();
  const noPage = buildReport(
    [post],
    betaContext(waiting(["AZ-401", "pending"]), []),
  );
  assert.ok(
    noPage.includes(
      'the exam page of `AZ-401` (the hub has no page for it yet: create it first with `node scripts/new-exam.mjs --code AZ-401 --name "<official name>" --beta --beta-start 2026-10-14`)',
    ),
  );
  const noStart = buildReport(
    [post],
    betaContext(waiting(["AZ-401", "pending", ""])),
  );
  assert.ok(noStart.includes("`betaStart` is not recorded for `AZ-401`"));
  assert.doesNotMatch(noStart, /`betaStart` stays/);
  assert.ok(noStart.includes("ask for it instead of guessing"));
  const foreign = buildReport(
    [{ ...post, link: "https://evil.example/post", id: "9" }],
    betaContext(waiting(["AZ-401", "pending"])),
  );
  assert.ok(foreign.includes(ACTION("AZ-401")));
  assert.ok(!foreign.includes("evil.example"));
  assert.ok(
    foreign.includes(
      "to the URL of this post (its address with `?WT.mc_id=studentamb_165290` added)",
    ),
  );
});

test("the ACTION entries stay when the report is shortened to fit one issue", () => {
  const long = (i) => ({
    ...mkPost(i),
    title: `Post ${i}: exam AZ-401 is in beta`,
    matched: true,
    summary: "exam",
    bodyBlocks: [
      "exam ".repeat(120),
      ...Array.from(
        { length: 30 },
        (_, k) =>
          `The beta exam AB-${100 + k} is available on October ${1 + (k % 28)}, 2026 and registration opens, ${"x".repeat(280)}.`,
      ),
    ],
  });
  const posts = Array.from({ length: 20 }, (_, i) => long(i + 1));
  const report = buildReport(
    posts,
    betaContext(waiting(["AZ-401", "pending"])),
  );
  assert.ok(report.length <= 60001, `report is ${report.length} characters`);
  assert.match(
    report,
    /shortened to keep this issue under GitHub's size limit/,
  );
  assert.doesNotMatch(report, /cut to fit/, "shortening was enough");
  assert.equal(
    report.split(ACTION("AZ-401")).length - 1,
    20,
    "every post keeps its steps",
  );
  assert.equal(
    report.split("- [ ] Re-run the tests (`pnpm test:scripts`).").length - 1,
    20,
  );
});

test("text from a post cannot ping, link, reference or render HTML in the issue", () => {
  const hostile = {
    ...mkPost(1),
    title:
      "Evil <b>exam</b> [click](https://evil.example) @maintainer #123 GH-456 | `code` ```fence``` _x_ *y*",
    summary: "Voucher",
    matched: true,
    bodyBlocks: [
      "Ping @maintainer, close #123 and see GH-456 <img src=x onerror=alert(1)> [link](https://evil.example/x) https://evil.example/bare | table `tick` ```fence```",
      "Exam AB-777 (beta) starts on November 4, 2026 ```break out``` @someone.",
    ],
    link: "https://evil.example/phish",
  };
  const report = buildReport([hostile], emptyContext);
  const title = buildIssueTitle([hostile]);

  const fenced = [];
  const outside = report.replace(/```text\n([\s\S]*?)\n```/g, (_, body) => {
    fenced.push(body);
    return "";
  });
  assert.equal(
    (report.match(/```/g) ?? []).length,
    2 * fenced.length,
    "every fence closes",
  );
  for (const text of [outside, title]) {
    assert.ok(!text.includes("<img"), "no HTML");
    assert.ok(!text.includes("<b>"), "no HTML");
    assert.ok(!text.includes("evil.example"), "no foreign link");
    assert.ok(!/@maintainer|@someone/.test(text), "no mention");
    assert.ok(!/#123/.test(text), "no issue reference");
    // GitHub does not link a reference inside a code span, and the exam codes
    // the report lists (GH-456 looks like one) are in code spans.
    assert.ok(
      !/GH-456/.test(text.replace(/`[^`\n]*`/g, "")),
      "no GH-<number> reference outside a code span",
    );
  }
  assert.ok(
    !/GH-456/.test(title),
    "none in the title, where there are no code spans",
  );
  assert.ok(
    outside.includes(`@${ZWSP}maintainer`) || !outside.includes("maintainer"),
  );
  assert.ok(title.includes(`@${ZWSP}maintainer`));
  // The heading does not link to a host that is not Microsoft's.
  assert.match(
    outside,
    /### 1\. Evil b exam \/b /,
    "tags are only letters, never markup",
  );
  assert.ok(!/### 1\. \[/.test(outside));
  // A pipe or backtick of the post never opens a code span or a table cell.
  const heading = outside.split("\n").find((line) => line.startsWith("### 1."));
  assert.ok(!heading.includes("`") && !heading.includes("|"));
  // The dated sentence is quoted, with its fence neutralized.
  assert.equal(fenced.length, 1);
  assert.match(
    fenced[0],
    /Exam AB-777 \(beta\) starts on November 4, 2026 '''break out''' @someone\./,
  );
  assert.ok(!fenced[0].includes("```"));
  // The excerpt is one quote line.
  assert.equal(
    outside.split("\n").filter((line) => line.startsWith("> ")).length,
    1,
  );
});

test("names, titles and cells are plain one-liners", () => {
  assert.equal(plain("  A\n\tB  <i>x</i> `y` "), "A B i x /i y");
  assert.equal(
    plain("a @b #1 GH-2 GH-x"),
    `a @${ZWSP}b #${ZWSP}1 GH-${ZWSP}2 GH-x`,
  );
  assert.equal(
    safeText("see https://a.example/b?c=d now [x](y) | z"),
    "see (link) now x (y) z",
  );
  assert.equal(
    safeText("snake_case *bold* ~~s~~ back\\slash"),
    "snake\\_case \\*bold\\* \\~\\~s\\~\\~ back\\\\slash",
  );
  assert.equal(safeText("a\u0000b\u200bc"), "a bc");
  assert.equal(trustedLink("https://techcommunity.microsoft.com/x"), true);
  assert.equal(trustedLink("https://learn.microsoft.com/x"), true);
  assert.equal(trustedLink("https://aka.ms/x"), true);
  assert.equal(trustedLink("https://microsoft.com.evil.example/x"), false);
  assert.equal(trustedLink("http://learn.microsoft.com/x"), false);
  assert.equal(trustedLink("javascript:alert(1)"), false);
  assert.equal(trustedLink(""), false);
});

test("the issue title names the posts and never exceeds 200 characters", () => {
  const named = (title) => ({ ...mkPost(1), title });
  assert.equal(
    buildIssueTitle([named("New exam AB-777 (beta)")]),
    "Skills Hub post: New exam AB-777 (beta)",
  );
  assert.equal(
    buildIssueTitle([named("One"), named("Two")]),
    "Skills Hub posts (2): One; Two",
  );
  const many = Array.from({ length: 30 }, (_, i) =>
    named(`A fairly long post title number ${i}`),
  );
  const title = buildIssueTitle(many);
  assert.ok(title.length <= 200);
  assert.match(title, /^Skills Hub posts \(30\): .* \+\d+ more$/);
  assert.ok(!title.includes("\n"));
  assert.ok(buildIssueTitle([named("x".repeat(500))]).length <= 200);
  // A link of a post never goes into a title.
  assert.equal(
    buildIssueTitle([named("Read https://evil.example/x now")]),
    "Skills Hub post: Read (link) now",
  );
});

test("the report stays under GitHub's size limit by shortening it in steps", () => {
  const long = (i) => ({
    ...mkPost(i),
    title: `Post ${i} exam`,
    matched: true,
    summary: "exam",
    bodyBlocks: [
      "exam ".repeat(120),
      ...Array.from(
        { length: 30 },
        (_, k) =>
          `The beta exam AB-${100 + k} is available on October ${1 + (k % 28)}, 2026 and registration opens, ${"x".repeat(280)}.`,
      ),
      Array.from({ length: 200 }, (_, k) => `AZ-${100 + k}`).join(" "),
    ],
  });
  // One run reports at most MAX_NEW_POSTS (10) posts, so this is far more than
  // a real run can produce: the point is that the size limit holds regardless.
  const full = buildReport([long(1)], emptyContext);
  assert.doesNotMatch(full, /shortened/, "a normal report is not shortened");
  assert.ok(
    full.includes("The beta exam AB-100 is available"),
    "dates are quoted in full detail",
  );

  const posts = Array.from({ length: 30 }, (_, i) => long(i + 1));
  const report = buildReport(posts, emptyContext);
  assert.ok(report.length <= 60001, `report is ${report.length} characters`);
  assert.match(
    report,
    /shortened to keep this issue under GitHub's size limit/,
  );
  assert.doesNotMatch(report, /cut to fit/, "shortening was enough");
  assert.ok(report.includes("### 30. "), "every post is still listed");

  // Even the shortest form of a flood is cut rather than rejected by GitHub.
  const flood = Array.from({ length: 400 }, (_, i) => long(i + 1));
  const cut = buildReport(flood, emptyContext);
  assert.ok(cut.length <= 60001, `cut report is ${cut.length} characters`);
  assert.match(cut, /The report was cut to fit into one issue/);
});

test("the failure report says what happened and what to do, and never guesses a feed", () => {
  const text = buildProblemReport(
    { kind: "feed", runs: 2, definite: 2, since: "2026-10-12" },
    "the document is <html>, not an RSS or Atom feed",
    cfgOf(),
  );
  assert.match(
    text,
    /no usable feed for 2 consecutive runs \(since 2026-10-12\)/,
  );
  assert.match(text, /not a usable RSS or Atom feed/);
  assert.ok(!text.includes("<html>"), "the reason is escaped");
  assert.ok(text.includes(FEED_URL));
  assert.match(
    text,
    /aka\.ms\/MTC\/RSS-Board-Footer\?board\.id=skills-hub-blog/,
  );
  assert.match(text, /never guess a feed URL/);
  assert.match(text, /raised again every week/);
  assert.match(
    text,
    /"Skills Hub Watch" runbook, `docs\/monitors\/skills-hub-watch\.md`/,
  );
  assert.match(
    buildProblemReport(
      { kind: "gone", runs: 1, definite: 1, since: "2026-10-12" },
      "HTTP 404",
      cfgOf(),
    ),
    /no usable feed for 1 consecutive run \(since/,
  );
});

// ---------------------------------------------------------------------------
// End to end: the script against a local fake of the feed
// ---------------------------------------------------------------------------
async function fakeFeed() {
  const state = {
    body: FIXTURE,
    status: 200,
    contentType: "text/xml; charset=UTF-8",
    requests: 0,
  };
  const server = createServer((_request, response) => {
    state.requests++;
    response.statusCode = state.status;
    response.setHeader("Content-Type", state.contentType);
    response.end(state.status === 200 ? state.body : "unavailable");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/feed`,
    close: () => new Promise((done) => server.close(done)),
  };
}

function runScript(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function setup(feed, { learn = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "skills-hub-test-"));
  const docs = join(dir, "docs");
  await mkdir(join(docs, "aibusiness"), { recursive: true });
  await mkdir(join(docs, "azure"), { recursive: true });
  await mkdir(join(docs, "vouchers"), { recursive: true });
  await writeFile(
    join(docs, "aibusiness", "AB-650.mdx"),
    "---\ntitle: x\n---\n",
  );
  await writeFile(join(docs, "azure", "AZ-802.mdx"), "---\ntitle: x\n---\n");
  await writeFile(
    join(docs, "vouchers", "ab650beta.mdx"),
    "---\ntitle: v\nvoucherCategory: Special\nlinkedExam: AB-650\n---\n",
  );
  const files = {
    dir,
    tracker: join(dir, "tracker.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "output"),
    summary: join(dir, "summary.md"),
    status: join(dir, "exam-status.mjs"),
    learn: join(dir, "learn-exams.json"),
    beta: join(dir, "beta-exams.json"),
    docs,
  };
  await writeFile(
    files.status,
    'export const examStatuses = { aibusiness: { "AB-650": { text: "BETA", variant: "tip" } } };\n',
  );
  if (learn)
    await writeFile(
      files.learn,
      JSON.stringify({ exams: [{ code: "AB-777" }] }),
    );
  // AB-650 has its announcement, AZ-401 and GH-700 wait for theirs.
  await writeFile(
    files.beta,
    JSON.stringify({
      lastSynced: "2026-10-14",
      exams: [
        {
          code: "AB-650",
          betaStart: "2026-07-28",
          announcement: `${BETA_POST_URL.replace("4599401", "4494123")}?WT.mc_id=studentamb_165290`,
          flaggedGA: false,
        },
        { code: "AZ-401", betaStart: "2026-10-14", announcement: "pending" },
        { code: "GH-700", betaStart: "2026-10-14", announcement: "pending" },
      ],
    }),
  );

  const run = async (extra = {}) => {
    await writeFile(files.output, "");
    await writeFile(files.summary, "");
    await rm(files.report, { force: true });
    await rm(files.error, { force: true });
    const result = await runScript({
      FEED_URL: feed.url,
      TRACKER_FILE: files.tracker,
      REPORT_FILE: files.report,
      ERROR_FILE: files.error,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      DOCS_DIR: docs,
      EXAM_STATUS_FILE: files.status,
      LEARN_TRACKER_FILE: files.learn,
      BETA_EXAMS_FILE: files.beta,
      FETCH_ATTEMPTS: "1",
      RETRY_BASE_MS: "0",
      TODAY,
      ...extra,
    });
    const output = Object.fromEntries(
      (await readFile(files.output, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    const read = async (file) =>
      existsSync(file) ? await readFile(file, "utf8") : null;
    return {
      ...result,
      output,
      tracker: await read(files.tracker),
      report: await read(files.report),
      errorText: await read(files.error),
      summary: await read(files.summary),
    };
  };
  return {
    files,
    run,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const newPost = (extra = {}) =>
  itemXml({
    id: 9999001,
    slug: "new-exam-ab-777-beta",
    title: "New exam AB-777 (beta) with an 80% off voucher",
    html: "<p>Beta exam AB-777 and AB-650. The beta period for Exam AB-777 begins on November 4, 2026. The first 300 people who take Exam AB-777 (beta) on or before December 1, 2026, can get 80% off.</p>",
    ...extra,
  });

const quietPost = () =>
  itemXml({
    id: 9999002,
    slug: "community-spotlight",
    title: "Community spotlight of the week",
    date: "Tue, 14 Oct 2026 03:40:00 GMT",
    html: "<p>Team stories and fun events.</p>",
  });

test("end to end: baseline, a quiet second run, a new post, an unrelated post", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    // 1. First run: silent baseline of the 9 posts, the newest relevant ones in the job summary.
    const first = await t.run();
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.output, {
      changes_found: "false",
      baseline_updated: "true",
      extraction_failed: "false",
      feed_problem: "false",
      feed_read: "true",
      issue_title: "",
      posts_new: "9",
      posts_relevant: "0",
    });
    assert.equal(first.report, null, "no issue for a baseline");
    const baseline = JSON.parse(first.tracker);
    assert.equal(baseline.posts.length, 9);
    assert.equal(baseline.lastSynced, TODAY);
    assert.equal(baseline.problem, null);
    assert.equal(baseline.posts.filter((p) => p.matched).length, 7);
    assert.match(first.summary, /BASELINE recorded silently/);
    assert.match(first.summary, /The 5 newest relevant posts in the feed/);
    const rows = first.summary
      .split("\n")
      .filter((line) => /^\| 2026-/.test(line));
    assert.equal(rows.length, 5);
    assert.match(
      rows[0],
      /New accessibility updates for Microsoft Certification exams/,
    );

    // 2. Second run: nothing happens, the tracker is byte-identical (also on another day).
    const second = await t.run({ TODAY: "2026-10-15" });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.output.changes_found, "false");
    assert.equal(second.output.baseline_updated, "false");
    assert.equal(second.output.posts_new, "0");
    assert.equal(second.tracker, first.tracker);
    assert.equal(second.report, null);
    assert.match(second.summary, /nothing to report/);
    assert.equal(feed.state.requests, 2, "one request per run");

    // 3. A new relevant post: one issue, the tracker gains it.
    feed.state.body = withItems(FIXTURE, newPost());
    const third = await t.run();
    assert.equal(third.code, 0, third.stderr);
    assert.equal(third.output.changes_found, "true");
    assert.equal(third.output.baseline_updated, "true");
    assert.equal(third.output.posts_new, "1");
    assert.equal(third.output.posts_relevant, "1");
    assert.equal(
      third.output.issue_title,
      "Skills Hub post: New exam AB-777 (beta) with an 80% off voucher",
    );
    assert.match(third.report, /^## Skills Hub: 1 new post to review/);
    assert.match(
      third.report,
      /\(https:\/\/techcommunity\.microsoft\.com\/t5\/the-skills-hub-blog\/new-exam-ab-777-beta\/ba-p\/9999001\)/,
    );
    assert.match(third.report, /Published: 2026-10-14 03:30 UTC/);
    assert.match(
      third.report,
      /Hub page exists \(1\): \[`AB-650`\].*\(BETA; voucher page: `vouchers\/ab650beta`\)/,
    );
    assert.match(
      third.report,
      /No hub page, already listed on Microsoft Learn .*: \[?`AB-777`/,
    );
    assert.match(
      third.report,
      /The beta period for Exam AB-777 begins on November 4, 2026\./,
    );
    assert.match(third.report, /Beta exam:/);
    assert.match(third.report, /Voucher or discount:/);
    assert.doesNotMatch(
      third.report,
      /ACTION:/,
      "the post names AB-650, whose announcement is a URL, and no exam that waits",
    );
    assert.equal(third.output.feed_read, "true");
    assert.equal(JSON.parse(third.tracker).posts.length, 10);
    assert.equal(
      JSON.parse(third.tracker).posts[0].title,
      "New exam AB-777 (beta) with an 80% off voucher",
    );

    // Reported once.
    const fourth = await t.run();
    assert.equal(fourth.output.changes_found, "false");
    assert.equal(fourth.output.baseline_updated, "false");
    assert.equal(fourth.tracker, third.tracker);

    // 4. An unrelated post is recorded without an issue.
    feed.state.body = withItems(FIXTURE, quietPost(), newPost());
    const fifth = await t.run();
    assert.equal(fifth.output.changes_found, "false");
    assert.equal(fifth.output.baseline_updated, "true");
    assert.equal(fifth.output.posts_new, "1");
    assert.equal(fifth.output.issue_title, "");
    assert.equal(fifth.report, null);
    assert.equal(JSON.parse(fifth.tracker).posts.length, 11);
    assert.equal(JSON.parse(fifth.tracker).posts[0].matched, false);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: a stale snapshot of the feed is a quiet run, not a flood of old posts", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    // The tracker knows the newest posts; the feed now serves an older window
    // that still holds two posts the tracker never saw (they are from May).
    feed.state.body = firstItems(5);
    const baseline = await t.run();
    assert.equal(JSON.parse(baseline.tracker).posts.length, 5);

    const fixturePosts = postsOf(FIXTURE);
    const stale = rss([
      ...FIXTURE.split("    <item>")
        .slice(1, 4)
        .map(
          (part) => "    <item>" + part.replace(/\s*<\/channel>[\s\S]*$/, ""),
        ),
      itemXml({
        id: 111,
        title: "Old exam news A",
        date: "Wed, 20 May 2026 10:00:00 GMT",
      }),
      itemXml({
        id: 112,
        title: "Old exam news B",
        date: "Thu, 21 May 2026 10:00:00 GMT",
      }),
    ]);
    assert.equal(fixturePosts.length, 9);
    feed.state.body = stale;
    const run = await t.run();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "false");
    assert.equal(
      run.output.baseline_updated,
      "false",
      "no commit for old posts",
    );
    assert.equal(run.output.posts_new, "0");
    assert.equal(run.tracker, baseline.tracker);
    assert.match(run.summary, /Old posts ignored \(stale feed snapshot\) \| 2/);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: a feed that is not a feed counts, alerts on the second run, repeats weekly and recovers", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    const baseline = await t.run();
    const posts = JSON.parse(baseline.tracker).posts;

    feed.state.body =
      "<!DOCTYPE html><html><body>Verifying you are human</body></html>";
    feed.state.contentType = "text/html";
    // Run 1: a counter in the tracker, no alert, the run succeeds. Nothing was
    // read, so feed_read is false: the run does not count as healthy either.
    const one = await t.run();
    assert.equal(one.code, 0, one.stderr);
    assert.deepEqual(
      { ...one.output },
      {
        changes_found: "false",
        baseline_updated: "true",
        extraction_failed: "false",
        feed_problem: "false",
        feed_read: "false",
        issue_title: "",
        posts_new: "0",
        posts_relevant: "0",
      },
    );
    assert.deepEqual(JSON.parse(one.tracker).problem, {
      kind: "feed",
      runs: 1,
      definite: 1,
      since: TODAY,
    });
    assert.deepEqual(
      JSON.parse(one.tracker).posts,
      posts,
      "the posts are kept",
    );
    assert.equal(one.errorText, null);
    assert.match(
      one.stderr,
      /WARNING: no usable feed \(the document is <html>, not an RSS or Atom feed\)/,
    );

    // Run 2: the alert.
    const two = await t.run();
    assert.equal(two.code, 0, two.stderr);
    assert.equal(two.output.extraction_failed, "true");
    assert.equal(two.output.feed_problem, "true");
    assert.equal(two.output.baseline_updated, "true");
    assert.match(two.errorText, /^## The Skills Hub blog feed cannot be read/);
    assert.match(
      two.errorText,
      /no usable feed for 2 consecutive runs \(since 2026-10-14\)/,
    );
    assert.match(two.errorText, /not an RSS or Atom feed/);
    assert.equal(JSON.parse(two.tracker).problem.reportedAt, TODAY);
    assert.match(two.summary, /NO USABLE FEED, previous posts kept/);

    // Run 3, same day: still a problem (the run goes red), no second issue, no commit.
    const three = await t.run();
    assert.equal(three.output.extraction_failed, "false");
    assert.equal(three.output.feed_problem, "true");
    assert.equal(three.output.baseline_updated, "false");
    assert.equal(three.tracker, two.tracker);
    assert.equal(three.errorText, null);

    // A week later: the reminder.
    const week = await t.run({ TODAY: "2026-10-21" });
    assert.equal(week.output.extraction_failed, "true");
    assert.equal(JSON.parse(week.tracker).problem.reportedAt, "2026-10-21");
    assert.equal(JSON.parse(week.tracker).problem.since, TODAY);

    // The feed is back: the counter is cleared, nothing is reported, the old posts are not new.
    feed.state.body = FIXTURE;
    feed.state.contentType = "text/xml";
    const back = await t.run({ TODAY: "2026-10-22" });
    assert.equal(back.code, 0, back.stderr);
    assert.equal(back.output.extraction_failed, "false");
    assert.equal(back.output.feed_problem, "false");
    assert.equal(back.output.baseline_updated, "true");
    assert.equal(back.output.changes_found, "false");
    assert.equal(JSON.parse(back.tracker).problem, null);
    assert.deepEqual(JSON.parse(back.tracker).posts, posts);
    assert.match(back.stdout, /readable again after 2 run\(s\)/);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: an empty feed, too few items and a 404 are definite; a 503 is not", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    await t.run();

    // Too few usable items.
    feed.state.body = firstItems(3);
    const few = await t.run();
    assert.equal(few.code, 0, few.stderr);
    assert.equal(JSON.parse(few.tracker).problem.runs, 1);
    const fewTwo = await t.run();
    assert.equal(fewTwo.output.extraction_failed, "true");
    assert.match(
      fewTwo.errorText,
      /only 3 usable items in the feed \(expected at least 5; 3 read, 0 without a title or id\)/,
    );
    // MIN_FEED_ITEMS is an override.
    const lenient = await t.run({ MIN_FEED_ITEMS: "3" });
    assert.equal(lenient.output.feed_problem, "false");
    assert.equal(JSON.parse(lenient.tracker).problem, null);

    // A feed without any item.
    feed.state.body = rss([]);
    const empty = await t.run();
    assert.equal(JSON.parse(empty.tracker).problem.kind, "feed");
    await t.run();

    // A 404 is gone.
    await rm(t.files.tracker);
    feed.state.status = 404;
    await writeFile(t.files.tracker, trackerContent(emptyTracker()));
    const gone1 = await t.run();
    assert.equal(JSON.parse(gone1.tracker).problem.kind, "gone");
    assert.equal(gone1.output.extraction_failed, "false");
    const gone2 = await t.run();
    assert.equal(gone2.output.extraction_failed, "true");
    assert.match(
      gone2.errorText,
      /the feed address answers that the page does not exist/,
    );
    assert.match(gone2.errorText, /HTTP 404/);

    // A 503 is a transient failure: it takes FETCH_FAILURE_RUNS runs.
    feed.state.status = 503;
    await writeFile(t.files.tracker, trackerContent(emptyTracker()));
    const env = { FETCH_FAILURE_RUNS: "3" };
    const t1 = await t.run(env);
    const t2 = await t.run(env);
    assert.equal(t1.output.extraction_failed, "false");
    assert.equal(t2.output.extraction_failed, "false");
    assert.equal(t2.output.feed_problem, "false");
    assert.deepEqual(JSON.parse(t2.tracker).problem, {
      kind: "fetch",
      runs: 2,
      definite: 0,
      since: TODAY,
    });
    const t3 = await t.run(env);
    assert.equal(t3.output.extraction_failed, "true");
    assert.equal(t3.output.feed_problem, "true");
    assert.match(t3.errorText, /the feed could not be fetched/);
    assert.match(t3.errorText, /HTTP 503/);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: a response over MAX_FEED_BYTES is a definite problem, nothing is recorded from it", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    await t.run();
    const before = JSON.parse(await readFile(t.files.tracker, "utf8"));
    // The same feed, valid, but over the limit: it is not read at all.
    const small = { MAX_FEED_BYTES: "1000" };
    assert.ok(FIXTURE.length > 1000);
    const first = await t.run(small);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.output.changes_found, "false");
    assert.equal(first.output.extraction_failed, "false");
    const problem = JSON.parse(first.tracker).problem;
    assert.equal(problem.kind, "feed");
    assert.equal(problem.definite, 1);
    assert.deepEqual(JSON.parse(first.tracker).posts, before.posts);
    // The second definite run raises the alert, with the reason.
    const second = await t.run(small);
    assert.equal(second.output.extraction_failed, "true");
    assert.match(second.errorText, /the response is larger than 1000 bytes/);
    // Under the limit it is read again and the counter clears.
    const fine = await t.run({ MAX_FEED_BYTES: String(FIXTURE.length + 10) });
    assert.equal(fine.output.feed_problem, "false");
    assert.equal(JSON.parse(fine.tracker).problem, null);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: retries are bounded and only for rate limits, server errors and network errors", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    feed.state.status = 503;
    const before = feed.state.requests;
    await t.run({ FETCH_ATTEMPTS: "3" });
    assert.equal(feed.state.requests - before, 3, "a 503 is retried");
    feed.state.status = 404;
    const mid = feed.state.requests;
    await t.run({ FETCH_ATTEMPTS: "3" });
    assert.equal(feed.state.requests - mid, 1, "a 404 is not");
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: the first run with an unreachable feed still starts a tracker with the counter", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    const url = feed.url;
    await feed.close();
    const run = await t.run({ FEED_URL: url });
    assert.equal(run.code, 0, run.stderr);
    const tracker = JSON.parse(run.tracker);
    assert.deepEqual(tracker.posts, []);
    assert.equal(tracker.lastSynced, null);
    assert.deepEqual(tracker.problem, {
      kind: "fetch",
      runs: 1,
      definite: 0,
      since: TODAY,
    });
    assert.equal(run.output.baseline_updated, "true");
    assert.equal(run.output.extraction_failed, "false");
    assert.equal(run.output.feed_read, "false", "nothing was read");
  } finally {
    await t.cleanup();
  }
});

test("end to end: a corrupt tracker stops the run and is left alone", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    for (const content of [
      "{ not json",
      JSON.stringify({ posts: "x" }),
      JSON.stringify({ posts: [{ id: "" }] }),
    ]) {
      await writeFile(t.files.tracker, content);
      const run = await t.run();
      assert.equal(run.code, 1);
      assert.equal(run.output.extraction_failed, "true");
      assert.equal(run.output.feed_read, "false");
      assert.equal(run.output.baseline_updated, "false");
      assert.match(run.errorText, /Corrupt tracker file at .*tracker\.json/);
      assert.equal(run.tracker, content, "not reset");
      assert.equal(run.report, null);
    }
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: more new posts than the limit stop the run; force_baseline accepts them silently", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    await writeFile(
      t.files.tracker,
      trackerContent({
        lastSynced: "2026-09-01",
        problem: null,
        posts: [
          {
            id: "https://techcommunity.microsoft.com/t5/b/s/ba-p/1000001",
            title: "Known",
            pubDate: "2026-10-12T19:00:00Z",
            matched: false,
          },
        ],
      }),
    );
    // OLD_POST_DAYS=0 switches the stale snapshot filter off: the fixture holds
    // posts from May to October, and only a post from the last 30 days counts as new.
    const stopped = await t.run({ MAX_NEW_POSTS: "3", OLD_POST_DAYS: "0" });
    assert.equal(stopped.code, 1);
    assert.equal(stopped.output.extraction_failed, "true");
    assert.equal(stopped.output.baseline_updated, "false");
    assert.match(
      stopped.errorText,
      /9 of the 9 posts in the feed are new at once \(limit 3\)/,
    );
    assert.match(stopped.errorText, /force_baseline/);
    assert.equal(
      JSON.parse(stopped.tracker).posts.length,
      1,
      "nothing was written",
    );

    const forced = await t.run({ MAX_NEW_POSTS: "3", FORCE_BASELINE: "1" });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.output.changes_found, "false");
    assert.equal(forced.output.baseline_updated, "true");
    assert.equal(forced.report, null);
    assert.equal(JSON.parse(forced.tracker).posts.length, 10);
    assert.match(forced.summary, /BASELINE recorded silently/);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: a report without the Learn tracker says so instead of failing", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed, { learn: false });
  try {
    await t.run();
    feed.state.body = withItems(FIXTURE, newPost());
    const run = await t.run();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "true");
    assert.match(
      run.report,
      /No hub page, Learn status unknown \(1\): `AB-777`/,
    );
    assert.match(run.report, /`learn-exams\.json` does not exist yet/);
    assert.ok(!run.report.includes(t.files.dir), "no local path in the issue");
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: the announcement post of a beta exam gets the ACTION entry, and only that exam", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    await writeFile(
      join(t.files.docs, "azure", "AZ-401.mdx"),
      "---\ntitle: x\n---\n",
    );
    await t.run(); // the baseline
    feed.state.body = withItems(FIXTURE, BETA_ITEM);
    const run = await t.run();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.changes_found, "true");
    assert.equal(run.output.posts_relevant, "1");
    assert.equal(
      run.output.issue_title,
      "Skills Hub post: New beta exam: AZ-401 Designing and Implementing Microsoft Agentic DevOps Solutions",
    );
    assert.ok(run.report.includes(`**${ACTION("AZ-401")}.**`));
    assert.ok(
      run.report.includes(
        `to the URL of this post: \`${BETA_POST_URL}?WT.mc_id=studentamb_165290\``,
      ),
    );
    assert.ok(
      run.report.includes(
        "replace the `:::note` that follows the beta `:::tip` on `src/content/docs/azure/AZ-401.mdx`",
      ),
    );
    assert.ok(
      run.report.includes("with `announcement` set to `pending`") &&
        run.report.includes("`betaStart` stays 2026-10-14"),
    );
    // GH-700 waits too, but the post does not name it; AB-650 has its announcement.
    assert.equal(run.report.split("**ACTION: ").length - 1, 1);
    assert.ok(!run.report.includes(ACTION("GH-700")));
    assert.ok(!run.report.includes(ACTION("AB-650")));
    assert.doesNotMatch(run.report, /Context that could not be read/);
    assert.equal(JSON.parse(run.tracker).posts.length, 10);

    // Reported once: the post is recorded, so the next run says nothing.
    const again = await t.run();
    assert.equal(again.output.changes_found, "false");
    assert.equal(again.report, null);

    // Once the tracker has the URL, the next post that names AZ-401 changes nothing.
    await writeFile(
      t.files.beta,
      JSON.stringify({
        exams: [
          {
            code: "AZ-401",
            betaStart: "2026-10-14",
            announcement: `${BETA_POST_URL}?WT.mc_id=studentamb_165290`,
          },
        ],
      }),
    );
    feed.state.body = withItems(
      FIXTURE,
      itemXml({
        id: 9999020,
        title: "More about Exam AZ-401 (beta)",
        date: "Wed, 14 Oct 2026 18:00:00 GMT",
        html: "<p>Beta exam AZ-401 study tips.</p>",
      }),
      BETA_ITEM,
    );
    const later = await t.run();
    assert.equal(later.output.changes_found, "true");
    assert.doesNotMatch(later.report, /ACTION:/);
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("end to end: a beta tracker that is missing or unreadable is said in the issue and never fails the run", async () => {
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    await t.run(); // the baseline
    let id = 9999030;
    const post = () =>
      itemXml({
        id: ++id,
        title: `Exam AZ-401 (beta) is open ${id}`,
        date: "Wed, 14 Oct 2026 18:00:00 GMT",
        html: "<p>Beta exam AZ-401 is open.</p>",
      });
    const invalid = join(t.files.dir, "invalid-beta.json");
    await writeFile(invalid, "{ not json");
    const broken = [
      [join(t.files.dir, "nowhere.json"), /`beta-exams\.json` does not exist/],
      [
        invalid,
        /`beta-exams\.json` could not be read \(invalid JSON or script\)/,
      ],
    ];
    let items = [];
    for (const [file, note] of broken) {
      items = [post(), ...items];
      feed.state.body = withItems(FIXTURE, ...items);
      const run = await t.run({ BETA_EXAMS_FILE: file });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.output.changes_found, "true");
      assert.equal(run.output.extraction_failed, "false");
      assert.equal(run.output.feed_read, "true");
      assert.match(
        run.report,
        new RegExp(
          `Context that could not be read for this report: .*${note.source}.*so it is not known which beta exam is waiting for its announcement post`,
        ),
      );
      assert.doesNotMatch(run.report, /ACTION:/);
      assert.match(run.stderr, /WARNING: could not read the beta exam tracker/);
      assert.ok(
        !run.report.includes(t.files.dir),
        "no local path in the issue",
      );
    }
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
const workflowDir = join(root, ".github", "workflows");
const workflow = readFileSync(
  join(workflowDir, "skills-hub-watch.yml"),
  "utf8",
);

function stepText(name) {
  const marker = `- name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow has the step "${name}"`);
  const next = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

const STEP_CHECK = "Check the Skills Hub blog feed";
const STEP_ISSUE = "Create issue if the Skills Hub blog has new relevant posts";
const STEP_FAILED = "Create issue if the check failed";
const STEP_COMMIT = "Commit updated Skills Hub tracker";
const STEP_RED = "Fail the run while the feed cannot be read";

const expandField = (field, max) => {
  if (field === "*" || field.startsWith("*/")) {
    const step = field.startsWith("*/") ? Number(field.slice(2)) : 1;
    return Array.from({ length: max + 1 }, (_, i) => i).filter(
      (i) => i % step === 0,
    );
  }
  return field.split(",").map(Number);
};
const crons = (source) =>
  [...source.matchAll(/^\s*- cron: "(\S+) (\S+) (\S+) (\S+) (\S+)"/gm)].map(
    (m) => ({
      minutes: expandField(m[1], 59),
      hours: expandField(m[2], 23),
      rest: m.slice(3, 6),
    }),
  );

test("the schedule is every 6 hours at minute 20 and no other pushing workflow starts then", () => {
  const mine = crons(workflow);
  assert.deepEqual(
    mine.map((c) => [c.minutes, c.hours].join(" ")).sort(),
    ["20 0", "20 12", "20 18", "20 6"].sort().map((s) => s.replace(" ", " ")),
  );
  assert.ok(
    mine.every((c) => c.rest.join(" ") === "* * *"),
    "every day",
  );
  const times = new Set(
    mine.flatMap((c) => c.hours.map((h) => `${h}:${c.minutes[0]}`)),
  );
  assert.deepEqual([...times].sort(), ["0:20", "12:20", "18:20", "6:20"]);

  let others = 0;
  for (const name of readdirSync(workflowDir)) {
    if (name === "skills-hub-watch.yml" || !name.endsWith(".yml")) continue;
    const text = readFileSync(join(workflowDir, name), "utf8");
    if (!/git push/.test(text)) continue;
    others++;
    for (const other of crons(text)) {
      for (const hour of other.hours) {
        for (const minute of other.minutes) {
          assert.ok(
            !(minute === 20 && [0, 6, 12, 18].includes(hour)),
            `${name} starts at ${hour}:${minute}, the same time as the Skills Hub watch`,
          );
        }
      }
    }
  }
  assert.ok(others > 0, "other pushing workflows were checked");
});

test("a run is never cancelled half way, uses the node version of .node-version and may only commit the tracker and open issues", () => {
  assert.match(
    workflow,
    /^concurrency:\n {2}group: skills-hub-watch\n {2}cancel-in-progress: false$/m,
  );
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(
    workflow,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(workflow, /^ {4}timeout-minutes: 10$/m);
  assert.match(workflow, /^ {6}REPORT_FILE: \/tmp\/skills-hub-report\.md$/m);
  assert.match(workflow, /^ {6}ERROR_FILE: \/tmp\/skills-hub-error\.md$/m);
  assert.ok(!/assignees?:/.test(workflow), "issues get no assignee");
});

test("the issue comes before the tracker commit, and a failed issue skips the commit", () => {
  const at = (needle) => workflow.indexOf(needle);
  assert.ok(
    at(`- name: ${STEP_CHECK}`) < at(`- name: ${STEP_ISSUE}`) &&
      at(`- name: ${STEP_ISSUE}`) < at(`- name: ${STEP_FAILED}`) &&
      at(`- name: ${STEP_FAILED}`) < at(`- name: ${STEP_COMMIT}`) &&
      at(`- name: ${STEP_COMMIT}`) < at(`- name: ${STEP_RED}`),
    "check, issue, failure issue, commit, red run",
  );

  const issue = stepText(STEP_ISSUE);
  assert.match(issue, /if: steps\.check\.outputs\.changes_found == 'true'/);
  assert.match(
    issue,
    /title: "\$\{\{ steps\.check\.outputs\.issue_title \}\}"/,
  );
  assert.match(issue, /content-filepath: \/tmp\/skills-hub-report\.md/);
  assert.match(issue, /labels: enhancement/);

  const failed = stepText(STEP_FAILED);
  assert.match(
    failed,
    /if: \$\{\{ !cancelled\(\) && steps\.check\.outputs\.extraction_failed == 'true' \}\}/,
  );
  // ONE issue with a stable title (not one per run), a comment at most once a day
  // while the check keeps failing every 6 hours, closed by a healthy run.
  assert.match(
    failed,
    /node scripts\/failure-issue\.mjs raise --title "Skills Hub Watch Failed" --label bug --file \/tmp\/skills-hub-error\.md --repeat-hours 24/,
  );
  assert.doesNotMatch(failed, /github\.run_id/);
  assert.doesNotMatch(workflow, /Failed — \$\{\{ github\.run_id/);
  const close = stepText("Close the failure issue once the check runs again");
  assert.match(
    close,
    /if: steps\.check\.outputs\.extraction_failed == 'false' && steps\.check\.outputs\.feed_read == 'true'/,
  );
  assert.doesNotMatch(
    close,
    /failure\(\)|always\(\)|!cancelled\(\)/,
    "it keeps the implicit success(): never after a failed step",
  );
  assert.match(
    close,
    /failure-issue\.mjs clear --title "Skills Hub Watch Failed" --label bug --comment/,
  );
  assert.ok(
    at("- name: Close the failure issue once") > at(`- name: ${STEP_COMMIT}`),
    "closed after the commit, which a failed issue step skips",
  );

  const commit = stepText(STEP_COMMIT);
  assert.match(commit, /if: steps\.check\.outputs\.baseline_updated == 'true'/);
  assert.ok(
    !/always\(\)|failure\(\)|success\(\)|cancelled\(\)/.test(commit),
    "no status-check function: a failed issue step skips the commit",
  );
  assert.match(commit, /git add src\/data_files\/skills-hub-posts\.json/);
  assert.match(commit, /for attempt in 1 2 3/);
  assert.match(commit, /git pull --rebase && git push && exit 0/);

  const red = stepText(STEP_RED);
  assert.match(red, /if: steps\.check\.outputs\.feed_problem == 'true'/);
  assert.match(red, /exit 1/);
});

const CLOSE_STEP = "Close the failure issue once the check runs again";

/**
 * Whether a step with this `if` runs for these outputs of the check step. It
 * understands what the close step uses: `steps.check.outputs.<name> == 'x'` and
 * `!= 'x'`, joined by `&&`; an output that was not written is "", as on GitHub.
 * The step has no status-check function, so it also needs every step before it to
 * have succeeded: a run whose check step failed (exit code 1) never gets here.
 */
function stepRuns(condition, output) {
  return condition.split("&&").every((part) => {
    const match = part
      .trim()
      .match(/^steps\.check\.outputs\.(\w+) (==|!=) '([^']*)'$/);
    assert.ok(match, `cannot evaluate "${part.trim()}"`);
    const actual = output[match[1]] ?? "";
    return match[2] === "==" ? actual === match[3] : actual !== match[3];
  });
}

/** Whether the workflow's step that closes the failure issue runs after this run of the check. */
const closes = (run) =>
  run.code === 0 &&
  stepRuns(stepText(CLOSE_STEP).match(/^\s+if: (.+)$/m)[1], run.output);

test("end to end: only a run that read a usable feed closes the failure issue, never a skipped or unestablished one", async () => {
  // What the step did before feed_read: it closed after a first or second bad read.
  const before =
    "steps.check.outputs.extraction_failed == 'false' && steps.check.outputs.feed_problem != 'true'";
  const feed = await fakeFeed();
  const t = await setup(feed);
  try {
    // Healthy: the baseline and a quiet run read the feed.
    assert.equal(closes(await t.run()), true, "the baseline");
    assert.equal(closes(await t.run()), true, "a quiet run");

    // The failsafe stops the run (the failure issue is raised): nothing closes it.
    await writeFile(
      t.files.tracker,
      trackerContent({
        lastSynced: "2026-09-01",
        problem: null,
        posts: [
          {
            id: "https://techcommunity.microsoft.com/t5/b/s/ba-p/1000001",
            title: "Known",
            pubDate: "2026-10-12T19:00:00Z",
            matched: false,
          },
        ],
      }),
    );
    const stopped = await t.run({ MAX_NEW_POSTS: "3", OLD_POST_DAYS: "0" });
    assert.equal(stopped.code, 1);
    assert.equal(stopped.output.extraction_failed, "true");
    assert.equal(closes(stopped), false, "a failed check");

    // The feed cannot be read a first and a second time: the counters see no
    // problem yet, and the run is no evidence of health either.
    feed.state.status = 503;
    for (const attempt of [1, 2]) {
      const bad = await t.run();
      assert.equal(bad.code, 0, bad.stderr);
      assert.equal(bad.output.extraction_failed, "false");
      assert.equal(bad.output.feed_problem, "false");
      assert.equal(bad.output.feed_read, "false");
      assert.equal(
        stepRuns(before, bad.output),
        true,
        `the old condition closed the issue after bad read ${attempt}`,
      );
      assert.equal(closes(bad), false, `bad read ${attempt}`);
    }
    // An established problem keeps it open, on the day of the alert and after it.
    const env = { FETCH_FAILURE_RUNS: "3" };
    const alert = await t.run(env);
    assert.deepEqual(
      [alert.output.extraction_failed, alert.output.feed_problem],
      ["true", "true"],
    );
    assert.equal(closes(alert), false, "the alert day");
    const frozen = await t.run(env);
    assert.deepEqual(
      [frozen.output.extraction_failed, frozen.output.feed_problem],
      ["false", "true"],
    );
    assert.equal(closes(frozen), false, "an established problem");

    // A corrupt tracker is a failed check.
    feed.state.status = 200;
    await writeFile(t.files.tracker, "{ not json");
    const corrupt = await t.run();
    assert.equal(corrupt.output.feed_read, "false");
    assert.equal(closes(corrupt), false, "a corrupt tracker");

    // The feed is read again: only now the issue closes.
    await rm(t.files.tracker);
    const back = await t.run();
    assert.equal(back.output.feed_read, "true");
    assert.equal(closes(back), true, "the feed is read again");
  } finally {
    await feed.close();
    await t.cleanup();
  }
});

test("a manual run can force the baseline with the input the failsafe message names", () => {
  const dispatch =
    workflow.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ?? "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/);
  assert.match(dispatch, /^ {8}type: boolean$/m);
  assert.match(dispatch, /^ {8}default: false$/m);
  assert.match(
    stepText(STEP_CHECK),
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
});

// ---------------------------------------------------------------------------
// The documentation
// ---------------------------------------------------------------------------
test("the Skills Hub Watch runbook documents the watch with the same filter, feed and files as the script", () => {
  const runbook = readFileSync(
    join(root, "docs", "monitors", "skills-hub-watch.md"),
    "utf8",
  );
  assert.match(runbook, /^# Skills Hub Watch$/m);
  for (const needle of [
    RELEVANCE_RE.source,
    FEED_URL,
    "scripts/skills-hub-watch.mjs",
    ".github/workflows/skills-hub-watch.yml",
    "src/data_files/skills-hub-posts.json",
    "tests/scripts/skills-hub-watch.test.mjs",
    "force_baseline",
    "OLD_POST_DAYS",
    "MAX_NEW_POSTS",
    "00:20, 06:20, 12:20 and 18:20 UTC",
    "DEFINITE_FAILURE_RUNS",
    "FETCH_FAILURE_RUNS",
  ]) {
    assert.ok(runbook.includes(needle), `the runbook mentions ${needle}`);
  }
  assert.ok(
    !/task board|tasks\.mjs|\.tasks\./i.test(runbook),
    "nothing about the private board",
  );
});
