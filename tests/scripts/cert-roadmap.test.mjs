import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { examStatuses } from "../../src/data_files/exam-status.mjs";
import {
  examAreaOf,
  examCodesOf,
  examHref,
  panelId,
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
  const unsure = roadmap.results["new-unsure"].exams.map((exam) => exam.code);
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
  assert.match(source, /panelId\(id\)/);
  assert.equal(panelId("x"), "roadmap-x");
  const page = readFileSync(
    join(root, "src/content/docs/guide/roadmap.mdx"),
    "utf8",
  );
  assert.match(page, /<CertRoadmap \/>/);
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
