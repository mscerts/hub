// scripts/study-guide-changes-cards.mjs and the files behind the Study Guide Changes pages: every exam
// page links its change page from the Get Started card, and every history file is valid
// (docs/study-guide-changes.md). The unit tests are offline; the last two read the repository.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readAllHistories } from "../../scripts/lib/guide-history.mjs";
import {
  cardStatus,
  changePath,
  changesCard,
  examPages,
  findProblems,
  historyCodes,
  withCard,
} from "../../scripts/study-guide-changes-cards.mjs";
import { examCodeOfEntry } from "../../src/utils/guide-changes/codes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PAGE = `---
title: AZ-999 Study Materials
---
import { Card, LinkCard } from '@components/docs';

<Card title="Get Started" icon="star">

  <LinkCard title="Exam AZ-999: Things" href="https://learn.microsoft.com/x" target="_blank" description=""/>
  <LinkCard title="AZ-999 Study Guide" href="https://learn.microsoft.com/y" target="_blank" description=""/>
  <LinkCard title="Exam Labs" href="/certs/labs/azure/az-999/" description=""/>
</Card>
`;

test("the card and the address of a change page", () => {
  assert.equal(changePath("AB-100"), "/certs/changelog/ab-100/");
  assert.equal(
    changesCard("AB-100"),
    '<LinkCard title="AB-100 Study Guide Changes" href="/certs/changelog/ab-100/" description="What changed in the study guide, what is coming, and the previous version."/>',
  );
});

test("a card is added directly under the Study Guide card, with its indentation, and only once", () => {
  assert.equal(cardStatus(PAGE, "AZ-999"), "missing");
  const added = withCard(PAGE, "AZ-999");
  const lines = added.split("\n");
  const guide = lines.findIndex((line) => line.includes('AZ-999 Study Guide"'));
  assert.equal(lines[guide + 1], `  ${changesCard("AZ-999")}`);
  assert.equal(
    lines[guide + 2].includes("Exam Labs"),
    true,
    "the card after it keeps its place",
  );
  assert.equal(cardStatus(added, "AZ-999"), "ok");
  assert.equal(
    withCard(added, "AZ-999"),
    added,
    "a page that has the card is left as it is",
  );
});

test("a card in the wrong place is reported and never moved, and a page without an anchor is left alone", () => {
  const misplaced = PAGE.replace(
    "</Card>",
    `  ${changesCard("AZ-999")}\n</Card>`,
  );
  assert.equal(cardStatus(misplaced, "AZ-999"), "misplaced");
  assert.equal(withCard(misplaced, "AZ-999"), misplaced);
  const noGuide = PAGE.replace(/.*AZ-999 Study Guide".*\n/, "");
  assert.equal(cardStatus(noGuide, "AZ-999"), "no-anchor");
  assert.equal(withCard(noGuide, "AZ-999"), noGuide);
  assert.equal(cardStatus("# nothing", "AZ-999"), "no-anchor");
});

test("a page's code comes from its collection id, and only exam pages have one", () => {
  assert.equal(examCodeOfEntry("azure/dp-700"), "DP-700");
  assert.equal(examCodeOfEntry("aibusiness/ab-100"), "AB-100");
  assert.equal(examCodeOfEntry("microsoft365/ms-102"), "MS-102");
  assert.equal(examCodeOfEntry("labs/azure/az-104"), null);
  assert.equal(examCodeOfEntry("vouchers/ab650beta"), null);
  assert.equal(examCodeOfEntry("guide/getting-started"), null);
  assert.equal(examCodeOfEntry("azure/az-104/extra"), null);
});

test("every exam page of the repository links its Study Guide Changes page", () => {
  const pages = examPages(root);
  assert.ok(pages.size > 40, `found only ${pages.size} exam pages`);
  assert.deepEqual(
    findProblems(root).map((p) => `${p.code}: ${p.problem}`),
    [],
    "run: node scripts/study-guide-changes-cards.mjs",
  );
});

test("every history file is valid, belongs to a known exam code and sits in its own file", () => {
  const dir = join(root, "src/data_files/study-guide-history");
  const histories = readAllHistories(dir); // throws, naming the file, when one is corrupt
  assert.ok(histories.length > 40, `found only ${histories.length} histories`);
  assert.deepEqual(
    histories.map((h) => h.code),
    historyCodes(root),
  );
  const stray = readdirSync(dir).filter(
    (name) => !/^[A-Z]{2,3}-\d{2,4}\.json$/.test(name),
  );
  assert.deepEqual(stray, [], "only <CODE>.json files belong in the folder");
  for (const history of histories) {
    const text = readFileSync(join(dir, `${history.code}.json`), "utf8");
    assert.ok(
      text.endsWith("}\n"),
      `${history.code}.json ends without a newline`,
    );
    for (const [index, version] of history.versions.entries()) {
      if (index === 0) continue;
      assert.ok(
        version.firstSeen >= history.versions[index - 1].firstSeen,
        `${history.code}: version ${version.n} was seen before version ${version.n - 1}`,
      );
    }
  }
  // Every exam page has its code in the exams the site knows; a history of a retired or renamed exam
  // (AZ-800, AZ-801, PL-400) stays without a page, which is allowed.
  assert.ok(
    existsSync(join(root, "docs/study-guide-changes.md")),
    "the feature has its runbook",
  );
});
