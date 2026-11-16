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
import { main as nextMain } from "../../scripts/course-next.mjs";
import { main } from "../../scripts/course-promote.mjs";
import { parseGuide } from "../../scripts/lib/course-guide.mjs";
import { asOfOfHeading } from "../../scripts/lib/guide-history.mjs";
import { exampleCourse } from "./helpers/example-course.mjs";

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const BEFORE = new Date("2026-11-16T12:00:00Z");
const ON_THE_DAY = new Date("2026-12-01T12:00:00Z");

const skillsLines = (lines) => [
  "## Skills measured as of October 14, 2026",
  ...lines.slice(
    lines.findIndex((l) => /^#{1,6}\s+skills at a glance/i.test(l)),
  ),
];

/**
 * A repo root with the example course for GH-900, its guide history (version 1 is its guide, version 2 counts
 * from 2026-12-01: one task reworded, one gone, one new), a decision list and an old page.
 */
function world() {
  const { course, fixture } = exampleCourse();
  const v1 = skillsLines(fixture.lines);
  const tasks = parseGuide(v1).domains.flatMap((d) =>
    d.groups.flatMap((g) => g.tasks),
  );
  const reword = tasks[0];
  const removed = tasks[3];
  const added = tasks[5];
  const v2 = v1
    .map((l) =>
      l.replace(
        /^## Skills measured.*$/,
        "## Skills measured as of December 1, 2026",
      ),
    )
    .flatMap((l) => {
      if (l === `- ${reword.text}`) return [`- ${reword.text} and its history`];
      if (l === `- ${removed.text}`) return [];
      if (l === `- ${added.text}`)
        return [l, "- Describe the brand new capability"];
      return [l];
    });
  const root = mkdtempSync(join(tmpdir(), "course-promote-"));
  temps.push(root);
  const data = (...p) => join(root, "src", "data_files", ...p);
  for (const d of ["courses", "study-guide-history", "course-decisions"])
    mkdirSync(data(d), { recursive: true });
  mkdirSync(join(root, "src", "content", "docs", "courses"), {
    recursive: true,
  });
  const asOf1 = asOfOfHeading(v1[0]);
  course.inputs.guideVersion = { n: 1, asOf: asOf1, firstSeen: "2026-10-15" };
  writeFileSync(data("courses", "GH-900.json"), JSON.stringify(course));
  writeFileSync(
    data("study-guide-history", "GH-900.json"),
    JSON.stringify({
      schemaVersion: 1,
      code: "GH-900",
      versions: [
        { n: 1, asOf: asOf1, firstSeen: "2026-10-15", lines: v1 },
        { n: 2, asOf: "2026-12-01", firstSeen: "2026-11-10", lines: v2 },
      ],
    }),
  );
  const decision = (task, target) => ({
    task,
    target,
    decision: "reject",
    reason: "not this task",
    by: "maintainer",
    at: "2026-10-17",
  });
  writeFileSync(
    data("course-decisions", "GH-900.json"),
    JSON.stringify({
      schemaVersion: 1,
      code: "GH-900",
      decisions: [
        decision(reword.key, "/azure/a"),
        decision(removed.key, "/azure/b"),
        decision(tasks[1].key, "/azure/c"),
      ],
      excludedFamilies: [],
    }),
  );
  writeFileSync(
    join(root, "src", "content", "docs", "courses", "gh-900.mdx"),
    "an old page\n",
  );
  return { root, data, reword, removed, tasks };
}

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

/** The upcoming course built and complete, as the maintainer leaves it. */
function withUpcoming(w, { complete = true } = {}) {
  assert.equal(
    nextMain(["build", "GH-900", "--write"], {
      root: w.root,
      now: BEFORE,
      env: {},
      ...capture(),
    }),
    0,
  );
  const file = w.data("courses", "GH-900.next.json");
  if (complete) {
    writeFileSync(join(w.root, "built.json"), readFileSync(file));
    assert.equal(
      nextMain(["merge", "GH-900", "--from", join(w.root, "built.json")], {
        root: w.root,
        now: BEFORE,
        env: {},
        ...capture(),
      }),
      0,
    );
  }
  return file;
}

const promote = async (w, argv, now = ON_THE_DAY) => {
  const io = capture();
  const code = await main(["GH-900", ...argv], {
    root: w.root,
    now,
    env: {},
    ...io,
    write() {},
  });
  return { code, ...io };
};

test("course-promote: without --write it says what it would do and changes nothing", async () => {
  const w = world();
  const next = withUpcoming(w);
  const before = readFileSync(w.data("courses", "GH-900.json"), "utf8");
  const r = await promote(w, []);
  assert.equal(r.code, 0, r.err.join(" | "));
  const said = r.out.join(" | ");
  assert.match(said, /takes over from version 1/);
  assert.match(said, /Decisions: 1 moved to new keys, 1 dropped/);
  assert.match(said, /Not written \(add --write\)/);
  assert.equal(readFileSync(w.data("courses", "GH-900.json"), "utf8"), before);
  assert.ok(existsSync(next));
});

test("course-promote --write: the upcoming course becomes the course, the decisions follow the tasks, the page is rendered again", async () => {
  const w = world();
  const next = withUpcoming(w);
  const upcoming = JSON.parse(readFileSync(next, "utf8"));
  const r = await promote(w, ["--write"]);
  assert.equal(r.code, 0, r.err.join(" | "));
  // the course file is the upcoming course, and the upcoming file is gone
  const now = JSON.parse(
    readFileSync(w.data("courses", "GH-900.json"), "utf8"),
  );
  assert.deepEqual(now, upcoming);
  assert.equal(now.pending, undefined);
  assert.equal(now.inputs.guideVersion.n, 2);
  assert.equal(existsSync(next), false);
  // the decision of the reworded task has its new key, the one of the removed task is gone, the other stays
  const newKey = parseGuide(
    JSON.parse(
      readFileSync(w.data("study-guide-history", "GH-900.json"), "utf8"),
    ).versions[1].lines,
  )
    .domains.flatMap((d) => d.groups.flatMap((g) => g.tasks))
    .find((t) => t.text === `${w.reword.text} and its history`).key;
  const decisions = JSON.parse(
    readFileSync(w.data("course-decisions", "GH-900.json"), "utf8"),
  ).decisions;
  assert.deepEqual(
    decisions.map((d) => d.task).sort(),
    [newKey, w.tasks[1].key].sort(),
  );
  // the page is the course alone: no component for two versions, the new wording is there
  const page = readFileSync(
    join(w.root, "src", "content", "docs", "courses", "gh-900.mdx"),
    "utf8",
  );
  assert.match(page, /^---\ntitle: GH-900 Study Guide Course/);
  assert.doesNotMatch(page, /CourseVersions/);
  assert.match(page, /and its history/);
  // a second run has nothing to take over
  assert.equal((await promote(w, ["--write"])).code, 2);
});

test("course-promote: it refuses before the day, an incomplete course and a broken file, and --force skips only the day", async () => {
  const early = world();
  withUpcoming(early);
  const tooEarly = await promote(early, ["--write"], BEFORE);
  assert.equal(tooEarly.code, 1);
  assert.match(
    tooEarly.err.join(" | "),
    /count from 2026-12-01, which has not come/,
  );
  assert.equal((await promote(early, ["--force"], BEFORE)).code, 0);

  const pending = world();
  withUpcoming(pending, { complete: false });
  const notReady = await promote(pending, []);
  assert.equal(notReady.code, 1);
  assert.match(notReady.err.join(" | "), /not complete/);

  const broken = world();
  const file = withUpcoming(broken);
  const course = JSON.parse(readFileSync(file, "utf8"));
  delete course.inputs.guideVersion;
  writeFileSync(file, JSON.stringify(course));
  const invalid = await promote(broken, []);
  assert.equal(invalid.code, 1);
  assert.match(invalid.err.join(" | "), /must name the version/);
});

test("course-promote: usage and input problems are exit code 2", async () => {
  const w = world();
  const io = capture();
  assert.equal(await main([], { root: w.root, ...io, env: {} }), 2);
  assert.equal(
    await main(["GH-900", "--bogus"], { root: w.root, ...io, env: {} }),
    2,
  );
  assert.equal((await promote(w, [])).code, 2, "no upcoming course yet");
});
