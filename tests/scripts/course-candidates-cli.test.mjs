import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { describeTask, main } from "../../scripts/course-candidates.mjs";
import {
  COURSES_URL,
  LEARNSYNC_RAW,
  learnsyncDir,
  loadLearnsyncDocs,
  parseDocsUrls,
} from "../../scripts/course-source.mjs";
import { learnInputs, readGuideFixture } from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const DOCS = [
  {
    title: "About branches",
    url: "https://learn.microsoft.com/azure/github/branches",
    description: "Branches let you work on a copy of a repository",
  },
  {
    title: "What is GitHub?",
    url: "https://learn.microsoft.com/azure/github/overview",
    description:
      "The difference between Git and GitHub: GitHub hosts repositories",
  },
  {
    title: "Merging branches",
    url: "https://learn.microsoft.com/azure/github/merging",
    description: "Merge a branch back",
  },
];

/** A repo root with the GH-900 guide stored, and a sibling learnsync checkout with the example GH-900 course. */
function world({ docsFiles = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-candidates-"));
  temps.push(base);
  const root = join(base, "hub");
  mkdirSync(join(root, "src", "data_files"), { recursive: true });
  const g = readGuideFixture("GH-900");
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({
      studyGuides: [
        {
          code: g.code,
          name: g.name,
          hash: g.hash,
          updatedAt: g.updatedAt,
          lines: g.lines,
        },
      ],
    }),
  );
  const inputs = learnInputs();
  inputs.modules[0].title =
    "Introduction to GitHub and the difference between Git and GitHub";
  const dir = join(base, "learnsync");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "learn-catalog.json"),
    JSON.stringify({ modules: inputs.modules }),
  );
  writeFileSync(
    join(data, "learn-content.json"),
    JSON.stringify({ learningPaths: inputs.learningPaths }),
  );
  writeFileSync(
    join(data, "module-links.json"),
    JSON.stringify(inputs.moduleLinks),
  );
  if (docsFiles) {
    writeFileSync(join(data, "docs-catalog.json"), JSON.stringify(DOCS));
    writeFileSync(
      join(data, "docs-urls.txt"),
      "/azure/github/branches\t2026-10-01\n/azure/github/merging\t-\n/azure/github/overview\t2026-10-02\n",
    );
    writeFileSync(join(data, "docs-redirects.json"), "[]");
  }
  return { base, root, dir, courses: inputs.courses };
}

function fakeFetch(routes) {
  return async (url) => {
    const body = routes[url];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status: 200 },
    );
  };
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

const run = async (argv, w, io = capture(), extra = {}) => {
  const code = await main(argv, {
    env: { LEARNSYNC_DIR: w.dir },
    root: w.root,
    fetchImpl: fakeFetch({ [COURSES_URL]: { courses: w.courses } }),
    ...io,
    ...extra,
  });
  return { code, io };
};

