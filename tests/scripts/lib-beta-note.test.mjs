import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { USAGE, UsageError, parseArgs, run } from "../../scripts/beta-note.mjs";
import {
  ABOUT_BETA_EXAMS_URL,
  BETA_NOTE_STATES,
  PENDING_ANNOUNCEMENT_DAYS,
  SKILLS_HUB_BLOG_URL,
  announcementState,
  betaTimeline,
  buildBetaNote,
  checkBetaNote,
  findBetaNote,
  formatLongDate,
  inspectBetaNote,
} from "../../scripts/lib/beta-note.mjs";

const root = resolve(import.meta.dirname, "../..");
const libFile = join(root, "scripts", "lib", "beta-note.mjs");
const script = join(root, "scripts", "beta-note.mjs");

// The notes of the three reference pages, byte for byte as they were when the
// generator was written: AB-650 (announced), AZ-401 (pending) and GH-700
// (pending, with its own scoring wording). They are pinned here so that these
// checks keep their meaning after an exam leaves beta; the last tests compare
// the live pages with the generator.
const AB_650_URL =
  "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-microsoft-365-certified-ai-services-administrator-associate-certification/4494123?WT.mc_id=studentamb_165290";
const AB_650_EXPECTS =
  "general availability of this certification in October 2026";
const AB_650_NOTE =
  "The beta period began on July 28, 2026. Microsoft's [announcement](https://techcommunity.microsoft.com/blog/skills-hub-blog/new-microsoft-365-certified-ai-services-administrator-associate-certification/4494123?WT.mc_id=studentamb_165290) expects general availability of this certification in October 2026. Microsoft also usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from July 28, 2026 this exam is expected to leave beta between October 6, 2026 and October 20, 2026. Beta scores are released about 10 days after that, so expect results between October 16, 2026 and October 30, 2026. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information.";
const AZ_401_NOTE =
  "The beta period began on October 14, 2026. Microsoft usually announces a new beta exam on the [Skills Hub blog](https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog?WT.mc_id=studentamb_165290) with an 80% discount code for the first 300 candidates. That announcement has not been published for this exam yet and should arrive within a few days, so check back before you pay full price. Microsoft usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from October 14, 2026 this exam is expected to leave beta between December 23, 2026 and January 6, 2027. Beta scores are released about 10 days after that, so expect results between January 2, 2027 and January 16, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information about the 80% discount and early access to codes.";
// GH-700 replaces the generated scoring sentence of AZ-401's note by its own.
const AZ_401_SCORES =
  "Beta scores are released about 10 days after that, so expect results between January 2, 2027 and January 16, 2027.";
const GH_700_NOTE =
  "The beta period began on October 14, 2026. Microsoft usually announces a new beta exam on the [Skills Hub blog](https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog?WT.mc_id=studentamb_165290) with an 80% discount code for the first 300 candidates. That announcement has not been published for this exam yet and should arrive within a few days, so check back before you pay full price. Microsoft usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from October 14, 2026 this exam is expected to leave beta between December 23, 2026 and January 6, 2027. Beta scores are usually released about 10 days after that, which would be between January 2, 2027 and January 16, 2027. However, Microsoft Learn's [certification page](https://learn.microsoft.com/credentials/certifications/agentic-ai-business-professional/?WT.mc_id=studentamb_165290) says that scores will be released approximately eight weeks after the beta period concludes, which would be between February 17, 2027 and March 3, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information about the 80% discount and early access to codes.";
// No page is in the third state yet: this is the wording specified for it.
const UNANNOUNCED_NOTE =
  "The beta period began on October 14, 2026. We have not found an official go-live announcement from Microsoft yet. Microsoft usually releases a beta exam as generally available [10-12 weeks after the beta period begins](https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290), so counting from October 14, 2026 this exam is expected to leave beta between December 23, 2026 and January 6, 2027. Beta scores are released about 10 days after that, so expect results between January 2, 2027 and January 16, 2027. These dates are estimates and can shift, and waiting for a score can take up to 14 weeks. See the [Beta Exams](/certs/vouchers/betaexams/) page for more information.";
const AB_650_ANNOUNCEMENT = `Microsoft's [announcement](${AB_650_URL}) expects ${AB_650_EXPECTS}.`;
const AB_650_ANNOUNCEMENT_WITHOUT_EXPECTS = `Microsoft announced this beta exam in its [announcement](${AB_650_URL}).`;

const note = (text) => `:::note\n${text}\n:::`;
const bodyOf = (block) =>
  block.slice(":::note\n".length, block.length - "\n:::".length);

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test("the shared constants are the ones the pages use", () => {
  assert.equal(
    ABOUT_BETA_EXAMS_URL,
    "https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290",
  );
  assert.equal(
    SKILLS_HUB_BLOG_URL,
    "https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog?WT.mc_id=studentamb_165290",
  );
  assert.equal(PENDING_ANNOUNCEMENT_DAYS, 7);
  assert.deepEqual(
    [...BETA_NOTE_STATES],
    ["announced", "pending", "unannounced"],
  );
  assert.ok(Object.isFrozen(BETA_NOTE_STATES));
});

