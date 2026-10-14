import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import * as monitor from "../../scripts/voucher-review-check.mjs";
import {
  FAILED_ISSUE_LABEL,
  FAILED_ISSUE_TITLE,
  REVIEW_ISSUE_LABEL,
  REVIEW_ISSUE_TITLE,
  ReviewError,
  betaAnnouncementFindings,
  buildIssueTitle,
  buildReport,
  daysBetween,
  emptyTracker,
  examFinding,
  examPageOf,
  isBetaVoucherPage,
  isRealIsoDate,
  loadBetaExams,
  loadConfig,
  loadTracker,
  normalizeTracker,
  pageFindings,
  parseFrontmatter,
  readSidebarSlugs,
  readTracker,
  selectReports,
  syncFailureIssue,
  syncIssue,
  syncReviewIssue,
  trackedBetaExams,
  trackerContent,
} from "../../scripts/voucher-review-check.mjs";
import { PENDING_ANNOUNCEMENT_DAYS } from "../../scripts/lib/beta-note.mjs";
import {
  examCode,
  voucherDate,
  voucherReviewFields,
} from "../../src/utils/voucher-fields.ts";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "voucher-review-check.mjs");

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Dates and frontmatter
// ---------------------------------------------------------------------------
test("dates must be real YYYY-MM-DD days, and passing is counted in whole UTC days", () => {
  for (const good of ["2026-10-31", "2024-02-29", "2026-01-01"]) {
    assert.ok(isRealIsoDate(good), good);
  }
  for (const bad of [
    "2026-02-31",
    "2026-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-1-5",
    "26-10-31",
    "2026-10-31T00:00:00Z",
    "October 31, 2026",
    "soon",
    "",
    undefined,
    null,
    20261031,
  ]) {
    assert.ok(!isRealIsoDate(bad), String(bad));
  }
  assert.equal(daysBetween("2026-10-12", "2026-10-14"), 2);
  assert.equal(daysBetween("2026-10-14", "2026-10-14"), 0);
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 3);
  assert.equal(daysBetween("2026-10-14", "2026-10-12"), -2);
});

test("the frontmatter reader copes with quotes, comments, CRLF, a BOM and nested keys", () => {
  const source = [
    "﻿---",
    'title: "GitHub Universe 2026 - GH-700"',
    "description: 'It''s a test: with a colon'",
    'voucherCategory: "Special"',
    "voucherEnds: 2026-10-21 # official end",
    'reviewBy: "2026-12-01"',
    "linkedExam: GH-700",
    "draft: true",
    "hero:",
    "  title: nested",
    "  tagline: should not leak",
    "---",
    "",
    "title: not frontmatter",
  ]
    .join("\r\n")
    .concat("\r\n");
  const fields = parseFrontmatter(source);
  assert.equal(fields.title, "GitHub Universe 2026 - GH-700");
  assert.equal(fields.description, "It's a test: with a colon");
  assert.equal(fields.voucherCategory, "Special");
  assert.equal(fields.voucherEnds, "2026-10-21");
  assert.equal(fields.reviewBy, "2026-12-01");
  assert.equal(fields.linkedExam, "GH-700");
  assert.equal(fields.draft, "true");
  assert.equal(fields.tagline, undefined, "nested keys are not top level");

  assert.equal(parseFrontmatter("No frontmatter here\n"), null);
  assert.equal(parseFrontmatter("title: x\n---\nbody"), null);
  // An empty value is present but empty, not absent.
  assert.equal(parseFrontmatter("---\nvoucherEnds:\n---\n").voucherEnds, "");
  // A hash inside a word is not a comment (C# stays C#).
  assert.equal(
    parseFrontmatter("---\ntitle: C# basics\n---\n").title,
    "C# basics",
  );
});

