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
import { join } from "node:path";
import test, { after } from "node:test";
import { currentFromVerdict, main } from "../../scripts/course-file.mjs";
import { exampleCourse, readGuideFixture } from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

/** A repo root with the tracker (GH-900 guide) and, unless `course` is null, a course file for GH-900. */
function world({ course = exampleCourse().course, tracker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "course-file-"));
  temps.push(root);
  mkdirSync(join(root, "src", "data_files", "courses"), { recursive: true });
  if (tracker) {
    const g = readGuideFixture("GH-900");
    writeFileSync(
      join(root, "src", "data_files", "learn-exams.json"),
      JSON.stringify({
        studyGuides: [
          { code: g.code, name: g.name, hash: g.hash, lines: g.lines },
        ],
      }),
    );
  }
  if (course)
    writeFileSync(
      join(root, "src", "data_files", "courses", "GH-900.json"),
      JSON.stringify(course),
    );
  return root;
}

const capture = () => {
  const out = [];
  const err = [];
  const written = [];
  return {
    out,
    err,
    written,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
    write: (t) => written.push(t),
  };
};

/** A lookup that calls every path current except the ones listed. */
const verdicts =
  (bad = {}) =>
  async (paths) =>
    new Map(paths.map((p) => [p, bad[p] ?? { path: p, verdict: "valid" }]));

test("currentFromVerdict: only a valid verdict is current, and the reason says why not", () => {
  assert.deepEqual(currentFromVerdict({ verdict: "valid" }), { ok: true });
  assert.deepEqual(
    currentFromVerdict({
      verdict: "moved",
      redirectsTo: "/azure/new",
      reason: "redirects",
    }),
    { ok: false, reason: "moved to /azure/new: redirects" },
  );
  assert.deepEqual(
    currentFromVerdict({
      verdict: "unverifiable",
      reason: "not covered by any cache",
    }),
    { ok: false, reason: "unverifiable: not covered by any cache" },
  );
  assert.deepEqual(currentFromVerdict(undefined), {
    ok: false,
    reason: "no verdict",
  });
});

test("validate: a good course file is valid (code or path), exit 0, with a summary", async () => {
  const root = world();
  const c = capture();
  assert.equal(
    await main(["validate", "gh-900"], {
      root,
      env: {},
      verdictsFor: verdicts(),
      log: c.log,
      error: c.error,
    }),
    0,
    c.err.join("\n"),
  );
  assert.match(
    c.out[0],
    /^GH-900: valid - 36 tasks \(3 with core picks, 32 with none\), 5 picks \(3 core, 2 supporting; 4 automatic, 1 approved by the maintainer\)/,
  );
  const byPath = capture();
  assert.equal(
    await main(
      ["validate", join(root, "src", "data_files", "courses", "GH-900.json")],
      {
        root,
        env: {},
        verdictsFor: verdicts(),
        log: byPath.log,
        error: byPath.error,
      },
    ),
    0,
  );
});

test("validate: a target that is not current, or that the caches cannot confirm, fails with exit 1", async () => {
  const root = world();
  const c = capture();
  const code = await main(["validate", "GH-900"], {
    root,
    env: {},
    verdictsFor: verdicts({
      "/azure/github/overview": {
        path: "/azure/github/overview",
        verdict: "moved",
        redirectsTo: "/azure/github/about",
        reason: "redirects",
      },
    }),
    log: c.log,
    error: c.error,
  });
  assert.equal(code, 1);
  assert.match(c.out.join("\n"), /GH-900: INVALID/);
  assert.match(
    c.out.join("\n"),
    /error: .*\/azure\/github\/overview is not a current Learn page \(moved to \/azure\/github\/about: redirects\)/,
  );
});

