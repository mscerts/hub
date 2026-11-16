import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  DESCRIPTION,
  cardStatus,
  courseCard,
  courseCodes,
  coursePath,
  findProblems,
  hasCard,
  withCard,
} from "../../scripts/course-cards.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "course-cards-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const CARD = courseCard("AZ-104");
const LEARN =
  '<LinkCard title="Microsoft Learn" href="https://learn.microsoft.com/training/courses/az-104t00?WT.mc_id=studentamb_165290" target="_blank"/>';
const OTHER =
  '<LinkCard title="Exam Ref AZ-104" href="https://example.com/book" target="_blank"/>';

/** An exam page whose Text tab holds `body` (lines). */
const page = (...body) =>
  [
    "---",
    'title: "AZ-104 Study Materials"',
    "---",
    '<Card title="Get Started" icon="star">',
    '<LinkCard title="AZ-104 Study Guide" href="https://learn.microsoft.com/x"/>',
    "<Tabs>",
    '  <TabItem label="Text">',
    ...body,
    "  </TabItem>",
    '  <TabItem label="Videos">',
    '    <LinkCard title="A video" href="https://example.com/v" target="_blank"/>',
    "  </TabItem>",
    "</Tabs>",
    "</Card>",
    "",
  ].join("\n");
const textTabOf = (text) =>
  text
    .split("\n")
    .slice(
      text.split("\n").findIndex((l) => l.includes('label="Text"')) + 1,
      text.split("\n").findIndex((l) => l.includes('label="Videos"')) - 1,
    );

test("the card names the course page, says what the course is and is an internal link", () => {
  assert.equal(coursePath("AZ-104"), "/certs/courses/az-104/");
  assert.equal(
    CARD,
    `<LinkCard title="AZ-104 Study Guide Course" href="/certs/courses/az-104/" description="${DESCRIPTION}"/>`,
  );
  assert.match(
    DESCRIPTION,
    /collection of Microsoft Learn modules and documentation pages, based on the study guide/,
  );
  assert.doesNotMatch(CARD, /target=/);
  // not the title the Missing Resources Audit reads as the exam's own Learn course
  assert.doesNotMatch(CARD, /title="Microsoft Learn"/);
});

test("the card goes directly under the exam's own Microsoft Learn course, outside or inside a card grid", () => {
  const outside = page(
    `    ${LEARN}`,
    "    <CardGrid>",
    `    ${OTHER}`,
    "    </CardGrid>",
  );
  assert.equal(cardStatus(outside, "AZ-104"), "missing");
  assert.deepEqual(textTabOf(withCard(outside, "AZ-104")), [
    `    ${LEARN}`,
    `    ${CARD}`,
    "    <CardGrid>",
    `    ${OTHER}`,
    "    </CardGrid>",
  ]);
  const inside = page(
    "    <CardGrid>",
    `      ${OTHER}`,
    `      ${LEARN}`,
    "    </CardGrid>",
  );
  assert.deepEqual(textTabOf(withCard(inside, "AZ-104")), [
    "    <CardGrid>",
    `      ${OTHER}`,
    `      ${LEARN}`,
    `      ${CARD}`,
    "    </CardGrid>",
  ]);
  // a Learn course card that spans several lines: the card follows its last line
  const long = page(
    '    <LinkCard title="Microsoft Learn"',
    '      href="https://learn.microsoft.com/training/courses/az-104t00"',
    '      target="_blank"/>',
    `    ${OTHER}`,
  );
  assert.deepEqual(textTabOf(withCard(long, "AZ-104")).slice(2, 4), [
    '      target="_blank"/>',
    `    ${CARD}`,
  ]);
  for (const text of [outside, inside, long])
    assert.equal(cardStatus(withCard(text, "AZ-104"), "AZ-104"), "ok");
});

test("without a Microsoft Learn course card the card is the first of the tab: before the other cards, after a note", () => {
  // a predecessor's course ("AZ-400: Microsoft Learn") and another course are not the exam's own course
  const predecessor = page(
    "",
    ":::note",
    "The resources below were made for the exam before.",
    ":::",
    "",
    '    <LinkCard title="AZ-400: Microsoft Learn" href="https://learn.microsoft.com/a"/>',
    '    <LinkCard title="Microsoft Learn AZ-2008 Course" href="https://learn.microsoft.com/b"/>',
  );
  assert.deepEqual(textTabOf(withCard(predecessor, "AZ-104")).slice(4, 7), [
    "",
    `    ${CARD}`,
    '    <LinkCard title="AZ-400: Microsoft Learn" href="https://learn.microsoft.com/a"/>',
  ]);
  const grid = page("    <CardGrid>", `    ${OTHER}`, "    </CardGrid>");
  assert.deepEqual(textTabOf(withCard(grid, "AZ-104")).slice(0, 2), [
    `    ${CARD}`,
    "    <CardGrid>",
  ]);
  // an empty tab, and one whose only course card is commented out
  assert.deepEqual(textTabOf(withCard(page(), "AZ-104")), [`    ${CARD}`]);
  const commented = page(`    {/* ${LEARN} */}`);
  assert.deepEqual(textTabOf(withCard(commented, "AZ-104")), [
    `    {/* ${LEARN} */}`,
    `    ${CARD}`,
  ]);
  for (const text of [predecessor, grid, page(), commented])
    assert.equal(cardStatus(withCard(text, "AZ-104"), "AZ-104"), "ok");
});