test("an unquoted midnight timestamp is read as the day it names, and any other time of day stays as written", () => {
  const read = (value, eol = "\n") =>
    parseFrontmatter(
      ["---", "title: T", `voucherEnds: ${value}`, "---", "body", ""].join(eol),
    ).voucherEnds;
  for (const value of [
    "2026-10-31T00:00:00Z",
    "2026-10-31 00:00:00",
    "2026-10-31T00:00:00",
    "2026-10-31T00:00:00.000Z",
    "2026-10-31 00:00:00.0",
    "2026-10-31T00:00:00Z # official end",
    "2026-10-31 00:00:00   # a comment",
  ]) {
    assert.equal(read(value), "2026-10-31", value);
    assert.equal(read(value, "\r\n"), "2026-10-31", `${value} with CRLF`);
  }
  // Another time of day, a quoted timestamp (a string for YAML) and the rest
  // are no day, so the date check reports them.
  for (const value of [
    "2026-10-31T10:00:00Z",
    "2026-10-31T00:00:01Z",
    "2026-10-31 00:01:00",
    "2026-10-31T00:00:00.5Z",
    "2026-10-31T00:00:00+02:00",
    '"2026-10-31T00:00:00Z"',
    "'2026-10-31 00:00:00'",
    "2026-10-31T00:00:00Zjunk",
  ]) {
    const unquoted = value.replace(/^["']|["']$/g, "");
    assert.equal(read(value), unquoted, value);
    assert.ok(!isRealIsoDate(read(value)), value);
  }
});

// ---------------------------------------------------------------------------
// The schema: src/utils/voucher-fields.ts and the real docs collection
// ---------------------------------------------------------------------------
test("the schema and the monitor agree on which dates are valid", () => {
  for (const value of [
    "2026-10-31",
    "2024-02-29",
    "2026-02-31",
    "2026-13-01",
    "2026-1-5",
    "soon",
    "",
    "2026-10-31T00:00:00Z",
  ]) {
    assert.equal(
      voucherDate.safeParse(value).success,
      isRealIsoDate(value),
      JSON.stringify(value),
    );
  }

  // What js-yaml makes of an unquoted date is a Date at UTC midnight.
  const parsed = voucherDate.safeParse(new Date("2026-10-31"));
  assert.ok(parsed.success);
  assert.equal(parsed.data.toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal(
    voucherDate.parse("2026-10-31").toISOString(),
    "2026-10-31T00:00:00.000Z",
    "a quoted date comes out as the same Date",
  );
  // A date with a time of day is not a calendar day.
  assert.ok(!voucherDate.safeParse(new Date("2026-10-31T10:00:00Z")).success);
  assert.ok(!voucherDate.safeParse(new Date("not a date")).success);
  assert.ok(!voucherDate.safeParse(20261031).success);
  assert.ok(!voucherDate.safeParse(null).success);
});

test("the schema and the monitor agree on every way a date or timestamp can be written in the frontmatter, midnight timestamps included", async () => {
  // Astro parses frontmatter with this function (js-yaml underneath): what the
  // schema sees is what it makes of the text, the monitor reads the text itself.
  const { parseFrontmatter: astroFrontmatter } =
    await import("@astrojs/markdown-remark");
  const agree = (value, readAs) => {
    const text = `---\ntitle: T\nvoucherEnds: ${value}\n---\nbody\n`;
    const schemaAccepts = voucherDate.safeParse(
      astroFrontmatter(text).frontmatter.voucherEnds,
    ).success;
    const read = parseFrontmatter(text).voucherEnds;
    assert.equal(read, readAs, `${value}: what the monitor reads`);
    assert.equal(
      isRealIsoDate(read),
      schemaAccepts,
      `${value}: the schema ${schemaAccepts ? "accepts" : "rejects"} it, the monitor ${isRealIsoDate(read) ? "accepts" : "rejects"} it`,
    );
    return schemaAccepts;
  };
  // Written the way a maintainer writes a date or the end of the day before.
  for (const value of [
    "2026-10-31",
    "2026-10-31T00:00:00Z",
    "2026-10-31 00:00:00",
    "2026-10-31T00:00:00",
    "2026-10-31T00:00:00.000Z",
    "2026-10-31 00:00:00 # official end",
    "2026-10-31T00:00:00Z # official end",
    '"2026-10-31"',
    "'2026-10-31'",
  ]) {
    assert.ok(agree(value, "2026-10-31"), `${value} is a day`);
  }
  // Any other time of day is not a calendar day, quoted or not.
  for (const value of [
    "2026-10-31T10:00:00Z",
    "2026-10-31T00:00:01Z",
    "2026-10-31 12:00:00",
    "2026-10-31T00:00:00.5Z",
    "2026-10-31T00:00:00+02:00",
    '"2026-10-31T00:00:00Z"',
    "'2026-10-31 00:00:00'",
    "soon",
    "31/10/2026",
  ]) {
    assert.ok(
      !agree(value, value.replace(/^["']|["']$/g, "")),
      `${value} is not a day`,
    );
  }
});

test("an exam code is two capital letters, a dash and three digits", () => {
  for (const good of ["AB-650", "GH-700", "AZ-104", "MB-335"]) {
    assert.ok(examCode.safeParse(good).success, good);
  }
  for (const bad of [
    "gh-700",
    "GH700",
    "GH-7000",
    "G-700",
    "GH-70",
    " GH-700",
    "",
  ]) {
    assert.ok(!examCode.safeParse(bad).success, JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(voucherReviewFields).sort(), [
    "linkedExam",
    "reviewBy",
    "voucherEnds",
  ]);
});

test("the real docs collection accepts the new fields, stays optional and validates them", async () => {
  // src/content.config.ts imports "astro:content", which only exists inside
  // Astro: stub it so the real schema object can be loaded and exercised.
  register(
    "data:text/javascript," +
      encodeURIComponent(`
        export async function resolve(specifier, context, next) {
          if (specifier === "astro:content") {
            return {
              url: "data:text/javascript,export const defineCollection=(c)=>c",
              shortCircuit: true,
            };
          }
          return next(specifier, context);
        }
      `),
    import.meta.url,
  );
  const { collections } = await import(
    pathToFileURL(join(root, "src", "content.config.ts")).href
  );
  const schema = collections.docs.schema;
  // Astro parses frontmatter with this function (js-yaml underneath).
  const { parseFrontmatter: astroFrontmatter } =
    await import("@astrojs/markdown-remark");
  const parse = (yaml) =>
    schema.safeParse(astroFrontmatter(`---\n${yaml}\n---\nbody`).frontmatter);

  // Absent: the existing pages keep working untouched.
  assert.ok(parse("title: T\nvoucherCategory: 50%").success);
  // Unquoted and quoted dates, and the exam code.
  const full = parse(
    "title: T\nvoucherCategory: Special\nvoucherEnds: 2026-10-31\nreviewBy: '2026-12-01'\nlinkedExam: GH-700",
  );
  assert.ok(full.success, JSON.stringify(full.error?.issues));
  assert.equal(full.data.voucherEnds.toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal(full.data.reviewBy.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(full.data.linkedExam, "GH-700");
  // Malformed values break the build with the message of the field.
  for (const [yaml, field] of [
    ["voucherEnds: soon", "voucherEnds"],
    ["voucherEnds:", "voucherEnds"],
    ['voucherEnds: "2026-02-31"', "voucherEnds"],
    ["voucherEnds: 2026-10-31T10:00:00Z", "voucherEnds"],
    ["reviewBy: 31/10/2026", "reviewBy"],
    ["linkedExam: gh-700", "linkedExam"],
    ["linkedExam: GH700", "linkedExam"],
  ]) {
    const result = parse(`title: T\n${yaml}`);
    assert.ok(!result.success, yaml);
    assert.equal(result.error.issues[0].path[0], field, yaml);
  }
  // The schema stays strict: a misspelt field is still rejected.
  assert.ok(!parse("title: T\nvoucherEnd: 2026-10-31").success);

  // Astro also turns the schema into a JSON schema for editors on every sync
  // (it warns and goes on if that throws): the date transform must not break
  // it, the new fields must show up, and none of them may become required.
  const { z } = await import("astro/zod");
  const jsonSchema = z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date-time";
      }
    },
    io: "input",
  });
  for (const field of ["voucherEnds", "reviewBy", "linkedExam"]) {
    assert.ok(jsonSchema.properties[field], `${field} is in the JSON schema`);
  }
  assert.deepEqual(jsonSchema.required, ["title"]);

  // Every voucher page in the repository passes, whatever fields it has.
  const dir = join(root, "src", "content", "docs", "vouchers");
  for (const name of readdirSync(dir).filter((n) => /\.mdx?$/.test(n))) {
    const result = schema.safeParse(
      astroFrontmatter(readFileSync(join(dir, name), "utf8")).frontmatter,
    );
    assert.ok(
      result.success,
      `${name}: ${JSON.stringify(result.error?.issues)}`,
    );
  }
});

test("the partner certification week page is reviewed after the last event it lists, not after the first", () => {
  // Checked 2026-10-14 against the Fast Lane pages: registration was open for 7
  // of the 10 events, the last ones running to November 27. A review date at the
  // end of the first week would nag every week while most of the page is live.
  const source = readFileSync(
    join(root, "src", "content", "docs", "vouchers", "partnerweek.mdx"),
    "utf8",
  );
  const months = { Oct: 10, Nov: 11, Dec: 12 };
  const ends = [
    ...source.matchAll(
      /<LinkCard title="[^"]*, (Oct|Nov|Dec) (\d+)–(\d+) 2026"/g,
    ),
  ].map(
    ([, month, , last]) =>
      `2026-${String(months[month]).padStart(2, "0")}-${last.padStart(2, "0")}`,
  );
  assert.ok(ends.length >= 8, `only ${ends.length} events found`);
  const lastEvent = ends.sort().at(-1);
  const reviewBy = source.match(/^reviewBy: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  assert.ok(reviewBy, "the page has a reviewBy date");
  assert.ok(
    reviewBy > lastEvent,
    `reviewBy ${reviewBy} is not after the last listed event ${lastEvent}`,
  );
  assert.equal(
    daysBetween(lastEvent, reviewBy),
    1,
    "the day after the last event",
  );
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const TODAY = "2026-10-14";
const page = (fields = {}) => ({
  id: "vouchers/sample",
  slug: "sample",
  path: "src/content/docs/vouchers/sample.mdx",
  title: "Sample",
  draft: false,
  category: "Special",
  voucherEnds: undefined,
  reviewBy: undefined,
  linkedExam: undefined,
  unreadable: "",
  ...fields,
});
const kinds = (findings) => findings.map((finding) => finding.kind);

test("an offer is overdue the day after its end date, not on it", () => {
  assert.deepEqual(
    pageFindings(page({ voucherEnds: "2026-10-14" }), null, TODAY),
    [],
  );
  assert.deepEqual(
    pageFindings(page({ voucherEnds: "2026-12-31" }), null, TODAY),
    [],
  );
  const [ended] = pageFindings(
    page({ voucherEnds: "2026-10-13" }),
    null,
    TODAY,
  );
  assert.equal(ended.kind, "ended");
  assert.equal(ended.signature, "ended:2026-10-13");
  assert.equal(ended.days, 1);
  assert.match(ended.message, /`voucherEnds: 2026-10-13` passed 1 day ago/);

  const [old] = pageFindings(page({ voucherEnds: "2026-09-30" }), null, TODAY);
  assert.equal(old.days, 14);
  assert.match(old.message, /passed 14 days ago/);
});

test("reviewBy and voucherEnds are separate problems with their own signatures", () => {
  const findings = pageFindings(
    page({ voucherEnds: "2026-10-01", reviewBy: "2026-10-10" }),
    null,
    TODAY,
  );
  assert.deepEqual(kinds(findings), ["ended", "review"]);
  assert.deepEqual(
    findings.map((finding) => finding.signature),
    ["ended:2026-10-01", "review:2026-10-10"],
  );
  assert.deepEqual(
    pageFindings(page({ reviewBy: "2026-10-15" }), null, TODAY),
    [],
  );
});

test("a malformed date or exam code is a finding, not a crash and not silence", () => {
  const findings = pageFindings(
    page({ voucherEnds: "soon", reviewBy: "", linkedExam: "gh-700" }),
    null,
    TODAY,
  );
  assert.deepEqual(kinds(findings), [
    "invalid-date",
    "invalid-date",
    "invalid-exam",
  ]);
  assert.match(findings[0].message, /`voucherEnds` is `soon`/);
  assert.match(findings[1].message, /`reviewBy` is empty/);
  assert.match(findings[2].message, /`linkedExam` is `gh-700`/);
  // Rolled-over dates are caught here even though js-yaml accepts them.
  assert.deepEqual(
    kinds(pageFindings(page({ voucherEnds: "2026-02-31" }), null, TODAY)),
    ["invalid-date"],
  );
  assert.deepEqual(
    kinds(
      pageFindings(
        page({ unreadable: "the file has no frontmatter block" }),
        null,
        TODAY,
      ),
    ),
    ["unreadable"],
  );
});

test("an unquoted midnight timestamp is an ordinary date: overdue once it has passed, not an invalid date", () => {
  const readPage = (value) =>
    page({
      voucherEnds: parseFrontmatter(`---\nvoucherEnds: ${value}\n---\n`)
        .voucherEnds,
    });
  const [ended, ...more] = pageFindings(
    readPage("2026-10-13T00:00:00Z"),
    null,
    TODAY,
  );
  assert.equal(ended.kind, "ended");
  assert.equal(ended.signature, "ended:2026-10-13");
  assert.deepEqual(more, []);
  assert.deepEqual(
    pageFindings(readPage("2026-12-31 00:00:00"), null, TODAY),
    [],
  );
  // Another time of day is not a day, in the schema too.
  assert.deepEqual(
    kinds(pageFindings(readPage("2026-10-13T10:00:00Z"), null, TODAY)),
    ["invalid-date"],
  );
});

function examContext({
  statuses = {},
  beta = [],
  retiring = [],
  pages = [],
} = {}) {
  return {
    statuses: new Map(Object.entries(statuses)),
    beta: new Map(beta.map((exam) => [exam.code, exam])),
    retiring: new Map(retiring.map((exam) => [exam.code, exam])),
    hubPages: new Set(pages),
  };
}

test("a linked exam that is still BETA or UPCOMING raises nothing", () => {
  const ctx = examContext({
    statuses: { "AB-650": "BETA", "GH-700": "UPCOMING" },
    beta: [{ code: "AB-650", flaggedGA: false }],
    pages: ["AB-650", "GH-700"],
  });
  assert.equal(examFinding("AB-650", ctx, TODAY), null);
  assert.equal(examFinding("GH-700", ctx, TODAY), null);
});

test("a linked exam that is no longer in beta is reported, whatever replaced the beta status", () => {
  const ctx = examContext({
    statuses: { "AZ-400": "AT RISK" },
    pages: ["AB-650", "AZ-400"],
  });
  const ga = examFinding("AB-650", ctx, TODAY);
  assert.equal(ga.kind, "exam-ga");
  assert.equal(ga.signature, "exam-ga:AB-650");
  assert.match(ga.message, /no longer BETA or UPCOMING in `exam-status.mjs`/);
  assert.doesNotMatch(ga.message, /status:/);
  assert.match(
    examFinding("AZ-400", ctx, TODAY).message,
    /\(status: AT RISK\)/,
  );
});

test("Learn showing GA while the hub still says BETA is its own early signal", () => {
  const ctx = examContext({
    statuses: { "AB-650": "BETA" },
    beta: [{ code: "AB-650", flaggedGA: true, flaggedAt: "2026-10-10" }],
    pages: ["AB-650"],
  });
  const finding = examFinding("AB-650", ctx, TODAY);
  assert.equal(finding.kind, "exam-learn-ga");
  assert.match(
    finding.message,
    /flagged GA on 2026-10-10 in `beta-exams.json`/,
  );
  assert.match(finding.message, /still lists it as BETA/);
});

test("a retiring or retired linked exam names the date and the replacement", () => {
  const ctx = examContext({
    statuses: { "AZ-800": "RETIRING", "MS-102": "RETIRING" },
    retiring: [
      {
        code: "AZ-800",
        retirementDate: "2026-09-30",
        replacementCode: "AZ-802",
      },
      {
        code: "MS-102",
        retirementDate: "2026-11-30",
        replacementCode: "AB-650",
      },
      { code: "AZ-801", retirementDate: "2026-10-14" },
    ],
    pages: ["AZ-800", "MS-102", "AZ-801"],
  });
  const retired = examFinding("AZ-800", ctx, TODAY);
  assert.equal(retired.kind, "exam-retired");
  assert.equal(retired.signature, "exam-retired:AZ-800:2026-09-30");
  assert.match(
    retired.message,
    /retired on 2026-09-30 \(replacement: `AZ-802`\)/,
  );
  assert.match(retired.message, /`retiring-exams.json` and `exam-status.mjs`/);

  const soon = examFinding("MS-102", ctx, TODAY);
  assert.equal(soon.kind, "exam-retiring");
  assert.match(soon.message, /retires on 2026-11-30/);
  // On its retirement day an exam is still retiring, not yet retired.
  assert.equal(examFinding("AZ-801", ctx, TODAY).kind, "exam-retiring");
  // A status without a tracker entry has no date.
  const bare = examFinding(
    "AZ-500",
    examContext({ statuses: { "AZ-500": "RETIRING" }, pages: ["AZ-500"] }),
    TODAY,
  );
  assert.equal(bare.signature, "exam-retiring:AZ-500:");
  assert.match(bare.message, /is marked RETIRING/);
});

test("a linked exam with the RETIRED badge counts as retired", () => {
  const ctx = examContext({
    statuses: { "AZ-800": "RETIRED", "AZ-801": "RETIRED", "AZ-500": "RETIRED" },
    retiring: [
      {
        code: "AZ-800",
        retirementDate: "2026-09-30",
        replacementCode: "AZ-802",
      },
      // the badge is ahead of the date: still retired for the voucher, said so
      { code: "AZ-801", retirementDate: "2026-12-31" },
    ],
    pages: ["AZ-800", "AZ-801", "AZ-500"],
  });
  const retired = examFinding("AZ-800", ctx, TODAY);
  assert.equal(retired.kind, "exam-retired");
  assert.equal(retired.signature, "exam-retired:AZ-800:2026-09-30");
  assert.match(
    retired.message,
    /retired on 2026-09-30 \(replacement: `AZ-802`\)/,
  );
  assert.match(retired.message, /`retiring-exams.json` and `exam-status.mjs`/);

  const ahead = examFinding("AZ-801", ctx, TODAY);
  assert.equal(ahead.kind, "exam-retired");
  assert.equal(ahead.signature, "exam-retired:AZ-801:2026-12-31");
  assert.match(
    ahead.message,
    /is marked RETIRED although its retirement date 2026-12-31 has not passed/,
  );

  // A RETIRED badge without a tracker entry has no date, but it is retired.
  const bare = examFinding("AZ-500", ctx, TODAY);
  assert.equal(bare.kind, "exam-retired");
  assert.equal(bare.signature, "exam-retired:AZ-500:");
  assert.match(bare.message, /is marked RETIRED per `exam-status.mjs`/);

  // The same exam with a RETIRING badge and a future date is still retiring.
  const retiring = examContext({
    statuses: { "AZ-801": "RETIRING" },
    retiring: [{ code: "AZ-801", retirementDate: "2026-12-31" }],
    pages: ["AZ-801"],
  });
  assert.equal(examFinding("AZ-801", retiring, TODAY).kind, "exam-retiring");
});

test("a linked exam without an exam page is a finding, and a retired exam beats it", () => {
  const ctx = examContext({
    pages: ["AB-650"],
    retiring: [{ code: "AZ-204", retirementDate: "2026-07-31" }],
  });
  const unknown = examFinding("XX-123", ctx, TODAY);
  assert.equal(unknown.kind, "exam-unknown");
  assert.match(unknown.message, /`XX-123` has no exam page/);
  // The page of a retired exam may be gone; "retired" is the better answer.
  assert.equal(examFinding("AZ-204", ctx, TODAY).kind, "exam-retired");
});

test("a voucher page that declares nothing is a stable offer: no finding on any day", () => {
  // No voucherEnds, no reviewBy, no linkedExam: nothing is asked of the page,
  // today or in years, with or without the exam files at hand.
  const stable = page();
  const ctx = examContext({ statuses: {}, pages: ["AB-650"] });
  for (const today of [TODAY, "2026-12-31", "2027-01-11", "2030-06-30"]) {
    assert.deepEqual(pageFindings(stable, null, today), [], today);
    assert.deepEqual(pageFindings(stable, ctx, today), [], today);
  }
  // Only a page that cannot be read says something about itself.
  assert.deepEqual(
    kinds(
      pageFindings(
        page({ unreadable: "the file has no frontmatter block" }),
        null,
        TODAY,
      ),
    ),
    ["unreadable"],
  );
});

test("a page that declares only a linkedExam is still reviewed for that exam, and for nothing else", () => {
  const onlyExam = (linkedExam) => page({ linkedExam });
  const ga = examContext({ statuses: {}, pages: ["GH-700"] });
  const beta = examContext({
    statuses: { "GH-700": "BETA" },
    beta: [{ code: "GH-700", flaggedGA: false }],
    pages: ["GH-700"],
  });
  assert.deepEqual(kinds(pageFindings(onlyExam("GH-700"), ga, TODAY)), [
    "exam-ga",
  ]);
  assert.deepEqual(pageFindings(onlyExam("GH-700"), beta, TODAY), []);
  assert.deepEqual(kinds(pageFindings(onlyExam("XX-123"), beta, TODAY)), [
    "exam-unknown",
  ]);
  assert.deepEqual(kinds(pageFindings(onlyExam("gh700"), beta, TODAY)), [
    "invalid-exam",
  ]);
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------
const flaggedPage = (id, signatures) => ({
  page: page({ id, slug: id.split("/")[1] }),
  findings: signatures.map((signature) => ({
    kind: signature.split(":")[0],
    signature,
    message: signature,
  })),
});
const trackerWith = (pages, extra = {}) => ({
  ...emptyTracker(),
  lastSynced: "2026-10-01",
  pages,
  ...extra,
});
const select = (flagged, tracker, today = TODAY, extra = {}) =>
  selectReports({ flagged, tracker, today, reminderDays: 7, ...extra });

test("a page that is not in the tracker is new and is recorded as reported today", () => {
  const { reports, nextPages } = select(
    [flaggedPage("vouchers/a", ["ended:2026-10-13"])],
    trackerWith({}),
  );
  assert.deepEqual(
    reports.map((r) => [r.page.id, r.status, r.firstReported]),
    [["vouchers/a", "new", TODAY]],
  );
  assert.deepEqual(nextPages["vouchers/a"], {
    firstReported: TODAY,
    lastReported: TODAY,
    reasons: ["ended:2026-10-13"],
  });
});

test("the same problem is quiet for six days and comes back as a reminder on the seventh", () => {
  const tracker = trackerWith({
    "vouchers/a": {
      firstReported: "2026-10-07",
      lastReported: "2026-10-08",
      reasons: ["ended:2026-10-06"],
    },
  });
  const flagged = [flaggedPage("vouchers/a", ["ended:2026-10-06"])];
  for (const today of ["2026-10-09", "2026-10-14"]) {
    const { reports, nextPages } = select(flagged, tracker, today);
    assert.equal(reports.length, 0, today);
    assert.deepEqual(nextPages, tracker.pages, `${today}: tracker unchanged`);
  }
  const { reports, nextPages } = select(flagged, tracker, "2026-10-15");
  assert.deepEqual(
    reports.map((r) => [r.status, r.firstReported]),
    [["reminder", "2026-10-07"]],
  );
  assert.equal(nextPages["vouchers/a"].firstReported, "2026-10-07");
  assert.equal(nextPages["vouchers/a"].lastReported, "2026-10-15");
});

test("a new reason or a moved date is reported at once, a vanished reason is not", () => {
  const tracker = trackerWith({
    "vouchers/a": {
      firstReported: "2026-10-13",
      lastReported: "2026-10-13",
      reasons: ["ended:2026-10-12", "exam-ga:AB-650"],
    },
  });
  // Another date (the maintainer extended the offer, and it ended again).
  let result = select(
    [flaggedPage("vouchers/a", ["ended:2026-10-13", "exam-ga:AB-650"])],
    tracker,
  );
  assert.equal(result.reports[0].status, "changed");
  // An additional reason.
  result = select(
    [
      flaggedPage("vouchers/a", [
        "ended:2026-10-12",
        "exam-ga:AB-650",
        "review:2026-10-01",
      ]),
    ],
    tracker,
  );
  assert.equal(result.reports[0].status, "changed");
  // One reason fixed: nothing new, so quiet, but the shorter list is kept so
  // that the old reason counts as new if it comes back.
  result = select([flaggedPage("vouchers/a", ["ended:2026-10-12"])], tracker);
  assert.equal(result.reports.length, 0);
  assert.deepEqual(result.nextPages["vouchers/a"].reasons, [
    "ended:2026-10-12",
  ]);
  assert.equal(result.nextPages["vouchers/a"].lastReported, "2026-10-13");
});

test("a page that is fine again leaves the tracker", () => {
  const tracker = trackerWith({
    "vouchers/a": {
      firstReported: "2026-10-13",
      lastReported: "2026-10-13",
      reasons: ["ended:2026-10-12"],
    },
  });
  assert.deepEqual(select([], tracker).nextPages, {});
});

test("REPORT_ALL reports every open page now, new or not, also on the very first run", () => {
  const tracker = trackerWith({
    "vouchers/a": {
      firstReported: "2026-10-13",
      lastReported: "2026-10-13",
      reasons: ["ended:2026-10-12"],
    },
  });
  const flagged = [
    flaggedPage("vouchers/a", ["ended:2026-10-12"]),
    flaggedPage("vouchers/b", ["review:2026-10-01"]),
  ];
  // Without it the page reported yesterday is quiet.
  assert.deepEqual(
    select(flagged, tracker).reports.map((r) => r.page.id),
    ["vouchers/b"],
  );
  const { reports } = select(flagged, tracker, TODAY, { reportAll: true });
  assert.deepEqual(
    reports.map((r) => [r.page.id, r.status]),
    [
      ["vouchers/a", "reminder"],
      ["vouchers/b", "new"],
    ],
  );
  // A tracker that was never written has nothing earlier to ignore: everything is new.
  assert.deepEqual(
    select(flagged, emptyTracker(), TODAY, { reportAll: true }).reports.map(
      (r) => [r.page.id, r.status],
    ),
    [
      ["vouchers/a", "new"],
      ["vouchers/b", "new"],
    ],
  );
});

test("there is no inventory of pages without a date any more: no selector, no setting, no tracker key", () => {
  assert.equal("selectInventory" in monitor, false);
  const cfg = loadConfig({ INVENTORY_DAYS: "3", TODAY: "2026-10-14" });
  assert.equal("inventoryDays" in cfg, false);
  assert.deepEqual(Object.keys(emptyTracker()), ["lastSynced", "pages"]);
  assert.deepEqual(Object.keys(normalizeTracker({ pages: {} })), [
    "lastSynced",
    "pages",
  ]);
  assert.deepEqual(Object.keys(trackerWith({})), ["lastSynced", "pages"]);
});

// ---------------------------------------------------------------------------
// Beta exam announcements: the exam page note against beta-exams.json
// ---------------------------------------------------------------------------
const ANNOUNCEMENT =
  "https://techcommunity.microsoft.com/blog/skills-hub-blog/example-announcement/1234567?WT.mc_id=studentamb_165290";
// The beta began 8 days before TODAY with no announcement: overdue.
const betaEntry = (extra = {}) => ({
  code: "AZ-401",
  area: "azure",
  betaStart: "2026-10-06",
  announcement: "pending",
  flaggedGA: false,
  ...extra,
});
const betaMap = (entries) =>
  new Map(entries.map((entry) => [entry.code, entry]));
const betaFindings = (entries, { pages = [], today = TODAY } = {}) =>
  betaAnnouncementFindings({ beta: betaMap(entries), pages, today });
const betaKinds = (entries, options) =>
  betaFindings(entries, options).flatMap(({ findings }) => kinds(findings));

test("a pending announcement is overdue from the eighth day after the beta began, not before", () => {
  assert.equal(PENDING_ANNOUNCEMENT_DAYS, 7);
  // TODAY is 2026-10-14: the beta began 7 days ago, which is still the pending window ...
  assert.deepEqual(betaFindings([betaEntry({ betaStart: "2026-10-07" })]), []);
  assert.deepEqual(betaFindings([betaEntry({ betaStart: "2026-10-14" })]), []);
  // ... and 8 days ago the announcement is overdue.
  const [{ page, findings }, ...others] = betaFindings([betaEntry()]);
  assert.deepEqual(others, []);
  assert.equal(page.id, "azure/AZ-401");
  assert.equal(findings.length, 1);
  const [overdue] = findings;
  assert.equal(overdue.kind, "beta-announcement-overdue");
  assert.equal(
    overdue.signature,
    "beta-announcement-overdue:AZ-401:2026-10-06",
  );
  assert.equal(overdue.days, 8);
  assert.match(
    overdue.message,
    /the exam page note of beta exam `AZ-401` still promises the Skills Hub blog announcement "within a few days", 8 days after the beta began on 2026-10-06/,
  );
  assert.match(
    overdue.message,
    /\(`announcement` is `pending`\); check the blog: if the post is out, set `announcement` to its address, run `node scripts\/beta-note\.mjs --code AZ-401 --expects "<wording>"` and add the beta voucher page; if there is none, set `announcement` to `unannounced` and run `node scripts\/beta-note\.mjs --code AZ-401`$/,
  );

  // Every later day it is the same problem (the signature carries the start
  // day only), counted in whole UTC days across a month and a year end.
  const later = betaFindings([betaEntry()], { today: "2026-11-20" })[0];
  assert.equal(later.findings[0].signature, overdue.signature);
  assert.equal(later.findings[0].days, 45);
  const newYear = (today) =>
    betaFindings([betaEntry({ betaStart: "2026-12-28" })], { today });
  assert.deepEqual(newYear("2027-01-04"), [], "day 7");
  assert.equal(newYear("2027-01-05").length, 1, "day 8");
  // A start day in the future is a mistake, not an overdue announcement.
  assert.deepEqual(betaFindings([betaEntry({ betaStart: "2026-11-01" })]), []);
  // Another start day is another signature: the dedupe reports it as new.
  assert.equal(
    betaFindings([betaEntry({ betaStart: "2026-10-01" })])[0].findings[0]
      .signature,
    "beta-announcement-overdue:AZ-401:2026-10-01",
  );
});

test("an announced or unannounced beta exam raises nothing, however long ago the beta began", () => {
  for (const announcement of [ANNOUNCEMENT, "unannounced"]) {
    for (const betaStart of ["2026-10-06", "2026-01-05"]) {
      assert.deepEqual(
        betaFindings([betaEntry({ announcement, betaStart })]),
        [],
        `${announcement} ${betaStart}`,
      );
    }
  }
});

test("a beta exam without a real betaStart or a valid announcement is a finding of its own", () => {
  const missing = [
    [{ betaStart: undefined }, "betaStart"],
    [{ betaStart: "" }, "betaStart"],
    [{ betaStart: null }, "betaStart"],
    [{ betaStart: "2026-02-31" }, "betaStart"],
    [{ betaStart: "soon" }, "betaStart"],
    [{ betaStart: "2026-10-06T00:00:00Z" }, "betaStart"],
    [{ betaStart: 20261006 }, "betaStart"],
    [{ announcement: undefined }, "announcement"],
    [{ announcement: "" }, "announcement"],
    [{ announcement: "soonish" }, "announcement"],
    [{ announcement: "Pending" }, "announcement"],
    [{ announcement: "http://example.test/insecure" }, "announcement"],
    [{ announcement: "https://example.test/a post" }, "announcement"],
    [{ announcement: "https://example.test/(post)" }, "announcement"],
    [{ announcement: 7 }, "announcement"],
  ];
  for (const [extra, field] of missing) {
    const [{ findings }] = betaFindings([betaEntry(extra)]);
    assert.deepEqual(
      kinds(findings),
      ["beta-announcement-missing"],
      JSON.stringify(extra),
    );
    assert.equal(findings[0].signature, "beta-announcement-missing:AZ-401");
    assert.match(
      findings[0].message,
      new RegExp(`\`${field}\` is (missing|\`)`),
      JSON.stringify(extra),
    );
  }
  // An invalid start day cannot date the announcement: no overdue on top of it.
  assert.deepEqual(
    betaKinds([betaEntry({ betaStart: "soon", announcement: "pending" })]),
    ["beta-announcement-missing"],
  );
  // Both fields at once name both problems, once.
  const [{ findings }] = betaFindings([
    betaEntry({ betaStart: undefined, announcement: "later" }),
  ]);
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /`betaStart` is missing, not a date written `YYYY-MM-DD`/,
  );
  assert.match(
    findings[0].message,
    /`announcement` is `later`, not `pending`, `unannounced` or the https address of the announcement/,
  );
  // A value from the file cannot break the table cell.
  const [{ findings: odd }] = betaFindings([
    betaEntry({
      announcement:
        "`x` \n<img src=x onerror=1> and a very long text that goes on and on",
    }),
  ]);
  assert.doesNotMatch(odd[0].message, /\n/);
  assert.ok(odd[0].message.length < 400);
});

test("a BETA voucher page tied to an exam whose announcement is still pending or unannounced is a mismatch", () => {
  const pages = [
    page({
      slug: "betaexam",
      title: "Exam AZ-401 (beta)",
      linkedExam: "AZ-401",
    }),
    page({
      slug: "betaexam",
      title: "Exam AZ-401 (beta)",
      linkedExam: "AZ-401",
    }), // listed twice, counted once
    page({
      slug: "az401-early",
      title: "AZ-401 early access (BETA)",
      linkedExam: "AZ-401",
    }),
    page({
      slug: "githubuniverse2026",
      title: "GitHub Universe 2026 - AZ-401",
      linkedExam: "AZ-401",
    }), // an event voucher that only links the exam: not the beta voucher
    page({ slug: "unrelated" }),
    page({
      slug: "elsewhere",
      title: "Exam GH-700 (beta)",
      linkedExam: "GH-700",
    }),
    page({
      slug: "broken",
      title: "Exam AZ-401 (beta)",
      linkedExam: "az-401",
    }), // not an exam code: invalid-exam, not a link
    page({
      slug: "unreadable",
      title: "Exam AZ-401 (beta)",
      linkedExam: "AZ-401",
      unreadable: "no frontmatter",
    }),
  ];
  for (const announcement of ["pending", "unannounced"]) {
    const [{ page: examPage, findings }] = betaFindings(
      [betaEntry({ announcement, betaStart: "2026-10-12" })],
      { pages },
    );
    assert.equal(examPage.path, "src/content/docs/azure/AZ-401.mdx");
    assert.deepEqual(kinds(findings), ["beta-voucher-mismatch"], announcement);
    assert.equal(findings[0].signature, "beta-voucher-mismatch:AZ-401");
    assert.equal(
      findings[0].message,
      `2 beta voucher pages (\`az401-early\`, \`betaexam\`) are tied to beta exam \`AZ-401\` (\`linkedExam\`), but \`announcement\` is still \`${announcement}\` in \`beta-exams.json\`: the exam page note was not switched`,
    );
  }
  // One page: singular wording.
  const [{ findings: single }] = betaFindings(
    [betaEntry({ betaStart: "2026-10-12" })],
    { pages: [pages[0]] },
  );
  assert.match(
    single[0].message,
    /^1 beta voucher page \(`betaexam`\) is tied to/,
  );
  // Announced: the voucher page is what the note should point to.
  assert.deepEqual(
    betaFindings([betaEntry({ announcement: ANNOUNCEMENT })], { pages }),
    [],
  );
  // No voucher page links the exam, or only other exams: nothing to match.
  const bySlug = (slug) => pages.find((candidate) => candidate.slug === slug);
  assert.deepEqual(
    betaFindings([betaEntry({ betaStart: "2026-10-12" })], {
      pages: [bySlug("unrelated"), bySlug("elsewhere")],
    }),
    [],
  );
  // An overdue pending announcement and a voucher page are two findings of the exam page.
  const [{ findings: both }] = betaFindings([betaEntry()], { pages });
  assert.deepEqual(kinds(both), [
    "beta-announcement-overdue",
    "beta-voucher-mismatch",
  ]);
  // With no usable announcement the state is unknown: missing, never a mismatch.
  assert.deepEqual(
    betaKinds([betaEntry({ announcement: "later" })], { pages }),
    ["beta-announcement-missing"],
  );
});

test("only a page titled (beta), in any case, is a beta voucher page: a voucher that merely links the exam is never a mismatch", () => {
  for (const title of [
    "Exam AZ-401 (beta)",
    "Exam AZ-401 (Beta)",
    "Exam AZ-401 (BETA)",
    "exam az-401 (bEtA)",
    "(beta) AZ-401 voucher",
    "AZ-401 voucher (beta) - 80% off",
  ]) {
    assert.ok(isBetaVoucherPage(page({ title })), title);
  }
  for (const title of [
    "GitHub Universe 2026 - GH-700",
    "Beta Exams",
    "Exam AZ-401 beta",
    "Exam AZ-401 [beta]",
    "Exam AZ-401 (betas)",
    "Exam AZ-401",
    "",
    undefined,
  ]) {
    assert.equal(isBetaVoucherPage(page({ title })), false, String(title));
  }

  // The title is the only difference between a mismatch and silence, for both
  // states in which the exam page note can still be.
  const tied = (title) => [
    page({ slug: "voucher", title, linkedExam: "AZ-401" }),
  ];
  for (const announcement of ["pending", "unannounced"]) {
    const entry = betaEntry({ announcement, betaStart: "2026-10-12" });
    for (const title of [
      "Exam AZ-401 (beta)",
      "Exam AZ-401 (Beta)",
      "Exam AZ-401 (BETA)",
    ]) {
      assert.deepEqual(
        betaKinds([entry], { pages: tied(title) }),
        ["beta-voucher-mismatch"],
        `${announcement}: ${title}`,
      );
    }
    for (const title of [
      "GitHub Universe 2026 - AZ-401",
      "Exam AZ-401 beta",
      "Beta Exams",
    ]) {
      assert.deepEqual(
        betaFindings([entry], { pages: tied(title) }),
        [],
        `${announcement}: ${title}`,
      );
    }
  }
});

test("the shape of githubuniverse2026, an event voucher tied to GH-700 while its announcement is pending, raises nothing on 2026-10-14", () => {
  const universe = page({
    id: "vouchers/githubuniverse2026",
    slug: "githubuniverse2026",
    path: "src/content/docs/vouchers/githubuniverse2026.mdx",
    title: "GitHub Universe 2026 - GH-700",
    category: "Special",
    reviewBy: "2026-10-22",
    linkedExam: "GH-700",
  });
  const gh700 = betaEntry({
    code: "GH-700",
    area: "github",
    betaStart: "2026-10-14",
    announcement: "pending",
  });
  const ctx = examContext({
    statuses: { "GH-700": "BETA" },
    beta: [gh700],
    pages: ["GH-700"],
  });

  // The day the beta began: nothing for the exam page, nothing for the event page.
  assert.deepEqual(
    betaFindings([gh700], { pages: [universe], today: "2026-10-14" }),
    [],
  );
  assert.deepEqual(pageFindings(universe, ctx, "2026-10-14"), []);

  // From day 8 the announcement is overdue and that is all: the event voucher
  // adds no mismatch, before or after its own reviewBy has passed.
  for (const today of ["2026-10-22", "2026-10-23"]) {
    const overdue = betaFindings([gh700], { pages: [universe], today });
    assert.deepEqual(
      overdue.map(({ page: examPage, findings }) => [
        examPage.id,
        kinds(findings),
      ]),
      [["github/GH-700", ["beta-announcement-overdue"]]],
      today,
    );
  }
  // The page keeps being reviewed for what it declares itself.
  assert.deepEqual(kinds(pageFindings(universe, ctx, "2026-10-23")), [
    "review",
  ]);
});

test("nothing is said about an exam Learn flagged GA, whatever its entry says", () => {
  const pages = [
    page({
      slug: "betaexam",
      title: "Exam AZ-401 (beta)",
      linkedExam: "AZ-401",
    }),
  ];
  for (const extra of [
    {},
    { betaStart: undefined, announcement: undefined },
    { announcement: "later" },
    { announcement: "unannounced" },
  ]) {
    assert.deepEqual(
      betaFindings(
        [betaEntry({ flaggedGA: true, flaggedAt: "2026-10-10", ...extra })],
        { pages },
      ),
      [],
      JSON.stringify(extra),
    );
    // The same entry that is not flagged is reported (the entry is the only difference).
    assert.notDeepEqual(
      betaFindings([betaEntry(extra)], { pages }),
      [],
      JSON.stringify(extra),
    );
  }
  // An entry without the flag at all is tracked.
  assert.equal(betaFindings([betaEntry({ flaggedGA: undefined })]).length, 1);
});

test("the beta findings are about the exam page: its path, its address and its tracker key", () => {
  const entries = [
    betaEntry({ code: "GH-700", area: "github", betaStart: "2026-10-01" }),
    betaEntry({ code: "AB-650", area: undefined, betaStart: "2026-10-02" }),
    betaEntry({ code: "AZ-401", area: "nonsense", betaStart: "2026-10-03" }),
    betaEntry({ code: "XX-123", area: undefined, betaStart: "2026-10-04" }),
    betaEntry({ code: "ABC-1234", betaStart: "2026-10-05" }),
    betaEntry({ code: "SC-401", flaggedGA: true }),
  ];
  assert.deepEqual(
    trackedBetaExams(betaMap(entries)).map(([c]) => c),
    ["AB-650", "AZ-401", "GH-700", "XX-123"],
    "sorted by code, GA and invalid codes left out",
  );
  const result = betaFindings(entries);
  assert.deepEqual(
    result.map(({ page: p }) => [p.id, p.path, p.route]),
    [
      [
        "aibusiness/AB-650",
        "src/content/docs/aibusiness/AB-650.mdx",
        "/certs/aibusiness/ab-650/",
      ],
      [
        "azure/AZ-401",
        "src/content/docs/azure/AZ-401.mdx",
        "/certs/azure/az-401/",
      ],
      [
        "github/GH-700",
        "src/content/docs/github/GH-700.mdx",
        "/certs/github/gh-700/",
      ],
      ["<area>/XX-123", "src/content/docs/<area>/XX-123.mdx", ""],
    ],
  );
  assert.deepEqual(examPageOf("MD-102", {}), {
    id: "microsoft365/MD-102",
    kind: "exam",
    slug: "MD-102",
    path: "src/content/docs/microsoft365/MD-102.mdx",
    route: "/certs/microsoft365/md-102/",
    title: "MD-102",
  });
  // Entries that are not objects, and codes in lower case, do not crash it.
  assert.deepEqual(
    betaAnnouncementFindings({
      beta: new Map([
        ["UNDEFINED", undefined],
        ["NULL", null],
        ["AZ-401", betaEntry({ announcement: ANNOUNCEMENT })],
      ]),
      pages: [],
      today: TODAY,
    }),
    [],
  );
});

test("the beta tracker is read on every run and its codes are compared in capitals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voucher-beta-"));
  tempDirs.push(dir);
  const file = join(dir, "beta-exams.json");
  await writeFile(
    file,
    JSON.stringify({
      exams: [betaEntry({ code: "az-401" }), null, { name: "no code" }],
    }),
  );
  const beta = loadBetaExams({ betaExamsFile: file });
  assert.equal(beta.get("AZ-401").announcement, "pending");
  assert.equal(beta.has("az-401"), false);
  await writeFile(file, "{ nope");
  assert.throws(
    () => loadBetaExams({ betaExamsFile: file }),
    (error) =>
      error instanceof ReviewError &&
      /beta-exams\.json could not be read as JSON/.test(error.message) &&
      /announcement state of every beta exam is checked/.test(error.message),
  );
  await writeFile(file, JSON.stringify({ exams: "x" }));
  assert.throws(
    () => loadBetaExams({ betaExamsFile: file }),
    /no "exams" list/,
  );
});

test("the findings of a beta exam follow the dedupe of every other finding: new, quiet for six days, a reminder, new when they change, gone when fixed", () => {
  const entry = betaEntry({ betaStart: "2026-10-06" });
  const flaggedOn = (today, entries = [entry], pages = []) =>
    betaFindings(entries, { pages, today });

  // Day 8: reported, recorded under the exam page.
  const first = select(flaggedOn("2026-10-14"), trackerWith({}), "2026-10-14");
  assert.deepEqual(
    first.reports.map((r) => [r.page.id, r.status, r.firstReported]),
    [["azure/AZ-401", "new", "2026-10-14"]],
  );
  assert.deepEqual(first.nextPages, {
    "azure/AZ-401": {
      firstReported: "2026-10-14",
      lastReported: "2026-10-14",
      reasons: ["beta-announcement-overdue:AZ-401:2026-10-06"],
    },
  });

  // The next six days it is quiet although the count of days in the message
  // moves, and nothing in the tracker changes.
  const tracker = trackerWith(first.nextPages);
  for (const today of ["2026-10-15", "2026-10-20"]) {
    const quiet = select(flaggedOn(today), tracker, today);
    assert.deepEqual(quiet.reports, [], today);
    assert.deepEqual(quiet.nextPages, tracker.pages, today);
  }
  // The seventh day is a reminder with the date of the first report.
  const reminder = select(flaggedOn("2026-10-21"), tracker, "2026-10-21");
  assert.deepEqual(
    reminder.reports.map((r) => [r.status, r.firstReported]),
    [["reminder", "2026-10-14"]],
  );
  assert.equal(reminder.nextPages["azure/AZ-401"].lastReported, "2026-10-21");

  // A beta voucher page appears while the announcement is still pending: a new
  // reason, reported at once.
  const pages = [
    page({
      slug: "betaexam",
      title: "Exam AZ-401 (beta)",
      linkedExam: "AZ-401",
    }),
  ];
  const changed = select(
    flaggedOn("2026-10-16", [entry], pages),
    tracker,
    "2026-10-16",
  );
  assert.deepEqual(
    changed.reports.map((r) => r.status),
    ["changed"],
  );
  assert.deepEqual(changed.nextPages["azure/AZ-401"].reasons, [
    "beta-announcement-overdue:AZ-401:2026-10-06",
    "beta-voucher-mismatch:AZ-401",
  ]);
  // The start day is corrected: another signature, reported at once.
  const moved = select(
    flaggedOn("2026-10-16", [betaEntry({ betaStart: "2026-10-05" })]),
    tracker,
    "2026-10-16",
  );
  assert.deepEqual(
    moved.reports.map((r) => r.status),
    ["changed"],
  );
  // Announced: the exam page leaves the tracker, and a relapse is new again.
  const fixed = select(
    flaggedOn("2026-10-16", [betaEntry({ announcement: ANNOUNCEMENT })]),
    tracker,
    "2026-10-16",
  );
  assert.deepEqual(fixed.reports, []);
  assert.deepEqual(fixed.nextPages, {});
  assert.equal(
    select(flaggedOn("2026-10-30"), trackerWith(fixed.nextPages), "2026-10-30")
      .reports[0].status,
    "new",
  );
});

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------
test("the tracker is validated and written in a fixed order", () => {
  const tracker = normalizeTracker({
    lastSynced: "2026-10-14",
    pages: {
      "vouchers/b": {
        lastReported: "2026-10-14",
        reasons: ["review:2026-10-01", "ended:2026-10-02", "ended:2026-10-02"],
      },
      "vouchers/a": {
        firstReported: "2026-10-10",
        lastReported: "2026-10-14",
        reasons: [],
      },
    },
  });
  assert.deepEqual(Object.keys(tracker.pages), ["vouchers/a", "vouchers/b"]);
  assert.equal(
    tracker.pages["vouchers/b"].firstReported,
    "2026-10-14",
    "a missing firstReported falls back to lastReported",
  );
  assert.deepEqual(tracker.pages["vouchers/b"].reasons, [
    "ended:2026-10-02",
    "review:2026-10-01",
  ]);
  assert.equal(trackerContent(tracker).slice(-2), "}\n");

  for (const corrupt of [
    null,
    [],
    "x",
    {},
    { pages: [] },
    { pages: { a: null } },
    { pages: { a: { lastReported: "2026-10-14", reasons: "x" } } },
    { pages: { a: { reasons: [] } } },
    { pages: {}, lastSynced: "yesterday" },
  ]) {
    assert.throws(
      () => normalizeTracker(corrupt),
      ReviewError,
      JSON.stringify(corrupt),
    );
  }
});

test("a missing tracker file is the first run, a corrupt one is a failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voucher-tracker-"));
  tempDirs.push(dir);
  assert.deepEqual(loadTracker(join(dir, "missing.json")), emptyTracker());
  await writeFile(join(dir, "bad.json"), "{ not json");
  assert.throws(() => loadTracker(join(dir, "bad.json")), /invalid JSON/);
});

test("a tracker written by the older monitor, with a lastInventory, loads without a word and is written back without it", async () => {
  const pages = {
    "vouchers/a": {
      firstReported: "2026-10-10",
      lastReported: "2026-10-14",
      reasons: ["ended:2026-10-09"],
    },
  };
  const legacy = {
    lastSynced: "2026-10-14",
    lastInventory: "2026-10-14",
    pages,
  };
  const tracker = normalizeTracker(legacy);
  assert.deepEqual(tracker, { lastSynced: "2026-10-14", pages });
  assert.equal(
    trackerContent(tracker),
    `${JSON.stringify({ lastSynced: "2026-10-14", pages }, null, 2)}\n`,
  );

  // Whatever the key holds it is not looked at: never an error, never written.
  for (const value of [
    null,
    "2026-10-14",
    "yesterday",
    "",
    7,
    true,
    {},
    [],
    { nested: "x" },
  ]) {
    const loaded = normalizeTracker({ ...legacy, lastInventory: value });
    assert.deepEqual(loaded, tracker, JSON.stringify(value));
    assert.doesNotMatch(trackerContent(loaded), /lastInventory/);
  }
  // trackerContent writes the keys of the format and nothing else, even when
  // it is handed an object that carries more.
  assert.equal(
    trackerContent({
      lastSynced: null,
      lastInventory: "2026-10-14",
      pages: {},
      other: 1,
    }),
    '{\n  "lastSynced": null,\n  "pages": {}\n}\n',
  );

  // From a file: it loads, and readTracker says the file still holds the old
  // key (the run then rewrites it once); the new format and a missing file do not.
  const dir = await mkdtemp(join(tmpdir(), "voucher-legacy-"));
  tempDirs.push(dir);
  const file = join(dir, "tracker.json");
  await writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.deepEqual(readTracker(file), { tracker, legacy: true });
  assert.deepEqual(loadTracker(file), tracker);
  await writeFile(file, trackerContent(tracker));
  assert.deepEqual(readTracker(file), { tracker, legacy: false });
  assert.deepEqual(readTracker(join(dir, "missing.json")), {
    tracker: emptyTracker(),
    legacy: false,
  });
  // The old key does not excuse a tracker that is corrupt otherwise.
  await writeFile(file, JSON.stringify({ lastInventory: "2026-10-14" }));
  assert.throws(() => readTracker(file), ReviewError);
});

// The monitor's workflow commits the tracker as soon as it changes (the first
// alert, or the old key being dropped), so a test of the committed file may
// pin its format and never its content.
function writtenFormatProblem(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "it is not JSON";
  }
  try {
    return trackerContent(normalizeTracker(parsed)) === text
      ? null
      : "it is not in the format the monitor writes";
  } catch (error) {
    return error.message;
  }
}

test("the committed tracker is in the format the monitor writes, whatever it holds", () => {
  const text = readFileSync(
    join(root, "src", "data_files", "voucher-review.json"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.equal(writtenFormatProblem(text), null);
});

test("a tracker that holds flagged pages is in the written format too, and a hand-edited one is not", () => {
  // What the workflow commits after the first alert: not the empty first-run state.
  const flagged = trackerWith({
    "azure/AZ-401": {
      firstReported: "2026-10-22",
      lastReported: "2026-10-22",
      reasons: ["beta-announcement-overdue:AZ-401:2026-10-14"],
    },
    "vouchers/partnerweek": {
      firstReported: "2026-10-14",
      lastReported: "2026-10-21",
      reasons: ["ended:2026-10-12"],
    },
  });
  const text = trackerContent(flagged);
  assert.notEqual(text, trackerContent(emptyTracker()));
  assert.equal(writtenFormatProblem(text), null);
  assert.equal(writtenFormatProblem(trackerContent(emptyTracker())), null);

  for (const [what, edited] of [
    ["not JSON", "{ nope"],
    ["four spaces", `${JSON.stringify(flagged, null, 4)}\n`],
    ["no final newline", text.trimEnd()],
    [
      "pages out of order",
      `${JSON.stringify({ ...flagged, pages: Object.fromEntries(Object.entries(flagged.pages).reverse()) }, null, 2)}\n`,
    ],
    ["an invalid date", text.replace("2026-10-21", "yesterday")],
    [
      "a lastInventory left over from the older monitor",
      text.replace('  "pages"', '  "lastInventory": "2026-10-14",\n  "pages"'),
    ],
  ]) {
    assert.notEqual(writtenFormatProblem(edited), null, what);
  }
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const cfg = loadConfig({ TODAY, SITE_URL: "https://example.test/" });

test("the report names every page, problem and status, and says what to edit", () => {
  const ended = {
    page: page({
      id: "vouchers/partnerweek",
      slug: "partnerweek",
      title: "Partner | Week @octocat #12",
      path: "src/content/docs/vouchers/partnerweek.mdx",
    }),
    findings: pageFindings(page({ voucherEnds: "2026-10-12" }), null, TODAY),
    status: "new",
    firstReported: TODAY,
  };
  const reminder = {
    page: page({ id: "vouchers/beta", slug: "beta", title: "Beta" }),
    findings: [
      { kind: "exam-ga", signature: "exam-ga:AB-650", message: "linked exam" },
    ],
    status: "reminder",
    firstReported: "2026-10-01",
  };
  const body = buildReport({
    cfg,
    today: TODAY,
    reviewed: 9,
    reports: [ended, reminder],
    sidebar: new Set(["partnerweek"]),
  });

  assert.match(body, /^## Voucher review: 2026-10-14/);
  assert.match(
    body,
    /looked at the 9 pages in `src\/content\/docs\/vouchers\/`/,
  );
  assert.match(body, /listed again after 7 days, not every day/);
  assert.match(body, /### Pages that need action \(2\)/);
  assert.match(
    body,
    /\(https:\/\/example\.test\/certs\/vouchers\/partnerweek\/\)<br>`src\/content\/docs\/vouchers\/partnerweek\.mdx`/,
  );
  assert.match(body, /`voucherEnds: 2026-10-12` passed 2 days ago/);
  assert.match(body, /\| new \| yes \|/);
  assert.match(body, /\| reminder \(first reported 2026-10-01\) \| no \|/);
  // Titles cannot break the table, ping users or link issues.
  assert.match(body, /\[Partner Week @​octocat #​12\]/);
  assert.doesNotMatch(body, /Partner \| Week/);

  // What to edit, with what the repo did before.
  assert.match(body, /### What to edit/);
  assert.match(body, /remove\s+`voucherCategory`/);
  assert.match(body, /\(Expired\)/);
  assert.match(body, /`voucherItems` in `src\/data_files\/docs-sidebar.ts`/);
  assert.match(body, /"\/vouchers\/<slug>\/": "\/certs\/vouchers\/"/);
  assert.match(body, /`levelup`/);
  assert.match(body, /`fabricdatadays`/);
  assert.match(body, /For a page with a `linkedExam`/);
  assert.doesNotMatch(
    body,
    /Fix the frontmatter/,
    "only the advice that applies",
  );
  // A date is for a temporary offer: a stable one carries none and is not reviewed.
  assert.match(
    body,
    /\(for a temporary offer with no stated end date, the day to look at it again as `reviewBy: YYYY-MM-DD`\)/,
  );
  assert.match(
    body,
    /If it turned out to be a stable offer \(a standing programme\), take the date fields off the page instead: a page that declares none is not reviewed\./,
  );

  // The review reads only what a page declares: it says so, closes when no
  // page has a problem, and has no list of pages without a date.
  assert.match(
    body,
    /A voucher page is reviewed only for the dates and the linked exam it declares: a stable offer, which declares none, is not asked for anything and is not listed\./,
  );
  assert.match(body, /the review closes it when no page has a problem\./);
  assert.doesNotMatch(
    body,
    /every page has a date|without `voucherEnds`|without a date|inventory/i,
  );
  assert.doesNotMatch(body, /### Pages without/);
  assert.match(body, /Voucher Review Monitor/);
});

test("what to edit for a passed reviewBy: move it for a temporary offer, take it off for a stable one; an unreadable sidebar is unknown", () => {
  const dated = page({ reviewBy: "2026-10-01" });
  const body = buildReport({
    cfg,
    today: TODAY,
    reviewed: 3,
    reports: [
      {
        page: dated,
        findings: pageFindings(dated, null, TODAY),
        status: "new",
        firstReported: TODAY,
      },
    ],
    sidebar: null,
  });
  assert.match(body, /`reviewBy: 2026-10-01` passed 13 days ago/);
  assert.match(
    body,
    /A passed `reviewBy` only means "look again": if the offer is unchanged and still temporary, move `reviewBy` to the next check date; if it turned out to be a stable offer, take `reviewBy` off \(a page without date fields is not reviewed\)\./,
  );
  assert.doesNotMatch(body, /every page|without a date|inventory/i);
  // An unreadable sidebar file is shown as unknown, not as "not in the sidebar".
  assert.match(body, /\| new \| \? \|/);
});

test("the issue title lists the pages that need action, and falls back to a count when it would be long", () => {
  const reports = (slugs) =>
    slugs.map((slug) => ({ page: page({ slug }), findings: [] }));
  assert.equal(
    buildIssueTitle({
      today: TODAY,
      reports: reports(["partnerweek", "githubuniverse2026"]),
    }),
    "Voucher review 2026-10-14: partnerweek, githubuniverse2026",
  );
  const many = Array.from({ length: 12 }, (_, i) => `voucher-page-${i}`);
  const title = buildIssueTitle({ today: TODAY, reports: reports(many) });
  assert.equal(title, "Voucher review 2026-10-14: 12 pages need action");
  assert.doesNotMatch(title, /without a date/);
});

test("the report puts a beta exam in the table as its exam page and says how to settle the announcement", () => {
  const withStatus = (entries, status, firstReported = TODAY) =>
    entries.map((entry) => ({ ...entry, status, firstReported }));
  const betaReports = withStatus(
    betaFindings([betaEntry()], {
      pages: [
        page({
          slug: "betaexam",
          title: "Exam AZ-401 (beta)",
          linkedExam: "AZ-401",
        }),
      ],
    }),
    "new",
  );
  const body = buildReport({
    cfg,
    today: TODAY,
    reviewed: 9,
    reports: betaReports,
    sidebar: new Set(["betaexam"]),
  });
  assert.match(
    body,
    /\| \[AZ-401\]\(https:\/\/example\.test\/certs\/azure\/az-401\/\)<br>`src\/content\/docs\/azure\/AZ-401\.mdx` \| /,
  );
  assert.match(
    body,
    /"within a few days", 8 days after the beta began on 2026-10-06/,
  );
  assert.match(
    body,
    /<br>1 beta voucher page \(`betaexam`\) is tied to beta exam `AZ-401`/,
  );
  // The sidebar lists voucher pages, not exam pages.
  assert.match(body, /\| new \| n\/a \|/);
  // What to edit: the blog, the commands of the beta note, the two outcomes.
  assert.match(body, /### What to edit/);
  assert.match(
    body,
    /\[Skills Hub blog\]\(https:\/\/techcommunity\.microsoft\.com\/category\/skills-hub\/blog\/skills-hub-blog\?WT\.mc_id=studentamb_165290\)/,
  );
  assert.match(body, /\*\*The post is out:\*\* set `announcement`/);
  assert.match(
    body,
    /`node scripts\/beta-note\.mjs --code <CODE> --expects "<Microsoft's go-live wording>"`/,
  );
  assert.match(body, /add the beta voucher page/);
  assert.match(
    body,
    /\*\*There is no post:\*\* set `announcement` to `"unannounced"`/,
  );
  assert.match(
    body,
    /`node scripts\/beta-note\.mjs --code <CODE>`, so the page stops promising a post/,
  );
  assert.match(
    body,
    /For a beta exam whose announcement is overdue or whose beta voucher page exists, open the \[Skills Hub blog\]/,
  );
  assert.match(
    body,
    /A beta voucher page \(its `title` contains `\(beta\)`, as in `Exam <CODE> \(beta\)`\) that is tied to the exam \(`linkedExam`\) while the announcement is still `pending` or `unannounced` stays in this list until `announcement` holds the address of the post: the voucher page is the sign that the post is out\./,
  );
  assert.match(
    body,
    /A voucher page without `\(beta\)` in its title, an event voucher say, is never matched, whatever its `linkedExam`\./,
  );
  assert.doesNotMatch(body, /take `linkedExam` off it/);
  // Only the advice that applies: no offer to end, no frontmatter to fix.
  assert.doesNotMatch(body, /Start from the offer's official source/);
  assert.doesNotMatch(body, /The offer has ended/);
  assert.doesNotMatch(body, /Fix the frontmatter/);
  assert.doesNotMatch(
    body,
    /Every beta exam in `src\/data_files\/beta-exams\.json` needs/,
  );
  assert.match(
    body,
    /looked at the 9 pages in `src\/content\/docs\/vouchers\/`.*Skills Hub announcement of every beta exam in `src\/data_files\/beta-exams\.json`/,
  );

  // A missing field gets its own advice, and a voucher finding keeps the lead-in.
  const mixed = buildReport({
    cfg,
    today: TODAY,
    reviewed: 9,
    reports: [
      ...withStatus(
        betaFindings([betaEntry({ betaStart: undefined })]),
        "reminder",
        "2026-10-07",
      ),
      {
        page: page({ voucherEnds: "2026-10-12" }),
        findings: pageFindings(
          page({ voucherEnds: "2026-10-12" }),
          null,
          TODAY,
        ),
        status: "new",
        firstReported: TODAY,
      },
    ],
    sidebar: null,
  });
  assert.match(
    mixed,
    /Every beta exam in `src\/data_files\/beta-exams\.json` needs `betaStart`/,
  );
  assert.match(mixed, /\| reminder \(first reported 2026-10-07\) \| n\/a \|/);
  assert.match(mixed, /Start from the offer's official source/);
  assert.doesNotMatch(mixed, /\*\*The post is out:\*\*/);

  // The issue title names the exam page by its code.
  assert.equal(
    buildIssueTitle({ today: TODAY, reports: betaReports }),
    "Voucher review 2026-10-14: AZ-401",
  );
  // An exam page of an area that is not known has no address to link.
  const unknown = buildReport({
    cfg,
    today: TODAY,
    reviewed: 1,
    reports: withStatus(
      betaFindings([betaEntry({ code: "XX-123", area: undefined })]),
      "new",
    ),
    sidebar: null,
  });
  const row = unknown.split("\n").find((line) => line.startsWith("| XX-123"));
  assert.ok(row, "the exam page has a row, without a link");
  assert.match(
    row,
    /^\| XX-123<br>`src\/content\/docs\/<area>\/XX-123\.mdx` \|/,
  );
});

test("the sidebar slugs come from the docsPath calls of the voucher group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voucher-sidebar-"));
  tempDirs.push(dir);
  const file = join(dir, "sidebar.ts");
  await writeFile(
    file,
    [
      'href: docsPath("vouchers/partnerweek"),',
      "href: docsPath('vouchers/betaexams/'),",
      'href: docsPath("prepare/labs"),',
      'href: docsPath( "vouchers/microsoftesi" ),',
    ].join("\n"),
  );
  assert.deepEqual([...readSidebarSlugs(file)].sort(), [
    "betaexams",
    "microsoftesi",
    "partnerweek",
  ]);
  assert.equal(readSidebarSlugs(join(dir, "missing.ts")), null);
  assert.ok(
    readSidebarSlugs(join(root, "src", "data_files", "docs-sidebar.ts")).size >
      0,
    "the real sidebar still links voucher pages in the form the reader expects",
  );
});

// ---------------------------------------------------------------------------
// End to end: the script on a small fake repository
// ---------------------------------------------------------------------------
const voucherPage = ({
  title = "Sample Voucher",
  category = '"Special"',
  lines = [],
} = {}) =>
  [
    "---",
    `title: ${title}`,
    ...(category ? [`voucherCategory: ${category}`] : []),
    ...lines,
    "---",
    "",
    "Some body text.",
    "",
  ].join("\n");

// A tracked beta exam whose announcement is out: nothing for the review to say.
const BETA_ANNOUNCED = {
  code: "AB-650",
  area: "aibusiness",
  betaStart: "2026-07-28",
  announcement: ANNOUNCEMENT,
  flaggedGA: false,
};
const BETA_BADGE = { text: "BETA", variant: "tip" };

async function makeRepo({
  vouchers,
  exams = ["AB-650", "GH-700", "AZ-800"],
  statuses = {
    github: { "GH-700": { text: "UPCOMING", variant: "note" } },
    aibusiness: { "AB-650": { text: "BETA", variant: "tip" } },
    azure: { "AZ-800": { text: "RETIRING", variant: "danger" } },
  },
  beta = [BETA_ANNOUNCED],
  retiring = [
    {
      code: "AZ-800",
      retirementDate: "2026-09-30",
      replacementCode: "AZ-802",
      notified: true,
    },
  ],
  tracker = trackerContent(emptyTracker()),
}) {
  const dir = await mkdtemp(join(tmpdir(), "voucher-review-"));
  tempDirs.push(dir);
  const docs = join(dir, "docs");
  await mkdir(join(docs, "vouchers"), { recursive: true });
  for (const [slug, text] of Object.entries(vouchers)) {
    await writeFile(join(docs, "vouchers", `${slug}.mdx`), text);
  }
  const areas = { AB: "aibusiness", GH: "github", AZ: "azure" };
  for (const code of exams) {
    const area = join(docs, areas[code.slice(0, 2)]);
    await mkdir(area, { recursive: true });
    await writeFile(join(area, `${code}.mdx`), "---\ntitle: x\n---\n");
  }
  await writeFile(
    join(dir, "exam-status.mjs"),
    `export const examStatuses = ${JSON.stringify(statuses)};\n`,
  );
  await writeFile(
    join(dir, "beta-exams.json"),
    JSON.stringify({ exams: beta }),
  );
  await writeFile(
    join(dir, "retiring-exams.json"),
    JSON.stringify({ exams: retiring }),
  );
  await writeFile(
    join(dir, "sidebar.ts"),
    'const items = [{ href: docsPath("vouchers/partnerweek") }];\n',
  );
  await writeFile(join(dir, "tracker.json"), tracker);
  const env = {
    DOCS_DIR: docs,
    TRACKER_FILE: join(dir, "tracker.json"),
    EXAM_STATUS_FILE: join(dir, "exam-status.mjs"),
    BETA_EXAMS_FILE: join(dir, "beta-exams.json"),
    RETIRING_EXAMS_FILE: join(dir, "retiring-exams.json"),
    SIDEBAR_FILE: join(dir, "sidebar.ts"),
    REPORT_FILE: join(dir, "report.md"),
    ERROR_FILE: join(dir, "error.md"),
    GITHUB_OUTPUT: join(dir, "output"),
    SITE_URL: "https://example.test",
  };
  return {
    dir,
    env,
    voucher: (slug) => join(docs, "vouchers", `${slug}.mdx`),
    trackerText: () =>
      existsSync(env.TRACKER_FILE)
        ? readFileSync(env.TRACKER_FILE, "utf8")
        : null,
    setTracker: (text) => writeFile(env.TRACKER_FILE, text),
    setBeta: (entries) =>
      writeFile(env.BETA_EXAMS_FILE, JSON.stringify({ exams: entries })),
  };
}

/** Runs the script like the workflow does and reads back everything it wrote. */
async function runScript(repo, today, extraEnv = {}) {
  for (const key of ["REPORT_FILE", "ERROR_FILE", "GITHUB_OUTPUT"]) {
    await rm(repo.env[key], { force: true });
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      ...repo.env,
      TODAY: today,
      REPORT_ALL: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const read = (file) =>
    existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
  const output = Object.fromEntries(
    (read(repo.env.GITHUB_OUTPUT) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
    report: read(repo.env.REPORT_FILE),
    error: read(repo.env.ERROR_FILE),
    tracker: repo.trackerText(),
  };
}

const QUIET = {
  changes_found: "false",
  baseline_updated: "false",
  extraction_failed: "false",
  issue_title: "",
};

test("a quiet repository stays quiet: no issue, no tracker write, on any number of days", async () => {
  const repo = await makeRepo({
    vouchers: {
      studentdiscount: voucherPage({ lines: ["reviewBy: 2027-03-01"] }),
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
    },
  });
  const before = repo.trackerText();
  for (const day of ["2026-10-14", "2026-10-15", "2026-11-30"]) {
    const result = await runScript(repo, day);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.output, QUIET, day);
    assert.equal(result.report, null, day);
    assert.equal(result.tracker, before, `${day}: no churn commit`);
  }
});

test("pages that declare nothing are stable offers: nothing is asked of them, nothing lists them and nothing is written, on any day", async () => {
  const repo = await makeRepo({
    vouchers: {
      stableone: voucherPage({ title: "Stable Offer One", category: '"50%"' }),
      stabletwo: voucherPage({ title: "Stable Offer Two" }),
      stablethree: voucherPage({
        title: "Stable Offer Three",
        category: '"100%"',
      }),
    },
  });
  const before = repo.trackerText();
  assert.equal(writtenFormatProblem(before), null);
  // However long they stay without a date, and also when everything is asked for.
  for (const day of ["2026-10-14", "2026-10-21", "2027-01-11", "2028-06-30"]) {
    for (const extra of [{}, { REPORT_ALL: "1" }]) {
      const label = `${day} ${JSON.stringify(extra)}`;
      const result = await runScript(repo, day, extra);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.output, QUIET, label);
      assert.equal(result.report, null, label);
      assert.equal(result.tracker, before, `${label}: nothing is written`);
      assert.match(
        result.stdout,
        /Reviewed 3 voucher pages with a voucherCategory\./,
      );
      assert.match(result.stdout, /0 pages with a problem, 0 reported today\./);
      assert.match(result.stdout, /Tracker unchanged/);
      assert.doesNotMatch(
        result.stdout,
        /neither voucherEnds nor reviewBy|recorded silently|without a date|listed in the issue/,
        label,
      );
    }
  }

  // Not even the first run writes anything: there is no inventory to baseline.
  await rm(repo.env.TRACKER_FILE);
  const first = await runScript(repo, "2026-10-14");
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.output, QUIET);
  assert.equal(first.tracker, null, "a quiet first run creates no tracker");
});

test("the result of a run carries no inventory: a repository of stable offers is all clear, with nothing found and nothing changed", async () => {
  const repo = await makeRepo({
    vouchers: {
      stableone: voucherPage({ title: "Stable Offer One", category: '"50%"' }),
      stabletwo: voucherPage({ title: "Stable Offer Two" }),
    },
  });
  const run = (extra = {}) =>
    monitor.run(loadConfig({ ...repo.env, TODAY, ...extra }));

  const result = await run();
  for (const removed of ["undated", "inventoryShown", "inventoryBaselined"]) {
    assert.equal(removed in result, false, `${removed} is gone`);
  }
  assert.deepEqual(
    {
      reviewed: result.reviewed,
      flagged: result.flagged,
      reports: result.reports,
      changesFound: result.changesFound,
      allClear: result.allClear,
      changed: result.changed,
      issueTitle: result.issueTitle,
      report: result.report,
    },
    {
      reviewed: 2,
      flagged: 0,
      reports: [],
      changesFound: false,
      allClear: true,
      changed: false,
      issueTitle: "",
      report: null,
    },
  );

  // With a page that has a problem next to them: found, not all clear.
  await writeFile(
    repo.voucher("overdue"),
    voucherPage({ lines: ["voucherEnds: 2026-10-12"] }),
  );
  const found = await run();
  assert.equal(found.reviewed, 3);
  assert.equal(found.flagged, 1);
  assert.equal(found.changesFound, true);
  assert.equal(found.allClear, false);
  assert.equal(found.issueTitle, `Voucher review ${TODAY}: overdue`);
});

test("a report and its title list only the pages with a problem: pages without a date are not counted, named or asked for a date", async () => {
  const repo = await makeRepo({
    vouchers: {
      overdue: voucherPage({
        title: "Overdue Offer",
        category: '"100%"',
        lines: ["voucherEnds: 2026-10-12"],
      }),
      stableone: voucherPage({ title: "Stable Offer One", category: '"50%"' }),
      stabletwo: voucherPage({ title: "Stable Offer Two" }),
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    changes_found: "true",
    baseline_updated: "true",
    extraction_failed: "false",
    issue_title: "Voucher review 2026-10-14: overdue",
  });
  assert.match(result.report, /looked at the 3 pages in /);
  assert.match(result.report, /### Pages that need action \(1\)/);
  assert.match(result.report, /Overdue Offer/);
  assert.doesNotMatch(result.report, /Stable Offer|stableone|stabletwo/);
  assert.doesNotMatch(
    result.report,
    /without a date|### Pages without|inventory|every page has a date/i,
  );
  assert.deepEqual(JSON.parse(result.tracker), {
    lastSynced: "2026-10-14",
    pages: {
      "vouchers/overdue": {
        firstReported: "2026-10-14",
        lastReported: "2026-10-14",
        reasons: ["ended:2026-10-12"],
      },
    },
  });
  assert.equal(writtenFormatProblem(result.tracker), null);

  // A week later: the reminder, with the same title shape and still no
  // mention of the pages without a date.
  const reminder = await runScript(repo, "2026-10-21");
  assert.equal(
    reminder.output.issue_title,
    "Voucher review 2026-10-21: overdue",
  );
  assert.doesNotMatch(reminder.report, /Stable Offer|without a date/);
});

test("an overdue offer: reported once, quiet for a week, a reminder after, and the lost issue is retried", async () => {
  const initial = trackerContent(emptyTracker());
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({
        title: "Microsoft Partner Certification Week",
        category: '"100%"',
        lines: ["voucherEnds: 2026-10-12"],
      }),
      studentdiscount: voucherPage({ lines: ["reviewBy: 2027-03-01"] }),
    },
    tracker: initial,
  });

  // Day 1: reported, whatever else is going on (the first run is not silent
  // for a date somebody wrote down).
  let day1 = await runScript(repo, "2026-10-14");
  assert.equal(day1.code, 0, day1.stderr);
  assert.equal(day1.output.changes_found, "true");
  assert.equal(day1.output.baseline_updated, "true");
  assert.equal(
    day1.output.issue_title,
    "Voucher review 2026-10-14: partnerweek",
  );
  assert.match(day1.report, /Microsoft Partner Certification Week/);
  assert.match(day1.report, /`voucherEnds: 2026-10-12` passed 2 days ago/);
  assert.match(day1.report, /\| new \| yes \|/, "sidebar entry found");
  assert.deepEqual(JSON.parse(day1.tracker).pages, {
    "vouchers/partnerweek": {
      firstReported: "2026-10-14",
      lastReported: "2026-10-14",
      reasons: ["ended:2026-10-12"],
    },
  });

  // The issue step failed, so the workflow did not commit the tracker: the next
  // run starts from the old tracker and says the same thing.
  await repo.setTracker(initial);
  const retry = await runScript(repo, "2026-10-14");
  assert.equal(retry.report, day1.report);
  assert.equal(retry.tracker, day1.tracker);

  // The issue step worked, the tracker was committed: quiet for days 2..7.
  const committed = day1.tracker;
  for (const day of ["2026-10-15", "2026-10-20"]) {
    const quiet = await runScript(repo, day);
    assert.deepEqual(quiet.output, QUIET, day);
    assert.equal(quiet.tracker, committed, `${day}: no churn commit`);
  }

  // Day 8: a reminder with the original report date.
  const reminder = await runScript(repo, "2026-10-21");
  assert.equal(reminder.output.changes_found, "true");
  assert.match(reminder.report, /`voucherEnds: 2026-10-12` passed 9 days ago/);
  assert.match(reminder.report, /reminder \(first reported 2026-10-14\)/);
  assert.equal(
    JSON.parse(reminder.tracker).pages["vouchers/partnerweek"].lastReported,
    "2026-10-21",
  );
});

test("a changed problem is reported at once, a fixed page leaves the tracker, and a relapse is new", async () => {
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-10-12"] }),
    },
  });
  await runScript(repo, "2026-10-14");

  // The maintainer extends the offer to a date that has passed again, and ties
  // the page to an exam that is no longer in beta.
  await writeFile(
    repo.voucher("partnerweek"),
    voucherPage({
      lines: [
        "voucherEnds: 2026-10-13",
        "linkedExam: GH-700",
        "reviewBy: 2026-10-01",
      ],
    }),
  );
  await writeFile(
    repo.env.EXAM_STATUS_FILE,
    "export const examStatuses = { github: {} };\n",
  );
  const changed = await runScript(repo, "2026-10-15");
  assert.equal(changed.output.changes_found, "true");
  assert.match(changed.report, /\| changed since the last report \|/);
  assert.match(changed.report, /`voucherEnds: 2026-10-13` passed 2 days ago/);
  assert.match(changed.report, /`reviewBy: 2026-10-01` passed 14 days ago/);
  assert.match(
    changed.report,
    /linked exam `GH-700` is no longer BETA or UPCOMING/,
  );
  assert.deepEqual(
    JSON.parse(changed.tracker).pages["vouchers/partnerweek"].reasons,
    ["ended:2026-10-13", "exam-ga:GH-700", "review:2026-10-01"],
  );

  // Fixed: dates in the future and no linked exam. No issue, but the tracker
  // forgets the page (a write without an alert).
  await writeFile(
    repo.voucher("partnerweek"),
    voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
  );
  const fixed = await runScript(repo, "2026-10-16");
  assert.equal(fixed.output.changes_found, "false");
  assert.equal(fixed.output.baseline_updated, "true");
  assert.deepEqual(JSON.parse(fixed.tracker).pages, {});
  assert.equal(
    (await runScript(repo, "2026-10-17")).output.baseline_updated,
    "false",
  );

  // It ends again: reported immediately, as new.
  const relapse = await runScript(repo, "2027-01-02");
  assert.equal(relapse.output.changes_found, "true");
  assert.match(relapse.report, /\| new \|/);
});

test("pages that left the voucher lists are not reviewed: no category, drafts", async () => {
  const repo = await makeRepo({
    vouchers: {
      levelup: voucherPage({
        title: "Microsoft Partner LevelUp (Expired)",
        category: "",
        lines: ["voucherEnds: 2026-05-31", "linkedExam: AB-650"],
      }),
      hidden: voucherPage({
        lines: ["draft: true", "voucherEnds: 2026-05-31"],
      }),
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, QUIET);
  assert.match(
    result.stdout,
    /Reviewed 1 voucher pages with a voucherCategory \(skipped, no voucherCategory or draft: hidden, levelup\)/,
  );
});

test("malformed frontmatter values and unreadable pages are reported, not fatal", async () => {
  const repo = await makeRepo({
    vouchers: {
      broken: voucherPage({
        lines: ["voucherEnds: 2026-02-31", "linkedExam: gh700"],
      }),
      nofrontmatter: "Just text, no frontmatter.\n",
      fine: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.changes_found, "true");
  assert.match(
    result.report,
    /`voucherEnds` is `2026-02-31`, not a date written `YYYY-MM-DD`/,
  );
  assert.match(result.report, /`linkedExam` is `gh700`/);
  assert.match(result.report, /the file has no frontmatter block/);
  assert.match(result.report, /Fix the frontmatter/);
  assert.equal(
    result.output.issue_title,
    "Voucher review 2026-10-14: broken, nofrontmatter",
  );
});

test("a date written as an unquoted midnight timestamp is reviewed like any other date, another time of day is invalid", async () => {
  const repo = await makeRepo({
    vouchers: {
      iso: voucherPage({ lines: ["voucherEnds: 2026-10-12T00:00:00Z"] }),
      spaced: voucherPage({
        lines: ["reviewBy: 2026-10-12 00:00:00 # look again"],
      }),
      future: voucherPage({ lines: ["voucherEnds: 2026-12-31T00:00:00Z"] }),
      timed: voucherPage({ lines: ["voucherEnds: 2026-10-12T10:00:00Z"] }),
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(JSON.parse(result.tracker).pages).map(([id, entry]) => [
        id,
        entry.reasons,
      ]),
    ),
    {
      "vouchers/iso": ["ended:2026-10-12"],
      "vouchers/spaced": ["review:2026-10-12"],
      "vouchers/timed": ["invalid-date:voucherEnds:2026-10-12T10:00:00Z"],
    },
  );
  assert.match(result.report, /`voucherEnds: 2026-10-12` passed 2 days ago/);
  assert.match(result.report, /`reviewBy: 2026-10-12` passed 2 days ago/);
  assert.match(
    result.report,
    /`voucherEnds` is `2026-10-12T10:00:00Z`, not a date written `YYYY-MM-DD`/,
  );
});

test("a linked exam: beta stays quiet, Learn-GA, retired and unknown are reported", async () => {
  const repo = await makeRepo({
    vouchers: {
      ok: voucherPage({
        lines: ["reviewBy: 2027-01-01", "linkedExam: AB-650"],
      }),
      upcoming: voucherPage({
        lines: ["reviewBy: 2027-01-01", "linkedExam: GH-700"],
      }),
      retired: voucherPage({
        lines: ["reviewBy: 2027-01-01", "linkedExam: AZ-800"],
      }),
      typo: voucherPage({
        lines: ["reviewBy: 2027-01-01", "linkedExam: AB-999"],
      }),
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.output.issue_title,
    "Voucher review 2026-10-14: retired, typo",
  );
  assert.match(
    result.report,
    /linked exam `AZ-800` retired on 2026-09-30 \(replacement: `AZ-802`\)/,
  );
  assert.match(result.report, /linked exam `AB-999` has no exam page/);
  // The pages whose linked exam is still BETA or UPCOMING are not listed (the
  // advice text may name AB-650 as an example, so look at the page links).
  assert.doesNotMatch(result.report, /\/certs\/vouchers\/(?:ok|upcoming)\//);

  // Learn flags the beta exam GA while the hub still says BETA.
  await writeFile(
    repo.env.BETA_EXAMS_FILE,
    JSON.stringify({
      exams: [{ code: "AB-650", flaggedGA: true, flaggedAt: "2026-10-13" }],
    }),
  );
  const flagged = await runScript(repo, "2026-10-15");
  assert.match(
    flagged.report,
    /Microsoft Learn no longer shows the beta marker of linked exam `AB-650`/,
  );
  assert.match(flagged.report, /flagged GA on 2026-10-13/);
});

test("end to end: a beta voucher page tied to a pending exam, an entry without a start day and a GA-flagged exam", async () => {
  const repo = await makeRepo({
    vouchers: {
      // an event voucher that only links the exam, as on the real hub: not the beta voucher
      githubuniverse2026: voucherPage({
        title: '"GitHub Universe 2026 - GH-700"',
        lines: ["reviewBy: 2026-12-01", "linkedExam: GH-700"],
      }),
      gh700beta: voucherPage({
        title: "Exam GH-700 (beta)",
        lines: ["voucherEnds: 2026-12-01", "linkedExam: GH-700"],
      }),
      // beta vouchers that left the voucher lists are not reviewed, and tie nothing
      oldoffer: voucherPage({
        title: '"Exam GH-700 (beta) (Expired)"',
        category: "",
        lines: ["voucherEnds: 2026-05-31", "linkedExam: GH-700"],
      }),
      hidden: voucherPage({
        title: "Exam GH-700 (beta)",
        lines: ["draft: true", "voucherEnds: 2026-12-31", "linkedExam: GH-700"],
      }),
    },
    exams: ["AB-650", "GH-700", "AZ-401"],
    statuses: {
      aibusiness: { "AB-650": BETA_BADGE },
      github: { "GH-700": BETA_BADGE },
      azure: { "AZ-401": BETA_BADGE },
    },
    beta: [
      BETA_ANNOUNCED,
      {
        code: "GH-700",
        area: "github",
        betaStart: "2026-10-14",
        announcement: "pending",
        flaggedGA: false,
      },
      { code: "AZ-401", area: "azure", flaggedGA: false },
    ],
  });

  // The first run is not silent for a finding: the beta voucher page of GH-700
  // is tied to an exam whose announcement is still pending (day 0, so not
  // overdue), and AZ-401 has neither a start day nor an announcement.
  const first = await runScript(repo, "2026-10-14");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.output.changes_found, "true");
  assert.equal(
    first.output.issue_title,
    "Voucher review 2026-10-14: AZ-401, GH-700",
  );
  assert.match(first.report, /### Pages that need action \(2\)/);
  const rows = first.report
    .split("\n")
    .filter((line) => /^\| \[(AZ-401|GH-700)\]/.test(line));
  assert.equal(rows.length, 2);
  assert.match(
    rows[0],
    /^\| \[AZ-401\]\(https:\/\/example\.test\/certs\/azure\/az-401\/\)<br>`src\/content\/docs\/azure\/AZ-401\.mdx` \| `beta-exams\.json` has no usable entry for beta exam `AZ-401`: `betaStart` is missing, not a date written `YYYY-MM-DD`; `announcement` is missing, not `pending`, `unannounced` or the https address of the announcement \| new \| n\/a \|$/,
  );
  assert.match(
    rows[1],
    /^\| \[GH-700\]\(https:\/\/example\.test\/certs\/github\/gh-700\/\)<br>`src\/content\/docs\/github\/GH-700\.mdx` \| 1 beta voucher page \(`gh700beta`\) is tied to beta exam `GH-700` \(`linkedExam`\), but `announcement` is still `pending` in `beta-exams\.json`: the exam page note was not switched \| new \| n\/a \|$/,
  );
  // The event voucher links the same exam but is not a beta voucher; the
  // expired and the draft beta vouchers are not on the lists.
  assert.doesNotMatch(first.report, /githubuniverse2026|oldoffer|hidden/);
  assert.deepEqual(JSON.parse(first.tracker).pages, {
    "azure/AZ-401": {
      firstReported: "2026-10-14",
      lastReported: "2026-10-14",
      reasons: ["beta-announcement-missing:AZ-401"],
    },
    "github/GH-700": {
      firstReported: "2026-10-14",
      lastReported: "2026-10-14",
      reasons: ["beta-voucher-mismatch:GH-700"],
    },
  });
  assert.match(
    first.stdout,
    /3 beta exams in beta-exams\.json checked .* 2 with a problem\./,
  );
  // The tracker is in the format the committed file is held to.
  assert.equal(writtenFormatProblem(first.tracker), null);

  // The same findings the next days are quiet (a tracker that did not change).
  const quiet = await runScript(repo, "2026-10-15");
  assert.deepEqual(quiet.output, QUIET);
  assert.equal(quiet.tracker, first.tracker);

  // Learn flags both exams GA: nothing is said about the exam pages any more.
  // (The voucher pages have their own finding for a linked exam that Learn
  // flagged, the event voucher too: that finding is about the exam, not the title.)
  await repo.setBeta([
    BETA_ANNOUNCED,
    {
      code: "GH-700",
      area: "github",
      betaStart: "2026-10-14",
      announcement: "pending",
      flaggedGA: true,
      flaggedAt: "2026-10-15",
    },
    { code: "AZ-401", area: "azure", flaggedGA: true, flaggedAt: "2026-10-15" },
  ]);
  const flagged = await runScript(repo, "2026-10-16");
  assert.equal(flagged.code, 0, flagged.stderr);
  assert.deepEqual(Object.keys(JSON.parse(flagged.tracker).pages), [
    "vouchers/gh700beta",
    "vouchers/githubuniverse2026",
  ]);
  for (const slug of ["gh700beta", "githubuniverse2026"]) {
    assert.deepEqual(
      JSON.parse(flagged.tracker).pages[`vouchers/${slug}`].reasons,
      ["exam-learn-ga:GH-700"],
      slug,
    );
  }
  assert.doesNotMatch(
    flagged.report,
    /tied to beta exam|no usable entry|still promises/,
  );
  assert.match(
    flagged.stdout,
    /1 beta exam in beta-exams\.json checked .* 0 with a problem\./,
  );
});

test("end to end: the githubuniverse2026 event voucher tied to GH-700 raises nothing while the announcement is pending, and is still reviewed for its own reviewBy", async () => {
  const repo = await makeRepo({
    vouchers: {
      githubuniverse2026: voucherPage({
        title: '"GitHub Universe 2026 - GH-700"',
        lines: ["reviewBy: 2026-10-22", "linkedExam: GH-700"],
      }),
    },
    exams: ["AB-650", "GH-700"],
    statuses: {
      aibusiness: { "AB-650": BETA_BADGE },
      github: { "GH-700": BETA_BADGE },
    },
    beta: [
      BETA_ANNOUNCED,
      {
        code: "GH-700",
        area: "github",
        betaStart: "2026-10-14",
        announcement: "pending",
        flaggedGA: false,
      },
    ],
  });
  const before = repo.trackerText();

  // The day the beta began: no finding for the event page, none for the exam
  // page, and nothing is written.
  const first = await runScript(repo, "2026-10-14");
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.output, QUIET);
  assert.equal(first.report, null);
  assert.equal(first.tracker, before);
  assert.match(
    first.stdout,
    /2 beta exams in beta-exams\.json checked .* 0 with a problem\./,
  );

  // Day 8: the announcement is overdue and that is the only finding; the event
  // voucher adds no mismatch to it.
  const overdue = await runScript(repo, "2026-10-22");
  assert.equal(overdue.output.changes_found, "true");
  assert.equal(overdue.output.issue_title, "Voucher review 2026-10-22: GH-700");
  assert.deepEqual(JSON.parse(overdue.tracker).pages, {
    "github/GH-700": {
      firstReported: "2026-10-22",
      lastReported: "2026-10-22",
      reasons: ["beta-announcement-overdue:GH-700:2026-10-14"],
    },
  });
  assert.doesNotMatch(overdue.report, /tied to beta exam|githubuniverse2026/);

  // The day after its reviewBy the page is reviewed for that, and only that.
  const review = await runScript(repo, "2026-10-23");
  assert.equal(
    review.output.issue_title,
    "Voucher review 2026-10-23: githubuniverse2026",
  );
  assert.deepEqual(
    JSON.parse(review.tracker).pages["vouchers/githubuniverse2026"],
    {
      firstReported: "2026-10-23",
      lastReported: "2026-10-23",
      reasons: ["review:2026-10-22"],
    },
  );
  assert.doesNotMatch(review.report, /tied to beta exam/);
});

test("REPORT_ALL reports every open finding now, ignoring what an earlier run reported, and still lists no page without a date", async () => {
  const repo = await makeRepo({
    vouchers: {
      overdue: voucherPage({
        title: "Overdue Offer",
        lines: ["voucherEnds: 2026-10-12"],
      }),
      checkme: voucherPage({
        title: "Check Me Offer",
        lines: ["reviewBy: 2026-10-01"],
      }),
      stable: voucherPage({ title: "Stable Offer", category: '"50%"' }),
    },
  });
  const first = await runScript(repo, "2026-10-14");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(
    first.output.issue_title,
    "Voucher review 2026-10-14: checkme, overdue",
  );

  // The next day it is quiet; with REPORT_ALL both are reported again, as reminders.
  const quiet = await runScript(repo, "2026-10-15");
  assert.deepEqual(quiet.output, QUIET);
  const all = await runScript(repo, "2026-10-15", { REPORT_ALL: "1" });
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(all.output, {
    changes_found: "true",
    baseline_updated: "true",
    extraction_failed: "false",
    issue_title: "Voucher review 2026-10-15: checkme, overdue",
  });
  assert.match(all.report, /### Pages that need action \(2\)/);
  assert.equal(
    all.report.match(/reminder \(first reported 2026-10-14\)/g)?.length,
    2,
  );
  assert.doesNotMatch(all.report, /Stable Offer/);
  assert.doesNotMatch(all.report, /without a date|### Pages without/i);
  assert.deepEqual(JSON.parse(all.tracker).pages["vouchers/overdue"], {
    firstReported: "2026-10-14",
    lastReported: "2026-10-15",
    reasons: ["ended:2026-10-12"],
  });

  // Also on the very first run, when no tracker was written yet: all of it is new.
  await rm(repo.env.TRACKER_FILE);
  const everything = await runScript(repo, "2026-10-14", { REPORT_ALL: "1" });
  assert.equal(everything.output.changes_found, "true");
  assert.equal(everything.report.match(/\| new \|/g)?.length, 2);
  assert.doesNotMatch(everything.report, /Stable Offer|without a date/);
});

test("a page that declares only a linkedExam is still reviewed for that exam, and listed nowhere else", async () => {
  const repo = await makeRepo({
    vouchers: {
      onlybeta: voucherPage({
        title: "Only Beta Exam",
        lines: ["linkedExam: AB-650"],
      }),
      onlyga: voucherPage({
        title: "Only GA Exam",
        lines: ["linkedExam: GH-700"],
      }),
      stable: voucherPage({ title: "Stable Offer", category: '"50%"' }),
    },
    statuses: {
      aibusiness: { "AB-650": BETA_BADGE },
      github: {}, // GH-700 is generally available: no badge
      azure: { "AZ-800": { text: "RETIRING", variant: "danger" } },
    },
  });
  const result = await runScript(repo, "2026-10-14");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.issue_title, "Voucher review 2026-10-14: onlyga");
  assert.match(result.report, /### Pages that need action \(1\)/);
  assert.match(
    result.report,
    /linked exam `GH-700` is no longer BETA or UPCOMING/,
  );
  assert.doesNotMatch(
    result.report,
    /Only Beta Exam|onlybeta|Stable Offer|without a date|every page/,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(JSON.parse(result.tracker).pages).map(([id, p]) => [
        id,
        p.reasons,
      ]),
    ),
    { "vouchers/onlyga": ["exam-ga:GH-700"] },
  );

  // The exam is back in beta: the finding goes away with the page.
  await writeFile(
    repo.env.EXAM_STATUS_FILE,
    `export const examStatuses = ${JSON.stringify({
      aibusiness: { "AB-650": BETA_BADGE },
      github: { "GH-700": BETA_BADGE },
    })};\n`,
  );
  await repo.setBeta([
    BETA_ANNOUNCED,
    {
      code: "GH-700",
      area: "github",
      betaStart: "2026-10-14",
      announcement: ANNOUNCEMENT,
      flaggedGA: false,
    },
  ]);
  const fixed = await runScript(repo, "2026-10-15");
  assert.equal(fixed.output.changes_found, "false");
  assert.deepEqual(JSON.parse(fixed.tracker).pages, {});
});

test("a tracker written by the older monitor loads without a word and is rewritten once without its lastInventory", async () => {
  const entry = {
    firstReported: "2026-10-14",
    lastReported: "2026-10-14",
    reasons: ["ended:2026-10-12"],
  };
  const legacyText = (lastInventory) =>
    `${JSON.stringify({ lastSynced: "2026-10-14", lastInventory, pages: { "vouchers/partnerweek": entry } }, null, 2)}\n`;
  const vouchers = {
    partnerweek: voucherPage({
      title: "Overdue Offer",
      lines: ["voucherEnds: 2026-10-12"],
    }),
    stable: voucherPage({ title: "Stable Offer", category: '"50%"' }),
  };

  // A quiet day: the page was reported yesterday and nothing else is going on.
  // The file still holds the old key, so it is rewritten once, without it.
  const repo = await makeRepo({
    vouchers,
    tracker: legacyText("2026-10-14"),
  });
  const first = await runScript(repo, "2026-10-15");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, "", "not a word about the old key");
  assert.deepEqual(first.output, {
    changes_found: "false",
    baseline_updated: "true",
    extraction_failed: "false",
    issue_title: "",
  });
  assert.equal(first.report, null);
  assert.deepEqual(JSON.parse(first.tracker), {
    lastSynced: "2026-10-15",
    pages: { "vouchers/partnerweek": entry },
  });
  assert.equal(writtenFormatProblem(first.tracker), null);
  // After that it is quiet again: written once, no churn, and the reminder a
  // week after the first report works on what was kept.
  const second = await runScript(repo, "2026-10-16");
  assert.deepEqual(second.output, QUIET);
  assert.equal(second.tracker, first.tracker);
  const reminder = await runScript(repo, "2026-10-21");
  assert.match(reminder.report, /reminder \(first reported 2026-10-14\)/);

  // Whatever the old key holds, and when the file is rewritten anyway (a
  // reminder is due), it goes too.
  for (const lastInventory of ["yesterday", "", null, 7]) {
    const other = await makeRepo({
      vouchers,
      tracker: legacyText(lastInventory),
    });
    const due = await runScript(other, "2026-10-21");
    assert.equal(
      due.code,
      0,
      `${JSON.stringify(lastInventory)}: ${due.stderr}`,
    );
    assert.equal(due.stderr, "");
    assert.equal(due.output.changes_found, "true");
    assert.match(due.report, /reminder \(first reported 2026-10-14\)/);
    assert.deepEqual(JSON.parse(due.tracker), {
      lastSynced: "2026-10-21",
      pages: {
        "vouchers/partnerweek": { ...entry, lastReported: "2026-10-21" },
      },
    });
  }
});

test("the check fails loudly, and never reports a page, when its inputs are broken", async () => {
  const fails = async (repo, today, expected) => {
    const result = await runScript(repo, today);
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(result.output, {
      changes_found: "false",
      baseline_updated: "false",
      extraction_failed: "true",
      issue_title: "",
    });
    assert.match(result.error, expected);
    assert.equal(result.report, null);
    return result;
  };

  // No voucher folder, an empty folder, pages that no longer have frontmatter.
  const base = await makeRepo({ vouchers: { x: voucherPage() } });
  await rm(join(base.env.DOCS_DIR, "vouchers"), { recursive: true });
  await fails(base, "2026-10-14", /voucher folder .* could not be read/);

  const empty = await makeRepo({ vouchers: {} });
  await fails(empty, "2026-10-14", /No voucher page/);

  const plain = await makeRepo({ vouchers: { a: "text\n", b: "more text\n" } });
  await fails(plain, "2026-10-14", /None of the 2 voucher pages/);

  // A corrupt tracker is never replaced by a fresh baseline.
  const corrupt = await makeRepo({
    vouchers: { x: voucherPage() },
    tracker: "{ nope",
  });
  await fails(corrupt, "2026-10-14", /Corrupt tracker .*\(invalid JSON\)/);
  assert.equal(corrupt.trackerText(), "{ nope");

  // A linked exam needs the exam files; if they cannot be read the state of the
  // exam is unknown, which is not evidence that it left beta.
  const noStatus = await makeRepo({
    vouchers: { x: voucherPage({ lines: ["linkedExam: AB-650"] }) },
  });
  await rm(noStatus.env.EXAM_STATUS_FILE);
  await fails(noStatus, "2026-10-14", /exam-status\.mjs could not be loaded/);

  const badBeta = await makeRepo({
    vouchers: { x: voucherPage({ lines: ["linkedExam: AB-650"] }) },
  });
  await writeFile(badBeta.env.BETA_EXAMS_FILE, "{ nope");
  await fails(
    badBeta,
    "2026-10-14",
    /beta-exams\.json could not be read as JSON/,
  );

  // ... but a repository without any linked exam does not need the exam status
  // and the retirement list (the beta exams are checked on every run, below).
  const unlinked = await makeRepo({
    vouchers: { x: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }) },
  });
  await rm(unlinked.env.EXAM_STATUS_FILE);
  await writeFile(unlinked.env.RETIRING_EXAMS_FILE, "{ nope");
  const fine = await runScript(unlinked, "2026-10-14");
  assert.equal(fine.code, 0, fine.stderr);
  assert.equal(fine.output.extraction_failed, "false");

  // The announcement of every beta exam is checked on every run, so the beta
  // tracker is needed with or without a linked exam: unreadable is no evidence
  // that every announcement is in order.
  const noBeta = await makeRepo({
    vouchers: { x: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }) },
  });
  await writeFile(noBeta.env.BETA_EXAMS_FILE, "{ nope");
  await fails(
    noBeta,
    "2026-10-14",
    /beta-exams\.json could not be read as JSON/,
  );
  await rm(noBeta.env.BETA_EXAMS_FILE);
  await fails(
    noBeta,
    "2026-10-14",
    /beta-exams\.json could not be read as JSON/,
  );
  await writeFile(noBeta.env.BETA_EXAMS_FILE, JSON.stringify({ exams: {} }));
  await fails(noBeta, "2026-10-14", /beta-exams\.json has no "exams" list/);
});

// ---------------------------------------------------------------------------
// The issues: one running issue, comments instead of new issues, closed when all is well
// ---------------------------------------------------------------------------
const quietCfg = { createIssues: true, dryRun: false, today: "2026-10-14" };

/** An in-process stand-in for the gh CLI that records the arguments of every call. */
function stubGh({ open = [], fail = {}, labels = [] } = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    const command = args.slice(0, 2).join(" ");
    if (fail[command]) throw new Error(`gh ${command} failed: boom`);
    if (command === "issue list") return JSON.stringify(open);
    if (command === "label list") {
      return JSON.stringify(labels.map((name) => ({ name })));
    }
    if (command === "issue create") {
      return "https://github.com/mscerts/hub/issues/77\n";
    }
    return "";
  };
  gh.calls = calls;
  gh.commands = () => calls.map((c) => c.args.slice(0, 2).join(" "));
  return gh;
}
const openIssue = (number, title = REVIEW_ISSUE_TITLE) => ({ number, title });
const issueArgs = {
  enabled: true,
  title: "T",
  label: "L",
  labelColor: "ffffff",
  labelDescription: "d",
  body: "BODY",
  closeComment: "bye",
};

test("one running issue: the report creates it, later reports are comments, never a second issue", () => {
  assert.equal(REVIEW_ISSUE_TITLE, "Voucher review: pages need attention");
  assert.equal(REVIEW_ISSUE_LABEL, "enhancement");
  assert.equal(FAILED_ISSUE_TITLE, "Voucher review: the check failed");
  assert.equal(FAILED_ISSUE_LABEL, "bug");

  const created = stubGh();
  const a = syncIssue({ ...issueArgs, gh: created, active: true });
  assert.deepEqual(a, {
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
    "L",
    "--body-file",
    "-",
  ]);
  assert.equal(created.calls[2].input, "BODY");

  const commented = stubGh({
    open: [
      { number: 9, title: "T" },
      { number: 3, title: "T" },
      // an older issue with another title (the label is shared) is never the one
      { number: 1, title: "other" },
      { number: 2, title: "T — old" },
    ],
  });
  const b = syncIssue({
    ...issueArgs,
    gh: commented,
    active: true,
    commentBody: "NEWS",
  });
  assert.equal(b.action, "commented");
  assert.equal(b.number, 3, "the oldest open copy gets it");
  assert.deepEqual(commented.commands(), ["issue list", "issue comment"]);
  assert.deepEqual(commented.calls[1].args, [
    "issue",
    "comment",
    "3",
    "--body-file",
    "-",
  ]);
  assert.equal(commented.calls[1].input, "NEWS");
  // the comment defaults to the body
  const same = stubGh({ open: [{ number: 3, title: "T" }] });
  syncIssue({ ...issueArgs, gh: same, active: true });
  assert.equal(same.calls[1].input, "BODY");
});

test("an open issue with another title is neither commented on nor closed, and does not stop the issue being created", () => {
  const foreign = [
    { number: 1, title: "other" },
    { number: 2, title: " " },
  ];
  const create = stubGh({ open: foreign });
  assert.equal(
    syncIssue({ ...issueArgs, gh: create, active: true }).action,
    "created",
  );
  const close = stubGh({ open: foreign });
  const out = syncIssue({ ...issueArgs, gh: close, active: false });
  assert.deepEqual(out, {
    action: "none",
    number: null,
    closed: [],
    error: null,
  });
  assert.deepEqual(close.commands(), ["issue list"]);
});

test("the issue closes with a comment when nothing is left, and touches nothing when disabled", () => {
  const closing = stubGh({
    open: [
      { number: 3, title: "T" },
      { number: 5, title: "T" },
      { number: 4, title: "other" },
    ],
  });
  const out = syncIssue({ ...issueArgs, gh: closing, active: false });
  assert.equal(out.action, "closed");
  assert.deepEqual(out.closed, [3, 5]);
  assert.deepEqual(closing.calls[1].args, [
    "issue",
    "close",
    "3",
    "--comment",
    "bye",
  ]);

  const none = stubGh();
  assert.equal(
    syncIssue({ ...issueArgs, gh: none, active: false }).action,
    "none",
  );
  assert.deepEqual(none.commands(), ["issue list"]);

  for (const active of [true, false]) {
    const off = stubGh({ open: [{ number: 3, title: "T" }] });
    const result = syncIssue({ ...issueArgs, gh: off, active, enabled: false });
    assert.equal(result.action, active ? "skipped" : "none");
    assert.deepEqual(off.calls, [], "not even a read");
  }
});

test("a failed write fails the run when an issue is needed; closing only reports and retries next time", () => {
  assert.throws(
    () =>
      syncIssue({
        ...issueArgs,
        gh: stubGh({ fail: { "issue list": 1 } }),
        active: true,
      }),
    /gh issue list failed/,
  );
  assert.throws(
    () =>
      syncIssue({
        ...issueArgs,
        gh: stubGh({ fail: { "issue create": 1 } }),
        active: true,
      }),
    /gh issue create failed/,
  );
  assert.throws(
    () =>
      syncIssue({
        ...issueArgs,
        gh: stubGh({
          open: [{ number: 3, title: "T" }],
          fail: { "issue comment": 1 },
        }),
        active: true,
      }),
    /gh issue comment failed/,
  );
  // a label that exists already does not stop the issue (gh says so by failing
  // to create it, and the label list shows it) ...
  const existing = stubGh({
    fail: { "label create": 1 },
    labels: [issueArgs.label],
  });
  assert.equal(
    syncIssue({ ...issueArgs, gh: existing, active: true }).action,
    "created",
  );
  assert.deepEqual(existing.commands(), [
    "issue list",
    "label create",
    "label list",
    "issue create",
  ]);
  // ... but a label that cannot be created and is not there is a real failure
  // that stops the issue, with the error of the creation
  const missing = stubGh({ fail: { "label create": 1 } });
  assert.throws(
    () => syncIssue({ ...issueArgs, gh: missing, active: true }),
    /gh label create failed/,
  );
  assert.ok(
    !missing.commands().includes("issue create"),
    "no issue is written without its label",
  );
  const lookup = syncIssue({
    ...issueArgs,
    gh: stubGh({ fail: { "issue list": 1 } }),
    active: false,
  });
  assert.equal(lookup.action, "lookup-failed");
  const close = syncIssue({
    ...issueArgs,
    gh: stubGh({
      open: [{ number: 3, title: "T" }],
      fail: { "issue close": 1 },
    }),
    active: false,
  });
  assert.equal(close.action, "close-failed");
  assert.match(close.error, /gh issue close failed/);
});

test("the review issue is only touched on a day with a report or when no page has a problem", () => {
  const quietButOpen = { changesFound: false, allClear: false, report: null };
  const idle = stubGh({ open: [openIssue(5)] });
  assert.equal(syncReviewIssue(quietCfg, idle, quietButOpen).action, "none");
  assert.deepEqual(
    idle.calls,
    [],
    "a quiet day with problems pending costs no call",
  );

  const report = stubGh();
  const created = syncReviewIssue(quietCfg, report, {
    changesFound: true,
    allClear: false,
    report: "REPORT",
  });
  assert.equal(created.action, "created");
  assert.equal(report.calls[2].input, "REPORT");
  assert.equal(report.calls[2].args[3], REVIEW_ISSUE_TITLE);

  // No page has a problem: closed, and the comment says nothing about dates
  // (pages without one are stable offers, not a problem) and nothing about
  // vouchers (the exam pages of the beta exams share the issue).
  const clear = stubGh({ open: [openIssue(5)] });
  const closed = syncReviewIssue(quietCfg, clear, {
    changesFound: false,
    allClear: true,
    report: null,
  });
  assert.equal(closed.action, "closed");
  assert.equal(
    clear.calls[1].args[4],
    "No page has a problem as of 2026-10-14, so there is nothing left to review. Closing this issue; the next finding opens a new one.",
  );
  assert.doesNotMatch(clear.calls[1].args[4], /date|voucher/i);

  // DRY_RUN and CREATE_ISSUES=0 touch nothing
  for (const cfg of [
    { ...quietCfg, dryRun: true },
    { ...quietCfg, createIssues: false },
  ]) {
    const off = stubGh({ open: [openIssue(5)] });
    syncReviewIssue(cfg, off, {
      changesFound: true,
      allClear: false,
      report: "R",
    });
    syncReviewIssue(cfg, off, {
      changesFound: false,
      allClear: true,
      report: null,
    });
    assert.deepEqual(off.calls, []);
  }
});

test("the failure issue: created, commented on for every further failure, closed after a healthy run", () => {
  const first = stubGh();
  const created = syncFailureIssue(
    { ...quietCfg, runUrl: "https://github.com/mscerts/hub/actions/runs/9" },
    first,
    "Corrupt tracker (invalid JSON).",
  );
  assert.equal(created.action, "created");
  assert.equal(first.calls[2].args[3], FAILED_ISSUE_TITLE);
  assert.equal(first.calls[2].args[5], "bug");
  assert.match(
    first.calls[2].input,
    /\*\*Why:\*\* Corrupt tracker \(invalid JSON\)\./,
  );
  assert.match(
    first.calls[2].input,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/9/,
  );

  const again = stubGh({ open: [openIssue(7, FAILED_ISSUE_TITLE)] });
  assert.equal(
    syncFailureIssue(quietCfg, again, "Corrupt tracker (invalid JSON).").action,
    "commented",
  );
  assert.deepEqual(again.commands(), ["issue list", "issue comment"]);
  assert.match(
    again.calls[1].input,
    /^The voucher review failed again on 2026-10-14:/,
  );

  const healthy = stubGh({ open: [openIssue(7, FAILED_ISSUE_TITLE)] });
  assert.equal(syncFailureIssue(quietCfg, healthy, null).action, "closed");
  assert.match(
    healthy.calls[1].args[4],
    /^The voucher review ran normally on 2026-10-14/,
  );
});

// A fake gh that keeps its issues in a file, like the one the link checker tests use.
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

/** Puts the fake gh into a repository made by makeRepo(); returns the env to pass to runScript and readers. */
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
  };
}

test("end to end: a weekly reminder is a comment, not a new issue, and the issue closes as soon as no page has a problem, whatever pages declare no date", async () => {
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({
        title: "Microsoft Partner Certification Week",
        lines: ["voucherEnds: 2026-10-12"],
      }),
      esi: voucherPage({
        title: "Organizational Skilling (ESI)",
        category: '"50%"',
      }),
    },
  });
  const gh = await withIssues(repo);

  // day 1: the overdue offer opens the running issue, with the report as its text
  const day1 = await runScript(repo, "2026-10-14", gh.env);
  assert.equal(day1.code, 0, day1.stderr);
  assert.equal(gh.issues().length, 1);
  const [issue] = gh.issues();
  assert.equal(issue.title, "Voucher review: pages need attention");
  assert.deepEqual(issue.labels, ["enhancement"]);
  assert.equal(issue.body, day1.report);
  assert.match(issue.body, /This issue is a running thread/);
  assert.match(
    day1.stdout,
    /Review issue "Voucher review: pages need attention" created \(#1\)/,
  );
  // the workflow outputs keep the headline of the day's report
  assert.equal(
    day1.output.issue_title,
    "Voucher review 2026-10-14: partnerweek",
  );
  assert.equal(day1.output.baseline_updated, "true");

  // days 2..7: quiet. No comment, no new issue, not even a lookup.
  const callsAfterDay1 = gh.calls().length;
  for (const day of ["2026-10-15", "2026-10-20"]) {
    const quiet = await runScript(repo, day, gh.env);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.output.changes_found, "false");
  }
  assert.deepEqual(
    gh
      .calls()
      .slice(callsAfterDay1)
      .map((c) => c.command),
    ["issue list", "issue list"],
    "only the daily look for a failure issue to close",
  );

  // day 8: the reminder comes as a COMMENT on the same issue; the page without
  // a date is not in it
  const day8 = await runScript(repo, "2026-10-21", gh.env);
  assert.equal(day8.code, 0, day8.stderr);
  assert.equal(day8.output.changes_found, "true");
  assert.equal(
    day8.output.issue_title,
    "Voucher review 2026-10-21: partnerweek",
  );
  assert.match(day8.report, /reminder \(first reported 2026-10-14\)/);
  assert.doesNotMatch(
    day8.report,
    /Organizational Skilling|esi\b|without a date|### Pages without/,
  );
  assert.equal(gh.issues().length, 1, "no second issue");
  assert.equal(gh.issues()[0].comments.length, 1);
  assert.equal(gh.issues()[0].comments[0], day8.report);
  assert.equal(gh.issues()[0].state, "open");

  // the overdue offer is dated: no page has a problem any more, so the next run
  // closes the issue with a comment, although `esi` still carries no date (it is
  // a stable offer, nothing is asked of it)
  await writeFile(
    repo.voucher("partnerweek"),
    voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
  );
  const fixed = await runScript(repo, "2026-10-22", gh.env);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fixed.output.changes_found, "false");
  assert.equal(gh.issues()[0].state, "closed");
  assert.equal(
    gh.issues()[0].comments.at(-1),
    "No page has a problem as of 2026-10-22, so there is nothing left to review. Closing this issue; the next finding opens a new one.",
  );
  assert.match(fixed.stdout, /Review issue .* closed \(#1\)\./);
  const afterClose = gh.writes().length;
  await runScript(repo, "2026-10-24", gh.env);
  assert.equal(gh.writes().length, afterClose, "closed once");

  // a relapse opens a new issue
  const relapse = await runScript(repo, "2027-01-02", gh.env);
  assert.equal(relapse.output.changes_found, "true");
  assert.equal(gh.issues().length, 2);
  assert.equal(gh.issues()[1].state, "open");
});

test("end to end: an overdue beta announcement opens the running issue for the exam page, comes back as a reminder and closes once the post is linked", async () => {
  const pendingEntry = {
    code: "AZ-401",
    area: "azure",
    betaStart: "2026-10-14",
    announcement: "pending",
    flaggedGA: false,
  };
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }),
    },
    exams: ["AB-650", "AZ-401"],
    statuses: {
      aibusiness: { "AB-650": BETA_BADGE },
      azure: { "AZ-401": BETA_BADGE },
    },
    beta: [BETA_ANNOUNCED, pendingEntry],
  });
  const gh = await withIssues(repo);
  const before = repo.trackerText();

  // The beta began on 2026-10-14: the first 8 days (day 0 to day 7) are the
  // pending window the note may promise "within a few days".
  for (const day of ["2026-10-14", "2026-10-18", "2026-10-21"]) {
    const quiet = await runScript(repo, day, gh.env);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.deepEqual(quiet.output, QUIET, day);
    assert.equal(quiet.tracker, before, `${day}: no churn commit`);
  }
  assert.deepEqual(
    gh.writes(),
    [],
    "nothing is opened for a window that is not over",
  );

  // Day 8: overdue. The report is the text of the running issue.
  const day8 = await runScript(repo, "2026-10-22", gh.env);
  assert.equal(day8.code, 0, day8.stderr);
  assert.deepEqual(day8.output, {
    changes_found: "true",
    baseline_updated: "true",
    extraction_failed: "false",
    issue_title: "Voucher review 2026-10-22: AZ-401",
  });
  assert.equal(gh.issues().length, 1);
  assert.equal(gh.issues()[0].title, REVIEW_ISSUE_TITLE);
  assert.equal(gh.issues()[0].body, day8.report);
  assert.match(
    day8.report,
    /\| \[AZ-401\]\(https:\/\/example\.test\/certs\/azure\/az-401\/\)<br>`src\/content\/docs\/azure\/AZ-401\.mdx` \| the exam page note of beta exam `AZ-401` still promises the Skills Hub blog announcement "within a few days", 8 days after the beta began on 2026-10-14 \(`announcement` is `pending`\); check the blog: if the post is out, set `announcement` to its address, run `node scripts\/beta-note\.mjs --code AZ-401 --expects "<wording>"` and add the beta voucher page; if there is none, set `announcement` to `unannounced` and run `node scripts\/beta-note\.mjs --code AZ-401` \| new \| n\/a \|/,
  );
  assert.deepEqual(JSON.parse(day8.tracker).pages, {
    "azure/AZ-401": {
      firstReported: "2026-10-22",
      lastReported: "2026-10-22",
      reasons: ["beta-announcement-overdue:AZ-401:2026-10-14"],
    },
  });
  assert.equal(writtenFormatProblem(day8.tracker), null);

  // The same problem is quiet for six days (the count of days in the text
  // moves, the problem does not) and a reminder comment on the seventh.
  for (const day of ["2026-10-23", "2026-10-28"]) {
    const quiet = await runScript(repo, day, gh.env);
    assert.deepEqual(quiet.output, QUIET, day);
    assert.equal(quiet.tracker, day8.tracker, `${day}: no churn commit`);
  }
  const day15 = await runScript(repo, "2026-10-29", gh.env);
  assert.equal(day15.output.changes_found, "true");
  assert.match(day15.report, /reminder \(first reported 2026-10-22\)/);
  assert.match(day15.report, /15 days after the beta began/);
  assert.equal(gh.issues().length, 1, "no second issue");
  assert.deepEqual(gh.issues()[0].comments, [day15.report]);

  // The post is out and the note is switched: the exam page leaves the list
  // and, nothing else being wrong, the issue closes.
  await repo.setBeta([
    BETA_ANNOUNCED,
    { ...pendingEntry, announcement: ANNOUNCEMENT },
  ]);
  const fixed = await runScript(repo, "2026-10-30", gh.env);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fixed.output.changes_found, "false");
  assert.equal(fixed.output.baseline_updated, "true");
  assert.deepEqual(JSON.parse(fixed.tracker).pages, {});
  assert.equal(gh.issues()[0].state, "closed");

  // The announcement is reported as unannounced instead: also settled.
  await repo.setBeta([
    BETA_ANNOUNCED,
    { ...pendingEntry, announcement: "unannounced" },
  ]);
  const unannounced = await runScript(repo, "2026-10-31", gh.env);
  assert.deepEqual(unannounced.output, QUIET);
});

