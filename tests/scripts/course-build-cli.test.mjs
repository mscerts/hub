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
import { main } from "../../scripts/course-build.mjs";
import { gateJudged } from "../../scripts/lib/course-gates.mjs";
import { validateCourse } from "../../scripts/lib/course-format.mjs";
import { guideOf, scopeOf } from "./helpers/example-candidates.mjs";
import { TASKS, exampleJudged } from "./helpers/example-judging.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const guide = (extra = {}) => ({ ...guideOf(TASKS), ok: true, ...extra });

/** A tmp folder with the gated file where `course-gates gate` writes it. */
function world({ gated = true, sheet = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-build-"));
  temps.push(base);
  const tmp = join(base, "tmp");
  mkdirSync(join(tmp, "course-gates"), { recursive: true });
  const judged = exampleJudged();
  const { items } = gateJudged([judged], {
    today: "2026-10-17",
    options: { queueUnsure: sheet },
  });
  const file = join(tmp, "course-gates", "NET-100.gated.json");
  if (gated)
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        kind: "gated",
        code: "NET-100",
        builtAt: "2026-10-17",
        inputs: judged.inputs,
        items,
      }),
    );
  return {
    base,
    tmp,
    root: join(base, "hub"),
    file,
    out: join(base, "out", "NET-100.json"),
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
    root: w.root,
    tmp: w.tmp,
    env: {},
    now: () => new Date("2026-10-18T09:00:00Z"),
    scopeFor: async () => ({ scope: scopeOf() }),
    loadGuide: () => ({ guide: guide(), name: "Network Administrator" }),
    ...io,
    ...extra,
  });
  return { code, io };
};

test("a built course is written to a temporary folder, passes the validator and says how to put it in place", async () => {
  const w = world();
  const { code, io } = await run(["NET-100"], w);
  assert.equal(code, 0, io.err.join("\n"));
  const file = join(w.tmp, "course-build", "NET-100.json");
  const course = readJson(file);
  assert.equal(course.code, "NET-100");
  assert.equal(course.name, "Network Administrator");
  assert.equal(course.inputs.builtAt, "2026-10-18", "the day of the build");
  assert.deepEqual(validateCourse(course, { guide: guide() }).errors, []);
  const text = io.out.join("\n");
  assert.match(
    text,
    /NET-100: built a course of 2 tasks, \d+ picks \(\d+ core, \d+ supporting; \d+ automatic, \d+ approved by the maintainer\)/,
  );
  assert.match(
    text,
    /To use it: move it to src\/data_files\/courses\/NET-100\.json, then node scripts\/course-file\.mjs validate NET-100 --live/,
  );
  assert.match(
    text,
    /warning: .* is still in the queue: it is not in the course/,
  );
  assert.ok(
    !existsSync(join(w.root, "src")),
    "nothing is written into the repository",
  );
});

test("the routing of the page rules is written beside the course and the summary says how many pages it holds", async () => {
  const w = world();
  const { code, io } = await run(["NET-100"], w);
  assert.equal(code, 0, io.err.join("\n"));
  const routing = readJson(join(w.tmp, "course-build", "NET-100.routing.json"));
  assert.equal(routing.kind, "routing");
  assert.equal(routing.code, "NET-100");
  assert.equal(routing.builtAt, "2026-10-18");
  assert.ok(Array.isArray(routing.handsOn) && Array.isArray(routing.repeats));
  assert.match(
    io.out.join("\n"),
    new RegExp(
      `${routing.handsOn.length} accepted hands-on pages are not in the course: the lab page collects them \\(node scripts/course-labs\\.mjs NET-100 --routing .*NET-100\\.routing\\.json\\); ${routing.repeats.length} pages fitted several tasks and are shown once\\.`,
    ),
  );
});

test("--out says where the course goes, and --gated where the decisions are", async () => {
  const w = world();
  const elsewhere = join(w.base, "decisions.gated.json");
  writeFileSync(elsewhere, readFileSync(w.file));
  rmSync(w.file);
  const { code, io } = await run(
    ["net-100", "--gated", elsewhere, "--out", w.out, "--today", "2026-12-01"],
    w,
  );
  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(readJson(w.out).inputs.builtAt, "2026-12-01");
});

test("a course whose inputs changed since the candidates were made is refused, and built when allowed", async () => {
  const w = world();
  const newerGuide = () => ({
    guide: guide({ hash: "a-newer-guide" }),
    name: "Network Administrator",
  });
  const refused = await run(["NET-100", "--out", w.out], w, capture(), {
    loadGuide: newerGuide,
  });
  assert.equal(refused.code, 1);
  assert.match(
    refused.io.err.join("\n"),
    /the course cannot be built; nothing was written/,
  );
  assert.match(
    refused.io.err.join("\n"),
    /the study guide changed since the candidates were made/,
  );
  assert.ok(!existsSync(w.out));
  const allowed = await run(
    ["NET-100", "--out", w.out, "--allow-stale"],
    w,
    capture(),
    { loadGuide: newerGuide },
  );
  assert.equal(allowed.code, 0, allowed.io.err.join("\n"));
  assert.match(
    allowed.io.out.join("\n"),
    /warning: the study guide changed .*built anyway/,
  );
  assert.equal(readJson(w.out).inputs.guideHash, "a-newer-guide");
});

