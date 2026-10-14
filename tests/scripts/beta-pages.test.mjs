import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { examStatuses } from "../../src/data_files/exam-status.mjs";
import {
  PENDING_ANNOUNCEMENT_DAYS,
  announcementState,
  betaTimeline,
  buildBetaNote,
  checkBetaNote,
  findBetaNote,
  inspectBetaNote,
} from "../../scripts/lib/beta-note.mjs";

// Consistency of everything that says "this exam is in beta": the BETA badge
// in src/data_files/exam-status.mjs, the entry in src/data_files/beta-exams.json
// and the exam page with its beta tip and the timeline note right after it.
// The rules are functions of plain data, so the real repository is checked
// below and the tests after that show that each rule catches what it is for.
// No clock and no network: whether a "pending" announcement is older than
// PENDING_ANNOUNCEMENT_DAYS is for the monitors, not for a test that never
// reads a date. Nor does anything here react to what a monitor does on its own:
// the Beta Exam Monitor flags an exam that left beta (flaggedGA) and raises an
// issue, and the BETA badge, the tip and the note are removed by hand after
// that. A flagged entry on a page that is still BETA is therefore no error, and
// flagged entries are left out of "an entry must be a BETA exam".

const root = resolve(import.meta.dirname, "../..");
const docsDir = join(root, "src", "content", "docs");

const TRACKER = "src/data_files/beta-exams.json";
const STATUSES = "src/data_files/exam-status.mjs";
const RUNBOOK = "docs/monitors/beta-and-retiring-exams.md";
const pageFile = (area, code) => `src/content/docs/${area}/${code}.mdx`;
const regenerate = (code) =>
  `node scripts/beta-note.mjs --code ${code} writes the note for the entry in ${TRACKER}`;

/** The BETA exams of the status table as [{ area, code }]. */
const betaExams = ({ statuses }) =>
  Object.entries(statuses).flatMap(([area, codes]) =>
    Object.entries(codes)
      .filter(([, badge]) => badge.text === "BETA")
      .map(([code]) => ({ area, code })),
  );

/** The one tracker entry of a code with a usable betaStart and announcement, or null. */
function trackedValues({ tracker }, code) {
  const entries = tracker.filter((entry) => entry.code === code);
  if (entries.length !== 1) return null;
  const [entry] = entries;
  try {
    betaTimeline(entry.betaStart);
    announcementState(entry.announcement);
  } catch {
    return null;
  }
  return entry;
}

function pageProblems(data) {
  return betaExams(data)
    .filter(({ area, code }) => !data.pages.has(`${area}/${code}`))
    .map(
      ({ area, code }) =>
        `${code}: ${STATUSES} marks it BETA but ${pageFile(area, code)} does not exist: create the page or remove the BETA status`,
    );
}

function tipAndNoteProblems(data) {
  const problems = [];
  for (const { area, code } of betaExams(data)) {
    const text = data.pages.get(`${area}/${code}`);
    if (text === undefined) continue;
    const file = pageFile(area, code);
    const { hasTip, noteCount } = inspectBetaNote(text);
    if (!hasTip) {
      problems.push(
        `${code}: ${file} has no beta tip but ${STATUSES} marks ${code} BETA: put the standard ":::tip" ("This is a beta exam. ...") at the top of the page, or remove the BETA status`,
      );
    } else if (noteCount === 0) {
      problems.push(
        `${code}: the beta tip in ${file} is not directly followed by the beta timeline note: add the ":::note" box right after the tip, with nothing in between and without a title (${regenerate(code)})`,
      );
    } else if (noteCount > 1) {
      problems.push(
        `${code}: ${file} has ${noteCount} ":::note" boxes right after the beta tip: keep exactly one, the beta timeline (${regenerate(code)})`,
      );
    }
  }
  return problems;
}