test("the module reads no clock, no locale and no file, and imports nothing", () => {
  const source = readFileSync(libFile, "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\(|\brequire\(/m);
  assert.doesNotMatch(
    source,
    /Date\.now|new Date\(\s*\)|toLocale|\bIntl\b|\bprocess\b|readFileSync|writeFileSync/,
  );
});

// ---------------------------------------------------------------------------
// formatLongDate
// ---------------------------------------------------------------------------

test("formatLongDate writes every month of the year in English, without zero padding", () => {
  const months = [
    ["2026-01-05", "January 5, 2026"],
    ["2026-02-05", "February 5, 2026"],
    ["2026-03-05", "March 5, 2026"],
    ["2026-04-05", "April 5, 2026"],
    ["2026-05-05", "May 5, 2026"],
    ["2026-06-05", "June 5, 2026"],
    ["2026-07-05", "July 5, 2026"],
    ["2026-08-05", "August 5, 2026"],
    ["2026-09-05", "September 5, 2026"],
    ["2026-10-30", "October 30, 2026"],
    ["2026-11-05", "November 5, 2026"],
    ["2026-12-05", "December 5, 2026"],
  ];
  for (const [iso, text] of months) assert.equal(formatLongDate(iso), text);
});

test("formatLongDate: month ends, the leap day and the year rollover", () => {
  for (const [iso, text] of [
    ["2026-01-31", "January 31, 2026"],
    ["2026-02-28", "February 28, 2026"],
    ["2026-04-30", "April 30, 2026"],
    ["2026-12-31", "December 31, 2026"],
    ["2027-01-01", "January 1, 2027"],
    ["2028-02-29", "February 29, 2028"],
    ["2028-03-01", "March 1, 2028"],
  ]) {
    assert.equal(formatLongDate(iso), text);
  }
  const utc = (...parts) => new Date(Date.UTC(...parts));
  assert.equal(formatLongDate(utc(2028, 1, 29)), "February 29, 2028");
  assert.equal(formatLongDate(utc(2028, 1, 30)), "March 1, 2028");
  assert.equal(formatLongDate(utc(2027, 1, 29)), "March 1, 2027");
  assert.equal(formatLongDate(utc(2026, 11, 31 + 1)), "January 1, 2027");
});

test("formatLongDate reads a Date in UTC, whatever the time zone of the machine", () => {
  assert.equal(
    formatLongDate(new Date("2026-10-30T23:59:59.999Z")),
    "October 30, 2026",
  );
  assert.equal(
    formatLongDate(new Date("2026-10-31T00:00:00.000Z")),
    "October 31, 2026",
  );
  // A machine east of Greenwich already has the next day at this instant.
  assert.equal(
    formatLongDate(new Date("2026-10-30T23:30:00Z")),
    "October 30, 2026",
  );
  assert.equal(
    formatLongDate(new Date("2026-10-31T00:30:00+02:00")),
    "October 30, 2026",
  );
});

test("formatLongDate rejects what is not a date", () => {
  for (const bad of [
    "2026-02-31",
    "2027-02-29",
    "2026-13-01",
    "October 30, 2026",
    "30/10/2026",
    "2026-10-30T00:00:00Z",
    "",
    undefined,
    null,
    20261030,
    {},
  ]) {
    assert.throws(
      () => formatLongDate(bad),
      /A date must be a real day written YYYY-MM-DD/,
      String(bad),
    );
  }
  assert.throws(() => formatLongDate(new Date("nope")), /Invalid Date/);
});

// ---------------------------------------------------------------------------
// betaTimeline
// ---------------------------------------------------------------------------

test("betaTimeline: go-live 10-12 weeks after the beta start, scores 10 days after that", () => {
  const cases = [
    // [start, goLiveFrom, goLiveTo, scoresFrom, scoresTo]
    [
      "2026-07-28",
      "October 6, 2026",
      "October 20, 2026",
      "October 16, 2026",
      "October 30, 2026",
    ],
    [
      "2026-10-14",
      "December 23, 2026",
      "January 6, 2027",
      "January 2, 2027",
      "January 16, 2027",
    ],
    [
      "2027-03-01",
      "May 10, 2027",
      "May 24, 2027",
      "May 20, 2027",
      "June 3, 2027",
    ],
    // the leap day, a year end, a start in February, a window across Feb 29
    [
      "2028-02-29",
      "May 9, 2028",
      "May 23, 2028",
      "May 19, 2028",
      "June 2, 2028",
    ],
    [
      "2026-12-31",
      "March 11, 2027",
      "March 25, 2027",
      "March 21, 2027",
      "April 4, 2027",
    ],
    [
      "2026-02-28",
      "May 9, 2026",
      "May 23, 2026",
      "May 19, 2026",
      "June 2, 2026",
    ],
    [
      "2027-12-20",
      "February 28, 2028",
      "March 13, 2028",
      "March 9, 2028",
      "March 23, 2028",
    ],
  ];
  for (const [start, goLiveFrom, goLiveTo, scoresFrom, scoresTo] of cases) {
    const timeline = betaTimeline(start);
    assert.deepEqual(
      [
        timeline.startText,
        timeline.goLiveFromText,
        timeline.goLiveToText,
        timeline.scoresFromText,
        timeline.scoresToText,
      ],
      [formatLongDate(start), goLiveFrom, goLiveTo, scoresFrom, scoresTo],
      start,
    );
  }
});

test("betaTimeline returns UTC midnight Dates next to the same dates as text", () => {
  const timeline = betaTimeline("2026-10-14");
  assert.deepEqual(Object.keys(timeline).sort(), [
    "goLiveFrom",
    "goLiveFromText",
    "goLiveTo",
    "goLiveToText",
    "scoresFrom",
    "scoresFromText",
    "scoresTo",
    "scoresToText",
    "start",
    "startText",
  ]);
  const iso = (key) => timeline[key].toISOString();
  assert.equal(iso("start"), "2026-10-14T00:00:00.000Z");
  assert.equal(iso("goLiveFrom"), "2026-12-23T00:00:00.000Z");
  assert.equal(iso("goLiveTo"), "2027-01-06T00:00:00.000Z");
  assert.equal(iso("scoresFrom"), "2027-01-02T00:00:00.000Z");
  assert.equal(iso("scoresTo"), "2027-01-16T00:00:00.000Z");
  assert.equal(timeline.startText, "October 14, 2026");
});

// An independent calendar: one day at a time, no Date involved.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const isLeap = (year) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
function walk([year, month, day], days) {
  const lengths = [
    31,
    isLeap(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  for (let left = days; left > 0; left--) {
    day++;
    if (day > lengths[month - 1]) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
        lengths[1] = isLeap(year) ? 29 : 28;
      }
    }
  }
  return [year, month, day];
}
const written = ([year, month, day]) =>
  `${MONTH_NAMES[month - 1]} ${day}, ${year}`;

test("betaTimeline agrees with a day-by-day calendar for every day of four years", () => {
  let checked = 0;
  for (let year = 2026; year <= 2029; year++) {
    let date = [year, 1, 1];
    while (date[0] === year) {
      const start = date
        .map((part, i) => String(part).padStart(i ? 2 : 4, "0"))
        .join("-");
      const timeline = betaTimeline(start);
      assert.deepEqual(
        [
          timeline.startText,
          timeline.goLiveFromText,
          timeline.goLiveToText,
          timeline.scoresFromText,
          timeline.scoresToText,
        ],
        [
          written(date),
          written(walk(date, 70)),
          written(walk(date, 84)),
          written(walk(date, 80)),
          written(walk(date, 94)),
        ],
        start,
      );
      date = walk(date, 1);
      checked++;
    }
  }
  assert.equal(checked, 365 * 4 + 1);
});

test("betaTimeline rejects anything that is not a real YYYY-MM-DD day", () => {
  for (const bad of [
    "2026-02-31",
    "2026-04-31",
    "2027-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-32",
    "2026-1-5",
    "26-10-14",
    "20261014",
    "2026/10/14",
    "2026-10-14T00:00:00Z",
    " 2026-10-14",
    "2026-10-14 ",
    "October 14, 2026",
    "0099-01-01",
    "",
    undefined,
    null,
    20261014,
    new Date(Date.UTC(2026, 9, 14)),
  ]) {
    assert.throws(
      () => betaTimeline(bad),
      (error) =>
        /The beta start must be a real day written YYYY-MM-DD/.test(
          error.message,
        ) && error.message.includes(JSON.stringify(bad) ?? "undefined"),
      String(bad),
    );
  }
  assert.throws(
    () => betaTimeline("2026-02-31"),
    /\(got "2026-02-31"\)/,
    "the message names the value",
  );
});

test("the dates and the notes do not depend on the time zone or the language of the machine", () => {
  const starts = [
    "2026-03-01",
    "2026-07-28",
    "2026-10-14",
    "2027-03-01",
    "2028-02-29",
    "2026-12-31",
  ];
  const snapshot = (lib) => ({
    timelines: starts.map((start) => {
      const timeline = lib.betaTimeline(start);
      return [
        timeline.startText,
        timeline.goLiveFromText,
        timeline.goLiveToText,
        timeline.scoresFromText,
        timeline.scoresToText,
      ];
    }),
    notes: starts.map((start) =>
      lib.buildBetaNote({ start, announcement: "pending" }),
    ),
    late: lib.formatLongDate(new Date(Date.UTC(2026, 9, 30, 23, 30))),
  });
  const expected = JSON.stringify(
    snapshot({ betaTimeline, buildBetaNote, formatLongDate }),
  );
  const program = `
    import * as lib from ${JSON.stringify(pathToFileURL(libFile).href)};
    const starts = ${JSON.stringify(starts)};
    console.log(JSON.stringify({
      timelines: starts.map((start) => {
        const timeline = lib.betaTimeline(start);
        return [timeline.startText, timeline.goLiveFromText, timeline.goLiveToText, timeline.scoresFromText, timeline.scoresToText];
      }),
      notes: starts.map((start) => lib.buildBetaNote({ start, announcement: "pending" })),
      late: lib.formatLongDate(new Date(Date.UTC(2026, 9, 30, 23, 30))),
    }));
  `;
  for (const zone of [
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
    "America/Los_Angeles",
    "Asia/Kolkata",
    "Europe/Berlin",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", program],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TZ: zone,
          LANG: "de_DE.UTF-8",
          LC_ALL: "de_DE.UTF-8",
        },
      },
    );
    assert.equal(result.status, 0, `${zone}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), expected, zone);
  }
});

// ---------------------------------------------------------------------------
// announcementState
// ---------------------------------------------------------------------------

test("announcementState: the two tokens, or an https URL for an announced exam", () => {
  assert.equal(announcementState("pending"), "pending");
  assert.equal(announcementState("unannounced"), "unannounced");
  assert.equal(announcementState(AB_650_URL), "announced");
  assert.equal(
    announcementState(
      "https://techcommunity.microsoft.com/blog/skills-hub-blog/x/1",
    ),
    "announced",
  );
  assert.equal(announcementState("https://example.com"), "announced");
});

test("announcementState rejects everything else, with a message that says what is allowed", () => {
  for (const bad of [
    "Pending",
    "PENDING",
    " pending",
    "pending ",
    "announced",
    "none",
    "",
    undefined,
    null,
    true,
    5,
    {},
    "http://techcommunity.microsoft.com/blog/x/1",
    "HTTPS://example.com/x",
    "https://",
    "https:/example.com/x",
    "ftp://example.com/x",
    "javascript:alert(1)",
    "/blog/skills-hub-blog/x/1",
    "https://example.com/a b",
    "https://example.com/x\n",
    "https://example.com/a(b)",
    "https://example.com/<x>",
    "https://example.com/{x}",
    "https://example.com/a\\b",
  ]) {
    assert.throws(
      () => announcementState(bad),
      /An announcement must be "pending", "unannounced" or an https URL/,
      JSON.stringify(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// buildBetaNote
// ---------------------------------------------------------------------------

test("buildBetaNote reproduces the announced note of AB-650 byte for byte", () => {
  assert.equal(
    buildBetaNote({
      start: "2026-07-28",
      announcement: AB_650_URL,
      expects: AB_650_EXPECTS,
    }),
    note(AB_650_NOTE),
  );
});

test("buildBetaNote reproduces the pending note of AZ-401 byte for byte", () => {
  assert.equal(
    buildBetaNote({ start: "2026-10-14", announcement: "pending" }),
    note(AZ_401_NOTE),
  );
});

test("the note of GH-700 is the generated pending note with its scoring sentence replaced by its own wording", () => {
  const generated = bodyOf(
    buildBetaNote({ start: "2026-10-14", announcement: "pending" }),
  );
  const at = generated.indexOf(AZ_401_SCORES);
  assert.ok(at > 0, "the generated note has the generic scoring sentence");
  const head = generated.slice(0, at);
  const tail = generated.slice(at + AZ_401_SCORES.length);
  assert.ok(GH_700_NOTE.startsWith(head), "everything before it is generated");
  assert.ok(GH_700_NOTE.endsWith(tail), "everything after it is generated");
  const own = GH_700_NOTE.slice(head.length, GH_700_NOTE.length - tail.length);
  assert.match(
    own,
    /^Beta scores are usually released about 10 days after that, which would be between January 2, 2027 and January 16, 2027\. However, Microsoft Learn's \[certification page\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/agentic-ai-business-professional\/\?WT\.mc_id=studentamb_165290\) says that scores will be released approximately eight weeks after the beta period concludes, which would be between February 17, 2027 and March 3, 2027\.$/,
  );
});

test("buildBetaNote writes the unannounced note", () => {
  assert.equal(
    buildBetaNote({ start: "2026-10-14", announcement: "unannounced" }),
    note(UNANNOUNCED_NOTE),
  );
});

test("an announced note without `expects` only says that Microsoft announced the exam", () => {
  const built = buildBetaNote({
    start: "2026-07-28",
    announcement: AB_650_URL,
  });
  assert.equal(
    built,
    note(
      AB_650_NOTE.replace(
        AB_650_ANNOUNCEMENT,
        AB_650_ANNOUNCEMENT_WITHOUT_EXPECTS,
      ),
    ),
  );
  assert.ok(built.includes(AB_650_ANNOUNCEMENT_WITHOUT_EXPECTS));
  assert.doesNotMatch(built, /expects|general availability of this/);
  // `expects` that says nothing is the same as none.
  for (const nothing of [undefined, null, "", "   "]) {
    assert.equal(
      buildBetaNote({
        start: "2026-07-28",
        announcement: AB_650_URL,
        expects: nothing,
      }),
      built,
      JSON.stringify(nothing),
    );
  }
});

test("`expects` is Microsoft's own wording, trimmed, and goes in as the fragment of one sentence", () => {
  const built = buildBetaNote({
    start: "2026-07-28",
    announcement: AB_650_URL,
    expects: `  ${AB_650_EXPECTS}  `,
  });
  assert.equal(built, note(AB_650_NOTE));
  assert.ok(
    buildBetaNote({
      start: "2026-07-28",
      announcement: AB_650_URL,
      expects: "an exact go-live date of November 3, 2026 (Q2 FY27)",
    }).includes(
      " expects an exact go-live date of November 3, 2026 (Q2 FY27). ",
    ),
  );
});

test("`expects` only goes with an announced note, on one line, without a final period or MDX syntax", () => {
  const announced = { start: "2026-07-28", announcement: AB_650_URL };
  for (const announcement of ["pending", "unannounced"]) {
    assert.throws(
      () =>
        buildBetaNote({
          start: "2026-07-28",
          announcement,
          expects: AB_650_EXPECTS,
        }),
      new RegExp(
        `only goes with an announced note \\(the announcement is "${announcement}"\\)`,
      ),
    );
  }
  assert.throws(
    () => buildBetaNote({ ...announced, expects: "line one\nline two" }),
    /one line/,
  );
  assert.throws(
    () => buildBetaNote({ ...announced, expects: "release in <October>" }),
    /one line without/,
  );
  assert.throws(
    () => buildBetaNote({ ...announced, expects: "release {soon}" }),
    /one line without/,
  );
  assert.throws(
    () => buildBetaNote({ ...announced, expects: `${AB_650_EXPECTS}.` }),
    /adds the final period itself/,
  );
  assert.throws(
    () => buildBetaNote({ ...announced, expects: 2026 }),
    /"expects" must be a string/,
  );
});

test("buildBetaNote is one note block of three lines and no trailing newline", () => {
  for (const [announcement, expects] of [
    ["pending"],
    ["unannounced"],
    [AB_650_URL, AB_650_EXPECTS],
    [AB_650_URL],
  ]) {
    const built = buildBetaNote({ start: "2026-10-14", announcement, expects });
    const lines = built.split("\n");
    assert.equal(lines.length, 3, built);
    assert.equal(lines[0], ":::note");
    assert.equal(lines[2], ":::");
    assert.ok(
      lines[1].startsWith("The beta period began on October 14, 2026."),
    );
    assert.ok(!built.endsWith("\n"));
    assert.ok(!built.includes("\r"));
  }
});

test("only the dates, the URL and `expects` vary between two notes of the same state", () => {
  const mask = (text) => text.replace(/[A-Z][a-z]+ \d{1,2}, \d{4}/g, "<date>");
  for (const [announcement, expects] of [
    ["pending"],
    ["unannounced"],
    [AB_650_URL, AB_650_EXPECTS],
  ]) {
    const early = buildBetaNote({ start: "2026-03-01", announcement, expects });
    const late = buildBetaNote({ start: "2027-11-30", announcement, expects });
    assert.notEqual(early, late);
    assert.equal(mask(early), mask(late));
    // the beta start twice, the go-live window, the score window
    assert.equal(mask(early).match(/<date>/g).length, 6, mask(early));
  }
  // a second announcement URL changes that URL and nothing else
  const other = "https://techcommunity.microsoft.com/blog/skills-hub-blog/x/1";
  assert.equal(
    buildBetaNote({ start: "2026-07-28", announcement: other }).replace(
      other,
      AB_650_URL,
    ),
    buildBetaNote({ start: "2026-07-28", announcement: AB_650_URL }),
  );
});

test("buildBetaNote refuses a start or an announcement that is not usable", () => {
  assert.throws(
    () => buildBetaNote({ start: "2026-02-31", announcement: "pending" }),
    /The beta start must be a real day written YYYY-MM-DD \(got "2026-02-31"\)/,
  );
  assert.throws(
    () => buildBetaNote({ start: "2026-10-14", announcement: "soon" }),
    /An announcement must be "pending", "unannounced" or an https URL/,
  );
  assert.throws(
    () => buildBetaNote({ start: "2026-10-14" }),
    /An announcement must be/,
  );
  assert.throws(
    () => buildBetaNote({ announcement: "pending" }),
    /The beta start must be/,
  );
  assert.throws(() => buildBetaNote(), /The beta start must be/);
});

test("every note buildBetaNote writes passes checkBetaNote, whatever the start", () => {
  const starts = [];
  for (const year of [2026, 2027, 2028]) {
    for (let month = 1; month <= 12; month++) {
      const mm = String(month).padStart(2, "0");
      starts.push(`${year}-${mm}-01`, `${year}-${mm}-28`);
    }
  }
  starts.push("2028-02-29", "2026-12-31", "2027-12-31");
  for (const start of starts) {
    for (const [announcement, expects] of [
      ["pending"],
      ["unannounced"],
      [AB_650_URL, AB_650_EXPECTS],
      [AB_650_URL],
    ]) {
      const text = bodyOf(buildBetaNote({ start, announcement, expects }));
      assert.deepEqual(
        checkBetaNote({ noteText: text, start, announcement, expects }),
        [],
        `${start} ${announcement}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// findBetaNote / inspectBetaNote
// ---------------------------------------------------------------------------

const TIP =
  ":::tip\nThis is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.\n\nIf you have any resources that you would like to recommend, please let us know and we will add them.\n:::";
const page = (...blocks) =>
  `---\ntitle: AZ-999 Study Materials\n---\nimport { Card } from '@components/docs';\n\n${blocks.join("\n\n")}\n\n<Card title="Get Started" icon="star">\n\n</Card>\n`;

test("findBetaNote returns the text of the note that follows the beta tip", () => {
  const found = findBetaNote(page(TIP, note(AZ_401_NOTE)));
  assert.deepEqual(found, { found: true, text: AZ_401_NOTE });
  assert.deepEqual(inspectBetaNote(page(TIP, note(AZ_401_NOTE))), {
    hasTip: true,
    noteCount: 1,
    text: AZ_401_NOTE,
  });
});

test("findBetaNote is tolerant of CRLF, of blank lines and of a note on one line or several", () => {
  const crlf = page(TIP, note(AZ_401_NOTE)).replace(/\n/g, "\r\n");
  assert.deepEqual(findBetaNote(crlf), { found: true, text: AZ_401_NOTE });
  assert.ok(!findBetaNote(crlf).text.includes("\r"));
  // lone CR (old Mac) endings, trailing blanks after the fences
  assert.equal(
    findBetaNote(page(TIP, note(AZ_401_NOTE)).replace(/\n/g, "\r")).text,
    AZ_401_NOTE,
  );
  assert.equal(
    findBetaNote(
      `${TIP.replace(/:::$/, ":::  ")}\n\n\n\n:::note \t\n${AZ_401_NOTE}\n::: \n`,
    ).text,
    AZ_401_NOTE,
  );
  // no blank line at all between the two blocks
  assert.equal(
    findBetaNote(`${TIP}\n${note(AZ_401_NOTE)}\n`).text,
    AZ_401_NOTE,
  );
  // a note wrapped over several lines keeps its line breaks, without the outer blank lines
  const wrapped = AZ_401_NOTE.replace(/\. /g, ".\n");
  assert.deepEqual(findBetaNote(page(TIP, `:::note\n\n${wrapped}\n\n:::`)), {
    found: true,
    text: wrapped,
  });
});

test("findBetaNote finds nothing without the beta tip", () => {
  for (const text of [
    "",
    page(note(AZ_401_NOTE)),
    page(":::tip\nSome other tip.\n:::", note(AZ_401_NOTE)),
    page(":::note\nThis is a beta exam.\n:::", note(AZ_401_NOTE)),
    "no directives at all",
  ]) {
    assert.deepEqual(findBetaNote(text), { found: false, text: "" });
    assert.equal(inspectBetaNote(text).hasTip, false);
  }
  assert.deepEqual(findBetaNote(undefined), { found: false, text: "" });
});

test("findBetaNote finds nothing when the note is missing or does not directly follow the tip", () => {
  const cases = {
    "tip alone": page(TIP),
    "note before the tip": page(note(AZ_401_NOTE), TIP),
    "a caution in between": page(
      TIP,
      ":::caution\nRetiring.\n:::",
      note(AZ_401_NOTE),
    ),
    "a paragraph in between": page(TIP, "Some text.", note(AZ_401_NOTE)),
    "a component in between": page(TIP, "<Card />", note(AZ_401_NOTE)),
    "a titled note": page(TIP, `:::note[Timeline]\n${AZ_401_NOTE}\n:::`),
    "a note that is never closed": page(TIP, `:::note\n${AZ_401_NOTE}`),
  };
  for (const [what, text] of Object.entries(cases)) {
    assert.deepEqual(findBetaNote(text), { found: false, text: "" }, what);
    assert.equal(inspectBetaNote(text).noteCount, 0, what);
  }
  assert.equal(inspectBetaNote(page(TIP)).hasTip, true);
});

test("findBetaNote finds nothing when two notes follow the tip, and inspectBetaNote counts them", () => {
  const two = page(TIP, note(AZ_401_NOTE), note("A second note."));
  assert.deepEqual(findBetaNote(two), { found: false, text: "" });
  assert.deepEqual(inspectBetaNote(two), {
    hasTip: true,
    noteCount: 2,
    text: AZ_401_NOTE,
  });
  assert.equal(
    inspectBetaNote(page(TIP, note("a"), note("b"), note("c"))).noteCount,
    3,
  );
  // a second note further down the page, after other content, is not "right after the tip"
  const apart = page(TIP, note(AZ_401_NOTE), "Some text.", note("Elsewhere."));
  assert.deepEqual(findBetaNote(apart), { found: true, text: AZ_401_NOTE });
});

test("findBetaNote ignores a tip and a note inside a code fence", () => {
  const fenced = page("```mdx", TIP, "", note(AZ_401_NOTE), "```");
  assert.deepEqual(findBetaNote(fenced), { found: false, text: "" });
  assert.equal(inspectBetaNote(fenced).hasTip, false);
  const tilde = page("~~~", TIP, note(AZ_401_NOTE), "~~~");
  assert.equal(inspectBetaNote(tilde).hasTip, false);
  // the real tip and note after a fenced example still count
  const both = page("```mdx", TIP, "```", TIP, note(AZ_401_NOTE));
  assert.deepEqual(findBetaNote(both), { found: true, text: AZ_401_NOTE });
});

// ---------------------------------------------------------------------------
// checkBetaNote
// ---------------------------------------------------------------------------

const check = (noteText, overrides = {}) =>
  checkBetaNote({
    noteText,
    start: "2026-10-14",
    announcement: "pending",
    ...overrides,
  });
const replaced = (text, from, to) => {
  assert.ok(text.includes(from), `the fixture no longer contains: ${from}`);
  return text.replaceAll(from, to);
};
const ABOUT_LINK = `[10-12 weeks after the beta period begins](${ABOUT_BETA_EXAMS_URL})`;
const AB_650_BASE = AB_650_URL.split("?")[0];
const AB_650_CHECK = {
  start: "2026-07-28",
  announcement: AB_650_URL,
};

test("checkBetaNote accepts the notes of the three reference pages", () => {
  assert.deepEqual(check(AZ_401_NOTE), []);
  assert.deepEqual(check(GH_700_NOTE), []);
  assert.deepEqual(check(AB_650_NOTE, AB_650_CHECK), []);
  assert.deepEqual(
    check(AB_650_NOTE, { ...AB_650_CHECK, expects: AB_650_EXPECTS }),
    [],
  );
  assert.deepEqual(
    check(UNANNOUNCED_NOTE, { announcement: "unannounced" }),
    [],
  );
});

test("checkBetaNote accepts exam-specific sentences next to the generated ones", () => {
  // GH-700's second score window is hand-written and is not calculated.
  assert.match(GH_700_NOTE, /between February 17, 2027 and March 3, 2027/);
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        " These dates are estimates",
        " Microsoft also lists a preview week for this exam. These dates are estimates",
      ),
    ),
    [],
  );
  // wrapped over lines, with CRLF, one word per line
  assert.deepEqual(check(AZ_401_NOTE.replace(/\. /g, ".\r\n")), []);
  assert.deepEqual(check(AZ_401_NOTE.replace(/ /g, "\n")), []);
});

