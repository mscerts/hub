// Offline tests of the Learn course tracker (scripts/learn-courses-sync.mjs, scripts/lib/learn-courses.mjs).
// The catalog answers, the hub pages and learnsync's data are small made-up copies in a temp folder; no network.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import {
  loadConfig,
  run,
  scanHub,
  syncIssue,
} from "../../scripts/learn-courses-sync.mjs";
import { describeSuggestion } from "../../scripts/lib/course-placement.mjs";
import {
  EDUCATION_ROLES,
  REMOVED_AFTER_RUNS,
  buildReport,
  catalogFields,
  checkHub,
  comparable,
  courseCode,
  emptyFile,
  examPages,
  needsCount,
  parseFile,
  proposalsFrom,
  serializeFile,
  signatureOf,
  skillsBuiltOn,
  suggestedCards,
  summarize,
  syncCourses,
} from "../../scripts/lib/learn-courses.mjs";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

const course = (number, extra = {}) => {
  const slug = (extra.slug ?? number).toLowerCase();
  return {
    uid: `course.${slug}`,
    course_number: number,
    title: extra.title ?? `Course ${number}`,
    summary: extra.summary ?? "<p>A course.</p>",
    url: `https://learn.microsoft.com/en-us/training/courses/${slug}/?WT.mc_id=api_CatalogApi`,
    levels: ["beginner"],
    roles: extra.roles ?? ["administrator"],
    products: extra.products ?? ["azure"],
    study_guide: extra.study_guide ?? [
      { uid: `learn.${slug}`, type: "learningPath" },
    ],
  };
};
const examCodes = new Set([
  "AZ-104",
  "AZ-400",
  "AZ-401",
  "AI-103",
  "PL-400",
  "MB-800",
]);
const hubPages = new Map([
  ["AZ-104", { file: "src/content/docs/azure/AZ-104.mdx", archived: false }],
  ["AZ-400", { file: "src/content/docs/azure/AZ-400.mdx", archived: false }],
  ["AZ-401", { file: "src/content/docs/azure/AZ-401.mdx", archived: false }],
  ["AI-103", { file: "src/content/docs/azure/AI-103.mdx", archived: false }],
  [
    "AB-400",
    { file: "src/content/docs/aibusiness/AB-400.mdx", archived: false },
  ],
  ["AZ-800", { file: "src/content/archive/azure/AZ-800.mdx", archived: true }],
]);
const retiring = [
  { code: "AZ-400", replacementCode: "AZ-401", retirementDate: "2027-02-01" },
];
const modulesOfNothing = () => new Set();
const base = {
  examCodes,
  hubPages,
  retiring,
  modulesOf: modulesOfNothing,
  skills: [],
  cards: [],
  videos: new Map(),
  today: "2026-10-21",
};
const sync = (previous, courses, extra = {}) =>
  syncCourses({
    previous,
    courses,
    describe: describeSuggestion,
    ...base,
    ...extra,
  });
const byKey = (file) => new Map(file.courses.map((c) => [c.key, c]));
const suggestion = (exam, confidence = "likely") => ({
  exam,
  confidence,
  points: 2,
  reasons: {
    shared: { count: 2, total: 3, modules: ["A", "B"], strong: true },
    guide: null,
    groups: null,
  },
});

// ---------------------------------------------------------------------------
// Kinds, codes, hashes
// ---------------------------------------------------------------------------

test("a course number gives the code of its short link; an exam course is <CODE>T<nn> of an exam on Learn", () => {
  assert.equal(courseCode("AZ-104T00-A"), "AZ-104");
  assert.equal(courseCode("SC-5006"), "SC-5006");
  assert.equal(courseCode("MSLE-AI"), "");
  assert.equal(courseCode(""), "");
  const exam = catalogFields(course("AZ-104T00"), { examCodes });
  assert.equal(exam.kind, "exam");
  assert.equal(exam.exam, "AZ-104");
  assert.equal(exam.url, "/training/courses/az-104t00");
  // not every three-digit course is a credential (DP-605T00 is no exam)
  const noExam = catalogFields(course("DP-605T00"), { examCodes });
  assert.equal(noExam.kind, "other");
  assert.equal(noExam.exam, undefined);
  assert.equal(catalogFields(course("AI-3026"), { examCodes }).kind, "other");
  // a course without a number is a course too
  const plain = catalogFields(
    { ...course("X"), course_number: undefined, uid: "course.edu.x" },
    { examCodes },
  );
  assert.equal(plain.number, "");
  assert.equal(plain.code, "");
});

test("the learning path hash follows the list of learning paths and modules, not their order", () => {
  const a = catalogFields(
    course("AZ-104T00", {
      study_guide: [
        { uid: "learn.a", type: "learningPath" },
        { uid: "azure.b", type: "module" },
      ],
    }),
    { examCodes },
  );
  const b = catalogFields(
    course("AZ-104T00", {
      study_guide: [
        { uid: "azure.b", type: "module" },
        { uid: "learn.a", type: "learningPath" },
      ],
    }),
    { examCodes },
  );
  const c = catalogFields(
    course("AZ-104T00", {
      study_guide: [{ uid: "learn.a", type: "learningPath" }],
    }),
    { examCodes },
  );
  assert.equal(a.pathsHash, b.pathsHash);
  assert.notEqual(a.pathsHash, c.pathsHash);
});

test("an Applied Skill is built on a course when the course holds at least half of its modules", () => {
  const modules = new Set(["/m/1", "/m/2", "/m/3", "/m/4"]);
  const skills = [
    { slug: "all", modules: new Set(["/m/1", "/m/2"]) },
    { slug: "half", modules: new Set(["/m/1", "/x/1"]) },
    { slug: "less", modules: new Set(["/m/1", "/x/1", "/x/2"]) },
    { slug: "none", modules: new Set(["/x/1"]) },
    { slug: "empty", modules: new Set() },
  ];
  assert.deepEqual(skillsBuiltOn(modules, skills), [
    { slug: "all", count: 2, total: 2 },
    { slug: "half", count: 1, total: 2 },
  ]);
});

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

