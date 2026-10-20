import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildPools } from "../../scripts/lib/course-candidates.mjs";
import {
  PLACEMENT_DEFAULTS,
  buildGuideIndex,
  confidenceOf,
  courseCode,
  courseModules,
  courseProfile,
  coveredByModules,
  describeSuggestion,
  suggestExams,
} from "../../scripts/lib/course-placement.mjs";
import {
  courseFromPlaylist,
  findCourse,
  loadPlacement,
  main,
  placeCourse,
} from "../../scripts/course-placement.mjs";
import {
  parsedGuides,
  placementWorld,
  writeGuidesFile,
  writeLearnsync,
} from "./helpers/example-placement.mjs";

const tempDirs = [];
async function tempDir(prefix = "course-placement-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Everything the lib reads, built the way loadPlacement builds it. */
function libWorld(world = placementWorld()) {
  const guides = parsedGuides();
  return {
    world,
    guides,
    guideIndex: buildGuideIndex(guides),
    pools: buildPools({
      catalog: world.catalog,
      courses: world.courses,
      learningPaths: world.learningPaths,
    }),
  };
}

function suggest(env, number, options) {
  const course = env.world.courses.find((c) => c.course_number === number);
  const { modules } = courseModules(course, {
    learningPaths: env.world.learningPaths,
    modules: env.world.catalog.modules,
  });
  return {
    course,
    modules,
    ...suggestExams({
      course,
      modules,
      guides: env.guides,
      guideIndex: env.guideIndex,
      pools: env.pools,
      options,
    }),
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
test("courseCode turns a course number into the code of its short link", () => {
  assert.equal(courseCode("AZ-104T00-A"), "AZ-104");
  assert.equal(courseCode("SC-5006"), "SC-5006");
  assert.equal(courseCode("MSLEAIBootcampFUN"), "");
});

test("courseModules follows learning paths and modules and reports what it cannot resolve", () => {
  const world = placementWorld();
  const found = courseModules(world.courses[2], {
    learningPaths: world.learningPaths,
    modules: world.catalog.modules,
  }); // XX-1001: one learning path
  assert.deepEqual(
    found.modules.map((m) => m.title),
    [
      "Configure virtual networks and user-defined routes",
      "Explore virtual network peering",
    ],
  );
  assert.deepEqual(found.unresolved, []);

  // A course entry that is a module (not a path), one that is neither, and a path whose module is gone.
  const odd = {
    study_guide: [
      { uid: "learn.journals", type: "module" },
      { uid: "learn.nothing", type: "learningPath" },
      { uid: "learn.wwl.gone-path", type: "learningPath" },
    ],
  };
  const learningPaths = [
    ...world.learningPaths,
    {
      uid: "learn.wwl.gone-path",
      modules: ["/training/modules/removed-one", "/training/modules/journals"],
    },
  ];
  const result = courseModules(odd, {
    learningPaths,
    modules: world.catalog.modules,
  });
  assert.deepEqual(
    result.modules.map((m) => m.path),
    ["/training/modules/journals"],
  );
  assert.deepEqual(result.unresolved, ["learn.nothing"]);
  assert.equal(result.missing, 1);
});

test("courseProfile is the title twice and the title of every module", () => {
  assert.equal(
    courseProfile({ title: "T" }, [{ title: "A" }, { title: "B" }]),
    "T . T . A . B",
  );
  assert.equal(courseProfile({ title: "" }, []), "");
});

test("confidenceOf names the evidence behind a suggestion", () => {
  assert.equal(confidenceOf(4), "strong");
  assert.equal(confidenceOf(3), "strong");
  assert.equal(confidenceOf(2.5), "likely");
  assert.equal(confidenceOf(2), "likely");
  assert.equal(confidenceOf(1.5), "possible");
  assert.equal(confidenceOf(1), "possible");
});

test("coveredByModules names the skill groups whose words the modules contain", () => {
  const env = libWorld();
  const paths = new Set(["/training/modules/credit-collections"]);
  const finance = coveredByModules(
    env.guides.get("MB-310").tree,
    paths,
    env.pools,
    PLACEMENT_DEFAULTS,
  );
  assert.ok(
    finance.groups.includes("Manage credit and collections"),
    finance.groups.join("|"),
  );
  // Another exam's guide has no such group.
  const azure = coveredByModules(
    env.guides.get("AZ-104").tree,
    paths,
    env.pools,
    PLACEMENT_DEFAULTS,
  );
  assert.deepEqual(azure.groups, []);
  // No modules, nothing covered.
  assert.deepEqual(
    coveredByModules(
      env.guides.get("MB-310").tree,
      new Set(),
      env.pools,
      PLACEMENT_DEFAULTS,
    ),
    { groups: [], tasks: 0 },
  );
});

// ---------------------------------------------------------------------------
// The suggestions
// ---------------------------------------------------------------------------
test("a course that shares modules with an exam's official course names that exam first, with all its evidence", () => {
  const env = libWorld();
  const { suggestions, note } = suggest(env, "XX-1001");
  assert.equal(note, null);
  const [first] = suggestions;
  assert.equal(first.exam, "AZ-104");
  assert.equal(first.name, "Microsoft Azure Administrator");
  assert.equal(first.confidence, "strong");
  assert.ok(first.points >= 3);
  assert.deepEqual(first.reasons.shared, {
    count: 1,
    total: 2,
    modules: ["Configure virtual networks and user-defined routes"],
    strong: true,
  });
  assert.equal(first.reasons.guide.rank, 1);
  assert.ok(first.reasons.guide.words.includes("routes"));
  assert.ok(first.reasons.groups.tasks > 0);
  const line = describeSuggestion(first);
  assert.match(
    line,
    /^AZ-104, strong \(shares 1 of 2 modules with its official course; guide match #1: /,
  );
  assert.match(line, /covers \d+ tasks?\)$/);
  // The list is in order of the evidence.
  const points = suggestions.map((s) => s.points);
  assert.deepEqual(
    points,
    [...points].sort((a, b) => b - a),
  );
});

test("a course nobody's course contains is matched by the study guides and the skill groups it covers", () => {
  const env = libWorld();
  const { suggestions } = suggest(env, "XX-2002");
  assert.equal(suggestions[0].exam, "MB-310");
  assert.equal(suggestions[0].confidence, "likely");
  assert.equal(suggestions[0].reasons.shared, null);
  assert.deepEqual(suggestions[0].reasons.groups.groups, [
    "Manage credit and collections",
  ]);
  assert.match(
    describeSuggestion(suggestions[0]),
    /^MB-310, likely \(guide match #1: .*; covers the skill group “Manage credit and collections”\)$/,
  );
});

test("a course whose learning paths are not in the catalog is matched by its title alone", () => {
  const env = libWorld();
  const { suggestions, modules } = suggest(env, "XX-4004");
  assert.equal(modules.length, 0);
  assert.equal(suggestions[0].exam, "AZ-104");
  assert.equal(suggestions[0].reasons.shared, null);
  assert.equal(suggestions[0].reasons.groups, null);
  assert.ok(suggestions[0].reasons.guide.words.includes("entra"));
});

test("a course that is too generic gets no suggestion and the reason why", () => {
  const env = libWorld();
  const { suggestions, note } = suggest(env, "XX-3003");
  assert.deepEqual(suggestions, []);
  assert.match(note, /probably not tied to an exam/);
  const none = suggestExams({
    course: { title: "Work smarter" },
    modules: [],
    guides: env.guides,
    guideIndex: env.guideIndex,
    pools: env.pools,
  });
  assert.match(
    none.note,
    /no modules in the catalog and its title is too generic/,
  );
});

test("an exam's own course is never a suggestion for itself", () => {
  const env = libWorld();
  const { suggestions } = suggest(env, "AZ-104T00-A");
  assert.ok(suggestions.every((s) => s.exam !== "AZ-104"));
});

test("a small overlap of modules is a reason, not a suggestion; the thresholds can be changed", () => {
  const env = libWorld();
  // 1 of 2 modules is 50%: strong at the default 30%, weak when 60% is asked for.
  const strict = suggest(env, "XX-1001", { minSharedShare: 0.6 });
  const az = strict.suggestions.find((s) => s.exam === "AZ-104");
  assert.equal(az.reasons.shared.strong, false);
  assert.ok(az.points < suggest(env, "XX-1001").suggestions[0].points);
  // Two suggestions at most when asked.
  assert.equal(
    suggest(env, "XX-1001", { maxSuggestions: 2 }).suggestions.length,
    2,
  );
  // Nothing at all passes an impossible guide coverage and no groups.
  const none = suggest(env, "XX-2002", {
    minGuideCoverage: 2,
    groupCoverage: 2,
  });
  assert.deepEqual(none.suggestions, []);
});

test("describeSuggestion shortens long lists of skill groups", () => {
  const line = describeSuggestion({
    exam: "AB-620",
    confidence: "possible",
    reasons: {
      shared: null,
      guide: null,
      groups: { groups: ["A", "B", "C"], tasks: 0 },
    },
  });
  assert.equal(
    line,
    "AB-620, possible (covers the skill groups “A”, “B” and 1 more)",
  );
  assert.equal(describeSuggestion({ exam: "X-1", reasons: {} }), "X-1");
});

// ---------------------------------------------------------------------------
// The loader and the command line
// ---------------------------------------------------------------------------
async function setup() {
  const dir = await tempDir();
  const world = placementWorld();
  await writeLearnsync(join(dir, "learnsync"), world);
  const guidesFile = await writeGuidesFile(join(dir, "learn-exams.json"));
  const root = join(dir, "repo");
  await mkdir(join(root, "src", "content", "docs", "azure"), {
    recursive: true,
  });
  await mkdir(join(root, "src", "data_files"), { recursive: true });
  const env = {
    LEARNSYNC_DIR: join(dir, "learnsync"),
    LEARN_EXAMS_FILE: guidesFile,
    COURSE_VIDEOS_FILE: join(root, "src", "data_files", "course-videos.json"),
  };
  const fetchImpl = async (url) => {
    assert.match(String(url), /api\/catalog\/\?type=courses/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ courses: world.courses }),
    };
  };
  return { dir, root, world, env, fetchImpl };
}

function capture() {
  const out = {
    lines: [],
    errors: [],
    log: (line) => out.lines.push(line),
    error: (line) => out.errors.push(line),
  };
  return out;
}

test("loadPlacement reads the learnsync checkout, the stored guides and the course list", async () => {
  const { root, env, fetchImpl } = await setup();
  const loaded = await loadPlacement({ root, env, fetchImpl });
  assert.equal(loaded.courses.length, 6);
  assert.deepEqual([...loaded.guides.keys()].sort(), [
    "AB-100",
    "AZ-104",
    "GH-900",
    "MB-310",
  ]);
  assert.deepEqual(loaded.skipped, []);
  assert.equal(findCourse(loaded.courses, "xx-1001").course_number, "XX-1001");
  assert.equal(
    findCourse(loaded.courses, "AZ-104").course_number,
    "AZ-104T00-A",
  );
  assert.equal(findCourse(loaded.courses, "NOPE-1"), null);
  const result = placeCourse(loaded, findCourse(loaded.courses, "XX-1001"));
  assert.equal(result.code, "XX-1001");
  assert.equal(result.modules, 2);
  assert.equal(result.suggestions[0].exam, "AZ-104");
  // Passing the course list in saves the request.
  const again = await loadPlacement({
    root,
    env,
    courses: loaded.courses,
    fetchImpl: async () => assert.fail("the course list was passed in"),
  });
  assert.equal(again.courses.length, 6);
});

test("the command line prints the suggestions with their evidence, or JSON", async () => {
  const { root, env, fetchImpl } = await setup();
  const text = capture();
  assert.equal(
    await main(["XX-1001", "xx-3003"], { root, env, fetchImpl, ...text }),
    0,
  );
  assert.equal(text.errors.length, 0);
  assert.match(
    text.lines[0],
    /^XX-1001  Extend virtual networks with routes and peering  \(2 modules\)$/,
  );
  assert.match(
    text.lines[1],
    /^ {4}1\. AZ-104, strong \(shares 1 of 2 modules/,
  );
  assert.match(text.lines[1], /Microsoft Azure Administrator$/);
  assert.ok(text.lines.some((l) => /^XX-3003 .*\(1 module\)$/.test(l)));
  assert.ok(
    text.lines.some((l) => /no suggestion: .*not tied to an exam/.test(l)),
  );

  const json = capture();
  assert.equal(
    await main(["--json", "XX-2002"], { root, env, fetchImpl, ...json }),
    0,
  );
  const [result] = JSON.parse(json.lines.join("\n"));
  assert.equal(result.code, "XX-2002");
  assert.equal(result.suggestions[0].exam, "MB-310");
});

test("the command line refuses what it cannot do and says why", async () => {
  const { root, env, fetchImpl } = await setup();
  for (const [argv, pattern] of [
    [[], /A course code or --unplaced is required/],
    [["--unplaced", "XX-1001"], /--unplaced takes no course codes/],
    [["--bogus"], /Unknown option --bogus/],
  ]) {
    const io = capture();
    assert.equal(await main(argv, { root, env, fetchImpl, ...io }), 2);
    assert.match(io.errors[0], pattern);
    assert.match(io.errors[0], /Usage: node scripts\/course-placement\.mjs/);
  }
  const unknown = capture();
  assert.equal(
    await main(["QQ-9999"], { root, env, fetchImpl, ...unknown }),
    2,
  );
  assert.match(
    unknown.errors[0],
    /No course QQ-9999 in the Learn catalog, and no playlist title/,
  );
  const noData = capture();
  assert.equal(
    await main(["XX-1001"], {
      root,
      env: { ...env, LEARNSYNC_DIR: join(root, "missing") },
      fetchImpl,
      ...noData,
    }),
    2,
  );
  assert.match(noData.errors[0], /Cannot load the inputs/);
});

/** A fake YouTube oEmbed endpoint answering with the given titles by playlist id. */
async function fakeOembed(titles) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const id = new URL(url.searchParams.get("url")).searchParams.get("list");
    if (titles[id]) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ title: titles[id] }));
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}/oembed`;
}

test("a course the catalog does not list is matched by its playlist title", async () => {
  const { root, env, fetchImpl } = await setup();
  const PLAYLIST = "PLtest0000000000000000000005";
  const oembed = await fakeOembed({
    [PLAYLIST]: "XX-5005: Create users and groups in Microsoft Entra",
  });
  await writeFile(
    env.COURSE_VIDEOS_FILE,
    JSON.stringify({
      courses: { "XX-5005": { playlist: PLAYLIST, since: "2026-10-20" } },
    }),
  );
  const withOembed = { ...env, OEMBED_URL: oembed };
  const course = await courseFromPlaylist("XX-5005", { root, env: withOembed });
  assert.deepEqual(course, {
    course_number: "XX-5005",
    title: "Create users and groups in Microsoft Entra",
    study_guide: [],
    fromPlaylist: true,
  });
  assert.equal(
    await courseFromPlaylist("XX-6006", { root, env: withOembed }),
    null,
  );
  assert.equal(
    await courseFromPlaylist("XX-5005", {
      root,
      env: {
        ...env,
        // nothing listens here: the title cannot be read
        OEMBED_URL: "http://127.0.0.1:9/oembed",
      },
    }),
    null,
  );

  const io = capture();
  assert.equal(
    await main(["XX-5005"], { root, env: withOembed, fetchImpl, ...io }),
    0,
  );
  assert.match(
    io.lines[0],
    /^XX-5005  Create users and groups in Microsoft Entra  \(not in the Learn catalog: matched by its playlist title only\)$/,
  );
  assert.match(io.lines[1], /^ {4}1\. AZ-104, possible \(guide match #1:/);
});

test("--unplaced lists the courses that resolve to a playlist and have no exam page and no card", async () => {
  const { root, env, fetchImpl } = await setup();
  const docs = join(root, "src", "content", "docs", "azure");
  await writeFile(join(docs, "AZ-104.mdx"), "# AZ-104\n");
  await writeFile(
    join(docs, "AZ-900.mdx"),
    '<LinkCard title="Microsoft Learn XX-2002 Course on YouTube" href="https://aka.ms/XX-2002onYouTube" target="_blank"/>\n',
  );
  const entry = (n) => ({
    playlist: `PLtest000000000000000000000${n}`,
    since: "2026-10-20",
  });
  await writeFile(
    env.COURSE_VIDEOS_FILE,
    JSON.stringify({
      courses: {
        "AZ-104": entry(1), // an exam page
        "XX-2002": entry(2), // a card
        "XX-2003": entry(2), // the same recording as XX-2002, so the same card
        "XX-1001": entry(3), // neither
        "XX-3003": entry(4), // neither
      },
    }),
  );
  const io = capture();
  assert.equal(await main(["--unplaced"], { root, env, fetchImpl, ...io }), 0);
  const heads = io.lines.filter((l) => /^[A-Z]{2}-\d{4}  /.test(l));
  assert.deepEqual(
    heads.map((l) => l.slice(0, 7)),
    ["XX-1001", "XX-3003"],
  );
});
