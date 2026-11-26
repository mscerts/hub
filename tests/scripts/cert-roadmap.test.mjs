import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import { examStatuses } from "../../src/data_files/exam-status.mjs";
import {
  examAreaOf,
  examCodesOf,
  examHref,
  panelId,
  reachableIds,
  readRoadmap,
  roadmapOutline,
  roadmapProblems,
} from "../../src/utils/cert-roadmap.mjs";
import { readRetiredExamCodes } from "../../src/utils/measureup-bundles.mjs";
import { serializeMdx } from "../../src/utils/markdown/serializeMdx.ts";

const root = resolve(import.meta.dirname, "../..");
const roadmap = readRoadmap(root);

const retiringCodes = () => {
  const tracker = JSON.parse(
    readFileSync(join(root, "src/data_files/retiring-exams.json"), "utf8"),
  );
  return new Set((tracker.exams ?? []).map((entry) => entry.code));
};

test("the roadmap is sound: every answer leads somewhere, nothing is unreachable, no path loops", () => {
  assert.deepEqual(roadmapProblems(roadmap), []);
});

test("roadmapProblems names what is wrong with a broken roadmap", () => {
  const broken = {
    start: "a",
    steps: {
      a: {
        question: "A?",
        answers: [
          { label: "to b", next: "b" },
          { label: "to nowhere", next: "missing" },
        ],
      },
      b: {
        question: "B?",
        answers: [
          { label: "back", next: "a" },
          { label: "result", next: "r" },
        ],
      },
      orphan: {
        question: "Orphan?",
        answers: [
          { label: "x", next: "r" },
          { label: "y", next: "r" },
        ],
      },
    },
    results: {
      r: { title: "R", summary: "S", exams: [] },
    },
  };
  const problems = roadmapProblems(broken).join("\n");
  assert.match(problems, /"missing" does not exist/);
  assert.match(problems, /loop: a -> b -> a/);
  assert.match(problems, /"orphan" cannot be reached/);
  assert.match(problems, /Result "r" names no exam and has no link/);
});

test("every exam the roadmap recommends has a page on the hub", () => {
  for (const code of examCodesOf(roadmap)) {
    const area = examAreaOf(code);
    assert.ok(area, `${code}: no area`);
    assert.ok(
      existsSync(join(root, "src", "content", "docs", area, `${code}.mdx`)),
      `${code} has no page under src/content/docs/${area}/`,
    );
    assert.equal(examHref(code), `/certs/${area}/${code.toLowerCase()}/`);
  }
});

test("no exam of the roadmap is retired, retiring or marked at risk", () => {
  const retired = readRetiredExamCodes(root);
  const retiring = retiringCodes();
  const flagged = new Set(
    Object.values(examStatuses).flatMap((area) =>
      Object.entries(area)
        .filter(([, status]) =>
          ["RETIRED", "RETIRING", "AT RISK"].includes(status.text),
        )
        .map(([code]) => code),
    ),
  );
  for (const code of examCodesOf(roadmap)) {
    assert.ok(!retired.has(code), `${code} is retired`);
    assert.ok(!retiring.has(code), `${code} is retiring`);
    assert.ok(!flagged.has(code), `${code} has a retirement or at-risk badge`);
  }
});

test("the replacements are used, not the retired exams", () => {
  const codes = new Set(examCodesOf(roadmap));
  for (const code of [
    "PL-200",
    "PL-400",
    "AZ-204",
    "AZ-400",
    "MS-102",
    "MB-330",
  ])
    assert.ok(!codes.has(code), `${code} must not be recommended`);
  for (const code of [
    "AB-400",
    "AB-410",
    "AI-200",
    "AI-500",
    "AZ-401",
    "AB-650",
    "AB-330",
  ])
    assert.ok(codes.has(code), `${code} should be recommended`);
});

test("the fundamentals exams of the poster are all offered to someone who is not sure", () => {
  const unsure = roadmap.results["r-fund-unsure"].exams.map(
    (exam) => exam.code,
  );
  assert.deepEqual([...unsure].sort(), [
    "AB-900",
    "AI-901",
    "AZ-900",
    "DP-900",
    "GH-900",
    "PL-900",
    "SC-900",
  ]);
});

test("the areas of the first questions all lead somewhere", () => {
  for (const id of ["new-area", "pro-area"]) {
    const labels = roadmap.steps[id].answers.map((answer) => answer.label);
    for (const area of [
      "Azure",
      "Security",
      "Power Platform",
      "Dynamics 365",
      "GitHub",
    ])
      assert.ok(
        labels.some((label) => label.includes(area)),
        `${id} has no ${area}`,
      );
  }
});

test("the page shows every step and result as a section the answers can link to", () => {
  const source = readFileSync(
    join(root, "src/components/CertRoadmap.astro"),
    "utf8",
  );
  assert.match(source, /idOf\(id\)/);
  assert.equal(panelId("x"), "roadmap-x");
  const page = readFileSync(
    join(root, "src/content/docs/guide/roadmap.mdx"),
    "utf8",
  );
  assert.match(page, /<CertRoadmap history \/>/);
  const sidebar = readFileSync(
    join(root, "src/data_files/docs-sidebar.ts"),
    "utf8",
  );
  assert.match(sidebar, /guide\/roadmap/);
});