function trackerProblems(data) {
  const problems = [];
  for (const { area, code } of betaExams(data)) {
    const entries = data.tracker.filter((entry) => entry.code === code);
    if (entries.length === 0) {
      problems.push(
        `${code}: ${TRACKER} has no entry for it but ${STATUSES} marks it BETA: add { "code", "area", "name", "url", "betaStart", "announcement", "flaggedGA": false } (see ${RUNBOOK})`,
      );
      continue;
    }
    if (entries.length > 1) {
      problems.push(
        `${code}: ${TRACKER} lists it ${entries.length} times: keep one entry`,
      );
      continue;
    }
    const [entry] = entries;
    if (entry.area !== area) {
      problems.push(
        `${code}: ${TRACKER} says area "${entry.area}" but ${STATUSES} lists it under "${area}": make them agree`,
      );
    }
    try {
      betaTimeline(entry.betaStart);
    } catch (error) {
      problems.push(
        `${code}: ${TRACKER} needs "betaStart", the day the beta period began (YYYY-MM-DD, from the official beta announcement or the exam's Microsoft Learn page, never guessed): ${error.message}`,
      );
    }
    try {
      announcementState(entry.announcement);
    } catch (error) {
      problems.push(
        `${code}: ${TRACKER} needs "announcement": "pending" (the Skills Hub announcement is expected within ${PENDING_ANNOUNCEMENT_DAYS} days of the beta start), "unannounced" (none found after that) or the https URL of the announcement: ${error.message}`,
      );
    }
  }
  return problems;
}

function noteProblems(data) {
  const problems = [];
  for (const { area, code } of betaExams(data)) {
    const text = data.pages.get(`${area}/${code}`);
    const entry = trackedValues(data, code);
    if (text === undefined || !entry) continue; // reported by the rules above
    const found = findBetaNote(text);
    if (!found.found) continue; // reported by the rule for the tip and the note
    const fix = `fix ${pageFile(area, code)}: ${regenerate(code)}; or correct the entry if the tracker is what is wrong`;
    const issues = checkBetaNote({
      noteText: found.text,
      start: entry.betaStart,
      announcement: entry.announcement,
    });
    for (const issue of issues) problems.push(`${code}: ${issue} (${fix})`);
    // The page links what the tracker says: the URL itself, not just the same address.
    if (
      issues.length === 0 &&
      announcementState(entry.announcement) === "announced" &&
      !found.text.includes(`](${entry.announcement})`)
    ) {
      problems.push(
        `${code}: the note links the announcement but not with the URL of ${TRACKER} ("${entry.announcement}"): make the link and the entry identical (${fix})`,
      );
    }
  }
  return problems;
}

function trackedAsBetaProblems(data) {
  const beta = new Set(betaExams(data).map(({ code }) => code));
  return data.tracker
    .filter((entry) => !entry.flaggedGA && !beta.has(entry.code))
    .map(
      (entry) =>
        `${entry.code}: ${TRACKER} tracks it as a beta exam (flaggedGA is not true) but ${STATUSES} has no BETA status for it: add { text: "BETA", variant: "tip" } under "${entry.area}" there, or, if the exam is generally available, set "flaggedGA": true in the entry (see ${RUNBOOK})`,
    );
}

function strayBetaPageProblems(data) {
  const beta = new Set(
    betaExams(data).map(({ area, code }) => `${area}/${code}`),
  );
  const problems = [];
  for (const [key, text] of data.pages) {
    if (beta.has(key)) continue;
    const [area, code] = key.split("/");
    const file = pageFile(area, code);
    if (inspectBetaNote(text).hasTip) {
      problems.push(
        `${code}: ${file} carries the beta tip but ${STATUSES} does not mark it BETA: remove the tip and the timeline note if the exam is generally available (see ${RUNBOOK}), or restore the BETA status and the entry in ${TRACKER}`,
      );
    } else if (/^The beta period began on /m.test(text)) {
      problems.push(
        `${code}: ${file} carries a beta timeline note ("The beta period began on ...") but ${STATUSES} does not mark it BETA: remove the note, which goes together with the beta tip`,
      );
    }
  }
  return problems;
}

const rules = {
  "every BETA exam has an exam page": pageProblems,
  "every BETA exam page has the beta tip and exactly one note right after it":
    tipAndNoteProblems,
  "every BETA exam is tracked in beta-exams.json with a valid betaStart and announcement":
    trackerProblems,
  "the note of every BETA exam agrees with its entry in beta-exams.json":
    noteProblems,
  "every beta-exams.json entry that is not flagged GA is a BETA exam in exam-status.mjs":
    trackedAsBetaProblems,
  "no exam page that is not BETA carries the beta tip or a beta timeline note":
    strayBetaPageProblems,
};
const allProblems = (data) =>
  Object.values(rules).flatMap((rule) => rule(data));

