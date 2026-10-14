import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  availabilityDate,
  availabilityNote,
  buildIssueTitle,
  buildReport,
  classifyPracticePage,
  courseSlug,
  evaluateCourses,
  evaluatePractice,
  examPagePath,
  isLearnCredentialPage,
  loadConfig,
  longDate,
  mapCoursesToExams,
  markdownUrl,
  normalizeTracker,
  pageExamCodes,
  parseCourseCatalog,
  parseHubPage,
  parseLinkCards,
  practiceSignals,
  practiceUrlCandidates,
  retryDelayMs,
  safeText,
  scanHub,
  stableContent,
  stripComments,
  trackerContent,
} from "../../scripts/learn-content-watch.mjs";
import {
  bashSkipReason,
  findBash,
  makeScratchRemote,
  pushAttempts,
  rejectFirstPushes,
  runBash,
} from "./helpers/git-remote.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/learn-content-watch.mjs");
const FIXTURES = join(root, "tests/fixtures/learn-content-watch");
const fx = (name) => readFileSync(join(FIXTURES, name), "utf8");
const catalogFixture = () =>
  JSON.parse(readFileSync(join(FIXTURES, "catalog-courses.json"), "utf8"));
const uidFixture = () =>
  JSON.parse(readFileSync(join(FIXTURES, "catalog-uids.json"), "utf8"));

const TODAY = "2026-10-14";
const TRACKING = "?WT.mc_id=studentamb_165290";
const ZWSP = String.fromCharCode(0x200b);
// The issue is public: internal planning stays out of everything the monitor ships.
const INTERNAL_WORDS = /\b(tasks?|board|tasks\.mjs|lifecycle)\b/i;

const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hub pages (MDX written the way the exam pages are)
// ---------------------------------------------------------------------------
function mdx({
  code,
  exam,
  practice = false,
  standIns = [],
  courses = [],
  paths = [],
  modules = [],
  comment = "",
  draft = false,
}) {
  const lines = [
    "---",
    `title: "${code} Study Materials"`,
    `description: "Collection of study materials for the certification exam ${code}: Test Exam."`,
    ...(draft ? ["draft: true"] : []),
    "---",
    'import { LinkCard, CardGrid, Card, Tabs, TabItem } from "@components/docs";',
    "",
    '<Card title="Get Started" icon="star">',
    `  <LinkCard title="Exam ${code}" href="${exam}" target="_blank"/>`,
    `  <LinkCard title="Study Guide" href="https://learn.microsoft.com/credentials/certifications/resources/study-guides/${code.toLowerCase()}${TRACKING}" target="_blank"/>`,
    '<Tabs>\n  <TabItem label="Text">\n    <CardGrid>',
  ];
  for (const entry of courses) {
    // A course is its number, or { number, description } for a card that
    // states something (an availability date, say).
    const { number, description } =
      typeof entry === "string" ? { number: entry } : entry;
    lines.push(
      `      <LinkCard title="Microsoft Learn" href="https://learn.microsoft.com/training/courses/${number}${TRACKING}" target="_blank"${description ? ` description="${description}"` : ""}/>`,
    );
  }
  for (const slug of paths) {
    lines.push(
      `      <LinkCard title="Path" href="https://learn.microsoft.com/training/paths/${slug}/${TRACKING}" target="_blank"/>`,
    );
  }
  for (const slug of modules) {
    lines.push(
      `      <LinkCard title="Module" href="https://learn.microsoft.com/training/modules/${slug}/${TRACKING}" target="_blank"/>`,
    );
  }
  lines.push("    </CardGrid>", "  </TabItem>", '  <TabItem label="Tests">');
  if (practice) {
    lines.push(
      `    <LinkCard title="Microsoft Learn Practice Assessment" href="https://learn.microsoft.com/credentials/certifications/exams/${code.toLowerCase()}/practice/assessment?assessment-type=practice&assessmentId=11${TRACKING.replace("?", "&")}" target="_blank"/>`,
    );
  }
  for (const standIn of standIns) {
    lines.push(
      `    <LinkCard title="${standIn}: Microsoft Learn Practice Assessment" href="https://learn.microsoft.com/credentials/certifications/exams/${standIn.toLowerCase()}/practice/assessment?assessment-type=practice&assessmentId=67${TRACKING.replace("?", "&")}" target="_blank"/>`,
    );
  }
  if (comment) lines.push(comment);
  lines.push("  </TabItem>", "</Tabs>", "</Card>", "");
  return lines.join("\n");
}

const CERT = (slug) =>
  `https://learn.microsoft.com/credentials/certifications/${slug}${TRACKING}`;

/** Default hub of the end-to-end tests: area -> code -> mdx options. */
function defaultHub() {
  return {
    aibusiness: {
      "AB-650": {
        exam: CERT("ai-services-administrator-associate"),
        courses: ["ab-650t00"],
        paths: ["manage-secure-microsoft-365-ai-services"],
      },
    },
    azure: {
      "AI-500": { exam: CERT("exams/ai-500") },
      "AZ-802": {
        exam: CERT("windows-server-administrator-associate"),
        standIns: ["AZ-800", "AZ-801"],
        courses: ["az-802t00"],
      },
    },
    dynamics: {
      "MB-230": {
        exam: CERT("d365-functional-consultant-customer-service-v3"),
        practice: true,
        courses: ["mb-230t01"],
      },
    },
    github: { "GH-700": { exam: CERT("exams/gh-700") } },
  };
}