test("checkBetaNote compares the announcement URL without its query string", () => {
  assert.deepEqual(
    check(
      replaced(
        AB_650_NOTE,
        `${AB_650_BASE}?WT.mc_id=studentamb_165290`,
        AB_650_BASE,
      ),
      AB_650_CHECK,
    ),
    [],
  );
  assert.deepEqual(
    check(AB_650_NOTE, {
      ...AB_650_CHECK,
      announcement: `${AB_650_BASE}?other=1#top`,
    }),
    [],
  );
});

test("checkBetaNote names a wrong beta start", () => {
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "The beta period began on October 14, 2026.",
        "The beta period began on October 15, 2026.",
      ),
    ),
    [
      "the note says the beta period began on October 15, 2026, but betaStart in src/data_files/beta-exams.json is 2026-10-14 (October 14, 2026)",
    ],
  );
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "The beta period began on October 14, 2026.",
        "The beta started in October.",
      ),
    ),
    [
      'the note must start with "The beta period began on October 14, 2026." (betaStart 2026-10-14 in src/data_files/beta-exams.json)',
    ],
  );
  // the whole note belongs to another start: every date is wrong
  const problems = check(AB_650_NOTE, { announcement: AB_650_URL });
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(
    problems[0],
    /the beta period began on July 28, 2026, but betaStart/,
  );
  assert.match(
    problems[1],
    /^the note must give the go-live window as "between December 23, 2026 and January 6, 2027"/,
  );
  assert.match(
    problems[2],
    /^the note must give the score window as "between January 2, 2027 and January 16, 2027"/,
  );
});