test("an exam course goes to its exam's page by the rule, and is proposed for the page of the exam that replaces it", () => {
  const exam = { key: "az-400t00", kind: "exam", exam: "AZ-400" };
  assert.deepEqual(examPages(exam, { hubPages, retiring }), [
    { page: "AZ-400", state: "confirmed", origin: "exam" },
    {
      page: "AZ-401",
      state: "proposed",
      origin: "replacement",
      temporary: { for: "AZ-400" },
    },
  ]);
  // no hub page for the exam: nothing; a rename is the maintainer's examPage
  assert.deepEqual(
    examPages({ kind: "exam", exam: "MB-800" }, { hubPages, retiring }),
    [],
  );
  assert.deepEqual(
    examPages(
      { kind: "exam", exam: "PL-400", examPage: "AB-400" },
      { hubPages, retiring },
    ),
    [{ page: "AB-400", state: "confirmed", origin: "exam" }],
  );
});

test("a first sync assigns the exam courses by the rule and leaves the other courses waiting with proposals", () => {
  const courses = [
    course("AZ-104T00"),
    course("AZ-400T00"),
    course("AI-3026"),
    course("MB-800T00"),
  ];
  const propose = (c) =>
    c.course_number === "AI-3026"
      ? [
          suggestion("AI-103"),
          suggestion("AZ-104", "possible"),
          suggestion("MB-999"),
        ]
      : [];
  const { file, changes } = sync(emptyFile(), courses, { propose });
  const map = byKey(file);
  assert.deepEqual(changes.added.sort(), [
    "ai-3026",
    "az-104t00",
    "az-400t00",
    "mb-800t00",
  ]);
  const az104 = map.get("az-104t00");
  assert.equal(az104.kind, "exam");
  assert.equal(az104.state, "active");
  assert.deepEqual(az104.pages, [
    { page: "AZ-104", state: "confirmed", origin: "exam" },
  ]);
  assert.equal(map.get("az-400t00").state, "active");
  assert.deepEqual(
    map.get("az-400t00").pages.map((p) => `${p.page}:${p.state}`),
    ["AZ-400:confirmed", "AZ-401:proposed"],
  );
  assert.equal(
    map.get("mb-800t00").state,
    "no-page",
    "no hub page for the exam",
  );
  const other = map.get("ai-3026");
  assert.equal(other.state, "new");
  assert.deepEqual(
    other.pages.map((p) => `${p.page}:${p.state}:${p.confidence}`),
    ["AI-103:proposed:likely", "AZ-104:proposed:possible"],
    "a page the hub does not have is not proposed",
  );
});

test("nothing is placed by itself: a proposal stays proposed, a decision is kept, a rejected page does not come back", () => {
  const courses = [course("AI-3026"), course("AZ-400T00")];
  const propose = () => [suggestion("AI-103"), suggestion("AZ-104")];
  const first = sync(emptyFile(), courses, { propose }).file;
  // the maintainer confirms one page, rejects another, and confirms the replacement page of the exam course
  const map = byKey(first);
  map.get("ai-3026").pages.find((p) => p.page === "AI-103").state = "confirmed";
  map.get("ai-3026").pages.find((p) => p.page === "AZ-104").state = "rejected";
  map.get("az-400t00").pages.find((p) => p.page === "AZ-401").state =
    "confirmed";
  const second = sync(first, courses, { propose }).file;
  const again = byKey(second);
  assert.equal(again.get("ai-3026").state, "active");
  assert.deepEqual(
    again.get("ai-3026").pages.map((p) => `${p.page}:${p.state}`),
    ["AI-103:confirmed", "AZ-104:rejected"],
  );
  assert.equal(
    again.get("az-400t00").pages.find((p) => p.page === "AZ-401").state,
    "confirmed",
  );
});

test("a hub page that already has a card for a course confirms it; a decided no-page stays", () => {
  const cards = [
    {
      file: "src/content/docs/azure/AI-103.mdx",
      page: "AI-103",
      archived: false,
      kind: "youtube",
      key: "",
      code: "AI-3026",
      playlist: "",
    },
  ];
  const videos = new Map([["AI-3026", { playlist: "PLx" }]]);
  const { file } = sync(emptyFile(), [course("AI-3026"), course("DP-605T00")], {
    cards,
    videos,
  });
  const map = byKey(file);
  assert.deepEqual(map.get("ai-3026").pages, [
    { page: "AI-103", state: "confirmed", origin: "card" },
  ]);
  assert.equal(map.get("ai-3026").state, "active");
  // the maintainer decided DP-605T00 belongs to no page: it stays so
  map.get("dp-605t00").state = "no-page";
  const next = sync(file, [course("AI-3026"), course("DP-605T00")], {
    cards,
    videos,
    propose: () => [suggestion("AI-103")],
  }).file;
  assert.equal(byKey(next).get("dp-605t00").state, "no-page");
  assert.deepEqual(byKey(next).get("dp-605t00").pages ?? [], []);
});

test("a course for educators is decided as no-page when it first shows up, once", () => {
  assert.ok(EDUCATION_ROLES.includes("k-12-educator"));
  const edu = course("", {
    slug: "edu.minecraft",
    roles: ["k-12-educator", "school-leader"],
  });
  const { file } = sync(emptyFile(), [edu], {
    propose: () => [suggestion("AI-103")],
  });
  const entry = byKey(file).get("edu.minecraft");
  assert.equal(entry.state, "no-page");
  assert.match(entry.note, /education/);
  assert.deepEqual(entry.pages, []);
  // the maintainer puts it back to new: the rule does not undo that
  entry.state = "new";
  entry.note = "look again";
  const next = sync(file, [edu], {
    propose: () => [suggestion("AI-103")],
  }).file;
  assert.equal(byKey(next).get("edu.minecraft").state, "new");
});