function writeHub(docsDir, hub) {
  for (const [area, pages] of Object.entries(hub)) {
    mkdirSync(join(docsDir, area), { recursive: true });
    for (const [code, options] of Object.entries(pages)) {
      writeFileSync(
        join(docsDir, area, `${code}.mdx`),
        mdx({ code, ...options }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// A fake Microsoft Learn
// ---------------------------------------------------------------------------
const PAGE_AB650 =
  "/en-us/credentials/certifications/ai-services-administrator-associate/";
const PAGE_AI500 = "/en-us/credentials/certifications/exams/ai-500/";
const PAGE_AZ802 =
  "/en-us/credentials/certifications/windows-server-administrator-associate/";

/** The real new-layout page with a published assessment, made another exam's. */
function publishedPage(code, id) {
  return fx("cert-newlayout-link.html")
    .replaceAll("AB-100", code)
    .replaceAll("ab-100", code.toLowerCase())
    .replaceAll("1815645847", String(id));
}

async function fakeLearn(init = {}) {
  const state = {
    catalog: init.catalog ?? catalogFixture(),
    catalogStatus: 200,
    catalogBody: null,
    lookups: new Map(),
    lookupStatus: 200,
    pages: {
      [PAGE_AB650]: { status: 200, body: fx("cert-unavailable.html") },
      [PAGE_AI500]: { status: 200, body: fx("exam-unavailable.html") },
      [PAGE_AZ802]: {
        status: 200,
        body: fx("cert-unavailable-no-exam-code.html"),
      },
    },
    routes: {}, // pathname -> { status, location? }
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
  };
  for (const item of uidFixture().learningPaths)
    state.lookups.set(item.uid, item);

  const lookup = (uid) =>
    state.lookups.get(uid) ?? {
      uid,
      type: "learningPath",
      title: `Title of ${uid.split(".").pop()}`,
      url: `https://learn.microsoft.com/en-us/training/paths/${uid.split(".").pop()}/?WT.mc_id=api_CatalogApi`,
    };

  const server = createServer((request, response) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    response.on("close", () => state.inFlight--);
    const url = new URL(request.url, "http://x");
    state.requests.push({
      path: url.pathname,
      search: url.search,
      at: Date.now(),
      agent: request.headers["user-agent"],
    });
    const send = (status, body, type = "text/html", headers = {}) => {
      response.writeHead(status, { "content-type": type, ...headers });
      response.end(body);
    };

    if (url.pathname === "/api/catalog/") {
      const uids = url.searchParams.get("uid");
      if (uids) {
        if (state.lookupStatus !== 200) return send(state.lookupStatus, "no");
        const found = uids.split(",").map(lookup);
        return send(
          200,
          JSON.stringify({
            learningPaths: found.filter((i) => i.type !== "module"),
            modules: found.filter((i) => i.type === "module"),
          }),
          "application/json",
        );
      }
      if (state.catalogStatus !== 200) return send(state.catalogStatus, "no");
      return send(
        200,
        state.catalogBody ?? JSON.stringify({ courses: state.catalog.courses }),
        "application/json",
      );
    }
    if (url.pathname.endsWith("/practice/assessment")) {
      const route = state.routes[url.pathname];
      if (!route) return send(404, "not found");
      if (route.location)
        return send(302, "", "text/html", { location: route.location });
      return send(route.status, "<html><body>practice</body></html>");
    }
    const page = state.pages[url.pathname];
    if (!page) return send(404, "not found");
    return send(page.status, page.body ?? "");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((done) => server.close(done));
  return state;
}

async function fakeAsn(status = 200) {
  const state = { requests: [], status };
  const server = createServer((request, response) => {
    state.requests.push(request.url);
    response.writeHead(state.status, { "content-type": "text/html" });
    response.end('<html><body><div id="app"></div></body></html>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((done) => server.close(done));
  return state;
}

function runScript(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function world({ hub = defaultHub(), learn, asn } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "learn-content-watch-"));
  tempDirs.push(dir);
  const docs = join(dir, "docs");
  writeHub(docs, hub);
  const files = {
    dir,
    docs,
    trackerFile: join(dir, "tracker.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "output"),
    summary: join(dir, "summary.md"),
  };
  const learnServer = learn ?? (await fakeLearn());
  const asnServer = asn ?? (await fakeAsn());
  const baseEnv = {
    LEARN_BASE_URL: learnServer.origin,
    ASN_BASE_URL: asnServer.origin,
    TRACKER_FILE: files.trackerFile,
    DOCS_DIR: docs,
    REPORT_FILE: files.report,
    ERROR_FILE: files.error,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    FETCH_DELAY_MS: "0",
    RETRY_BASE_MS: "1",
    FETCH_ATTEMPTS: "2",
    MIN_COURSES: "3",
    TODAY,
  };
  const api = {
    ...files,
    learn: learnServer,
    asn: asnServer,
    env: baseEnv,
    async run(extra = {}) {
      writeFileSync(files.output, "");
      writeFileSync(files.summary, "");
      const result = await runScript({ ...baseEnv, ...extra });
      const outputs = {};
      for (const line of readFileSync(files.output, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
      }
      result.outputs = outputs;
      result.report = existsSync(files.report)
        ? readFileSync(files.report, "utf8")
        : null;
      result.error = existsSync(files.error)
        ? readFileSync(files.error, "utf8")
        : null;
      result.summary = readFileSync(files.summary, "utf8");
      return result;
    },
    tracker: () => JSON.parse(readFileSync(files.trackerFile, "utf8")),
    async close() {
      if (!learn) await learnServer.close();
      if (!asn) await asnServer.close();
    },
  };
  return api;
}

async function withWorld(options, body) {
  const w = await world(options);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------------------
// Hub page parsing
// ---------------------------------------------------------------------------
test("parseLinkCards reads titles and hrefs even when a value holds a > sign", () => {
  const cards = parseLinkCards(
    '<LinkCard title="A > B" href="https://x.example/a?b=1&c=2" target="_blank"/>\n<LinkCard\n  title=\'Single\'\n  href="/certs/x/"\n/>',
  );
  assert.deepEqual(cards, [
    { title: "A > B", href: "https://x.example/a?b=1&c=2" },
    { title: "Single", href: "/certs/x/" },
  ]);
});

test("stripComments removes MDX and HTML comments", () => {
  assert.equal(
    stripComments("a {/* <LinkCard title='x'/> */} b <!-- <LinkCard/> --> c"),
    "a  b  c",
  );
});

test("a hub page has the practice card only for a title that starts with the canonical text", () => {
  const page = parseHubPage(
    mdx({
      code: "AB-650",
      exam: CERT("ai-services-administrator-associate"),
      standIns: ["PL-200"],
      courses: ["ab-650t00"],
      paths: ["Some-Path"],
      modules: ["a-module"],
      comment:
        '{/* <LinkCard title="Microsoft Learn Practice Assessment" href="https://x/"/> */}',
    }),
    "AB-650",
    "aibusiness",
  );
  assert.equal(
    page.hasPracticeCard,
    false,
    "a stand-in and a comment do not count",
  );
  assert.deepEqual(page.standIns, [
    "PL-200: Microsoft Learn Practice Assessment",
  ]);
  assert.equal(
    page.examPath,
    "/credentials/certifications/ai-services-administrator-associate/",
  );
  assert.ok(page.courseSlugs.has("ab-650t00"));
  assert.ok(page.pathSlugs.has("some-path"), "slugs are lowercase");
  assert.ok(page.moduleSlugs.has("a-module"));

  for (const title of [
    "Microsoft Learn Practice Assessment",
    "Microsoft Learn Practice Assessment (AI Skills Navigator)",
  ]) {
    const withCard = parseHubPage(
      `<LinkCard title="${title}" href="https://x/"/>`,
      "AB-650",
      "aibusiness",
    );
    assert.equal(withCard.hasPracticeCard, true, title);
  }
});

test("a draft page is skipped and the scan covers only the seven areas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-content-watch-scan-"));
  tempDirs.push(dir);
  writeHub(join(dir, "docs"), {
    azure: {
      "AZ-900": { exam: CERT("exams/az-900") },
      "AZ-901": { exam: CERT("exams/az-901"), draft: true },
    },
  });
  mkdirSync(join(dir, "docs", "labs"), { recursive: true });
  writeFileSync(join(dir, "docs", "azure", "readme.mdx"), "x");
  writeFileSync(
    join(dir, "docs", "labs", "AZ-777.mdx"),
    mdx({ code: "AZ-777", exam: CERT("exams/az-777") }),
  );
  const hub = scanHub({ docsDir: join(dir, "docs") });
  assert.deepEqual([...hub.keys()], ["AZ-900"]);
});

test("examPagePath picks the Exam card of the Learn certifications and ignores study guides and practice routes", () => {
  const cards = [
    {
      title: "Study Guide",
      href: "https://learn.microsoft.com/credentials/certifications/resources/study-guides/ab-650?WT.mc_id=x",
    },
    {
      title: "Exam AB-650",
      href: "https://learn.microsoft.com/credentials/certifications/ai-services-administrator-associate?WT.mc_id=x",
    },
    {
      title: "Practice",
      href: "https://learn.microsoft.com/credentials/certifications/exams/ab-650/practice/assessment?x=1",
    },
  ];
  assert.equal(
    examPagePath(cards, "AB-650"),
    "/credentials/certifications/ai-services-administrator-associate/",
  );
  assert.equal(
    examPagePath(
      [
        {
          title: "Exam AB-650",
          href: "https://learn.microsoft.com/en-us/credentials/certifications/exams/ab-650/?a=1#x",
        },
      ],
      "AB-650",
    ),
    "/credentials/certifications/exams/ab-650/",
  );
  assert.equal(
    examPagePath(
      [{ title: "Exam AB-650", href: "https://example.com/x" }],
      "AB-650",
    ),
    null,
  );
  assert.equal(examPagePath([], "AB-650"), null);
});

// ---------------------------------------------------------------------------
// Reading a Learn page (fixtures are trimmed from the real pages)
// ---------------------------------------------------------------------------
test("the classic certification page with a published assessment is a link", () => {
  const html = fx("cert-classic-link.html");
  assert.equal(isLearnCredentialPage(html), true);
  const found = classifyPracticePage(html, "AZ-104");
  assert.equal(found.state, "link");
  assert.equal(found.kind, "learn");
  assert.equal(found.assessmentId, "21");
  assert.deepEqual(found.extraIds, []);
});

test("the new-layout page names the exam its assessment belongs to", () => {
  const html = fx("cert-newlayout-link.html");
  const { ids } = practiceSignals(html);
  assert.deepEqual(ids, [
    { id: "1815645847", exam: "AB-100", source: "data attributes" },
  ]);
  const found = classifyPracticePage(html, "AB-100");
  assert.equal(found.state, "link");
  assert.equal(found.assessmentId, "1815645847");
  // The same page read for another exam does not hand over that exam's id.
  assert.notEqual(classifyPracticePage(html, "AB-200").state, "link");
});

test("the static sentence means unavailable, on a certification page, an exam page and a page that names no exam code", () => {
  assert.deepEqual(
    classifyPracticePage(fx("cert-unavailable.html"), "AB-650"),
    { state: "unavailable" },
  );
  assert.deepEqual(
    classifyPracticePage(fx("exam-unavailable.html"), "AI-500"),
    { state: "unavailable" },
  );
  const noCode = fx("cert-unavailable-no-exam-code.html");
  assert.equal(pageExamCodes(noCode).size, 0);
  assert.deepEqual(classifyPracticePage(noCode, "AZ-802"), {
    state: "unavailable",
  });
});

test("a page that says nothing about practice assessments is unknown, and a feedback widget id is not an assessment", () => {
  const html = fx("cert-no-mention.html");
  assert.match(
    html,
    /assessmentId: '42630d0d-/,
    "the real page carries the widget guid",
  );
  assert.deepEqual(classifyPracticePage(html, "AZ-120"), {
    state: "unknown",
    detail: "no-mention",
  });
});

test("an AI Skills Navigator callout is a link of its own kind", () => {
  const found = classifyPracticePage(fx("cert-asn-callout.html"), "DP-750");
  assert.equal(found.state, "link");
  assert.equal(found.kind, "asn");
  assert.equal(
    found.rawUrl,
    "https://aiskillsnavigator.microsoft.com/credentials/cert-6818382e4ae0a7b840cb7d1f87e51c0b08fe0213fdb2c309b2ba5f295625014e",
  );
});

test("a page that is not a certification or exam page, or does not list the exam, is never a link", () => {
  assert.deepEqual(
    classifyPracticePage(
      "<html><title>Just a moment...</title></html>",
      "AB-650",
    ),
    {
      state: "unknown",
      detail: "not-a-credential-page",
    },
  );
  // The sentence is there, but the page is about another exam.
  const other = fx("cert-unavailable.html")
    .replaceAll("AB-650", "AB-651")
    .replaceAll("ab-650", "ab-651");
  assert.deepEqual(classifyPracticePage(other, "AB-650"), {
    state: "unknown",
    detail: "exam-not-listed",
  });
});

test("a practice id that cannot be tied to the exam is ambiguous, not a link", () => {
  // Two exams on the page, and a metadata id that names neither.
  const html = fx("cert-classic-link.html")
    .replace('<meta name="learn_exam"', '<meta name="x"')
    .replace(
      "</head>",
      '<meta name="learn_exam" content="exam.az-104" /><meta name="learn_exam" content="exam.az-105" /></head>',
    );
  assert.deepEqual(classifyPracticePage(html, "AZ-104"), {
    state: "unknown",
    detail: "ambiguous",
  });
  // An id that names the exam wins even on a page with several exams.
  const mine = html.replace(
    "</body>",
    '<a data-practice-assessment-link="" data-practice-assessment-link-exam-uid="exam.az-104" data-practice-assessment-link-assessment-uid="77">x</a></body>',
  );
  const found = classifyPracticePage(mine, "AZ-104");
  assert.equal(found.state, "link");
  assert.equal(found.assessmentId, "77");
});

test("only digits make an assessment id", () => {
  const html = fx("cert-newlayout-link.html").replace(
    'assessment-uid="1815645847"',
    'assessment-uid="12ab"',
  );
  assert.deepEqual(practiceSignals(html).ids, []);
});

test("practice addresses follow the page the id was found on and keep the repo's URL rules", () => {
  // A certification route carries practice-assessment-type=certification; the
  // exam route (the canonical form of AGENTS.md > URL Formats) does not.
  assert.deepEqual(
    practiceUrlCandidates({
      code: "AB-650",
      kind: "learn",
      assessmentId: "4242",
      pagePath:
        "/credentials/certifications/ai-services-administrator-associate/",
    }),
    [
      `https://learn.microsoft.com/credentials/certifications/ai-services-administrator-associate/practice/assessment?assessment-type=practice&assessmentId=4242&practice-assessment-type=certification&WT.mc_id=studentamb_165290`,
      `https://learn.microsoft.com/credentials/certifications/exams/ab-650/practice/assessment?assessment-type=practice&assessmentId=4242&WT.mc_id=studentamb_165290`,
    ],
  );
  // An exam page: the page's own route is the exam route, listed once and
  // without the certification parameter (the card to paste for AI-500, AZ-401).
  assert.deepEqual(
    practiceUrlCandidates({
      code: "AI-500",
      kind: "learn",
      assessmentId: "9",
      pagePath: "/credentials/certifications/exams/ai-500/",
    }),
    [
      "https://learn.microsoft.com/credentials/certifications/exams/ai-500/practice/assessment?assessment-type=practice&assessmentId=9&WT.mc_id=studentamb_165290",
    ],
  );
  // No page of its own (or one outside the certifications): the exam route only.
  for (const pagePath of [undefined, null, "", "/training/paths/x/"]) {
    assert.deepEqual(
      practiceUrlCandidates({
        code: "AZ-401",
        kind: "learn",
        assessmentId: "7",
        pagePath,
      }),
      [
        "https://learn.microsoft.com/credentials/certifications/exams/az-401/practice/assessment?assessment-type=practice&assessmentId=7&WT.mc_id=studentamb_165290",
      ],
      String(pagePath),
    );
  }
  assert.deepEqual(
    practiceUrlCandidates({
      code: "X",
      kind: "asn",
      rawUrl: "https://aiskillsnavigator.microsoft.com/credentials/cert-1",
    }),
    ["https://aiskillsnavigator.microsoft.com/credentials/cert-1"],
  );
  for (const url of practiceUrlCandidates({
    code: "AB-650",
    kind: "learn",
    assessmentId: "1",
    pagePath: "/credentials/certifications/x/",
  })) {
    assert.doesNotMatch(url, /\/en-us\//, "no locale segment");
    assert.match(url, /&WT\.mc_id=studentamb_165290$/);
  }
});

// ---------------------------------------------------------------------------
// Practice assessment states and transitions
// ---------------------------------------------------------------------------
const obs = (state, extra = {}) => ({
  state,
  routeLive: false,
  pageUrl: "https://learn.microsoft.com/credentials/certifications/x/",
  ...extra,
});
const LINK_OBS = obs("link", {
  kind: "learn",
  assessmentId: "4242",
  url: "https://learn.microsoft.com/credentials/certifications/x/practice/assessment?assessment-type=practice&assessmentId=4242&practice-assessment-type=certification&WT.mc_id=studentamb_165290",
  extraIds: [],
});

function step(previous, observation, today = TODAY, failureDays = 5) {
  return evaluatePractice({
    code: "AB-650",
    previous,
    observation,
    today,
    failureDays,
  });
}

test("a first sight of an unavailable assessment is recorded without an alert", () => {
  const { record, alert } = step(undefined, obs("unavailable"));
  assert.equal(alert, null);
  assert.equal(record.state, "unavailable");
  assert.equal(record.firstSeen, TODAY);
});

test("unavailable or unknown becoming a link is the alert, with the exact address", () => {
  for (const before of [
    obs("unavailable"),
    obs("unknown", { detail: "no-mention" }),
  ]) {
    const first = step(undefined, before).record;
    const { record, alert } = step(first, LINK_OBS, "2026-10-15");
    assert.equal(alert.kind, "available");
    assert.equal(alert.url, LINK_OBS.url);
    assert.equal(alert.assessmentId, "4242");
    assert.equal(record.state, "link");
    assert.equal(record.lastChanged, "2026-10-15");
  }
  // A first sight that is already a link is reported too (actionable state).
  assert.equal(step(undefined, LINK_OBS).alert.kind, "available");
});

test("a link that stays the same is quiet and keeps its last change date", () => {
  const first = step(undefined, LINK_OBS, "2026-10-14").record;
  const again = step(first, LINK_OBS, "2026-10-20");
  assert.equal(again.alert, null);
  assert.equal(again.record.lastChanged, "2026-10-14");
  assert.equal(again.record.firstSeen, "2026-10-14");
});

test("a sentence that disappears without a link, a link that disappears and a link that changes need a look by hand", () => {
  const unavailable = step(undefined, obs("unavailable")).record;
  const gone = step(unavailable, obs("unknown", { detail: "no-mention" }));
  assert.equal(gone.alert.kind, "changed");
  assert.match(
    gone.alert.reasons[0],
    /is gone, but no practice assessment link took its place/,
  );

  const link = step(undefined, LINK_OBS).record;
  const withdrawn = step(link, obs("unavailable"));
  assert.equal(withdrawn.alert.kind, "changed");
  assert.match(
    withdrawn.alert.reasons[0],
    /used to offer a practice assessment and no longer does/,
  );

  const moved = step(link, {
    ...LINK_OBS,
    assessmentId: "9999",
    url: LINK_OBS.url.replace("4242", "9999"),
  });
  assert.equal(moved.alert.kind, "changed");
  assert.match(moved.alert.reasons[0], /address on the Learn page changed/);
});

test("unknown becoming unavailable is not news", () => {
  const unknown = step(
    undefined,
    obs("unknown", { detail: "no-mention" }),
  ).record;
  assert.equal(step(unknown, obs("unavailable")).alert, null);
});

test("a link that does not resolve and an ambiguous page are reported once", () => {
  const unavailable = step(undefined, obs("unavailable")).record;
  const broken = obs("unknown", {
    detail: "link-not-resolving",
    kind: "learn",
    candidateUrl: LINK_OBS.url,
  });
  const first = step(unavailable, broken);
  assert.equal(first.alert.kind, "changed");
  assert.match(first.alert.reasons.join(" "), /does not resolve/);
  assert.equal(first.alert.candidateUrl, LINK_OBS.url);
  assert.equal(
    step(first.record, broken).alert,
    null,
    "the same state is not reported twice",
  );

  const ambiguous = obs("unknown", { detail: "ambiguous" });
  const amb = step(unavailable, ambiguous);
  assert.match(amb.alert.reasons.join(" "), /does not say which exam/);
  assert.equal(step(amb.record, ambiguous).alert, null);
});

test("the practice route answering 200 is an early signal, reported when it turns on", () => {
  const unavailable = step(undefined, obs("unavailable")).record;
  const live = step(unavailable, obs("unavailable", { routeLive: true }));
  assert.equal(live.alert.kind, "changed");
  assert.match(live.alert.reasons[0], /answers HTTP 200/);
  assert.equal(live.record.routeLive, true);
  assert.equal(
    step(live.record, obs("unavailable", { routeLive: true })).alert,
    null,
  );
  // No answer from the probe keeps what was known.
  const unprobed = step(live.record, obs("unavailable", { routeLive: null }));
  assert.equal(unprobed.record.routeLive, true);
  assert.equal(unprobed.alert, null);
  // When the page shows the link, "available" is the alert, not the route.
  assert.equal(
    step(unavailable, { ...LINK_OBS, routeLive: true }).alert.kind,
    "available",
  );
});

test("a page that cannot be read keeps the previous state, and a first failure leaves a placeholder", () => {
  const unavailable = step(undefined, obs("unavailable")).record;
  const failed = step(unavailable, {
    failed: true,
    reason: "status 500",
    pageUrl: "u",
  });
  assert.equal(failed.alert, null);
  assert.equal(failed.carried, "status 500");
  assert.equal(failed.record.state, "unavailable");
  assert.equal(failed.record.failedSince, TODAY);

  const first = step(undefined, {
    failed: true,
    reason: "network error",
    pageUrl: "u",
  });
  assert.equal(first.alert, null);
  assert.equal(first.record.state, "unknown");
  assert.equal(first.record.detail, "unreadable");
  // The first good read after a placeholder is a normal first sight.
  assert.equal(step(first.record, obs("unavailable")).alert, null);
  assert.equal(step(first.record, LINK_OBS).alert.kind, "available");
});

test("a page that stays unreadable is reported once after FAILURE_DAYS days and recovers silently", () => {
  const failed = { failed: true, reason: "status 403", pageUrl: "u" };
  let record = step(undefined, obs("unavailable")).record;
  const alerts = [];
  for (const day of [
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
  ]) {
    const result = step(record, failed, day, 5);
    record = result.record;
    alerts.push(result.alert);
  }
  assert.deepEqual(
    alerts.map(Boolean),
    [false, false, false, false, true, false, false],
    "once, on the fifth failing day in a row",
  );
  assert.match(
    alerts[4].reasons[0],
    /could not be read for 5 days in a row \(status 403\)/,
  );
  assert.equal(record.failedSince, "2026-10-14");
  assert.equal(record.failureReported, "2026-10-18");

  // Two runs on the same day count as one day.
  const start = step(
    step(undefined, obs("unavailable")).record,
    failed,
    TODAY,
    2,
  );
  const same = step(start.record, failed, TODAY, 2);
  assert.equal(same.alert, null, "the same day twice is still one day");
  assert.equal(
    step(same.record, failed, "2026-10-15", 2).alert.kind,
    "changed",
  );

  // A good read clears the failure marks.
  const healthy = step(record, obs("unavailable"), "2026-10-21");
  assert.equal(healthy.alert, null);
  assert.equal(healthy.record.failedSince, undefined);
  assert.equal(healthy.record.failureReported, undefined);
});

test("an exam that has no Learn page yet is a state, an exam whose page disappeared is a failure", () => {
  const missing = {
    failed: true,
    status: 404,
    reason: "status 404",
    pageUrl: "u",
  };
  const none = step(undefined, missing);
  assert.equal(none.record.state, "unknown");
  assert.equal(none.record.detail, "no-learn-page");
  assert.equal(none.carried, undefined);
  // Still missing next day: still a state, no alert.
  assert.equal(step(none.record, missing).alert, null);
  // A page that existed and now answers 404 is carried like any failure.
  const existed = step(undefined, obs("unavailable")).record;
  const lost = step(existed, missing);
  assert.equal(lost.record.state, "unavailable");
  assert.equal(lost.carried, "status 404");
  // The page appears with the sentence: no alert, with the link: an alert.
  assert.equal(step(none.record, obs("unavailable")).alert, null);
  assert.equal(step(none.record, LINK_OBS).alert.kind, "available");
});

// ---------------------------------------------------------------------------
// The course catalog
// ---------------------------------------------------------------------------
test("the real catalog sample is understood: numbers, exam fields, availability notes", () => {
  const courses = parseCourseCatalog(catalogFixture(), 3);
  assert.equal(courses.length, 8);
  const ab650 = courses.find((c) => c.number === "AB-650T00");
  assert.equal(ab650.exam, null);
  assert.equal(ab650.studyGuide.length, 3);
  assert.equal(
    availabilityNote(ab650.summary),
    "the catalog says it will be available on 10/30/2026",
  );
  assert.equal(availabilityNote("<p>nothing</p>"), "");
  assert.equal(courses.find((c) => c.number === "AI-500T00").exam, "AI-500");
  assert.equal(
    courses.find((c) => c.number === "MSLEAIBOOTCAMPFUN").studyGuide.length,
    0,
    "an empty list is kept as an empty list",
  );
  assert.deepEqual(
    courses.find((c) => c.number === "AB-400T00").studyGuide,
    [],
  );
  const sample = catalogFixture();
  delete sample.courses[0].study_guide;
  assert.equal(
    parseCourseCatalog(sample, 3).find((c) => c.number === "AB-650T00")
      .studyGuide,
    null,
    "an absent field is not an empty list",
  );
});

test("the catalog is mapped to hub exams by course number (T00, T01, variants) and by the exam field", () => {
  const hubCodes = new Set(["AB-650", "AI-500", "AZ-802", "MB-230", "AZ-104"]);
  const course = (number, extra = {}) => ({
    uid: `course.${number.toLowerCase()}`,
    number,
    title: number,
    exam: null,
    summary: "",
    studyGuide: [],
    ...extra,
  });
  const map = mapCoursesToExams(
    [
      course("AB-650T00"),
      course("MB-230T01"),
      course("AZ-104T00-A"),
      course("AZ-104T00-B"),
      course("AI-500T00", { exam: "AI-500" }),
      course("SC-5008", { exam: "AZ-802" }),
      course("AB-400T00"),
      course("AZ-1T00"),
      course("AB-650T00 <b>x</b>", { exam: "AB-650" }),
      course("MSLEAIBOOTCAMPFUN"),
    ],
    hubCodes,
  );
  assert.deepEqual(
    [...map.keys()],
    ["AB-650", "AI-500", "AZ-104", "AZ-802", "MB-230"],
  );
  assert.deepEqual(
    map.get("AZ-104").map((c) => c.number),
    ["AZ-104T00-A", "AZ-104T00-B"],
  );
  assert.deepEqual(
    map.get("AI-500").map((c) => c.number),
    ["AI-500T00"],
    "number and exam field give one course once",
  );
  assert.deepEqual(
    map.get("AB-650").map((c) => c.number),
    ["AB-650T00"],
    "a number with markup maps to nothing",
  );
  assert.deepEqual(
    map.get("AZ-802").map((c) => c.number),
    ["SC-5008"],
    "the exam field maps a course with another number",
  );
});

test("a catalog that looks different is a failure, never an empty list", () => {
  const sample = catalogFixture();
  assert.throws(() => parseCourseCatalog(null, 3), /no `courses` list/);
  assert.throws(
    () => parseCourseCatalog({ courses: "x" }, 3),
    /no `courses` list/,
  );
  assert.throws(
    () => parseCourseCatalog({ courses: sample.courses.slice(0, 2) }, 3),
    /only 2 courses \(expected at least 3\)/,
  );
  assert.throws(
    () =>
      parseCourseCatalog(
        { courses: sample.courses.map((c) => ({ ...c, uid: undefined })) },
        3,
      ),
    /have a uid and a title/,
  );
  assert.throws(
    () =>
      parseCourseCatalog(
        { courses: sample.courses.map(({ study_guide, ...rest }) => rest) },
        3,
      ),
    /carry a study_guide list/,
  );
  // A course twice counts once; entries that are not objects are ignored.
  const doubled = parseCourseCatalog(
    { courses: [...sample.courses, sample.courses[0], null, 4] },
    3,
  );
  assert.equal(doubled.length, 8);
});

// ---------------------------------------------------------------------------
// Course evaluation
// ---------------------------------------------------------------------------
function hubOf(options) {
  return new Map(
    Object.entries(options).map(([code, o]) => [
      code,
      parseHubPage(
        mdx({ code, exam: CERT(`exams/${code.toLowerCase()}`), ...o }),
        code,
        "azure",
      ),
    ]),
  );
}
const course = (number, paths, extra = {}) => ({
  uid: `course.${number.toLowerCase()}`,
  number,
  title: `${number} title`,
  exam: null,
  summary: "",
  studyGuide: paths.map((uid) => ({
    uid,
    type: uid.startsWith("mod.") ? "module" : "learningPath",
  })),
  ...extra,
});
const mapOf = (...entries) =>
  new Map(entries.map(([code, list]) => [code, list]));

test("a course the exam page does not link is reported once, on a first run too", () => {
  const hub = hubOf({ "AB-650": {} });
  const courseMap = mapOf([
    "AB-650",
    [
      course("AB-650T00", ["lp.a", "lp.b"], {
        summary: "<p>This course will be available on 10/30/2026.</p>",
      }),
    ],
  ]);
  const first = evaluateCourses({ previous: [], courseMap, hub, today: TODAY });
  assert.equal(first.unlinked.length, 1);
  assert.deepEqual(
    { ...first.unlinked[0], note: undefined },
    {
      code: "AB-650",
      number: "AB-650T00",
      slug: "ab-650t00",
      title: "AB-650T00 title",
      reason: "new-course",
      note: undefined,
      pagePath: "src/content/docs/azure/AB-650.mdx",
    },
  );
  assert.match(first.unlinked[0].note, /available on 10\/30\/2026/);
  assert.equal(first.records[0].unlinkedReported, TODAY);
  assert.equal(first.records[0].paths.length, 2);

  // The next day it is not reported again.
  const second = evaluateCourses({
    previous: first.records,
    courseMap,
    hub,
    today: "2026-10-15",
  });
  assert.equal(second.unlinked.length, 0);
  assert.equal(
    second.records[0].unlinkedReported,
    TODAY,
    "the date of the report is kept",
  );

  // Linked: no alert and the mark is dropped; when the link is removed later it is reported again.
  const linkedHub = hubOf({ "AB-650": { courses: ["ab-650t00"] } });
  const linked = evaluateCourses({
    previous: second.records,
    courseMap,
    hub: linkedHub,
    today: "2026-10-16",
  });
  assert.equal(linked.unlinked.length, 0);
  assert.equal(linked.records[0].unlinkedReported, undefined);
  const removedLink = evaluateCourses({
    previous: linked.records,
    courseMap,
    hub,
    today: "2026-10-17",
  });
  assert.equal(removedLink.unlinked.length, 1);
  assert.equal(removedLink.unlinked[0].reason, "not-linked");
});

test("the course slug is the end of the catalog address, not always the lower-cased number", () => {
  const courses = parseCourseCatalog(catalogFixture(), 3);
  assert.deepEqual(
    Object.fromEntries(courses.map((c) => [c.number, courseSlug(c)])),
    {
      "AB-650T00": "ab-650t00",
      "AI-500T00": "ai-500t00",
      "AZ-802T00": "az-802t00",
      "MB-230T01": "mb-230t01",
      "AB-400T00": "ab-400t00",
      "SC-5008": "sc-5008",
      // the number in lower case would be msleaibootcampfun
      MSLEAIBOOTCAMPFUN: "msle-ai-bootcamp-fun",
      // Learn serves a course whose number has a suffix at an address without it
      "AZ-104T00-A": "az-104t00",
    },
  );
  assert.equal(
    courses.find((c) => c.number === "AZ-104T00-A").url,
    "https://learn.microsoft.com/en-us/training/courses/az-104t00/?WT.mc_id=api_CatalogApi",
  );

  // Without a usable address the uid says (course.<slug>), then the number.
  const uid = "course.az-104t00";
  assert.equal(courseSlug({ uid, number: "AZ-104T00-A" }), "az-104t00");
  assert.equal(
    courseSlug({ url: "", uid, number: "AZ-104T00-A" }),
    "az-104t00",
  );
  assert.equal(
    courseSlug({
      url: "not an address",
      uid: "lp.other",
      number: "AZ-104T00-A",
    }),
    "az-104t00-a",
  );
  assert.equal(courseSlug({ number: "AB-650T00" }), "ab-650t00");
  assert.equal(courseSlug({}), "");
  assert.equal(courseSlug(), "");
  // An address that is not a course page, or whose end is not a plain slug
  // (it ends up in a link), is not used either.
  for (const url of [
    "https://learn.microsoft.com/en-us/training/paths/some-path/",
    "https://learn.microsoft.com/en-us/training/courses/",
    "https://learn.microsoft.com/en-us/training/courses/a%20b/",
    "https://learn.microsoft.com/en-us/training/courses/x/more/",
    "https://learn.microsoft.com/en-us/training/courses/<b>x</b>/",
  ]) {
    assert.equal(
      courseSlug({ url, uid: "course.fallback-slug", number: "ZZ-1" }),
      "fallback-slug",
      url,
    );
  }
  // The address is compared in lower case, like the links of the hub pages.
  assert.equal(
    courseSlug({
      url: "https://learn.microsoft.com/training/courses/AZ-104T00?wt.mc_id=x",
    }),
    "az-104t00",
  );
});

test("a linked course on a first run is recorded silently", () => {
  const hub = hubOf({ "AB-650": { courses: ["AB-650T00"] } });
  const courseMap = mapOf(["AB-650", [course("AB-650T00", ["lp.a"])]]);
  const result = evaluateCourses({
    previous: [],
    courseMap,
    hub,
    today: TODAY,
  });
  assert.deepEqual(
    [result.unlinked, result.pathChanges, result.removed],
    [[], [], []],
  );
  assert.equal(result.records.length, 1);
});

test("a course whose address has no suffix is linked, reported and tracked by that address", () => {
  // AZ-104T00-A: Learn serves it at /training/courses/az-104t00.
  const suffixed = parseCourseCatalog(catalogFixture(), 3).find(
    (c) => c.number === "AZ-104T00-A",
  );
  const courseMap = mapOf(["AZ-104", [suffixed]]);
  const evaluate = (hub, previous = [], overrides = {}, today = TODAY) =>
    evaluateCourses({
      previous,
      courseMap: overrides.courseMap ?? courseMap,
      hub,
      today,
    });

  // The page links the address Learn serves: linked, nothing to report. (The
  // number in lower case, az-104t00-a, is not what it links.)
  const linkedHub = hubOf({ "AZ-104": { courses: ["az-104t00"] } });
  const linked = evaluate(linkedHub);
  assert.deepEqual(linked.unlinked, []);
  assert.equal(linked.records[0].unlinkedReported, undefined);
  assert.equal(linked.records[0].number, "AZ-104T00-A");
  assert.equal(linked.records[0].uid, "course.az-104t00");

  // A page without it: reported once, with the address that works.
  const bareHub = hubOf({ "AZ-104": {} });
  const reported = evaluate(bareHub);
  assert.equal(reported.unlinked.length, 1);
  assert.equal(reported.unlinked[0].number, "AZ-104T00-A");
  assert.equal(reported.unlinked[0].slug, "az-104t00");
  assert.deepEqual(evaluate(bareHub, reported.records).unlinked, []);
  const report = buildReport({
    alerts: {
      practice: [],
      unlinked: reported.unlinked,
      pathChanges: [],
      removed: [],
    },
    hub: bareHub,
    today: TODAY,
    baseline: false,
  });
  assert.match(
    report,
    /\[AZ-104T00-A\]\(https:\/\/learn\.microsoft\.com\/training\/courses\/az-104t00\?WT\.mc_id=studentamb_165290\)/,
  );
  assert.doesNotMatch(report, /courses\/az-104t00-a/);

  // A page that links the number with the suffix links a dead address: it is
  // not a link to the course (it used to be the only form that counted).
  const deadHub = hubOf({ "AZ-104": { courses: ["az-104t00-a"] } });
  assert.equal(evaluate(deadHub).unlinked.length, 1);

  // The other alerts of the course link the same address.
  const paths = evaluate(linkedHub, linked.records, {
    courseMap: mapOf([
      "AZ-104",
      [{ ...suffixed, studyGuide: [{ uid: "lp.new", type: "learningPath" }] }],
    ]),
  });
  assert.equal(paths.pathChanges[0].slug, "az-104t00");
  const dated = (summary) => mapOf(["AZ-104", [{ ...suffixed, summary }]]);
  const first = evaluate(linkedHub, [], { courseMap: dated("<p>x</p>") });
  const moved = evaluate(
    linkedHub,
    first.records,
    { courseMap: dated("<p>This course will be available on 11/15/2026.</p>") },
    "2026-10-15",
  );
  assert.equal(moved.availability[0].slug, "az-104t00");
  // A course that left the catalog is known by its uid only.
  const gone = evaluate(linkedHub, linked.records, { courseMap: new Map() });
  const removed = evaluate(
    linkedHub,
    gone.records,
    { courseMap: new Map() },
    "2026-10-15",
  );
  assert.equal(removed.removed[0].number, "AZ-104T00-A");
  assert.equal(removed.removed[0].slug, "az-104t00");
});

test("added and removed learning paths are reported with titles, the hub link state and the other courses that list them", () => {
  const hub = hubOf({
    "AB-650": {
      courses: ["ab-650t00"],
      paths: ["new-path-slug"],
      modules: ["a-module-slug"],
    },
    "AB-651": { courses: ["ab-651t00"] },
  });
  const previous = [
    {
      code: "AB-650",
      number: "AB-650T00",
      uid: "course.ab-650t00",
      title: "AB-650T00 title",
      paths: [
        { uid: "lp.a", type: "learningPath", title: "Path A" },
        { uid: "lp.old", type: "learningPath", title: "Old path" },
      ],
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-13",
    },
    {
      code: "AB-651",
      number: "AB-651T00",
      uid: "course.ab-651t00",
      title: "AB-651T00 title",
      paths: [{ uid: "lp.shared", type: "learningPath", title: "Shared" }],
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-13",
    },
  ];
  const courseMap = mapOf(
    ["AB-650", [course("AB-650T00", ["lp.a", "lp.new", "lp.shared", "mod.m"])]],
    ["AB-651", [course("AB-651T00", ["lp.shared"])]],
  );
  const titles = new Map([
    [
      "lp.new",
      {
        title: "New path",
        url: "https://learn.microsoft.com/training/paths/new-path-slug/?WT.mc_id=studentamb_165290",
        slug: "new-path-slug",
      },
    ],
    ["lp.shared", { title: "Shared", url: "", slug: "shared-slug" }],
    ["mod.m", { title: "A module", url: "", slug: "a-module-slug" }],
  ]);
  const first = evaluateCourses({ previous, courseMap, hub, today: TODAY });
  assert.deepEqual([...first.needTitles].sort(), [
    "lp.new",
    "lp.shared",
    "mod.m",
  ]);
  const result = evaluateCourses({
    previous,
    courseMap,
    hub,
    today: TODAY,
    titles,
  });
  assert.equal(result.pathChanges.length, 1);
  const change = result.pathChanges[0];
  assert.equal(change.number, "AB-650T00");
  assert.deepEqual(
    change.added.map(({ uid, type, title, linked, alsoIn }) => ({
      uid,
      type,
      title,
      linked,
      alsoIn,
    })),
    [
      {
        uid: "lp.new",
        type: "learningPath",
        title: "New path",
        linked: true,
        alsoIn: [],
      },
      {
        uid: "lp.shared",
        type: "learningPath",
        title: "Shared",
        linked: false,
        alsoIn: ["AB-651T00"],
      },
      {
        uid: "mod.m",
        type: "module",
        title: "A module",
        linked: true,
        alsoIn: [],
      },
    ],
  );
  assert.deepEqual(change.removed, [
    { uid: "lp.old", type: "learningPath", title: "Old path" },
  ]);
  const record = result.records.find((r) => r.number === "AB-650T00");
  assert.equal(record.lastChanged, TODAY);
  assert.deepEqual(
    record.paths.map((p) => p.uid),
    ["lp.a", "lp.new", "lp.shared", "mod.m"].sort(),
  );
  // AB-651 did not change: no alert, and its last change date stays unset.
  assert.equal(
    result.records.find((r) => r.number === "AB-651T00").lastChanged,
    undefined,
  );
});

test("a renamed course or a moved last_modified is not an alert, and the order of the catalog does not matter", () => {
  const hub = hubOf({ "AB-650": { courses: ["ab-650t00"] } });
  const previous = [
    {
      code: "AB-650",
      number: "AB-650T00",
      uid: "course.ab-650t00",
      title: "Old title",
      paths: [
        { uid: "lp.a", type: "learningPath", title: "A" },
        { uid: "lp.b", type: "learningPath", title: "B" },
      ],
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-13",
    },
  ];
  const courseMap = mapOf([
    "AB-650",
    [course("AB-650T00", ["lp.b", "lp.a"], { title: "New title" })],
  ]);
  const result = evaluateCourses({ previous, courseMap, hub, today: TODAY });
  assert.deepEqual(
    [result.unlinked, result.pathChanges, result.removed],
    [[], [], []],
  );
  assert.equal(result.records[0].title, "New title");
});

test("a course that disappears is reported only when it is still missing on a later day", () => {
  const hub = hubOf({ "AB-650": { courses: ["ab-650t00"] } });
  const base = {
    code: "AB-650",
    number: "AB-650T00",
    uid: "course.ab-650t00",
    title: "T",
    paths: [],
    firstSeen: "2026-10-01",
    lastSeen: "2026-10-13",
  };
  const empty = new Map();
  const day1 = evaluateCourses({
    previous: [base],
    courseMap: empty,
    hub,
    today: "2026-10-14",
  });
  assert.deepEqual(day1.removed, []);
  assert.equal(day1.records[0].missingSince, "2026-10-14");
  assert.match(day1.warnings[0], /not in the catalog today/);
  // Same day again: still not reported.
  const sameDay = evaluateCourses({
    previous: day1.records,
    courseMap: empty,
    hub,
    today: "2026-10-14",
  });
  assert.deepEqual(sameDay.removed, []);
  const day2 = evaluateCourses({
    previous: day1.records,
    courseMap: empty,
    hub,
    today: "2026-10-15",
  });
  assert.equal(day2.removed.length, 1);
  assert.deepEqual(day2.removed[0], {
    code: "AB-650",
    number: "AB-650T00",
    slug: "ab-650t00",
    title: "T",
    missingSince: "2026-10-14",
  });
  assert.equal(day2.records[0].removedAt, "2026-10-15");
  const day3 = evaluateCourses({
    previous: day2.records,
    courseMap: empty,
    hub,
    today: "2026-10-16",
  });
  assert.deepEqual(day3.removed, [], "reported once");
  // It comes back: silently tracked again, the marks are gone.
  const back = evaluateCourses({
    previous: day2.records,
    courseMap: mapOf(["AB-650", [course("AB-650T00", [])]]),
    hub,
    today: "2026-10-17",
  });
  assert.deepEqual([back.removed, back.unlinked], [[], []]);
  assert.equal(back.records[0].removedAt, undefined);
  assert.equal(back.records[0].missingSince, undefined);
  // A single odd response (back on the next day) never counts.
  const blip = evaluateCourses({
    previous: day1.records,
    courseMap: mapOf(["AB-650", [course("AB-650T00", [])]]),
    hub,
    today: "2026-10-15",
  });
  assert.deepEqual(blip.removed, []);
  assert.equal(blip.records[0].missingSince, undefined);
  // When the exam page is gone the course is forgotten.
  const forgotten = evaluateCourses({
    previous: [base],
    courseMap: empty,
    hub: new Map(),
    today: TODAY,
  });
  assert.deepEqual(forgotten.records, []);
});

test("a catalog entry without a study_guide list keeps the learning paths that were known", () => {
  const hub = hubOf({ "AB-650": { courses: ["ab-650t00"] } });
  const previous = [
    {
      code: "AB-650",
      number: "AB-650T00",
      uid: "course.ab-650t00",
      title: "T",
      paths: [{ uid: "lp.a", type: "learningPath", title: "A" }],
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-13",
    },
  ];
  const courseMap = mapOf([
    "AB-650",
    [course("AB-650T00", [], { studyGuide: null })],
  ]);
  const result = evaluateCourses({ previous, courseMap, hub, today: TODAY });
  assert.deepEqual(result.pathChanges, []);
  assert.deepEqual(
    result.records[0].paths.map((p) => p.uid),
    ["lp.a"],
  );
  assert.match(result.warnings[0], /no study_guide list/);
  // An empty list is real: every path was removed.
  const emptied = evaluateCourses({
    previous,
    courseMap: mapOf(["AB-650", [course("AB-650T00", [])]]),
    hub,
    today: TODAY,
  });
  assert.equal(emptied.pathChanges[0].removed.length, 1);
});

test("an announced availability date is read from the catalog summary and written the way the hub writes dates", () => {
  assert.equal(
    availabilityDate(
      '<div class="IMPORTANT"><p>**This course will be available on 10/30/2026.</p></div>',
    ),
    "2026-10-30",
  );
  assert.equal(availabilityDate("Will be available on 1/5/2027"), "2027-01-05");
  assert.equal(availabilityDate("<p>No date here.</p>"), "");
  assert.equal(availabilityDate(undefined), "");
  assert.equal(
    availabilityDate("available on 13/45/2026"),
    "",
    "a day that does not exist is not a date",
  );
  assert.equal(availabilityDate("available on 2/30/2026"), "");
  assert.equal(longDate("2026-10-30"), "October 30, 2026");
  assert.equal(longDate("2027-01-05"), "January 5, 2027");
  assert.equal(longDate("soon"), "");
});

test("a moved, withdrawn or newly announced availability date is reported, an unchanged or unreadable one is not", () => {
  const dated = (date) =>
    `<div class="IMPORTANT"><p>This course will be available on ${date}.</p></div><p>Text</p>`;
  const hub = hubOf({
    "AB-650": {
      courses: [
        {
          number: "ab-650t00",
          description: "Becomes available October 30, 2026.",
        },
      ],
    },
  });
  const run = (previous, summary) =>
    evaluateCourses({
      previous,
      courseMap: mapOf(["AB-650", [course("AB-650T00", [], { summary })]]),
      hub,
      today: TODAY,
    });

  // First sight: the date is recorded, nothing to report about it.
  const first = run([], dated("10/30/2026"));
  assert.deepEqual(first.availability, []);
  assert.equal(first.records[0].availableOn, "2026-10-30");

  // Unchanged text: quiet.
  assert.deepEqual(run(first.records, dated("10/30/2026")).availability, []);

  // The date moves: reported, and the page is known to state the old one.
  const moved = run(first.records, dated("11/15/2026"));
  assert.deepEqual(moved.availability, [
    {
      code: "AB-650",
      number: "AB-650T00",
      slug: "ab-650t00",
      title: "AB-650T00 title",
      from: "2026-10-30",
      to: "2026-11-15",
      pagePath: "src/content/docs/azure/AB-650.mdx",
      statesOld: true,
      statesNew: false,
    },
  ]);
  assert.equal(moved.records[0].availableOn, "2026-11-15");
  assert.equal(moved.records[0].lastChanged, TODAY);

  // The date is withdrawn (the course is available now): reported once.
  const withdrawn = run(first.records, "<p>Plain summary.</p>");
  assert.equal(withdrawn.availability.length, 1);
  assert.equal(withdrawn.availability[0].to, "");
  assert.equal(withdrawn.availability[0].statesNew, null);
  assert.equal(withdrawn.records[0].availableOn, undefined);
  assert.deepEqual(
    run(withdrawn.records, "<p>Plain summary.</p>").availability,
    [],
  );

  // A date appearing on a course that had none is reported too.
  const announced = run(withdrawn.records, dated("12/01/2026"));
  assert.equal(announced.availability[0].from, "");
  assert.equal(announced.availability[0].to, "2026-12-01");
  assert.equal(announced.availability[0].statesOld, null);

  // A catalog entry without any summary text is no data: the date stays.
  const empty = run(first.records, "");
  assert.deepEqual(empty.availability, []);
  assert.equal(empty.records[0].availableOn, "2026-10-30");
});

// ---------------------------------------------------------------------------
// Tracker, titles, report
// ---------------------------------------------------------------------------
test("the tracker comparison ignores the keys' order and the fields that move every run", () => {
  const a = {
    lastSynced: "2026-10-01",
    practiceAssessments: [
      {
        routeLive: null,
        code: "A",
        state: "unknown",
        lastChecked: "2026-10-01",
      },
    ],
    courses: [{ code: "B", lastSeen: "2026-10-01", paths: [] }],
  };
  const b = {
    courses: [{ paths: [], lastSeen: "2026-10-09", code: "B" }],
    practiceAssessments: [
      {
        code: "A",
        lastChecked: "2026-10-09",
        state: "unknown",
        routeLive: null,
      },
    ],
    lastSynced: "2026-10-09",
  };
  assert.equal(stableContent(a), stableContent(b));
  assert.notEqual(
    stableContent(a),
    stableContent({ ...b, courses: [{ paths: [], code: "C" }] }),
  );
  assert.ok(trackerContent(a).endsWith("}\n"));
});

test("safeText and markdownUrl keep third-party text from linking, pinging or breaking a table", () => {
  const text = safeText(
    "@octocat fixed #123 <img src=x onerror=1> `code` [a](http://evil.example) | pipe",
  );
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("`"));
  assert.ok(!text.includes("["));
  assert.ok(!text.includes("|"));
  assert.ok(text.includes(`@${ZWSP}octocat`));
  assert.ok(text.includes(`#${ZWSP}123`));
  assert.equal(
    markdownUrl("https://x.example/a b(c)?d=`e`"),
    "https://x.example/a%20b%28c%29?d=%60e%60",
  );
});

test("the issue title lists the codes by kind and stays within 200 characters", () => {
  const alerts = {
    practice: [
      { kind: "available", code: "AB-650" },
      { kind: "changed", code: "AI-500" },
    ],
    unlinked: [{ number: "AZ-802T00" }],
    pathChanges: [{ number: "MB-230T01" }],
    availability: [],
    removed: [],
  };
  assert.equal(
    buildIssueTitle(alerts),
    "Learn content watch: practice assessment available: AB-650; practice assessment changed: AI-500; course not linked: AZ-802T00; course paths changed: MB-230T01",
  );
  assert.equal(
    buildIssueTitle({
      practice: [],
      unlinked: [],
      pathChanges: [],
      availability: [{ number: "AB-650T00" }, { number: "AB-650T00" }],
      removed: [],
    }),
    "Learn content watch: course availability date changed: AB-650T00",
  );
  // Five kinds at once do not fit the codes into 200 characters: counts instead.
  const five = buildIssueTitle({
    ...alerts,
    availability: [{ number: "AB-650T00" }],
  });
  assert.equal(
    five,
    "Learn content watch: practice assessment available (1); practice assessment changed (1); course not linked (1); course paths changed (1); course availability date changed (1)",
  );
  assert.ok(five.length <= 200);
  const many = {
    practice: Array.from({ length: 40 }, (_, i) => ({
      kind: "available",
      code: `AB-${100 + i}`,
    })),
    unlinked: Array.from({ length: 40 }, (_, i) => ({
      number: `AZ-${200 + i}T00`,
    })),
    pathChanges: Array.from({ length: 40 }, (_, i) => ({
      number: `SC-${300 + i}T00`,
    })),
    removed: Array.from({ length: 40 }, (_, i) => ({
      number: `MB-${400 + i}T00`,
    })),
  };
  const title = buildIssueTitle(many);
  assert.ok(title.length <= 200, `${title.length}`);
  assert.match(title, /^Learn content watch: /);
  assert.match(title, /practice assessment available/);
});

function reportAlerts(extra = {}) {
  return {
    practice: [
      {
        kind: "available",
        code: "AB-650",
        url: "https://learn.microsoft.com/credentials/certifications/x/practice/assessment?assessment-type=practice&assessmentId=4242&practice-assessment-type=certification&WT.mc_id=studentamb_165290",
        assessmentKind: "learn",
        assessmentId: "4242",
        extraIds: ["77"],
        spaHost: false,
        pageUrl: "https://learn.microsoft.com/credentials/certifications/x/",
      },
      {
        kind: "available",
        code: "DP-750",
        url: "https://aiskillsnavigator.microsoft.com/credentials/cert-1",
        assessmentKind: "asn",
        assessmentId: undefined,
        extraIds: [],
        spaHost: true,
        pageUrl: "https://learn.microsoft.com/credentials/certifications/y/",
      },
      {
        kind: "changed",
        code: "AI-500",
        reasons: ["the sentence is gone @octocat"],
        before: "unavailable",
        after: "unknown (no-mention)",
        candidateUrl: "",
        pageUrl:
          "https://learn.microsoft.com/credentials/certifications/exams/ai-500/",
      },
    ],
    unlinked: [
      {
        code: "AZ-802",
        number: "AZ-802T00",
        title: "Administer Windows Server @octocat",
        reason: "new-course",
        note: "the catalog says it will be available on 10/30/2026",
        pagePath: "src/content/docs/azure/AZ-802.mdx",
      },
    ],
    pathChanges: [
      {
        code: "AB-650",
        number: "AB-650T00",
        title: "Administer",
        added: [
          {
            uid: "lp.n",
            type: "learningPath",
            title: "New path",
            url: "https://learn.microsoft.com/training/paths/n/?WT.mc_id=studentamb_165290",
            linked: false,
            alsoIn: [],
          },
        ],
        removed: [{ uid: "lp.o", type: "module", title: "Old module" }],
      },
    ],
    availability: [
      {
        code: "AB-650",
        number: "AB-650T00",
        title: "Administer",
        from: "2026-10-30",
        to: "2026-11-15",
        pagePath: "src/content/docs/azure/AB-650.mdx",
        statesOld: true,
        statesNew: false,
      },
      {
        code: "MB-230",
        number: "MB-230T01",
        title: "Customer service",
        from: "2026-12-01",
        to: "",
        pagePath: "src/content/docs/dynamics/MB-230.mdx",
        statesOld: null,
        statesNew: null,
      },
    ],
    removed: [
      {
        code: "MB-230",
        number: "MB-230T01",
        title: "Gone",
        missingSince: "2026-10-13",
      },
    ],
    ...extra,
  };
}
const reportHub = () => {
  const hub = hubOf({ "AB-650": {}, "DP-750": {} });
  return hub;
};

test("the report has one section per kind, the exact address, the card to add and the steps to take", () => {
  const report = buildReport({
    alerts: reportAlerts(),
    hub: reportHub(),
    today: TODAY,
    baseline: false,
  });
  for (const heading of [
    "## Practice assessment now available",
    "## Practice assessment changed, check by hand",
    "## Courses the exam pages do not link",
    "## Course learning paths changed",
    "## Course availability dates changed",
    "## Courses removed from the Learn catalog",
    "## What to do",
  ]) {
    assert.ok(report.includes(heading), heading);
  }
  assert.match(
    report,
    /\| AB-650 \| `src\/content\/docs\/azure\/AB-650\.mdx` \| \[AB-650T00\]\(https:\/\/learn\.microsoft\.com\/training\/courses\/ab-650t00\?WT\.mc_id=studentamb_165290\) \| October 30, 2026 \| November 15, 2026 \| yes \| no \|/,
  );
  assert.match(report, /\| no date \(probably available now\) \| - \| - \|/);
  assert.match(report, /Becomes available <date>/);
  assert.ok(
    report.includes(
      '<LinkCard title="Microsoft Learn Practice Assessment" href="https://learn.microsoft.com/credentials/certifications/x/practice/assessment?assessment-type=practice&assessmentId=4242&practice-assessment-type=certification&WT.mc_id=studentamb_165290" target="_blank"',
    ),
  );
  assert.ok(
    report.includes(
      'title="Microsoft Learn Practice Assessment (AI Skills Navigator)"',
    ),
  );
  assert.match(report, /answers HTTP 200 to every address/);
  assert.match(report, /Learn answers 200 for any assessment id/);
  assert.match(report, /also names `77`/);
  assert.match(
    report,
    /\[AZ-802T00\]\(https:\/\/learn\.microsoft\.com\/training\/courses\/az-802t00\?WT\.mc_id=studentamb_165290\)/,
  );
  assert.match(report, /available on 10\/30\/2026/);
  assert.match(report, /\| removed \| Old module \(module\) \| - \| - \|/);
  assert.match(
    report,
    /\| added \| \[New path\]\(.*\) \(learning path\) \| no \| new for the hub \|/,
  );
  for (const needle of [
    "node scripts/audit-missing-resources.mjs",
    "pnpm build",
    "Exam Page Anatomy",
    "Nothing needs to be dismissed",
  ]) {
    assert.ok(report.includes(needle), needle);
  }
  assert.ok(!report.includes("@octocat"), "mentions are broken");
  assert.ok(report.includes(`@${ZWSP}octocat`));
  assert.doesNotMatch(report, INTERNAL_WORDS);
  assert.ok(!report.includes("This is the first run"));
  assert.ok(
    buildReport({
      alerts: reportAlerts(),
      hub: reportHub(),
      today: TODAY,
      baseline: true,
    }).includes("This is the first run"),
  );
});

test("an AI Skills Navigator card keeps its title suffix and a stand-in card is mentioned", () => {
  const hub = new Map([
    [
      "AB-650",
      parseHubPage(
        mdx({ code: "AB-650", exam: CERT("x"), standIns: ["PL-200"] }),
        "AB-650",
        "aibusiness",
      ),
    ],
  ]);
  const report = buildReport({
    alerts: {
      practice: [reportAlerts().practice[0]],
      unlinked: [],
      pathChanges: [],
      removed: [],
    },
    hub,
    today: TODAY,
    baseline: false,
  });
  assert.match(report, /stand-in; decide whether to keep it/);
});

test("a huge report is cut down in steps and stays under the GitHub limit", () => {
  const long = "x".repeat(3000);
  const added = Array.from({ length: 300 }, (_, i) => ({
    uid: `lp.${i}`,
    type: "learningPath",
    title: `${long}${i}`,
    url: "",
    linked: null,
    alsoIn: [],
  }));
  const alerts = reportAlerts({
    pathChanges: Array.from({ length: 12 }, (_, i) => ({
      code: "AB-650",
      number: `AB-650T${10 + i}`,
      title: "T",
      added,
      removed: [],
    })),
  });
  const report = buildReport({
    alerts,
    hub: reportHub(),
    today: TODAY,
    baseline: false,
  });
  assert.ok(report.length <= 60000, `${report.length}`);
  assert.match(report, /more change\(s\) of this course are not shown/);
  assert.match(report, /## What to do/);
});

test("retries honour Retry-After in seconds or as a date and are capped", () => {
  const base = {
    baseMs: 1000,
    maxMs: 60000,
    now: Date.parse("2026-10-14T00:00:00Z"),
  };
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "7", ...base }), 7000);
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Wed, 14 Oct 2026 00:00:30 GMT",
      ...base,
    }),
    30000,
  );
  assert.equal(retryDelayMs({ attempt: 3, retryAfter: null, ...base }), 4000);
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "9999", ...base }),
    60000,
  );
});

