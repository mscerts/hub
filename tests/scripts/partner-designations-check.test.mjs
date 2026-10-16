import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  LINES_FORMAT,
  applyResults,
  buildIssueTitle,
  buildReport,
  diffLines,
  feedsText,
  hashLines,
  htmlToLines,
  loadConfig,
  normalizeTracker,
  parsePartnerPage,
  renderDiff,
  retryDelayMs,
  storedLines,
  summarizeDiff,
  trackerContent,
} from "../../scripts/partner-designations-check.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/partner-designations-check.mjs");
const FIXTURE = readFileSync(
  join(root, "tests/fixtures/partner-designations/solution-area.html"),
  "utf8",
);
const TODAY = "2026-10-13";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const read = (lines, extra = {}) => ({
  ok: true,
  lines,
  hash: hashLines(lines),
  updatedAt: "2026-10-01",
  ...extra,
});

function trackedPage(name, lines, extra = {}) {
  return {
    label: name,
    url: `https://learn.example/${name.toLowerCase().replace(/\W+/g, "-")}`,
    areas: [name],
    feeds: undefined,
    contentHash: lines ? hashLines(lines) : null,
    lastChanged: undefined,
    lines: lines ?? undefined,
    ...extra,
  };
}

function trackerOf(pages, extra = {}) {
  return {
    lastSynced: "2026-09-16",
    format: LINES_FORMAT,
    pages,
    ...extra,
  };
}

/** The fixture page as another solution area, so every page has its own text. */
function pageHtml(area, mutate = (html) => html) {
  return mutate(
    FIXTURE.replaceAll(
      "Solutions Partner for Security",
      `Solutions Partner for ${area}`,
    ),
  );
}

/**
 * The same article text in different clothes: other ids and classes, wrapped
 * lines, entities, soft hyphens, no-break spaces, CRLF line ends, other chrome,
 * another "Last updated" date and other link targets.
 */
function reformat(html) {
  return html
    .replace(/class="([^"]*)"/g, (whole, value) =>
      value.split(/\s+/).includes("content") ? whole : 'class="restyled"',
    )
    .replace(/\bid="[^"]*"/g, 'id="x"')
    .replace(/href="[^"]*"/g, 'href="/moved/elsewhere"')
    .replace(/(\w) (\w)/g, "$1\n    $2")
    .replace(/ points/g, "&nbsp;points")
    .replace(/doesn't/g, "doesn&#39;t")
    .replace(/certification/g, "certi&shy;fication")
    .replace(/Last updated on/g, "Page last republished")
    .replace(/2026-07-31|2026-08-31/g, "2026-10-12")
    .replace(/Feedback/g, "Send feedback")
    .replace(/In this article/g, "On this page")
    .replace(/\n/g, "\r\n");
}

function article(extra = []) {
  return [
    "# Page title",
    "Intro text of the page.",
    "## Skilling category",
    "- First certification",
    "- Second certification",
    ...extra,
    "## Related content",
    "- Some link",
    "More text one.",
    "More text two.",
    "More text three.",
    "More text four.",
  ];
}

const articleHtml = (body, { title = "Page title" } = {}) =>
  `<html><head><title>${title}</title><meta name="updated_at" content="2026-10-01T16:00:00Z" /></head>` +
  `<body><nav>Chrome nav</nav><main><div class="content"><h1>${title}</h1></div>` +
  `<div class="content">${body}</div><div id="feedback">Was this page helpful?</div></main></body></html>`;

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

test("entities are decoded once, in one pass", () => {
  assert.equal(
    htmlToLines("<p>&amp;lt; and &#x41; and &unknown; and &#1114112;</p>")[0],
    "&lt; and A and &unknown; and",
  );
});

// ---------------------------------------------------------------------------
// The article of a Learn page
// ---------------------------------------------------------------------------
test("a Learn page yields its article text only, never the page chrome", () => {
  const page = parsePartnerPage(FIXTURE);
  assert.equal(page.ok, true);
  assert.equal(page.updatedAt, "2026-08-31");
  assert.equal(page.lines[0], "# Solutions Partner for Security");
  assert.ok(page.lines.length > 40);
  assert.ok(
    page.lines.includes("- Cloud and AI Security Engineer Associate"),
    "list items keep their text",
  );
  assert.ok(page.lines.includes("## Skilling category"));
  assert.ok(page.lines.includes("#### STEP 1 (Required)"));
  const text = page.lines.join("\n");
  for (const chrome of [
    "Table of contents",
    "Exit editor mode",
    "Ask Learn",
    "Feedback",
    "Summarize this article",
    "In this article",
    "Was this page helpful",
    "Last updated on",
    "Additional resources",
    "Skip to main content",
    "Previous Versions",
    "Solutions Partner for Azure",
  ]) {
    assert.ok(
      !text.includes(chrome),
      `"${chrome}" is page chrome, not article text`,
    );
  }
});

test("the hash ignores formatting, ids, classes, links, entities, line wraps and every bit of page chrome", () => {
  const plain = parsePartnerPage(FIXTURE);
  const dressed = parsePartnerPage(reformat(FIXTURE));
  assert.equal(dressed.ok, true);
  assert.deepEqual(dressed.lines, plain.lines);
  assert.equal(hashLines(dressed.lines), hashLines(plain.lines));
  // The republish date is shown in the issue, but it never decides: the dressed
  // page says it was republished later and still has the same hash.
  assert.equal(plain.updatedAt, "2026-08-31");
  assert.equal(dressed.updatedAt, "2026-10-12");
});

