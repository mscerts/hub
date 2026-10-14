import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { examStatuses } from "../../src/data_files/exam-status.mjs";

const root = resolve(import.meta.dirname, "../..");
const TRACKING = "?WT.mc_id=studentamb_165290";
const ANNOUNCEMENT = `https://techcommunity.microsoft.com/blog/skills-hub-blog/new-exam/123${TRACKING}`;
// an address verified by hand, like GH-700's: not the exams/<code> one
const CERT_URL = `https://learn.microsoft.com/credentials/certifications/agentic-ai-business-professional/${TRACKING}`;

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const examPage = (code, name) =>
  `---\ntitle: ${code} Study Materials\ndescription: "Collection of study materials for the certification exam ${code}: ${name}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses."\n---\n`;

/**
 * The sync script copied into a scratch tree of its own, so that the exam statuses,
 * the exam pages and the tracker it reads are the test's, not the repository's:
 * the script finds them relative to its own location (only OUTPUT_FILE is an
 * environment variable).
 */
function scratch({ statuses, pages, tracker }) {
  const dir = mkdtempSync(join(tmpdir(), "beta-exams-sync-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(root, "scripts", "beta-exams-sync.mjs"),
    join(dir, "scripts", "beta-exams-sync.mjs"),
  );
  mkdirSync(join(dir, "src", "data_files"), { recursive: true });
  writeFileSync(
    join(dir, "src", "data_files", "exam-status.mjs"),
    `export const examStatuses = ${JSON.stringify(statuses)};\n`,
  );
  for (const [path, name] of Object.entries(pages)) {
    const [area, code] = path.split("/");
    mkdirSync(join(dir, "src", "content", "docs", area), { recursive: true });
    writeFileSync(
      join(dir, "src", "content", "docs", area, `${code}.mdx`),
      examPage(code, name),
    );
  }
  const output = join(dir, "beta-exams.json");
  if (tracker !== undefined) {
    writeFileSync(
      output,
      typeof tracker === "string"
        ? tracker
        : JSON.stringify(tracker, null, 2) + "\n",
    );
  }
  return {
    output,
    run: () =>
      spawnSync(
        process.execPath,
        [join(dir, "scripts", "beta-exams-sync.mjs")],
        {
          encoding: "utf8",
          env: { ...process.env, OUTPUT_FILE: output },
        },
      ),
    read: () => JSON.parse(readFileSync(output, "utf8")),
  };
}

const BETA = { text: "BETA", variant: "tip" };
const STATUSES = {
  azure: { "AZ-401": BETA, "AZ-400": { text: "AT RISK", variant: "caution" } },
  aibusiness: { "AB-650": BETA },
  github: {},
};
const PAGES = {
  "azure/AZ-401": "Designing Agentic DevOps Solutions",
  "azure/AZ-400": "Designing and Implementing Microsoft DevOps Solutions",
  "aibusiness/AB-650": "Administering Microsoft 365 and AI Services",
};
const url = (code) =>
  `https://learn.microsoft.com/credentials/certifications/exams/${code.toLowerCase()}${TRACKING}`;

test("the real script over a copy of the committed tracker writes every entry of an exam that is still BETA back byte for byte: only lastSynced moves", () => {
  const committedFile = join(root, "src", "data_files", "beta-exams.json");
  const committedText = readFileSync(committedFile, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const committed = JSON.parse(committedText);
  // a copy: the committed tracker is never written
  const dir = mkdtempSync(join(tmpdir(), "beta-exams-sync-"));
  scratchDirs.push(dir);
  const output = join(dir, "beta-exams.json");
  writeFileSync(output, committedText);
  const run = spawnSync(
    process.execPath,
    [join(root, "scripts", "beta-exams-sync.mjs")],
    { encoding: "utf8", env: { ...process.env, OUTPUT_FILE: output } },
  );
  assert.equal(run.status, 0, run.stderr);

  // the sync's own rule for a BETA exam
  const isBeta = (code) =>
    Object.values(examStatuses).some(
      (entries) =>
        entries[code]?.text === "BETA" && entries[code]?.variant === "tip",
    );
  const outputText = readFileSync(output, "utf8");
  const written = new Map(
    JSON.parse(outputText).exams.map((exam) => [exam.code, exam]),
  );
  const block = (exam) => JSON.stringify(exam, null, 2);
  for (const entry of committed.exams) {
    if (!isBeta(entry.code)) {
      // an exam that is not BETA any more is dropped, as it always was
      assert.ok(!written.has(entry.code), `${entry.code} is not BETA any more`);
      continue;
    }
    assert.ok(written.has(entry.code), `${entry.code} is BETA: it is kept`);
    assert.equal(
      block(written.get(entry.code)),
      block(entry),
      `${entry.code} comes back byte for byte (its url and flags included)`,
    );
  }

  // where the tracker agrees with exam-status.mjs, that is the whole file
  const stamped = (text) =>
    text.replace(/^ {2}"lastSynced": ".*",$/m, '  "lastSynced": "<day>",');
  if (
    written.size === committed.exams.length &&
    committed.exams.every((entry) => written.has(entry.code))
  ) {
    assert.equal(stamped(outputText), stamped(committedText));
  }
});

test("a resync refreshes the area and the name of an entry and keeps every other key as the file has it, the hand-set url included", () => {
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        {
          code: "AB-650",
          area: "somewhere-else",
          name: "An old name",
          url: "https://old.example/ab-650",
          betaStart: "2026-07-28",
          announcement: ANNOUNCEMENT,
          flaggedGA: false,
          note: "written by hand",
          links: { blog: "https://example.com/x" },
        },
        {
          code: "AZ-401",
          area: "azure",
          name: "Designing Agentic DevOps Solutions",
          url: url("AZ-401"),
          betaStart: "2026-10-14",
          announcement: "pending",
          flaggedGA: false,
        },
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);

  const { exams } = sandbox.read();
  assert.deepEqual(
    exams.map((exam) => exam.code),
    ["AB-650", "AZ-401"],
  );
  assert.deepEqual(exams[0], {
    code: "AB-650",
    // what the repository says is refreshed: the area from exam-status.mjs, the name from the page ...
    area: "aibusiness",
    name: "Administering Microsoft 365 and AI Services",
    // ... and nothing else is lost: the address set by hand, and the rest in the order the entry had it
    url: "https://old.example/ab-650",
    betaStart: "2026-07-28",
    announcement: ANNOUNCEMENT,
    note: "written by hand",
    links: { blog: "https://example.com/x" },
    flaggedGA: false,
  });
  assert.deepEqual(Object.keys(exams[0]), [
    "code",
    "area",
    "name",
    "url",
    "betaStart",
    "announcement",
    "note",
    "links",
    "flaggedGA",
  ]);
  assert.equal(exams[1].betaStart, "2026-10-14");
  assert.equal(exams[1].announcement, "pending");
  // entries that are complete need no warning
  assert.doesNotMatch(run.stderr, /WARNING/);
});

test("an exam that is BETA but has no entry gets one without betaStart and announcement, and a warning says to add them by hand", () => {
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        {
          code: "AB-650",
          area: "aibusiness",
          name: "Administering Microsoft 365 and AI Services",
          url: url("AB-650"),
          betaStart: "2026-07-28",
          announcement: "unannounced",
          flaggedGA: false,
        },
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);

  const { exams } = sandbox.read();
  const added = exams.find((exam) => exam.code === "AZ-401");
  // the two fields are not invented, not even as placeholders
  assert.deepEqual(added, {
    code: "AZ-401",
    area: "azure",
    name: "Designing Agentic DevOps Solutions",
    url: url("AZ-401"),
    flaggedGA: false,
  });
  assert.match(
    run.stderr,
    /WARNING: AZ-401 is BETA, but the tracker had no entry for it, so the new entry has no "betaStart" and "announcement"\. A resync cannot derive them: both must be added by hand/,
  );
  assert.match(
    run.stderr,
    /tests\/scripts\/beta-pages\.test\.mjs fails until then/,
  );
  // the entry that has them is not warned about
  assert.doesNotMatch(run.stderr, /WARNING: AB-650/);
  assert.deepEqual(
    exams.find((exam) => exam.code === "AB-650").announcement,
    "unannounced",
  );
});

