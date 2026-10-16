import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  diffTrees,
  normalizeTitle,
  parseAsOf,
  parseGuide,
  parseHeading,
  splitWeight,
  squish,
  treeFromCourseMdx,
} from "../../scripts/lib/course-guide.mjs";

const fixtures = resolve(import.meta.dirname, "../fixtures/course-source");
const guide = (code) =>
  JSON.parse(readFileSync(join(fixtures, `guide-${code}.json`), "utf8"));

test("squish, normalizeTitle, splitWeight and parseHeading are tolerant of Microsoft's typography", () => {
  assert.equal(squish("  It’s “x” – y \n z "), 'It\'s "x" - y z');
  assert.equal(
    normalizeTitle("Manage VMs & storage (!)"),
    "manage vms and storage",
  );
  assert.deepEqual(splitWeight("Implement and manage storage (15–20%)"), {
    title: "Implement and manage storage",
    weight: { min: 15, max: 20 },
  });
  assert.deepEqual(splitWeight("Plan (15-20%)"), {
    title: "Plan",
    weight: { min: 15, max: 20 },
  });
  assert.deepEqual(splitWeight("Single (10%)"), {
    title: "Single",
    weight: { min: 10, max: 10 },
  });
  assert.deepEqual(splitWeight("No weight here"), {
    title: "No weight here",
    weight: null,
  });
  assert.deepEqual(parseHeading("### Audience profile  "), {
    level: 3,
    text: "Audience profile",
  });
  assert.deepEqual(parseHeading("# One"), { level: 1, text: "One" });
  assert.equal(parseHeading("- a bullet"), null);
  assert.equal(parseHeading("#nospace"), null);
  assert.equal(parseHeading(undefined), null);
});

test("parseAsOf reads a full date, a month, and gives up politely", () => {
  assert.deepEqual(parseAsOf(["## Skills measured as of April 17, 2026"]), {
    text: "April 17, 2026",
    iso: "2026-04-17",
  });
  assert.deepEqual(parseAsOf(["### Skills at a glance as of January 2026"]), {
    text: "January 2026",
    iso: "2026-01",
  });
  assert.deepEqual(parseAsOf(["## Skills measured as of the next update"]), {
    text: "the next update",
    iso: null,
  });
  assert.equal(parseAsOf(["## Skills measured", "- nothing"]), null);
  assert.equal(
    parseAsOf(["## Exam updated as of April 17, 2026"]),
    null,
    "only the skills headings count",
  );
});

test("AZ-104 (real guide): 5 domains, 15 groups, 82 tasks with weights, date and unique keys", () => {
  const g = guide("AZ-104");
  const r = parseGuide(g.lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { domains: 5, groups: 15, tasks: 82 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.asOf, { text: "April 17, 2026", iso: "2026-04-17" });
  assert.deepEqual(
    r.domains.map((d) => [d.weight.min, d.weight.max]),
    [
      [20, 25],
      [15, 20],
      [20, 25],
      [15, 20],
      [10, 15],
    ],
  );
  assert.equal(r.domains[0].title, "Manage Azure identities and governance");
  assert.equal(
    r.domains[0].groups[0].title,
    "Manage Microsoft Entra users and groups",
  );
  assert.deepEqual(
    r.domains[0].groups[0].tasks.map((t) => t.text),
    [
      "Create users and groups",
      "Manage user and group properties",
      "Manage licenses in Microsoft Entra ID",
      "Manage external users",
      "Configure self-service password reset (SSPR)",
    ],
  );
  const keys = r.domains.flatMap((d) =>
    d.groups.flatMap((x) => x.tasks.map((t) => t.key)),
  );
  assert.equal(new Set(keys).size, 82);
  assert.equal(
    r.domains[0].groups[0].tasks[0].key,
    "manage-azure-identities-and-governance/manage-microsoft-entra-users-and-groups/create-users-and-groups",
  );
});

test("GH-900 (real guide, irregular headings): an h1 domain and an h2 used as a group still parse, with a warning", () => {
  const r = parseGuide(guide("GH-900").lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { domains: 7, groups: 8, tasks: 36 });
  assert.deepEqual(r.asOf, { text: "January 2026", iso: "2026-01" });
  assert.ok(r.warnings.some((w) => /different levels \(1, 3\)/.test(w)));
  assert.deepEqual(
    r.domains[1].groups.map((g) => g.title),
    ["Repository management"],
    "an h2 inside a domain is a group",
  );
  assert.equal(
    r.domains[5].title,
    "Understand privacy, security, and administration",
    "the h1 heading starts the domain; the glance list names it",
  );
  assert.equal(r.domains[5].headingLevel, 1);
});

test("MB-310 (real guide): the 'Study resources' heading after the last domain is not a domain or a group", () => {
  const r = parseGuide(guide("MB-310").lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { domains: 5, groups: 16, tasks: 96 });
  assert.deepEqual(r.warnings, []);
  const last = r.domains.at(-1);
  assert.equal(last.title, "Manage fixed assets");
  assert.deepEqual(
    last.groups.map((g) => g.title),
    ["Implement and manage fixed assets", "Process fixed asset transactions"],
  );
});

test("AB-100 (real guide): 3 domains, 10 groups, 74 tasks", () => {
  const r = parseGuide(guide("AB-100").lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { domains: 3, groups: 10, tasks: 74 });
});

const lines = (...parts) => parts.flat();

test("two glance entries with the same weight and overlapping words are two domains when both have a section (AB-410)", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Create a foundation for intelligent applications (25–30%)",
      "- Create intelligent applications (25–30%)",
      "### Create a foundation for intelligent applications (25–30%)",
      "#### Design",
      "- Task one",
      "### Create intelligent applications (25–30%)",
      "#### Build",
      "- Task two",
    ),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.domains.map((d) => d.title),
    [
      "Create a foundation for intelligent applications",
      "Create intelligent applications",
    ],
  );
  assert.deepEqual(
    r.warnings.filter((w) => /twice/.test(w)),
    [],
  );
});