test("a change of the article text changes the hash, however small", () => {
  const base = hashLines(parsePartnerPage(FIXTURE).lines);
  for (const [from, to] of [
    ["minimum of 70 points", "minimum of 80 points"],
    ["adds 6.67 points in Step 3", "adds 7.5 points in Step 3"],
    [
      "Cloud and AI Security Engineer Associate",
      "Cloud and AI Security Engineer Expert",
    ],
  ]) {
    assert.ok(FIXTURE.includes(from), `fixture contains "${from}"`);
    const changed = parsePartnerPage(FIXTURE.replace(from, to));
    assert.notEqual(hashLines(changed.lines), base, `${from} -> ${to}`);
  }
});

test("a page that is not the article is never read as one", () => {
  const cases = [
    [
      "a bot-check page",
      "<html><body><h1>Just a moment...</h1><p>Checking your browser.</p></body></html>",
      /no <main>/,
    ],
    [
      "an empty main",
      "<html><body><main><p>Hello</p></main></body></html>",
      /no <div class="content">/,
    ],
    [
      "a page without title",
      '<html><body><main><div class="content">' +
        "<p>Text line.</p>".repeat(20) +
        "</div></main></body></html>",
      /no page title/,
    ],
    [
      "a page with hardly any text",
      '<html><body><main><div class="content"><h1>Title</h1><p>One.</p></div></main></body></html>',
      /only 2 text lines/,
    ],
    ["nothing at all", "", /no <main>/],
  ];
  for (const [name, html, reason] of cases) {
    const result = parsePartnerPage(html);
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
});

test("content blocks inside content blocks count once, and chrome outside the blocks never counts", () => {
  const html = articleHtml(
    '<p>Outer text.</p><div class="content"><p>Inner text.</p></div><p>After inner.</p>',
  ).replace("<nav>", '<nav><div class="content">Not in main</div>');
  const result = parsePartnerPage(html, { minLines: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, [
    "# Page title",
    "Outer text.",
    "Inner text.",
    "After inner.",
  ]);
});

test("a malformed updated_at never reaches the issue", () => {
  const page = parsePartnerPage(
    articleHtml("<p>x</p>".repeat(12)).replace(
      "2026-10-01T16:00:00Z",
      "<script>alert(1)</script>",
    ),
  );
  assert.equal(page.ok, true);
  assert.equal(page.updatedAt, "");
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
test("the line diff names the headings a change sits under and shows removed and added lines", () => {
  const oldLines = article();
  const newLines = article().map((line) =>
    line === "- Second certification"
      ? "- Second certification (renamed)"
      : line,
  );
  newLines.splice(
    newLines.indexOf("## Related content"),
    0,
    "- Third certification",
  );

  const diff = summarizeDiff(oldLines, newLines);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.entries, [
    { kind: "hunk", context: "Page title > Skilling category" },
    { kind: "-", line: "- Second certification" },
    { kind: "+", line: "- Second certification (renamed)" },
    { kind: "+", line: "- Third certification" },
  ]);
  const rendered = renderDiff(diff.entries, 10);
  assert.equal(
    rendered.text,
    [
      "@@ Page title > Skilling category @@",
      "- - Second certification",
      "+ - Second certification (renamed)",
      "+ - Third certification",
    ].join("\n"),
  );
  assert.equal(rendered.shown, 3);
  assert.equal(rendered.omitted, 0);
});

test("the diff of identical text is empty and a huge differing middle falls back to remove-all add-all", () => {
  assert.equal(summarizeDiff(article(), article()).entries.length, 0);
  const a = Array.from({ length: 2500 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 2500 }, (_, i) => `new ${i}`);
  const ops = diffLines(["same", ...a, "end"], ["same", ...b, "end"]);
  assert.equal(ops.filter((op) => op.t === "-").length, 2500);
  assert.equal(ops.filter((op) => op.t === "+").length, 2500);
  assert.equal(ops[0].t, "=");
  assert.equal(ops.at(-1).t, "=");
});

test("a long diff is cut with a count of what is left out, long lines are clipped and fences cannot break out", () => {
  const entries = [{ kind: "hunk", context: "A".repeat(500) + "```" }];
  for (let i = 0; i < 12; i++) entries.push({ kind: "+", line: `added ${i}` });
  entries.push({ kind: "-", line: "x".repeat(900) + " ``` fence" });
  const rendered = renderDiff(entries, 5);
  assert.equal(rendered.shown, 5);
  assert.equal(rendered.omitted, 8);
  const longer = renderDiff(entries.slice(0, 1).concat(entries.slice(-1)), 5);
  assert.ok(longer.text.split("\n").every((line) => line.length <= 310));
  assert.ok(!longer.text.includes("```"));
  assert.ok(!rendered.text.includes("```"));
});

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
test("a tracker written before this check loads, with nothing stored", () => {
  const hash = "a".repeat(64);
  const tracker = normalizeTracker({
    lastSynced: "2026-09-16",
    pages: [
      {
        label: "Security",
        url: "https://learn.example/security",
        areas: ["Security"],
        contentHash: hash,
        lastChanged: "2026-09-16",
      },
      {
        label: "New",
        url: "https://learn.example/new",
        areas: [],
        contentHash: null,
      },
    ],
  });
  assert.equal(tracker.format, 0);
  assert.equal(tracker.pages[0].contentHash, hash);
  assert.equal(tracker.pages[0].lines, undefined);
  assert.equal(tracker.pages[1].contentHash, null);
  assert.equal(storedLines(tracker.pages[0], tracker.format), null);
});

test("a corrupt tracker is rejected, not repaired", () => {
  const ok = {
    label: "A",
    url: "https://learn.example/a",
    areas: [],
    contentHash: null,
  };
  const bad = [
    [null, /pages array/],
    [{}, /pages array/],
    [{ pages: [{ ...ok, url: "not a url" }] }, /no valid url/],
    [{ pages: [ok, { ...ok, label: "B" }] }, /repeats the url/],
    [{ pages: [{ ...ok, contentHash: "abc" }] }, /malformed contentHash/],
    [{ pages: [{ ...ok, contentHash: 5 }] }, /malformed contentHash/],
    [{ pages: [{ ...ok, lines: "text" }] }, /malformed stored lines/],
    [{ pages: [{ ...ok, lines: ["a", 2] }] }, /malformed stored lines/],
  ];
  for (const [input, reason] of bad) {
    assert.throws(() => normalizeTracker(input), reason);
  }
});

test("the tracker file has a fixed key order and survives a round trip", () => {
  const lines = article();
  const tracker = trackerOf(
    [
      trackedPage("Security", lines, {
        lastChanged: "2026-10-01",
        feeds: "the Security tab",
      }),
      trackedPage("Modern Work", null),
    ],
    { lastSynced: TODAY },
  );
  const content = trackerContent(tracker);
  assert.ok(content.endsWith("}\n"));
  assert.deepEqual(Object.keys(JSON.parse(content)), [
    "lastSynced",
    "format",
    "pages",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(content).pages[0]), [
    "label",
    "url",
    "areas",
    "feeds",
    "contentHash",
    "lastChanged",
    "lines",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(content).pages[1]), [
    "label",
    "url",
    "areas",
    "contentHash",
  ]);
  assert.equal(trackerContent(normalizeTracker(JSON.parse(content))), content);
  // One JSON line per stored text line: a git diff of the tracker shows what changed.
  assert.ok(
    content.split("\n").filter((row) => row.includes("Second certification"))
      .length === 1,
  );
});

test("the committed tracker is valid, lists the guide's pages and carries the repo's tracking parameter", () => {
  const tracker = normalizeTracker(
    JSON.parse(
      readFileSync(
        join(root, "src/data_files/partner-designations.json"),
        "utf8",
      ),
    ),
  );
  assert.ok(tracker.pages.length >= 6);
  for (const page of tracker.pages) {
    assert.match(
      page.url,
      /^https:\/\/learn\.microsoft\.com\/partner-center\/membership\/[a-z-]+\?WT\.mc_id=studentamb_165290$/,
    );
    assert.ok(page.label);
  }
  const urls = tracker.pages.map((page) => page.url);
  assert.ok(urls.some((url) => url.includes("/introduction-to-pcs?")));
  assert.ok(urls.some((url) => url.includes("/ms-learn-associate?")));
  // The four solution area pages are the ones the guide page links by hand.
  const guide = readFileSync(
    join(root, "src/content/docs/guide/partneremployees.mdx"),
    "utf8",
  );
  for (const name of ["azure", "security", "business", "modern-work"]) {
    const url = urls.find((candidate) =>
      candidate.includes(`solutions-partner-${name}?`),
    );
    assert.ok(url, `${name} is tracked`);
    assert.ok(guide.includes(url), `${name} is linked from the guide page`);
  }
  // Pages that have a hash have their lines too (or neither, before the first run).
  for (const page of tracker.pages) {
    if (page.lines) assert.equal(hashLines(page.lines), page.contentHash);
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
test("a tracker without stored text baselines every readable page silently", () => {
  const oldBodyHash = "b".repeat(64);
  const tracker = normalizeTracker({
    lastSynced: "2026-09-16",
    pages: [
      {
        label: "Security",
        url: "https://learn.example/security",
        areas: ["Security"],
        contentHash: oldBodyHash,
        lastChanged: "2026-09-16",
      },
      {
        label: "Intro",
        url: "https://learn.example/intro",
        areas: [],
        contentHash: null,
      },
      {
        label: "Down",
        url: "https://learn.example/down",
        areas: [],
        contentHash: oldBodyHash,
      },
    ],
  });
  const lines = article();
  const result = applyResults(
    tracker,
    [
      read(lines),
      read(lines.slice(0, 8)),
      { ok: false, kind: "fetch", reason: "HTTP 503" },
    ],
    TODAY,
  );
  assert.equal(result.changed.length, 0, "an older tracker never alerts");
  assert.equal(result.baselined.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.dirty, true);
  assert.equal(result.tracker.format, LINES_FORMAT);
  assert.equal(result.tracker.lastSynced, TODAY);
  const [security, intro, down] = result.tracker.pages;
  assert.equal(security.contentHash, hashLines(lines));
  assert.deepEqual(security.lines, lines);
  assert.equal(
    security.lastChanged,
    "2026-09-16",
    "a baseline is not a change",
  );
  assert.equal(intro.lastChanged, undefined);
  assert.equal(
    down.contentHash,
    oldBodyHash,
    "an unread page keeps its record",
  );
  assert.equal(down.lines, undefined);
  // The input is never modified.
  assert.equal(tracker.pages[0].contentHash, oldBodyHash);
  assert.equal(tracker.format, 0);
});

test("the same hash is no change at all and does not touch the tracker", () => {
  const lines = article();
  const tracker = trackerOf([
    trackedPage("Security", lines),
    trackedPage("Intro", article(["- Extra"])),
  ]);
  const result = applyResults(
    tracker,
    [read(lines), read(article(["- Extra"]))],
    TODAY,
  );
  assert.equal(result.dirty, false);
  assert.equal(result.unchanged.length, 2);
  assert.equal(result.tracker, tracker);
  assert.equal(trackerContent(result.tracker), trackerContent(tracker));
});

test("a changed hash with stored text is a change with a diff; the new text is recorded", () => {
  const before = article();
  const after = article(["- Third certification"]);
  const tracker = trackerOf([
    trackedPage("Security", before, { lastChanged: "2026-09-16" }),
    trackedPage("Intro", article(["- Same"])),
  ]);
  const result = applyResults(
    tracker,
    [
      read(after, { redirectedTo: "https://learn.example/moved" }),
      read(article(["- Same"])),
    ],
    TODAY,
  );
  assert.equal(result.changed.length, 1);
  assert.equal(result.unchanged.length, 1);
  const [change] = result.changed;
  assert.equal(change.page.label, "Security");
  assert.equal(change.redirectedTo, "https://learn.example/moved");
  assert.equal(change.diff.added, 1);
  assert.equal(change.diff.removed, 0);
  assert.equal(result.tracker.pages[0].contentHash, hashLines(after));
  assert.deepEqual(result.tracker.pages[0].lines, after);
  assert.equal(result.tracker.pages[0].lastChanged, TODAY);
  assert.equal(result.tracker.pages[1].lastChanged, undefined);
  // The next read of the same text is quiet.
  const again = applyResults(
    result.tracker,
    [read(after), read(article(["- Same"]))],
    TODAY,
  );
  assert.equal(again.dirty, false);
});

test("stored text that does not hash to the stored hash, or that has another format, is not a previous version", () => {
  const lines = article();
  const edited = trackedPage("Security", lines, {
    contentHash: hashLines(article(["- Other"])),
  });
  assert.equal(storedLines(edited, LINES_FORMAT), null);
  const otherFormat = trackedPage("Security", lines);
  assert.equal(storedLines(otherFormat, LINES_FORMAT + 1), null);
  assert.deepEqual(storedLines(otherFormat, LINES_FORMAT), lines);
  assert.equal(storedLines(trackedPage("Security", []), LINES_FORMAT), null);

  const tracker = trackerOf([edited, trackedPage("Other", lines)], {
    format: LINES_FORMAT + 1,
  });
  const result = applyResults(
    tracker,
    [
      read(article(["- New"])),
      { ok: false, kind: "fetch", reason: "HTTP 500" },
    ],
    TODAY,
  );
  assert.equal(result.changed.length, 0);
  assert.equal(result.baselined.length, 1);
  assert.equal(result.tracker.format, LINES_FORMAT);
  assert.equal(
    result.tracker.pages[1].lines,
    undefined,
    "text of another format is dropped, so the next read baselines it",
  );
  assert.equal(result.tracker.pages[1].contentHash, hashLines(lines));
});

test("a page that failed or is not an article keeps its record and is never a change", () => {
  const lines = article();
  const tracker = trackerOf([
    trackedPage("Security", lines),
    trackedPage("Intro", lines),
    trackedPage("Gone", lines),
  ]);
  const result = applyResults(
    tracker,
    [
      { ok: false, kind: "fetch", reason: "HTTP 503" },
      { ok: false, kind: "parse", reason: "no <main> element" },
      undefined,
    ],
    TODAY,
  );
  assert.equal(result.dirty, false);
  assert.equal(result.failed.length, 2);
  assert.equal(result.unparsed.length, 1);
  assert.equal(result.changed.length, 0);
  assert.equal(result.tracker, tracker);
  assert.equal(result.unparsed[0].reason, "no <main> element");
});

test("formatting-only differences of the real fixture are never a change", () => {
  const plain = parsePartnerPage(FIXTURE);
  const tracker = trackerOf([trackedPage("Security", plain.lines)]);
  const dressed = parsePartnerPage(reformat(FIXTURE));
  const result = applyResults(tracker, [read(dressed.lines)], TODAY);
  assert.equal(result.dirty, false);
  assert.equal(result.unchanged.length, 1);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function changeOf(label, before, after, extra = {}) {
  return {
    page: {
      label,
      url: `https://learn.example/${label.toLowerCase().replace(/\W+/g, "-")}?WT.mc_id=x`,
      areas: [label],
      feeds: undefined,
    },
    diff: summarizeDiff(before, after),
    updatedAt: "2026-10-12",
    ...extra,
  };
}

test("the report names the page, what it feeds, the diff and the steps", () => {
  const security = changeOf(
    "Security",
    article(),
    article(["- Third certification"]).map((line) =>
      line.replace("Intro text", "Intro text, updated"),
    ),
  );
  const intro = changeOf("Intro", article(), article(["- Added"]), {
    page: {
      label: "Intro",
      url: "https://learn.example/intro",
      areas: [],
      feeds: "the introduction section",
    },
  });
  const report = buildReport([security, intro]);
  assert.match(report, /^## Partner Center pages changed \(2\)/);
  assert.match(
    report,
    /\| \[Security\]\(https:\/\/learn\.example\/security\?WT\.mc_id=x\) \| the Security skilling tab/,
  );
  assert.match(
    report,
    /\| \[Intro\]\(https:\/\/learn\.example\/intro\) \| the introduction section \|/,
  );
  assert.match(
    report,
    /```diff\n@@ Page title @@\n- Intro text of the page\.\n\+ Intro text, updated of the page\.\n@@ Page title > Skilling category @@\n\+ - Third certification\n```/,
  );
  assert.match(report, /\+2 \/ -1/);
  assert.match(report, /\+1 \/ -0/);
  assert.match(report, /`src\/content\/docs\/guide\/partneremployees\.mdx`/);
  assert.match(report, /Total skilling points: X\/70/);
  assert.match(report, /### What to do/);
  assert.match(report, /Partner Designation Skilling Requirements/);
  assert.match(report, /2026-10-12/);
  assert.ok(report.endsWith("\n"));
});

test("the report notes a page that moved", () => {
  const moved = changeOf("Security", article(), article(["- X"]), {
    redirectedTo: "https://learn.example/new/place (1)",
  });
  assert.match(
    buildReport([moved]),
    /now redirects to https:\/\/learn\.example\/new\/place%20%281%29/,
  );
});

test("text from a page cannot ping, link or render HTML in the issue", () => {
  const hostile = [
    "Ping @maintainer and close #123 <img src=x onerror=alert(1)> [link](https://evil.example)",
    "```",
    "```diff\n- fake",
    "<details><summary>x</summary>",
  ];
  const change = changeOf(
    "Evil <b>name</b> @someone #5 | `code`",
    article(),
    article(hostile),
  );
  const report = buildReport([change]);
  const fenceStart = report.indexOf("```diff");
  const fenceEnd = report.indexOf("```", fenceStart + 3);
  const fenced = report.slice(fenceStart, fenceEnd);
  assert.ok(fenced.includes("@maintainer"), "page text is inside the fence");
  assert.ok(fenced.includes("<img"), "page text is inside the fence");
  // Only the fence of the diff block opens and closes: no stray fence in the text.
  const outside = report.slice(0, fenceStart) + report.slice(fenceEnd + 3);
  assert.ok(!outside.includes("@maintainer"));
  assert.equal((report.match(/```/g) ?? []).length, 2);
  // The name is sanitized in the table, the heading and the title.
  const rows = report.split("\n").filter((row) => row.startsWith("| ["));
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].includes("<b>"));
  assert.ok(!/@someone/.test(rows[0]));
  assert.ok(!/#5/.test(rows[0]));
  assert.ok(
    !/(^|[^\\])\|.*\|.*\|.*\|.*\|.*\|/.test(rows[0].replace(/\| /g, "")),
    "a pipe in a name never adds a column",
  );
  const title = buildIssueTitle([change]);
  assert.ok(!/[<>`]/.test(title));
  assert.ok(!/@someone/.test(title));
});

test("the report stays under GitHub's size limit by shortening the diffs in steps", () => {
  // Six pages whose every line changed, each line as long as a diff line may get:
  // the first step (200 lines in all) would not fit into one issue.
  const big = (label) =>
    changeOf(
      label,
      Array.from(
        { length: 1500 },
        (_, i) => `old line ${i} ${"x".repeat(320)}`,
      ),
      Array.from(
        { length: 1500 },
        (_, i) => `new line ${i} ${"y".repeat(320)}`,
      ),
    );
  const report = buildReport(
    ["Azure", "Security", "Business", "Modern Work", "Intro", "Associate"].map(
      big,
    ),
  );
  assert.ok(report.length <= 60001, `report is ${report.length} characters`);
  assert.match(
    report,
    /shortened to keep this issue under GitHub's size limit/,
  );
  assert.match(report, /more changed lines are not shown here/);
  assert.match(report, /\+1500 \/ -1500/, "the counts stay exact");
  const small = buildReport([
    changeOf("Security", article(), article(["- One"])),
  ]);
  assert.ok(!small.includes("shortened"));
});

test("the issue title names the pages, drops parentheses and never exceeds 200 characters", () => {
  const named = (label) => changeOf(label, article(), article(["- X"]));
  assert.equal(
    buildIssueTitle([named("Security")]),
    "Partner Center page changed: Security",
  );
  assert.equal(
    buildIssueTitle([
      named(
        "Azure solution areas (Data & AI, Digital & App Innovation, Infrastructure)",
      ),
      named("Modern Work"),
    ]),
    "Partner Center pages changed: Azure solution areas, Modern Work",
  );
  const many = Array.from({ length: 40 }, (_, i) =>
    named(`A fairly long page name number ${i}`),
  );
  const title = buildIssueTitle(many);
  assert.ok(title.length <= 200);
  assert.match(title, /\+\d+ more$/);
  assert.ok(!title.includes("\n"));
});

test("the page text a tracker entry feeds is shown, with a default derived from its areas", () => {
  assert.equal(feedsText({ areas: [], feeds: "the intro" }), "the intro");
  assert.equal(feedsText({ areas: [] }), "the guide page");
  assert.match(
    feedsText({ areas: ["Security"] }),
    /^the Security skilling tab \(/,
  );
  assert.match(
    feedsText({ areas: ["A", "B", "C"] }),
    /^the A, B, C skilling tabs \(/,
  );
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

test("the config reads its overrides and falls back for malformed numbers", () => {
  const cfg = loadConfig({
    TRACKER_FILE: "/tmp/tracker.json",
    FETCH_DELAY_MS: "0",
    MIN_CONTENT_LINES: "abc",
    TODAY: "2026-01-02",
  });
  assert.equal(cfg.trackerFile, "/tmp/tracker.json");
  assert.equal(cfg.fetchDelayMs, 0);
  assert.equal(cfg.minContentLines, 10);
  assert.equal(cfg.today, "2026-01-02");
  assert.equal(loadConfig({ TODAY: "yesterday" }).today.length, 10);
  assert.equal(loadConfig({}).fetchDelayMs, 1000, "polite by default");
});

test("a page is always tried at least once: FETCH_ATTEMPTS below 1 is 1", () => {
  assert.equal(loadConfig({}).fetchAttempts, 3);
  assert.equal(loadConfig({ FETCH_ATTEMPTS: "5" }).fetchAttempts, 5);
  for (const value of ["0", "-2"]) {
    assert.equal(loadConfig({ FETCH_ATTEMPTS: value }).fetchAttempts, 1, value);
  }
  assert.equal(loadConfig({ FETCH_ATTEMPTS: "many" }).fetchAttempts, 3);
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
test("the workflow opens the issue before it commits the tracker and never cancels a run half way", () => {
  const workflow = readFileSync(
    join(root, ".github/workflows/partner-designations-monitor.yml"),
    "utf8",
  );
  const at = (needle) => {
    const index = workflow.indexOf(needle);
    assert.notEqual(index, -1, `workflow has "${needle}"`);
    return index;
  };
  const check = at("- name: Check partner designation pages");
  const issue = at(
    "- name: Create issue if a partner designation page changed",
  );
  const commit = at("- name: Commit updated partner designations tracker");
  const failure = at("- name: Create issue if check failed");
  assert.ok(
    check < issue && issue < commit && commit < failure,
    "check, issue, commit, failure issue",
  );

  const issueStep = workflow.slice(issue, commit);
  assert.match(issueStep, /if: steps\.check\.outputs\.changes_found == 'true'/);
  assert.match(
    issueStep,
    /title: "\$\{\{ steps\.check\.outputs\.issue_title \}\}"/,
  );
  assert.match(
    issueStep,
    /content-filepath: \/tmp\/partner-designations-report\.md/,
  );

  const commitStep = workflow.slice(commit, failure);
  assert.match(
    commitStep,
    /if: steps\.check\.outputs\.baseline_updated == 'true'/,
  );
  assert.ok(
    !/always\(\)|failure\(\)|success\(\)/.test(commitStep),
    "a failed issue step must skip the commit",
  );
  assert.match(commitStep, /for attempt in 1 2 3/);
  assert.match(
    commitStep,
    /git add src\/data_files\/partner-designations\.json/,
  );

  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /cron: "0 8 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /REPORT_FILE: \/tmp\/partner-designations-report\.md/);
  assert.match(
    workflow,
    /failure\(\) && steps\.check\.outputs\.extraction_failed == 'true'/,
  );
});

// ---------------------------------------------------------------------------
// End to end: the script against a local fake of the Partner Center pages
// ---------------------------------------------------------------------------
const AREAS = ["Security", "Modern Work", "Business Applications"];

async function fakeSite() {
  const state = {
    html: Object.fromEntries(AREAS.map((area) => [area, pageHtml(area)])),
    status: {},
    requests: [],
  };
  const server = createServer((request, response) => {
    state.requests.push(request.url);
    // "/p/<area>" serves the page, "/old/<area>" is where a page used to live.
    const area = decodeURIComponent(
      request.url.split("?")[0].split("/")[2] ?? "",
    );
    if (state.status[area]) {
      response.statusCode = state.status[area];
      response.end("error");
      return;
    }
    if (request.url.startsWith("/old/")) {
      response.statusCode = 301;
      response.setHeader("Location", `/p/${encodeURIComponent(area)}`);
      response.end();
      return;
    }
    const html = state.html[area];
    if (html === undefined) {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    origin,
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

async function setup(site, { stored = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "partner-designations-test-"));
  const files = {
    dir,
    tracker: join(dir, "tracker.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "output"),
    summary: join(dir, "summary.md"),
  };
  const pages = AREAS.map((area, index) => ({
    label: area,
    url: `${site.origin}/${index === 0 ? "old" : "p"}/${encodeURIComponent(area)}?WT.mc_id=studentamb_165290`,
    areas: [area],
    // The shape of the tracker before this check stored any text.
    contentHash: stored ? null : "c".repeat(64),
    lastChanged: "2026-09-16",
  }));
  await writeFile(
    files.tracker,
    JSON.stringify({ lastSynced: "2026-09-16", pages }, null, 2) + "\n",
  );
  const run = async (extraEnv = {}) => {
    await writeFile(files.output, "");
    await writeFile(files.summary, "");
    await rm(files.report, { force: true });
    await rm(files.error, { force: true });
    const result = await runScript({
      TRACKER_FILE: files.tracker,
      REPORT_FILE: files.report,
      ERROR_FILE: files.error,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      FETCH_DELAY_MS: "0",
      FETCH_ATTEMPTS: "2",
      RETRY_BASE_MS: "1",
      TODAY,
      ...extraEnv,
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
    return {
      ...result,
      output,
      tracker: await readFile(files.tracker, "utf8"),
    };
  };
  return {
    files,
    run,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("end to end: silent baseline, quiet reruns, a real diff on a real change, nothing on a reformat", async () => {
  const site = await fakeSite();
  const env = await setup(site);
  try {
    // 1. An older tracker (hash only): every page baselines silently.
    const first = await env.run();
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.output.changes_found, "false");
    assert.equal(first.output.baseline_updated, "true");
    assert.equal(first.output.extraction_failed, "false");
    assert.equal(
      existsSync(env.files.report),
      false,
      "a baseline never writes a report",
    );
    const baseline = JSON.parse(first.tracker);
    assert.equal(baseline.format, LINES_FORMAT);
    assert.equal(baseline.lastSynced, TODAY);
    for (const page of baseline.pages) {
      assert.ok(page.lines.length > 40);
      assert.equal(page.contentHash, hashLines(page.lines));
      assert.equal(page.lastChanged, "2026-09-16");
    }
    assert.ok(site.state.requests.some((url) => url.startsWith("/old/")));
    assert.match(
      await readFile(env.files.summary, "utf8"),
      /baseline recorded/,
    );

    // 2. Nothing changed: no write at all, byte for byte.
    const second = await env.run();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.output.changes_found, "false");
    assert.equal(second.output.baseline_updated, "false");
    assert.equal(second.tracker, first.tracker);
    assert.equal(existsSync(env.files.report), false);

    // 3. Only formatting changed (and Learn republished): still nothing.
    for (const area of AREAS) site.state.html[area] = reformat(pageHtml(area));
    const third = await env.run();
    assert.equal(third.code, 0, third.stderr);
    assert.equal(third.output.changes_found, "false");
    assert.equal(third.output.baseline_updated, "false");
    assert.equal(third.tracker, first.tracker);

    // 4. The text of one page changed: an issue with the diff, the tracker records it.
    site.state.html.Security = pageHtml("Security", (html) =>
      html
        .replace("minimum of 70 points", "minimum of 80 points")
        .replace(
          '<li><a href="/en-us/credentials/certifications/cloud-and-ai-security-engineer-associate/" data-linktype="absolute-path">Cloud and AI Security Engineer Associate</a></li>',
          "<li>Cloud and AI Security Engineer Associate</li><li>Security Copilot Specialist</li>",
        ),
    );
    const fourth = await env.run();
    assert.equal(fourth.code, 0, fourth.stderr);
    assert.equal(fourth.output.changes_found, "true");
    assert.equal(fourth.output.baseline_updated, "true");
    assert.equal(fourth.output.pages_changed, "1");
    assert.equal(
      fourth.output.issue_title,
      "Partner Center page changed: Security",
    );
    const report = await readFile(env.files.report, "utf8");
    assert.match(
      report,
      /\| \[Security\]\(http:\/\/127\.0\.0\.1:\d+\/old\/Security\?WT\.mc_id=studentamb_165290\)/,
    );
    assert.match(
      report,
      /- To attain a Solutions Partner for Security designation, you must earn a minimum of 70 points/,
    );
    assert.match(
      report,
      /\+ To attain a Solutions Partner for Security designation, you must earn a minimum of 80 points/,
    );
    assert.match(report, /\+ - Security Copilot Specialist/);
    assert.match(report, /@@ Solutions Partner for Security @@\n- To attain/);
    assert.match(
      report,
      /@@ Intermediate certifications metric > Enterprise track > STEP 1 \(Required\) @@\n\+ - Security Copilot Specialist/,
    );
    assert.ok(
      !report.includes("Modern Work\n\nChanged text"),
      "unchanged pages are not in the report",
    );
    assert.match(report, /\+2 \/ -1/);
    const updated = JSON.parse(fourth.tracker);
    const security = updated.pages.find((page) => page.label === "Security");
    assert.equal(security.lastChanged, TODAY);
    assert.ok(security.lines.includes("- Security Copilot Specialist"));
    assert.match(
      await readFile(env.files.summary, "utf8"),
      /\| Security \| changed \|/,
    );

    // 5. The recorded text is the new baseline: the next run is quiet again.
    const fifth = await env.run();
    assert.equal(fifth.output.changes_found, "false");
    assert.equal(fifth.output.baseline_updated, "false");
    assert.equal(fifth.tracker, fourth.tracker);
  } finally {
    await env.cleanup();
    await site.close();
  }
});

test("end to end: a page that fails, is gone, or is not an article is warned about and never reported", async () => {
  const site = await fakeSite();
  const env = await setup(site, { stored: false });
  try {
    const first = await env.run();
    assert.equal(first.code, 0, first.stderr);

    site.state.status["Modern Work"] = 503;
    delete site.state.html["Business Applications"];
    site.state.html.Security =
      "<html><body><h1>Just a moment...</h1></body></html>";
    // Only one page left to read: still a normal run.
    site.state.html.Security = pageHtml("Security", (html) =>
      html.replace("minimum of 70 points", "minimum of 90 points"),
    );
    const partial = await env.run();
    assert.equal(partial.code, 0, partial.stderr);
    assert.equal(
      partial.output.changes_found,
      "true",
      "the readable page still reports its change",
    );
    assert.match(partial.stderr, /could not fetch "Modern Work".*HTTP 503/);
    assert.match(
      partial.stderr,
      /could not fetch "Business Applications".*HTTP 404/,
    );
    const after = JSON.parse(partial.tracker);
    const before = JSON.parse(first.tracker);
    for (const label of ["Modern Work", "Business Applications"]) {
      const kept = after.pages.find((page) => page.label === label);
      assert.deepEqual(
        kept,
        before.pages.find((page) => page.label === label),
        `${label} keeps its record`,
      );
    }
    const summary = await readFile(env.files.summary, "utf8");
    assert.match(summary, /FAILED, kept \| HTTP 503/);

    // A page that answers 200 with something that is not the article keeps its record too.
    delete site.state.status["Modern Work"];
    site.state.html["Modern Work"] =
      "<html><body><main><p>Please verify you are human.</p></main></body></html>";
    site.state.html["Business Applications"] = pageHtml(
      "Business Applications",
    );
    site.state.html.Security = pageHtml("Security", (html) =>
      html.replace("minimum of 70 points", "minimum of 90 points"),
    );
    const unparsed = await env.run();
    assert.equal(unparsed.code, 0, unparsed.stderr);
    assert.equal(unparsed.output.changes_found, "false");
    assert.equal(unparsed.output.baseline_updated, "false");
    assert.match(
      unparsed.stderr,
      /"Modern Work".*not a readable Learn article \(no <div class="content"> block in <main>\)/,
    );
    assert.equal(unparsed.tracker, partial.tracker, "nothing was written");
    assert.match(
      await readFile(env.files.summary, "utf8"),
      /NOT AN ARTICLE, kept/,
    );
  } finally {
    await env.cleanup();
    await site.close();
  }
});

test("end to end: when no page can be read the run fails, writes nothing and says why", async () => {
  const site = await fakeSite();
  const env = await setup(site);
  try {
    const first = await env.run();
    assert.equal(first.code, 0, first.stderr);

    for (const area of AREAS) site.state.status[area] = 500;
    const down = await env.run();
    assert.equal(down.code, 1);
    assert.equal(down.output.extraction_failed, "true");
    assert.equal(down.output.changes_found, "false");
    assert.equal(down.output.baseline_updated, "false");
    assert.equal(down.tracker, first.tracker);
    const error = await readFile(env.files.error, "utf8");
    assert.match(
      error,
      /None of the 3 tracked Partner Center pages could be read/,
    );
    assert.match(error, /HTTP 500/);

    // A layout change that leaves no readable article anywhere fails the same way.
    for (const area of AREAS) {
      delete site.state.status[area];
      site.state.html[area] =
        '<html><body><main><div class="other">New layout</div></main></body></html>';
    }
    const layout = await env.run();
    assert.equal(layout.code, 1);
    assert.equal(layout.output.extraction_failed, "true");
    assert.equal(layout.tracker, first.tracker);
    assert.match(
      await readFile(env.files.error, "utf8"),
      /no <div class="content"> block/,
    );
  } finally {
    await env.cleanup();
    await site.close();
  }
});

test("end to end: FETCH_ATTEMPTS=0 still reads every page, once", async () => {
  const site = await fakeSite();
  const env = await setup(site);
  try {
    const run = await env.run({ FETCH_ATTEMPTS: "0" });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.output.extraction_failed, "false");
    assert.equal(run.output.baseline_updated, "true");
    // Security is tracked through a redirect, so it takes two requests
    assert.equal(site.state.requests.length, AREAS.length + 1);
  } finally {
    await env.cleanup();
    await site.close();
  }
});

test("end to end: a corrupt tracker fails the run without touching it", async () => {
  const site = await fakeSite();
  const env = await setup(site);
  try {
    await writeFile(env.files.tracker, "{ not json");
    const bad = await env.run();
    assert.equal(bad.code, 1);
    assert.equal(bad.output.extraction_failed, "true");
    assert.equal(bad.tracker, "{ not json");
    assert.match(
      await readFile(env.files.error, "utf8"),
      /Corrupt tracker file .*invalid JSON/,
    );

    await writeFile(
      env.files.tracker,
      JSON.stringify({
        pages: [{ url: "https://x.example/a", contentHash: "short" }],
      }),
    );
    const malformed = await env.run();
    assert.equal(malformed.code, 1);
    assert.match(
      await readFile(env.files.error, "utf8"),
      /malformed contentHash/,
    );
  } finally {
    await env.cleanup();
    await site.close();
  }
});

test("end to end: a page that moved is reported with its new location when its text changed", async () => {
  const site = await fakeSite();
  const env = await setup(site, { stored: true });
  try {
    // The first page is tracked under /old/ and redirected to /p/: moved. While
    // its text stays the same that is no alert, only a note in the log and in the
    // job summary.
    const baseline = await env.run();
    assert.match(
      baseline.stderr,
      /NOTE: .*\/old\/Security.* now redirects to .*\/p\/Security/,
    );
    const quiet = await env.run();
    assert.equal(quiet.output.changes_found, "false");
    assert.equal(quiet.output.baseline_updated, "false");
    assert.match(
      quiet.stderr,
      /NOTE: .*\/old\/Security.* now redirects to .*\/p\/Security/,
    );
    assert.match(
      await readFile(env.files.summary, "utf8"),
      /\| Security \| unchanged \| redirects to http:\/\/127\.0\.0\.1:\d+\/p\/Security \|/,
    );

    // A page that did not move changes: its issue has no redirect paragraph.
    site.state.html["Modern Work"] = pageHtml("Modern Work", (html) =>
      html.replace("minimum of 70 points", "minimum of 75 points"),
    );
    const other = await env.run();
    assert.equal(other.output.changes_found, "true");
    assert.ok(
      !(await readFile(env.files.report, "utf8")).includes(
        "The tracked URL now redirects to",
      ),
    );

    // The page that moved changes: its issue says where it lives now.
    site.state.html.Security = pageHtml("Security", (html) =>
      html.replace("minimum of 70 points", "minimum of 75 points"),
    );
    const result = await env.run();
    assert.equal(result.output.changes_found, "true");
    assert.match(
      result.stderr,
      /NOTE: .*\/old\/Security.* now redirects to .*\/p\/Security/,
    );
    assert.match(
      await readFile(env.files.report, "utf8"),
      /The tracked URL now redirects to http:\/\/127\.0\.0\.1:\d+\/p\/Security/,
    );
  } finally {
    await env.cleanup();
    await site.close();
  }
});