test("a certification address set by hand survives a resync, however often it is run", () => {
  // GH-700's real situation: its exam page is a 404, so the exams/gh-700 address is no use
  const entry = {
    code: "GH-700",
    area: "github",
    name: "Enhancing Operational Efficiency with Agentic AI",
    url: CERT_URL,
    betaStart: "2026-10-14",
    announcement: "pending",
    flaggedGA: false,
  };
  const sandbox = scratch({
    statuses: { github: { "GH-700": BETA } },
    pages: { "github/GH-700": entry.name },
    tracker: { lastSynced: "2026-09-16", exams: [entry] },
  });
  for (const attempt of [1, 2]) {
    const run = sandbox.run();
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /WARNING/);
    // the entry comes back as it was, byte for byte
    assert.equal(
      JSON.stringify(sandbox.read().exams),
      JSON.stringify([entry]),
      `run ${attempt}`,
    );
  }
});

test("an entry flagged as generally available stays flagged, with its flaggedAt; an unflagged one stays unflagged", () => {
  const entry = (code, extra) => ({
    code,
    area: code === "AB-650" ? "aibusiness" : "azure",
    name: "Old name",
    url: url(code),
    betaStart: "2026-07-28",
    announcement: "unannounced",
    flaggedGA: false,
    ...extra,
  });
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        entry("AB-650", { flaggedGA: true, flaggedAt: "2026-10-20" }),
        entry("AZ-401"),
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);
  const [flagged, unflagged] = sandbox.read().exams;
  assert.equal(flagged.code, "AB-650");
  assert.equal(flagged.flaggedGA, true);
  assert.equal(flagged.flaggedAt, "2026-10-20");
  // the monitor's state stays last, as the monitor writes it
  assert.deepEqual(Object.keys(flagged).slice(-2), ["flaggedGA", "flaggedAt"]);
  assert.equal(unflagged.code, "AZ-401");
  assert.equal(unflagged.flaggedGA, false);
  assert.ok(!("flaggedAt" in unflagged));
});

