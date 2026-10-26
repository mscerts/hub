import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { AREA_BY_PREFIX, EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import {
  PENDING_ANNOUNCEMENT_DAYS,
  buildBetaNote,
  checkBetaNote,
  findBetaNote,
  inspectBetaNote,
} from "../../scripts/lib/beta-note.mjs";
import {
  AREA_MAP,
  betaFor,
  buildPage,
  parseArgs,
} from "../../scripts/new-exam.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "new-exam.mjs");
// LF whatever the checkout did to the files (core.autocrlf on Windows).
const lf = (text) => text.replace(/\r\n/g, "\n");
const fixture = (name) =>
  lf(readFileSync(join(root, "tests", "fixtures", "new-exam", name), "utf8"));

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// The pages always go to a temporary DOCS_DIR (never into src/content), and the
// day is always TODAY (never the clock).
async function scaffold(args, { today = "2026-10-16", env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "new-exam-scaffold-"));
  tempDirs.push(dir);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, DOCS_DIR: dir, TODAY: today, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("close", done));
  return {
    dir,
    code,
    stdout,
    stderr,
    page: (area, name) => readFile(join(dir, area, `${name}.mdx`), "utf8"),
    files: async () => (await readdir(dir, { recursive: true })).sort(),
  };
}

const BETA = ["--code", "AZ-998", "--name", "Agentic Things", "--beta"];

// The standard beta tip ("Beta Exam Pages" in AGENTS.md), the text of every beta
// page, for example src/content/docs/azure/AZ-401.mdx.
const TIP = [
  ":::tip",
  "This is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.",
  "",
  "If you have any resources that you would like to recommend, please let us know and we will add them.",
  ":::",
].join("\n");

// The beta tips of the real exam pages (none when no exam is in beta).
function realBetaTips() {
  const docs = join(root, "src", "content", "docs");
  const tips = new Set();
  for (const area of EXAM_AREAS) {
    for (const file of readdirSync(join(docs, area))) {
      if (!file.endsWith(".mdx")) continue;
      const text = lf(readFileSync(join(docs, area, file), "utf8"))
        .replace(/^<BetaBanner>$/gm, ":::tip")
        .replace(/^<\/BetaBanner>$/gm, ":::");
      const tip = text.match(/^:::tip\nThis is a beta exam\.[\s\S]*?\n:::$/m);
      if (tip) tips.add(tip[0]);
    }
  }
  return [...tips];
}