test("the defaults are polite and a bad number falls back", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.fetchDelayMs, 1000, "one request a second");
  assert.equal(cfg.minCourses, 100);
  assert.equal(cfg.maxChanges, 15);
  assert.equal(cfg.failureDays, 5);
  assert.equal(cfg.forceBaseline, false);
  assert.equal(cfg.baseUrl, "https://learn.microsoft.com");
  const odd = loadConfig({
    MIN_COURSES: "abc",
    MAX_CHANGES: "",
    FORCE_BASELINE: "1",
    TODAY: "2026-01-02",
    LEARN_BASE_URL: "http://x.test///",
  });
  assert.equal(odd.minCourses, 100);
  assert.equal(odd.maxChanges, 15);
  assert.equal(odd.forceBaseline, true);
  assert.equal(odd.today, "2026-01-02");
  assert.equal(odd.baseUrl, "http://x.test");
  assert.match(loadConfig({ TODAY: "yesterday" }).today, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// End to end against a fake Learn
// ---------------------------------------------------------------------------
test("first run: a silent baseline except the actionable course, then a quiet second run that writes nothing", async () => {
  await withWorld({}, async (w) => {
    const first = await w.run();
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.equal(first.outputs.extraction_failed, "false");
    // AI-500's course is not linked from its page: actionable on day one.
    assert.equal(first.outputs.changes_found, "true");
    assert.equal(first.outputs.baseline_updated, "true");
    assert.equal(first.outputs.course_alerts, "1");
    assert.equal(first.outputs.practice_alerts, "0");
    assert.equal(
      first.outputs.issue_title,
      "Learn content watch: course not linked: AI-500T00",
    );
    assert.match(first.report, /This is the first run/);
    assert.match(first.report, /## Courses the exam pages do not link/);
    assert.doesNotMatch(first.report, /Practice assessment now available/);
    assert.match(
      first.summary,
      /Recorded 4 courses with 20 learning paths and 4 practice assessment states silently \(0 link, 3 unavailable, 1 unknown\)/,
    );

    const tracker = w.tracker();
    assert.equal(tracker.format, 1);
    assert.equal(tracker.lastSynced, TODAY);
    // MB-230 has the card: it is not watched for practice; the others are.
    assert.deepEqual(
      tracker.practiceAssessments.map((r) => [r.code, r.state, r.detail ?? ""]),
      [
        ["AB-650", "unavailable", ""],
        ["AI-500", "unavailable", ""],
        ["AZ-802", "unavailable", ""],
        ["GH-700", "unknown", "no-learn-page"],
      ],
    );
    assert.deepEqual(
      tracker.courses.map((c) => c.number),
      ["AB-650T00", "AI-500T00", "AZ-802T00", "MB-230T01"],
    );
    assert.equal(
      tracker.courses.find((c) => c.code === "AI-500").unlinkedReported,
      TODAY,
    );
    assert.equal(
      tracker.courses.find((c) => c.code === "AB-650").paths[0].title.length >
        0,
      true,
      "titles are resolved",
    );

    // Same day or the next day, nothing changed on Learn: no issue, and the file is not rewritten.
    const before = await readFile(w.trackerFile, "utf8");
    for (const day of [TODAY, "2026-10-15", "2026-10-16"]) {
      const quiet = await w.run({ TODAY: day });
      assert.equal(quiet.code, 0, quiet.stderr);
      assert.equal(quiet.outputs.changes_found, "false", day);
      assert.equal(quiet.outputs.baseline_updated, "false", day);
      assert.equal(quiet.report, null);
      assert.equal(
        await readFile(w.trackerFile, "utf8"),
        before,
        `${day}: tracker is byte-identical`,
      );
    }
  });
});

test("requests are one at a time, spaced out, with a browser user agent and the right addresses", async () => {
  await withWorld({}, async (w) => {
    const res = await w.run({ FETCH_DELAY_MS: "60" });
    assert.equal(res.code, 0, res.stderr);
    const requests = w.learn.requests;
    assert.equal(w.learn.maxInFlight, 1, "never two requests in flight");
    assert.ok(requests.every((r) => /Mozilla\/5\.0/.test(r.agent)));
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
    assert.ok(Math.min(...gaps) >= 40, `gaps: ${gaps}`);
    const paths = requests.map((r) => r.path);
    assert.ok(paths.includes("/api/catalog/"));
    // The control probe and the pages of the four exams that lack the card, MB-230 untouched.
    assert.ok(
      paths.includes(
        "/en-us/credentials/certifications/exams/zz-000/practice/assessment",
      ),
    );
    assert.ok(paths.includes(PAGE_AB650));
    assert.ok(paths.includes(PAGE_AI500));
    assert.ok(paths.includes(PAGE_AZ802));
    assert.ok(
      paths.includes("/en-us/credentials/certifications/exams/gh-700/"),
      "an exam without a page is requested at the exam address",
    );
    assert.ok(
      !paths.some((p) => /d365-functional-consultant/.test(p)),
      "an exam with the card is not requested",
    );
    assert.ok(res.stdout.includes(`HTTP requests: ${requests.length}.`));
  });
});

test("a practice assessment that appears is reported once, with the verified address, and its record is dropped once the card exists", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    // AB-650: the page now offers the assessment and the practice page exists.
    w.learn.pages[PAGE_AB650] = {
      status: 200,
      body: publishedPage("AB-650", 4242),
    };
    w.learn.routes[
      "/en-us/credentials/certifications/ai-services-administrator-associate/practice/assessment"
    ] = { status: 200 };
    const day2 = await w.run({ TODAY: "2026-10-15" });
    assert.equal(day2.code, 0, day2.stderr);
    assert.equal(day2.outputs.practice_alerts, "1");
    assert.equal(
      day2.outputs.issue_title,
      "Learn content watch: practice assessment available: AB-650",
    );
    const expected =
      "https://learn.microsoft.com/credentials/certifications/ai-services-administrator-associate/practice/assessment?assessment-type=practice&assessmentId=4242&practice-assessment-type=certification&WT.mc_id=studentamb_165290";
    assert.ok(day2.report.includes(`href="${expected}"`), day2.report);
    assert.match(
      day2.report,
      /\| AB-650 \| `src\/content\/docs\/aibusiness\/AB-650\.mdx` \| \[Learn page\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/ai-services-administrator-associate\/\?WT\.mc_id=studentamb_165290\)/,
    );
    assert.match(day2.report, /assessment id `4242`/);
    assert.doesNotMatch(day2.report, /This is the first run/);
    const record = w
      .tracker()
      .practiceAssessments.find((r) => r.code === "AB-650");
    assert.equal(record.state, "link");
    assert.equal(record.url, expected);
    assert.equal(record.lastChanged, "2026-10-15");
    assert.equal(record.firstSeen, TODAY);

    // The card is still missing the next day: reported only once.
    const day3 = await w.run({ TODAY: "2026-10-16" });
    assert.equal(day3.outputs.changes_found, "false");
    assert.equal(day3.outputs.baseline_updated, "false");

    // The maintainer adds the card: the record disappears, with no alert.
    writeHub(w.docs, {
      aibusiness: {
        "AB-650": {
          exam: CERT("ai-services-administrator-associate"),
          practice: true,
          courses: ["ab-650t00"],
        },
      },
    });
    const day4 = await w.run({ TODAY: "2026-10-17" });
    assert.equal(day4.outputs.changes_found, "false");
    assert.equal(day4.outputs.baseline_updated, "true");
    assert.ok(
      !w.tracker().practiceAssessments.some((r) => r.code === "AB-650"),
    );
  });
});