test("--task prints the shortlist of the tasks that contain the text, with provenance and where each page comes from", async () => {
  const w = world();
  const { code, io } = await run(
    ["gh-900", "--task", "difference between Git and GitHub"],
    w,
  );
  assert.equal(code, 0, io.err.join("\n"));
  const text = io.out.join("\n");
  assert.match(
    text,
    /^Explain the difference between Git and GitHub {2}\(.+ > Version control fundamentals\)/m,
  );
  assert.match(text, /P1 module \(the exam's own course\)/);
  assert.match(
    text,
    /Introduction to GitHub .*\/training\/modules\/intro-to-github/,
  );
  assert.match(text, /P2 docs \(listed by the exam's modules\)/);
  assert.match(
    text,
    /What is GitHub\? .*\/azure\/github\/overview {2}via \/training\/modules\/intro-to-github/,
  );
  assert.match(text, /anchor: Introduction to GitHub and the difference/);
  assert.equal(
    existsSync(join(w.root, "course-candidates")),
    false,
    "nothing is written when a task is asked for",
  );
});

test("--task --json prints the matching tasks as data", async () => {
  const w = world();
  const { code, io } = await run(
    ["GH-900", "--task", "branch protection", "--json"],
    w,
  );
  assert.equal(code, 0);
  const tasks = JSON.parse(io.out.join("\n"));
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].text, /branch protection rules/);
  assert.ok(Array.isArray(tasks[0].candidates));
});

test("without --task the whole exam is written to the output folder and summarised", async () => {
  const w = world();
  const out = join(w.base, "out");
  const { code, io } = await run(["GH-900", "--out", out], w);
  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(readdirSync(out), ["GH-900.candidates.json"]);
  const result = JSON.parse(
    readFileSync(join(out, "GH-900.candidates.json"), "utf8"),
  );
  assert.equal(result.code, "GH-900");
  assert.equal(result.stats.tasks, 36);
  assert.equal(result.inputs.docsCatalog, true);
  assert.match(
    io.out[0],
    /^GH-900: 36 tasks, \d+ candidates \(P1 \d+, P2 \d+, P3 \d+, P4 \d+\)/,
  );
  assert.match(io.out.at(-1), /^Wrote .*GH-900\.candidates\.json$/);
});

test("the default output folder is a temporary one, never the repository", async () => {
  const w = world();
  const tmp = join(w.base, "tmp");
  const { code } = await run(["GH-900"], w, capture(), { tmp });
  assert.equal(code, 0);
  assert.ok(
    existsSync(join(tmp, "course-candidates", "GH-900.candidates.json")),
  );
  assert.deepEqual(readdirSync(w.root), ["src"], "the repo root is untouched");
});

test("missing documentation files are warnings, and the run still works on the modules", async () => {
  const w = world({ docsFiles: false });
  const out = join(w.base, "out");
  const { code, io } = await run(["GH-900", "--out", out], w);
  assert.equal(code, 0, io.err.join("\n"));
  const text = io.out.join("\n");
  assert.match(text, /warning: docs-catalog\.json is not in learnsync/);
  assert.match(text, /warning: docs-urls\.txt is not in learnsync/);
  const result = JSON.parse(
    readFileSync(join(out, "GH-900.candidates.json"), "utf8"),
  );
  assert.equal(result.inputs.docsCatalog, false);
  assert.ok(result.stats.bySource.P1 > 0);
});

test("usage and input errors are exit code 2 with a message", async () => {
  const w = world();
  for (const [argv, pattern] of [
    [[], /An exam code is required/],
    [["GH-900", "--wat"], /Unknown option --wat/],
    [["GH-900", "AZ-104"], /Only one exam code/],
    [["GH-900", "--task"], /--task needs a value/],
    [["AZ-104"], /No stored study guide text for AZ-104/],
    [
      ["GH-900", "--task", "no such task anywhere"],
      /No task of GH-900 contains/,
    ],
  ]) {
    const { code, io } = await run(argv, w);
    assert.equal(code, 2, argv.join(" "));
    assert.match(io.err.join("\n"), pattern);
  }
  const broken = await run(["GH-900"], w, capture(), {
    fetchImpl: fakeFetch({ [COURSES_URL]: 500 }),
  });
  assert.equal(broken.code, 2);
  assert.match(broken.io.err.join("\n"), /Cannot load the inputs/);
});

test("describeTask says when a task has no candidates and when the whole exam is the anchor", () => {
  const lines = describeTask({
    text: "Do a thing",
    domain: "D",
    group: "G",
    anchor: { basis: "exam", modules: [], families: [] },
    candidates: [],
    dropped: {
      "out-of-scope-product": { count: 3, samples: [{ path: "/x/y" }] },
    },
  });
  assert.equal(lines[0], "Do a thing  (D > G)");
  assert.match(
    lines[1],
    /none of the exam's modules fits well: the whole exam/,
  );
  assert.ok(lines.includes("  no candidates"));
  assert.match(
    lines.at(-1),
    /dropped: out-of-scope-product 3 \(e\.g\. \/x\/y\)/,
  );
});

test("parseDocsUrls keeps the paths of docs-urls.txt and ignores everything else", () => {
  const paths = parseDocsUrls(
    "/azure/a\t2026-10-01\n/azure/b\t-\n\nnot a path\n",
  );
  assert.deepEqual([...paths], ["/azure/a", "/azure/b"]);
});

test("learnsyncDir prefers LEARNSYNC_DIR, then a sibling checkout, else null", () => {
  const w = world();
  assert.equal(
    learnsyncDir({ root: w.root, env: { LEARNSYNC_DIR: "/x" } }),
    "/x",
  );
  assert.equal(
    learnsyncDir({ root: w.root, env: {} }),
    join(w.root, "..", "learnsync"),
  );
  const bare = mkdtempSync(join(tmpdir(), "course-candidates-"));
  temps.push(bare);
  assert.equal(learnsyncDir({ root: join(bare, "hub"), env: {} }), null);
});

test("loadLearnsyncDocs reads a checkout, or GitHub when there is none, and reports what is missing", async () => {
  const w = world();
  const local = await loadLearnsyncDocs({
    dir: w.dir,
    fetchImpl: fakeFetch({}),
  });
  assert.equal(local.docs.length, 3);
  assert.ok(local.docPaths.has("/azure/github/merging"));
  assert.deepEqual(local.redirects, []);
  assert.deepEqual(local.warnings, []);

  const remote = await loadLearnsyncDocs({
    dir: null,
    fetchImpl: fakeFetch({
      [`${LEARNSYNC_RAW}/docs-catalog.json`]: DOCS,
      [`${LEARNSYNC_RAW}/docs-urls.txt`]: "/azure/github/branches\t-\n",
    }),
  });
  assert.equal(remote.docs.length, 3);
  assert.deepEqual([...remote.docPaths], ["/azure/github/branches"]);
  assert.equal(remote.redirects, null);
  assert.deepEqual(remote.warnings, [
    "docs-redirects.json is not in learnsync: the filters that need it are off",
  ]);

  const none = await loadLearnsyncDocs({
    dir: world({ docsFiles: false }).dir,
    fetchImpl: fakeFetch({}),
  });
  assert.equal(none.docs, null);
  assert.equal(none.docPaths, null);
  assert.equal(none.warnings.length, 3);
});
