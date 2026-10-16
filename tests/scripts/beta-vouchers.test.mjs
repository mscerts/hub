import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  SME_LINKEDIN_GROUP_URL,
  SME_MAILING_LIST_URL,
  areaOf,
  betaVoucherSlug,
  buildBetaVoucherPage,
  findBetaVoucherProblems,
} from "../../scripts/lib/beta-voucher.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "new-beta-voucher.mjs");
// LF whatever the checkout did to the files (core.autocrlf on Windows).
const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (...parts) => lf(readFileSync(join(root, ...parts), "utf8"));
const fixture = (name) => read("tests", "fixtures", "beta-voucher", name);

const TRACKING = "WT.mc_id=studentamb_165290";

// The data of the two pages in tests/fixtures/beta-voucher: AZ-401 without and
// GH-700 with a scheduling caution.
const AZ = {
  code: "AZ-401",
  examName: "Designing and Implementing Microsoft Agentic DevOps Solutions",
  certification: "Microsoft Certified: Agentic DevOps Engineer Expert",
  about:
    "It validates your ability to deliver continuous value with AI-assisted DevOps across Azure DevOps and GitHub, using GitHub Copilot. To earn the certification you must also pass Exam GH-300 or Exam AZ-104.",
  announcementUrl: `https://techcommunity.microsoft.com/blog/skills-hub-blog/new-microsoft-certified-agentic-devops-engineer-expert/4528356?${TRACKING}`,
  discountCode: "AZ401Glendon",
  deadline: "2026-11-02",
  registerUrl: `https://learn.microsoft.com/credentials/certifications/exams/az-401?${TRACKING}`,
};
const GH = {
  code: "GH-700",
  examName: "Enhancing Operational Efficiency with Agentic AI",
  certification: "GitHub Certified: Agentic AI Business Professional",
  about:
    "It validates your skills in using GitHub and GitHub Copilot to design agentic workflows and apply human oversight. The certification is designed for business professionals such as product managers, program managers, technical project managers, and business analysts, and deep software development or coding experience is not required.",
  announcementUrl: `https://techcommunity.microsoft.com/blog/skills-hub-blog/new-github-certified-agentic-ai-business-professional/4564532?${TRACKING}`,
  discountCode: "GH700B8F5",
  deadline: "2026-11-02",
  registerUrl: `https://learn.microsoft.com/credentials/certifications/agentic-ai-business-professional/?${TRACKING}`,
  scheduleUrl:
    "https://learn.microsoft.com/credentials/certifications/schedule-through-pearson-vue?examUid=exam.GH-700&examUrl=https://learn.microsoft.com/credentials/",
};

// ---------------------------------------------------------------------------
// The template and the check
// ---------------------------------------------------------------------------
test("the template writes the layout of the two reference pages, to the letter", () => {
  assert.equal(buildBetaVoucherPage(AZ), fixture("az401beta.mdx"));
  assert.equal(buildBetaVoucherPage(GH), fixture("gh700beta.mdx"));
  assert.equal(betaVoucherSlug("AZ-401"), "az401beta");
  assert.equal(betaVoucherSlug("GH-700"), "gh700beta");
  assert.equal(areaOf("AZ-401"), "azure");
  assert.equal(areaOf("AB-650"), "aibusiness");
  assert.equal(areaOf("XY-123"), undefined);
});

test("the layout the template writes is the one the check accepts, and the top tip carries the SME code", () => {
  for (const data of [AZ, GH]) {
    const page = buildBetaVoucherPage(data);
    assert.deepEqual(findBetaVoucherProblems(page), []);
    // the tip on top, before the announcement button
    const tip = page.indexOf(":::tip");
    assert.ok(tip > 0 && tip < page.indexOf("Read Official Announcement"));
    for (const needle of [
      "Missed the public code?",
      "more private 80% beta code for another 300 people",
      SME_MAILING_LIST_URL,
      SME_LINKEDIN_GROUP_URL,
      "(/certs/vouchers/betaexams/)",
    ]) {
      assert.ok(page.includes(needle), `the top tip lacks ${needle}`);
    }
  }
  // CRLF checkouts are fine
  assert.deepEqual(
    findBetaVoucherProblems(buildBetaVoucherPage(GH).replace(/\n/g, "\r\n")),
    [],
  );
});