test("a code with no entry yet gets the canonical exams address and flaggedGA false, whatever the entries of the other codes carry", () => {
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        {
          code: "AB-650",
          area: "aibusiness",
          name: "Administering Microsoft 365 and AI Services",
          url: CERT_URL,
          betaStart: "2026-07-28",
          announcement: "unannounced",
          flaggedGA: true,
          flaggedAt: "2026-10-20",
        },
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);
  const { exams } = sandbox.read();
  // AZ-401 is new: neither the address nor the flags of AB-650 are handed on
  assert.deepEqual(
    exams.find((exam) => exam.code === "AZ-401"),
    {
      code: "AZ-401",
      area: "azure",
      name: "Designing Agentic DevOps Solutions",
      url: url("AZ-401"),
      flaggedGA: false,
    },
  );
  assert.match(
    run.stderr,
    /WARNING: AZ-401 is BETA, but the tracker had no entry for it/,
  );
  const known = exams.find((exam) => exam.code === "AB-650");
  assert.equal(known.url, CERT_URL);
  assert.equal(known.flaggedGA, true);
});

test("an entry without a usable url gets the canonical one, and a missing flaggedGA is false", () => {
  for (const bad of [undefined, null, "", "   ", 42]) {
    const sandbox = scratch({
      statuses: { aibusiness: { "AB-650": BETA } },
      pages: { "aibusiness/AB-650": PAGES["aibusiness/AB-650"] },
      tracker: {
        lastSynced: "2026-09-16",
        // JSON.stringify leaves a key whose value is undefined out
        exams: [
          {
            code: "AB-650",
            url: bad,
            betaStart: "2026-07-28",
            announcement: "pending",
          },
        ],
      },
    });
    const run = sandbox.run();
    assert.equal(run.status, 0, `${JSON.stringify(bad)}: ${run.stderr}`);
    assert.deepEqual(
      sandbox.read().exams,
      [
        {
          code: "AB-650",
          area: "aibusiness",
          name: "Administering Microsoft 365 and AI Services",
          url: url("AB-650"),
          betaStart: "2026-07-28",
          announcement: "pending",
          flaggedGA: false,
        },
      ],
      JSON.stringify(bad),
    );
  }
});

test("without a tracker file every BETA exam is written without the two fields, each with its warning", () => {
  const sandbox = scratch({ statuses: STATUSES, pages: PAGES });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    sandbox.read().exams.map((exam) => Object.keys(exam)),
    [
      ["code", "area", "name", "url", "flaggedGA"],
      ["code", "area", "name", "url", "flaggedGA"],
    ],
  );
  for (const code of ["AB-650", "AZ-401"]) {
    assert.match(run.stderr, new RegExp(`WARNING: ${code} is BETA, but`));
  }
});

test("an entry that lacks one of the two fields is warned about by name", () => {
  const entry = (code, extra) => ({
    code,
    area: "azure",
    name: "Old",
    url: url(code),
    ...extra,
    flaggedGA: false,
  });
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        entry("AB-650", { betaStart: "2026-07-28" }),
        entry("AZ-401", { announcement: "pending", betaStart: "" }),
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stderr,
    /WARNING: AB-650 is BETA, but its entry has no "announcement"\. A resync cannot derive it: it must be added by hand/,
  );
  assert.match(
    run.stderr,
    /WARNING: AZ-401 is BETA, but its entry has no "betaStart"\./,
  );
  // what the entries had is kept
  const { exams } = sandbox.read();
  assert.equal(exams[0].betaStart, "2026-07-28");
  assert.equal(exams[1].announcement, "pending");
});

