import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  annotate,
  appendStepSummary,
  warnLoud,
  writeOutput,
} from "../../scripts/lib/actions.mjs";

const root = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "lib-actions-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const tempFile = () => join(dir, `file-${counter++}`);

/** What console.log and console.error print while the test runs. */
function capture(t) {
  const printed = { out: [], err: [] };
  t.mock.method(console, "log", (...args) => printed.out.push(args.join(" ")));
  t.mock.method(console, "error", (...args) =>
    printed.err.push(args.join(" ")),
  );
  return printed;
}

function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** The outputs as the runner reads them: one `key=value` per line. */
const readOutputs = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]);

// ---------------------------------------------------------------------------
// writeOutput
// ---------------------------------------------------------------------------
test("writeOutput appends one key=value line per output and keeps the case", () => {
  const file = tempFile();
  writeOutput(file, {
    changes_found: true,
    count: 3,
    issue_title: "New Microsoft Learn exam: AZ-104, Beta = yes",
  });
  assert.equal(
    readFileSync(file, "utf8"),
    "changes_found=true\ncount=3\nissue_title=New Microsoft Learn exam: AZ-104, Beta = yes\n",
  );
  writeOutput(file, { more: "x" });
  assert.deepEqual(
    readOutputs(file).map(([key]) => key),
    ["changes_found", "count", "issue_title", "more"],
    "appended, not overwritten",
  );
});

test("a line break in a value can never start another output", () => {
  const file = tempFile();
  writeOutput(file, {
    issue_title: "one\r\ntwo\nextra_output=injected\n\n\nthree\r",
    ok: true,
  });
  assert.equal(
    readFileSync(file, "utf8"),
    "issue_title=one two extra_output=injected three \nok=true\n",
  );
  assert.deepEqual(
    readOutputs(file).map(([key]) => key),
    ["issue_title", "ok"],
  );
});

test("lowercase reproduces the monitors that lower-cased their booleans and counts", () => {
  const file = tempFile();
  writeOutput(
    file,
    {
      changes_found: true,
      extraction_failed: false,
      Count: 12,
      Name: "AbC\nDeF",
    },
    { lowercase: true },
  );
  assert.equal(
    readFileSync(file, "utf8"),
    "changes_found=true\nextraction_failed=false\nCount=12\nName=abc def\n",
    "values are lower-cased, keys are not",
  );
  const kept = tempFile();
  writeOutput(kept, { Name: "AbC" }, { lowercase: false });
  assert.equal(readFileSync(kept, "utf8"), "Name=AbC\n");
});

