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
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { main } from "../../scripts/course-propose.mjs";
import { buildProposalBatches } from "../../scripts/lib/course-propose.mjs";
import {
  EXAM,
  candidatesFile,
  worldPools,
} from "./helpers/example-judging.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
const root = resolve(import.meta.dirname, "../..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2));

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

/** A tmp hub with a stored guide: a real one (AZ-104) or the given lines. */
function world({ lines = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-propose-"));
  temps.push(base);
  const hub = join(base, "hub");
  mkdirSync(join(hub, "src", "data_files"), { recursive: true });
  const real = readJson(
    join(root, "tests/fixtures/course-source/guide-AZ-104.json"),
  );
  write(join(hub, "src", "data_files", "learn-exams.json"), {
    studyGuides: [{ ...real, ...(lines ? { lines } : {}) }],
  });
  return { base, hub, tmp: join(base, "tmp"), out: join(base, "out") };
}

const run = async (argv, w, extra = {}) => {
  const io = capture();
  const code = await main(argv, {
    root: w.hub,
    tmp: w.tmp,
    env: {},
    ...io,
    ...extra,
  });
  return { code, io };
};

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------
test("prepare writes a batch and a prompt for every skill group of the stored guide and says how big they are", async () => {
  const w = world();
  const { code, io } = await run(["prepare", "az-104", "--out", w.out], w);
  assert.equal(code, 0, io.err.join("\n"));
  const files = readdirSync(w.out).sort();
  assert.equal(files.length, 30, "15 skill groups, a batch and a prompt each");
  const prefix = join(
    w.out,
    "AZ-104.01-manage-microsoft-entra-users-and-groups",
  );
  const batch = readJson(`${prefix}.propose-batch.json`);
  assert.equal(batch.kind, "propose");
  assert.equal(batch.exam.code, "AZ-104");
  assert.equal(batch.exam.name, "Microsoft Azure Administrator");
  assert.equal(batch.tasks.length, 5);
  const prompt = readFileSync(`${prefix}.propose.md`, "utf8");
  assert.match(prompt, /Create users and groups/);
  assert.match(prompt, /AZ-104: Microsoft Azure Administrator/);
  assert.match(
    io.out.at(-1),
    /^15 batches, about \d+ prompt tokens in all\. Files are in /,
  );
});

test("prepare can be limited to one skill group, and says what it cannot do", async () => {
  const w = world();
  const one = await run(
    ["prepare", "AZ-104", "--group", "backup", "--out", w.out],
    w,
  );
  assert.equal(one.code, 0);
  assert.deepEqual(
    readdirSync(w.out)
      .map((f) => f.replace(/^AZ-104\.\d+-/, ""))
      .sort(),
    [
      "implement-backup-and-recovery.propose-batch.json",
      "implement-backup-and-recovery.propose.md",
    ],
  );
  const none = await run(
    ["prepare", "AZ-104", "--group", "nothing like it"],
    w,
  );
  assert.equal(none.code, 2);
  assert.match(
    none.io.err[0],
    /No skill group of AZ-104 contains "nothing like it"/,
  );
  const unknown = await run(["prepare", "XX-999"], w);
  assert.equal(unknown.code, 2);
  assert.match(unknown.io.err[0], /No stored study guide text for XX-999/);
  const broken = await run(
    ["prepare", "AZ-104"],
    world({ lines: ["not a guide"] }),
  );
  assert.equal(broken.code, 2);
  assert.match(broken.io.err[0], /does not parse completely/);
});

test("the command line refuses what it does not understand", async () => {
  const w = world();
  for (const [argv, pattern] of [
    [[], /A command is required/],
    [["nope", "AZ-104"], /Unknown command nope/],
    [["prepare"], /An exam code is required/],
    [["check"], /A file prefix is required/],
    [["prepare", "AZ-104", "--bogus"], /Unknown option --bogus/],
    [["prepare", "AZ-104", "--out"], /--out needs a value/],
    [["prepare", "AZ-104", "extra"], /Too many arguments/],
  ]) {
    const { code, io } = await run(argv, w);
    assert.equal(code, 2, argv.join(" "));
    assert.match(io.err[0], pattern);
    assert.match(io.err[0], /Usage: node scripts\/course-propose\.mjs/);
  }
});

// ---------------------------------------------------------------------------
// check and merge, on the invented corner of Learn
// ---------------------------------------------------------------------------
const T0 = "networking/configure/t0";
const T1 = "networking/configure/t1";

/** A tmp folder with the generator's candidates file, a proposals batch and (optionally) the model's answer. */
function proposed({ answer = "valid", withCandidates = true } = {}) {
  const w = world();
  const answers = join(w.tmp, "course-propose");
  mkdirSync(answers, { recursive: true });
  mkdirSync(join(w.tmp, "course-candidates"), { recursive: true });
  if (withCandidates)
    write(
      join(w.tmp, "course-candidates", `${EXAM.code}.candidates.json`),
      candidatesFile().candidates,
    );
  const [batch] = buildProposalBatches({
    tasks: [
      {
        key: T0,
        text: "Configure user-defined routes",
        domain: "Networking",
        group: "Configure virtual networks",
      },
      {
        key: T1,
        text: "Manage external users",
        domain: "Networking",
        group: "Configure virtual networks",
      },
    ],
    exam: EXAM,
  });
  const prefix = join(answers, `${EXAM.code}.01-configure-virtual-networks`);
  write(`${prefix}.propose-batch.json`, batch);
  const file = {
    schemaVersion: 1,
    kind: "proposals",
    batchId: batch.batchId,
    proposedBy: "test",
    tasks: [
      {
        task: T0,
        pages: [
          {
            path: "/azure/virtual-network/virtual-networks-udr-overview",
            title: "x",
            why: "Already found.",
          },
          {
            path: "/azure/network-watcher/next-hop-overview",
            title: "Next hop",
            why: "Finds the next hop.",
          },
          { path: "https://example.com/nope", title: "no" },
        ],
      },
      {
        task: T1,
        pages: [
          {
            path: "/azure/virtual-network/manage-route-table",
            title: "Route table",
            why: "Routes.",
          },
        ],
      },
    ],
  };
  if (answer === "valid") write(`${prefix}.proposals.json`, file);
  if (answer === "invalid")
    write(`${prefix}.proposals.json`, { ...file, batchId: "other" });
  return { ...w, answers, prefix };
}

const mergeDeps = { loadPoolsImpl: async () => worldPools() };

test("check accepts a valid answer and sends an invalid one back with the reasons", async () => {
  const ok = proposed();
  const good = await run(["check", ok.prefix], ok);
  assert.equal(good.code, 0, good.io.err.join("\n"));
  assert.match(good.io.out[0], /2 of 2 tasks answered, 4 pages proposed\./);
  const bad = proposed({ answer: "invalid" });
  const sent = await run(["check", bad.prefix], bad);
  assert.equal(sent.code, 1);
  assert.match(
    sent.io.err.join("\n"),
    /batchId must be "networking\/configure", not "other"/,
  );
  assert.match(sent.io.err.join("\n"), /1 problem in .*proposals\.json/);
  const missing = await run(["check", join(bad.answers, "nothing")], bad);
  assert.equal(missing.code, 2);
  assert.match(missing.io.err[0], /the batch file not found/);
});

test("merge adds what exists as P5, marks what the word search had, and reports what became of every proposal", async () => {
  const w = proposed();
  const { code, io } = await run(["merge", EXAM.code], w, mergeDeps);
  assert.equal(code, 0, io.err.join("\n"));
  const outFile = join(
    w.tmp,
    "course-candidates",
    `${EXAM.code}.proposed.json`,
  );
  const merged = readJson(outFile);
  const p5 = merged.tasks.flatMap((t) =>
    t.candidates
      .filter((c) => c.source === "P5")
      .map((c) => [t.key, c.target.path]),
  );
  assert.deepEqual(p5, [
    [T0, "/azure/network-watcher/next-hop-overview"],
    [T1, "/azure/virtual-network/manage-route-table"],
  ]);
  const also = merged.tasks
    .find((t) => t.key === T0)
    .candidates.find(
      (c) =>
        c.target.path ===
        "/azure/virtual-network/virtual-networks-udr-overview",
    );
  assert.equal(also.alsoProposed, true);
  const report = readJson(`${outFile}.report.json`);
  assert.equal(report.proposed, 4);
  assert.equal(report.added, 2);
  assert.equal(report.alreadyCandidates, 1);
  assert.deepEqual(report.unresolved, { "not-learn": 1 });
  const text = io.out.join("\n");
  assert.match(text, /4 pages proposed for 2 tasks:/);
  assert.match(text, /exist: 3 \(75%\)/);
  assert.match(
    text,
    /already on the shortlist: 1; new P5 candidates: 2 \(2 docs, 0 modules, 0 units\) for 2 tasks/,
  );
  assert.match(text, /not found: 1 \(not-learn 1\)/);
  assert.match(
    text,
    new RegExp(`Wrote ${outFile.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`),
  );
});

test("merge --only-new --out keeps only the new P5 candidates, for the judge", async () => {
  const w = proposed();
  const outFile = join(w.base, "only-new.json");
  const { code, io } = await run(
    ["merge", EXAM.code, "--only-new", "--out", outFile],
    w,
    mergeDeps,
  );
  assert.equal(code, 0, io.err.join("\n"));
  const merged = readJson(outFile);
  assert.deepEqual(
    merged.tasks.flatMap((t) => t.candidates).map((c) => c.source),
    ["P5", "P5"],
  );
  assert.match(io.out.at(-1), /\(the new P5 candidates only\)$/);
});

test("merge stops with a reason when it has nothing to merge or the answer is wrong", async () => {
  const none = proposed({ answer: "none" });
  const empty = await run(["merge", EXAM.code], none, mergeDeps);
  assert.equal(empty.code, 2);
  assert.match(empty.io.err[0], /No NET-100\.\*\.proposals\.json files in /);

  const noDir = proposed();
  const gone = await run(
    ["merge", EXAM.code, "--answers", join(noDir.base, "missing")],
    noDir,
    mergeDeps,
  );
  assert.equal(gone.code, 2);
  assert.match(
    gone.io.err[0],
    /No proposals: .* does not exist\. Run prepare first\./,
  );

  const bad = proposed({ answer: "invalid" });
  const invalid = await run(["merge", EXAM.code], bad, mergeDeps);
  assert.equal(invalid.code, 1);
  assert.match(
    invalid.io.err.join("\n"),
    /is not valid: fix it \(node scripts\/course-propose\.mjs check /,
  );
  assert.equal(
    existsSync(
      join(bad.tmp, "course-candidates", `${EXAM.code}.proposed.json`),
    ),
    false,
    "nothing is written",
  );

  const noCandidates = proposed({ withCandidates: false });
  const missing = await run(["merge", EXAM.code], noCandidates, mergeDeps);
  assert.equal(missing.code, 2);
  assert.match(missing.io.err[0], /the candidates file not found/);

  const other = proposed();
  write(join(other.tmp, "course-candidates", `${EXAM.code}.candidates.json`), {
    ...candidatesFile().candidates,
    code: "OTHER-1",
  });
  const wrong = await run(["merge", EXAM.code], other, mergeDeps);
  assert.equal(wrong.code, 2);
  assert.match(wrong.io.err[0], /is for OTHER-1, not NET-100/);

  const down = proposed();
  const failing = await run(["merge", EXAM.code], down, {
    loadPoolsImpl: async () => {
      throw new Error("no learnsync data");
    },
  });
  assert.equal(failing.code, 2);
  assert.match(failing.io.err[0], /Cannot load the inputs: no learnsync data/);
});

test("merge --probe asks Learn about the addresses the catalogs do not know and keeps the pages it redirects to", async () => {
  const w = proposed();
  const file = `${w.prefix}.proposals.json`;
  const answer = readJson(file);
  answer.tasks[1].pages.push(
    {
      path: "/azure/virtual-network/old-route-table",
      title: "old",
      why: "Moved.",
    },
    { path: "/azure/virtual-network/never-existed", title: "none" },
  );
  write(file, answer);
  const asked = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    return path === "/azure/virtual-network/old-route-table"
      ? {
          ok: true,
          url: "https://learn.microsoft.com/en-us/azure/network-watcher/next-hop-overview",
          body: null,
        }
      : { ok: false, status: 404, url, body: null };
  };
  const { code, io } = await run(["merge", EXAM.code, "--probe"], w, {
    ...mergeDeps,
    fetchImpl,
    env: { PROBE_DELAY_MS: "0" },
  });
  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(asked.sort(), [
    "/azure/virtual-network/never-existed",
    "/azure/virtual-network/old-route-table",
  ]);
  const outFile = join(
    w.tmp,
    "course-candidates",
    `${EXAM.code}.proposed.json`,
  );
  const report = readJson(`${outFile}.report.json`);
  assert.deepEqual(report.probe, { asked: 2, moved: 1, failed: 1 });
  assert.equal(report.how.live, 1);
  assert.deepEqual(report.unresolved, { "not-learn": 1, "not-found": 1 });
  const moved = readJson(outFile)
    .tasks.flatMap((t) => t.candidates)
    .find((c) => c.proposal?.how === "live");
  assert.equal(moved.target.path, "/azure/network-watcher/next-hop-overview");
  assert.equal(moved.proposal.asked, "/azure/virtual-network/old-route-table");
  assert.match(
    io.out.join("\n"),
    /Asking learn\.microsoft\.com about 2 addresses the catalogs do not know/,
  );
  assert.match(io.out.join("\n"), /after a live redirect 1/);
  // without --probe nothing is asked
  const quiet = proposed();
  write(`${quiet.prefix}.proposals.json`, answer);
  let calls = 0;
  const off = await run(["merge", EXAM.code], quiet, {
    ...mergeDeps,
    fetchImpl: async () => {
      calls++;
    },
  });
  assert.equal(off.code, 0);
  assert.equal(calls, 0);
});
