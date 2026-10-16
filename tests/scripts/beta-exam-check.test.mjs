import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  monitorRunner,
  startServer,
} from "../fixtures/legacy-monitors/harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts", "beta-exam-check.mjs");

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const page = (title) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><main>exam</main></body></html>`;
const BETA = (code) => page(`Exam ${code} (beta) | Microsoft Learn`);
const GA = (code) => page(`Exam ${code} | Microsoft Learn`);

const entry = (server, code, extra = {}) => ({
  code,
  area: "azure",
  name: `Exam ${code}`,
  url: `${server.origin}/exams/${code.toLowerCase()}`,
  betaStart: "2026-07-28",
  announcement: "pending",
  flaggedGA: false,
  ...extra,
});

const without = (object, ...keys) =>
  Object.fromEntries(
    Object.entries(object).filter(([key]) => !keys.includes(key)),
  );

async function setup(entries) {
  const dir = mkdtempSync(join(tmpdir(), "beta-exam-check-"));
  scratchDirs.push(dir);
  const server = await startServer();
  const examsFile = join(dir, "beta-exams.json");
  const write = (text) => writeFileSync(examsFile, text);
  if (entries) {
    write(
      JSON.stringify(
        { lastSynced: "2026-09-16", exams: entries(server) },
        null,
        2,
      ) + "\n",
    );
  }
  const monitor = monitorRunner({
    script,
    dir,
    env: { EXAMS_FILE: examsFile, FETCH_DELAY_MS: "0" },
  });
  return {
    server,
    run: monitor.run,
    write,
    examsText: () => readFileSync(examsFile, "utf8"),
    exams: () => JSON.parse(readFileSync(examsFile, "utf8")).exams,
    // what the Learn page of an exam says
    serve: (code, html) =>
      server.route(`/exams/${code.toLowerCase()}`, { body: html }),
    close: () => server.close(),
  };
}

const QUIET = {
  changes_found: "false",
  baseline_updated: "false",
  extraction_failed: "false",
};

test("an exam whose page lost the (beta) marker is reported once and flagged; the others are left alone", async () => {
  const site = await setup((server) => [
    entry(server, "AB-650"),
    entry(server, "AZ-401"),
    entry(server, "GH-700", { flaggedGA: true, flaggedAt: "2026-09-01" }),
  ]);
  try {
    site.serve("AB-650", GA("AB-650"));
    site.serve("AZ-401", BETA("AZ-401"));
    site.serve("GH-700", GA("GH-700"));

    const run = await site.run();
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.outputs, {
      changes_found: "true",
      baseline_updated: "true",
      extraction_failed: "false",
    });
    assert.match(run.stdout, /AZ-401 is still in beta\./);
    assert.match(run.stdout, /AB-650 no longer shows a beta marker/);

    const [ab, az, gh] = site.exams();
    assert.equal(ab.flaggedGA, true);
    assert.match(ab.flaggedAt, /^\d{4}-\d{2}-\d{2}$/);
    // everything else of the entry survives the rewrite
    assert.deepEqual(
      without(ab, "flaggedGA", "flaggedAt"),
      without(entry(site.server, "AB-650"), "flaggedGA"),
    );
    assert.deepEqual(az, entry(site.server, "AZ-401"));
    assert.equal(gh.flaggedAt, "2026-09-01", "a flagged exam keeps its date");
    // an exam that is flagged already is not fetched at all
    assert.ok(!site.server.hits.includes("/exams/gh-700"));

    // the report names the exam that went GA, and only that one
    assert.match(run.report, /^## Beta exam\(s\) now generally available/);
    assert.ok(
      run.report.includes(`| AB-650 | Exam AB-650 | [Link](${ab.url}) |`),
    );
    assert.ok(!run.report.includes("AZ-401"));
    assert.ok(!run.report.includes("GH-700"));
  } finally {
    await site.close();
  }
});

test("an exam is reported once: the next run finds nothing to say and does not rewrite the tracker", async () => {
  const site = await setup((server) => [
    entry(server, "AB-650"),
    entry(server, "AZ-401"),
  ]);
  try {
    site.serve("AB-650", GA("AB-650"));
    site.serve("AZ-401", BETA("AZ-401"));
    const first = await site.run();
    assert.equal(first.outputs.changes_found, "true");
    const flagged = site.examsText();

    for (let day = 0; day < 2; day++) {
      const quiet = await site.run();
      assert.equal(quiet.code, 0, quiet.stderr);
      assert.deepEqual(quiet.outputs, QUIET);
      assert.equal(quiet.report, null);
      assert.equal(site.examsText(), flagged);
    }
    // the exam that was reported is not asked about again, the one still in beta is
    assert.deepEqual(
      site.server.hits.filter((path) => path === "/exams/ab-650"),
      ["/exams/ab-650"],
    );
    assert.equal(
      site.server.hits.filter((path) => path === "/exams/az-401").length,
      3,
    );
  } finally {
    await site.close();
  }
});

test("while every exam is still in beta, or none is left to check, nothing is written", async () => {
  const site = await setup((server) => [
    entry(server, "AZ-401"),
    entry(server, "GH-700"),
  ]);
  try {
    const before = site.examsText();
    site.serve("AZ-401", BETA("AZ-401"));
    site.serve("GH-700", BETA("GH-700"));
    const beta = await site.run();
    assert.deepEqual(beta.outputs, QUIET);
    assert.equal(beta.report, null);
    assert.equal(site.examsText(), before);

    // a page without a <title> proves nothing: it is skipped, never flagged
    site.serve("AZ-401", "<html><body>no title</body></html>");
    const untitled = await site.run();
    assert.deepEqual(untitled.outputs, QUIET);
    assert.match(untitled.stderr, /could not find a <title> on AZ-401's page/);
    assert.equal(site.examsText(), before);
  } finally {
    await site.close();
  }

  const flagged = await setup((server) => [
    entry(server, "AZ-401", { flaggedGA: true }),
  ]);
  try {
    const before = flagged.examsText();
    const run = await flagged.run();
    assert.deepEqual(run.outputs, QUIET);
    assert.match(run.stdout, /No untracked-as-GA beta exams to check\./);
    assert.deepEqual(flagged.server.hits, []);
    assert.equal(flagged.examsText(), before);
  } finally {
    await flagged.close();
  }
});

test("a missing or corrupt tracker fails the run with extraction_failed", async () => {
  const site = await setup();
  try {
    const missing = await site.run();
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.outputs, { ...QUIET, extraction_failed: "true" });
    assert.match(missing.error, /Tracker file not found at /);

    site.write("{ not json");
    const corrupt = await site.run();
    assert.equal(corrupt.code, 1);
    assert.equal(corrupt.outputs.extraction_failed, "true");
    assert.match(corrupt.error, /Corrupt tracker file .*\(invalid JSON\)/);
    assert.equal(site.examsText(), "{ not json", "the file is not touched");

    site.write('{ "exams": "nope" }');
    const shapeless = await site.run();
    assert.equal(shapeless.code, 1);
    assert.match(shapeless.error, /missing exams array/);
  } finally {
    await site.close();
  }
});
