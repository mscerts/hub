import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ATTENTION_ISSUE_TITLE,
  FAILED_ISSUE_TITLE,
  LINES_FORMAT,
  applyResults,
  attentionState,
  buildAttentionReport,
  buildIssueTitle,
  buildReport,
  citationsOf,
  citedCell,
  compareValidators,
  contentFileSet,
  credentialsSitemapFiles,
  decodeEntities,
  diffLines,
  durationText,
  hashLines,
  htmlToLines,
  isLearnHost,
  loadConfig,
  missingFeeds,
  normalizeEtag,
  normalizeTracker,
  normalizeWatchList,
  parseHtmlSource,
  parseSitemapUrls,
  readAllSources,
  removeElements,
  renderDiff,
  safeText,
  scanContentUrls,
  storedLines,
  summarizeDiff,
  syncAttentionIssue,
  syncFailureIssue,
  syncIssue,
  trackerContent,
  urlKeys,
} from "../../scripts/source-watch.mjs";
import { listOpenIssues } from "../../scripts/lib/gh.mjs";
import { retryDelayMs } from "../../scripts/lib/retry.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/source-watch.mjs");
const FIXTURES = join(root, "tests/fixtures/source-watch");
const LEARN_PAGE = readFileSync(join(FIXTURES, "learn-policy.html"), "utf8");
const NO_MAIN_PAGE = readFileSync(join(FIXTURES, "no-main.html"), "utf8");
const TODAY = "2026-10-14";
// The options of a page that is on a Learn host (the real list has them on learn.microsoft.com).
const LEARN = { learn: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const watchOf = (...entries) => normalizeWatchList({ sources: entries });
const htmlEntry = (name, extra = {}) => ({
  url: `https://example.test/${name}`,
  kind: "html",
  label: `Page ${name}`,
  ...extra,
});
const pdfEntry = (name, extra = {}) => ({
  url: `https://example.test/${name}.pdf`,
  kind: "pdf",
  label: `File ${name}`,
  ...extra,
});
const readOf = (lines, extra = {}) => ({
  ok: true,
  lines,
  hash: hashLines(lines),
  updatedAt: "2026-10-01",
  ...extra,
});
const pdfRead = (
  validators,
  resolvedUrl = "https://cdn.example.test/a.pdf",
) => ({
  ok: true,
  validators,
  resolvedUrl,
});
const recordOf = (source, lines, extra = {}) => ({
  url: source.url,
  label: source.label,
  kind: "html",
  contentHash: hashLines(lines),
  lines,
  ...extra,
});
const trackerOf = (sources, extra = {}) => ({
  lastSynced: "2026-10-01",
  format: LINES_FORMAT,
  attention: null,
  sources,
  ...extra,
});
const OPTS = { today: TODAY, force: false, maxChanged: 8, failureRuns: 3 };
/** A record or tracker as it is written to disk: without the keys that hold undefined. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A page of `n` distinct text lines, so that changes are easy to make. */
const textLines = (n, tag = "Line") => [
  "# Title",
  ...Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`),
];

function article(items = ["First rule", "Second rule", "Third rule"]) {
  return [
    "# Policy title",
    "Intro paragraph.",
    "## Rules",
    ...items.map((item) => `- ${item}`),
    "Closing paragraph one.",
    "Closing paragraph two.",
  ];
}

const learnHtml = (
  title,
  items = ["First rule", "Second rule", "Third rule"],
) =>
  `<html><head><title>${title}</title><meta name="updated_at" content="2026-10-01T10:00:00Z" /></head>` +
  `<body><nav>Site navigation</nav><main><div class="content"><h1>${title}</h1></div>` +
  `<div class="content"><p>Intro paragraph.</p><h2>Rules</h2><ul>${items
    .map((item) => `<li>${item}</li>`)
    .join(
      "",
    )}</ul><p>Closing paragraph one.</p><p>Closing paragraph two.</p></div>` +
  `<div id="feedback">Was this page helpful?</div></main><footer>Footer chrome</footer></body></html>`;

/** The same article text in different clothes (ids, classes, wraps, entities, chrome, dates). */
function reformat(html) {
  return html
    .replace(/class="([^"]*)"/g, (whole, value) =>
      value.split(/\s+/).includes("content") ? whole : 'class="restyled"',
    )
    .replace(/\bid="[^"]*"/g, 'id="x"')
    .replace(/href="[^"]*"/g, 'href="/moved/elsewhere"')
    .replace(/(\w) (\w)/g, "$1\n    $2")
    .replace(/ hours/g, "&nbsp;hours")
    .replace(/certification/g, "certi&shy;fication")
    .replace(/2026-07-27T21:34:00Z/g, "2026-10-12T05:00:00Z")
    .replace(/\n/g, "\r\n");
}

// ---------------------------------------------------------------------------
// Text -> lines
// ---------------------------------------------------------------------------
test("htmlToLines makes one line per block and normalizes entities, spaces and soft breaks", () => {
  const lines = htmlToLines(
    '<h2 id="a">A &amp; B</h2>\n<p>Some   text\n  that was wrapped, it&#39;s &lt;fine&gt; &amp;amp; more&nbsp;text.</p>' +
      '<ul><li>One</li><li><p>Two <a href="/x">link</a></p>\n</li><li></li></ul>' +
      "<table><tr><th>Head 1</th><th>Head 2</th></tr><tr><td>Cell 1</td><td>Cell 2</td></tr></table>" +
      "<h3></h3><p>soft&shy;hyphen and zero&#8203;width</p><p> </p><!-- gone --><script>var x = 1;</script>",
  );
  assert.deepEqual(lines, [
    "## A & B",
    "Some text that was wrapped, it's <fine> &amp; more text.",
    "- One",
    "- Two link",
    "Head 1 | Head 2",
    "Cell 1 | Cell 2",
    "softhyphen and zerowidth",
  ]);
});

test("entities are decoded once, in one pass, and unknown names stay text", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(
    decodeEntities("&constructor; &nosuch; &#x41;&#66;"),
    "&constructor; &nosuch; AB",
  );
  assert.equal(decodeEntities("&#99999999999;"), "");
});

test("a Learn page yields its article text only, never the page chrome", () => {
  const parsed = parseHtmlSource(LEARN_PAGE, LEARN);
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.lines[0],
    "# Exam and Applied Skills assessment lab retake policies",
  );
  assert.equal(parsed.lines.length, 34);
  assert.ok(
    parsed.lines.includes(
      "- If you don’t pass an exam the first time, you must wait 24 hours before retaking it.",
    ),
  );
  const text = parsed.lines.join("\n");
  for (const chrome of [
    "Skip to main content",
    "Table of contents",
    "Ask Learn",
  ]) {
    assert.ok(!text.includes(chrome), `${chrome} is page chrome`);
  }
  assert.equal(parsed.updatedAt, "2026-07-27");
});

test("only a Learn host's article is its content blocks: on any other site a div.content wrapper does not hide the rest of <main>", () => {
  // The first read of a source must be right: the text is the hash input, so
  // fixing the mode later would be a LINES_FORMAT bump.
  const page =
    '<main><div class="content"><h1>T</h1><p>a</p></div><p>outside</p></main>';
  const other = parseHtmlSource(page, { minLines: 1 });
  assert.equal(other.ok, true);
  assert.deepEqual(other.lines, ["# T", "a", "outside"]);
  assert.deepEqual(
    parseHtmlSource(page, { minLines: 1, learn: false }).lines,
    other.lines,
    "not a Learn host is the default",
  );
  const learn = parseHtmlSource(page, { minLines: 1, learn: true });
  assert.deepEqual(learn.lines, ["# T", "a"]);

  // Why Learn is read through its blocks: <main> also holds a "Last updated"
  // line and sign-in notes that move without the article changing.
  const whole = parseHtmlSource(LEARN_PAGE);
  assert.equal(whole.ok, true);
  assert.equal(whole.lines.length, 40);
  assert.ok(whole.lines.includes("- Last updated on 2026-07-27"));
  assert.ok(
    !parseHtmlSource(LEARN_PAGE, LEARN).lines.includes(
      "- Last updated on 2026-07-27",
    ),
  );
  // A wrapper on another site that holds the title and more than the blocks.
  const wrapped = parseHtmlSource(
    '<main><div class="content wide"><h1>Offer</h1></div><h2>Terms</h2><p>Ends on 1 December.</p></main>',
    { minLines: 1 },
  );
  assert.deepEqual(wrapped.lines, [
    "# Offer",
    "## Terms",
    "Ends on 1 December.",
  ]);
});

test("a URL is on a Learn host when its host name is one of them, whatever the case", () => {
  const hosts = ["learn.microsoft.com", "127.0.0.1"];
  for (const url of [
    "https://learn.microsoft.com/en-us/credentials/support/retake-policy?WT.mc_id=x",
    "https://LEARN.Microsoft.com/x",
    "http://127.0.0.1:8080/page",
  ]) {
    assert.equal(isLearnHost(url, hosts), true, url);
  }
  for (const url of [
    "https://azure.microsoft.com/free/students/",
    "https://learn.microsoft.com.evil.example/x",
    "https://microsoft.com/learn.microsoft.com",
    "not a url",
    "",
  ]) {
    assert.equal(isLearnHost(url, hosts), false, url);
  }
  assert.equal(isLearnHost("https://learn.microsoft.com/x", []), false);
});

test("the hash ignores formatting, ids, classes, links, entities, line wraps and chrome, but not one changed number", () => {
  const base = parseHtmlSource(LEARN_PAGE, LEARN);
  const restyled = parseHtmlSource(reformat(LEARN_PAGE), LEARN);
  assert.equal(restyled.ok, true);
  assert.deepEqual(restyled.lines, base.lines);
  assert.equal(hashLines(restyled.lines), hashLines(base.lines));
  assert.equal(
    restyled.updatedAt,
    "2026-10-12",
    "only the stated date differs",
  );

  const edited = parseHtmlSource(
    LEARN_PAGE.replace("wait 24 hours", "wait 48 hours"),
    LEARN,
  );
  assert.notEqual(hashLines(edited.lines), hashLines(base.lines));
  const summary = summarizeDiff(base.lines, edited.lines);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
});

test("a site without <main> is read from the body with its chrome removed, only when asked to", () => {
  assert.deepEqual(parseHtmlSource(NO_MAIN_PAGE), {
    ok: false,
    reason: "no <main> element",
  });
  const parsed = parseHtmlSource(NO_MAIN_PAGE, { root: "body" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.lines.length, 53);
  assert.equal(parsed.lines[0], "Home/ Exam Replay");
  assert.ok(
    parsed.lines.some((line) => line.startsWith("Q. What is Exam Replay?")),
  );
  assert.deepEqual(parseHtmlSource("<html></html>", { root: "body" }), {
    ok: false,
    reason: "no <body> element",
  });
});

test("a page that is hardly a page, or too long to store, is not an article", () => {
  const tiny = parseHtmlSource(
    '<main><div class="content"><h1>Sign in</h1><p>Please sign in.</p></div></main>',
    LEARN,
  );
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /only 2 text lines \(expected at least 5\)/);

  const long = parseHtmlSource(
    learnHtml(
      "Long",
      Array.from({ length: 30 }, (_, i) => `Rule ${i}`),
    ),
    {
      ...LEARN,
      maxLines: 20,
    },
  );
  assert.equal(long.ok, false);
  assert.match(long.reason, /more than the 20 this monitor stores per page/);

  // Content blocks without a title are not "the article": the whole <main> is read.
  const untitled = parseHtmlSource(
    `<main><div class="content"><p>A</p><p>B</p><p>C</p><p>D</p><p>E</p></div><p>F</p></main>`,
    LEARN,
  );
  assert.equal(untitled.ok, true);
  assert.deepEqual(untitled.lines, ["A", "B", "C", "D", "E", "F"]);
});

test("a malformed updated_at never reaches the issue", () => {
  const parsed = parseHtmlSource(
    learnHtml("T").replace("2026-10-01T10:00:00Z", "<img src=x>"),
    LEARN,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.updatedAt, "");
});

test("skipSections drops a volatile section up to the next heading of the same or a higher level", () => {
  const page = (catalogue) =>
    `<main><h1>Student offer</h1><p>Credit: $100.</p><p>Renews yearly.</p>` +
    `<h2>Account types</h2><p>Eligibility text.</p>` +
    `<h2>Free services</h2><p>Intro to the catalogue.</p><h3>Azure DevOps</h3><p>${catalogue}</p><h3>Other</h3><p>Another</p>` +
    `<h2>Get started</h2><p>Sign up.</p></main>`;
  const options = { skipSections: ["Free services"], minLines: 1 };
  const a = parseHtmlSource(page("5 users"), options);
  const b = parseHtmlSource(page("10 users, new!"), options);
  assert.equal(a.ok, true);
  assert.deepEqual(a.lines, [
    "# Student offer",
    "Credit: $100.",
    "Renews yearly.",
    "## Account types",
    "Eligibility text.",
    "## Get started",
    "Sign up.",
  ]);
  assert.equal(
    hashLines(a.lines),
    hashLines(b.lines),
    "the catalogue is not watched",
  );
  // without the option the catalogue decides the hash
  assert.notEqual(
    hashLines(parseHtmlSource(page("5 users"), { minLines: 1 }).lines),
    hashLines(parseHtmlSource(page("10 users, new!"), { minLines: 1 }).lines),
  );
  // the heading is gone: a layout change, not silence
  const renamed = parseHtmlSource(
    page("5 users").replace("Free services", "Products"),
    options,
  );
  assert.equal(renamed.ok, false);
  assert.match(
    renamed.reason,
    /the section "Free services" \(skipSections\) is no longer on the page/,
  );
});

test("removeElements removes nested elements of one name and not look-alikes", () => {
  assert.equal(
    removeElements(
      "a<nav>x<nav>y</nav>z</nav>b<nav-menu>keep</nav-menu>c<nav/>d",
      ["nav"],
    ),
    "ab<nav-menu>keep</nav-menu>cd",
  );
});

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------
test("the line diff names the headings a change sits under and shows removed and added lines", () => {
  const before = article();
  const after = article([
    "First rule",
    "Changed rule",
    "Third rule",
    "Fourth rule",
  ]);
  const summary = summarizeDiff(before, after);
  assert.equal(summary.added, 2);
  assert.equal(summary.removed, 1);
  const text = renderDiff(summary.entries, 50);
  assert.equal(text.shown, 3);
  assert.equal(text.omitted, 0);
  // two hunks: the unchanged "Third rule" separates the edit from the added line
  assert.equal(
    text.text,
    [
      "@@ Policy title > Rules @@",
      "- - Second rule",
      "+ - Changed rule",
      "@@ Policy title > Rules @@",
      "+ - Fourth rule",
    ].join("\n"),
  );
  assert.deepEqual(
    diffLines(["a", "b"], ["a", "b"]).map((op) => op.t),
    ["=", "="],
  );
});

test("a long diff is cut with a count of what is left out, long lines are clipped and fences cannot break out", () => {
  const before = textLines(5);
  const after = [
    ...before,
    ...Array.from(
      { length: 30 },
      (_, i) => `Added ${i} ${"x".repeat(400)} \`\`\`\`\` end`,
    ),
  ];
  const summary = summarizeDiff(before, after);
  const rendered = renderDiff(summary.entries, 10);
  assert.equal(rendered.shown, 10);
  assert.equal(rendered.omitted, 20);
  for (const line of rendered.text.split("\n")) {
    assert.ok(line.length <= 302 + 2, "lines are clipped");
    assert.ok(!line.includes("```"), "three backticks never survive");
  }
});

