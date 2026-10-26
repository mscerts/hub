import assert from "node:assert/strict";
import test from "node:test";
import {
  diffTrees,
  treeFromCourseMdx,
} from "../../scripts/lib/course-guide.mjs";
import {
  learnHref,
  numberReview,
  renderCourse,
  reviewLabel,
} from "../../scripts/lib/course-render.mjs";
import { eachPick } from "../../scripts/lib/course-format.mjs";
import { exampleCourse, pick } from "./helpers/example-course.mjs";

test("learnHref gives a Learn address with the hub's tracking parameter and no locale", () => {
  assert.equal(
    learnHref("/azure/storage/blobs"),
    "https://learn.microsoft.com/azure/storage/blobs?WT.mc_id=studentamb_165290",
  );
});

test("a rendered page is an ordinary page: there are no draft pages", () => {
  const { course } = exampleCourse();
  assert.ok(!/draft:/.test(renderCourse(course)));
  assert.ok(!/draft:/.test(renderCourse(course, { draft: true })));
});

/** A review file marking the picks at `at` of the course (in the order eachPick lists them). */
function reviewOf(course, at, extra = {}) {
  const all = [...eachPick(course)];
  return {
    schemaVersion: 1,
    kind: "review",
    code: course.code,
    picks: at.map((i, n) => ({
      task: all[i].task.key,
      path: all[i].pick.target.path,
      title: all[i].pick.title,
      reasons:
        n % 2 === 0
          ? ["the judge is not sure (low confidence)"]
          : ["flagged: other-role, other-sub-product"],
      why: `The judge's reason ${n}.`,
      ...extra,
    })),
  };
}

test("the review copy marks the marked picks in orange with a number and the judge's reason, and nothing else changes", () => {
  const { course } = exampleCourse();
  const review = reviewOf(course, [0, 1, 2]);
  const plain = renderCourse(course);
  const page = renderCourse(course, { review });
  assert.match(
    page,
    /^---\ntitle: GH-900 Study Guide Course \(review copy\)\n/,
  );
  assert.ok(!/draft:/.test(page));
  assert.match(page, /:::caution\nThis is the review copy\./);
  assert.match(page, /The 3 orange cards/);
  const marked = page.split("\n").filter((l) => /tone="review"/.test(l));
  assert.equal(marked.length, 3);
  // every marked card keeps its title and address and says what is wrong
  assert.match(marked[0], /description="#1 Not sure\. The judge's reason 0\."/);
  assert.match(
    marked[1],
    /description="#2 Flagged as another job role · Flagged as another product area\./,
  );
  assert.match(marked[2], /description="#3 Not sure\./);
  for (const l of marked)
    assert.match(
      l,
      /^ +<LinkCard title="[^"]+" href="https:\/\/learn\.microsoft\.com\//,
    );
  // the unmarked cards are the cards of the normal page
  const unmarked = (text) =>
    text
      .split("\n")
      .filter((l) => /<LinkCard/.test(l) && !/tone="review"/.test(l));
  assert.deepEqual(
    unmarked(page),
    unmarked(plain).filter(
      (l) => !marked.some((m) => m.startsWith(l.replace(/\/>$/, ""))),
    ),
  );
  // without a review file there is no caution and no mark
  assert.ok(!/tone="review"|review copy/.test(plain));
});

