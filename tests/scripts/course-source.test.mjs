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
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  COURSES_URL,
  LEARNSYNC_RAW,
  fetchCourses,
  loadLearnsync,
  main,
  readGuides,
} from "../../scripts/course-source.mjs";

const fixtures = resolve(import.meta.dirname, "../fixtures/course-source");
const fixture = (code) =>
  JSON.parse(readFileSync(join(fixtures, `guide-${code}.json`), "utf8"));

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const COURSES = [
  {
    course_number: "AZ-104T00",
    title: "Microsoft Azure Administrator",
    url: "https://learn.microsoft.com/en-us/training/courses/az-104t00/",
    last_modified: "2026-01-01T00:00:00Z",
    study_guide: [{ uid: "learn.path-1", type: "learningPath" }],
  },
];
const CATALOG = {
  modules: [
    {
      uid: "learn.a",
      path: "/training/modules/a",
      title: "Module a",
      unitSig: "s",
      units: ["Intro"],
    },
  ],
};
const CONTENT = {
  learningPaths: [
    {
      uid: "learn.path-1",
      title: "Path 1",
      path: "/training/paths/path-1",
      modules: ["/training/modules/a"],
    },
  ],
};
const LINKS = {
  lastChecked: "2026-10-16T00:00:00Z",
  modules: [
    {
      path: "/training/modules/a",
      unitSig: "s",
      unit: "/training/modules/a/2-summary",
      links: [
        { kind: "docs", path: "/azure/a", text: "A", section: "Learn more" },
      ],
    },
  ],
};

/** A repo root with a tracker file (and a sibling learnsync checkout when `withLearnsync`). */
function world({
  guides = ["AZ-104"],
  withLearnsync = true,
  links = true,
} = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-source-"));
  temps.push(base);
  const root = join(base, "hub");
  mkdirSync(join(root, "src", "data_files"), { recursive: true });
  const studyGuides = guides.map((code) => {
    const g = fixture(code);
    return {
      code: g.code,
      name: g.name,
      hash: g.hash,
      updatedAt: g.updatedAt,
      lines: g.lines,
    };
  });
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({ studyGuides }),
  );
  const dir = join(base, "learnsync");
  if (withLearnsync) {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "data", "learn-catalog.json"),
      JSON.stringify(CATALOG),
    );
    writeFileSync(
      join(dir, "data", "learn-content.json"),
      JSON.stringify(CONTENT),
    );
    if (links)
      writeFileSync(
        join(dir, "data", "module-links.json"),
        JSON.stringify(LINKS),
      );
  }
  return { base, root, dir };
}

function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("", { status: 404 });
    if (typeof body === "number") return new Response("", { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { impl, calls };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
  };
}

test("readGuides keeps the guides that have text and rejects an unreadable tracker", () => {
  const { root } = world({ guides: ["AZ-104", "GH-900"] });
  const file = join(root, "src", "data_files", "learn-exams.json");
  writeFileSync(
    file,
    JSON.stringify({
      studyGuides: [
        { code: "AZ-104", lines: ["## x"] },
        { code: "AZ-305", lastmod: "2026-01-01" },
      ],
    }),
  );
  assert.deepEqual([...readGuides(file).keys()], ["AZ-104"]);
  assert.throws(() => readGuides(join(root, "nope.json")), /Cannot read/);
  writeFileSync(file, JSON.stringify({ exams: [] }));
  assert.throws(() => readGuides(file), /no studyGuides list/);
});

