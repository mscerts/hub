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
import { codeFromFileName, main } from "../../scripts/course-pilot.mjs";
import { renderCourse } from "../../scripts/lib/course-render.mjs";
import { exampleCourse, readGuideFixture } from "./helpers/example-course.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** A scratch repo root with the GH-900 guide in the tracker, a course file and its rendered page. */
function world() {
  const base = mkdtempSync(join(tmpdir(), "course-pilot-"));
  temps.push(base);
  const root = join(base, "hub");
  const tmp = join(base, "tmp");
  mkdirSync(join(root, "src", "data_files"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const g = readGuideFixture("GH-900");
  writeFileSync(
    join(root, "src", "data_files", "learn-exams.json"),
    JSON.stringify({
      studyGuides: [
        { code: g.code, name: g.name, hash: g.hash, lines: g.lines },
      ],
    }),
  );
  const { course } = exampleCourse();
  const json = join(base, "GH-900.json");
  writeFileSync(json, JSON.stringify(course));
  const mdx = join(base, "gh-900course.mdx");
  writeFileSync(mdx, renderCourse(course));
  return { base, root, tmp, json, mdx };
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

const run = async (argv, w, io = capture()) => {
  const code = await main(argv, {
    root: w.root,
    tmp: w.tmp,
    env: {},
    ...io,
  });
  return { code, io, text: io.out.join("\n"), errors: io.err.join("\n") };
};

const gatedItem = (task, path, decision, extra = {}) => {
  const { by = "gates", via = "gates" } = extra;
  return {
    task: { key: task, text: `Text of ${task}`, group: "Group" },
    target: { kind: "docs", path },
    title: `Title of ${path}`,
    source: "P1",
    judge: { verdict: "core", why: `why ${path}`, quote: `quote ${path}` },
    gate: { decision, class: "core", by, via, reasons: [] },
  };
};

/** A gated file in the place `course-gates gate` writes it: 30 automatic acceptances, 6 queued, 4 rejected. */
function withGated(w, { code = "NET-100", extra = [] } = {}) {
  const items = [
    ...Array.from({ length: 30 }, (_, i) =>
      gatedItem(`t${i % 6}`, `/azure/auto/${i}`, "accept"),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      gatedItem("t0", `/azure/queued/${i}`, "queue", { by: "maintainer" }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      gatedItem("t1", `/azure/rejected/${i}`, "reject", { via: "judge" }),
    ),
    ...extra,
  ];
  const file = join(w.tmp, "course-gates", `${code}.gated.json`);
  mkdirSync(join(w.tmp, "course-gates"), { recursive: true });
  writeFileSync(file, JSON.stringify({ kind: "gated", code, items }));
  return file;
}

test("the exam code is read from the name of a course file", () => {
  assert.equal(
    codeFromFileName("src/content/docs/courses/az-104course.mdx"),
    "AZ-104",
  );
  assert.equal(codeFromFileName("C:\\x\\GH-900.json"), "GH-900");
  assert.equal(codeFromFileName("notes.mdx"), null);
});

test("gold-template draws picks from a course file and from its rendered page, the same ones", async () => {
  const w = world();
  const fromJson = await run(["gold-template", w.json, "--seed", "4"], w);
  assert.equal(fromJson.code, 0, fromJson.errors);
  assert.match(
    fromJson.text,
    /GH-900: 5 of 5 picks drawn \(seed 4\) from \d+ skill groups\./,
  );
  assert.match(fromJson.text, /Mark every pick "keep" or "drop"/);
  const out = join(w.tmp, "course-pilot", "GH-900.gold.json");
  const gold = readJson(out);
  assert.equal(gold.code, "GH-900");
  assert.equal(gold.picks.length, 5);
  assert.ok(gold.picks.every((p) => p.mark === null));

  const fromMdx = await run(
    [
      "gold-template",
      w.mdx,
      "--seed",
      "4",
      "--out",
      join(w.base, "page.gold.json"),
    ],
    w,
  );
  assert.equal(fromMdx.code, 0, fromMdx.errors);
  const same = (g) => g.picks.map((p) => `${p.task}|${p.target.path}`).sort();
  assert.deepEqual(same(readJson(join(w.base, "page.gold.json"))), same(gold));
});

test("gold-template: --size, --include and the way it fails", async () => {
  const w = world();
  const small = await run(
    [
      "gold-template",
      w.json,
      "--size",
      "2",
      "--include",
      "branches",
      "--out",
      join(w.base, "g.json"),
    ],
    w,
  );
  assert.equal(small.code, 0, small.errors);
  const gold = readJson(join(w.base, "g.json"));
  assert.equal(gold.picks.length, 2);
  assert.ok(gold.picks.some((p) => p.target.path === "/azure/github/branches"));

  const missing = await run(
    ["gold-template", w.json, "--include", "nowhere"],
    w,
  );
  assert.equal(missing.code, 2);
  assert.match(missing.errors, /No pick of the course contains "nowhere"/);

  const noCode = join(w.base, "notes.mdx");
  writeFileSync(noCode, "x");
  const unnamed = await run(["gold-template", noCode], w);
  assert.equal(unnamed.code, 2);
  assert.match(unnamed.errors, /give it with --code/);

  const noGuide = await run(["gold-template", w.json, "--code", "ZZ-999"], w);
  assert.equal(noGuide.code, 2);
  assert.match(noGuide.errors, /No stored study guide text for ZZ-999/);

  const empty = join(w.base, "gh-900empty.mdx");
  writeFileSync(empty, "# nothing\n");
  const none = await run(["gold-template", empty], w);
  assert.equal(none.code, 2);
  assert.match(
    none.errors,
    /no picks that match a task of the GH-900 study guide/,
  );

  assert.equal(
    (await run(["gold-template", join(w.base, "missing.json")], w)).code,
    2,
  );
});

test("sample draws from the automatic acceptances only and says where the file is", async () => {
  const w = world();
  withGated(w);
  const r = await run(["sample", "net-100", "--size", "10", "--seed", "3"], w);
  assert.equal(r.code, 0, r.errors);
  assert.match(
    r.text,
    /NET-100: 10 of 30 automatic acceptances drawn \(seed 3\)\./,
  );
  assert.match(r.text, /set "correct" to true or false/);
  const sample = readJson(join(w.tmp, "course-pilot", "NET-100.sample.json"));
  assert.equal(sample.items.length, 10);
  assert.ok(
    sample.items.every((i) => i.target.path.startsWith("/azure/auto/")),
  );
  // the same seed again gives the same sample
  const again = await run(
    [
      "sample",
      "NET-100",
      "--size",
      "10",
      "--seed",
      "3",
      "--out",
      join(w.base, "again.json"),
    ],
    w,
  );
  assert.equal(again.code, 0);
  assert.deepEqual(readJson(join(w.base, "again.json")), sample);
  const small = await run(
    ["sample", "NET-100", "--size", "5", "--out", join(w.base, "s.json")],
    w,
  );
  assert.match(small.text, /warning: a sample this small/);
});

test("sample and measure need the gated file, of the right exam", async () => {
  const w = world();
  const none = await run(["sample", "NET-100"], w);
  assert.equal(none.code, 2);
  assert.match(none.errors, /the gated file not found/);
  withGated(w, { code: "NET-100" });
  const wrong = join(w.base, "wrong.gated.json");
  writeFileSync(
    wrong,
    JSON.stringify({ kind: "gated", code: "OTHER-1", items: [] }),
  );
  const mismatch = await run(["measure", "NET-100", "--gated", wrong], w);
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.errors, /is for OTHER-1, not NET-100/);
  const notGated = join(w.base, "x.json");
  writeFileSync(notGated, JSON.stringify({ kind: "judged" }));
  assert.equal(
    (await run(["measure", "NET-100", "--gated", notGated], w)).code,
    2,
  );
  const onlyRejected = join(w.base, "rejected.gated.json");
  writeFileSync(
    onlyRejected,
    JSON.stringify({
      kind: "gated",
      code: "NET-100",
      items: [gatedItem("t", "/a", "reject", { via: "judge" })],
    }),
  );
  const empty = await run(["sample", "NET-100", "--gated", onlyRejected], w);
  assert.equal(empty.code, 2);
  assert.match(empty.errors, /accepted nothing on their own/);
});

test("measure with nothing but the gated file: the queue share is measured, the rest is not, and the exit code says not passed", async () => {
  const w = world();
  withGated(w);
  const r = await run(["measure", "NET-100"], w);
  assert.equal(r.code, 1);
  assert.match(
    r.text,
    /NET-100: 40 candidates: 30 accepted \(30 by the gates alone\), 6 queued, 4 rejected\./,
  );
  assert.match(
    r.text,
    /PASS {2}queue share: the queue holds 16\.7% of the judge's picks \(limit 25%\)/,
  );
  assert.match(r.text, /---- {2}automatic acceptances: not measured/);
  assert.match(r.text, /---- {2}gold set: not measured/);
  assert.match(r.text, /course-build\.mjs --urls --live/);
});

test("measure: a queue above the limit fails, the limit can be moved", async () => {
  const w = world();
  withGated(w);
  const strict = await run(["measure", "NET-100", "--max-queue", "0.1"], w);
  assert.match(strict.text, /FAIL {2}queue share: .* \(limit 10%\)/);
});

async function markedSample(w, wrong) {
  await run(
    ["sample", "NET-100", "--size", "20", "--out", join(w.base, "sample.json")],
    w,
  );
  const sample = readJson(join(w.base, "sample.json"));
  sample.items.forEach((i, n) => {
    i.correct = !wrong.includes(n);
  });
  writeFileSync(join(w.base, "sample.json"), JSON.stringify(sample));
  return join(w.base, "sample.json");
}

function goldFile(w, rows) {
  const file = join(w.base, "gold.json");
  writeFileSync(
    file,
    JSON.stringify({
      kind: "gold",
      code: "NET-100",
      picks: rows.map(([task, path, mark]) => ({
        task,
        taskText: `Text of ${task}`,
        group: "Group",
        target: { kind: "docs", path },
        title: `Title of ${path}`,
        mark,
        note: "",
      })),
    }),
  );
  return file;
}

test("measure passes when the sample is right, the gold keeps are kept and no drop was accepted", async () => {
  const w = world();
  withGated(w);
  const sample = await markedSample(w, [3]);
  const gold = goldFile(w, [
    ["t0", "/azure/auto/0", "keep"],
    ["t0", "/azure/queued/1", "keep"],
    ["t1", "/azure/rejected/2", "drop"],
    ["t5", "/azure/never", "drop"],
  ]);
  const r = await run(
    ["measure", "NET-100", "--sample", sample, "--gold", gold],
    w,
  );
  assert.equal(r.code, 0, r.text + r.errors);
  assert.match(
    r.text,
    /PASS {2}automatic acceptances: 19 of 20 sampled automatic acceptances are right: 95% \(limit 95%; at 95% confidence it could be as low as \d+(\.\d)?%\)/,
  );
  assert.match(
    r.text,
    /PASS {2}gold keeps: 2 of 2 picks marked keep were kept or queued by the pipeline \(100%; limit 90%\): 1 accepted by the gates, 0 by the maintainer's earlier decisions, 1 queued, 0 lost/,
  );
  assert.match(
    r.text,
    /PASS {2}gold drops: 0 of 2 picks marked drop were accepted by the gates on their own \(must be 0\); 0 queued, 1 rejected, 1 never a candidate/,
  );
  assert.match(r.text, /wrong: /, "the wrong pick of the sample is listed");
});

test("measure fails on a false accept and names the pick; a lost keep is named too", async () => {
  const w = world();
  withGated(w);
  const sample = await markedSample(w, []);
  const gold = goldFile(w, [
    ["t2", "/azure/auto/2", "drop"],
    ["t0", "/azure/rejected/0", "keep"],
    ["t1", "/azure/rejected/1", "keep"],
  ]);
  const r = await run(
    ["measure", "NET-100", "--sample", sample, "--gold", gold],
    w,
  );
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL {2}gold keeps: 0 of 2/);
  assert.match(
    r.text,
    /FAIL {2}gold drops: 1 of 1 picks marked drop was accepted|FAIL {2}gold drops: 1 of 1/,
  );
  assert.match(
    r.text,
    /FALSE ACCEPT: t2 Text of t2\n\s+Title of \/azure\/auto\/2 {2}\/azure\/auto\/2 {2}\(accepted by the gates\)/,
  );
  assert.match(r.text, /lost keep: t1 Text of t1/);
});

test("measure: a sample that is not fully marked is pending, not a pass", async () => {
  const w = world();
  withGated(w);
  await run(
    ["sample", "NET-100", "--size", "10", "--out", join(w.base, "s.json")],
    w,
  );
  const sample = readJson(join(w.base, "s.json"));
  sample.items[0].correct = true;
  writeFileSync(join(w.base, "s.json"), JSON.stringify(sample));
  const r = await run(
    ["measure", "NET-100", "--sample", join(w.base, "s.json")],
    w,
  );
  assert.equal(r.code, 1);
  assert.match(
    r.text,
    /---- {2}automatic acceptances: 1 of 10 sampled acceptances marked so far: 9 still to mark/,
  );
});

test("measure: an invalid review sample or gold file is an input problem, listed", async () => {
  const w = world();
  withGated(w);
  await run(
    ["sample", "NET-100", "--size", "10", "--out", join(w.base, "s.json")],
    w,
  );
  const sample = readJson(join(w.base, "s.json"));
  sample.items[0].correct = "yes";
  writeFileSync(join(w.base, "s.json"), JSON.stringify(sample));
  const a = await run(
    ["measure", "NET-100", "--sample", join(w.base, "s.json")],
    w,
  );
  assert.equal(a.code, 2);
  assert.match(
    a.errors,
    /The review sample is not valid:\n\s+t\d .*"correct" must be true or false/,
  );

  const unmarked = goldFile(w, [["t0", "/azure/auto/0", null]]);
  const b = await run(["measure", "NET-100", "--gold", unmarked], w);
  assert.equal(b.code, 2);
  assert.match(b.errors, /The gold file has no marks yet\./);

  const unknownTask = goldFile(w, [["t99", "/azure/x", "keep"]]);
  const c = await run(["measure", "NET-100", "--gold", unknownTask], w);
  assert.equal(c.code, 2);
  assert.match(c.errors, /t99: the pipeline did not run on this task/);

  const partly = goldFile(w, [
    ["t0", "/azure/auto/0", "keep"],
    ["t0", "/azure/auto/6", null],
  ]);
  const d = await run(["measure", "NET-100", "--gold", partly], w);
  assert.match(
    d.text,
    /warning: 1 picks of the gold file are not marked and are left out/,
  );
});

test("usage errors are exit code 2 with the usage text, and nothing is written", async () => {
  const w = world();
  for (const [argv, expected] of [
    [[], /A command is required/],
    [["nope", "x"], /Unknown command nope/],
    [["sample"], /An exam code is required/],
    [["gold-template"], /A course file is required/],
    [["sample", "A", "B"], /Too many arguments/],
    [["sample", "NET-100", "--nope"], /Unknown option --nope/],
    [["sample", "NET-100", "--size"], /--size needs a value/],
    [["sample", "NET-100", "--size", "0"], /--size must be a whole number/],
    [["sample", "NET-100", "--seed", "x"], /--seed must be a whole number/],
    [
      ["measure", "NET-100", "--min-correct", "2"],
      /--min-correct must be from 0 to 1/,
    ],
  ]) {
    const r = await run(argv, w);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.errors, expected);
    assert.match(r.errors, /Usage: node scripts\/course-pilot\.mjs/);
  }
  assert.equal(existsSync(join(w.tmp, "course-pilot")), false);
});