test("end to end: a failing check raises one issue, comments on it while it keeps failing and closes it when healthy", async () => {
  const repo = await makeRepo({
    vouchers: { x: voucherPage({ lines: ["voucherEnds: 2026-12-31"] }) },
    tracker: "{ nope",
  });
  const gh = await withIssues(repo);

  const first = await runScript(repo, "2026-10-14", gh.env);
  assert.equal(first.code, 1);
  assert.equal(first.output.extraction_failed, "true");
  assert.equal(first.output.baseline_updated, "false");
  assert.equal(gh.issues().length, 1);
  assert.equal(gh.issues()[0].title, "Voucher review: the check failed");
  assert.deepEqual(gh.issues()[0].labels, ["bug"]);
  assert.match(gh.issues()[0].body, /Corrupt tracker .*\(invalid JSON\)/);
  assert.equal(first.tracker, "{ nope", "a corrupt tracker is never replaced");

  // days later, still failing: a comment on the same issue, one per run
  const second = await runScript(repo, "2026-10-15", gh.env);
  assert.equal(second.code, 1);
  const third = await runScript(repo, "2026-10-16", gh.env);
  assert.equal(third.code, 1);
  assert.equal(gh.issues().length, 1, "never one issue per run");
  assert.equal(gh.issues()[0].comments.length, 2);
  assert.match(
    gh.issues()[0].comments[0],
    /^The voucher review failed again on 2026-10-15:/,
  );

  // restored: the healthy run closes the alert
  await repo.setTracker(trackerContent(emptyTracker()));
  const healthy = await runScript(repo, "2026-10-17", gh.env);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(gh.issues()[0].state, "closed");
  assert.match(
    gh.issues()[0].comments.at(-1),
    /^The voucher review ran normally on 2026-10-17/,
  );
});