function assertNone(problems) {
  assert.ok(
    problems.length === 0,
    `\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`,
  );
}

// ---------------------------------------------------------------------------
// the real repository
// ---------------------------------------------------------------------------

function loadRepo() {
  const pages = new Map();
  for (const area of Object.keys(examStatuses)) {
    const dir = join(docsDir, area);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!/^[A-Z]{2}-\d{3}\.mdx$/.test(file)) continue;
      pages.set(
        `${area}/${file.slice(0, -".mdx".length)}`,
        readFileSync(join(dir, file), "utf8"),
      );
    }
  }
  const tracker = JSON.parse(readFileSync(join(root, TRACKER), "utf8")).exams;
  return { statuses: examStatuses, tracker, pages };
}
const repo = loadRepo();

test("the data the rules read is the real exam pages, status table and tracker", () => {
  for (const area of Object.keys(examStatuses)) {
    assert.ok(
      [...repo.pages.keys()].some((key) => key.startsWith(`${area}/`)),
      `no exam page found for the area ${area}`,
    );
  }
  assert.ok(Array.isArray(repo.tracker));
});

for (const [name, rule] of Object.entries(rules)) {
  test(name, () => assertNone(rule(repo)));
}

// ---------------------------------------------------------------------------
// the rules catch what they are for
// ---------------------------------------------------------------------------

const START = "2026-10-14";
const ANNOUNCEMENT =
  "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-exam/123?WT.mc_id=studentamb_165290";
const TIP =
  ":::tip\nThis is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.\n\nIf you have any resources that you would like to recommend, please let us know and we will add them.\n:::";
const page = (...blocks) =>
  `---\ntitle: AB-999 Study Materials\n---\nimport { Card } from '@components/docs';\n\n${blocks.join("\n\n")}\n\n<Card title="Get Started" icon="star">\n</Card>\n`;
const noteFor = (announcement, expects) =>
  buildBetaNote({ start: START, announcement, expects });

/** A made-up beta exam AB-999 that is consistent everywhere, and an ordinary page. */
function world({ announcement = "pending", ...override } = {}) {
  return {
    statuses: {
      aibusiness: { "AB-999": { text: "BETA", variant: "tip" } },
      azure: { "AZ-998": { text: "RETIRING", variant: "danger" } },
    },
    tracker: [
      {
        code: "AB-999",
        area: "aibusiness",
        name: "A beta exam",
        betaStart: START,
        announcement,
        flaggedGA: false,
      },
    ],
    pages: new Map([
      ["aibusiness/AB-999", page(TIP, noteFor(announcement))],
      ["azure/AZ-998", page(":::caution\nRetiring.\n:::")],
    ]),
    ...override,
  };
}
const withPages = (entries) => ({
  pages: new Map([...world().pages, ...entries]),
});
const problemsOf = (data) => allProblems(data);

test("a consistent exam produces no problem, in each state of the announcement", () => {
  assert.deepEqual(problemsOf(world()), []);
  assert.deepEqual(problemsOf(world({ announcement: "unannounced" })), []);
  assert.deepEqual(problemsOf(world({ announcement: ANNOUNCEMENT })), []);
  // a note with its own scoring wording, and a flagged historical entry of an exam that is GA
  const own = noteFor("pending").replace(
    "Beta scores are released about 10 days after that, so expect results between January 2, 2027 and January 16, 2027.",
    "Beta scores are usually released about 10 days after that, which would be between January 2, 2027 and January 16, 2027. This exam is scored by hand.",
  );
  assert.ok(own.includes("scored by hand"));
  const data = world();
  data.pages.set("aibusiness/AB-999", page(TIP, own));
  data.tracker.push({ code: "AB-123", area: "aibusiness", flaggedGA: true });
  assert.deepEqual(problemsOf(data), []);
  // a world without any beta exam has nothing to check
  assert.deepEqual(
    problemsOf({ statuses: { azure: {} }, tracker: [], pages: new Map() }),
    [],
  );
});

test("a BETA exam without a page is named, with the file to create", () => {
  const data = world({ pages: new Map() });
  assert.deepEqual(problemsOf(data), [
    "AB-999: src/data_files/exam-status.mjs marks it BETA but src/content/docs/aibusiness/AB-999.mdx does not exist: create the page or remove the BETA status",
  ]);
});

