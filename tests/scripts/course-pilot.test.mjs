import assert from "node:assert/strict";
import test from "node:test";
import { parseGuide } from "../../scripts/lib/course-guide.mjs";
import { renderCourse } from "../../scripts/lib/course-render.mjs";
import {
  CRITERIA,
  drawGoldSample,
  drawReviewSample,
  goldAgreement,
  goldTemplate,
  kindOfLearnPath,
  picksFromCourseFile,
  picksFromCourseMdx,
  queueShare,
  scoreReviewSample,
  seededRandom,
  wilsonLowerBound,
} from "../../scripts/lib/course-pilot.mjs";
import { exampleCourse, readGuideFixture } from "./helpers/example-course.mjs";

const guideOf = (code) => {
  const fixture = readGuideFixture(code);
  return { ...parseGuide(fixture.lines), hash: fixture.hash };
};

/** A gated item, as scripts/lib/course-gates.mjs writes it, with just what the pilot reads. */
function gated(task, path, decision, extra = {}) {
  const { by = "gates", via = "gates", cls = "core", quote, group } = extra;
  return {
    task: { key: task, text: `Text of ${task}`, group: group ?? "Group" },
    target: {
      kind:
        path.split("/").length > 4
          ? "unit"
          : path.startsWith("/training")
            ? "module"
            : "docs",
      path,
    },
    title: `Title of ${path}`,
    source: "P1",
    judge: { verdict: "core", why: `why ${path}`, ...(quote ? { quote } : {}) },
    gate: { decision, class: cls, by, via, reasons: [] },
  };
}
const file = (items, code = "NET-100") => ({
  kind: "gated",
  code,
  items,
});

test("kindOfLearnPath: module, unit and docs pages; everything else on Learn is not a pick", () => {
  assert.equal(kindOfLearnPath("/training/modules/m"), "module");
  assert.equal(kindOfLearnPath("/training/modules/m/2-unit"), "unit");
  assert.equal(kindOfLearnPath("/azure/app-service/overview"), "docs");
  for (const path of [
    "/training/paths/p",
    "/credentials/certifications/exams/az-104",
    "/shows/x",
    "/answers/questions/1",
    "",
    null,
  ])
    assert.equal(kindOfLearnPath(path), null, String(path));
});

test("the picks of a rendered course page are the picks of its course file", () => {
  const { course, guide } = exampleCourse();
  const fromFile = picksFromCourseFile(course);
  const fromPage = picksFromCourseMdx(renderCourse(course), guide);
  const key = (p) =>
    `${p.task.key}|${p.target.kind}|${p.target.path}|${p.title}`;
  assert.equal(fromFile.picks.length, 5);
  assert.deepEqual(
    fromPage.picks.map(key).sort(),
    fromFile.picks.map(key).sort(),
  );
  assert.deepEqual(fromPage.unmatched, []);
  assert.equal(fromPage.tasks, 36);
  const first = fromPage.picks[0];
  assert.deepEqual(Object.keys(first.task).sort(), [
    "domain",
    "group",
    "key",
    "text",
  ]);
});

test("a course page's picks are tied to the guide's tasks by title; other headings, links and code are ignored", () => {
  const guide = guideOf("GH-900");
  const { course } = exampleCourse();
  let page = renderCourse(course);
  // a task that is not in the guide: its picks are reported, not guessed
  page = page.replace(
    "#### Describe the purpose and benefits of version control",
    "#### Describe something the guide does not say",
  );
  // a card outside Learn, one to a path, and one in a code fence
  page = page.replace(
    "<CardGrid>",
    '<CardGrid>\n      <LinkCard title="Elsewhere" href="https://example.com/x" target="_blank"/>\n      <LinkCard title="A path" href="https://learn.microsoft.com/training/paths/p" target="_blank"/>',
  );
  page +=
    '\n```\n#### Not a heading\n<LinkCard title="x" href="https://learn.microsoft.com/azure/x"/>\n```\n';
  const found = picksFromCourseMdx(page, guide);
  assert.deepEqual(found.unmatched, [
    "Describe something the guide does not say",
  ]);
  assert.ok(found.picks.every((p) => p.target.path !== "/azure/x"));
  assert.ok(
    found.picks.every(
      (p) => !/example\.com|training\/paths/.test(p.target.path),
    ),
  );
  assert.equal(found.picks.length, 4);
});