test("checkBetaNote names a wrong go-live window or score window and what the note has instead", () => {
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "between December 23, 2026 and January 6, 2027",
        "between December 24, 2026 and January 6, 2027",
      ),
    ),
    [
      'the note must give the go-live window as "between December 23, 2026 and January 6, 2027" (beta start + 10 to 12 weeks); the note has "between December 24, 2026 and January 6, 2027"',
    ],
  );
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "expect results between January 2, 2027 and January 16, 2027",
        "expect results between January 3, 2027 and January 16, 2027",
      ),
    ),
    [
      'the note must give the score window as "between January 2, 2027 and January 16, 2027" (the go-live window + 10 days); the note has "between January 3, 2027 and January 16, 2027"',
    ],
  );
  // the window removed altogether: nothing to point at
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        " Beta scores are released about 10 days after that, so expect results between January 2, 2027 and January 16, 2027.",
        "",
      ),
    ),
    [
      'the note must give the score window as "between January 2, 2027 and January 16, 2027" (the go-live window + 10 days)',
    ],
  );
  // both windows are required in a note that adds its own: GH-700 without its generic window
  assert.deepEqual(
    check(
      replaced(
        GH_700_NOTE,
        "which would be between January 2, 2027 and January 16, 2027. However,",
        "which would come later. However,",
      ),
    ),
    [
      'the note must give the score window as "between January 2, 2027 and January 16, 2027" (the go-live window + 10 days); the note has "between February 17, 2027 and March 3, 2027"',
    ],
  );
});

