import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BUG_LABEL,
  CheckError,
  FAILED_ISSUE_TITLE,
  FINDINGS_ISSUE_LABEL,
  FINDINGS_ISSUE_TITLE,
  PAGES,
  PAGES_ISSUE_TITLE,
  RETIREMENT_BADGES,
  ROLL_OFF_DAYS,
  SCHEDULE_FORMAT,
  badgeSnippet,
  bannerState,
  buildAnnouncementReport,
  buildFindingsReport,
  buildPagesReport,
  buildRetiredReport,
  classifyHeading,
  computeAnnouncements,
  computeFindings,
  createEventIssue,
  daysBetween,
  dayBefore,
  decodeEntities,
  diffRows,
  diffRowsIgnoringStatus,
  emptySchedule,
  evidenceByCode,
  examNameFromDescription,
  examsContent,
  expectedBadgeText,
  extractMain,
  fence,
  formatLongDate,
  htmlToText,
  isRealIsoDate,
  isRetirementBadge,
  loadConfig,
  loadHubContext,
  loadRetiringExams,
  loadSchedule,
  normalizeSchedule,
  parseLearnDate,
  parseRetirementPage,
  parseTable,
  quoteRow,
  readPage,
  replacementFromPage,
  restructuredReason,
  retryDelayMs,
  rowIdentity,
  run,
  safeText,
  scheduleContent,
  selectReports,
  selectRetired,
  slugCodeMap,
  sortRows,
  storedRow,
  syncFailureIssue,
  syncFindingsIssue,
  syncIssue,
  syncPagesIssue,
  titleWithCodes,
  updateFailures,
} from "../../scripts/retiring-exam-check.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "retiring-exam-check.mjs");
const fixtures = join(root, "tests", "fixtures", "retirement-schedule");
const examsFixture = readFileSync(join(fixtures, "exams-page.html"), "utf8");
const credentialsFixture = readFileSync(
  join(fixtures, "credentials-page.html"),
  "utf8",
);

const EXAMS_PAGE = PAGES.find((p) => p.id === "exams");
const CREDENTIALS_PAGE = PAGES.find((p) => p.id === "credentials");

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Builders for Learn-shaped pages
// ---------------------------------------------------------------------------
const table = (headers, rows) =>
  `<table>\n<thead>\n<tr>\n${headers.map((h) => `<th>${h}</th>`).join("\n")}\n</tr>\n</thead>\n<tbody>\n` +
  rows
    .map(
      (cells) => `<tr>\n${cells.map((c) => `<td>${c}</td>`).join("\n")}\n</tr>`,
    )
    .join("\n") +
  "\n</tbody>\n</table>";

// an empty slug is a name without a link, which Learn does for rows it has no page for
const link = (kind, slug, text) =>
  slug
    ? `<a href="/en-us/credentials/${kind}/${slug}/" data-linktype="absolute-path">${text}</a>`
    : text;

const none = "<p><em>None at this time.</em></p>";

function articlePage(title, body, updated) {
  return (
    `<!DOCTYPE html><html lang="en-us"><head><title>${title} | Microsoft Learn</title>` +
    `<meta name="updated_at" content="${updated}" /></head><body><header><nav>nav</nav></header>` +
    `<main id="main" role="main"><div class="content"><h1>${title}</h1></div>` +
    `<div class="content">${body}</div></main><aside><h2>Additional resources</h2></aside></body></html>`
  );
}

/** rows: exams [code, name, date, slug], skills [name, date, slug] */
function examsPage({
  scheduled = [],
  skills = [],
  retired = [],
  updated = "2026-09-30T20:12:00Z",
} = {}) {
  const examTable = (rows) =>
    rows.length
      ? table(
          ["Exam number", "Exam name", "Retirement date"],
          rows.map(([code, name, date, slug]) => [
            link("certifications", slug, code),
            name,
            date,
          ]),
        )
      : none;
  return articlePage(
    "Exam and assessment lab retirement",
    [
      "<h2>Why exams and assessment labs are retired</h2><p>Technology changes.</p>",
      "<h2>What to expect when an exam or assessment lab is retired</h2><p>Take it before.</p>",
      '<h2 id="exams-scheduled-to-retire">Exams scheduled to retire</h2><p>Listed by date.</p>',
      examTable(scheduled),
      "<h2>Applied Skills assessment labs scheduled to retire</h2>",
      skills.length
        ? table(
            ["Applied Skills name", "Retirement date"],
            skills.map(([name, date, slug]) => [
              link("applied-skills", slug, name),
              date,
            ]),
          )
        : none,
      "<h2>Recently retired exams</h2><p><strong>Role-based</strong></p>",
      examTable(retired),
      "<h2>Recently retired assessment labs</h2>",
      "<!--| Applied Skills name | Retirement date|-->",
    ].join("\n"),
    updated,
  );
}

/** rows: certifications [name, date, slug], skills [name, date, slug] */
function credentialsPage({
  scheduled = [],
  skillsScheduled = [],
  retired = [],
  skillsRetired = [],
  updated = "2026-08-31T19:51:00Z",
} = {}) {
  const certTable = (headers, rows, kind) =>
    rows.length
      ? table(
          headers,
          rows.map(([name, date, slug]) => [link(kind, slug, name), date]),
        )
      : none;
  const cert = ["Certification", "Retirement date"];
  const skill = ["Applied Skills name", "Retirement date"];
  return articlePage(
    "Credential retirement",
    [
      "<h2>Why credentials get retired</h2><p>Technology changes.</p>",
      "<h2>Certifications scheduled to retire</h2>",
      certTable(cert, scheduled, "certifications"),
      "<h2>Applied skills credentials scheduled to retire</h2>",
      certTable(skill, skillsScheduled, "applied-skills"),
      "<h2>Recently retired Certifications</h2><p><strong>Role-based</strong></p>",
      certTable(cert, retired, "certifications"),
      "<h2>Recently retired Applied Skills credentials</h2>",
      certTable(skill, skillsRetired, "applied-skills"),
    ].join("\n"),
    updated,
  );
}

const MS102 = [
  "MS-102",
  "Microsoft 365 Certified: Administrator Expert",
  "November 30, 2026",
  "m365-administrator-expert",
];
const AZ800 = [
  "AZ-800",
  "Microsoft Certified: Windows Server Hybrid Administrator Associate",
  "September 30, 2026",
  "windows-server-hybrid-administrator",
];
const AZ801 = ["AZ-801", AZ800[1], "September 30, 2026", AZ800[3]];
const AI102 = [
  "AI-102",
  "Microsoft Certified: Azure AI Engineer Associate",
  "June 30, 2026",
  "azure-ai-engineer",
];
const AGENT_SKILL = [
  "Microsoft Applied Skills: Create an AI agent",
  "May 28, 2026",
  "create-an-ai-agent",
];
const certRow = ([, name, date, slug]) => [name, date, slug];

const defaultExamsHtml = () =>
  examsPage({
    scheduled: [MS102],
    retired: [AZ800, AZ801, AI102],
    skills: [AGENT_SKILL],
  });
const defaultCredentialsHtml = () =>
  credentialsPage({
    scheduled: [certRow(MS102)],
    retired: [certRow(AZ800), certRow(AI102)],
    skillsRetired: [AGENT_SKILL],
  });

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
test("dates must be real days, counted in whole UTC days", () => {
  for (const good of ["2026-10-31", "2024-02-29"])
    assert.ok(isRealIsoDate(good));
  for (const bad of [
    "2026-02-31",
    "2026-13-01",
    "2026-1-5",
    "soon",
    "",
    null,
  ]) {
    assert.ok(!isRealIsoDate(bad), String(bad));
  }
  assert.equal(daysBetween("2026-10-14", "2026-11-30"), 47);
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 3);
  assert.equal(daysBetween("2026-10-14", "2026-10-12"), -2);
  assert.equal(dayBefore("2026-10-14"), "2026-10-13");
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
  assert.equal(formatLongDate("2026-11-30"), "November 30, 2026");
  assert.equal(formatLongDate("2026-06-01"), "June 1, 2026");
});