test("an exam code builds the guide tree and the scope map into the output folder", async () => {
  const { root, dir, base } = world();
  const c = capture();
  const out = join(base, "out");
  const code = await main(["az-104", "--out", out], {
    env: { LEARNSYNC_DIR: dir },
    root,
    fetchImpl: fakeFetch({ [COURSES_URL]: { courses: COURSES } }).impl,
    log: c.log,
    error: c.error,
  });
  assert.equal(code, 0, c.err.join("\n"));
  const guide = JSON.parse(
    readFileSync(join(out, "AZ-104.guide.json"), "utf8"),
  );
  assert.equal(guide.code, "AZ-104");
  assert.equal(guide.ok, true);
  assert.deepEqual(guide.stats, { domains: 5, groups: 15, tasks: 82 });
  assert.equal(
    guide.hash,
    fixture("AZ-104").hash,
    "the guide's hash travels with its tree",
  );
  const scope = JSON.parse(
    readFileSync(join(out, "AZ-104.scope.json"), "utf8"),
  );
  assert.equal(scope.ok, true);
  assert.deepEqual(
    scope.modules.map((m) => m.path),
    ["/training/modules/a"],
  );
  assert.equal(scope.modules[0].resources.links[0].path, "/azure/a");
  assert.equal(scope.learnsync, dir);
  const text = c.out.join("\n");
  assert.match(
    text,
    /Guide: parsed - 5 domains, 15 groups, 82 tasks, skills measured as of April 17, 2026/,
  );
  assert.match(
    text,
    /Scope: AZ-104T00 - 1 learning paths, 1 modules, 1 with resource links/,
  );
});

test("an exam without an official course still succeeds, with a warning and an empty scope", async () => {
  const { root, dir, base } = world({ guides: ["GH-900"] });
  const c = capture();
  const code = await main(["GH-900", "--out", join(base, "out")], {
    env: { LEARNSYNC_DIR: dir },
    root,
    fetchImpl: fakeFetch({ [COURSES_URL]: { courses: COURSES } }).impl,
    log: c.log,
    error: c.error,
  });
  assert.equal(code, 0);
  assert.match(c.out.join("\n"), /no official course found for GH-900/);
  assert.equal(
    JSON.parse(readFileSync(join(base, "out", "GH-900.scope.json"), "utf8")).ok,
    false,
  );
});

test("without a learnsync checkout the data comes from GitHub, and missing module links are a warning", async () => {
  const { root, base } = world({ withLearnsync: false });
  const web = fakeFetch({
    [COURSES_URL]: { courses: COURSES },
    [`${LEARNSYNC_RAW}/learn-catalog.json`]: CATALOG,
    [`${LEARNSYNC_RAW}/learn-content.json`]: CONTENT,
  });
  const c = capture();
  const code = await main(["AZ-104", "--out", join(base, "out")], {
    env: {},
    root,
    fetchImpl: web.impl,
    log: c.log,
    error: c.error,
  });
  assert.equal(code, 0, c.err.join("\n"));
  assert.ok(web.calls.includes(`${LEARNSYNC_RAW}/learn-catalog.json`));
  assert.match(
    c.out.join("\n"),
    /module-links\.json is not on learnsync main yet/,
  );
  const scope = JSON.parse(
    readFileSync(join(base, "out", "AZ-104.scope.json"), "utf8"),
  );
  assert.equal(scope.modules[0].resources, null);
});

test("loadLearnsync and fetchCourses fail loudly on data they cannot use", async () => {
  await assert.rejects(
    loadLearnsync({ dir: null, fetchImpl: fakeFetch({}).impl }),
    /has no learn-catalog\.json/,
  );
  await assert.rejects(
    fetchCourses(fakeFetch({ [COURSES_URL]: { nope: [] } }).impl),
    /no courses list/,
  );
  await assert.rejects(
    fetchCourses(fakeFetch({ [COURSES_URL]: 503 }).impl),
    /HTTP 503/,
  );
  const { dir } = world({ links: false });
  const loaded = await loadLearnsync({ dir, fetchImpl: fakeFetch({}).impl });
  assert.equal(loaded.moduleLinks, null);
  assert.match(loaded.warnings[0], /not in the learnsync checkout/);
});

test("a data problem is exit code 2 with a message, not a stack trace", async () => {
  const { root, dir } = world();
  const c = capture();
  const code = await main(["AZ-104"], {
    env: { LEARNSYNC_DIR: dir },
    root,
    fetchImpl: fakeFetch({ [COURSES_URL]: 500 }).impl,
    log: c.log,
    error: c.error,
  });
  assert.equal(code, 2);
  assert.match(c.err.join("\n"), /Cannot load the Learn data: .* HTTP 500/);
});