test("a BETA page without the tip, without a note or with two notes is named", () => {
  const without = world();
  without.pages.set("aibusiness/AB-999", page(noteFor("pending")));
  assert.deepEqual(problemsOf(without), [
    'AB-999: src/content/docs/aibusiness/AB-999.mdx has no beta tip but src/data_files/exam-status.mjs marks AB-999 BETA: put the standard ":::tip" ("This is a beta exam. ...") at the top of the page, or remove the BETA status',
  ]);

  const noNote = world();
  noNote.pages.set("aibusiness/AB-999", page(TIP));
  assert.deepEqual(problemsOf(noNote), [
    'AB-999: the beta tip in src/content/docs/aibusiness/AB-999.mdx is not directly followed by the beta timeline note: add the ":::note" box right after the tip, with nothing in between and without a title (node scripts/beta-note.mjs --code AB-999 writes the note for the entry in src/data_files/beta-exams.json)',
  ]);
  const apart = world();
  apart.pages.set(
    "aibusiness/AB-999",
    page(TIP, "Some text.", noteFor("pending")),
  );
  assert.match(
    problemsOf(apart)[0],
    /not directly followed by the beta timeline note/,
  );

  const two = world();
  two.pages.set(
    "aibusiness/AB-999",
    page(TIP, noteFor("pending"), ":::note\nAnother box.\n:::"),
  );
  assert.deepEqual(problemsOf(two), [
    'AB-999: src/content/docs/aibusiness/AB-999.mdx has 2 ":::note" boxes right after the beta tip: keep exactly one, the beta timeline (node scripts/beta-note.mjs --code AB-999 writes the note for the entry in src/data_files/beta-exams.json)',
  ]);
});

test("a BETA exam that the tracker lacks, lists twice or puts in another area is named", () => {
  const missing = world({ tracker: [] });
  assert.deepEqual(problemsOf(missing), [
    'AB-999: src/data_files/beta-exams.json has no entry for it but src/data_files/exam-status.mjs marks it BETA: add { "code", "area", "name", "url", "betaStart", "announcement", "flaggedGA": false } (see docs/monitors/beta-and-retiring-exams.md)',
  ]);

  const twice = world();
  twice.tracker.push({ ...twice.tracker[0] });
  assert.deepEqual(problemsOf(twice), [
    "AB-999: src/data_files/beta-exams.json lists it 2 times: keep one entry",
  ]);

  const area = world();
  area.tracker[0].area = "azure";
  assert.deepEqual(problemsOf(area), [
    'AB-999: src/data_files/beta-exams.json says area "azure" but src/data_files/exam-status.mjs lists it under "aibusiness": make them agree',
  ]);
});