test("checkBetaNote reports a missing link", () => {
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "[Beta Exams](/certs/vouchers/betaexams/)",
        "Beta Exams",
      ),
    ),
    [
      "the note must link the Beta Exams page: [Beta Exams](/certs/vouchers/betaexams/)",
    ],
  );
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        ABOUT_BETA_EXAMS_URL,
        "https://learn.microsoft.com/certifications/beta-exams",
      ),
    ),
    [`the note must link Microsoft's page about beta exams: ${ABOUT_LINK}`],
  );
  assert.deepEqual(
    check(
      replaced(AZ_401_NOTE, SKILLS_HUB_BLOG_URL, "https://example.com/blog"),
    ),
    [
      `the note must link the Skills Hub blog: [Skills Hub blog](${SKILLS_HUB_BLOG_URL})`,
    ],
  );
  assert.deepEqual(check(replaced(AZ_401_NOTE, "80% discount", "discount")), [
    'the note must mention the "80% discount"',
  ]);
});

test("checkBetaNote reports a note that carries the wording of another state", () => {
  const swapped = (text, announcement, said, extra = {}) =>
    assert.deepEqual(check(text, { announcement, ...extra }), [
      `the note says ${said} but beta-exams.json says announcement "${announcement}"`,
    ]);
  // the example of the consistency test: a pending note, a tracker that says unannounced
  swapped(AZ_401_NOTE, "unannounced", '"pending"');
  swapped(UNANNOUNCED_NOTE, "pending", '"unannounced"');
  swapped(AB_650_NOTE, "pending", '"announced"', { start: "2026-07-28" });
  swapped(AB_650_NOTE, "unannounced", '"announced"', { start: "2026-07-28" });
  swapped(AZ_401_NOTE, AB_650_URL, '"pending"');
  swapped(UNANNOUNCED_NOTE, AB_650_URL, '"unannounced"');
});