// ---------------------------------------------------------------------------
// URL keys, the watch list and who cites what
// ---------------------------------------------------------------------------
test("two links are the same page when host and path match, whatever the locale, slash, case, fragment or tracking", () => {
  const keys = (url) => urlKeys(url).path;
  const one = keys(
    "https://learn.microsoft.com/en-us/credentials/support/retake-policy/?WT.mc_id=studentamb_165290#x",
  );
  assert.equal(one, "learn.microsoft.com/credentials/support/retake-policy");
  assert.equal(
    keys("https://LEARN.microsoft.com/credentials/support/Retake-Policy"),
    one,
  );
  assert.equal(
    urlKeys("https://x.test/p?id=2&WT.mc_id=a&utm_source=b").full,
    "x.test/p?id=2",
  );
  assert.equal(urlKeys("https://x.test/p?id=2").hasQuery, true);
  assert.equal(urlKeys("https://x.test/p").hasQuery, false);
  assert.equal(urlKeys("mailto:a@b.c"), null);
  assert.equal(urlKeys("not a url"), null);
});

test("the watch list is validated: a typo is an error, not a silently unwatched page", () => {
  const bad = (entry, message) =>
    assert.throws(
      () => watchOf(entry),
      (error) => {
        assert.match(error.message, message);
        return true;
      },
    );
  assert.throws(() => normalizeWatchList({}), /missing sources array/);
  bad(null, /not an object/);
  bad({ kind: "html", label: "x" }, /no valid http\(s\) url/);
  bad(
    { url: "ftp://x.test/a", kind: "html", label: "x" },
    /no valid http\(s\) url/,
  );
  bad(htmlEntry("a", { label: " " }), /has no label/);
  bad(htmlEntry("a", { kind: "xml" }), /expected html or pdf/);
  bad(htmlEntry("a", { root: "head" }), /expected main or body/);
  bad(htmlEntry("a", { aliases: ["nope"] }), /malformed aliases list/);
  bad(
    htmlEntry("a", { alsoFeeds: ["docs/x.mdx"] }),
    /malformed alsoFeeds list/,
  );
  bad(htmlEntry("a", { skipSections: [" "] }), /malformed skipSections list/);
  bad(
    pdfEntry("a", { skipSections: ["Intro"] }),
    /only an html source can have/,
  );
  assert.throws(
    () => watchOf(htmlEntry("a"), htmlEntry("a")),
    /repeats the url/,
  );

  const [ok] = watchOf(
    htmlEntry("a", {
      label: "  A   page ",
      note: " a  note ",
      aliases: ["https://x.test/old"],
      alsoFeeds: ["src/content/docs/guide/x.mdx"],
      skipSections: ["Catalogue"],
    }),
  );
  assert.equal(ok.label, "A page");
  assert.equal(ok.note, "a note");
  assert.equal(ok.root, "main");
  assert.deepEqual(ok.skipSections, ["Catalogue"]);
});

async function contentDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "source-watch-content-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the pages that cite a source are found by link, alias or alsoFeeds, comments do not count, and the line is the first one", async () => {
  const content = await contentDir({
    "docs/guide/retake.mdx":
      "---\ntitle: Retake\n---\n\nText.\n\nSee [policy](https://learn.example/en-us/credentials/support/retake-policy?WT.mc_id=x).\nAgain https://learn.example/credentials/support/retake-policy/ here.\n",
    "docs/guide/old.mdx":
      "Old link https://learn.example/certifications/exam-retake-policy.\n",
    "docs/guide/commented.mdx":
      "{/* https://learn.example/credentials/support/retake-policy */}\n<!-- https://learn.example/credentials/support/retake-policy -->\n\nNothing.\n",
    "docs/vouchers/event.mdx":
      "[a](https://events.example/week?id=1) and [b](https://events.example/week?id=2)\n",
    "blog/post.md": "https://learn.example/credentials/support/retake-policy\n",
  });
  try {
    const urls = scanContentUrls(content.dir);
    const files = contentFileSet(content.dir);
    const [retake, event] = watchOf(
      htmlEntry("x", {
        url: "https://learn.example/credentials/support/retake-policy",
        aliases: ["https://learn.example/certifications/exam-retake-policy"],
        alsoFeeds: [
          "src/content/docs/guide/restated.mdx",
          "src/content/docs/guide/does-not-exist.mdx",
        ],
      }),
      htmlEntry("y", { url: "https://events.example/week?id=2" }),
    );
    const refs = citationsOf(
      retake,
      urls,
      new Set([...files, "src/content/docs/guide/restated.mdx"]),
    );
    assert.deepEqual(refs, [
      { file: "src/content/blog/post.md", line: 1, via: "link" },
      { file: "src/content/docs/guide/old.mdx", line: 1, via: "link" },
      { file: "src/content/docs/guide/restated.mdx", line: 0, via: "restated" },
      { file: "src/content/docs/guide/retake.mdx", line: 7, via: "link" },
    ]);
    assert.equal(citedCell(refs).split("<br>").length, 4);
    assert.match(citedCell(refs), /`src\/content\/docs\/guide\/restated\.mdx`/);

    // a source whose URL carries a query is matched with its query
    assert.deepEqual(citationsOf(event, urls, files), [
      { file: "src/content/docs/vouchers/event.mdx", line: 1, via: "link" },
    ]);
    // the alsoFeeds page that does not exist is reported, not cited
    assert.deepEqual(
      missingFeeds([retake], files).map((entry) => entry.file),
      [
        "src/content/docs/guide/restated.mdx",
        "src/content/docs/guide/does-not-exist.mdx",
      ],
    );
    assert.equal(citedCell([]), "—");
    assert.match(
      citedCell(
        Array.from({ length: 5 }, (_, i) => ({
          file: `src/content/a${i}.mdx`,
          line: 1,
          via: "link",
        })),
      ),
      /\+2 more/,
    );
  } finally {
    await content.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tracker file
// ---------------------------------------------------------------------------
test("a corrupt tracker is rejected, not repaired", () => {
  const bad = (value, message) =>
    assert.throws(
      () => normalizeTracker(value),
      (error) => {
        assert.match(error.message, message);
        return true;
      },
    );
  bad(null, /missing sources array/);
  bad({ sources: "x" }, /missing sources array/);
  bad({ sources: [{ url: "nope" }] }, /no valid url/);
  bad(
    { sources: [{ url: "https://x.test/a" }, { url: "https://x.test/a" }] },
    /repeats the url/,
  );
  bad(
    { sources: [{ url: "https://x.test/a", contentHash: "abc" }] },
    /malformed contentHash/,
  );
  bad(
    { sources: [{ url: "https://x.test/a", lines: [1] }] },
    /malformed stored lines/,
  );
  bad(
    { sources: [{ url: "https://x.test/a", validators: [] }] },
    /malformed validators/,
  );
  bad(
    { sources: [], attention: { signature: "zz" } },
    /malformed attention record/,
  );
});

test("the tracker file has a fixed key order, drops what is not set and survives a round trip", () => {
  const [html, pdf] = watchOf(htmlEntry("a"), pdfEntry("b"));
  const lines = textLines(6);
  const tracker = trackerOf(
    [
      recordOf(html, lines, { lastChanged: "2026-09-01" }),
      {
        url: pdf.url,
        label: pdf.label,
        kind: "pdf",
        contentHash: null,
        resolvedUrl: "https://cdn.example.test/b.pdf",
        validators: {
          etag: '"e1"',
          lastModified: "2026-09-02T00:00:00.000Z",
          contentLength: 10,
        },
      },
    ],
    { attention: { signature: "0123456789abcdef", since: "2026-10-01" } },
  );
  const text = trackerContent(tracker);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    "lastSynced",
    "format",
    "attention",
    "sources",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(text).sources[0]), [
    "url",
    "label",
    "kind",
    "contentHash",
    "lastChanged",
    "lines",
  ]);
  assert.ok(!text.includes("failures"), "unset fields are not written");
  const again = normalizeTracker(JSON.parse(text));
  assert.equal(trackerContent(again), text);
});

// ---------------------------------------------------------------------------
// Validators of a PDF
// ---------------------------------------------------------------------------
test("validators compare on the fields both reads have, and an ETag is normalized", () => {
  assert.equal(normalizeEtag('W/"abc"'), '"abc"');
  assert.equal(normalizeEtag('"abc-gzip"'), '"abc"');
  assert.equal(normalizeEtag(null), "");
  assert.deepEqual(
    compareValidators(
      { etag: '"a"', contentLength: 5 },
      { etag: '"a"', contentLength: 5 },
    ),
    {
      comparable: true,
      changes: [],
    },
  );
  assert.deepEqual(
    compareValidators(
      { etag: '"a"', contentLength: 5 },
      { etag: '"b"', contentLength: 5 },
    ).changes,
    [{ field: "etag", before: '"a"', after: '"b"' }],
  );
  assert.equal(
    compareValidators({ etag: '"a"' }, { contentLength: 5 }).comparable,
    false,
  );
  assert.equal(compareValidators(undefined, { etag: '"a"' }).comparable, false);
});

// ---------------------------------------------------------------------------
// Applying reads to the tracker
// ---------------------------------------------------------------------------
test("a source without stored text is baselined silently, the first run records everything", () => {
  const watch = watchOf(htmlEntry("a"), pdfEntry("b"));
  const result = applyResults(
    trackerOf([]),
    watch,
    [readOf(article()), pdfRead({ etag: '"v1"', contentLength: 10 })],
    OPTS,
  );
  assert.equal(result.baselined.length, 2);
  assert.equal(result.changed.length, 0);
  const [html, pdf] = result.tracker.sources;
  assert.deepEqual(html.lines, article());
  assert.equal(html.contentHash, hashLines(article()));
  assert.equal(html.lastChanged, undefined);
  assert.deepEqual(pdf.validators, { etag: '"v1"', contentLength: 10 });
  assert.equal(pdf.resolvedUrl, "https://cdn.example.test/a.pdf");
});

test("the same hash is no change at all, a changed hash with stored text is a change with a diff", () => {
  const [source] = watchOf(htmlEntry("a"));
  const lines = article();
  const same = applyResults(
    trackerOf([recordOf(source, lines)]),
    [source],
    [readOf(lines)],
    OPTS,
  );
  assert.equal(same.unchanged.length, 1);
  assert.equal(same.changed.length, 0);
  assert.deepEqual(plain(same.tracker.sources[0]), recordOf(source, lines));

  const newer = article(["First rule", "Second rule changed", "Third rule"]);
  const changed = applyResults(
    trackerOf([recordOf(source, lines, { lastChanged: "2026-09-01" })]),
    [source],
    [readOf(newer)],
    OPTS,
  );
  assert.equal(changed.changed.length, 1);
  const [entry] = changed.changed;
  assert.equal(entry.diff.added, 1);
  assert.equal(entry.diff.removed, 1);
  assert.equal(entry.kind, "html");
  assert.equal(changed.tracker.sources[0].lastChanged, TODAY);
  assert.deepEqual(changed.tracker.sources[0].lines, newer);
  // the new text is the baseline of the next run
  const next = applyResults(changed.tracker, [source], [readOf(newer)], OPTS);
  assert.equal(next.changed.length, 0);
  assert.equal(next.unchanged.length, 1);
});

test("stored text that does not hash to the stored hash, or has another format, is not a previous version", () => {
  const [source] = watchOf(htmlEntry("a"));
  const lines = article();
  const good = recordOf(source, lines);
  assert.deepEqual(storedLines(good, LINES_FORMAT), lines);
  assert.equal(storedLines(good, LINES_FORMAT + 1), null);
  assert.equal(
    storedLines({ ...good, lines: [...lines, "edited by hand"] }, LINES_FORMAT),
    null,
  );
  assert.equal(storedLines({ ...good, lines: undefined }, LINES_FORMAT), null);
  assert.equal(storedLines({ ...good, contentHash: null }, LINES_FORMAT), null);
  assert.equal(storedLines({ ...good, kind: "pdf" }, LINES_FORMAT), null);
  assert.equal(storedLines(null, LINES_FORMAT), null);

  const newer = article(["Brand new"]);
  for (const stale of [
    trackerOf([{ ...good, lines: [...lines, "edited by hand"] }]),
    trackerOf([good], { format: LINES_FORMAT + 1 }),
    trackerOf([{ ...good, lines: undefined }]),
  ]) {
    const result = applyResults(stale, [source], [readOf(newer)], OPTS);
    assert.equal(
      result.changed.length,
      0,
      "the change of a normalization is not a change of the page",
    );
    assert.equal(result.baselined.length, 1);
    assert.deepEqual(result.tracker.sources[0].lines, newer);
    assert.equal(result.tracker.format, LINES_FORMAT);
  }
});

test("a failed read during a format change does not keep text of the old format as if it were of the new one", () => {
  const [source] = watchOf(htmlEntry("a"));
  const lines = article();
  const old = trackerOf([recordOf(source, lines)], {
    format: LINES_FORMAT - 1,
  });
  // The page cannot be read on the day the normalization changes: the record is
  // kept, but its text is of the old format and must not survive under the new one.
  const failed = applyResults(
    old,
    [source],
    [{ ok: false, kind: "fetch", reason: "HTTP 500" }],
    OPTS,
  );
  assert.equal(failed.tracker.format, LINES_FORMAT);
  assert.equal(failed.tracker.sources[0].lines, undefined);
  assert.equal(failed.tracker.sources[0].failures, 1);

  // The next good read is a baseline, never a change of the page: without that,
  // the new normalization of the same text would look like an edit.
  const next = applyResults(
    failed.tracker,
    [source],
    [readOf(article(["Reworded rule"]))],
    { ...OPTS, today: "2026-10-16" },
  );
  assert.equal(next.changed.length, 0);
  assert.equal(next.baselined.length, 1);

  // Within the current format the text is kept through a failed read.
  const current = applyResults(
    trackerOf([recordOf(source, lines)]),
    [source],
    [{ ok: false, kind: "fetch", reason: "HTTP 500" }],
    OPTS,
  );
  assert.deepEqual(current.tracker.sources[0].lines, lines);
});