test("--urls refuses a course with a pick that is not a current Learn page, and writes nothing", async () => {
  const w = world();
  const stale = "/training/modules/route-between-networks";
  const verdictsFor = async (paths) =>
    new Map(
      paths.map((p) => [
        p,
        p === stale
          ? {
              path: p,
              verdict: "moved",
              redirectsTo: "/training/modules/new",
              reason: "renamed",
            }
          : { path: p, verdict: "valid" },
      ]),
    );
  const bad = await run(["NET-100", "--out", w.out, "--urls"], w, capture(), {
    verdictsFor,
  });
  assert.equal(bad.code, 1);
  assert.match(
    bad.io.err.join("\n"),
    /some picks are not current Learn pages; nothing was written/,
  );
  assert.match(
    bad.io.err.join("\n"),
    /route-between-networks \(moved to \/training\/modules\/new/,
  );
  assert.ok(!existsSync(w.out));
  const good = await run(["NET-100", "--out", w.out, "--urls"], w, capture(), {
    verdictsFor: async (paths) =>
      new Map(paths.map((p) => [p, { path: p, verdict: "valid" }])),
  });
  assert.equal(good.code, 0, good.io.err.join("\n"));
  assert.ok(existsSync(w.out));
});

test("--urls without a learnsync checkout stops with a message", async () => {
  const w = world();
  const { code, io } = await run(["NET-100", "--out", w.out, "--urls"], w);
  assert.equal(code, 2);
  assert.match(io.err.join("\n"), /Cannot check the URLs/);
  assert.ok(!existsSync(w.out));
});

test("usage and input errors are exit code 2 with a message", async () => {
  const w = world();
  for (const [argv, pattern] of [
    [[], /An exam code is required/],
    [["NET-100", "AZ-104"], /Only one exam code/],
    [["NET-100", "--wat"], /Unknown option --wat/],
    [["NET-100", "--out"], /--out needs a value/],
    [["NET-100", "--today", "soon"], /--today must be a YYYY-MM-DD day/],
  ]) {
    const { code, io } = await run(argv, w);
    assert.equal(code, 2, argv.join(" "));
    assert.match(io.err.join("\n"), pattern);
  }
  const none = world({ gated: false });
  const missing = await run(["NET-100"], none);
  assert.equal(missing.code, 2);
  assert.match(
    missing.io.err.join("\n"),
    /No gated file for NET-100.*Run node scripts\/course-gates\.mjs gate NET-100 first/,
  );
  writeFileSync(none.file, "{ not json");
  assert.match(
    (await run(["NET-100"], none)).io.err.join("\n"),
    /The gated file is not valid JSON/,
  );
  writeFileSync(none.file, JSON.stringify({ kind: "queue" }));
  assert.match(
    (await run(["NET-100"], none)).io.err.join("\n"),
    /is not a gated file/,
  );
  const noGuide = await run(["NET-100"], w, capture(), {
    loadGuide: () => null,
  });
  assert.equal(noGuide.code, 2);
  assert.match(
    noGuide.io.err.join("\n"),
    /No stored study guide text for NET-100/,
  );
  const noName = await run(["NET-100"], w, capture(), {
    loadGuide: () => ({ guide: guide(), name: null }),
  });
  assert.match(
    noName.io.err.join("\n"),
    /the stored study guide has no exam name/,
  );
  const cannotLoad = await run(["NET-100"], w, capture(), {
    scopeFor: async () => {
      throw new Error("Learn is not there");
    },
  });
  assert.equal(cannotLoad.code, 2);
  assert.match(
    cannotLoad.io.err.join("\n"),
    /Cannot load the inputs: Learn is not there/,
  );
});

test("the picks marked for review are written beside the course and the summary says how many there are", async () => {
  const w = world({ sheet: false });
  const { code, io } = await run(["NET-100"], w);
  assert.equal(code, 0, io.err.join("\n"));
  const review = readJson(join(w.tmp, "course-build", "NET-100.review.json"));
  assert.equal(review.kind, "review");
  assert.equal(review.code, "NET-100");
  assert.equal(review.builtAt, "2026-10-18");
  assert.ok(review.picks.length > 0);
  assert.match(
    io.out.join("\n"),
    new RegExp(
      `${review.picks.length} picks are in the course but marked for review .*node scripts/course-file\\.mjs render NET-100 --review .*NET-100\\.review\\.json`,
    ),
  );
  assert.ok(
    !/still in the queue/.test(io.out.join("\n")),
    "nothing waits in the queue",
  );
});