test("end to end: when the issue cannot be written the run fails, the tracker is not reported as updated, and the next run reports again", async () => {
  const initial = trackerContent(emptyTracker());
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-10-12"] }),
    },
    tracker: initial,
  });
  const gh = await withIssues(repo);

  for (const failing of ["issue create", "issue list"]) {
    const failed = await runScript(repo, "2026-10-14", {
      ...gh.env,
      FAKE_GH_FAIL: failing,
    });
    assert.equal(failed.code, 1, failing);
    assert.deepEqual(failed.output, {
      changes_found: "false",
      baseline_updated: "false",
      extraction_failed: "true",
      issue_title: "",
    });
    assert.match(failed.error, new RegExp(`gh ${failing} failed`));
    assert.equal(
      gh.issues().filter((i) => i.title === REVIEW_ISSUE_TITLE).length,
      0,
    );
    // main still holds the old tracker (the workflow did not commit): start over from it
    await repo.setTracker(initial);
  }

  const retried = await runScript(repo, "2026-10-14", gh.env);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.output.baseline_updated, "true");
  assert.equal(
    gh.issues().filter((i) => i.title === REVIEW_ISSUE_TITLE).length,
    1,
  );
});

test("end to end: DRY_RUN and CREATE_ISSUES=0 touch no issue, but the report and the tracker are still written", async () => {
  const repo = await makeRepo({
    vouchers: {
      partnerweek: voucherPage({ lines: ["voucherEnds: 2026-10-12"] }),
    },
  });
  const gh = await withIssues(repo);

  const dry = await runScript(repo, "2026-10-14", { ...gh.env, DRY_RUN: "1" });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(gh.calls(), []);
  assert.match(dry.stdout, /not touched \(DRY_RUN\)/);
  assert.match(dry.report, /partnerweek|Partner/);
  assert.equal(dry.output.baseline_updated, "true");

  await repo.setTracker(trackerContent(emptyTracker()));
  const off = await runScript(repo, "2026-10-14", {
    ...gh.env,
    CREATE_ISSUES: "0",
  });
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(gh.calls(), []);
  assert.match(off.stdout, /not touched \(CREATE_ISSUES is not 1\)/);
});

