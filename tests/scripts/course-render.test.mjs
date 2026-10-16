import assert from "node:assert/strict";
import test from "node:test";
import {
  diffTrees,
  treeFromCourseMdx,
} from "../../scripts/lib/course-guide.mjs";
import {
  SUPPORTING_TAB,
  learnHref,
  renderCourse,
} from "../../scripts/lib/course-render.mjs";
import { exampleCourse, pick } from "./helpers/example-course.mjs";

test("learnHref gives a Learn address with the hub's tracking parameter and no locale", () => {
  assert.equal(
    learnHref("/azure/storage/blobs"),
    "https://learn.microsoft.com/azure/storage/blobs?WT.mc_id=studentamb_165290",
  );
});

test("the page opens with frontmatter, the import and a note that cites the study guide and explains the related tab", () => {
  const { course } = exampleCourse();
  const page = renderCourse(course);
  const [frontmatter, rest] = page.split("---\nimport");
  assert.match(
    frontmatter,
    /^---\ntitle: GH-900 Study Guide Course\ndescription: "A task-by-task walkthrough of the GH-900: GitHub Foundations skills measured, with Microsoft Learn training and documentation for every task in the official study guide\."\n/,
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
    /"Related in practice" lists material the guide does not name but that you meet when you do the task at work\./,
  );
  assert.ok(page.endsWith("\n") && !page.endsWith("\n\n"));
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

test("core modules and units go to Learning, core docs to Documentation, supporting picks to the related tab with how and why", () => {
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
  // task 3: a unit in Learning and a supporting doc in the related tab
  assert.match(
    page,
    /<LinkCard title="What is Git\?" href="https:\/\/learn\.microsoft\.com\/training\/modules\/intro-to-github\/2-what-is-git\?WT\.mc_id=studentamb_165290" target="_blank"\/>/,
  );
  assert.match(
    page,
    new RegExp(
      `<TabItem label="${SUPPORTING_TAB}">\\n    <CardGrid>\\n      <LinkCard title="About branches" href="[^"]+" target="_blank" description="Prerequisite: You create and switch branches before you can open a pull request\\."\\/>`,
    ),
  );
  assert.match(
    page,
    /description="Deeper dive: The same feature in more depth\."/,
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
  const description = renderCourse(supporting)
    .match(/description="([^"]+)"/g)
    .find((d) => d.includes("Operate and troubleshoot"));
  assert.ok(
    description.length < 260 && description.includes("…"),
    "long reasons are clipped",
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