test("a card in the wrong place is reported, a page that has it is left alone, and line endings are kept", () => {
  const last = page(`    ${LEARN}`, `    ${OTHER}`, `    ${CARD}`);
  assert.equal(cardStatus(last, "AZ-104"), "misplaced");
  assert.equal(withCard(last, "AZ-104"), last);
  const inVideos = page(`    ${LEARN}`).replace(
    '    <LinkCard title="A video"',
    `    ${CARD}\n    <LinkCard title="A video"`,
  );
  assert.equal(cardStatus(inVideos, "AZ-104"), "misplaced");
  const ok = withCard(page(`    ${LEARN}`), "AZ-104");
  assert.equal(withCard(ok, "AZ-104"), ok);
  assert.equal(hasCard(ok, "AZ-104"), true);
  assert.equal(hasCard(page(`    ${LEARN}`), "AZ-104"), false);
  assert.equal(hasCard(page(`    {/* ${CARD} */}`), "AZ-104"), false);
  assert.equal(cardStatus("no tabs here", "AZ-104"), "no-anchor");
  const crlf = page(`    ${LEARN}`).replace(/\n/g, "\r\n");
  const added = withCard(crlf, "AZ-104");
  assert.ok(added.includes(`${CARD}\r\n`));
  assert.doesNotMatch(added, /[^\r]\n/);
  assert.equal(cardStatus(added, "AZ-104"), "ok");
});

/** A small site: exam pages and course pages. */
function site(name, { exams, courses }) {
  const base = join(tempDir, name);
  for (const [area, code, text] of exams) {
    mkdirSync(join(base, "src/content/docs", area), { recursive: true });
    writeFileSync(join(base, "src/content/docs", area, `${code}.mdx`), text);
  }
  mkdirSync(join(base, "src/content/docs/courses"), { recursive: true });
  for (const [file, text] of courses)
    writeFileSync(join(base, "src/content/docs/courses", file), text);
  return base;
}
const COURSE = "---\ntitle: A course\n---\n";

test("a course page is one named after an exam and not a draft; review copies and pilot pages are not", () => {
  const base = site("codes", {
    exams: [],
    courses: [
      ["az-104.mdx", COURSE],
      ["dp-600.mdx", "---\ntitle: A course\ndraft: true\n---\n"],
      ["az-104-review.mdx", COURSE],
      ["az-104course-v3.mdx", COURSE],
      ["sc-200.mdx", COURSE],
    ],
  });
  assert.deepEqual(courseCodes(base), ["AZ-104", "SC-200"]);
});

test("the check: an exam with a course needs its card, an exam without one must not have it, a course needs an exam page", () => {
  const withIt = withCard(page(`    ${LEARN}`), "AZ-104");
  const base = site("check", {
    exams: [
      ["azure", "AZ-104", page(`    ${LEARN}`)],
      ["azure", "AZ-305", withCard(page(`    ${LEARN}`), "AZ-305")],
      [
        "security",
        "SC-200",
        withIt.replaceAll("AZ-104", "SC-200").replaceAll("az-104", "sc-200"),
      ],
    ],
    courses: [
      ["az-104.mdx", COURSE],
      ["sc-200.mdx", COURSE],
      ["gh-900.mdx", COURSE],
    ],
  });
  assert.deepEqual(
    findProblems(base)
      .map((p) => `${p.code}: ${p.problem}`)
      .sort(),
    ["AZ-104: missing", "AZ-305: no-course-page", "GH-900: no-exam-page"],
  );
});

test("every exam page of the site links its course, in its place, and no card points to a course the site lacks", () => {
  assert.deepEqual(
    findProblems().map((p) => `${p.code}: ${p.problem}`),
    [],
    "run node scripts/course-cards.mjs",
  );
  assert.ok(courseCodes().length > 0);
});