test("a seeded generator gives the same numbers for the same seed", () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  const first = [a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b()]);
  assert.ok(first.every((n) => n >= 0 && n < 1));
  assert.notDeepEqual(first, [
    seededRandom(6)(),
    seededRandom(6)(),
    seededRandom(6)(),
  ]);
});

function manyPicks() {
  const picks = [];
  for (const [domain, tasks, per] of [
    ["D1", 6, 4],
    ["D2", 3, 6],
    ["D3", 2, 2],
  ])
    for (let t = 0; t < tasks; t++)
      for (let p = 0; p < per; p++)
        picks.push({
          task: {
            key: `${domain}/t${t}`,
            text: `t${t}`,
            domain,
            group: `${domain} group`,
          },
          target: { kind: "docs", path: `/azure/${domain}/${t}/${p}` },
          title: `Page ${domain} ${t} ${p}`,
        });
  return picks;
}

test("a gold sample has the size asked for, is spread over the domains and tasks, and is repeatable", () => {
  const picks = manyPicks();
  const sample = drawGoldSample(picks, { size: 12, seed: 3 });
  assert.equal(sample.length, 12);
  assert.equal(new Set(sample).size, 12);
  assert.deepEqual(
    new Set(sample.map((p) => p.task.domain)),
    new Set(["D1", "D2", "D3"]),
  );
  assert.ok(
    new Set(sample.map((p) => p.task.key)).size >= 9,
    "different tasks, not one task's picks",
  );
  assert.deepEqual(sample, drawGoldSample(picks, { size: 12, seed: 3 }));
  assert.notDeepEqual(
    sample.map((p) => p.target.path),
    drawGoldSample(picks, { size: 12, seed: 4 }).map((p) => p.target.path),
  );
  const keys = sample.map((p) => `${p.task.key}|${p.target.path}`);
  assert.deepEqual(keys, [...keys].sort(), "sorted by task and address");
});

test("a gold sample always holds the picks it was told to include, and cannot be bigger than the course", () => {
  const picks = manyPicks();
  const sample = drawGoldSample(picks, {
    size: 5,
    seed: 1,
    include: ["D3/1/1"],
  });
  assert.equal(sample.length, 5);
  assert.ok(sample.some((p) => p.target.path === "/azure/D3/1/1"));
  assert.equal(drawGoldSample(picks, { size: 500 }).length, picks.length);
  const titled = drawGoldSample(picks, { size: 3, include: ["PAGE D2 2 5"] });
  assert.ok(
    titled.some((p) => p.title === "Page D2 2 5"),
    "matched on the title, any case",
  );
});

test("a gold template is unmarked and names the skill groups the pipeline has to run on", () => {
  const picks = manyPicks().slice(0, 30);
  const gold = goldTemplate({ code: "NET-100", source: "x.mdx", picks });
  assert.equal(gold.kind, "gold");
  assert.deepEqual(gold.groups, ["D1 group", "D2 group"]);
  assert.ok(gold.picks.every((p) => p.mark === null && p.note === ""));
  assert.deepEqual(Object.keys(gold.picks[0]).sort(), [
    "group",
    "mark",
    "note",
    "target",
    "task",
    "taskText",
    "title",
  ]);
});

function marked(...rows) {
  return {
    kind: "gold",
    code: "NET-100",
    picks: rows.map(([task, path, mark]) => ({
      task,
      taskText: `Text of ${task}`,
      group: "Group",
      target: { kind: "docs", path },
      title: path,
      mark,
      note: "",
    })),
  };
}

test("the gold set against the gates: kept picks that were accepted or queued are retained, lost ones are not", () => {
  const items = [
    gated("t1", "/azure/a", "accept"),
    gated("t1", "/azure/b", "accept", { by: "maintainer", via: "remembered" }),
    gated("t1", "/azure/c", "queue", { by: "maintainer" }),
    gated("t1", "/azure/d", "reject", { via: "judge" }),
    gated("t2", "/azure/other", "accept"),
  ];
  const result = goldAgreement(
    marked(
      ["t1", "/azure/a", "keep"],
      ["t1", "/azure/b", "keep"],
      ["t1", "/azure/c", "keep"],
      ["t1", "/azure/d", "keep"],
      ["t1", "/azure/never", "keep"],
      ["t2", "/azure/never2", "keep"],
    ),
    file(items),
  );
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.items.map((i) => i.outcome),
    [
      "accepted by the gates",
      "accepted by the maintainer",
      "queued",
      "rejected by the judge",
      "not a candidate",
      "not a candidate",
    ],
  );
  assert.equal(result.keeps.total, 6);
  assert.equal(result.keeps.lost, 3);
  assert.equal(result.keeps.retainedShare, 0.5);
  assert.equal(result.passes.keepsRetained, false);
  assert.equal(
    result.passes.noFalseAccepts,
    true,
    "no drops at all: nothing falsely accepted",
  );
});