test("a quote in the certification is escaped in the description", () => {
  const page = buildBetaVoucherPage({
    ...AZ,
    certification: 'Microsoft Certified: "Quoted" Thing',
  });
  assert.match(page, /^description: ".*\\"Quoted\\".*"$/m);
});

// A page with one change, and what the check says about it.
function problemsAfter(change, data = GH) {
  return findBetaVoucherProblems(change(buildBetaVoucherPage(data)));
}
const cut = (from, to) => (page) => {
  const start = page.indexOf(from);
  assert.ok(start >= 0, `the page has no ${JSON.stringify(from)}`);
  const end = page.indexOf(to, start) + to.length;
  return page.slice(0, start) + page.slice(end);
};

test("the check names what is missing from a page", () => {
  const tip = ":::tip\n**Missed";
  assert.deepEqual(problemsAfter(cut(tip, "access.\n:::\n\n")), [
    "missing the top tip about the SME mailing list and LinkedIn group",
  ]);
  assert.deepEqual(
    problemsAfter(
      cut('<LinkButton href="https://techcommunity', "</LinkButton>\n\n"),
    ),
    ['missing the "Read Official Announcement" button'],
  );
  assert.match(
    problemsAfter(cut(":::note\nThe first 300", ":::\n\n")).join("\n"),
    /missing the offer note/,
  );
  const noCard = problemsAfter(cut("<LinkCard title=", "/>\n\n"));
  assert.equal(noCard.length, 1);
  assert.match(noCard[0], /^missing the study materials card <LinkCard /);
  assert.match(
    problemsAfter(cut(":::tip\nThis is not a private", ":::\n\n")).join("\n"),
    /missing the closing tip/,
  );
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace(
        /\n<LinkButton href="\/certs\/vouchers\/betaexams\/".*\n/,
        "\n",
      ),
    ),
    ['missing the "More About Beta Exams" secondary button'],
  );
  assert.match(
    problemsAfter(cut("## How to claim", "discount\n\n")).join("\n"),
    /missing the heading ## How to claim the 80% discount/,
  );
});

test("the check names what is wrong in the frontmatter", () => {
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace(/^description: "(.*)"$/m, "description: $1"),
    ),
    [
      "description must be a quoted string (a colon in an unquoted description breaks the page)",
    ],
  );
  assert.deepEqual(
    problemsAfter((page) => page.replace(/^voucherEnds: .*\n/m, "")),
    ["voucherEnds must be the last day of the offer, a real YYYY-MM-DD day"],
  );
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace("voucherEnds: 2026-11-02", "voucherEnds: 2026-02-31"),
    ),
    ["voucherEnds must be the last day of the offer, a real YYYY-MM-DD day"],
  );
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace("linkedExam: GH-700", "linkedExam: GH-600"),
    ),
    ["linkedExam must be GH-700"],
  );
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace('voucherCategory: "Special"', 'voucherCategory: "50%"'),
    ),
    ['voucherCategory must be "Special"'],
  );
  assert.deepEqual(
    problemsAfter((page) =>
      page.replace("title: Exam GH-700 (beta)", "title: GH-700 beta"),
    ),
    ['title must be "Exam <CODE> (beta)" (got "GH-700 beta")'],
  );
  assert.deepEqual(findBetaVoucherProblems("no frontmatter here"), [
    "the page has no frontmatter",
  ]);
});

test("the check names what disagrees inside a page", () => {
  // the deadline of the note and the steps follow voucherEnds
  const note = problemsAfter((page) =>
    page.replace(
      "on or before November 2, 2026, can",
      "on or before November 3, 2026, can",
    ),
  );
  assert.match(
    note.join("\n"),
    /the offer note says November 3, 2026 but voucherEnds is 2026-11-02 \(November 2, 2026\)/,
  );
  const step = problemsAfter((page) =>
    page.replace("**November 2, 2026**", "**November 9, 2026**"),
  );
  assert.match(
    step.join("\n"),
    /step 2 says November 9, 2026 but voucherEnds is 2026-11-02/,
  );
  // one code in the note and the steps
  const code = problemsAfter((page) =>
    page.replace("use the code **GH700B8F5**", "use the code **GH700OTHER**"),
  );
  assert.match(
    code.join("\n"),
    /step 3 uses the code GH700OTHER but the offer note says GH700B8F5/,
  );
  // a locale segment
  assert.match(
    problemsAfter((page) =>
      page.replace(
        "learn.microsoft.com/credentials/certifications/agentic",
        "learn.microsoft.com/en-us/credentials/certifications/agentic",
      ),
    ).join("\n"),
    /an \/en-us\/ locale segment/,
  );
  // the study materials card points to the exam of the page
  assert.match(
    problemsAfter((page) =>
      page.replace(
        'href="/certs/github/gh-700/"',
        'href="/certs/github/gh-600/"',
      ),
    ).join("\n"),
    /missing the study materials card/,
  );
});