test("usage errors: no arguments, unknown option, two codes, a code with no stored guide", async () => {
  const { root } = world();
  for (const [argv, expected] of [
    [[], /Usage/],
    [["--nope"], /Unknown option --nope/],
    [["AZ-104", "AZ-305"], /Only one exam code/],
    [["AZ-104", "--out"], /--out needs a value/],
    [["AZ-305"], /No stored study guide text for AZ-305/],
  ]) {
    const c = capture();
    assert.equal(
      await main(argv, { env: {}, root, log: c.log, error: c.error }),
      2,
      argv.join(" "),
    );
    assert.match([...c.out, ...c.err].join("\n"), expected);
  }
  const help = capture();
  assert.equal(
    await main(["--help"], { env: {}, root, log: help.log, error: help.error }),
    0,
  );
});

test("--check compares a course page with the guide: 0 when they match, 1 with the differences", async () => {
  const { root, base } = world();
  const c0 = capture();
  // build a course page from the guide's own headings through the parser
  const { parseGuide } = await import("../../scripts/lib/course-guide.mjs");
  const parsed = parseGuide(fixture("AZ-104").lines);
  const page = (rename) =>
    parsed.domains
      .map((d) =>
        [
          `## ${d.title} (${d.weight.min}–${d.weight.max}%)`,
          ...d.groups.flatMap((g) => [
            `### ${rename && g.title === "Manage storage accounts" ? "Manage storage" : g.title}`,
            ...g.tasks.map((t) => `#### ${t.text}`),
          ]),
        ].join("\n"),
      )
      .join("\n");
  const good = join(base, "good.mdx");
  writeFileSync(good, page(false));
  assert.equal(
    await main(["AZ-104", "--check", good], {
      env: {},
      root,
      log: c0.log,
      error: c0.error,
    }),
    0,
  );
  assert.match(
    c0.out.join("\n"),
    /matches the AZ-104 study guide \(5 domains, 15 groups, 82 tasks/,
  );
  const bad = join(base, "bad.mdx");
  writeFileSync(
    bad,
    page(true).replace("#### Create users and groups", "#### Create users"),
  );
  const c1 = capture();
  assert.equal(
    await main(["AZ-104", "--check", bad], {
      env: {},
      root,
      log: c1.log,
      error: c1.error,
    }),
    1,
  );
  assert.match(c1.out.join("\n"), /missing-task: .*Create users and groups/);
  assert.match(c1.out.join("\n"), /extra-task: .*Create users/);
  const c2 = capture();
  assert.equal(
    await main(["AZ-104", "--check", join(base, "absent.mdx")], {
      env: {},
      root,
      log: c2.log,
      error: c2.error,
    }),
    2,
  );
});

test("--survey lists every stored guide and exits 1 when one does not parse completely", async () => {
  const { root } = world({ guides: ["AZ-104", "GH-900", "MB-310"] });
  const c = capture();
  assert.equal(
    await main(["--survey"], { env: {}, root, log: c.log, error: c.error }),
    0,
  );
  const text = c.out.join("\n");
  assert.match(text, /AZ-104 +ok +5 domains, 15 groups, 82 tasks/);
  assert.match(
    text,
    /GH-900 +ok +7 domains, 8 groups, 36 tasks, skills measured as of January 2026 +\[1 warning\]/,
  );
  assert.match(text, /3 guides, 0 not parsed completely, 214 tasks/);
  // a guide the parser cannot read
  const file = join(root, "src", "data_files", "learn-exams.json");
  const tracker = JSON.parse(readFileSync(file, "utf8"));
  tracker.studyGuides.push({
    code: "ZZ-999",
    name: "Broken",
    lines: ["## Nothing useful"],
  });
  writeFileSync(file, JSON.stringify(tracker));
  const c2 = capture();
  assert.equal(
    await main(["--survey"], { env: {}, root, log: c2.log, error: c2.error }),
    1,
  );
  assert.match(c2.out.join("\n"), /ZZ-999 +BAD/);
});

test("the tool writes only where asked", async () => {
  const { root, dir, base } = world();
  const out = join(base, "only-here");
  const c = capture();
  await main(["AZ-104", "--out", out], {
    env: { LEARNSYNC_DIR: dir },
    root,
    fetchImpl: fakeFetch({ [COURSES_URL]: { courses: COURSES } }).impl,
    log: c.log,
    error: c.error,
  });
  assert.ok(existsSync(join(out, "AZ-104.guide.json")));
  assert.equal(existsSync(join(root, "AZ-104.guide.json")), false);
});