test("an assessment found on an exam page is reported at the exam route, without the certification parameter", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    // AI-500 has no certification page: the hub links its exam page.
    w.learn.pages[PAGE_AI500] = {
      status: 200,
      body: publishedPage("AI-500", 4242),
    };
    w.learn.routes[
      "/en-us/credentials/certifications/exams/ai-500/practice/assessment"
    ] = { status: 200 };
    const day2 = await w.run({ TODAY: "2026-10-15" });
    assert.equal(day2.code, 0, day2.stderr);
    assert.equal(day2.outputs.practice_alerts, "1");
    const expected =
      "https://learn.microsoft.com/credentials/certifications/exams/ai-500/practice/assessment?assessment-type=practice&assessmentId=4242&WT.mc_id=studentamb_165290";
    assert.ok(
      day2.report.includes(
        `<LinkCard title="Microsoft Learn Practice Assessment" href="${expected}" target="_blank"`,
      ),
      day2.report,
    );
    assert.doesNotMatch(day2.report, /practice-assessment-type/);
    assert.equal(
      w.tracker().practiceAssessments.find((r) => r.code === "AI-500").url,
      expected,
    );
  });
});

test("a published assessment whose address does not resolve, or redirects to another page, is not reported as available", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    w.learn.pages[PAGE_AB650] = {
      status: 200,
      body: publishedPage("AB-650", 4242),
    };
    // The certification route redirects to the certification page; the exam route does not exist.
    w.learn.routes[
      "/en-us/credentials/certifications/ai-services-administrator-associate/practice/assessment"
    ] = {
      status: 302,
      location: PAGE_AB650,
    };
    w.learn.pages[PAGE_AB650].body = publishedPage("AB-650", 4242);
    const res = await w.run({ TODAY: "2026-10-15" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.outputs.practice_alerts, "1");
    assert.equal(
      res.outputs.issue_title,
      "Learn content watch: practice assessment changed: AB-650",
    );
    assert.match(res.report, /Practice assessment changed, check by hand/);
    assert.match(res.report, /does not resolve/);
    assert.doesNotMatch(res.report, /Practice assessment now available/);
    assert.equal(
      w.tracker().practiceAssessments.find((r) => r.code === "AB-650").detail,
      "link-not-resolving",
    );
  });
});