test("Learn's date texts parse to one real day, and anything else is null", () => {
  const cases = {
    "November 30, 2026": "2026-11-30",
    "June 01, 2026": "2026-06-01",
    "June 1, 2026": "2026-06-01",
    "Sept 30, 2026": "2026-09-30",
    "Sep. 30, 2026": "2026-09-30",
    "30 November 2026": "2026-11-30",
    "1st March, 2027": "2027-03-01",
    "2026-11-30": "2026-11-30",
    "  December   31, 2026 ": "2026-12-31",
    "December 31, 2026": "2026-12-31",
    "February 29, 2028": "2028-02-29",
  };
  for (const [text, iso] of Object.entries(cases)) {
    assert.equal(parseLearnDate(text), iso, text);
  }
  for (const bad of [
    "To be announced",
    "",
    "Q4 2026",
    "February 30, 2026",
    "February 29, 2026",
    "Smarch 3, 2026",
    "11/30/2026",
    "November 2026",
    "November 30",
    null,
    undefined,
  ]) {
    assert.equal(parseLearnDate(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------------------
// HTML and the retirement tables
// ---------------------------------------------------------------------------
test("html text: tags go, entities decode, invisible characters and wraps disappear", () => {
  assert.equal(
    htmlToText(
      '<td> <a href="/x">Azure&nbsp;Arc&ndash;enabled</a>&shy; <b>serv​ers</b>\n  &amp; more<br>next </td>',
    ),
    "Azure Arc–enabled servers & more next",
  );
  // an encoded tag stays text and never becomes markup
  assert.equal(
    htmlToText("&lt;script&gt;x&lt;/script&gt;"),
    "<script>x</script>",
  );
  assert.equal(
    decodeEntities("&#x41;&#66;&bogus;&constructor;"),
    "AB&bogus;&constructor;",
  );
  assert.equal(decodeEntities("&#0;&#1114112;"), "");
});

test("extractMain returns the article only, without comments and scripts", () => {
  const html =
    '<html><nav>menu</nav><main id="m"><!-- <h2>Recently retired exams</h2> --><script>var x="<main>";</script><p>body</p></main><footer>f</footer>';
  assert.equal(extractMain(html).trim(), "<p>body</p>");
  assert.equal(extractMain("<html><body>no article</body></html>"), null);
});

test("headings introduce a table only in the shapes Learn uses", () => {
  const yes = {
    "Exams scheduled to retire": ["exam", "scheduled"],
    "Recently retired exams": ["exam", "retired"],
    "Applied Skills assessment labs scheduled to retire": [
      "applied-skill",
      "scheduled",
    ],
    "Recently retired assessment labs": ["applied-skill", "retired"],
    "Certifications scheduled to retire": ["certification", "scheduled"],
    "Applied skills credentials scheduled to retire": [
      "applied-skill",
      "scheduled",
    ],
    "Recently retired Certifications": ["certification", "retired"],
    "Recently retired Applied Skills credentials": ["applied-skill", "retired"],
    "  Exams   Scheduled to  Retire ": ["exam", "scheduled"],
  };
  for (const [text, [kind, status]] of Object.entries(yes)) {
    assert.deepEqual(classifyHeading(text), { kind, status }, text);
  }
  for (const text of [
    "Why exams and assessment labs are retired",
    "What to expect when an exam or assessment lab is retired",
    "Why credentials get retired",
    "Exam and assessment lab retirement",
    "Credential retirement",
    "Additional resources",
    "In this article",
    "",
  ]) {
    assert.equal(classifyHeading(text), null, text);
  }
});

test("a table is read with its link, its multi-cell rows and row headers", () => {
  const parsed = parseTable(
    "<table><tr><th>Exam number</th><th>Exam name</th><th>Retirement date</th></tr>" +
      '<tr><th scope="row"><a href="/en-us/credentials/certifications/x/">AZ-800</a></th><td>A &amp; B</td><td>June 01, 2026</td></tr>' +
      "<tr></tr></table>",
  );
  assert.deepEqual(parsed.headers, [
    "Exam number",
    "Exam name",
    "Retirement date",
  ]);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(
    parsed.rows[0].map((c) => c.text),
    ["AZ-800", "A & B", "June 01, 2026"],
  );
  assert.equal(parsed.rows[0][0].href, "/en-us/credentials/certifications/x/");
});

test("the realistic exams page (trimmed from Learn) parses to the rows the page shows", () => {
  const out = parseRetirementPage(examsFixture, EXAMS_PAGE);
  assert.deepEqual(out.fatal, []);
  assert.deepEqual(out.problems, []);
  assert.equal(out.updatedAt, "2026-09-30T20:12:00Z");
  const count = (kind, status) =>
    out.rows.filter((r) => r.kind === kind && r.status === status).length;
  assert.equal(count("exam", "scheduled"), 1);
  assert.equal(count("applied-skill", "scheduled"), 3);
  assert.equal(count("exam", "retired"), 6);
  assert.equal(count("applied-skill", "retired"), 0);
  assert.equal(out.rows.length, 10);

  const ms102 = out.rows.find((r) => r.code === "MS-102");
  assert.deepEqual(
    {
      kind: ms102.kind,
      status: ms102.status,
      slug: ms102.slug,
      name: ms102.name,
      date: ms102.date,
    },
    {
      kind: "exam",
      status: "scheduled",
      slug: "m365-administrator-expert",
      name: "Microsoft 365 Certified: Administrator Expert",
      date: "2026-11-30",
    },
  );
  // the same certification slug backs both Windows Server exams
  const az = out.rows.filter((r) => /^AZ-80[01]$/.test(r.code));
  assert.deepEqual(
    az.map((r) => r.slug),
    [
      "windows-server-hybrid-administrator",
      "windows-server-hybrid-administrator",
    ],
  );
  assert.ok(az.every((r) => r.date === "2026-09-30"));
  // a zero-padded day and an Applied Skills row
  assert.equal(out.rows.find((r) => r.code === "AI-102").date, "2026-06-30");
  const skill = out.rows.find((r) => r.slug === "create-an-ai-agent");
  assert.equal(skill.kind, "applied-skill");
  assert.equal(skill.date, "2026-05-28");
  assert.equal(skill.name, "Microsoft Applied Skills: Create an AI agent");
  // nothing from the commented-out "retired more than 12 months ago" block
  assert.ok(!out.rows.some((r) => /12 months/.test(r.name)));
});

test("the realistic credentials page parses to certifications and Applied Skills", () => {
  const out = parseRetirementPage(credentialsFixture, CREDENTIALS_PAGE);
  assert.deepEqual(out.fatal, []);
  assert.deepEqual(out.problems, []);
  const certs = out.rows.filter((r) => r.kind === "certification");
  assert.equal(certs.filter((r) => r.status === "scheduled").length, 1);
  assert.equal(certs.filter((r) => r.status === "retired").length, 4);
  assert.equal(out.rows.filter((r) => r.kind === "applied-skill").length, 3);
  assert.equal(certs[0].code, null);
  assert.equal(certs[0].slug, "m365-administrator-expert");
  assert.equal(certs[0].date, "2026-11-30");
  const aspire = out.rows.find(
    (r) => r.slug === "build-distributed-apps-with-dotnet-aspire",
  );
  assert.equal(aspire.date, "2025-04-30");
});

test("a commented-out table is never read, a live empty section is fine", () => {
  const html = articlePage(
    "Credential retirement",
    [
      "<h2>Certifications scheduled to retire</h2>",
      "<!-- <table><tr><th>Certification</th><th>Retirement date</th></tr><tr><td>Ghost</td><td>May 1, 2026</td></tr></table> -->",
      "<p><em>None at this time.</em></p>",
      "<h2>Recently retired Certifications</h2>",
      table(["Certification", "Retirement date"], [["Real", "May 2, 2026"]]),
    ].join("\n"),
    "2026-01-01T00:00:00Z",
  );
  const out = parseRetirementPage(html, CREDENTIALS_PAGE);
  assert.deepEqual(out.fatal, []);
  assert.deepEqual(
    out.rows.map((r) => [r.status, r.name]),
    [["retired", "Real"]],
  );
});

test("a page that is not an article, or lacks a required section, is fatal, not empty", () => {
  const bot = parseRetirementPage(
    "<html><body><h1>Verify you are human</h1></body></html>",
    EXAMS_PAGE,
  );
  assert.match(bot.fatal.join(), /no <main> article/);

  const renamed = parseRetirementPage(
    articlePage(
      "Exam and assessment lab retirement",
      "<h2>Upcoming exam changes</h2>" +
        table(
          ["Exam number", "Exam name", "Retirement date"],
          [["AZ-1", "x", "May 1, 2026"]],
        ) +
        "<h2>Recently retired exams</h2>" +
        none,
      "",
    ),
    EXAMS_PAGE,
  );
  assert.match(
    renamed.fatal.join(),
    /"Exams scheduled to retire" was not found/,
  );
  // the table under the unknown heading is flagged, not silently dropped
  assert.match(renamed.problems.join(), /sits under "Upcoming exam changes"/);
});

test("what cannot be read is reported while the rest is still read", () => {
  const html = articlePage(
    "Exam and assessment lab retirement",
    [
      "<h2>Exams scheduled to retire</h2>",
      table(
        ["Exam number", "Exam name", "Retirement date"],
        [
          [
            link("certifications", "a", "AZ-800, AZ-801"),
            "Two at once",
            "May 1, 2026",
          ],
          [
            link("certifications", "b", "MB-310"),
            "Open date",
            "To be announced",
          ],
          [link("certifications", "c", "70-740"), "Legacy", "March 3, 2027"],
          ["short row"],
        ],
      ),
      "<h2>Recently retired exams</h2>",
      table(["Exam number", "Exam name", "Gone"], [["x", "y", "z"]]),
    ].join("\n"),
    "",
  );
  const out = parseRetirementPage(html, EXAMS_PAGE);
  assert.deepEqual(out.fatal, []);
  assert.deepEqual(
    out.rows.map((r) => [r.code, r.date]),
    [
      ["AZ-800", "2026-05-01"],
      ["AZ-801", "2026-05-01"],
      ["MB-310", null],
      ["70-740", "2027-03-03"],
    ],
  );
  const text = out.problems.join("\n");
  assert.match(
    text,
    /"Open date" in "Exams scheduled to retire" has a date that is not one calendar day: "To be announced"/,
  );
  assert.match(text, /has 1 cells, expected 3/);
  assert.match(
    text,
    /has no retirement date column \(headers: Exam number \| Exam name \| Gone\)/,
  );
});

test("a table whose column order changed is still read by its headers", () => {
  const html = articlePage(
    "Credential retirement",
    [
      "<h2>Certifications scheduled to retire</h2>",
      table(
        ["Retirement date", "Certification"],
        [["March 31, 2027", link("certifications", "slug-x", "Cert X")]],
      ),
      "<h2>Recently retired Certifications</h2>",
      none,
    ].join("\n"),
    "",
  );
  const out = parseRetirementPage(html, CREDENTIALS_PAGE);
  assert.deepEqual(out.fatal, []);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].name, "Cert X");
  assert.equal(out.rows[0].date, "2027-03-31");
  assert.equal(out.rows[0].slug, "slug-x");
});

// ---------------------------------------------------------------------------
// Rows: storage, order, differences, failsafe
// ---------------------------------------------------------------------------
const R = (over = {}) => ({
  source: "exams",
  kind: "exam",
  status: "scheduled",
  code: "MS-102",
  slug: "s",
  name: "N",
  date: "2026-11-30",
  ...over,
});

test("a stored row keeps only what is needed, in a fixed key order", () => {
  assert.deepEqual(
    Object.keys(storedRow("exams", { ...R(), dateText: "November 30, 2026" })),
    ["source", "kind", "status", "code", "slug", "name", "date"],
  );
  assert.deepEqual(
    storedRow("credentials", {
      kind: "certification",
      status: "retired",
      code: null,
      slug: "",
      name: "X",
      date: null,
      dateText: "TBD",
    }),
    {
      source: "credentials",
      kind: "certification",
      status: "retired",
      name: "X",
      date: null,
      dateText: "TBD",
    },
  );
});

test("the order of Learn's rows never changes the stored file", () => {
  const rows = [
    R({ code: "MS-102" }),
    R({ code: "AZ-800", status: "retired", date: "2026-09-30" }),
    R({ code: "AZ-801", status: "retired", date: "2026-09-30" }),
    R({
      source: "credentials",
      kind: "certification",
      code: undefined,
      slug: "z",
      name: "Z",
    }),
    R({
      kind: "applied-skill",
      code: undefined,
      slug: "k",
      name: "K",
      status: "retired",
      date: "2026-01-01",
    }),
  ].map((r) => storedRow(r.source, r));
  const a = JSON.stringify(sortRows(rows));
  const b = JSON.stringify(sortRows([...rows].reverse()));
  assert.equal(a, b);
  assert.deepEqual(
    sortRows(rows).map((r) => `${r.source}:${r.kind}:${r.status}`),
    [
      "credentials:certification:scheduled",
      "exams:exam:scheduled",
      "exams:exam:retired",
      "exams:exam:retired",
      "exams:applied-skill:retired",
    ],
  );
});

test("row identity survives a date or display-name change, not a code change", () => {
  assert.equal(
    rowIdentity(R()),
    rowIdentity(R({ date: "2027-01-01", name: "Other" })),
  );
  assert.notEqual(rowIdentity(R()), rowIdentity(R({ code: "MS-100" })));
  assert.notEqual(rowIdentity(R()), rowIdentity(R({ status: "retired" })));
  assert.notEqual(rowIdentity(R()), rowIdentity(R({ source: "credentials" })));
  // without a code the slug, then the normalised name, identify the row
  const bare = {
    source: "credentials",
    kind: "certification",
    status: "retired",
  };
  assert.equal(
    rowIdentity({ ...bare, slug: "a", name: "x" }),
    rowIdentity({ ...bare, slug: "a", name: "y" }),
  );
  assert.equal(
    rowIdentity({ ...bare, name: "Azure  AI!" }),
    rowIdentity({ ...bare, name: "azure ai" }),
  );
});

test("diffRows reports added, removed and re-dated rows", () => {
  const before = [
    R({ code: "A-1" }),
    R({ code: "B-2" }),
    R({ code: "C-3", date: "2026-12-01" }),
  ].map((r) => storedRow("exams", r));
  const after = [
    R({ code: "B-2" }),
    R({ code: "C-3", date: "2026-12-15" }),
    R({ code: "D-4" }),
  ].map((r) => storedRow("exams", r));
  const diff = diffRows(before, after);
  assert.deepEqual(
    diff.added.map((r) => r.code),
    ["D-4"],
  );
  assert.deepEqual(
    diff.removed.map((r) => r.code),
    ["A-1"],
  );
  assert.deepEqual(
    diff.changed.map((c) => [c.before.date, c.after.date]),
    [["2026-12-01", "2026-12-15"]],
  );
});

test("a row without a code or a link has one identity, parsed or read back from the file", () => {
  // what the parser makes of a name cell that has no link: no code and an empty address
  const parsed = {
    source: "credentials",
    kind: "certification",
    status: "scheduled",
    code: null,
    slug: "",
    name: "Microsoft Certified: Linkless Expert",
    date: "2027-03-31",
    dateText: "March 31, 2027",
  };
  const stored = storedRow("credentials", parsed);
  assert.equal(rowIdentity(parsed), rowIdentity(stored));
  assert.equal(
    rowIdentity(parsed),
    "credentials|certification|scheduled|microsoft certified linkless expert",
  );
  // two such rows are two rows: they never collapse into one identity
  const other = { ...parsed, name: "Microsoft Certified: Other Expert" };
  assert.notEqual(rowIdentity(parsed), rowIdentity(other));
  // and a parsed row is never new against its own stored copy
  assert.deepEqual(
    diffRows([stored, storedRow("credentials", other)], [parsed, other]),
    { added: [], removed: [], changed: [] },
  );
  // an empty code or address is none, in either shape
  const bare = {
    source: "credentials",
    kind: "certification",
    status: "scheduled",
    name: "X Cert",
  };
  for (const empty of [
    { code: "" },
    { code: null },
    { slug: "" },
    { slug: null },
    { code: "", slug: "" },
  ]) {
    assert.equal(
      rowIdentity({ ...bare, ...empty }),
      rowIdentity(bare),
      JSON.stringify(empty),
    );
  }
});

test("diffRowsIgnoringStatus: moving between the two tables is no addition and no removal", () => {
  const before = [
    R({ code: "A-1" }),
    R({ code: "B-2" }),
    R({ code: "C-3", date: "2026-12-01" }),
    R({ code: "D-4" }),
  ].map((r) => storedRow("exams", r));
  const after = [
    R({ code: "A-1", status: "retired" }), // moved, same date: nothing
    R({ code: "B-2", status: "retired", date: "2026-12-15" }), // moved and re-dated: one change
    R({ code: "C-3", date: "2026-12-15" }), // re-dated in place: one change
    R({ code: "E-5" }), // new
  ].map((r) => storedRow("exams", r));
  const diff = diffRowsIgnoringStatus(before, after);
  assert.deepEqual(
    diff.added.map((r) => r.code),
    ["E-5"],
  );
  assert.deepEqual(
    diff.removed.map((r) => r.code),
    ["D-4"],
  );
  assert.deepEqual(
    diff.changed.map((c) => `${c.after.code}:${c.after.status}`),
    ["C-3:scheduled", "B-2:retired"],
  );
  // diffRows itself keeps telling the two apart: a new "scheduled" row is what is announced
  const plain = diffRows(before, after);
  assert.deepEqual(plain.added.map((r) => r.code).sort(), [
    "A-1",
    "B-2",
    "E-5",
  ]);
  assert.deepEqual(plain.removed.map((r) => r.code).sort(), [
    "A-1",
    "B-2",
    "D-4",
  ]);
  // the same subject in another source or kind is another row
  const elsewhere = diffRowsIgnoringStatus(
    [storedRow("exams", R({ code: "A-1" }))],
    [storedRow("credentials", R({ code: "A-1", status: "retired" }))],
  );
  assert.deepEqual(
    [
      elsewhere.added.length,
      elsewhere.removed.length,
      elsewhere.changed.length,
    ],
    [1, 1, 0],
  );
});

test("the failsafe stops a restructured page, not a normal batch of news", () => {
  // the rows are dated 2026-11-30: the day is injected, because with the real clock
  // they would count as rolled off from 2027-12-02 on and the failsafe would see nothing
  const cfg = loadConfig({ TODAY: "2026-10-14" });
  const many = (n, prefix = "X") =>
    Array.from({ length: n }, (_, i) =>
      storedRow("exams", R({ code: `${prefix}-${100 + i}` })),
    );
  // nothing to compare with
  assert.equal(restructuredReason([], many(50), cfg), null);
  // a handful of new announcements and roll-offs
  assert.equal(
    restructuredReason(many(40), [...many(40).slice(5), ...many(8, "N")], cfg),
    null,
  );
  // every row replaced at once: the identity of the rows changed shape
  assert.match(
    restructuredReason(many(40), many(40, "Y"), cfg),
    /40 of its 40 current rows disappeared at once and 40 new ones appeared/,
  );
  // many re-dated rows (no row gone) are the other shape of the same failsafe
  const redated = (date) =>
    Array.from({ length: 30 }, (_, i) =>
      storedRow("exams", R({ code: `X-${100 + i}`, date })),
    );
  assert.match(
    restructuredReason(redated("2026-12-01"), redated("2026-12-15"), cfg),
    /30 of its 30 rows changed at once \(more than 20 and 50%\)/,
  );
  // a table that vanished, even when the count of changes stays under the limit
  assert.match(
    restructuredReason(many(40), many(10), cfg),
    /30 of its 40 current rows disappeared at once/,
  );
  assert.match(
    restructuredReason(many(12), many(5), cfg),
    /7 of its 12 current rows disappeared at once/,
  );
  // a small page can lose most of its rows without being a failsafe case
  assert.equal(restructuredReason(many(6), many(1), cfg), null);
  // the limits are configurable
  const strict = loadConfig({
    TODAY: "2026-10-14",
    MAX_ROW_CHANGES: "3",
    MAX_ROW_CHANGE_PCT: "10",
  });
  assert.match(
    restructuredReason(
      many(40),
      [...many(40).slice(2), ...many(3, "N")],
      strict,
    ),
    /changed at once/,
  );
});

test("the failsafe ignores rows Learn drops after 12 months, and still sees the rest", () => {
  const cfg = loadConfig({ TODAY: "2026-10-14" });
  const old = (n) =>
    Array.from({ length: n }, (_, i) =>
      storedRow(
        "exams",
        R({ code: `OLD-${100 + i}`, status: "retired", date: "2025-04-30" }),
      ),
    );
  const recent = (n) =>
    Array.from({ length: n }, (_, i) =>
      storedRow(
        "exams",
        R({ code: `NEW-${100 + i}`, status: "retired", date: "2026-06-30" }),
      ),
    );
  // the exams page really lists 21 Applied Skills from 2025: deleting them all is housekeeping
  assert.equal(
    restructuredReason([...old(25), ...recent(13)], recent(13), cfg),
    null,
  );
  // but the same number of recent rows vanishing is a page that changed shape
  assert.match(
    restructuredReason([...old(2), ...recent(25)], old(2), cfg),
    /25 of its 25 current rows disappeared/,
  );
  // the cut is more than 366 days: 366 days old is still current, 367 has rolled off
  const dated = (date) =>
    Array.from({ length: 12 }, (_, i) =>
      storedRow("exams", R({ code: `D-${100 + i}`, status: "retired", date })),
    );
  assert.match(
    restructuredReason(dated("2025-10-13"), [], cfg),
    /12 of its 12 current rows disappeared/,
  );
  assert.equal(restructuredReason(dated("2025-10-12"), [], cfg), null);
  // nothing current left to compare with
  assert.equal(restructuredReason(old(40), [], cfg), null);
  assert.equal(ROLL_OFF_DAYS, 366);
});

test("the failsafe ignores exams moving from scheduled to retired, however many on one day, and still sees a restructured page", () => {
  const cfg = loadConfig({ TODAY: "2026-10-14" });
  // the exams page as it really is: 21 Applied Skills from 2025 (rolled off) and 17 current rows
  const rolledOff = Array.from({ length: 21 }, (_, i) =>
    storedRow(
      "exams",
      R({
        kind: "applied-skill",
        code: undefined,
        slug: `skill-${i}`,
        name: `Skill ${i}`,
        status: "retired",
        date: "2025-04-30",
      }),
    ),
  );
  const current = (prefix = "CUR") =>
    Array.from({ length: 17 }, (_, i) =>
      storedRow(
        "exams",
        R({
          code: `${prefix}-${100 + i}`,
          status: "retired",
          date: "2026-06-30",
        }),
      ),
    );
  const exams = (n, status, date = "2026-10-13") =>
    Array.from({ length: n }, (_, i) =>
      storedRow("exams", R({ code: `MOV-${100 + i}`, status, date })),
    );
  // 10 moves were quiet before, 11 and more tripped it: "22 of its 28 rows changed at once"
  for (const n of [10, 11, 25, 60]) {
    assert.equal(
      restructuredReason(
        [...rolledOff, ...current(), ...exams(n, "scheduled")],
        [...rolledOff, ...current(), ...exams(n, "retired")],
        cfg,
      ),
      null,
      `${n} exams moved to retired on one day`,
    );
  }
  // a move that changes the date as well is one change, so many of them are a changed page
  assert.match(
    restructuredReason(
      [...rolledOff, ...current(), ...exams(25, "scheduled")],
      [...rolledOff, ...current(), ...exams(25, "retired", "2026-11-30")],
      cfg,
    ),
    /^25 of its 42 rows changed at once \(more than 20 and 50%\)$/,
  );
  // rows replaced at once still trip it, whatever moves along with them
  assert.match(
    restructuredReason(
      [...rolledOff, ...current(), ...exams(11, "scheduled")],
      [...rolledOff, ...current("NEW"), ...exams(11, "retired")],
      cfg,
    ),
    /^17 of its 28 current rows disappeared at once and 17 new ones appeared$/,
  );
  // and rows that vanish without being listed as retired are still removals
  assert.match(
    restructuredReason(
      [...rolledOff, ...current(), ...exams(25, "scheduled")],
      [...rolledOff, ...current()],
      cfg,
    ),
    /^25 of its 42 current rows disappeared at once$/,
  );
});

// ---------------------------------------------------------------------------
// Trackers
// ---------------------------------------------------------------------------
test("the schedule tracker: missing is the first run, anything malformed is an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retire-schedule-"));
  tempDirs.push(dir);
  const file = join(dir, "s.json");
  const first = loadSchedule(file);
  assert.equal(first.existed, false);
  assert.deepEqual(first.schedule, emptySchedule());

  const good = {
    lastSynced: "2026-10-14",
    format: SCHEDULE_FORMAT,
    failures: { exams: { runs: 2, since: "2026-10-12", last: "2026-10-13" } },
    reported: {
      "exam:MS-102:untracked": {
        signature: "s",
        firstReported: "2026-10-01",
        lastReported: "2026-10-08",
      },
    },
    rows: [storedRow("exams", R())],
  };
  await writeFile(file, JSON.stringify(good));
  const loaded = loadSchedule(file);
  assert.equal(loaded.existed, true);
  assert.deepEqual(loaded.schedule.failures, good.failures);
  assert.equal(scheduleContent(loaded.schedule), scheduleContent(good));

  await writeFile(file, "{not json");
  assert.throws(() => loadSchedule(file), /invalid JSON/);
  for (const bad of [
    "[]",
    "{}",
    '{"rows":[{"source":"nope","kind":"exam","status":"retired","name":"x","date":null}]}',
    '{"rows":[{"source":"exams","kind":"exam","status":"retired","name":"x","date":"2026-02-31"}]}',
    '{"rows":[],"failures":{"exams":{"runs":0,"since":"2026-10-01","last":"2026-10-01"}}}',
    '{"rows":[],"reported":{"k":{"signature":1}}}',
  ]) {
    assert.throws(() => normalizeSchedule(JSON.parse(bad)), CheckError, bad);
  }
});

test("the schedule tracker has a format: the current one is written, a missing or foreign one reads as another", () => {
  assert.equal(SCHEDULE_FORMAT, 1);
  assert.equal(emptySchedule().format, SCHEDULE_FORMAT);
  const rows = [storedRow("exams", R())];
  assert.equal(normalizeSchedule({ rows, format: SCHEDULE_FORMAT }).format, 1);
  assert.equal(normalizeSchedule({ rows, format: 7 }).format, 7);
  // an older file has no format; a malformed one is none either (0 is nothing this script wrote)
  for (const format of [undefined, null, "1", 1.5, {}]) {
    assert.equal(normalizeSchedule({ rows, format }).format, 0, String(format));
  }
  // it is written right after lastSynced and never dropped
  const written = JSON.parse(scheduleContent(emptySchedule()));
  assert.deepEqual(Object.keys(written), [
    "lastSynced",
    "format",
    "failures",
    "reported",
    "rows",
  ]);
  assert.equal(written.format, SCHEDULE_FORMAT);
});

test("retiring-exams.json is validated, so a typo can never silence a notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retire-exams-"));
  tempDirs.push(dir);
  const file = join(dir, "r.json");
  assert.throws(() => loadRetiringExams(file), /Tracker file not found/);
  const write = (value) =>
    writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  await write("{nope");
  assert.throws(
    () => loadRetiringExams(file),
    /Corrupt tracker file.*invalid JSON/,
  );
  await write({ nothing: true });
  assert.throws(() => loadRetiringExams(file), /missing exams array/);
  await write({ exams: [{ code: "oops", retirementDate: "2026-11-30" }] });
  assert.throws(
    () => loadRetiringExams(file),
    /entry 0 has no valid exam code/,
  );
  await write({ exams: [{ code: "MS-102", retirementDate: "2026-02-31" }] });
  assert.throws(
    () => loadRetiringExams(file),
    /MS-102 has retirementDate "2026-02-31".*never notify/,
  );
  await write({
    exams: [{ code: "MS-102", retirementDate: "November 30, 2026" }],
  });
  assert.throws(() => loadRetiringExams(file), /not a real YYYY-MM-DD day/);
  await write({
    exams: [
      { code: "MS-102", retirementDate: "2026-11-30" },
      { code: "MS-102", retirementDate: "2026-11-30" },
    ],
  });
  assert.throws(() => loadRetiringExams(file), /MS-102 is listed twice/);
  await write({ exams: [{ code: "MS-102", retirementDate: "2026-11-30" }] });
  assert.equal(loadRetiringExams(file).exams.length, 1);
});

test("the committed retiring-exams.json is valid for the monitor and is written back unchanged", () => {
  const file = join(root, "src", "data_files", "retiring-exams.json");
  const tracker = loadRetiringExams(file);
  assert.ok(tracker.exams.length > 0);
  // a quiet run must not rewrite (and so never commit) the hand-kept list
  assert.equal(
    examsContent(tracker),
    readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
  );
});

test("entries are written in one key order, whatever order the script added keys in", () => {
  const entry = {
    notifiedAt: "2026-12-01",
    notified: true,
    retirementDate: "2026-11-30",
    code: "MS-102",
    extra: 1,
  };
  const text = examsContent({ lastSynced: "x", exams: [entry] });
  assert.deepEqual(Object.keys(JSON.parse(text).exams[0]), [
    "code",
    "retirementDate",
    "notified",
    "notifiedAt",
    "extra",
  ]);
  assert.ok(text.startsWith('{\n  "lastSynced": "x",'));
  assert.ok(text.endsWith("}\n"));
});

// ---------------------------------------------------------------------------
// The notification after the date
// ---------------------------------------------------------------------------
const E = (over = {}) => ({
  code: "MS-102",
  area: "microsoft365",
  name: "Microsoft 365 Administrator",
  retirementDate: "2026-11-30",
  replacementCode: "AB-650",
  notified: false,
  ...over,
});