test("the order of the parts is the layout: a part in the wrong place is named", () => {
  const swapped = problemsAfter((page) => {
    const button = page.match(
      /<LinkButton href="https:\/\/techcommunity[^\n]*\n\n/,
    )[0];
    return page
      .replace(button, "")
      .replace(":::tip\n**Missed", button + ":::tip\n**Missed");
  });
  assert.ok(
    swapped.length > 0,
    "the announcement button before the top tip is a problem",
  );
  assert.match(swapped.join("\n"), /out of order|missing/);
});

test("a scheduling caution is for this exam and sits between the steps and the card", () => {
  assert.deepEqual(
    problemsAfter((page) => page, GH),
    [],
  );
  // a caution for another exam
  assert.match(
    problemsAfter((page) =>
      page.replace("examUid=exam.GH-700", "examUid=exam.GH-600"),
    ).join("\n"),
    /the scheduling caution must be/,
  );
  // the caution after the card is not where the layout puts it
  const after = problemsAfter((page) => {
    const caution = page.match(/:::caution\n[^\n]*\n:::\n\n/)[0];
    return page
      .replace(caution, "")
      .replace(/(<LinkCard[^\n]*\n\n)/, "$1" + caution);
  });
  assert.ok(after.length > 0);
});

// ---------------------------------------------------------------------------
// The real beta voucher pages
// ---------------------------------------------------------------------------
const vouchersDir = join(root, "src", "content", "docs", "vouchers");
const realPages = readdirSync(vouchersDir)
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => ({
    file,
    text: lf(readFileSync(join(vouchersDir, file), "utf8")),
  }))
  .filter(({ text }) => /^title: Exam [A-Z]{2,3}-\d{3} \(beta\)$/m.test(text));

test("every beta voucher page follows the layout, is named after its exam and is linked from the exam page and the sidebar", () => {
  const sidebar = read("src", "data_files", "docs-sidebar.ts");
  for (const { file, text } of realPages) {
    const code = /^title: Exam ([A-Z]{2,3}-\d{3}) \(beta\)$/m.exec(text)[1];
    const where = `src/content/docs/vouchers/${file}`;
    assert.deepEqual(findBetaVoucherProblems(text), [], where);
    const slug = betaVoucherSlug(code);
    assert.equal(file, `${slug}.mdx`, `${where} must be named ${slug}.mdx`);

    const area = areaOf(code);
    const examPage = join(root, "src", "content", "docs", area, `${code}.mdx`);
    assert.ok(
      existsSync(examPage),
      `${where}: the exam page ${code}.mdx does not exist`,
    );
    assert.ok(
      lf(readFileSync(examPage, "utf8")).includes(
        `href="/certs/vouchers/${slug}/"`,
      ),
      `${code}: the exam page has no card linking /certs/vouchers/${slug}/ (see "Next steps" of node scripts/new-beta-voucher.mjs)`,
    );
    assert.ok(
      sidebar.includes(`docsPath("vouchers/${slug}")`),
      `${code}: src/data_files/docs-sidebar.ts has no voucherItems entry for vouchers/${slug}`,
    );
  }
});

test("the reference pages of the tests are themselves valid", () => {
  for (const name of ["az401beta.mdx", "gh700beta.mdx"]) {
    assert.deepEqual(findBetaVoucherProblems(fixture(name)), [], name);
  }
});

// ---------------------------------------------------------------------------
// The scaffold script
// ---------------------------------------------------------------------------
const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const TRACKER = {
  exams: [
    { code: "AZ-401", name: AZ.examName },
    { code: "GH-700", name: GH.examName },
  ],
};