test("a proposal names at most four pages, the hub's own, and never an archived page or the course's own exam", () => {
  const hub = new Map([
    ...hubPages,
    ["AZ-900", { file: "x", archived: false }],
    ["SC-200", { file: "y", archived: false }],
    ["SC-300", { file: "z", archived: false }],
  ]);
  const out = proposalsFrom(
    ["AZ-800", "AZ-104", "AZ-900", "SC-200", "SC-300", "AI-103"].map((e) =>
      suggestion(e),
    ),
    {
      hubPages: hub,
      exclude: ["AZ-104"],
      describe: (s) => `${s.exam}, likely (x)`,
    },
  );
  assert.deepEqual(
    out.map((p) => p.page),
    ["AZ-900", "SC-200", "SC-300", "AI-103"],
  );
  assert.equal(out[0].why, "likely (x)", "the page name is not repeated");
  assert.equal(out[0].origin, "modules");
});

// ---------------------------------------------------------------------------
// Removal, changes, ghosts
// ---------------------------------------------------------------------------

test("a course is removed only after it is missing two runs in a row, and is back when listed again", () => {
  assert.equal(REMOVED_AFTER_RUNS, 2);
  const courses = [course("AZ-104T00"), course("AI-3026")];
  let file = sync(emptyFile(), courses).file;
  const without = [course("AZ-104T00")];
  const once = sync(file, without);
  assert.equal(byKey(once.file).get("ai-3026").missingRuns, 1);
  assert.equal(
    byKey(once.file).get("ai-3026").state,
    "new",
    "one miss proves nothing",
  );
  assert.deepEqual(once.changes.removed, []);
  const twice = sync(once.file, without);
  assert.equal(byKey(twice.file).get("ai-3026").state, "removed");
  assert.equal(byKey(twice.file).get("ai-3026").goneSince, "2026-10-21");
  assert.deepEqual(twice.changes.removed, ["ai-3026"]);
  // listed again
  const back = sync(twice.file, courses);
  assert.deepEqual(back.changes.back, ["ai-3026"]);
  assert.notEqual(byKey(back.file).get("ai-3026").state, "removed");
  assert.equal(byKey(back.file).get("ai-3026").goneSince, undefined);
  // one miss and then listed again: no trace
  const blink = sync(sync(file, without).file, courses);
  assert.equal(byKey(blink.file).get("ai-3026").missingRuns, undefined);
  void file;
});

test("a changed learning path list is noted, and a course with a confirmed page is flagged for a look", () => {
  const first = sync(emptyFile(), [course("AI-3026"), course("AI-3027")], {
    cards: [
      {
        file: "f",
        page: "AI-103",
        archived: false,
        kind: "youtube",
        key: "",
        code: "AI-3026",
        playlist: "",
      },
    ],
  }).file;
  const changed = [
    course("AI-3026", {
      study_guide: [{ uid: "learn.new", type: "learningPath" }],
    }),
    course("AI-3027", {
      study_guide: [{ uid: "learn.new2", type: "learningPath" }],
    }),
  ];
  const { file, changes } = sync(first, changed, {
    cards: [
      {
        file: "f",
        page: "AI-103",
        archived: false,
        kind: "youtube",
        key: "",
        code: "AI-3026",
        playlist: "",
      },
    ],
  });
  assert.deepEqual(changes.changed.map((c) => c.key).sort(), [
    "ai-3026",
    "ai-3027",
  ]);
  assert.ok(byKey(file).get("ai-3026").review, "it has a confirmed page");
  assert.equal(
    byKey(file).get("ai-3027").review,
    undefined,
    "nothing assigned, nothing to re-check",
  );
});

test("a four-digit course that a hub YouTube card names but the catalog does not list becomes a removed entry, once", () => {
  const cards = [
    {
      file: "src/content/docs/azure/AI-103.mdx",
      page: "AI-103",
      archived: false,
      kind: "youtube",
      key: "",
      code: "AI-3016",
      playlist: "",
    },
    {
      file: "src/content/docs/azure/AZ-104.mdx",
      page: "AZ-104",
      archived: false,
      kind: "youtube",
      key: "",
      code: "AZ-104",
      playlist: "",
    },
  ];
  const first = sync(emptyFile(), [course("AI-3026")], { cards });
  assert.deepEqual(first.changes.ghosts, ["ai-3016"]);
  const ghost = byKey(first.file).get("ai-3016");
  assert.equal(ghost.state, "removed");
  assert.equal(ghost.code, "AI-3016");
  // the second run keeps it and adds no second entry
  const second = sync(first.file, [course("AI-3026")], { cards });
  assert.deepEqual(second.changes.ghosts, []);
  assert.equal(
    second.file.courses.filter((c) => c.code === "AI-3016").length,
    1,
  );
});

test("the Applied Skills of an entry are refreshed from the catalog and stay when the list could not be read", () => {
  const c = course("MS-4018");
  const modulesOf = () => new Set(["/m/1", "/m/2"]);
  const skills = [{ slug: "streamline", modules: new Set(["/m/1", "/m/2"]) }];
  const first = sync(emptyFile(), [c], { modulesOf, skills }).file;
  assert.deepEqual(byKey(first).get("ms-4018").skills, [
    { slug: "streamline", count: 2, total: 2 },
  ]);
  const kept = sync(first, [c], { modulesOf, skills: null }).file;
  assert.deepEqual(byKey(kept).get("ms-4018").skills, [
    { slug: "streamline", count: 2, total: 2 },
  ]);
  const gone = sync(first, [c], { modulesOf, skills: [] }).file;
  assert.equal(byKey(gone).get("ms-4018").skills.length, 0);
});

// ---------------------------------------------------------------------------
// The hub check
// ---------------------------------------------------------------------------

const learnCard = (key, page, extra = {}) => ({
  file: `src/content/docs/azure/${page}.mdx`,
  line: 1,
  page,
  archived: false,
  kind: "learn",
  key,
  code: "",
  playlist: "",
  ...extra,
});

