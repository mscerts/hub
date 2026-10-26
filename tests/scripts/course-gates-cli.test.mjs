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
import { describeQueue, loadAges, main } from "../../scripts/course-gates.mjs";
import { eachPick } from "../../scripts/lib/course-format.mjs";
import { exampleCourse } from "./helpers/example-course.mjs";
import { exampleJudged } from "./helpers/example-judging.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2));

/** A temporary world: the judged file where `course-judge merge` writes it, and a repo root for the decisions. */
function world({ judged = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-gates-"));
  temps.push(base);
  const tmp = join(base, "tmp");
  mkdirSync(join(tmp, "course-judge"), { recursive: true });
  if (judged)
    write(
      join(
        tmp,
        "course-judge",
        "NET-100.01-configure-virtual-networks.judged.json",
      ),
      exampleJudged({ units: "all" }),
    );
  const root = join(base, "hub");
  mkdirSync(root, { recursive: true });
  return {
    base,
    tmp,
    root,
    out: join(base, "out"),
    queue: join(base, "out", "NET-100.queue.json"),
    decisions: join(
      root,
      "src",
      "data_files",
      "course-decisions",
      "NET-100.json",
    ),
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
    now: () => new Date("2026-10-17T10:00:00Z"),
    ...io,
    ...extra,
  });
  return { code, io };
};
const gate = (w, extra = []) =>
  run(["gate", "NET-100", "--out", w.out, "--queue-unsure", ...extra], w);

test("gate decides every candidate, writes the gated file and the queue, and says what waits and why", async () => {
  const w = world();
  const { code, io } = await gate(w);
  assert.equal(code, 0, io.err.join("\n"));
  const gated = readJson(join(w.out, "NET-100.gated.json"));
  assert.equal(gated.kind, "gated");
  assert.equal(gated.builtAt, "2026-10-17");
  assert.equal(gated.items.length, gated.stats.candidates);
  const queue = readJson(w.queue);
  assert.equal(queue.kind, "queue");
  assert.equal(queue.items.length, gated.stats.queued);
  assert.ok(queue.items.every((q) => q.decision === null));
  const text = io.out.join("\n");
  assert.match(
    text,
    /^NET-100: \d+ candidates: \d+ accepted \(\d+ core, \d+ supporting; 0 by earlier decisions\), \d+ rejected/m,
  );
  assert.match(text, / {2}queued: flagged \(\d+\)/);
  assert.match(
    text,
    / {2}queued: the judge is not sure \(low confidence\) \(\d+\)/,
  );
  assert.match(
    text,
    / {2}\d+ of the accepted carry a warning the gates accepted anyway \(the judge picked them and is sure of them\): /,
  );
  assert.match(text, /Wrote .*NET-100\.gated\.json and .*NET-100\.queue\.json/);
  assert.match(
    text,
    /warning: no learnsync data, so the age of a page is not checked/,
  );
});

test("the queue is read, answered by hand, applied, and nothing decided comes back", async () => {
  const w = world();
  await gate(w);
  const queue = readJson(w.queue);
  const before = queue.items.length;
  const reject = queue.items.find(
    (q) => q.source === "P4" && q.target.kind === "docs",
  );
  const accept = queue.items.find((q) => q.source === "P3");
  Object.assign(reject, {
    decision: "reject",
    note: "Another job.",
    excludeFamily: true,
  });
  Object.assign(accept, { decision: "accept" });
  write(w.queue, queue);

  const shown = await run(["show", "NET-100", "--out", w.out], w);
  assert.equal(shown.code, 0);
  assert.match(
    shown.io.out[0],
    /items in the queue \(\d+ pending, 2 answered, not yet applied\)/,
  );
  assert.ok(shown.io.out.some((l) => l.includes(`-> reject`)));

  const resolved = await run(
    ["resolve", "NET-100", "--out", w.out, "--decisions", w.decisions],
    w,
  );
  assert.equal(resolved.code, 0, resolved.io.err.join("\n"));
  assert.match(
    resolved.io.out[0],
    /2 decisions applied \(1 accepted, 1 rejected\), \d+ still pending/,
  );
  const store = readJson(w.decisions);
  assert.equal(store.code, "NET-100");
  assert.equal(store.decisions.length, 2);
  assert.equal(store.excludedFamilies.length, 1);
  assert.ok(
    store.decisions.every(
      (d) => d.by === "maintainer" && d.at === "2026-10-17",
    ),
  );
  const left = readJson(w.queue);
  assert.equal(
    left.items.length,
    before - 2,
    "the answered items leave the queue file",
  );

  // a gate run now uses what was decided
  const again = await gate(w, ["--decisions", w.decisions]);
  assert.equal(again.code, 0, again.io.err.join("\n"));
  const requeue = readJson(w.queue);
  const asked = new Set(requeue.items.map((q) => `${q.task}|${q.target.path}`));
  assert.ok(!asked.has(`${reject.task}|${reject.target.path}`));
  assert.ok(!asked.has(`${accept.task}|${accept.target.path}`));
  assert.ok(requeue.items.length < before);
  assert.match(again.io.out.join("\n"), /\d+ by earlier decisions/);
  const gated = readJson(join(w.out, "NET-100.gated.json"));
  const item = gated.items.find(
    (i) => i.target.path === accept.target.path && i.task.key === accept.task,
  );
  assert.equal(item.gate.decision, "accept");
  assert.equal(item.gate.by, "maintainer");
});

