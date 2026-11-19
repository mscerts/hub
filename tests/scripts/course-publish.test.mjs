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
import { main as publishMain } from "../../scripts/course-publish.mjs";
import {
  REQUIRED_CACHE_FILES,
  checkLearnsyncCaches,
  main as syncMain,
} from "../../scripts/learnsync-sync.mjs";
import { exampleCourse, readGuideFixture } from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
  };
};

const verdicts =
  (bad = {}) =>
  async (paths) =>
    new Map(paths.map((p) => [p, bad[p] ?? { path: p, verdict: "valid" }]));

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "course-publish-"));
  temps.push(root);
  mkdirSync(join(root, "src", "data_files", "courses"), { recursive: true });
  mkdirSync(join(root, "src", "content", "docs", "courses"), {
    recursive: true,
  });
  mkdirSync(join(root, "src", "content", "docs", "github"), {
    recursive: true,
  });
  const g = readGuideFixture("GH-900");
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({
      studyGuides: [
        { code: g.code, name: g.name, hash: g.hash, lines: g.lines },
      ],
    }),
  );
  writeFileSync(
    join(root, "src", "content", "docs", "github", "GH-900.mdx"),
    [
      "---",
      'title: "GH-900 Study Materials"',
      'description: "GH-900 study guide resources"',
      "---",
      "<Tabs>",
      '  <TabItem label="Text">',
      "    <CardGrid>",
      '      <LinkCard title="Microsoft Learn" href="https://learn.microsoft.com/training/courses/gh-900t00?WT.mc_id=studentamb_165290" target="_blank"/>',
      "    </CardGrid>",
      "  </TabItem>",
      "</Tabs>",
      "",
    ].join("\n"),
  );
  return root;
}

test("learnsync-sync: checks all 6 cache files and clones or fast-forwards cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learnsync-check-"));
  temps.push(dir);

  const initial = checkLearnsyncCaches(dir);
  assert.equal(initial.ok, false);
  assert.equal(initial.missing.length, REQUIRED_CACHE_FILES.length);

  const gitCalls = [];
  const runGit = (args) => {
    gitCalls.push(args);
    for (const rel of REQUIRED_CACHE_FILES) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "{}");
    }
    mkdirSync(join(dir, ".git"), { recursive: true });
  };

  // Clone path (when .git does not exist yet)
  const cap1 = capture();
  const code1 = await syncMain(["--dir", dir], {
    ...cap1,
    runGit,
    env: {},
  });
  assert.equal(code1, 0);
  assert.equal(gitCalls[0][0], "clone");

  // Pull path (when .git already exists)
  const cap2 = capture();
  const code2 = await syncMain(["--dir", dir], {
    ...cap2,
    runGit,
    env: {},
  });
  assert.equal(code2, 0);
  assert.deepEqual(gitCalls[1].slice(2), ["pull", "--ff-only"]);
});

test("course-publish: refuses unreviewed orange picks, publishes valid --run-dir build, removes -review.mdx, and adds exam card", async () => {
  const root = makeWorld();
  const runDir = join(root, ".course-runs", "GH-900-test");
  mkdirSync(join(runDir, "build"), { recursive: true });

  const builtCourse = exampleCourse().course;
  const builtPath = join(runDir, "build", "GH-900.json");
  writeFileSync(builtPath, JSON.stringify(builtCourse, null, 2));

  // Leftover review sidecar with undecided orange pick blocks publishing by default
  writeFileSync(
    `${builtPath}.review.json`,
    JSON.stringify({
      kind: "review",
      code: "GH-900",
      picks: [{ task: "t0", path: "/a", reason: "unsure" }],
    }),
  );
  const capBlocked = capture();
  const blockedCode = await publishMain(
    ["GH-900", "--run-dir", runDir, "--offline"],
    { root, env: {}, verdictsFor: verdicts(), ...capBlocked },
  );
  assert.equal(blockedCode, 1);
  assert.equal(
    existsSync(join(root, "src", "data_files", "courses", "GH-900.json")),
    false,
  );

  // Clear review picks (simulating resolved review) and plant a leftover -review.mdx
  writeFileSync(
    `${builtPath}.review.json`,
    JSON.stringify({ kind: "review", code: "GH-900", picks: [] }),
  );
  const reviewMdx = join(
    root,
    "src",
    "content",
    "docs",
    "courses",
    "gh-900-review.mdx",
  );
  writeFileSync(reviewMdx, "temporary review copy");

  const capOk = capture();
  const okCode = await publishMain(
    ["GH-900", "--run-dir", runDir, "--offline"],
    { root, env: {}, verdictsFor: verdicts(), ...capOk },
  );
  assert.equal(okCode, 0, capOk.err.join("\n"));
  assert.equal(
    existsSync(join(root, "src", "data_files", "courses", "GH-900.json")),
    true,
  );
  assert.equal(
    existsSync(join(root, "src", "content", "docs", "courses", "gh-900.mdx")),
    true,
  );
  assert.equal(existsSync(reviewMdx), false);

  const examMdx = readFileSync(
    join(root, "src", "content", "docs", "github", "GH-900.mdx"),
    "utf8",
  );
  assert.match(examMdx, /title="GH-900 Study Guide Course"/);
});