test("the check finds a confirmed page without the course card: every course needs its Learn page card, the recording's card does not stand in for it", () => {
  const courses = [course("AZ-104T00"), course("AI-3026")];
  const cards = [
    {
      file: "f",
      page: "AI-103",
      archived: false,
      kind: "youtube",
      key: "",
      code: "AI-3026",
      playlist: "",
    },
  ];
  const { file } = sync(emptyFile(), courses, { cards });
  const videos = new Map([["AI-3026", { playlist: "PL" }]]);
  let view = checkHub({
    file,
    hubPages,
    cards,
    retiring,
    videos,
    today: "2026-10-21",
  });
  assert.deepEqual(
    view.missing.map((m) => `${m.course.key}@${m.page}`),
    ["ai-3026@AI-103", "az-104t00@AZ-104"],
    "neither has its Learn card; AI-3026 has only its YouTube card",
  );
  const exam = view.missing.find((m) => m.course.key === "az-104t00");
  assert.match(
    exam.cards[0],
    /title="Microsoft Learn" href="https:\/\/learn\.microsoft\.com\/training\/courses\/az-104t00\?WT\.mc_id=studentamb_165290"/,
  );
  // the page that already has the recording's card is asked for the Learn card only
  const other = view.missing.find((m) => m.course.key === "ai-3026");
  assert.equal(other.cards.length, 1);
  assert.match(other.cards[0], /training\/courses\/ai-3026\?/);
  // a YouTube card does not satisfy an exam course
  const aiLearn = learnCard("ai-3026", "AI-103");
  view = checkHub({
    file,
    hubPages,
    cards: [
      ...cards,
      aiLearn,
      {
        file: "g",
        page: "AZ-104",
        archived: false,
        kind: "youtube",
        key: "",
        code: "AZ-104",
        playlist: "",
      },
    ],
    retiring,
    today: "2026-10-21",
  });
  assert.equal(view.missing.length, 1);
  // the Learn card satisfies it
  view = checkHub({
    file,
    hubPages,
    cards: [...cards, aiLearn, learnCard("az-104t00", "AZ-104")],
    retiring,
    today: "2026-10-21",
  });
  assert.deepEqual(view.missing, []);
  // an archived page is never asked for a card
  const archivedFile = structuredClone(file);
  byKey(archivedFile).get("az-104t00").pages = [
    { page: "AZ-800", state: "confirmed", origin: "exam" },
  ];
  view = checkHub({
    file: archivedFile,
    hubPages,
    cards: [...cards, aiLearn],
    retiring,
    today: "2026-10-21",
  });
  assert.deepEqual(view.missing, []);
});

test("a recording counts as the card of a course through its playlist as well", () => {
  const { file } = sync(emptyFile(), [course("AI-3026")], {
    cards: [
      {
        file: "f",
        page: "AI-103",
        archived: false,
        kind: "youtube",
        key: "",
        code: "",
        playlist: "PLshared",
      },
    ],
    videos: new Map([["AI-3026", { playlist: "PLshared" }]]),
  });
  assert.equal(byKey(file).get("ai-3026").state, "active");
});

test("a removed course that hub pages (active or archived) still link is reported until the maintainer acknowledges it", () => {
  const { file } = sync(
    {
      ...emptyFile(),
      courses: [
        {
          key: "ai-3016",
          uid: "",
          number: "AI-3016",
          code: "AI-3016",
          title: "",
          kind: "other",
          state: "removed",
          pages: [],
          firstSeen: "2026-10-01",
          lastSeen: "2026-10-01",
        },
        {
          key: "az-800t00",
          uid: "course.az-800t00",
          number: "AZ-800T00",
          code: "AZ-800",
          title: "Old",
          kind: "exam",
          exam: "AZ-800",
          state: "removed",
          pages: [{ page: "AZ-800", state: "confirmed", origin: "exam" }],
          firstSeen: "2026-01-01",
          lastSeen: "2026-09-01",
          goneSince: "2026-10-01",
        },
      ],
    },
    [course("AZ-104T00")],
  );
  const cards = [
    {
      file: "src/content/docs/azure/AI-103.mdx",
      page: "AI-103",
      archived: false,
      kind: "youtube",
      key: "",
      code: "AI-3016",
      playlist: "",
    },
    learnCard("az-800t00", "AZ-800", {
      file: "src/content/archive/azure/AZ-800.mdx",
      archived: true,
    }),
  ];
  let view = checkHub({ file, hubPages, cards, retiring, today: "2026-10-21" });
  assert.deepEqual(
    view.gone.map((g) => `${g.course.key}: ${g.files.join(",")}`),
    [
      "ai-3016: src/content/docs/azure/AI-103.mdx",
      "az-800t00: src/content/archive/azure/AZ-800.mdx",
    ],
  );
  byKey(file).get("ai-3016").ack = true;
  view = checkHub({ file, hubPages, cards, retiring, today: "2026-10-21" });
  assert.deepEqual(
    view.gone.map((g) => g.course.key),
    ["az-800t00"],
  );
  // the card is removed: nothing to report
  view = checkHub({ file, hubPages, cards: [], retiring, today: "2026-10-21" });
  assert.deepEqual(view.gone, []);
});

test("a temporary assignment is reported when the retirement date has passed or the replacement has a course of its own", () => {
  const courses = [course("AZ-400T00")];
  const { file } = sync(emptyFile(), courses);
  const entry = byKey(file).get("az-400t00");
  // proposed: a decision, not a due date
  let view = checkHub({
    file,
    hubPages,
    cards: [],
    retiring,
    today: "2027-03-01",
  });
  assert.deepEqual(
    view.replacements.map((r) => `${r.course.key}->${r.page}`),
    ["az-400t00->AZ-401"],
  );
  assert.deepEqual(view.temporary, []);
  // confirmed: reported once it is due
  entry.pages.find((p) => p.page === "AZ-401").state = "confirmed";
  view = checkHub({ file, hubPages, cards: [], retiring, today: "2026-12-01" });
  assert.deepEqual(view.temporary, []);
  view = checkHub({ file, hubPages, cards: [], retiring, today: "2027-02-02" });
  assert.deepEqual(
    view.temporary.map((t) => t.why),
    ["AZ-400 retired on 2027-02-01"],
  );
  // the replacement has its own course
  const withOwn = sync(file, [...courses, course("AZ-401T00")]).file;
  byKey(withOwn)
    .get("az-400t00")
    .pages.find((p) => p.page === "AZ-401").state = "confirmed";
  view = checkHub({
    file: withOwn,
    hubPages,
    cards: [],
    retiring,
    today: "2026-12-01",
  });
  assert.match(view.temporary[0].why, /AZ-401 has its own course now/);
});