test("an entry flagged generally available is no error while the exam is still BETA, a BETA exam without an entry is", () => {
  // The Beta Exam Monitor sets flaggedGA (and flaggedAt) on its own when Learn
  // drops the "(beta)" marker; the clean-up by hand comes after that.
  for (const announcement of ["pending", "unannounced", ANNOUNCEMENT]) {
    const flagged = world({ announcement });
    Object.assign(flagged.tracker[0], {
      flaggedGA: true,
      flaggedAt: "2026-10-15",
    });
    assert.deepEqual(problemsOf(flagged), [], announcement);
  }
  // The flag excuses nothing else: the hub still says BETA, so the entry and the note have to be right.
  const noStart = world();
  Object.assign(noStart.tracker[0], {
    flaggedGA: true,
    betaStart: undefined,
  });
  const [startProblem, ...restOfStart] = problemsOf(noStart);
  assert.deepEqual(restOfStart, []);
  assert.match(
    startProblem,
    /^AB-999: src\/data_files\/beta-exams\.json needs "betaStart"/,
  );
  const wrongNote = world({ announcement: "unannounced" });
  wrongNote.tracker[0].flaggedGA = true;
  wrongNote.pages.set("aibusiness/AB-999", page(TIP, noteFor("pending")));
  const [noteProblem, ...restOfNote] = problemsOf(wrongNote);
  assert.deepEqual(restOfNote, []);
  assert.match(
    noteProblem,
    /^AB-999: the note says "pending" but beta-exams\.json says announcement "unannounced" /,
  );
  const noTip = world();
  noTip.tracker[0].flaggedGA = true;
  noTip.pages.set("aibusiness/AB-999", page(noteFor("pending")));
  assert.match(problemsOf(noTip)[0], /^AB-999: .* has no beta tip but /);

  // A BETA exam without an entry stays an error, and the entry of another exam, flagged or not, is no entry for it.
  const missing = world({
    tracker: [{ code: "AB-123", area: "aibusiness", flaggedGA: true }],
  });
  assert.deepEqual(problemsOf(missing), [
    'AB-999: src/data_files/beta-exams.json has no entry for it but src/data_files/exam-status.mjs marks it BETA: add { "code", "area", "name", "url", "betaStart", "announcement", "flaggedGA": false } (see docs/monitors/beta-and-retiring-exams.md)',
  ]);

  // Halfway through the clean-up: the badge is gone and the flagged entry stays, only the tip left on the page is named.
  const half = world();
  half.tracker[0].flaggedGA = true;
  half.statuses.aibusiness = {};
  assert.deepEqual(problemsOf(half), [
    "AB-999: src/content/docs/aibusiness/AB-999.mdx carries the beta tip but src/data_files/exam-status.mjs does not mark it BETA: remove the tip and the timeline note if the exam is generally available (see docs/monitors/beta-and-retiring-exams.md), or restore the BETA status and the entry in src/data_files/beta-exams.json",
  ]);
  // The same for an entry that is not flagged: that one must be a BETA exam.
  const unflagged = world();
  unflagged.statuses.aibusiness = {};
  assert.match(
    problemsOf(unflagged)[0],
    /^AB-999: src\/data_files\/beta-exams\.json tracks it as a beta exam \(flaggedGA is not true\) but /,
  );
});

test("a missing or invalid betaStart or announcement is named, with what to write", () => {
  for (const betaStart of [undefined, "", "2026-02-31", "14.10.2026"]) {
    const data = world();
    data.tracker[0].betaStart = betaStart;
    const problems = problemsOf(data);
    assert.equal(problems.length, 1, JSON.stringify(betaStart));
    assert.match(
      problems[0],
      /^AB-999: src\/data_files\/beta-exams\.json needs "betaStart", the day the beta period began \(YYYY-MM-DD, .*never guessed\): The beta start must be a real day written YYYY-MM-DD/,
    );
  }
  for (const announcement of [undefined, "", "soon", "http://example.com/x"]) {
    const data = world();
    data.tracker[0].announcement = announcement;
    const problems = problemsOf(data);
    assert.equal(problems.length, 1, JSON.stringify(announcement));
    assert.match(
      problems[0],
      /^AB-999: src\/data_files\/beta-exams\.json needs "announcement": "pending" \(the Skills Hub announcement is expected within 7 days of the beta start\), "unannounced" \(none found after that\) or the https URL of the announcement: An announcement must be/,
    );
  }
});

test("a note that says another state than the tracker is named, with the file to fix", () => {
  const data = world({ announcement: "unannounced" });
  data.pages.set("aibusiness/AB-999", page(TIP, noteFor("pending")));
  assert.deepEqual(problemsOf(data), [
    'AB-999: the note says "pending" but beta-exams.json says announcement "unannounced" (fix src/content/docs/aibusiness/AB-999.mdx: node scripts/beta-note.mjs --code AB-999 writes the note for the entry in src/data_files/beta-exams.json; or correct the entry if the tracker is what is wrong)',
  ]);
  // the announcement arrived and the tracker says so, the page still has the pending note
  const arrived = world({ announcement: ANNOUNCEMENT });
  arrived.pages.set("aibusiness/AB-999", page(TIP, noteFor("pending")));
  assert.equal(problemsOf(arrived).length, 1);
  assert.match(
    problemsOf(arrived)[0],
    /^AB-999: the note says "pending" but beta-exams\.json says announcement "https:\/\/techcommunity/,
  );
});

test("a note with a wrong date or a missing link is named", () => {
  const data = world();
  data.pages.set(
    "aibusiness/AB-999",
    page(
      TIP,
      noteFor("pending").replace(
        "between December 23, 2026 and January 6, 2027",
        "between December 24, 2026 and January 6, 2027",
      ),
    ),
  );
  const problems = problemsOf(data);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /^AB-999: the note must give the go-live window as "between December 23, 2026 and January 6, 2027" .* \(fix src\/content\/docs\/aibusiness\/AB-999\.mdx: node scripts\/beta-note\.mjs --code AB-999 /,
  );
  const link = world();
  link.pages.set(
    "aibusiness/AB-999",
    page(
      TIP,
      noteFor("pending").replace(
        "[Beta Exams](/certs/vouchers/betaexams/)",
        "Beta Exams",
      ),
    ),
  );
  assert.match(
    problemsOf(link)[0],
    /^AB-999: the note must link the Beta Exams page/,
  );
});