test("a source that fails keeps its record, counts one failure per UTC day, freezes at the limit and recovers cleanly", () => {
  const [source] = watchOf(htmlEntry("a"));
  const lines = article();
  const failed = { ok: false, kind: "fetch", reason: "HTTP 500" };
  let tracker = trackerOf([recordOf(source, lines)]);
  const step = (read, today) => {
    const result = applyResults(tracker, [source], [read], { ...OPTS, today });
    tracker = result.tracker;
    return result;
  };

  const day1 = step(failed, "2026-10-14");
  assert.equal(day1.failed.length, 1);
  assert.equal(day1.changed.length, 0);
  let record = tracker.sources[0];
  assert.equal(record.failures, 1);
  assert.equal(record.failingSince, "2026-10-14");
  assert.equal(record.lastFailure, "HTTP 500");
  assert.deepEqual(record.lines, lines, "the last good text is kept");
  assert.equal(record.contentHash, hashLines(lines));

  step(failed, "2026-10-14");
  assert.equal(
    tracker.sources[0].failures,
    1,
    "a second run on the same UTC day counts once",
  );
  step(failed, "2026-10-15");
  assert.equal(tracker.sources[0].failures, 2);
  step({ ok: false, kind: "parse", reason: "no <main> element" }, "2026-10-16");
  assert.equal(tracker.sources[0].failures, 3);
  assert.equal(tracker.sources[0].failingSince, "2026-10-14");
  const frozen = JSON.stringify(tracker);
  const day4 = step(failed, "2026-10-17");
  assert.equal(
    JSON.stringify(tracker),
    frozen,
    "a source that stays dead produces no churn",
  );
  assert.equal(day4.failed.length, 1);

  // a healthy read ends the streak; unchanged text is not a change
  const healthy = step(readOf(lines), "2026-10-18");
  assert.equal(healthy.unchanged.length, 1);
  record = tracker.sources[0];
  for (const field of [
    "failures",
    "failingSince",
    "lastFailedOn",
    "lastFailure",
  ]) {
    assert.equal(record[field], undefined, field);
  }
  // text that changed while the source was failing is a change when it comes back
  tracker = trackerOf([
    recordOf(source, lines, {
      failures: 3,
      failingSince: "2026-10-14",
      lastFailedOn: "2026-10-16",
      lastFailure: "x",
    }),
  ]);
  const back = step(readOf(article(["Different"])), "2026-10-19");
  assert.equal(back.changed.length, 1);
});

test("a source that is not an article is reported as such and never as a change", () => {
  const [source] = watchOf(htmlEntry("a"));
  const result = applyResults(
    trackerOf([recordOf(source, article())]),
    [source],
    [
      {
        ok: false,
        kind: "parse",
        reason: "only 2 text lines (expected at least 5)",
      },
    ],
    OPTS,
  );
  assert.equal(result.unparsed.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.changed.length, 0);
  assert.deepEqual(result.tracker.sources[0].lines, article());
});

test("a PDF is a change only when a validator both reads have differs or its address moved", () => {
  const [source] = watchOf(pdfEntry("a"));
  const base = {
    etag: '"v1"',
    lastModified: "2026-09-02T00:00:00.000Z",
    contentLength: 100,
  };
  const tracker = applyResults(
    trackerOf([]),
    [source],
    [pdfRead(base)],
    OPTS,
  ).tracker;
  const run = (read, from = tracker) =>
    applyResults(from, [source], [read], OPTS);

  assert.equal(run(pdfRead(base)).unchanged.length, 1);
  // the server stopped sending one validator: nothing differs on the others
  const dropped = run(pdfRead({ etag: '"v1"', contentLength: 100 }));
  assert.equal(dropped.unchanged.length, 1);
  assert.deepEqual(
    dropped.tracker.sources[0].validators,
    base,
    "what it sent before is kept",
  );

  const replaced = run(pdfRead({ ...base, etag: '"v2"', contentLength: 120 }));
  assert.equal(replaced.changed.length, 1);
  assert.deepEqual(
    replaced.changed[0].changes.map((c) => c.field),
    ["etag", "contentLength"],
  );
  assert.equal(replaced.changed[0].moved, false);
  assert.equal(replaced.tracker.sources[0].lastChanged, TODAY);

  // an alias that now points to another file
  const moved = run(pdfRead(base, "https://cdn.example.test/new-file.pdf"));
  assert.equal(moved.changed.length, 1);
  assert.equal(moved.changed[0].moved, true);
  assert.equal(moved.changed[0].changes.length, 0);

  // no field in common: the reads cannot be compared, so this is a baseline
  const incomparable = run(
    pdfRead({ lastModified: "2026-10-10T00:00:00.000Z" }),
    {
      ...tracker,
      sources: [{ ...tracker.sources[0], validators: { etag: '"v1"' } }],
    },
  );
  assert.equal(incomparable.changed.length, 0);
  assert.equal(incomparable.baselined.length, 1);
});

test("more changed sources than the limit are held back: nothing is recorded for them, unless the change is accepted", () => {
  const sources = watchOf(...["a", "b", "c", "d"].map((n) => htmlEntry(n)));
  const before = sources.map((s) => recordOf(s, article([`${s.label} old`])));
  const reads = sources.map((s, i) =>
    readOf(i < 3 ? article([`${s.label} new`]) : article([`${s.label} old`])),
  );
  const held = applyResults(trackerOf(before), sources, reads, {
    ...OPTS,
    maxChanged: 2,
  });
  assert.equal(held.changed.length, 0);
  assert.equal(held.held.length, 3);
  assert.deepEqual(
    plain(held.tracker.sources),
    before,
    "the old text stays the previous version",
  );

  const accepted = applyResults(trackerOf(before), sources, reads, {
    ...OPTS,
    maxChanged: 2,
    force: true,
  });
  assert.equal(accepted.changed.length, 0);
  assert.equal(accepted.held.length, 0);
  assert.equal(accepted.accepted.length, 3);
  assert.deepEqual(accepted.tracker.sources[0].lines, article(["Page a new"]));

  // exactly the limit is still reported
  const atLimit = applyResults(trackerOf(before), sources, reads, {
    ...OPTS,
    maxChanged: 3,
  });
  assert.equal(atLimit.changed.length, 3);
});

test("a source removed from the watch list leaves the tracker, and a kind that changed is a new baseline", () => {
  const [a, b] = watchOf(htmlEntry("a"), htmlEntry("b"));
  const tracker = trackerOf([recordOf(a, article()), recordOf(b, article())]);
  const dropped = applyResults(tracker, [a], [readOf(article())], OPTS);
  assert.deepEqual(
    dropped.tracker.sources.map((s) => s.url),
    [a.url],
  );

  const [asPdf] = watchOf(pdfEntry("a", { url: a.url }));
  const switched = applyResults(
    trackerOf([recordOf(a, article())]),
    [asPdf],
    [pdfRead({ etag: '"x"' })],
    OPTS,
  );
  assert.equal(switched.baselined.length, 1);
  assert.equal(switched.changed.length, 0);
  assert.equal(switched.tracker.sources[0].kind, "pdf");
});

// ---------------------------------------------------------------------------
// The change issue
// ---------------------------------------------------------------------------
function changeOf(watch, before, after, extra = {}) {
  const result = applyResults(
    trackerOf(watch.map((source, i) => recordOf(source, before[i]))),
    watch,
    after.map((lines) => readOf(lines, extra)),
    { ...OPTS, maxChanged: 1000 },
  );
  return result.changed;
}

