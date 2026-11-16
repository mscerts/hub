import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";
import { readHistory } from "../../scripts/lib/guide-history.mjs";
import {
  comparisonInput,
  comparisonPairs,
} from "../../src/utils/guide-changes/compare.mjs";
import { taskReviews } from "../../src/utils/guide-changes/compare-tasks.mjs";
import { buildChangePage } from "../../src/utils/guide-changes/render.mjs";
import { versionState } from "../../src/utils/guide-changes/state.mjs";
import {
  taskFingerprint,
  taskRefs as refs,
  taskTuples,
} from "../../src/utils/guide-changes/task-review.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "src/data_files/study-guide-history");
const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = (node, omitOld = false) =>
  omitOld && node.tagName === "del"
    ? ""
    : (node.value ??
      (node.childNodes ?? []).map((n) => text(n, omitOld)).join(""));

test("every predecessor comparison has a current manual task review", () => {
  for (const pair of comparisonPairs) {
    const input = comparisonInput(pair.to, (code) => readHistory(dir, code));
    assert.ok(input.tasks, `${pair.to}: no manual task review`);
    const html = buildChangePage(input.to.history, {
      compare: input,
    }).tabs.find((tab) => tab.label.startsWith("Compared to"))?.html;
    assert.ok(html, `${pair.to}: no comparison tab`);
    assert.doesNotMatch(
      html,
      /changed after we matched|matched automatically by topic/,
      `${pair.to}: the currently displayed guides need manual re-review`,
    );
    const elements = nodes(parseFragment(html));
    const ids = elements.flatMap((node) =>
      (node.attrs ?? [])
        .filter((attr) => attr.name === "id")
        .map((attr) => attr.value),
    );
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${pair.to}: duplicate comparison anchors`,
    );
    for (const node of elements)
      for (const attr of node.attrs ?? [])
        if (attr.name === "href" && attr.value.startsWith("#cmp-"))
          assert.ok(
            ids.includes(attr.value.slice(1)),
            `${pair.to}: broken comparison link ${attr.value}`,
          );
  }
});

test("AZ-401 shows all six lifecycle metrics tasks under the two combined success-metrics tasks", () => {
  const input = comparisonInput("AZ-401", (code) => readHistory(dir, code));
  const html = buildChangePage(input.to.history, { compare: input }).tabs.find(
    (tab) => tab.label.startsWith("Compared to"),
  ).html;
  const heading = nodes(parseFragment(html)).find(
    (node) =>
      node.tagName === "h5" &&
      text(node, true).replace(/\s+/g, " ").trim() ===
        "Design and implement success metrics for DevOps",
  );
  assert.ok(heading, "the success-metrics group is rendered");
  const siblings = heading.parentNode.childNodes;
  const list = siblings[siblings.indexOf(heading) + 1];
  assert.equal(list.tagName, "ul");
  const items = list.childNodes.filter((node) => node.tagName === "li");
  const tasks = items.filter((node) => node.childNodes[0]?.tagName !== "del");
  assert.equal(
    tasks.length,
    2,
    "six predecessor tasks must not appear as unrelated removals",
  );
  assert.equal(items.length, 3, "the old dashboard also keeps its move notice");
  assert.match(text(items[0]), /Design and implement a dashboard.*now in/);
  const predecessors = tasks[0].childNodes.find(
    (node) => node.tagName === "ul",
  );
  assert.ok(predecessors, "the combined task lists its predecessor tasks");
  assert.deepEqual(
    predecessors.childNodes
      .filter((node) => node.tagName === "li")
      .map((node) => text(node).trim()),
    [
      "project planning",
      "development",
      "testing",
      "security",
      "delivery",
      "operations",
    ].map(
      (stage) =>
        `Design and implement appropriate metrics and queries for ${stage}`,
    ),
  );
  assert.match(text(tasks[0]), /Translate business KPIs into success metrics/);
  assert.match(
    text(tasks[1]),
    /Implement queries to evaluate success metrics.*part of the same change/,
  );
});

for (const [code, review] of Object.entries(taskReviews)) {
  test(`${code}: reviewed references pin the source text and account for every task exactly once`, () => {
    const pair = comparisonPairs.find((p) => p.to === code);
    assert.ok(pair, `${code}: not a comparison target`);
    const reviewedAt = new Date(`${review.reviewed}T12:00:00Z`);
    const guides = [...pair.from, code].map((source) => {
      const state = versionState(readHistory(dir, source), reviewedAt);
      const version = state.current ?? state.upcoming;
      const tasks = taskTuples(version.lines);
      assert.ok(tasks, `${source}: unreadable guide`);
      return tasks;
    });
    assert.deepEqual(
      guides.map(taskFingerprint),
      review.sources,
      `${code}: the reviewed source changed; reread both guides before updating references`,
    );
    const counts = [
      guides.slice(0, -1).reduce((n, tasks) => n + tasks.length, 0),
      guides.at(-1).length,
    ];
    for (const [side, unpaired] of [review.removed, review.added].entries()) {
      const seen = new Set();
      const references = [
        ...review.matches.flatMap((match) => refs(match[side])),
        ...unpaired,
      ];
      for (const ref of references) {
        assert.ok(
          Number.isInteger(ref) && ref > 0 && ref <= counts[side],
          `${code}: invalid ${side} reference ${ref}`,
        );
        assert.ok(
          !seen.has(ref),
          `${code}: duplicate ${side} reference ${ref}`,
        );
        seen.add(ref);
      }
      assert.equal(
        seen.size,
        counts[side],
        `${code}: an unreviewed task remains on side ${side}`,
      );
    }
    for (const [from, to, note] of review.matches)
      if (refs(from).length > 1 || refs(to).length > 1)
        assert.ok(
          typeof note === "string" && note.length > 20,
          `${code}: explain the consolidation or split`,
        );
    // The page of the day of the review shows the hand matching, not the matching by topic.
    const input = comparisonInput(code, (c) => readHistory(dir, c));
    const html = buildChangePage(input.to.history, {
      now: reviewedAt,
      compare: input,
    }).tabs.find((tab) => tab.label.startsWith("Compared to"))?.html;
    assert.ok(html, `${code}: no Compared to tab`);
    assert.ok(
      !html.includes("changed after we matched"),
      `${code}: the review does not fit the diff of the two guides`,
    );
  });
}