// The pages always go to a temporary DOCS_DIR (never into src/content), the
// tracker is a copy, and the day is always TODAY (never the clock).
async function scaffold(
  args,
  { today = "2026-10-16", tracker = TRACKER, env = {} } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "new-beta-voucher-"));
  tempDirs.push(dir);
  const trackerFile = join(dir, "beta-exams.json");
  await writeFile(trackerFile, JSON.stringify(tracker));
  const docs = join(dir, "docs");
  await mkdir(docs);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      DOCS_DIR: docs,
      BETA_EXAMS_FILE: trackerFile,
      TODAY: today,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("close", done));
  return {
    docs,
    code,
    stdout,
    stderr,
    page: (slug) => readFile(join(docs, "vouchers", `${slug}.mdx`), "utf8"),
    files: async () => (await readdir(docs, { recursive: true })).sort(),
  };
}

const AZ_ARGS = [
  "--code",
  "AZ-401",
  "--announcement",
  "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-microsoft-certified-agentic-devops-engineer-expert/4528356",
  "--discount-code",
  "AZ401Glendon",
  "--deadline",
  "2026-11-02",
  "--certification",
  AZ.certification,
  "--about",
  AZ.about,
  "--register-url",
  "https://learn.microsoft.com/credentials/certifications/exams/az-401",
];
const GH_ARGS = [
  "--code",
  "GH-700",
  "--announcement",
  "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-github-certified-agentic-ai-business-professional/4564532?wt.mc_id=cred_blog_gh700betaexam_wwl",
  "--discount-code",
  "GH700B8F5",
  "--deadline",
  "2026-11-02",
  "--certification",
  GH.certification,
  "--about",
  GH.about,
  "--register-url",
  "https://learn.microsoft.com/en-us/credentials/certifications/agentic-ai-business-professional/?practice-assessment-type=certification",
  "--schedule-url",
  "https://learn.microsoft.com/en-us/credentials/certifications/schedule-through-pearson-vue?examUid=exam.GH-700&examUrl=https://learn.microsoft.com/credentials/",
];

test("the script writes the reference page from the arguments of the announcement, and nothing else", async () => {
  const run = await scaffold(AZ_ARGS);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(await run.files(), [
    "vouchers",
    join("vouchers", "az401beta.mdx"),
  ]);
  assert.equal(lf(await run.page("az401beta")), fixture("az401beta.mdx"));
  // the name came from the tracker
  assert.match(
    await run.page("az401beta"),
    /Exam AZ-401: Designing and Implementing Microsoft Agentic DevOps Solutions is the new beta exam/,
  );
});

test("links get the tracking parameter and lose /en-us/, query and the tracking parameters of the post", async () => {
  const run = await scaffold(GH_ARGS);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(lf(await run.page("gh700beta")), fixture("gh700beta.mdx"));
});

test("the script reminds of the sidebar entry, the card, the tracker and the checks", async () => {
  const run = await scaffold(GH_ARGS);
  for (const needle of [
    "Created: ",
    "src/data_files/docs-sidebar.ts",
    'label: "Exam GH-700 (beta)"',
    'href: docsPath("vouchers/gh700beta")',
    'badge: { text: "*80%", variant: "tip" }',
    "src/content/docs/github/GH-700.mdx",
    '<LinkCard title="Exam GH-700 (beta)" href="/certs/vouchers/gh700beta/"',
    "on or before November 2, 2026 can get 80% off",
    "src/data_files/beta-exams.json",
    "node scripts/beta-note.mjs --code GH-700 --expects",
    "pnpm build && pnpm test:scripts",
  ]) {
    assert.ok(
      run.stdout.includes(needle),
      `the reminder lacks ${needle}\n${run.stdout}`,
    );
  }
});

test("a name on the command line wins, and without one the tracker must have it", async () => {
  const named = await scaffold([...AZ_ARGS, "--name", "Something Else"], {
    tracker: { exams: [] },
  });
  assert.equal(named.code, 0, named.stderr);
  assert.match(
    await named.page("az401beta"),
    /Exam AZ-401: Something Else is the new beta exam/,
  );

  const unnamed = await scaffold(AZ_ARGS, { tracker: { exams: [] } });
  assert.equal(unnamed.code, 1);
  assert.match(
    unnamed.stderr,
    /AZ-401 has no entry with a name in .*beta-exams\.json.*--name/,
  );
  assert.deepEqual(await unnamed.files(), []);
});

