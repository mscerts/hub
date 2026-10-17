import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScopeMap,
  coursesForExam,
  fingerprintOfSnapshot,
  learnPath,
  linksHash,
} from "../../scripts/lib/course-scope.mjs";

const course = (number, studyGuide, extra = {}) => ({
  course_number: number,
  title: `Course ${number}`,
  url: `https://learn.microsoft.com/en-us/training/courses/${number.toLowerCase()}/?WT.mc_id=x`,
  last_modified: "2026-01-01T00:00:00Z",
  study_guide: studyGuide,
  ...extra,
});
const mod = (slug, sig = "sig-1", units = ["Introduction", "Summary"]) => ({
  uid: `learn.${slug}`,
  path: `/training/modules/${slug}`,
  title: `Module ${slug}`,
  unitSig: sig,
  units,
});
const lp = (id, modules) => ({
  uid: `learn.path-${id}`,
  title: `Path ${id}`,
  path: `/training/paths/path-${id}`,
  modules: modules.map((m) => `/training/modules/${m}`),
});
const record = (slug, links) => ({
  path: `/training/modules/${slug}`,
  unitSig: "sig-1",
  unit: `/training/modules/${slug}/2-summary`,
  unitTitle: "Summary",
  harvestedAt: "2026-10-16",
  links,
});
const docs = (path) => ({
  kind: "docs",
  path,
  text: "t",
  section: "Learn more",
});

test("learnPath canonicalises a Learn URL or path", () => {
  assert.equal(
    learnPath(
      "https://learn.microsoft.com/en-us/training/courses/AZ-104T00/?WT.mc_id=x",
    ),
    "/training/courses/az-104t00",
  );
  assert.equal(learnPath("/en-us/azure/storage/"), "/azure/storage");
  assert.equal(learnPath(""), "/");
});

test("coursesForExam matches the course number prefix and the exam field, and nothing that merely starts alike", () => {
  const courses = [
    course("AZ-104T00-A", []),
    course("AZ-104T00", []),
    course("AZ-1040T00", []),
    course("AZ-10T00", []),
    course("XX-900T00", [], { exam: "exam.az-104" }),
    course("MB-230T01", [], { exam: "exam.mb-230" }),
    course("MB-230T02", []),
    course("AZ-1040T01", []),
  ];
  assert.deepEqual(
    coursesForExam("AZ-104", courses).map((c) => c.course_number),
    ["AZ-104T00", "AZ-104T00-A", "XX-900T00"],
  );
  assert.deepEqual(
    coursesForExam("az-104", courses).length,
    3,
    "the code's case does not matter",
  );
  assert.deepEqual(
    coursesForExam("MB-230", courses).map((c) => c.course_number),
    ["MB-230T01", "MB-230T02"],
  );
  assert.deepEqual(coursesForExam("AZ-401", courses), []);
  assert.deepEqual(coursesForExam("AZ-104", undefined), []);
});