test("TODAY must be a real date, otherwise the clock decides", () => {
  assert.equal(loadConfig({ TODAY: "2026-10-14" }).today, "2026-10-14");
  assert.match(
    loadConfig({ TODAY: "2026-02-31" }).today,
    /^\d{4}-\d{2}-\d{2}$/,
  );
  assert.notEqual(loadConfig({ TODAY: "2026-02-31" }).today, "2026-02-31");
  assert.equal(loadConfig({ REMINDER_DAYS: "3" }).reminderDays, 3);
  assert.equal(loadConfig({ REMINDER_DAYS: "-1" }).reminderDays, 7);
  assert.equal(loadConfig({}).reportAll, false);
  assert.equal(loadConfig({ REPORT_ALL: "1" }).reportAll, true);
});

// ---------------------------------------------------------------------------
// The workflow and the files it replaced
// ---------------------------------------------------------------------------
// LF whatever core.autocrlf did to the checkout.
const readWorkflow = (name) =>
  readFileSync(join(root, ".github", "workflows", name), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const workflowSource = readWorkflow("voucher-review.yml");

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

const workflowStep = (name) => {
  const step = workflowSteps().find((candidate) => candidate.name === name);
  assert.ok(step, `no workflow step named "${name}"`);
  return step;
};

const STEP_CHECK = "Review the voucher pages";
const STEP_COMMIT = "Commit updated voucher review tracker";

test("the check step opens the issue before the workflow commits the tracker, so a failed issue is retried", () => {
  const names = workflowSteps().map((step) => step.name);
  assert.deepEqual(
    names.filter(Boolean),
    [STEP_CHECK, STEP_COMMIT],
    "the issues are handled inside the script: no separate issue step is left",
  );
  // No status-check function: the implicit success() skips the commit when the
  // check step (which opens the issue) failed, so the pages are reported again
  // on the next run.
  assert.equal(
    workflowStep(STEP_COMMIT).condition,
    "steps.check.outputs.baseline_updated == 'true'",
  );
  assert.doesNotMatch(
    workflowStep(STEP_COMMIT).condition,
    /always\(\)|failure\(\)/,
  );
  assert.match(
    workflowStep(STEP_COMMIT).text,
    /git add src\/data_files\/voucher-review\.json/,
  );
  // a rejected push is retried on top of what another monitor pushed meanwhile
  assert.match(workflowStep(STEP_COMMIT).text, /for attempt in 1 2 3; do/);
  assert.match(
    workflowStep(STEP_COMMIT).text,
    /git pull --rebase && git push && exit 0/,
  );
  assert.doesNotMatch(
    workflowSource,
    /create-issue-from-file|steps\.check\.outputs\.issue_title/,
    "no issue per run with a date in its title any more",
  );
});

test("the check step may create, comment on and close issues, and says so through the environment the script reads", () => {
  const env = workflowStep(STEP_CHECK).text;
  assert.match(env, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(env, /CREATE_ISSUES: "1"/);
  assert.match(
    workflowSource,
    /^ {6}REPORT_FILE: \/tmp\/voucher-review-report\.md$/m,
  );
  assert.match(
    workflowSource,
    /^ {6}ERROR_FILE: \/tmp\/voucher-review-error\.md$/m,
  );
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(workflowSource, /node-version-file: \.node-version/);
  assert.match(
    workflowSource,
    /^ {2}group: voucher-review\n {2}cancel-in-progress: false$/m,
  );
  // the stable titles named in the workflow comment are the script's
  assert.ok(workflowSource.includes(`"${REVIEW_ISSUE_TITLE}"`));
  assert.ok(workflowSource.includes(`"${FAILED_ISSUE_TITLE}"`));
});

test("a manual run can report everything through the input the script reads", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  assert.match(dispatch, /^ {4}inputs:\n {6}report_all:\n/);
  assert.match(dispatch, /^ {8}type: boolean$/m);
  assert.match(dispatch, /^ {8}default: false$/m);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /REPORT_ALL: \$\{\{ inputs\.report_all && '1' \|\| '' \}\}/,
  );
  // What it does now: every open finding, ignoring earlier reports, and no list of pages without a date.
  assert.match(
    dispatch,
    /^ {8}description: "Report every open finding now, ignoring what an earlier run already reported \(also on the very first run\)"$/m,
  );
});