test("checkBetaNote reports two states mixed in one note", () => {
  const unannouncedSentence =
    "We have not found an official go-live announcement from Microsoft yet.";
  const pendingSentence =
    "That announcement has not been published for this exam yet.";
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "The beta period began on October 14, 2026.",
        `The beta period began on October 14, 2026. ${unannouncedSentence}`,
      ),
    ),
    [
      'the note mixes in the "unannounced" wording ("We have not found an official go-live announcement") although beta-exams.json says announcement "pending"',
    ],
  );
  assert.deepEqual(
    check(
      AB_650_NOTE.replace(
        "2026. Microsoft's",
        `2026. ${pendingSentence} Microsoft's`,
      ),
      AB_650_CHECK,
    ),
    [
      `the note mixes in the "pending" wording ("has not been published for this exam yet") although beta-exams.json says announcement "${AB_650_URL}"`,
    ],
  );
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        "The beta period began on October 14, 2026.",
        "The beta period began on October 14, 2026. Microsoft's [announcement](https://example.com/x) is out.",
      ),
    ),
    [
      'the note mixes in the "announced" wording ("[announcement](") although beta-exams.json says announcement "pending"',
    ],
  );
  // both foreign states at once: one message each
  const both = check(
    replaced(
      AB_650_NOTE,
      "The beta period began on July 28, 2026.",
      `The beta period began on July 28, 2026. ${pendingSentence} ${unannouncedSentence}`,
    ),
    AB_650_CHECK,
  );
  assert.equal(both.length, 2, both.join("\n"));
  assert.match(both[0], /mixes in the "pending" wording/);
  assert.match(both[1], /mixes in the "unannounced" wording/);
});

test("checkBetaNote reports a missing marker of the note's own state", () => {
  assert.deepEqual(
    check(
      replaced(
        AZ_401_NOTE,
        " That announcement has not been published for this exam yet and should arrive within a few days, so check back before you pay full price.",
        "",
      ),
    ),
    [
      'the note must say that the announcement is still pending: "has not been published for this exam yet"',
    ],
  );
  assert.deepEqual(
    check(
      replaced(
        UNANNOUNCED_NOTE,
        " We have not found an official go-live announcement from Microsoft yet.",
        "",
      ),
      { announcement: "unannounced" },
    ),
    [
      'the note must say that no announcement was found: "We have not found an official go-live announcement"',
    ],
  );
});

test("checkBetaNote holds an announced note to the announcement of the tracker", () => {
  // another announcement
  assert.deepEqual(
    check(
      replaced(
        AB_650_NOTE,
        AB_650_URL,
        "https://techcommunity.microsoft.com/blog/skills-hub-blog/other/1?WT.mc_id=studentamb_165290",
      ),
      AB_650_CHECK,
    ),
    [
      `the note must link the announcement ${AB_650_BASE} (compared without the query string); it links https://techcommunity.microsoft.com/blog/skills-hub-blog/other/1 instead`,
    ],
  );
  // the same path with one more character is another URL
  assert.equal(
    check(replaced(AB_650_NOTE, "/4494123?", "/44941234?"), AB_650_CHECK)
      .length,
    1,
  );
  // no announcement link at all
  assert.deepEqual(
    check(
      replaced(AB_650_NOTE, AB_650_ANNOUNCEMENT, "Microsoft announced it."),
      AB_650_CHECK,
    ),
    [
      `the note must link the announcement ${AB_650_BASE} (compared without the query string)`,
    ],
  );
});

test("checkBetaNote holds an announced note to `expects`, and refuses it elsewhere", () => {
  assert.deepEqual(
    check(AB_650_NOTE, {
      ...AB_650_CHECK,
      expects: "general availability of this certification in November 2026",
    }),
    [
      'the note must carry Microsoft\'s go-live wording: "expects general availability of this certification in November 2026"',
    ],
  );
  assert.deepEqual(
    check(AB_650_NOTE, { ...AB_650_CHECK, expects: `  ${AB_650_EXPECTS} ` }),
    [],
  );
  assert.deepEqual(check(AZ_401_NOTE, { expects: AB_650_EXPECTS }), [
    '"expects" only goes with an announced note, but the announcement is "pending"',
  ]);
});

test("checkBetaNote turns an unusable start or announcement into a problem instead of throwing", () => {
  assert.deepEqual(check(AZ_401_NOTE, { start: "2026-02-31" }), [
    'betaStart in src/data_files/beta-exams.json cannot be used: The beta start must be a real day written YYYY-MM-DD (got "2026-02-31").',
  ]);
  assert.deepEqual(check(AZ_401_NOTE, { announcement: "soon" }), [
    'announcement in src/data_files/beta-exams.json cannot be used: An announcement must be "pending", "unannounced" or an https URL without spaces or brackets (got "soon").',
  ]);
  // the parts that need a good value are skipped, the rest is still checked
  const problems = check(
    replaced(
      AZ_401_NOTE,
      "[Beta Exams](/certs/vouchers/betaexams/)",
      "Beta Exams",
    ),
    {
      start: undefined,
      announcement: undefined,
    },
  );
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems[0], /^betaStart in /);
  assert.match(problems[1], /^announcement in /);
  assert.match(problems[2], /link the Beta Exams page/);
});

test("checkBetaNote has a problem for no text at all", () => {
  for (const noteText of [
    "",
    "   \n",
    undefined,
    null,
    5,
    ":::note\n:::",
    ":::note\n\n:::\n",
  ]) {
    assert.deepEqual(check(noteText), ["there is no note text to check"]);
  }
  assert.equal(checkBetaNote().length, 3);
  assert.equal(checkBetaNote({}).length, 3);
});

test("checkBetaNote takes the text of the note or the whole block that buildBetaNote writes", () => {
  assert.deepEqual(check(note(AZ_401_NOTE)), []);
  assert.deepEqual(check(`${note(AZ_401_NOTE)}\n`), []);
  assert.deepEqual(check(note(AZ_401_NOTE).replace(/\n/g, "\r\n")), []);
  assert.deepEqual(check(note(AB_650_NOTE), AB_650_CHECK), []);
  // the fences are not part of what is checked: a broken note stays broken inside them
  assert.deepEqual(
    check(note(AZ_401_NOTE.replace("October 14, 2026.", "October 15, 2026."))),
    [
      "the note says the beta period began on October 15, 2026, but betaStart in src/data_files/beta-exams.json is 2026-10-14 (October 14, 2026)",
    ],
  );
});

// ---------------------------------------------------------------------------
// the live reference pages
// ---------------------------------------------------------------------------

const docsDir = join(root, "src", "content", "docs");
const liveTracker = JSON.parse(
  readFileSync(join(root, "src", "data_files", "beta-exams.json"), "utf8"),
).exams;

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `at character ${i}: page "${a.slice(Math.max(0, i - 30), i + 50)}", generated "${b.slice(Math.max(0, i - 30), i + 50)}"`;
}

