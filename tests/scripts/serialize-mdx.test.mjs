import assert from "node:assert/strict";
import test from "node:test";
import { renderCourseVersions } from "../../scripts/lib/course-render.mjs";
import { versionLabels, versionMarks } from "../../scripts/lib/course-next.mjs";
import { serializeMdx } from "../../src/utils/markdown/serializeMdx.ts";
import { exampleCourse } from "./helpers/example-course.mjs";

/** The course in force and an upcoming course of the example exam: one task reworded, one added, one gone, one card new. */
function versions() {
  const { course } = exampleCourse();
  const next = structuredClone(course);
  const tasks = (c) =>
    c.domains.flatMap((d) => d.groups.flatMap((g) => g.tasks));
  tasks(next)[0].text = `${tasks(next)[0].text} and its history`;
  tasks(next)[2].picks.push({
    target: { kind: "docs", path: "/azure/github/new-page" },
    title: "A page only the upcoming course has",
    class: "core",
    source: "P4",
    decision: { by: "auto", at: "2026-11-01" },
  });
  const group = next.domains[0].groups[0];
  group.tasks.push({
    key: `${group.tasks[0].key}-added`,
    text: "A brand new skill",
    picks: [],
  });
  return { course, next };
}

/** The page with two versions, as the renderer writes it, for the effective day `effective`. */
function page(effective) {
  const { course, next } = versions();
  const marks = versionMarks({ current: course, next });
  const raw = renderCourseVersions(course, next, {
    marks,
    effective,
    labels: versionLabels({ effective, counts: marks.counts }),
  });
  return raw.replace(/^---[\s\S]*?---\n/, "");
}

test("the Markdown copy of a page with two versions is the course in force until the effective day", async () => {
  const copy = await serializeMdx(page("2999-01-01"));
  // the headings are Markdown headings again, and the courses' own words are there
  assert.match(copy, /^##? .+$/m);
  assert.match(
    copy,
    /^#### Describe the purpose and benefits of version control$/m,
  );
  // the upcoming course, the marks, the notes about the marks and the component itself are not
  assert.doesNotMatch(copy, /and its history/);
  assert.doesNotMatch(copy, /A brand new skill/);
  assert.doesNotMatch(copy, /A page only the upcoming course has/);
  assert.doesNotMatch(
    copy,
    /CourseVersions|course-legend|<h\d|slot=|course-mark|Leaves|New from/,
  );
});

test("from the effective day the copy is the upcoming course, without badges", async () => {
  const copy = await serializeMdx(page("2000-01-01"));
  assert.match(
    copy,
    /^#### Describe the purpose and benefits of version control and its history$/m,
  );
  assert.match(copy, /^#### A brand new skill$/m);
  assert.match(copy, /A page only the upcoming course has/);
  assert.doesNotMatch(
    copy,
    /Describe the purpose and benefits of version control$/m,
  );
  assert.doesNotMatch(
    copy,
    /CourseVersions|course-legend|<h\d|slot=|course-mark|Reworded|New from/,
  );
});

test("a page without versions is serialized as before: components are unwrapped, tabs become headings", async () => {
  const copy = await serializeMdx(
    [
      "import { LinkCard, Tabs, TabItem } from '@components/docs';",
      "",
      "## A heading",
      "",
      "<Tabs>",
      '  <TabItem label="Learning">',
      '    <LinkCard title="A card" href="https://example.com/a" description="About it"/>',
      "  </TabItem>",
      "</Tabs>",
      "",
    ].join("\n"),
  );
  assert.match(copy, /^## A heading$/m);
  assert.match(copy, /^### Learning$/m);
  assert.match(copy, /^### \[A card\]\(https:\/\/example\.com\/a\)$/m);
  assert.match(copy, /About it/);
  assert.doesNotMatch(copy, /<|import/);
});