test("a retiring Applied Skill built on a tracked course is reported", () => {
  const modulesOf = () => new Set(["/m/1"]);
  const { file } = sync(emptyFile(), [course("MS-4018")], {
    modulesOf,
    skills: [
      { slug: "streamline-business-workflows", modules: new Set(["/m/1"]) },
    ],
  });
  const view = checkHub({
    file,
    hubPages,
    cards: [],
    retiring,
    skillsCache: {
      retiring: [
        {
          name: "x",
          url: "https://learn.microsoft.com/credentials/applied-skills/streamline-business-workflows/",
        },
      ],
    },
    today: "2026-10-21",
  });
  assert.deepEqual(
    view.skills.map((s) => s.slug),
    ["streamline-business-workflows"],
  );
});

// ---------------------------------------------------------------------------
// The file and the report
// ---------------------------------------------------------------------------

test("the file round-trips as one course per line, sorted by key, and refuses what is wrong", () => {
  const { file } = sync(emptyFile(), [course("AZ-104T00"), course("AI-3026")], {
    propose: () => [suggestion("AI-103")],
  });
  const text = serializeFile(file);
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith('    {"key"')).length, 2);
  assert.ok(
    text.indexOf('"key":"ai-3026"') < text.indexOf('"key":"az-104t00"'),
  );
  assert.equal(comparable(parseFile(text)), comparable(file));
  assert.equal(serializeFile(parseFile(text)), text, "stable");
  const bad = (mutate) => {
    const copy = JSON.parse(text);
    mutate(copy);
    return JSON.stringify(copy);
  };
  assert.throws(() => parseFile("{"), /not valid JSON/);
  assert.throws(
    () => parseFile(bad((d) => (d.schemaVersion = 9))),
    /schemaVersion/,
  );
  assert.throws(
    () => parseFile(bad((d) => (d.courses[1].state = "maybe"))),
    /unknown state/,
  );
  assert.throws(
    () =>
      parseFile(
        bad(
          (d) =>
            (d.courses[0].pages = [
              { page: "AI-103", state: "confirmed", origin: "magic" },
            ]),
        ),
      ),
    /unknown origin/,
  );
  assert.throws(
    () => parseFile(bad((d) => d.courses.push({ ...d.courses[0] }))),
    /appears twice/,
  );
  assert.throws(
    () =>
      parseFile(
        bad(
          (d) =>
            (d.courses[0].pages = [
              { page: "103", state: "confirmed", origin: "exam" },
            ]),
        ),
      ),
    /not an exam page code/,
  );
  const active = bad((d) => {
    d.courses[0].state = "active";
    d.courses[0].pages = [];
  });
  assert.throws(() => parseFile(active), /needs a confirmed page/);
});

function viewOf(file, extra = {}) {
  return checkHub({
    file,
    hubPages,
    cards: [],
    retiring,
    today: "2026-10-21",
    ...extra,
  });
}

