import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSES,
  COURSE_SCHEMA_VERSION,
  RELATIONS,
  SOURCES,
  approvalPolicy,
  courseStats,
  eachPick,
  pickProblems,
  validateCourse,
} from "../../scripts/lib/course-format.mjs";
import { exampleCourse, pick } from "./helpers/example-course.mjs";

const supporting = (extra = {}) =>
  pick({
    class: "supporting",
    relation: "prerequisite",
    why: "A professional meets it.",
    evidence: "A quote from the page.",
    source: "P1",
    ...extra,
  });

test("the vocabulary of the format is fixed: two classes, four relations, four sources", () => {
  assert.deepEqual(CLASSES, ["core", "supporting"]);
  assert.deepEqual(Object.keys(RELATIONS), [
    "prerequisite",
    "same-workflow",
    "operate",
    "deeper",
  ]);
  assert.deepEqual(SOURCES, ["P1", "P2", "P3", "P4"]);
  for (const relation of Object.values(RELATIONS))
    assert.ok(relation.label && relation.meaning);
  assert.equal(COURSE_SCHEMA_VERSION, 1);
});

test("approvalPolicy: only the gates may accept P1/P2 core picks and non-deeper supporting picks from P1-P3", () => {
  const rows = [
    [{ class: "core", source: "P1" }, "gates"],
    [{ class: "core", source: "P2" }, "gates"],
    [{ class: "core", source: "P3" }, "maintainer"],
    [{ class: "core", source: "P4" }, "maintainer"],
    [{ class: "supporting", source: "P1", relation: "prerequisite" }, "gates"],
    [{ class: "supporting", source: "P2", relation: "operate" }, "gates"],
    [{ class: "supporting", source: "P3", relation: "same-workflow" }, "gates"],
    [{ class: "supporting", source: "P3", relation: "deeper" }, "maintainer"],
    [{ class: "supporting", source: "P1", relation: "deeper" }, "maintainer"],
    [
      { class: "supporting", source: "P4", relation: "prerequisite" },
      "maintainer",
    ],
  ];
  for (const [input, expected] of rows)
    assert.equal(approvalPolicy(input), expected, JSON.stringify(input));
});

test("a valid pick has no problems", () => {
  assert.deepEqual(pickProblems(pick()), []);
  assert.deepEqual(pickProblems(supporting()), []);
  assert.deepEqual(
    pickProblems(
      pick({ target: { kind: "unit", path: "/training/modules/m/3-unit" } }),
    ),
    [],
  );
  assert.deepEqual(
    pickProblems(
      pick({
        target: { kind: "docs", path: "/azure/storage/blobs" },
        source: "P2",
      }),
    ),
    [],
  );
  assert.deepEqual(pickProblems(pick({ was: "/azure/old" })), []);
});

test("target problems: kind, canonical path, and the path shape each kind needs", () => {
  const problems = (target) => pickProblems(pick({ target })).join("|");
  assert.match(
    problems({ kind: "page", path: "/x" }),
    /target\.kind must be one of/,
  );
  assert.match(
    problems({ kind: "docs", path: "/Azure/Storage" }),
    /not a canonical Learn path/,
  );
  assert.match(
    problems({ kind: "docs", path: "/azure/storage/" }),
    /not a canonical Learn path/,
  );
  assert.match(
    problems({ kind: "docs", path: "/azure/storage?x=1" }),
    /not a canonical Learn path/,
  );
  assert.match(
    problems({ kind: "docs", path: "https://learn.microsoft.com/azure/x" }),
    /not a canonical Learn path/,
  );
  assert.match(
    problems({ kind: "module", path: "/training/paths/p" }),
    /a module target must be/,
  );
  assert.match(
    problems({ kind: "module", path: "/training/modules/m/1-unit" }),
    /a module target must be/,
  );
  assert.match(
    problems({ kind: "unit", path: "/training/modules/m" }),
    /a unit target must be/,
  );
  assert.match(
    problems({ kind: "docs", path: "/training/modules/m" }),
    /not a training page/,
  );
  assert.match(
    pickProblems({ ...pick(), target: undefined }).join("|"),
    /target\.kind/,
  );
  assert.match(pickProblems(null).join("|"), /not an object/);
});