test("it agrees with the copies it replaces for what they wrote", () => {
  // The two kinds of copy: keep the case and flatten line breaks, or lower-case.
  const keep = (obj) =>
    Object.entries(obj)
      .map(
        ([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ")}\n`,
      )
      .join("");
  const lower = (obj) =>
    Object.entries(obj)
      .map(([key, value]) => `${key}=${String(value).toLowerCase()}\n`)
      .join("");
  const flags = { changes_found: true, baseline_updated: false, count: 0 };
  const text = {
    issue_title: "Lab repos 2026-10-14: 1 linked repository",
    note: "a\r\nb",
    ...flags,
  };
  const a = tempFile();
  const b = tempFile();
  writeOutput(a, text);
  writeOutput(b, flags, { lowercase: true });
  assert.equal(readFileSync(a, "utf8"), keep(text));
  assert.equal(readFileSync(b, "utf8"), lower(flags));
});

test("without a file there is nothing to write and nothing fails", () => {
  for (const file of [undefined, null, ""]) {
    assert.doesNotThrow(() => writeOutput(file, { changes_found: true }));
  }
});

test("a file that cannot be appended to is an error, not silence", () => {
  assert.throws(() => writeOutput(dir, { changes_found: true }));
});

// ---------------------------------------------------------------------------
// annotate
// ---------------------------------------------------------------------------
test("annotate prints a workflow command for each level", (t) => {
  const { out } = capture(t);
  annotate("error", "it broke");
  annotate("warning", "careful");
  annotate("notice", "fyi");
  assert.deepEqual(out, [
    "::error::it broke",
    "::warning::careful",
    "::notice::fyi",
  ]);
});

test("annotate escapes the message: percent, CR and LF, nothing else", (t) => {
  const { out } = capture(t);
  annotate("warning", "100% done\r\nnext line\nlast: a, b");
  assert.deepEqual(out, ["::warning::100%25 done%0D%0Anext line%0Alast: a, b"]);
});

test("annotate escapes the properties as well: colon and comma too", (t) => {
  const { out } = capture(t);
  annotate("notice", "msg", { title: "Lab repos: a, b" });
  annotate("error", "msg", { title: "100%\nof: it", file: "src/a,b.mjs" });
  assert.deepEqual(out, [
    "::notice title=Lab repos%3A a%2C b::msg",
    "::error title=100%25%0Aof%3A it,file=src/a%2Cb.mjs::msg",
  ]);
});

test("annotate takes title, file and line, in that order, and leaves out what is missing", (t) => {
  const { out } = capture(t);
  annotate("error", "m", { line: 12, file: "a.mjs", title: "T" });
  annotate("error", "m", { file: "a.mjs", line: 3 });
  annotate("error", "m", { title: "", file: undefined, line: null });
  annotate("error", "m", {});
  assert.deepEqual(out, [
    "::error title=T,file=a.mjs,line=12::m",
    "::error file=a.mjs,line=3::m",
    "::error::m",
    "::error::m",
  ]);
});

test("annotate takes what the monitors pass: a number, an Error, nothing", (t) => {
  const { out } = capture(t);
  annotate("warning", 42);
  annotate("warning", new Error("boom"));
  annotate("warning", undefined);
  assert.deepEqual(out, [
    "::warning::42",
    "::warning::Error: boom",
    "::warning::",
  ]);
});

test("annotate refuses a level GitHub would ignore", (t) => {
  const { out } = capture(t);
  assert.throws(() => annotate("note", "m"), RangeError);
  assert.throws(() => annotate("Warning", "m"), RangeError);
  assert.throws(() => annotate(undefined, "m"), RangeError);
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// warnLoud
// ---------------------------------------------------------------------------
test("warnLoud writes to stderr everywhere and annotates only on a GitHub runner", (t) => {
  const printed = capture(t);
  withEnv("GITHUB_ACTIONS", undefined, () =>
    warnLoud("careful", { title: "Source Watch" }),
  );
  assert.deepEqual(printed.err, ["WARNING: careful"]);
  assert.deepEqual(printed.out, []);

  withEnv("GITHUB_ACTIONS", "true", () =>
    warnLoud("careful", { title: "Source Watch" }),
  );
  assert.deepEqual(printed.err, ["WARNING: careful", "WARNING: careful"]);
  assert.deepEqual(printed.out, ["::warning title=Source Watch::careful"]);

  // Only the exact value GitHub sets counts.
  withEnv("GITHUB_ACTIONS", "1", () => warnLoud("again"));
  assert.equal(printed.out.length, 1);
});

test("warnLoud without a title annotates without one; a multi-line message stays one command", (t) => {
  const printed = capture(t);
  withEnv("GITHUB_ACTIONS", "true", () => {
    warnLoud("plain");
    warnLoud("100% sure:\nsecond line");
  });
  assert.deepEqual(printed.out, [
    "::warning::plain",
    "::warning::100%25 sure:%0Asecond line",
  ]);
  assert.deepEqual(printed.err, [
    "WARNING: plain",
    "WARNING: 100% sure:\nsecond line",
  ]);
});

test("warnLoud prints what the copy in every monitor printed", (t) => {
  // The copy of source-watch.mjs (the title was the only difference).
  const legacyWarnLoud = (message) => {
    console.error(`WARNING: ${message}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      const escaped = message
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");
      console.log(`::warning title=Source Watch::${escaped}`);
    }
  };
  const printed = capture(t);
  const run = (warn, message) => {
    printed.out.length = 0;
    printed.err.length = 0;
    warn(message);
    return { out: [...printed.out], err: [...printed.err] };
  };
  for (const actions of ["true", undefined]) {
    for (const message of [
      "could not fetch: HTTP 500",
      "100% of 3\r\nsources, kept: a, b\n",
      "",
    ]) {
      withEnv("GITHUB_ACTIONS", actions, () => {
        assert.deepEqual(
          run((m) => warnLoud(m, { title: "Source Watch" }), message),
          run(legacyWarnLoud, message),
          JSON.stringify([actions, message]),
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// appendStepSummary
// ---------------------------------------------------------------------------
test("appendStepSummary appends the markdown with a trailing newline", () => {
  const file = tempFile();
  assert.equal(appendStepSummary(file, "### First"), true);
  assert.equal(appendStepSummary(file, "- a\n- b"), true);
  assert.equal(readFileSync(file, "utf8"), "### First\n- a\n- b\n");
});

test("appendStepSummary without a file does nothing and does not fail", (t) => {
  const printed = capture(t);
  for (const file of [undefined, null, ""]) {
    assert.equal(appendStepSummary(file, "### Nothing"), false);
  }
  assert.deepEqual(printed, { out: [], err: [] });
});

test("a summary file that cannot be written is a warning on stderr, not an error", (t) => {
  const printed = capture(t);
  const missing = join(dir, "no-such-folder", "summary.md");
  assert.equal(appendStepSummary(missing, "### Lost"), false);
  assert.equal(existsSync(missing), false);
  assert.equal(printed.err.length, 1);
  assert.match(printed.err[0], /^WARNING: could not write the step summary \(/);
  assert.deepEqual(printed.out, []);
});

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------
test("the module imports only node: built-ins, so the monitors run without pnpm install", () => {
  const source = readFileSync(join(root, "scripts/lib/actions.mjs"), "utf8");
  const specifiers = [
    ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g),
  ].map((match) => match[1] ?? match[2]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);
});