test("a queue with answers that were not applied is never overwritten by the next gate run", async () => {
  const w = world();
  await gate(w);
  const queue = readJson(w.queue);
  queue.items[0].decision = "accept";
  write(w.queue, queue);
  const refused = await gate(w);
  assert.equal(refused.code, 2);
  assert.match(
    refused.io.err.join("\n"),
    /has 1 answers that were not applied: run resolve NET-100 first/,
  );
  assert.equal(
    readJson(w.queue).items[0].decision,
    "accept",
    "the answer is still there",
  );
  const forced = await gate(w, ["--force"]);
  assert.equal(forced.code, 0);
  assert.equal(readJson(w.queue).items[0].decision, null);
});

test("resolve writes nothing when an answer is wrong, and says when there is nothing to apply", async () => {
  const w = world();
  await gate(w);
  const none = await run(
    ["resolve", "NET-100", "--out", w.out, "--decisions", w.decisions],
    w,
  );
  assert.equal(none.code, 0);
  assert.match(
    none.io.out[0],
    /no answers in the queue file \(\d+ items pending\)/,
  );
  assert.ok(!existsSync(w.decisions));

  const queue = readJson(w.queue);
  queue.items[0].decision = "accept";
  queue.items[1].decision = "yes please";
  write(w.queue, queue);
  const bad = await run(
    ["resolve", "NET-100", "--out", w.out, "--decisions", w.decisions],
    w,
  );
  assert.equal(bad.code, 1);
  assert.match(bad.io.err.join("\n"), /nothing was written/);
  assert.match(bad.io.err.join("\n"), /decision must be "accept" or "reject"/);
  assert.ok(
    !existsSync(w.decisions),
    "the valid answer was not applied either",
  );
});

test("a decision changed on purpose needs --replace", async () => {
  const w = world();
  await gate(w);
  let queue = readJson(w.queue);
  queue.items[0].decision = "accept";
  write(w.queue, queue);
  await run(
    ["resolve", "NET-100", "--out", w.out, "--decisions", w.decisions],
    w,
  );
  const store = readJson(w.decisions);
  // the same candidate comes up again (a fresh queue from the earlier file) and is answered differently
  await gate(w, ["--decisions", join(w.base, "none.json")]);
  queue = readJson(w.queue);
  const same = queue.items.find(
    (q) =>
      q.task === store.decisions[0].task &&
      q.target.path === store.decisions[0].target,
  );
  Object.assign(same, { decision: "reject", note: "Changed my mind." });
  write(w.queue, queue);
  const refused = await run(
    ["resolve", "NET-100", "--out", w.out, "--decisions", w.decisions],
    w,
  );
  assert.equal(refused.code, 1);
  assert.match(refused.io.err.join("\n"), /already decided/);
  const replaced = await run(
    [
      "resolve",
      "NET-100",
      "--out",
      w.out,
      "--decisions",
      w.decisions,
      "--replace",
    ],
    w,
  );
  assert.equal(replaced.code, 0, replaced.io.err.join("\n"));
  assert.equal(readJson(w.decisions).decisions[0].decision, "reject");
});

