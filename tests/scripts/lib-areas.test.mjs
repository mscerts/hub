import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AREA_BY_PREFIX, EXAM_AREAS } from "../../scripts/lib/areas.mjs";

const root = resolve(import.meta.dirname, "../..");
const docs = join(root, "src", "content", "docs");

test("the exam areas are the seven folders of exam pages under src/content/docs", () => {
  assert.deepEqual(
    [...EXAM_AREAS],
    [
      "aibusiness",
      "azure",
      "dynamics",
      "github",
      "microsoft365",
      "power",
      "security",
    ],
  );
  for (const area of EXAM_AREAS) {
    assert.ok(statSync(join(docs, area)).isDirectory(), area);
    const pages = readdirSync(join(docs, area)).filter((file) =>
      /^[A-Z]{2}-\d{3}\.mdx$/.test(file),
    );
    assert.ok(pages.length > 0, `${area} holds no <CODE>.mdx exam page`);
  }
});

test("AREA_BY_PREFIX is the AREA_MAP of the page scaffold", () => {
  // scripts/new-exam.mjs runs on import (it reads the command line, can exit and
  // writes a page), so its map is read from the source.
  const source = readFileSync(join(root, "scripts", "new-exam.mjs"), "utf8");
  const body = source.match(/const AREA_MAP = \{([\s\S]*?)\};/)?.[1];
  if (!body) {
    // A scaffold without a map of its own must use this one.
    assert.match(source, /from "\.\/lib\/areas\.mjs"/);
    return;
  }
  const scaffold = Object.fromEntries(
    [...body.matchAll(/(\w+):\s*"(\w+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  assert.ok(Object.keys(scaffold).length > 0);
  assert.deepEqual(
    Object.entries(AREA_BY_PREFIX).sort(),
    Object.entries(scaffold).sort(),
  );
});

test("every prefix maps to an exam area, and every exam area has a prefix", () => {
  for (const [prefix, area] of Object.entries(AREA_BY_PREFIX)) {
    assert.match(prefix, /^[A-Z]{2}$/, prefix);
    assert.ok(EXAM_AREAS.includes(area), `${prefix} -> ${area}`);
    assert.ok(statSync(join(docs, area)).isDirectory(), `${prefix} -> ${area}`);
  }
  assert.deepEqual(
    [...new Set(Object.values(AREA_BY_PREFIX))].sort(),
    [...EXAM_AREAS].sort(),
    "an area without a prefix can never be reached from an exam code",
  );
});

test("the shared maps cannot be changed by one monitor for all the others", () => {
  assert.ok(Object.isFrozen(EXAM_AREAS));
  assert.ok(Object.isFrozen(AREA_BY_PREFIX));
  assert.throws(() => {
    AREA_BY_PREFIX.ZZ = "azure";
  }, TypeError);
  assert.throws(() => EXAM_AREAS.push("blog"), TypeError);
});

test("the module imports nothing", () => {
  const source = readFileSync(join(root, "scripts/lib/areas.mjs"), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\(|\brequire\(/m);
});