test("the Markdown copy lists the roadmap as nested lists with links to the exam pages", async () => {
  const copy = await serializeMdx("<CertRoadmap />\n");
  assert.match(
    copy,
    /How much do you already work with Microsoft technology\?/,
  );
  assert.match(copy, /\[SC-200\]\(\/certs\/security\/sc-200\/\)/);
  assert.match(copy, /\[AB-400\]\(\/certs\/aibusiness\/ab-400\/\)/);
  assert.equal(roadmapOutline(roadmap).length, 1);
});

test("a roadmap that starts at a later step reaches only its own branch", () => {
  const azure = reachableIds(roadmap, "azure-focus");
  assert.ok(azure.has("azure-focus") && azure.has("r-azure-admin"));
  assert.ok(!azure.has("security-focus") && !azure.has("r-sec-soc"));
  assert.ok(!azure.has("experience"));
  // every step and result can be reached from the start
  assert.equal(
    reachableIds(roadmap).size,
    Object.keys(roadmap.steps).length + Object.keys(roadmap.results).length,
  );
  const outline = roadmapOutline(roadmap, undefined, "security-focus");
  assert.equal(outline[0].text, roadmap.steps["security-focus"].question);
  assert.throws(() => roadmapOutline(roadmap, undefined, "nowhere"), /nowhere/);
});

test("two roadmaps on one page get ids that cannot clash", () => {
  assert.equal(panelId("azure-focus", "rm-azure"), "rm-azure-azure-focus");
  assert.notEqual(panelId("a", "one"), panelId("a", "two"));
});

test("the component is a wizard that can sit on any page: props, the answer markers and the script it needs", () => {
  const source = readFileSync(
    join(root, "src/components/CertRoadmap.astro"),
    "utf8",
  );
  for (const needle of [
    "start?: string",
    "prefix?: string",
    "history?: boolean",
    "data-roadmap-answer",
    "data-roadmap-reset",
    "data-roadmap-jump",
    "data-roadmap-back",
    "<script>",
    "pushState",
  ])
    assert.ok(source.includes(needle), `CertRoadmap.astro lacks ${needle}`);
  // the page with the roadmap in the address and the history: one per page
  const page = readFileSync(
    join(root, "src/content/docs/guide/roadmap.mdx"),
    "utf8",
  );
  assert.match(page, /<CertRoadmap history \/>/);
});

test("the Markdown copy follows the start of a roadmap placed on another page", async () => {
  const copy = await serializeMdx('<CertRoadmap start="security-focus" />\n');
  assert.match(copy, /What do you do in security\?/);
  assert.match(copy, /\[SC-200\]/);
  assert.doesNotMatch(copy, /What do you do on Azure\?/);
});

test("every exam page of the hub that is not retiring is recommended somewhere, and no question is too long or too deep", () => {
  const live = EXAM_AREAS.flatMap((area) =>
    readdirSync(join(root, "src", "content", "docs", area)).map((file) =>
      file.replace(/\.mdx$/, ""),
    ),
  );
  const retiring = retiringCodes();
  const flagged = new Set(
    Object.values(examStatuses).flatMap((area) =>
      Object.entries(area)
        .filter(([, status]) => ["RETIRED", "RETIRING"].includes(status.text))
        .map(([code]) => code),
    ),
  );
  const recommended = new Set(examCodesOf(roadmap));
  for (const code of live) {
    if (retiring.has(code) || flagged.has(code)) continue;
    assert.ok(recommended.has(code), `${code} is not in any result`);
  }
  // at most 7 answers to a question, at most 5 questions before a result
  for (const [id, step] of Object.entries(roadmap.steps))
    assert.ok(
      step.answers.length <= 7,
      `${id} has ${step.answers.length} answers`,
    );
  let deepest = 0;
  const walk = (id, depth) => {
    if (id in roadmap.results) {
      deepest = Math.max(deepest, depth);
      return;
    }
    for (const answer of roadmap.steps[id].answers)
      walk(answer.next, depth + 1);
  };
  walk(roadmap.start, 0);
  assert.ok(deepest <= 5, `the longest path has ${deepest} questions`);
});

test("an expert exam is only a first choice after its prerequisite is settled", () => {
  // AZ-305, SC-100, AB-100 and AZ-401 earn an expert certification only with another certification or exam
  // (src/data_files/related-certs.ts): a result that starts with one of them is reached after the question
  // that asks for it, or is a result about what comes after a certification the visitor holds
  const expert = new Set(["AZ-305", "SC-100", "AB-100", "AZ-401"]);
  const asks = {
    "arch-azure-prereq": "r-arch-azure",
    "arch-security-prereq": "r-arch-security",
    "arch-ai-prereq": "r-arch-ai",
    "devops-prereq": "r-devops",
  };
  for (const [step, result] of Object.entries(asks)) {
    const yes = roadmap.steps[step].answers.find((a) => a.label === "Yes");
    assert.equal(yes?.next, result, `${step}: "Yes" leads to ${result}`);
  }
  const allowed = new Set([
    ...Object.values(asks),
    "r-next-az-104",
    "r-next-gh-300",
    "r-replace-pl-600",
  ]);
  for (const [id, result] of Object.entries(roadmap.results))
    for (const exam of result.exams)
      if (expert.has(exam.code) && exam.role === "start")
        assert.ok(
          allowed.has(id),
          `${id} starts with ${exam.code} without its prerequisite question`,
        );
});