test("a glance entry with no section of its own that repeats another one is a duplicate, not a missing domain (GH-300)", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Use GitHub Copilot features (25–30%)",
      "- GitHub Copilot features (25–30%)",
      "- Other domain (10–15%)",
      "### Use GitHub Copilot features (25–30%)",
      "#### Use it",
      "- Task one",
      "### Other domain (10–15%)",
      "#### Group",
      "- Task two",
    ),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.domains.map((d) => d.title),
    ["Use GitHub Copilot features", "Other domain"],
  );
  assert.ok(
    r.warnings.some((w) => /names "GitHub Copilot features" twice/.test(w)),
  );
});

test("a domain the glance list words differently from its heading is matched by weight and words, with a warning (AZ-802)", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Manage virtual machines (10–15%)",
      "- Secure servers (20–25%)",
      "### Manage VMs (10–15%)",
      "#### Group",
      "- Task one",
      "### Secure servers (20–25%)",
      "#### Group",
      "- Task two",
    ),
  );
  assert.equal(r.ok, true);
  assert.equal(r.domains[0].title, "Manage virtual machines");
  assert.equal(r.domains[0].headingText, "Manage VMs");
  assert.ok(
    r.warnings.some((w) =>
      /"Manage virtual machines" \(glance list\) is the section "Manage VMs"/.test(
        w,
      ),
    ),
  );
  // a different weight is not a match
  const wrong = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Manage virtual machines (10–15%)",
      "### Manage VMs (20–25%)",
      "#### G",
      "- Task",
    ),
  );
  assert.equal(wrong.ok, false);
  assert.ok(wrong.warnings.some((w) => /has no section/.test(w)));
});

test("bullets directly under a domain become an implicit group named after the domain", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Only domain (100%)",
      "### Only domain (100%)",
      "- Loose task",
      "#### A real group",
      "- Grouped task",
    ),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.domains[0].groups.map((g) => [
      g.title,
      g.implicit === true,
      g.tasks.length,
    ]),
    [
      ["Only domain", true, 1],
      ["A real group", false, 1],
    ],
  );
});

test("a guide without a glance list falls back to the weighted headings, with a warning", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Alpha (50–55%)",
      "#### Group",
      "- Task one",
      "### Beta (45–50%)",
      "#### Group",
      "- Task two",
    ),
  );
  assert.equal(r.ok, true);
  assert.equal(r.stats.domains, 2);
  assert.ok(r.warnings.some((w) => /no "Skills at a glance" list/.test(w)));
});

test("a guide that cannot be parsed is not ok, whatever else it returns", () => {
  const none = parseGuide([
    "## Updates to the exam",
    "Some text.",
    "- a bullet",
  ]);
  assert.equal(none.ok, false);
  assert.deepEqual(none.stats, { domains: 0, groups: 0, tasks: 0 });
  assert.equal(parseGuide(undefined).ok, false);
  const noTasks = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Alpha (100%)",
      "### Alpha (100%)",
      "#### Group",
    ),
  );
  assert.equal(noTasks.ok, false);
  assert.ok(noTasks.warnings.some((w) => /has no tasks/.test(w)));
});

test("a heading that looks like page furniture inside a domain is reported, and the study resources end the skills", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Alpha (100%)",
      "### Alpha (100%)",
      "#### Group",
      "- Task",
      "#### Practice assessment",
      "- Take it",
      "### Study resources",
      "- A course",
    ),
  );
  assert.ok(
    r.warnings.some((w) =>
      /"Practice assessment" in "Alpha" looks like page furniture/.test(w),
    ),
  );
  assert.equal(
    r.stats.tasks,
    2,
    "the bullets under 'Study resources' are not tasks",
  );
});

test("task keys stay unique when a task repeats within a group", () => {
  const r = parseGuide(
    lines(
      "## Skills measured",
      "### Skills at a glance",
      "- Alpha (100%)",
      "### Alpha (100%)",
      "#### Group",
      "- Same task",
      "- Same task",
    ),
  );
  assert.deepEqual(
    r.domains[0].groups[0].tasks.map((t) => t.key),
    ["alpha/group/same-task", "alpha/group/same-task-2"],
  );
});