test("the marks are numbered in the order the cards are on the page, and numberReview gives the same numbers", () => {
  const { course } = exampleCourse();
  const all = [...eachPick(course)];
  const review = reviewOf(course, all.map((_, i) => i).reverse());
  const numbered = numberReview(course, review);
  assert.equal(numbered.length, all.length);
  assert.deepEqual(
    numbered.map((m) => m.n),
    numbered.map((_, i) => i + 1),
  );
  const page = renderCourse(course, { review });
  const onPage = [...page.matchAll(/description="#(\d+) /g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(
    onPage,
    numbered.map((m) => m.n),
    "the numbers run down the page",
  );
  // the paths in the page order are the ones numberReview lists
  const hrefs = [
    ...page.matchAll(
      /href="https:\/\/learn\.microsoft\.com([^"?]+)\?[^"]*" target="_blank" tone="review"/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    numbered.map((m) => m.path),
  );
});

test("a mark whose pick is not in the course is left out, so a review file of another build is noticed by its length", () => {
  const { course } = exampleCourse();
  const review = reviewOf(course, [0]);
  review.picks.push({
    task: review.picks[0].task,
    path: "/azure/not-in-this-course",
    reasons: ["the judge is not sure (low confidence)"],
    why: "x",
  });
  assert.equal(numberReview(course, review).length, 1);
  assert.equal(numberReview(course, null).length, 0);
});

test("the label says why a card is marked", () => {
  assert.equal(
    reviewLabel(["the judge is not sure (low confidence)"]),
    "Not sure",
  );
  assert.equal(
    reviewLabel(["flagged: other-role"]),
    "Flagged as another job role",
  );
  assert.equal(
    reviewLabel([
      "the judge is not sure (low confidence)",
      "flagged: other-role, licensing-tier",
    ]),
    "Not sure · Flagged as another job role · Flagged as another licensing tier",
  );
});

test("the page opens with frontmatter, the import and a note that cites the study guide and says where the hands-on pages are", () => {
  const { course } = exampleCourse();
  const page = renderCourse(course);
  const [frontmatter, rest] = page.split("---\nimport");
  assert.match(
    frontmatter,
    /^---\ntitle: GH-900 Study Guide Course\ndescription: "Follow a structured GH-900 course organized by study guide task, with Microsoft Learn training and documentation for GitHub Foundations\."\n/,
  );
  assert.match(
    rest,
    /^ \{ LinkCard, CardGrid, Tabs, TabItem \} from '@components\/docs';\n\n:::note\n/,
  );
  assert.match(
    page,
    /\[official GH-900 study guide\]\(https:\/\/learn\.microsoft\.com\/credentials\/certifications\/resources\/study-guides\/gh-900\?WT\.mc_id=studentamb_165290\) skills measured \(January 2026 version\)/,
  );
  assert.match(
    page,
    /Each task links to the relevant Microsoft Learn training and documentation\. Exercises, guided projects, tutorials and quickstarts are on the lab page, not here, and every page appears once\./,
  );
  assert.ok(page.endsWith("\n") && !page.endsWith("\n\n"));
});

test("the note links the lab page when it is given one", () => {
  const { course } = exampleCourse();
  assert.match(
    renderCourse(course, { labPage: "/certs/labs/github/gh-900/" }),
    /are on the \[GH-900 labs page\]\(\/certs\/labs\/github\/gh-900\/\), not here/,
  );
});

test("domains, groups and tasks become ##, ### and #### headings with the domain weight", () => {
  const { course } = exampleCourse();
  const page = renderCourse(course);
  assert.match(page, /^## Understand Git and GitHub basics \(25–30%\)$/m);
  assert.match(page, /^### Version control fundamentals$/m);
  assert.match(
    page,
    /^#### Describe the purpose and benefits of version control$/m,
  );
  const single = structuredClone(course);
  single.domains[0].weight = { min: 100, max: 100 };
  assert.match(
    renderCourse(single),
    /^## Understand Git and GitHub basics \(100%\)$/m,
  );
  single.domains[0].weight = null;
  assert.match(renderCourse(single), /^## Understand Git and GitHub basics$/m);
});

test("modules and units go to Learning, docs pages to Documentation, a supporting pick follows the core ones and, like every card, has no description; there is no third tab", () => {
  const { course } = exampleCourse();
  const page = renderCourse(course);
  // task 1: one module
  assert.match(
    page,
    /<TabItem label="Learning">\n    <CardGrid>\n      <LinkCard title="Introduction to GitHub" href="https:\/\/learn\.microsoft\.com\/training\/modules\/intro-to-github\?WT\.mc_id=studentamb_165290" target="_blank"\/>\n    <\/CardGrid>\n  <\/TabItem>\n<\/Tabs>/,
  );
  // task 2: docs only, so no Learning tab for it
  assert.match(
    page,
    /<TabItem label="Documentation">\n    <CardGrid>\n      <LinkCard title="What is GitHub\?" href="https:\/\/learn\.microsoft\.com\/azure\/github\/overview\?WT\.mc_id=studentamb_165290" target="_blank"\/>/,
  );
  // task 3: a module in Learning (a course has no unit cards: a module is placed once, as a module) and a supporting
  // doc in Documentation, without a description
  assert.match(
    page,
    /<LinkCard title="Git basics" href="https:\/\/learn\.microsoft\.com\/training\/modules\/git-basics\?WT\.mc_id=studentamb_165290" target="_blank"\/>/,
  );
  assert.ok(!page.includes("/2-what-is-git"), "no card of a unit");
  assert.match(
    page,
    /<TabItem label="Documentation">\n    <CardGrid>\n      <LinkCard title="About branches" href="[^"]+" target="_blank"\/>/,
  );
  // task 4: a supporting module is in Learning, without a description
  assert.match(
    page,
    /<TabItem label="Learning">\n    <CardGrid>\n      <LinkCard title="Advanced Git workflows" href="[^"]+" target="_blank"\/>/,
  );
  assert.ok(
    !page.includes("Related in practice"),
    "no tab of its own for supporting picks",
  );
  assert.deepEqual(
    [...new Set(page.match(/<TabItem label="[^"]+"/g))],
    ['<TabItem label="Learning"', '<TabItem label="Documentation"'],
  );
  // every card carries the tracking parameter
  for (const href of page.match(/href="[^"]+"/g))
    assert.match(href, /\?WT\.mc_id=studentamb_165290"$/, href);
});

test("a task with no pick says so instead of showing empty tabs; no tab is rendered empty", () => {
  const { course } = exampleCourse();
  const page = renderCourse(course);
  assert.match(
    page,
    /#### Explain the GitHub Flow for collaboration\n\n:::note\nNo Learn module or documentation page covers this task yet\.\n:::/,
  );
  assert.ok(!/<CardGrid>\s*<\/CardGrid>/.test(page));
  assert.ok(!/<TabItem label="[^"]+">\s*<\/TabItem>/.test(page));
});

test("text that MDX would read as code or markup is escaped, quotes in attributes are replaced", () => {
  const { course } = exampleCourse();
  const odd = structuredClone(course);
  odd.domains[0].groups[0].tasks[0].text = "Use {braces} and <tags>";
  odd.domains[0].groups[0].tasks[0].picks = [
    pick({
      title: 'The "quoted" title',
      target: { kind: "docs", path: "/azure/x" },
      source: "P2",
    }),
  ];
  const page = renderCourse(odd);
  assert.match(page, /^#### Use \\\{braces\\\} and \\<tags\\>$/m);
  assert.match(page, /<LinkCard title="The 'quoted' title"/);
  const supporting = structuredClone(course);
  supporting.domains[0].groups[0].tasks[0].picks = [
    pick({
      class: "supporting",
      relation: "operate",
      why: "x".repeat(400),
      evidence: "q",
      target: { kind: "docs", path: "/azure/y" },
      source: "P2",
    }),
  ];
  assert.ok(
    !/<LinkCard[^>]*description=/.test(renderCourse(supporting)),
    "no card has a description, whatever the pick's relation and reason",
  );
});

test("the rendered page has exactly the study guide's tree, even for headings with escaped characters", () => {
  const { course, guide } = exampleCourse();
  assert.deepEqual(
    diffTrees(guide, treeFromCourseMdx(renderCourse(course))).differences,
    [],
  );
  const odd = structuredClone(course);
  odd.domains[0].groups[0].tasks[0].text = "Use {braces} and <tags>";
  const guideWithOdd = structuredClone(guide);
  guideWithOdd.domains[0].groups[0].tasks[0].text = "Use {braces} and <tags>";
  assert.deepEqual(
    diffTrees(guideWithOdd, treeFromCourseMdx(renderCourse(odd))).differences,
    [],
  );
});

test("rendering is deterministic", () => {
  const { course } = exampleCourse();
  assert.equal(renderCourse(course), renderCourse(structuredClone(course)));
});

test("in a tab the core picks come before the supporting ones, whatever the order of the course file", () => {
  const { course } = exampleCourse();
  const task = course.domains[0].groups[0].tasks[0];
  task.picks = [
    pick({
      class: "supporting",
      relation: "operate",
      why: "Runs what the task sets up.",
      evidence: "q",
      target: { kind: "docs", path: "/azure/first" },
      title: "Supporting page",
      source: "P2",
      via: "/training/modules/intro-to-github",
    }),
    pick({
      target: { kind: "docs", path: "/azure/second" },
      title: "Core page",
      source: "P2",
      via: "/training/modules/intro-to-github",
    }),
  ];
  const page = renderCourse(course);
  assert.ok(page.indexOf("Core page") < page.indexOf("Supporting page"));
});

test("a preview renders only the skill groups whose title contains the text, numbers its marks from 1 and says so", () => {
  const { course } = exampleCourse();
  const groups = course.domains.flatMap((d) => d.groups.map((g) => g.title));
  assert.ok(groups.length > 1, "the example has several skill groups");
  const only = groups[1];
  const rows = [...eachPick(course)];
  const review = {
    schemaVersion: 1,
    kind: "review",
    code: course.code,
    picks: rows.map(({ task, pick }) => ({
      task: task.key,
      path: pick.target.path,
      reasons: ["the judge is not sure (low confidence)"],
      why: "A reason.",
    })),
  };
  const page = renderCourse(course, { only, review });
  assert.match(page, /title: "GH-900 Study Guide Course: .+ \(review copy\)"/);
  assert.match(page, /preview of the skill groups whose title contains/);
  assert.ok(page.includes(`### ${only}`));
  for (const other of groups.filter((g) => g !== only && !only.includes(g)))
    assert.ok(!page.includes(`### ${other}`), other);
  // the marks of the shown group start at 1
  const numbers = [...page.matchAll(/description="#(\d+) /g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
  assert.equal(numberReview(course, review, { only }).length, numbers.length);
  assert.ok(numbers.length < rows.length, "fewer than the whole course");
  // no filter: the whole page, without the preview note
  assert.ok(!/preview of the skill groups/.test(renderCourse(course)));
  assert.ok(!/one skill group/.test(renderCourse(course)));
});