test("--urls rejects a candidate that is not a current Learn page", async () => {
  const w = world();
  const stale = "/training/modules/manage-traffic-routes";
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
  const result = await run(
    ["gate", "NET-100", "--out", w.out, "--urls"],
    w,
    capture(),
    { verdictsFor },
  );
  assert.equal(result.code, 0, result.io.err.join("\n"));
  const gated = readJson(join(w.out, "NET-100.gated.json"));
  const item = gated.items.find((i) => i.target.path === stale);
  assert.equal(item.gate.decision, "reject");
  assert.equal(item.gate.via, "current");
  assert.match(item.gate.reasons[0], /moved to \/training\/modules\/new/);
  assert.match(result.io.out.join("\n"), /\d+ not current/);
});

test("loadAges reads the age of a page from learnsync: lastmod for documentation, lastModified for a module and its units", () => {
  const base = mkdtempSync(join(tmpdir(), "course-gates-"));
  temps.push(base);
  mkdirSync(join(base, "data"), { recursive: true });
  writeFileSync(
    join(base, "data", "docs-urls.txt"),
    "/azure/old\t2024-01-01\n/azure/new\t2026-10-01T10:00:00Z\n/azure/undated\t-\n",
  );
  write(join(base, "data", "learn-catalog.json"), {
    modules: [
      {
        path: "/training/modules/m",
        lastModified: "2026-09-17T00:00:00+00:00",
      },
    ],
  });
  const ageOf = loadAges(base, "2026-10-17");
  assert.equal(
    ageOf({ kind: "docs", path: "/azure/old" }),
    1020,
    "days since 2024-01-01",
  );
  assert.equal(ageOf({ kind: "docs", path: "/azure/new" }), 16);
  assert.equal(ageOf({ kind: "docs", path: "/azure/undated" }), null);
  assert.equal(ageOf({ kind: "docs", path: "/azure/unknown" }), null);
  assert.equal(ageOf({ kind: "module", path: "/training/modules/m" }), 30);
  assert.equal(ageOf({ kind: "unit", path: "/training/modules/m/3-unit" }), 30);
  assert.equal(loadAges(null, "2026-10-17"), null);
  assert.equal(loadAges(join(base, "empty"), "2026-10-17"), null);
});

test("a gate run with learnsync data accepts an old page with a warning", async () => {
  const w = world();
  const dir = join(w.base, "learnsync");
  mkdirSync(join(dir, "data"), { recursive: true });
  const judged = exampleJudged({ units: "all" });
  const docs = judged.tasks
    .flatMap((t) => t.items)
    .find((i) => i.target.kind === "docs" && i.source === "P2");
  writeFileSync(
    join(dir, "data", "docs-urls.txt"),
    `${docs.target.path}\t2020-01-01\n`,
  );
  const { code, io } = await run(
    ["gate", "NET-100", "--out", w.out],
    w,
    capture(),
    { env: { LEARNSYNC_DIR: dir } },
  );
  assert.equal(code, 0, io.err.join("\n"));
  const item = readJson(join(w.out, "NET-100.gated.json")).items.find(
    (i) => i.target.path === docs.target.path && i.source === "P2",
  );
  assert.equal(item.gate.decision, "accept");
  assert.match(item.gate.warnings.join(), /not modified for \d+ months/);
});