test("an address that could not be verified (HTTP 500) concludes nothing and keeps the previous state", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    w.learn.pages[PAGE_AB650] = {
      status: 200,
      body: publishedPage("AB-650", 4242),
    };
    w.learn.routes[
      "/en-us/credentials/certifications/ai-services-administrator-associate/practice/assessment"
    ] = { status: 500 };
    const res = await w.run({ TODAY: "2026-10-15" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.outputs.practice_alerts, "0");
    assert.equal(res.outputs.changes_found, "false");
    assert.match(
      res.stderr,
      /AB-650: the Learn page could not be evaluated \(the practice assessment address could not be verified\)/,
    );
    assert.match(res.summary, /AB-650: the Learn page could not be evaluated/);
    assert.equal(
      w.tracker().practiceAssessments.find((r) => r.code === "AB-650").state,
      "unavailable",
    );
  });
});

test("an AI Skills Navigator assessment is reported with the warning that the host answers everything", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    w.learn.pages[PAGE_AI500] = {
      status: 200,
      body: fx("cert-asn-callout.html")
        .replaceAll("DP-750", "AI-500")
        .replace(/certification\.[a-z-]+/, "exam.ai-500"),
    };
    const res = await w.run({ TODAY: "2026-10-15" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      res.outputs.issue_title,
      "Learn content watch: practice assessment available: AI-500",
    );
    assert.match(
      res.report,
      /Microsoft Learn Practice Assessment \(AI Skills Navigator\)/,
    );
    assert.match(res.report, /answers HTTP 200 to every address/);
    assert.match(
      res.report,
      /href="https:\/\/aiskillsnavigator\.microsoft\.com\/credentials\/cert-6818382e4ae0a7b8/,
    );
    assert.equal(w.asn.requests.length, 1);
    const record = w
      .tracker()
      .practiceAssessments.find((r) => r.code === "AI-500");
    assert.equal(record.kind, "asn");
    assert.match(record.url, /^https:\/\/aiskillsnavigator\.microsoft\.com\//);
  });
});

