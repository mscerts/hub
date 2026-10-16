import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  AREA_BY_PREFIX,
  DRIFT_FAILED_ISSUE_TITLE,
  DRIFT_ISSUE_TITLE,
  IGNORED_PREFIXES,
  addDays,
  applyGuideResults,
  areaForCode,
  buildDriftComment,
  buildDriftReport,
  buildIssueTitle,
  buildReport,
  buildScan,
  classifyNotice,
  datedStatements,
  daysBetween,
  diffLines,
  driftSignature,
  evaluateDrift,
  evidenceOf,
  examCodeFromUid,
  formatDate,
  hashLines,
  htmlToLines,
  isCertificationPage,
  isIgnoredCode,
  isRealIsoDate,
  isUnmappedFamily,
  loadConfig,
  makeDeadline,
  mentionsDate,
  mergeCertRenames,
  mergeTracker,
  noticeBoxes,
  normalizeTracker,
  parseCertificationPage,
  parseCredentialsSitemap,
  parseDates,
  parseDriftMarker,
  parseExamNameFromTitle,
  parseHubPage,
  parseListing,
  parseSitemapIndex,
  parseStudyGuide,
  guideProbeTargets,
  probeTargets,
  renderDiff,
  runDriftCheck,
  selectAlerts,
  selectGuidesToFetch,
  splitBeta,
  studyGuideUrl,
  summarizeDiff,
  syncDriftFailureIssue,
  syncDriftIssue,
  trackerContent,
} from "../../scripts/new-exam-check.mjs";
import { AREA_BY_PREFIX as SHARED_AREA_BY_PREFIX } from "../../scripts/lib/areas.mjs";
import { findBetaNote, inspectBetaNote } from "../../scripts/lib/beta-note.mjs";
import { makeGh } from "../../scripts/lib/gh.mjs";
import { retryDelayMs } from "../../scripts/lib/retry.mjs";
import { AREA_MAP } from "../../scripts/new-exam.mjs";
import {
  bashSkipReason,
  findBash,
  makeScratchRemote,
  pushAttempts,
  rejectFirstPushes,
  runBash,
} from "./helpers/git-remote.mjs";

const root = resolve(import.meta.dirname, "../..");
const fixtureDir = join(root, "tests", "fixtures", "new-exam");
// LF whatever the checkout did to the files (core.autocrlf on Windows); a test
// below feeds the parser CRLF markup on purpose.
const fixture = (name) =>
  readFileSync(join(fixtureDir, name), "utf8").replace(/\r\n/g, "\n");

const tempDirs = [];
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Pure parsers, on trimmed copies of real Microsoft Learn markup
// ---------------------------------------------------------------------------
test("exam codes come from uids and the area comes from the code prefix", () => {
  assert.equal(examCodeFromUid("exam.ab-650"), "AB-650");
  assert.equal(examCodeFromUid("exam.AZ-104"), "AZ-104");
  assert.equal(examCodeFromUid("exam.77-726"), "77-726");
  assert.equal(examCodeFromUid("certification.azure-administrator"), null);
  assert.equal(examCodeFromUid(undefined), null);

  assert.equal(areaForCode("AZ-104"), "azure");
  assert.equal(areaForCode("DP-700"), "azure");
  assert.equal(areaForCode("AI-901"), "azure");
  assert.equal(areaForCode("AB-650"), "aibusiness");
  assert.equal(areaForCode("MB-500"), "dynamics");
  assert.equal(areaForCode("GH-300"), "github");
  assert.equal(areaForCode("MD-102"), "microsoft365");
  assert.equal(areaForCode("MS-700"), "microsoft365");
  assert.equal(areaForCode("PL-400"), "power");
  assert.equal(areaForCode("SC-200"), "security");
  assert.equal(areaForCode("MO-110"), null);
  assert.equal(areaForCode("77-726"), null);
});

test("ignored families are known-irrelevant; any other unmapped prefix is a new family", () => {
  for (const code of ["MO-110", "77-726", "98-366", "70-740", "62-193"]) {
    assert.ok(isIgnoredCode(code), code);
    assert.ok(!isUnmappedFamily(code), code);
  }
  for (const code of ["AZ-104", "AB-650", "GH-300"]) {
    assert.ok(!isIgnoredCode(code), code);
    assert.ok(!isUnmappedFamily(code), code);
  }
  for (const code of ["CP-100", "XY-200", "99-001"]) {
    assert.ok(isUnmappedFamily(code), code);
  }
  // A prefix is either mapped or ignored, never both.
  for (const prefix of IGNORED_PREFIXES) {
    assert.ok(!(prefix in AREA_BY_PREFIX), prefix);
  }
});

test("the checker and the page scaffold read the same map of exam prefixes, which neither of them copies", () => {
  // scripts/lib/areas.mjs holds the map: the checker re-exports it and the
  // scaffold calls it AREA_MAP, so there is nothing of its own to keep in sync.
  assert.equal(AREA_BY_PREFIX, SHARED_AREA_BY_PREFIX);
  assert.equal(AREA_MAP, SHARED_AREA_BY_PREFIX);
  assert.deepEqual(
    Object.entries(AREA_BY_PREFIX).sort(),
    Object.entries(AREA_MAP).sort(),
  );
  for (const [file, name] of [
    ["new-exam-check.mjs", "AREA_BY_PREFIX"],
    ["new-exam.mjs", "AREA_MAP"],
  ]) {
    const source = readFileSync(join(root, "scripts", file), "utf8");
    assert.doesNotMatch(source, new RegExp(`const ${name}\\s*=\\s*\\{`), file);
    assert.match(source, /from "\.\/lib\/areas\.mjs"/, file);
  }
});

test("the monitor takes its gh runner, issue lookups, retry delay, outputs, annotations and job summary from scripts/lib", () => {
  const source = readFileSync(
    join(root, "scripts", "new-exam-check.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /^(?:export )?(?:async )?function (?:makeGh|listOpenIssues|retryDelayMs|writeOutput|annotate)\b/m,
  );
  for (const lib of ["actions", "gh", "retry"]) {
    assert.match(source, new RegExp(`from "\\./lib/${lib}\\.mjs"`), lib);
  }
});

test("a deadline reports the time left and expires", () => {
  let now = 1000;
  const deadline = makeDeadline(500, () => now);
  assert.equal(deadline.expired(), false);
  assert.equal(deadline.remaining(), 500);
  now = 1499;
  assert.equal(deadline.expired(), false);
  now = 1500;
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.remaining(), 0);
});

test("a trailing (beta) marker is split off names and titles", () => {
  assert.deepEqual(splitBeta("Administering Microsoft 365 (beta)"), {
    text: "Administering Microsoft 365",
    beta: true,
  });
  assert.deepEqual(splitBeta("Microsoft 365 Certified:  Admin  Associate"), {
    text: "Microsoft 365 Certified: Admin Associate",
    beta: false,
  });
});

test("the listing keeps certifications and standalone exams and ignores the rest", () => {
  const { results } = JSON.parse(fixture("browse-sample.json"));
  // The hidden item has a slug of its own: only the `hidden` flag can drop it.
  const hidden = {
    ...results[0],
    uid: "certification.hidden",
    url: "/credentials/certifications/hidden/",
    hidden: true,
  };
  const { certifications, examinations } = parseListing([...results, hidden]);

  assert.equal(certifications.length, 5);
  assert.ok(!certifications.some((cert) => cert.slug === "hidden"));
  assert.ok(!certifications.some((cert) => cert.slug.startsWith("administer")));
  assert.deepEqual(
    examinations.map((exam) => exam.code),
    ["AB-650", "PL-400", "MO-110"],
  );

  const beta = certifications.find(
    (cert) => cert.slug === "ai-services-administrator-associate",
  );
  assert.equal(
    beta.title,
    "Microsoft 365 Certified: Microsoft 365 and AI Services Administrator Associate",
  );
  assert.equal(beta.beta, true);
  assert.deepEqual(beta.examCodes, ["AB-650"]);
  assert.ok(beta.products.includes("Microsoft Agent 365"));

  const mos = certifications.find((cert) => cert.types.includes("mos"));
  assert.deepEqual(mos.examCodes, ["MO-100", "MO-200", "MO-300"]);
  assert.deepEqual(
    certifications.find((cert) => cert.slug === "azure-administrator")
      .examCodes,
    [],
  );

  const ab650 = examinations.find((exam) => exam.code === "AB-650");
  assert.equal(ab650.name, "Administering Microsoft 365 and AI Services");
  assert.equal(ab650.beta, true);
  // A standalone item links its own exam page, so that page exists.
  assert.equal(ab650.examPage, true);
});

test("a repeated certification slug or exam code in the listing counts once", () => {
  const { results } = JSON.parse(fixture("browse-sample.json"));
  const cert = results.find((item) => item.uid.startsWith("certification."));
  const examination = results.find((item) => item.uid === "exam.ab-650");
  const once = parseListing(results);
  const twice = parseListing([...results, cert, examination, cert]);
  assert.equal(twice.certifications.length, once.certifications.length);
  assert.equal(twice.examinations.length, once.examinations.length);

  // An examination whose URL is not its own exam page is not proof of one.
  const odd = parseListing([
    { ...examination, uid: "exam.ab-651", url: "/somewhere/else/" },
  ]);
  assert.equal(odd.examinations[0].examPage, false);
});

test("a new-layout beta page yields the exam name, beta marker and announcement", () => {
  const html = fixture("cert-new-layout-beta.html");
  assert.ok(isCertificationPage(html));
  const page = parseCertificationPage(html);

  assert.equal(page.uid, "certification.ai-services-administrator-associate");
  assert.equal(page.beta, true);
  assert.deepEqual(page.exams, [
    {
      code: "AB-650",
      name: "Administering Microsoft 365 and AI Services",
      beta: true,
      betaKnown: true,
      examPage: true, // the card links ../exams/ab-650/
      // The card says "(beta)" and so does the callout that names the exam.
      evidence: ["card:beta", "callout:beta"],
    },
  ]);
  assert.equal(page.announcements.length, 1);
  assert.match(
    page.announcements[0].url,
    /^https:\/\/techcommunity\.microsoft\.com\/blog\/skills-hub-blog\//,
  );
  assert.deepEqual(page.announcements[0].codes, ["AB-650"]);
});

test("a classic page only exposes the exam code through the scheduling link", () => {
  const page = parseCertificationPage(fixture("cert-classic-layout.html"));
  // Nothing on a classic page says whether the exam is beta, or links an exam page.
  assert.deepEqual(page.exams, [
    {
      code: "AZ-104",
      name: "",
      beta: false,
      betaKnown: false,
      examPage: false,
      evidence: [], // a classic page says nothing about the beta status
    },
  ]);
  assert.equal(page.beta, false);
  assert.deepEqual(page.announcements, []);
});

test("a page with several exams lists them all, with and without a card name", () => {
  const page = parseCertificationPage(fixture("cert-multi-exam.html"));
  assert.deepEqual(
    page.exams.map((exam) => [exam.code, exam.name]),
    [
      ["PL-400", "Microsoft Power Platform Developer"],
      ["AB-400", ""],
    ],
  );
  // The transition notice on this page is not an announcement of a new exam.
  assert.deepEqual(page.announcements, []);

  // learn_exam metas alone are enough: MO-200 and MO-300 have no card here.
  const mos = parseCertificationPage(fixture("cert-mos-multi-exam.html"));
  assert.deepEqual(
    mos.exams.map((exam) => exam.code),
    ["MO-100", "MO-200", "MO-300"],
  );
});

test("an exam card without a name still yields its exam, from its text or its link", () => {
  const page = parseCertificationPage(
    '<meta name="uid" content="certification.x" />' +
      '<a class="exam-card-title" href="../exams/ab-651/">AB-651</a>' +
      '<a class="exam-card-title" href="../exams/ab-652/">Something &amp; more (beta)</a>' +
      '<a class="other" href="../exams/ab-653/">AB-653: Not a card</a>',
  );
  assert.deepEqual(page.exams, [
    {
      code: "AB-651",
      name: "",
      beta: false,
      betaKnown: true,
      examPage: true,
      evidence: ["card:ga"],
    },
    {
      code: "AB-652",
      name: "Something & more",
      beta: true,
      betaKnown: true,
      examPage: true,
      evidence: ["card:beta"],
    },
  ]);

  // A card whose link points elsewhere still names the exam, but proves no exam page.
  const odd = parseCertificationPage(
    '<meta name="uid" content="certification.x" />' +
      '<a class="exam-card-title" href="https://example.com/x">AB-654: Name</a>',
  );
  assert.deepEqual(odd.exams, [
    {
      code: "AB-654",
      name: "Name",
      beta: false,
      betaKnown: true,
      examPage: false,
      evidence: ["card:ga"],
    },
  ]);
});

test("a beta callout names the exam it announces, a page without exams yields none", () => {
  const page = parseCertificationPage(
    fixture("cert-classic-announcement.html"),
  );
  assert.deepEqual(page.exams, [
    {
      code: "AB-210",
      name: "",
      beta: true,
      betaKnown: true,
      examPage: false,
      evidence: ["callout:beta"],
    },
  ]);
  assert.equal(
    page.announcements[0].url,
    "https://aka.ms/AB210CertificationBetaBlog",
  );

  const none = parseCertificationPage(fixture("cert-no-exam.html"));
  assert.deepEqual(none.exams, []);
  assert.ok(isCertificationPage(fixture("cert-no-exam.html")));
  assert.ok(
    !isCertificationPage("<html><title>Just a moment...</title></html>"),
  );
});

test("a certification page that lists no exam any other way still names the exam in its callout and study guide card", () => {
  // The beta certification of GH-700 (2026-10-14): no scheduling link, no
  // learn_exam meta and no exam card yet, only a callout and a resource card.
  const html = fixture("cert-new-layout-beta-callout-only.html");
  assert.ok(isCertificationPage(html));
  const page = parseCertificationPage(html);
  assert.equal(page.uid, "certification.agentic-ai-business-professional");
  assert.equal(
    page.title,
    "GitHub Certified: Agentic AI Business Professional",
  );
  assert.equal(page.beta, true);
  assert.deepEqual(page.exams, [
    {
      code: "GH-700",
      name: "",
      beta: true,
      betaKnown: true,
      examPage: false,
      evidence: ["callout:beta"],
    },
  ]);
  assert.deepEqual(page.announcements, [
    {
      url: "https://aka.ms/GH700CertificationBetaBlog",
      text: "Learn more about the beta exam GH-700",
      codes: ["GH-700"],
    },
  ]);

  // The "Exam GH-700 study guide" card alone is enough, and says nothing about beta.
  const cardOnly = parseCertificationPage(
    html.replace(/<div class="IMPORTANT">[\s\S]*?<\/div>/, ""),
  );
  assert.deepEqual(cardOnly.exams, [
    {
      code: "GH-700",
      name: "",
      beta: false,
      betaKnown: false,
      examPage: false,
      evidence: [],
    },
  ]);

  // An ordinary callout about a new exam names it too.
  const fresh = parseCertificationPage(
    '<meta name="uid" content="certification.x" /><div class="NOTE"><p><a href="https://example.com/a" data-linktype="external">Learn more about the new exam AB-777</a></p></div>',
  );
  assert.deepEqual(
    fresh.exams.map((exam) => exam.code),
    ["AB-777"],
  );

  // Where the page lists an exam, a code in a callout or a card may belong to
  // another exam (a replacement, say) and is not taken for one of this page.
  const listed = parseCertificationPage(
    html.replace(
      "<main>",
      '<main><a class="exam-card-title" href="../exams/gh-701/">GH-701: Listed one</a>',
    ),
  );
  assert.deepEqual(
    listed.exams.map((exam) => exam.code),
    ["GH-701"],
  );
  assert.deepEqual(listed.announcements[0].codes, []);

  // A callout without the words "beta exam" / "new exam" before the code names nothing.
  const vague = parseCertificationPage(
    '<meta name="uid" content="certification.x" /><div class="NOTE"><p><a href="https://example.com/a" data-linktype="external">Read the beta announcement for AB-778</a></p></div>',
  );
  assert.deepEqual(vague.exams, []);
});

test("the study guide page of an UPCOMING exam is worth a request unless the sitemap lists it", () => {
  const hub = makeHub({
    pages: ["AB-1", "GH-3", "GH-4", "AZ-4"].map((code) =>
      hubPage(code, { name: "X" }),
    ),
    statuses: {
      "GH-3": "UPCOMING",
      "GH-4": "UPCOMING",
      "AB-1": "BETA",
      "AZ-4": "RETIRING",
    },
  });
  const targets = probeTargets(hub);
  assert.deepEqual(targets, ["AB-1", "GH-3", "GH-4"]);
  assert.deepEqual([...guideProbeTargets(hub, targets)], ["GH-3", "GH-4"]);
  assert.deepEqual(
    [...guideProbeTargets(hub, targets, new Set(["GH-3"]))],
    ["GH-4"],
  );
});

test("a study guide page found by a probe makes an exam, with the name of its title, but never an exam page", () => {
  const scan = buildScan({
    certifications: [],
    examinations: [],
    pages: new Map(),
    previous: { certifications: [], exams: [], studyGuides: [] },
    probes: new Map([
      ["GH-9", { guide: true, guideName: "Agentic AI" }],
      ["GH-8", { guide: false, guideName: "" }],
      ["GH-7", { page: false }],
    ]),
  });
  assert.deepEqual([...scan.exams.keys()], ["GH-9"]);
  const found = scan.exams.get("GH-9");
  assert.equal(found.name, "Agentic AI");
  assert.equal(found.studyGuide, true);
  assert.equal(found.guideOnly, true);
  assert.equal(found.examPage, false);
  assert.deepEqual([...found.evidence], []);
  assert.deepEqual(evidenceOf(found), ["study guide"]);
});

test("exam names come from study guide and exam page titles", () => {
  const guide =
    "<title>Study guide for Exam AZ-104: Microsoft Azure Administrator | Microsoft Learn</title>";
  assert.deepEqual(parseExamNameFromTitle(guide, "AZ-104"), {
    name: "Microsoft Azure Administrator",
    beta: false,
  });
  const exam =
    "<title>Exam AB-650: Administering Microsoft 365 and AI Services (beta) - Certifications | Microsoft Learn</title>";
  assert.deepEqual(parseExamNameFromTitle(exam, "AB-650"), {
    name: "Administering Microsoft 365 and AI Services",
    beta: true,
  });
  // A redirect to the certification page is not an exam name.
  const cert =
    "<title>Microsoft Certified: Azure Administrator Associate - Certifications | Microsoft Learn</title>";
  assert.equal(parseExamNameFromTitle(cert, "AZ-104"), null);
  assert.equal(parseExamNameFromTitle(guide, "AZ-105"), null);
});

test("Retry-After is honoured in seconds and as a date, and always capped", () => {
  const opts = {
    baseMs: 1000,
    maxMs: 60000,
    now: Date.parse("2026-10-09T06:00:00Z"),
  };
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "7", ...opts }), 7000);
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Fri, 09 Oct 2026 06:00:30 GMT",
      ...opts,
    }),
    30000,
  );
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "3600", ...opts }),
    60000,
  );
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Thu, 01 Jan 2026 00:00:00 GMT",
      ...opts,
    }),
    0,
  );
  // No (or unusable) header: exponential backoff from the base, also capped.
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: null, ...opts }), 1000);
  assert.equal(retryDelayMs({ attempt: 3, retryAfter: "soon", ...opts }), 4000);
  assert.equal(retryDelayMs({ attempt: 10, retryAfter: null, ...opts }), 60000);
});

test("the tracker comparison ignores lastSeen so an unchanged Learn writes nothing", () => {
  const previous = {
    certifications: [],
    exams: [
      {
        code: "AZ-901",
        name: "Exam",
        beta: false,
        betaEvidence: ["listing:ga"],
        certifications: [],
        products: [],
        url: "u",
        announcements: [],
        firstSeen: "2026-10-01",
        lastSeen: "2026-10-01",
      },
    ],
  };
  const scan = buildScan({
    certifications: [],
    examinations: [{ code: "AZ-901", name: "Exam", beta: false, products: [] }],
    pages: new Map(),
    previous,
  });
  const next = mergeTracker(previous, scan, "2026-10-09");
  assert.equal(next.exams[0].lastSeen, "2026-10-09");
  assert.equal(next.exams[0].firstSeen, "2026-10-01");
  assert.equal(trackerContent(next).includes("2026-10-09"), false);
  assert.equal(
    trackerContent(next),
    trackerContent({
      certifications: [],
      exams: [{ ...previous.exams[0], url: next.exams[0].url }],
    }),
  );
});

test("a certification missing from today's listing stays linked to its exams", () => {
  const link = (slug) => ({ slug, title: slug.toUpperCase() });
  const previous = {
    certifications: [],
    exams: [
      {
        code: "AZ-901",
        name: "",
        beta: false,
        certifications: [link("a"), link("b")],
        products: [],
        url: "u",
        announcements: [],
        firstSeen: "2026-10-01",
        lastSeen: "2026-10-01",
      },
    ],
  };
  const scan = {
    certs: new Map([["b", {}]]),
    exams: new Map([
      [
        "AZ-901",
        {
          name: "",
          beta: false,
          betaKnown: false,
          certs: new Map([["b", "B"]]),
          products: new Set(),
          announcements: new Map(),
        },
      ],
    ]),
  };
  const merged = mergeTracker(previous, scan, "2026-10-09");
  assert.deepEqual(
    merged.exams[0].certifications.map((cert) => cert.slug),
    ["a", "b"],
  );
});

test("a beta certification with one exam makes that exam beta; a failed page keeps the previous exams", () => {
  const certifications = [
    {
      slug: "a",
      uid: "certification.a",
      title: "A",
      beta: true,
      products: [],
      types: ["certification"],
      examCodes: [],
    },
    {
      slug: "b",
      uid: "certification.b",
      title: "B",
      beta: false,
      products: [],
      types: ["certification"],
      examCodes: [],
    },
  ];
  const previous = {
    certifications: [
      {
        slug: "b",
        title: "B",
        beta: false,
        products: [],
        exams: ["SC-901", "SC-902"],
        firstSeen: "2026-10-01",
        lastSeen: "2026-10-01",
      },
    ],
    exams: [],
  };
  const pages = new Map([
    [
      "a",
      {
        uid: "certification.a",
        title: "A",
        beta: true,
        exams: [{ code: "AB-901", name: "", beta: false }],
        announcements: [],
      },
    ],
  ]);
  const scan = buildScan({ certifications, examinations: [], pages, previous });
  assert.equal(scan.exams.get("AB-901").beta, true);
  assert.deepEqual([...scan.certs.get("b").exams].sort(), ["SC-901", "SC-902"]);
  assert.equal(scan.warnings.length, 1);
  assert.match(scan.warnings[0], /kept the previous exam list/);
});

test("the beta status is only known when a source says so, and pages that lost their exams are counted", () => {
  const day = "2026-10-01";
  const item = (slug) => ({
    slug,
    uid: `certification.${slug}`,
    title: slug,
    beta: false,
    products: [],
    types: ["certification"],
    examCodes: [],
  });
  const known = (slug, exams) => ({
    slug,
    title: slug,
    beta: false,
    products: [],
    exams,
    firstSeen: day,
    lastSeen: day,
  });
  const page = (exams) => ({
    uid: null,
    title: "",
    beta: false,
    exams,
    announcements: [],
  });
  const bare = (code) => ({
    code,
    name: "",
    beta: false,
    betaKnown: false,
    examPage: false,
  });
  const scan = buildScan({
    certifications: ["had", "also", "none", "card"].map(item),
    examinations: [],
    pages: new Map([
      ["had", page([])], // the tracker knew AZ-901: the page lost it
      ["also", page([bare("AZ-902")])],
      ["none", page([])], // never had an exam (like the mos-* pages)
      [
        "card",
        page([
          {
            code: "AZ-903",
            name: "Named",
            beta: false,
            betaKnown: true,
            examPage: true,
          },
        ]),
      ],
    ]),
    previous: {
      certifications: [known("had", ["AZ-901"]), known("also", ["AZ-902"])],
      exams: [],
    },
  });

  assert.deepEqual(scan.emptyPages, ["had"]);
  assert.equal(scan.knownWithExams, 2);
  assert.deepEqual(scan.noExamPages, ["had", "none"]);
  assert.equal(scan.exams.get("AZ-901").betaKnown, false); // carried forward
  assert.equal(scan.exams.get("AZ-902").betaKnown, false); // a bare scheduling link
  assert.equal(scan.exams.get("AZ-902").examPage, false);
  assert.equal(scan.exams.get("AZ-903").betaKnown, true); // an exam card
  assert.equal(scan.exams.get("AZ-903").examPage, true);
});

test("the tracker stores an exam page only when it is confirmed, and keeps a status it knew", () => {
  const day = "2026-10-01";
  const record = (code, extra) => ({
    code,
    name: "",
    beta: false,
    certifications: [],
    products: [],
    url: "",
    announcements: [],
    firstSeen: day,
    lastSeen: day,
    ...extra,
  });
  const confirmed =
    "https://learn.microsoft.com/credentials/certifications/exams/az-902?WT.mc_id=studentamb_165290";
  const previous = {
    certifications: [],
    exams: [
      record("AZ-901", { beta: true }),
      record("AZ-902", { url: confirmed }),
      record("AZ-905", { beta: true }),
    ],
  };
  const seen = (extra) => ({
    name: "",
    beta: false,
    betaKnown: false,
    examPage: false,
    certs: new Map(),
    products: new Set(),
    announcements: new Map(),
    ...extra,
  });
  const merged = mergeTracker(
    previous,
    {
      certs: new Map(),
      exams: new Map([
        ["AZ-901", seen()], // status not stated today: it stays beta
        ["AZ-902", seen()], // no link today: the earlier confirmation stays
        ["AZ-903", seen({ examPage: true })],
        ["AZ-904", seen()], // never confirmed: no guessed URL
        ["AZ-905", seen({ betaKnown: true })], // an exam card now says GA
      ]),
    },
    "2026-10-09",
  );
  const byCode = Object.fromEntries(merged.exams.map((e) => [e.code, e]));
  assert.equal(byCode["AZ-901"].beta, true);
  assert.equal(byCode["AZ-905"].beta, false); // a stated status replaces the old one
  assert.equal(byCode["AZ-902"].url, confirmed);
  assert.equal(
    byCode["AZ-903"].url,
    "https://learn.microsoft.com/credentials/certifications/exams/az-903?WT.mc_id=studentamb_165290",
  );
  assert.equal(byCode["AZ-904"].url, "");
});

test("a failed exam page probe is no evidence: the exam-page tags of the last reading stay, an answer replaces them, an exam that is not probed loses them", () => {
  const day = "2026-10-01";
  const record = (code, betaEvidence) => ({
    code,
    name: "Named",
    beta: true,
    betaEvidence,
    certifications: [{ slug: "c", title: "C" }],
    products: [],
    url: "",
    announcements: [],
    firstSeen: day,
    lastSeen: day,
  });
  const previous = {
    certifications: [
      {
        slug: "c",
        title: "C",
        beta: false,
        products: [],
        exams: ["AB-7", "AB-8", "AB-9"],
        firstSeen: day,
        lastSeen: day,
      },
    ],
    exams: [
      record("AB-7", ["exam-page:beta"]),
      record("AB-8", ["exam-page:beta"]),
      record("AB-9", ["callout:beta", "exam-page:beta"]),
    ],
  };
  // Today's certification page lists the three exams and says nothing about beta.
  const bare = (code) => ({
    code,
    name: "Named",
    beta: false,
    betaKnown: false,
    examPage: false,
    evidence: [],
  });
  const pages = new Map([
    [
      "c",
      {
        uid: "certification.c",
        title: "C",
        beta: false,
        exams: ["AB-7", "AB-8", "AB-9"].map(bare),
        announcements: [],
      },
    ],
  ]);
  const certifications = [
    {
      slug: "c",
      uid: "certification.c",
      title: "C",
      beta: false,
      products: [],
      types: ["certification"],
      examCodes: [],
    },
  ];
  const evidence = (probes, probeCodes = ["AB-7", "AB-8"]) => {
    const scan = buildScan({
      certifications,
      examinations: [],
      pages,
      previous,
      probes,
      probeCodes,
    });
    return Object.fromEntries(
      mergeTracker(previous, scan, "2026-10-09").exams.map((exam) => [
        exam.code,
        exam.betaEvidence,
      ]),
    );
  };

  // AB-7's probe failed (a 5xx, a timeout or the deadline: it has no entry), AB-8's answered GA.
  const failed = evidence(
    new Map([["AB-8", { page: true, name: "Named", beta: false }]]),
  );
  assert.deepEqual(failed["AB-7"], ["exam-page:beta"]);
  assert.deepEqual(failed["AB-8"], ["exam-page:ga"]);
  // AB-9 is not probed any more (the hub dropped its BETA badge): its old tags go, as before.
  assert.deepEqual(failed["AB-9"], []);
  // Every probe failed: the exam-page tags of both stay.
  const allFailed = evidence(new Map());
  assert.deepEqual(allFailed["AB-7"], ["exam-page:beta"]);
  assert.deepEqual(allFailed["AB-8"], ["exam-page:beta"]);
  // A study guide answer without an exam page one leaves the exam page part out too.
  assert.deepEqual(
    evidence(new Map([["AB-7", { guide: true, guideName: "Named" }]]))["AB-7"],
    ["exam-page:beta"],
  );
  // "There is no exam page" (404) is an answer: the old tag goes.
  assert.deepEqual(evidence(new Map([["AB-7", { page: false }]]))["AB-7"], []);

  // The consequence in the drift check: a BETA exam whose only strong marker is
  // its exam page title is not "unconfirmed" on a day its probe failed.
  const hub = makeHub({
    pages: [hubPage("AB-7", { name: "Named" })],
    statuses: { "AB-7": "BETA" },
  });
  const rows = (tags) =>
    kinds(
      drift(
        hub,
        makeTracker({ exams: [{ code: "AB-7", betaEvidence: tags }] }),
      ),
    );
  assert.deepEqual(rows(failed["AB-7"]), []);
  assert.deepEqual(rows(evidence(new Map(), [])["AB-7"]), ["check:beta:AB-7"]);
});

test("a new exam family is alerted, while Office and legacy families and empty MOS certifications stay silent", () => {
  const cert = (exams, types = ["certification"]) => ({
    exams: new Set(exams),
    types,
  });
  const scan = {
    certs: new Map([
      ["mos-empty", cert([], ["certification", "mos"])],
      ["family", cert(["CP-100"])],
      ["mixed", cert(["MO-100", "CP-101"])],
      ["office", cert(["MO-100", "77-200"])],
    ]),
  };
  const result = selectAlerts({
    newExamCodes: ["CP-100", "98-366", "CP-101", "70-740", "MO-100"],
    newCertSlugs: ["mos-empty", "family", "mixed", "office"],
    scan,
    hubPage: () => false,
  });
  assert.deepEqual(result.alertExams, ["CP-100", "CP-101"]);
  assert.deepEqual(
    result.silentExams.map((entry) => entry.code),
    ["98-366", "70-740", "MO-100"],
  );
  assert.deepEqual(result.alertCerts, ["family", "mixed"]);
  assert.deepEqual(
    result.silentCerts.map((entry) => entry.slug),
    ["mos-empty", "office"],
  );
});

test("alert selection skips hub pages, other families and MOS certifications", () => {
  const cert = (exams, types = ["certification"]) => ({
    exams: new Set(exams),
    types,
  });
  const scan = {
    certs: new Map([
      ["covered", cert(["AZ-904"])],
      ["mos", cert(["MO-904"], ["certification", "mos"])],
      ["office", cert(["MO-905"])],
      ["empty", cert([])],
      ["real", cert(["AZ-903"])],
    ]),
  };
  const result = selectAlerts({
    newExamCodes: ["AZ-903", "AZ-904", "MO-904", "77-900"],
    newCertSlugs: ["covered", "mos", "office", "empty", "real"],
    scan,
    hubPage: (code) => code === "AZ-904",
  });
  assert.deepEqual(result.alertExams, ["AZ-903"]);
  assert.deepEqual(
    result.silentExams.map((entry) => entry.code),
    ["AZ-904", "MO-904", "77-900"],
  );
  assert.deepEqual(result.alertCerts, ["covered", "empty", "real"]);
  assert.deepEqual(
    result.silentCerts.map((entry) => entry.slug),
    ["mos", "office"],
  );
});

test("issue titles name the exam codes in their original case and stay on one line", () => {
  assert.equal(
    buildIssueTitle({
      exams: [{ code: "AB-650", beta: true }],
      certs: [],
    }),
    "New Microsoft Learn exam: AB-650 (beta)",
  );
  assert.equal(
    buildIssueTitle({
      exams: [
        { code: "AZ-901", beta: false },
        { code: "SC-902", beta: true },
      ],
      certs: [{ title: "X" }],
    }),
    "New Microsoft Learn exams: AZ-901, SC-902 (beta); 1 new certification",
  );
  const many = Array.from({ length: 9 }, (_, i) => ({
    code: `AZ-90${i}`,
    beta: false,
  }));
  assert.match(buildIssueTitle({ exams: many, certs: [] }), / \+3 more$/);
  assert.equal(
    buildIssueTitle({
      exams: [],
      certs: [{ title: "Microsoft Certified:\nSomething\r\nNew" }],
    }),
    "New Microsoft Learn certification: Microsoft Certified: Something New",
  );
});

test("the report names the checklist, the beta start date rule and nothing private", () => {
  const exam = {
    code: "AB-960",
    name: "Pipes | and brackets [x]",
    beta: true,
    certifications: [{ slug: "new-cert", title: "New Cert" }],
    products: ["Microsoft 365"],
    url: "https://learn.microsoft.com/credentials/certifications/exams/ab-960?WT.mc_id=studentamb_165290",
    announcements: [],
    firstSeen: "2026-10-09",
  };
  const scan = {
    exams: new Map([
      [
        "AB-960",
        {
          announcements: new Map([["https://example.com/a(1) b", "Beta post"]]),
        },
      ],
    ]),
  };
  const report = buildReport({
    exams: [exam],
    certs: [],
    scan,
    today: "2026-10-09",
  });
  // Learn text in a cell: the pipe is escaped, brackets cannot open a link.
  assert.match(report, /\| AB-960 \| Pipes \\\| and brackets x \| BETA \|/);
  assert.match(report, /\[Beta post\]\(https:\/\/example\.com\/a%281%29%20b\)/);
  assert.match(report, /src\/content\/docs\/aibusiness\/AB-960\.mdx/);
  // The command keeps the name as it is (it is pasted into a shell) and asks for the beta start.
  assert.match(
    report,
    /node scripts\/new-exam\.mjs --code AB-960 --name "Pipes \| and brackets \[x\]" --beta --beta-start <YYYY-MM-DD>\n/,
  );
  assertChecklist(report);
});

test("the report says GA only when known, and links only pages that exist", () => {
  const exam = (code, extra = {}) => ({
    code,
    name: "N",
    beta: false,
    betaKnown: false,
    certifications: [{ slug: "c", title: "C" }],
    products: [],
    url: "",
    announcements: [],
    firstSeen: "2026-10-09",
    ...extra,
  });
  const confirmed =
    "https://learn.microsoft.com/credentials/certifications/exams/az-961?WT.mc_id=studentamb_165290";
  const report = buildReport({
    exams: [
      exam("AZ-961", { betaKnown: true, url: confirmed }),
      exam("AZ-962"),
      exam("AZ-963", { certifications: [{ slug: "b", title: "B" }] }),
      exam("AZ-964", { certifications: [] }),
      exam("CP-100"),
    ],
    certs: [],
    scan: {
      exams: new Map(),
      certs: new Map([["b", { beta: true }]]),
    },
    today: "2026-10-09",
  });

  assert.match(report, /\| AZ-961 \| N \| GA \|/);
  assert.match(report, /\| AZ-962 \| N \| unknown, check Learn \|/);
  assert.match(
    report,
    /\| AZ-963 \| N \| unknown \(its certification is BETA\), check Learn \|/,
  );
  assert.ok(report.includes(`[Exam page](${confirmed})`));
  assert.ok(
    report.includes(
      "[Certification page](https://learn.microsoft.com/credentials/certifications/c/?WT.mc_id=studentamb_165290) (no exam page confirmed)",
    ),
  );
  // The exam page of an exam nobody confirmed is never linked.
  assert.doesNotMatch(report, /exams\/az-962|exams\/az-963|exams\/az-964/);
  // Without a status the command does not guess --beta.
  assert.match(report, /--code AZ-962 --name "N"\n/);

  // A family without a hub area gets no scaffold command and a decision note.
  assert.match(report, /\| CP-100 \| N \| unknown, check Learn \|/);
  assert.match(report, /no hub area for this prefix/);
  assert.match(report, /### Exam families without a hub area/);
  assert.match(report, /- `CP-100` \(prefix `CP`\)/);
  // One map for the monitor and the scaffold: that is where a prefix goes.
  assert.match(
    report,
    /`AREA_BY_PREFIX` in `scripts\/lib\/areas\.mjs`[\s\S]*`IGNORED_PREFIXES`/,
  );
  assert.doesNotMatch(report, /AREA_MAP/);
  assert.doesNotMatch(report, /new-exam\.mjs --code CP-100/);
  assert.doesNotMatch(report, /\bnull\b|undefined/);

  // The scaffold's guessed link is called out, and the beta box is no longer a banner to replace.
  assert.match(report, /guesses the `Exam` link/);
  assert.match(report, /\*\*Exam link\*\* column/);
  assert.doesNotMatch(report, /BetaBanner/);
  assert.match(report, /standard `:::tip` beta text/);
  assertChecklist(report);

  const only = buildReport({
    exams: [exam("CP-100")],
    certs: [],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  assert.match(only, /### Exam families without a hub area/);
  assert.doesNotMatch(only, /### Checklist/);
  assert.doesNotMatch(only, /new-exam\.mjs --code/);
});

test("a new certification lists exams without a hub area as such", () => {
  const report = buildReport({
    exams: [],
    certs: [
      {
        slug: "x",
        title: "X",
        beta: false,
        exams: ["CP-100", "MO-100", "AZ-904"],
        products: [],
        firstSeen: "2026-10-09",
      },
    ],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
    hubPage: (code) => code === "AZ-904",
  });
  assert.match(
    report,
    /CP-100 \(no hub area\), MO-100, AZ-904 \(hub page exists\)/,
  );
});

test("an issue title never exceeds 200 characters", () => {
  const title = buildIssueTitle({
    exams: [],
    certs: [{ title: "x".repeat(300) }],
  });
  assert.equal(title.length, 200);
  assert.ok(title.endsWith("…"));
  assert.ok(
    buildIssueTitle({ exams: [{ code: "AZ-901", beta: false }], certs: [] })
      .length < 200,
  );
});

// ---------------------------------------------------------------------------
// Study guides: sitemap, page text, hash and diff, on trimmed real markup
// ---------------------------------------------------------------------------
const guideFixture = (name, code) => parseStudyGuide(fixture(name), code);

test("a guide with both sections yields its name, page date, text lines and a stable hash", () => {
  const guide = guideFixture("study-guide-az-104.html", "AZ-104");
  assert.equal(guide.ok, true);
  assert.equal(guide.name, "Microsoft Azure Administrator");
  assert.equal(guide.updatedAt, "2026-03-19T18:11:00Z");
  assert.deepEqual(guide.missing, []);
  assert.equal(guide.lines[0], "## Updates to the exam");
  assert.ok(guide.lines.includes("## Skills measured as of April 17, 2026"));
  assert.ok(guide.lines.includes("### Implement and manage storage (15–20%)"));
  assert.ok(
    guide.lines.includes(
      "- Configure Azure Storage firewalls and virtual networks",
    ),
  );
  // One line per paragraph, list item or heading: Learn's hard line breaks are gone.
  assert.ok(
    guide.lines.every((line) => !line.includes("\n") && line === line.trim()),
  );
  // Nothing of what is not hashed: purpose, study resources, change log, chrome.
  const text = guide.lines.join("\n");
  assert.doesNotMatch(
    text,
    /Purpose of this document|Study resources|Change log|Skill area prior to|self-paced|Feedback|Summarize this article/,
  );
  assert.equal(guide.hash, hashLines(guide.lines));
  assert.match(guide.hash, /^[0-9a-f]{64}$/);
  assert.equal(
    guideFixture("study-guide-az-104.html", "AZ-104").hash,
    guide.hash,
  );
});

test("odd layouts keep every skills part: stray h2s, a Domains heading, two versions, a title without Exam", () => {
  // GH-500: an <h2> in the middle of the skills text does not end the section.
  const gh500 = guideFixture("study-guide-gh-500.html", "GH-500");
  const stray = gh500.lines.indexOf(
    "## Manage and respond to Secret Protection alerts",
  );
  assert.ok(stray > 0);
  assert.ok(
    gh500.lines
      .slice(stray)
      .includes("- Create and manage custom secret patterns"),
  );
  assert.ok(gh500.lines.includes("## Skills measured as of July 2026"));

  // GH-900: "About the exam" is the updates section, the skills sit under "Domains".
  const gh900 = guideFixture("study-guide-gh-900.html", "GH-900");
  assert.equal(gh900.lines[0], "## Updates to the exam");
  assert.ok(gh900.lines.includes("## Domains"));
  assert.ok(gh900.lines.includes("## Repository management"));
  assert.deepEqual(gh900.missing, []);

  // PL-600: "Study guide for PL-600:" has no "Exam"; the older skills version
  // comes after the change log and still counts.
  const pl600 = guideFixture("study-guide-pl-600.html", "PL-600");
  assert.equal(pl600.ok, true);
  assert.equal(pl600.name, "Microsoft Power Platform Solution Architect");
  const current = pl600.lines.indexOf(
    "## Skills measured as of September 23, 2024",
  );
  const prior = pl600.lines.indexOf(
    "## Skills measured prior to September 23, 2024",
  );
  assert.ok(current > 0 && prior > current);
  assert.ok(pl600.lines.includes("## Identify existing solutions and systems"));
  assert.doesNotMatch(pl600.lines.join("\n"), /Change log|Study resources/);
});

test("a guide without a section says so, and a page that is not that guide or holds nothing is not ok", () => {
  const noSkills = guideFixture("study-guide-no-skills.html", "AZ-104");
  assert.equal(noSkills.ok, true);
  assert.deepEqual(noSkills.missing, ["skills"]);
  assert.match(noSkills.hash, /^[0-9a-f]{64}$/);
  assert.ok(noSkills.lines.every((line) => !/Skills measured/.test(line)));

  const az = fixture("study-guide-az-104.html");
  const wrong = parseStudyGuide(az, "AZ-105");
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /not the study guide page of AZ-105/);
  assert.equal(wrong.hash, null);

  // Nothing here may throw, and nothing may produce a hash to alert on.
  for (const html of [
    "",
    undefined,
    null,
    "<<<>>>",
    "<html><title>Just a moment...</title></html>",
    "<title>Study guide for Exam AZ-104: Name | Microsoft Learn</title><div class='content'><h2 id='purpose-of-this-document'>Purpose</h2><p>x</p></div>",
  ]) {
    const guide = parseStudyGuide(html, "AZ-104");
    assert.equal(guide.ok, false, String(html));
    assert.equal(guide.hash, null);
    assert.deepEqual(guide.lines, []);
  }
  assert.match(
    parseStudyGuide(
      "<title>Study guide for Exam AZ-104: Name | Microsoft Learn</title><div class='content'><h2 id='study-resources'>R</h2></div>",
      "AZ-104",
    ).reason,
    /neither an Updates to the exam nor a Skills measured section/,
  );
});

test("the hash ignores everything but the text: wrapping, ids, links, chrome, dates, study resources and change log", () => {
  const base = guideSpec({ name: "Azure Role 1" });
  const hashOf = (spec) =>
    parseStudyGuide(guideHtml("AZ-901", spec), "AZ-901").hash;
  const reference = hashOf(base);
  assert.match(reference, /^[0-9a-f]{64}$/);

  // Only churn: same hash.
  assert.equal(hashOf({ ...base, noise: 7 }), reference);
  assert.equal(hashOf({ ...base, rewrap: true }), reference);
  assert.equal(hashOf({ ...base, rewrap: true, noise: 3 }), reference);
  assert.equal(hashOf({ ...base, updatesId: "about-the-exam" }), reference);
  // MB-310: the change log follows the skills directly, and still stays out.
  assert.equal(hashOf({ ...base, noStudyResources: true }), reference);
  assert.equal(
    hashOf({ ...base, noStudyResources: true, noise: 7 }),
    reference,
  );
  assert.equal(
    hashOf({ ...base, updatedAt: "2026-10-01T00:00:00Z" }),
    reference,
  );
  assert.equal(hashOf({ ...base, lastmod: "2026-10-01" }), reference);

  // The text itself: a different hash.
  const [first, second] = base.groups;
  for (const changed of [
    {
      ...base,
      groups: [
        { ...first, bullets: ["Do A1", "Do A2 changed", "Do A3"] },
        second,
      ],
    },
    { ...base, groups: [first] },
    { ...base, heading: "Skills measured as of October 14, 2026" },
    { ...base, updates: [...base.updates, "One more sentence."] },
    { ...base, skillsMissing: true },
  ]) {
    assert.notEqual(hashOf(changed), reference);
  }
});

test("notice boxes are guide text: real retirement warnings before the first heading and under Purpose are hashed", () => {
  // AZ-801 (real markup): the WARNING sits right after the content block opens.
  const az801 = guideFixture("study-guide-az-801.html", "AZ-801");
  assert.equal(az801.ok, true);
  assert.deepEqual(az801.lines.slice(0, 4), [
    "## Notices",
    "Warning",
    "This exam was retired on September 30, 2026, at 5:00 PM Central Standard Time. Learn more.",
    "## Updates to the exam",
  ]);
  assert.deepEqual(az801.missing, []);
  const withoutBox = fixture("study-guide-az-801.html").replace(
    /<div class="WARNING">[\s\S]*?<\/div>\n/,
    "",
  );
  const bare = parseStudyGuide(withoutBox, "AZ-801");
  assert.equal(bare.lines[0], "## Updates to the exam");
  assert.deepEqual(bare.lines, az801.lines.slice(3));
  // Adding or removing the notice changes the hash; a different link target does not.
  assert.notEqual(bare.hash, az801.hash);
  assert.equal(
    parseStudyGuide(
      fixture("study-guide-az-801.html").replace("4494128", "9999999"),
      "AZ-801",
    ).hash,
    az801.hash,
  );

  // PL-600 (real markup): the WARNING is under "Purpose of this document".
  const pl600 = guideFixture("study-guide-pl-600.html", "PL-600");
  assert.deepEqual(pl600.lines.slice(0, 3), [
    "## Notices",
    "Warning",
    "This exam was retired on June 30, 2026, at 11:59 PM Central Standard Time. Learn more.",
  ]);
  assert.doesNotMatch(pl600.lines.join("\n"), /Purpose of this document/);

  // A guide without a box has no Notices part at all.
  assert.ok(
    !guideFixture("study-guide-az-104.html", "AZ-104").lines.includes(
      "## Notices",
    ),
  );
});

test("a guide served with CRLF line ends reads exactly like the same guide with LF", () => {
  for (const [name, code] of [
    ["study-guide-az-104.html", "AZ-104"],
    ["study-guide-az-801.html", "AZ-801"],
    ["study-guide-pl-600.html", "PL-600"],
    ["study-guide-gh-900.html", "GH-900"],
  ]) {
    const lf = parseStudyGuide(fixture(name), code);
    const crlf = parseStudyGuide(fixture(name).replace(/\n/g, "\r\n"), code);
    assert.equal(crlf.ok, true, name);
    assert.deepEqual(crlf.lines, lf.lines, name);
    assert.equal(crlf.hash, lf.hash, name);
  }
});

test("a notice box is hashed wherever the guide text has one, but not under study resources, the change log or in the page chrome", () => {
  const base = guideSpec();
  const read = (spec) => parseStudyGuide(guideHtml("AZ-901", spec), "AZ-901");
  const reference = read(base);
  const retire = "This exam will retire on January 31, 2027.";

  for (const where of ["pre", "purpose"]) {
    const boxed = read({ ...base, notices: { [where]: retire } });
    assert.notEqual(boxed.hash, reference.hash, where);
    assert.deepEqual(
      boxed.lines.slice(0, 4),
      ["## Notices", "Warning", retire, "## Updates to the exam"],
      where,
    );
    // The kind of box is part of the text: a NOTE turned into a WARNING is news.
    const note = read({
      ...base,
      notices: { [where]: retire, [`${where}Kind`]: "NOTE" },
    });
    assert.equal(note.lines[1], "Note");
    assert.notEqual(note.hash, boxed.hash);
    // And so is taking it down again.
    assert.equal(read({ ...base, notices: {} }).hash, reference.hash);
  }
  // Two boxes keep their order, under one Notices heading.
  const both = read({
    ...base,
    notices: { pre: "First box", purpose: "Second box" },
  });
  assert.deepEqual(both.lines.slice(0, 5), [
    "## Notices",
    "Warning",
    "First box",
    "Warning",
    "Second box",
  ]);
  assert.equal(both.lines.filter((line) => line === "## Notices").length, 1);

  // Boxes that are not guide text: study resources and the change log.
  for (const where of ["resources", "changeLog"]) {
    assert.equal(
      read({ ...base, notices: { [where]: "Not the guide" } }).hash,
      reference.hash,
      where,
    );
  }
  // A box in the page chrome, after the content block, is not guide text either.
  const chromeBox =
    '<div class="WARNING"><p>Warning</p><p>Site banner</p></div>';
  assert.equal(
    parseStudyGuide(
      guideHtml("AZ-901", base).replace(
        '<div id="ms--inline-notifications" class="margin-block-xs"></div>',
        `<div id="ms--inline-notifications" class="margin-block-xs">${chromeBox}</div>`,
      ),
      "AZ-901",
    ).hash,
    reference.hash,
  );
  // Nor one in the page header, before any content block (no heading above it
  // says "skip", so only the content block requirement keeps it out).
  assert.equal(
    parseStudyGuide(
      guideHtml("AZ-901", base).replace("<header>", `<header>${chromeBox}`),
      "AZ-901",
    ).hash,
    reference.hash,
  );
  // A box inside a hashed section is part of that section once, not twice.
  const inSkills = read({ ...base, notices: { skills: "In the skills" } });
  assert.equal(
    inSkills.lines.filter((line) => line === "In the skills").length,
    1,
  );
  assert.ok(!inSkills.lines.includes("## Notices"));

  // A box inside a box is read once, with the outer one.
  const nested = parseStudyGuide(
    guideHtml("AZ-901", base).replace(
      '<h2 id="purpose-of-this-document">',
      '<div class="WARNING"><p>Outer</p><div class="NOTE"><p>Inner</p></div></div><h2 id="purpose-of-this-document">',
    ),
    "AZ-901",
  );
  assert.deepEqual(nested.lines.slice(0, 4), [
    "## Notices",
    "Outer",
    "Inner",
    "## Updates to the exam",
  ]);

  // A box alone does not make a study guide.
  const onlyBox = parseStudyGuide(
    '<title>Study guide for Exam AZ-901: Name | Microsoft Learn</title><div class="content"><div class="WARNING"><p>Warning</p><p>Retired.</p></div></div>',
    "AZ-901",
  );
  assert.equal(onlyBox.ok, false);
  assert.equal(onlyBox.hash, null);
  assert.match(onlyBox.reason, /neither an Updates to the exam nor a Skills/);
});

test("htmlToLines makes one line per block and normalizes entities, spaces and soft breaks", () => {
  assert.deepEqual(
    htmlToLines(
      '<h3 id="x">Tom &amp; Jerry&rsquo;s&nbsp;guide</h3>\n<p>One\ntwo   three<br>four</p>' +
        "<ul><li><p>Bullet\n one</p></li><li>Plain <strong>bold</strong></li><li></li></ul>" +
        '<table><tr><th>A</th><td>B <a href="/x">link</a></td></tr></table>' +
        "<script>var x = 1</script><!-- hidden --><h4></h4>",
    ),
    [
      "### Tom & Jerry’s guide",
      "One two three",
      "four",
      "- Bullet one",
      "- Plain bold",
      "A | B link",
    ],
  );
});

test("the sitemap index yields the en-us credentials files as paths, in numeric order", () => {
  assert.deepEqual(parseSitemapIndex(fixture("sitemap-index.xml")), [
    "/_sitemaps/credentials_en-us_1.xml",
  ]);
  const loc = (url) =>
    `<sitemap><loc>${url}</loc><lastmod>2026-10-05</lastmod></sitemap>`;
  assert.deepEqual(
    parseSitemapIndex(
      "<sitemapindex>" +
        [
          // An off-site host only contributes its path: the base URL decides where to fetch.
          "https://evil.example/_sitemaps/credentials_en-us_10.xml",
          "https://learn.microsoft.com/_sitemaps/credentials_en-us_2.xml",
          "https://learn.microsoft.com/_sitemaps/credentials_en-us_2.xml",
          "https://learn.microsoft.com/_sitemaps/credentials_de-de_1.xml",
          "https://learn.microsoft.com/_sitemaps/previous-versions_en-us_1.xml",
        ]
          .map(loc)
          .join("") +
        "</sitemapindex>",
    ),
    [
      "/_sitemaps/credentials_en-us_2.xml",
      "/_sitemaps/credentials_en-us_10.xml",
    ],
  );
  assert.deepEqual(parseSitemapIndex(""), []);
  assert.deepEqual(parseSitemapIndex("not xml"), []);
});

test("the credentials sitemap yields certification study guides with their dates and nothing else", () => {
  const guides = parseCredentialsSitemap(fixture("sitemap-credentials.xml"));
  assert.deepEqual(Object.fromEntries(guides), {
    "AB-650": "2026-07-27",
    "AZ-104": "2026-03-19",
    "GH-500": "2026-05-14",
    "PL-600": "2024-10-06",
  });

  const url = (loc, lastmod = "") =>
    `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  const base = "https://learn.microsoft.com";
  const odd = parseCredentialsSitemap(
    "<urlset>" +
      [
        url(
          `${base}/en-us/credentials/certifications/resources/study-guides/az-104/`,
          "2026-01-01",
        ),
        url(
          `${base}/en-us/credentials/certifications/resources/study-guides/az-104`,
          "2026-02-01T10:00:00Z",
        ),
        url(
          `${base}/en-us/credentials/certifications/resources/study-guides/sc-200`,
        ),
        url(
          `${base}/de-de/credentials/certifications/resources/study-guides/ab-650`,
          "2026-03-01",
        ),
        url(
          `${base}/en-us/credentials/applied-skills/resources/study-guides/apl-1001`,
          "2026-03-01",
        ),
        url(
          `${base}/en-us/credentials/certifications/resources/study-guides/not-a-code`,
          "2026-03-01",
        ),
        url(`${base}/en-us/credentials/certifications/az-900/`, "2026-03-01"),
      ].join("") +
      "</urlset>",
  );
  // A repeated guide keeps its latest date; a missing <lastmod> is an empty date.
  assert.deepEqual(Object.fromEntries(odd), {
    "AZ-104": "2026-02-01",
    "SC-200": "",
  });
  assert.equal(parseCredentialsSitemap("").size, 0);
});

/** The AZ-104 text with typical edits: a new dated heading, a removed, a changed and an added bullet. */
function editedAz104() {
  const before = guideFixture("study-guide-az-104.html", "AZ-104").lines;
  const after = [...before];
  const swap = (from, to) => {
    const at = after.indexOf(from);
    assert.ok(at >= 0, from);
    after.splice(at, 1, ...to);
  };
  swap("## Skills measured as of April 17, 2026", [
    "## Skills measured as of October 14, 2026",
  ]);
  swap("- Assign roles at different scopes", []);
  swap("- Configure resource locks", [
    "- Configure resource locks and management groups",
  ]);
  swap("- Configure Azure Storage redundancy", [
    "- Configure Azure Storage redundancy",
    "- Configure object replication",
  ]);
  return { before, after };
}

test("the line diff names the headings a change sits under and shows removed and added lines", () => {
  const { before, after } = editedAz104();
  assert.deepEqual(
    diffLines(before, before).filter((op) => op.t !== "="),
    [],
  );

  const diff = summarizeDiff(before, after);
  assert.equal(diff.added, 3);
  assert.equal(diff.removed, 3);
  const rendered = renderDiff(diff.entries, 50);
  assert.equal(rendered.omitted, 0);
  assert.equal(rendered.shown, 6);
  assert.equal(
    rendered.text,
    [
      "@@ top of the compared text @@",
      "- ## Skills measured as of April 17, 2026",
      "+ ## Skills measured as of October 14, 2026",
      "@@ Manage Azure identities and governance (20–25%) > Manage access to Azure resources @@",
      "- - Assign roles at different scopes",
      "@@ Manage Azure identities and governance (20–25%) > Manage Azure subscriptions and governance @@",
      "- - Configure resource locks",
      "+ - Configure resource locks and management groups",
      "@@ Implement and manage storage (15–20%) > Configure and manage storage accounts @@",
      "+ - Configure object replication",
    ].join("\n"),
  );
  assert.deepEqual(datedStatements(diff.entries), [
    "Skills measured as of October 14, 2026",
  ]);
});

test("a long diff is cut with a count of what is left out, long lines are clipped and fences cannot break out", () => {
  const before = Array.from({ length: 60 }, (_, i) => `- Old ${i}`);
  const after = Array.from({ length: 60 }, (_, i) => `- New ${i}`);
  before[0] = "- ```diff " + "x".repeat(400);
  const diff = summarizeDiff(before, after);
  assert.equal(diff.added + diff.removed, 120);
  const rendered = renderDiff(diff.entries, 10);
  assert.equal(rendered.shown, 10);
  assert.equal(rendered.omitted, 110);
  const lines = rendered.text.split("\n");
  assert.ok(
    lines.every((line) => line.length <= 302),
    "a line was not clipped",
  );
  assert.ok(lines.some((line) => line.endsWith("…")));
  assert.doesNotMatch(rendered.text, /```/);
  assert.match(rendered.text, /^- - '''diff x/m);

  // A pathological size falls back to "all removed, all added" instead of a huge table.
  const big = diffLines(
    Array.from({ length: 2500 }, (_, i) => `a${i}`),
    Array.from({ length: 2500 }, (_, i) => `b${i}`),
  );
  assert.equal(big.filter((op) => op.t === "-").length, 2500);
  assert.equal(big.filter((op) => op.t === "+").length, 2500);

  // Dates are quoted without the marker this script adds, and only from added lines.
  assert.deepEqual(
    datedStatements([
      { kind: "-", line: "- Retired on January 1, 2020" },
      { kind: "+", line: "- Retires on June 30, 2027 (see 2027-06-30)" },
      { kind: "+", line: "### Skills at a glance as of January 2026" },
      { kind: "+", line: "- No date here" },
      { kind: "+", line: "- Retires on June 30, 2027 (see 2027-06-30)" },
    ]),
    [
      "Retires on June 30, 2027 (see 2027-06-30)",
      "Skills at a glance as of January 2026",
    ],
  );
});

// A study guide record as the tracker holds it.
const guideRecord = (code, extra = {}) => ({
  code,
  name: "Some Exam",
  lastmod: "2026-09-01",
  hash: hashLines(["a"]),
  updatedAt: "u0",
  firstSeen: "2026-08-01",
  lastChanged: null,
  lines: ["a"],
  ...extra,
});
const guideOk = (lines, extra = {}) => ({
  status: "ok",
  guide: {
    name: "N",
    updatedAt: "u1",
    missing: [],
    lines,
    hash: hashLines(lines),
    ...extra,
  },
});

test("every covered guide is read every run: conditional when the server's Last-Modified is stored, a full read when the date moved, there is no validator or a baseline is forced", () => {
  const sitemap = new Map([
    ["AZ-907", "2026-09-01"], // hash, but the server sent no Last-Modified
    ["AZ-901", "2026-09-02"], // sitemap date moved
    ["AZ-902", "2026-09-01"], // same date, validator: conditional
    ["AZ-903", "2026-09-01"], // no hash yet
    ["AZ-904", "2026-09-09"], // not covered
    ["AZ-905", ""], // new
    ["AZ-906", ""], // no date in the sitemap, same as tracked: still conditional
  ]);
  const since = "Tue, 01 Sep 2026 10:00:00 GMT";
  const previousGuides = new Map([
    ["AZ-901", guideRecord("AZ-901", { lastModified: since })],
    ["AZ-902", guideRecord("AZ-902", { lastModified: since })],
    ["AZ-903", guideRecord("AZ-903", { hash: null, lastModified: since })],
    ["AZ-904", guideRecord("AZ-904", { lastModified: since })],
    ["AZ-906", guideRecord("AZ-906", { lastmod: "", lastModified: since })],
    ["AZ-907", guideRecord("AZ-907")],
  ]);
  const covered = (code) => code !== "AZ-904";
  // The sitemap date lags the page, so a guide whose date did not move is
  // still asked about; only the validator keeps that cheap.
  assert.deepEqual(
    selectGuidesToFetch({ sitemap, previousGuides, covered, fetchAll: false }),
    [
      { code: "AZ-901", ifModifiedSince: "" },
      { code: "AZ-902", ifModifiedSince: since },
      { code: "AZ-903", ifModifiedSince: "" },
      { code: "AZ-905", ifModifiedSince: "" },
      { code: "AZ-906", ifModifiedSince: since },
      { code: "AZ-907", ifModifiedSince: "" },
    ],
  );
  // A baseline or forced re-baseline never trusts a "not modified".
  assert.deepEqual(
    selectGuidesToFetch({ sitemap, previousGuides, covered, fetchAll: true }),
    ["AZ-901", "AZ-902", "AZ-903", "AZ-905", "AZ-906", "AZ-907"].map(
      (code) => ({ code, ifModifiedSince: "" }),
    ),
  );
});

test("guide results: first hashes and date-only moves are silent, a changed hash is a change", () => {
  const sitemap = new Map([
    ["AZ-901", "2026-09-05"], // same text, new date
    ["AZ-902", "2026-09-05"], // changed text
    ["AZ-903", "2026-09-05"], // no hash yet
    ["AZ-904", "2026-09-05"], // new covered guide
    ["AZ-905", "2026-09-05"], // not read: the date is mirrored
    ["AZ-906", "2026-09-05"], // brand new, not read
  ]);
  const previousGuides = new Map([
    ["AZ-901", guideRecord("AZ-901")],
    ["AZ-902", guideRecord("AZ-902")],
    ["AZ-903", guideRecord("AZ-903", { hash: null, lines: undefined })],
    ["AZ-905", guideRecord("AZ-905", { hash: null, lines: undefined })],
    ["AZ-999", guideRecord("AZ-999")], // gone from the sitemap: stays
  ]);
  const results = new Map([
    ["AZ-901", guideOk(["a"])],
    ["AZ-902", guideOk(["a", "b"], { name: "Two" })],
    ["AZ-903", guideOk(["c"])],
    ["AZ-904", guideOk(["d"])],
  ]);
  const applied = applyGuideResults({
    sitemap,
    previousGuides,
    selected: new Set(["AZ-901", "AZ-902", "AZ-903", "AZ-904"]),
    results,
    silent: false,
    today: "2026-10-09",
  });
  const byCode = Object.fromEntries(applied.guides.map((g) => [g.code, g]));

  assert.deepEqual(applied.dateOnly, [
    { code: "AZ-901", from: "2026-09-01", to: "2026-09-05" },
  ]);
  assert.equal(byCode["AZ-901"].lastmod, "2026-09-05");
  assert.equal(byCode["AZ-901"].updatedAt, "u1");
  assert.equal(byCode["AZ-901"].lastChanged, null);

  assert.equal(applied.changes.length, 1);
  assert.equal(applied.changes[0].code, "AZ-902");
  assert.equal(applied.changes[0].name, "Two");
  assert.deepEqual(
    [applied.changes[0].diff.added, applied.changes[0].diff.removed],
    [1, 0],
  );
  assert.equal(byCode["AZ-902"].hash, hashLines(["a", "b"]));
  assert.equal(byCode["AZ-902"].lastChanged, "2026-10-09");
  assert.deepEqual(byCode["AZ-902"].lines, ["a", "b"]);

  assert.deepEqual(applied.baselined, ["AZ-903", "AZ-904"]);
  assert.equal(byCode["AZ-903"].lastChanged, null);
  assert.equal(byCode["AZ-903"].firstSeen, "2026-08-01"); // kept
  assert.equal(byCode["AZ-904"].firstSeen, "2026-10-09");

  assert.equal(byCode["AZ-905"].lastmod, "2026-09-05");
  assert.equal(byCode["AZ-905"].hash, null);
  assert.deepEqual(
    { ...byCode["AZ-906"], lines: undefined },
    {
      code: "AZ-906",
      lastmod: "2026-09-05",
      hash: null,
      updatedAt: "",
      firstSeen: "2026-10-09",
      lastChanged: null,
      lines: undefined,
    },
  );
  assert.equal(byCode["AZ-999"].lastmod, "2026-09-01");
  assert.deepEqual(
    applied.guides.map((g) => g.code),
    [...applied.guides.map((g) => g.code)].sort(),
  );

  // A forced baseline records the same change silently and leaves lastChanged alone.
  const forced = applyGuideResults({
    sitemap,
    previousGuides,
    selected: new Set(["AZ-902"]),
    results,
    silent: true,
    today: "2026-10-09",
  });
  assert.deepEqual(forced.changes, []);
  assert.deepEqual(forced.rebaselined, ["AZ-902"]);
  assert.equal(
    forced.guides.find((g) => g.code === "AZ-902").hash,
    hashLines(["a", "b"]),
  );
  assert.equal(
    forced.guides.find((g) => g.code === "AZ-902").lastChanged,
    null,
  );
});

test("guide results: a failed or unreadable guide, or one that lost a section, keeps its record and is never a change", () => {
  const previous = new Map([
    ["AZ-901", guideRecord("AZ-901")],
    ["AZ-902", guideRecord("AZ-902")],
    ["AZ-903", guideRecord("AZ-903")],
    ["AZ-904", guideRecord("AZ-904")],
    ["AZ-905", guideRecord("AZ-905", { missing: ["skills"] })],
  ]);
  const sitemap = new Map(
    ["AZ-901", "AZ-902", "AZ-903", "AZ-904", "AZ-905"].map((code) => [
      code,
      "2026-09-09",
    ]),
  );
  const applied = applyGuideResults({
    sitemap,
    previousGuides: previous,
    selected: new Set(sitemap.keys()),
    results: new Map([
      ["AZ-901", { status: "failed", reason: "status 500" }],
      // AZ-902 was never started (deadline or too many failures)
      [
        "AZ-903",
        { status: "unparsed", reason: "not the study guide page of AZ-903" },
      ],
      ["AZ-904", guideOk(["x"], { missing: ["skills"] })], // had skills, lost them
      ["AZ-905", guideOk(["y"], { missing: ["skills"] })], // never had them: a plain change
    ]),
    silent: false,
    today: "2026-10-09",
  });
  const byCode = Object.fromEntries(applied.guides.map((g) => [g.code, g]));
  for (const code of ["AZ-901", "AZ-902", "AZ-903", "AZ-904"]) {
    assert.deepEqual(byCode[code], previous.get(code), code);
  }
  assert.deepEqual(
    applied.failed.map((f) => [f.code, f.reason]),
    [
      ["AZ-901", "status 500"],
      ["AZ-902", "not fetched (deadline or too many failures)"],
    ],
  );
  assert.deepEqual(
    applied.unparsed.map((f) => f.code),
    ["AZ-903"],
  );
  assert.deepEqual(applied.degraded, [
    { code: "AZ-904", sections: ["skills"] },
  ]);
  assert.deepEqual(
    applied.changes.map((c) => c.code),
    ["AZ-905"],
  );
  assert.deepEqual(byCode["AZ-905"].missing, ["skills"]);
});

test("guide results: 'not modified' keeps the record; a republished page with the same text only refreshes its validator", () => {
  const since = "Tue, 01 Sep 2026 10:00:00 GMT";
  const later = "Wed, 02 Sep 2026 10:00:00 GMT";
  const previous = new Map([
    ["AZ-901", guideRecord("AZ-901", { lastModified: since })],
    ["AZ-902", guideRecord("AZ-902", { lastModified: since })],
    ["AZ-903", guideRecord("AZ-903")], // read before the validator existed
    ["AZ-904", guideRecord("AZ-904", { hash: null, lines: undefined })],
  ]);
  const sitemap = new Map(
    [...previous.keys()].map((code) => [code, "2026-09-01"]),
  );
  const applied = applyGuideResults({
    sitemap,
    previousGuides: previous,
    selected: new Set(sitemap.keys()),
    results: new Map([
      ["AZ-901", { status: "notModified" }],
      ["AZ-902", guideOk(["a"], { lastModified: later })],
      ["AZ-903", guideOk(["a"], { lastModified: since })],
      ["AZ-904", { status: "notModified" }], // nothing stored to be unmodified against
    ]),
    silent: false,
    today: "2026-10-09",
  });
  const byCode = Object.fromEntries(applied.guides.map((g) => [g.code, g]));

  assert.deepEqual(byCode["AZ-901"], previous.get("AZ-901"));
  assert.deepEqual(applied.unchanged, ["AZ-901"]);

  // Same text, new Last-Modified: recorded (else the server would answer 200
  // for ever), never reported.
  assert.deepEqual(applied.changes, []);
  assert.deepEqual(
    applied.republished.map((entry) => entry.code),
    ["AZ-902", "AZ-903"],
  );
  assert.equal(byCode["AZ-902"].lastModified, later);
  assert.equal(byCode["AZ-902"].hash, previous.get("AZ-902").hash);
  assert.equal(byCode["AZ-902"].lastChanged, null);
  assert.equal(byCode["AZ-903"].lastModified, since);

  assert.deepEqual(byCode["AZ-904"], previous.get("AZ-904"));
  assert.deepEqual(applied.failed, [
    { code: "AZ-904", reason: "answered 304 without a stored text" },
  ]);
});

test("guide results: a lost section is kept and only reported, until the new text is accepted on purpose", () => {
  const previous = new Map([["AZ-901", guideRecord("AZ-901")]]);
  const run = (previousGuides, lastmod, lines, silent) =>
    applyGuideResults({
      sitemap: new Map([["AZ-901", lastmod]]),
      previousGuides,
      selected: new Set(["AZ-901"]),
      results: new Map([["AZ-901", guideOk(lines, { missing: ["skills"] })]]),
      silent,
      today: "2026-10-09",
    });

  // A normal run keeps the record: the loss may be a broken page, not news.
  const normal = run(previous, "2026-09-09", ["x"], false);
  assert.deepEqual(normal.degraded, [{ code: "AZ-901", sections: ["skills"] }]);
  assert.deepEqual(normal.changes, []);
  assert.deepEqual(normal.guides, [previous.get("AZ-901")]);

  // FORCE_GUIDE_BASELINE accepts it, silently.
  const accepted = run(previous, "2026-09-09", ["x"], true);
  assert.deepEqual(accepted.degraded, []);
  assert.deepEqual(accepted.changes, []);
  assert.deepEqual(accepted.rebaselined, ["AZ-901"]);
  const [record] = accepted.guides;
  assert.equal(record.hash, hashLines(["x"]));
  assert.deepEqual(record.missing, ["skills"]);
  assert.equal(record.lastChanged, null);

  // It is not a trap: the next real edit is an ordinary change again.
  const next = run(
    new Map([["AZ-901", record]]),
    "2026-09-20",
    ["x", "y"],
    false,
  );
  assert.deepEqual(next.degraded, []);
  assert.deepEqual(
    next.changes.map((change) => change.code),
    ["AZ-901"],
  );
});

test("a study guide code nobody tracked is an exam of its own; known codes and certified codes only gain evidence", () => {
  const previous = normalizeTracker(
    {
      certifications: [],
      exams: [
        {
          code: "AZ-720",
          name: "Old",
          certifications: [{ slug: "gone", title: "Gone" }],
        },
      ],
    },
    "2026-10-01",
  );
  const item = {
    slug: "azure-role-1",
    uid: "certification.azure-role-1",
    title: "Role",
    beta: false,
    products: [],
    types: ["certification"],
    examCodes: ["AZ-901"],
  };
  const scan = buildScan({
    certifications: [item],
    examinations: [
      { code: "77-901", name: "Legacy", beta: false, products: [] },
    ],
    pages: new Map(),
    previous,
    guideCodes: ["AB-651", "AZ-901", "AZ-720", "77-901"],
  });
  const ab = scan.exams.get("AB-651");
  assert.equal(ab.guideOnly, true);
  assert.deepEqual(evidenceOf(ab), ["study guide"]);
  assert.deepEqual(evidenceOf(scan.exams.get("AZ-901")), [
    "certification page",
    "study guide",
  ]);
  assert.equal(scan.exams.get("AZ-901").guideOnly, false);
  assert.deepEqual(evidenceOf(scan.exams.get("77-901")), [
    "exam listing",
    "study guide",
  ]);
  // AZ-720 is tracked and no certification lists it: its record is not touched.
  assert.ok(!scan.exams.has("AZ-720"));
  assert.deepEqual(evidenceOf(undefined), []);

  const merged = mergeTracker(previous, scan, "2026-10-09");
  const record = merged.exams.find((exam) => exam.code === "AB-651");
  assert.deepEqual(record.certifications, []);
  assert.equal(record.url, "");
  assert.equal(record.firstSeen, "2026-10-09");
  assert.deepEqual(
    merged.exams.find((exam) => exam.code === "AZ-720").certifications,
    [{ slug: "gone", title: "Gone" }],
  );
});

test("a tracker written before the study guide check loads, and compares equal to one with none", () => {
  const old = normalizeTracker(
    { certifications: [], exams: [{ code: "AZ-901" }] },
    "2026-10-09",
  );
  assert.deepEqual(old.studyGuides, []);
  assert.equal(
    trackerContent(old),
    trackerContent({ ...old, studyGuides: undefined }),
  );
  const kept = normalizeTracker(
    {
      certifications: [],
      exams: [],
      studyGuides: [
        {
          code: "az-104",
          lastmod: "2026-01-01",
          hash: "abc",
          lastModified: " Tue, 01 Sep 2026 10:00:00 GMT ",
          lines: ["x", 3],
          missing: ["skills"],
        },
        // A validator belongs to a guide that was read; there is none to keep here.
        { code: "AB-650", lastModified: "Tue, 01 Sep 2026 10:00:00 GMT" },
        { nothing: true },
      ],
    },
    "2026-10-09",
  );
  assert.deepEqual(kept.studyGuides, [
    {
      code: "AB-650",
      lastmod: "",
      hash: null,
      updatedAt: "",
      firstSeen: "2026-10-09",
      lastChanged: null,
    },
    {
      code: "AZ-104",
      lastmod: "2026-01-01",
      hash: "abc",
      updatedAt: "",
      lastModified: "Tue, 01 Sep 2026 10:00:00 GMT",
      firstSeen: "2026-10-09",
      lastChanged: null,
      missing: ["skills"],
      lines: ["x", "3"],
    },
  ]);
  // Key order is part of the file format: the validator follows updatedAt.
  assert.deepEqual(Object.keys(kept.studyGuides[1]), [
    "code",
    "lastmod",
    "hash",
    "updatedAt",
    "lastModified",
    "firstSeen",
    "lastChanged",
    "missing",
    "lines",
  ]);
});

test("issue titles name the updated study guides and keep them when the list is long", () => {
  const guides = (n) =>
    Array.from({ length: n }, (_, i) => ({ code: `AZ-${100 + i}` }));
  assert.equal(
    buildIssueTitle({
      exams: [{ code: "AB-651", beta: false }],
      certs: [],
      guides: [{ code: "AZ-104" }, { code: "SC-300" }],
    }),
    "New Microsoft Learn exam: AB-651; study guide updated: AZ-104, SC-300",
  );
  assert.equal(
    buildIssueTitle({ exams: [], certs: [], guides: [{ code: "AZ-104" }] }),
    "Microsoft Learn study guide updated: AZ-104",
  );
  assert.equal(
    buildIssueTitle({
      exams: [{ code: "AZ-901", beta: true }],
      certs: [{ title: "X" }],
      guides: [{ code: "AZ-104" }],
    }),
    "New Microsoft Learn exam: AZ-901 (beta); 1 new certification; study guide updated: AZ-104",
  );
  assert.match(
    buildIssueTitle({ exams: [], certs: [], guides: guides(9) }),
    /^Microsoft Learn study guide updated: AZ-100, AZ-101, AZ-102, AZ-103, AZ-104, AZ-105 \+3 more$/,
  );
  assert.equal(
    buildIssueTitle({
      exams: [],
      certs: [{ title: "Cert A" }],
      guides: [{ code: "AZ-104" }],
    }),
    "New Microsoft Learn certification: Cert A; study guide updated: AZ-104",
  );

  // Both lists long: fewer codes are named so the guide part is not cut off.
  const exams = Array.from({ length: 12 }, (_, i) => ({
    code: `AB-9${10 + i}`,
    beta: true,
  }));
  const long = buildIssueTitle({
    exams,
    certs: [{ title: "C" }, { title: "D" }],
    guides: guides(12),
  });
  assert.ok(long.length <= 200, long);
  assert.match(long, /; study guide updated: AZ-100/);
  assert.ok(!long.endsWith("…"));
  // Whatever the input, the cap holds.
  const absurd = buildIssueTitle({
    exams: [],
    certs: [{ title: "x".repeat(150) }],
    guides: [{ code: "y".repeat(150) }],
  });
  assert.equal(absurd.length, 200);
});

/** A changed guide as the monitor hands it to the report. */
function reportGuide(
  code,
  { name = "Microsoft Azure Administrator", diff, ...extra } = {},
) {
  const { before, after } = editedAz104();
  return {
    code,
    name,
    lastmodBefore: "2026-03-01",
    lastmod: "2026-03-19",
    updatedAtBefore: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-19T18:11:00Z",
    missing: [],
    diff: diff === undefined ? summarizeDiff(before, after) : diff,
    ...extra,
  };
}

test("a study guide report quotes the diff and dates as 'from the study guide' and tells what to do", () => {
  const report = buildReport({
    exams: [],
    certs: [],
    guides: [reportGuide("AZ-104")],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
    hubPage: () => true,
  });
  assert.match(report, /^## Study guides updated on Microsoft Learn\n/);
  assert.match(report, /### Study guides updated \(1\)/);
  assert.match(
    report,
    /\| AZ-104 Microsoft Azure Administrator \| \[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/az-104\?WT\.mc_id=studentamb_165290\) \| `src\/content\/docs\/azure\/AZ-104\.mdx` \| \+3 \/ -3 \| 2026-03-01 → 2026-03-19 \| 2026-03-01T10:00:00Z → 2026-03-19T18:11:00Z \|/,
  );
  assert.match(
    report,
    /```diff\n@@ top of the compared text @@\n- ## Skills measured as of April 17, 2026\n\+ ## Skills measured as of October 14, 2026\n/,
  );
  assert.match(report, /Changed text, from the study guide/);
  assert.match(
    report,
    /from the study guide, quoted verbatim; they are not exam or beta start dates\):\n\n```text\n- "Skills measured as of October 14, 2026"\n```/,
  );
  // The steps.
  assert.match(report, /#### What to do/);
  assert.match(
    report,
    /announces a retirement or replacement, follow the retirement rules in `docs\/monitors\/beta-and-retiring-exams\.md`/,
  );
  assert.match(report, /Do not invent dates/);
  assert.match(report, /Never use one as the beta start date of an exam/);
  assert.match(report, /audit-missing-resources\.mjs/);
  // A guide-only report has no exam checklist, and nothing private or unfinished in it.
  assert.doesNotMatch(report, /### Checklist|### New exams|First detected/);
  assert.doesNotMatch(report, INTERNAL_WORDS);
  assert.doesNotMatch(report, /\bnull\b|undefined/);
  assert.ok(report.length < 20000);

  // Without a stored previous text, or with a missing section, the report says so.
  const odd = buildReport({
    exams: [],
    certs: [],
    guides: [
      reportGuide("AZ-104", { diff: null, missing: ["skills"] }),
      reportGuide("SC-300", {
        name: "",
        diff: { added: 0, removed: 0, entries: [] },
      }),
    ],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  assert.match(
    odd,
    /The previous text was not stored, so there is no line diff/,
  );
  assert.match(
    odd,
    /Not found in the page markup: the "Skills measured" section\./,
  );
  assert.match(odd, /No line differs from the stored text/);
  assert.match(odd, /\| SC-300 \| \[Study guide\]/);
  assert.doesNotMatch(odd, /\bnull\b|undefined/);
});

test("the guide section names its columns, says what its dates are not, and points to the notices", () => {
  const guides = ["AZ-105", "AZ-104", "SC-300"].map((code) =>
    reportGuide(code),
  );
  const report = buildReport({
    exams: [],
    certs: [],
    guides, // out of order on purpose: the report sorts them
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
    hubPage: () => true,
  });
  const table = report
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(0, 5);
  const cells = (line) => line.split("|").slice(1, -1);
  assert.deepEqual(
    cells(table[0]).map((header) => header.trim()),
    [
      "Exam",
      "Study guide",
      "Hub page",
      "Changed lines",
      "Sitemap lastmod",
      "Page updated_at",
    ],
  );
  // The delimiter row has one cell per column, or the table does not render.
  assert.equal(cells(table[1]).length, 6);
  assert.ok(cells(table[1]).every((dashes) => /^-+$/.test(dashes)));
  assert.deepEqual(
    table.slice(2).map((row) => row.match(/^\| (\S+)/)[1]),
    ["AZ-104", "AZ-105", "SC-300"],
  );
  assert.ok(table.slice(2).every((row) => cells(row).length === 6));

  assert.match(
    report,
    /The "Notices" \(the warning, note and important boxes of the guide\), "Updates to the exam" or "Skills measured" text/,
  );
  assert.match(
    report,
    /A change of a date alone \(Microsoft Learn sitemap, page\) is not reported, only a change of the text\./,
  );
  assert.match(
    report,
    /\*\*Sitemap lastmod\*\* and \*\*updated_at\*\* are when Learn says it modified the page; they are not exam dates\./,
  );
  assert.match(
    report,
    /Every date quoted below is from the study guide and is not confirmed anywhere else\./,
  );
  // A retirement can sit in a notice box or in the updates text; both are named.
  assert.match(
    report,
    /3\. If a "Notices" box .* or the "Updates to the exam" text announces a retirement or replacement/,
  );
});

test("the report shows at most 30 changed lines per guide and 150 in total, and 6 dated statements per guide", () => {
  const numbered = (prefix, n) =>
    Array.from({ length: n }, (_, i) => `- ${prefix} ${i}`);
  const bigDiff = () => summarizeDiff(numbered("old", 80), numbered("new", 80));
  const guides = [
    "AZ-100",
    "AZ-101",
    "AZ-102",
    "AZ-103",
    "AZ-104",
    "AZ-105",
  ].map((code) => reportGuide(code, { diff: bigDiff() }));
  const report = buildReport({
    exams: [],
    certs: [],
    guides,
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  const fences = [...report.matchAll(/```diff\n([\s\S]*?)\n```/g)].map(
    (match) => match[1],
  );
  const shown = fences.map(
    (text) => text.split("\n").filter((line) => /^[-+] /.test(line)).length,
  );
  // 5 guides x 30 lines use the 150; the sixth gets no diff at all.
  assert.deepEqual(shown, [30, 30, 30, 30, 30]);
  assert.match(
    report,
    /130 more changed lines are not shown here \(at most 30 lines per study guide, 150 in total, to stay under GitHub's issue size limit\)/,
  );
  assert.match(report, /160 more changed lines are not shown here/);
  assert.doesNotMatch(report, /The diffs are shortened/);

  const dated = Array.from(
    { length: 10 },
    (_, i) => `- Skills measured as of January ${i + 1}, 2027`,
  );
  const withDates = buildReport({
    exams: [],
    certs: [],
    guides: [reportGuide("AZ-104", { diff: summarizeDiff([], dated) })],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  const block = withDates.match(/```text\n([\s\S]*?)\n```/)[1];
  assert.equal(block.split("\n").length, 6);
  assert.equal(
    block.split("\n")[0],
    '- "Skills measured as of January 1, 2027"',
  );
});

test("text from a study guide cannot ping, link or render HTML in the issue", () => {
  const hostile =
    "Skills measured as of October 14, 2026 @octocat see #123 and [x](https://evil.example) <img src=x> ```diff boom";
  const guide = reportGuide("AZ-104", {
    name: "Admin | Foo @octocat #12 <b>x</b> [l](u) `code`",
    diff: summarizeDiff(["## Skills"], ["## Skills", `- ${hostile}`]),
  });
  const report = buildReport({
    exams: [],
    certs: [],
    guides: [guide],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  const outside = report.replace(/```[\s\S]*?\n```/g, "");
  // Nothing from the guide survives as a mention, a cross-reference, HTML, a
  // link or a code span outside a code fence.
  assert.doesNotMatch(outside, /@(?!\u200b)\w/);
  assert.doesNotMatch(outside, /#(?!\u200b)\d/);
  assert.doesNotMatch(outside, /<b>|<\/b>|<img|\[l\]|`code`/);
  assert.match(outside, /\| AZ-104 Admin \\\| Foo @\u200boctocat #\u200b12 /);
  assert.match(
    outside,
    /^#### AZ-104: Admin \| Foo @\u200boctocat #\u200b12 /m,
  );

  // The verbatim date statement is in a fence of its own that it cannot close.
  const statement = report.match(/```text\n([\s\S]*?)\n```/)[1];
  assert.match(
    statement,
    /^- "Skills measured as of October 14, 2026 @octocat/,
  );
  assert.doesNotMatch(statement, /```/);
  assert.match(statement, /'''diff boom"$/);
  // The diff cannot close its fence either: every fence opens and closes.
  assert.equal((report.match(/^```/gm) ?? []).length % 2, 0);
  assert.match(
    report,
    /^\+ - Skills measured as of October 14, 2026 @octocat/m,
  );
});

test("exam names, certification titles, products and announcement texts from Learn cannot ping, link or render HTML in the issue, and neither can the issue title", () => {
  const hostile =
    "Team @octocat #123 <b>x</b> [l](https://evil.example) `code` | pipe";
  const exam = {
    code: "AB-960",
    name: hostile,
    beta: false,
    betaKnown: true,
    certifications: [{ slug: "new-cert", title: hostile }],
    products: [hostile],
    url: "",
    announcements: [],
    firstSeen: "2026-10-09",
    evidence: ["certification page"],
  };
  const certification = {
    slug: "x-cert",
    title: hostile,
    beta: false,
    exams: ["AB-960"],
    products: [hostile],
    firstSeen: "2026-10-09",
  };
  const scan = {
    exams: new Map([
      [
        "AB-960",
        { announcements: new Map([["https://example.com/a", hostile]]) },
      ],
    ]),
    certs: new Map(),
  };
  const report = buildReport({
    exams: [exam],
    certs: [certification],
    scan,
    today: "2026-10-09",
  });
  // The scaffold command is code and keeps the name as it is (the maintainer
  // pastes it into a shell); everything outside the fence is Markdown.
  const fence = / *```bash\n([\s\S]*?)\n *```/;
  const command = report.match(fence)[1];
  assert.ok(
    command.includes(
      '--name "Team @octocat #123 <b>x</b> [l](https://evil.example) \\`code\\` | pipe"',
    ),
    command,
  );
  const outside = report.replace(fence, "");
  assert.doesNotMatch(outside, /@(?!\u200b)\w/);
  assert.doesNotMatch(outside, /#(?!\u200b)\d/);
  assert.doesNotMatch(outside, /<b>|<\/b>|\[l\]|`code`/);
  // What is left of it is plain text, the pipe escaped, in every cell and link text.
  const zw = "\u200b";
  const text = `Team @${zw}octocat #${zw}123 b x /b l (https://evil.example) code \\| pipe`;
  const certPage = (slug) =>
    `https://learn.microsoft.com/credentials/certifications/${slug}/?WT.mc_id=studentamb_165290`;
  assert.ok(
    outside.includes(
      `| AB-960 | ${text} | GA | [${text}](${certPage("new-cert")}) | ${text} |`,
    ),
    outside,
  );
  assert.ok(outside.includes(`[${text}](https://example.com/a)`), outside);
  assert.ok(
    outside.includes(
      `| [${text}](${certPage("x-cert")}) | GA | AB-960 | ${text} | 2026-10-09 |`,
    ),
    outside,
  );

  // The issue title of a new certification names it: no mention, no reference.
  assert.equal(
    buildIssueTitle({ exams: [], certs: [certification] }),
    `New Microsoft Learn certification: Team @${zw}octocat #${zw}123 b x /b l (https://evil.example) code | pipe`,
  );
});

test("the scaffold commands of the checklist are ones scripts/new-exam.mjs accepts once the beta start is filled in", async () => {
  const exam = (code, beta) => ({
    code,
    name: "Administering Something New",
    beta,
    betaKnown: true,
    certifications: [],
    products: [],
    url: "",
    announcements: [],
    firstSeen: "2026-10-09",
    evidence: [],
  });
  const report = buildReport({
    exams: [exam("AB-960", true), exam("AB-961", false)],
    certs: [],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  const commands = [
    ...report.matchAll(/^ {3}(node scripts\/new-exam\.mjs .*)$/gm),
  ].map((match) => match[1]);
  assert.equal(commands.length, 2);
  assert.match(commands[0], / --beta --beta-start <YYYY-MM-DD>$/);
  assert.doesNotMatch(commands[1], /--beta/);

  const dir = await mkdtemp(join(tmpdir(), "new-exam-checklist-"));
  tempDirs.push(dir);
  for (const command of commands) {
    // The placeholder is the maintainer's to fill in: the day the beta began.
    const [script, ...args] = [
      ...command
        .replace("<YYYY-MM-DD>", "2026-10-14")
        .matchAll(/"([^"]*)"|(\S+)/g),
    ]
      .map((match) => match[1] ?? match[2])
      .slice(1); // without "node"
    const child = spawn(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: { ...process.env, DOCS_DIR: dir, TODAY: "2026-10-16" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    assert.equal(
      await new Promise((done) => child.on("close", done)),
      0,
      stderr,
    );
  }
  const beta = await readFile(join(dir, "aibusiness", "AB-960.mdx"), "utf8");
  const plain = await readFile(join(dir, "aibusiness", "AB-961.mdx"), "utf8");
  assert.equal(findBetaNote(beta).found, true);
  assert.equal(inspectBetaNote(plain).hasTip, false);
});

test("the stale deeper headings of an earlier section never label a later hunk", () => {
  const before = ["## A", "### A1", "- x1", "## B", "- y1"];
  const after = ["## A", "### A1", "- x1", "## B", "- y2"];
  const diff = summarizeDiff(before, after);
  assert.equal(renderDiff(diff.entries, 10).text.split("\n")[0], "@@ B @@");
});

test("a new exam that no certification lists yet says so instead of blaming the certification page", () => {
  const exam = {
    code: "AB-960",
    name: "",
    beta: false,
    betaKnown: false,
    certifications: [],
    products: [],
    url: "",
    announcements: [],
    firstSeen: "2026-10-09",
    evidence: ["study guide"],
  };
  const report = (certifications) =>
    buildReport({
      exams: [{ ...exam, certifications }],
      certs: [],
      scan: { exams: new Map(), certs: new Map() },
      today: "2026-10-09",
    });
  assert.match(report([]), /_not found yet, check the study guide_/);
  assert.doesNotMatch(report([]), /not published on the certification page/);
  assert.match(
    report([{ slug: "c", title: "C" }]),
    /_not published on the certification page, check the study guide_/,
  );
});

test("a new certification lists the exams it names that still need a page, and says 'no page needed' only when none does", () => {
  const seen = (extra = {}) => ({
    name: "",
    beta: false,
    betaKnown: false,
    examPage: false,
    certs: new Map([["c", "C"]]),
    products: new Set(["AI"]),
    announcements: new Map(),
    viaCert: true,
    ...extra,
  });
  const scan = {
    exams: new Map([
      [
        "AB-960",
        seen({
          name: "Administering Something New",
          beta: true,
          betaKnown: true,
          examPage: true,
          announcements: new Map([
            ["https://example.com/a", "Learn more about the beta exam AB-960"],
          ]),
        }),
      ],
      ["AB-961", seen()],
      ["AB-962", seen()],
      ["77-901", seen()],
    ]),
    certs: new Map([["c", { beta: true }]]),
  };
  const cert = (exams) => ({
    slug: "c",
    title: "C",
    beta: true,
    exams,
    products: [],
    firstSeen: "2026-10-09",
  });
  const hubPage = (code) => code === "AB-961"; // AB-961 has its page already
  const trackedExams = new Map([
    [
      "AB-962",
      {
        name: "Tracked Name",
        beta: false,
        certifications: [{ slug: "c", title: "C" }],
        products: [],
        url: "",
        firstSeen: "2026-08-01",
      },
    ],
  ]);
  const report = buildReport({
    exams: [],
    certs: [cert(["AB-960", "AB-961", "AB-962", "77-901"])],
    scan,
    today: "2026-10-09",
    hubPage,
    trackedExams,
  });
  assert.match(
    report,
    /### Exams the new certifications list that still have no hub page \(2\)/,
  );
  // AB-960: what the certification page says now (BETA, announcement, exam page).
  assert.match(
    report,
    /\| AB-960 \| Administering Something New \| BETA \| \[C\]\([^)]*\) \| AI \| `src\/content\/docs\/aibusiness\/AB-960\.mdx` \| \[Exam page\]\([^)]*exams\/ab-960\?WT\.mc_id=studentamb_165290\) \| \[Learn more about the beta exam AB-960\]\(https:\/\/example\.com\/a\) \| certification page \| — \|/,
  );
  // AB-962: the name and the first-seen day come from the tracker.
  assert.match(
    report,
    /\| AB-962 \| Tracked Name \| unknown \(its certification is BETA\)[^\n]*\| 2026-08-01 \|/,
  );
  // Not listed: the exam with a page, and the legacy family.
  assert.doesNotMatch(report, /\| AB-961 \||\| 77-901 \|/);
  // And the checklist serves them: a scaffold command each, --beta only for the beta one (with the start it needs).
  assert.match(
    report,
    /node scripts\/new-exam\.mjs --code AB-960 --name "Administering Something New" --beta --beta-start <YYYY-MM-DD>\n/,
  );
  assert.match(
    report,
    /node scripts\/new-exam\.mjs --code AB-962 --name "Tracked Name"\n/,
  );
  assert.doesNotMatch(report, /No new exam page is needed/);
  assertChecklist(report);

  // An exam that is a new exam in this very issue is not listed twice.
  const sameIssue = buildReport({
    exams: [
      {
        code: "AB-960",
        name: "Administering Something New",
        beta: true,
        betaKnown: true,
        certifications: [{ slug: "c", title: "C" }],
        products: [],
        url: "",
        announcements: [],
        firstSeen: "2026-10-09",
        evidence: ["certification page"],
      },
    ],
    certs: [cert(["AB-960"])],
    scan,
    today: "2026-10-09",
    hubPage,
  });
  assert.doesNotMatch(sameIssue, /still have no hub page/);
  assert.equal((sameIssue.match(/^\| AB-960 \|/gm) ?? []).length, 1);

  // Nothing to do: every exam it lists has a page or is outside the hub areas.
  const quiet = buildReport({
    exams: [],
    certs: [cert(["AB-961", "77-901"])],
    scan,
    today: "2026-10-09",
    hubPage,
  });
  assert.doesNotMatch(quiet, /still have no hub page/);
  assert.match(
    quiet,
    /No new exam page is needed for the certification\(s\) above right now: every exam they list already has a hub page or is outside the hub areas\. /,
  );
  const empty = buildReport({
    exams: [],
    certs: [cert([])],
    scan,
    today: "2026-10-09",
    hubPage,
  });
  assert.match(
    empty,
    /right now: they list no exam yet\. The monitor reports a new exam in its own issue/,
  );
});

test("a record without its stored text still reports a changed guide, without a diff", () => {
  const legacy = guideRecord("AZ-901", { lines: undefined });
  const applied = applyGuideResults({
    sitemap: new Map([["AZ-901", "2026-09-09"]]),
    previousGuides: new Map([["AZ-901", legacy]]),
    selected: new Set(["AZ-901"]),
    results: new Map([["AZ-901", guideOk(["a", "b"])]]),
    silent: false,
    today: "2026-10-09",
  });
  assert.equal(applied.changes.length, 1);
  assert.equal(applied.changes[0].diff, null);
  assert.deepEqual(applied.guides[0].lines, ["a", "b"]); // stored from now on
});

test("guide findings come out sorted by code, whatever the order of the sitemap", () => {
  const codes = ["AZ-903", "AZ-901", "AZ-902"];
  const applied = applyGuideResults({
    sitemap: new Map(codes.map((code) => [code, "2026-09-09"])),
    previousGuides: new Map(codes.map((code) => [code, guideRecord(code)])),
    selected: new Set(codes),
    results: new Map(codes.map((code) => [code, guideOk(["a", code])])),
    silent: false,
    today: "2026-10-09",
  });
  const sorted = [...codes].sort();
  assert.deepEqual(
    applied.changes.map((change) => change.code),
    sorted,
  );
  assert.deepEqual(
    applied.guides.map((guide) => guide.code),
    sorted,
  );
  const notModified = applyGuideResults({
    sitemap: new Map(codes.map((code) => [code, "2026-09-01"])),
    previousGuides: new Map(
      codes.map((code) => [code, guideRecord(code, { lastModified: "x" })]),
    ),
    selected: new Set(codes),
    results: new Map(codes.map((code) => [code, { status: "notModified" }])),
    silent: false,
    today: "2026-10-09",
  });
  assert.deepEqual(notModified.unchanged, sorted);
});

test("a date in ISO form is a dated statement too", () => {
  assert.deepEqual(
    datedStatements([
      { kind: "+", line: "- Registration closes 2027-01-31" },
      { kind: "+", line: "- No year 12345 or 2027-1-3 here" },
    ]),
    ["Registration closes 2027-01-31"],
  );
});

test("a report with new exams and updated guides keeps the exam checklist, shows the evidence and the guide sections", () => {
  const exam = (code, evidence, extra = {}) => ({
    code,
    name: "N",
    beta: false,
    betaKnown: false,
    certifications: [],
    products: [],
    url: "",
    announcements: [],
    firstSeen: "2026-10-09",
    evidence,
    ...extra,
  });
  const report = buildReport({
    exams: [
      exam("AB-960", ["study guide"]),
      exam("AB-961", ["certification page", "study guide"], {
        certifications: [{ slug: "c", title: "C" }],
      }),
      exam("AB-962", ["certification page"], {
        certifications: [{ slug: "c", title: "C" }],
      }),
      exam("AB-963", []),
    ],
    certs: [],
    guides: [reportGuide("AZ-104")],
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  assert.match(report, /^## New on Microsoft Learn\n/);
  // The guides are a top-level section of their own, not a part of the new-exam one.
  assert.match(report, /\n## Study guides updated on Microsoft Learn\n/);
  assert.equal((report.match(/^## /gm) ?? []).length, 2);
  assert.match(report, /\| Announcement \| Evidence \| First detected \|/);
  // The evidence column; the exam link falls back to the study guide for an exam only a guide shows.
  assert.match(
    report,
    /\| AB-960 \| N \| unknown, check Learn \| — \| — \| `src\/content\/docs\/aibusiness\/AB-960\.mdx` \| \[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/ab-960\?WT\.mc_id=studentamb_165290\) \(no exam page confirmed\) \| — \| study guide \| 2026-10-09 \|/,
  );
  assert.match(
    report,
    /\| AB-961 [^\n]*\| certification page \+ study guide \| 2026-10-09 \|/,
  );
  assert.match(
    report,
    /\| AB-962 [^\n]*\| certification page \| 2026-10-09 \|/,
  );
  assert.match(report, /\| AB-963 [^\n]*\| — \| 2026-10-09 \|/);
  assert.match(report, /### Checklist/);
  assert.ok(
    report.indexOf("### Checklist") <
      report.indexOf("### Study guides updated (1)"),
  );
  assert.match(
    report,
    /or the study guide for an exam only a study guide shows so far/,
  );
  assertChecklist(report);
});

test("the report stays under GitHub's issue size limit: diffs shrink first, then the report is cut with a note", () => {
  const lines = (prefix, n, width) =>
    Array.from(
      { length: n },
      (_, i) => `- ${prefix} ${i} ${"w".repeat(width)}`,
    );
  const big = (code) =>
    reportGuide(code, {
      diff: summarizeDiff(lines("old", 80, 280), lines("new", 80, 280)),
    });
  const guides = Array.from({ length: 30 }, (_, i) => big(`AZ-${100 + i}`));
  const report = buildReport({
    exams: [],
    certs: [],
    guides,
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  assert.ok(report.length <= 60000, `${report.length} characters`);
  assert.match(report, /more changed lines? (?:is|are) not shown here/);
  assert.match(
    report,
    /The diffs are shortened to keep this issue under GitHub's size limit/,
  );
  assert.match(report, /#### What to do/);
  // Every guide still has its row, even when its diff is left out.
  for (const guide of guides)
    assert.ok(report.includes(`| ${guide.code} `), guide.code);

  // Even the tables alone can exceed the limit: the tail is cut and says so.
  const many = Array.from({ length: 700 }, (_, i) =>
    reportGuide(`AZ-${1000 + i}`, { name: "Name ".repeat(40) }),
  );
  const cut = buildReport({
    exams: [],
    certs: [],
    guides: many,
    scan: { exams: new Map(), certs: new Map() },
    today: "2026-10-09",
  });
  assert.ok(cut.length <= 60000, `${cut.length} characters`);
  assert.match(cut, /cut at the size limit of a GitHub issue/);
  assert.ok(cut.endsWith("\n"));
});

test("studyGuideUrl uses the repo's URL form", () => {
  assert.equal(
    studyGuideUrl("AB-650"),
    "https://learn.microsoft.com/credentials/certifications/resources/study-guides/ab-650?WT.mc_id=studentamb_165290",
  );
});

// The report is posted in a public issue: internal planning stays out of it.
const INTERNAL_WORDS = /\b(tasks?|board|tasks\.mjs|lifecycle)\b/i;

function assertChecklist(report) {
  for (const needle of [
    "scripts/new-exam.mjs",
    "src/data_files/exam-status.mjs",
    "src/data_files/beta-exams.json",
    "Beta Exam Pages",
    ":::note",
    "scripts/audit-missing-resources.mjs",
    "pnpm build",
    "runbook (`docs/monitors/new-exam-monitor.md`)",
    "First detected",
  ]) {
    assert.ok(report.includes(needle), `report is missing "${needle}"`);
  }
  // The beta start comes from the announcement or the maintainers, never from this issue.
  assert.match(report, /not\*\* from the "First detected" date/);
  assert.match(report, /not the day the beta began/);
  assert.match(
    report,
    /`--beta` needs `--beta-start`, the day the beta period began: take it from the official announcement or the maintainers/,
  );
  // The beta entry has the two fields, and the note is printed, not computed by hand.
  assert.match(
    report,
    /with `betaStart` \(the `--beta-start` day\) and `announcement`: `"pending"` while the Skills Hub announcement is still due \(at most 7 days after the beta start\), `"unannounced"` after 7 days without one, or the announcement URL/,
  );
  assert.match(
    report,
    /Never compute the dates of the note by hand: `node scripts\/beta-note\.mjs --code <CODE>` prints the note for the entry/,
  );
  assert.match(report, /--expects "<its go-live wording>"/);
  // The scaffold writes the standard tip and the note now: there is no banner to replace.
  assert.doesNotMatch(report, /BetaBanner/);
  assert.doesNotMatch(report, /calculated window/);
  assert.doesNotMatch(report, INTERNAL_WORDS);
}

// The edit of a drift row that tells how to add a beta exam: the two fields of its
// beta-exams.json entry and the generated note instead of dates worked out by hand.
// The first rendering of a row keeps 1000 characters of it, so it is not cut there.
function assertBetaEntryEdit(edit, code) {
  assert.match(edit, /betaStart and announcement/);
  assert.match(edit, /pending, unannounced or the announcement URL/);
  assert.ok(
    edit.includes(`node scripts/beta-note.mjs --code ${code}`),
    `the edit names the note command for ${code}: ${edit}`,
  );
  assert.match(
    edit,
    /beta start date comes from the official announcement or the maintainers, never from this issue/,
  );
  assert.doesNotMatch(edit, /calculated window/);
  assert.ok(edit.length <= 1000, `the edit is ${edit.length} characters`);
}

// ---------------------------------------------------------------------------
// End to end against a local fake of the Microsoft Learn endpoints
// ---------------------------------------------------------------------------
const CONFIG_KEYS = [
  "LEARN_BASE_URL",
  "TRACKER_FILE",
  "DOCS_DIR",
  "REPORT_FILE",
  "ERROR_FILE",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "MIN_CERTIFICATIONS",
  "MIN_PAGE_OK_PCT",
  "MIN_BASELINE_PAGE_OK_PCT",
  "MAX_EMPTY_PAGE_PCT",
  "MAX_NEW_EXAMS",
  "MAX_NEW_CERTS",
  "MAX_NEW_PCT",
  "MIN_STUDY_GUIDES",
  "MAX_GUIDE_CHANGES",
  "MAX_GUIDE_CHANGE_PCT",
  "MAX_GUIDE_FETCH_FAILURES",
  "FORCE_BASELINE",
  "FORCE_GUIDE_BASELINE",
  "DRIFT_CHECK",
  "DRIFT_REPORT_FILE",
  "DRIFT_ERROR_FILE",
  "EXAM_STATUS_FILE",
  "BETA_EXAMS_FILE",
  "RETIRING_EXAMS_FILE",
  "MAX_DRIFT",
  "FORCE_DRIFT",
  "CERT_RENAME_DAYS",
  "PROBE_DEADLINE_MS",
  "CREATE_ISSUES",
  "DRY_RUN",
  "GH_CLI_SCRIPT",
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "FETCH_DELAY_MS",
  "FETCH_ATTEMPTS",
  "RETRY_BASE_MS",
  "MAX_RETRY_AFTER_MS",
  "FETCH_TIMEOUT_MS",
  "RUN_DEADLINE_MS",
  "LOOKUP_DEADLINE_MS",
  "GUIDE_DEADLINE_MS",
  "GITHUB_ACTIONS",
  "TODAY",
];

function exam(code, name, beta = false) {
  return { code, name, beta };
}

function cert(slug, exams, extra = {}) {
  return {
    slug,
    title: `Microsoft Certified: ${slug}`,
    layout: "classic",
    types: ["role-based"],
    products: ["Azure"],
    exams,
    ...extra,
  };
}

// A guide request the fake answered with 304 is logged with this suffix.
const NOT_MODIFIED = " [304]";

/** What the fake Learn serves. Tests change it between runs. */
function baseWorld() {
  const certs = [];
  for (let i = 1; i <= 12; i++) {
    const code = `AZ-9${String(i).padStart(2, "0")}`;
    certs.push(
      cert(`azure-role-${i}`, [exam(code, `Azure Role ${i}`)], {
        layout: i % 2 ? "new" : "classic",
      }),
    );
  }
  certs.push(
    cert("mos-word-2099", [exam("MO-901", "Word 2099")], {
      layout: "new",
      types: ["mos"],
    }),
  );
  return {
    certs,
    standalone: [exam("77-901", "Legacy Thing")],
    studyGuides: {},
    // code -> { name, beta } for a real exam page, or { redirect: true } for an
    // exam URL that lands on the certification page like many do on Learn.
    examPages: {},
    // Answers (true = handled) a request for an exam page, to make it fail.
    examPageHook: null,
    listingHook: null,
    pageHooks: new Map(),
    // Study guides in the credentials sitemap: code -> guideSpec(). Tests that
    // do not add any leave the sitemap without guides, which the monitor skips.
    guides: {},
    guideHooks: new Map(),
    // Answers (true = handled) a request for the study guide page that is not
    // in the sitemap: the probe of an UPCOMING exam asks for it.
    studyGuideHook: null,
    indexHook: null,
    sitemapHook: null,
    sitemapSplit: false,
    // true = the server ignores If-Modified-Since and always sends the page
    ignoreConditional: false,
    requests: [],
    // When each request came in, by the index in `requests` (it is reused after a reset).
    times: [],
  };
}

// ---------------------------------------------------------------------------
// A fake of the study guide side of Learn: sitemap index, credentials sitemap
// and guide pages in the markup shape of the real ones (see tests/fixtures)
// ---------------------------------------------------------------------------
const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * What a guide page says. `noise` changes only what the monitor must ignore.
 * `modified` is when Learn (re)published the page (the Last-Modified header; the
 * page date `updatedAt` by default). `notices` puts callout boxes where Learn
 * does: `pre` before the first heading, `purpose` under "Purpose of this
 * document" (both are guide text), `resources` and `changeLog` under the study
 * resources and the change log (not guide text).
 */
function guideSpec(overrides = {}) {
  return {
    name: "Some Exam",
    lastmod: "2026-09-01",
    updatedAt: "2026-09-01T10:00:00Z",
    updates: [
      "Our exams are updated periodically to reflect skills that are required to perform a role.",
      "We always update the English language version of the exam first.",
    ],
    heading: "Skills measured as of September 1, 2026",
    groups: [
      { title: "Group A (20–25%)", bullets: ["Do A1", "Do A2", "Do A3"] },
      { title: "Group B (30–35%)", bullets: ["Do B1", "Do B2"] },
    ],
    noise: 0,
    ...overrides,
  };
}

/** A callout box as Learn renders "> [!WARNING]": a label and the text. */
function callout(text, kind = "WARNING") {
  const label = kind[0] + kind.slice(1).toLowerCase();
  return `<div class="${kind}">\n<p>${label}</p>\n<p>${escapeHtml(text)}</p>\n</div>\n`;
}

function guideHtml(code, spec) {
  const n = spec.noise;
  const notices = spec.notices ?? {};
  const box = (where) =>
    notices[where] ? callout(notices[where], notices[`${where}Kind`]) : "";
  const text = (value) => {
    const escaped = escapeHtml(value);
    return spec.rewrap ? escaped.replace(/ /g, "\n") : escaped;
  };
  const skills = spec.skillsMissing
    ? ""
    : `<h2 id="skills-measured-as-of-${n}">${escapeHtml(spec.heading)}</h2>\n` +
      '<h3 id="audience-profile">Audience profile</h3>\n<p>You build things.</p>\n' +
      box("skills") +
      spec.groups
        .map(
          (group, i) =>
            `<h3 id="group-${i}-${n}">${escapeHtml(group.title)}</h3>\n<ul>\n` +
            group.bullets
              .map((bullet) => `<li><p>${text(bullet)}</p>\n</li>`)
              .join("\n") +
            "\n</ul>",
        )
        .join("\n");
  return (
    `<!DOCTYPE html><html><head><title>${spec.noTitle ? "Just a moment..." : `Study guide for Exam ${code}: ${escapeHtml(spec.name)} | Microsoft Learn`}</title>` +
    `<meta name="updated_at" content="${spec.updatedAt}" /><meta name="ms.date" content="2026-08-01T00:00:00Z" /></head>` +
    `<body><header><nav class="nav-${n}">Sign in ${n}</nav></header><main id="main-${n}">` +
    `<div class="content"><h1 id="study-guide-${n}">Study guide for Exam ${code}</h1></div>` +
    '<nav id="center-doc-outline"><h2 id="ms--in-this-article" class="title is-6">In this article</h2></nav>' +
    `<div class="content">${box("pre")}\n<h2 id="purpose-of-this-document">Purpose of this document</h2>\n` +
    box("purpose") +
    `<p>Useful links <a href="/en-us/credentials/some-page?churn=${n}" data-linktype="absolute-path">link ${n}</a></p>\n` +
    (spec.updatesMissing
      ? ""
      : `<h2 id="${spec.updatesId ?? "updates-to-the-exam"}">${spec.updatesId === "about-the-exam" ? "About the exam" : "Updates to the exam"}</h2>\n` +
        spec.updates
          .map((paragraph) => `<p>${text(paragraph)}</p>`)
          .join("\n") +
        "\n") +
    skills +
    // MB-310 has no study resources: its change log follows the skills directly.
    (spec.noStudyResources
      ? "\n"
      : '\n<h2 id="study-resources">Study resources</h2>\n' +
        box("resources") +
        `<table><tbody><tr><td><a href="/en-us/azure/?x=${n}">Docs ${n}</a></td></tr></tbody></table>\n`) +
    '<h2 id="change-log">Change log</h2>\n' +
    box("changeLog") +
    `<table><tbody><tr><td>Change ${n}</td></tr></tbody></table>\n</div>\n` +
    '<div id="ms--inline-notifications" class="margin-block-xs"></div>' +
    '<div id="ms--additional-resources-mobile"><hr hidden />' +
    '<h2 id="ms--additional-resources-mobile-heading" hidden>Additional resources</h2></div>' +
    `<footer>Last updated <local-time datetime="2026-09-0${(n % 9) + 1}T00:00:00Z">${n}</local-time></footer></main></body></html>`
  );
}

const SITEMAP_NS =
  'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"';

function sitemapIndexXml(world) {
  const loc = (name) =>
    `<sitemap><loc>https://learn.microsoft.com/_sitemaps/${name}</loc><lastmod>2026-10-05</lastmod></sitemap>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    [
      "credentials_de-de_1.xml",
      "credentials_en-us_1.xml",
      ...(world.sitemapSplit ? ["credentials_en-us_2.xml"] : []),
      "previous-versions_en-us_1.xml",
    ]
      .map(loc)
      .join("") +
    "</sitemapindex>"
  );
}

function credentialsSitemapXml(world, file) {
  const url = (path, lastmod) =>
    `<url><loc>https://learn.microsoft.com/en-us/credentials/${path}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}` +
    `<xhtml:link rel="alternate" hreflang="de-de" href="https://learn.microsoft.com/de-de/credentials/${path}" /></url>`;
  const codes = Object.keys(world.guides)
    .filter((code) => world.guides[code].inSitemap !== false)
    .sort();
  const mine = world.sitemapSplit
    ? codes.filter((_, i) => (i % 2 === 0) === (file === 1))
    : file === 1
      ? codes
      : [];
  return (
    `<?xml version="1.0" encoding="utf-8"?><urlset ${SITEMAP_NS}>` +
    // What else lives in that file on the real sitemap: ignored by the monitor.
    (file === 1
      ? url("certifications/azure-administrator/", "2026-08-07") +
        url("applied-skills/resources/study-guides/apl-1001", "2026-09-01") +
        url("applied-skills/resources/study-guides/apl-1002", "2026-09-02") +
        url("certifications/practice/results", "2026-08-25")
      : "") +
    mine
      .map((code) =>
        url(
          `certifications/resources/study-guides/${code.toLowerCase()}`,
          world.guides[code].sitemapLastmod ?? world.guides[code].lastmod,
        ),
      )
      .join("") +
    "</urlset>"
  );
}

function certHtml(c) {
  const exams = c.layout === "none" ? [] : c.exams;
  const metas =
    c.layout === "new"
      ? exams
          .map(
            (e) =>
              `<meta name="learn_exam" content="exam.${e.code.toLowerCase()}" />`,
          )
          .join("\n")
      : "";
  const cards =
    c.layout === "new"
      ? exams
          .map(
            (e) =>
              `<a class="exam-card-title" href="../exams/${e.code.toLowerCase()}/">${e.code}: ${e.name}${e.beta ? " (beta)" : ""}</a>`,
          )
          .join("\n")
      : "";
  const schedule = (c.noSchedule ? [] : exams)
    .map(
      (e) =>
        `<a href="/en-us/credentials/certifications/schedule-through-pearson-vue?examUid=exam.${e.code}&amp;examUrl=https://learn.microsoft.com/credentials/certifications" data-exam-provider-link="">Schedule exam</a>`,
    )
    .join("\n");
  const callout = c.announcement
    ? `<div class="IMPORTANT"><p>Important</p><p><a href="${c.announcement}" data-linktype="external">Learn more about the beta exam ${c.exams[0].code}</a></p></div>`
    : "";
  return (
    `<!DOCTYPE html><html><head><title>${c.title}${c.beta ? " (beta)" : ""} - Certifications | Microsoft Learn</title>` +
    `<meta name="uid" content="certification.${c.slug}" /><meta name="schema" content="Certification" />${metas}</head>` +
    `<body><main><h1>${c.title}</h1>${callout}${cards}${schedule}</main></body></html>`
  );
}

function listingItems(world) {
  const items = world.certs.map((c) => ({
    credential_types: ["certification", ...c.types],
    hidden: false,
    ...(c.layout === "new"
      ? {
          exams: c.exams.map((e) => ({
            uid: `exam.${e.code.toLowerCase()}`,
            display_name: e.code,
          })),
        }
      : { exams: [] }),
    uid: `certification.${c.slug}`,
    title: `${c.title}${c.beta ? " (beta)" : ""}`,
    products: ["p"],
    display_products: c.products,
    url: `/credentials/certifications/${c.slug}/`,
  }));
  for (const e of world.standalone) {
    items.push({
      credential_types: ["examination"],
      hidden: false,
      exam_display_name: e.code,
      uid: `exam.${e.code.toLowerCase()}`,
      title: `${e.name}${e.beta ? " (beta)" : ""}`,
      products: ["office"],
      display_products: ["Office"],
      url: `/credentials/certifications/exams/${e.code.toLowerCase()}/`,
    });
  }
  items.push({
    credential_types: ["applied skills"],
    hidden: false,
    uid: "applied-skill.something",
    title: "Applied thing",
    url: "/credentials/applied-skills/something/",
  });
  return items;
}

async function startLearn(world) {
  let listingCalls = 0;
  const pageCalls = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://learn.test");
    const logged = world.requests.push(url.pathname) - 1;
    world.times[logged] = Date.now();

    if (url.pathname === "/api/contentbrowser/search/credentials") {
      listingCalls++;
      if (world.listingHook?.(request, response, listingCalls)) return;
      const items = listingItems(world);
      const skip = Number(url.searchParams.get("$skip") ?? 0);
      const size = 6;
      const body = {
        results: items.slice(skip, skip + size),
        count: items.length,
      };
      if (skip + size < items.length) {
        body["@nextLink"] =
          `/api/contentbrowser/search/credentials?locale=en-us&$top=100&$skip=${skip + size}`;
      }
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify(body));
    }

    const page = url.pathname.match(
      /^\/en-us\/credentials\/certifications\/([^/]+)\/$/,
    );
    if (page) {
      const count = (pageCalls.get(page[1]) ?? 0) + 1;
      pageCalls.set(page[1], count);
      if (world.pageHooks.get(page[1])?.(request, response, count)) return;
      const found = world.certs.find((c) => c.slug === page[1]);
      if (!found) {
        response.statusCode = 404;
        return response.end("not found");
      }
      response.setHeader("content-type", "text/html");
      return response.end(certHtml(found));
    }

    const examPage = url.pathname.match(
      /^\/credentials\/certifications\/exams\/([^/]+)\/$/,
    );
    if (
      examPage &&
      world.examPageHook?.(request, response, examPage[1].toUpperCase())
    ) {
      return;
    }
    const examEntry = examPage && world.examPages[examPage[1].toUpperCase()];
    if (examEntry) {
      const code = examPage[1].toUpperCase();
      response.setHeader("content-type", "text/html");
      return response.end(
        examEntry.redirect
          ? "<title>Microsoft Certified: Something - Certifications | Microsoft Learn</title>"
          : `<title>Exam ${code}: ${examEntry.name}${examEntry.beta ? " (beta)" : ""} - Certifications | Microsoft Learn</title>`,
      );
    }

    const guide = url.pathname.match(
      /^\/credentials\/certifications\/resources\/study-guides\/([^/]+)$/,
    );
    if (guide && world.studyGuideHook?.(request, response, guide[1])) return;
    const guideName =
      guide &&
      (world.studyGuides[guide[1].toUpperCase()] ??
        world.guides[guide[1].toUpperCase()]?.name);
    if (guide && guideName) {
      const code = guide[1].toUpperCase();
      response.setHeader("content-type", "text/html");
      return response.end(
        `<title>Study guide for Exam ${code}: ${guideName} | Microsoft Learn</title>`,
      );
    }

    // The study guide side: sitemap index, credentials sitemap, guide pages.
    if (url.pathname === "/_sitemaps/sitemapindex.xml") {
      if (world.indexHook?.(request, response)) return;
      response.setHeader("content-type", "application/xml");
      return response.end(sitemapIndexXml(world));
    }
    const sitemap = url.pathname.match(
      /^\/_sitemaps\/credentials_en-us_(\d+)\.xml$/,
    );
    if (sitemap) {
      if (world.sitemapHook?.(request, response, Number(sitemap[1]))) return;
      response.setHeader("content-type", "application/xml");
      return response.end(credentialsSitemapXml(world, Number(sitemap[1])));
    }
    const guidePage = url.pathname.match(
      /^\/en-us\/credentials\/certifications\/resources\/study-guides\/([^/]+)$/,
    );
    if (guidePage) {
      const code = guidePage[1].toUpperCase();
      const count = (pageCalls.get(`guide:${code}`) ?? 0) + 1;
      pageCalls.set(`guide:${code}`, count);
      if (world.guideHooks.get(code)?.(request, response, count)) return;
      const spec = world.guides[code];
      if (spec && !spec.gone) {
        // Like Learn: the page carries the time it was published as
        // Last-Modified and answers 304 when the client already has that version.
        const modified = new Date(spec.modified ?? spec.updatedAt);
        const since = Date.parse(request.headers["if-modified-since"] ?? "");
        if (!world.ignoreConditional && since >= modified.getTime()) {
          world.requests[logged] += NOT_MODIFIED;
          response.statusCode = 304;
          return response.end();
        }
        response.setHeader("content-type", "text/html");
        response.setHeader("last-modified", modified.toUTCString());
        return response.end(guideHtml(code, spec));
      }
    }

    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "new-exam-test-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "docs", "azure"), { recursive: true });
  return {
    dir,
    tracker: join(dir, "learn-exams.json"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
    output: join(dir, "output"),
    docs: join(dir, "docs"),
  };
}

/** Runs the script once and returns its exit code, outputs and logs. */
async function runMonitor(box, learn, extra = {}) {
  await writeFile(box.output, "");
  const env = { ...process.env };
  for (const key of CONFIG_KEYS) delete env[key];
  Object.assign(env, {
    LEARN_BASE_URL: learn.origin,
    TRACKER_FILE: box.tracker,
    DOCS_DIR: box.docs,
    REPORT_FILE: box.report,
    ERROR_FILE: box.error,
    GITHUB_OUTPUT: box.output,
    MIN_CERTIFICATIONS: "5",
    MIN_STUDY_GUIDES: "3",
    FETCH_DELAY_MS: "0",
    FETCH_ATTEMPTS: "2",
    RETRY_BASE_MS: "1",
    TODAY: "2026-10-09",
    // These tests are about the exam and study guide checks; the hub-vs-Learn
    // drift check has its own tests below and is switched on there.
    DRIFT_CHECK: "0",
    ...extra,
  });
  const child = spawn(process.execPath, ["scripts/new-exam-check.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((done) => child.on("close", done));

  const outputs = {};
  for (const line of (await readFile(box.output, "utf8")).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { code, outputs, stdout, stderr };
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const readTracker = async (box) =>
  JSON.parse(await readFile(box.tracker, "utf8"));

async function baselined(extra) {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  const first = await runMonitor(box, learn, extra);
  assert.equal(first.code, 0, first.stderr);
  return { world, learn, box };
}

test("the first run records a silent baseline and opens no issue", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.outputs, {
      changes_found: "false",
      baseline_updated: "true",
      extraction_failed: "false",
      // This sitemap lists no guides, so the guide check did not run.
      guide_check_failed: "skipped",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "0",
      study_guides_changed: "0",
      issue_title: "",
    });
    assert.equal(await exists(box.report), false);
    assert.match(result.stdout, /Baseline: 13 certifications, 14 exams/);
    assert.match(
      result.stdout,
      /12 of 12 exams in the hub areas have no hub page/,
    );

    const tracker = await readTracker(box);
    assert.equal(tracker.certifications.length, 13);
    assert.equal(tracker.exams.length, 14);
    assert.match(tracker.lastSynced, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(
      tracker.exams.map((e) => e.code),
      [...tracker.exams.map((e) => e.code)].sort(),
    );
    const azure1 = tracker.exams.find((e) => e.code === "AZ-901");
    assert.equal(azure1.name, "Azure Role 1"); // new layout card
    assert.equal(
      azure1.url,
      "https://learn.microsoft.com/credentials/certifications/exams/az-901?WT.mc_id=studentamb_165290",
    );
    assert.equal(azure1.firstSeen, "2026-10-09");
    const azure2 = tracker.exams.find((e) => e.code === "AZ-902");
    assert.equal(azure2.name, ""); // classic page
    // No exam page is confirmed on a classic page: no guessed URL is stored.
    assert.equal(azure2.url, "");
    assert.equal(azure2.beta, false);
    const legacy = tracker.exams.find((e) => e.code === "77-901");
    assert.equal(legacy.certifications.length, 0);
    // A standalone exam links its own page in the listing: that one is confirmed.
    assert.equal(
      legacy.url,
      "https://learn.microsoft.com/credentials/certifications/exams/77-901?WT.mc_id=studentamb_165290",
    );
    // Applied Skills are another monitor's business.
    assert.ok(!JSON.stringify(tracker).includes("applied"));
  } finally {
    await learn.close();
  }
});

test("a baseline lists what it swallowed in the job summary", async () => {
  const world = baseWorld();
  world.certs.push(cert("contoso-ai", [exam("CP-901", "Contoso AI")]));
  const learn = await startLearn(world);
  const box = await sandbox();
  const summary = join(box.dir, "summary.md");
  try {
    await writeFile(join(box.docs, "azure", "AZ-901.mdx"), "---\n---\n");
    const result = await runMonitor(box, learn, {
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.match(
      result.stdout,
      /exams are in families the hub neither maps nor ignores: CP-901/,
    );
    assert.match(result.stdout, /\d+ of \d+ certification pages list no exam/);

    const text = await readFile(summary, "utf8");
    assert.match(text, /New Exam Monitor: Baseline/);
    assert.match(text, /without a hub page[^\n]*`AZ-902`/);
    assert.doesNotMatch(text, /without a hub page[^\n]*`AZ-901`/); // has a page
    assert.match(text, /neither maps nor ignores[^\n]*`CP-901`/);
    assert.doesNotMatch(text, /`77-901`|`MO-901`/); // ignored families
    assert.doesNotMatch(text, INTERNAL_WORDS);
  } finally {
    await learn.close();
  }
});

test("a second run changes nothing, not even on another day", async () => {
  const { learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    const again = await runMonitor(box, learn, { TODAY: "2026-10-10" });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.outputs.changes_found, "false");
    assert.equal(again.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.equal(await exists(box.report), false);
  } finally {
    await learn.close();
  }
});

test("a new classic-layout exam is reported once, named from its study guide, with an unknown status and the certification link", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "true");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AZ-950; 1 new certification",
    );
    const report = await readFile(box.report, "utf8");
    // Nothing says GA: the study guide title never carries "(beta)".
    assert.match(
      report,
      /\| AZ-950 \| Designing New Things \| unknown, check Learn \|/,
    );
    assert.match(report, /src\/content\/docs\/azure\/AZ-950\.mdx/);
    // The exam page is unconfirmed (it 404s here): link the certification page.
    assert.doesNotMatch(report, /exams\/az-950/);
    assert.match(
      report,
      /\[Certification page\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/azure-new-thing\/\?WT\.mc_id=studentamb_165290\) \(no exam page confirmed\)/,
    );
    assert.match(report, /\| 2026-10-09 \|/);
    assert.match(
      report,
      /node scripts\/new-exam\.mjs --code AZ-950 --name "Designing New Things"\n/,
    );
    assert.doesNotMatch(report, /--code AZ-950[^\n]*--beta/);
    assert.match(report, /### New certifications \(1\)/);
    assertChecklist(report);

    const tracker = await readTracker(box);
    const record = tracker.exams.find((e) => e.code === "AZ-950");
    assert.equal(record.name, "Designing New Things");
    assert.equal(record.url, ""); // never a guessed exam URL
    assert.equal(record.beta, false);

    const again = await runMonitor(box, learn);
    assert.equal(again.outputs.changes_found, "false");
    assert.equal(again.outputs.baseline_updated, "false");
    assert.equal(
      await exists(box.report),
      false,
      "a stale report must not survive",
    );
  } finally {
    await learn.close();
  }
});

test("the exam page confirms a new classic-layout exam and supplies its beta marker", async () => {
  const { world, learn, box } = await baselined();
  try {
    // The certification title carries no "(beta)" and the study guide never does.
    world.certs.push(cert("azure-beta-thing", [exam("AZ-960", "")]));
    world.studyGuides["AZ-960"] = "Ignored Study Guide Name";
    world.examPages["AZ-960"] = { name: "Designing Beta Things", beta: true };
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AZ-960 (beta); 1 new certification",
    );
    const report = await readFile(box.report, "utf8");
    assert.match(report, /\| AZ-960 \| Designing Beta Things \| BETA \|/);
    assert.match(
      report,
      /\[Exam page\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/exams\/az-960\?WT\.mc_id=studentamb_165290\)/,
    );
    assert.doesNotMatch(report, /Certification page\]\([^)]*\) \(no exam page/);
    assert.match(
      report,
      /--code AZ-960 --name "Designing Beta Things" --beta --beta-start <YYYY-MM-DD>\n/,
    );
    assertChecklist(report);

    const record = (await readTracker(box)).exams.find(
      (e) => e.code === "AZ-960",
    );
    assert.equal(record.beta, true);
    assert.equal(
      record.url,
      "https://learn.microsoft.com/credentials/certifications/exams/az-960?WT.mc_id=studentamb_165290",
    );
  } finally {
    await learn.close();
  }
});

test("an exam page that is a GA page makes the status known; one that redirects confirms nothing", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(
      cert("azure-two-new", [exam("AZ-961", ""), exam("AZ-962", "")], {
        beta: true,
      }),
    );
    world.examPages["AZ-961"] = { name: "Plain GA Exam", beta: false };
    world.examPages["AZ-962"] = { redirect: true };
    world.studyGuides["AZ-962"] = "Named By Guide";
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    const report = await readFile(box.report, "utf8");
    assert.match(report, /\| AZ-961 \| Plain GA Exam \| GA \|/);
    // A beta certification with two exams: nobody says which one is beta.
    assert.match(
      report,
      /\| AZ-962 \| Named By Guide \| unknown \(its certification is BETA\), check Learn \|/,
    );
    assert.match(report, /exams\/az-961\?WT\.mc_id/);
    assert.doesNotMatch(report, /exams\/az-962/);
    assert.match(report, /--code AZ-961 --name "Plain GA Exam"\n/);
    assert.doesNotMatch(report, /--code AZ-962[^\n]*--beta/);

    const tracker = await readTracker(box);
    assert.notEqual(tracker.exams.find((e) => e.code === "AZ-961").url, "");
    assert.equal(tracker.exams.find((e) => e.code === "AZ-962").url, "");
  } finally {
    await learn.close();
  }
});

test("a new exam family is alerted instead of being swallowed, with a note to map or ignore it", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(
      cert("contoso-ai-engineer", [exam("CP-100", "Contoso AI")], {
        layout: "new",
        beta: true,
      }),
    );
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "true");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: CP-100 (beta); 1 new certification",
    );
    assert.match(
      result.stdout,
      /New exam CP-100 is in a family the hub neither maps nor ignores/,
    );
    const report = await readFile(box.report, "utf8");
    assert.match(report, /\| CP-100 \| Contoso AI \| BETA \|/);
    assert.match(report, /no hub area for this prefix/);
    assert.match(report, /### Exam families without a hub area/);
    assert.match(report, /CP-100 \(no hub area\)/);
    assert.doesNotMatch(report, /new-exam\.mjs --code CP-100/);
    assert.doesNotMatch(report, /\bnull\b/);

    // Reported once: the tracker knows it now.
    const again = await runMonitor(box, learn);
    assert.equal(again.outputs.changes_found, "false");
  } finally {
    await learn.close();
  }
});

test("a new certification whose only exam is in a new family is alerted too", async () => {
  const { world, learn, box } = await baselined();
  try {
    // The exam is already tracked, so only the certification is new.
    world.certs.push(cert("family-first", [exam("CP-200", "First")]));
    await runMonitor(box, learn); // records CP-200 and family-first
    world.certs.push(cert("family-second", [exam("CP-200", "First")]));
    const result = await runMonitor(box, learn);

    assert.equal(result.outputs.changes_found, "true");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn certification: Microsoft Certified: family-second",
    );
    assert.match(await readFile(box.report, "utf8"), /CP-200 \(no hub area\)/);
  } finally {
    await learn.close();
  }
});

test("a new beta exam is reported with its announcement and a case-preserved title", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(
      cert(
        "ai-new-admin",
        [exam("AB-960", "Administering Something New", true)],
        {
          layout: "new",
          beta: true,
          products: ["Microsoft 365", "Microsoft Entra"],
          announcement:
            "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-cert/123",
        },
      ),
    );
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "true");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AB-960 (beta); 1 new certification",
    );
    assert.notEqual(
      result.outputs.issue_title,
      result.outputs.issue_title.toLowerCase(),
    );
    const raw = await readFile(box.output, "utf8");
    assert.match(
      raw,
      /^issue_title=New Microsoft Learn exam: AB-960 \(beta\)/m,
    );

    const report = await readFile(box.report, "utf8");
    assert.match(report, /\| AB-960 \| Administering Something New \| BETA \|/);
    assert.match(report, /Microsoft 365, Microsoft Entra/);
    assert.match(report, /src\/content\/docs\/aibusiness\/AB-960\.mdx/);
    assert.match(
      report,
      /\[Learn more about the beta exam AB-960\]\(https:\/\/techcommunity\.microsoft\.com\/blog\/skills-hub-blog\/new-cert\/123\)/,
    );
    assert.match(
      report,
      /--code AB-960 --name "Administering Something New" --beta --beta-start <YYYY-MM-DD>\n/,
    );
    assertChecklist(report);

    const tracker = await readTracker(box);
    const record = tracker.exams.find((e) => e.code === "AB-960");
    assert.equal(record.beta, true);
    assert.deepEqual(record.announcements, [
      "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-cert/123",
    ]);
    assert.equal(
      tracker.certifications.find((c) => c.slug === "ai-new-admin").beta,
      true,
    );
  } finally {
    await learn.close();
  }
});

test("a new certification without an exam is reported on its own", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(cert("azure-future", [], { layout: "none" }));
    const result = await runMonitor(box, learn);

    assert.equal(result.outputs.changes_found, "true");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn certification: Microsoft Certified: azure-future",
    );
    const report = await readFile(box.report, "utf8");
    assert.match(report, /### New certifications \(1\)/);
    assert.match(report, /none listed yet/);
    assert.doesNotMatch(report, /### New exams/);
    assert.doesNotMatch(report, INTERNAL_WORDS);

    // Its exam shows up later: that is a new exam, the certification is not repeated.
    world.certs.find((c) => c.slug === "azure-future").exams = [
      exam("AZ-955", "Future"),
    ];
    world.certs.find((c) => c.slug === "azure-future").layout = "new";
    const later = await runMonitor(box, learn);
    assert.equal(later.outputs.issue_title, "New Microsoft Learn exam: AZ-955");
    assert.doesNotMatch(
      await readFile(box.report, "utf8"),
      /### New certifications/,
    );
  } finally {
    await learn.close();
  }
});

test("exams that already have a hub page are tracked without an alert", async () => {
  const { world, learn, box } = await baselined();
  try {
    await writeFile(
      join(box.docs, "azure", "AZ-951.mdx"),
      "---\ntitle: AZ-951 Study Materials\n---\n",
    );
    await writeFile(
      join(box.docs, "azure", "AZ-952.mdx"),
      "---\ntitle: AZ-952 Study Materials\n---\n",
    );

    // An exam appearing under a certification we already track: silent.
    world.certs
      .find((c) => c.slug === "azure-role-2")
      .exams.push(exam("AZ-952", ""));
    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.changes_found, "false");
    assert.equal(quiet.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    assert.ok((await readTracker(box)).exams.some((e) => e.code === "AZ-952"));

    // A new certification for a covered exam is still announced, but not the exam.
    world.certs.push(cert("azure-renamed", [exam("AZ-951", "")]));
    const renamed = await runMonitor(box, learn);
    assert.equal(renamed.outputs.changes_found, "true");
    const report = await readFile(box.report, "utf8");
    assert.doesNotMatch(report, /### New exams/);
    assert.match(report, /AZ-951 \(hub page exists\)/);
    assert.ok((await readTracker(box)).exams.some((e) => e.code === "AZ-951"));
  } finally {
    await learn.close();
  }
});

test("Office and legacy exams are tracked but never alerted", async () => {
  const { world, learn, box } = await baselined();
  try {
    world.certs.push(
      cert("mos-excel-2099", [exam("MO-950", "Excel 2099")], {
        layout: "new",
        types: ["mos"],
      }),
    );
    world.certs.push(
      cert("office-other", [exam("MO-951", "Other")], { layout: "new" }),
    );
    world.standalone.push(exam("98-950", "Old Thing"));
    const result = await runMonitor(box, learn);

    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    const codes = (await readTracker(box)).exams.map((e) => e.code);
    for (const code of ["MO-950", "MO-951", "98-950"])
      assert.ok(codes.includes(code), code);
  } finally {
    await learn.close();
  }
});

test("a certification page that cannot be fetched keeps its exams and raises nothing", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    world.pageHooks.set("azure-role-3", (_request, response) => {
      response.statusCode = 500;
      response.end("boom");
      return true;
    });
    world.pageHooks.set("azure-role-4", (_request, response) => {
      response.statusCode = 404;
      response.end("gone");
      return true;
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.match(
      result.stderr,
      /Could not read the page of "azure-role-3"; kept the previous exam list/,
    );
    assert.match(result.stderr, /could not read the page of "azure-role-4"/);
  } finally {
    await learn.close();
  }
});

test("a page without exam signals keeps the exams the tracker knew", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    const target = world.certs.find((c) => c.slug === "azure-role-1"); // new layout
    target.layout = "none";
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.match(
      result.stderr,
      /"azure-role-1" lists no exam although the tracker knew AZ-901/,
    );
  } finally {
    await learn.close();
  }
});

test("exams and certifications that disappear from Learn stay in the tracker silently", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    world.certs = world.certs.filter((c) => c.slug !== "azure-role-5");
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.ok((await readTracker(box)).exams.some((e) => e.code === "AZ-905"));
  } finally {
    await learn.close();
  }
});

test("a flood of new exams is treated as a structure change, unless a re-baseline is forced", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    for (let i = 0; i < 5; i++) {
      world.certs.push(cert(`flood-${i}`, [exam(`SC-97${i}`, `Flood ${i}`)]));
    }

    const byPercent = await runMonitor(box, learn);
    assert.equal(byPercent.code, 1);
    assert.equal(byPercent.outputs.extraction_failed, "true");
    assert.equal(byPercent.outputs.changes_found, "false");
    assert.equal(byPercent.outputs.baseline_updated, "false");
    const error = await readFile(box.error, "utf8");
    assert.match(error, /5 new exams appeared at once/);
    // The way out is the workflow's `force_baseline` input (see the workflow test).
    assert.match(error, /FORCE_BASELINE=1/);
    assert.match(error, /`force_baseline`/);
    assert.deepEqual(await readFile(box.tracker), before);

    const byCount = await runMonitor(box, learn, {
      MAX_NEW_PCT: "1000",
      MAX_NEW_EXAMS: "3",
    });
    assert.equal(byCount.code, 1);
    assert.equal(byCount.outputs.extraction_failed, "true");
    assert.deepEqual(await readFile(box.tracker), before);

    const forced = await runMonitor(box, learn, { FORCE_BASELINE: "1" });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.outputs.changes_found, "false");
    assert.equal(forced.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    assert.equal((await readTracker(box)).exams.length, 19);
  } finally {
    await learn.close();
  }
});

test("only exams that would be alerted count toward MAX_NEW_EXAMS: a bunch of Office and legacy exams, or of exams that already have a page, is no flood", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = (await readTracker(box)).exams.length;
    // 20 Office certifications with an MO exam each, 3 legacy exams and 5 exams
    // that already have a hub page: 28 new exams, none of them alerted.
    for (let i = 0; i < 20; i++) {
      world.certs.push(
        cert(`mos-app-${i}`, [exam(`MO-9${i + 10}`, `Office ${i}`)], {
          layout: "new",
          types: ["mos"],
        }),
      );
    }
    for (const code of ["98-901", "98-902", "70-901"]) {
      world.standalone.push(exam(code, `Legacy ${code}`));
    }
    for (let i = 1; i <= 5; i++) {
      world.standalone.push(exam(`AZ-95${i}`, `Covered ${i}`));
      await writeFile(join(box.docs, "azure", `AZ-95${i}.mdx`), "---\n---\n");
    }
    // ... next to one real new exam, which is alerted as usual.
    world.certs.push(cert("azure-new-thing", [exam("AZ-960", "")]));
    world.studyGuides["AZ-960"] = "Designing New Things";

    const result = await runMonitor(box, learn);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.extraction_failed, "false");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AZ-960; 1 new certification",
    );
    // Every one of them is tracked, and the report names the real one only.
    const tracker = await readTracker(box);
    assert.equal(tracker.exams.length, before + 29);
    for (const code of ["MO-910", "MO-929", "98-902", "70-901", "AZ-955"]) {
      assert.ok(
        tracker.exams.some((entry) => entry.code === code),
        code,
      );
    }
    assert.doesNotMatch(
      await readFile(box.report, "utf8"),
      /MO-9|98-90|70-90|AZ-95/,
    );
    assert.match(result.stdout, /New exam MO-910 tracked without an alert/);

    // The exams that would be alerted still count: five of them are over a
    // limit of three, however many Office exams arrive next to them.
    const tracked = await readFile(box.tracker);
    for (let i = 0; i < 5; i++) {
      world.standalone.push(exam(`SC-97${i}`, `New ${i}`));
    }
    for (let i = 0; i < 6; i++) {
      world.standalone.push(exam(`MO-95${i}`, `More Office ${i}`));
    }
    const flood = await runMonitor(box, learn, { MAX_NEW_EXAMS: "3" });
    assert.equal(flood.code, 1);
    const error = await readFile(box.error, "utf8");
    assert.match(
      error,
      /^5 new exams appeared at once \(.*exams in ignored families and exams that already have a hub page are not counted\)/,
    );
    assert.deepEqual(await readFile(box.tracker), tracked);
  } finally {
    await learn.close();
  }
});

test("too few certifications in the listing fails without writing a tracker", async () => {
  const world = baseWorld(); // 13 certifications
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    const result = await runMonitor(box, learn, { MIN_CERTIFICATIONS: "" }); // default: 50
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.equal(result.outputs.issue_title, "");
    // The run failed before the guide check: it did not run either.
    assert.equal(result.outputs.guide_check_failed, "skipped");
    assert.match(
      await readFile(box.error, "utf8"),
      /only 13 certifications \(expected at least 50\)/,
    );
    assert.equal(await exists(box.tracker), false);
  } finally {
    await learn.close();
  }
});

test("an unreachable or unparsable listing fails without touching the tracker", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);

    world.listingHook = (_request, response) => {
      response.statusCode = 503;
      response.end("down");
      return true;
    };
    const down = await runMonitor(box, learn);
    assert.equal(down.code, 1);
    assert.equal(down.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /Failed to fetch the credentials listing .*status 503/,
    );

    world.listingHook = (_request, response) => {
      response.end("<html>Just a moment...</html>");
      return true;
    };
    const junk = await runMonitor(box, learn);
    assert.equal(junk.code, 1);
    assert.match(
      await readFile(box.error, "utf8"),
      /parse the credentials listing/,
    );

    world.listingHook = (_request, response) => {
      response.end(JSON.stringify({ items: [] }));
      return true;
    };
    const reshaped = await runMonitor(box, learn);
    assert.equal(reshaped.code, 1);
    assert.match(await readFile(box.error, "utf8"), /no `results` array/);

    assert.deepEqual(await readFile(box.tracker), before);
  } finally {
    await learn.close();
  }
});

test("a listing that points off-site or loops is rejected, not followed", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);

    world.listingHook = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: listingItems(world).slice(0, 3),
          "@nextLink": "https://evil.example/api/contentbrowser/search/x",
        }),
      );
      return true;
    };
    const offsite = await runMonitor(box, learn);
    assert.equal(offsite.code, 1);
    assert.equal(offsite.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /unexpected next page \(https:\/\/evil\.example\//,
    );

    // A next link back to a page that was already read would loop forever.
    world.listingHook = (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: listingItems(world).slice(0, 3),
          "@nextLink": request.url,
        }),
      );
      return true;
    };
    const loop = await runMonitor(box, learn);
    assert.equal(loop.code, 1);
    assert.match(await readFile(box.error, "utf8"), /unexpected next page/);

    assert.deepEqual(await readFile(box.tracker), before);
  } finally {
    await learn.close();
  }
});

test("a page that is another certification or an interstitial counts as unreadable and keeps the exams", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    // A 200 answer for the wrong certification, and a bot-check page.
    world.pageHooks.set("azure-role-3", (_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(certHtml(world.certs[0]));
      return true;
    });
    world.pageHooks.set("azure-role-4", (_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<html><title>Just a moment...</title></html>");
      return true;
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.match(
      result.stderr,
      /could not read the page of "azure-role-3" \(page is certification\.azure-role-1, expected certification\.azure-role-3\)/,
    );
    assert.match(
      result.stderr,
      /could not read the page of "azure-role-4" \(not a certification page\)/,
    );
    assert.deepEqual(await readFile(box.tracker), before);
  } finally {
    await learn.close();
  }
});

const pageRequests = (world) =>
  world.requests.filter((path) => path.startsWith("/en-us/credentials/"));

const blocked = (_request, response) => {
  response.statusCode = 403;
  response.end("blocked");
  return true;
};

test("too many unreadable certification pages stops the run early instead of guessing", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    for (const c of world.certs) world.pageHooks.set(c.slug, blocked);
    world.requests.length = 0;
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.match(
      await readFile(box.error, "utf8"),
      /Stopped early: \d+ of the \d+ certification pages tried could not be fetched/,
    );
    assert.deepEqual(await readFile(box.tracker), before);
    // 13 pages, 80% needed: the 3rd failure dooms the run. Two workers may
    // have one more request in flight, but the other pages are never tried.
    assert.ok(
      pageRequests(world).length <= 5,
      `${pageRequests(world).length} page requests`,
    );
  } finally {
    await learn.close();
  }
});

test("pages that fail only at the very end are reported with the page count", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    // The last three of 13 listed certifications: the third failure can only
    // happen once every page has been started.
    for (const c of world.certs.slice(-3)) world.pageHooks.set(c.slug, blocked);
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 1);
    assert.match(
      await readFile(box.error, "utf8"),
      /Only 10 of 13 certification pages could be fetched and parsed \(76\.9%, expected at least 80%\)/,
    );
    assert.deepEqual(await readFile(box.tracker), before);
  } finally {
    await learn.close();
  }
});

test("a silent baseline needs nearly every page, because it is never revisited", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    world.pageHooks.set("azure-role-3", blocked);
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /Stopped early: 1 of the \d+ certification pages tried .*fewer than 95% of the 13 can still be read \(a baseline is never revisited/,
    );
    assert.equal(await exists(box.tracker), false);

    // The same single failure is fine once a baseline exists.
    world.pageHooks.clear();
    const baseline = await runMonitor(box, learn);
    assert.equal(baseline.code, 0, baseline.stderr);
    world.pageHooks.set("azure-role-3", blocked);
    const later = await runMonitor(box, learn);
    assert.equal(later.code, 0, later.stderr);

    // A forced re-baseline is permanent too: it is held to the baseline bar.
    const forced = await runMonitor(box, learn, { FORCE_BASELINE: "1" });
    assert.equal(forced.code, 1);
    assert.match(
      await readFile(box.error, "utf8"),
      /a baseline is never revisited/,
    );
  } finally {
    await learn.close();
  }
});

test("pages that read fine but lost their exam markup fail loudly instead of blinding the monitor", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    // Learn drops the Pearson VUE scheduling link, the only exam signal of a
    // classic page. The new exam below is invisible while this lasts.
    world.certs.push(cert("azure-hidden", [exam("AZ-999", "")]));
    world.certs.forEach((c) => (c.noSchedule = true));
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.equal(result.outputs.changes_found, "false");
    const error = await readFile(box.error, "utf8");
    assert.match(
      error,
      /6 of the 13 certification pages the tracker knew exams for \(46\.2%, more than MAX_EMPTY_PAGE_PCT 25%\) were read but list no exam/,
    );
    assert.match(error, /Examples: azure-role-2/);
    assert.deepEqual(await readFile(box.tracker), before);

    // The threshold is configurable; below it the run carries on and warns.
    const lenient = await runMonitor(box, learn, { MAX_EMPTY_PAGE_PCT: "50" });
    assert.equal(lenient.code, 0, lenient.stderr);
    assert.match(lenient.stderr, /lists no exam although the tracker knew/);
  } finally {
    await learn.close();
  }
});

test("a degraded Learn that never answers hits the run deadline and reports it", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    for (const c of world.certs) {
      world.pageHooks.set(c.slug, (_request, response) => {
        setTimeout(() => {
          response.setHeader("content-type", "text/html");
          response.end(certHtml(c));
        }, 400);
        return true;
      });
    }
    const started = Date.now();
    const result = await runMonitor(box, learn, { RUN_DEADLINE_MS: "1500" });

    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /run deadline \(RUN_DEADLINE_MS=1500\) was reached while reading certification pages/,
    );
    assert.deepEqual(await readFile(box.tracker), before);
    // 13 pages at 400 ms on two workers would take about 2.6 s.
    assert.ok(Date.now() - started < 20000);

    // The listing is under the same deadline.
    world.pageHooks.clear();
    world.listingHook = (_request, response) => {
      setTimeout(() => response.end("{}"), 600);
      return true;
    };
    const slow = await runMonitor(box, learn, { RUN_DEADLINE_MS: "150" });
    assert.equal(slow.code, 1);
    assert.match(
      await readFile(box.error, "utf8"),
      /run deadline .* while fetching the credentials listing/,
    );
  } finally {
    await learn.close();
  }
});

test("a Retry-After longer than the deadline neither stalls the run nor hides the cause", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    world.listingHook = (_request, response) => {
      response.statusCode = 503;
      response.setHeader("retry-after", "30");
      response.end("busy");
      return true;
    };
    const started = Date.now();
    const result = await runMonitor(box, learn, {
      RUN_DEADLINE_MS: "400",
      MAX_RETRY_AFTER_MS: "60000",
    });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /run deadline \(RUN_DEADLINE_MS=400\) was reached while fetching the credentials listing/,
    );
    // The 30 s Retry-After is cut at the deadline instead of being slept through.
    assert.ok(Date.now() - started < 10000, "slept through Retry-After");
    assert.equal(await exists(box.tracker), false);
  } finally {
    await learn.close();
  }
});

test("a flood of new certifications without new exams is a structure change, but MOS certifications do not count", async () => {
  const { world, learn, box } = await baselined();
  try {
    const before = await readFile(box.tracker);
    // Four new slugs and no new exam (renamed URLs): 13 are tracked, so more
    // than 25% are new.
    for (let i = 0; i < 4; i++) {
      world.certs.push(cert(`renamed-${i}`, [], { layout: "none" }));
    }
    const flood = await runMonitor(box, learn);
    assert.equal(flood.code, 1);
    assert.equal(flood.outputs.extraction_failed, "true");
    assert.equal(flood.outputs.changes_found, "false");
    const error = await readFile(box.error, "utf8");
    assert.match(error, /4 new certifications appeared at once/);
    assert.match(error, /MAX_NEW_CERTS \/ MAX_NEW_PCT/);
    assert.match(error, /force_baseline/);
    assert.deepEqual(await readFile(box.tracker), before);

    const byCount = await runMonitor(box, learn, {
      MAX_NEW_PCT: "1000",
      MAX_NEW_CERTS: "3",
    });
    assert.equal(byCount.code, 1);
    assert.deepEqual(await readFile(box.tracker), before);

    const forced = await runMonitor(box, learn, { FORCE_BASELINE: "1" });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.outputs.changes_found, "false");
    assert.equal(forced.outputs.baseline_updated, "true");
    assert.equal((await readTracker(box)).certifications.length, 17);

    // Office certifications arrive in bunches (most list no exam) and are silent anyway.
    for (let i = 0; i < 6; i++) {
      world.certs.push(
        cert(`mos-new-${i}`, [], { layout: "none", types: ["mos"] }),
      );
    }
    const office = await runMonitor(box, learn);
    assert.equal(office.code, 0, office.stderr);
    assert.equal(office.outputs.changes_found, "false");
    assert.equal(office.outputs.baseline_updated, "true");
  } finally {
    await learn.close();
  }
});

test("a corrupt tracker fails and is left alone", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    await writeFile(box.tracker, "{ not json");
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /Corrupt tracker .*invalid JSON/,
    );
    assert.equal(await readFile(box.tracker, "utf8"), "{ not json");
  } finally {
    await learn.close();
  }
});

test("a Retry-After header is honoured and capped", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    let limited = false;
    world.listingHook = (_request, response) => {
      if (limited) return false;
      limited = true;
      response.statusCode = 429;
      response.setHeader("retry-after", "1");
      response.end("slow down");
      return true;
    };
    const started = Date.now();
    const honoured = await runMonitor(box, learn);
    assert.equal(honoured.code, 0, honoured.stderr);
    assert.ok(limited);
    assert.match(honoured.stderr, /attempt 1 failed \(429\)/);
    assert.ok(Date.now() - started >= 900, "waited for Retry-After: 1");

    // A huge Retry-After is capped by MAX_RETRY_AFTER_MS instead of stalling the job.
    const capped = await sandbox();
    let limitedAgain = false;
    world.listingHook = (_request, response) => {
      if (limitedAgain) return false;
      limitedAgain = true;
      response.statusCode = 429;
      response.setHeader("retry-after", "3600");
      response.end("slow down");
      return true;
    };
    const startedCapped = Date.now();
    const result = await runMonitor(capped, learn, {
      MAX_RETRY_AFTER_MS: "20",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(limitedAgain);
    assert.match(result.stderr, /attempt 1 failed \(429\)/);
    assert.ok(Date.now() - startedCapped < 5000);
  } finally {
    await learn.close();
  }
});

test("the sitemap and the study guides are asked for politely too: a pause before the sitemap and between its files", async () => {
  const delay = 90;
  const world = baseWorld();
  world.sitemapSplit = true;
  for (const code of ["AZ-901", "AZ-902", "AZ-903", "AZ-904"]) {
    world.guides[code] = guideSpec();
  }
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    const result = await runMonitor(box, learn, {
      FETCH_DELAY_MS: String(delay),
    });
    assert.equal(result.code, 0, result.stderr);
    const at = (path) => world.times[world.requests.indexOf(path)];
    const lastCertification = Math.max(
      ...world.requests
        .map((path, i) => [path, i])
        .filter(([path]) =>
          /^\/en-us\/credentials\/certifications\/[^/]+\/$/.test(path),
        )
        .map(([, i]) => world.times[i]),
    );
    const slack = 25; // timers may fire a little early
    assert.ok(
      at("/_sitemaps/sitemapindex.xml") - lastCertification >= delay - slack,
      "no pause between the certification pages and the sitemap",
    );
    assert.ok(
      at("/_sitemaps/credentials_en-us_1.xml") -
        at("/_sitemaps/sitemapindex.xml") >=
        delay - slack,
      "no pause between the sitemap index and its first file",
    );
    assert.ok(
      at("/_sitemaps/credentials_en-us_2.xml") -
        at("/_sitemaps/credentials_en-us_1.xml") >=
        delay - slack,
      "no pause between the sitemap files",
    );
  } finally {
    await learn.close();
  }
});

test("requests stay polite: at most two in flight", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    world.pageHooks = new Map();
    let inFlight = 0;
    let peak = 0;
    for (const c of world.certs) {
      world.pageHooks.set(c.slug, (_request, response) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          response.setHeader("content-type", "text/html");
          response.end(certHtml(c));
        }, 25);
        return true;
      });
    }
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(peak >= 1 && peak <= 2, `peak concurrency was ${peak}`);
  } finally {
    await learn.close();
  }
});

// ---------------------------------------------------------------------------
// Study guides end to end, against the fake sitemap and guide pages
// ---------------------------------------------------------------------------
const GUIDE_PATH = "/en-us/credentials/certifications/resources/study-guides/";
// Guide pages the monitor read in full (a 200 with the page) and the ones that
// answered 304 to its conditional request.
const guideRequests = (world) =>
  world.requests.filter(
    (path) => path.startsWith(GUIDE_PATH) && !path.endsWith(NOT_MODIFIED),
  );
const notModifiedRequests = (world) =>
  world.requests.filter((path) => path.endsWith(NOT_MODIFIED));
const guideCodesRequested = (world) => [
  ...new Set(
    guideRequests(world).map((path) =>
      path.slice(GUIDE_PATH.length).toUpperCase(),
    ),
  ),
];
const notModifiedCodes = (world) =>
  notModifiedRequests(world)
    .map((path) =>
      path.slice(GUIDE_PATH.length, -NOT_MODIFIED.length).toUpperCase(),
    )
    .sort();
const sitemapRequests = (world) =>
  world.requests.filter((path) => path.startsWith("/_sitemaps/"));
const guideOf = (tracker, code) =>
  tracker.studyGuides.find((guide) => guide.code === code);
const COVERED = ["AZ-901", "AZ-902", "AZ-903", "AZ-904"];

/**
 * Guides for exams the hub covers (a page in the docs dir), for exams it does
 * not, and for codes only a study guide shows (no certification lists them).
 */
async function guideWorld({
  covered = COVERED,
  uncovered = ["AZ-905", "AZ-906"],
  guideOnly = ["AZ-980", "AZ-981"],
} = {}) {
  const world = baseWorld();
  for (const code of covered) {
    world.guides[code] = guideSpec({ name: `Covered ${code}` });
  }
  for (const code of uncovered) {
    world.guides[code] = guideSpec({ name: `Not covered ${code}` });
  }
  for (const code of guideOnly) {
    world.guides[code] = guideSpec({ name: `Retired ${code}` });
  }
  const learn = await startLearn(world);
  const box = await sandbox();
  for (const code of covered) {
    await writeFile(
      join(box.docs, "azure", `${code}.mdx`),
      `---\ntitle: ${code} Study Materials\n---\n`,
    );
  }
  return { world, learn, box };
}

async function guideBaselined(options, extra) {
  const context = await guideWorld(options);
  const first = await runMonitor(context.box, context.learn, extra);
  assert.equal(first.code, 0, first.stderr);
  context.world.requests.length = 0;
  return context;
}

test("the first run baselines study guides silently: covered ones are hashed, the others kept by date, Applied Skills guides ignored", async () => {
  const { world, learn, box } = await guideWorld();
  const summary = join(box.dir, "summary.md");
  try {
    // A hub page whose exam has no study guide in the sitemap is listed for the maintainers.
    await writeFile(join(box.docs, "azure", "AZ-910.mdx"), "---\n---\n");
    const result = await runMonitor(box, learn, {
      GITHUB_STEP_SUMMARY: summary,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.outputs, {
      changes_found: "false",
      baseline_updated: "true",
      extraction_failed: "false",
      guide_check_failed: "false",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "0",
      study_guides_changed: "0",
      issue_title: "",
    });
    assert.equal(await exists(box.report), false);

    const tracker = await readTracker(box);
    assert.deepEqual(
      tracker.studyGuides.map((guide) => guide.code),
      [
        "AZ-901",
        "AZ-902",
        "AZ-903",
        "AZ-904",
        "AZ-905",
        "AZ-906",
        "AZ-980",
        "AZ-981",
      ],
    );
    for (const code of COVERED) {
      const guide = guideOf(tracker, code);
      assert.match(guide.hash, /^[0-9a-f]{64}$/, code);
      assert.equal(guide.lastmod, "2026-09-01");
      assert.equal(guide.updatedAt, "2026-09-01T10:00:00Z");
      assert.equal(guide.firstSeen, "2026-10-09");
      assert.equal(guide.lastChanged, null);
      assert.equal(guide.lines[0], "## Updates to the exam");
      assert.equal(guide.missing, undefined);
      // The server's Last-Modified is kept to ask "changed since?" next time.
      assert.equal(guide.lastModified, "Tue, 01 Sep 2026 10:00:00 GMT", code);
    }
    for (const code of ["AZ-905", "AZ-906", "AZ-980", "AZ-981"]) {
      const guide = guideOf(tracker, code);
      assert.equal(guide.hash, null, code);
      assert.equal(guide.lines, undefined);
      assert.equal(guide.updatedAt, "");
      assert.equal(guide.lastModified, undefined, code);
      assert.equal(guide.lastmod, "2026-09-01");
    }
    assert.ok(
      !JSON.stringify(tracker).includes("apl-"),
      "Applied Skills guide tracked",
    );

    // The sitemap files once each, and only the covered guides.
    assert.deepEqual(sitemapRequests(world), [
      "/_sitemaps/sitemapindex.xml",
      "/_sitemaps/credentials_en-us_1.xml",
    ]);
    assert.deepEqual(guideCodesRequested(world).sort(), COVERED);

    // Codes only a study guide shows are exams now, with no certification yet.
    const retired = tracker.exams.find((exam) => exam.code === "AZ-980");
    assert.deepEqual(retired.certifications, []);
    assert.equal(retired.firstSeen, "2026-10-09");

    assert.match(result.stdout, /Study guides: 8 tracked, 4 with a text hash/);
    assert.match(
      result.stdout,
      /Exams the hub covers without a study guide in the sitemap: AZ-910\./,
    );
    const text = await readFile(summary, "utf8");
    assert.match(
      text,
      /Recorded 8 study guides silently \(4 with a text hash\)/,
    );
    assert.match(text, /without a study guide in the sitemap: `AZ-910`/);
    assert.match(text, /Without a hub page[^\n]*`AZ-980`, `AZ-981`\n/);
    assert.doesNotMatch(text, INTERNAL_WORDS);
  } finally {
    await learn.close();
  }
});

test("a second run asks every covered guide whether it changed, gets 304 and changes nothing, not even on another day", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readFile(box.tracker);
    const again = await runMonitor(box, learn, { TODAY: "2026-10-10" });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.outputs.changes_found, "false");
    assert.equal(again.outputs.baseline_updated, "false");
    assert.equal(again.outputs.study_guides_changed, "0");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.equal(await exists(box.report), false);
    // The sitemap date lags the page, so every covered guide is asked every day,
    // with the Last-Modified of the last read; Learn answers 304, no page is sent.
    assert.deepEqual(guideRequests(world), []);
    assert.deepEqual(notModifiedCodes(world), COVERED);
    assert.equal(sitemapRequests(world).length, 2);
    assert.match(
      again.stdout,
      /4 covered guides checked \(0 read in full, 4 not modified since the last read\)/,
    );
  } finally {
    await learn.close();
  }
});

test("a change published without a new sitemap date is found: the conditional request misses and the page is read", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readTracker(box);
    // Learn publishes new skills a month before the sitemap date moves: the
    // page is newer (Last-Modified, updated_at) but its sitemap lastmod is not.
    Object.assign(world.guides["AZ-902"], {
      modified: "2026-09-25T22:18:39Z",
      updatedAt: "2026-09-25T22:00:00Z",
      heading: "Skills measured as of October 27, 2026",
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.study_guides_changed, "1");
    assert.equal(
      result.outputs.issue_title,
      "Microsoft Learn study guide updated: AZ-902",
    );
    // Only that guide came in full; the others answered 304.
    assert.deepEqual(guideCodesRequested(world), ["AZ-902"]);
    assert.deepEqual(notModifiedCodes(world), ["AZ-901", "AZ-903", "AZ-904"]);
    const report = await readFile(box.report, "utf8");
    assert.match(report, /^\+ ## Skills measured as of October 27, 2026$/m);
    assert.match(
      report,
      /2026-09-01 → 2026-09-01 \| 2026-09-01T10:00:00Z → 2026-09-25T22:00:00Z \|/,
    );

    const tracker = await readTracker(box);
    const guide = guideOf(tracker, "AZ-902");
    assert.equal(guide.lastmod, "2026-09-01"); // the sitemap still says so
    assert.equal(guide.lastModified, "Fri, 25 Sep 2026 22:18:39 GMT");
    assert.equal(guide.lastChanged, "2026-10-09");
    assert.notEqual(guide.hash, guideOf(before, "AZ-902").hash);

    // Recorded: the next run is quiet again, and conditional on the new version.
    world.requests.length = 0;
    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.changes_found, "false");
    assert.equal(quiet.outputs.baseline_updated, "false");
    assert.deepEqual(guideRequests(world), []);
    assert.deepEqual(notModifiedCodes(world), COVERED);
  } finally {
    await learn.close();
  }
});

test("a server that ignores If-Modified-Since only costs bandwidth: the hash still decides, and nothing is reported or rewritten", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readFile(box.tracker);
    world.ignoreConditional = true;
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.deepEqual(guideCodesRequested(world).sort(), COVERED);
    assert.deepEqual(notModifiedRequests(world), []);
    assert.match(
      result.stdout,
      /4 covered guides checked \(4 read in full, 0 not modified since the last read\)/,
    );
  } finally {
    await learn.close();
  }
});

test("a page republished with the same text is not reported, but its new Last-Modified is recorded so the next request can be 304 again", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readTracker(box);
    // A template rebuild: new publish time, new page date, same words.
    Object.assign(world.guides["AZ-903"], {
      modified: "2026-10-01T06:00:00Z",
      updatedAt: "2026-10-01T05:59:00Z",
      noise: 4,
      rewrap: true,
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    assert.deepEqual(guideCodesRequested(world), ["AZ-903"]);
    assert.match(
      result.stdout,
      /Study guide AZ-903: the page was republished \(updated_at 2026-09-01T10:00:00Z -> 2026-10-01T05:59:00Z; Last-Modified Tue, 01 Sep 2026 10:00:00 GMT -> Thu, 01 Oct 2026 06:00:00 GMT\), the text did not change\./,
    );
    assert.match(result.stdout, /1 republished with the same text/);

    const tracker = await readTracker(box);
    const guide = guideOf(tracker, "AZ-903");
    assert.equal(guide.hash, guideOf(before, "AZ-903").hash);
    assert.equal(guide.lastChanged, null);
    assert.equal(guide.lastModified, "Thu, 01 Oct 2026 06:00:00 GMT");
    assert.equal(guide.updatedAt, "2026-10-01T05:59:00Z");

    world.requests.length = 0;
    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.baseline_updated, "false");
    assert.deepEqual(guideRequests(world), []);
    assert.deepEqual(notModifiedCodes(world), COVERED);
  } finally {
    await learn.close();
  }
});

test("a sitemap date that moved with the same text is recorded silently; a guide the hub does not cover is never read", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readTracker(box);
    // AZ-901 is re-published (new date, re-wrapped page, churn) with the same text.
    Object.assign(world.guides["AZ-901"], {
      lastmod: "2026-09-20",
      noise: 5,
      rewrap: true,
    });
    world.guides["AZ-905"].lastmod = "2026-09-21";
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    assert.deepEqual(guideCodesRequested(world), ["AZ-901"]);
    assert.match(
      result.stdout,
      /Study guide AZ-901: the sitemap date moved \(2026-09-01 -> 2026-09-20\), the text did not\./,
    );

    const tracker = await readTracker(box);
    const guide = guideOf(tracker, "AZ-901");
    assert.equal(guide.lastmod, "2026-09-20");
    assert.equal(guide.hash, guideOf(before, "AZ-901").hash);
    assert.equal(guide.lastChanged, null);
    assert.equal(guideOf(tracker, "AZ-905").lastmod, "2026-09-21");
    assert.equal(guideOf(tracker, "AZ-905").hash, null);

    const saved = await readFile(box.tracker);
    world.requests.length = 0;
    const again = await runMonitor(box, learn);
    assert.equal(again.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), saved);
    assert.deepEqual(guideRequests(world), []);
  } finally {
    await learn.close();
  }
});

test("changed guide text is reported once, with the diff, the hub page, both dates and the instructions", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const saved = await readFile(box.tracker);
    const before = await readTracker(box);
    const spec = world.guides["AZ-901"];
    Object.assign(spec, {
      lastmod: "2026-09-15",
      updatedAt: "2026-09-15T08:00:00Z",
      heading: "Skills measured as of October 14, 2026",
      groups: [
        {
          title: "Group A (20–25%)",
          bullets: ["Do A1", "Do A2 revised", "Do A3"],
        },
        spec.groups[1],
      ],
      noise: 3,
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
      guide_check_failed: "false",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "0",
      study_guides_changed: "1",
      issue_title: "Microsoft Learn study guide updated: AZ-901",
    });
    const report = await readFile(box.report, "utf8");
    assert.match(report, /^## Study guides updated on Microsoft Learn\n/);
    assert.match(report, /### Study guides updated \(1\)/);
    assert.match(
      report,
      /\| AZ-901 Covered AZ-901 \| \[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/az-901\?WT\.mc_id=studentamb_165290\) \| `src\/content\/docs\/azure\/AZ-901\.mdx` \| \+2 \/ -2 \| 2026-09-01 → 2026-09-15 \| 2026-09-01T10:00:00Z → 2026-09-15T08:00:00Z \|/,
    );
    assert.match(report, /^- ## Skills measured as of September 1, 2026$/m);
    assert.match(report, /^\+ ## Skills measured as of October 14, 2026$/m);
    assert.match(
      report,
      /^@@ Skills measured as of October 14, 2026 > Group A \(20–25%\) @@\n- - Do A2\n\+ - Do A2 revised$/m,
    );
    assert.match(report, /- "Skills measured as of October 14, 2026"/);
    assert.match(report, /#### What to do/);
    assert.match(report, /Never use one as the beta start date of an exam/);
    assert.doesNotMatch(report, /### Checklist|### New exams/);
    assert.doesNotMatch(report, INTERNAL_WORDS);
    assert.doesNotMatch(report, /\bnull\b|undefined/);

    const tracker = await readTracker(box);
    const guide = guideOf(tracker, "AZ-901");
    assert.notEqual(guide.hash, guideOf(before, "AZ-901").hash);
    assert.equal(guide.lastChanged, "2026-10-09");
    assert.equal(guide.lastmod, "2026-09-15");
    assert.equal(guide.updatedAt, "2026-09-15T08:00:00Z");
    assert.ok(guide.lines.includes("- Do A2 revised"));
    assert.deepEqual(guideOf(tracker, "AZ-902"), guideOf(before, "AZ-902"));

    // The workflow opens the issue first and commits the tracker afterwards: when
    // that commit is skipped the same change is reported again, byte for byte.
    const firstReport = report;
    await writeFile(box.tracker, saved);
    const retry = await runMonitor(box, learn);
    assert.equal(retry.outputs.issue_title, result.outputs.issue_title);
    assert.equal(await readFile(box.report, "utf8"), firstReport);

    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.changes_found, "false");
    assert.equal(quiet.outputs.baseline_updated, "false");
    assert.equal(await exists(box.report), false);
  } finally {
    await learn.close();
  }
});

test("a retirement notice added to a covered guide is reported as guide text, and so is taking it down again", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    // Microsoft puts a box before the first heading (AZ-801) or under Purpose
    // (MS-102); the updates and skills text do not change at all. A box under
    // the study resources is not guide text.
    const retire = "This exam will retire on January 31, 2027.";
    Object.assign(world.guides["AZ-903"], {
      lastmod: "2026-09-18",
      notices: { pre: retire },
    });
    Object.assign(world.guides["AZ-904"], {
      lastmod: "2026-09-18",
      notices: { resources: "Not the guide" },
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.study_guides_changed, "1");
    assert.equal(
      result.outputs.issue_title,
      "Microsoft Learn study guide updated: AZ-903",
    );
    const report = await readFile(box.report, "utf8");
    assert.match(
      report,
      /^@@ top of the compared text @@\n\+ ## Notices\n\+ Warning\n\+ This exam will retire on January 31, 2027\.$/m,
    );
    assert.match(
      report,
      /quoted verbatim; they are not exam or beta start dates\):\n\n```text\n- "This exam will retire on January 31, 2027\."\n```/,
    );
    assert.match(report, /3\. If a "Notices" box/);
    assert.doesNotMatch(report, /Not the guide|AZ-904/);
    const tracker = await readTracker(box);
    assert.deepEqual(guideOf(tracker, "AZ-903").lines.slice(0, 3), [
      "## Notices",
      "Warning",
      retire,
    ]);
    assert.equal(guideOf(tracker, "AZ-903").lastChanged, "2026-10-09");
    assert.equal(guideOf(tracker, "AZ-904").lastChanged, null);
    assert.equal(guideOf(tracker, "AZ-904").lastmod, "2026-09-18");

    // Taken down again, with the sitemap date still where it was (it lags): the
    // conditional request notices the new version and the hash reports it.
    Object.assign(world.guides["AZ-903"], {
      modified: "2026-09-19T08:00:00Z",
      notices: {},
    });
    const removed = await runMonitor(box, learn, { TODAY: "2026-10-10" });
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(
      removed.outputs.issue_title,
      "Microsoft Learn study guide updated: AZ-903",
    );
    assert.match(
      await readFile(box.report, "utf8"),
      /^- ## Notices\n- Warning\n- This exam will retire on January 31, 2027\.$/m,
    );
    assert.equal(
      guideOf(await readTracker(box), "AZ-903").lines[0],
      "## Updates to the exam",
    );
  } finally {
    await learn.close();
  }
});

test("one issue names a new exam, its certification and an updated guide, with the evidence of the exam", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.guides["AZ-950"] = guideSpec({ name: "Designing New Things" });
    Object.assign(world.guides["AZ-902"], {
      lastmod: "2026-09-16",
      updates: [...world.guides["AZ-902"].updates, "A new sentence."],
    });
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "true");
    assert.equal(result.outputs.study_guides_changed, "1");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AZ-950; 1 new certification; study guide updated: AZ-902",
    );
    const report = await readFile(box.report, "utf8");
    assert.match(report, /^## New on Microsoft Learn\n/);
    assert.match(
      report,
      /\| AZ-950 \| Designing New Things \| unknown, check Learn \|[^\n]*\| certification page \+ study guide \| 2026-10-09 \|/,
    );
    assert.match(report, /### New certifications \(1\)/);
    assert.match(report, /### Study guides updated \(1\)/);
    assert.match(report, /^\+ A new sentence\.$/m);
    assertChecklist(report);
    // One new exam, not two: the guide and the certification page are the same exam.
    assert.equal((report.match(/^\| AZ-950 \|/gm) ?? []).length, 1);
  } finally {
    await learn.close();
  }
});

test("a study guide is an earlier new-exam signal: alerted once, and the certification page that lists the exam later only enriches the record", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    world.guides["AB-960"] = guideSpec({
      name: "Administering Something New",
      lastmod: "2026-10-08",
    });
    const first = await runMonitor(box, learn);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.changes_found, "true");
    assert.equal(first.outputs.study_guides_changed, "0");
    assert.equal(first.outputs.issue_title, "New Microsoft Learn exam: AB-960");
    const report = await readFile(box.report, "utf8");
    assert.match(report, /### New exams \(1\)/);
    assert.match(
      report,
      /\| AB-960 \| Administering Something New \| unknown, check Learn \| — \| — \| `src\/content\/docs\/aibusiness\/AB-960\.mdx` \| \[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/ab-960\?WT\.mc_id=studentamb_165290\) \(no exam page confirmed\) \| — \| study guide \| 2026-10-09 \|/,
    );
    assert.doesNotMatch(
      report,
      /### New certifications|### Study guides updated/,
    );
    assert.match(
      report,
      /node scripts\/new-exam\.mjs --code AB-960 --name "Administering Something New"\n/,
    );
    assertChecklist(report);

    let tracker = await readTracker(box);
    const candidate = tracker.exams.find((e) => e.code === "AB-960");
    assert.equal(candidate.name, "Administering Something New");
    assert.deepEqual(candidate.certifications, []);
    assert.equal(candidate.url, "");
    assert.equal(candidate.beta, false);
    assert.equal(guideOf(tracker, "AB-960").hash, null); // no hub page: tracked by date

    // Reported once.
    const saved = await readFile(box.tracker);
    const second = await runMonitor(box, learn);
    assert.equal(second.outputs.changes_found, "false");
    assert.equal(second.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), saved);

    // Days later a certification page lists the exam: a new certification is
    // reported, the exam is not, and its record is enriched, not replaced.
    world.certs.push(
      cert(
        "ai-new-admin",
        [exam("AB-960", "Administering Something New", true)],
        {
          layout: "new",
          beta: true,
          announcement:
            "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-cert/123",
        },
      ),
    );
    const later = await runMonitor(box, learn, { TODAY: "2026-10-12" });
    assert.equal(later.code, 0, later.stderr);
    assert.equal(later.outputs.changes_found, "true");
    assert.equal(
      later.outputs.issue_title,
      "New Microsoft Learn certification: Microsoft Certified: ai-new-admin",
    );
    const laterReport = await readFile(box.report, "utf8");
    assert.match(laterReport, /### New certifications \(1\)/);
    assert.doesNotMatch(laterReport, /### New exams/);
    // The exam is not a new exam, but it still needs a page, and the
    // certification page now says what the study guide could not: BETA and the
    // announcement. The issue shows both and does not claim nothing is left to do.
    assert.match(
      laterReport,
      /### Exams the new certifications list that still have no hub page \(1\)/,
    );
    assert.match(
      laterReport,
      /\| AB-960 \| Administering Something New \| BETA \| \[Microsoft Certified: ai-new-admin\]\([^)]*\) \| Azure \| `src\/content\/docs\/aibusiness\/AB-960\.mdx` \| \[Exam page\]\([^)]*exams\/ab-960\?WT\.mc_id=studentamb_165290\) \| \[Learn more about the beta exam AB-960\]\(https:\/\/techcommunity\.microsoft\.com\/blog\/skills-hub-blog\/new-cert\/123\) \| certification page \+ study guide \| 2026-10-09 \|/,
    );
    assert.match(
      laterReport,
      /node scripts\/new-exam\.mjs --code AB-960 --name "Administering Something New" --beta --beta-start <YYYY-MM-DD>\n/,
    );
    assert.doesNotMatch(laterReport, /No new exam page is needed/);
    assertChecklist(laterReport);

    tracker = await readTracker(box);
    const enriched = tracker.exams.find((e) => e.code === "AB-960");
    assert.deepEqual(enriched.certifications, [
      { slug: "ai-new-admin", title: "Microsoft Certified: ai-new-admin" },
    ]);
    assert.equal(enriched.beta, true);
    assert.deepEqual(enriched.announcements, [
      "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-cert/123",
    ]);
    assert.equal(enriched.name, "Administering Something New");
    assert.equal(enriched.firstSeen, "2026-10-09");
    assert.equal(enriched.lastSeen, "2026-10-12");
    assert.match(enriched.url, /exams\/ab-960\?WT\.mc_id=studentamb_165290$/);

    const third = await runMonitor(box, learn, { TODAY: "2026-10-12" });
    assert.equal(third.outputs.changes_found, "false");
    assert.equal(third.outputs.baseline_updated, "false");
  } finally {
    await learn.close();
  }
});

test("a hub page created after its guide was tracked gets its first hash silently", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    await writeFile(join(box.docs, "azure", "AZ-905.mdx"), "---\n---\n");
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    assert.deepEqual(guideCodesRequested(world), ["AZ-905"]);
    const guide = guideOf(await readTracker(box), "AZ-905");
    assert.match(guide.hash, /^[0-9a-f]{64}$/);
    assert.ok(guide.lines.length > 5);
    assert.equal(guide.lastChanged, null);
    assert.equal(guide.firstSeen, "2026-10-09");

    world.requests.length = 0;
    const again = await runMonitor(box, learn);
    assert.equal(again.outputs.baseline_updated, "false");
    assert.deepEqual(guideRequests(world), []);
  } finally {
    await learn.close();
  }
});

test("a guide that cannot be read keeps its state and is retried; it is never evidence of a change", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readFile(box.tracker);
    Object.assign(world.guides["AZ-901"], {
      lastmod: "2026-09-15",
      updates: [...world.guides["AZ-901"].updates, "A new sentence."],
    });
    world.guideHooks.set("AZ-901", (_request, response) => {
      response.statusCode = 500;
      response.end("boom");
      return true;
    });
    const failed = await runMonitor(box, learn);

    assert.equal(failed.code, 0, failed.stderr);
    assert.equal(failed.outputs.changes_found, "false");
    assert.equal(failed.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.match(
      failed.stderr,
      /could not read the study guide of AZ-901 \(status 500\); kept its previous state/,
    );

    world.guideHooks.clear();
    const retry = await runMonitor(box, learn);
    assert.equal(
      retry.outputs.issue_title,
      "Microsoft Learn study guide updated: AZ-901",
    );
    assert.match(await readFile(box.report, "utf8"), /^\+ A new sentence\.$/m);
  } finally {
    await learn.close();
  }
});

test("a sitemap problem skips the study guide check loudly and leaves the exam detection and the guide records alone", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const saved = await readFile(box.tracker);
    const guidesBefore = (await readTracker(box)).studyGuides;
    // Learn changes a guide and lists a new exam while the sitemap is broken.
    Object.assign(world.guides["AZ-901"], {
      lastmod: "2026-09-15",
      updates: [...world.guides["AZ-901"].updates, "A new sentence."],
    });
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";

    const cases = [
      [
        "the index is down",
        () => {
          world.indexHook = (_request, response) => {
            response.statusCode = 503;
            response.end("down");
            return true;
          };
        },
        {},
        /the sitemap index \/_sitemaps\/sitemapindex\.xml could not be fetched \(status 503\)/,
      ],
      [
        "the credentials file is missing",
        () => {
          world.indexHook = null;
          world.sitemapHook = (_request, response) => {
            response.statusCode = 404;
            response.end("gone");
            return true;
          };
        },
        {},
        /\/_sitemaps\/credentials_en-us_1\.xml could not be fetched \(status 404\)/,
      ],
      [
        "the sitemap lists too few guides",
        () => {
          world.sitemapHook = null;
        },
        { MIN_STUDY_GUIDES: "50" },
        /lists only 8 certification study guides \(expected at least 50\)/,
      ],
      [
        "the index lists no en-us file",
        () => {
          world.indexHook = (_request, response) => {
            response.end(
              "<sitemapindex><sitemap><loc>https://learn.microsoft.com/_sitemaps/credentials_de-de_1.xml</loc></sitemap></sitemapindex>",
            );
            return true;
          };
        },
        {},
        /the sitemap index lists no credentials_en-us_<n>\.xml file/,
      ],
    ];
    for (const [index, [name, setup, env, pattern]] of cases.entries()) {
      setup();
      await writeFile(box.tracker, saved);
      world.requests.length = 0;
      const summary = join(box.dir, `summary-${index}.md`);
      const result = await runMonitor(box, learn, {
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_ACTIONS: "true",
        ...env,
      });

      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      // No guide was checked: neither "true" (the failsafe) nor "false" (it ran).
      assert.equal(result.outputs.guide_check_failed, "skipped", name);
      // The exam detection still works...
      assert.equal(result.outputs.changes_found, "true", name);
      assert.equal(
        result.outputs.issue_title,
        "New Microsoft Learn exam: AZ-950; 1 new certification",
        name,
      );
      assert.equal(result.outputs.study_guides_changed, "0", name);
      // ...and the guide records stay as they were: the changed guide is not
      // read, not recorded, not reported.
      assert.deepEqual(
        (await readTracker(box)).studyGuides,
        guidesBefore,
        name,
      );
      assert.deepEqual(guideRequests(world), [], name);
      assert.doesNotMatch(
        await readFile(box.report, "utf8"),
        /Study guides updated/,
      );
      // And it is loud: stderr, workflow annotation, job summary.
      assert.match(result.stderr, pattern, name);
      assert.match(
        result.stderr,
        /WARNING: Study guides were not checked this run: /,
        name,
      );
      assert.match(
        result.stdout,
        /::warning title=New Exam Monitor::Study guides were not checked this run: /,
        name,
      );
      const text = await readFile(summary, "utf8");
      assert.match(text, /Study guides were not checked this run:/, name);
      assert.match(text, pattern, name);
      assert.doesNotMatch(text, INTERNAL_WORDS);
    }

    // Once the sitemap works again the pending change is found.
    world.indexHook = null;
    world.sitemapHook = null;
    await writeFile(box.tracker, saved);
    const back = await runMonitor(box, learn);
    assert.equal(
      back.outputs.issue_title,
      "New Microsoft Learn exam: AZ-950; 1 new certification; study guide updated: AZ-901",
    );
  } finally {
    await learn.close();
  }
});

test("guide_check_failed is true for a tripped failsafe, false for a guide check that ran and skipped for one that did not: a skipped day neither closes nor raises the failsafe issue", async () => {
  const covered = Array.from(
    { length: 12 },
    (_, i) => `AZ-9${String(i + 1).padStart(2, "0")}`,
  );
  const { world, learn, box } = await guideBaselined({
    covered,
    uncovered: [],
    guideOnly: [],
  });
  const down = (_request, response) => {
    response.statusCode = 503;
    response.end("down");
    return true;
  };
  // The output of a run, and what the workflow does with it.
  const guideCheck = async (extra) => {
    const result = await runMonitor(box, learn, extra);
    assert.equal(result.code, 0, result.stderr);
    return result.outputs.guide_check_failed;
  };
  try {
    // The guide check ran and found nothing wrong: it works, the issue may close.
    assert.equal(await guideCheck(), "false");

    // The sitemap is down, so no guide was checked. That says nothing about
    // whether the check works: before, this wrote "false" and closed the issue
    // of a failsafe that was still tripped (the next good run opened a new one).
    world.indexHook = down;
    assert.equal(await guideCheck({ TODAY: "2026-10-10" }), "skipped");
    world.indexHook = null;

    // Four of twelve guides change at once: the failsafe trips.
    for (const code of covered.slice(0, 4)) {
      Object.assign(world.guides[code], {
        lastmod: "2026-09-20",
        updates: [...world.guides[code].updates, "Markup changed."],
      });
    }
    assert.equal(await guideCheck({ TODAY: "2026-10-11" }), "true");
    // A day with a broken sitemap in between does not end it ...
    world.indexHook = down;
    assert.equal(await guideCheck({ TODAY: "2026-10-12" }), "skipped");
    world.indexHook = null;
    assert.equal(await guideCheck({ TODAY: "2026-10-13" }), "true");
    // ... accepting the new text does.
    assert.equal(
      await guideCheck({ FORCE_GUIDE_BASELINE: "1", TODAY: "2026-10-14" }),
      "false",
    );
  } finally {
    await learn.close();
  }
  // The workflow raises the issue on "true" only and closes it on "false" only.
  assert.deepEqual(failsafeIssueSteps("true"), { raise: true, clear: false });
  assert.deepEqual(failsafeIssueSteps("false"), { raise: false, clear: true });
  assert.deepEqual(failsafeIssueSteps("skipped"), {
    raise: false,
    clear: false,
  });
});

test("many covered guides changing at once is a markup change: the guide results are discarded and reported, the exam check goes on, and FORCE_GUIDE_BASELINE records the new text", async () => {
  const covered = Array.from(
    { length: 12 },
    (_, i) => `AZ-9${String(i + 1).padStart(2, "0")}`,
  );
  const { world, learn, box } = await guideBaselined({
    covered,
    uncovered: [],
    guideOnly: [],
  });
  try {
    const before = await readFile(box.tracker);
    const beforeTracker = JSON.parse(before);
    // Four of twelve (33%) new texts in one run, and a real new exam next to them.
    for (const code of covered.slice(0, 4)) {
      Object.assign(world.guides[code], {
        lastmod: "2026-09-20",
        updates: [...world.guides[code].updates, "Markup changed."],
      });
    }
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const newExam = "New Microsoft Learn exam: AZ-950; 1 new certification";
    const summary = join(box.dir, "summary.md");

    const byPercent = await runMonitor(box, learn, {
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_ACTIONS: "true",
    });
    // The run does not fail: the failsafe stops the guide part and says so.
    assert.equal(byPercent.code, 0, byPercent.stderr);
    assert.deepEqual(byPercent.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
      guide_check_failed: "true",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "0",
      study_guides_changed: "0",
      issue_title: newExam,
    });
    // ...the new exam is alerted and tracked as usual...
    const stoppedReport = await readFile(box.report, "utf8");
    assert.match(stoppedReport, /\| AZ-950 \|/);
    assert.doesNotMatch(stoppedReport, /Study guides updated/);
    const stopped = await readTracker(box);
    assert.ok(stopped.exams.some((exam) => exam.code === "AZ-950"));
    // ...and every guide record is exactly what it was.
    assert.deepEqual(stopped.studyGuides, beforeTracker.studyGuides);

    const error = await readFile(box.error, "utf8");
    assert.match(
      error,
      /4 of the 12 covered study guides looked different in one run \(4 changed text, 0 no longer parse, 0 lost a section; 33\.3%/,
    );
    assert.match(error, /MAX_GUIDE_CHANGES 15 \/ MAX_GUIDE_CHANGE_PCT 25%/);
    assert.match(error, /study guide results of this run were discarded/);
    assert.match(error, /the exam check ran as usual/);
    assert.match(error, /`force_guide_baseline`/);
    assert.match(error, /FORCE_GUIDE_BASELINE=1/);
    assert.match(
      error,
      /FORCE_BASELINE does the same, but also records every new exam/,
    );
    assert.doesNotMatch(error, INTERNAL_WORDS);
    // Loud: log, annotation, job summary.
    assert.match(
      byPercent.stderr,
      /WARNING: The study guide check stopped: 4 of the 12/,
    );
    assert.match(
      byPercent.stdout,
      /::warning title=New Exam Monitor::The study guide check stopped: 4 of the 12/,
    );
    const text = await readFile(summary, "utf8");
    assert.match(
      text,
      /\*\*The study guide failsafe stopped the guide check this run:\*\* 4 of the 12/,
    );
    assert.doesNotMatch(text, INTERNAL_WORDS);

    // It stays tripped, every day, until the changes are accepted: the exam was
    // alerted once, the guides are reported as a problem again.
    const nextDay = await runMonitor(box, learn, { TODAY: "2026-10-10" });
    assert.equal(nextDay.code, 0, nextDay.stderr);
    assert.equal(nextDay.outputs.guide_check_failed, "true");
    assert.equal(nextDay.outputs.changes_found, "false");
    assert.equal(nextDay.outputs.baseline_updated, "false");
    assert.equal(await exists(box.report), false);

    // By count as well as by percentage.
    await writeFile(box.tracker, before);
    const byCount = await runMonitor(box, learn, {
      MAX_GUIDE_CHANGES: "3",
      MAX_GUIDE_CHANGE_PCT: "100",
    });
    assert.equal(byCount.code, 0, byCount.stderr);
    assert.equal(byCount.outputs.guide_check_failed, "true");
    assert.equal(byCount.outputs.study_guides_changed, "0");

    // Under both limits it is news, and all four are in one issue.
    await writeFile(box.tracker, before);
    const calm = await runMonitor(box, learn, { MAX_GUIDE_CHANGE_PCT: "50" });
    assert.equal(calm.code, 0, calm.stderr);
    assert.equal(calm.outputs.guide_check_failed, "false");
    assert.equal(calm.outputs.study_guides_changed, "4");
    assert.equal(
      calm.outputs.issue_title,
      `${newExam}; study guide updated: AZ-901, AZ-902, AZ-903, AZ-904`,
    );
    assert.equal(await exists(box.error), false);

    // The way out: re-read every covered guide in full and record the new text
    // silently. New exams are still alerted.
    await writeFile(box.tracker, before);
    world.requests.length = 0;
    const forced = await runMonitor(box, learn, { FORCE_GUIDE_BASELINE: "1" });
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(forced.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
      guide_check_failed: "false",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "0",
      study_guides_changed: "0",
      issue_title: newExam,
    });
    assert.deepEqual(guideCodesRequested(world).sort(), covered);
    assert.deepEqual(notModifiedRequests(world), []);
    const tracker = await readTracker(box);
    for (const code of covered.slice(0, 4)) {
      const guide = guideOf(tracker, code);
      assert.notEqual(guide.hash, guideOf(beforeTracker, code).hash, code);
      assert.equal(guide.lastmod, "2026-09-20");
      assert.equal(guide.lastChanged, null); // a re-baseline is not a change
    }
    for (const code of covered.slice(4)) {
      assert.deepEqual(guideOf(tracker, code), guideOf(beforeTracker, code));
    }
    assert.doesNotMatch(
      await readFile(box.report, "utf8"),
      /Study guides updated/,
    );
    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.changes_found, "false");
    assert.equal(quiet.outputs.baseline_updated, "false");
    assert.equal(quiet.outputs.guide_check_failed, "false");

    // FORCE_BASELINE does the same for the guides, but swallows the exam too.
    await writeFile(box.tracker, before);
    const everything = await runMonitor(box, learn, { FORCE_BASELINE: "1" });
    assert.equal(everything.code, 0, everything.stderr);
    assert.equal(everything.outputs.guide_check_failed, "false");
    assert.equal(everything.outputs.changes_found, "false");
    assert.equal(everything.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    const swallowed = await readTracker(box);
    assert.ok(swallowed.exams.some((exam) => exam.code === "AZ-950"));
    assert.equal(
      guideOf(swallowed, "AZ-901").hash,
      guideOf(tracker, "AZ-901").hash,
    );
  } finally {
    await learn.close();
  }
});

test("guide pages that no longer parse, or lost a section, only warn; many of them stop the guide check, and FORCE_GUIDE_BASELINE accepts what can be accepted", async () => {
  const { world, learn, box } = await guideBaselined();
  const summary = join(box.dir, "summary.md");
  try {
    const before = await readFile(box.tracker);
    const moved = { lastmod: "2026-09-25" };
    // A bot-check page, a guide page with neither section, a guide that lost its skills.
    Object.assign(world.guides["AZ-901"], moved, { noTitle: true });
    Object.assign(world.guides["AZ-902"], moved, {
      updatesMissing: true,
      skillsMissing: true,
    });
    Object.assign(world.guides["AZ-903"], moved, { skillsMissing: true });
    const result = await runMonitor(box, learn, {
      GITHUB_STEP_SUMMARY: summary,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "false");
    assert.equal(result.outputs.guide_check_failed, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.match(
      result.stderr,
      /WARNING: the study guide of AZ-901 could not be parsed \(not the study guide page of AZ-901\); kept its previous state\./,
    );
    assert.match(
      result.stderr,
      /WARNING: the study guide of AZ-902 could not be parsed \(found neither an Updates to the exam nor a Skills measured section\)/,
    );
    assert.match(
      result.stderr,
      /WARNING: the study guide of AZ-903 lost its skills section in the markup; kept its previous state\. No change is reported for it until the section is back or FORCE_GUIDE_BASELINE=1 accepts the new text/,
    );
    const text = await readFile(summary, "utf8");
    assert.match(text, /The study guide of `AZ-901` could not be parsed/);
    assert.match(text, /The study guide of `AZ-903` lost its skills section/);
    assert.match(text, /Check the guide by hand/);
    assert.match(text, /`force_guide_baseline`/);
    assert.doesNotMatch(text, INTERNAL_WORDS);

    // Three of them at once is the pattern of changed markup: the guide check
    // stops, the run does not fail, and nothing is written.
    const flood = await runMonitor(box, learn, { MAX_GUIDE_CHANGES: "2" });
    assert.equal(flood.code, 0, flood.stderr);
    assert.equal(flood.outputs.extraction_failed, "false");
    assert.equal(flood.outputs.guide_check_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /3 of the 4 covered study guides looked different in one run \(0 changed text, 2 no longer parse, 1 lost a section;/,
    );
    assert.deepEqual(await readFile(box.tracker), before);

    // A page that does not parse is never recorded, forced or not: two of them
    // keep tripping a tight limit, even though the lost section would be accepted.
    const tight = await runMonitor(box, learn, {
      FORCE_GUIDE_BASELINE: "1",
      MAX_GUIDE_CHANGES: "1",
    });
    assert.equal(tight.code, 0, tight.stderr);
    assert.equal(tight.outputs.guide_check_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /2 of the 4 covered study guides looked different in one run \(0 changed text, 2 no longer parse, 0 lost a section;/,
    );
    assert.deepEqual(await readFile(box.tracker), before);

    // With a limit that lets them be, the lost section is accepted on purpose,
    // and the two unparsable pages keep their record.
    const forced = await runMonitor(box, learn, {
      FORCE_GUIDE_BASELINE: "1",
      MAX_GUIDE_CHANGES: "2",
    });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.outputs.guide_check_failed, "false");
    assert.equal(forced.outputs.changes_found, "false");
    assert.equal(forced.outputs.baseline_updated, "true");
    assert.match(forced.stderr, /study guide of AZ-901 could not be parsed/);
    const tracker = await readTracker(box);
    const was = JSON.parse(before);
    assert.deepEqual(guideOf(tracker, "AZ-901"), guideOf(was, "AZ-901"));
    assert.deepEqual(guideOf(tracker, "AZ-902"), guideOf(was, "AZ-902"));
    const accepted = guideOf(tracker, "AZ-903");
    assert.deepEqual(accepted.missing, ["skills"]);
    assert.notEqual(accepted.hash, guideOf(was, "AZ-903").hash);
    assert.equal(accepted.lastChanged, null);
    assert.equal(accepted.lastmod, "2026-09-25");

    // It is not a trap: the next real edit of that guide is reported again,
    // with the note that its skills section is not in the markup.
    world.guides["AZ-903"].lastmod = "2026-09-30";
    world.guides["AZ-903"].updates = [
      ...world.guides["AZ-903"].updates,
      "A new sentence.",
    ];
    const later = await runMonitor(box, learn);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(
      later.outputs.issue_title,
      "Microsoft Learn study guide updated: AZ-903",
    );
    const report = await readFile(box.report, "utf8");
    assert.match(report, /^\+ A new sentence\.$/m);
    assert.match(
      report,
      /Not found in the page markup: the "Skills measured" section\./,
    );
  } finally {
    await learn.close();
  }
});

test("guides are read at most two at a time, and reading stops after too many failures", async () => {
  const covered = Array.from(
    { length: 12 },
    (_, i) => `AZ-9${String(i + 1).padStart(2, "0")}`,
  );
  const { world, learn, box } = await guideWorld({
    covered,
    uncovered: [],
    guideOnly: [],
  });
  try {
    let inFlight = 0;
    let peak = 0;
    for (const code of covered) {
      world.guideHooks.set(code, (_request, response) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          response.setHeader("content-type", "text/html");
          response.end(guideHtml(code, world.guides[code]));
        }, 25);
        return true;
      });
    }
    const baseline = await runMonitor(box, learn);
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.ok(peak >= 1 && peak <= 2, `peak concurrency was ${peak}`);
    assert.equal(guideCodesRequested(world).length, 12);
  } finally {
    await learn.close();
  }

  // Every guide fails: after MAX_GUIDE_CHANGES-like patience the rest is not tried.
  const failing = await guideWorld({ covered, uncovered: [], guideOnly: [] });
  try {
    for (const code of covered) {
      failing.world.guideHooks.set(code, (_request, response) => {
        response.statusCode = 500;
        response.end("boom");
        return true;
      });
    }
    const result = await runMonitor(failing.box, failing.learn, {
      MAX_GUIDE_FETCH_FAILURES: "2",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.changes_found, "false");
    const asked = guideCodesRequested(failing.world);
    assert.ok(asked.length >= 2 && asked.length <= 4, asked.join(","));
    const tracker = await readTracker(failing.box);
    assert.equal(tracker.studyGuides.length, 12);
    assert.ok(tracker.studyGuides.every((guide) => guide.hash === null));
    assert.match(
      result.stderr,
      /could not read the study guide of AZ-9\d\d \(status 500\)/,
    );
    assert.match(
      result.stderr,
      /not fetched \(deadline or too many failures\)/,
    );

    // Next run: the guides answer, and the missing first hashes are recorded silently.
    failing.world.guideHooks.clear();
    const next = await runMonitor(failing.box, failing.learn);
    assert.equal(next.code, 0, next.stderr);
    assert.equal(next.outputs.changes_found, "false");
    const done = await readTracker(failing.box);
    assert.ok(
      done.studyGuides.every((guide) => /^[0-9a-f]{64}$/.test(guide.hash)),
    );
  } finally {
    await failing.learn.close();
  }
});

test("slow guide pages hit the guide deadline: the guides keep their record and the exam check is not held up", async () => {
  const { world, learn, box } = await guideBaselined();
  try {
    const before = await readFile(box.tracker);
    // Learn answers, but slower than the guide budget allows.
    for (const code of COVERED) {
      Object.assign(world.guides[code], {
        lastmod: "2026-09-20",
        updates: [...world.guides[code].updates, "A new sentence."],
      });
      world.guideHooks.set(code, (_request, response) => {
        setTimeout(() => {
          response.setHeader("content-type", "text/html");
          response.end(guideHtml(code, world.guides[code]));
        }, 400);
        return true;
      });
    }
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const result = await runMonitor(box, learn, { GUIDE_DEADLINE_MS: "250" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.guide_check_failed, "false");
    assert.equal(result.outputs.study_guides_changed, "0");
    assert.equal(
      result.outputs.issue_title,
      "New Microsoft Learn exam: AZ-950; 1 new certification",
    );
    assert.match(
      result.stderr,
      /could not read the study guide of AZ-90\d \(deadline reached\); kept its previous state/,
    );
    assert.match(
      result.stderr,
      /not fetched \(deadline or too many failures\)/,
    );
    // No guide record changed, and each is retried the next day.
    assert.deepEqual(
      (await readTracker(box)).studyGuides,
      JSON.parse(before).studyGuides,
    );
    world.guideHooks.clear();
    const retry = await runMonitor(box, learn, { TODAY: "2026-10-10" });
    assert.equal(retry.outputs.study_guides_changed, "4");
  } finally {
    await learn.close();
  }
});

test("a tracker from before the study guide check baselines the guides silently, and later floods of guide-only codes still fail", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    const first = await runMonitor(box, learn); // no guides in this sitemap: skipped
    assert.equal(first.code, 0, first.stderr);
    const old = await readTracker(box);
    assert.deepEqual(old.studyGuides, []);
    delete old.studyGuides; // the shape of a tracker written before this check existed
    await writeFile(box.tracker, JSON.stringify(old, null, 2) + "\n");

    // Learn has guides now: covered ones, and twenty codes only a guide shows
    // (more than MAX_NEW_EXAMS), which every older exam has: retired exams.
    const flood = Array.from({ length: 20 }, (_, i) => `AZ-9${80 + i}`);
    for (const code of ["AZ-901", "AZ-902", ...flood]) {
      world.guides[code] = guideSpec({ name: `Guide ${code}` });
    }
    await writeFile(join(box.docs, "azure", "AZ-901.mdx"), "---\n---\n");
    const result = await runMonitor(box, learn);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.extraction_failed, "false");
    assert.equal(result.outputs.changes_found, "false");
    assert.equal(result.outputs.baseline_updated, "true");
    assert.equal(await exists(box.report), false);
    const tracker = await readTracker(box);
    assert.equal(tracker.studyGuides.length, 22);
    assert.match(guideOf(tracker, "AZ-901").hash, /^[0-9a-f]{64}$/);
    for (const code of flood) {
      const record = tracker.exams.find((e) => e.code === code);
      assert.deepEqual(record?.certifications, [], code);
    }

    // A real new exam is still alerted; the twenty are not.
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const next = await runMonitor(box, learn);
    assert.equal(
      next.outputs.issue_title,
      "New Microsoft Learn exam: AZ-950; 1 new certification",
    );

    // Now that guides are tracked, sixteen new guide codes at once are a structure change.
    const before = await readFile(box.tracker);
    for (let i = 0; i < 16; i++) {
      world.guides[`SC-9${String(i).padStart(2, "0")}`] = guideSpec();
    }
    const failed = await runMonitor(box, learn);
    assert.equal(failed.code, 1);
    assert.match(
      await readFile(box.error, "utf8"),
      /16 new exams appeared at once/,
    );
    assert.deepEqual(await readFile(box.tracker), before);
  } finally {
    await learn.close();
  }
});

test("a sitemap split over several files is read completely", async () => {
  const { world, learn, box } = await guideWorld();
  try {
    world.sitemapSplit = true;
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(sitemapRequests(world), [
      "/_sitemaps/sitemapindex.xml",
      "/_sitemaps/credentials_en-us_1.xml",
      "/_sitemaps/credentials_en-us_2.xml",
    ]);
    assert.equal((await readTracker(box)).studyGuides.length, 8);
  } finally {
    await learn.close();
  }
});

test("a tracker whose studyGuides is not a list is corrupt and left alone", async () => {
  const world = baseWorld();
  const learn = await startLearn(world);
  const box = await sandbox();
  try {
    const bad = JSON.stringify({
      certifications: [],
      exams: [],
      studyGuides: {},
    });
    await writeFile(box.tracker, bad);
    const result = await runMonitor(box, learn);
    assert.equal(result.code, 1);
    assert.equal(result.outputs.extraction_failed, "true");
    assert.match(
      await readFile(box.error, "utf8"),
      /Corrupt tracker .*studyGuides is not an array/,
    );
    assert.equal(await readFile(box.tracker, "utf8"), bad);
  } finally {
    await learn.close();
  }
});

// ---------------------------------------------------------------------------
// Recovery: an exam is only "known" once the tracker that records it is saved
// ---------------------------------------------------------------------------
test("an exam is reported again until the tracker that records it is saved", async () => {
  // The workflow opens the issue first and commits the tracker afterwards. When
  // the issue fails the commit is skipped, so the tracker on main stays as it
  // was; the monitor must then report the same exam again, byte for byte.
  const { world, learn, box } = await baselined();
  try {
    const saved = await readFile(box.tracker);
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";

    const first = await runMonitor(box, learn);
    assert.equal(first.outputs.changes_found, "true");
    assert.equal(first.outputs.baseline_updated, "true");
    const firstReport = await readFile(box.report, "utf8");

    await writeFile(box.tracker, saved); // the commit was skipped
    const retry = await runMonitor(box, learn);
    assert.equal(retry.outputs.changes_found, "true");
    assert.equal(retry.outputs.baseline_updated, "true");
    assert.equal(retry.outputs.issue_title, first.outputs.issue_title);
    assert.equal(await readFile(box.report, "utf8"), firstReport);

    // The tracker was saved this time: the exam is not reported a third time.
    const quiet = await runMonitor(box, learn);
    assert.equal(quiet.outputs.changes_found, "false");
    assert.equal(quiet.outputs.baseline_updated, "false");
  } finally {
    await learn.close();
  }
});

// ---------------------------------------------------------------------------
// Hub vs Learn drift: the pure parts
// ---------------------------------------------------------------------------
const DRIFT_TODAY = "2026-10-09";

test("dates are read in the forms Learn uses; a month alone and an impossible day are no dates", () => {
  assert.deepEqual(
    parseDates("until October 30, 2026, at 5 PM").map((d) => d.iso),
    ["2026-10-30"],
  );
  assert.deepEqual(
    parseDates("on October 30th 2026 and 2026-11-02").map((d) => d.iso),
    ["2026-10-30", "2026-11-02"],
  );
  assert.deepEqual(parseDates("expected to go live in July 2026"), []);
  assert.deepEqual(parseDates("February 31, 2026 and 2026-02-30"), []);
  assert.equal(isRealIsoDate("2026-02-28"), true);
  assert.equal(isRealIsoDate("2026-02-29"), false);
  assert.equal(isRealIsoDate("2026-2-9"), false);
  assert.equal(formatDate("2026-10-06"), "October 6, 2026");
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-10-09", "2026-10-16"), 7);
  assert.equal(daysBetween("2026-10-16", "2026-10-09"), -7);

  // A hub page writes a date as prose or as an ISO value; "October 6" is not "October 16".
  assert.equal(
    mentionsDate("On **October 16, 2026**, registration", "2026-10-16"),
    true,
  );
  assert.equal(mentionsDate('retireDate="2026-10-16"', "2026-10-16"), true);
  assert.equal(mentionsDate("October 6, 2026", "2026-10-16"), false);
  assert.equal(mentionsDate("October 16, 2025", "2026-10-16"), false);
});

test("the hub page gives its exam name from the description template, whatever the quoting and spacing, and nothing from a page worded differently", () => {
  const source = (description, body = "") =>
    `---\ntitle: "AZ-104 Study Materials"\ndescription: ${description}\n---\n${body}`;
  const template =
    "Collection of study materials for the certification exam AZ-104:  Microsoft   Azure Administrator. Contains official Microsoft Learn materials, labs.";

  for (const description of [`"${template}"`, `'${template}'`, template]) {
    assert.equal(
      parseHubPage(source(description), "AZ-104").descriptionName,
      "Microsoft Azure Administrator",
      description,
    );
  }
  // A period inside the name does not end it.
  assert.equal(
    parseHubPage(
      source(
        '"Collection of study materials for the certification exam AZ-104: Run v2.0 things. Contains official Microsoft Learn materials."',
      ),
      "AZ-104",
    ).descriptionName,
    "Run v2.0 things",
  );
  // The GH-700 placeholder does not follow the template: no name, no comparison.
  const placeholder = parseHubPage(
    source(
      '"GH-700: Enhancing Operational Efficiency with Agentic AI is an upcoming GitHub certification exam, announced but not yet available."',
    ),
    "GH-700",
  );
  assert.equal(placeholder.descriptionName, null);
  assert.equal(placeholder.cardName, null);

  const page = parseHubPage(
    source(
      `"${template}"`,
      ":::caution\nThis exam retires soon.\n:::\n\n" +
        '<LinkCard title="Exam AZ-104: Microsoft Azure   Administrator" href="x" />\n' +
        '{/* <LinkCard title="Exam AZ-104: Hidden" href="y" /> */}\n',
    ),
    "AZ-104",
  );
  assert.equal(page.cardName, "Microsoft Azure Administrator");
  assert.match(page.caution, /retires soon/);
  assert.doesNotMatch(page.text, /Hidden/);
  assert.equal(
    parseHubPage("no frontmatter at all", "AZ-104").description,
    null,
  );
});

const notice = (...lines) => ({ label: "Note", lines });

test("a notice box is read for the retirement, transition, rename or cancellation it announces, with the dates it names", () => {
  assert.deepEqual(
    classifyNotice(
      notice(
        "This exam will retire on November 30, 2026, at 11:59 PM Central Standard Time. Learn more.",
      ),
    ).map(({ type, date }) => ({ type, date })),
    [{ type: "retirement", date: "2026-11-30" }],
  );
  assert.equal(
    classifyNotice(
      notice(
        "This exam was retired on September 30, 2026, at 5:00 PM Central Standard Time. Learn more.",
      ),
    )[0].date,
    "2026-09-30",
  );
  // A retirement with no date in its sentence has no date, even if another sentence has one.
  const undated = classifyNotice(
    notice(
      "This exam will retire soon. The new exam arrives on October 5, 2026.",
    ),
  );
  assert.equal(undated[0].type, "retirement");
  assert.equal(undated[0].date, null);

  const transition = classifyNotice(
    notice(
      "PL-400 is transitioning to AB-400 to align the exam within Microsoft's certification portfolio.",
      "Important dates:",
      "- October 16, 2026: Registration for PL-400 closes, and registration opens exclusively for AB-400.",
      "- Learners who register for PL-400 on or before October 16 can continue to schedule and take the exam through October 30, 2026.",
    ),
  );
  assert.deepEqual(
    transition.map(({ type, to }) => ({ type, to })),
    [{ type: "transition", to: "AB-400" }],
  );
  // The same day named twice is listed once.
  assert.deepEqual(transition[0].dates, ["2026-10-16", "2026-10-30"]);

  const [rename] = classifyNotice(
    notice(
      "We’re updating the certification’s name and level to reflect the evolving role of Azure Cosmos DB developers. The updated certification will be Microsoft Certified: Azure Cosmos DB AI Developer Associate. This change will go into effect on October 6, 2026. No action is required. Learn more.",
    ),
  );
  assert.equal(rename.type, "rename");
  assert.equal(rename.date, "2026-10-06");
  assert.equal(rename.newName, "Azure Cosmos DB AI Developer Associate");

  assert.deepEqual(
    classifyNotice(notice("The beta for this exam has been cancelled.")).map(
      (entry) => entry.type,
    ),
    ["cancellation"],
  );
  // Nothing is guessed from words that merely look alike.
  assert.deepEqual(
    classifyNotice(
      notice("Our exams are updated periodically to reflect skills."),
    ),
    [],
  );
});

test("notice boxes are read from the stored guide text, under the Notices heading only", () => {
  const lines = [
    "## Notices",
    "Warning",
    "This exam will retire on November 30, 2026.",
    "Note",
    "Second box.",
    "## Updates to the exam",
    "Note",
    "Not a notice.",
  ];
  assert.deepEqual(noticeBoxes(lines), [
    {
      label: "Warning",
      lines: ["This exam will retire on November 30, 2026."],
    },
    { label: "Note", lines: ["Second box."] },
  ]);
  assert.deepEqual(noticeBoxes(["## Updates to the exam", "x"]), []);
  assert.deepEqual(noticeBoxes(undefined), []);
});

test("a certification whose title changed is an event of its own, kept for a while and replaced by a newer rename", () => {
  const previous = normalizeTracker(
    {
      certifications: [
        {
          slug: "cosmos",
          title: "Microsoft Certified: Old   Name",
          exams: ["DP-420"],
        },
        { slug: "other", title: "Microsoft Certified: Other", exams: [] },
      ],
      exams: [],
      certRenames: [],
    },
    DRIFT_TODAY,
  );
  const scan = (title, other = "Microsoft Certified: Other") => ({
    certs: new Map([
      ["cosmos", { title }],
      ["other", { title: other }],
    ]),
  });
  const renamed = mergeCertRenames({
    previous,
    scan: scan("Microsoft Certified: New Name"),
    today: DRIFT_TODAY,
    days: 30,
  });
  assert.deepEqual(renamed, [
    {
      slug: "cosmos",
      from: "Microsoft Certified: Old Name",
      to: "Microsoft Certified: New Name",
      firstSeen: DRIFT_TODAY,
    },
  ]);
  // Whitespace is not a rename.
  assert.deepEqual(
    mergeCertRenames({
      previous,
      scan: scan("Microsoft Certified:  Old Name"),
      today: DRIFT_TODAY,
      days: 30,
    }),
    [],
  );

  // The next day the tracker has the new title and the event: still one event.
  const next = normalizeTracker(
    {
      certifications: [
        {
          slug: "cosmos",
          title: "Microsoft Certified: New Name",
          exams: ["DP-420"],
        },
      ],
      exams: [],
      certRenames: renamed,
    },
    DRIFT_TODAY,
  );
  const again = mergeCertRenames({
    previous: next,
    scan: scan("Microsoft Certified: New Name"),
    today: "2026-10-10",
    days: 30,
  });
  assert.equal(again.length, 1);
  assert.equal(again[0].firstSeen, DRIFT_TODAY);
  // Forgotten after the window, and replaced when renamed again.
  assert.deepEqual(
    mergeCertRenames({
      previous: next,
      scan: scan("Microsoft Certified: New Name"),
      today: "2026-11-15",
      days: 30,
    }),
    [],
  );
  const twice = mergeCertRenames({
    previous: next,
    scan: scan("Microsoft Certified: Newest"),
    today: "2026-10-12",
    days: 30,
  });
  assert.deepEqual(
    twice.map((event) => `${event.from} -> ${event.to}`),
    ["Microsoft Certified: New Name -> Microsoft Certified: Newest"],
  );
});

// --- evaluateDrift on small hubs and trackers --------------------------------
function hubPage(code, { name, text = "", area, description } = {}) {
  const folder = area ?? areaForCode(code) ?? "azure";
  const desc =
    description ??
    `Collection of study materials for the certification exam ${code}: ${name ?? "Some Exam"}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`;
  return {
    code,
    area: folder,
    path: `src/content/docs/${folder}/${code}.mdx`,
    labPath: null,
    ...parseHubPage(
      `---\ntitle: "${code}"\ndescription: "${desc}"\n---\n${text}`,
      code,
    ),
  };
}

function makeHub({ pages = [], statuses = {}, beta = [], retiring = [] } = {}) {
  return {
    pages: new Map(pages.map((page) => [page.code, page])),
    statuses: new Map(
      Object.entries(statuses).map(([code, text]) => [
        code,
        { area: areaForCode(code), text },
      ]),
    ),
    beta: new Map(beta.map((entry) => [entry.code, entry])),
    retiring: new Map(retiring.map((entry) => [entry.code, entry])),
  };
}

function trackedGuide(code, { name, headingName, lines } = {}) {
  const text = lines ?? ["## Updates to the exam", "Some text."];
  return {
    code,
    name,
    headingName,
    lastmod: "2026-09-01",
    hash: hashLines(text),
    updatedAt: "",
    lastChanged: null,
    lines: text,
  };
}

function makeTracker({ exams = [], guides = [], certRenames = [] } = {}) {
  return normalizeTracker(
    {
      certifications: [],
      exams: exams.map((exam) => ({ name: "", ...exam })),
      studyGuides: guides,
      certRenames,
    },
    DRIFT_TODAY,
  );
}

const drift = (hub, tracker, extra = {}) =>
  evaluateDrift({ today: DRIFT_TODAY, hub, tracker, ...extra });
const kinds = (items) =>
  items.map((item) => `${item.severity}:${item.kind}:${item.code}`);

test("drift: the exam name of the study guide against the hub description, modulo whitespace and nothing else", () => {
  const tracker = makeTracker({
    guides: [trackedGuide("AZ-104", { name: "Microsoft Azure Administrator" })],
  });
  const page = (name) => hubPage("AZ-104", { name });

  // Equal after whitespace normalisation: nothing.
  assert.deepEqual(
    drift(
      makeHub({ pages: [page("Microsoft  Azure\n Administrator")] }),
      tracker,
    ),
    [],
  );

  // A rename on Learn: a definite mismatch with the file to edit and the source.
  const items = drift(
    makeHub({
      pages: [
        {
          ...page("Old Administrator"),
          labPath: "src/content/docs/labs/azure/az-104.mdx",
        },
      ],
    }),
    tracker,
  );
  assert.deepEqual(kinds(items), ["fix:name:AZ-104"]);
  assert.match(items[0].summary, /Learn: "Microsoft Azure Administrator"/);
  assert.match(
    items[0].summary,
    /frontmatter description: "Old Administrator"/,
  );
  assert.deepEqual(items[0].hubFiles, [
    "src/content/docs/azure/AZ-104.mdx",
    "src/content/docs/labs/azure/az-104.mdx",
  ]);
  assert.match(items[0].edit, /src\/content\/docs\/azure\/AZ-104\.mdx/);
  assert.deepEqual(
    items[0].learn.map((link) => link.label),
    ["Study guide"],
  );
  assert.match(items[0].id, /^name:AZ-104:[0-9a-f]{8}$/);

  // Case counts.
  assert.deepEqual(
    kinds(
      drift(
        makeHub({ pages: [page("microsoft azure administrator")] }),
        tracker,
      ),
    ),
    ["fix:name:AZ-104"],
  );
  // The Get Started card is compared too.
  const card = hubPage("AZ-104", {
    name: "Microsoft Azure Administrator",
    text: '<LinkCard title="Exam AZ-104: Azure Administrator" href="x" />',
  });
  const cardItems = drift(makeHub({ pages: [card] }), tracker);
  assert.deepEqual(kinds(cardItems), ["fix:name:AZ-104"]);
  assert.match(
    cardItems[0].summary,
    /Get Started card title: "Azure Administrator"/,
  );
});

test("drift: a missing field is no evidence, and a carried-forward guide keeps its facts", () => {
  const page = hubPage("AZ-104", { name: "Whatever" });
  // No stored name (a guide that was never read, or an older tracker).
  assert.deepEqual(
    drift(
      makeHub({ pages: [page] }),
      makeTracker({ guides: [trackedGuide("AZ-104")] }),
    ),
    [],
  );
  assert.deepEqual(drift(makeHub({ pages: [page] }), makeTracker()), []);
  // A hub description that does not follow the template and has no card.
  const placeholder = hubPage("AZ-104", {
    description: "An upcoming exam, not yet on Learn.",
  });
  assert.deepEqual(
    drift(
      makeHub({ pages: [placeholder] }),
      makeTracker({ guides: [trackedGuide("AZ-104", { name: "Real Name" })] }),
    ),
    [],
  );
  // An exam with a page the hub does not have is not compared at all.
  assert.deepEqual(
    drift(
      makeHub(),
      makeTracker({ guides: [trackedGuide("AZ-104", { name: "Real Name" })] }),
    ),
    [],
  );
});

test("drift: when Learn words the name two ways the answer is ambiguous, never a definite mismatch", () => {
  const tracker = makeTracker({
    guides: [
      trackedGuide("AB-620", {
        name: "Designing and Building Integrated AI Solutions in Copilot Studio",
        headingName:
          "Designing and Building Integrated AI Agent Solutions in Copilot Studio",
      }),
    ],
  });
  // The hub uses one of the two wordings: information only.
  const uses = drift(
    makeHub({
      pages: [
        hubPage("AB-620", {
          name: "Designing and Building Integrated AI Solutions in Copilot Studio",
        }),
      ],
    }),
    tracker,
  );
  assert.deepEqual(kinds(uses), ["info:name:AB-620"]);
  assert.match(uses[0].summary, /more than one way/);
  assert.equal(uses[0].edit, "No edit needed now.");
  // The hub uses neither: a human decides which is official.
  const neither = drift(
    makeHub({ pages: [hubPage("AB-620", { name: "Something Else" })] }),
    tracker,
  );
  assert.deepEqual(kinds(neither), ["check:name:AB-620"]);
  assert.match(neither[0].summary, /decide which one is the official name/);
  // The certification page word counts as a second Learn wording.
  const withCert = drift(
    makeHub({ pages: [hubPage("AZ-104", { name: "Guide Name" })] }),
    makeTracker({
      guides: [trackedGuide("AZ-104", { name: "Guide Name" })],
      exams: [{ code: "AZ-104", name: "Card Name" }],
    }),
  );
  assert.deepEqual(kinds(withCert), ["info:name:AZ-104"]);
});

test("drift: the beta state, from the evidence the pages gave, against the hub badge and beta-exams.json", () => {
  const exams = (code, betaEvidence) =>
    makeTracker({ exams: [{ code, betaEvidence }] });
  const page = hubPage("AB-9", { name: "X" });
  const learn = (code, tags, hub) => drift(hub, exams(code, tags));

  // Learn marks it beta, the hub does not: fix, and the edit says where the date comes from.
  const started = learn("AB-9", ["card:beta"], makeHub({ pages: [page] }));
  assert.deepEqual(kinds(started), ["fix:beta:AB-9"]);
  assert.match(started[0].edit, /beta-exams\.json/);
  assert.match(started[0].edit, /never from this issue/);
  assertBetaEntryEdit(started[0].edit, "AB-9");
  assert.equal(started[0].id, "beta:AB-9:started");
  for (const tag of [
    "listing:beta",
    "certification-title:beta",
    "exam-page:beta",
  ]) {
    assert.deepEqual(
      kinds(learn("AB-9", [tag], makeHub({ pages: [page] }))),
      ["fix:beta:AB-9"],
      tag,
    );
  }

  // Only a callout says beta while the exam card / title do not: information
  // only (a stale callout is the usual reason), never a row to act on.
  const unclear = learn("AB-9", ["callout:beta"], makeHub({ pages: [page] }));
  assert.deepEqual(kinds(unclear), ["info:beta:AB-9"]);
  assert.match(unclear[0].summary, /stale callout/);
  assert.equal(unclear[0].id, "beta:AB-9:unclear");
  assert.ok(
    unclear[0].edit.includes("node scripts/beta-note.mjs --code AB-9"),
    unclear[0].edit,
  );
  // ... and the exam page title settles it the other way.
  assert.deepEqual(
    learn("AB-9", ["callout:beta", "exam-page:ga"], makeHub({ pages: [page] })),
    [],
  );

  // The hub says BETA (badge or tracker entry), Learn shows a GA exam card: fix.
  const ended = learn(
    "AB-9",
    ["card:ga"],
    makeHub({ pages: [page], statuses: { "AB-9": "BETA" } }),
  );
  assert.deepEqual(kinds(ended), ["fix:beta:AB-9"]);
  assert.equal(ended[0].id, "beta:AB-9:ended");
  assert.match(ended[0].edit, /Beta exam tracker/);
  assert.deepEqual(
    kinds(
      learn(
        "AB-9",
        ["listing:ga"],
        makeHub({ pages: [page], beta: [{ code: "AB-9", flaggedGA: false }] }),
      ),
    ),
    ["fix:beta:AB-9"],
  );
  // No marker anywhere (a certification page that could not be read): check, not fix.
  assert.deepEqual(
    kinds(
      learn(
        "AB-9",
        [],
        makeHub({ pages: [page], statuses: { "AB-9": "BETA" } }),
      ),
    ),
    ["check:beta:AB-9"],
  );
  // Agreement raises nothing, and a beta entry Learn already flagged GA is not a hub beta.
  assert.deepEqual(
    learn(
      "AB-9",
      ["card:beta"],
      makeHub({ pages: [page], statuses: { "AB-9": "BETA" } }),
    ),
    [],
  );
  assert.deepEqual(
    learn(
      "AB-9",
      ["card:ga"],
      makeHub({ pages: [page], beta: [{ code: "AB-9", flaggedGA: true }] }),
    ),
    [],
  );
  assert.deepEqual(learn("AB-9", ["card:ga"], makeHub({ pages: [page] })), []);
  // UPCOMING has its own check: no beta row on top of it.
  assert.deepEqual(
    kinds(
      learn(
        "AB-9",
        ["card:beta"],
        makeHub({ pages: [page], statuses: { "AB-9": "UPCOMING" } }),
      ),
    ),
    ["fix:upcoming:AB-9"],
  );
});

test("drift: a retirement date in the notices against the badge, retiring-exams.json and the banner", () => {
  const retire = (date) =>
    trackedGuide("MS-9", {
      lines: [
        "## Notices",
        "Warning",
        `This exam will retire on ${formatDate(date)}, at 11:59 PM Central Standard Time. Learn more.`,
        "## Updates to the exam",
        "Text.",
      ],
    });
  const tracker = makeTracker({ guides: [retire("2026-11-30")] });
  const page = hubPage("MS-9", { name: "X" });

  // Nothing on the hub: badge, tracker entry and banner are all proposed.
  const nothing = drift(makeHub({ pages: [page] }), tracker);
  assert.deepEqual(kinds(nothing), ["fix:notice:MS-9"]);
  assert.match(
    nothing[0].edit,
    /add \{ text: "RETIRING", variant: "danger" \} for MS-9 to src\/data_files\/exam-status\.mjs/,
  );
  assert.match(nothing[0].edit, /retirementDate 2026-11-30/);
  assert.match(nothing[0].edit, /November 30, 2026 in the banner/);
  assert.match(nothing[0].summary, /retirement on November 30, 2026/);
  assert.deepEqual(nothing[0].hubFiles, [
    page.path,
    "src/data_files/exam-status.mjs",
    "src/data_files/retiring-exams.json",
  ]);
  assert.equal(nothing[0].id, "notice:MS-9:retirement:2026-11-30");

  // The date is tracked correctly: raise nothing, whatever the page text says.
  const tracked = { code: "MS-9", retirementDate: "2026-11-30" };
  assert.deepEqual(
    drift(
      makeHub({
        pages: [page],
        statuses: { "MS-9": "RETIRING" },
        retiring: [tracked],
      }),
      tracker,
    ),
    [],
  );
  // The tracker has another date: change it.
  const other = drift(
    makeHub({
      pages: [page],
      statuses: { "MS-9": "RETIRING" },
      retiring: [{ code: "MS-9", retirementDate: "2026-12-31" }],
    }),
    tracker,
  );
  assert.deepEqual(kinds(other), ["fix:notice:MS-9"]);
  assert.match(
    other[0].edit,
    /change retirementDate of MS-9 in src\/data_files\/retiring-exams\.json from 2026-12-31 to 2026-11-30/,
  );
  assert.doesNotMatch(other[0].edit, /add \{ text: "RETIRING"/);
  // An AT RISK badge is replaced, not added; a banner that shows the date needs no edit for it.
  const risk = drift(
    makeHub({
      pages: [
        hubPage("MS-9", {
          name: "X",
          text: "This exam retires on November 30, 2026.",
        }),
      ],
      statuses: { "MS-9": "AT RISK" },
    }),
    tracker,
  );
  assert.match(risk[0].edit, /replace the AT RISK badge of MS-9/);
  assert.doesNotMatch(risk[0].edit, /in the banner/);
  // A retirement without a date is something to check.
  const undated = drift(
    makeHub({ pages: [page] }),
    makeTracker({
      guides: [
        trackedGuide("MS-9", {
          lines: [
            "## Notices",
            "Warning",
            "This exam will retire soon.",
            "## Updates to the exam",
            "x",
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(kinds(undated), ["check:notice:MS-9"]);
  assert.match(undated[0].summary, /without a date/);
  // A guide kept from an earlier read without its text raises nothing.
  assert.deepEqual(
    drift(
      makeHub({ pages: [page] }),
      makeTracker({ guides: [{ ...trackedGuide("MS-9"), lines: undefined }] }),
    ),
    [],
  );
});

test("drift: a RETIRING badge whose date has passed is switched to RETIRED, a RETIRED badge ahead of its date is flagged", () => {
  const TODAY = "2026-10-14";
  const guideWith = (sentence) =>
    trackedGuide("AZ-9", {
      lines: [
        "## Notices",
        "Warning",
        sentence,
        "## Updates to the exam",
        "Text.",
      ],
    });
  const retiredOn = (date) =>
    guideWith(
      `This exam was retired on ${formatDate(date)}, at 5:00 PM Central Standard Time. Learn more.`,
    );
  const retiresOn = (date) =>
    guideWith(
      `This exam will retire on ${formatDate(date)}, at 11:59 PM Central Standard Time. Learn more.`,
    );
  const banner = hubPage("AZ-9", {
    name: "X",
    text: '<RetirementBanner retireDate="September 30, 2026" certRetires={false} />',
  });
  const plain = hubPage("AZ-9", { name: "X" });
  const run = ({ status, date, guide, page = banner }) =>
    drift(
      makeHub({
        pages: [page],
        statuses: status ? { "AZ-9": status } : {},
        retiring: date ? [{ code: "AZ-9", retirementDate: date }] : [],
      }),
      makeTracker({ guides: guide ? [guide] : [] }),
      { today: TODAY },
    );

  // RETIRING, tracked date passed: switch to RETIRED, keep the entry as history.
  const switched = run({
    status: "RETIRING",
    date: "2026-09-30",
    guide: retiredOn("2026-09-30"),
  });
  assert.deepEqual(kinds(switched), ["fix:status:AZ-9"]);
  assert.equal(switched[0].id, "status:AZ-9:retired:2026-09-30");
  assert.match(
    switched[0].summary,
    /still shows AZ-9 as RETIRING, but its retirement date has passed: retiring-exams\.json says September 30, 2026\./,
  );
  assert.match(
    switched[0].summary,
    /Learn's notice: "This exam was retired on/,
  );
  assert.match(switched[0].edit, /^Switch the badge to RETIRED/);
  assert.match(
    switched[0].edit,
    /replace the RETIRING badge of AZ-9 with \{ text: "RETIRED", variant: "note" \} in src\/data_files\/exam-status\.mjs/,
  );
  assert.match(
    switched[0].edit,
    /Keep the AZ-9 entry in src\/data_files\/retiring-exams\.json as history/,
  );
  assert.match(
    switched[0].edit,
    /RetirementBanner on src\/content\/docs\/azure\/AZ-9\.mdx words itself in the past tense by itself/,
  );
  assert.deepEqual(switched[0].hubFiles, [
    banner.path,
    "src/data_files/exam-status.mjs",
    "src/data_files/retiring-exams.json",
  ]);
  assert.deepEqual(
    switched[0].learn.map((link) => link.label),
    ["Study guide"],
  );
  // A hand-written caution box has to be reworded by hand.
  assert.match(
    run({ status: "RETIRING", date: "2026-09-30", page: plain })[0].edit,
    /Reword the retirement note on src\/content\/docs\/azure\/AZ-9\.mdx in the past tense\./,
  );

  // On the day itself and before it the exam is still retiring.
  for (const date of ["2026-10-14", "2026-11-30"]) {
    assert.deepEqual(
      run({ status: "RETIRING", date, guide: retiresOn(date) }),
      [],
      date,
    );
  }
  // RETIRING with no tracker entry: Learn's past-dated notice decides, and says to add the entry.
  const noEntry = run({ status: "RETIRING", guide: retiredOn("2026-09-30") });
  assert.ok(kinds(noEntry).includes("fix:status:AZ-9"));
  const noEntryStatus = noEntry.find((item) => item.kind === "status");
  assert.match(
    noEntryStatus.summary,
    /Learn says it has retired on September 30, 2026, and retiring-exams\.json has no entry/,
  );
  assert.match(
    noEntryStatus.edit,
    /\(add it first, with the date of the official source\)/,
  );
  // ... and nothing to go on without a date at all.
  assert.deepEqual(run({ status: "RETIRING" }), []);
  // Learn names a future date while the tracker's has passed: the notice row says the date is wrong, the badge row stays quiet.
  assert.deepEqual(
    kinds(
      run({
        status: "RETIRING",
        date: "2026-09-30",
        guide: retiresOn("2026-12-31"),
      }),
    ),
    ["fix:notice:AZ-9"],
  );

  // RETIRED, and the tracker and Learn agree that it has retired: nothing (the AZ-800 case).
  assert.deepEqual(
    run({
      status: "RETIRED",
      date: "2026-09-30",
      guide: retiredOn("2026-09-30"),
    }),
    [],
  );
  assert.deepEqual(run({ status: "RETIRED" }), []);
  assert.deepEqual(run({ status: "RETIRED", date: "2026-09-30" }), []);

  // RETIRED ahead of the tracker's date, whether that is in a month or today.
  const ahead = run({ status: "RETIRED", date: "2026-12-31" });
  assert.deepEqual(kinds(ahead), ["fix:status:AZ-9"]);
  assert.equal(ahead[0].id, "status:AZ-9:ahead:2026-12-31");
  assert.match(ahead[0].summary, /RETIRED badge of AZ-9 is ahead of the date/);
  assert.match(ahead[0].summary, /retiring-exams\.json says December 31, 2026/);
  assert.match(
    ahead[0].edit,
    /change the badge of AZ-9 back to \{ text: "RETIRING", variant: "danger" \} in src\/data_files\/exam-status\.mjs/,
  );
  assert.deepEqual(kinds(run({ status: "RETIRED", date: TODAY })), [
    "fix:status:AZ-9",
  ]);
  // ... or ahead of the date Learn's notice gives, with no tracker entry.
  const learnAhead = run({
    status: "RETIRED",
    guide: retiresOn("2026-11-30"),
  });
  // (the notice row asks for the missing tracker entry on top of it)
  assert.deepEqual(kinds(learnAhead), ["fix:notice:AZ-9", "fix:status:AZ-9"]);
  const learnStatus = learnAhead.find((item) => item.kind === "status");
  assert.equal(learnStatus.id, "status:AZ-9:ahead:2026-11-30");
  assert.match(
    learnStatus.summary,
    /Learn's notice: "This exam will retire on/,
  );
  assert.doesNotMatch(
    learnAhead.find((item) => item.kind === "notice").edit,
    /badge/,
  );

  // The notice check treats RETIRED like RETIRING: no badge to add, a differing date to change.
  const differs = run({
    status: "RETIRED",
    date: "2026-09-29",
    guide: retiredOn("2026-09-30"),
  });
  assert.deepEqual(kinds(differs), ["fix:notice:AZ-9"]);
  assert.match(
    differs[0].edit,
    /change retirementDate of AZ-9 in src\/data_files\/retiring-exams\.json from 2026-09-29 to 2026-09-30/,
  );
  assert.doesNotMatch(differs[0].edit, /badge/);
  // an undated retirement notice raises nothing for an exam that carries the badge
  assert.deepEqual(
    run({
      status: "RETIRED",
      guide: guideWith("This exam has retired. Learn more."),
    }),
    [],
  );
  // With no badge at all, a past-dated notice proposes RETIRED, a future one RETIRING.
  assert.match(
    run({ guide: retiredOn("2026-09-30") })[0].edit,
    /add \{ text: "RETIRED", variant: "note" \} for AZ-9 to src\/data_files\/exam-status\.mjs/,
  );
  assert.match(
    run({ guide: retiresOn("2026-11-30") })[0].edit,
    /add \{ text: "RETIRING", variant: "danger" \} for AZ-9 to src\/data_files\/exam-status\.mjs/,
  );
  // The new kind is sorted after the notice rows and has its own label.
  assert.equal(
    buildDriftReport({ items: switched, today: TODAY }).body.includes(
      "| AZ-9 | Retirement badge |",
    ),
    true,
  );
});

test("drift: the 'ahead of the date' row says nothing about today, so a new day alone changes neither its text nor the marker of the issue", () => {
  const hub = makeHub({
    pages: [hubPage("AZ-9", { name: "X" })],
    statuses: { "AZ-9": "RETIRED" },
    retiring: [{ code: "AZ-9", retirementDate: "2026-12-31" }],
  });
  const day = (today) => {
    const items = drift(hub, makeTracker(), { today });
    return { items, report: buildDriftReport({ items, today }) };
  };
  const first = day("2026-10-09");
  const second = day("2026-10-10");
  assert.deepEqual(kinds(first.items), ["fix:status:AZ-9"]);
  assert.match(
    first.items[0].summary,
    /^The RETIRED badge of AZ-9 is ahead of the date: the exam has not retired yet\. retiring-exams\.json says December 31, 2026\.$/,
  );
  assert.doesNotMatch(first.items[0].summary, /today|October 9|2026-10-09/);
  assert.deepEqual(second.items, first.items);
  // The marker hashes the text of the rows: the same on both days.
  assert.deepEqual(second.report.signature, first.report.signature);
  assert.equal(
    parseDriftMarker(second.report.body).h,
    parseDriftMarker(first.report.body).h,
  );

  // So the running issue is not edited, not even with a write, on the second day.
  const memory = memoryGh();
  assert.equal(
    syncDriftIssue(enabledCfg({ today: "2026-10-09" }), memory.gh, first)
      .action,
    "created",
  );
  assert.equal(
    syncDriftIssue(enabledCfg({ today: "2026-10-10" }), memory.gh, second)
      .action,
    "unchanged",
  );
  assert.deepEqual(
    memory.writes().map((call) => call.command),
    ["issue create"],
  );
});

test("drift: a transition, a certification rename and a cancellation in the notices", () => {
  const transition = trackedGuide("PL-901", {
    lines: [
      "## Notices",
      "Note",
      "PL-901 is transitioning to AB-901 to align the exam.",
      "- October 16, 2026: Registration for PL-901 closes.",
      "- You can take the exam through October 30, 2026.",
      "## Updates to the exam",
      "x",
    ],
  });
  const page = hubPage("PL-901", { name: "X" });
  const items = drift(
    makeHub({ pages: [page] }),
    makeTracker({ guides: [transition] }),
  );
  assert.deepEqual(kinds(items), ["fix:notice:PL-901"]);
  assert.match(items[0].summary, /PL-901 is transitioning to AB-901/);
  assert.match(items[0].edit, /replacementCode AB-901/);
  assert.match(items[0].edit, /October 16, 2026, October 30, 2026/);
  assert.match(items[0].edit, /mention AB-901 in the banner/);
  assert.equal(items[0].id, "notice:PL-901:transition:AB-901");
  // Tracked with that replacement: nothing; the banner already names it: no banner step.
  assert.deepEqual(
    drift(
      makeHub({
        pages: [page],
        statuses: { "PL-901": "RETIRING" },
        retiring: [
          {
            code: "PL-901",
            retirementDate: "2026-10-30",
            replacementCode: "AB-901",
          },
        ],
      }),
      makeTracker({ guides: [transition] }),
    ),
    [],
  );
  const named = drift(
    makeHub({
      pages: [hubPage("PL-901", { name: "X", text: "Moves to [AB-901](x)." })],
    }),
    makeTracker({ guides: [transition] }),
  );
  assert.doesNotMatch(named[0].edit, /in the banner/);

  const rename = trackedGuide("DP-9", {
    lines: [
      "## Notices",
      "Note",
      "We’re updating the certification’s name and level. The updated certification will be Microsoft Certified: Azure Cosmos DB AI Developer Associate. This change will go into effect on October 6, 2026. No action is required.",
      "## Updates to the exam",
      "x",
    ],
  });
  const stale = drift(
    makeHub({
      pages: [
        hubPage("DP-9", {
          name: "X",
          text: "Microsoft Certified: Azure Cosmos DB Developer Specialty",
        }),
      ],
    }),
    makeTracker({ guides: [rename] }),
  );
  assert.deepEqual(kinds(stale), ["fix:notice:DP-9"]);
  assert.match(
    stale[0].summary,
    /certification rename effective October 6, 2026 to "Azure Cosmos DB AI Developer Associate"/,
  );
  // The page shows the new name: nothing.
  assert.deepEqual(
    drift(
      makeHub({
        pages: [
          hubPage("DP-9", {
            name: "X",
            text: "Now Microsoft Certified: Azure Cosmos DB AI Developer Associate.",
          }),
        ],
      }),
      makeTracker({ guides: [rename] }),
    ),
    [],
  );

  const cancelled = trackedGuide("SC-9", {
    lines: [
      "## Notices",
      "Note",
      "The beta for SC-9 has been cancelled.",
      "## Updates to the exam",
      "x",
    ],
  });
  assert.deepEqual(
    kinds(
      drift(
        makeHub({ pages: [hubPage("SC-9", { name: "X" })] }),
        makeTracker({ guides: [cancelled] }),
      ),
    ),
    ["check:notice:SC-9"],
  );
  assert.deepEqual(
    drift(
      makeHub({
        pages: [
          hubPage("SC-9", { name: "X", text: "The beta was cancelled." }),
        ],
      }),
      makeTracker({ guides: [cancelled] }),
    ),
    [],
  );
});

test("drift: an UPCOMING exam that appears on Learn, and an AT RISK banner about an exam Learn lists now", () => {
  const upcoming = hubPage("GH-9", {
    description: "GH-9 is an upcoming exam.",
  });
  const hub = makeHub({ pages: [upcoming], statuses: { "GH-9": "UPCOMING" } });
  // Absent from Learn: nothing.
  assert.deepEqual(drift(hub, makeTracker()), []);
  // The study guide appears in the sitemap.
  const byGuide = drift(
    hub,
    makeTracker({ guides: [trackedGuide("GH-9", { name: "Agentic AI" })] }),
  );
  assert.deepEqual(kinds(byGuide), ["fix:upcoming:GH-9"]);
  assert.match(
    byGuide[0].summary,
    /now on Microsoft Learn: study guide in the sitemap/,
  );
  assert.equal(byGuide[0].id, "upcoming:GH-9:now-on-learn");
  assert.match(byGuide[0].edit, /replace the UPCOMING badge/);
  assertBetaEntryEdit(byGuide[0].edit, "GH-9");
  // A certification page lists it, beta.
  const byCert = drift(
    hub,
    makeTracker({
      exams: [
        {
          code: "GH-9",
          betaEvidence: ["card:beta"],
          certifications: [
            {
              slug: "ai-bp",
              title: "GitHub Certified: Agentic AI for Business Professionals",
            },
          ],
          url: "https://learn.microsoft.com/credentials/certifications/exams/gh-9?WT.mc_id=studentamb_165290",
        },
      ],
    }),
  );
  assert.deepEqual(kinds(byCert), ["fix:upcoming:GH-9"]);
  assert.match(
    byCert[0].summary,
    /certification page \(GitHub Certified: Agentic AI for Business Professionals\), exam page/,
  );
  assert.match(byCert[0].summary, /Learn marks it as a beta exam/);
  assert.deepEqual(byCert[0].learn[0], {
    label: "Exam page",
    url: "https://learn.microsoft.com/credentials/certifications/exams/gh-9?WT.mc_id=studentamb_165290",
  });
  // The exam is no longer UPCOMING on the hub: this check is quiet.
  assert.deepEqual(
    kinds(
      drift(
        makeHub({ pages: [upcoming] }),
        makeTracker({ guides: [trackedGuide("GH-9", { name: "Agentic AI" })] }),
      ),
    ).filter((k) => k.includes("upcoming")),
    [],
  );

  const caution = hubPage("AZ-400", {
    name: "X",
    text: ":::caution\nMicrosoft is exploring a potential new exam, AZ-401: Designing Agentic DevOps. It may replace AZ-400. Neither has been confirmed.\n:::\n",
  });
  const risk = makeHub({ pages: [caution], statuses: { "AZ-400": "AT RISK" } });
  assert.deepEqual(drift(risk, makeTracker()), []);
  const listed = drift(
    risk,
    makeTracker({
      exams: [
        {
          code: "AZ-401",
          name: "Designing and Implementing Microsoft Agentic DevOps Solutions",
          betaEvidence: ["card:beta"],
          certifications: [
            {
              slug: "agentic-devops",
              title: "Microsoft Certified: Agentic DevOps Engineer Expert",
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(kinds(listed), ["fix:at-risk:AZ-400"]);
  assert.match(
    listed[0].summary,
    /calls AZ-401 a potential, unconfirmed exam, but Learn lists it/,
  );
  assert.match(listed[0].summary, /marked beta/);
  assert.equal(listed[0].id, "at-risk:AZ-400:AZ-401");
  // Without the AT RISK badge the banner is not judged.
  assert.deepEqual(
    drift(
      makeHub({ pages: [caution] }),
      makeTracker({ exams: [{ code: "AZ-401", name: "N" }] }),
    ),
    [],
  );
});

test("drift: a retirement notice without a date is a row only while the hub tracks nothing", () => {
  const page = hubPage("MS-9", { name: "X" });
  const tracker = makeTracker({
    guides: [
      trackedGuide("MS-9", {
        lines: [
          "## Notices",
          "Warning",
          "This exam will retire soon.",
          "## Updates to the exam",
          "x",
        ],
      }),
    ],
  });
  // Nothing tracked: something to check.
  assert.deepEqual(kinds(drift(makeHub({ pages: [page] }), tracker)), [
    "check:notice:MS-9",
  ]);
  // The badge alone, or the retiring-exams.json entry alone, is enough: the
  // hub already knows the exam retires, the missing date is its own business.
  assert.deepEqual(
    drift(
      makeHub({ pages: [page], statuses: { "MS-9": "RETIRING" } }),
      tracker,
    ),
    [],
  );
  assert.deepEqual(
    drift(
      makeHub({
        pages: [page],
        retiring: [{ code: "MS-9", retirementDate: "2026-11-30" }],
      }),
      tracker,
    ),
    [],
  );
});

test("drift: an AT RISK banner is judged on its own wording, and an exam never counts as its own successor", () => {
  const banner = (text) =>
    hubPage("AZ-400", { name: "X", text: `:::caution\n${text}\n:::\n` });
  const risk = (page) =>
    makeHub({ pages: [page], statuses: { "AZ-400": "AT RISK" } });
  const listed = (...codes) =>
    makeTracker({ exams: codes.map((code) => ({ code, name: "X" })) });

  // The real banner names AZ-400 itself, and AZ-400 is in the tracker: no row
  // for the exam about itself, only for the other one that Learn lists.
  const real = banner(
    "Microsoft is exploring a potential new exam, AZ-401. It may replace AZ-400. Neither has been confirmed.",
  );
  assert.deepEqual(drift(risk(real), listed("AZ-400")), []);
  assert.deepEqual(kinds(drift(risk(real), listed("AZ-400", "AZ-401"))), [
    "fix:at-risk:AZ-400",
  ]);

  // A banner that still calls the exam "potential" or says Microsoft is
  // "exploring" it is stale once Learn lists the exam.
  for (const text of [
    "A potential exam, AZ-401, is mentioned.",
    "Microsoft is exploring AZ-401.",
  ]) {
    assert.deepEqual(
      kinds(drift(risk(banner(text)), listed("AZ-401"))),
      ["fix:at-risk:AZ-400"],
      text,
    );
  }
  // A banner that already says the exam is listed and nothing is confirmed (the
  // AZ-400 banner today) is up to date: "not confirmed", "neither", "may
  // replace" and a survey mentioned in an announcement link are no reason.
  for (const text of [
    "AZ-401 has not been confirmed.",
    "AZ-401 is not confirmed.",
    "Neither AZ-400 nor AZ-401 is final.",
    "AZ-401 may replace this exam.",
    "A survey about AZ-401 is open.",
    "Microsoft Learn lists AZ-401. It may replace AZ-400, but neither is confirmed. [Announcement](https://example.com/potential-exploring-survey)",
  ]) {
    assert.deepEqual(
      kinds(drift(risk(banner(text)), listed("AZ-401"))),
      [],
      text,
    );
  }
  // A banner that states a fact is not judged.
  assert.deepEqual(
    drift(risk(banner("AZ-401 is the new exam.")), listed("AZ-401")),
    [],
  );
});

test("drift: a certification rename since the last run, and the certification names the page still uses", () => {
  const rename = {
    slug: "cosmos",
    from: "Microsoft Certified: Azure Cosmos DB Developer Specialty",
    to: "Microsoft Certified: Azure Cosmos DB AI Developer Associate",
    firstSeen: "2026-10-08",
  };
  const exams = [
    {
      code: "DP-9",
      certifications: [{ slug: "cosmos", title: rename.to }],
    },
  ];
  const tracker = makeTracker({ exams, certRenames: [rename] });
  const old = hubPage("DP-9", {
    name: "X",
    text: "Earns Microsoft Certified: Azure Cosmos DB Developer Specialty.",
  });
  const items = drift(makeHub({ pages: [old] }), tracker);
  const fix = items.find((item) => item.severity === "fix");
  assert.ok(fix, kinds(items).join());
  assert.equal(fix.kind, "certification");
  assert.match(
    fix.summary,
    /renamed the certification "Microsoft Certified: Azure Cosmos DB Developer Specialty" to "Microsoft Certified: Azure Cosmos DB AI Developer Associate"/,
  );
  assert.match(fix.summary, /still shows the old name/);
  assert.deepEqual(fix.learn, [
    {
      label: "Certification page",
      url: "https://learn.microsoft.com/credentials/certifications/cosmos/?WT.mc_id=studentamb_165290",
    },
  ]);
  // A page that names neither: information. The new name: nothing.
  assert.equal(
    drift(makeHub({ pages: [hubPage("DP-9", { name: "X" })] }), tracker)[0]
      .severity,
    "info",
  );
  assert.deepEqual(
    drift(
      makeHub({
        pages: [
          hubPage("DP-9", {
            name: "X",
            text: "Microsoft Certified: Azure Cosmos DB AI Developer Associate",
          }),
        ],
      }),
      tracker,
    ),
    [],
  );
  // The event is forgotten after the window.
  assert.deepEqual(
    drift(makeHub({ pages: [hubPage("DP-9", { name: "X" })] }), tracker, {
      today: "2026-12-01",
    }),
    [],
  );
  // The certification name the hub text uses, against what Learn lists today: information only.
  const text = drift(makeHub({ pages: [old] }), makeTracker({ exams }));
  assert.deepEqual(kinds(text), ["info:certification:DP-9"]);
  assert.match(text[0].summary, /may be quoting the former name on purpose/);
});

test("drift: the rows are sorted fix, check, information; then by kind and exam", () => {
  const hub = makeHub({
    pages: [
      hubPage("AZ-1", { name: "Old" }),
      hubPage("AZ-2", { name: "Old" }),
      hubPage("AZ-3", { name: "Same" }),
      hubPage("AZ-4", { name: "Same" }),
    ],
    statuses: { "AZ-4": "BETA" },
  });
  const tracker = makeTracker({
    guides: [
      trackedGuide("AZ-1", { name: "New" }),
      trackedGuide("AZ-2", { name: "New" }),
      trackedGuide("AZ-3", { name: "Same", headingName: "Other" }),
    ],
    exams: [{ code: "AZ-2", betaEvidence: ["callout:beta"] }],
  });
  // AZ-4 is BETA on the hub and no page shows a beta marker: a row to check.
  // AZ-2 is only called beta by a callout: information, never a row to act on.
  assert.deepEqual(kinds(drift(hub, tracker)), [
    "fix:name:AZ-1",
    "fix:name:AZ-2",
    "check:beta:AZ-4",
    "info:name:AZ-3",
    "info:beta:AZ-2",
  ]);
});

// --- the issue text --------------------------------------------------------------
function sampleItems() {
  const hub = makeHub({
    pages: [
      hubPage("AZ-1", { name: "Old" }),
      hubPage("AZ-2", { name: "X" }),
      hubPage("AZ-3", { name: "Z" }),
    ],
    statuses: { "AZ-3": "BETA" },
  });
  const tracker = makeTracker({
    guides: [
      trackedGuide("AZ-1", { name: "New" }),
      trackedGuide("AZ-2", { name: "X", headingName: "Y" }),
    ],
  });
  return drift(hub, tracker);
}

test("the drift issue text has a table per severity, the hub file and the Learn source of every row, the checklist and a marker", () => {
  const items = sampleItems();
  const { body, signature } = buildDriftReport({ items, today: DRIFT_TODAY });
  assert.match(body, /^## Learn drift: hub pages need updating/);
  assert.match(body, /\*\*1 to fix\*\*, \*\*1 to check\*\*, 1 for information/);
  for (const heading of [
    "### To fix (1)",
    "### To check (1)",
    "### For information (1)",
  ]) {
    assert.ok(body.includes(heading), heading);
  }
  assert.match(
    body,
    /\| Exam \| Kind \| What differs \| What to edit \| Hub file \| Learn source \|/,
  );
  assert.ok(body.includes("`src/content/docs/azure/AZ-1.mdx`"));
  assert.match(
    body,
    /\[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/az-1\?WT\.mc_id=studentamb_165290\)/,
  );
  assert.match(body, /### What to do/);
  assert.match(body, /scripts\/audit-missing-resources\.mjs/);
  assert.match(
    body,
    /"New Exam Monitor" runbook \(`docs\/monitors\/new-exam-monitor\.md`\)/,
  );
  assert.match(body, /never use a date from this issue as the start of a beta/);
  assert.doesNotMatch(body, INTERNAL_WORDS);

  // The marker lists the ids of the open rows and of the information rows.
  const marker = parseDriftMarker(body);
  assert.deepEqual(
    marker.ids,
    items
      .filter((i) => i.severity !== "info")
      .map((i) => i.id)
      .sort(),
  );
  assert.deepEqual(
    marker.infoIds,
    items.filter((i) => i.severity === "info").map((i) => i.id),
  );
  assert.equal(marker.a, signature.a);
  assert.equal(marker.h, signature.h);
  assert.equal(parseDriftMarker("no marker"), null);
  assert.equal(parseDriftMarker(null), null);

  // The same rows give the same text apart from the date; another wording changes the row hash only.
  assert.equal(
    buildDriftReport({ items, today: "2026-10-10" }).signature.h,
    signature.h,
  );
  const reworded = items.map((item) => ({
    ...item,
    summary: `${item.summary} (more)`,
  }));
  const other = buildDriftReport({
    items: reworded,
    today: DRIFT_TODAY,
  }).signature;
  assert.equal(other.a, signature.a);
  assert.notEqual(other.h, signature.h);
  assert.deepEqual(driftSignature([]), {
    a: "-",
    b: "-",
    h: driftSignature([]).h,
  });
});

test("text from a Learn page cannot ping, link, render HTML or break the table of the drift issue", () => {
  const hub = makeHub({ pages: [hubPage("AZ-1", { name: "Old" })] });
  const evil =
    "Evil | name <script>alert(1)</script> @octocat fixes #12 [click](https://evil.example/x) `code`";
  const items = drift(
    hub,
    makeTracker({ guides: [trackedGuide("AZ-1", { name: evil })] }),
  );
  const { body } = buildDriftReport({ items, today: DRIFT_TODAY });
  const row = body.split("\n").find((line) => line.startsWith("| AZ-1 |"));
  assert.ok(row, "row missing");
  assert.doesNotMatch(row, /<script|\]\(https:\/\/evil|`code`/);
  assert.doesNotMatch(row, /@octocat/);
  assert.match(row, /@​octocat/);
  assert.match(row, /#​12/);
  // The pipe in the text is escaped: the row keeps its six cells.
  assert.equal(row.replace(/\\\|/g, "").split("|").length, 8);
});

test("a long list of drift rows shrinks before it is cut, and stays under GitHub's limit", () => {
  const pages = [];
  const guides = [];
  for (let i = 0; i < 1500; i++) {
    const code = `AZ-${String(100 + i)}`;
    pages.push(
      hubPage(code, {
        name: "Old name that is quite a bit longer than usual ".repeat(3),
      }),
    );
    guides.push(
      trackedGuide(code, {
        name: "New name that is also quite a bit longer than usual ".repeat(3),
      }),
    );
  }
  const items = drift(makeHub({ pages }), makeTracker({ guides }));
  assert.ok(items.length >= 1500, String(items.length));
  const { body, signature } = buildDriftReport({ items, today: DRIFT_TODAY });
  assert.ok(body.length <= 60000, String(body.length));
  assert.match(body, /shortened|cut at the size limit/);
  // Whatever happens, the marker survives: the next run needs it. Hundreds of
  // ids are too many to spell out, so the marker then holds a hash of them.
  const marker = parseDriftMarker(body);
  assert.equal(marker?.a, signature.a);
  assert.match(signature.a, /^h:[0-9a-f]{8}$/);
  assert.equal(marker.ids, null);

  // A realistic list keeps its ids, so a comment can name what changed.
  const some = parseDriftMarker(
    buildDriftReport({ items: items.slice(0, 5), today: DRIFT_TODAY }).body,
  );
  assert.equal(
    some.ids.length,
    items.slice(0, 5).filter((i) => i.severity !== "info").length,
  );
});

test("the comment on a changed list names what was added and what is no longer listed", () => {
  const items = sampleItems();
  const open = items.filter((item) => item.severity !== "info");
  const comment = buildDriftComment({
    items: open,
    previousIds: ["name:AZ-9:deadbeef", open[0].id],
    today: DRIFT_TODAY,
    runUrl: "https://github.com/mscerts/hub/actions/runs/1",
  });
  assert.match(
    comment,
    /The list changed on 2026-10-09: 1 added, 1 no longer listed, 2 open now\./,
  );
  assert.match(comment, /Added:\n- Beta status AZ-3:/);
  assert.match(comment, /No longer listed[^\n]*\n- Exam name AZ-9/);
  assert.match(
    comment,
    /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/1/,
  );
  assert.match(
    buildDriftComment({ items: open, previousIds: null, today: DRIFT_TODAY }),
    /rebuilt on 2026-10-09 \(the list of the old text could not be read\)/,
  );
});

test("the exam pages worth a look are those of the BETA and UPCOMING exams the hub has a page for", () => {
  const hub = makeHub({
    pages: ["AB-1", "AB-2", "GH-3", "AZ-4"].map((code) =>
      hubPage(code, { name: "X" }),
    ),
    statuses: {
      "GH-3": "UPCOMING",
      "AB-2": "BETA",
      "AB-1": "RETIRING",
      "AB-7": "BETA",
    },
  });
  assert.deepEqual(probeTargets(hub), ["AB-2", "GH-3"]);
  assert.deepEqual(probeTargets(hub, 1), ["AB-2"]);
});

test("the drift settings have sensible defaults and are all overridable", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.maxDrift, 25);
  assert.equal(cfg.forceDrift, false);
  assert.equal(cfg.driftCheck, true);
  assert.equal(cfg.createIssues, false);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.certRenameDays, 30);
  const set = loadConfig({
    MAX_DRIFT: "3",
    FORCE_DRIFT: "1",
    DRIFT_CHECK: "0",
    CREATE_ISSUES: "1",
    DRY_RUN: "1",
  });
  assert.equal(set.maxDrift, 3);
  assert.equal(set.forceDrift, true);
  assert.equal(set.driftCheck, false);
  assert.equal(set.createIssues, true);
  assert.equal(set.dryRun, true);
});

// --- the running issue, through an in-memory `gh` -------------------------------------
/** Behaves like the parts of `gh` the monitor uses; `calls` records every call. */
function memoryGh({ fail = [], today = DRIFT_TODAY } = {}) {
  const issues = [];
  const calls = [];
  let next = 1;
  const flag = (args, name) => {
    const at = args.indexOf(name);
    return at < 0 ? null : args[at + 1];
  };
  const pick = (issue, args) =>
    Object.fromEntries(
      (flag(args, "--json") ?? "number,title")
        .split(",")
        .map((field) => [field, issue[field]]),
    );
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push({ command, args, input });
    if (fail.includes(command)) throw new Error(`gh ${command} failed`);
    const find = () => issues.find((issue) => issue.number === Number(args[2]));
    // Like the real CLI: only the fields asked for, open issues unless --state says closed.
    if (command === "issue list") {
      return JSON.stringify(
        issues
          .filter(
            (issue) =>
              issue.state === (flag(args, "--state") ?? "open") &&
              issue.labels.includes(flag(args, "--label")),
          )
          .map((issue) => pick(issue, args)),
      );
    }
    if (command === "issue view") return JSON.stringify(pick(find(), args));
    if (command === "issue create") {
      const issue = {
        number: next++,
        title: flag(args, "--title"),
        labels: [flag(args, "--label")],
        body: input,
        state: "open",
        comments: [],
        args,
      };
      issues.push(issue);
      return `https://github.com/mscerts/hub/issues/${issue.number}`;
    }
    if (command === "issue comment") find().comments.push(input);
    if (command === "issue edit") find().body = input;
    if (command === "issue close") {
      const issue = find();
      issue.state = "closed";
      issue.closedAt = `${memory.today}T08:00:00Z`;
      issue.comments.push(flag(args, "--comment"));
    }
    return "";
  };
  const memory = {
    gh,
    issues,
    calls,
    // The day an issue counts as closed on; tests move it.
    today,
    writes: () =>
      calls.filter((c) => !["issue list", "issue view"].includes(c.command)),
  };
  return memory;
}

const enabledCfg = (extra = {}) => ({
  ...loadConfig({ TODAY: DRIFT_TODAY, CREATE_ISSUES: "1" }),
  ...extra,
});

function syncWith(memory, items, cfg = enabledCfg()) {
  return syncDriftIssue(cfg, memory.gh, {
    items,
    report: items.length ? buildDriftReport({ items, today: cfg.today }) : null,
  });
}

test("the drift issue is created once with the stable title and label and no assignee, then left alone while nothing changes", () => {
  const memory = memoryGh();
  const items = sampleItems();
  const created = syncWith(memory, items);
  assert.equal(created.action, "created");
  assert.equal(created.number, 1);
  assert.equal(memory.issues.length, 1);
  assert.equal(memory.issues[0].title, DRIFT_ISSUE_TITLE);
  assert.equal(DRIFT_ISSUE_TITLE, "Learn drift: hub pages need updating");
  assert.deepEqual(memory.issues[0].labels, ["enhancement"]);
  assert.ok(!memory.issues[0].args.includes("--assignee"));
  assert.match(memory.issues[0].body, /AZ-1/);

  // The same rows the next day: not even a write, only the list and the text
  // of the one issue (to read its marker).
  const before = memory.calls.length;
  const again = syncWith(memory, items, enabledCfg({ today: "2026-10-10" }));
  assert.equal(again.action, "unchanged");
  assert.deepEqual(
    memory.calls.slice(before).map((call) => call.command),
    ["issue list", "issue view"],
  );
  // An information row coming and going never touches the issue... but a wording change edits the text.
  const reworded = items.map((item) => ({
    ...item,
    summary: `${item.summary} (updated)`,
  }));
  const edited = syncWith(memory, reworded);
  assert.equal(edited.action, "edited");
  assert.equal(memory.issues[0].comments.length, 0);
  assert.match(memory.issues[0].body, /\(updated\)/);
});

test("when the set of rows changes the text is edited and a comment says what changed; when nothing is left the issue is closed with a comment", () => {
  const memory = memoryGh();
  const items = sampleItems();
  syncWith(memory, items);

  const fewer = items.filter((item) => item.kind !== "name");
  const commented = syncWith(memory, fewer);
  assert.equal(commented.action, "commented");
  assert.equal(memory.issues.length, 1, "never a second issue");
  assert.equal(memory.issues[0].comments.length, 1);
  assert.match(
    memory.issues[0].comments[0],
    /0 added, 1 no longer listed, 1 open now/,
  );
  assert.deepEqual(
    parseDriftMarker(memory.issues[0].body).ids,
    fewer.filter((i) => i.severity !== "info").map((i) => i.id),
  );

  // Only information rows left: nothing to fix or check, the issue closes.
  const info = items.filter((item) => item.severity === "info");
  const closed = syncWith(memory, info);
  assert.equal(closed.action, "closed");
  assert.equal(memory.issues[0].state, "closed");
  assert.match(
    memory.issues[0].comments.at(-1),
    /Nothing is left to fix or check as of 2026-10-09/,
  );
  // Nothing open and nothing to do: only a lookup.
  const before = memory.calls.length;
  assert.equal(syncWith(memory, []).action, "none");
  assert.deepEqual(
    memory.calls.slice(before).map((call) => call.command),
    ["issue list"],
  );
  // A relapse opens a new issue, even on the day the monitor closed the old
  // one: the monitor cleared the rows in the text of an issue it closes itself.
  assert.match(memory.issues[0].body, /a=- b=- h=closed/);
  assert.equal(syncWith(memory, items).action, "created");
  assert.equal(memory.issues.length, 2);
});

test("an issue a maintainer closed by hand is not recreated every day: held for the reminder days unless a row is new", () => {
  const memory = memoryGh();
  const items = sampleItems();
  syncWith(memory, items);
  // Closed in the GitHub UI: state only, the text keeps its rows.
  const closeByHand = (index, day) => {
    memory.issues[index].state = "closed";
    memory.issues[index].closedAt = `${day}T09:00:00Z`;
  };
  closeByHand(0, "2026-10-09");

  const held = syncWith(memory, items, enabledCfg({ today: "2026-10-10" }));
  assert.equal(held.action, "held");
  assert.equal(held.number, 1);
  assert.equal(memory.issues.length, 1, "no second issue");
  assert.deepEqual(
    memory.writes().map((call) => call.command),
    ["issue create"],
  );
  // Fewer rows than were in the closed issue: still nothing new.
  const fewer = items.filter((item) => item.kind !== "name");
  assert.equal(
    syncWith(memory, fewer, enabledCfg({ today: "2026-10-12" })).action,
    "held",
  );
  // A row that was not in the closed issue is news at once.
  const extra = {
    ...items.find((item) => item.kind === "name"),
    id: "name:AZ-9:deadbeef",
    code: "AZ-9",
  };
  assert.equal(
    syncWith(memory, [...items, extra], enabledCfg({ today: "2026-10-12" }))
      .action,
    "created",
  );
  assert.equal(memory.issues.length, 2);

  // Closed again by hand: after the reminder days the same rows come back.
  closeByHand(1, "2026-10-12");
  assert.equal(
    syncWith(memory, [...items, extra], enabledCfg({ today: "2026-10-18" }))
      .action,
    "held",
  );
  assert.equal(
    syncWith(memory, [...items, extra], enabledCfg({ today: "2026-10-19" }))
      .action,
    "created",
  );
  assert.equal(memory.issues.length, 3);

  // DRIFT_REMINDER_DAYS=0 switches the hold off.
  closeByHand(2, "2026-10-19");
  assert.equal(
    syncWith(
      memory,
      [...items, extra],
      enabledCfg({ today: "2026-10-19", driftReminderDays: 0 }),
    ).action,
    "created",
  );
});

test("only a closed issue with the drift title can hold a new one back", () => {
  const memory = memoryGh();
  const items = sampleItems();
  syncWith(memory, items);
  const text = memory.issues[0].body;
  // Another closed issue of the same label carries the very same text (a marker
  // with these rows) and was closed more recently: it is not the drift issue.
  memory.issues[0].title = "Something else entirely";
  memory.issues[0].state = "closed";
  memory.issues[0].closedAt = "2026-10-09T09:00:00Z";
  assert.match(text, /learn-drift:v1/);
  assert.equal(
    syncWith(memory, items, enabledCfg({ today: "2026-10-10" })).action,
    "created",
  );
});

test("a lookup of closed issues that fails costs an early issue, never a lost alert", () => {
  const memory = memoryGh();
  const items = sampleItems();
  syncWith(memory, items);
  memory.issues[0].state = "closed";
  memory.issues[0].closedAt = "2026-10-09T09:00:00Z";
  const failing = {
    ...memory,
    gh: (args, input) => {
      if (args[1] === "list" && args.includes("closed")) {
        throw new Error("gh issue list failed");
      }
      return memory.gh(args, input);
    },
  };
  assert.equal(
    syncWith(failing, items, enabledCfg({ today: "2026-10-10" })).action,
    "created",
  );
});

test("the issue listings ask for the number and the title only, and the text of one issue is read by its number", () => {
  const memory = memoryGh();
  const items = sampleItems();
  syncWith(memory, items);
  syncWith(memory, items, enabledCfg({ today: "2026-10-10" }));
  syncWith(memory, []);
  syncDriftFailureIssue(enabledCfg(), memory.gh, "boom");
  const lists = memory.calls.filter((call) => call.command === "issue list");
  assert.ok(lists.length >= 4);
  for (const call of lists) {
    const json = call.args[call.args.indexOf("--json") + 1];
    assert.match(json, /^number,title(,closedAt)?$/, json);
  }
  const views = memory.calls.filter((call) => call.command === "issue view");
  assert.ok(views.length >= 1);
  for (const call of views) {
    assert.match(call.args[2], /^\d+$/);
    assert.equal(call.args[call.args.indexOf("--json") + 1], "body");
  }
});

test("gh output of many megabytes does not overflow the child process buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "new-exam-gh-"));
  tempDirs.push(dir);
  const script = join(dir, "big-gh.mjs");
  // 4 MiB of output, four times what spawnSync allows by default.
  await writeFile(
    script,
    'process.stdout.write(JSON.stringify([{ number: 1, title: "x".repeat(4 * 1024 * 1024) }]));\n',
  );
  const gh = makeGh({ ghCliScript: script });
  const out = JSON.parse(gh(["issue", "list"]));
  assert.equal(out[0].title.length, 4 * 1024 * 1024);
});

test("an open issue with the same label and another title is never the drift issue: not edited, not commented on, not closed", () => {
  // The label `enhancement` is shared with the issues of new exams and study
  // guides; the title is what tells them apart.
  const memory = memoryGh();
  const foreign = (title, label = "enhancement") =>
    memory.gh(
      [
        "issue",
        "create",
        "--title",
        title,
        "--label",
        label,
        "--body-file",
        "-",
      ],
      "text of " + title,
    );
  foreign("New Microsoft Learn exam: AB-1 (beta)");
  foreign("Learn drift: hub pages need updating — old", "enhancement");
  foreign(DRIFT_ISSUE_TITLE, "bug");
  const items = sampleItems();

  assert.equal(syncWith(memory, items).action, "created");
  assert.equal(memory.issues.length, 4, "its own issue was created");
  assert.equal(memory.issues[3].title, DRIFT_ISSUE_TITLE);
  assert.deepEqual(
    memory.issues.slice(0, 3).map((issue) => [issue.body, issue.comments]),
    [
      ["text of New Microsoft Learn exam: AB-1 (beta)", []],
      ["text of Learn drift: hub pages need updating — old", []],
      ["text of Learn drift: hub pages need updating", []],
    ],
  );

  // A change of the rows edits and comments on its own issue only.
  const fewer = items.filter((item) => item.kind !== "name");
  assert.equal(syncWith(memory, fewer).action, "commented");
  assert.equal(memory.issues[3].comments.length, 1);
  assert.ok(
    memory.issues.slice(0, 3).every((issue) => issue.comments.length === 0),
  );

  // Nothing left: only its own issue is closed.
  assert.equal(syncWith(memory, []).action, "closed");
  assert.deepEqual(
    memory.issues.map((issue) => issue.state),
    ["open", "open", "open", "closed"],
  );

  // The "could not run" issue keeps to its title too.
  const other = memoryGh();
  other.gh(
    [
      "issue",
      "create",
      "--title",
      "Something else",
      "--label",
      "bug",
      "--body-file",
      "-",
    ],
    "x",
  );
  assert.equal(
    syncDriftFailureIssue(enabledCfg(), other.gh, "boom").action,
    "created",
  );
  assert.equal(other.issues[0].comments.length, 0);
  assert.equal(
    syncDriftFailureIssue(enabledCfg(), other.gh, null).action,
    "closed",
  );
  assert.equal(other.issues[0].state, "open");
});

test("several open copies are closed together, and only the oldest is kept up to date", () => {
  const memory = memoryGh();
  const items = sampleItems();
  for (let i = 0; i < 2; i++) {
    memory.gh(
      [
        "issue",
        "create",
        "--title",
        DRIFT_ISSUE_TITLE,
        "--label",
        "enhancement",
        "--body-file",
        "-",
      ],
      "old text",
    );
  }
  const updated = syncWith(memory, items);
  assert.equal(updated.number, 1);
  assert.equal(memory.issues[0].body.startsWith("## Learn drift"), true);
  assert.equal(memory.issues[1].body, "old text");
  const closed = syncWith(memory, []);
  assert.deepEqual(closed.closed, [1, 2]);
  assert.ok(memory.issues.every((issue) => issue.state === "closed"));
});

test("issues are never touched, not even read, unless they are enabled and it is not a dry run", () => {
  const items = sampleItems();
  for (const cfg of [
    enabledCfg({ createIssues: false }),
    enabledCfg({ dryRun: true }),
  ]) {
    const memory = memoryGh();
    assert.equal(syncWith(memory, items, cfg).action, "skipped");
    assert.equal(syncWith(memory, [], cfg).action, "none");
    assert.equal(memory.calls.length, 0);
    assert.equal(
      syncDriftFailureIssue(cfg, memory.gh, "boom").action,
      "skipped",
    );
    assert.equal(memory.calls.length, 0);
  }
});

test("a gh failure is an error when the issue is needed; a failed lookup or close comes back as a result, and the run counts every one of them", () => {
  const items = sampleItems();
  assert.throws(
    () => syncWith(memoryGh({ fail: ["issue list"] }), items),
    /issue list failed/,
  );
  assert.throws(
    () => syncWith(memoryGh({ fail: ["issue create"] }), items),
    /issue create failed/,
  );
  const seeded = memoryGh();
  syncWith(seeded, items);
  const closeFails = (memory, only = () => true) => ({
    ...memory,
    gh: (args, input) => {
      if (args[1] === "close" && only(args)) throw new Error("gh close failed");
      return memory.gh(args, input);
    },
  });
  const failing = closeFails(seeded);
  const result = syncWith(failing, []);
  assert.equal(result.action, "close-failed");
  assert.match(result.error, /close failed/);
  assert.equal(
    syncWith(memoryGh({ fail: ["issue list"] }), []).action,
    "lookup-failed",
  );

  // The run: nothing to fix, so nothing is created, but every gh problem is
  // recorded in syncErrors (an annotation, and drift_issue_failed=true).
  const hub = makeHub({ pages: [hubPage("AZ-1", { name: "X" })] });
  const run = (memory) =>
    runDriftCheck(enabledCfg(), { hub, tracker: makeTracker(), gh: memory.gh });
  assert.deepEqual(run(memoryGh()).syncErrors, []);
  const lookup = run(memoryGh({ fail: ["issue list"] }));
  assert.equal(lookup.issue.action, "lookup-failed");
  assert.deepEqual(lookup.syncErrors, [
    `the issue "${DRIFT_ISSUE_TITLE}" could not be kept up to date: gh issue list failed`,
    `the issue "${DRIFT_FAILED_ISSUE_TITLE}" could not be closed: gh issue list failed`,
  ]);
  const closing = run(failing);
  assert.equal(closing.issue.action, "close-failed");
  assert.deepEqual(closing.syncErrors, [
    `the issue "${DRIFT_ISSUE_TITLE}" could not be kept up to date: gh close failed`,
  ]);
  // One of two open copies closes, the other does not: a failure all the same.
  const twins = memoryGh();
  for (let i = 0; i < 2; i++) {
    twins.gh(
      [
        "issue",
        "create",
        "--title",
        DRIFT_ISSUE_TITLE,
        "--label",
        "enhancement",
      ],
      "old text",
    );
  }
  const partial = run(closeFails(twins, (args) => args[2] === "2"));
  assert.equal(partial.issue.action, "closed");
  assert.deepEqual(partial.issue.closed, [1]);
  assert.equal(partial.syncErrors.length, 1);
  assert.match(
    partial.syncErrors[0],
    /could not be kept up to date: gh close failed$/,
  );
  // The "could not run" issue that a healthy run closes: a failed close counts too.
  const stuck = memoryGh();
  syncDriftFailureIssue(enabledCfg(), stuck.gh, "boom");
  const stuckClose = run(closeFails(stuck));
  assert.deepEqual(stuckClose.syncErrors, [
    `the issue "${DRIFT_FAILED_ISSUE_TITLE}" could not be closed: gh close failed`,
  ]);
});

test("the 'could not run' issue: created, one comment per further failure, closed by a healthy run", () => {
  const memory = memoryGh();
  const cfg = enabledCfg();
  assert.equal(
    syncDriftFailureIssue(cfg, memory.gh, "hub files unreadable").action,
    "created",
  );
  assert.equal(memory.issues[0].title, DRIFT_FAILED_ISSUE_TITLE);
  assert.deepEqual(memory.issues[0].labels, ["bug"]);
  assert.match(memory.issues[0].body, /hub files unreadable/);
  assert.equal(
    syncDriftFailureIssue(cfg, memory.gh, "again").action,
    "commented",
  );
  assert.equal(memory.issues.length, 1);
  assert.match(memory.issues[0].comments[0], /again/);
  assert.equal(syncDriftFailureIssue(cfg, memory.gh, null).action, "closed");
  assert.equal(memory.issues[0].state, "closed");
  assert.equal(syncDriftFailureIssue(cfg, memory.gh, null).action, "none");
});

test("the failsafe: many new rows at once are a naming or markup change, not news", () => {
  const pages = [];
  const guides = [];
  for (let i = 0; i < 6; i++) {
    const code = `AZ-${900 + i}`;
    pages.push(hubPage(code, { name: "Old" }));
    guides.push(trackedGuide(code, { name: "New" }));
  }
  const hub = makeHub({ pages });
  const tracker = makeTracker({ guides });
  const memory = memoryGh();
  const cfg = enabledCfg({ maxDrift: 5 });

  const stopped = runDriftCheck(cfg, { hub, tracker, gh: memory.gh });
  assert.match(stopped.failure, /6 new drift items \(limit MAX_DRIFT 5\)/);
  assert.match(stopped.failure, /force_drift/);
  assert.equal(stopped.issue.action, "none");
  assert.equal(stopped.report, null);
  assert.equal(stopped.failureIssue.action, "created");
  assert.deepEqual(
    memory.issues.map((issue) => issue.title),
    [DRIFT_FAILED_ISSUE_TITLE],
  );

  // Forced: the full list is written and the failure issue closes.
  const forced = runDriftCheck(enabledCfg({ maxDrift: 5, forceDrift: true }), {
    hub,
    tracker,
    gh: memory.gh,
  });
  assert.equal(forced.failure, null);
  assert.equal(forced.issue.action, "created");
  assert.equal(
    memory.issues.find((issue) => issue.title === DRIFT_ISSUE_TITLE).state,
    "open",
  );
  assert.equal(
    memory.issues.find((issue) => issue.title === DRIFT_FAILED_ISSUE_TITLE)
      .state,
    "closed",
  );

  // The next normal run counts only rows the running issue does not list yet: quiet.
  const quiet = runDriftCheck(cfg, { hub, tracker, gh: memory.gh });
  assert.equal(quiet.failure, null);
  assert.equal(quiet.issue.action, "unchanged");
  // Six more at once, on top of the six: stopped again, the issue is left as it is.
  const more = [];
  const moreGuides = [];
  for (let i = 0; i < 6; i++) {
    const code = `AZ-${800 + i}`;
    more.push(hubPage(code, { name: "Old" }));
    moreGuides.push(trackedGuide(code, { name: "New" }));
  }
  const bigger = runDriftCheck(cfg, {
    hub: makeHub({ pages: [...pages, ...more] }),
    tracker: makeTracker({ guides: [...guides, ...moreGuides] }),
    gh: memory.gh,
  });
  assert.match(bigger.failure, /6 new drift items/);
  assert.equal(
    memory.issues.find((issue) => issue.title === DRIFT_ISSUE_TITLE).state,
    "open",
  );
});

test("the failsafe also remembers the rows of an issue a maintainer closed by hand, for as long as the hold lasts", () => {
  const rows = (from, count) => {
    const pages = [];
    const guides = [];
    for (let i = 0; i < count; i++) {
      const code = `AZ-${from + i}`;
      pages.push(hubPage(code, { name: "Old" }));
      guides.push(trackedGuide(code, { name: "New" }));
    }
    return { pages, guides };
  };
  const six = rows(900, 6);
  const hub = makeHub({ pages: six.pages });
  const tracker = makeTracker({ guides: six.guides });
  const cfg = (extra = {}) => enabledCfg({ maxDrift: 5, ...extra });
  const check = (memory, extra, world = { hub, tracker }) =>
    runDriftCheck(cfg(extra), { ...world, gh: memory.gh });
  const memory = memoryGh();

  // The maintainers accepted the 6 rows (FORCE_DRIFT) and later closed the
  // issue in the GitHub UI: only its state changed, its text keeps the rows.
  assert.equal(check(memory, { forceDrift: true }).issue.action, "created");
  memory.issues[0].state = "closed";
  memory.issues[0].closedAt = "2026-10-09T09:00:00Z";
  const writes = memory.writes().length;

  // While the hold lasts those rows are not new: no failure issue, no new drift issue.
  for (const today of ["2026-10-10", "2026-10-15"]) {
    const held = check(memory, { today });
    assert.equal(held.failure, null, today);
    assert.equal(held.issue.action, "held", today);
    assert.deepEqual(held.syncErrors, [], today);
  }
  assert.deepEqual(
    memory.issues.map((issue) => issue.title),
    [DRIFT_ISSUE_TITLE],
  );
  assert.equal(memory.writes().length, writes, "nothing was written");

  // Rows the closed issue does not list still count: 6 new ones next to the 6
  // old ones are 6 at once (over the limit of 5), not 12.
  const more = rows(800, 6);
  const bigger = check(
    memory,
    { today: "2026-10-11" },
    {
      hub: makeHub({ pages: [...six.pages, ...more.pages] }),
      tracker: makeTracker({ guides: [...six.guides, ...more.guides] }),
    },
  );
  assert.match(bigger.failure, /^6 new drift items \(limit MAX_DRIFT 5\)/);
  // A few new rows pass the failsafe, and are news: the issue is created again.
  const few = rows(700, 2);
  const news = check(
    memory,
    { today: "2026-10-11" },
    {
      hub: makeHub({ pages: [...six.pages, ...few.pages] }),
      tracker: makeTracker({ guides: [...six.guides, ...few.guides] }),
    },
  );
  assert.equal(news.failure, null);
  assert.equal(news.issue.action, "created");

  // The memory ends with the hold: after DRIFT_REMINDER_DAYS, or with the hold
  // switched off, every row counts again.
  for (const extra of [
    { today: "2026-10-16" },
    { today: "2026-10-10", driftReminderDays: 0 },
  ]) {
    const fresh = memoryGh();
    check(fresh, { forceDrift: true });
    fresh.issues[0].state = "closed";
    fresh.issues[0].closedAt = "2026-10-09T09:00:00Z";
    assert.match(
      check(fresh, extra).failure,
      /^6 new drift items \(limit MAX_DRIFT 5\)/,
      JSON.stringify(extra),
    );
  }

  // An issue the monitor closed itself (nothing was left) lists no rows.
  const own = memoryGh();
  check(own, { forceDrift: true });
  check(
    own,
    { today: "2026-10-10" },
    { hub: makeHub(), tracker: makeTracker() },
  );
  assert.equal(own.issues[0].state, "closed");
  assert.match(own.issues[0].body, /a=- b=- h=closed/);
  assert.match(
    check(own, { today: "2026-10-11" }).failure,
    /^6 new drift items \(limit MAX_DRIFT 5\)/,
  );
});

test("an unreadable hub or an error while comparing is reported as a failure of the check, and leaves the running issue alone", () => {
  const memory = memoryGh();
  const cfg = enabledCfg();
  syncWith(memory, sampleItems());
  const unreadable = runDriftCheck(cfg, {
    hub: null,
    inputError: "src/data_files/exam-status.mjs could not be loaded (gone)",
    tracker: makeTracker(),
    gh: memory.gh,
  });
  assert.match(
    unreadable.failure,
    /could not be read, so nothing was compared: src\/data_files\/exam-status\.mjs could not be loaded \(gone\)/,
  );
  assert.equal(unreadable.failureIssue.action, "created");
  assert.equal(
    memory.issues.find((issue) => issue.title === DRIFT_ISSUE_TITLE).state,
    "open",
  );

  const broken = runDriftCheck(cfg, {
    hub: {},
    tracker: makeTracker(),
    gh: memory.gh,
  });
  assert.match(broken.failure, /Unexpected error while comparing/);
});

// ---------------------------------------------------------------------------
// Hub vs Learn drift, end to end: fake Learn, hub files in the sandbox, a fake `gh`
// ---------------------------------------------------------------------------
const FAKE_GH = join(fixtureDir, "fake-gh.mjs");
const AZ = ["AZ-901", "AZ-902", "AZ-903", "AZ-904"];

/** Writes the hub files the drift check reads: exam pages, badges and the two trackers. */
async function writeHub(
  box,
  { pages = {}, statuses = {}, beta = [], retiring = [] } = {},
) {
  const byArea = {};
  for (const [code, text] of Object.entries(statuses)) {
    (byArea[areaForCode(code)] ??= {})[code] = { text, variant: "tip" };
  }
  await writeFile(
    join(box.dir, "exam-status.mjs"),
    `export const examStatuses = ${JSON.stringify(byArea)};\n`,
  );
  await writeFile(
    join(box.dir, "beta-exams.json"),
    JSON.stringify({ lastSynced: "2026-10-01", exams: beta }),
  );
  await writeFile(
    join(box.dir, "retiring-exams.json"),
    JSON.stringify({ lastSynced: "2026-10-01", exams: retiring }),
  );
  for (const [code, page] of Object.entries(pages)) {
    const area = areaForCode(code);
    await mkdir(join(box.docs, area), { recursive: true });
    const description =
      page.description ??
      `Collection of study materials for the certification exam ${code}: ${page.name}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`;
    await writeFile(
      join(box.docs, area, `${code}.mdx`),
      `---\ntitle: ${code} Study Materials\ndescription: ${JSON.stringify(description)}\n---\n${page.text ?? ""}`,
    );
  }
}

/** Hub pages whose names agree with the fake Learn ("Azure Role n"), unless overridden. */
const agreeing = (overrides = {}) => ({
  ...Object.fromEntries(
    AZ.map((code, i) => [code, { name: `Azure Role ${i + 1}` }]),
  ),
  ...overrides,
});

/** A fake Learn with a guide for each of AZ-901..904 (named like their certification) and a hub that agrees with it. */
async function driftWorld({ pages, guides = {}, ...hub } = {}) {
  const world = baseWorld();
  AZ.forEach((code, i) => {
    world.guides[code] = guideSpec({
      name: `Azure Role ${i + 1}`,
      ...(guides[code] ?? {}),
    });
  });
  const learn = await startLearn(world);
  const box = await sandbox();
  await writeHub(box, { pages: pages ?? agreeing(), ...hub });
  return { world, learn, box };
}

const driftEnv = (box, extra = {}) => ({
  DRIFT_CHECK: "1",
  EXAM_STATUS_FILE: join(box.dir, "exam-status.mjs"),
  BETA_EXAMS_FILE: join(box.dir, "beta-exams.json"),
  RETIRING_EXAMS_FILE: join(box.dir, "retiring-exams.json"),
  DRIFT_REPORT_FILE: join(box.dir, "drift-report.md"),
  DRIFT_ERROR_FILE: join(box.dir, "drift-error.md"),
  CREATE_ISSUES: "1",
  GH_CLI_SCRIPT: FAKE_GH,
  FAKE_GH_STATE: join(box.dir, "gh-state.json"),
  FAKE_GH_LOG: join(box.dir, "gh-log.jsonl"),
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "mscerts/hub",
  GITHUB_RUN_ID: "42",
  ...extra,
});

const runDrift = (box, learn, extra = {}) =>
  runMonitor(box, learn, {
    // The fake gh stamps a closed issue with the day of the run.
    FAKE_GH_TODAY: extra.TODAY ?? "2026-10-09",
    ...driftEnv(box, extra),
  });

const ghIssues = async (box) =>
  (await exists(join(box.dir, "gh-state.json")))
    ? JSON.parse(await readFile(join(box.dir, "gh-state.json"), "utf8")).issues
    : [];
const ghCalls = async (box) =>
  (await exists(join(box.dir, "gh-log.jsonl")))
    ? (await readFile(join(box.dir, "gh-log.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const ghWrites = async (box) =>
  (await ghCalls(box))
    .map((call) => call.command)
    .filter((command) => !["issue list", "issue view"].includes(command));
/** The drift issue(s) of the fake repo, open or not. */
const driftIssues = async (box) =>
  (await ghIssues(box)).filter((issue) => issue.title === DRIFT_ISSUE_TITLE);
const openDrift = async (box) =>
  (await driftIssues(box)).filter((issue) => issue.state === "open");

test("drift end to end: the first run reports the problems that exist, an unchanged day touches nothing, a fixed hub closes the issue", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    // The baseline is silent for new exams, not for drift.
    assert.deepEqual(first.outputs, {
      changes_found: "false",
      baseline_updated: "true",
      extraction_failed: "false",
      guide_check_failed: "false",
      drift_check_failed: "false",
      drift_issue_failed: "false",
      drift_items: "1",
      study_guides_changed: "0",
      issue_title: "",
    });
    assert.equal(await exists(box.report), false);
    const issues = await driftIssues(box);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, "open");
    assert.deepEqual(issues[0].labels, ["enhancement"]);
    assert.match(issues[0].body, /\| AZ-901 \| Exam name \|/);
    assert.match(issues[0].body, /Learn: "Azure Role 1"/);
    assert.match(issues[0].body, /frontmatter description: "Old Name"/);
    assert.match(issues[0].body, /src\/content\/docs\/azure\/AZ-901\.mdx/);
    assert.equal(
      await readFile(join(box.dir, "drift-report.md"), "utf8"),
      issues[0].body,
    );
    assert.deepEqual(await ghWrites(box), ["issue create"]);
    for (const call of await ghCalls(box)) {
      assert.ok(!call.args.includes("--assignee"), call.command);
    }
    // The guide name is stored for the next comparison; it costs no request.
    const tracker = await readTracker(box);
    assert.equal(guideOf(tracker, "AZ-901").name, "Azure Role 1");
    assert.deepEqual(tracker.certRenames, []);
    assert.doesNotMatch(first.stdout, /Drift: 0/);
    assert.match(
      first.stdout,
      /Drift: 1 to fix, 0 to check, 0 for information\./,
    );

    // Same state, the next day: no write to the issue, no write to the tracker.
    const before = await readFile(box.tracker);
    const again = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.outputs.drift_items, "1");
    assert.equal(again.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.deepEqual(await ghWrites(box), ["issue create"]);

    // The hub is fixed: the issue closes itself with a comment.
    await writeHub(box, { pages: agreeing() });
    const fixed = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(fixed.outputs.drift_items, "0");
    assert.equal(await exists(join(box.dir, "drift-report.md")), false);
    // The monitor clears the rows in the text of an issue it closes itself.
    assert.deepEqual(await ghWrites(box), [
      "issue create",
      "issue edit",
      "issue close",
    ]);
    const [closed] = await driftIssues(box);
    assert.equal(closed.state, "closed");
    assert.match(
      closed.comments.at(-1),
      /Nothing is left to fix or check as of 2026-10-11/,
    );
    assert.match(
      closed.comments.at(-1),
      /Run: https:\/\/github\.com\/mscerts\/hub\/actions\/runs\/42/,
    );

    // A later difference opens a new issue, never reopens a stale thread.
    await writeHub(box, {
      pages: agreeing({ "AZ-902": { name: "Other Name" } }),
    });
    await runDrift(box, learn, { TODAY: "2026-10-12" });
    assert.equal((await driftIssues(box)).length, 2);
    assert.equal((await openDrift(box)).length, 1);
  } finally {
    await learn.close();
  }
});

test("drift end to end: a changed set of rows edits the issue and adds one comment, a changed wording only edits it", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    await runDrift(box, learn);
    await writeHub(box, {
      pages: agreeing({
        "AZ-901": { name: "Old Name" },
        "AZ-902": { name: "Stale" },
      }),
    });
    const second = await runDrift(box, learn);
    assert.equal(second.outputs.drift_items, "2");
    assert.deepEqual(await ghWrites(box), [
      "issue create",
      "issue edit",
      "issue comment",
    ]);
    const [issue] = await openDrift(box);
    assert.equal((await driftIssues(box)).length, 1, "never a second issue");
    assert.match(issue.body, /\| AZ-902 \| Exam name \|/);
    assert.equal(issue.comments.length, 1);
    assert.match(issue.comments[0], /1 added, 0 no longer listed, 2 open now/);
    assert.match(issue.comments[0], /Exam name AZ-902/);

    // One row fixed: the comment names what is no longer listed.
    await writeHub(box, { pages: agreeing({ "AZ-902": { name: "Stale" } }) });
    await runDrift(box, learn);
    const [after] = await openDrift(box);
    assert.equal(after.comments.length, 2);
    assert.match(after.comments[1], /0 added, 1 no longer listed, 1 open now/);
    assert.match(
      after.comments[1],
      /No longer listed[^\n]*\n- Exam name AZ-901/,
    );
    assert.doesNotMatch(after.body, /\| AZ-901 \|/);
  } finally {
    await learn.close();
  }
});

test("drift end to end: a retirement notice is a row until the badge, the tracker entry and the banner agree with it", async () => {
  const notice =
    "This exam will retire on November 30, 2026, at 11:59 PM Central Standard Time. Learn more.";
  const { world, learn, box } = await driftWorld({
    guides: { "AZ-902": { notices: { pre: notice } } },
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.outputs.drift_items, "1");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| AZ-902 \| Retirement or transition notice \|/);
    assert.match(issue.body, /retirement on November 30, 2026/);
    assert.match(issue.body, /retirementDate 2026-11-30/);
    assert.match(issue.body, /`src\/data_files\/retiring-exams\.json`/);

    // Tracked correctly (badge and entry): nothing left, whatever the banner says.
    await writeHub(box, {
      pages: agreeing(),
      statuses: { "AZ-902": "RETIRING" },
      retiring: [
        { code: "AZ-902", retirementDate: "2026-11-30", notified: false },
      ],
    });
    const fixed = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(fixed.outputs.drift_items, "0");
    assert.equal((await openDrift(box)).length, 0);

    // Microsoft moves the date: the guide changes (a study guide report) and the
    // tracker now has the wrong date, which is a row to fix.
    Object.assign(world.guides["AZ-902"], {
      notices: { pre: notice.replace("November 30", "December 31") },
      lastmod: "2026-10-10",
      updatedAt: "2026-10-10T08:00:00Z",
    });
    const moved = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(moved.outputs.changes_found, "true");
    assert.equal(moved.outputs.study_guides_changed, "1");
    assert.equal(moved.outputs.drift_items, "1");
    const [again] = await openDrift(box);
    assert.match(
      again.body,
      /change retirementDate of AZ-902 in src\/data_files\/retiring-exams\.json from 2026-11-30 to 2026-12-31/,
    );
    assert.doesNotMatch(again.body, /add \{ text: "RETIRING"/);
  } finally {
    await learn.close();
  }
});

test("drift end to end: an exam still RETIRING after its date is a row until the badge says RETIRED, and RETIRED before the date is ahead of it", async () => {
  const notice =
    "This exam was retired on September 30, 2026, at 5:00 PM Central Standard Time. Learn more.";
  const tracked = (date) => [
    { code: "AZ-902", retirementDate: date, notified: true },
  ];
  const { learn, box } = await driftWorld({
    guides: { "AZ-902": { notices: { pre: notice } } },
    statuses: { "AZ-902": "RETIRING" },
    retiring: tracked("2026-09-30"),
  });
  try {
    const first = await runDrift(box, learn, { TODAY: "2026-10-14" });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.drift_items, "1");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| AZ-902 \| Retirement badge \|/);
    assert.match(
      issue.body,
      /still shows AZ-902 as RETIRING, but its retirement date has passed/,
    );
    assert.match(issue.body, /Switch the badge to RETIRED/);

    // The badge is switched (the tracker entry stays as history): nothing is left.
    await writeHub(box, {
      pages: agreeing(),
      statuses: { "AZ-902": "RETIRED" },
      retiring: tracked("2026-09-30"),
    });
    const fixed = await runDrift(box, learn, { TODAY: "2026-10-15" });
    assert.equal(fixed.outputs.drift_items, "0");
    assert.equal((await openDrift(box)).length, 0);

    // A RETIRED badge while the tracker says the exam retires later: ahead of the date.
    await writeHub(box, {
      pages: agreeing(),
      statuses: { "AZ-902": "RETIRED" },
      retiring: tracked("2026-12-31"),
    });
    const ahead = await runDrift(box, learn, { TODAY: "2026-10-16" });
    assert.equal(ahead.outputs.drift_items, "2");
    const [again] = await openDrift(box);
    assert.match(again.body, /\| AZ-902 \| Retirement badge \|/);
    assert.match(again.body, /RETIRED badge of AZ-902 is ahead of the date/);
    // the notice row asks for the date, and never for a RETIRING badge to be added
    assert.match(again.body, /Retirement or transition notice/);
    assert.doesNotMatch(again.body, /add \{ text: "RETIRING"/);
  } finally {
    await learn.close();
  }
});

test("drift end to end: a beta exam on Learn that the hub does not know, and one that left beta", async () => {
  const { world, learn, box } = await driftWorld();
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.outputs.drift_items, "0");
    assert.equal((await driftIssues(box)).length, 0);

    // The exam card of AZ-901 now says "(beta)".
    world.certs[0].exams[0].beta = true;
    const beta = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(beta.outputs.drift_items, "1");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| AZ-901 \| Beta status \|/);
    assert.match(
      issue.body,
      /exam card on the certification page is marked "\(beta\)"/,
    );
    assert.match(issue.body, /never from this issue/);

    // The hub marks it BETA (badge and tracker): the row goes.
    await writeHub(box, {
      pages: agreeing(),
      statuses: { "AZ-901": "BETA" },
      beta: [{ code: "AZ-901", flaggedGA: false }],
    });
    const marked = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(marked.outputs.drift_items, "0");
    assert.equal((await openDrift(box)).length, 0);

    // Learn drops the marker while the hub still says BETA.
    world.certs[0].exams[0].beta = false;
    const ended = await runDrift(box, learn, { TODAY: "2026-10-12" });
    assert.equal(ended.outputs.drift_items, "1");
    const [again] = await openDrift(box);
    assert.match(again.body, /Learn no longer marks it beta/);
  } finally {
    await learn.close();
  }
});

test("drift end to end: an UPCOMING exam is noticed the day Learn shows it, and a 404 exam page proves nothing", async () => {
  const placeholder = {
    description:
      "GH-799: Something New is an upcoming exam, not yet on Microsoft Learn.",
  };
  const { world, learn, box } = await driftWorld({
    pages: agreeing({ "GH-799": placeholder }),
    statuses: { "GH-799": "UPCOMING" },
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.drift_items, "0");
    assert.equal((await driftIssues(box)).length, 0);
    // The monitor looked for the exam page of the UPCOMING exam, politely, once.
    assert.equal(
      world.requests.filter(
        (path) => path === "/credentials/certifications/exams/gh-799/",
      ).length,
      1,
    );

    // The study guide appears in the sitemap.
    world.guides["GH-799"] = guideSpec({
      name: "Agentic AI for Business Professionals",
    });
    const second = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.outputs.drift_items, "1");
    // The hub has a page for the exam, so the exam itself is not a new-exam alert.
    assert.equal(second.outputs.changes_found, "false");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| GH-799 \| Upcoming exam \|/);
    assert.match(
      issue.body,
      /now on Microsoft Learn: study guide in the sitemap/,
    );

    // The exam page is up and calls it a beta; the maintainer marks it BETA: the issue closes.
    world.examPages["GH-799"] = {
      name: "Agentic AI for Business Professionals",
      beta: true,
    };
    await writeHub(box, {
      pages: agreeing({ "GH-799": placeholder }),
      statuses: { "GH-799": "BETA" },
      beta: [{ code: "GH-799", flaggedGA: false }],
    });
    const done = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(done.outputs.drift_items, "0");
    assert.equal((await openDrift(box)).length, 0);
    const tracker = await readTracker(box);
    const record = tracker.exams.find((exam) => exam.code === "GH-799");
    assert.deepEqual(record.betaEvidence, ["exam-page:beta"]);
    assert.match(record.url, /exams\/gh-799/);
  } finally {
    await learn.close();
  }
});

test("drift end to end: an UPCOMING exam whose study guide page is live before the sitemap lists it is noticed from the page", async () => {
  const placeholder = {
    description:
      "GH-799: Something New is an upcoming exam, not yet on Microsoft Learn.",
  };
  const { world, learn, box } = await driftWorld({
    pages: agreeing({ "GH-799": placeholder }),
    statuses: { "GH-799": "UPCOMING" },
  });
  const guidePath = "/credentials/certifications/resources/study-guides/gh-799";
  const asked = () =>
    world.requests.filter((path) => path === guidePath).length;
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.drift_items, "0");
    // One polite request for the page of the UPCOMING exam: the sitemap lists none.
    assert.equal(asked(), 1);
    assert.equal((await driftIssues(box)).length, 0);

    // The page is live, the sitemap still does not list it (GH-700 on 2026-10-14).
    world.studyGuides["GH-799"] = "Agentic AI for Business Professionals";
    const second = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.outputs.drift_items, "1");
    // The hub has a page for the exam, so the exam itself is no new-exam alert.
    assert.equal(second.outputs.changes_found, "false");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| GH-799 \| Upcoming exam \|/);
    assert.match(
      issue.body,
      /now on Microsoft Learn: study guide page \(the sitemap does not list it yet\)/,
    );
    assert.match(
      issue.body,
      /\[Study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/gh-799/,
    );
    const record = (await readTracker(box)).exams.find(
      (exam) => exam.code === "GH-799",
    );
    assert.equal(record.name, "Agentic AI for Business Professionals");
    assert.equal(record.url, "");

    // The page answering 503 one day proves nothing: the row stays, the run warns.
    world.studyGuideHook = (_request, response) => {
      response.statusCode = 503;
      response.end("busy");
      return true;
    };
    const third = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stderr, /could not probe the study guide of GH-799/);
    assert.equal(third.outputs.drift_items, "1");
    assert.equal((await openDrift(box)).length, 1);
    assert.equal((await openDrift(box))[0].comments.length, 0);

    // Once the sitemap lists the guide the probe is not made any more.
    world.studyGuideHook = null;
    world.guides["GH-799"] = guideSpec({
      name: "Agentic AI for Business Professionals",
    });
    const before = asked();
    await runDrift(box, learn, { TODAY: "2026-10-12" });
    assert.equal(asked(), before, "no probe for a guide the sitemap lists");
  } finally {
    await learn.close();
  }
});

test("drift end to end: an UPCOMING exam that Learn names only in the callout of a beta certification page is noticed", async () => {
  const placeholder = {
    description:
      "GH-799: Something New is an upcoming exam, not yet on Microsoft Learn.",
  };
  const world = baseWorld();
  AZ.forEach((code, i) => {
    world.guides[code] = guideSpec({ name: `Azure Role ${i + 1}` });
  });
  // No scheduling link, learn_exam meta or exam card: only a callout and the
  // beta marker in the title, like the GH-700 certification on 2026-10-14.
  world.certs.push(
    cert("agentic-ai", [exam("GH-799", "Something New", true)], {
      layout: "none",
      beta: true,
      title: "GitHub Certified: Agentic AI",
      announcement: "https://aka.ms/GH799CertificationBetaBlog",
    }),
  );
  const learn = await startLearn(world);
  const box = await sandbox();
  await writeHub(box, {
    pages: agreeing({ "GH-799": placeholder }),
    statuses: { "GH-799": "UPCOMING" },
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    // The baseline is silent for new exams; the drift row is not.
    assert.equal(first.outputs.changes_found, "false");
    assert.equal(first.outputs.drift_items, "1");
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| GH-799 \| Upcoming exam \|/);
    assert.match(
      issue.body,
      /certification page \(GitHub Certified: Agentic AI\)/,
    );
    assert.match(issue.body, /Learn marks it as a beta exam/);
    const record = (await readTracker(box)).exams.find(
      (exam) => exam.code === "GH-799",
    );
    assert.deepEqual(
      record.certifications.map((c) => c.slug),
      ["agentic-ai"],
    );
    assert.deepEqual(record.betaEvidence, [
      "callout:beta",
      "certification-title:beta",
    ]);
    assert.deepEqual(record.announcements, [
      "https://aka.ms/GH799CertificationBetaBlog",
    ]);
  } finally {
    await learn.close();
  }
});

test("drift end to end: a certification renamed on Learn is a row with old -> new while the hub page still shows the old name", async () => {
  const oldName = "Microsoft Certified: Azure Cosmos DB Developer Specialty";
  const newName = "Microsoft Certified: Azure Cosmos DB AI Developer Associate";
  const world = baseWorld();
  world.certs[0].title = oldName;
  AZ.forEach((code, i) => {
    world.guides[code] = guideSpec({ name: `Azure Role ${i + 1}` });
  });
  const learn = await startLearn(world);
  const box = await sandbox();
  await writeHub(box, {
    pages: agreeing({
      "AZ-901": { name: "Azure Role 1", text: `Earns ${oldName}.\n` },
    }),
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.outputs.drift_items, "0");
    assert.deepEqual((await readTracker(box)).certRenames, []);

    world.certs[0].title = newName;
    const renamed = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.equal(renamed.outputs.drift_items, "1");
    assert.deepEqual((await readTracker(box)).certRenames, [
      {
        slug: "azure-role-1",
        from: oldName,
        to: newName,
        firstSeen: "2026-10-10",
      },
    ]);
    const [issue] = await openDrift(box);
    assert.match(issue.body, /\| AZ-901 \| Certification \|/);
    assert.match(
      issue.body,
      /renamed the certification "Microsoft Certified: Azure Cosmos DB Developer Specialty" to "Microsoft Certified: Azure Cosmos DB AI Developer Associate"/,
    );

    // The page now shows the new name: the row goes; the event stays in the tracker for a while.
    await writeHub(box, {
      pages: agreeing({
        "AZ-901": { name: "Azure Role 1", text: `Earns ${newName}.\n` },
      }),
    });
    const fixed = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.equal(fixed.outputs.drift_items, "0");
    assert.equal((await readTracker(box)).certRenames.length, 1);
    const later = await runDrift(box, learn, { TODAY: "2026-12-01" });
    assert.equal(later.outputs.drift_items, "0");
    assert.deepEqual((await readTracker(box)).certRenames, []);
  } finally {
    await learn.close();
  }
});

test("drift end to end: more new rows than MAX_DRIFT is a naming change, not news: its own issue, the exam check goes on, FORCE_DRIFT accepts the list", async () => {
  const { world, learn, box } = await driftWorld({
    pages: agreeing({
      "AZ-901": { name: "Old 1" },
      "AZ-902": { name: "Old 2" },
      "AZ-903": { name: "Old 3" },
    }),
  });
  try {
    const summary = join(box.dir, "summary.md");
    const stopped = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      GITHUB_STEP_SUMMARY: summary,
    });
    // The job summary carries the reason too, next to the other checks.
    assert.match(
      await readFile(summary, "utf8"),
      /### New Exam Monitor: hub vs Learn drift\n\n- \*\*The drift check did not run:\*\* 3 new drift items/,
    );
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.outputs.drift_check_failed, "true");
    assert.equal(stopped.outputs.extraction_failed, "false");
    assert.equal(stopped.outputs.drift_items, "0");
    assert.equal(stopped.outputs.baseline_updated, "true");
    assert.match(stopped.stderr, /The drift check did not run/);
    assert.match(
      await readFile(join(box.dir, "drift-error.md"), "utf8"),
      /3 new drift items \(limit MAX_DRIFT 2\)/,
    );
    assert.equal((await driftIssues(box)).length, 0);
    const [failure] = await ghIssues(box);
    assert.equal(failure.title, DRIFT_FAILED_ISSUE_TITLE);
    assert.deepEqual(failure.labels, ["bug"]);
    assert.match(failure.body, /force_drift/);

    // Once more: one comment on the same issue, not a second issue.
    await runDrift(box, learn, { MAX_DRIFT: "2", TODAY: "2026-10-10" });
    assert.equal((await ghIssues(box)).length, 1);
    assert.equal((await ghIssues(box))[0].comments.length, 1);

    // A new exam still reaches the exam issue while the drift check is stopped.
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const alsoNew = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      TODAY: "2026-10-11",
    });
    assert.equal(alsoNew.outputs.changes_found, "true");
    assert.equal(alsoNew.outputs.drift_check_failed, "true");

    // Forced: the full list, and the failure issue closes.
    const forced = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      FORCE_DRIFT: "1",
      TODAY: "2026-10-12",
    });
    assert.equal(forced.outputs.drift_check_failed, "false");
    assert.equal(forced.outputs.drift_items, "3");
    assert.equal((await openDrift(box)).length, 1);
    assert.equal(
      (await ghIssues(box)).find((i) => i.title === DRIFT_FAILED_ISSUE_TITLE)
        .state,
      "closed",
    );
    assert.equal(await exists(join(box.dir, "drift-error.md")), false);

    // The next normal run only counts rows that are not in the issue yet.
    const quiet = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      TODAY: "2026-10-13",
    });
    assert.equal(quiet.outputs.drift_check_failed, "false");
    assert.equal(quiet.outputs.drift_items, "3");
    assert.equal((await openDrift(box)).length, 1);
  } finally {
    await learn.close();
  }
});

test("drift end to end: unreadable hub files stop only the drift check, with an issue that closes itself when they are back", async () => {
  const { world, learn, box } = await driftWorld();
  try {
    await runDrift(box, learn);
    world.certs.push(cert("azure-new-thing", [exam("AZ-950", "")]));
    world.studyGuides["AZ-950"] = "Designing New Things";
    const broken = await runDrift(box, learn, {
      TODAY: "2026-10-10",
      EXAM_STATUS_FILE: join(box.dir, "gone.mjs"),
    });
    assert.equal(broken.code, 0, broken.stderr);
    assert.equal(broken.outputs.drift_check_failed, "true");
    assert.equal(broken.outputs.extraction_failed, "false");
    // The exam check did its work.
    assert.equal(broken.outputs.changes_found, "true");
    assert.match(broken.outputs.issue_title, /AZ-950/);
    assert.match(
      await readFile(join(box.dir, "drift-error.md"), "utf8"),
      /The hub files could not be read, so nothing was compared: src\/data_files\/exam-status\.mjs could not be loaded/,
    );
    const failure = (await ghIssues(box)).find(
      (i) => i.title === DRIFT_FAILED_ISSUE_TITLE,
    );
    assert.equal(failure.state, "open");

    for (const [name, content] of [
      ["beta-exams.json", "{ not json"],
      ["retiring-exams.json", '{"exams": "nope"}'],
    ]) {
      const file = join(box.dir, name);
      const saved = await readFile(file);
      await writeFile(file, content);
      const result = await runDrift(box, learn, { TODAY: "2026-10-10" });
      assert.equal(result.outputs.drift_check_failed, "true", name);
      assert.match(
        await readFile(join(box.dir, "drift-error.md"), "utf8"),
        new RegExp(name.replace(".", "\\.")),
      );
      await writeFile(file, saved);
    }

    const healthy = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(healthy.outputs.drift_check_failed, "false");
    assert.equal(
      (await ghIssues(box)).find((i) => i.title === DRIFT_FAILED_ISSUE_TITLE)
        .state,
      "closed",
    );
  } finally {
    await learn.close();
  }
});

test("drift end to end: nothing touches an issue without CREATE_ISSUES, and nothing at all in a dry run", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    for (const extra of [{ CREATE_ISSUES: "" }, { DRY_RUN: "1" }]) {
      const result = await runDrift(box, learn, extra);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.drift_items, "1");
      assert.match(result.stdout, /Drift: 1 to fix/);
      // The text is written for a human to read, but no `gh` call is made.
      assert.match(
        await readFile(join(box.dir, "drift-report.md"), "utf8"),
        /AZ-901/,
      );
      assert.equal(await exists(join(box.dir, "gh-log.jsonl")), false);
    }
    // The difference is still reported once it is switched on.
    const live = await runDrift(box, learn);
    assert.deepEqual(await ghWrites(box), ["issue create"]);
    assert.equal(live.outputs.drift_items, "1");
  } finally {
    await learn.close();
  }
});

test("drift end to end: a study guide that cannot be fetched keeps its stored facts, so a failed fetch neither raises nor clears a row", async () => {
  const { world, learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    await runDrift(box, learn);
    assert.equal((await openDrift(box)).length, 1);
    // Learn's guide page is down for AZ-901 (and for AZ-902, whose hub name is right).
    for (const code of ["AZ-901", "AZ-902"]) {
      world.guideHooks.set(code, (_request, response) => {
        response.statusCode = 500;
        response.end("down");
        return true;
      });
    }
    const down = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.outputs.drift_items, "1");
    assert.match(down.stderr, /could not read the study guide of AZ-901/);
    assert.deepEqual(await ghWrites(box), ["issue create"]);
    assert.equal((await openDrift(box)).length, 1);
    const tracker = await readTracker(box);
    assert.equal(guideOf(tracker, "AZ-901").name, "Azure Role 1");
    assert.equal(guideOf(tracker, "AZ-902").name, "Azure Role 2");
  } finally {
    await learn.close();
  }
});

test("drift end to end: when gh fails the run still writes its outputs and the tracker, flags the failure, and the next run does the drift work again", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    const failed = await runDrift(box, learn, { FAKE_GH_FAIL: "issue create" });
    // The check itself worked: no extraction failure, no failed exit.
    assert.equal(failed.code, 0, failed.stderr);
    assert.equal(failed.outputs.extraction_failed, "false");
    assert.equal(failed.outputs.drift_issue_failed, "true");
    assert.equal(failed.outputs.drift_check_failed, "false");
    assert.equal(failed.outputs.baseline_updated, "true");
    assert.equal(failed.outputs.drift_items, "1");
    assert.equal(await exists(box.error), false);
    assert.ok(await exists(box.tracker), "the tracker was written");
    assert.match(
      failed.stderr,
      /the issue "Learn drift: hub pages need updating" could not be kept up to date: gh issue create failed/,
    );
    assert.equal((await driftIssues(box)).length, 0);

    // The drift is derived from the hub and the tracker, so nothing was lost.
    const retry = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(retry.outputs.drift_issue_failed, "false");
    assert.equal((await openDrift(box)).length, 1);
  } finally {
    await learn.close();
  }
});

test("drift end to end: a gh failure never holds back the new exam alert or the tracker of the same run", async () => {
  const { world, learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.outputs.drift_issue_failed, "false");

    // A new exam appears while the GitHub CLI is down, whatever it is asked.
    world.certs.push(cert("azure-new", [exam("AZ-999", "Azure New")]));
    const down = await runDrift(box, learn, {
      TODAY: "2026-10-10",
      FAKE_GH_FAIL: "issue list",
    });
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.outputs.extraction_failed, "false");
    assert.equal(down.outputs.drift_issue_failed, "true");
    // The primary alert and the tracker commit of this run go ahead.
    assert.equal(down.outputs.changes_found, "true");
    assert.equal(down.outputs.baseline_updated, "true");
    assert.match(down.outputs.issue_title, /AZ-999/);
    assert.match(await readFile(box.report, "utf8"), /AZ-999/);
    assert.ok(
      (await readTracker(box)).exams.some((exam) => exam.code === "AZ-999"),
    );
  } finally {
    await learn.close();
  }
});

test("drift end to end: a gh lookup that fails while there is nothing to fix is annotated and flagged like any other gh failure", async () => {
  // The hub agrees with Learn: no row, so nothing is created, edited or closed.
  const { learn, box } = await driftWorld();
  try {
    const down = await runDrift(box, learn, {
      FAKE_GH_FAIL: "issue list",
      GITHUB_ACTIONS: "true",
    });
    // The checks themselves worked and their results are written ...
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.outputs.extraction_failed, "false");
    assert.equal(down.outputs.drift_check_failed, "false");
    assert.equal(down.outputs.drift_items, "0");
    assert.equal(down.outputs.baseline_updated, "true");
    // ... but the issues could not be looked up: annotated, and the last step of the workflow turns the run red.
    assert.equal(down.outputs.drift_issue_failed, "true");
    assert.match(
      down.stdout,
      /::warning title=New Exam Monitor::the issue "Learn drift: hub pages need updating" could not be kept up to date: gh issue list failed/,
    );
    assert.match(
      down.stderr,
      /WARNING: the issue "Learn drift: the check could not run" could not be closed: gh issue list failed/,
    );
    assert.deepEqual(await ghWrites(box), []);

    const back = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(back.outputs.drift_issue_failed, "false");
  } finally {
    await learn.close();
  }
});

test("drift end to end: an exam page probe that fails leaves the beta evidence, the tracker and the issues as they were", async () => {
  // AZ-902 has a classic certification page: it says nothing about beta, so the
  // exam page title is the only marker the BETA badge has.
  const { world, learn, box } = await driftWorld({
    statuses: { "AZ-902": "BETA" },
    beta: [{ code: "AZ-902", flaggedGA: false }],
  });
  world.examPages["AZ-902"] = { name: "Azure Role 2", beta: true };
  const evidence = async () =>
    (await readTracker(box)).exams.find((entry) => entry.code === "AZ-902")
      .betaEvidence;
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(await evidence(), ["exam-page:beta"]);
    assert.equal(first.outputs.drift_items, "0");
    const before = await readFile(box.tracker);

    // The exam page is down for a day: its tag is neither dropped nor replaced.
    world.examPageHook = (_request, response) => {
      response.statusCode = 503;
      response.end("down");
      return true;
    };
    const down = await runDrift(box, learn, { TODAY: "2026-10-10" });
    assert.equal(down.code, 0, down.stderr);
    assert.match(down.stderr, /could not probe the exam page of AZ-902/);
    assert.deepEqual(await evidence(), ["exam-page:beta"]);
    // So no tracker commit, and no row that says the BETA badge lost its evidence.
    assert.equal(down.outputs.baseline_updated, "false");
    assert.deepEqual(await readFile(box.tracker), before);
    assert.equal(down.outputs.drift_items, "0");
    assert.deepEqual(await ghWrites(box), []);

    // An answer replaces the tag: the page title dropped its marker.
    world.examPageHook = null;
    world.examPages["AZ-902"] = { name: "Azure Role 2", beta: false };
    const ga = await runDrift(box, learn, { TODAY: "2026-10-11" });
    assert.deepEqual(await evidence(), ["exam-page:ga"]);
    assert.equal(ga.outputs.drift_items, "1");
  } finally {
    await learn.close();
  }
});

test("drift end to end: a maintainer who closes the drift issue by hand gets no new one every day, only a reminder after the hold", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({ "AZ-901": { name: "Old Name" } }),
  });
  const closeByHand = async (day) => {
    const file = join(box.dir, "gh-state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    for (const issue of state.issues.filter((i) => i.state === "open")) {
      issue.state = "closed";
      issue.closedAt = `${day}T09:00:00Z`;
    }
    await writeFile(file, JSON.stringify(state));
  };
  try {
    await runDrift(box, learn);
    assert.equal((await driftIssues(box)).length, 1);
    await closeByHand("2026-10-09");

    for (const day of ["2026-10-10", "2026-10-12", "2026-10-15"]) {
      const held = await runDrift(box, learn, { TODAY: day });
      assert.equal(held.code, 0, held.stderr);
      assert.equal(held.outputs.drift_items, "1", day);
      assert.equal((await driftIssues(box)).length, 1, day);
    }
    assert.match(
      (await runDrift(box, learn, { TODAY: "2026-10-15" })).stdout,
      /not recreated: a maintainer closed it by hand less than 7 days ago/,
    );

    // A row that was not in the closed issue is news at once.
    await writeHub(box, {
      pages: agreeing({
        "AZ-901": { name: "Old Name" },
        "AZ-902": { name: "Stale" },
      }),
    });
    await runDrift(box, learn, { TODAY: "2026-10-15" });
    assert.equal((await driftIssues(box)).length, 2);
    await closeByHand("2026-10-15");

    // Seven days later the same rows are listed again as a reminder.
    await runDrift(box, learn, { TODAY: "2026-10-21" });
    assert.equal((await driftIssues(box)).length, 2);
    await runDrift(box, learn, { TODAY: "2026-10-22" });
    assert.equal((await driftIssues(box)).length, 3);
    assert.equal((await openDrift(box)).length, 1);
  } finally {
    await learn.close();
  }
});

test("drift end to end: closing the issue of an accepted long list by hand does not trip the failsafe, daily, with a 'could not run' issue", async () => {
  const { learn, box } = await driftWorld({
    pages: agreeing({
      "AZ-901": { name: "Old 1" },
      "AZ-902": { name: "Old 2" },
      "AZ-903": { name: "Old 3" },
    }),
  });
  const closeByHand = async (day) => {
    const file = join(box.dir, "gh-state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    for (const issue of state.issues.filter((i) => i.state === "open")) {
      issue.state = "closed";
      issue.closedAt = `${day}T09:00:00Z`;
    }
    await writeFile(file, JSON.stringify(state));
  };
  try {
    // Three rows are more than MAX_DRIFT 2: accepted once, with FORCE_DRIFT.
    const forced = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      FORCE_DRIFT: "1",
    });
    assert.equal(forced.outputs.drift_check_failed, "false");
    assert.equal(forced.outputs.drift_items, "3");
    await closeByHand("2026-10-09");

    // The maintainer closed it: while the hold lasts the rows are still theirs, not news.
    for (const day of ["2026-10-10", "2026-10-15"]) {
      const held = await runDrift(box, learn, { MAX_DRIFT: "2", TODAY: day });
      assert.equal(held.code, 0, held.stderr);
      assert.equal(held.outputs.drift_check_failed, "false", day);
      assert.equal(held.outputs.drift_items, "3", day);
    }
    assert.deepEqual(
      (await ghIssues(box)).map((issue) => issue.title),
      [DRIFT_ISSUE_TITLE],
      "no 'could not run' issue and no new drift issue",
    );
    assert.equal(await exists(join(box.dir, "drift-error.md")), false);

    // After the hold nothing is remembered: the failsafe counts every row again.
    const later = await runDrift(box, learn, {
      MAX_DRIFT: "2",
      TODAY: "2026-10-16",
    });
    assert.equal(later.outputs.drift_check_failed, "true");
    assert.match(
      await readFile(join(box.dir, "drift-error.md"), "utf8"),
      /3 new drift items \(limit MAX_DRIFT 2\)/,
    );
  } finally {
    await learn.close();
  }
});

test("drift end to end: the monitor stays quiet when the hub and Learn agree, whatever the day", async () => {
  const { learn, box } = await driftWorld();
  try {
    const first = await runDrift(box, learn);
    assert.equal(first.outputs.drift_items, "0");
    assert.equal(await exists(join(box.dir, "drift-report.md")), false);
    const before = await readFile(box.tracker);
    for (const day of ["2026-10-10", "2026-11-10"]) {
      const again = await runDrift(box, learn, { TODAY: day });
      assert.equal(again.outputs.drift_items, "0");
      assert.equal(again.outputs.baseline_updated, "false");
    }
    assert.deepEqual(await readFile(box.tracker), before);
    assert.deepEqual(await ghWrites(box), []);
  } finally {
    await learn.close();
  }
});

// ---------------------------------------------------------------------------
// The workflow: its step order and manual input are part of the contract
// ---------------------------------------------------------------------------
// A checkout with core.autocrlf (this repo's maintainer works on Windows) turns
// the line ends of the workflow into CRLF; the patterns below are written for LF.
const readWorkflow = (name) =>
  readFileSync(join(root, ".github", "workflows", name), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const workflowSource = readWorkflow("new-exam-monitor.yml");

/** The job's steps with comments removed: { name, condition, text }. */
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

function workflowStep(name) {
  const step = workflowSteps().find((candidate) => candidate.name === name);
  assert.ok(step, `no workflow step named "${name}"`);
  return step;
}

const STEP_CHECK = "Check Microsoft Learn for new exams";
const STEP_ISSUE =
  "Create issue if a new exam, certification or study guide update was found";
const STEP_COMMIT = "Commit updated Learn exam tracker";
const STEP_GUIDES = "Create issue if the study guide check stopped";
const STEP_GUIDES_CLOSE =
  "Close the study guide issue once the guide check runs again";
const STEP_FAILED = "Create issue if the check failed";

/**
 * What the two steps that look after the issue "study guide check stopped" do for
 * a value of the guide_check_failed output: { raise, clear }. Their conditions
 * compare the output with one literal, so neither fires for any other value.
 */
function failsafeIssueSteps(value) {
  const fires = (name) => {
    const condition = workflowStep(name).condition;
    const wanted = condition.match(
      /^steps\.check\.outputs\.guide_check_failed == '(\w+)'$/,
    )?.[1];
    assert.ok(wanted, `${name}: unexpected condition ${condition}`);
    return value === wanted;
  };
  return { raise: fires(STEP_GUIDES), clear: fires(STEP_GUIDES_CLOSE) };
}

test("the workflow opens the issue before it commits the tracker, so a failed issue is retried", () => {
  const names = workflowSteps().map((step) => step.name);
  const at = [
    STEP_CHECK,
    STEP_ISSUE,
    STEP_COMMIT,
    STEP_GUIDES,
    STEP_FAILED,
  ].map((name) => names.indexOf(name));
  assert.ok(
    at[0] >= 0 && at.every((index, i) => i === 0 || index > at[i - 1]),
    `unexpected step order: ${at}`,
  );

  assert.equal(
    workflowStep(STEP_ISSUE).condition,
    "steps.check.outputs.changes_found == 'true'",
  );
  // No status-check function (always, failure, cancelled): the condition keeps
  // the implicit success(), so the commit is skipped when the issue step fails
  // and the exam is still new on the next run.
  assert.equal(
    workflowStep(STEP_COMMIT).condition,
    "steps.check.outputs.baseline_updated == 'true'",
  );
  assert.equal(
    workflowStep(STEP_FAILED).condition,
    "failure() && steps.check.outputs.extraction_failed == 'true'",
  );
});

test("a gh failure while the drift issue is kept up to date fails the run only at its very last step", () => {
  const names = workflowSteps().map((step) => step.name);
  const last = "Fail the run if the drift issue could not be kept up to date";
  assert.equal(names.at(-1), last);
  assert.ok(
    names.indexOf(last) > names.indexOf(STEP_COMMIT) &&
      names.indexOf(last) > names.indexOf(STEP_ISSUE),
    "after the exam issue and the tracker commit",
  );
  // Also when an earlier step failed (the message still reaches the log), never when cancelled.
  assert.equal(
    workflowStep(last).condition,
    "${{ !cancelled() && steps.check.outputs.drift_issue_failed == 'true' }}",
  );
  assert.match(workflowStep(last).text, /::error title=New Exam Monitor::/);
  assert.match(workflowStep(last).text, /exit 1/);
  // The check step itself does not fail on a drift issue problem: the script
  // writes drift_issue_failed instead (see the end to end tests).
  assert.match(
    readFileSync(join(root, "scripts", "new-exam-check.mjs"), "utf8"),
    /drift_issue_failed:/,
  );
});

test("the issues are labelled and read the files the script writes", () => {
  const label = (name) =>
    workflowStep(name)
      .text.match(/labels: (\S+)|--label (\S+)/)
      ?.slice(1)
      .find(Boolean);
  const file = (name) =>
    workflowStep(name)
      .text.match(/content-filepath: (\S+)|--file (\S+)/)
      ?.slice(1)
      .find(Boolean);
  assert.equal(label(STEP_ISSUE), "enhancement");
  assert.equal(label(STEP_GUIDES), "bug");
  assert.equal(label(STEP_FAILED), "bug");
  // REPORT_FILE / ERROR_FILE of the job env are the paths the issues read.
  assert.match(
    workflowSource,
    /^ {6}REPORT_FILE: \/tmp\/new-exam-report\.md$/m,
  );
  assert.match(workflowSource, /^ {6}ERROR_FILE: \/tmp\/new-exam-error\.md$/m);
  assert.equal(file(STEP_ISSUE), "/tmp/new-exam-report.md");
  assert.equal(file(STEP_GUIDES), "/tmp/new-exam-error.md");
  assert.equal(file(STEP_FAILED), "/tmp/new-exam-error.md");
  // The job may commit the tracker and open issues, and nothing else.
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
  assert.match(workflowSource, /^ {4}timeout-minutes: 30$/m);
});

test("the study guide failsafe has an issue of its own that does not need a failed run", () => {
  // The failsafe stops only the guide part: the run succeeds (exit 0), so the
  // step cannot depend on failure(), and it must not run when the check itself
  // failed (that has its own issue).
  const step = workflowStep(STEP_GUIDES);
  assert.equal(
    step.condition,
    "steps.check.outputs.guide_check_failed == 'true'",
  );
  // One issue with a stable title (a comment for every further day), not one
  // per run: the run id is not in the title, and a healthy guide check closes it.
  assert.match(
    step.text,
    /failure-issue\.mjs raise --title "New Exam Monitor: study guide check stopped" --label bug/,
  );
  assert.doesNotMatch(step.text, /github\.run_id/);
  assert.doesNotMatch(workflowSource, /Failed — \$\{\{ github\.run_id/);
  const close = workflowStep(STEP_GUIDES_CLOSE);
  assert.equal(
    close.condition,
    "steps.check.outputs.guide_check_failed == 'false'",
  );
  assert.match(
    close.text,
    /failure-issue\.mjs clear --title "New Exam Monitor: study guide check stopped"/,
  );
  // The output has three values and the conditions are exact comparisons: a day
  // on which no guide was checked ("skipped") raises nothing and closes nothing.
  // The workflow says so next to the steps.
  assert.deepEqual(failsafeIssueSteps("skipped"), {
    raise: false,
    clear: false,
  });
  assert.match(workflowSource, /^ *# [^\n]*'skipped'/m);
  // And it tells what to run.
  assert.match(workflowSource, /force_guide_baseline/);
});

test("the schedule is daily, and no other monitor that pushes to main starts in the same minute", () => {
  const cron = (source) =>
    [...source.matchAll(/^\s*- cron: "(\d+) (\d+) (\S+) (\S+) (\S+)"/gm)].map(
      (match) => match.slice(1, 6),
    );
  const [mine, ...extra] = cron(workflowSource);
  assert.equal(extra.length, 0, "one schedule");
  assert.deepEqual(mine.slice(2), ["*", "*", "*"], "every day");

  // Two monitors starting in the same minute can reject each other's push.
  // Distinct start minutes are only a convenience (GitHub often starts scheduled
  // runs hours late); the protection is the push retry every commit step has
  // (the tests of the commit step below run it, and workflow-commit-steps.test.mjs
  // runs it for every workflow that pushes).
  const dir = join(root, ".github", "workflows");
  for (const name of readdirSync(dir)) {
    if (name === "new-exam-monitor.yml" || !name.endsWith(".yml")) continue;
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

test("a run is not cancelled between the issue and the tracker commit", () => {
  assert.match(
    workflowSource,
    /^concurrency:\n {2}group: new-exam-monitor\n {2}cancel-in-progress: false$/m,
  );
});

test("a manual run can force a re-baseline with the input the failsafe message names", () => {
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
});

test("a manual run can force just the study guides, which leaves the exam alerts alone", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  assert.match(dispatch, /^ {6}force_guide_baseline:\n/m);
  const input = dispatch.match(
    /^ {6}force_guide_baseline:\n((?: {8}.*\n)+)/m,
  )?.[1];
  assert.match(input, /^ {8}type: boolean$/m);
  assert.match(input, /^ {8}default: false$/m);
  assert.match(input, /study guide/);
  assert.match(input, /new exams and certifications are still reported/);
  assert.match(
    workflowStep(STEP_CHECK).text,
    /FORCE_GUIDE_BASELINE: \$\{\{ inputs\.force_guide_baseline && '1' \|\| '' \}\}/,
  );
});

test("the check step runs the drift check with the job token and can be forced from the manual run", () => {
  const step = workflowStep(STEP_CHECK).text;
  // `gh` needs a token and the script only touches issues when it is told to.
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /CREATE_ISSUES: "1"/);
  assert.match(
    step,
    /FORCE_DRIFT: \$\{\{ inputs\.force_drift && '1' \|\| '' \}\}/,
  );
  // The drift issue is written by this step, so before the tracker commit.
  const names = workflowSteps().map((candidate) => candidate.name);
  assert.ok(names.indexOf(STEP_CHECK) < names.indexOf(STEP_COMMIT));

  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  const input = dispatch.match(/^ {6}force_drift:\n((?: {8}.*\n)+)/m)?.[1];
  assert.ok(input, "no force_drift input");
  assert.match(input, /^ {8}type: boolean$/m);
  assert.match(input, /^ {8}default: false$/m);
  assert.match(input, /drift/);
  // The names the script uses in its own messages are the ones the workflow has.
  const source = readFileSync(
    join(root, "scripts", "new-exam-check.mjs"),
    "utf8",
  );
  assert.match(source, /`force_drift`/);
  assert.match(source, /FORCE_DRIFT=1/);
  // The job may write issues and nothing else beyond the tracker commit.
  assert.match(
    workflowSource,
    /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n/m,
  );
});

test("the forced baseline also covers study guides, and nothing the monitor ships mentions private planning", () => {
  const dispatch =
    workflowSource.match(/^ {2}workflow_dispatch:\n((?: {4,}.*\n)+)/m)?.[1] ??
    "";
  const forceBaseline = dispatch.match(
    /^ {6}force_baseline:\n((?: {8}.*\n)+)/m,
  )?.[1];
  assert.match(forceBaseline, /re-read every covered study guide/);
  // One issue covers the study guide updates too: the step says so.
  assert.ok(
    workflowSteps().some(
      (step) => step.name === STEP_ISSUE && /study guide/.test(step.name),
    ),
  );
  for (const path of [
    "scripts/new-exam-check.mjs",
    ".github/workflows/new-exam-monitor.yml",
  ]) {
    assert.doesNotMatch(
      readFileSync(join(root, path), "utf8"),
      INTERNAL_WORDS,
      path,
    );
  }
});

// The commit step is plain bash; run it for real against a scratch remote
// (tests/scripts/helpers/git-remote.mjs: its hook that rejects pushes is
// executable, the bare origin is read with --git-dir, and on Windows the bash is
// the one of Git for Windows).
const bash = findBash();
const bashSkip = bashSkipReason(bash);
const TRACKER = "src/data_files/learn-exams.json";
// The wait between the tries (5, 10 and 15 seconds on the runner) is cut to
// nothing by a function that shadows `sleep`; the script itself is not touched.
const SLEEPLESS = "sleep() { :; }\n";

/** The shell script of the commit step, de-indented as the runner would see it. */
function commitScript() {
  const body = workflowStep(STEP_COMMIT).text.split(/^\s+run: \|\n/m)[1];
  assert.ok(body, "the commit step has no run script");
  const indent = body.match(/^ +/)[0].length;
  return body
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

/** A scratch remote that has the tracker, and a function that runs the commit step in its work tree. */
async function commitStepRemote(prefix, options = {}) {
  const remote = await makeScratchRemote({
    prefix,
    files: { [TRACKER]: '{"exams":[]}\n' },
    ...options,
  });
  const script = SLEEPLESS + commitScript();
  assert.match(script, /for attempt in 1 2 3; do/);
  return {
    remote,
    run: () => runBash(bash, script, { cwd: remote.work, env: remote.env }),
  };
}

test(
  "the commit step tries the push again when it is rejected once, and fails after the third rejection",
  { skip: bashSkip },
  async () => {
    const { remote, run } = await commitStepRemote("new-exam-workflow-retry-", {
      withOther: false,
    });
    try {
      // Rejected once: the second try goes through.
      await rejectFirstPushes(remote, 1);
      await remote.write(remote.work, TRACKER, '{"exams":["AZ-950"]}\n');
      const retried = await run();
      assert.equal(retried.code, 0, retried.stderr);
      assert.deepEqual(await remote.subjects(), [
        "Update Learn exam tracker",
        "init",
      ]);
      assert.equal(
        await pushAttempts(remote),
        2,
        "the origin saw the push it rejected and the one it accepted",
      );

      // Rejected three times: the step fails (the run is red, the next run tries again).
      await rejectFirstPushes(remote, 3);
      await remote.write(remote.work, TRACKER, '{"exams":["AZ-951"]}\n');
      const failed = await run();
      assert.notEqual(failed.code, 0, "three rejections are a failed step");
      assert.deepEqual(await remote.subjects(), [
        "Update Learn exam tracker",
        "init",
      ]);
      assert.equal(await pushAttempts(remote), 3, "three tries, no more");
    } finally {
      await remote.cleanup();
    }
  },
);

test(
  "the commit step pushes the tracker, rebases onto a concurrent push and skips an unchanged tracker",
  { skip: bashSkip },
  async () => {
    const { remote, run } = await commitStepRemote("new-exam-workflow-");
    try {
      // Nothing changed: the step succeeds without a commit.
      const unchanged = await run();
      assert.equal(unchanged.code, 0, unchanged.stderr);
      assert.deepEqual(await remote.subjects(), ["init"]);

      // Someone pushed to main after the checkout: the step rebases onto it.
      await remote.concurrentPush("notes.txt", "x\n", "elsewhere");
      await remote.write(remote.work, TRACKER, '{"exams":["AZ-950"]}\n');
      const pushed = await run();
      assert.equal(pushed.code, 0, pushed.stderr);
      assert.deepEqual(await remote.subjects(), [
        "Update Learn exam tracker",
        "elsewhere",
        "init",
      ]);
      assert.equal(await remote.show(TRACKER), '{"exams":["AZ-950"]}');
    } finally {
      await remote.cleanup();
    }
  },
);