test("the queue is described in a readable form, task by task", async () => {
  const w = world();
  await gate(w);
  const lines = describeQueue(readJson(w.queue));
  assert.match(lines[0], /^NET-100: \d+ items in the queue/);
  assert.ok(
    lines.some((l) => /^ {2}\[q001\] P\d (module|unit|docs) {2}/.test(l)),
  );
  assert.ok(
    lines.some((l) => /^ {6}https:\/\/learn\.microsoft\.com\//.test(l)),
  );
  assert.ok(
    lines.some((l) =>
      /^ {6}proposed: (core|supporting).*why it waits: /.test(l),
    ),
  );
  assert.ok(lines.some((l) => /^ {6}judge \((high|medium|low)\): /.test(l)));
  assert.ok(!lines.some((l) => /skeptic/.test(l)));
});

test("input errors are exit code 2 with a message, and a bad decisions file is exit code 1", async () => {
  const w = world();
  for (const [argv, pattern] of [
    [[], /A command is required/],
    [["wat", "X"], /Unknown command wat/],
    [["gate"], /An exam code is required/],
    [["gate", "A", "B"], /Too many arguments/],
    [["gate", "NET-100", "--wat"], /Unknown option --wat/],
    [["gate", "NET-100", "--out"], /--out needs a value/],
    [
      ["gate", "NET-100", "--today", "tomorrow"],
      /--today must be a YYYY-MM-DD day/,
    ],
    [
      ["show", "NET-100", "--out", join(w.base, "nowhere")],
      /the queue file not found/,
    ],
  ]) {
    const { code, io } = await run(argv, w);
    assert.equal(code, 2, argv.join(" "));
    assert.match(io.err.join("\n"), pattern);
  }
  const empty = world({ judged: false });
  const noFiles = await gate(empty);
  assert.equal(noFiles.code, 2);
  assert.match(noFiles.io.err.join("\n"), /No NET-100\.\*\.judged\.json files/);
  const noDir = await run(
    ["gate", "NET-100", "--judged", join(w.base, "nope"), "--out", w.out],
    w,
  );
  assert.match(
    noDir.io.err.join("\n"),
    /does not exist\. Run node scripts\/course-judge\.mjs merge first/,
  );
  const notJudged = world();
  write(join(notJudged.tmp, "course-judge", "NET-100.02-x.judged.json"), {
    kind: "batch",
  });
  const wrong = await gate(notJudged);
  assert.equal(wrong.code, 2);
  assert.match(wrong.io.err.join("\n"), /is not a judged file of NET-100/);

  mkdirSync(join(w.root, "src", "data_files", "course-decisions"), {
    recursive: true,
  });
  write(w.decisions, {
    schemaVersion: 1,
    code: "NET-100",
    decisions: [{ task: "t" }],
    excludedFamilies: [],
  });
  const bad = await gate(w);
  assert.equal(bad.code, 1);
  assert.match(bad.io.err.join("\n"), /The decisions file is not valid/);
  assert.match(bad.io.err.join("\n"), /needs a task and a target/);
});

test("with --urls and no learnsync checkout the run stops with a message", async () => {
  const w = world();
  const { code, io } = await gate(w, ["--urls"]);
  assert.equal(code, 2);
  assert.match(io.err.join("\n"), /--urls needs a learnsync checkout/);
});

test("the default folders are temporary ones and the decisions file is the repository's, written only by resolve", async () => {
  const w = world();
  const { code } = await run(["gate", "NET-100"], w);
  assert.equal(code, 0);
  assert.ok(existsSync(join(w.tmp, "course-gates", "NET-100.queue.json")));
  assert.ok(!existsSync(w.decisions), "gate never writes the decisions file");
  assert.deepEqual(
    readFileSync(join(w.tmp, "course-gates", "NET-100.gated.json"), "utf8")
      .length > 0,
    true,
  );
});

/** A course file with a review file beside it, three picks marked: the world of the review command. */
function reviewWorld() {
  const w = world({ judged: false });
  const { course } = exampleCourse();
  const picks = [...eachPick(course)].slice(0, 3);
  const courseFile = join(w.base, "course", "GH-900.json");
  mkdirSync(join(w.base, "course"), { recursive: true });
  write(courseFile, course);
  write(join(w.base, "course", "GH-900.review.json"), {
    schemaVersion: 1,
    kind: "review",
    code: "GH-900",
    builtAt: "2026-10-18",
    picks: picks.map(({ task, pick }) => ({
      task: task.key,
      path: pick.target.path,
      title: pick.title,
      kind: pick.target.kind,
      source: pick.source,
      class: pick.class,
      ...(pick.relation ? { relation: pick.relation } : {}),
      reasons: ["the judge is not sure (low confidence)"],
      why: "A reason.",
    })),
  });
  return {
    ...w,
    courseFile,
    decisions: join(w.base, "decisions", "GH-900.json"),
    picks,
  };
}

test("review: the dropped numbers are rejected, the others kept, and both are remembered in the decisions file", async () => {
  const w = reviewWorld();
  const { code, io } = await run(
    [
      "review",
      "GH-900",
      "--course",
      w.courseFile,
      "--drop",
      "2",
      "--note",
      "Not for this exam.",
      "--decisions",
      w.decisions,
    ],
    w,
  );
  assert.equal(code, 0, io.err.join("\n"));
  assert.match(
    io.out.join("\n"),
    /GH-900: 3 marked picks decided \(2 kept, 1 dropped\)\. Wrote .*GH-900\.json; run gate and build again\./,
  );
  const store = readJson(w.decisions);
  assert.equal(store.decisions.length, 3);
  const byTarget = new Map(store.decisions.map((d) => [d.target, d]));
  const decisionOf = (i) => byTarget.get(w.picks[i].pick.target.path);
  assert.equal(decisionOf(0).decision, "accept");
  assert.equal(decisionOf(0).by, "maintainer");
  assert.equal(decisionOf(1).decision, "reject");
  assert.equal(decisionOf(1).reason, "Not for this exam.");
  assert.equal(decisionOf(2).decision, "accept");
  // the numbers are the ones of the page
  const { numberReview } = await import("../../scripts/lib/course-render.mjs");
  const numbered = numberReview(
    readJson(w.courseFile),
    readJson(w.courseFile.replace(/\.json$/, ".review.json")),
  );
  assert.equal(numbered[1].path, w.picks[1].pick.target.path);

  // an answer already given is a problem unless it is changed on purpose
  const again = await run(
    [
      "review",
      "GH-900",
      "--course",
      w.courseFile,
      "--drop",
      "1",
      "--decisions",
      w.decisions,
    ],
    w,
  );
  assert.equal(again.code, 1);
  assert.match(again.io.err.join("\n"), /already decided/);
  const replaced = await run(
    [
      "review",
      "GH-900",
      "--course",
      w.courseFile,
      "--drop",
      "1",
      "--decisions",
      w.decisions,
      "--replace",
    ],
    w,
  );
  assert.equal(replaced.code, 0, replaced.io.err.join("\n"));
  assert.equal(
    readJson(w.decisions).decisions.filter((d) => d.decision === "reject")
      .length,
    1,
  );
});

test("review: nothing is written for a number that is not on the page, a missing option, or a review file of another build", async () => {
  const w = reviewWorld();
  const args = (...more) => [
    "review",
    "GH-900",
    "--course",
    w.courseFile,
    "--decisions",
    w.decisions,
    ...more,
  ];
  const off = await run(args("--drop", "4"), w);
  assert.equal(off.code, 2);
  assert.match(
    off.io.err.join("\n"),
    /--drop: 4 is not on the page \(the numbers go from 1 to 3\)/,
  );
  const bad = await run(args("--drop", "x"), w);
  assert.equal(bad.code, 2);
  const none = await run(["review", "GH-900", "--course", w.courseFile], w);
  assert.equal(none.code, 2);
  assert.match(
    none.io.err.join("\n"),
    /review needs --course FILE and --drop NUMBERS/,
  );
  // a review file that lists a pick the course no longer has
  const reviewFile = w.courseFile.replace(/\.json$/, ".review.json");
  const review = readJson(reviewFile);
  write(reviewFile, {
    ...review,
    picks: [...review.picks, { ...review.picks[0], path: "/azure/gone" }],
  });
  const stale = await run(args("--drop", "1"), w);
  assert.equal(stale.code, 1);
  assert.match(stale.io.err.join("\n"), /belongs to another build/);
  write(reviewFile, { ...review, code: "AZ-104" });
  const other = await run(args("--drop", "1"), w);
  assert.equal(other.code, 2);
  assert.ok(!existsSync(w.decisions), "nothing was written");
});

test("gate: by default the unsure picks are accepted and counted as marked for review, with --queue-unsure they wait", async () => {
  const w = world();
  const sheet = await gate(w);
  assert.equal(sheet.code, 0, sheet.io.err.join("\n"));
  const waiting = readJson(w.queue).items.length;
  assert.ok(waiting > 0);
  const marked = await run(["gate", "NET-100", "--out", w.out, "--force"], w);
  assert.equal(marked.code, 0, marked.io.err.join("\n"));
  assert.ok(readJson(w.queue).items.length < waiting);
  assert.match(
    marked.io.out.join("\n"),
    /\d+ of the accepted are marked for review on the course page/,
  );
});