test("a page is never overwritten", async () => {
  const first = await scaffold(AZ_ARGS);
  assert.equal(first.code, 0);
  const again = await scaffold(AZ_ARGS, { env: { DOCS_DIR: first.docs } });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /File already exists: /);
});

test("every bad argument is refused with its own message, and nothing is written", async () => {
  const without = (...flags) => {
    const out = [];
    for (let i = 0; i < AZ_ARGS.length; i += 2) {
      if (!flags.includes(AZ_ARGS[i])) out.push(AZ_ARGS[i], AZ_ARGS[i + 1]);
    }
    return out;
  };
  const withValue = (flag, value) => {
    const out = [...AZ_ARGS];
    out[out.indexOf(flag) + 1] = value;
    return out;
  };
  const cases = [
    [[], /^Usage: node scripts\/new-beta-voucher\.mjs/],
    [withValue("--code", "az401"), /Invalid exam code: "AZ401"/],
    [withValue("--code", "XY-123"), /Unknown prefix "XY"/],
    [without("--deadline"), /--deadline must be a real day written YYYY-MM-DD/],
    [withValue("--deadline", "2026-02-31"), /--deadline must be a real day/],
    [
      withValue("--deadline", "2026-10-15"),
      /--deadline 2026-10-15 is before today \(2026-10-16\)/,
    ],
    [
      without("--discount-code"),
      /--discount-code must be the code of the post/,
    ],
    [
      withValue("--discount-code", "has space"),
      /--discount-code must be the code of the post/,
    ],
    [without("--certification"), /--certification is required/],
    [without("--about"), /--about is required/],
    [withValue("--about", "Uses {braces}."), /--about must not contain/],
    [without("--announcement"), /--announcement must be a full https URL/],
    [
      withValue("--announcement", "http://techcommunity.microsoft.com/x"),
      /--announcement must be an https URL on/,
    ],
    [
      withValue("--announcement", "https://example.com/post"),
      /--announcement must be an https URL on techcommunity\.microsoft\.com or learn\.microsoft\.com/,
    ],
    [without("--register-url"), /--register-url must be a full https URL/],
    [
      withValue("--register-url", "https://example.com/exam"),
      /--register-url must be an https URL on learn\.microsoft\.com/,
    ],
    [
      [
        ...AZ_ARGS,
        "--schedule-url",
        "https://learn.microsoft.com/credentials/certifications/schedule-through-pearson-vue?examUid=exam.AZ-104",
      ],
      /--schedule-url must be the Pearson VUE scheduling link of AZ-401/,
    ],
    [
      [
        ...AZ_ARGS,
        "--schedule-url",
        "https://learn.microsoft.com/credentials/certifications/exams/az-401",
      ],
      /--schedule-url must be the Pearson VUE scheduling link of AZ-401/,
    ],
  ];
  for (const [args, message] of cases) {
    const run = await scaffold(args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.stderr, message, args.join(" "));
    assert.deepEqual(
      await run.files(),
      [],
      `${args.join(" ")}: nothing may be written`,
    );
  }
});

test("the about text gets its full stop, and a quote in the certification is escaped", async () => {
  const run = await scaffold(
    AZ_ARGS.map((arg) => (arg === AZ.about ? "It validates a thing" : arg)),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    await run.page("az401beta"),
    /is the new beta exam for Microsoft Certified: Agentic DevOps Engineer Expert\. It validates a thing\.\n/,
  );
});

// ---------------------------------------------------------------------------
// The documentation
// ---------------------------------------------------------------------------
test("AGENTS.md documents the layout, the script and the guard", () => {
  const agents = read("AGENTS.md");
  const section = agents.slice(agents.indexOf("Beta voucher format"));
  for (const needle of [
    "node scripts/new-beta-voucher.mjs",
    "scripts/lib/beta-voucher.mjs",
    "tests/scripts/beta-vouchers.test.mjs",
    "mailing list",
    "LinkedIn group",
    "Study Materials",
    "More About Beta Exams",
  ]) {
    assert.ok(
      section.includes(needle),
      `the beta voucher format of AGENTS.md lacks ${needle}`,
    );
  }
});