test("a kept module that the pipeline found as another page of the same module counts, with the page named", () => {
  const items = [
    gated("t1", "/training/modules/m", "queue", { by: "maintainer" }),
    gated("t1", "/training/modules/m/2-unit", "accept"),
    gated("t1", "/training/modules/n/2-unit", "reject", { via: "judge" }),
  ];
  const result = goldAgreement(
    marked(
      ["t1", "/training/modules/m/3-other", "keep"],
      ["t1", "/training/modules/n", "keep"],
    ),
    file(items),
  );
  assert.equal(result.items[0].outcome, "accepted by the gates");
  assert.equal(
    result.items[0].nearPath,
    "/training/modules/m/2-unit",
    "the best outcome among the module's pages",
  );
  assert.equal(result.items[0].found, false);
  assert.equal(result.items[1].outcome, "rejected by the judge");
  assert.equal(result.keeps.foundAsAnotherPageOfTheModule, 2);
  assert.equal(result.keeps.lost, 1);
  // a drop is only matched exactly
  const drop = goldAgreement(
    marked(["t1", "/training/modules/m/3-other", "drop"]),
    file(items),
  );
  assert.equal(drop.items[0].outcome, "not a candidate");
  assert.equal(drop.drops.falseAccepts, 0);
});

test("a dropped pick that the gates accepted on their own is a false accept and fails the criterion", () => {
  const items = [
    gated("t1", "/azure/entitlement", "accept"),
    gated("t1", "/azure/queued", "queue", { by: "maintainer" }),
    gated("t1", "/azure/rejected", "reject", { via: "judge" }),
    gated("t1", "/azure/by-hand", "accept", {
      by: "maintainer",
      via: "remembered",
    }),
  ];
  const result = goldAgreement(
    marked(
      ["t1", "/azure/entitlement", "drop"],
      ["t1", "/azure/queued", "drop"],
      ["t1", "/azure/rejected", "drop"],
      ["t1", "/azure/by-hand", "drop"],
      ["t1", "/azure/absent", "drop"],
    ),
    file(items),
  );
  assert.deepEqual(result.drops, {
    total: 5,
    falseAccepts: 1,
    queued: 1,
    rejected: 1,
    notCandidates: 1,
  });
  assert.equal(result.passes.noFalseAccepts, false);
  assert.equal(
    goldAgreement(marked(["t1", "/azure/entitlement", "drop"]), file(items), {
      maxFalseAccepts: 1,
    }).passes.noFalseAccepts,
    true,
  );
  assert.equal(result.keeps.retainedShare, null);
  assert.equal(result.passes.keepsRetained, true, "no keeps to lose");
});

test("the gold file's problems: wrong exam, a task the pipeline did not run on, a mark that is neither, a twice-listed pick", () => {
  const items = [gated("t1", "/azure/a", "accept")];
  const result = goldAgreement(
    {
      ...marked(
        ["t1", "/azure/a", "keep"],
        ["t1", "/azure/a", "keep"],
        ["t1", "/azure/b", "Keep"],
        ["t9", "/azure/c", "keep"],
        ["t1", "/azure/d", null],
        ["t1", "/azure/e", ""],
      ),
      code: "OTHER-1",
    },
    file(items),
  );
  assert.equal(result.unmarked, 2);
  assert.deepEqual(result.problems, [
    "the gold file is for OTHER-1, the gated file for NET-100",
    "t1|/azure/a is in the gold file twice",
    't1 /azure/b: the mark is "Keep", not keep or drop',
    "t9: the pipeline did not run on this task (judge and gate it, or remove its picks from the gold file)",
  ]);
  assert.deepEqual(goldAgreement({ kind: "nope" }, file(items)).problems, [
    "not a gold file",
  ]);
});