test("the notification after the date keeps the old cut-off: yesterday or earlier", () => {
  const exams = [
    E({ code: "A-1", retirementDate: "2026-10-13" }),
    E({ code: "B-2", retirementDate: "2026-10-14" }),
    E({
      code: "C-3",
      retirementDate: "2026-09-30",
      notified: true,
      notifiedAt: "2026-10-01",
    }),
    E({ code: "D-4", retirementDate: "2026-01-01" }),
  ];
  const out = selectRetired(exams, "2026-10-14");
  assert.deepEqual(
    out.retired.map((e) => e.code),
    ["A-1", "D-4"],
  );
  assert.ok(
    out.retired.every(
      (e) => e.notified === true && e.notifiedAt === "2026-10-14",
    ),
  );
  // the day itself is not retired yet
  assert.equal(out.exams.find((e) => e.code === "B-2").notified, false);
  // an already notified entry is not touched
  assert.equal(
    out.exams.find((e) => e.code === "C-3").notifiedAt,
    "2026-10-01",
  );
});

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------
const examMdx = (code, name, body = "") =>
  `---\ntitle: ${code} Study Materials\ndescription: "Collection of study materials for the certification exam ${code}: ${name}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses."\n---\nimport { Card } from '@components/docs';\n${body}\n<Card title="Get Started" icon="star">\n</Card>\n`;

const CAUTION_102 =
  ":::caution\nExam and its certification are being retired.\n\nUPDATE: Microsoft pushed the retirement date to November 30, 2026.\n\nIt will be replaced by [AB-650: Administering Microsoft 365 and AI Services](/certs/aibusiness/ab-650/).\n:::\n";
const BANNER_800 =
  'import RetirementBanner from \'../../../components/RetirementBanner.astro\';\n\n<RetirementBanner\n  retireDate="September 30, 2026"\n  certRetires={false}\n  replacementCode="AZ-802"\n/>\n';

async function makeRepo({
  exams = {
    "microsoft365/MS-102": ["Microsoft 365 Administrator", CAUTION_102],
    "azure/AZ-800": [
      "Administering Windows Server Hybrid Core Infrastructure",
      BANNER_800,
    ],
    "azure/AZ-801": [
      "Configuring Windows Server Hybrid Advanced Services",
      BANNER_800,
    ],
    "aibusiness/AB-650": ["Administering Microsoft 365 and AI Services", ""],
    "azure/AZ-104": [
      "Microsoft Azure Administrator",
      "[cert](https://learn.microsoft.com/credentials/certifications/azure-administrator?WT.mc_id=studentamb_165290)\n",
    ],
  },
  statuses = {
    azure: {
      "AZ-800": { text: "RETIRING", variant: "danger" },
      "AZ-801": { text: "RETIRING", variant: "danger" },
    },
    microsoft365: { "MS-102": { text: "RETIRING", variant: "danger" } },
    aibusiness: { "AB-650": { text: "BETA", variant: "tip" } },
  },
  retiring = [
    E({
      code: "AZ-800",
      area: "azure",
      name: "Administering Windows Server Hybrid Core Infrastructure",
      retirementDate: "2026-09-30",
      replacementCode: "AZ-802",
      notified: true,
      notifiedAt: "2026-10-01",
    }),
    E({
      code: "AZ-801",
      area: "azure",
      name: "Configuring Windows Server Hybrid Advanced Services",
      retirementDate: "2026-09-30",
      replacementCode: "AZ-802",
      notified: true,
      notifiedAt: "2026-10-01",
    }),
    E(),
  ],
  schedule = null,
  labs = {},
  learnExams = null,
  drafts = [],
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "retire-repo-"));
  tempDirs.push(dir);
  const docs = join(dir, "docs");
  for (const [path, [name, body]] of Object.entries(exams)) {
    const [area, code] = path.split("/");
    await mkdir(join(docs, area), { recursive: true });
    let text = examMdx(code, name, body);
    if (drafts.includes(code))
      text = text.replace("---\ntitle", "---\ndraft: true\ntitle");
    await writeFile(join(docs, area, `${code}.mdx`), text);
  }
  for (const [path, text] of Object.entries(labs)) {
    await mkdir(join(docs, "labs", path.split("/")[0]), { recursive: true });
    await writeFile(join(docs, "labs", `${path}.mdx`), text);
  }
  await writeFile(
    join(dir, "exam-status.mjs"),
    `export const examStatuses = ${JSON.stringify(statuses)};\n`,
  );
  await writeFile(
    join(dir, "retiring-exams.json"),
    JSON.stringify({ lastSynced: "2026-09-16", exams: retiring }, null, 2) +
      "\n",
  );
  if (schedule !== null)
    await writeFile(
      join(dir, "retirement-schedule.json"),
      typeof schedule === "string" ? schedule : scheduleContent(schedule),
    );
  if (learnExams)
    await writeFile(join(dir, "learn-exams.json"), JSON.stringify(learnExams));
  const env = {
    DOCS_DIR: docs,
    EXAMS_FILE: join(dir, "retiring-exams.json"),
    SCHEDULE_FILE: join(dir, "retirement-schedule.json"),
    EXAM_STATUS_FILE: join(dir, "exam-status.mjs"),
    LEARN_EXAMS_FILE: join(dir, "learn-exams.json"),
    REPORT_FILE: join(dir, "report.md"),
    ERROR_FILE: join(dir, "error.md"),
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    FETCH_DELAY_MS: "0",
    RETRY_BASE_MS: "1",
    FETCH_ATTEMPTS: "2",
  };
  return {
    dir,
    env,
    cfg: (extra = {}) => loadConfig({ ...env, ...extra }),
    schedule: () =>
      existsSync(env.SCHEDULE_FILE)
        ? readFileSync(env.SCHEDULE_FILE, "utf8")
        : null,
    exams: () => readFileSync(env.EXAMS_FILE, "utf8"),
    setSchedule: (text) => writeFile(env.SCHEDULE_FILE, text),
    setExams: (list) =>
      writeFile(
        env.EXAMS_FILE,
        JSON.stringify({ lastSynced: "2026-09-16", exams: list }, null, 2) +
          "\n",
      ),
  };
}

test("the exam name comes from the standard description, banners and replacements from the page", () => {
  const text = examMdx("AZ-104", "Microsoft Azure Administrator");
  assert.equal(
    examNameFromDescription(text, "AZ-104"),
    "Microsoft Azure Administrator",
  );
  assert.equal(examNameFromDescription(text, "AZ-900"), "");
  // a period inside the name does not cut it short
  assert.equal(
    examNameFromDescription(
      examMdx("AB-1", "Cloud Admin v2.0 for Teams"),
      "AB-1",
    ),
    "Cloud Admin v2.0 for Teams",
  );
  assert.equal(replacementFromPage(BANNER_800), "AZ-802");
  assert.equal(replacementFromPage(CAUTION_102), "AB-650");
  assert.equal(replacementFromPage("{/* replaced by [AB-1](/x) */}"), "");
  assert.equal(replacementFromPage("nothing here"), "");
});

test("the banner check: component or caution box, the date, and comments never count", () => {
  assert.deepEqual(bannerState(CAUTION_102, "2026-11-30"), {
    present: true,
    mentionsDate: true,
  });
  assert.deepEqual(bannerState(CAUTION_102, "2026-12-31"), {
    present: true,
    mentionsDate: false,
  });
  assert.deepEqual(bannerState(BANNER_800, "2026-09-30"), {
    present: true,
    mentionsDate: true,
  });
  assert.deepEqual(bannerState("plain page\n", "2026-09-30"), {
    present: false,
    mentionsDate: null,
  });
  // a caution box that is not about a retirement is not a retirement banner
  assert.equal(
    bannerState(":::caution\nBeta exam.\n:::\n", "2026-09-30").present,
    false,
  );
  // a commented-out banner is not a banner
  assert.equal(
    bannerState(
      '{/* <RetirementBanner retireDate="x" /> */}\n<!-- <RetirementBanner /> -->',
      "2026-09-30",
    ).present,
    false,
  );
  // the padded day form Learn uses matches too
  assert.equal(
    bannerState(":::caution\nRetires June 01, 2026.\n:::\n", "2026-06-01")
      .mentionsDate,
    true,
  );
});

test("the hub context: pages, badges, lab skills, certification links, drafts and comments", async () => {
  const repo = await makeRepo({
    exams: {
      "azure/AZ-104": [
        "Microsoft Azure Administrator",
        "[c](https://learn.microsoft.com/credentials/certifications/azure-administrator?x=1)\n[e](https://learn.microsoft.com/credentials/certifications/exams/az-104?x=1)\n{/* credentials/certifications/commented-out */}\n",
      ],
      "azure/AZ-900": ["Azure Fundamentals", ""],
      "github/GH-200": ["GitHub Actions", ""],
    },
    drafts: ["GH-200"],
    labs: {
      "azure/az-104":
        "x https://learn.microsoft.com/credentials/applied-skills/real-skill/?WT.x\n{/* credentials/applied-skills/commented-skill */}\n<!-- credentials/applied-skills/html-commented -->\n",
      "azure/az-900":
        "credentials/applied-skills/real-skill and credentials/applied-skills/second\n",
    },
    learnExams: {
      certifications: [
        {
          slug: "Windows-Server-Hybrid-Administrator",
          exams: ["AZ-800", { code: "AZ-801" }, 5, "bad"],
        },
        { slug: "broken" },
      ],
    },
  });
  const hub = await loadHubContext(repo.cfg());
  assert.deepEqual(
    [...hub.exams.keys()].sort(),
    ["AZ-104", "AZ-900", "MS-102"]
      .filter((c) => c !== "MS-102")
      .concat([])
      .sort(),
  );
  assert.equal(hub.exams.get("AZ-104").area, "azure");
  assert.equal(
    hub.exams.get("AZ-104").path,
    "src/content/docs/azure/AZ-104.mdx",
  );
  assert.equal(hub.exams.get("AZ-104").name, "Microsoft Azure Administrator");
  assert.equal(hub.statuses.get("AZ-800").text, "RETIRING");
  assert.deepEqual([...hub.certLinks.keys()], ["azure-administrator"]);
  assert.deepEqual([...hub.certLinks.get("azure-administrator")], ["AZ-104"]);
  assert.deepEqual([...hub.labSkills.get("real-skill")].sort(), [
    "labs/azure/az-104",
    "labs/azure/az-900",
  ]);
  assert.ok(hub.labSkills.has("second"));
  assert.ok(!hub.labSkills.has("commented-skill"));
  assert.ok(!hub.labSkills.has("html-commented"));
  assert.deepEqual(
    [...hub.learnCerts.get("windows-server-hybrid-administrator")].sort(),
    ["AZ-800", "AZ-801"],
  );
  assert.ok(!hub.learnCerts.has("broken"));
});

test("an unreadable repository file is a failure of the check, never a guess", async () => {
  const repo = await makeRepo();
  await assert.rejects(
    loadHubContext(repo.cfg({ DOCS_DIR: join(repo.dir, "nowhere") })),
    /docs folder was not found/,
  );
  await assert.rejects(
    loadHubContext(
      repo.cfg({ EXAM_STATUS_FILE: join(repo.dir, "missing.mjs") }),
    ),
    /exam-status.mjs not found/,
  );
  await writeFile(join(repo.dir, "bad.mjs"), "export const nothing = 1;\n");
  await assert.rejects(
    loadHubContext(repo.cfg({ EXAM_STATUS_FILE: join(repo.dir, "bad.mjs") })),
    /no examStatuses export/,
  );
  // the optional Learn tracker may be absent or garbage
  await writeFile(join(repo.dir, "learn-exams.json"), "{garbage");
  assert.equal((await loadHubContext(repo.cfg())).learnCerts.size, 0);
});

// ---------------------------------------------------------------------------
// Findings: Learn versus the hub
// ---------------------------------------------------------------------------
function fakeHub({
  exams = ["MS-102", "AZ-800", "AZ-104"],
  // consistent with the default tracker ([E()] is MS-102): a badge without an entry is a finding
  statuses = { "MS-102": "RETIRING" },
  certLinks = {},
  labSkills = {},
  learnCerts = {},
} = {}) {
  const sets = (obj) =>
    new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));
  return {
    exams: new Map(
      exams.map((code) => [
        code,
        {
          code,
          area: "azure",
          path: `src/content/docs/azure/${code}.mdx`,
          name: code,
          text: "",
        },
      ]),
    ),
    statuses: new Map(
      Object.entries(statuses).map(([code, text]) => [
        code,
        { area: "azure", text },
      ]),
    ),
    certLinks: sets(certLinks),
    labSkills: sets(labSkills),
    learnCerts: sets(learnCerts),
  };
}
// an exam row links its certification, like Learn's: the same address as cert() below
const L = (over = {}) =>
  R({ source: "exams", slug: "m365-administrator-expert", ...over });
const cert = (over = {}) =>
  R({
    source: "credentials",
    kind: "certification",
    code: undefined,
    slug: "m365-administrator-expert",
    name: "Microsoft 365 Certified: Administrator Expert",
    ...over,
  });
const findingsFor = (opts) =>
  computeFindings({
    previousRows: [],
    okSources: new Set(["exams", "credentials"]),
    tracked: [E()],
    hub: fakeHub(),
    today: "2026-10-14",
    ...opts,
  });

test("a tracked exam with the date Learn gives is quiet, however Learn lists it", () => {
  assert.deepEqual(
    findingsFor({
      rows: [L(), cert()],
      tracked: [E({ notified: false })],
      hub: fakeHub({ statuses: { "MS-102": "RETIRING" } }),
    }),
    [],
  );
  // already retired: the same date in the retired table
  assert.deepEqual(
    findingsFor({
      rows: [L({ code: "AZ-800", status: "retired", date: "2026-09-30" })],
      tracked: [
        E({ code: "AZ-800", retirementDate: "2026-09-30", notified: true }),
      ],
      hub: fakeHub({ statuses: { "AZ-800": "RETIRING" } }),
    }),
    [],
  );
});

test("an exam the hub covers but the tracker does not know is a finding, scheduled or retired", () => {
  const scheduled = findingsFor({
    rows: [L({ code: "AZ-104", date: "2027-03-31" })],
    tracked: [],
    hub: fakeHub({ statuses: {} }),
  });
  assert.equal(scheduled.length, 1);
  assert.deepEqual(
    [
      scheduled[0].kind,
      scheduled[0].subject,
      scheduled[0].key,
      scheduled[0].via,
    ],
    ["untracked", "AZ-104", "exam:AZ-104:untracked", "exam"],
  );
  assert.equal(scheduled[0].signature, "scheduled|2027-03-31|exam");

  const retired = findingsFor({
    rows: [L({ code: "AZ-104", status: "retired", date: "2026-08-31" })],
    tracked: [],
    hub: fakeHub({ statuses: {} }),
  });
  assert.equal(retired[0].signature, "retired|2026-08-31|exam");

  // an unreadable date is still a finding: the exam is listed
  const unreadable = findingsFor({
    rows: [L({ code: "AZ-104", date: null, dateText: "TBD" })],
    tracked: [],
    hub: fakeHub({ statuses: {} }),
  });
  assert.equal(unreadable[0].signature, "scheduled|?|exam");
});

test("rows of exams the hub does not cover and does not track never alert", () => {
  assert.deepEqual(
    findingsFor({
      rows: [
        L({ code: "MB-910", status: "retired", date: "2025-12-31" }),
        L({ code: "MB-300", date: "2027-01-01" }),
      ],
      tracked: [],
      hub: fakeHub({ exams: ["AZ-104"], statuses: {} }),
    }),
    [],
  );
});

test("a different date is a finding, in either direction", () => {
  for (const learn of ["2026-12-31", "2026-11-01"]) {
    const found = findingsFor({ rows: [L({ date: learn })] });
    assert.equal(found.length, 1, learn);
    assert.equal(found[0].kind, "date-differs");
    assert.equal(found[0].signature, `${learn}|2026-11-30`);
  }
  // a tracked entry whose Learn date cannot be read is not compared
  assert.deepEqual(
    findingsFor({ rows: [L({ date: null, dateText: "TBD" })] }),
    [],
  );
});

