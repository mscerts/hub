import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";
import {
  certificationRequirements,
  externalPrerequisites,
} from "../../src/data_files/related-certs.ts";
import {
  idFromHash,
  trailTo,
  validTrail,
} from "../../src/utils/cert-roadmap-nav.mjs";
import { examStatuses } from "../../src/data_files/exam-status.mjs";
import {
  examAreaOf,
  examCodesOf,
  examHref,
  panelId,
  reachableIds,
  readRoadmap,
  describeExam,
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
  assert.match(copy, /\[SC-200[^\]]*\]\(\/certs\/security\/sc-200\/\)/);
  assert.match(copy, /\[AB-400[^\]]*\]\(\/certs\/aibusiness\/ab-400\/\)/);
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
  assert.match(copy, /\[SC-200[^\]]*\]/);
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
        .filter(([, status]) =>
          ["RETIRED", "RETIRING", "AT RISK", "UPCOMING"].includes(status.text),
        )
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

// Every expert certification whose requirement the hub records (src/data_files/related-certs.ts) and whose exam is
// a live, non-retiring page has a question before it; the question and the "not yet" results are checked against
// the recorded prerequisites, not against a list written in the test.
const ASKS = {
  "AZ-305": { step: "arch-azure-prereq", yes: "r-arch-azure" },
  "SC-100": { step: "arch-security-prereq", yes: "r-arch-security" },
  "AB-100": { step: "arch-ai-prereq", yes: "r-arch-ai" },
  "AZ-401": { step: "devops-prereq", yes: "r-devops" },
};
const livePage = (code) => {
  const area = examAreaOf(code);
  return (
    Boolean(area) &&
    existsSync(join(root, "src/content/docs", area, `${code}.mdx`))
  );
};

test("every expert exam has a prerequisite question that matches the recorded requirements", () => {
  const retiringNow = retiringCodes();
  const experts = certificationRequirements
    .map((entry) => entry.expert)
    .filter((code) => livePage(code) && !retiringNow.has(code));
  assert.deepEqual([...experts].sort(), Object.keys(ASKS).sort());
  const resultsAfter = (id, found = new Set()) => {
    if (id in roadmap.results) return found.add(id);
    for (const answer of roadmap.steps[id].answers)
      resultsAfter(answer.next, found);
    return found;
  };
  for (const entry of certificationRequirements) {
    const ask = ASKS[entry.expert];
    if (!ask) continue;
    const step = roadmap.steps[ask.step];
    // the question names every prerequisite the hub or the requirements data knows by code
    const help = `${step.question} ${step.help ?? ""}`;
    for (const code of entry.prerequisites)
      if (livePage(code) || externalPrerequisites[code])
        assert.ok(help.includes(code), `${ask.step} does not name ${code}`);
    const yes = step.answers.find((answer) => answer.label === "Yes");
    const notYet = step.answers.find((answer) => answer.label === "Not yet");
    assert.equal(yes?.next, ask.yes);
    const yesExams = roadmap.results[ask.yes].exams;
    assert.deepEqual(
      yesExams.map((e) => e.code),
      [entry.expert],
    );
    // "not yet": the prerequisites come first, the expert exam last as `then`
    for (const id of resultsAfter(notYet.next)) {
      const exams = roadmap.results[id].exams;
      assert.ok(
        exams.some((e) => e.code === entry.expert && e.role === "then"),
        `${id} does not end on ${entry.expert}`,
      );
      for (const exam of exams.filter((e) => e.role === "start"))
        assert.ok(
          entry.prerequisites.includes(exam.code),
          `${id} starts with ${exam.code}, which ${entry.expert} does not list`,
        );
    }
  }
  // an expert exam is only a first choice in the "yes" results, or where a certification the visitor holds is named
  const allowed = new Set([
    ...Object.values(ASKS).map((ask) => ask.yes),
    "r-next-az-104",
    "r-next-gh-300",
    "r-replace-pl-600",
  ]);
  for (const [id, result] of Object.entries(roadmap.results))
    for (const exam of result.exams)
      if (ASKS[exam.code] && exam.role === "start")
        assert.ok(
          allowed.has(id),
          `${id} starts with ${exam.code} without asking for its prerequisite`,
        );
});

test("every exam of the roadmap has a built page (not a draft)", () => {
  for (const code of examCodesOf(roadmap)) {
    const area = examAreaOf(code);
    const text = readFileSync(
      join(root, "src/content/docs", area, `${code}.mdx`),
      "utf8",
    );
    assert.doesNotMatch(text, /^draft:\s*true\s*$/m, `${code} is a draft`);
    assert.ok(describeExam(code, root), `${code} has no examName`);
  }
});

