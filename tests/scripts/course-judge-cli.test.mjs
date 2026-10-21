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
import { main } from "../../scripts/course-judge.mjs";
import {
  EXAM,
  candidatesFile,
  judgmentsFor,
  worldPools,
} from "./helpers/example-judging.mjs";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2));

/** A tmp folder with the candidates file where the generator writes it, and a stored study guide. */
function world({ guideHash = "guide-hash", withCandidates = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "course-judge-"));
  temps.push(base);
  const tmp = join(base, "tmp");
  mkdirSync(join(tmp, "course-candidates"), { recursive: true });
  const { candidates } = candidatesFile();
  if (withCandidates)
    write(
      join(tmp, "course-candidates", `${EXAM.code}.candidates.json`),
      candidates,
    );
  const root = join(base, "hub");
  mkdirSync(join(root, "src", "data_files"), { recursive: true });
  write(join(root, "src", "data_files", "learn-exams.json"), {
    studyGuides: [
      { code: EXAM.code, name: EXAM.name, hash: guideHash, lines: ["x"] },
    ],
  });
  return { base, tmp, root, out: join(base, "out") };
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
    loadPoolsImpl: async () => worldPools(),
    ...io,
    ...extra,
  });
  return { code, io };
};

/** prepare, then the path prefix of the only batch. */
async function prepared(w, extra = []) {
  const { code, io } = await run(
    ["prepare", EXAM.code, "--out", w.out, ...extra],
    w,
  );
  assert.equal(code, 0, io.err.join("\n"));
  const prefix = join(w.out, `${EXAM.code}.01-configure-virtual-networks`);
  return { prefix, io, batch: readJson(`${prefix}.batch.json`) };
}

test("prepare writes a batch and a prompt for each skill group and says how big the prompts are", async () => {
  const w = world();
  const { prefix, io, batch } = await prepared(w);
  assert.deepEqual(readdirSync(w.out).sort(), [
    `${EXAM.code}.01-configure-virtual-networks.batch.json`,
    `${EXAM.code}.01-configure-virtual-networks.judge.md`,
  ]);
  assert.equal(batch.kind, "judge");
  assert.equal(
    batch.exam.name,
    "Network Administrator",
    "the exam name comes from the stored guide",
  );
  const prompt = readFileSync(`${prefix}.judge.md`, "utf8");
  assert.match(prompt, /Judge the candidates of one skill group/);
  assert.match(
    io.out[0],
    /01-configure-virtual-networks: 2 tasks, \d+ candidates, prompt about \d+ tokens/,
  );
  assert.match(io.out.at(-1), /^1 batches, about \d+ prompt tokens in all/);
});

test("prepare --max-candidates cuts a group into parts that each get their own files; a bad value is a usage error", async () => {
  const w = world();
  const { code, io } = await run(
    ["prepare", EXAM.code, "--out", w.out, "--max-candidates", "6"],
    w,
  );
  assert.equal(code, 0, io.err.join("\n"));
  const batchFiles = readdirSync(w.out)
    .filter((f) => f.endsWith(".batch.json"))
    .sort();
  assert.ok(batchFiles.length > 1);
  batchFiles.forEach((f, n) =>
    assert.equal(
      f,
      `${EXAM.code}.${String(n + 1).padStart(2, "0")}-configure-virtual-networks-p${n + 1}of${batchFiles.length}.batch.json`,
    ),
  );
  const first = readJson(join(w.out, batchFiles[0]));
  assert.deepEqual(first.part, { n: 1, of: batchFiles.length });
  const prompt = readFileSync(
    join(w.out, batchFiles[0].replace(".batch.json", ".judge.md")),
    "utf8",
  );
  assert.match(prompt, /This is part 1 of \d+ of the group/);
  assert.match(
    io.out.at(-1),
    new RegExp(`^${batchFiles.length} batches, about \\d+ prompt tokens`),
  );
  for (const bad of ["0", "x", "2.5"]) {
    const r = await run(
      ["prepare", EXAM.code, "--out", w.out, "--max-candidates", bad],
      w,
    );
    assert.equal(r.code, 2, bad);
    assert.match(
      r.io.err.join("\n"),
      /--max-candidates must be a whole number of at least 1/,
    );
  }
});

test("prepare without --out writes to a temporary folder, never to the repository", async () => {
  const w = world();
  const { code } = await run(["prepare", EXAM.code], w);
  assert.equal(code, 0);
  assert.ok(
    existsSync(
      join(
        w.tmp,
        "course-judge",
        `${EXAM.code}.01-configure-virtual-networks.batch.json`,
      ),
    ),
  );
  assert.deepEqual(readdirSync(w.root), ["src"]);
});

test("prepare --group keeps the groups that contain the text", async () => {
  const w = world();
  const ok = await run(
    ["prepare", EXAM.code, "--out", w.out, "--group", "VIRTUAL networks"],
    w,
  );
  assert.equal(ok.code, 0);
  const none = await run(
    ["prepare", EXAM.code, "--out", w.out, "--group", "billing"],
    w,
  );
  assert.equal(none.code, 2);
  assert.match(
    none.io.err.join("\n"),
    /No skill group of NET-100 contains "billing"/,
  );
});

test("prepare warns when the candidates were built from another study guide text", async () => {
  const w = world({ guideHash: "another-hash" });
  const { io } = await prepared(w);
  assert.match(
    io.out.join("\n"),
    /warning: the candidates were built from another study guide text/,
  );
});