test("class rules: a core pick has no relation; a supporting pick needs a relation, a why and evidence", () => {
  assert.match(
    pickProblems(pick({ relation: "prerequisite" })).join("|"),
    /a core pick has no relation/,
  );
  assert.deepEqual(pickProblems(pick({ relation: null })), []);
  const problems = (extra) => pickProblems(supporting(extra)).join("|");
  assert.match(problems({ relation: undefined }), /needs a relation/);
  assert.match(problems({ relation: "adjacent" }), /needs a relation/);
  assert.match(problems({ why: " " }), /must say why/);
  assert.match(problems({ evidence: "" }), /evidence is required/);
  assert.match(
    pickProblems(pick({ class: "extra" })).join("|"),
    /class must be one of/,
  );
  assert.match(
    pickProblems(pick({ source: "P9" })).join("|"),
    /source must be one of/,
  );
  assert.match(pickProblems(pick({ title: "" })).join("|"), /title is missing/);
});

test("evidence is also required for core material from outside the exam's own course", () => {
  assert.match(
    pickProblems(
      pick({ source: "P3", decision: { by: "maintainer", at: "2026-10-17" } }),
    ).join("|"),
    /evidence is required/,
  );
  assert.deepEqual(
    pickProblems(
      pick({
        source: "P3",
        evidence: "quote",
        decision: { by: "maintainer", at: "2026-10-17" },
      }),
    ),
    [],
  );
});

test("decision rules: the right shape, and the maintainer where the policy says so", () => {
  assert.match(
    pickProblems(pick({ decision: undefined })).join("|"),
    /decision must be/,
  );
  assert.match(
    pickProblems(pick({ decision: { by: "robot", at: "2026-10-17" } })).join(
      "|",
    ),
    /decision must be/,
  );
  assert.match(
    pickProblems(pick({ decision: { by: "auto", at: "2026-02-31" } })).join(
      "|",
    ),
    /decision must be/,
  );
  const p4 = pick({
    source: "P4",
    evidence: "quote",
    decision: { by: "auto", at: "2026-10-17" },
  });
  assert.match(
    pickProblems(p4).join("|"),
    /needs the maintainer's approval, not "auto"/,
  );
  assert.deepEqual(
    pickProblems({ ...p4, decision: { by: "maintainer", at: "2026-10-17" } }),
    [],
  );
  const deeper = supporting({
    relation: "deeper",
    decision: { by: "auto", at: "2026-10-17" },
  });
  assert.match(
    pickProblems(deeper).join("|"),
    /\(deeper\) needs the maintainer's approval/,
  );
  // the maintainer may approve anything the gates could
  assert.deepEqual(
    pickProblems(pick({ decision: { by: "maintainer", at: "2026-10-17" } })),
    [],
  );
});

test("the example course is valid and its stats add up", () => {
  const { course, guide } = exampleCourse();
  const result = validateCourse(course, { guide });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.tasks, 36);
  assert.equal(result.stats.picks, 5);
  assert.equal(courseStats(course).supporting, 2);
  assert.equal([...eachPick(course)].length, 5);
});

test("file-level problems: schema version, code, name, inputs, empty domains, not an object", () => {
  const { course, guide } = exampleCourse();
  const bad = (change) =>
    validateCourse(change(structuredClone(course)), { guide }).errors.join("|");
  assert.match(
    bad((c) => ({ ...c, schemaVersion: 2 })),
    /schemaVersion must be 1/,
  );
  assert.match(
    bad((c) => ({ ...c, code: "gh900" })),
    /is not an exam code/,
  );
  assert.match(
    bad((c) => ({ ...c, name: "" })),
    /name \(the exam name\) is missing/,
  );
  assert.match(
    bad((c) => ({ ...c, inputs: { ...c.inputs, guideHash: "" } })),
    /inputs\.guideHash is missing/,
  );
  assert.match(
    bad((c) => ({ ...c, inputs: { ...c.inputs, scopeFingerprint: "abc" } })),
    /40-character fingerprint/,
  );
  assert.match(
    bad((c) => ({ ...c, inputs: { ...c.inputs, builtAt: "yesterday" } })),
    /builtAt must be YYYY-MM-DD/,
  );
  assert.match(
    bad((c) => ({ ...c, domains: [] })),
    /domains is missing or empty/,
  );
  assert.equal(validateCourse(null).ok, false);
  assert.equal(validateCourse([]).ok, false);
});

