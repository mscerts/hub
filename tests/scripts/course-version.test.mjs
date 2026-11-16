import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { main, plan } from "../../scripts/course-versions-backfill.mjs";
import {
  guideVersionProblem,
  validateCourse,
} from "../../scripts/lib/course-format.mjs";
import {
  builtForVersion,
  findVersion,
  followsGuide,
  guideOfVersion,
  versionRef,
  versionsMatching,
  withVersion,
} from "../../scripts/lib/course-version.mjs";
import { domains, guide } from "../fixtures/study-guide-changes/guides.mjs";
import { exampleCourse } from "./helpers/example-course.mjs";

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const same = guide({ asOf: "2026-06-01", domains: domains() });
const changed = guide({
  asOf: "2026-12-01",
  domains: domains((d) => d[0].groups[0].tasks.push("Configure a new thing")),
});
const history = {
  schemaVersion: 1,
  code: "DP-700",
  versions: [
    { n: 1, asOf: "2026-06-01", firstSeen: "2026-06-01", lines: same },
    // the same tasks again with another date (a weights or date change)
    {
      n: 2,
      asOf: "2026-09-01",
      firstSeen: "2026-09-02",
      lines: guide({ asOf: "2026-09-01", domains: domains() }),
    },
    { n: 3, asOf: "2026-12-01", firstSeen: "2026-11-10", lines: changed },
  ],
};

/** A course with the tasks of a guide, built on a day. */
function courseOf(lines, builtAt) {
  const tree = guideOfVersion({ lines });
  return {
    schemaVersion: 1,
    code: "DP-700",
    name: "Example",
    inputs: { guideHash: "abc", builtAt },
    domains: tree.domains.map((d) => ({
      title: d.title,
      groups: d.groups.map((g) => ({
        title: g.title,
        tasks: g.tasks.map((t) => ({ key: t.key, text: t.text, picks: [] })),
      })),
    })),
    rejected: [],
  };
}

test("versions: a course follows the versions with its tasks, and the newest the hub had seen when it was built is its own", () => {
  const course = courseOf(same, "2026-06-05");
  assert.deepEqual(
    versionsMatching(history, course).map((v) => v.n),
    [1, 2],
  );
  // built before version 2 was seen: version 1; built after: version 2 (same tasks, newer)
  assert.equal(builtForVersion(history, course).n, 1);
  assert.equal(builtForVersion(history, courseOf(same, "2026-09-05")).n, 2);
  // a course built before anything was seen still gets the newest that matches
  assert.equal(builtForVersion(history, courseOf(same, "2026-01-01")).n, 2);
  assert.equal(builtForVersion(history, courseOf(changed, "2026-11-20")).n, 3);
  // a course that no version matches
  const stray = courseOf(same, "2026-06-05");
  stray.domains[0].groups[0].tasks.pop();
  assert.equal(builtForVersion(history, stray), null);
  assert.equal(
    followsGuide(course, guideOfVersion(history.versions[2])),
    false,
  );
  assert.deepEqual(versionRef(history.versions[2]), {
    n: 3,
    asOf: "2026-12-01",
    firstSeen: "2026-11-10",
  });
  assert.equal(findVersion(history, { n: 2 }).asOf, "2026-09-01");
  assert.equal(findVersion(history, { n: 9 }), null);
  assert.equal(findVersion(history, null), null);
});

test("withVersion keeps the order of inputs and replaces an earlier version", () => {
  const course = {
    inputs: {
      guideHash: "h",
      guideAsOf: "June 1, 2026",
      builtAt: "2026-06-02",
    },
  };
  const ref = { n: 1, asOf: "2026-06-01", firstSeen: "2026-06-01" };
  const set = withVersion(course, ref);
  assert.deepEqual(Object.keys(set.inputs), [
    "guideHash",
    "guideAsOf",
    "guideVersion",
    "builtAt",
  ]);
  const again = withVersion(set, { ...ref, n: 2 });
  assert.equal(again.inputs.guideVersion.n, 2);
  assert.equal(Object.keys(again.inputs).length, 4);
  assert.deepEqual(
    Object.keys(withVersion({ inputs: { builtAt: "x" } }, ref).inputs),
    ["guideVersion", "builtAt"],
  );
});

test("guideVersionProblem: the shape, and the history when it is given", () => {
  const ref = { n: 1, asOf: "2026-06-01", firstSeen: "2026-06-01" };
  assert.equal(guideVersionProblem(undefined), null);
  assert.equal(guideVersionProblem(ref), null);
  assert.equal(guideVersionProblem({ ...ref, asOf: null }), null);
  for (const bad of [
    null,
    [],
    "1",
    { ...ref, n: 0 },
    { ...ref, n: 1.5 },
    { ...ref, asOf: "June 1" },
    { ...ref, firstSeen: null },
  ])
    assert.match(
      guideVersionProblem(bad),
      /inputs\.guideVersion/,
      JSON.stringify(bad),
    );
  assert.equal(guideVersionProblem(ref, history), null);
  assert.match(guideVersionProblem({ ...ref, n: 9 }, history), /does not have/);
  assert.match(
    guideVersionProblem({ ...ref, firstSeen: "2026-06-02" }, history),
    /but version 1 of the history says/,
  );
});