test("roadmapProblems also reports bad roles, repeated answers, a missing exam list and a bad link", () => {
  const broken = {
    start: "a",
    steps: {
      a: {
        question: "A?",
        answers: [
          { label: "same", next: "r1" },
          { label: "same", next: "r2" },
        ],
      },
    },
    results: {
      r1: {
        title: "R1",
        summary: "S",
        exams: [{ code: "AZ-104", role: "optinal" }],
      },
      r2: {
        title: "R2",
        summary: "S",
        link: { label: "x", href: "/Certs/Bad" },
      },
    },
  };
  const problems = roadmapProblems(broken).join("\n");
  assert.match(problems, /role "optinal"/);
  assert.match(problems, /answer "same" twice/);
  assert.match(problems, /Result "r2" has no exams list/);
  // a result that only a "next" button leads to counts as reached
  const viaNext = {
    start: "a",
    steps: {
      a: {
        question: "A?",
        answers: [
          { label: "x", next: "r" },
          { label: "y", next: "r" },
        ],
      },
      b: {
        question: "B?",
        answers: [
          { label: "x", next: "r2" },
          { label: "y", next: "r2" },
        ],
      },
    },
    results: {
      r: {
        title: "R",
        summary: "S",
        exams: [{ code: "AZ-104", role: "start" }],
        next: { label: "Go", to: "b" },
      },
      r2: {
        title: "R2",
        summary: "S",
        exams: [{ code: "AZ-104", role: "start" }],
      },
    },
  };
  assert.deepEqual(roadmapProblems(viaNext), []);
  assert.match(
    roadmapProblems({
      ...viaNext,
      results: {
        ...viaNext.results,
        r2: { ...viaNext.results.r2, link: { label: "x", href: "/Certs/Bad" } },
      },
    }).join("\n"),
    /not an https address or a lowercase \/certs\/ path/,
  );
});

test("the wizard's address and history rules: headings, unknown ids, stale trails, trails to a step", () => {
  const known = new Set([
    ...Object.keys(roadmap.steps),
    ...Object.keys(roadmap.results),
  ]);
  assert.equal(
    idFromHash("#roadmap-security-focus", "roadmap", known),
    "security-focus",
  );
  // the anchor of a heading (the docs copy-link anchors and the search results use it) names its step
  assert.equal(
    idFromHash("#roadmap-security-focus-title", "roadmap", known),
    "security-focus",
  );
  assert.equal(idFromHash("roadmap-r-sec-soc", "roadmap", known), "r-sec-soc");
  // not the roadmap's: another prefix, an unknown id, the skip link, nothing
  assert.equal(idFromHash("#rm-azure-azure-focus", "roadmap", known), null);
  assert.equal(idFromHash("#roadmap-nowhere", "roadmap", known), null);
  assert.equal(idFromHash("#roadmap-nowhere-title", "roadmap", known), null);
  assert.equal(idFromHash("#main-content", "roadmap", known), null);
  assert.equal(idFromHash("", "roadmap", known), null);
  // a saved trail is trusted only when every id still exists and it starts at the start
  const ok = [
    { id: "experience", label: "" },
    { id: "pro-area", label: "I work with it in my job" },
  ];
  assert.deepEqual(validTrail(ok, "experience", known), ok);
  assert.equal(
    validTrail(
      [{ id: "experience" }, { id: "renamed-later" }],
      "experience",
      known,
    ),
    null,
  );
  assert.equal(validTrail([{ id: "pro-area" }], "experience", known), null);
  assert.equal(validTrail([], "experience", known), null);
  assert.equal(validTrail("pro-area", "experience", known), null);
  // the shortest trail to a step, only through known ids
  const edges = new Map(
    Object.entries(roadmap.steps).map(([id, step]) => [
      id,
      step.answers.map((answer) => ({ to: answer.next, label: answer.label })),
    ]),
  );
  const trail = trailTo(edges, "experience", "r-azure-admin", known);
  assert.equal(trail[0].id, "experience");
  assert.equal(trail.at(-1).id, "r-azure-admin");
  assert.ok(trail.length <= 5);
  assert.deepEqual(trailTo(edges, "experience", "nowhere", known), [
    { id: "experience", label: "" },
  ]);
  for (const item of trailTo(edges, "experience", "r-fund-unsure", known))
    assert.ok(known.has(item.id));
});

test("the Markdown copy keeps the help of a question and the name and badge of an exam", async () => {
  const copy = await serializeMdx("<CertRoadmap />\n");
  assert.match(
    copy,
    /Note: On this hub these are the certifications of AB-210/,
  );
  assert.match(copy, /Microsoft Azure Administrator/);
  // the beta label comes from the exam page's status, as on the page
  assert.match(copy, /AZ-401[^\n]*\(beta\)/);
});