test("the sentence disappearing without a link, and the practice route turning on, are 'changed, check by hand'", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    // AB-650: the sentence is gone and nothing replaced it.
    w.learn.pages[PAGE_AB650] = {
      status: 200,
      body: fx("cert-unavailable.html").replace(
        /<li>The Practice Assessment for this exam[^]*?<\/li>/,
        "",
      ),
    };
    // AI-500: the exam's practice route starts to answer although the page still says unavailable.
    w.learn.routes[
      "/en-us/credentials/certifications/exams/ai-500/practice/assessment"
    ] = { status: 200 };
    const res = await w.run({ TODAY: "2026-10-15" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.outputs.practice_alerts, "2");
    assert.equal(
      res.outputs.issue_title,
      "Learn content watch: practice assessment changed: AB-650, AI-500",
    );
    assert.match(
      res.report,
      /is gone, but no practice assessment link took its place/,
    );
    assert.match(res.report, /answers HTTP 200/);
    assert.deepEqual(
      w
        .tracker()
        .practiceAssessments.map((r) => [r.code, r.state, r.routeLive]),
      [
        ["AB-650", "unknown", false],
        ["AI-500", "unavailable", true],
        ["AZ-802", "unavailable", false],
        ["GH-700", "unknown", false],
      ],
    );
  });
});

test("when the control exam code answers 200 the route probe is switched off with a warning", async () => {
  await withWorld({}, async (w) => {
    w.learn.routes[
      "/en-us/credentials/certifications/exams/zz-000/practice/assessment"
    ] = { status: 200 };
    w.learn.routes[
      "/en-us/credentials/certifications/exams/ai-500/practice/assessment"
    ] = { status: 200 };
    const res = await w.run();
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /practice route probe is not used this run/);
    assert.match(res.summary, /practice route probe is not used this run/);
    assert.equal(
      w.tracker().practiceAssessments.find((r) => r.code === "AI-500")
        .routeLive,
      null,
    );
    assert.equal(res.outputs.practice_alerts, "0");
  });
});

test("a Learn page that stays unreadable is carried, then reported once as no longer watched", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    w.learn.pages[PAGE_AB650] = { status: 500, body: "boom" };
    const days = ["2026-10-15", "2026-10-16", "2026-10-17"];
    const outputs = [];
    for (const day of days) {
      const res = await w.run({ TODAY: day, FAILURE_DAYS: "2" });
      assert.equal(res.code, 0, res.stderr);
      outputs.push(res.outputs.practice_alerts);
      assert.match(
        res.stderr,
        /AB-650: the Learn page could not be evaluated \(status 500\)/,
      );
    }
    assert.deepEqual(
      outputs,
      ["0", "1", "0"],
      "reported on the second day of failures, once",
    );
    const record = w
      .tracker()
      .practiceAssessments.find((r) => r.code === "AB-650");
    assert.equal(record.state, "unavailable", "the old state is kept");
    assert.equal(record.failedSince, "2026-10-15");
    assert.equal(record.failureReported, "2026-10-16");

    w.learn.pages[PAGE_AB650] = {
      status: 200,
      body: fx("cert-unavailable.html"),
    };
    const healthy = await w.run({ TODAY: "2026-10-18", FAILURE_DAYS: "2" });
    assert.equal(healthy.outputs.practice_alerts, "0");
    const recovered = w
      .tracker()
      .practiceAssessments.find((r) => r.code === "AB-650");
    assert.equal(recovered.failedSince, undefined);
    assert.equal(recovered.failureReported, undefined);
  });
});

test("the failing day's alert text names the cause and says the watch is off", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    w.learn.pages[PAGE_AB650] = { status: 403, body: "no" };
    await w.run({ TODAY: "2026-10-15", FAILURE_DAYS: "2" });
    const res = await w.run({ TODAY: "2026-10-16", FAILURE_DAYS: "2" });
    assert.equal(res.outputs.practice_alerts, "1");
    assert.match(
      res.report,
      /could not be read for 2 days in a row \(status 403\), so practice assessments are not being watched for this exam/,
    );
    assert.match(res.report, /not readable since 2026-10-15/);
  });
});

test("course alerts across days: a new learning path, a removed one, and a course that vanishes", async () => {
  await withWorld({}, async (w) => {
    // The page links everything, so day one is quiet.
    writeHub(w.docs, {
      azure: {
        "AI-500": { exam: CERT("exams/ai-500"), courses: ["ai-500t00"] },
      },
    });
    const first = await w.run();
    assert.equal(first.outputs.changes_found, "false", first.report);

    // Day 2: AB-650 gains a learning path (and loses one); AI-500's course vanishes.
    const catalog = catalogFixture();
    const ab650 = catalog.courses.find((c) => c.course_number === "AB-650T00");
    const removedUid = ab650.study_guide.pop().uid;
    ab650.study_guide.push({
      uid: "learn.wwl.brand-new-path",
      type: "learningPath",
    });
    w.learn.catalog = {
      courses: catalog.courses.filter((c) => c.course_number !== "AI-500T00"),
    };
    w.learn.lookups.set("learn.wwl.brand-new-path", {
      uid: "learn.wwl.brand-new-path",
      type: "learningPath",
      title: "A brand new path",
      url: "https://learn.microsoft.com/en-us/training/paths/brand-new-path/?WT.mc_id=api_CatalogApi",
    });
    const day2 = await w.run({ TODAY: "2026-10-15" });
    assert.equal(day2.code, 0, day2.stderr);
    assert.equal(
      day2.outputs.course_alerts,
      "1",
      "the vanished course waits one more day",
    );
    assert.equal(
      day2.outputs.issue_title,
      "Learn content watch: course paths changed: AB-650T00",
    );
    assert.match(
      day2.report,
      /\| added \| \[A brand new path\]\(https:\/\/learn\.microsoft\.com\/training\/paths\/brand-new-path\/\?WT\.mc_id=studentamb_165290\) \(learning path\) \| no \| new for the hub \|/,
    );
    assert.match(
      day2.report,
      new RegExp(`\\| removed \\| .*\\(learning path\\) \\| - \\| - \\|`),
    );
    assert.ok(removedUid);
    assert.match(day2.stderr, /AI-500T00 is not in the catalog today/);
    assert.doesNotMatch(day2.report, /Courses removed/);

    // Day 3: still missing: reported now. The path change is not reported again.
    const day3 = await w.run({ TODAY: "2026-10-16" });
    assert.equal(
      day3.outputs.issue_title,
      "Learn content watch: course removed: AI-500T00",
    );
    assert.match(day3.report, /## Courses removed from the Learn catalog/);
    assert.match(
      day3.report,
      /\| AI-500 \| \[AI-500T00\]\(https:\/\/learn\.microsoft\.com\/training\/courses\/ai-500t00\?WT\.mc_id=studentamb_165290\) \| .* \| 2026-10-15 \|/,
    );
    assert.doesNotMatch(day3.report, /Course learning paths changed/);

    // Day 4: nothing new.
    const day4 = await w.run({ TODAY: "2026-10-17" });
    assert.equal(day4.outputs.changes_found, "false");
  });
});

test("a brand new course for a hub exam is reported as soon as the catalog lists it", async () => {
  await withWorld({}, async (w) => {
    writeHub(w.docs, {
      azure: {
        "AI-500": { exam: CERT("exams/ai-500"), courses: ["ai-500t00"] },
      },
    });
    await w.run();
    const catalog = catalogFixture();
    catalog.courses.push({
      uid: "course.mb-230t00",
      course_number: "MB-230T00",
      title: "Customer service, the new course",
      summary: "<p>This course will be available on 12/01/2026.</p>",
      exam: "exam.mb-230",
      study_guide: [{ uid: "learn.wwl.some-path", type: "learningPath" }],
    });
    w.learn.catalog = catalog;
    const res = await w.run({ TODAY: "2026-10-15" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      res.outputs.issue_title,
      "Learn content watch: course not linked: MB-230T00",
    );
    assert.match(res.report, /Customer service, the new course/);
    assert.match(res.report, /course is new for this exam/);
    assert.match(res.report, /available on 12\/01\/2026/);
    assert.match(res.report, /src\/content\/docs\/dynamics\/MB-230\.mdx/);
  });
});

test("a course whose number has a suffix its address lacks is linked and reported by the address Learn serves", async () => {
  const azure = (courses) => ({
    azure: {
      "AZ-104": { exam: CERT("exams/az-104"), practice: true, courses },
    },
  });
  // The page links /training/courses/az-104t00 (the catalog number is AZ-104T00-A).
  await withWorld({ hub: azure(["az-104t00"]) }, async (w) => {
    const first = await w.run();
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.changes_found, "false", first.report);
    const record = w.tracker().courses.find((c) => c.number === "AZ-104T00-A");
    assert.equal(record.code, "AZ-104");
    assert.equal(record.uid, "course.az-104t00");
    assert.equal(record.unlinkedReported, undefined);
    assert.ok(!("slug" in record), "the tracker format is unchanged");
  });
  // A page without the link is told the address that works, not a dead one.
  await withWorld({ hub: azure([]) }, async (w) => {
    const res = await w.run();
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      res.outputs.issue_title,
      "Learn content watch: course not linked: AZ-104T00-A",
    );
    assert.match(
      res.report,
      /\[AZ-104T00-A\]\(https:\/\/learn\.microsoft\.com\/training\/courses\/az-104t00\?WT\.mc_id=studentamb_165290\)/,
    );
    assert.doesNotMatch(res.report, /courses\/az-104t00-a/);
  });
});