test("validateCourse: the version replaces the hash, must match the history, and an upcoming course needs one", () => {
  const { course, guide: g, fixture } = exampleCourse();
  const named = (ref, extra = {}) => ({
    ...course,
    inputs: { ...course.inputs, guideVersion: ref, ...extra },
  });
  const ref = { n: 1, asOf: null, firstSeen: "2026-10-15" };
  const h = {
    code: "GH-900",
    versions: [
      { n: 1, asOf: null, firstSeen: "2026-10-15", lines: fixture.lines },
    ],
  };
  assert.deepEqual(
    validateCourse(named(ref), { guide: g, history: h }).errors,
    [],
  );
  // the hash may go when the version names the guide
  const noHash = named(ref);
  delete noHash.inputs.guideHash;
  assert.deepEqual(validateCourse(noHash, { guide: g, history: h }).errors, []);
  const neither = structuredClone(course);
  delete neither.inputs.guideHash;
  assert.ok(
    validateCourse(neither, { guide: g }).errors.includes(
      "inputs.guideHash is missing",
    ),
  );
  // a version the history does not have
  assert.ok(
    validateCourse(named({ ...ref, n: 4 }), {
      guide: g,
      history: h,
    }).errors.some((e) => e.includes("does not have")),
  );
  // an upcoming course must name its version, and only an upcoming course may have a pending list
  assert.ok(
    validateCourse(course, { guide: g, next: true }).errors.some((e) =>
      e.includes("must name the version"),
    ),
  );
  const pending = {
    ...named(ref),
    pending: { added: [course.domains[0].groups[0].tasks[0].key] },
  };
  assert.deepEqual(
    validateCourse(pending, { guide: g, history: h, next: true }).errors,
    [],
  );
  assert.ok(
    validateCourse(pending, { guide: g, history: h }).errors.some((e) =>
      e.includes("belongs to an upcoming course"),
    ),
  );
  const stray = {
    ...named(ref),
    pending: { added: ["not/a/task"], confirm: [{ key: "x", was: "w" }] },
  };
  const errors = validateCourse(stray, {
    guide: g,
    history: h,
    next: true,
  }).errors;
  assert.ok(
    errors.some((e) =>
      e.includes("pending.added names a task that is not in the course"),
    ),
  );
});

test("the backfill: names the version of every course it can, and leaves the rest alone", () => {
  const root = mkdtempSync(join(tmpdir(), "course-versions-"));
  temps.push(root);
  const coursesDir = join(root, "src", "data_files", "courses");
  const historyDir = join(root, "src", "data_files", "study-guide-history");
  mkdirSync(coursesDir, { recursive: true });
  mkdirSync(historyDir, { recursive: true });
  const put = (name, value) =>
    writeFileSync(
      join(coursesDir, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  put("DP-700.json", courseOf(same, "2026-06-05"));
  put("DP-700.next.json", { not: "a course of the list" });
  const named = courseOf(same, "2026-06-05");
  named.code = "DP-800";
  named.inputs.guideVersion = { n: 1, asOf: null, firstSeen: "2026-01-01" };
  put("DP-800.json", named);
  const stray = courseOf(same, "2026-06-05");
  stray.code = "DP-900";
  put("DP-900.json", stray);
  const noMatch = courseOf(same, "2026-06-05");
  noMatch.code = "DP-600";
  noMatch.domains[0].groups[0].tasks.pop();
  put("DP-600.json", noMatch);
  writeFileSync(join(historyDir, "DP-700.json"), JSON.stringify(history));
  writeFileSync(
    join(historyDir, "DP-600.json"),
    JSON.stringify({ ...history, code: "DP-600" }),
  );

  const rows = plan({ coursesDir, historyDir });
  assert.deepEqual(
    rows.map((r) => [r.code, r.action]),
    [
      ["DP-600", "no-match"],
      ["DP-700", "set"],
      ["DP-800", "already"],
      ["DP-900", "no-history"],
    ],
  );
  assert.equal(rows.find((r) => r.code === "DP-700").ref.n, 1);

  const out = [];
  assert.equal(main([], { root, log: (m) => out.push(m) }), 0);
  assert.equal(
    JSON.parse(readFileSync(join(coursesDir, "DP-700.json"), "utf8")).inputs
      .guideVersion,
    undefined,
    "a dry run writes nothing",
  );
  assert.equal(main(["--write"], { root, log: (m) => out.push(m) }), 0);
  const written = readFileSync(join(coursesDir, "DP-700.json"), "utf8");
  assert.equal(JSON.parse(written).inputs.guideVersion.n, 1);
  assert.ok(
    written.endsWith("}\n"),
    "the file is written the way the builder writes it",
  );
  assert.equal(main(["--bogus"], { root, log() {}, error() {} }), 2);
});