test("prepare needs the candidates and the stored guide", async () => {
  const w = world({ withCandidates: false });
  const missing = await run(["prepare", EXAM.code, "--out", w.out], w);
  assert.equal(missing.code, 2);
  assert.match(
    missing.io.err.join("\n"),
    /No candidates file for NET-100.*Run node scripts\/course-candidates\.mjs NET-100 first/,
  );
  const other = world();
  const noGuide = await run(
    [
      "prepare",
      "XX-999",
      "--out",
      other.out,
      "--candidates",
      join(other.tmp, "course-candidates", "NET-100.candidates.json"),
    ],
    other,
  );
  assert.equal(noGuide.code, 2);
  assert.match(noGuide.io.err.join("\n"), /is for NET-100, not XX-999/);
  const cannotLoad = await run(
    ["prepare", EXAM.code, "--out", other.out],
    other,
    capture(),
    {
      loadPoolsImpl: async () => {
        throw new Error("learnsync is not there");
      },
    },
  );
  assert.equal(cannotLoad.code, 2);
  assert.match(
    cannotLoad.io.err.join("\n"),
    /Cannot load the inputs: learnsync is not there/,
  );
});

test("check passes a clean answer and sends back one with a made-up quote", async () => {
  const w = world();
  const { prefix, batch } = await prepared(w);
  write(`${prefix}.judgments.json`, judgmentsFor(batch));
  const ok = await run(["check", prefix], w);
  assert.equal(ok.code, 0, ok.io.err.join("\n"));
  assert.match(
    ok.io.out[0],
    /\d+ candidates judged, \d+ picks, every quote is in the evidence/,
  );

  write(
    `${prefix}.judgments.json`,
    judgmentsFor(batch, (j) =>
      j.verdict === "core" ? { ...j, quote: "from my imagination" } : j,
    ),
  );
  const bad = await run(["check", prefix], w);
  assert.equal(bad.code, 1);
  const text = bad.io.out.join("\n");
  assert.match(text, /the judgments need another pass/);
  assert.match(text, /the quote is not in the evidence: "from my imagination"/);

  const kept = await run(["check", prefix, "--keep-unverified"], w);
  assert.equal(kept.code, 0, "kept on request");

  write(`${prefix}.judgments.json`, { ...judgmentsFor(batch), judgments: [] });
  const empty = await run(["check", prefix], w);
  assert.equal(empty.code, 1);
  assert.match(empty.io.out.join("\n"), /not judged/);
});

test("merge writes the judge's answers into one judged file, and refuses an answer that is not valid", async () => {
  const w = world();
  const { prefix, batch } = await prepared(w);
  write(
    `${prefix}.judgments.json`,
    judgmentsFor(batch, (j) =>
      j.verdict === "core" ? { ...j, quote: "not there" } : j,
    ),
  );
  const refused = await run(["merge", prefix], w);
  assert.equal(refused.code, 1);
  assert.match(refused.io.err.join("\n"), /nothing was written/);
  assert.ok(!existsSync(`${prefix}.judged.json`));

  write(`${prefix}.judgments.json`, judgmentsFor(batch));
  const merged = await run(["merge", prefix], w);
  assert.equal(merged.code, 0, merged.io.err.join("\n"));
  const judged = readJson(`${prefix}.judged.json`);
  assert.equal(judged.kind, "judged");
  assert.ok(judged.stats.core > 0);
  assert.equal(judged.stats.agree, undefined);
  assert.match(
    merged.io.out[0],
    /candidates: \d+ core, \d+ supporting, \d+ reject\. Wrote/,
  );
});

test("there is no skeptic command and no --no-skeptic option any more", async () => {
  const w = world();
  const command = await run(["skeptic", "x"], w);
  assert.equal(command.code, 2);
  assert.match(command.io.err.join("\n"), /Unknown command skeptic/);
  const option = await run(["merge", "x", "--no-skeptic"], w);
  assert.equal(option.code, 2);
  assert.match(option.io.err.join("\n"), /Unknown option --no-skeptic/);
});

test("merge keeps a quote that is not in the evidence only when asked, and marks it", async () => {
  const w = world();
  const { prefix, batch } = await prepared(w);
  write(
    `${prefix}.judgments.json`,
    judgmentsFor(batch, (j, c) =>
      c.source === "P2" ? { ...j, quote: "never said" } : j,
    ),
  );
  const refused = await run(["merge", prefix], w);
  assert.equal(refused.code, 1);
  assert.match(refused.io.err.join("\n"), /The judgments are not valid/);
  const kept = await run(["merge", prefix, "--keep-unverified"], w);
  assert.equal(kept.code, 0);
  assert.match(kept.io.out[0], /\d+ unverified quotes kept/);
  assert.equal(
    readJson(`${prefix}.judged.json`).stats.unverifiedQuotes > 0,
    true,
  );
});

test("usage and input errors are exit code 2 with a message", async () => {
  const w = world();
  for (const [argv, pattern] of [
    [[], /A command is required/],
    [["wat", "x"], /Unknown command wat/],
    [["prepare"], /An exam code is required/],
    [["check"], /A file prefix is required/],
    [["check", "a", "b"], /Too many arguments/],
    [["check", "a", "--wat"], /Unknown option --wat/],
    [["prepare", "NET-100", "--out"], /--out needs a value/],
    [["check", join(w.base, "missing")], /the batch file not found/],
  ]) {
    const { code, io } = await run(argv, w);
    assert.equal(code, 2, argv.join(" "));
    assert.match(io.err.join("\n"), pattern);
  }
  mkdirSync(w.out, { recursive: true });
  writeFileSync(join(w.out, "x.batch.json"), "{ not json");
  const broken = await run(["check", join(w.out, "x")], w);
  assert.equal(broken.code, 2);
  assert.match(broken.io.err.join("\n"), /the batch file is not valid JSON/);
});