test("resyncing the output again changes nothing, whatever the entries carry", () => {
  const sandbox = scratch({
    statuses: STATUSES,
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        {
          code: "AZ-401",
          url: CERT_URL,
          betaStart: "2026-10-14",
          announcement: "pending",
          note: "kept",
          flaggedGA: true,
          flaggedAt: "2026-10-20",
        },
      ],
    },
  });
  assert.equal(sandbox.run().status, 0);
  const first = readFileSync(sandbox.output, "utf8");
  assert.equal(sandbox.run().status, 0);
  const second = readFileSync(sandbox.output, "utf8");
  // the entries are the same (lastSynced is the day of the run, which is not what is compared)
  assert.deepEqual(JSON.parse(second).exams, JSON.parse(first).exams);
  assert.equal(
    JSON.parse(first).exams.find((exam) => exam.code === "AZ-401").url,
    CERT_URL,
  );
  assert.match(first, /^\{\n {2}"lastSynced": "\d{4}-\d{2}-\d{2}",\n/);
  assert.ok(first.endsWith("}\n"));
});

test("a tracker file that cannot be read does not stop a resync: nothing can be kept, and the warning says so", () => {
  for (const tracker of ["{ not json", '{ "exams": "nope" }', "[]"]) {
    const sandbox = scratch({ statuses: STATUSES, pages: PAGES, tracker });
    const run = sandbox.run();
    assert.equal(run.status, 0, `${tracker}: ${run.stderr}`);
    assert.match(
      run.stderr,
      /WARNING: .*beta-exams\.json cannot be read \(.*\), so no entry can be kept: every entry is written with the canonical url and flaggedGA false, and without "betaStart" and "announcement", which must be added by hand/,
      tracker,
    );
    const { exams } = sandbox.read();
    assert.deepEqual(
      exams.map((exam) => exam.code),
      ["AB-650", "AZ-401"],
    );
    for (const exam of exams) {
      assert.equal(exam.url, url(exam.code), tracker);
      assert.equal(exam.flaggedGA, false, tracker);
    }
  }
});

test("the rest of the sync is as it was: BETA only, sorted by code, a missing page skipped, entries of exams that are not BETA dropped", () => {
  const sandbox = scratch({
    statuses: {
      azure: { "AZ-401": BETA, "AZ-900": BETA, "AZ-400": { text: "GA" } },
      aibusiness: { "AB-650": BETA },
    },
    // AZ-900 has no page
    pages: PAGES,
    tracker: {
      lastSynced: "2026-09-16",
      exams: [
        // not BETA any more
        {
          code: "AZ-400",
          url: url("AZ-400"),
          betaStart: "2025-01-01",
          announcement: "unannounced",
          flaggedGA: true,
          flaggedAt: "2025-06-01",
        },
        {
          code: "AZ-401",
          url: CERT_URL,
          betaStart: "2026-10-14",
          announcement: "pending",
          flaggedGA: true,
          flaggedAt: "2026-10-20",
        },
        // BETA, but its page is missing
        {
          code: "AZ-900",
          url: url("AZ-900"),
          betaStart: "2026-10-01",
          announcement: "pending",
          flaggedGA: false,
        },
      ],
    },
  });
  const run = sandbox.run();
  assert.equal(run.status, 0, run.stderr);
  const { exams, lastSynced } = sandbox.read();
  assert.match(lastSynced, /^\d{4}-\d{2}-\d{2}$/);
  // sorted by code; AZ-400 and AZ-900 are not in the file any more
  assert.deepEqual(
    exams.map((exam) => exam.code),
    ["AB-650", "AZ-401"],
  );
  // the page-less exam is skipped with a warning, so its entry goes too ...
  assert.match(
    run.stderr,
    /WARNING: no exam page found for AZ-900 in azure; skipping\./,
  );
  // ... and the entry of an exam that is not BETA goes without a word, as it always did
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /AZ-400/);
  // the entry that stays is untouched: flagged, with its date and its address
  const az401 = exams.find((exam) => exam.code === "AZ-401");
  assert.equal(az401.flaggedGA, true);
  assert.equal(az401.flaggedAt, "2026-10-20");
  assert.equal(az401.url, CERT_URL);
  assert.equal(az401.betaStart, "2026-10-14");
  // a new code gets the canonical address
  assert.equal(exams.find((exam) => exam.code === "AB-650").url, url("AB-650"));
});