test("buildScopeMap: course -> paths -> modules in course order, shared modules listed once with every path, resources attached", () => {
  const result = buildScopeMap({
    code: "AZ-104",
    courses: [
      course("AZ-104T00", [
        { uid: "learn.path-1", type: "learningPath" },
        { uid: "learn.path-2", type: "learningPath" },
        { uid: "learn.solo", type: "module" },
      ]),
      course("AZ-900T00", [{ uid: "learn.path-3", type: "learningPath" }]),
    ],
    learningPaths: [lp(1, ["a", "b"]), lp(2, ["b", "c"]), lp(3, ["z"])],
    modules: [mod("a"), mod("b"), mod("c"), mod("solo"), mod("z")],
    moduleLinks: {
      lastChecked: "2026-10-16T00:00:00Z",
      modules: [record("b", [docs("/azure/b/one")]), record("c", [])],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.courses.map((c) => [c.number, c.path]),
    [["AZ-104T00", "/training/courses/az-104t00"]],
  );
  assert.deepEqual(
    result.paths.map((p) => [p.uid, p.modules.length]),
    [
      ["learn.path-1", 2],
      ["learn.path-2", 2],
    ],
  );
  assert.deepEqual(
    result.modules.map((m) => [m.path.split("/").pop(), m.paths]),
    [
      ["a", ["learn.path-1"]],
      ["b", ["learn.path-1", "learn.path-2"]],
      ["c", ["learn.path-2"]],
      ["solo", []],
    ],
  );
  const b = result.modules[1];
  assert.deepEqual(b.units, ["Introduction", "Summary"]);
  assert.equal(b.resources.unit, "/training/modules/b/2-summary");
  assert.deepEqual(
    b.resources.links.map((l) => l.path),
    ["/azure/b/one"],
  );
  assert.equal(result.modules[0].resources, null, "no record: no resources");
  assert.deepEqual(
    result.modules[2].resources.links,
    [],
    "a record with no links is kept",
  );
  assert.equal(result.inputs.resourceModules, 1);
  assert.equal(result.inputs.moduleLinksChecked, "2026-10-16T00:00:00Z");
  assert.deepEqual(result.warnings, []);
});

test("buildScopeMap reports what it cannot resolve instead of guessing", () => {
  const result = buildScopeMap({
    code: "AZ-104",
    courses: [
      course("AZ-104T00", [{ uid: "learn.path-1" }, { uid: "learn.unknown" }]),
    ],
    learningPaths: [lp(1, ["a", "gone"])],
    modules: [mod("a")],
    moduleLinks: null,
  });
  assert.deepEqual(
    result.modules.map((m) => m.path),
    ["/training/modules/a"],
  );
  assert.deepEqual(result.unresolved, ["learn.unknown"]);
  assert.ok(
    result.warnings.some((w) =>
      /module \/training\/modules\/gone is not in the catalog/.test(w),
    ),
  );
  assert.ok(
    result.warnings.some((w) =>
      /1 course entries resolve to no learning path or module: learn\.unknown/.test(
        w,
      ),
    ),
  );
  assert.equal(result.inputs.moduleLinksChecked, null);
});

test("an exam with no official course has an empty, not-ok scope map and says so", () => {
  const result = buildScopeMap({
    code: "AZ-401",
    courses: [course("AZ-104T00", [])],
    learningPaths: [],
    modules: [],
    moduleLinks: null,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.modules, []);
  assert.ok(
    result.warnings.some((w) => /no official course found for AZ-401/.test(w)),
  );
});

test("the fingerprint moves with the course list, a unitSig or a resource, and with nothing else", () => {
  const base = () => ({
    code: "AZ-104",
    courses: [course("AZ-104T00", [{ uid: "learn.path-1" }])],
    learningPaths: [lp(1, ["a", "b"])],
    modules: [mod("a"), mod("b")],
    moduleLinks: {
      lastChecked: "2026-10-16T00:00:00Z",
      modules: [record("a", [docs("/azure/a/one")])],
    },
  });
  const fp = (input) => buildScopeMap(input).inputs.fingerprint;
  const original = fp(base());
  assert.match(original, /^[0-9a-f]{40}$/);
  assert.equal(fp(base()), original, "deterministic");
  const sig = base();
  sig.modules[1] = mod("b", "sig-2");
  assert.notEqual(fp(sig), original);
  const link = base();
  link.moduleLinks.modules[0].links = [docs("/azure/a/other")];
  assert.notEqual(fp(link), original);
  const moved = base();
  moved.moduleLinks.modules[0].links = [
    { ...docs("/azure/a/one"), was: "/azure/a/old" },
  ];
  assert.notEqual(
    fp(moved),
    original,
    "a link that moved again changes the inputs",
  );
  const courseChanged = base();
  courseChanged.courses[0].last_modified = "2026-10-01T00:00:00Z";
  assert.notEqual(fp(courseChanged), original);
  const unrelated = base();
  unrelated.modules.push(mod("not-in-this-course"));
  unrelated.learningPaths.push(lp(9, ["not-in-this-course"]));
  unrelated.moduleLinks.lastChecked = "2026-11-01T00:00:00Z";
  unrelated.moduleLinks.modules.push(
    record("not-in-this-course", [docs("/azure/x")]),
  );
  assert.equal(
    fp(unrelated),
    original,
    "other exams' modules and a later cache stamp do not matter",
  );
});

test("the snapshot lists the courses and modules with their signatures and link hashes, and the fingerprint is computed from it", () => {
  const result = buildScopeMap({
    code: "AZ-104",
    courses: [course("AZ-104T00", [{ uid: "learn.path-1" }])],
    learningPaths: [lp(1, ["b", "a"])],
    modules: [mod("a", "sig-a"), mod("b", "sig-b")],
    moduleLinks: { modules: [record("a", [docs("/azure/a/one")])] },
  });
  const { snapshot } = result.inputs;
  assert.deepEqual(snapshot.courses, [["AZ-104T00", "2026-01-01T00:00:00Z"]]);
  assert.deepEqual(
    snapshot.modules.map((m) => [m[0], m[1]]),
    [
      ["/training/modules/a", "sig-a"],
      ["/training/modules/b", "sig-b"],
    ],
    "sorted by path",
  );
  assert.match(snapshot.modules[0][2], /^[0-9a-f]{12}$/);
  assert.equal(
    snapshot.modules[1][2],
    "-",
    "a module without a record has no links hash",
  );
  assert.equal(fingerprintOfSnapshot(snapshot), result.inputs.fingerprint);
  assert.equal(
    fingerprintOfSnapshot({
      courses: [...snapshot.courses],
      modules: [...snapshot.modules].reverse(),
    }),
    result.inputs.fingerprint,
    "order does not matter",
  );
});

test("linksHash depends on the targets and on `was`, in order, and not on the link text", () => {
  const links = (list) => ({ links: list });
  const base = linksHash(links([docs("/azure/a"), docs("/azure/b")]));
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(
    linksHash(
      links([{ ...docs("/azure/a"), text: "another text" }, docs("/azure/b")]),
    ),
    base,
  );
  assert.notEqual(linksHash(links([docs("/azure/b"), docs("/azure/a")])), base);
  assert.notEqual(
    linksHash(
      links([{ ...docs("/azure/a"), was: "/azure/old" }, docs("/azure/b")]),
    ),
    base,
  );
  assert.equal(linksHash(null), "-");
});