test("the review sample holds only what the gates accepted on their own, repeatably, with the judge's reason and quote", () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) =>
      gated(`t${i % 5}`, `/azure/auto/${i}`, "accept", { quote: `quote ${i}` }),
    ),
    gated("t0", "/azure/hand", "accept", {
      by: "maintainer",
      via: "remembered",
    }),
    gated("t0", "/azure/queued", "queue", { by: "maintainer" }),
    gated("t0", "/azure/rejected", "reject", { via: "judge" }),
  ];
  const sample = drawReviewSample(file(items), { size: 10, seed: 2 });
  assert.equal(sample.kind, "review-sample");
  assert.equal(sample.population, 30);
  assert.equal(sample.items.length, 10);
  assert.ok(
    sample.items.every((i) => i.target.path.startsWith("/azure/auto/")),
  );
  assert.ok(sample.items.every((i) => i.correct === null && i.note === ""));
  assert.ok(
    sample.items.every(
      (i) => i.url === `https://learn.microsoft.com${i.target.path}`,
    ),
  );
  assert.match(sample.items[0].judge, /^why \/azure\/auto\//);
  assert.match(sample.items[0].quote, /^quote \d+$/);
  assert.deepEqual(
    sample,
    drawReviewSample(file(items), { size: 10, seed: 2 }),
  );
  assert.equal(
    drawReviewSample(file(items), { size: 100 }).items.length,
    30,
    "all of them when there are fewer",
  );
});

test("the queue share is the queued part of the judge's picks; rejections are not picks", () => {
  const items = [
    gated("t", "/a", "accept"),
    gated("t", "/b", "accept", { by: "maintainer", via: "remembered" }),
    gated("t", "/c", "accept"),
    gated("t", "/d", "queue", { by: "maintainer" }),
    gated("t", "/e", "reject", { via: "judge" }),
  ];
  assert.deepEqual(queueShare(file(items)), {
    accepted: 3,
    acceptedByGates: 2,
    queued: 1,
    rejected: 1,
    share: 0.25,
  });
  assert.equal(
    queueShare(file([gated("t", "/e", "reject", { via: "judge" })])).share,
    null,
  );
});

test("wilsonLowerBound says how far a small sample can be trusted", () => {
  assert.equal(wilsonLowerBound(0, 0), null);
  assert.ok(
    Math.abs(wilsonLowerBound(38, 40) - 0.835) < 0.001,
    "95% of 40 could be 83.5%",
  );
  assert.ok(
    wilsonLowerBound(190, 200) > 0.91 && wilsonLowerBound(190, 200) < 0.93,
  );
  assert.ok(wilsonLowerBound(40, 40) > 0.91 && wilsonLowerBound(40, 40) < 1);
  assert.equal(wilsonLowerBound(0, 10) >= 0, true);
});

test("a review sample is scored on the items marked; it passes only once every item is marked", () => {
  const sample = (marks) => ({
    kind: "review-sample",
    code: "NET-100",
    population: 80,
    items: marks.map((correct, i) => ({
      task: "t",
      taskText: "Text",
      target: { path: `/azure/${i}` },
      title: `Page ${i}`,
      url: `https://learn.microsoft.com/azure/${i}`,
      correct,
      note: "",
    })),
  });
  const pending = scoreReviewSample(sample([true, true, null]));
  assert.equal(pending.answered, 2);
  assert.equal(pending.pending, 1);
  assert.equal(pending.passes, null);
  const twenty = Array(19).fill(true).concat(false);
  const exact = scoreReviewSample(sample(twenty));
  assert.equal(exact.share, 0.95);
  assert.equal(exact.passes, true, "95% meets a limit of 95%");
  assert.equal(exact.wrongItems.length, 1);
  assert.ok(exact.lowerBound < 0.8, "20 samples prove little");
  const worse = scoreReviewSample(
    sample(Array(18).fill(true).concat([false, false])),
  );
  assert.equal(worse.passes, false);
  assert.equal(
    scoreReviewSample(sample([true, false]), { minCorrect: 0.5 }).passes,
    true,
  );
  const odd = scoreReviewSample(sample([true, "yes", null]));
  assert.equal(odd.problems.length, 1);
  assert.match(odd.problems[0], /"correct" must be true or false, not "yes"/);
  assert.equal(odd.pending, 1);
  assert.deepEqual(scoreReviewSample({ kind: "x" }).problems, [
    "not a review sample",
  ]);
});

test("the default criteria are the pilot's: 95% right, a quarter queued, nine in ten keeps, no false accepts", () => {
  assert.deepEqual(
    { ...CRITERIA },
    {
      minCorrect: 0.95,
      maxQueueShare: 0.25,
      minKeepRetained: 0.9,
      maxFalseAccepts: 0,
    },
  );
  assert.ok(Object.isFrozen(CRITERIA));
});