const tree = (spec) => ({
  domains: spec.map(([title, groups]) => ({
    title,
    groups: groups.map(([gt, tasks]) => ({ title: gt, tasks })),
  })),
});

test("diffTrees: identical trees, a renamed group, an inserted task and a reordering are each one clear difference", () => {
  const a = tree([
    [
      "D1",
      [
        ["G1", ["t1", "t2", "t3"]],
        ["G2", ["t4"]],
      ],
    ],
  ]);
  assert.deepEqual(
    diffTrees(
      a,
      tree([
        [
          "D1",
          [
            ["G1", ["t1", "t2", "t3"]],
            ["G2", ["t4"]],
          ],
        ],
      ]),
    ),
    { identical: true, differences: [] },
  );
  const renamed = diffTrees(
    a,
    tree([
      [
        "D1",
        [
          ["G1", ["t1", "t2", "t3"]],
          ["G2 renamed", ["t4"]],
        ],
      ],
    ]),
  );
  assert.deepEqual(
    renamed.differences.map((d) => d.kind),
    ["missing-group", "extra-group"],
  );
  const inserted = diffTrees(
    a,
    tree([
      [
        "D1",
        [
          ["G1", ["t1", "new", "t2", "t3"]],
          ["G2", ["t4"]],
        ],
      ],
    ]),
  );
  assert.deepEqual(inserted.differences, [
    { kind: "extra-task", at: ["D1", "G1", "new"], actual: "new" },
  ]);
  const removed = diffTrees(
    a,
    tree([
      [
        "D1",
        [
          ["G1", ["t1", "t3"]],
          ["G2", ["t4"]],
        ],
      ],
    ]),
  );
  assert.deepEqual(removed.differences, [
    { kind: "missing-task", at: ["D1", "G1", "t2"], expected: "t2" },
  ]);
  const reordered = diffTrees(
    a,
    tree([
      [
        "D1",
        [
          ["G2", ["t4"]],
          ["G1", ["t1", "t2", "t3"]],
        ],
      ],
    ]),
  );
  assert.deepEqual(
    reordered.differences.map((d) => d.kind),
    ["reordered-groups"],
  );
  const missingDomain = diffTrees(a, tree([]));
  assert.deepEqual(
    missingDomain.differences.map((d) => d.kind),
    ["missing-domain"],
  );
});

test("diffTrees ignores whitespace, quote and dash variants, accepts task objects or strings, and keeps case", () => {
  const a = {
    domains: [
      {
        title: "D",
        groups: [{ title: "G–x", tasks: [{ text: "Don’t  panic" }] }],
      },
    ],
  };
  const b = {
    domains: [
      { title: "D", groups: [{ title: "G-x", tasks: ["Don't panic"] }] },
    ],
  };
  assert.equal(diffTrees(a, b).identical, true);
  const c = {
    domains: [
      { title: "D", groups: [{ title: "G-x", tasks: ["don't panic"] }] },
    ],
  };
  assert.equal(diffTrees(a, c).identical, false);
});

test("treeFromCourseMdx reads ## domain (weighted), ### group and #### task, skipping the audience profile and code blocks", () => {
  const mdx = [
    "---\r",
    "title: x\r",
    "---\r",
    "## Audience profile\r",
    "### You should be familiar with\r",
    "#### Operating systems\r",
    "## Manage things (20–25%)\r",
    "### Group one\r",
    "#### Task a\r",
    "#### Task b\r",
    "```",
    "## Not a heading (10%)",
    "```",
    "## Other (75–80%)",
    "### Group two",
    "#### Task c",
  ].join("\n");
  const t = treeFromCourseMdx(mdx);
  assert.deepEqual(
    t.domains.map((d) => [
      d.title,
      d.groups.map((g) => [g.title, g.tasks.map((x) => x.text)]),
    ]),
    [
      ["Manage things", [["Group one", ["Task a", "Task b"]]]],
      ["Other", [["Group two", ["Task c"]]]],
    ],
  );
  assert.deepEqual(treeFromCourseMdx(undefined), { domains: [] });
});

test("a course page built from the AZ-104 guide's own headings matches it exactly; one changed heading is reported", () => {
  const parsed = parseGuide(guide("AZ-104").lines);
  const mdx = (changed) =>
    parsed.domains
      .map((d) =>
        [
          `## ${d.title} (${d.weight.min}–${d.weight.max}%)`,
          ...d.groups.flatMap((g) => [
            `### ${g.title}`,
            ...g.tasks.map(
              (t) =>
                `#### ${changed && t.text === "Manage subscriptions" ? "Manage your subscriptions" : t.text}`,
            ),
          ]),
        ].join("\n"),
      )
      .join("\n");
  assert.equal(
    diffTrees(parsed, treeFromCourseMdx(mdx(false))).identical,
    true,
  );
  const changed = diffTrees(parsed, treeFromCourseMdx(mdx(true)));
  assert.deepEqual(
    changed.differences.map((d) => d.kind),
    ["missing-task", "extra-task"],
  );
});
