import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";

const root = resolve(import.meta.dirname, "../..");
// LF whatever the checkout did to the files (core.autocrlf on Windows).
const lf = (text) => text.replace(/\r\n/g, "\n");
const stripComments = (text) =>
  text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "");

const NOTE =
  /about 8 weeks after an exam (?:leaves beta and )?reaches general availability/;
const OWN_CARD = /<LinkCard\s+title="Microsoft Learn Practice Assessment/;

/** Every exam page (code, area, text without comments). */
function examPages() {
  const pages = [];
  for (const area of EXAM_AREAS) {
    const dir = join(root, "src", "content", "docs", area);
    for (const name of readdirSync(dir)) {
      const code = name.match(/^([A-Z]{2,3}-\d{3})\.mdx$/)?.[1];
      if (!code) continue;
      pages.push({
        code,
        text: stripComments(lf(readFileSync(join(dir, name), "utf8"))),
      });
    }
  }
  return pages;
}

const testsTab = (text) =>
  text.match(/<TabItem label="Tests"[^>]*>([\s\S]*?)<\/TabItem>/)?.[1] ?? "";

test("the 'practice assessment arrives about 8 weeks after general availability' note sits in the Tests tab of an exam that has no assessment of its own yet", () => {
  const withNote = examPages().filter((page) => NOTE.test(page.text));
  assert.ok(withNote.length > 0, "no exam page carries the note any more");
  for (const { code, text } of withNote) {
    assert.ok(
      NOTE.test(testsTab(text)),
      `${code}: the note belongs at the top of the Tests tab`,
    );
    assert.ok(
      !OWN_CARD.test(text),
      `${code} has its own Microsoft Learn Practice Assessment card now: remove the "about 8 weeks" note from its Tests tab`,
    );
  }
});

test("the note is told apart from a page that simply links an assessment", () => {
  assert.ok(
    NOTE.test(
      "about 8 weeks after an exam leaves beta and reaches general availability",
    ),
  );
  assert.ok(
    NOTE.test("about 8 weeks after an exam reaches general availability"),
  );
  assert.ok(!NOTE.test("about 8 weeks after the beta"));
  assert.ok(
    OWN_CARD.test(
      '<LinkCard title="Microsoft Learn Practice Assessment" href="x"',
    ),
  );
  assert.ok(
    OWN_CARD.test(
      '<LinkCard title="Microsoft Learn Practice Assessment (AI Skills Navigator)" href="x"',
    ),
  );
  assert.ok(
    !OWN_CARD.test(
      '<LinkCard title="AZ-400: Microsoft Learn Practice Assessment" href="x"',
    ),
  );
});

const ASN_NOTE =
  /says that the Practice Assessment is on AI Skills Navigator, on the page of/;

test("the 'practice assessment is on AI Skills Navigator, but the study guide links another certification' note sits in the Tests tab of an exam that has no card for it yet", () => {
  const withNote = examPages().filter((page) => ASN_NOTE.test(page.text));
  assert.ok(withNote.length > 0, "no exam page carries the note any more");
  for (const { code, text } of withNote) {
    assert.ok(
      ASN_NOTE.test(testsTab(text)),
      `${code}: the note belongs at the top of the Tests tab`,
    );
    assert.ok(
      !OWN_CARD.test(text),
      `${code} has its own Microsoft Learn Practice Assessment card now: remove the AI Skills Navigator note from its Tests tab`,
    );
    assert.ok(
      !NOTE.test(text),
      `${code} carries both practice assessment notes: keep the one that is true`,
    );
  }
});