test("the scaffold reads the one shared map of exam prefixes, and every prefix of it has its folder", async () => {
  assert.equal(AREA_MAP, AREA_BY_PREFIX);
  const runs = await Promise.all(
    Object.entries(AREA_BY_PREFIX).map(async ([prefix, area]) => {
      const run = await scaffold(["--code", `${prefix}-999`, "--name", "X"]);
      return { prefix, area, run };
    }),
  );
  for (const { prefix, area, run } of runs) {
    assert.equal(run.code, 0, `${prefix}: ${run.stderr}`);
    assert.deepEqual(await run.files(), [
      area,
      join(area, `${prefix}-999.mdx`),
    ]);
  }

  const unknown = await scaffold(["--code", "XY-123", "--name", "X"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown prefix "XY"/);
  assert.ok(
    unknown.stderr.includes(Object.keys(AREA_BY_PREFIX).join(", ")),
    "the message lists the supported prefixes",
  );
  assert.deepEqual(await unknown.files(), []);
});

test("without --beta the page is exactly what the scaffold wrote before, labs link included", async () => {
  const plain = await scaffold([
    "--code",
    "az-999",
    "--name",
    'Designing and Implementing "Quoted" Things',
  ]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(
    await plain.page("azure", "AZ-999"),
    fixture("scaffold-plain.mdx"),
  );
  assert.match(plain.stdout, /Created: .*AZ-999\.mdx/);
  assert.match(
    plain.stdout,
    /2\. If this exam is BETA or RETIRING, add it to src\/data_files\/exam-status\.mjs/,
  );
  assert.doesNotMatch(plain.stdout, /beta-note|beta-exams/);

  const labs = await scaffold([
    "--code",
    "SC-999",
    "--name",
    "Security Things",
    "--labs",
  ]);
  assert.equal(labs.code, 0, labs.stderr);
  assert.equal(
    await labs.page("security", "SC-999"),
    fixture("scaffold-labs.mdx"),
  );
  assert.doesNotMatch(labs.stdout, /add it with --labs next time/);
});

test("--beta writes the standard beta tip and the generated note right after it, and no BetaBanner", async () => {
  const run = await scaffold([...BETA, "--beta-start", "2026-10-14"]);
  assert.equal(run.code, 0, run.stderr);
  const page = lf(await run.page("azure", "AZ-998"));

  // The standard tip, then the note as a box of its own, then the card.
  const note = buildBetaNote({ start: "2026-10-14", announcement: "pending" });
  assert.ok(
    page.includes(
      `'@components/docs';\n\n${TIP}\n\n${note}\n\n<Card title="Get Started"`,
    ),
    "the page must open with the standard tip, the note and the Get Started card, each in a box of its own",
  );
  assert.doesNotMatch(page, /BetaBanner/);
  assert.match(page, /^title: AZ-998 Study Materials$/m);
  assert.match(page, /title="Exam AZ-998: Agentic Things"/);

  // What the repository's own beta page rules see in it.
  const inspected = inspectBetaNote(page);
  assert.equal(inspected.hasTip, true);
  assert.equal(inspected.noteCount, 1);
  const found = findBetaNote(page);
  assert.equal(found.found, true);
  assert.deepEqual(
    checkBetaNote({
      noteText: found.text,
      start: "2026-10-14",
      announcement: "pending",
    }),
    [],
  );
});

test("the note starts as pending up to 7 days after the beta start and as unannounced after that", async () => {
  assert.equal(PENDING_ANNOUNCEMENT_DAYS, 7);
  const state = (start, today) => betaFor(start, today).state;
  assert.equal(state("2026-10-14", "2026-10-14"), "pending");
  assert.equal(state("2026-10-14", "2026-10-21"), "pending");
  assert.equal(state("2026-10-14", "2026-10-22"), "unannounced");
  assert.equal(state("2026-10-14", "2027-01-01"), "unannounced");
  // Month and leap-year borders count real days.
  assert.equal(state("2028-02-25", "2028-03-03"), "pending");
  assert.equal(state("2028-02-25", "2028-03-04"), "unannounced");
  assert.equal(state("2026-12-28", "2027-01-04"), "pending");
  assert.equal(state("2026-12-28", "2027-01-05"), "unannounced");
  // A start that has not come yet: still waiting for the announcement.
  assert.equal(betaFor("2026-10-14", "2026-10-10").daysSince, -4);
  assert.equal(state("2026-10-14", "2026-10-10"), "pending");

  const late = await scaffold([...BETA, "--beta-start", "2026-10-14"], {
    today: "2026-10-22",
  });
  assert.equal(late.code, 0, late.stderr);
  const page = lf(await late.page("azure", "AZ-998"));
  const note = buildBetaNote({
    start: "2026-10-14",
    announcement: "unannounced",
  });
  assert.ok(page.includes(`\n\n${note}\n\n<Card`));
  assert.match(page, /We have not found an official go-live announcement/);
  assert.doesNotMatch(page, /has not been published for this exam yet/);
  assert.match(late.stdout, /"announcement": "unannounced"/);
  assert.doesNotMatch(late.stdout, /after today/);

  const soon = await scaffold([...BETA, "--beta-start", "2026-10-14"], {
    today: "2026-10-21",
  });
  assert.match(
    lf(await soon.page("azure", "AZ-998")),
    /has not been published for this exam yet/,
  );

  // A start in the future is pending, and the script says that the note's wording does not fit yet.
  const early = await scaffold([...BETA, "--beta-start", "2026-10-14"], {
    today: "2026-10-10",
  });
  assert.equal(early.code, 0, early.stderr);
  assert.match(early.stdout, /beta start 2026-10-14 is after today/);
  assert.match(early.stdout, /"announcement": "pending"/);
});

test("--beta needs a real --beta-start, and every refusal leaves no page behind", async () => {
  const refused = [
    [[...BETA], /--beta needs --beta-start YYYY-MM-DD/],
    [[...BETA, "--beta-start"], /--beta needs --beta-start YYYY-MM-DD/],
    // The date written after --beta itself is not a --beta-start.
    [
      ["--code", "AZ-998", "--name", "X", "--beta", "2026-10-14"],
      /--beta needs --beta-start/,
    ],
    [
      [...BETA, "--beta-start", "2026-02-31"],
      /--beta-start must be a real day written YYYY-MM-DD \(got "2026-02-31"\)/,
    ],
    [
      [...BETA, "--beta-start", "2026-13-01"],
      /--beta-start must be a real day/,
    ],
    [
      [...BETA, "--beta-start", "14.10.2026"],
      /--beta-start must be a real day/,
    ],
    [
      [...BETA, "--beta-start", "2026-10-14T00:00:00Z"],
      /--beta-start must be a real day/,
    ],
    [
      ["--code", "AZ-998", "--name", "X", "--beta-start", "2026-10-14"],
      /--beta-start only goes with --beta/,
    ],
  ];
  for (const [args, message] of refused) {
    const run = await scaffold(args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.stderr, message, args.join(" "));
    assert.match(run.stderr, /^❌ {2}/, args.join(" "));
    assert.equal(run.stdout, "", args.join(" "));
    assert.deepEqual(await run.files(), [], args.join(" "));
  }

  // TODAY is checked too: the clock is only used when nothing is injected.
  const badToday = await scaffold([...BETA, "--beta-start", "2026-10-14"], {
    today: "tomorrow",
  });
  assert.equal(badToday.code, 1);
  assert.match(badToday.stderr, /TODAY must be a real day written YYYY-MM-DD/);
  assert.deepEqual(await badToday.files(), []);
});

test("the script writes the page and nothing else, and reminds of the badge and the beta-exams.json entry", async () => {
  const dataFiles = () =>
    ["exam-status.mjs", "beta-exams.json"].map((name) =>
      readFileSync(join(root, "src", "data_files", name), "utf8"),
    );
  const before = dataFiles();
  const run = await scaffold([...BETA, "--beta-start", "2026-10-14"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(await run.files(), ["azure", join("azure", "AZ-998.mdx")]);
  assert.deepEqual(dataFiles(), before);
  for (const needle of [
    "src/data_files/exam-status.mjs",
    'add { text: "BETA", variant: "tip" } for AZ-998 under "azure"',
    "src/data_files/beta-exams.json",
    '"betaStart": "2026-10-14"',
    '"announcement": "pending"',
    "node scripts/beta-note.mjs --code AZ-998",
    "writes neither of these files",
  ]) {
    assert.ok(run.stdout.includes(needle), `the reminder lacks ${needle}`);
  }
  assert.match(
    run.stdout,
    /Check the beta note \(the "pending" variant for a beta start of 2026-10-14\)/,
  );
  assert.doesNotMatch(run.stdout, /BetaBanner/);
});

test("an existing page is never overwritten, and a bad code or a missing option prints what is needed", async () => {
  const first = await scaffold(["--code", "AZ-998", "--name", "First"]);
  assert.equal(first.code, 0, first.stderr);
  const again = await scaffold(["--code", "AZ-998", "--name", "Second"], {
    env: { DOCS_DIR: first.dir },
  });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /File already exists: .*AZ-998\.mdx/);
  assert.match(await first.page("azure", "AZ-998"), /First/);
  assert.doesNotMatch(await first.page("azure", "AZ-998"), /Second/);

  const badCode = await scaffold(["--code", "A-1", "--name", "X"]);
  assert.equal(badCode.code, 1);
  assert.match(badCode.stderr, /Invalid exam code: "A-1"/);

  const none = await scaffold([]);
  assert.equal(none.code, 1);
  assert.match(
    none.stderr,
    /^Usage: node scripts\/new-exam\.mjs --code AZ-999 --name/,
  );
  assert.match(none.stderr, /--beta --beta-start YYYY-MM-DD/);
  assert.deepEqual(await none.files(), []);
});

test("the command line is read as --key value pairs and --flags", () => {
  assert.deepEqual(
    parseArgs([
      "--code",
      "AZ-1",
      "--beta",
      "--beta-start",
      "2026-10-14",
      "--labs",
    ]),
    { code: "AZ-1", beta: true, "beta-start": "2026-10-14", labs: true },
  );
  assert.deepEqual(parseArgs(["--beta", "2026-10-14"]), { beta: "2026-10-14" });
  assert.deepEqual(parseArgs([]), {});
});

test("buildPage keeps the beta box out of a page that is not beta", () => {
  const page = buildPage({ code: "AZ-999", name: "X", area: "azure" });
  assert.doesNotMatch(page, /:::note|This is a beta exam/);
  const beta = buildPage({
    code: "AZ-999",
    name: "X",
    area: "azure",
    beta: { start: "2026-10-14", state: "unannounced" },
  });
  assert.equal(
    beta.split(":::tip").length,
    3,
    "the beta tip and the MeasureUp tip",
  );
  assert.equal(beta.split(":::note").length, 2, "one beta note");
});

// The scaffold's copy of the tip is checked against the pages that use it.
test("the beta tip of the scaffold is the one the real beta pages carry", (t) => {
  const tips = realBetaTips();
  if (tips.length === 0) {
    t.skip("no exam page is a beta page at the moment");
    return;
  }
  assert.ok(
    tips.includes(TIP),
    `the beta pages carry ${tips.length} tip(s), none is the standard text of this test`,
  );
  const page = buildPage({
    code: "AZ-999",
    name: "X",
    area: "azure",
    beta: { start: "2026-10-14", state: "pending" },
  });
  assert.ok(page.includes(`\n\n${TIP}\n\n:::note\n`));
});