test("the tree must be the study guide's tree: missing, extra and renamed tasks, wrong keys", () => {
  const { course, guide } = exampleCourse();
  const errors = (change) =>
    validateCourse(change(structuredClone(course)), { guide }).errors.join("|");
  assert.match(
    errors((c) => (c.domains[0].groups[0].tasks.pop(), c)),
    /tree differs from the study guide: missing-task/,
  );
  assert.match(
    errors(
      (c) => (
        c.domains[0].groups[0].tasks.push({
          key: "x",
          text: "A task the guide does not have",
          picks: [],
        }),
        c
      ),
    ),
    /extra-task/,
  );
  assert.match(
    errors((c) => ((c.domains[1].title = "Renamed domain"), c)),
    /missing-domain|extra-domain/,
  );
  assert.match(
    errors((c) => ((c.domains[0].groups[0].tasks[0].key = "changed-key"), c)),
    /task keys differ from the study guide's keys/,
  );
  assert.match(
    validateCourse(course, { guide: { ...guide, ok: false } }).errors.join("|"),
    /does not parse completely/,
  );
});

test("a changed guide hash is a warning, not an error: the rebuild check owns that decision", () => {
  const { course, guide } = exampleCourse();
  const result = validateCourse(course, { guide: { ...guide, hash: "ffff" } });
  assert.equal(result.ok, true);
  assert.match(
    result.warnings.join("|"),
    /guide changed since the course was built/,
  );
});

test("picks: duplicates under one task, and a rejected pick coming back, are errors", () => {
  const { course, guide } = exampleCourse();
  const dup = structuredClone(course);
  dup.domains[0].groups[0].tasks[0].picks.push(pick());
  assert.match(
    validateCourse(dup, { guide }).errors.join("|"),
    /appears twice under one task/,
  );
  const back = structuredClone(course);
  back.domains[0].groups[0].tasks[0].picks.push(
    pick({
      target: {
        kind: "module",
        path: "/training/modules/entitlement-management",
      },
      title: "Entitlement management",
    }),
  );
  assert.match(
    validateCourse(back, { guide }).errors.join("|"),
    /was rejected by the maintainer and must not come back/,
  );
  const noReason = structuredClone(course);
  noReason.rejected = [{ taskKey: "x", path: "/p" }];
  assert.match(
    validateCourse(noReason, { guide }).errors.join("|"),
    /a rejected entry needs taskKey, path, reason and at/,
  );
});

test("URLs: a target that is not a current Learn page is an error with the reason; catalog titles are checked as a warning", () => {
  const { course, guide } = exampleCourse();
  const isCurrent = (path) =>
    path === "/azure/github/overview"
      ? { ok: false, reason: "moved to /azure/github/about" }
      : { ok: true };
  const result = validateCourse(course, { guide, isCurrent });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("|"),
    /\/azure\/github\/overview is not a current Learn page \(moved to \/azure\/github\/about\)/,
  );
  assert.equal(result.errors.length, 1);
  const titles = validateCourse(course, {
    guide,
    titleOf: (path) =>
      path === "/training/modules/intro-to-github"
        ? "Introduction to GitHub (updated)"
        : undefined,
  });
  assert.equal(titles.ok, true);
  assert.match(
    titles.warnings.join("|"),
    /the title "Introduction to GitHub" is not the catalog title "Introduction to GitHub \(updated\)"/,
  );
});

test("without a guide only the file itself is checked", () => {
  const { course } = exampleCourse();
  assert.equal(validateCourse(course).ok, true);
});