// The pinned notes above are what the three pages said when the generator was
// written. The live pages must still be the generated note of their tracker
// entry, apart from the scoring sentence, which an exam may replace with its
// own (GH-700 does). A page whose exam has left beta has no note any more and
// is skipped.
for (const [code, area] of [
  ["AB-650", "aibusiness"],
  ["AZ-401", "azure"],
  ["GH-700", "github"],
]) {
  const file = join(docsDir, area, `${code}.mdx`);
  const live = findBetaNote(existsSync(file) ? readFileSync(file, "utf8") : "");
  const entry = liveTracker.find(
    (exam) => exam.code === code && !exam.flaggedGA,
  );
  const left = !live.found || !entry;
  test(
    `the live ${code} note is the generated note of its tracker entry, apart from the scoring wording`,
    {
      skip:
        left &&
        `${code} has no beta note or no beta entry any more (it left beta); the pinned notes above still guard the generator`,
    },
    () => {
      const fix = `fix src/content/docs/${area}/${code}.mdx (node scripts/beta-note.mjs --code ${code} writes the generated note) or the entry in src/data_files/beta-exams.json`;
      // Microsoft's go-live wording is not in the tracker: it is the page's.
      const expects = /\) expects (.+?)\. Microsoft also usually releases/.exec(
        live.text,
      )?.[1];
      const generated = bodyOf(
        buildBetaNote({
          start: entry.betaStart,
          announcement: entry.announcement,
          expects,
        }),
      );
      const timeline = betaTimeline(entry.betaStart);
      const scoring = `Beta scores are released about 10 days after that, so expect results between ${timeline.scoresFromText} and ${timeline.scoresToText}.`;
      const at = generated.indexOf(scoring);
      const head = generated.slice(0, at);
      const tail = generated.slice(at + scoring.length);
      assert.ok(
        live.text.startsWith(head),
        `${code}: the note differs from the generated one before its scoring wording, ${firstDifference(live.text, generated)}; ${fix}`,
      );
      assert.ok(
        live.text.length >= head.length + tail.length &&
          live.text.endsWith(tail),
        `${code}: the note differs from the generated one after its scoring wording, ${firstDifference(live.text.slice(-tail.length), tail)}; ${fix}`,
      );
      assert.deepEqual(
        checkBetaNote({
          noteText: live.text,
          start: entry.betaStart,
          announcement: entry.announcement,
          expects,
        }),
        [],
      );
    },
  );
}

// ---------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "beta-note-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const trackerFile = join(dir, "beta-exams.json");
writeFileSync(
  trackerFile,
  JSON.stringify({
    lastSynced: "2026-10-14",
    exams: [
      {
        code: "AB-650",
        area: "aibusiness",
        betaStart: "2026-07-28",
        announcement: AB_650_URL,
        flaggedGA: false,
      },
      {
        code: "AZ-401",
        area: "azure",
        betaStart: "2026-10-14",
        announcement: "pending",
        flaggedGA: false,
      },
      {
        code: "GH-700",
        area: "github",
        betaStart: "2026-10-14",
        announcement: "unannounced",
        flaggedGA: false,
      },
      { code: "XX-001", area: "azure", announcement: "pending" },
      { code: "XX-002", area: "azure", betaStart: "2026-10-14" },
      {
        code: "XX-003",
        area: "azure",
        betaStart: "2026-02-31",
        announcement: "pending",
      },
      {
        code: "XX-004",
        area: "azure",
        betaStart: "2026-10-14",
        announcement: "soon",
      },
      { code: "XX-005", area: "azure", flaggedGA: true },
    ],
  }),
);
const env = { BETA_EXAMS_FILE: trackerFile };

function failure(args, withEnv = env) {
  try {
    run(args, withEnv);
  } catch (error) {
    return { usage: error instanceof UsageError, message: error.message };
  }
  return assert.fail(`${JSON.stringify(args)} should have been refused`);
}

test("--code writes the note of the tracker entry for each state", () => {
  assert.equal(run(["--code", "AZ-401"], env), note(AZ_401_NOTE));
  assert.equal(run(["--code", "GH-700"], env), note(UNANNOUNCED_NOTE));
  assert.equal(
    run(["--code", "AB-650", "--expects", AB_650_EXPECTS], env),
    note(AB_650_NOTE),
  );
  assert.equal(
    run(["--code", "AB-650"], env),
    buildBetaNote({ start: "2026-07-28", announcement: AB_650_URL }),
  );
  // the code is read without regard to case or spaces; --name=value works too
  assert.equal(run(["--code", " az-401 "], env), note(AZ_401_NOTE));
  assert.equal(run(["--code=AZ-401"], env), note(AZ_401_NOTE));
  assert.equal(
    run([`--code=AB-650`, `--expects=${AB_650_EXPECTS}`], env),
    note(AB_650_NOTE),
  );
});

test("--start and --state write the note without reading the tracker", () => {
  const nowhere = { BETA_EXAMS_FILE: join(dir, "missing.json") };
  assert.equal(
    run(["--start", "2026-10-14", "--state", "pending"], nowhere),
    note(AZ_401_NOTE),
  );
  assert.equal(
    run(["--start", "2026-10-14", "--state", "unannounced"], nowhere),
    note(UNANNOUNCED_NOTE),
  );
  assert.equal(
    run(
      [
        "--start",
        "2026-07-28",
        "--state",
        "announced",
        "--announcement-url",
        AB_650_URL,
        "--expects",
        AB_650_EXPECTS,
      ],
      nowhere,
    ),
    note(AB_650_NOTE),
  );
  assert.equal(
    run(
      [
        "--state",
        "announced",
        "--announcement-url",
        AB_650_URL,
        "--start",
        "2026-07-28",
      ],
      nowhere,
    ),
    buildBetaNote({ start: "2026-07-28", announcement: AB_650_URL }),
  );
});

test("--timeline prints the four calculated dates as plain lines", () => {
  const lines = [
    "go-live from: December 23, 2026",
    "go-live to: January 6, 2027",
    "scores from: January 2, 2027",
    "scores to: January 16, 2027",
  ].join("\n");
  assert.equal(run(["--timeline", "--start", "2026-10-14"], env), lines);
  assert.equal(run(["--start", "2026-10-14", "--timeline"], env), lines);
  assert.equal(run(["--timeline", "--code", "AZ-401"], env), lines);
  // a tracker entry without an announcement still has a timeline
  assert.equal(run(["--timeline", "--code", "XX-002"], env), lines);
});

test("--help prints the usage", () => {
  assert.equal(run(["--help"], env), USAGE);
  assert.equal(run(["-h"], env), USAGE);
  assert.match(USAGE, /--code <CODE>/);
});

test("an unknown code, a missing betaStart or announcement and an invalid value are refused with a clear message", () => {
  assert.deepEqual(failure(["--code", "AZ-999"]), {
    usage: false,
    message: `No beta exam AZ-999 in ${trackerFile} (it lists AB-650, AZ-401, GH-700, XX-001, XX-002, XX-003, XX-004, XX-005).`,
  });
  const missingStart = failure(["--code", "XX-001"]);
  assert.equal(missingStart.usage, false);
  assert.match(
    missingStart.message,
    /^XX-001 in .*beta-exams\.json: no betaStart: add the day the beta period began \(YYYY-MM-DD, .*never guess it\)$/,
  );
  assert.match(
    failure(["--code", "XX-005"]).message,
    /^XX-005 in .*: no betaStart/,
  );
  assert.match(
    failure(["--code", "XX-002"]).message,
    /^XX-002 in .*beta-exams\.json: no announcement: set "pending", "unannounced" or the URL of the announcement$/,
  );
  assert.match(
    failure(["--code", "XX-003"]).message,
    /^XX-003 in .*beta-exams\.json: The beta start must be a real day written YYYY-MM-DD \(got "2026-02-31"\)\.$/,
  );
  assert.match(
    failure(["--code", "XX-004"]).message,
    /^XX-004 in .*beta-exams\.json: An announcement must be "pending", "unannounced" or an https URL/,
  );
  assert.match(
    failure(["--timeline", "--code", "XX-003"]).message,
    /^XX-003 in .*: The beta start must be a real day/,
  );
  assert.deepEqual(failure(["--start", "2026-02-31", "--state", "pending"]), {
    usage: false,
    message:
      'The beta start must be a real day written YYYY-MM-DD (got "2026-02-31").',
  });
  assert.match(
    failure(["--timeline", "--start", "2026-13-01"]).message,
    /\(got "2026-13-01"\)/,
  );
  assert.match(
    failure([
      "--start",
      "2026-10-14",
      "--state",
      "announced",
      "--announcement-url",
      "http://example.com/x",
    ]).message,
    /An announcement must be .* https URL/,
  );
  assert.match(
    failure(["--start", "2026-10-14", "--state", "pending", "--expects", "x"])
      .message,
    /only goes with an announced note/,
  );
});

