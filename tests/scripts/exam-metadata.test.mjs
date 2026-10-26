import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { readExamName } from "../../src/utils/exam-name.mjs";
import { parseHubPage } from "../../scripts/new-exam-check.mjs";
import { examNameFromDescription } from "../../scripts/retiring-exam-check.mjs";

const root = resolve(import.meta.dirname, "../../src/content/docs");
const areas = [
  "azure",
  "aibusiness",
  "github",
  "microsoft365",
  "dynamics",
  "power",
  "security",
];
const field = (source, name) => {
  const value = source.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  return value?.startsWith('"') ? JSON.parse(value) : value;
};

test("exam names survive free-form descriptions in drift and retirement readers", () => {
  const source =
    '---\nexamName: "Developing with .NET and \\"AI\\""\ndescription: "Short copy unrelated to the old template."\n---\n';
  const name = 'Developing with .NET and "AI"';
  assert.equal(readExamName(source), name);
  assert.equal(parseHubPage(source, "AZ-999").descriptionName, name);
  assert.equal(examNameFromDescription(source, "AZ-999"), name);
  assert.equal(
    readExamName("---\nexamName: 'A name with it''s apostrophe'\n---"),
    "A name with it's apostrophe",
  );
  assert.equal(
    readExamName("---\ntitle: Example\n---\nexamName: Not frontmatter"),
    "",
  );
});

test("published exam, lab and course metadata is distinct, concise and free of em dashes", () => {
  const pages = [];
  for (const area of areas) {
    for (const filename of readdirSync(join(root, area))) {
      if (!/^[A-Z]{2,3}-\d{3}\.mdx$/.test(filename)) continue;
      const source = readFileSync(join(root, area, filename), "utf8");
      assert.ok(readExamName(source), `${filename} needs examName`);
      pages.push({ source, path: `${area}/${filename}` });
    }
    for (const filename of readdirSync(join(root, "labs", area))) {
      const source = readFileSync(join(root, "labs", area, filename), "utf8");
      assert.match(
        field(source, "title"),
        /Hands-on Labs|Labs and Case Studies/,
      );
      pages.push({ source, path: `labs/${area}/${filename}` });
    }
  }
  for (const filename of readdirSync(join(root, "courses"))) {
    if (!filename.endsWith(".mdx")) continue;
    const source = readFileSync(join(root, "courses", filename), "utf8");
    if (!/^draft: true$/m.test(source))
      pages.push({ source, path: `courses/${filename}` });
  }
  const titles = new Set();
  const descriptions = new Set();
  for (const { source, path } of pages) {
    const title = field(source, "title");
    const description = field(source, "description");
    assert.ok(
      description && description.length <= 170,
      `${path}: ${description?.length} characters`,
    );
    assert.ok(!description.includes("\u2014"), path);
    assert.ok(!titles.has(title), `Duplicate title: ${path}`);
    assert.ok(!descriptions.has(description), `Duplicate description: ${path}`);
    assert.doesNotMatch(
      description,
      /Collection of study materials|Lab exercises for/,
    );
    titles.add(title);
    descriptions.add(description);
  }
});