test("a course whose announced availability date moves is reported once, naming whether the page states the old date", async () => {
  await withWorld({}, async (w) => {
    writeHub(w.docs, {
      aibusiness: {
        "AB-650": {
          exam: CERT("ai-services-administrator-associate"),
          courses: [
            {
              number: "ab-650t00",
              description: "Becomes available October 30, 2026.",
            },
          ],
        },
      },
      azure: {
        "AI-500": { exam: CERT("exams/ai-500"), courses: ["ai-500t00"] },
      },
    });
    const first = await w.run();
    assert.equal(first.outputs.changes_found, "false", first.report);
    assert.equal(
      w.tracker().courses.find((c) => c.number === "AB-650T00").availableOn,
      "2026-10-30",
    );

    const catalog = catalogFixture();
    const summary = catalog.courses.find(
      (c) => c.course_number === "AB-650T00",
    );
    summary.summary = summary.summary.replace("10/30/2026", "11/15/2026");
    w.learn.catalog = catalog;
    const moved = await w.run({ TODAY: "2026-10-15" });
    assert.equal(moved.code, 0, moved.stderr);
    assert.equal(moved.outputs.course_alerts, "1");
    assert.equal(
      moved.outputs.issue_title,
      "Learn content watch: course availability date changed: AB-650T00",
    );
    assert.match(moved.report, /## Course availability dates changed/);
    assert.match(
      moved.report,
      /\| AB-650 \| `src\/content\/docs\/aibusiness\/AB-650\.mdx` \| \[AB-650T00\]\(.*\) \| October 30, 2026 \| November 15, 2026 \| yes \| no \|/,
    );
    assert.match(moved.report, /Becomes available <date>/);
    assert.equal(
      w.tracker().courses.find((c) => c.number === "AB-650T00").availableOn,
      "2026-11-15",
    );

    // Reported once.
    const again = await w.run({ TODAY: "2026-10-16" });
    assert.equal(again.outputs.changes_found, "false");
    assert.equal(again.outputs.baseline_updated, "false");

    // The date is withdrawn: reported once more, as "no date".
    summary.summary = "<p>Plain summary.</p>";
    const withdrawn = await w.run({ TODAY: "2026-10-17" });
    assert.match(
      withdrawn.report,
      /\| November 15, 2026 \| no date \(probably available now\) \| no \| - \|/,
    );
  });
});

test("a catalog problem is a failure: nothing is written, the error file says why, and the exit code is 1", async () => {
  const cases = [
    [
      "status 500",
      (learn) => (learn.catalogStatus = 500),
      /could not be read \(status 500\)/,
    ],
    [
      "not JSON",
      (learn) => (learn.catalogBody = "<html>login</html>"),
      /not JSON/,
    ],
    [
      "shape changed",
      (learn) => (learn.catalogBody = JSON.stringify({ items: [] })),
      /no `courses` list/,
    ],
    [
      "too few courses",
      (learn) =>
        (learn.catalogBody = JSON.stringify({
          courses: catalogFixture().courses.slice(0, 2),
        })),
      /only 2 courses/,
    ],
  ];
  for (const [name, mutate, message] of cases) {
    await withWorld({}, async (w) => {
      await w.run();
      const before = await readFile(w.trackerFile, "utf8");
      mutate(w.learn);
      const res = await w.run({ TODAY: "2026-10-15" });
      assert.equal(res.code, 1, name);
      assert.equal(res.outputs.extraction_failed, "true", name);
      assert.equal(res.outputs.changes_found, "false", name);
      assert.equal(res.outputs.baseline_updated, "false", name);
      assert.match(res.error, message, name);
      assert.match(res.error, /tracker was not modified/);
      assert.doesNotMatch(res.error, INTERNAL_WORDS);
      assert.equal(
        await readFile(w.trackerFile, "utf8"),
        before,
        `${name}: tracker untouched`,
      );
      assert.equal(res.report, null);
    });
  }
});

test("a corrupt tracker or a hub without exam pages stops the run without writing", async () => {
  await withWorld({}, async (w) => {
    await writeFile(w.trackerFile, "{not json");
    const res = await w.run();
    assert.equal(res.code, 1);
    assert.match(res.error, /tracker could not be read/);
    assert.equal(await readFile(w.trackerFile, "utf8"), "{not json");
    for (const bad of [
      [],
      { format: 2 },
      { courses: "x" },
      { courses: [{ code: 1 }] },
      { practiceAssessments: [{ code: "AB-650", state: "bogus" }] },
    ]) {
      await writeFile(w.trackerFile, JSON.stringify(bad));
      const again = await w.run();
      assert.equal(again.code, 1, JSON.stringify(bad));
      assert.match(again.error, /tracker is corrupt|tracker could not be read/);
    }
  });
  await withWorld({ hub: {} }, async (w) => {
    const res = await w.run();
    assert.equal(res.code, 1);
    assert.match(res.error, /No exam page found/);
    assert.equal(existsSync(w.trackerFile), false);
  });
});

test("every date the tracker stores must be YYYY-MM-DD, otherwise the tracker is corrupt and the error names the field", () => {
  const course = (extra = {}) => ({
    code: "AB-650",
    number: "AB-650T00",
    uid: "course.ab-650t00",
    title: "T",
    paths: [],
    firstSeen: "2026-10-01",
    lastSeen: "2026-10-13",
    ...extra,
  });
  const practice = (extra = {}) => ({
    code: "AI-500",
    state: "unavailable",
    pageUrl: "u",
    firstSeen: "2026-10-01",
    lastChanged: "2026-10-01",
    lastChecked: "2026-10-13",
    ...extra,
  });
  const COURSE_DATES = [
    "firstSeen",
    "lastSeen",
    "lastChanged",
    "missingSince",
    "availableOn",
    "removedAt",
    "unlinkedReported",
  ];
  const PRACTICE_DATES = [
    "firstSeen",
    "lastChanged",
    "lastChecked",
    "failedSince",
    "failureReported",
  ];

  // A tracker with every date in place is kept as it is.
  const full = {
    lastSynced: "2026-10-14",
    format: 1,
    courses: [
      course(Object.fromEntries(COURSE_DATES.map((f) => [f, "2026-10-05"]))),
    ],
    practiceAssessments: [
      practice(
        Object.fromEntries(PRACTICE_DATES.map((f) => [f, "2026-10-06"])),
      ),
    ],
  };
  const normalized = normalizeTracker(full);
  assert.equal(normalized.lastSynced, "2026-10-14");
  for (const field of COURSE_DATES) {
    assert.equal(normalized.courses[0][field], "2026-10-05", field);
  }
  for (const field of PRACTICE_DATES) {
    assert.equal(normalized.practiceAssessments[0][field], "2026-10-06", field);
  }
  // No date at all (a field that was never written, or null) is allowed.
  assert.equal(normalizeTracker({}).lastSynced, null);
  assert.equal(normalizeTracker({ lastSynced: null }).lastSynced, null);
  assert.doesNotThrow(() =>
    normalizeTracker({
      courses: [course({ missingSince: null, availableOn: undefined })],
      practiceAssessments: [practice({ failedSince: null })],
    }),
  );

  const corrupt = (tracker, where, field, shown) =>
    assert.throws(
      () => normalizeTracker(tracker),
      (error) => {
        assert.equal(
          error.message,
          `The tracker is corrupt (${where}${field} is ${shown}, not a YYYY-MM-DD date). Fix or delete src/data_files/learn-content-watch.json; it was not modified.`,
        );
        return true;
      },
      `${where}${field}`,
    );
  const bad = [
    ["yesterday", '"yesterday"'],
    ["10/14/2026", '"10/14/2026"'],
    ["2026-10-1", '"2026-10-1"'],
    ["2026-10-14T00:00:00Z", '"2026-10-14T00:00:00Z"'],
    ["", '""'],
    [20261014, "20261014"],
    [true, "true"],
    [{}, "{}"],
  ];
  for (const [value, shown] of bad) {
    corrupt({ lastSynced: value }, "", "lastSynced", shown);
    for (const field of COURSE_DATES) {
      corrupt(
        { courses: [course({ [field]: value })] },
        "course AB-650T00: ",
        field,
        shown,
      );
    }
    for (const field of PRACTICE_DATES) {
      corrupt(
        { practiceAssessments: [practice({ [field]: value })] },
        "practice assessment AI-500: ",
        field,
        shown,
      );
    }
  }
  // A long value is cut in the message.
  assert.throws(
    () =>
      normalizeTracker({
        courses: [course({ missingSince: "x".repeat(200) })],
      }),
    (error) => error.message.length < 250 && error.message.includes("…"),
  );
  // The shape of the record is still looked at first.
  assert.throws(
    () => normalizeTracker({ courses: [{ code: 1, missingSince: "x" }] }),
    /a course record is malformed/,
  );
});

test("a hand-edited date that is not YYYY-MM-DD stops the run instead of silently breaking the two-days-in-a-row rule", async () => {
  await withWorld({}, async (w) => {
    await w.run();
    // AI-500's course leaves the catalog and someone edits the day it went missing.
    const catalog = catalogFixture();
    w.learn.catalog = {
      courses: catalog.courses.filter((c) => c.course_number !== "AI-500T00"),
    };
    const tracker = w.tracker();
    tracker.courses.find((c) => c.number === "AI-500T00").missingSince =
      "yesterday";
    await writeFile(w.trackerFile, JSON.stringify(tracker, null, 2));
    const before = await readFile(w.trackerFile, "utf8");
    const res = await w.run({ TODAY: "2026-10-16" });
    assert.equal(res.code, 1, res.stdout);
    assert.equal(res.outputs.extraction_failed, "true");
    assert.match(
      res.error,
      /The tracker is corrupt \(course AI-500T00: missingSince is "yesterday", not a YYYY-MM-DD date\)\. Fix or delete src\/data_files\/learn-content-watch\.json; it was not modified\./,
    );
    assert.equal(await readFile(w.trackerFile, "utf8"), before, "untouched");
    assert.equal(res.report, null);

    // Fixed by hand: the removal is reported on this run, since the course has
    // been missing since before today.
    tracker.courses.find((c) => c.number === "AI-500T00").missingSince =
      "2026-10-15";
    await writeFile(w.trackerFile, JSON.stringify(tracker, null, 2));
    const fixed = await w.run({ TODAY: "2026-10-16" });
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(
      fixed.outputs.issue_title,
      "Learn content watch: course removed: AI-500T00",
    );
  });
});

test("more than 15 changes at once is a structure change, not news, unless the baseline is forced", async () => {
  const hub = { azure: {} };
  const catalog = { courses: [] };
  for (let i = 0; i < 17; i++) {
    const code = `AZ-${900 + i}`;
    hub.azure[code] = {
      exam: CERT(`exams/${code.toLowerCase()}`),
      practice: true,
    };
    catalog.courses.push({
      uid: `course.${code.toLowerCase()}t00`,
      course_number: `${code}T00`,
      title: `Course ${code}`,
      summary: "",
      study_guide: [{ uid: `learn.wwl.p${i}`, type: "learningPath" }],
    });
  }
  const learn = await fakeLearn({ catalog });
  try {
    await withWorld({ hub, learn }, async (w) => {
      const res = await w.run();
      assert.equal(res.code, 1);
      assert.match(res.error, /17 changes at once \(limit 15\)/);
      assert.match(res.error, /force_baseline/);
      assert.equal(existsSync(w.trackerFile), false, "nothing written");
      assert.equal(res.outputs.extraction_failed, "true");

      const forced = await w.run({ FORCE_BASELINE: "1" });
      assert.equal(forced.code, 0, forced.stderr);
      assert.equal(
        forced.outputs.changes_found,
        "false",
        "forced baselines are silent",
      );
      assert.equal(forced.outputs.baseline_updated, "true");
      assert.equal(forced.report, null);
      assert.match(
        forced.summary,
        /FORCE_BASELINE recorded 17 item\(s\) silently: AZ-900T00 \(unlinked\)/,
      );
      assert.equal(w.tracker().courses.length, 17);
      const quiet = await w.run({ TODAY: "2026-10-15" });
      assert.equal(
        quiet.outputs.changes_found,
        "false",
        "and not reported afterwards",
      );
    });
  } finally {
    await learn.close();
  }
});

test("MAX_CHANGES can be raised", async () => {
  await withWorld({}, async (w) => {
    const res = await w.run({ MAX_CHANGES: "0" });
    assert.equal(res.code, 1);
    assert.match(res.error, /1 changes at once \(limit 0\)/);
    assert.equal((await w.run({ MAX_CHANGES: "1" })).code, 0);
  });
});

test("titles that cannot be looked up are shown as uids and do not block the alert", async () => {
  await withWorld({}, async (w) => {
    w.learn.lookupStatus = 500;
    const res = await w.run();
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /Could not resolve \d+ learning path titles/);
    assert.equal(res.outputs.course_alerts, "1");
    assert.ok(
      w.tracker().courses.every((c) => c.paths.every((p) => p.title === "")),
    );
    // The titles are looked up again on the next run, and kept once found.
    w.learn.lookupStatus = 200;
    const again = await w.run({ TODAY: "2026-10-15" });
    assert.equal(again.code, 0, again.stderr);
    assert.ok(
      w.tracker().courses.every((c) => c.paths.every((p) => p.title !== "")),
    );
    assert.equal(
      again.outputs.changes_found,
      "false",
      "a title is not a change",
    );
  });
});