test("the workflow does not talk about a list of pages without a date or a date every page must carry", () => {
  assert.doesNotMatch(
    workflowSource,
    /without a date|every page has a date|inventory|undated/i,
  );
  // It says what a page without date fields is, and when the issue closes.
  assert.match(
    workflowSource,
    /closes it with a comment when no\n {6}# page has a problem\. A voucher page that declares no date and no linked exam\n {6}# is a stable offer: nothing is asked of it and no report lists it\./,
  );
});

test("the schedule is daily and no other monitor that pushes to main starts in the same minute", () => {
  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (match) => match.slice(1, 6),
    );
  const [mine, ...extra] = cron(workflowSource);
  assert.equal(extra.length, 0, "one schedule");
  assert.deepEqual(mine.slice(2), ["*", "*", "*"], "every day");

  const dir = join(root, ".github", "workflows");
  for (const name of readdirSync(dir)) {
    if (name === "voucher-review.yml" || !name.endsWith(".yml")) continue;
    const other = readWorkflow(name);
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

test("the old pull-request based expiry check is gone and nothing refers to it", () => {
  assert.ok(
    !existsSync(join(root, ".github", "workflows", "voucher-expiry.yml")),
  );
  assert.ok(!existsSync(join(root, "scripts", "voucher-expiry-check.sh")));

  const needles = ["voucher-expiry", "expired-vouchers", "voucher-changes"];
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    ".astro",
    ".github-cache",
  ]);
  const hits = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(mjs|js|ts|yml|yaml|json|astro|sh)$/.test(entry.name)) {
        // The tests and the script's own history note name the old files.
        if (path === script || path.endsWith("voucher-review-check.test.mjs")) {
          continue;
        }
        const text = readFileSync(path, "utf8");
        if (needles.some((needle) => text.includes(needle))) hits.push(path);
      }
    }
  })(root);
  assert.deepEqual(hits, []);
});