test("validate: a course whose tree no longer matches the guide fails", async () => {
  const { course } = exampleCourse();
  course.domains[0].groups[0].tasks.pop();
  const root = world({ course });
  const c = capture();
  assert.equal(
    await main(["validate", "GH-900"], {
      root,
      env: {},
      verdictsFor: verdicts(),
      log: c.log,
      error: c.error,
    }),
    1,
  );
  assert.match(
    c.out.join("\n"),
    /tree differs from the study guide: missing-task/,
  );
});

test("validate without a learnsync checkout is a clear input problem, not a crash", async () => {
  const root = world();
  const c = capture();
  assert.equal(
    await main(["validate", "GH-900"], {
      root,
      env: { LEARNSYNC_DIR: join(root, "nope") },
      log: c.log,
      error: c.error,
    }),
    2,
  );
  assert.match(
    c.err.join("\n"),
    /Cannot check the URLs .* Set LEARNSYNC_DIR to a learnsync checkout/,
  );
});

test("render: prints the page to stdout, or writes it with --out, and needs no network", async () => {
  const root = world();
  const c = capture();
  assert.equal(
    await main(["render", "GH-900"], {
      root,
      env: {},
      log: c.log,
      error: c.error,
      write: c.write,
    }),
    0,
    c.err.join("\n"),
  );
  assert.match(c.written.join(""), /^---\ntitle: GH-900 Study Guide Course/);
  const out = join(root, "out", "page.mdx");
  const c2 = capture();
  assert.equal(
    await main(["render", "GH-900", "--out", out], {
      root,
      env: {},
      log: c2.log,
      error: c2.error,
      write: c2.write,
    }),
    0,
  );
  assert.equal(readFileSync(out, "utf8"), c.written.join(""));
  assert.match(c2.out[0], /^Wrote .*page\.mdx \(\d+ lines\)\.$/);
  assert.deepEqual(c2.written, []);
});

test("render refuses a course file with errors and writes nothing", async () => {
  const { course } = exampleCourse();
  course.domains[0].groups[0].tasks[0].picks[0].decision = {
    by: "robot",
    at: "2026-10-17",
  };
  const root = world({ course });
  const out = join(root, "page.mdx");
  const c = capture();
  assert.equal(
    await main(["render", "GH-900", "--out", out], {
      root,
      env: {},
      log: c.log,
      error: c.error,
      write: c.write,
    }),
    1,
  );
  assert.match(c.err.join("\n"), /the course file has errors, not rendered/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(c.written, []);
});

test("input problems are exit code 2: usage, a missing course file, a missing guide, a wrong schema version", async () => {
  const root = world({ course: null });
  for (const [argv, expected] of [
    [[], /A command .* are required/],
    [["validate"], /A command .* are required/],
    [["build", "GH-900"], /A command .* are required/],
    [["render", "GH-900", "--nope"], /Unknown option --nope/],
    [["render", "GH-900", "--out"], /--out needs a value/],
    [["render", "GH-900"], /it does not exist/],
  ]) {
    const c = capture();
    assert.equal(
      await main(argv, {
        root,
        env: {},
        log: c.log,
        error: c.error,
        write: c.write,
      }),
      2,
      argv.join(" "),
    );
    assert.match(c.err.join("\n"), expected);
  }
  const noGuide = world({ tracker: false });
  writeFileSync(
    join(noGuide, "src", "data_files", "learn-exams.json"),
    JSON.stringify({ studyGuides: [] }),
  );
  const c = capture();
  assert.equal(
    await main(["render", "GH-900"], {
      root: noGuide,
      env: {},
      log: c.log,
      error: c.error,
      write: c.write,
    }),
    2,
  );
  assert.match(c.err.join("\n"), /No stored study guide text for GH-900/);
  const { course } = exampleCourse();
  const old = world({ course: { ...course, schemaVersion: 9 } });
  const c2 = capture();
  assert.equal(
    await main(["validate", "GH-900"], {
      root: old,
      env: {},
      verdictsFor: verdicts(),
      log: c2.log,
      error: c2.error,
    }),
    1,
  );
  assert.match(c2.err.join("\n"), /schemaVersion 9 is not 1/);
});