test("the tracker file itself can be missing, unreadable or the wrong shape", () => {
  assert.match(
    failure(["--code", "AZ-401"], { BETA_EXAMS_FILE: join(dir, "nope.json") })
      .message,
    /^The tracker file .*nope\.json does not exist\.$/,
  );
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  assert.match(
    failure(["--code", "AZ-401"], { BETA_EXAMS_FILE: broken }).message,
    /^The tracker file .*broken\.json is not valid JSON/,
  );
  const shapeless = join(dir, "shapeless.json");
  writeFileSync(shapeless, JSON.stringify({ exams: {} }));
  assert.match(
    failure(["--code", "AZ-401"], { BETA_EXAMS_FILE: shapeless }).message,
    /has no "exams" array/,
  );
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ exams: [] }));
  assert.match(
    failure(["--code", "AZ-401"], { BETA_EXAMS_FILE: empty }).message,
    /\(it lists no exams\)/,
  );
});

test("options that do not fit together are usage errors", () => {
  const usage = (args, pattern) => {
    const result = failure(args);
    assert.equal(result.usage, true, JSON.stringify(args));
    assert.match(result.message, pattern, JSON.stringify(args));
  };
  usage([], /Give --code <CODE>, or --start <YYYY-MM-DD> with --state/);
  usage(["--start", "2026-10-14"], /Give --code/);
  usage(["--state", "pending"], /Give --code/);
  usage(["--frobnicate"], /Unknown option --frobnicate\./);
  usage(["AZ-401"], /Unknown option AZ-401\./);
  usage(["--code"], /--code needs a value\./);
  usage(["--code", "--timeline"], /--code needs a value\./);
  usage(["--code", ""], /--code needs a value\./);
  usage(["--expects="], /--expects needs a value\./);
  usage(["--timeline=1"], /--timeline takes no value\./);
  usage(
    ["--start", "2026-10-14", "--state", "soon"],
    /--state must be one of announced, pending, unannounced \(got "soon"\)/,
  );
  usage(
    ["--start", "2026-10-14", "--state", "announced"],
    /--state announced needs --announcement-url/,
  );
  usage(
    [
      "--start",
      "2026-10-14",
      "--state",
      "pending",
      "--announcement-url",
      AB_650_URL,
    ],
    /--announcement-url only goes with --state announced/,
  );
  usage(["--code", "AZ-401", "--start", "2026-10-14"], /do not combine it/);
  usage(["--code", "AZ-401", "--state", "pending"], /do not combine it/);
  usage(
    ["--code", "AZ-401", "--announcement-url", AB_650_URL],
    /do not combine it/,
  );
  usage(
    ["--timeline"],
    /--timeline needs --start <YYYY-MM-DD> or --code <CODE>/,
  );
  usage(
    ["--timeline", "--start", "2026-10-14", "--code", "AZ-401"],
    /--timeline needs --start <YYYY-MM-DD> or --code <CODE>/,
  );
  usage(
    ["--timeline", "--start", "2026-10-14", "--state", "pending"],
    /--timeline only takes --start or --code/,
  );
  usage(
    ["--timeline", "--start", "2026-10-14", "--expects", "x"],
    /--timeline only takes/,
  );
});

test("parseArgs reads flags with a value, with =, and the switches", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(
    parseArgs([
      "--code",
      "AZ-401",
      "--expects=in October",
      "--timeline",
      "-h",
      "--start",
      "2026-10-14",
      "--state=pending",
      "--announcement-url",
      "https://example.com/x",
    ]),
    {
      code: "AZ-401",
      expects: "in October",
      timeline: true,
      help: true,
      start: "2026-10-14",
      state: "pending",
      announcementUrl: "https://example.com/x",
    },
  );
  // an inherited property name is no option
  assert.throws(() => parseArgs(["--constructor"]), UsageError);
  assert.throws(() => parseArgs(["--toString=1"]), UsageError);
});

function cli(args, withEnv = { BETA_EXAMS_FILE: trackerFile }, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...withEnv },
  });
}

test("the command prints only the note on stdout, so that it can be piped", () => {
  const result = cli(["--code", "AZ-401"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${note(AZ_401_NOTE)}\n`);
  assert.equal(result.stderr, "");
  const dates = cli(["--timeline", "--start", "2026-07-28"]);
  assert.equal(dates.status, 0, dates.stderr);
  assert.equal(
    dates.stdout,
    "go-live from: October 6, 2026\ngo-live to: October 20, 2026\nscores from: October 16, 2026\nscores to: October 30, 2026\n",
  );
  assert.equal(dates.stderr, "");
  const explicit = cli([
    "--start",
    "2026-07-28",
    "--state",
    "announced",
    "--announcement-url",
    AB_650_URL,
    "--expects",
    AB_650_EXPECTS,
  ]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, `${note(AB_650_NOTE)}\n`);
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${USAGE}\n`);
});

test("bad input exits with 1, a message on stderr and nothing on stdout", () => {
  for (const args of [
    ["--code", "AZ-999"],
    ["--code", "XX-001"],
    ["--start", "2026-02-31", "--state", "pending"],
    ["--timeline", "--start", "nonsense"],
    ["--frobnicate"],
    [],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
    assert.match(result.stderr, /^ERROR: /, JSON.stringify(args));
  }
  const usage = cli(["--frobnicate"]);
  assert.match(
    usage.stderr,
    /Unknown option --frobnicate\.\nUsage:\n {2}node scripts\/beta-note\.mjs --code/,
  );
  const refused = cli(["--code", "AZ-999"]);
  assert.match(
    refused.stderr,
    /^ERROR: No beta exam AZ-999 in .*\(it lists AB-650, AZ-401/,
  );
  assert.doesNotMatch(refused.stderr, /Usage:/);
});

test("without BETA_EXAMS_FILE the command reads src/data_files/beta-exams.json", () => {
  const result = cli(["--code", "ZZ-999"], { BETA_EXAMS_FILE: "" });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^ERROR: No beta exam ZZ-999 in src\/data_files\/beta-exams\.json \(it lists /,
  );
  for (const exam of liveTracker)
    assert.ok(result.stderr.includes(exam.code), exam.code);
  // from any directory, and a relative BETA_EXAMS_FILE starts at the repository root
  assert.equal(
    cli(["--code", "ZZ-999"], { BETA_EXAMS_FILE: "" }, dir).stderr,
    result.stderr,
  );
  const relative = cli(
    ["--code", "ZZ-999"],
    { BETA_EXAMS_FILE: "src/data_files/beta-exams.json" },
    dir,
  );
  assert.equal(relative.stderr, result.stderr);
});