test("on a GitHub runner a warning is also an annotation with the monitor's title", async () => {
  await withWorld({}, async (w) => {
    w.learn.lookupStatus = 500;
    const res = await w.run({ GITHUB_ACTIONS: "true" });
    assert.equal(res.code, 0, res.stderr);
    const annotation = res.stdout
      .split("\n")
      .find((line) => line.startsWith("::warning "));
    assert.match(
      annotation,
      /^::warning title=Learn Content Watch::Could not resolve \d+ learning path titles \(status 500\); their uids are shown instead\.$/,
    );
    assert.match(
      res.stderr,
      /^WARNING: Could not resolve \d+ learning path titles/m,
    );
    // Off a runner there is the warning on stderr and no annotation.
    const local = await w.run({ GITHUB_ACTIONS: "", TODAY: "2026-10-15" });
    assert.doesNotMatch(local.stdout, /::warning/);
    assert.match(local.stderr, /^WARNING: Could not resolve/m);
  });
});

test("hostile text from the catalog cannot ping, link or break the issue", async () => {
  await withWorld({}, async (w) => {
    writeHub(w.docs, { azure: { "AI-500": { exam: CERT("exams/ai-500") } } });
    const catalog = catalogFixture();
    catalog.courses.find((c) => c.course_number === "AI-500T00").title =
      "@octocat fixed #123 <img src=x onerror=alert(1)> `tick` [a](http://evil.example) | pipe\nnewline";
    w.learn.catalog = catalog;
    const res = await w.run();
    assert.equal(res.code, 0, res.stderr);
    const row = res.report
      .split("\n")
      .find((line) => line.startsWith("| AI-500 |"));
    assert.ok(row);
    assert.equal(row.split(" | ").length, 6, row);
    assert.ok(!res.report.includes("<img"));
    assert.ok(!res.report.includes("[a]"));
    assert.ok(!res.report.includes("@octocat"));
    assert.ok(!res.report.includes("#123"));
    assert.equal(res.outputs.issue_title.includes("\n"), false);
  });
});

test("the monitor's own files never mention private planning", () => {
  for (const path of [
    "scripts/learn-content-watch.mjs",
    ".github/workflows/learn-content-watch.yml",
  ]) {
    assert.doesNotMatch(
      readFileSync(join(root, path), "utf8"),
      INTERNAL_WORDS,
      path,
    );
  }
  for (const name of readdirSync(FIXTURES)) {
    assert.doesNotMatch(
      readFileSync(join(FIXTURES, name), "utf8"),
      INTERNAL_WORDS,
      name,
    );
  }
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
const workflowDir = join(root, ".github", "workflows");
const workflowSource = readFileSync(
  join(workflowDir, "learn-content-watch.yml"),
  "utf8",
);

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
    .map((stepText) => ({
      text: stepText,
      name: stepText.match(/^\s*(?:- )?name: (.+)$/m)?.[1] ?? "",
      condition: stepText.match(/^\s+if: (.+)$/m)?.[1] ?? "",
    }));
}
function workflowStep(name) {
  const found = workflowSteps().find((candidate) => candidate.name === name);
  assert.ok(found, `no workflow step named "${name}"`);
  return found;
}
const STEP_CHECK = "Check Microsoft Learn for new official content";
const STEP_ISSUE = "Create issue if new official content was found";
const STEP_COMMIT = "Commit updated Learn content tracker";
const STEP_FAILED = "Create issue if the check failed";

test("the workflow opens the issue before it commits the tracker, so a failed issue is retried", () => {
  const names = workflowSteps().map((s) => s.name);
  const at = [STEP_CHECK, STEP_ISSUE, STEP_COMMIT, STEP_FAILED].map((n) =>
    names.indexOf(n),
  );
  assert.ok(
    at[0] >= 0 && at.every((index, i) => i === 0 || index > at[i - 1]),
    `unexpected step order: ${at}`,
  );
  assert.equal(
    workflowStep(STEP_ISSUE).condition,
    "steps.check.outputs.changes_found == 'true'",
  );
  assert.equal(
    workflowStep(STEP_COMMIT).condition,
    "steps.check.outputs.baseline_updated == 'true'",
  );
  for (const name of [STEP_ISSUE, STEP_COMMIT]) {
    assert.doesNotMatch(
      workflowStep(name).condition,
      /always\(\)|failure\(\)|cancelled\(\)/,
      `${name} must be skipped when an earlier step failed`,
    );
  }
  assert.equal(
    workflowStep(STEP_FAILED).condition,
    "failure() && steps.check.outputs.extraction_failed == 'true'",
  );
});

test("issues carry the right label, the report file and no assignee; the failure issue is a bug", () => {
  const issue = workflowStep(STEP_ISSUE).text;
  assert.match(
    issue,
    /uses: peter-evans\/create-issue-from-file@[0-9a-f]{40} # v6/,
  );
  assert.match(
    issue,
    /title: "\$\{\{ steps\.check\.outputs\.issue_title \}\}"/,
  );
  assert.match(
    issue,
    /content-filepath: \/tmp\/learn-content-watch-report\.md/,
  );
  assert.match(issue, /labels: enhancement$/m);
  // The failure issue is ONE issue with a stable title (a comment per failed
  // run, closed by a healthy run), not one per run id.
  const failed = workflowStep(STEP_FAILED).text;
  assert.match(
    failed,
    /node scripts\/failure-issue\.mjs raise --title "Learn Content Watch Failed" --label bug --file \/tmp\/learn-content-watch-error\.md/,
  );
  assert.doesNotMatch(failed, /github\.run_id/);
  const close = workflowStep(
    "Close the failure issue once the check runs again",
  );
  assert.equal(
    close.condition,
    "steps.check.outputs.extraction_failed == 'false'",
  );
  assert.match(
    close.text,
    /failure-issue\.mjs clear --title "Learn Content Watch Failed" --label bug --comment/,
  );
  assert.doesNotMatch(workflowSource, /assignees?:/);
  assert.match(
    workflowSource,
    /REPORT_FILE: \/tmp\/learn-content-watch-report\.md/,
  );
  assert.match(
    workflowSource,
    /ERROR_FILE: \/tmp\/learn-content-watch-error\.md/,
  );
});

test("the workflow runs the node version of .node-version with only the permissions it needs and is never cancelled half way", () => {
  assert.match(workflowSource, /node-version-file: \.node-version/);
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(
    workflowSource,
    /^concurrency:\n {2}group: learn-content-watch\n {2}cancel-in-progress: false$/m,
  );
  assert.match(workflowSource, /^ {4}timeout-minutes: 20$/m);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /run: node scripts\/learn-content-watch\.mjs/,
  );
});

test("a manual run can force a baseline with the input the failsafe message names", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  assert.match(dispatch, /^ {4}inputs:\n {6}force_baseline:\n/);
  assert.match(dispatch, /^ {8}type: boolean$/m);
  assert.match(dispatch, /^ {8}default: false$/m);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /FORCE_BASELINE: \$\{\{ inputs\.force_baseline && '1' \|\| '' \}\}/,
  );
  // The script's failure message names the same input.
  assert.match(
    readFileSync(script, "utf8"),
    /run the workflow with force_baseline enabled/,
  );
});

test("the schedule is daily at 09:20 UTC and no other monitor that pushes to main starts in the same minute", () => {
  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\S+) (\S+) (\S+) (\S+) (\S+)"/gm)].map(
      (match) => match.slice(1, 6),
    );
  const mine = cron(workflowSource);
  assert.deepEqual(mine, [["20", "9", "*", "*", "*"]]);
  let others = 0;
  for (const name of readdirSync(workflowDir)) {
    if (name === "learn-content-watch.yml" || !name.endsWith(".yml")) continue;
    const text = readFileSync(join(workflowDir, name), "utf8");
    if (!/git push/.test(text)) continue;
    others++;
    for (const schedule of cron(text)) {
      assert.notDeepEqual(
        schedule.slice(0, 2),
        mine[0].slice(0, 2),
        `${name} starts at the same time (${schedule.slice(0, 2).join(" ")})`,
      );
    }
  }
  assert.ok(others > 0, "other pushing workflows were checked");
});

// The commit step is plain bash: run it for real against a scratch remote
// (tests/scripts/helpers/git-remote.mjs; the step of every pushing workflow is
// also run by workflow-commit-steps.test.mjs).
const bash = findBash();
const TRACKER_PATH = "src/data_files/learn-content-watch.json";

function commitScript() {
  const body = workflowStep(STEP_COMMIT).text.split(/^\s+run: \|\n/m)[1];
  assert.ok(body, "the commit step has no run script");
  const indent = body.match(/^ +/)[0].length;
  return body
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

test(
  "the commit step tries the push again when it is rejected once, and fails after the third rejection",
  { skip: bashSkipReason(bash) },
  async (t) => {
    const remote = await makeScratchRemote({
      prefix: "learn-content-workflow-retry-",
      files: { [TRACKER_PATH]: '{"courses":[]}\n' },
    });
    t.after(() => remote.cleanup());
    // The wait between the tries (5, 10 and 15 seconds on the runner) is cut to
    // nothing by a function that shadows `sleep`; the step is not touched.
    const script = `sleep() { :; }\n${commitScript()}`;
    assert.match(script, /for attempt in 1 2 3; do/);
    const runStep = () =>
      runBash(bash, script, { cwd: remote.work, env: remote.env });

    // Rejected once: the second try goes through.
    await rejectFirstPushes(remote, 1);
    await remote.write(
      remote.work,
      TRACKER_PATH,
      '{"courses":["AB-650T00"]}\n',
    );
    const retried = await runStep();
    assert.equal(retried.code, 0, retried.stderr);
    assert.deepEqual(await remote.subjects(), [
      "Update Learn content tracker",
      "init",
    ]);
    assert.equal(await pushAttempts(remote), 2);

    // Rejected three times: the step fails (the run is red, the next run tries again).
    await rejectFirstPushes(remote, 3);
    await remote.write(
      remote.work,
      TRACKER_PATH,
      '{"courses":["AB-651T00"]}\n',
    );
    const failed = await runStep();
    assert.notEqual(failed.code, 0, "three rejections are a failed step");
    assert.deepEqual(await remote.subjects(), [
      "Update Learn content tracker",
      "init",
    ]);
    assert.equal(await pushAttempts(remote), 3);
  },
);

test(
  "the commit step pushes only the tracker, rebases onto a concurrent push and skips an unchanged tracker",
  { skip: bashSkipReason(bash) },
  async (t) => {
    const remote = await makeScratchRemote({
      prefix: "learn-content-workflow-",
      files: { [TRACKER_PATH]: '{"courses":[]}\n' },
    });
    t.after(() => remote.cleanup());
    const script = commitScript();
    assert.match(
      script,
      /git add src\/data_files\/learn-content-watch\.json$/m,
      "only the tracker is staged",
    );
    const runStep = () =>
      runBash(bash, script, { cwd: remote.work, env: remote.env });

    const unchanged = await runStep();
    assert.equal(unchanged.code, 0, unchanged.stderr);
    assert.deepEqual(await remote.subjects(), ["init"]);

    // A stray file next to the tracker is not committed.
    await remote.write(remote.work, "stray.txt", "x\n");
    await remote.concurrentPush("notes.txt", "x\n");
    await remote.write(
      remote.work,
      TRACKER_PATH,
      '{"courses":["AB-650T00"]}\n',
    );

    const pushed = await runStep();
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.deepEqual(await remote.subjects(), [
      "Update Learn content tracker",
      "elsewhere",
      "init",
    ]);
    assert.equal(await remote.show(TRACKER_PATH), '{"courses":["AB-650T00"]}');
    assert.deepEqual(await remote.changedFiles(), [TRACKER_PATH]);
    assert.ok(!(await remote.files()).includes("stray.txt"));
  },
);

test("the Learn Content Watch runbook documents the monitor and the files it owns", () => {
  const runbook = readFileSync(
    join(root, "docs", "monitors", "learn-content-watch.md"),
    "utf8",
  );
  assert.match(runbook, /^# Learn Content Watch$/m);
  assert.ok(runbook.length > 500, "the runbook has content");
  for (const needle of [
    ".github/workflows/learn-content-watch.yml",
    "scripts/learn-content-watch.mjs",
    "src/data_files/learn-content-watch.json",
    "tests/scripts/learn-content-watch.test.mjs",
    "09:20 UTC",
    "force_baseline",
    "FORCE_BASELINE",
    "MIN_COURSES",
    "MAX_CHANGES",
    "FAILURE_DAYS",
    "Working the list",
    "node scripts/audit-missing-resources.mjs",
    "pnpm build",
  ]) {
    assert.ok(runbook.includes(needle), `the runbook is missing "${needle}"`);
  }
  assert.doesNotMatch(runbook, INTERNAL_WORDS);
});