test("the report says nothing when nothing needs a person, and otherwise names every kind of work", () => {
  const quiet = sync(emptyFile(), [course("AZ-104T00")], {
    cards: [learnCard("az-104t00", "AZ-104")],
  }).file;
  const quietView = viewOf(quiet, {
    cards: [learnCard("az-104t00", "AZ-104")],
  });
  assert.equal(needsCount(quietView), 0);
  assert.equal(
    buildReport({
      file: quiet,
      view: quietView,
      changes: { added: [], removed: [], changed: [] },
      summary: summarize(quiet),
      date: "2026-10-21",
    }),
    "",
  );

  const { file, changes } = sync(
    emptyFile(),
    [course("AZ-104T00"), course("AZ-400T00"), course("AI-3026")],
    {
      propose: () => [suggestion("AI-103")],
    },
  );
  const view = viewOf(file);
  const report = buildReport({
    file,
    view,
    changes,
    summary: summarize(file),
    date: "2026-10-21",
  });
  assert.match(report, /^## Learn courses 2026-10-21/);
  assert.match(report, /### Courses waiting for a decision \(1\)/);
  assert.match(report, /\*\*AI-103\*\* likely \(shares 2 of 3 modules/);
  assert.match(
    report,
    /### Exam courses proposed for a replacement page \(1\)/,
  );
  assert.match(report, /### Confirmed pages that lack the course card \(2\)/);
  assert.match(report, /Nothing is placed automatically/);
});

test("the report caps its tables and the signature follows what needs a person and nothing else", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    course(`DP-30${String(i).padStart(2, "0")}`),
  );
  const { file, changes } = sync(emptyFile(), many);
  const view = viewOf(file);
  const report = buildReport({
    file,
    view,
    changes,
    summary: summarize(file),
    date: "2026-10-21",
    maxRows: 5,
  });
  assert.match(report, /\| \.\.\. 7 more \|/);
  const sig = signatureOf(view);
  assert.equal(sig, signatureOf(viewOf(file)), "stable");
  // a counter that is not work does not change it
  const next = sync(file, many, { today: "2026-10-28" }).file;
  assert.equal(signatureOf(viewOf(next)), sig);
  // one course decided: the work list changes
  byKey(file).get("dp-3000").state = "no-page";
  assert.notEqual(signatureOf(viewOf(file)), sig);
});

test("the cards a person would add: the Learn page, and the recording when there is one", () => {
  const exam = {
    key: "az-104t00",
    kind: "exam",
    code: "AZ-104",
    number: "AZ-104T00",
  };
  assert.deepEqual(suggestedCards(exam), [
    '<LinkCard title="Microsoft Learn" href="https://learn.microsoft.com/training/courses/az-104t00?WT.mc_id=studentamb_165290" target="_blank"/>',
  ]);
  const other = {
    key: "ai-3026",
    kind: "other",
    code: "AI-3026",
    number: "AI-3026",
  };
  assert.deepEqual(
    suggestedCards(other, new Map([["AI-3026", { playlist: "PL" }]])),
    [
      '<LinkCard title="Microsoft Learn AI-3026 Course" href="https://learn.microsoft.com/training/courses/ai-3026?WT.mc_id=studentamb_165290" target="_blank"/>',
      '<LinkCard title="Microsoft Learn AI-3026 Course on YouTube" href="https://aka.ms/AI-3026onYouTube" target="_blank"/>',
    ],
  );
  // a four-digit course's code says nothing about its topic: the Learn card carries the course title
  assert.deepEqual(
    suggestedCards({ ...other, title: 'Build "agents" with Foundry' }),
    [
      '<LinkCard title="Microsoft Learn AI-3026 Course" href="https://learn.microsoft.com/training/courses/ai-3026?WT.mc_id=studentamb_165290" target="_blank" description="Build &quot;agents&quot; with Foundry"/>',
    ],
  );
});

// ---------------------------------------------------------------------------
// The hub scan and the whole run
// ---------------------------------------------------------------------------

function put(dir, rel, text) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const page = (title, cards = "", extra = "") =>
  `---\ntitle: ${title}\n${extra}---\n${cards}\n`;
const card = (title, href) =>
  `<LinkCard title="${title}" href="${href}" target="_blank"/>`;

/** A temp hub with the files the run reads; `world` is a made-up learnsync. */
function world({ courses, skills = [], tracker = null, minCourses } = {}) {
  const base = mkdtempSync(join(tmpdir(), "learn-courses-"));
  dirs.push(base);
  put(
    base,
    "docs/azure/AZ-104.mdx",
    page(
      "AZ-104 Study Materials",
      card(
        "Microsoft Learn",
        "https://learn.microsoft.com/training/courses/az-104t00/?WT.mc_id=studentamb_165290",
      ),
    ),
  );
  put(base, "docs/azure/AZ-400.mdx", page("AZ-400 Study Materials"));
  put(base, "docs/azure/AZ-401.mdx", page("AZ-401 Study Materials"));
  put(base, "docs/azure/AI-103.mdx", page("AI-103 Study Materials"));
  put(
    base,
    "docs/azure/AZ-900.mdx",
    page("AZ-900 Study Materials", "", "draft: true\n"),
  );
  put(
    base,
    "archive/azure/AZ-800.mdx",
    page(
      "AZ-800 Study Materials",
      card(
        "Microsoft Learn",
        "https://learn.microsoft.com/training/courses/az-800t00/",
      ),
    ),
  );
  put(
    base,
    "exams.json",
    JSON.stringify({
      exams: ["AZ-104", "AZ-400", "AZ-401", "AI-103", "AZ-800"].map((code) => ({
        code,
      })),
    }),
  );
  put(
    base,
    "retiring.json",
    JSON.stringify({
      exams: [
        {
          code: "AZ-400",
          replacementCode: "AZ-401",
          retirementDate: "2027-02-01",
        },
      ],
    }),
  );
  put(base, "courses.json", JSON.stringify({ courses }));
  put(base, "skills.json", JSON.stringify({ appliedSkills: skills }));
  put(base, "videos.json", JSON.stringify({ courses: {} }));
  put(base, "skills-cache.json", JSON.stringify({ retiring: [] }));
  const trackerFile = join(base, "learn-courses.json");
  if (tracker) writeFileSync(trackerFile, tracker);
  const env = {
    COURSES_FILE: join(base, "courses.json"),
    SKILLS_FILE: join(base, "skills.json"),
    DOCS_DIR: join(base, "docs"),
    ARCHIVE_DIR: join(base, "archive"),
    LEARN_EXAMS_FILE: join(base, "exams.json"),
    RETIRING_FILE: join(base, "retiring.json"),
    SKILLS_CACHE_FILE: join(base, "skills-cache.json"),
    VIDEOS_FILE: join(base, "videos.json"),
    TRACKER_FILE: trackerFile,
    REPORT_FILE: join(base, "report.md"),
    ERROR_FILE: join(base, "error.md"),
    GITHUB_OUTPUT: join(base, "output"),
    MIN_COURSES: String(minCourses ?? courses.length),
    RETRY_BASE_MS: "0",
    FETCH_ATTEMPTS: "1",
    TODAY: "2026-10-21",
    CREATE_ISSUES: "1",
  };
  return {
    base,
    env,
    trackerFile,
    read: (rel) => readFileSync(join(base, rel), "utf8"),
    exists: (rel) => existsSync(join(base, rel)),
    put: (rel, text) => put(base, rel, text),
  };
}

const learnsync = {
  catalog: {
    modules: [
      { path: "/training/modules/m1", title: "M1", units: [] },
      { path: "/training/modules/m2", title: "M2", units: [] },
    ],
  },
  content: {
    learningPaths: [
      {
        uid: "learn.lp-skill",
        modules: ["/training/modules/m1", "/training/modules/m2"],
      },
    ],
  },
};
const worldOf = (propose) => ({ learnsync, propose });

function memoryGh() {
  const issues = [];
  const calls = [];
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const gh = (args, input) => {
    const command = args.slice(0, 2).join(" ");
    calls.push(command);
    if (command === "issue list")
      return JSON.stringify(
        issues
          .filter(
            (i) => i.state === "open" && i.label === flag(args, "--label"),
          )
          .map((i) => ({ number: i.number, title: i.title })),
      );
    if (command === "label create") return "";
    if (command === "issue create") {
      issues.push({
        number: issues.length + 1,
        title: flag(args, "--title"),
        label: flag(args, "--label"),
        body: input,
        state: "open",
        comments: [],
      });
      return `https://github.com/mscerts/hub/issues/${issues.length}`;
    }
    if (command === "issue comment")
      issues.find((i) => i.number === Number(args[2])).comments.push(input);
    if (command === "issue close")
      issues.find((i) => i.number === Number(args[2])).state = "closed";
    return "";
  };
  return { gh, issues, calls };
}

const COURSES = [
  course("AZ-104T00"),
  course("AZ-400T00"),
  course("AI-3026"),
  course("MS-4018", {
    study_guide: [{ uid: "learn.lp-skill", type: "learningPath" }],
  }),
];
const SKILLS = [
  {
    uid: "applied-skill.streamline",
    url: "https://learn.microsoft.com/en-us/credentials/applied-skills/streamline/",
    title: "Streamline",
    study_guide: [{ uid: "learn.lp-skill", type: "learningPath" }],
  },
];

test("the hub scan reads exam pages and course cards of the docs and the archive, without drafts and comments", () => {
  const w = world({ courses: COURSES });
  w.put(
    "docs/azure/AI-103.mdx",
    page(
      "AI-103",
      [
        card(
          "Microsoft Learn AI-3026 Course on YouTube",
          "https://aka.ms/AI-3026onYouTube",
        ),
        "{/* " +
          card("old", "https://learn.microsoft.com/training/courses/gone/") +
          " */}",
        card("Other", "https://example.com/x"),
      ].join("\n"),
    ),
  );
  w.put(
    "docs/guide/other.mdx",
    page(
      "Guide",
      card(
        "Course",
        "https://learn.microsoft.com/en-us/training/courses/az-104t00?x=1",
      ),
    ),
  );
  const { hubPages: pages, cards } = scanHub(loadConfig(w.env));
  assert.deepEqual(
    [...pages.keys()].sort(),
    ["AI-103", "AZ-104", "AZ-400", "AZ-401", "AZ-800"],
    "the draft AZ-900 is left out",
  );
  assert.equal(pages.get("AZ-800").archived, true);
  assert.equal(pages.get("AZ-104").archived, false);
  const summary = cards
    .map(
      (c) =>
        `${c.kind}:${c.key || c.code}@${c.page || "-"}${c.archived ? "(archive)" : ""}`,
    )
    .sort();
  assert.deepEqual(summary, [
    "learn:az-104t00@-",
    "learn:az-104t00@AZ-104",
    "learn:az-800t00@AZ-800(archive)",
    "youtube:AI-3026@AI-103",
  ]);
});

test("the first run builds the file, opens ONE issue and writes the file after it", async () => {
  const w = world({ courses: COURSES, skills: SKILLS });
  const github = memoryGh();
  const result = await run(loadConfig(w.env), {
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
    gh: github.gh,
    world: worldOf((c) =>
      c.course_number === "AI-3026" ? [suggestion("AI-103")] : [],
    ),
  });
  assert.equal(
    result.extractionFailed,
    false,
    w.exists("error.md") ? w.read("error.md") : "",
  );
  assert.equal(result.baselineUpdated, true);
  assert.equal(result.changesFound, true);
  const file = parseFile(w.read("learn-courses.json"));
  const map = byKey(file);
  assert.equal(map.get("az-104t00").state, "active");
  assert.deepEqual(map.get("ms-4018").skills, [
    { slug: "streamline", count: 2, total: 2 },
  ]);
  assert.equal(map.get("ai-3026").state, "new");
  assert.ok(file.reported.signature);
  assert.equal(github.issues.length, 1);
  assert.equal(github.issues[0].title, "Learn courses: decisions needed");
  assert.match(github.issues[0].body, /Courses waiting for a decision/);
  assert.match(
    github.issues[0].body,
    /Exam courses proposed for a replacement page/,
  );
  assert.match(w.read("report.md"), /Learn courses 2026-10-21/);
  assert.match(w.read("output"), /changes_found=true/);
  assert.match(w.read("output"), /baseline_updated=true/);
});

test("a second run with nothing new changes nothing and calls gh not at all", async () => {
  const w = world({ courses: COURSES, skills: SKILLS });
  const deps = {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    world: worldOf(() => [suggestion("AI-103")]),
  };
  await run(loadConfig(w.env), { ...deps, gh: memoryGh().gh });
  const before = w.read("learn-courses.json");
  const github = memoryGh();
  const result = await run(loadConfig(w.env), { ...deps, gh: github.gh });
  assert.equal(result.baselineUpdated, false);
  assert.equal(result.changesFound, false);
  assert.deepEqual(github.calls, []);
  assert.equal(w.read("learn-courses.json"), before);
});

test("the maintainer's decisions flow through: a confirmed page without a card is reported, the card closes it, and an empty list closes the issue", async () => {
  const w = world({ courses: COURSES, skills: SKILLS });
  const deps = {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    world: worldOf((c) =>
      c.course_number === "AI-3026" ? [suggestion("AI-103")] : [],
    ),
  };
  const github = memoryGh();
  await run(loadConfig(w.env), { ...deps, gh: github.gh });
  // decide: AI-3026 on AI-103 (confirmed), MS-4018 belongs to no page, AZ-400T00's replacement page rejected, AZ-400 gets its card
  const file = parseFile(w.read("learn-courses.json"));
  const map = byKey(file);
  map.get("ai-3026").pages.find((p) => p.page === "AI-103").state = "confirmed";
  map.get("ms-4018").state = "no-page";
  map.get("az-400t00").pages.find((p) => p.page === "AZ-401").state =
    "rejected";
  writeFileSync(w.trackerFile, serializeFile(file));
  w.put(
    "docs/azure/AZ-400.mdx",
    page(
      "AZ-400",
      card(
        "Microsoft Learn",
        "https://learn.microsoft.com/training/courses/az-400t00/",
      ),
    ),
  );
  const second = await run(loadConfig(w.env), { ...deps, gh: github.gh });
  assert.equal(second.changesFound, true);
  assert.equal(github.issues.length, 1, "a comment, never a second issue");
  assert.equal(github.issues[0].comments.length, 1);
  assert.match(
    github.issues[0].comments[0],
    /Confirmed pages that lack the course card/,
  );
  assert.match(github.issues[0].comments[0], /AI-103\.mdx/);
  assert.ok(
    !/Courses waiting for a decision/.test(github.issues[0].comments[0]),
  );
  // the card is added: nothing is left, the issue is closed
  w.put(
    "docs/azure/AI-103.mdx",
    page(
      "AI-103",
      card(
        "Microsoft Learn AI-3026 Course",
        "https://learn.microsoft.com/training/courses/ai-3026?WT.mc_id=studentamb_165290",
      ),
    ),
  );
  const third = await run(loadConfig(w.env), { ...deps, gh: github.gh });
  assert.equal(third.changesFound, false);
  assert.equal(github.issues[0].state, "closed");
  assert.equal(w.read("report.md"), "");
});

test("a local run without CREATE_ISSUES does not mark the list as reported, so the first run with issues still opens the issue", async () => {
  const w = world({ courses: COURSES });
  const deps = {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    world: worldOf(() => []),
  };
  await run(loadConfig({ ...w.env, CREATE_ISSUES: "0" }), { ...deps });
  assert.equal(
    parseFile(w.read("learn-courses.json")).reported.signature,
    null,
  );
  const github = memoryGh();
  await run(loadConfig(w.env), { ...deps, gh: github.gh });
  assert.equal(github.issues.length, 1);
});

test("--check writes no file and touches no issue", async () => {
  const w = world({ courses: COURSES });
  const github = memoryGh();
  const result = await run(loadConfig(w.env), {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    gh: github.gh,
    checkOnly: true,
    world: worldOf(() => []),
  });
  assert.equal(result.extractionFailed, false);
  assert.ok(!w.exists("learn-courses.json"));
  assert.deepEqual(github.calls, []);
  assert.ok(w.exists("report.md"));
});

test("failsafes: a catalog that is too small, a mass disappearance, a corrupt file and an unreadable course list stop the run with nothing written", async () => {
  const deps = (courses) => ({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    gh: memoryGh().gh,
    world: worldOf(() => []),
    courses,
  });
  // too few courses
  const small = world({ courses: COURSES, minCourses: 50 });
  const r1 = await run(loadConfig(small.env), deps());
  assert.equal(r1.extractionFailed, true);
  assert.match(small.read("error.md"), /fewer than MIN_COURSES/);
  assert.ok(!small.exists("learn-courses.json"));
  assert.match(small.read("output"), /extraction_failed=true/);
  // a mass disappearance (needs 20 tracked courses)
  const lots = Array.from({ length: 30 }, (_, i) =>
    course(`DP-3${String(100 + i)}`),
  );
  const w = world({ courses: lots, minCourses: 5 });
  await run(loadConfig(w.env), {
    fetchImpl: async () => {
      throw new Error("x");
    },
    gh: memoryGh().gh,
    world: worldOf(() => []),
  });
  const before = w.read("learn-courses.json");
  w.put("courses.json", JSON.stringify({ courses: lots.slice(0, 10) }));
  const r2 = await run(loadConfig(w.env), {
    fetchImpl: async () => {
      throw new Error("x");
    },
    gh: memoryGh().gh,
    world: worldOf(() => []),
  });
  assert.equal(r2.extractionFailed, true);
  assert.match(w.read("error.md"), /missing from the catalog at once/);
  assert.equal(w.read("learn-courses.json"), before, "nothing was written");
  const forced = await run(loadConfig({ ...w.env, FORCE_BASELINE: "1" }), {
    fetchImpl: async () => {
      throw new Error("x");
    },
    gh: memoryGh().gh,
    world: worldOf(() => []),
  });
  assert.equal(forced.extractionFailed, false);
  // a corrupt file
  const corrupt = world({ courses: COURSES, tracker: "{ not json" });
  const r3 = await run(loadConfig(corrupt.env), deps());
  assert.equal(r3.extractionFailed, true);
  assert.equal(
    corrupt.read("learn-courses.json"),
    "{ not json",
    "the file is left alone",
  );
  // an unreadable course list
  const none = world({ courses: COURSES });
  rmSync(join(none.base, "courses.json"));
  const r4 = await run(loadConfig(none.env), deps());
  assert.equal(r4.extractionFailed, true);
});

test("when the Applied Skills list cannot be read the run goes on and the skills stay as they were", async () => {
  const w = world({ courses: COURSES, skills: SKILLS });
  const deps = {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    gh: memoryGh().gh,
    world: worldOf(() => []),
  };
  await run(loadConfig(w.env), deps);
  rmSync(join(w.base, "skills.json"));
  const result = await run(loadConfig(w.env), deps);
  assert.equal(result.extractionFailed, false);
  assert.deepEqual(
    byKey(parseFile(w.read("learn-courses.json"))).get("ms-4018").skills,
    [{ slug: "streamline", count: 2, total: 2 }],
  );
  assert.match(w.read("report.md"), /Applied Skills list could not be read/);
});

test("the issue helper stays quiet with the same list and closes the issue only if one was reported", () => {
  const cfg = loadConfig({ CREATE_ISSUES: "1" });
  const github = memoryGh();
  assert.equal(
    syncIssue(
      cfg,
      { report: "x", signature: "s", previous: { signature: "s" } },
      github.gh,
    ).action,
    "none",
  );
  assert.equal(
    syncIssue(
      cfg,
      { report: "", signature: null, previous: { signature: null } },
      github.gh,
    ).action,
    "none",
  );
  assert.deepEqual(github.calls, []);
  assert.equal(
    syncIssue(
      loadConfig({}),
      { report: "x", signature: "s", previous: null },
      github.gh,
    ).action,
    "skipped",
  );
});