test("the report names the source, the hub pages that cite it, the diff and the steps", () => {
  const watch = watchOf(
    htmlEntry("a", {
      label: "Exam retake policy",
      note: "The guide quotes 24 hours.",
    }),
    htmlEntry("b", { label: "Renewal" }),
  );
  const changed = changeOf(
    watch,
    [article(), article()],
    [article(["First rule", "Second rule edited", "Third rule"]), article()],
  );
  assert.equal(changed.length, 1);
  const citations = new Map([
    [
      watch[0].url,
      [
        { file: "src/content/docs/guide/overview.mdx", line: 12, via: "link" },
        {
          file: "src/content/docs/guide/schedulingexam.mdx",
          line: 0,
          via: "restated",
        },
      ],
    ],
  ]);
  const hints = new Map([[watch[0].url, "2026-10-02"]]);
  const report = buildReport(changed, { citations, hints });
  assert.match(report, /^## Watched source changed \(1\)/);
  assert.match(
    report,
    /\| \[Exam retake policy\]\(https:\/\/example\.test\/a\) \| `src\/content\/docs\/guide\/overview\.mdx:12`<br>`src\/content\/docs\/guide\/schedulingexam\.mdx` \| \+1 \/ -1 \| 2026-10-01, sitemap 2026-10-02 \|/,
  );
  assert.match(
    report,
    /#### Exam retake policy\n\nNote: The guide quotes 24 hours\./,
  );
  assert.match(
    report,
    /Hub pages: `src\/content\/docs\/guide\/overview\.mdx:12`, `src\/content\/docs\/guide\/schedulingexam\.mdx` \(restated, not linked\)/,
  );
  assert.match(
    report,
    /```diff\n@@ Policy title > Rules @@\n- - Second rule\n\+ - Second rule edited\n```/,
  );
  assert.match(report, /### What to do/);
  assert.match(
    report,
    /"Source Watch" runbook \(`docs\/monitors\/source-watch\.md`\)/,
  );
  assert.ok(
    !report.includes("Page b") && !report.includes("Renewal"),
    "unchanged sources are not in the report",
  );
});

test("a PDF change says the file was replaced and never claims its text was compared", () => {
  const [pdf] = watchOf(pdfEntry("faq", { label: "MVTD FAQ (PDF)" }));
  const tracker = applyResults(
    trackerOf([]),
    [pdf],
    [pdfRead({ etag: '"v1"', contentLength: 10 })],
    OPTS,
  ).tracker;
  const result = applyResults(
    tracker,
    [pdf],
    [
      pdfRead(
        { etag: '"v2"', contentLength: 12 },
        "https://cdn.example.test/faq-v2.pdf",
      ),
    ],
    OPTS,
  );
  const report = buildReport(result.changed, {
    citations: new Map(),
    hints: new Map(),
  });
  assert.match(report, /\| file replaced \|/);
  assert.match(report, /not compared by text/);
  assert.match(
    report,
    /before URL: https:\/\/cdn\.example\.test\/a\.pdf\nbefore ETag: "v1"\nbefore Content-Length: 10\nafter {2}URL: https:\/\/cdn\.example\.test\/faq-v2\.pdf\nafter {2}ETag: "v2"\nafter {2}Content-Length: 12/,
  );
  assert.match(report, /Hub pages: none found by the scan\./);
  assert.ok(!/text of the PDF (has )?changed/i.test(report));
  assert.ok(!report.includes("```diff"));
});

test("a watched URL that now redirects is reported with its new address", () => {
  const [source] = watchOf(htmlEntry("a"));
  const result = applyResults(
    trackerOf([recordOf(source, article())]),
    [source],
    [
      readOf(article(["Changed"]), {
        redirectedTo: "https://example.test/moved/a",
      }),
    ],
    OPTS,
  );
  const report = buildReport(result.changed, {
    citations: new Map(),
    hints: new Map(),
  });
  assert.match(
    report,
    /now redirects to https:\/\/example\.test\/moved\/a\. The page moved/,
  );
});

test("text from a source cannot ping, link or render HTML in the issue", () => {
  const [source] = watchOf(
    htmlEntry("a", {
      label:
        "Evil @maintainer #123 [x](http://e.example) <img src=x> `code` | pipe",
      note: "Note <b>@everyone</b> #9",
    }),
  );
  const nasty = [
    "# Title",
    "@everyone please fix #123 <script>alert(1)</script> ````` ``` end",
    "![img](http://evil.example/x.png)",
    "Plain.",
    "Plain two.",
    "Plain three.",
  ];
  const changed = changeOf([source], [article()], [nasty]);
  const report = buildReport(changed, {
    citations: new Map(),
    hints: new Map(),
  });
  const fenced = [...report.matchAll(/```diff\n([\s\S]*?)\n```/g)]
    .map((m) => m[1])
    .join("\n");
  assert.ok(fenced.includes("@everyone"), "page text appears inside the fence");
  const outside = report.replace(/```diff\n[\s\S]*?\n```/g, "");
  assert.ok(!outside.includes("@everyone"));
  assert.ok(!outside.includes("@maintainer"), "mentions are broken up");
  assert.ok(!outside.includes("#123"), "cross references are broken up");
  assert.ok(
    !outside.includes("<img") &&
      !outside.includes("<b>") &&
      !outside.includes("<script"),
  );
  assert.equal(
    (report.match(/```/g) ?? []).length,
    2,
    "exactly one fence, opened and closed once",
  );
  assert.equal(safeText("a|b `c` <d> [e]"), "a b c d e");
});

test("the report stays under GitHub's size limit by shortening the diffs in steps", () => {
  const watch = watchOf(
    ...Array.from({ length: 10 }, (_, i) => htmlEntry(`s${i}`)),
  );
  const before = watch.map(() => textLines(5));
  const after = watch.map((_, i) => [
    ...textLines(5),
    ...Array.from(
      { length: 400 },
      (_, j) => `Added ${i}-${j} ${"y".repeat(280)}`,
    ),
  ]);
  const changed = changeOf(watch, before, after);
  assert.equal(changed.length, 10);
  const report = buildReport(changed, {
    citations: new Map(),
    hints: new Map(),
  });
  assert.ok(report.length <= 60000, `report is ${report.length} characters`);
  assert.match(
    report,
    /The diffs are shortened to keep this issue under GitHub's size limit/,
  );
  assert.match(
    report,
    /400 added and 0 removed lines/,
    "the counts stay exact",
  );
  assert.match(report, /more changed lines are not shown here/);
  for (const source of watch)
    assert.ok(report.includes(`Page ${source.url.split("/").pop()}`));
});

test("the issue title names the sources, drops parentheses and never exceeds 200 characters", () => {
  const entries = (...labels) =>
    watchOf(...labels.map((label, i) => htmlEntry(`t${i}`, { label }))).map(
      (source) => ({ source }),
    );
  assert.equal(
    buildIssueTitle(entries("Exam retake policy")),
    "Watched source changed: Exam retake policy",
  );
  assert.equal(
    buildIssueTitle(entries("Virtual Training Days FAQ (PDF)", "Online exams")),
    "Watched sources changed: Virtual Training Days FAQ, Online exams",
  );
  const many = buildIssueTitle(
    entries(
      ...Array.from({ length: 40 }, (_, i) => `Certification Week number ${i}`),
    ),
  );
  assert.ok(many.length <= 200, `${many.length}`);
  assert.match(many, /\+\d+ more$/);
  const huge = buildIssueTitle(entries("X".repeat(500)));
  assert.ok(huge.length <= 200);
});

// ---------------------------------------------------------------------------
// The running attention issue
// ---------------------------------------------------------------------------
test("attention: failing sources, held changes and uncited sources make the state active, with a stable signature", () => {
  const watch = watchOf(htmlEntry("a"), htmlEntry("b"), htmlEntry("c"));
  const records = [
    {
      url: watch[0].url,
      failures: 3,
      failingSince: "2026-10-10",
      lastFailure: "HTTP 403",
    },
    { url: watch[1].url, failures: 2, failingSince: "2026-10-12" },
    { url: watch[2].url },
  ];
  const citations = new Map(
    watch.map((s) => [
      s.url,
      [{ file: "src/content/x.mdx", line: 1, via: "link" }],
    ]),
  );
  const state = (overrides = {}) =>
    attentionState({
      records,
      watch,
      held: [],
      citations,
      missing: [],
      failureRuns: 3,
      ...overrides,
    });

  const failing = state();
  assert.equal(failing.active, true);
  assert.deepEqual(
    failing.failing.map((f) => f.source.url),
    [watch[0].url],
    "two failures are not enough",
  );
  assert.equal(failing.failing[0].since, "2026-10-10");
  assert.equal(failing.signature, state().signature);
  assert.match(failing.signature, /^[0-9a-f]{16}$/);

  assert.equal(state({ records: [{ url: watch[0].url }] }).active, false);
  const uncited = state({
    records: [],
    citations: new Map([
      [watch[0].url, []],
      [watch[1].url, []],
      [watch[2].url, [{ file: "f", line: 1, via: "link" }]],
    ]),
  });
  assert.deepEqual(
    uncited.uncited.map((s) => s.url),
    [watch[0].url, watch[1].url],
  );
  const missing = state({
    records: [],
    missing: [{ source: watch[0], file: "src/content/gone.mdx" }],
  });
  assert.equal(missing.active, true);
  assert.notEqual(missing.signature, state({ records: [] }).signature);
  const held = state({
    records: [],
    held: [
      {
        source: watch[1],
        kind: "html",
        diff: { added: 3, removed: 2, entries: [] },
      },
    ],
  });
  assert.equal(held.active, true);
  assert.equal(held.held[0].summary, "+3 / -2");
});

test("the attention report says what is wrong and what to do, and a held run shows counts and no diffs", () => {
  const watch = watchOf(
    htmlEntry("a", { label: "Failing page" }),
    htmlEntry("b", { label: "Held page" }),
    htmlEntry("c", { label: "Orphan page" }),
  );
  const citations = new Map([
    [
      watch[0].url,
      [{ file: "src/content/docs/guide/a.mdx", line: 4, via: "link" }],
    ],
    [
      watch[1].url,
      [{ file: "src/content/docs/guide/b.mdx", line: 9, via: "link" }],
    ],
    [watch[2].url, []],
  ]);
  const state = attentionState({
    records: [
      {
        url: watch[0].url,
        failures: 3,
        failingSince: "2026-10-10",
        lastFailure: "HTTP 403 @everyone",
      },
    ],
    watch,
    held: [
      {
        source: watch[1],
        kind: "html",
        diff: { added: 2, removed: 1, entries: [] },
      },
    ],
    citations,
    missing: [{ source: watch[1], file: "src/content/docs/guide/gone.mdx" }],
    failureRuns: 3,
  });
  const report = buildAttentionReport(state, {
    today: TODAY,
    citations,
    failureRuns: 3,
    maxChanged: 8,
    total: 3,
    runUrl: "https://github.com/x/y/actions/runs/1",
  });
  assert.match(report, /^## Source Watch needs attention \(2026-10-14\)/);
  assert.match(report, /### Sources that could not be read 3 runs in a row/);
  assert.match(
    report,
    /\| \[Failing page\]\(https:\/\/example\.test\/a\) \| 2026-10-10 \| HTTP 403 @​everyone \| `src\/content\/docs\/guide\/a\.mdx:4` \|/,
  );
  assert.match(report, /### Many sources changed at once \(held back\)/);
  assert.match(
    report,
    /1 of 3 watched sources changed text in one run, more than the limit of 8/,
  );
  assert.match(report, /force_baseline/);
  assert.match(report, /### Watched sources that no hub page cites/);
  assert.match(report, /### `alsoFeeds` pages that do not exist/);
  assert.match(report, /Run: https:\/\/github\.com\/x\/y\/actions\/runs\/1/);
  assert.ok(
    !report.includes("@@"),
    "no per-source diffs when many sources changed at once",
  );
});

function recordingGh({ open = [], fail = [], labels = [] } = {}) {
  const calls = [];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, args, input });
    if (fail.includes(command)) throw new Error(`gh ${command} failed`);
    if (command === "issue list") return JSON.stringify(open);
    if (command === "label list") {
      return JSON.stringify(labels.map((name) => ({ name })));
    }
    if (command === "issue create")
      return "https://github.com/mscerts/hub/issues/42";
    return "";
  };
  return { gh, calls, commands: () => calls.map((call) => call.command) };
}
const ISSUE = {
  title: "Running issue",
  label: "bug",
  labelColor: "d73a4a",
  labelDescription: "Something isn't working",
};

test("syncIssue creates one issue, comments on the oldest open copy, closes every copy and touches nothing when disabled", () => {
  const off = recordingGh();
  assert.equal(
    syncIssue({ ...ISSUE, gh: off.gh, enabled: false, active: true, body: "b" })
      .action,
    "skipped",
  );
  assert.equal(
    syncIssue({ ...ISSUE, gh: off.gh, enabled: false, active: false, body: "" })
      .action,
    "none",
  );
  assert.deepEqual(off.calls, [], "not even a lookup");

  const none = recordingGh();
  const created = syncIssue({
    ...ISSUE,
    gh: none.gh,
    enabled: true,
    active: true,
    body: "the body",
  });
  assert.equal(created.action, "created");
  assert.equal(created.number, 42);
  assert.deepEqual(none.commands(), [
    "issue list",
    "label create",
    "issue create",
  ]);
  const create = none.calls.at(-1);
  assert.deepEqual(create.args.slice(0, 7), [
    "issue",
    "create",
    "--title",
    "Running issue",
    "--label",
    "bug",
    "--body-file",
  ]);
  assert.ok(!create.args.includes("--assignee"), "no assignee");
  assert.equal(create.input, "the body");

  const open = recordingGh({
    open: [
      { number: 9, title: "Running issue" },
      { number: 4, title: "Running issue" },
      { number: 5, title: "Another issue" },
    ],
  });
  const commented = syncIssue({
    ...ISSUE,
    gh: open.gh,
    enabled: true,
    active: true,
    body: "b",
    commentBody: "c",
  });
  assert.deepEqual([commented.action, commented.number], ["commented", 4]);
  assert.deepEqual(open.commands(), ["issue list", "issue comment"]);
  assert.equal(open.calls[1].args[2], "4");
  assert.equal(open.calls[1].input, "c");

  const closing = recordingGh({
    open: [
      { number: 9, title: "Running issue" },
      { number: 4, title: "Running issue" },
    ],
  });
  const closed = syncIssue({
    ...ISSUE,
    gh: closing.gh,
    enabled: true,
    active: false,
    body: "",
    closeComment: "done",
  });
  assert.deepEqual([closed.action, closed.closed], ["closed", [4, 9]]);
  assert.equal(closing.calls[1].args.at(-1), "done");
});

test("a failed lookup stops an active issue (nothing is committed) and only warns when the issue is being closed", () => {
  const broken = recordingGh({ fail: ["issue list"] });
  assert.throws(
    () =>
      syncIssue({
        ...ISSUE,
        gh: broken.gh,
        enabled: true,
        active: true,
        body: "b",
      }),
    /gh issue list failed/,
  );
  const closing = syncIssue({
    ...ISSUE,
    gh: broken.gh,
    enabled: true,
    active: false,
    body: "",
    closeComment: "x",
  });
  assert.equal(closing.action, "lookup-failed");
  assert.match(closing.error, /gh issue list failed/);

  const stuck = recordingGh({
    open: [{ number: 3, title: "Running issue" }],
    fail: ["issue close"],
  });
  const result = syncIssue({
    ...ISSUE,
    gh: stuck.gh,
    enabled: true,
    active: false,
    body: "",
    closeComment: "x",
  });
  assert.equal(result.action, "close-failed");
  assert.match(result.error, /gh issue close failed/);
  assert.deepEqual(
    listOpenIssues(stuck.gh, { title: "Running issue", label: "bug" }).map(
      (i) => i.number,
    ),
    [3],
  );
});

test("the label comes before the first issue, and one that cannot be created is an error unless it exists", () => {
  const fresh = recordingGh();
  syncIssue({ ...ISSUE, gh: fresh.gh, enabled: true, active: true, body: "b" });
  assert.deepEqual(fresh.calls[1].args, [
    "label",
    "create",
    "bug",
    "--color",
    "d73a4a",
    "--description",
    "Something isn't working",
  ]);

  // `label create` is refused because the label is there: the lookup finds it.
  const exists = recordingGh({ fail: ["label create"], labels: ["bug"] });
  const created = syncIssue({
    ...ISSUE,
    gh: exists.gh,
    enabled: true,
    active: true,
    body: "b",
  });
  assert.equal(created.action, "created");
  assert.deepEqual(exists.commands(), [
    "issue list",
    "label create",
    "label list",
    "issue create",
  ]);

  // It failed for another reason and the label is not there: the error says so
  // (it used to be swallowed, and `issue create` then failed with a vaguer one).
  const denied = recordingGh({ fail: ["label create"] });
  assert.throws(
    () =>
      syncIssue({
        ...ISSUE,
        gh: denied.gh,
        enabled: true,
        active: true,
        body: "b",
      }),
    /gh label create failed/,
  );
  assert.ok(!denied.commands().includes("issue create"));
});

test("the attention issue is touched only when its list changed, and closes when nothing is left", () => {
  const cfg = loadConfig({ CREATE_ISSUES: "1", TODAY });
  const active = { active: true, signature: "aaaaaaaaaaaaaaaa" };
  const quiet = { active: false, signature: "bbbbbbbbbbbbbbbb" };

  const same = recordingGh();
  assert.equal(
    syncAttentionIssue(cfg, same.gh, active, "report", {
      signature: "aaaaaaaaaaaaaaaa",
      since: "2026-10-10",
    }).action,
    "none",
  );
  assert.deepEqual(same.calls, [], "an unchanged list makes no call at all");

  const first = recordingGh();
  const created = syncAttentionIssue(cfg, first.gh, active, "report", null);
  assert.equal(created.action, "created");
  assert.deepEqual(first.calls.at(-1).args.slice(0, 6), [
    "issue",
    "create",
    "--title",
    ATTENTION_ISSUE_TITLE,
    "--label",
    "bug",
  ]);

  const changed = recordingGh({
    open: [{ number: 8, title: ATTENTION_ISSUE_TITLE }],
  });
  assert.equal(
    syncAttentionIssue(cfg, changed.gh, active, "new report", {
      signature: "cccccccccccccccc",
      since: "2026-10-10",
    }).action,
    "commented",
  );

  const nothing = recordingGh();
  assert.equal(
    syncAttentionIssue(cfg, nothing.gh, quiet, "", null).action,
    "none",
  );
  assert.deepEqual(nothing.calls, []);

  const closing = recordingGh({
    open: [{ number: 8, title: ATTENTION_ISSUE_TITLE }],
  });
  const closed = syncAttentionIssue(cfg, closing.gh, quiet, "", {
    signature: "aaaaaaaaaaaaaaaa",
    since: "2026-10-10",
  });
  assert.deepEqual([closed.action, closed.closed], ["closed", [8]]);

  const dry = recordingGh();
  assert.equal(
    syncAttentionIssue(
      loadConfig({ CREATE_ISSUES: "1", DRY_RUN: "1", TODAY }),
      dry.gh,
      active,
      "r",
      null,
    ).action,
    "skipped",
  );
  assert.deepEqual(dry.calls, [], "DRY_RUN touches no issue");
});

test("the failure issue is one issue with a comment per failed run, closed by the next healthy run", () => {
  const cfg = loadConfig({
    CREATE_ISSUES: "1",
    TODAY,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "mscerts/hub",
    GITHUB_RUN_ID: "77",
  });
  const first = recordingGh();
  assert.equal(
    syncFailureIssue(
      cfg,
      first.gh,
      "None of the 48 watched sources could be read",
    ).action,
    "created",
  );
  const create = first.calls.at(-1);
  assert.equal(create.args[3], FAILED_ISSUE_TITLE);
  assert.match(create.input, /None of the 48 watched sources could be read/);
  assert.match(
    create.input,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/77/,
  );

  const again = recordingGh({
    open: [{ number: 5, title: FAILED_ISSUE_TITLE }],
  });
  assert.equal(
    syncFailureIssue(cfg, again.gh, "still down").action,
    "commented",
  );

  const healthy = recordingGh({
    open: [{ number: 5, title: FAILED_ISSUE_TITLE }],
  });
  assert.equal(syncFailureIssue(cfg, healthy.gh, null).action, "closed");
  assert.match(
    healthy.calls.at(-1).args.at(-1),
    /Source Watch ran normally on 2026-10-14/,
  );
});

// ---------------------------------------------------------------------------
// Config, retry, sitemap
// ---------------------------------------------------------------------------
test("the config reads its overrides and falls back for malformed numbers", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.maxChanged, 8);
  assert.equal(defaults.failureRuns, 3);
  assert.equal(defaults.fetchDelayMs, 1000);
  assert.equal(defaults.minContentLines, 5);
  assert.equal(defaults.maxLines, 800);
  assert.equal(defaults.runDeadlineMs, 600000, "10 minutes of the 15 allowed");
  assert.equal(defaults.forceBaseline, false);
  assert.equal(defaults.sitemapHint, true);
  assert.equal(defaults.createIssues, false);
  assert.deepEqual(defaults.learnHosts, ["learn.microsoft.com"]);
  assert.equal(
    defaults.sitemapIndexUrl,
    "https://learn.microsoft.com/_sitemaps/sitemapindex.xml",
  );
  assert.match(defaults.today, /^\d{4}-\d{2}-\d{2}$/);

  const custom = loadConfig({
    MAX_CHANGED: "2",
    FAILURE_RUNS: "5.9",
    FETCH_DELAY_MS: "0",
    MAX_LINES: "banana",
    RUN_DEADLINE_MS: "0",
    MIN_CONTENT_LINES: "-4",
    FORCE_BASELINE: "1",
    SITEMAP_HINT: "0",
    LEARN_HOSTS: " Learn.Example , other.example",
    TODAY: "2027-01-02",
    TRACKER_FILE: "/tmp/x.json",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "a/b",
    GITHUB_RUN_ID: "9",
  });
  assert.equal(custom.maxChanged, 2);
  assert.equal(custom.failureRuns, 5);
  assert.equal(custom.fetchDelayMs, 0);
  assert.equal(custom.maxLines, 800);
  assert.equal(
    custom.runDeadlineMs,
    600000,
    "a deadline of 0 is not a deadline",
  );
  assert.equal(custom.minContentLines, 5);
  assert.equal(custom.forceBaseline, true);
  assert.equal(custom.sitemapHint, false);
  assert.deepEqual(custom.learnHosts, ["learn.example", "other.example"]);
  assert.equal(custom.today, "2027-01-02");
  assert.equal(custom.runUrl, "https://github.com/a/b/actions/runs/9");
  assert.equal(loadConfig({ TODAY: "yesterday" }).today.length, 10);
});

test("Retry-After is honoured in seconds and as a date, and always capped", () => {
  const base = { attempt: 1, baseMs: 5000, maxMs: 60000 };
  assert.equal(retryDelayMs({ ...base, retryAfter: "7" }), 7000);
  assert.equal(retryDelayMs({ ...base, retryAfter: "99999" }), 60000);
  assert.equal(retryDelayMs({ ...base, retryAfter: null }), 5000);
  assert.equal(retryDelayMs({ ...base, attempt: 3, retryAfter: null }), 20000);
  const now = Date.parse("2026-10-14T10:00:00Z");
  assert.equal(
    retryDelayMs({ ...base, retryAfter: "Wed, 14 Oct 2026 10:00:30 GMT", now }),
    30000,
  );
  assert.equal(
    retryDelayMs({ ...base, retryAfter: "Wed, 14 Oct 2026 09:00:00 GMT", now }),
    0,
  );
});

test("durations are written for a human, singular and plural", () => {
  assert.equal(durationText(600000), "10 minutes");
  assert.equal(durationText(60000), "1 minute");
  assert.equal(durationText(45000), "45 seconds");
  assert.equal(durationText(1000), "1 second");
  assert.equal(durationText(150), "150 ms");
});

test("a run past its deadline stops requesting: the rest come back as failed reads and are never fetched", async () => {
  let time = 0;
  const requested = [];
  const waits = [];
  const cfg = { runDeadlineMs: 1000, fetchDelayMs: 7 };
  const watch = ["a", "b", "c", "d", "e"].map((name) => ({
    url: `https://x.example/${name}`,
  }));
  const reads = await readAllSources(cfg, watch, {
    startedAt: 0,
    now: () => time,
    wait: async (ms) => waits.push(ms),
    read: async (_cfg, source) => {
      requested.push(source.url);
      time += 400; // each source takes 400 ms
      return { ok: true, lines: [source.url] };
    },
  });
  // The deadline is checked before a source starts: 0, 400 and 800 ms are inside it.
  assert.deepEqual(
    requested,
    watch.slice(0, 3).map((s) => s.url),
  );
  assert.deepEqual(
    reads.map((r) => r.ok),
    [true, true, true, false, false],
  );
  assert.equal(reads.length, watch.length, "one read per source, in order");
  for (const skipped of reads.slice(3)) {
    assert.equal(
      skipped.kind,
      "fetch",
      "a failed read: it keeps the record and counts for the day",
    );
    assert.equal(skipped.skipped, true);
    assert.equal(
      skipped.reason,
      "not requested: the run deadline of 1 second was reached",
    );
  }
  assert.deepEqual(
    waits,
    [7, 7],
    "paused between the requests that were made, not after them",
  );

  // A fast run is untouched, whatever the number of sources.
  time = 0;
  const all = await readAllSources(
    { runDeadlineMs: 1000, fetchDelayMs: 0 },
    watch,
    {
      startedAt: 0,
      now: () => time,
      wait: async () => {},
      read: async () => ({ ok: true }),
    },
  );
  assert.ok(all.every((r) => r.ok && !r.skipped));
  // A skipped read is a fetch failure to the comparison: record kept, one failure counted.
  const tracker = {
    lastSynced: null,
    format: LINES_FORMAT,
    attention: null,
    sources: [
      {
        url: watch[3].url,
        label: "d",
        kind: "html",
        contentHash: hashLines(["old"]),
        lines: ["old"],
      },
    ],
  };
  const applied = applyResults(
    tracker,
    [{ ...watch[3], kind: "html", label: "d" }],
    [reads[3]],
    { today: "2026-10-15" },
  );
  assert.equal(applied.failed.length, 1);
  assert.equal(applied.changed.length, 0);
  assert.equal(applied.tracker.sources[0].failures, 1);
  assert.deepEqual(
    applied.tracker.sources[0].lines,
    ["old"],
    "the last good text is kept",
  );
});

test("the Learn credentials sitemap is read for lastmod dates only, from the index's own site", () => {
  const index =
    "<sitemapindex><sitemap><loc>https://learn.microsoft.com/_sitemaps/credentials_en-us_1.xml</loc></sitemap>" +
    "<sitemap><loc>https://learn.microsoft.com/_sitemaps/training_en-us_1.xml</loc></sitemap></sitemapindex>";
  assert.deepEqual(
    credentialsSitemapFiles(
      index,
      "http://127.0.0.1:9/_sitemaps/sitemapindex.xml",
    ),
    ["http://127.0.0.1:9/_sitemaps/credentials_en-us_1.xml"],
  );
  assert.deepEqual(
    parseSitemapUrls(
      "<urlset><url><loc>https://learn.microsoft.com/en-us/credentials/support/retake-policy</loc><lastmod>2026-07-27T21:34:00Z</lastmod></url>" +
        "<url><loc>https://x.test/no-date</loc></url>" +
        "<url><loc>https://x.test/a?b=1&amp;c=2</loc><lastmod>2026-01-02</lastmod></url></urlset>",
    ),
    [
      {
        loc: "https://learn.microsoft.com/en-us/credentials/support/retake-policy",
        lastmod: "2026-07-27",
      },
      { loc: "https://x.test/a?b=1&c=2", lastmod: "2026-01-02" },
    ],
  );
});

// ---------------------------------------------------------------------------
// The committed watch list and workflow
// ---------------------------------------------------------------------------
const WATCH_FILE = join(root, "src/data_files/watched-sources.json");

function committedWatch() {
  return normalizeWatchList(JSON.parse(readFileSync(WATCH_FILE, "utf8")));
}

test("the committed watch list is valid and every source is cited by a hub page that exists", () => {
  const watch = committedWatch();
  assert.ok(watch.length >= 30);
  const contentRoot = join(root, "src/content");
  const urls = scanContentUrls(contentRoot);
  const files = contentFileSet(contentRoot);
  assert.deepEqual(
    missingFeeds(watch, files),
    [],
    "every alsoFeeds page exists",
  );
  for (const source of watch) {
    assert.match(source.url, /^https?:\/\//);
    assert.ok(!/[?#]/.test(source.url) || source.url.includes("?"), source.url);
    assert.ok(
      !source.url.includes("WT.mc_id"),
      "the tracker keys on the plain address",
    );
    assert.ok(
      citationsOf(source, urls, files).length > 0,
      `${source.url} is cited by no hub page`,
    );
  }
  assert.equal(new Set(watch.map((s) => s.url)).size, watch.length);
  assert.equal(
    new Set(watch.map((s) => s.label)).size,
    watch.length,
    "labels name the issue, so they are unique",
  );
});

test("with the default LEARN_HOSTS the Learn pages of the committed watch list are read through their content blocks and every other page as a whole <main>", () => {
  const { learnHosts } = loadConfig({});
  const html = committedWatch().filter((source) => source.kind === "html");
  const learn = html.filter((source) => isLearnHost(source.url, learnHosts));
  assert.ok(learn.length >= 15, `${learn.length} Learn pages`);
  for (const source of learn) {
    assert.equal(new URL(source.url).hostname, "learn.microsoft.com");
    assert.equal(source.root, "main", source.url);
  }
  // The pages of every other site (about 14 with a <main>) keep the whole <main>.
  assert.ok(html.length > learn.length);
  for (const source of html.filter((s) => !learn.includes(s))) {
    assert.ok(!/learn\.microsoft\.com/.test(source.url), source.url);
  }
});

test("the committed watch list leaves the pages another monitor owns to that monitor", () => {
  const owned = [
    /credentials\/support\/retired-certification-exams/,
    /credentials\/support\/credential-retirement/,
    /partner-center\//,
    /techcommunity\.microsoft\.com/,
    /measureup\.com/,
    /\/credentials\/certifications\/exams\//,
    /\/resources\/study-guides\//,
    /learn\.microsoft\.com\/training\//,
    /github\.com\/MicrosoftLearning/i,
    /learn\.microsoft\.com\/credentials\/applied-skills/,
  ];
  for (const source of committedWatch()) {
    for (const pattern of owned) {
      assert.ok(
        !pattern.test(source.url),
        `${source.url} belongs to another monitor`,
      );
    }
  }
});

test("Learn URL Check skips the tracker (stored foreign page text) but still reads the watch list", () => {
  const source = readFileSync(
    join(root, "scripts/learn-url-check.mjs"),
    "utf8",
  );
  const literal = source.match(/const SCAN_SKIP =\s*(\/.+\/);/)?.[1];
  assert.ok(literal, "SCAN_SKIP is a regular expression literal");
  const skip = new RegExp(literal.slice(1, -1));
  assert.ok(
    skip.test("src/data_files/source-watch.json"),
    "the tracker is skipped like the other trackers",
  );
  assert.ok(
    skip.test("src\\data_files\\source-watch.json"),
    "also with Windows separators",
  );
  assert.ok(
    !skip.test("src/data_files/watched-sources.json"),
    "a dead address in the hand-edited watch list is worth flagging",
  );
  // The tracker of the Learn Content Watch stores the exam page addresses of
  // exams that have no page yet (GH-700): a bot-owned file with an address that
  // returns 404, which a hand edit cannot fix.
  for (const tracker of [
    "learn-content-watch",
    "learn-exams",
    "retirement-schedule",
    "skills-hub-posts",
  ]) {
    assert.ok(
      skip.test(`src/data_files/${tracker}.json`),
      `${tracker}.json is skipped`,
    );
    assert.ok(
      skip.test(`src\\data_files\\${tracker}.json`),
      `${tracker}.json is skipped with Windows separators`,
    );
  }
  assert.ok(
    !skip.test("src/data_files/lab-repos-ignore.json"),
    "the hand-edited ignore list of the lab repositories is not a tracker",
  );
});

test("every Titan journey the partner guide quotes is watched, by its own entry or by the overview that lists its counts", () => {
  const guide = readFileSync(
    join(root, "src/content/docs/guide/partneremployees.mdx"),
    "utf8",
  );
  const quoted = new Set(
    [
      ...guide.matchAll(
        /skillupwithlevelup\.com\/journeys\/(\d+)\)[^\n]*?\d+ tasks?, ~\d+ hours?/g,
      ),
    ].map((match) => match[1]),
  );
  assert.ok(quoted.size >= 14, `only ${quoted.size} journeys quoted`);
  const watch = committedWatch();
  const own = new Set(
    watch
      .map(
        (source) =>
          source.url.match(/skillupwithlevelup\.com\/journeys\/(\d+)$/)?.[1],
      )
      .filter(Boolean),
  );
  // The overview names the journeys whose counts it lists in its note.
  const overview = watch.find(
    (source) => source.url === "https://skillupwithlevelup.com/titan",
  );
  assert.ok(overview, "the overview page is watched");
  const named = (overview.note ?? "").match(/journeys ((?:\d+, )*\d+ and \d+)/);
  assert.ok(named, "the overview note names the journeys it lists");
  const listed = new Set(named[1].split(/, | and /));
  for (const id of quoted) {
    assert.ok(
      own.has(id) || listed.has(id),
      `journey ${id} is quoted by the guide but neither watched nor named in the overview note`,
    );
  }
});

test("the PDFs and pages the guide, prepare and voucher pages quote are on the list", () => {
  const urls = new Set(committedWatch().map((s) => s.url));
  for (const wanted of [
    "https://learn.microsoft.com/credentials/support/retake-policy",
    "https://learn.microsoft.com/credentials/support/reschedule-and-cancellation-policy",
    "https://learn.microsoft.com/credentials/support/exam-duration-exam-experience",
    "https://learn.microsoft.com/credentials/certifications/renew-your-microsoft-certification",
    "https://learn.microsoft.com/credentials/certifications/renew-your-microsoft-certification-faq",
    "https://learn.microsoft.com/credentials/support/credential-expiration-policy",
    "https://learn.microsoft.com/credentials/certifications/register-schedule-exam",
    "https://learn.microsoft.com/credentials/certifications/online-exams",
    "https://learn.microsoft.com/credentials/support/redeem-discounts",
    "https://learn.microsoft.com/credentials/certifications/student-discounts",
    "https://learn.microsoft.com/credentials/support/about-beta-exams",
    "https://learn.microsoft.com/credentials/certifications/practice-assessments-for-microsoft-certifications",
    "https://learn.microsoft.com/credentials/certifications/prepare-exam",
    "https://learn.microsoft.com/credentials/certifications/deals",
    "https://learn.microsoft.com/credentials/certifications/college-credit",
    "https://aka.ms/MVTD_FAQ_EN",
    "https://aka.ms/TrainCertPoster",
    "https://yes-aiskills.co.za/",
    "https://eu2.mindhub.com/exam-replay",
  ]) {
    assert.ok(urls.has(wanted), `${wanted} is watched`);
  }
  const kinds = Object.fromEntries(
    committedWatch().map((s) => [s.url, s.kind]),
  );
  assert.equal(kinds["https://aka.ms/MVTD_FAQ_EN"], "pdf");
  assert.equal(kinds["https://aka.ms/TrainCertPoster"], "pdf");
  assert.ok(
    [...urls].filter((u) => u.startsWith("https://certweeks.fastlane.net/"))
      .length >= 8,
    "the Certification Week pages",
  );
});

test("every link to a program host in the guide, prepare and voucher pages is watched, or named here with the reason it is not", () => {
  // Pages of these hosts are always programme facts; a new link without a watch is a gap.
  const programHost =
    /^(certweeks\.fastlane\.net|yes-aiskills\.co\.za|learn\.microsoft\.com\/credentials\/(support|certifications)\/)/;
  const excluded = new Map([
    [
      "learn.microsoft.com/credentials/support/retired-certification-exams",
      "owned by the Retiring Exam Monitor",
    ],
    [
      "learn.microsoft.com/credentials/certifications/azure-ai-engineer",
      "a certification page: the New Exam Monitor reads it",
    ],
    [
      "learn.microsoft.com/credentials/certifications/azure-administrator",
      "a certification page: the New Exam Monitor reads it",
    ],
    [
      "learn.microsoft.com/credentials/certifications/azure-solutions-architect",
      "a certification page: the New Exam Monitor reads it",
    ],
    [
      "learn.microsoft.com/credentials/certifications/schedule-through-pearson-vue",
      "client-rendered shell, no article text",
    ],
    [
      "learn.microsoft.com/credentials/certifications/exams/az-305",
      "an exam page: the New Exam Monitor and its study guide check own it",
    ],
    [
      "learn.microsoft.com/credentials/certifications/exams/az-400",
      "an exam page: the New Exam Monitor and its study guide check own it",
    ],
    [
      "learn.microsoft.com/credentials/certifications/exams/sc-100",
      "an exam page: the New Exam Monitor and its study guide check own it",
    ],
  ]);
  const watch = committedWatch();
  const watched = new Set();
  for (const source of watch) {
    for (const url of [source.url, ...source.aliases])
      watched.add(urlKeys(url).path);
  }
  const gaps = new Set();
  for (const found of scanContentUrls(join(root, "src/content"))) {
    if (!/^src\/content\/docs\/(guide|prepare|vouchers)\//.test(found.file))
      continue;
    const key = found.keys.path;
    if (programHost.test(key) && !watched.has(key) && !excluded.has(key))
      gaps.add(`${key} (${found.file}:${found.line})`);
  }
  assert.deepEqual([...gaps], [], "cited but neither watched nor excluded");
});

const WORKFLOW = join(root, ".github/workflows/source-watch.yml");

function workflowSource() {
  return readFileSync(WORKFLOW, "utf8");
}

test("the workflow is daily at its own minute, runs the node version of .node-version, and is never cancelled half way", () => {
  const source = workflowSource();
  const cron = (text) =>
    [...text.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (m) => m.slice(1, 6),
    );
  const [mine, ...extra] = cron(source);
  assert.equal(extra.length, 0, "one schedule");
  assert.deepEqual(mine, ["20", "8", "*", "*", "*"], "daily 08:20 UTC");
  assert.match(source, /node-version-file: \.node-version/);
  assert.match(source, /package-manager-cache: false/);
  assert.match(
    source,
    /^ {2}group: source-watch\n {2}cancel-in-progress: false$/m,
  );
  assert.match(
    source,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(source, /^ {6}REPORT_FILE: \/tmp\/source-watch-report\.md$/m);
  assert.match(
    source,
    /^ {6}ATTENTION_FILE: \/tmp\/source-watch-attention\.md$/m,
  );
  assert.match(source, /^ {6}ERROR_FILE: \/tmp\/source-watch-error\.md$/m);
  assert.match(source, /workflow_dispatch:/);

  const dir = join(root, ".github/workflows");
  for (const name of readdirSync(dir)) {
    if (name === "source-watch.yml" || !name.endsWith(".yml")) continue;
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

test("the run deadline leaves the workflow time to finish the source it is in, write the tracker and open the issue", () => {
  const timeout = Number(
    workflowSource().match(/^ {4}timeout-minutes: (\d+)$/m)?.[1],
  );
  assert.ok(timeout > 0, "the job has a timeout");
  const defaults = loadConfig({});
  // The worst case after the deadline: the source in flight (every attempt
  // times out, with the backoff between them), then the issue and the commit.
  const inFlight =
    defaults.fetchAttempts * defaults.timeoutMs +
    defaults.retryBaseMs * (2 ** (defaults.fetchAttempts - 1) - 1);
  assert.ok(
    defaults.runDeadlineMs + inFlight + 3 * 60000 <= timeout * 60000,
    `deadline ${defaults.runDeadlineMs} ms + a hung source ${inFlight} ms + 3 minutes must fit into ${timeout} minutes`,
  );
});

test("the workflow opens the issue before it commits the tracker, with the label and no assignee", () => {
  const source = workflowSource();
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `workflow has "${needle}"`);
    return index;
  };
  const check = at("- name: Check the watched sources");
  const issue = at("- name: Create issue if a watched source changed");
  const commit = at("- name: Commit updated source watch tracker");
  assert.ok(check < issue && issue < commit, "check, issue, commit");

  const checkStep = source.slice(check, issue);
  assert.match(checkStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(checkStep, /CREATE_ISSUES: "1"/);
  assert.match(
    checkStep,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  assert.match(checkStep, /run: node scripts\/source-watch\.mjs/);

  const issueStep = source.slice(issue, commit);
  assert.match(issueStep, /if: steps\.check\.outputs\.changes_found == 'true'/);
  assert.match(
    issueStep,
    /uses: peter-evans\/create-issue-from-file@[0-9a-f]{40} # v6/,
  );
  assert.match(
    issueStep,
    /title: "\$\{\{ steps\.check\.outputs\.issue_title \}\}"/,
  );
  assert.match(issueStep, /content-filepath: \/tmp\/source-watch-report\.md/);
  assert.match(issueStep, /labels: enhancement/);
  assert.ok(!/assignees?:/.test(source), "no assignee");

  const commitStep = source.slice(commit);
  assert.match(
    commitStep,
    /if: steps\.check\.outputs\.baseline_updated == 'true'/,
  );
  assert.ok(
    !/always\(\)|failure\(\)|success\(\)/.test(commitStep),
    "a failed issue step must skip the commit",
  );
  assert.match(commitStep, /git add src\/data_files\/source-watch\.json/);
  assert.match(commitStep, /for attempt in 1 2 3/);
  assert.match(commitStep, /git pull --rebase && git push && exit 0/);
});

test("a manual run can accept a mass change through the input the script reads", () => {
  const source = workflowSource();
  const dispatch =
    source.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ?? "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/);
  assert.match(dispatch, /^ {8}type: boolean$/m);
  assert.match(dispatch, /^ {8}default: false$/m);
  // the stable titles named in the workflow comment are the script's
  assert.ok(source.includes(`"${ATTENTION_ISSUE_TITLE}"`));
  assert.ok(source.includes(`"${FAILED_ISSUE_TITLE}"`));
});

// ---------------------------------------------------------------------------
// End to end: the script against a local fake of the sources
// ---------------------------------------------------------------------------
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const command = args.slice(0, 2).join(" ");
const stdin = arg("--body-file") === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ command, args, stdin }) + "\\n");
if (process.env.FAKE_GH_FAIL && process.env.FAKE_GH_FAIL.split(",").includes(command)) {
  console.error("fake gh: " + command + " failed on purpose");
  process.exit(1);
}
const stateFile = process.env.FAKE_GH_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, issues: [], labels: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const find = () => state.issues.find((i) => i.number === Number(args[2]));
if (command === "issue list") {
  const label = arg("--label");
  console.log(JSON.stringify(state.issues.filter((i) => i.state === "open" && i.labels.includes(label)).map(({ number, title }) => ({ number, title }))));
} else if (command === "label create") {
  state.labels.push(args[2]); save();
} else if (command === "issue create") {
  const issue = { number: state.next++, title: arg("--title"), labels: [arg("--label")], body: stdin, state: "open", comments: [] };
  state.issues.push(issue); save();
  console.log("https://github.com/mscerts/hub/issues/" + issue.number);
} else if (command === "issue comment") {
  find().comments.push(stdin); save();
} else if (command === "issue close") {
  const issue = find(); issue.state = "closed"; issue.comments.push(arg("--comment")); save();
}
`;

async function fakeSite() {
  /** path -> { status, type, body, headers, redirect, noHead } */
  const routes = new Map();
  const requests = [];
  const handle = (request, response) => {
    const path = request.url.split("?")[0];
    requests.push(`${request.method} ${request.url}`);
    const spec = routes.get(path);
    if (!spec) {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    if (spec.redirect) {
      response.statusCode = spec.status ?? 301;
      response.setHeader("Location", spec.redirect);
      response.end();
      return;
    }
    if (spec.status && spec.status !== 200) {
      response.statusCode = spec.status;
      response.end("error");
      return;
    }
    if (request.method === "HEAD" && spec.noHead) {
      response.statusCode = 405;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", spec.type ?? "text/html; charset=utf-8");
    const body = spec.body ?? "";
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      response.setHeader(name, value);
    }
    if (request.method === "HEAD") {
      if (spec.lengthOnHead !== false) {
        response.setHeader("Content-Length", Buffer.byteLength(body));
      }
      response.end();
      return;
    }
    if (spec.chunked) {
      // no Content-Length: the body is streamed
      response.write(body);
      response.end();
      return;
    }
    response.end(body);
  };
  // spec.delayMs answers that late: a slow host.
  const server = createServer((request, response) => {
    const delay = routes.get(request.url.split("?")[0])?.delayMs;
    if (delay) setTimeout(() => handle(request, response), delay);
    else handle(request, response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    routes,
    requests,
    origin,
    close: () => new Promise((done) => server.close(done)),
  };
}

const pdfSpec = (etag, body = "%PDF-1.7 fake", extra = {}) => ({
  type: "application/pdf",
  body,
  headers: { ETag: etag, "Last-Modified": "Tue, 01 Sep 2026 10:00:00 GMT" },
  ...extra,
});

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

/**
 * A temporary world: a fake site with three sources (a policy page cited by a
 * guide page, an offer page without <main>, a PDF behind an alias), the content
 * directory that cites them, and the files the script reads and writes.
 */
async function makeWorld({ withPdf = true } = {}) {
  const site = await fakeSite();
  const dir = await mkdtemp(join(tmpdir(), "source-watch-test-"));
  const files = {
    dir,
    content: join(dir, "content"),
    watch: join(dir, "watch.json"),
    tracker: join(dir, "tracker.json"),
    report: join(dir, "report.md"),
    attention: join(dir, "attention.md"),
    error: join(dir, "error.md"),
    output: join(dir, "output"),
    summary: join(dir, "summary.md"),
    ghScript: join(dir, "fake-gh.mjs"),
    ghLog: join(dir, "gh.log"),
    ghState: join(dir, "gh-state.json"),
  };
  site.routes.set("/policy/retake", { body: learnHtml("Retake policy") });
  site.routes.set("/offer/home", {
    body: NO_MAIN_PAGE,
  });
  site.routes.set("/aka/faq", { redirect: "/files/faq-v1.pdf", status: 302 });
  site.routes.set("/files/faq-v1.pdf", pdfSpec('"v1"'));

  const sources = [
    {
      url: `${site.origin}/policy/retake`,
      kind: "html",
      label: "Retake policy",
    },
    {
      url: `${site.origin}/offer/home`,
      kind: "html",
      label: "Exam Replay offer",
      root: "body",
      note: "The voucher page restates the price rules.",
    },
  ];
  if (withPdf) {
    sources.push({
      url: `${site.origin}/aka/faq`,
      kind: "pdf",
      label: "FAQ (PDF)",
    });
  }
  await writeFile(files.watch, JSON.stringify({ sources }, null, 2));
  await mkdir(join(files.content, "docs/guide"), { recursive: true });
  await mkdir(join(files.content, "docs/vouchers"), { recursive: true });
  await writeFile(
    join(files.content, "docs/guide/retake.mdx"),
    `---\ntitle: Retake\n---\n\nText.\n\nSee [the policy](${site.origin}/policy/retake?WT.mc_id=x).\n`,
  );
  await writeFile(
    join(files.content, "docs/vouchers/offer.mdx"),
    `---\ntitle: Offer\n---\n\n[Offer](${site.origin}/offer/home)\n[FAQ](${site.origin}/aka/faq)\n`,
  );
  await writeFile(files.ghScript, FAKE_GH);
  await writeFile(files.ghLog, "");

  const sourcesByName = {
    retake: sources[0].url,
    offer: sources[1].url,
    faq: sources[2]?.url,
  };

  const ghCalls = () =>
    readFileSync(files.ghLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const issues = () =>
    existsSync(files.ghState)
      ? JSON.parse(readFileSync(files.ghState, "utf8")).issues
      : [];

  const run = async (day = TODAY, env = {}) => {
    await writeFile(files.output, "");
    await writeFile(files.summary, "");
    for (const name of ["report", "attention", "error"]) {
      await rm(files[name], { force: true });
    }
    const result = await runScript({
      WATCH_FILE: files.watch,
      TRACKER_FILE: files.tracker,
      CONTENT_DIR: files.content,
      REPORT_FILE: files.report,
      ATTENTION_FILE: files.attention,
      ERROR_FILE: files.error,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      FETCH_DELAY_MS: "0",
      FETCH_ATTEMPTS: "2",
      RETRY_BASE_MS: "1",
      SITEMAP_HINT: "0",
      // The fake site stands for Learn: its pages are read through their content blocks.
      LEARN_HOSTS: "127.0.0.1",
      TODAY: day,
      ...env,
    });
    const output = Object.fromEntries(
      (await readFile(files.output, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((row) => [
          row.slice(0, row.indexOf("=")),
          row.slice(row.indexOf("=") + 1),
        ]),
    );
    const maybe = async (path) =>
      existsSync(path) ? readFile(path, "utf8") : null;
    return {
      ...result,
      output,
      tracker: await maybe(files.tracker),
      report: await maybe(files.report),
      attention: await maybe(files.attention),
      error: await maybe(files.error),
      summary: await readFile(files.summary, "utf8"),
    };
  };
  /** The env that lets the script open issues, through the recording fake gh. */
  const withIssues = () => ({
    CREATE_ISSUES: "1",
    GH_CLI_SCRIPT: files.ghScript,
    FAKE_GH_LOG: files.ghLog,
    FAKE_GH_STATE: files.ghState,
    FAKE_GH_FAIL: "",
  });
  return {
    site,
    files,
    sources: sourcesByName,
    run,
    withIssues,
    ghCalls,
    ghWrites: () =>
      ghCalls().filter((c) =>
        [
          "label create",
          "issue create",
          "issue comment",
          "issue close",
        ].includes(c.command),
      ),
    issues,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await site.close();
    },
  };
}

test("end to end: silent baseline, quiet reruns, a real diff on a real change, nothing on a reformat", async () => {
  const world = await makeWorld();
  try {
    // 1. The first run (no tracker) records everything silently.
    const first = await world.run();
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.output.changes_found, "false");
    assert.equal(first.output.baseline_updated, "true");
    assert.equal(first.output.extraction_failed, "false");
    assert.equal(first.output.attention, "false");
    assert.equal(first.report, null, "a baseline never writes a report");
    const baseline = JSON.parse(first.tracker);
    assert.equal(baseline.format, LINES_FORMAT);
    assert.equal(baseline.lastSynced, TODAY);
    assert.deepEqual(
      baseline.sources.map((s) => s.kind),
      ["html", "html", "pdf"],
    );
    assert.equal(
      baseline.sources[0].contentHash,
      hashLines(baseline.sources[0].lines),
    );
    assert.equal(baseline.sources[1].lines.length, 53);
    assert.deepEqual(baseline.sources[2].validators.etag, '"v1"');
    assert.equal(
      baseline.sources[2].resolvedUrl,
      `${world.site.origin}/files/faq-v1.pdf`,
    );
    assert.match(first.summary, /\| Retake policy \| baseline recorded \|/);

    // 2. Nothing changed: no write at all, byte for byte.
    const second = await world.run("2026-10-15");
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.output.changes_found, "false");
    assert.equal(second.output.baseline_updated, "false");
    assert.equal(second.tracker, first.tracker);
    assert.equal(second.report, null);
    assert.match(second.stdout, /No watched source changed this run\./);

    // 3. Only formatting changed: still nothing.
    world.site.routes.set("/policy/retake", {
      body: reformat(learnHtml("Retake policy")),
    });
    const third = await world.run("2026-10-16");
    assert.equal(third.output.changes_found, "false");
    assert.equal(third.output.baseline_updated, "false");
    assert.equal(third.tracker, first.tracker);

    // 4. The text of one page and the file behind the alias changed.
    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy", [
        "First rule",
        "Second rule is now 48 hours",
        "Third rule",
      ]),
    });
    world.site.routes.set("/aka/faq", {
      redirect: "/files/faq-v2.pdf",
      status: 302,
    });
    world.site.routes.set(
      "/files/faq-v2.pdf",
      pdfSpec('"v2"', "%PDF-1.7 a newer fake"),
    );
    const fourth = await world.run("2026-10-17");
    assert.equal(fourth.code, 0, fourth.stderr);
    assert.equal(fourth.output.changes_found, "true");
    assert.equal(fourth.output.baseline_updated, "true");
    assert.equal(fourth.output.sources_changed, "2");
    assert.equal(
      fourth.output.issue_title,
      "Watched sources changed: Retake policy, FAQ",
    );
    assert.match(fourth.report, /^## Watched sources changed \(2\)/);
    assert.match(
      fourth.report,
      /\| \[Retake policy\]\(http:\/\/127\.0\.0\.1:\d+\/policy\/retake\) \| `src\/content\/docs\/guide\/retake\.mdx:7` \| \+1 \/ -1 \| 2026-10-01 \|/,
    );
    assert.match(
      fourth.report,
      /@@ Retake policy > Rules @@\n- - Second rule\n\+ - Second rule is now 48 hours/,
    );
    assert.match(
      fourth.report,
      /\| \[FAQ \(PDF\)\][^|]*\| `src\/content\/docs\/vouchers\/offer\.mdx:6` \| file replaced \|/,
    );
    assert.match(fourth.report, /before ETag: "v1"/);
    assert.match(fourth.report, /after {2}ETag: "v2"/);
    assert.ok(
      !fourth.report.includes("Exam Replay offer"),
      "unchanged sources are not in the report",
    );
    const updated = JSON.parse(fourth.tracker);
    assert.equal(updated.sources[0].lastChanged, "2026-10-17");
    assert.equal(updated.sources[2].validators.etag, '"v2"');
    assert.match(fourth.summary, /\| Retake policy \| changed \|/);
    assert.match(fourth.summary, /\| FAQ \(PDF\) \| changed \|/);

    // 5. The recorded state is the new baseline.
    const fifth = await world.run("2026-10-18");
    assert.equal(fifth.output.changes_found, "false");
    assert.equal(fifth.output.baseline_updated, "false");
    assert.equal(fifth.tracker, fourth.tracker);
    assert.deepEqual(
      world.ghCalls(),
      [],
      "no issue is touched unless CREATE_ISSUES is set",
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: the PDF is asked with HEAD, falls back to GET when HEAD fails, and a file without validators is not watched", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run();
    assert.equal(first.code, 0, first.stderr);
    assert.ok(world.site.requests.some((r) => r.startsWith("HEAD /aka/faq")));
    assert.ok(
      !world.site.requests.some((r) => r === "GET /files/faq-v1.pdf"),
      "the file is never downloaded",
    );

    // The server answers HEAD with 405: a GET whose body is dropped.
    world.site.routes.set(
      "/files/faq-v1.pdf",
      pdfSpec('"v1"', "%PDF-1.7 fake", { noHead: true }),
    );
    world.site.requests.length = 0;
    const second = await world.run("2026-10-15");
    assert.equal(second.output.changes_found, "false", second.stderr);
    assert.equal(second.tracker, first.tracker);
    assert.ok(world.site.requests.some((r) => r === "GET /files/faq-v1.pdf"));

    // A "PDF" link that now serves an HTML page, and one without any validator.
    world.site.routes.set("/files/faq-v1.pdf", { body: learnHtml("Moved") });
    const html = await world.run("2026-10-16");
    assert.equal(html.code, 0, html.stderr);
    assert.match(html.stderr, /"FAQ \(PDF\)".*not a PDF/);
    assert.equal(html.output.changes_found, "false");
    assert.equal(JSON.parse(html.tracker).sources[2].failures, 1);
    assert.equal(
      JSON.parse(html.tracker).sources[2].validators.etag,
      '"v1"',
      "the last good validators are kept",
    );
    world.site.routes.set("/files/faq-v1.pdf", {
      type: "application/pdf",
      body: "x",
      chunked: true,
      lengthOnHead: false,
    });
    const bare = await world.run("2026-10-17");
    assert.match(
      bare.stderr,
      /the server sent no ETag, Last-Modified or Content-Length/,
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: a source that fails, vanishes or stops being an article is warned about and never reported, and three days in a row raise one running issue", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run("2026-10-14", world.withIssues());
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(world.ghWrites(), [], "a healthy first run opens nothing");

    // day 1: the policy page returns 500, the offer page lost its markup
    world.site.routes.set("/policy/retake", { status: 500 });
    world.site.routes.set("/offer/home", {
      body: "<html><body><p>Please accept the cookies.</p></body></html>",
    });
    const day1 = await world.run("2026-10-15", world.withIssues());
    assert.equal(day1.code, 0, day1.stderr);
    assert.equal(day1.output.changes_found, "false");
    assert.equal(day1.report, null);
    assert.match(
      day1.stderr,
      /WARNING: could not fetch "Retake policy".*HTTP 500; kept its previous record/,
    );
    assert.match(
      day1.stderr,
      /WARNING: "Exam Replay offer".*cannot be read as an article \(only 1 text line/,
    );
    assert.match(
      day1.summary,
      /\| Retake policy \| FAILED, kept \| HTTP 500 \|/,
    );
    assert.match(
      day1.summary,
      /\| Exam Replay offer \| NOT AN ARTICLE, kept \|/,
    );
    const afterDay1 = JSON.parse(day1.tracker);
    assert.equal(afterDay1.sources[0].failures, 1);
    assert.equal(
      afterDay1.sources[0].contentHash,
      JSON.parse(first.tracker).sources[0].contentHash,
      "the last good text is kept",
    );
    assert.equal(afterDay1.sources[1].failures, 1);
    assert.deepEqual(world.ghWrites(), []);

    // a second run the same UTC day counts once
    const again = await world.run("2026-10-15", world.withIssues());
    assert.equal(again.tracker, day1.tracker);

    const day2 = await world.run("2026-10-16", world.withIssues());
    assert.equal(JSON.parse(day2.tracker).sources[0].failures, 2);
    assert.deepEqual(world.ghWrites(), [], "two days are not enough");

    // day 3: the running issue is created BEFORE the tracker is written
    const day3 = await world.run("2026-10-17", world.withIssues());
    assert.equal(day3.code, 0, day3.stderr);
    assert.equal(day3.output.attention, "true");
    assert.equal(day3.output.changes_found, "false");
    assert.equal(world.issues().length, 1);
    const [issue] = world.issues();
    assert.equal(issue.title, ATTENTION_ISSUE_TITLE);
    assert.deepEqual(issue.labels, ["bug"]);
    assert.equal(issue.body, day3.attention);
    assert.match(
      issue.body,
      /### Sources that could not be read 3 runs in a row/,
    );
    assert.match(
      issue.body,
      /\[Retake policy\]\(http:\/\/127\.0\.0\.1:\d+\/policy\/retake\) \| 2026-10-15 \| HTTP 500 \| `src\/content\/docs\/guide\/retake\.mdx:7`/,
    );
    assert.match(issue.body, /\[Exam Replay offer\]/);
    assert.ok(
      world.ghCalls().every((c) => !c.args.includes("--assignee")),
      "no assignee",
    );
    const afterDay3 = JSON.parse(day3.tracker);
    assert.equal(afterDay3.attention.since, "2026-10-17");
    assert.equal(day3.output.baseline_updated, "true");

    // day 4..5: the same list, no comment, no new issue; the frozen streak is no churn
    const writes = world.ghWrites().length;
    const day4 = await world.run("2026-10-18", world.withIssues());
    assert.equal(day4.output.baseline_updated, "false");
    assert.equal(day4.tracker, day3.tracker);
    assert.equal(world.ghWrites().length, writes);

    // the sources come back: the issue closes with a comment and the record clears
    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy"),
    });
    world.site.routes.set("/offer/home", { body: NO_MAIN_PAGE });
    const healed = await world.run("2026-10-19", world.withIssues());
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(
      healed.output.changes_found,
      "false",
      "identical text is no change",
    );
    assert.equal(world.issues()[0].state, "closed");
    assert.match(
      world.issues()[0].comments.at(-1),
      /Nothing needs attention any more as of 2026-10-19/,
    );
    const final = JSON.parse(healed.tracker);
    assert.equal(final.attention, null);
    assert.equal(final.sources[0].failures, undefined);
  } finally {
    await world.cleanup();
  }
});

test("end to end: a host that is too slow cuts the run off at its deadline, nothing is lost or reported as a change, and it raises the running issue after three days", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run("2026-10-14", world.withIssues());
    assert.equal(first.code, 0, first.stderr);
    const baseline = JSON.parse(first.tracker);

    // The first source answers after 600 ms, the deadline is 250 ms: the other two are never asked.
    world.site.routes.get("/policy/retake").delayMs = 600;
    const slow = { ...world.withIssues(), RUN_DEADLINE_MS: "250" };
    const before = world.site.requests.length;
    const day1 = await world.run("2026-10-15", slow);
    assert.equal(day1.code, 0, day1.stderr);
    assert.deepEqual(
      world.site.requests.slice(before).map((r) => r.split(" ")[1]),
      ["/policy/retake"],
      "the sources after the deadline are not requested at all",
    );
    assert.match(
      day1.stderr,
      /WARNING: the run deadline of 250 ms was reached: 2 of 3 sources were not requested and keep their previous record/,
    );
    assert.doesNotMatch(
      day1.stderr,
      /could not fetch "(Exam Replay offer|FAQ \(PDF\))"/,
      "one warning for all the sources the deadline cut off, not one each",
    );
    assert.equal(
      day1.output.changes_found,
      "false",
      "slowness is never a change",
    );
    assert.equal(day1.report, null);
    assert.match(
      day1.summary,
      /\| Exam Replay offer \| FAILED, kept \| not requested: the run deadline of 250 ms was reached \|/,
    );
    assert.match(day1.summary, /\| FAQ \(PDF\) \| FAILED, kept \|/);
    const afterDay1 = JSON.parse(day1.tracker);
    assert.equal(
      afterDay1.sources[0].failures,
      undefined,
      "the source that answered is healthy",
    );
    assert.equal(afterDay1.sources[1].failures, 1);
    assert.equal(afterDay1.sources[2].failures, 1);
    assert.equal(
      afterDay1.sources[1].contentHash,
      baseline.sources[1].contentHash,
      "the last good text is kept",
    );
    assert.deepEqual(
      afterDay1.sources[2].validators,
      baseline.sources[2].validators,
    );

    const day2 = await world.run("2026-10-16", slow);
    assert.equal(JSON.parse(day2.tracker).sources[1].failures, 2);
    assert.deepEqual(world.issues(), [], "two days are not enough");

    // The third day in a row raises the one running issue, BEFORE the tracker is written.
    const day3 = await world.run("2026-10-17", slow);
    assert.equal(day3.code, 0, day3.stderr);
    assert.equal(day3.output.attention, "true");
    assert.equal(world.issues().length, 1);
    const [issue] = world.issues();
    assert.equal(issue.title, ATTENTION_ISSUE_TITLE);
    assert.deepEqual(issue.labels, ["bug"]);
    assert.match(
      issue.body,
      /### Sources that could not be read 3 runs in a row/,
    );
    assert.match(
      issue.body,
      /\[Exam Replay offer\].*not requested: the run deadline of 250 ms was reached/,
    );
    assert.match(issue.body, /\[FAQ \(PDF\)\]/);
    assert.doesNotMatch(
      issue.body,
      /\[Retake policy\]/,
      "the source that answered is not blamed",
    );

    // The host recovers: the issue closes and the records clear.
    delete world.site.routes.get("/policy/retake").delayMs;
    const healed = await world.run("2026-10-18", world.withIssues());
    assert.equal(healed.code, 0, healed.stderr);
    assert.equal(healed.output.changes_found, "false");
    assert.equal(world.issues()[0].state, "closed");
    assert.equal(JSON.parse(healed.tracker).sources[1].failures, undefined);
  } finally {
    await world.cleanup();
  }
});

test("end to end: the deadline counts from the first request, so slow setup never cuts off the first source", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run("2026-10-14", world.withIssues());
    assert.equal(first.code, 0, first.stderr);
    // A one-millisecond deadline: reading the watch list and scanning the content
    // pages takes longer than that on any machine (the old clock started before
    // them and skipped every source, which made the run fail with "none of the
    // sources could be read"). The first source is always asked.
    const before = world.site.requests.length;
    const tiny = await world.run("2026-10-15", {
      ...world.withIssues(),
      RUN_DEADLINE_MS: "1",
    });
    assert.equal(tiny.code, 0, tiny.stderr);
    assert.deepEqual(
      world.site.requests.slice(before).map((r) => r.split(" ")[1]),
      ["/policy/retake"],
    );
    assert.match(
      tiny.stderr,
      /the run deadline of 1 ms was reached: 2 of 3 sources were not requested/,
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: more sources changing at once than the limit is held back, shown with counts only, and accepted with FORCE_BASELINE", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run("2026-10-14", world.withIssues());
    assert.equal(first.code, 0, first.stderr);

    // a template change: every page now has a different line
    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy", ["New A", "New B", "New C"]),
    });
    world.site.routes.set("/offer/home", {
      body: NO_MAIN_PAGE.replace(
        "Exam Replay gives you a second chance",
        "A different sentence",
      ),
    });
    const held = await world.run("2026-10-15", {
      ...world.withIssues(),
      MAX_CHANGED: "1",
    });
    assert.equal(held.code, 0, held.stderr);
    assert.equal(held.output.changes_found, "false", "no per-source issue");
    assert.equal(held.output.mass_change, "true");
    assert.equal(held.output.attention, "true");
    assert.equal(held.report, null);
    assert.match(held.stderr, /2 of 3 sources changed at once \(limit 1\)/);
    assert.match(held.summary, /CHANGED, HELD BACK/);
    assert.equal(world.issues().length, 1);
    const body = world.issues()[0].body;
    assert.match(body, /### Many sources changed at once \(held back\)/);
    assert.match(
      body,
      /2 of 3 watched sources changed text in one run, more than the limit of 1/,
    );
    assert.ok(
      !body.includes("@@") && !body.includes("New A"),
      "no diffs are shown",
    );
    // the old text is still the previous version
    const heldTracker = JSON.parse(held.tracker);
    const firstTracker = JSON.parse(first.tracker);
    assert.deepEqual(heldTracker.sources, firstTracker.sources);

    // the same hold repeats without a new comment
    const writes = world.ghWrites().length;
    const repeat = await world.run("2026-10-16", {
      ...world.withIssues(),
      MAX_CHANGED: "1",
    });
    assert.equal(repeat.output.mass_change, "true");
    assert.equal(world.ghWrites().length, writes);

    // accepted: the new text is recorded silently and the issue closes
    const forced = await world.run("2026-10-17", {
      ...world.withIssues(),
      MAX_CHANGED: "1",
      FORCE_BASELINE: "1",
    });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.output.changes_found, "false");
    assert.equal(forced.output.mass_change, "false");
    assert.equal(forced.report, null);
    assert.match(forced.summary, /changed, accepted \(forced\)/);
    assert.deepEqual(JSON.parse(forced.tracker).sources[0].lines, [
      "# Retake policy",
      "Intro paragraph.",
      "## Rules",
      "- New A",
      "- New B",
      "- New C",
      "Closing paragraph one.",
      "Closing paragraph two.",
    ]);
    assert.equal(world.issues()[0].state, "closed");
    const quiet = await world.run("2026-10-18", world.withIssues());
    assert.equal(quiet.output.baseline_updated, "false");
    assert.equal(quiet.output.mass_change, "false");
  } finally {
    await world.cleanup();
  }
});

test("end to end: a watched source that no hub page cites, or a missing alsoFeeds page, is a running issue", async () => {
  const world = await makeWorld();
  try {
    const sources = JSON.parse(
      await readFile(world.files.watch, "utf8"),
    ).sources;
    sources[0].alsoFeeds = ["src/content/docs/guide/deleted.mdx"];
    sources.push({
      url: `${world.site.origin}/policy/orphan`,
      kind: "html",
      label: "Orphan page",
    });
    world.site.routes.set("/policy/orphan", { body: learnHtml("Orphan") });
    await writeFile(world.files.watch, JSON.stringify({ sources }));

    const run = await world.run("2026-10-14", world.withIssues());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.attention, "true");
    assert.match(run.stderr, /no hub page cites "Orphan page"/);
    assert.match(
      run.stderr,
      /lists src\/content\/docs\/guide\/deleted\.mdx in alsoFeeds, which does not exist/,
    );
    const [issue] = world.issues();
    assert.match(
      issue.body,
      /### Watched sources that no hub page cites\n[\s\S]*Orphan page/,
    );
    assert.match(
      issue.body,
      /### `alsoFeeds` pages that do not exist\n[\s\S]*deleted\.mdx/,
    );
    // the baseline is still recorded and nothing is reported as a change
    assert.equal(run.output.changes_found, "false");
    assert.equal(JSON.parse(run.tracker).sources.length, 4);

    // the entry is removed from the list: the tracker drops it and the issue closes
    await writeFile(
      world.files.watch,
      JSON.stringify({
        sources: sources.slice(0, 3).map(({ alsoFeeds, ...rest }) => rest),
      }),
    );
    const fixed = await world.run("2026-10-15", world.withIssues());
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(world.issues()[0].state, "closed");
    assert.equal(JSON.parse(fixed.tracker).sources.length, 3);
  } finally {
    await world.cleanup();
  }
});

test("end to end: when no source can be read the run fails, writes nothing and raises one failure issue, closed by the next healthy run", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run("2026-10-14", world.withIssues());
    assert.equal(first.code, 0, first.stderr);

    for (const route of [
      "/policy/retake",
      "/offer/home",
      "/files/faq-v1.pdf",
    ]) {
      world.site.routes.set(route, { status: 503 });
    }
    const failed = await world.run("2026-10-15", world.withIssues());
    assert.equal(failed.code, 1);
    assert.equal(failed.output.extraction_failed, "true");
    assert.equal(failed.output.changes_found, "false");
    assert.equal(failed.output.baseline_updated, "false");
    assert.equal(failed.tracker, first.tracker, "the tracker is untouched");
    assert.match(failed.error, /None of the 3 watched sources could be read/);
    assert.match(failed.error, /\/policy\/retake: HTTP 503/);
    assert.equal(world.issues().length, 1);
    assert.equal(world.issues()[0].title, FAILED_ISSUE_TITLE);
    assert.deepEqual(world.issues()[0].labels, ["bug"]);

    // another failed run is a comment, not a second issue
    const again = await world.run("2026-10-16", world.withIssues());
    assert.equal(again.code, 1);
    assert.equal(world.issues().length, 1);
    assert.equal(world.issues()[0].comments.length, 1);

    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy"),
    });
    world.site.routes.set("/offer/home", { body: NO_MAIN_PAGE });
    world.site.routes.set("/files/faq-v1.pdf", pdfSpec('"v1"'));
    const healthy = await world.run("2026-10-17", world.withIssues());
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.equal(world.issues()[0].state, "closed");
    assert.match(
      world.issues()[0].comments.at(-1),
      /Source Watch ran normally on 2026-10-17/,
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: a corrupt tracker or watch list fails the run without touching the tracker", async () => {
  const world = await makeWorld();
  try {
    await writeFile(world.files.tracker, "{ not json");
    const corrupt = await world.run();
    assert.equal(corrupt.code, 1);
    assert.equal(corrupt.output.extraction_failed, "true");
    assert.match(corrupt.error, /Corrupt tracker file at .*\(invalid JSON\)/);
    assert.equal(corrupt.tracker, "{ not json");

    await writeFile(
      world.files.tracker,
      JSON.stringify({
        sources: [{ url: "https://x.test/a", contentHash: "short" }],
      }),
    );
    const bad = await world.run();
    assert.equal(bad.code, 1);
    assert.match(bad.error, /Corrupt tracker file at .*malformed contentHash/);

    await rm(world.files.tracker);
    await writeFile(
      world.files.watch,
      JSON.stringify({
        sources: [{ url: "https://x.test/a", kind: "xml", label: "A" }],
      }),
    );
    const list = await world.run();
    assert.equal(list.code, 1);
    assert.match(list.error, /Corrupt watch list at .*expected html or pdf/);
    assert.equal(list.tracker, null, "nothing was written");

    await writeFile(world.files.watch, JSON.stringify({ sources: [] }));
    const empty = await world.run();
    assert.equal(empty.code, 1);
    assert.match(empty.error, /the list is empty/);
  } finally {
    await world.cleanup();
  }
});

test("end to end: a page that moved is reported with its new location when its text changed", async () => {
  const world = await makeWorld();
  try {
    const first = await world.run();
    assert.equal(first.code, 0, first.stderr);
    world.site.routes.set("/policy/retake", {
      redirect: "/policy/retake-v2",
      status: 301,
    });
    world.site.routes.set("/policy/retake-v2", {
      body: learnHtml("Retake policy", ["Moved and edited", "Second", "Third"]),
    });
    const moved = await world.run("2026-10-15");
    assert.equal(moved.code, 0, moved.stderr);
    assert.equal(moved.output.changes_found, "true");
    assert.match(
      moved.report,
      /now redirects to http:\/\/127\.0\.0\.1:\d+\/policy\/retake-v2\. The page moved/,
    );
    assert.match(
      moved.stderr,
      /NOTE: .*\/policy\/retake now redirects to .*\/policy\/retake-v2/,
    );
    // another site is never read as the page
    const port = new URL(world.site.origin).port;
    world.site.routes.set("/policy/retake-v2", {
      redirect: `http://localhost:${port}/other`,
      status: 302,
    });
    world.site.routes.set("/other", { body: learnHtml("Somewhere else") });
    const away = await world.run("2026-10-16");
    assert.equal(away.output.changes_found, "false");
    assert.match(away.stderr, /redirected to another site \(localhost\)/);
  } finally {
    await world.cleanup();
  }
});

test("end to end: skipSections keeps a volatile catalogue out of the decision, and a vanished heading is a warning", async () => {
  const world = await makeWorld({ withPdf: false });
  try {
    const page = (catalogue, heading = "Free services") =>
      learnHtml("Student offer", [
        "Credit of 100 dollars",
        "Renews yearly",
        "Open to students",
      ]).replace(
        "</ul>",
        `</ul><h2>${heading}</h2><ul><li>${catalogue}</li><li>Fixed entry</li></ul><h2>Next</h2><p>After the catalogue.</p>`,
      );
    const sources = JSON.parse(
      await readFile(world.files.watch, "utf8"),
    ).sources;
    sources[0].skipSections = ["Free services"];
    await writeFile(world.files.watch, JSON.stringify({ sources }));
    world.site.routes.set("/policy/retake", { body: page("Azure DevOps") });

    const first = await world.run();
    assert.equal(first.code, 0, first.stderr);
    assert.ok(
      !JSON.parse(first.tracker).sources[0].lines.some((l) =>
        l.includes("Azure DevOps"),
      ),
    );

    world.site.routes.set("/policy/retake", {
      body: page("Azure DevOps, Azure Functions, a lot more"),
    });
    const same = await world.run("2026-10-15");
    assert.equal(same.output.changes_found, "false");
    assert.equal(same.tracker, first.tracker);

    world.site.routes.set("/policy/retake", {
      body: page("x").replace("Renews yearly", "Renews every two years"),
    });
    const real = await world.run("2026-10-16");
    assert.equal(real.output.changes_found, "true");
    assert.match(real.report, /- - Renews yearly\n\+ - Renews every two years/);

    world.site.routes.set("/policy/retake", { body: page("x", "Products") });
    const renamed = await world.run("2026-10-17");
    assert.equal(renamed.output.changes_found, "false");
    assert.match(
      renamed.stderr,
      /the section "Free services" \(skipSections\) is no longer on the page/,
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: the article is the content blocks on a Learn host and the whole <main> on any other site", async () => {
  const world = await makeWorld({ withPdf: false });
  try {
    // learnHtml has a feedback box inside <main>, outside its content blocks.
    const original = learnHtml("Retake policy");
    const edited = original.replace(
      "Was this page helpful?",
      "Offer ends 1 December.",
    );
    const asLearn = { LEARN_HOSTS: "127.0.0.1" };
    const asOther = { LEARN_HOSTS: "learn.example" };

    const learn = await world.run("2026-10-14", asLearn);
    assert.equal(learn.code, 0, learn.stderr);
    const learnLines = JSON.parse(learn.tracker).sources[0].lines;
    assert.equal(learnLines[0], "# Retake policy");
    assert.ok(!learnLines.includes("Was this page helpful?"));
    // A change outside the content blocks is no change on a Learn host.
    world.site.routes.set("/policy/retake", { body: edited });
    const same = await world.run("2026-10-15", asLearn);
    assert.equal(same.output.changes_found, "false");
    assert.equal(same.tracker, learn.tracker);

    // On any other host nothing of <main> goes unwatched.
    await rm(world.files.tracker);
    world.site.routes.set("/policy/retake", { body: original });
    const other = await world.run("2026-10-14", asOther);
    assert.equal(other.code, 0, other.stderr);
    assert.deepEqual(JSON.parse(other.tracker).sources[0].lines, [
      ...learnLines,
      "Was this page helpful?",
    ]);
    world.site.routes.set("/policy/retake", { body: edited });
    const changed = await world.run("2026-10-15", asOther);
    assert.equal(changed.output.changes_found, "true");
    assert.match(
      changed.report,
      /- Was this page helpful\?\n\+ Offer ends 1 December\./,
    );
  } finally {
    await world.cleanup();
  }
});

test("end to end: the Learn sitemap lastmod is only a hint in the report, and a failing sitemap changes nothing", async () => {
  const world = await makeWorld({ withPdf: false });
  try {
    const hint = {
      SITEMAP_HINT: "1",
      LEARN_HOSTS: "127.0.0.1",
      SITEMAP_INDEX_URL: `${world.site.origin}/_sitemaps/sitemapindex.xml`,
    };
    world.site.routes.set("/_sitemaps/sitemapindex.xml", {
      type: "application/xml",
      body: "<sitemapindex><sitemap><loc>https://learn.microsoft.com/_sitemaps/credentials_en-us_1.xml</loc></sitemap></sitemapindex>",
    });
    world.site.routes.set("/_sitemaps/credentials_en-us_1.xml", {
      type: "application/xml",
      body: "<urlset><url><loc>http://127.0.0.1/policy/retake</loc><lastmod>2026-10-02T08:00:00Z</lastmod></url></urlset>",
    });
    const first = await world.run("2026-10-14", hint);
    assert.equal(first.code, 0, first.stderr);
    assert.match(
      first.summary,
      /\| Retake policy \| baseline recorded \| — \| 8 \| 2026-10-01 \| 2026-10-02 \| 1 \|/,
    );

    // the hint moving is no change
    world.site.routes.set("/_sitemaps/credentials_en-us_1.xml", {
      type: "application/xml",
      body: "<urlset><url><loc>http://127.0.0.1/policy/retake</loc><lastmod>2026-10-13</lastmod></url></urlset>",
    });
    const moved = await world.run("2026-10-15", hint);
    assert.equal(moved.output.changes_found, "false");
    assert.equal(moved.tracker, first.tracker);

    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy", ["Changed", "Second", "Third"]),
    });
    const changed = await world.run("2026-10-16", hint);
    assert.match(changed.report, /\| 2026-10-01, sitemap 2026-10-13 \|/);

    // a sitemap that is down: a warning, the same decision
    world.site.routes.set("/_sitemaps/sitemapindex.xml", { status: 500 });
    world.site.routes.set("/policy/retake", {
      body: learnHtml("Retake policy", ["Changed again", "Second", "Third"]),
    });
    const down = await world.run("2026-10-17", hint);
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.output.changes_found, "true");
    assert.match(down.stderr, /the Learn sitemap hint is unavailable/);
    assert.match(down.report, /\| 2026-10-01 \|/);
  } finally {
    await world.cleanup();
  }
});

test("end to end: DRY_RUN touches no issue, and the report and attention text are still written", async () => {
  const world = await makeWorld({ withPdf: false });
  try {
    await world.run("2026-10-14", world.withIssues());
    const callsBefore = world.ghCalls().length;
    world.site.routes.set("/policy/retake", { status: 404 });
    for (const day of ["2026-10-15", "2026-10-16", "2026-10-17"]) {
      const dry = await world.run(day, { ...world.withIssues(), DRY_RUN: "1" });
      assert.equal(dry.code, 0, dry.stderr);
    }
    assert.equal(world.ghCalls().length, callsBefore, "not even a lookup");
    const last = await world.run("2026-10-18", {
      ...world.withIssues(),
      DRY_RUN: "1",
    });
    assert.match(
      last.attention,
      /Sources that could not be read 3 runs in a row/,
    );
  } finally {
    await world.cleanup();
  }
});

test("the script's header documents every environment override it reads", () => {
  const source = readFileSync(script, "utf8");
  const header = source.slice(0, source.indexOf("\nimport "));
  assert.ok(header.length > 1000, "the header was found");
  const read = new Set(
    [...source.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]),
  );
  for (const name of read) {
    assert.ok(header.includes(name), `${name} is documented in the header`);
  }
});