test("the note of an announced exam links the announcement of the tracker, to the letter", () => {
  const data = world({ announcement: ANNOUNCEMENT });
  const other = ANNOUNCEMENT.replace("/123?", "/124?");
  data.pages.set(
    "aibusiness/AB-999",
    page(TIP, noteFor(ANNOUNCEMENT).replace(ANNOUNCEMENT, other)),
  );
  const [problem, ...rest] = problemsOf(data);
  assert.deepEqual(rest, []);
  assert.match(
    problem,
    /^AB-999: the note must link the announcement https:\/\/techcommunity\.microsoft\.com\/blog\/skills-hub-blog\/new-exam\/123 /,
  );
  // the same address without the tracking query is accepted by the checker but not by the test
  const bare = world({ announcement: ANNOUNCEMENT });
  bare.pages.set(
    "aibusiness/AB-999",
    page(
      TIP,
      noteFor(ANNOUNCEMENT).replace(ANNOUNCEMENT, ANNOUNCEMENT.split("?")[0]),
    ),
  );
  const [exact, ...others] = problemsOf(bare);
  assert.deepEqual(others, []);
  assert.match(
    exact,
    new RegExp(
      `^AB-999: the note links the announcement but not with the URL of src/data_files/beta-exams\\.json \\("${ANNOUNCEMENT.replace(/[.?]/g, "\\$&")}"\\)`,
    ),
  );
  // Microsoft's own go-live wording is the page's and needs no tracker field
  const withExpects = world({ announcement: ANNOUNCEMENT });
  withExpects.pages.set(
    "aibusiness/AB-999",
    page(TIP, noteFor(ANNOUNCEMENT, "general availability in November 2026")),
  );
  assert.deepEqual(problemsOf(withExpects), []);
});

test("a tracked beta exam without a BETA status is named, and so is the page that still has the tip", () => {
  const data = world();
  data.statuses.aibusiness = {};
  const problems = problemsOf(data);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.equal(
    problems[0],
    'AB-999: src/data_files/beta-exams.json tracks it as a beta exam (flaggedGA is not true) but src/data_files/exam-status.mjs has no BETA status for it: add { text: "BETA", variant: "tip" } under "aibusiness" there, or, if the exam is generally available, set "flaggedGA": true in the entry (see docs/monitors/beta-and-retiring-exams.md)',
  );
  assert.equal(
    problems[1],
    "AB-999: src/content/docs/aibusiness/AB-999.mdx carries the beta tip but src/data_files/exam-status.mjs does not mark it BETA: remove the tip and the timeline note if the exam is generally available (see docs/monitors/beta-and-retiring-exams.md), or restore the BETA status and the entry in src/data_files/beta-exams.json",
  );
  // the exam went GA and was worked off the list: the tracker may keep the flagged entry
  data.tracker[0].flaggedGA = true;
  data.pages.set("aibusiness/AB-999", page(":::tip\nSome other hint.\n:::"));
  assert.deepEqual(problemsOf(data), []);
});

test("a page that is not BETA must not keep the beta timeline note either", () => {
  const data = world({
    ...withPages([["azure/AZ-998", page(noteFor("pending"))]]),
  });
  assert.deepEqual(problemsOf(data), [
    'AZ-998: src/content/docs/azure/AZ-998.mdx carries a beta timeline note ("The beta period began on ...") but src/data_files/exam-status.mjs does not mark it BETA: remove the note, which goes together with the beta tip',
  ]);
  const tipped = world({ ...withPages([["azure/AZ-998", page(TIP)]]) });
  assert.match(
    problemsOf(tipped)[0],
    /^AZ-998: src\/content\/docs\/azure\/AZ-998\.mdx carries the beta tip but /,
  );
  // an exam whose status is RETIRING or GA is no beta exam
  assert.equal(problemsOf(tipped).length, 1);
});