test("a certification row maps to hub exams, and cert-only evidence never decides a date", () => {
  // the exam page links its certification: a certification row alone finds it
  const viaLink = findingsFor({
    rows: [
      cert({
        slug: "azure-administrator",
        name: "Azure Administrator",
        date: "2027-06-30",
      }),
    ],
    tracked: [],
    hub: fakeHub({
      statuses: {},
      certLinks: { "azure-administrator": ["AZ-104"] },
    }),
  });
  assert.equal(viaLink.length, 1);
  assert.equal(viaLink[0].subject, "AZ-104");
  assert.equal(viaLink[0].via, "certification");

  // the Learn exam tracker maps it too
  const viaLearn = findingsFor({
    rows: [
      cert({
        slug: "windows-server-hybrid-administrator",
        date: "2026-09-30",
        status: "retired",
      }),
    ],
    tracked: [],
    hub: fakeHub({
      statuses: {},
      learnCerts: { "windows-server-hybrid-administrator": ["AZ-800", "MB-1"] },
    }),
  });
  assert.deepEqual(
    viaLearn.map((f) => f.subject),
    ["AZ-800"],
  );

  // a certification date that differs from a tracked exam's own date is not a finding
  assert.deepEqual(
    findingsFor({
      rows: [cert({ slug: "azure-administrator", date: "2027-06-30" })],
      tracked: [E({ code: "AZ-104", retirementDate: "2027-01-31" })],
      hub: fakeHub({
        statuses: {},
        certLinks: { "azure-administrator": ["AZ-104"] },
      }),
    }),
    [],
  );
  // when the exam row exists it is the evidence, and the certification row is only context
  const both = findingsFor({
    rows: [
      L({ code: "MS-102", date: "2026-12-31" }),
      cert({ date: "2026-12-31" }),
    ],
  });
  assert.equal(both[0].kind, "date-differs");
  assert.equal(both[0].via, "exam");
  assert.equal(both[0].certRows.length, 1);
  // a certification no hub exam maps to is not a finding
  assert.deepEqual(
    findingsFor({
      rows: [cert({ slug: "unknown-cert" })],
      tracked: [],
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
});

test("certification rows map through the slug the exam rows link", () => {
  const rows = [
    L({
      code: "AZ-800",
      slug: "windows-server-hybrid-administrator",
      status: "retired",
    }),
    L({
      code: "AZ-801",
      slug: "windows-server-hybrid-administrator",
      status: "retired",
    }),
    cert({
      slug: "windows-server-hybrid-administrator",
      status: "retired",
      name: "WSHA",
    }),
    L({ kind: "exam", code: undefined, slug: "codeless", name: "Codeless" }),
  ];
  const map = evidenceByCode(
    rows,
    fakeHub({ certLinks: { codeless: ["AZ-104"] } }),
  );
  assert.equal(map.get("AZ-800").certRows.length, 1);
  assert.equal(map.get("AZ-801").certRows.length, 1);
  assert.equal(map.get("AZ-800").examRows.length, 1);
  // a code-less exam row behaves like a certification row
  assert.equal(map.get("AZ-104").certRows.length, 1);
});

test("a tracked, still future retirement that vanished from Learn is a finding, with care", () => {
  const prev = [storedRow("exams", L())];
  const ok = new Set(["exams", "credentials"]);
  const base = { rows: [], previousRows: prev, okSources: ok, tracked: [E()] };
  const dropped = findingsFor({ ...base, hub: fakeHub({ statuses: {} }) });
  assert.deepEqual(
    dropped.map((f) => [f.kind, f.subject]),
    [["dropped", "MS-102"]],
  );
  assert.equal(dropped[0].signature, "2026-11-30|2026-11-30");

  // it moved to the retired table: the normal lifecycle, no finding
  assert.deepEqual(
    findingsFor({
      ...base,
      rows: [L({ status: "retired" })],
      tracked: [E({ retirementDate: "2026-11-30" })],
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
  // the page could not be read this run: no evidence
  assert.deepEqual(
    findingsFor({
      ...base,
      okSources: new Set(["credentials"]),
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
  // the date has passed: the notification flow owns it
  assert.deepEqual(
    findingsFor({
      ...base,
      tracked: [E({ retirementDate: "2026-10-14" })],
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
  assert.deepEqual(
    findingsFor({
      ...base,
      tracked: [E({ retirementDate: "2026-09-30" })],
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
  // already notified
  assert.deepEqual(
    findingsFor({
      ...base,
      tracked: [E({ notified: true })],
      hub: fakeHub({ statuses: {} }),
    }),
    [],
  );
  // a row that rolled off "recently retired" is not a drop
  assert.deepEqual(
    findingsFor({
      ...base,
      previousRows: [
        storedRow("exams", L({ status: "retired", date: "2025-01-01" })),
      ],
    }),
    [],
  );
  // not tracked: nothing to cancel
  assert.deepEqual(
    findingsFor({ ...base, tracked: [], hub: fakeHub({ statuses: {} }) }),
    [],
  );
});

test("a RETIRING badge without a tracker entry is a finding, said once", () => {
  const hub = fakeHub({
    statuses: { "AZ-104": "RETIRING", "AZ-800": "RETIRING", "GH-1": "BETA" },
  });
  const found = findingsFor({
    rows: [],
    tracked: [E({ code: "AZ-800" })],
    hub,
  });
  assert.deepEqual(
    found.map((f) => [f.kind, f.subject]),
    [["badge-untracked", "AZ-104"]],
  );
  // when Learn lists the same exam the untracked finding already says it
  const both = findingsFor({
    rows: [L({ code: "AZ-104", date: "2027-03-31" })],
    tracked: [],
    hub: fakeHub({ statuses: { "AZ-104": "RETIRING" } }),
  });
  assert.deepEqual(
    both.map((f) => f.kind),
    ["untracked"],
  );
});

test("the retirement badges: RETIRING until the date has passed, RETIRED after it", () => {
  assert.deepEqual(RETIREMENT_BADGES, {
    RETIRING: { text: "RETIRING", variant: "danger" },
    RETIRED: { text: "RETIRED", variant: "note" },
  });
  assert.equal(isRetirementBadge({ text: "RETIRING" }), true);
  assert.equal(isRetirementBadge({ text: "RETIRED" }), true);
  for (const other of [{ text: "BETA" }, { text: "AT RISK" }, {}, undefined]) {
    assert.equal(isRetirementBadge(other), false);
  }
  // inherited property names are not statuses
  assert.equal(isRetirementBadge({ text: "toString" }), false);

  // The same cut-off as the notification and as the RetirementBanner: the exam is
  // retired once the date is before today (UTC); on the day itself it is retiring.
  assert.equal(expectedBadgeText("2026-09-30", "2026-10-14"), "RETIRED");
  assert.equal(expectedBadgeText("2026-10-13", "2026-10-14"), "RETIRED");
  assert.equal(expectedBadgeText("2026-10-14", "2026-10-14"), "RETIRING");
  assert.equal(expectedBadgeText("2026-11-30", "2026-10-14"), "RETIRING");
  // a date that is not a day never promotes an exam to retired
  assert.equal(expectedBadgeText("", "2026-10-14"), "RETIRING");
  assert.equal(expectedBadgeText("2026-02-31", "2026-10-14"), "RETIRING");

  assert.equal(badgeSnippet("RETIRED"), '{ text: "RETIRED", variant: "note" }');
  assert.equal(
    badgeSnippet("RETIRING"),
    '{ text: "RETIRING", variant: "danger" }',
  );
});

test("a RETIRED badge counts like RETIRING: it concerns the exam, needs a tracker entry, and a tracked one is quiet", () => {
  // a tracked retired exam, with Learn's row of the same date: nothing to say
  assert.deepEqual(
    findingsFor({
      rows: [L({ code: "AZ-800", status: "retired", date: "2026-09-30" })],
      tracked: [
        E({
          code: "AZ-800",
          retirementDate: "2026-09-30",
          notified: true,
          notifiedAt: "2026-10-01",
        }),
      ],
      hub: fakeHub({ statuses: { "AZ-800": "RETIRED" } }),
    }),
    [],
  );
  // a RETIRED badge without an entry is the same finding as a RETIRING one,
  // and says which badge it found
  const found = findingsFor({
    rows: [],
    tracked: [E({ code: "AZ-800" })],
    hub: fakeHub({
      statuses: { "AZ-104": "RETIRED", "AZ-800": "RETIRED" },
    }),
  });
  assert.deepEqual(
    found.map((f) => [f.kind, f.subject, f.badge]),
    [["badge-untracked", "AZ-104", "RETIRED"]],
  );
  const text = buildFindingsReport(
    reportCtx(),
    found.map((finding) => ({ finding, status: "new" })),
  );
  assert.match(text, /### AZ-104: RETIRED badge without a tracker entry/);
  assert.match(
    text,
    /marks `AZ-104` as RETIRED, but `src\/data_files\/retiring-exams.json` has no entry for it/,
  );
  assert.match(text, /the retirement has no recorded date/);
  // the RETIRED badge alone makes Learn's row about the exam a concern of the hub
  const alone = findingsFor({
    rows: [L({ code: "AZ-104", status: "retired", date: "2026-08-31" })],
    tracked: [],
    hub: fakeHub({ exams: [], statuses: { "AZ-104": "RETIRED" } }),
  });
  assert.deepEqual(
    alone.map((f) => [f.kind, f.subject]),
    [["untracked", "AZ-104"]],
  );
  // a RETIRING badge keeps saying RETIRING
  const retiring = findingsFor({
    rows: [],
    tracked: [E({ code: "AZ-800" })],
    hub: fakeHub({ statuses: { "AZ-104": "RETIRING" } }),
  });
  assert.equal(retiring[0].badge, "RETIRING");
  assert.match(
    buildFindingsReport(
      reportCtx(),
      retiring.map((finding) => ({ finding, status: "new" })),
    ),
    /### AZ-104: RETIRING badge without a tracker entry/,
  );
});

test("the edits name the badge that fits the date: RETIRED once it has passed, RETIRING before", () => {
  const edits = ({ statuses, row }) => {
    const hub = fakeHub({ exams: ["AZ-104"], statuses });
    hub.exams.get("AZ-104").name = "Microsoft Azure Administrator";
    const finding = computeFindings({
      rows: [row],
      previousRows: [],
      okSources: new Set(["exams"]),
      tracked: [],
      hub,
      today: "2026-10-14",
    })[0];
    return buildFindingsReport({ ...reportCtx(), hub }, [
      { finding, status: "new" },
    ]);
  };
  const passed = L({ code: "AZ-104", status: "retired", date: "2026-08-31" });
  const future = L({ code: "AZ-104", date: "2027-03-31" });

  // no badge yet, date passed: add RETIRED and keep the entry as history
  const none = edits({ statuses: {}, row: passed });
  assert.match(
    none,
    /under `azure` add `"AZ-104": \{ text: "RETIRED", variant: "note" \}` \(the date has passed; keep the tracker entry as history\)\./,
  );
  assert.match(
    none,
    /badge RETIRED in `exam-status.mjs`: \*\*missing\*\*; retirement banner on the page: \*\*missing\*\*/,
  );
  // still RETIRING after the date: switch it
  const stale = edits({ statuses: { "AZ-104": "RETIRING" }, row: passed });
  assert.match(
    stale,
    /under `azure` change the badge of `AZ-104` to `"AZ-104": \{ text: "RETIRED", variant: "note" \}`/,
  );
  assert.match(
    stale,
    /badge RETIRED in `exam-status.mjs`: \*\*missing\*\* \(it says `RETIRING`\)/,
  );
  // already RETIRED: no badge edit at all
  const done = edits({ statuses: { "AZ-104": "RETIRED" }, row: passed });
  assert.doesNotMatch(done, /exam-status\.mjs`: under/);
  assert.match(done, /badge RETIRED in `exam-status.mjs`: yes/);
  // a future date wants RETIRING, and a RETIRED badge is the one that is wrong
  const ahead = edits({ statuses: { "AZ-104": "RETIRED" }, row: future });
  assert.match(
    ahead,
    /change the badge of `AZ-104` to `"AZ-104": \{ text: "RETIRING", variant: "danger" \}`\./,
  );
  assert.doesNotMatch(ahead, /keep the tracker entry as history/);
});

test("an Applied Skill that a lab page links and Learn retires is a finding; others are only recorded", () => {
  const rows = [
    R({
      source: "exams",
      kind: "applied-skill",
      status: "scheduled",
      code: undefined,
      slug: "create-an-ai-agent",
      name: "Create an AI agent",
      date: "2026-05-28",
    }),
    R({
      source: "credentials",
      kind: "applied-skill",
      status: "retired",
      code: undefined,
      slug: "create-an-ai-agent",
      name: "Create an AI agent",
      date: "2026-05-28",
    }),
    R({
      source: "credentials",
      kind: "applied-skill",
      status: "retired",
      code: undefined,
      slug: "not-linked",
      name: "Not linked",
      date: "2026-05-28",
    }),
  ];
  const found = findingsFor({
    rows,
    tracked: [],
    hub: fakeHub({
      statuses: {},
      labSkills: {
        "create-an-ai-agent": ["labs/azure/ai-102", "labs/azure/ai-900"],
      },
    }),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "skill-linked");
  assert.deepEqual(found[0].labs, ["labs/azure/ai-102", "labs/azure/ai-900"]);
  assert.equal(found[0].signature, "retired:2026-05-28,scheduled:2026-05-28");
});

test("findings come in a fixed order", () => {
  const hub = fakeHub({
    exams: ["AZ-104", "AZ-800", "MS-102"],
    statuses: { "AZ-800": "RETIRING" },
    labSkills: { sk: ["labs/azure/x"] },
  });
  const found = findingsFor({
    rows: [
      L({ code: "MS-102", date: "2026-12-31" }),
      L({ code: "AZ-104", date: "2027-02-01" }),
      R({ kind: "applied-skill", code: undefined, slug: "sk", name: "Sk" }),
    ],
    tracked: [E()],
    hub,
  });
  assert.deepEqual(
    found.map((f) => f.kind),
    ["untracked", "date-differs", "badge-untracked", "skill-linked"],
  );
});

test("reports: new, unchanged (quiet), changed, reminder after 7 days, resolved ones forgotten", () => {
  const f = (key, signature) => ({
    key,
    signature,
    kind: "untracked",
    subject: key,
  });
  const today = "2026-10-14";
  const first = selectReports([f("a", "1"), f("b", "1")], {}, today, 7);
  assert.deepEqual(
    first.reportNow.map((r) => [r.finding.key, r.status]),
    [
      ["a", "new"],
      ["b", "new"],
    ],
  );
  assert.deepEqual(first.reported.a, {
    signature: "1",
    firstReported: today,
    lastReported: today,
  });

  // the next day: same signature, nothing to say
  const quiet = selectReports([f("a", "1")], first.reported, "2026-10-15", 7);
  assert.equal(quiet.reportNow.length, 0);
  assert.equal(quiet.reported.a.lastReported, today);
  assert.ok(!("b" in quiet.reported), "b was resolved");

  // a changed signature is reported at once and keeps nothing of the old record
  const changed = selectReports([f("a", "2")], first.reported, "2026-10-15", 7);
  assert.deepEqual(
    changed.reportNow.map((r) => r.status),
    ["changed"],
  );
  assert.equal(changed.reported.a.firstReported, "2026-10-15");

  // still open after 7 days: a reminder that remembers when it was first reported
  const remind = selectReports([f("a", "1")], first.reported, "2026-10-21", 7);
  assert.deepEqual(
    remind.reportNow.map((r) => r.status),
    ["reminder"],
  );
  assert.equal(remind.reportNow[0].firstReported, today);
  assert.deepEqual(remind.reported.a, {
    signature: "1",
    firstReported: today,
    lastReported: "2026-10-21",
  });
  assert.equal(
    selectReports([f("a", "1")], first.reported, "2026-10-20", 7).reportNow
      .length,
    0,
  );

  // resolved and back again: reported at once
  const back = selectReports([f("a", "1")], {}, "2026-10-30", 7);
  assert.equal(back.reportNow[0].status, "new");
});

// ---------------------------------------------------------------------------
// Announcements: new rows no exam maps to
// ---------------------------------------------------------------------------
const OKAY = new Set(["exams", "credentials"]);
const announce = (opts) =>
  computeAnnouncements({
    okSources: OKAY,
    hub: fakeHub({ statuses: {} }),
    ...opts,
  });

test("a scheduled certification row that appears or moves and maps to no exam is announced", () => {
  const known = cert({
    slug: "old-cert",
    name: "Old Cert",
    date: "2027-01-31",
  });
  const previousRows = [storedRow("credentials", known)];
  const fresh = cert({
    slug: "brand-new",
    name: "Brand New Cert",
    date: "2027-03-31",
  });
  const moved = { ...known, date: "2027-02-28" };
  const out = announce({ rows: [fresh, moved], previousRows });
  // sorted by date, the moved row first
  assert.deepEqual(
    out.map((r) => [r.name, r.date]),
    [
      ["Old Cert", "2027-02-28"],
      ["Brand New Cert", "2027-03-31"],
    ],
  );
  // unchanged rows say nothing
  assert.deepEqual(announce({ rows: [known], previousRows }), []);
});

test("a certification row without a link is announced when it appears, and never again once recorded", () => {
  // the parser leaves code: null and slug: "" where a name cell has no link
  const linkless = (name, over = {}) =>
    cert({ code: null, slug: "", name, date: "2027-03-31", ...over });
  const seen = linkless("Seen Without Link");
  const old = cert({ slug: "old-cert", name: "Old Cert" });
  const stored = (...rows) => rows.map((r) => storedRow("credentials", r));
  // it was recorded on an earlier run: quiet (it was announced again on every run)
  assert.deepEqual(
    announce({ rows: [seen, old], previousRows: stored(seen, old) }),
    [],
  );
  // a new one is announced, once
  const fresh = linkless("Fresh Without Link", { date: "2027-05-31" });
  assert.deepEqual(
    announce({
      rows: [seen, old, fresh],
      previousRows: stored(seen, old),
    }).map((r) => r.name),
    ["Fresh Without Link"],
  );
  assert.deepEqual(
    announce({
      rows: [seen, old, fresh],
      previousRows: stored(seen, old, fresh),
    }),
    [],
  );
  // a re-dated one is announced as moved
  assert.deepEqual(
    announce({
      rows: [{ ...seen, date: "2027-06-30" }, old],
      previousRows: stored(seen, old),
    }).map((r) => r.date),
    ["2027-06-30"],
  );
});

test("rows with a reliable mapping, a code or another kind or status are never announced", () => {
  const previousRows = [
    storedRow("credentials", cert({ slug: "seen", name: "Seen" })),
  ];
  const rows = (...extra) => [cert({ slug: "seen", name: "Seen" }), ...extra];
  // the address is the one an exam row links
  assert.deepEqual(
    announce({
      rows: rows(
        L({ code: "AB-1", slug: "linked", date: "2027-04-01" }),
        cert({ slug: "linked", name: "Linked" }),
      ),
      previousRows,
    }),
    [],
  );
  // ... a hub exam page links, or the Learn exam tracker lists
  assert.deepEqual(
    announce({
      rows: rows(cert({ slug: "page-linked", name: "P" })),
      previousRows,
      hub: fakeHub({ statuses: {}, certLinks: { "page-linked": ["AZ-104"] } }),
    }),
    [],
  );
  assert.deepEqual(
    announce({
      rows: rows(cert({ slug: "tracked", name: "T" })),
      previousRows,
      hub: fakeHub({ statuses: {}, learnCerts: { tracked: ["AZ-800"] } }),
    }),
    [],
  );
  // an exam row names its code: the hub either has the page (a finding) or does not care
  assert.deepEqual(
    announce({
      rows: rows(L({ code: "MB-300", slug: "x", date: "2027-04-01" })),
      previousRows,
    }),
    [],
  );
  // a retirement that moved to "recently retired" is the normal lifecycle
  assert.deepEqual(
    announce({
      rows: rows(cert({ slug: "gone", name: "Gone", status: "retired" })),
      previousRows,
    }),
    [],
  );
  // Applied Skills belong to the Applied Skills monitor
  assert.deepEqual(
    announce({
      rows: rows(
        R({
          source: "credentials",
          kind: "applied-skill",
          code: undefined,
          slug: "sk",
          name: "Sk",
        }),
      ),
      previousRows,
    }),
    [],
  );
  // an exam row without a code behaves like a certification row
  const codeless = L({ code: undefined, slug: "codeless-x", name: "Codeless" });
  assert.deepEqual(
    announce({
      rows: rows(codeless),
      previousRows: [
        ...previousRows,
        storedRow("exams", L({ code: "MS-102" })),
      ],
    }).map((r) => r.name),
    ["Codeless"],
  );
});

test("nothing is announced without a previous state of that page to compare with", () => {
  const fresh = cert({ slug: "brand-new", name: "Brand New" });
  // first run: no rows at all
  assert.deepEqual(announce({ rows: [fresh], previousRows: [] }), []);
  // the credentials page had no rows before (it could not be read on the baseline day)
  assert.deepEqual(
    announce({ rows: [fresh], previousRows: [storedRow("exams", L())] }),
    [],
  );
  // a page that could not be read this run
  const previousRows = [
    storedRow("credentials", cert({ slug: "seen", name: "Seen" })),
  ];
  assert.deepEqual(
    announce({ rows: [fresh], previousRows, okSources: new Set(["exams"]) }),
    [],
  );
  assert.equal(announce({ rows: [fresh], previousRows }).length, 1);
});

test("the slug map joins exam rows, hub pages and the Learn tracker", () => {
  const map = slugCodeMap(
    [L({ code: "MS-102", slug: "a" }), cert({ slug: "ignored" })],
    fakeHub({
      certLinks: { b: ["AZ-104"] },
      learnCerts: { a: ["MS-100"], c: ["AZ-800"] },
    }),
  );
  assert.deepEqual([...map.get("a")].sort(), ["MS-100", "MS-102"]);
  assert.deepEqual([...map.get("b")], ["AZ-104"]);
  assert.deepEqual([...map.get("c")], ["AZ-800"]);
  assert.ok(!map.has("ignored"));
});

test("the announcement says what it is, quotes safely and caps a long list", () => {
  const ctx = reportCtx();
  const rows = [
    cert({
      slug: "x",
      name: "Cert <img src=x> @octocat #12 | pipe",
      date: "2027-03-31",
    }),
  ];
  const text = buildAnnouncementReport(ctx, rows);
  assert.match(
    text,
    /^## Microsoft Learn announced a retirement this monitor cannot map to a hub exam/,
  );
  assert.match(
    text,
    /\| Certifications scheduled to retire \| Cert img src=x @​octocat #​12 pipe \| March 31, 2027 \| \[Credential retirement\]\(https:\/\/learn\.microsoft\.com\/en-us\/credentials\/support\/credential-retirement\) \|/,
  );
  assert.ok(!/<img/.test(text));
  assert.match(
    text,
    /1 row appeared in .* and no exam could be tied to it: the row names no exam code, and its certification address is not one that/,
  );
  assert.match(
    buildAnnouncementReport(ctx, [rows[0], rows[0]]),
    /2 rows appeared .* no exam could be tied to them: the rows name no exam code, and their certification addresses are not ones that/,
  );
  assert.match(text, /nothing to do/i);
  assert.match(text, /Adding a new exam to either tracker/);

  const many = Array.from({ length: 40 }, (_, i) =>
    cert({ slug: `s-${i}`, name: `Cert ${i}`, date: "2027-03-31" }),
  );
  const long = buildAnnouncementReport(ctx, many);
  assert.match(long, /15 more rows are not listed here/);
  assert.equal(
    long.split("\n").filter((l) => l.startsWith("| Certifications scheduled"))
      .length,
    25,
  );
});

// ---------------------------------------------------------------------------
// Failure counters
// ---------------------------------------------------------------------------
test("a page that cannot be read counts one more day per day, and a good read clears it", () => {
  const out = (id, status) => ({ id, status });
  let counters = {};
  counters = updateFailures(
    counters,
    [out("exams", "failed"), out("credentials", "ok")],
    "2026-10-12",
    3,
  );
  assert.deepEqual(counters, {
    exams: { runs: 1, since: "2026-10-12", last: "2026-10-12" },
  });
  // a second run on the same day counts once
  counters = updateFailures(
    counters,
    [out("exams", "failed"), out("credentials", "ok")],
    "2026-10-12",
    3,
  );
  assert.equal(counters.exams.runs, 1);
  counters = updateFailures(
    counters,
    [out("exams", "degraded"), out("credentials", "ok")],
    "2026-10-13",
    3,
  );
  assert.deepEqual(counters.exams, {
    runs: 2,
    since: "2026-10-12",
    last: "2026-10-13",
  });
  counters = updateFailures(
    counters,
    [out("exams", "failed"), out("credentials", "failed")],
    "2026-10-14",
    3,
  );
  assert.equal(counters.exams.runs, 3);
  assert.equal(counters.credentials.runs, 1);
  // a streak at the cap is frozen: no daily rewrite of the tracker
  const frozen = updateFailures(
    counters,
    [out("exams", "failed"), out("credentials", "failed")],
    "2026-10-15",
    3,
  );
  assert.deepEqual(frozen.exams, counters.exams);
  assert.equal(frozen.credentials.runs, 2);
  // healthy again
  assert.deepEqual(
    updateFailures(
      frozen,
      [out("exams", "ok"), out("credentials", "ok")],
      "2026-10-16",
      3,
    ),
    {},
  );
});

// ---------------------------------------------------------------------------
// Fetching and reading a page
// ---------------------------------------------------------------------------
test("retry delays honour Retry-After, cap it, and back off otherwise", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "5", baseMs: 100, maxMs: 60000 }),
    5000,
  );
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "9999", baseMs: 100, maxMs: 60000 }),
    60000,
  );
  assert.equal(
    retryDelayMs({ attempt: 3, retryAfter: null, baseMs: 100, maxMs: 60000 }),
    400,
  );
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Wed, 14 Oct 2026 10:00:07 GMT",
      baseMs: 100,
      maxMs: 60000,
      now,
    }),
    7000,
  );
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "garbage",
      baseMs: 100,
      maxMs: 60000,
    }),
    100,
  );
});

const fakeResponse = (status, body = "", headers = {}, url = "") => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => body,
});

test("readPage: ok, degraded, failed, restructured and the redirect note", async () => {
  // the day is injected: the previous rows below are dated 2026-11-30 and must stay current
  const cfg = (fetchImpl, extra = {}) => ({
    ...loadConfig({
      TODAY: "2026-10-14",
      FETCH_ATTEMPTS: "2",
      RETRY_BASE_MS: "1",
      ...extra,
    }),
    fetchImpl,
  });
  const goodHtml = examsPage({ scheduled: [MS102], retired: [AZ800] });
  const ok = await readPage(
    cfg(async () =>
      fakeResponse(
        200,
        goodHtml,
        {},
        "https://learn.microsoft.com" + EXAMS_PAGE.path,
      ),
    ),
    EXAMS_PAGE,
    [],
  );
  assert.equal(ok.status, "ok");
  assert.equal(ok.rows.length, 2);
  assert.ok(
    ok.rows.every((r) => r.source === "exams" || r.source === undefined),
  );

  // a 404 is final, a 503 is retried and then reported
  let hits = 0;
  const failed404 = await readPage(
    cfg(async () => (hits++, fakeResponse(404))),
    EXAMS_PAGE,
    [],
  );
  assert.deepEqual([failed404.status, hits], ["failed", 1]);
  assert.match(failed404.reason, /HTTP 404/);
  hits = 0;
  const failed503 = await readPage(
    cfg(async () => (hits++, fakeResponse(503, "", { "retry-after": "0" }))),
    EXAMS_PAGE,
    [],
  );
  assert.deepEqual([failed503.status, hits], ["failed", 2]);
  const thrown = await readPage(
    cfg(async () => {
      throw new Error("connect ECONNREFUSED");
    }),
    EXAMS_PAGE,
    [],
  );
  assert.match(thrown.reason, /network error: connect ECONNREFUSED/);
  // a retry that succeeds
  let n = 0;
  const flaky = await readPage(
    cfg(async () =>
      ++n === 1
        ? fakeResponse(429)
        : fakeResponse(
            200,
            goodHtml,
            {},
            "https://learn.microsoft.com" + EXAMS_PAGE.path,
          ),
    ),
    EXAMS_PAGE,
    [],
  );
  assert.equal(flaky.status, "ok");

  // 200 but not an article
  const bot = await readPage(
    cfg(async () => fakeResponse(200, "<html>captcha</html>")),
    EXAMS_PAGE,
    [],
  );
  assert.equal(bot.status, "failed");
  assert.match(bot.reason, /no <main> article/);

  // an unreadable row degrades the page but keeps the rows that were read
  const withBad = examsPage({
    scheduled: [["MB-1", "Open", "To be announced", "x"], MS102],
  });
  const degraded = await readPage(
    cfg(async () =>
      fakeResponse(
        200,
        withBad,
        {},
        "https://learn.microsoft.com" + EXAMS_PAGE.path,
      ),
    ),
    EXAMS_PAGE,
    [],
  );
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.rows.length, 2);
  assert.match(degraded.reason, /not one calendar day/);

  // a redirect to another address is a problem to fix in PAGES
  const moved = await readPage(
    cfg(async () =>
      fakeResponse(
        200,
        goodHtml,
        {},
        "https://learn.microsoft.com/en-us/credentials/support/new-name",
      ),
    ),
    EXAMS_PAGE,
    [],
  );
  assert.equal(moved.status, "degraded");
  assert.match(
    moved.reason,
    /redirects to https:\/\/learn.microsoft.com\/en-us\/credentials\/support\/new-name/,
  );

  // a restructured page keeps its previous rows, unless the baseline is forced
  const previous = Array.from({ length: 40 }, (_, i) =>
    storedRow("exams", R({ code: `OLD-${100 + i}`, status: "retired" })),
  );
  const restructured = await readPage(
    cfg(async () =>
      fakeResponse(
        200,
        goodHtml,
        {},
        "https://learn.microsoft.com" + EXAMS_PAGE.path,
      ),
    ),
    EXAMS_PAGE,
    previous,
  );
  assert.equal(restructured.status, "failed");
  assert.match(restructured.reason, /looks restructured.*force_baseline/);
  const forced = await readPage(
    cfg(
      async () =>
        fakeResponse(
          200,
          goodHtml,
          {},
          "https://learn.microsoft.com" + EXAMS_PAGE.path,
        ),
      { FORCE_BASELINE: "1" },
    ),
    EXAMS_PAGE,
    previous,
  );
  assert.equal(forced.status, "ok");
});

// ---------------------------------------------------------------------------
// Text of the issues
// ---------------------------------------------------------------------------
test("text from Learn cannot ping, link, open a block or inject markup", () => {
  const evil =
    "@octocat fixes #123 <img src=x onerror=1> `tick` [link](http://x) | pipe";
  const safe = safeText(evil);
  assert.ok(!/[<>`[\]|]/.test(safe));
  assert.ok(!/@octocat/.test(safe) && safe.includes("@​octocat"));
  assert.ok(safe.includes("#​123"));

  // the quote of a row sits in a fence that its own text cannot close
  const block = fence("MS-102 | ```evil``` | November 30, 2026");
  assert.ok(block.startsWith("````text\n"));
  assert.ok(block.endsWith("\n````"));
  assert.equal(fence("plain").split("\n")[0], "```text");
  assert.equal(
    quoteRow({ code: "MS-102", name: "X", dateText: "November 30, 2026" }),
    "MS-102 | X | November 30, 2026",
  );
  assert.equal(
    quoteRow({ name: "Cert", date: "2026-11-30" }),
    "Cert | November 30, 2026",
  );
});

test("titles name the codes and never pass 200 characters", () => {
  assert.equal(
    titleWithCodes("Exam retirement notification: ", ["MS-102"]),
    "Exam retirement notification: MS-102",
  );
  assert.equal(titleWithCodes("T: ", ["A-1", "B-2"]), "T: A-1, B-2");
  const many = Array.from({ length: 200 }, (_, i) => `AZ-${100 + i}`);
  const title = titleWithCodes("Exam retirement notification: ", many);
  assert.ok(title.length <= 200);
  assert.match(title, /and \d+ more$/);
});

function reportCtx(overrides = {}) {
  const hub = fakeHub({
    statuses: { "AZ-800": "RETIRING", "MS-102": "RETIRING" },
  });
  hub.exams.get("MS-102").text = CAUTION_102;
  hub.exams.get("MS-102").path = "src/content/docs/microsoft365/MS-102.mdx";
  hub.exams.get("MS-102").area = "microsoft365";
  hub.exams.get("MS-102").name = "Microsoft 365 Administrator";
  const rows = [L({ date: "2026-12-31" }), cert({ date: "2026-12-31" })];
  return {
    cfg: loadConfig({ TODAY: "2026-10-14" }),
    hub,
    today: "2026-10-14",
    pages: [
      {
        id: "exams",
        page: EXAMS_PAGE,
        status: "ok",
        updatedAt: "2026-09-30T20:12:00Z",
        rows: [],
      },
      {
        id: "credentials",
        page: CREDENTIALS_PAGE,
        status: "ok",
        updatedAt: "2026-08-31T19:51:00Z",
        rows: [],
      },
    ],
    evidence: evidenceByCode(rows, hub),
    ...overrides,
  };
}

test("the findings report quotes Learn's row and names the exact edits", () => {
  const ctx = reportCtx();
  const rows = [
    L({
      date: "2026-12-31",
      name: "Microsoft 365 Certified: Administrator Expert",
    }),
  ];
  const found = computeFindings({
    rows,
    previousRows: [],
    okSources: new Set(["exams"]),
    tracked: [E()],
    hub: ctx.hub,
    today: ctx.today,
  });
  const text = buildFindingsReport(
    ctx,
    found.map((finding) => ({ finding, status: "new" })),
  );
  assert.match(
    text,
    /^## Exam retirement schedule: the hub does not match Microsoft Learn/,
  );
  assert.match(
    text,
    /Checked on 2026-10-14 against \[Exam and assessment lab retirement\]\(https:\/\/learn\.microsoft\.com\/en-us\/credentials\/support\/retired-certification-exams\) \(updated 2026-09-30\)/,
  );
  assert.match(text, /### MS-102: the retirement date differs from Learn/);
  assert.match(
    text,
    /gives December 31, 2026 \(78 days from today\) for `MS-102`; `retiring-exams.json` says `2026-11-30`/,
  );
  assert.match(
    text,
    /```text\nMS-102 \| Microsoft 365 Certified: Administrator Expert \| December 31, 2026\n```/,
  );
  // the page has the badge and a banner, but its banner names another date
  assert.match(
    text,
    /badge RETIRING in `exam-status.mjs`: yes; retirement banner on the page: present, but it does not mention December 31, 2026/,
  );
  assert.match(
    text,
    /1\. `src\/data_files\/retiring-exams.json`: set `retirementDate` of `MS-102` to `2026-12-31`/,
  );
  assert.match(
    text,
    /2\. `src\/content\/docs\/microsoft365\/MS-102.mdx`: change the date in the retirement banner to December 31, 2026\./,
  );
  assert.match(text, /3\. Run `pnpm build`\./);
});

test("an untracked exam gets the entry, the badge and the banner to paste", () => {
  const hub = fakeHub({ exams: ["AZ-104"], statuses: {} });
  hub.exams.get("AZ-104").text = BANNER_800.replace("AZ-802", "AZ-999");
  const bare = fakeHub({ exams: ["AZ-104"], statuses: {} });
  bare.exams.get("AZ-104").name = "Microsoft Azure Administrator";
  const ctx = reportCtx({ hub: bare });
  const finding = computeFindings({
    rows: [
      L({ code: "AZ-104", date: "2027-03-31" }),
      cert({ slug: "s", date: "2027-03-31" }),
    ],
    previousRows: [],
    okSources: new Set(["exams"]),
    tracked: [],
    hub: bare,
    today: "2026-10-14",
  })[0];
  const text = buildFindingsReport({ ...ctx, hub: bare }, [
    { finding, status: "new" },
  ]);
  assert.match(
    text,
    /### AZ-104: Learn lists a retirement the hub does not track/,
  );
  assert.match(
    text,
    /schedules `AZ-104` to retire on March 31, 2027 \(168 days from today\)/,
  );
  assert.match(
    text,
    /"code": "AZ-104",\n\s+"area": "azure",\n\s+"name": "Microsoft Azure Administrator",\n\s+"retirementDate": "2027-03-31",/,
  );
  assert.match(
    text,
    /Fill `replacementCode` only from Microsoft's announcement/,
  );
  assert.match(text, /"notified": false/);
  assert.match(
    text,
    /under `azure` add `"AZ-104": \{ text: "RETIRING", variant: "danger" \}`/,
  );
  assert.match(
    text,
    /import RetirementBanner from '\.\.\/\.\.\/\.\.\/components\/RetirementBanner\.astro';/,
  );
  assert.match(text, /retireDate="March 31, 2027"/);
  // a retired exam is recorded as already notified: this issue is the notification
  const retired = computeFindings({
    rows: [L({ code: "AZ-104", status: "retired", date: "2026-08-31" })],
    previousRows: [],
    okSources: new Set(["exams"]),
    tracked: [],
    hub: bare,
    today: "2026-10-14",
  })[0];
  const retiredText = buildFindingsReport({ ...ctx, hub: bare }, [
    { finding: retired, status: "new" },
  ]);
  assert.match(
    retiredText,
    /lists `AZ-104` as \*\*retired\*\* on August 31, 2026 \(44 days ago\)/,
  );
  assert.match(retiredText, /"notified": true/);
  assert.match(retiredText, /this issue is the notification/);
});

test("the other findings say what to check and what to edit", () => {
  const ctx = reportCtx();
  const dropped = {
    key: "k",
    kind: "dropped",
    subject: "MS-102",
    entry: E(),
    row: storedRow("exams", L()),
    signature: "s",
  };
  const badge = {
    key: "b",
    kind: "badge-untracked",
    subject: "AZ-800",
    signature: "badge",
  };
  const skill = {
    key: "s",
    kind: "skill-linked",
    subject: "create-an-ai-agent",
    labs: ["labs/azure/ai-102"],
    signature: "x",
    rows: [
      R({
        kind: "applied-skill",
        status: "retired",
        code: undefined,
        name: "Create an AI agent",
        date: "2026-05-28",
      }),
    ],
  };
  const text = buildFindingsReport(
    ctx,
    [dropped, badge, skill].map((finding) => ({ finding, status: "reminder" })),
  );
  assert.match(text, /### MS-102: Learn no longer lists a tracked retirement/);
  assert.match(text, /Do not change the page on this alone/);
  assert.match(text, /### AZ-800: RETIRING badge without a tracker entry/);
  assert.match(text, /will never remind about or announce/);
  assert.match(
    text,
    /### create-an-ai-agent: a lab page links a retiring Applied Skill/,
  );
  assert.match(text, /- `src\/content\/docs\/labs\/azure\/ai-102.mdx`/);
  assert.match(text, /node scripts\/applied-skills-sync\.mjs/);
  assert.match(text, /_Reminder: reported before and still open\._/);
});

test("a huge findings report is cut under GitHub's size limit and says so", () => {
  const ctx = reportCtx();
  const findings = Array.from({ length: 400 }, (_, i) => ({
    finding: {
      key: `k${i}`,
      kind: "badge-untracked",
      subject: `AZ-${1000 + i}`,
      signature: "b",
    },
    status: "new",
  }));
  const text = buildFindingsReport(ctx, findings);
  assert.ok(text.length < 60_000, String(text.length));
  assert.match(text, /more items are not shown here/);
  assert.ok(text.includes("AZ-1000"));
});

test("the notification after the date confirms it against Learn", () => {
  const ctx = reportCtx();
  ctx.evidence = evidenceByCode(
    [
      L({ status: "retired" }),
      L({ code: "AZ-800", status: "retired", date: "2026-09-30" }),
    ],
    ctx.hub,
  );
  const retired = selectRetired(
    [E({ retirementDate: "2026-10-13" })],
    "2026-10-14",
  ).retired;
  const text = buildRetiredReport(ctx, retired);
  assert.match(text, /^## Exam\(s\) retired/);
  assert.match(
    text,
    /\| MS-102 \| Microsoft 365 Administrator \| 2026-10-13 \| AB-650 \|/,
  );
  assert.match(text, /### MS-102/);
  assert.match(
    text,
    /Learn: listed as retired on November 30, 2026 \(\*\*differs\*\* from the tracker date 2026-10-13\)\./,
  );
  assert.match(
    text,
    /"Beta and Retiring Exam Tracking" runbook \(`docs\/monitors\/beta-and-retiring-exams\.md`\)/,
  );
});

// ---------------------------------------------------------------------------
// Issue handling
// ---------------------------------------------------------------------------
test("the notification tells the maintainer to switch the badge to RETIRED and keep the tracker entry", () => {
  const ctx = reportCtx();
  ctx.evidence = evidenceByCode([L({ status: "retired" })], ctx.hub);
  const retired = selectRetired(
    [E({ retirementDate: "2026-10-13" })],
    "2026-10-14",
  ).retired;
  const text = buildRetiredReport(ctx, retired);
  // the badge is still RETIRING after the date: the exam line says it is the wrong one
  assert.match(
    text,
    /badge RETIRED in `exam-status.mjs`: \*\*missing\*\* \(it says `RETIRING`\)/,
  );
  assert.match(
    text,
    /switch it from `RETIRING` to `RETIRED` in `src\/data_files\/exam-status\.mjs` \(`\{ text: "RETIRED", variant: "note" \}`\)/,
  );
  assert.match(
    text,
    /Keep the `retiring-exams.json` entry as history: the monitor sets `notified` itself and never notifies again for it/,
  );
  assert.match(
    text,
    /`RetirementBanner` on the page already words itself in the past tense/,
  );
  // the old advice to remove the status is gone
  assert.doesNotMatch(text, /remove the `RETIRING` status/);

  // once the badge says RETIRED the exam line agrees
  ctx.hub.statuses.set("MS-102", { area: "microsoft365", text: "RETIRED" });
  assert.match(
    buildRetiredReport(ctx, retired),
    /badge RETIRED in `exam-status.mjs`: yes/,
  );
});

const quietCfg = loadConfig({ CREATE_ISSUES: "1", TODAY: "2026-10-14" });

function stubGh({ open = [], fail = {} } = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const command = args.slice(0, 2).join(" ");
    if (fail[command]) throw new Error(`gh ${command} failed: boom`);
    if (command === "issue list") return JSON.stringify(open);
    if (command === "issue create")
      return "https://github.com/mscerts/hub/issues/77\n";
    return "";
  };
  gh.calls = calls;
  gh.commands = () => calls.map((c) => c.args.slice(0, 2).join(" "));
  return gh;
}
const issueArgs = {
  enabled: true,
  title: "T",
  label: "enhancement",
  body: "BODY",
  closeComment: "bye",
};

test("a running issue: created once, then comments, closed when nothing is left", () => {
  const created = stubGh();
  assert.deepEqual(syncIssue({ ...issueArgs, gh: created, active: true }), {
    action: "created",
    number: 77,
    closed: [],
    error: null,
  });
  assert.deepEqual(created.commands(), [
    "issue list",
    "label create",
    "issue create",
  ]);
  assert.deepEqual(created.calls[2].args, [
    "issue",
    "create",
    "--title",
    "T",
    "--label",
    "enhancement",
    "--body-file",
    "-",
  ]);
  assert.equal(created.calls[2].input, "BODY");

  const commented = stubGh({
    open: [
      { number: 9, title: "T" },
      { number: 3, title: "T" },
      { number: 4, title: "other" },
    ],
  });
  const out = syncIssue({
    ...issueArgs,
    gh: commented,
    active: true,
    commentBody: "NEWS",
  });
  assert.equal(out.action, "commented");
  assert.equal(out.number, 3, "the oldest open copy gets the comment");
  assert.deepEqual(commented.commands(), ["issue list", "issue comment"]);

  const closing = stubGh({
    open: [
      { number: 3, title: "T" },
      { number: 5, title: "T" },
    ],
  });
  const closed = syncIssue({ ...issueArgs, gh: closing, active: false });
  assert.deepEqual([closed.action, closed.closed], ["closed", [3, 5]]);
  assert.deepEqual(closing.calls[1].args, [
    "issue",
    "close",
    "3",
    "--comment",
    "bye",
  ]);

  // nothing open, nothing to close
  assert.equal(
    syncIssue({ ...issueArgs, gh: stubGh(), active: false }).action,
    "none",
  );
});

test("issues are not touched when disabled; a failure is fatal only when the issue is needed", () => {
  const gh = stubGh();
  assert.equal(
    syncIssue({ ...issueArgs, gh, enabled: false, active: true }).action,
    "skipped",
  );
  assert.equal(
    syncIssue({ ...issueArgs, gh, enabled: false, active: false }).action,
    "none",
  );
  assert.equal(gh.calls.length, 0, "not even a read");

  const lookup = stubGh({ fail: { "issue list": true } });
  assert.throws(
    () => syncIssue({ ...issueArgs, gh: lookup, active: true }),
    /issue list failed/,
  );
  const quiet = syncIssue({ ...issueArgs, gh: lookup, active: false });
  assert.equal(quiet.action, "lookup-failed");
  assert.match(quiet.error, /boom/);
  const closeFails = stubGh({
    open: [{ number: 3, title: "T" }],
    fail: { "issue close": true },
  });
  assert.equal(
    syncIssue({ ...issueArgs, gh: closeFails, active: false }).action,
    "close-failed",
  );
  const createFails = stubGh({ fail: { "issue create": true } });
  assert.throws(
    () => syncIssue({ ...issueArgs, gh: createFails, active: true }),
    /issue create failed/,
  );
});

test("event issues (the notification after the date) are new issues with the codes in the title", () => {
  const gh = stubGh();
  const out = createEventIssue(quietCfg, gh, {
    title: "Exam retirement notification: MS-102",
    body: "B",
  });
  assert.deepEqual(out, { action: "created", number: 77 });
  assert.deepEqual(gh.calls.at(-1).args.slice(0, 6), [
    "issue",
    "create",
    "--title",
    "Exam retirement notification: MS-102",
    "--label",
    "enhancement",
  ]);
  const off = stubGh();
  assert.equal(
    createEventIssue(loadConfig({}), off, { title: "T", body: "B" }).action,
    "skipped",
  );
  assert.equal(
    createEventIssue(loadConfig({ CREATE_ISSUES: "1", DRY_RUN: "1" }), off, {
      title: "T",
      body: "B",
    }).action,
    "skipped",
  );
  assert.equal(off.calls.length, 0);
});

test("a label that cannot be created is an error, unless it exists already", () => {
  const labelGh = (labels) => {
    const calls = [];
    const gh = (args) => {
      const command = args.slice(0, 2).join(" ");
      calls.push(command);
      if (command === "label create") {
        throw new Error("gh label create failed: boom");
      }
      if (command === "label list") {
        return JSON.stringify(labels.map((name) => ({ name })));
      }
      return command === "issue create"
        ? "https://github.com/mscerts/hub/issues/78\n"
        : "";
    };
    return Object.assign(gh, { calls });
  };
  const issue = { title: "T", body: "B" };

  // it was there already (or a parallel run made it): the issue is created
  const known = labelGh(["bug", "Enhancement"]);
  assert.deepEqual(createEventIssue(quietCfg, known, issue), {
    action: "created",
    number: 78,
  });
  assert.deepEqual(known.calls, ["label create", "label list", "issue create"]);

  // any other failure of `label create` is not swallowed, and no issue is made
  const broken = labelGh([]);
  assert.throws(
    () => createEventIssue(quietCfg, broken, issue),
    /gh label create failed: boom/,
  );
  assert.ok(!broken.calls.includes("issue create"));
});

test("the stable issues: findings, unreadable pages, failed check", () => {
  assert.equal(
    FINDINGS_ISSUE_TITLE,
    "Exam retirement schedule: hub does not match Microsoft Learn",
  );
  assert.equal(FINDINGS_ISSUE_LABEL, "enhancement");
  assert.equal(
    PAGES_ISSUE_TITLE,
    "Retiring Exam Monitor: Microsoft Learn retirement pages cannot be read",
  );
  assert.equal(FAILED_ISSUE_TITLE, "Retiring Exam Monitor: the check failed");
  assert.equal(BUG_LABEL, "bug");

  // findings: all clear closes, a pending report creates, anything else leaves it alone
  const open = [{ number: 12, title: FINDINGS_ISSUE_TITLE }];
  const close = stubGh({ open });
  assert.equal(
    syncFindingsIssue(quietCfg, close, {
      reportNow: [],
      allClear: true,
      body: "",
    }).action,
    "closed",
  );
  assert.match(close.calls[1].args[4], /agree as of 2026-10-14/);
  const idle = stubGh({ open });
  assert.equal(
    syncFindingsIssue(quietCfg, idle, {
      reportNow: [],
      allClear: false,
      body: "",
    }).action,
    "none",
  );
  assert.equal(idle.calls.length, 0);
  const comment = stubGh({ open });
  assert.equal(
    syncFindingsIssue(quietCfg, comment, {
      reportNow: [{}],
      allClear: false,
      body: "NEW",
    }).action,
    "commented",
  );
  assert.equal(comment.calls[1].input, "NEW");

  // unreadable pages: one issue, a comment per further day, closed when readable
  const failing = [
    {
      page: EXAMS_PAGE,
      record: { runs: 3, since: "2026-10-12", last: "2026-10-14" },
      reason: "could not be fetched (HTTP 503)",
    },
  ];
  const made = stubGh();
  assert.equal(syncPagesIssue(quietCfg, made, { failing }).action, "created");
  assert.equal(made.calls[2].args[3], PAGES_ISSUE_TITLE);
  assert.match(
    made.calls[2].input,
    /\| 2026-10-12 \| 3 \| could not be fetched \(HTTP 503\) \|/,
  );
  assert.match(
    made.calls[2].input,
    /The notification after the date still works/,
  );
  const again = stubGh({ open: [{ number: 5, title: PAGES_ISSUE_TITLE }] });
  assert.equal(
    syncPagesIssue(quietCfg, again, { failing }).action,
    "commented",
  );
  assert.match(
    again.calls[1].input,
    /Still unreadable on 2026-10-14: exams \(could not be fetched \(HTTP 503\)\)/,
  );
  const healed = stubGh({ open: [{ number: 5, title: PAGES_ISSUE_TITLE }] });
  assert.equal(
    syncPagesIssue(quietCfg, healed, { failing: [] }).action,
    "closed",
  );
  assert.match(buildPagesReport(quietCfg, failing), /force_baseline/);

  // the failed check: created with the reason, a comment per further failure, closed after a healthy run
  const f1 = stubGh();
  assert.equal(
    syncFailureIssue(quietCfg, f1, "Corrupt tracker file at x (invalid JSON).")
      .action,
    "created",
  );
  assert.match(
    f1.calls[2].input,
    /^The Retiring Exam Monitor could not run on 2026-10-14\./,
  );
  assert.match(f1.calls[2].input, /\*\*Why:\*\* Corrupt tracker file/);
  const f2 = stubGh({ open: [{ number: 7, title: FAILED_ISSUE_TITLE }] });
  assert.equal(syncFailureIssue(quietCfg, f2, "again").action, "commented");
  assert.match(
    f2.calls[1].input,
    /^The Retiring Exam Monitor failed again on 2026-10-14:/,
  );
  const f3 = stubGh({ open: [{ number: 7, title: FAILED_ISSUE_TITLE }] });
  assert.equal(syncFailureIssue(quietCfg, f3, null).action, "closed");
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
test("configuration: defaults, overrides and bad values", () => {
  const cfg = loadConfig({});
  assert.match(
    cfg.examsFile.replace(/\\/g, "/"),
    /src\/data_files\/retiring-exams\.json$/,
  );
  assert.match(
    cfg.scheduleFile.replace(/\\/g, "/"),
    /src\/data_files\/retirement-schedule\.json$/,
  );
  assert.equal(cfg.learnBaseUrl, "https://learn.microsoft.com");
  assert.equal(cfg.fetchDelayMs, 1000);
  assert.equal(cfg.failingRuns, 3);
  assert.equal(cfg.reminderDays, 7);
  assert.equal(cfg.maxRowChanges, 20);
  assert.equal(cfg.createIssues, false);
  assert.equal(cfg.forceBaseline, false);
  assert.match(cfg.today, /^\d{4}-\d{2}-\d{2}$/);

  const custom = loadConfig({
    TODAY: "2026-12-01",
    LEARN_BASE_URL: "http://127.0.0.1:9/",
    FETCH_DELAY_MS: "0",
    FAILING_RUNS: "5",
    CREATE_ISSUES: "1",
    FORCE_BASELINE: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "mscerts/hub",
    GITHUB_RUN_ID: "42",
  });
  assert.equal(custom.today, "2026-12-01");
  assert.equal(custom.learnBaseUrl, "http://127.0.0.1:9");
  assert.equal(custom.fetchDelayMs, 0);
  assert.equal(custom.failingRuns, 5);
  assert.equal(custom.createIssues, true);
  assert.equal(custom.forceBaseline, true);
  assert.equal(custom.runUrl, "https://github.com/mscerts/hub/actions/runs/42");

  const bad = loadConfig({
    TODAY: "2026-02-31",
    FETCH_DELAY_MS: "-4",
    FAILING_RUNS: "0",
    MAX_ROW_CHANGES: "x",
  });
  assert.match(bad.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(bad.today, "2026-02-31");
  assert.equal(bad.fetchDelayMs, 1000);
  assert.equal(bad.failingRuns, 1);
  assert.equal(bad.maxRowChanges, 20);
});

// ---------------------------------------------------------------------------
// End to end: the script against a local fake of Learn and a fake gh
// ---------------------------------------------------------------------------
async function startLearn({
  exams = defaultExamsHtml(),
  credentials = defaultCredentialsHtml(),
} = {}) {
  const state = {
    html: { exams, credentials },
    status: { exams: 200, credentials: 200 },
    hits: { exams: 0, credentials: 0 },
    headers: [],
  };
  const idOf = (url) => PAGES.find((p) => p.path === url.split("?")[0])?.id;
  const server = createServer((request, response) => {
    state.headers.push(request.headers);
    const id = idOf(request.url);
    if (!id) {
      response.statusCode = 404;
      return response.end("nope");
    }
    state.hits[id]++;
    response.statusCode = state.status[id];
    response.setHeader("content-type", "text/html");
    response.end(state.status[id] === 200 ? state.html[id] : "unavailable");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

// A fake gh that keeps its issues in a file, like the other monitors' tests.
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

async function withIssues(repo) {
  const file = join(repo.dir, "fake-gh.mjs");
  const log = join(repo.dir, "gh.log");
  const state = join(repo.dir, "gh-state.json");
  await writeFile(file, FAKE_GH);
  await writeFile(log, "");
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    env: {
      CREATE_ISSUES: "1",
      GH_CLI_SCRIPT: file,
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
      FAKE_GH_FAIL: "",
    },
    calls,
    writes: () =>
      calls().filter((c) =>
        [
          "label create",
          "issue create",
          "issue comment",
          "issue close",
        ].includes(c.command),
      ),
    issues: () =>
      existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).issues : [],
    open: (title) =>
      (existsSync(state)
        ? JSON.parse(readFileSync(state, "utf8")).issues
        : []
      ).filter((i) => i.state === "open" && (!title || i.title === title)),
  };
}

/** Runs the script like the workflow does and reads back everything it wrote. */
function runScript(repo, learn, today, extraEnv = {}) {
  for (const key of [
    "REPORT_FILE",
    "ERROR_FILE",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
  ]) {
    if (existsSync(repo.env[key])) rmSyncSafe(repo.env[key]);
  }
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        // what a GitHub runner sets must not change what the script prints or links
        GITHUB_ACTIONS: "",
        GITHUB_SERVER_URL: "",
        GITHUB_REPOSITORY: "",
        GITHUB_RUN_ID: "",
        ...repo.env,
        LEARN_BASE_URL: learn.origin,
        TODAY: today,
        FORCE_BASELINE: "",
        CREATE_ISSUES: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      const read = (file) =>
        existsSync(file)
          ? readFileSync(file, "utf8").replace(/\r\n/g, "\n")
          : null;
      const output = Object.fromEntries(
        (read(repo.env.GITHUB_OUTPUT) ?? "")
          .split("\n")
          .filter(Boolean)
          .map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ]),
      );
      resolveRun({
        code,
        stdout,
        stderr,
        output,
        report: read(repo.env.REPORT_FILE),
        error: read(repo.env.ERROR_FILE),
        summary: read(repo.env.GITHUB_STEP_SUMMARY),
        schedule: repo.schedule(),
        exams: repo.exams(),
      });
    });
  });
}

import { rmSync } from "node:fs";
const rmSyncSafe = (file) => {
  try {
    rmSync(file, { force: true });
  } catch {
    /* gone */
  }
};

const QUIET = {
  changes_found: "false",
  baseline_updated: "false",
  extraction_failed: "false",
  issue_title: "",
};

test("end to end: the first run baselines the rows silently and finds nothing in a consistent hub", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  try {
    const result = await runScript(repo, learn, "2026-10-14");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.output, { ...QUIET, baseline_updated: "true" });
    assert.equal(result.report, null);
    const schedule = JSON.parse(result.schedule);
    assert.equal(schedule.lastSynced, "2026-10-14");
    assert.deepEqual(schedule.failures, {});
    assert.deepEqual(schedule.reported, {});
    // 1 + 3 + 1 exam rows and 1 + 2 + 1 credentials rows
    assert.equal(schedule.rows.filter((r) => r.source === "exams").length, 5);
    assert.equal(
      schedule.rows.filter((r) => r.source === "credentials").length,
      4,
    );
    assert.ok(schedule.rows.every((r) => !("dateText" in r)));
    assert.match(
      result.stdout,
      /exams: ok, 5 rows read, Learn updated_at 2026-09-30T20:12:00Z/,
    );
    assert.match(result.stdout, /0 findings open, 0 to report today\./);
    assert.match(
      result.summary,
      /Exam and assessment lab retirement: \*\*ok\*\*, 5 rows/,
    );
    // the hand-kept list is untouched
    assert.equal(result.exams, readFileSync(repo.env.EXAMS_FILE, "utf8"));
    // polite: one request per page, a browser User-Agent
    assert.deepEqual(learn.state.hits, { exams: 1, credentials: 1 });
    assert.match(learn.state.headers[0]["user-agent"], /Mozilla\/5\.0/);
  } finally {
    await learn.close();
  }
});

test("end to end: a hub whose retired exams carry the RETIRED badge, with their tracker entries as history, is quiet", async () => {
  const repo = await makeRepo({
    statuses: {
      azure: {
        "AZ-800": { text: "RETIRED", variant: "note" },
        "AZ-801": { text: "RETIRED", variant: "note" },
      },
      microsoft365: { "MS-102": { text: "RETIRING", variant: "danger" } },
      aibusiness: { "AB-650": { text: "BETA", variant: "tip" } },
    },
  });
  const learn = await startLearn();
  try {
    const result = await runScript(repo, learn, "2026-10-14");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.output, { ...QUIET, baseline_updated: "true" });
    assert.equal(result.report, null);
    // the tracker is history, not touched
    assert.equal(result.exams, readFileSync(repo.env.EXAMS_FILE, "utf8"));
    const later = await runScript(repo, learn, "2026-10-15");
    assert.deepEqual(later.output, QUIET);
  } finally {
    await learn.close();
  }
});

test("end to end: a RETIRED badge for an exam the tracker does not know is a finding that names the entry to add", async () => {
  const repo = await makeRepo({
    statuses: {
      azure: {
        "AZ-800": { text: "RETIRED", variant: "note" },
        "AZ-801": { text: "RETIRED", variant: "note" },
      },
      microsoft365: { "MS-102": { text: "RETIRING", variant: "danger" } },
      aibusiness: { "AB-650": { text: "BETA", variant: "tip" } },
    },
    retiring: [E()],
  });
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    const result = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(result.code, 0, result.stderr);
    const findings = gh
      .issues()
      .find((i) => /hub does not match/.test(i.title));
    assert.ok(findings, "a findings issue is open");
    for (const code of ["AZ-800", "AZ-801"]) {
      assert.match(
        findings.body,
        new RegExp(
          `### ${code}: Learn lists a retirement the hub does not track`,
        ),
      );
      // Learn lists them as retired and the badge already says RETIRED: no badge edit
      assert.match(
        findings.body,
        new RegExp(`${code}[^\\n]*\\*\\*retired\\*\\*`),
      );
    }
    assert.doesNotMatch(findings.body, /exam-status\.mjs`: under/);
    assert.match(findings.body, /badge RETIRED in `exam-status.mjs`: yes/);
  } finally {
    await learn.close();
  }
});

test("end to end: an unchanged Learn is no churn on any later day, however its rows are ordered", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  try {
    await runScript(repo, learn, "2026-10-14");
    const first = repo.schedule();
    const reordered = examsPage({
      scheduled: [MS102],
      retired: [AI102, AZ801, AZ800],
      skills: [AGENT_SKILL],
    });
    learn.state.html.exams = reordered;
    // all of these days are well before MS-102 retires: nothing is due
    for (const day of ["2026-10-15", "2026-10-20", "2026-10-30"]) {
      const result = await runScript(repo, learn, day);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.output, QUIET, day);
      assert.equal(result.schedule, first, `${day}: no churn commit`);
    }
  } finally {
    await learn.close();
  }
});

test("end to end, the real fixtures: today's Learn rows and a consistent hub raise nothing", async () => {
  const repo = await makeRepo();
  const learn = await startLearn({
    exams: examsFixture,
    credentials: credentialsFixture,
  });
  try {
    const result = await runScript(repo, learn, "2026-10-14");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output.changes_found, "false");
    assert.equal(result.output.extraction_failed, "false");
    assert.match(result.stdout, /exams: ok, 10 rows read/);
    assert.match(result.stdout, /credentials: ok, 8 rows read/);
    assert.match(result.stdout, /0 findings open/);
  } finally {
    await learn.close();
  }
});

test("end to end: a retirement Learn lists and the tracker misses opens ONE running issue, then comments", async () => {
  const repo = await makeRepo({
    retiring: [
      E({
        code: "AZ-800",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
      E({
        code: "AZ-801",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
    ],
  });
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    // day 1: MS-102 is on Learn and on the page, but not in retiring-exams.json
    const first = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.output, {
      ...QUIET,
      changes_found: "true",
      baseline_updated: "true",
      issue_title: "Exam retirement schedule: MS-102",
    });
    const open = gh.open(FINDINGS_ISSUE_TITLE);
    assert.equal(open.length, 1);
    assert.deepEqual(open[0].labels, ["enhancement"]);
    assert.match(
      open[0].body,
      /### MS-102: Learn lists a retirement the hub does not track/,
    );
    assert.match(open[0].body, /November 30, 2026/);
    assert.match(open[0].body, /"replacementCode": "AB-650"/);
    assert.equal(first.report, open[0].body);
    assert.deepEqual(Object.keys(JSON.parse(first.schedule).reported), [
      "exam:MS-102:untracked",
    ]);

    // day 2 and 3: the same fact is not reported again
    for (const day of ["2026-10-15", "2026-10-20"]) {
      const quiet = await runScript(repo, learn, day, gh.env);
      assert.equal(quiet.output.changes_found, "false", day);
      assert.equal(
        gh.writes().filter((c) => c.command === "issue comment").length,
        0,
        day,
      );
    }
    // 7 days later: a reminder, as a COMMENT on the same issue
    const reminder = await runScript(repo, learn, "2026-10-21", gh.env);
    assert.equal(reminder.output.changes_found, "true");
    assert.equal(gh.issues().length, 1, "never a second issue");
    assert.equal(gh.issues()[0].comments.length, 1);
    assert.match(
      gh.issues()[0].comments[0],
      /_Reminder: reported before and still open\._/,
    );

    // the maintainer adds the entry: the issue closes itself on the next run
    await repo.setExams([
      E({
        code: "AZ-800",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
      E({
        code: "AZ-801",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
      E(),
    ]);
    const fixed = await runScript(repo, learn, "2026-10-22", gh.env);
    assert.equal(fixed.output.changes_found, "false");
    assert.equal(gh.open().length, 0);
    const closed = gh.issues()[0];
    assert.equal(closed.state, "closed");
    assert.match(closed.comments.at(-1), /agree as of 2026-10-22/);
    assert.deepEqual(JSON.parse(fixed.schedule).reported, {});
  } finally {
    await learn.close();
  }
});

test("end to end: Learn moves a date, and a tracked retirement that vanishes from Learn is flagged", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    // Microsoft pushes MS-102 to January 2027
    learn.state.html.exams = examsPage({
      scheduled: [[...MS102.slice(0, 2), "January 31, 2027", MS102[3]]],
      retired: [AZ800, AZ801, AI102],
      skills: [AGENT_SKILL],
    });
    learn.state.html.credentials = credentialsPage({
      scheduled: [[MS102[1], "January 31, 2027", MS102[3]]],
      retired: [certRow(AZ800), certRow(AI102)],
      skillsRetired: [AGENT_SKILL],
    });
    const moved = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(moved.output.changes_found, "true");
    assert.match(
      gh.open(FINDINGS_ISSUE_TITLE)[0].body,
      /### MS-102: the retirement date differs from Learn[\s\S]*January 31, 2027[\s\S]*`2026-11-30`/,
    );

    // later it disappears from both tables entirely
    learn.state.html.exams = examsPage({
      retired: [AZ800, AZ801, AI102],
      skills: [AGENT_SKILL],
    });
    learn.state.html.credentials = credentialsPage({
      retired: [certRow(AZ800), certRow(AI102)],
      skillsRetired: [AGENT_SKILL],
    });
    // the maintainer had already moved the tracker to January
    await repo.setExams(
      JSON.parse(readFileSync(repo.env.EXAMS_FILE, "utf8")).exams.map((e) =>
        e.code === "MS-102" ? { ...e, retirementDate: "2027-01-31" } : e,
      ),
    );
    const dropped = await runScript(repo, learn, "2026-10-16", gh.env);
    assert.equal(dropped.output.changes_found, "true");
    const comment = gh.issues()[0].comments.at(-1);
    assert.match(
      comment,
      /### MS-102: Learn no longer lists a tracked retirement/,
    );
  } finally {
    await learn.close();
  }
});

test("end to end: a new certification row no exam maps to is announced once, and never at the baseline", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  const base = {
    retired: [certRow(AZ800), certRow(AI102)],
    skillsRetired: [AGENT_SKILL],
  };
  const first = [
    "Microsoft Certified: Brand New Cert",
    "March 31, 2027",
    "brand-new-cert",
  ];
  const second = [
    "Microsoft Certified: Other New Cert",
    "April 30, 2027",
    "other-new-cert",
  ];
  try {
    // the baseline day: the unmapped row is already there and is recorded silently
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), first],
      ...base,
    });
    const baseline = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.deepEqual(baseline.output, { ...QUIET, baseline_updated: "true" });
    assert.equal(gh.issues().length, 0);

    // a second one appears: ONE new issue, with the row and what to do
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), first, second],
      ...base,
    });
    const announced = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(announced.code, 0, announced.stderr);
    assert.deepEqual(announced.output, {
      ...QUIET,
      changes_found: "true",
      baseline_updated: "true",
      issue_title:
        "Microsoft Learn announced a retirement: Microsoft Certified: Other New Cert",
    });
    assert.equal(gh.issues().length, 1);
    assert.deepEqual(gh.issues()[0].labels, ["enhancement"]);
    assert.match(
      gh.issues()[0].body,
      /\| Certifications scheduled to retire \| Microsoft Certified: Other New Cert \| April 30, 2027 \|/,
    );
    assert.ok(
      !gh.issues()[0].body.includes("Brand New Cert"),
      "the baseline row is not announced",
    );
    assert.match(
      announced.stdout,
      /1 new retirement row no exam could be mapped to\./,
    );
    assert.match(announced.summary, /new rows no exam maps to: 1/);
    assert.equal(announced.report, gh.issues()[0].body);

    // recorded: the next days say nothing
    for (const day of ["2026-10-16", "2026-10-17"]) {
      const quiet = await runScript(repo, learn, day, gh.env);
      assert.equal(quiet.output.changes_found, "false", day);
    }
    assert.equal(gh.issues().length, 1);

    // the row moves to another date: announced again, as the change it is
    learn.state.html.credentials = credentialsPage({
      scheduled: [
        certRow(MS102),
        first,
        [second[0], "May 31, 2027", second[2]],
      ],
      ...base,
    });
    const moved = await runScript(repo, learn, "2026-10-18", gh.env);
    assert.equal(moved.output.changes_found, "true");
    assert.match(gh.issues()[1].body, /May 31, 2027/);
  } finally {
    await learn.close();
  }
});

test("end to end: a retirement row without a link is announced once, not on every run until Learn drops it", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  const base = {
    retired: [certRow(AZ800), certRow(AI102)],
    skillsRetired: [AGENT_SKILL],
  };
  // Learn lists these in plain text: the name cell has no link, so there is no address
  const unlinked = ["Microsoft Certified: Unlinked Cert", "March 31, 2027", ""];
  const another = [
    "Microsoft Certified: Another Unlinked Cert",
    "April 30, 2027",
    "",
  ];
  try {
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), unlinked],
      ...base,
    });
    const baseline = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.deepEqual(baseline.output, { ...QUIET, baseline_updated: "true" });
    // stored with no code and no address: there are none
    assert.deepEqual(
      JSON.parse(baseline.schedule).rows.find((row) =>
        row.name.includes("Unlinked"),
      ),
      {
        source: "credentials",
        kind: "certification",
        status: "scheduled",
        name: unlinked[0],
        date: "2027-03-31",
      },
    );

    // the days after: not new again, nothing announced, nothing written, no issue
    for (const day of ["2026-10-15", "2026-10-16", "2026-10-17"]) {
      const quiet = await runScript(repo, learn, day, gh.env);
      assert.equal(quiet.code, 0, quiet.stderr);
      assert.deepEqual(quiet.output, QUIET, day);
      assert.equal(quiet.report, null, day);
      assert.equal(quiet.schedule, baseline.schedule, day);
    }
    assert.equal(gh.issues().length, 0, "no announcement for a recorded row");

    // a second unlinked row appears: announced once, and quiet again afterwards
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), unlinked, another],
      ...base,
    });
    const announced = await runScript(repo, learn, "2026-10-18", gh.env);
    assert.deepEqual(announced.output, {
      ...QUIET,
      changes_found: "true",
      baseline_updated: "true",
      issue_title:
        "Microsoft Learn announced a retirement: Microsoft Certified: Another Unlinked Cert",
    });
    assert.equal(gh.issues().length, 1);
    assert.ok(!gh.issues()[0].body.includes(unlinked[0]));
    for (const day of ["2026-10-19", "2026-10-20"]) {
      const quiet = await runScript(repo, learn, day, gh.env);
      assert.deepEqual(quiet.output, QUIET, day);
    }
    assert.equal(gh.issues().length, 1, "announced once, not on every run");
  } finally {
    await learn.close();
  }
});

test("run twice: a certification row without a link is not new on the second run", async () => {
  const repo = await makeRepo();
  const html = {
    exams: defaultExamsHtml(),
    credentials: credentialsPage({
      scheduled: [
        certRow(MS102),
        ["Microsoft Certified: Unlinked Cert", "March 31, 2027", ""],
      ],
      retired: [certRow(AZ800), certRow(AI102)],
      skillsRetired: [AGENT_SKILL],
    }),
  };
  const fetchImpl = async (url) =>
    fakeResponse(
      200,
      html[PAGES.find((p) => url.endsWith(p.path)).id],
      {},
      url,
    );
  const cfg = (today) => ({ ...repo.cfg({ TODAY: today }), fetchImpl });

  const first = await run(cfg("2026-10-14"));
  assert.equal(first.existed, false);
  assert.deepEqual(first.announcements, []);
  await repo.setSchedule(scheduleContent(first.nextSchedule));

  for (const day of ["2026-10-15", "2026-10-16"]) {
    const again = await run(cfg(day));
    assert.equal(again.existed, true);
    assert.deepEqual(again.announcements, [], day);
    assert.equal(again.scheduleChanged, false, day);
  }
});

// What an older extraction's file looks like next to today's Learn: 30 rows the exams
// page does not list (the failsafe would stop the page), MS-102 scheduled there (a
// vanished retirement), and no row for the new certification (an announcement).
const olderSchedule = () =>
  JSON.stringify({
    lastSynced: "2026-10-01",
    failures: {},
    reported: {},
    rows: [
      ...Array.from({ length: 30 }, (_, i) =>
        storedRow(
          "exams",
          R({ code: `OLD-${100 + i}`, status: "retired", date: "2026-06-30" }),
        ),
      ),
      storedRow("exams", R({ code: "MS-102" })),
    ],
  });
const nowOnLearn = () => ({
  exams: examsPage({ retired: [AZ800, AZ801, AI102] }),
  credentials: credentialsPage({
    scheduled: [
      ["Microsoft Certified: Brand New Cert", "March 31, 2027", "brand-new"],
    ],
    retired: [certRow(AZ800), certRow(AI102)],
  }),
});

test("end to end: a schedule from another format is re-baselined silently, with no announcement, finding or failsafe", async () => {
  const repo = await makeRepo({ schedule: olderSchedule() });
  const learn = await startLearn(nowOnLearn());
  const gh = await withIssues(repo);
  try {
    const first = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.output, { ...QUIET, baseline_updated: "true" });
    assert.equal(first.report, null);
    assert.equal(gh.writes().length, 0, "no issue, comment or label");
    assert.match(
      first.stdout,
      /schedule tracker is in format 0, this script writes 1: its rows are recorded again, silently/,
    );
    assert.match(first.summary, /was in format 0, this script writes 1/);
    assert.doesNotMatch(first.stderr, /restructured/);

    // the file is in today's format with today's rows, and nothing of the old ones
    const stored = JSON.parse(first.schedule);
    assert.equal(stored.format, SCHEDULE_FORMAT);
    assert.equal(stored.lastSynced, "2026-10-14");
    assert.deepEqual(stored.failures, {});
    assert.ok(stored.rows.every((row) => !row.code?.startsWith("OLD-")));
    assert.deepEqual(
      stored.rows.map((row) => row.code ?? row.slug).sort(),
      [
        "AI-102",
        "AZ-800",
        "AZ-801",
        "azure-ai-engineer",
        "brand-new",
        "windows-server-hybrid-administrator",
      ].sort(),
    );

    // from then on it is an ordinary tracker
    const next = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.deepEqual(next.output, QUIET);
    assert.equal(next.schedule, first.schedule);
    assert.ok(!/in format/.test(next.stdout));
    assert.equal(gh.writes().length, 0);
  } finally {
    await learn.close();
  }
});

test("end to end: a page that cannot be read on the day of a format change is recorded silently once it can", async () => {
  const repo = await makeRepo({ schedule: olderSchedule() });
  const learn = await startLearn(nowOnLearn());
  const gh = await withIssues(repo);
  try {
    learn.state.status.exams = 503;
    const down = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(down.code, 0, down.stderr);
    assert.deepEqual(down.output, { ...QUIET, baseline_updated: "true" });
    const stored = JSON.parse(down.schedule);
    assert.equal(stored.format, SCHEDULE_FORMAT);
    // rows of the other format are not kept for a page nobody could read
    assert.deepEqual(
      stored.rows.filter((row) => row.source === "exams"),
      [],
    );
    assert.equal(stored.failures.exams.runs, 1);

    // it reads again: nothing to compare with, so nothing is announced and no failsafe trips
    learn.state.status.exams = 200;
    const back = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.deepEqual(back.output, { ...QUIET, baseline_updated: "true" });
    assert.equal(gh.writes().length, 0);
    const healed = JSON.parse(back.schedule);
    assert.deepEqual(healed.failures, {});
    assert.equal(healed.rows.filter((row) => row.source === "exams").length, 3);
  } finally {
    await learn.close();
  }
});

test("end to end: a forced baseline announces nothing, records the new row, and the next normal run stays quiet about it", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  const base = {
    retired: [certRow(AZ800), certRow(AI102)],
    skillsRetired: [AGENT_SKILL],
  };
  const known = [
    "Microsoft Certified: Brand New Cert",
    "March 31, 2027",
    "brand-new-cert",
  ];
  const appeared = [
    "Microsoft Certified: Other New Cert",
    "April 30, 2027",
    "other-new-cert",
  ];
  try {
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), known],
      ...base,
    });
    await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(gh.issues().length, 0);

    // A row appears, and the maintainer accepts the page as it is (FORCE_BASELINE):
    // the row is recorded, nothing is announced about it.
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), known, appeared],
      ...base,
    });
    const forced = await runScript(repo, learn, "2026-10-15", {
      ...gh.env,
      FORCE_BASELINE: "1",
    });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.output.changes_found, "false");
    assert.equal(forced.output.baseline_updated, "true");
    assert.equal(gh.issues().length, 0, "no announcement on a forced baseline");
    assert.ok(
      JSON.parse(forced.schedule).rows.some((row) =>
        row.name.includes("Other New Cert"),
      ),
      "the row was recorded",
    );
    assert.doesNotMatch(forced.stdout, /new retirement row/);

    // Recorded, so a normal run the next day has nothing to announce either.
    const next = await runScript(repo, learn, "2026-10-16", gh.env);
    assert.equal(next.output.changes_found, "false");
    assert.equal(gh.issues().length, 0);
  } finally {
    await learn.close();
  }
});

test("end to end: a failed announcement issue loses nothing, the next run announces it", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  const base = {
    retired: [certRow(AZ800), certRow(AI102)],
    skillsRetired: [AGENT_SKILL],
  };
  const fresh = [
    "Microsoft Certified: Brand New Cert",
    "March 31, 2027",
    "brand-new-cert",
  ];
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    const stored = repo.schedule();
    learn.state.html.credentials = credentialsPage({
      scheduled: [certRow(MS102), fresh],
      ...base,
    });
    gh.env.FAKE_GH_FAIL = "issue create";
    const failed = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(failed.code, 1);
    assert.equal(failed.output.baseline_updated, "false");
    assert.equal(
      failed.schedule,
      stored,
      "the row was not recorded, so it is still new",
    );
    gh.env.FAKE_GH_FAIL = "";
    const retry = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(retry.code, 0, retry.stderr);
    assert.match(retry.output.issue_title, /Brand New Cert/);
  } finally {
    await learn.close();
  }
});

test("end to end: the notification and the tracker write are ordered the same way", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    const before = repo.exams();
    gh.env.FAKE_GH_FAIL = "issue create";
    const failed = await runScript(repo, learn, "2026-12-01", gh.env);
    assert.equal(failed.code, 1);
    assert.equal(
      failed.exams,
      before,
      "notified was not recorded, so the notification is sent again",
    );
    gh.env.FAKE_GH_FAIL = "";
    const retry = await runScript(repo, learn, "2026-12-01", gh.env);
    assert.equal(retry.output.changes_found, "true");
    assert.equal(
      JSON.parse(retry.exams).exams.find((e) => e.code === "MS-102").notified,
      true,
    );
  } finally {
    await learn.close();
  }
});

test("end to end: the notification after the date, confirmed against Learn, exactly once", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    // the day itself: not retired yet, so nothing is raised (no reminder before the date)
    const onTheDay = await runScript(repo, learn, "2026-11-30", gh.env);
    assert.equal(onTheDay.output.issue_title, "");
    assert.equal(
      gh.issues().filter((i) => /notification|approaching/.test(i.title))
        .length,
      0,
    );
    assert.equal(
      JSON.parse(onTheDay.exams).exams.find((e) => e.code === "MS-102")
        .notified,
      false,
    );

    learn.state.html.exams = examsPage({
      retired: [MS102, AZ800, AZ801, AI102],
      skills: [AGENT_SKILL],
    });
    learn.state.html.credentials = credentialsPage({
      retired: [certRow(MS102), certRow(AZ800), certRow(AI102)],
      skillsRetired: [AGENT_SKILL],
    });
    const after = await runScript(repo, learn, "2026-12-01", gh.env);
    assert.equal(after.code, 0, after.stderr);
    assert.deepEqual(after.output, {
      ...QUIET,
      changes_found: "true",
      baseline_updated: "true",
      issue_title: "Exam retirement notification: MS-102",
    });
    const entry = JSON.parse(after.exams).exams.find(
      (e) => e.code === "MS-102",
    );
    assert.equal(entry.notified, true);
    assert.equal(entry.notifiedAt, "2026-12-01");
    const issue = gh.issues().find((i) => /notification/.test(i.title));
    assert.match(
      issue.body,
      /\| MS-102 \| Microsoft 365 Administrator \| 2026-11-30 \| AB-650 \|/,
    );
    assert.match(
      issue.body,
      /Learn: listed as retired on November 30, 2026 \(same date as the tracker\)\./,
    );
    // the badge is still RETIRING after the date: the issue says to switch it
    assert.match(
      issue.body,
      /badge RETIRED in `exam-status.mjs`: \*\*missing\*\* \(it says `RETIRING`\)/,
    );
    assert.match(
      issue.body,
      /switch it from `RETIRING` to `RETIRED` in `src\/data_files\/exam-status\.mjs`/,
    );
    // and never again
    const later = await runScript(repo, learn, "2026-12-02", gh.env);
    assert.equal(later.output.changes_found, "false");
    assert.equal(
      gh.issues().filter((i) => /notification/.test(i.title)).length,
      1,
    );
  } finally {
    await learn.close();
  }
});

test("end to end: the issue comes BEFORE the trackers are written, and a failed issue loses nothing", async () => {
  const repo = await makeRepo({
    retiring: [
      E({
        code: "AZ-800",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
    ],
  });
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    gh.env.FAKE_GH_FAIL = "issue create";
    const failed = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(failed.code, 1);
    assert.equal(failed.output.extraction_failed, "true");
    assert.equal(
      failed.output.baseline_updated,
      "false",
      "the workflow's commit step is skipped",
    );
    assert.equal(failed.schedule, null, "no tracker was written");
    assert.match(failed.stderr, /gh issue create failed/);
    assert.match(failed.stderr, /Could not write the failure issue/);

    // gh recovers: the same finding is reported on the next run
    gh.env.FAKE_GH_FAIL = "";
    const retry = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(retry.output.changes_found, "true");
    assert.equal(gh.open(FINDINGS_ISSUE_TITLE).length, 1);
    assert.ok(retry.schedule);
  } finally {
    await learn.close();
  }
});

test("end to end: a page that fails only warns, keeps the old rows and never creates a finding", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    const baseline = JSON.parse(repo.schedule());
    learn.state.status.exams = 503;
    const down = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.output.changes_found, "false");
    assert.equal(down.output.extraction_failed, "false");
    assert.match(
      down.stderr,
      /WARNING: .*exams.*failed.*could not be fetched \(HTTP 503\)/,
    );
    assert.equal(learn.state.hits.exams, 1 + 2, "retried once");
    const after = JSON.parse(down.schedule);
    assert.deepEqual(after.rows, baseline.rows, "the previous rows are kept");
    assert.deepEqual(after.failures, {
      exams: { runs: 1, since: "2026-10-15", last: "2026-10-15" },
    });
    assert.match(down.summary, /\*\*failed\*\*, 0 rows/);
    assert.equal(gh.writes().length, 0, "one bad day raises no issue");
  } finally {
    await learn.close();
  }
});

test("end to end: three bad days in a row raise ONE issue, a comment follows, and a good read closes it", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    await runScript(repo, learn, "2026-10-14", gh.env);
    learn.state.html.credentials =
      "<html><body>Verify you are human</body></html>";
    const days = [
      "2026-10-15",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ];
    const seen = [];
    for (const day of days) {
      const result = await runScript(repo, learn, day, gh.env);
      assert.equal(result.code, 0, `${day}: ${result.stderr}`);
      seen.push([
        day,
        JSON.parse(result.schedule).failures.credentials.runs,
        gh.open(PAGES_ISSUE_TITLE).length,
        gh.issues().reduce((n, i) => n + i.comments.length, 0),
      ]);
    }
    assert.deepEqual(seen, [
      ["2026-10-15", 1, 0, 0],
      ["2026-10-15", 1, 0, 0], // a second run on the same day counts once
      ["2026-10-16", 2, 0, 0],
      ["2026-10-17", 3, 1, 0], // the third day creates the issue
      ["2026-10-18", 3, 1, 1], // the streak is frozen, but the issue gets its daily comment
      ["2026-10-19", 3, 1, 2],
    ]);
    const issue = gh.open(PAGES_ISSUE_TITLE)[0];
    assert.deepEqual(issue.labels, ["bug"]);
    assert.match(issue.body, /Credential retirement/);
    assert.match(issue.body, /2026-10-15 \| 3 \|/);
    // text in a public issue loses its angle brackets (see safeText)
    assert.match(issue.body, /no main article/);
    assert.equal(gh.issues().length, 1, "never a second issue");

    // the page works again: the counter is cleared and the issue closes
    learn.state.html.credentials = defaultCredentialsHtml();
    const healed = await runScript(repo, learn, "2026-10-20", gh.env);
    assert.deepEqual(JSON.parse(healed.schedule).failures, {});
    assert.equal(gh.open().length, 0);
    assert.match(gh.issues()[0].comments.at(-1), /read cleanly on 2026-10-20/);
  } finally {
    await learn.close();
  }
});

test("end to end: with both pages down on the first run the monitor still works from the tracker", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    learn.state.status.exams = 500;
    learn.state.status.credentials = 404;
    const result = await runScript(repo, learn, "2026-12-01", gh.env);
    assert.equal(result.code, 0, result.stderr);
    // the notification needs no Learn page
    assert.equal(
      result.output.issue_title,
      "Exam retirement notification: MS-102",
    );
    assert.match(
      gh.issues().find((i) => /notification/.test(i.title)).body,
      /not listed on the retirement pages/,
    );
    const schedule = JSON.parse(result.schedule);
    assert.deepEqual(schedule.rows, []);
    assert.deepEqual(Object.keys(schedule.failures).sort(), [
      "credentials",
      "exams",
    ]);
  } finally {
    await learn.close();
  }
});

test("end to end: a restructured page is not trusted until the baseline is forced", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  const rows = Array.from({ length: 30 }, (_, i) => [
    `AZ-${100 + i}`,
    `Old exam ${i}`,
    "June 30, 2026",
    `old-${i}`,
  ]);
  try {
    learn.state.html.exams = examsPage({ scheduled: [MS102], retired: rows });
    await runScript(repo, learn, "2026-10-14");
    const baseline = repo.schedule();
    // every row is replaced at once
    const renamed = Array.from({ length: 30 }, (_, i) => [
      `AZ-${200 + i}`,
      `New exam ${i}`,
      "June 30, 2026",
      `new-${i}`,
    ]);
    learn.state.html.exams = examsPage({
      scheduled: [MS102],
      retired: renamed,
    });
    const stopped = await runScript(repo, learn, "2026-10-15");
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(
      stopped.stderr,
      /looks restructured: 30 of its 31 current rows disappeared at once and 30 new ones appeared/,
    );
    assert.deepEqual(
      JSON.parse(stopped.schedule).rows,
      JSON.parse(baseline).rows,
    );
    assert.equal(JSON.parse(stopped.schedule).failures.exams.runs, 1);

    const forced = await runScript(repo, learn, "2026-10-16", {
      FORCE_BASELINE: "1",
    });
    assert.equal(forced.code, 0, forced.stderr);
    const rowsNow = JSON.parse(forced.schedule);
    assert.ok(rowsNow.rows.some((r) => r.code === "AZ-200"));
    assert.deepEqual(rowsNow.failures, {});
  } finally {
    await learn.close();
  }
});

test("end to end: a corrupt tracker is ONE failure issue, a comment per failed day, closed by a healthy run", async () => {
  const repo = await makeRepo({ schedule: "{ this is not json" });
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    const first = await runScript(repo, learn, "2026-10-14", gh.env);
    assert.equal(first.code, 1);
    assert.equal(first.output.extraction_failed, "true");
    assert.match(
      first.error,
      /Corrupt retirement-schedule\.json \(invalid JSON\)/,
    );
    assert.equal(
      repo.schedule(),
      "{ this is not json",
      "a corrupt file is never reset",
    );
    assert.equal(gh.open(FAILED_ISSUE_TITLE).length, 1);
    assert.deepEqual(gh.open(FAILED_ISSUE_TITLE)[0].labels, ["bug"]);

    const second = await runScript(repo, learn, "2026-10-15", gh.env);
    assert.equal(second.code, 1);
    assert.equal(gh.issues().length, 1, "no issue per run id");
    assert.equal(gh.issues()[0].comments.length, 1);
    assert.match(gh.issues()[0].comments[0], /failed again on 2026-10-15/);

    // repaired by hand
    await repo.setSchedule(scheduleContent(emptySchedule()));
    const healthy = await runScript(repo, learn, "2026-10-16", gh.env);
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.equal(gh.open().length, 0);
    assert.match(gh.issues()[0].comments.at(-1), /ran normally on 2026-10-16/);
  } finally {
    await learn.close();
  }
});

test("end to end: a broken hand-kept tracker or exam-status file is a failure, not a quiet run", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  try {
    await writeFile(
      repo.env.EXAMS_FILE,
      JSON.stringify({
        exams: [{ code: "MS-102", retirementDate: "30.11.2026" }],
      }),
    );
    const typo = await runScript(repo, learn, "2026-10-14");
    assert.equal(typo.code, 1);
    assert.match(typo.error, /MS-102 has retirementDate "30\.11\.2026"/);
    assert.equal(
      learn.state.hits.exams,
      0,
      "nothing was fetched for a check that cannot run",
    );

    await repo.setExams([E()]);
    await rm(repo.env.EXAM_STATUS_FILE);
    const noStatus = await runScript(repo, learn, "2026-10-14");
    assert.equal(noStatus.code, 1);
    assert.match(noStatus.error, /exam-status\.mjs not found/);
  } finally {
    await learn.close();
  }
});

test("end to end: DRY_RUN touches no issue, but the report and the trackers are written", async () => {
  const repo = await makeRepo({
    retiring: [
      E({
        code: "AZ-800",
        area: "azure",
        retirementDate: "2026-09-30",
        notified: true,
      }),
    ],
  });
  const learn = await startLearn();
  const gh = await withIssues(repo);
  try {
    const result = await runScript(repo, learn, "2026-10-14", {
      ...gh.env,
      DRY_RUN: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.calls().length, 0, "gh was never called");
    assert.match(result.stdout, /Findings issue .* not touched \(DRY_RUN\)/);
    assert.match(result.report, /### MS-102/);
    assert.ok(result.schedule);
  } finally {
    await learn.close();
  }
});

// ---------------------------------------------------------------------------
// The workflow and the repository around it
// ---------------------------------------------------------------------------
const workflowDir = join(root, ".github", "workflows");
const workflow = readFileSync(
  join(workflowDir, "retiring-exam-monitor.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function stepsOf(source) {
  const body = source.split(/^ {4}steps:\n/m)[1] ?? "";
  return body
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => ({
      text,
      name: text.match(/^name: (.*)$/m)?.[1],
      condition: text.match(/^ {8}if: (.*)$/m)?.[1],
    }));
}

test("the workflow is daily, reaches Learn, is never cancelled half way and has a distinct start minute", () => {
  assert.match(workflow, /^ {4}- cron: "0 5 \* \* \*"/m);
  assert.match(
    workflow,
    /^concurrency:\n {2}group: retiring-exam-monitor\n {2}cancel-in-progress: false$/m,
  );
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(
    workflow,
    /permissions:\n {6}contents: write\n {6}issues: write/,
  );
  assert.match(workflow, /timeout-minutes: 10/);

  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (m) => m.slice(1, 6),
    );
  const mine = cron(workflow);
  assert.equal(mine.length, 1);
  for (const name of readdirSync(workflowDir)) {
    if (name === "retiring-exam-monitor.yml" || !name.endsWith(".yml"))
      continue;
    const other = readFileSync(join(workflowDir, name), "utf8");
    if (!/git push/.test(other)) continue;
    for (const schedule of cron(other)) {
      assert.notDeepEqual(
        schedule.slice(0, 2),
        mine[0].slice(0, 2),
        `${name} starts at the same time`,
      );
    }
  }
});

test("the workflow order: check (issues inside), then the commit with its retry loop, no per-run issue steps", () => {
  const steps = stepsOf(workflow);
  const names = steps.map((s) => s.name).filter(Boolean);
  assert.deepEqual(names, [
    "Check Microsoft Learn and the retiring exam tracker",
    "Commit updated retiring exam trackers",
  ]);
  const [check, commit] = steps.filter((s) => s.name);
  assert.match(check.text, /id: check/);
  assert.match(check.text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(check.text, /CREATE_ISSUES: "1"/);
  assert.match(
    check.text,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  assert.match(check.text, /run: node scripts\/retiring-exam-check\.mjs/);

  // no status-check function: a failed check skips the commit
  assert.equal(
    commit.condition,
    "steps.check.outputs.baseline_updated == 'true'",
  );
  assert.ok(!/always\(\)|failure\(\)/.test(commit.text));
  assert.match(
    commit.text,
    /git add src\/data_files\/retiring-exams\.json src\/data_files\/retirement-schedule\.json/,
  );
  assert.match(
    commit.text,
    /for attempt in 1 2 3; do\n\s+git pull --rebase && git push && exit 0/,
  );
  assert.match(commit.text, /git rebase --abort/);
  assert.match(commit.text, /exit 1/);

  // the old one-issue-per-run-id steps are gone
  assert.ok(!/create-issue-from-file/.test(workflow));
  assert.ok(!/github\.run_id/.test(workflow));
  assert.ok(
    workflow.indexOf("Check Microsoft Learn") <
      workflow.indexOf("Commit updated"),
  );
});

test("a manual run can force the baseline, with the wording the failsafe message names", () => {
  const dispatch =
    workflow.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ?? "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/);
  assert.match(dispatch, /^ {8}type: boolean$/m);
  assert.match(dispatch, /^ {8}default: false$/m);
  assert.match(readFileSync(script, "utf8"), /force_baseline/);
});

test("the resync script keeps every RETIRING and RETIRED exam in the tracker, with the notified state it had", async () => {
  const { examStatuses } = await import(
    pathToFileURL(join(root, "src", "data_files", "exam-status.mjs")).href
  );
  const withBadge = Object.entries(examStatuses)
    .flatMap(([area, entries]) =>
      Object.entries(entries).map(([code, badge]) => ({ area, code, badge })),
    )
    .filter(({ badge }) => ["RETIRING", "RETIRED"].includes(badge.text));
  assert.ok(
    withBadge.length > 0,
    "the hub has no retiring or retired exam to resync",
  );
  const dir = await mkdtemp(join(tmpdir(), "retire-sync-"));
  tempDirs.push(dir);
  const out = join(dir, "retiring-exams.json");
  // the tracker as it was: everything notified on a made-up day
  await writeFile(
    out,
    JSON.stringify({
      lastSynced: "2026-09-16",
      exams: withBadge.map(({ area, code }) => ({
        code,
        area,
        name: "Old",
        retirementDate: "2026-09-30",
        notified: true,
        notifiedAt: "2026-10-01",
      })),
    }),
  );
  const run = spawnSync(
    process.execPath,
    [join(root, "scripts", "retiring-exams-sync.mjs")],
    { env: { ...process.env, OUTPUT_FILE: out }, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const synced = JSON.parse(await readFile(out, "utf8")).exams;
  assert.deepEqual(
    synced.map((exam) => exam.code).sort(),
    withBadge.map(({ code }) => code).sort(),
  );
  for (const exam of synced) {
    assert.equal(exam.notified, true, exam.code);
    assert.equal(exam.notifiedAt, "2026-10-01", exam.code);
    assert.match(exam.retirementDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  // the log says which of them are history
  const retired = withBadge.filter(({ badge }) => badge.text === "RETIRED");
  for (const { code } of retired) {
    assert.match(run.stdout, new RegExp(`Found retired exam: ${code}`));
  }
});

test("the resync script keeps the tracker entry of a RETIRED exam whose page gives no date, and drops an exam with no badge, with a warning", () => {
  const source = readFileSync(
    join(root, "scripts", "retiring-exams-sync.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /RETIREMENT_BADGES = new Set\(\["RETIRING", "RETIRED"\]\)/,
  );
  assert.match(source, /so its existing tracker entry is kept as history/);
  assert.match(source, /neither a RETIRING nor a RETIRED badge/);
});

test("the script header documents every environment variable it reads", () => {
  const source = readFileSync(script, "utf8");
  // the header is everything above the first import
  const header = source.slice(0, source.search(/^import /m));
  assert.ok(header.length > 1000, "the script has no header comment");
  const used = new Set(
    [...source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
  );
  for (const name of used) {
    assert.ok(header.includes(name), `${name} is not documented in the header`);
  }
});

test("the monitor writes only the two tracker files and nothing under src/content", () => {
  const source = readFileSync(script, "utf8");
  const writes = [...source.matchAll(/writeFileSync\(([^,]+),/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual([...new Set(writes)].sort(), [
    "cfg.errorFile",
    "cfg.examsFile",
    "cfg.reportFile",
    "cfg.scheduleFile",
  ]);
});

test("a quiet run never leaves stray files next to the trackers", async () => {
  const repo = await makeRepo();
  const learn = await startLearn();
  try {
    await runScript(repo, learn, "2026-10-14");
    const files = readdirSync(repo.dir)
      .filter((f) => !["docs", "fake-gh.mjs"].includes(f))
      .sort();
    assert.deepEqual(files, [
      "exam-status.mjs",
      "output",
      "retirement-schedule.json",
      "retiring-exams.json",
      "summary.md",
    ]);
  } finally {
    await learn.close();
  }
});

test("reading a fixture back: the stored rows round-trip through the tracker format", async () => {
  const exams = parseRetirementPage(examsFixture, EXAMS_PAGE);
  const creds = parseRetirementPage(credentialsFixture, CREDENTIALS_PAGE);
  const rows = sortRows([
    ...exams.rows.map((r) => storedRow("exams", r)),
    ...creds.rows.map((r) => storedRow("credentials", r)),
  ]);
  const text = scheduleContent({
    lastSynced: "2026-10-14",
    format: SCHEDULE_FORMAT,
    failures: {},
    reported: {},
    rows,
  });
  const back = normalizeSchedule(JSON.parse(text));
  assert.equal(scheduleContent(back), text);
  // the file holds rows and counters, no Learn text beyond names and dates
  assert.ok(!/learn\.microsoft\.com/.test(text));
  assert.equal(readFileSync(script, "utf8").includes("readFile("), false);
  assert.equal(typeof readFile, "function");
});
