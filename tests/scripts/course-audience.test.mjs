import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { main } from "../../scripts/course-audience.mjs";
import {
  audienceBatches,
  audienceConcepts,
  audiencePrompt,
  audienceProblems,
  buildAudience,
  clearConcept,
  decisionsProblems,
  eachConcept,
  emptyDecisions,
  optionsInOrder,
  parseAudience,
  pickFromOption,
  pickFromUrl,
  renderSheet,
  setConcept,
} from "../../scripts/lib/course-audience.mjs";
import { generateCandidates } from "../../scripts/lib/course-candidates.mjs";
import {
  diffTrees,
  parseGuide,
  treeFromCourseMdx,
} from "../../scripts/lib/course-guide.mjs";
import { renderCourse } from "../../scripts/lib/course-render.mjs";
import { diffAudience } from "../../scripts/lib/course-status.mjs";
import { guideOf, scopeOf } from "./helpers/example-candidates.mjs";
import { exampleCourse } from "./helpers/example-course.mjs";
import { TASKS, worldPools } from "./helpers/example-judging.mjs";

const root = resolve(import.meta.dirname, "../..");
const az104 = JSON.parse(
  readFileSync(
    join(root, "tests/fixtures/course-source/guide-AZ-104.json"),
    "utf8",
  ),
);
const TODAY = "2026-10-26";

const temps = [];
after(() =>
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

test("the audience profile of a guide: the text, and every list with the line that leads it", () => {
  const audience = parseAudience(az104.lines);
  assert.equal(audience.intro.length, 2);
  assert.match(audience.intro[0], /subject matter expertise/);
  assert.deepEqual(
    audience.lists.map((l) => [l.lead, l.kind, l.items.length]),
    [
      ["You should be familiar with", "prerequisite", 4],
      ["In addition, you should have experience with", "prerequisite", 5],
    ],
  );
  assert.deepEqual(audience.lists[0].items, [
    "Operating systems",
    "Networking",
    "Servers",
    "Virtualization",
  ]);
  assert.deepEqual(parseGuide(az104.lines).audience, audience);
});

test("a list of responsibilities is a role list, a guide without a section has none, prose gives no list", () => {
  const audience = parseAudience([
    "### Audience profile",
    "Candidates build things.",
    "Your responsibilities include:",
    "- Planning",
    "- Reviewing",
    "You must have applied knowledge of:",
    "- Networking",
    "A line that leads nowhere:",
    "### Skills at a glance",
  ]);
  assert.deepEqual(
    audience.lists.map((l) => [l.lead, l.kind]),
    [
      ["Your responsibilities include", "role"],
      ["You must have applied knowledge of", "prerequisite"],
    ],
  );
  assert.deepEqual(audience.intro, [
    "Candidates build things.",
    "A line that leads nowhere:",
  ]);
  assert.equal(parseAudience(["### Skills at a glance", "- A"]), null);
  const prose = parseAudience([
    "### Audience profile",
    "You should be familiar with Azure and PowerShell.",
    "### Skills at a glance",
  ]);
  assert.deepEqual(prose.lists, []);
  assert.deepEqual(audienceConcepts(prose), []);
});

test("a concept has a key that stays while the wording does, and two lists with one lead do not collide", () => {
  const audience = parseAudience(az104.lines);
  const concepts = audienceConcepts(audience);
  assert.equal(concepts.length, 9);
  assert.equal(
    concepts[0].key,
    "audience/you-should-be-familiar-with/operating-systems",
  );
  assert.equal(concepts[4].list, 1);
  const twin = audienceConcepts({
    intro: [],
    lists: [
      { lead: "You know", kind: "prerequisite", items: ["A"] },
      { lead: "You know", kind: "prerequisite", items: ["A"] },
      { lead: "Role", kind: "role", items: ["B"] },
    ],
  });
  assert.deepEqual(
    twin.map((c) => c.key),
    ["audience/you-know/a", "audience/you-know-2/a"],
  );
});

test("a pick is a Learn page or a page of any https site, and nothing else", () => {
  const external = pickFromUrl({
    url: "https://www.netacad.com/courses/networking-basics",
    title: "Networking Basics",
    why: "Chosen by hand.",
    today: TODAY,
  });
  assert.deepEqual(external, {
    title: "Networking Basics",
    href: "https://www.netacad.com/courses/networking-basics",
    kind: "external",
    source: "maintainer",
    decidedAt: TODAY,
    why: "Chosen by hand.",
  });
  const learn = pickFromUrl({
    url: "https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview",
    title: "Hyper-V",
    today: TODAY,
  });
  assert.equal(learn.kind, "learn");
  assert.equal(learn.path, "/windows-server/virtualization/hyper-v/overview");
  assert.throws(
    () =>
      pickFromUrl({ url: "http://example.com/a", title: "A", today: TODAY }),
    /not an https address/,
  );
  assert.throws(
    () => pickFromUrl({ url: "not a url", title: "A", today: TODAY }),
    /not an https address/,
  );
  const option = pickFromOption(
    {
      title: "Fundamentals of computer networking",
      target: {
        kind: "module",
        path: "/training/modules/network-fundamentals",
      },
    },
    { today: TODAY },
  );
  assert.equal(
    option.href,
    "https://learn.microsoft.com/training/modules/network-fundamentals",
  );
  assert.equal(option.source, "option");
});

test("the decisions: set, replace, clear, and the checks of the file", () => {
  const audience = parseAudience(az104.lines);
  const [first, second] = audienceConcepts(audience);
  let d = emptyDecisions("AZ-104");
  d = setConcept(d, first, [
    pickFromUrl({ url: "https://example.com/os", title: "OS", today: TODAY }),
  ]);
  d = setConcept(d, second, []);
  assert.deepEqual(
    d.concepts.map((c) => [c.key, c.picks.length]),
    [
      [second.key, 0],
      [first.key, 1],
    ], // sorted by key
  );
  assert.deepEqual(decisionsProblems(d, { code: "AZ-104", audience }), {
    problems: [],
    warnings: [],
  });
  assert.equal(clearConcept(d, first).concepts.length, 1);

  const bad = structuredClone(d);
  bad.concepts[1].picks.push(bad.concepts[1].picks[0]);
  bad.concepts[1].picks[0].kind = "learn";
  assert.match(
    decisionsProblems(bad, { code: "AZ-104", audience }).problems.join("\n"),
    /learn pick is on learn\.microsoft\.com/,
  );
  assert.match(
    decisionsProblems(d, { code: "AZ-900", audience }).problems.join("\n"),
    /for AZ-104, not AZ-900/,
  );
  const gone = setConcept(d, { key: "audience/x/y", text: "Y" }, []);
  assert.match(
    decisionsProblems(gone, { code: "AZ-104", audience }).warnings.join("\n"),
    /no longer a concept/,
  );
  const reworded = structuredClone(d);
  reworded.concepts[1].text = "Operating system";
  assert.match(
    decisionsProblems(reworded, { code: "AZ-104", audience }).warnings.join(
      "\n",
    ),
    /the guide now says "Operating systems"/,
  );
});

test("the audience of a course: the guide's words with the picks; no decision, no picks; decided to need none, an empty list", () => {
  const guideAudience = parseAudience(az104.lines);
  const [first, second] = audienceConcepts(guideAudience);
  let d = emptyDecisions("AZ-104");
  d = setConcept(d, first, [
    pickFromUrl({ url: "https://example.com/os", title: "OS", today: TODAY }),
  ]);
  d = setConcept(d, second, []);
  const audience = buildAudience(guideAudience, d);
  const concepts = eachConcept(audience);
  assert.equal(concepts.length, 9);
  assert.equal(concepts[0].picks.length, 1);
  assert.deepEqual(concepts[1].picks, []);
  assert.equal(concepts[2].picks, undefined);
  assert.equal(buildAudience(null, d), null);
  assert.deepEqual(audienceProblems(audience, { guideAudience }), {
    errors: [],
    warnings: [],
  });
  const changed = structuredClone(guideAudience);
  changed.lists[0].items.push("Storage");
  assert.match(
    audienceProblems(audience, { guideAudience: changed }).errors.join("\n"),
    /differs from the study guide's/,
  );
  assert.deepEqual(diffAudience(audience, changed), {
    added: ["Storage"],
    removed: [],
    changed: true,
  });
  assert.equal(diffAudience(audience, guideAudience).changed, false);
  assert.equal(diffAudience(null, guideAudience), null);
});

test("the options of a concept come from the search, as a short list, hands-on pages left out", () => {
  const { pools } = worldPools();
  const guide = {
    ...guideOf(TASKS),
    audience: {
      intro: [],
      lists: [
        {
          lead: "You should be familiar with",
          kind: "prerequisite",
          items: ["User-defined routes"],
        },
      ],
    },
  };
  const result = generateCandidates({
    code: "NET-100",
    guide,
    scope: scopeOf(),
    pools,
    options: { audienceOnly: true, audienceMax: 3 },
  });
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.foundations, []);
  assert.equal(result.audience.length, 1);
  const [concept] = result.audience;
  assert.equal(concept.text, "User-defined routes");
  assert.ok(concept.candidates.length > 0 && concept.candidates.length <= 3);
  assert.deepEqual(
    concept.candidates.map((c) => c.rank),
    concept.candidates.map((_, i) => i + 1),
  );
  const covered = concept.candidates.map((c) => c.coverage ?? 0);
  assert.deepEqual(
    covered,
    [...covered].sort((a, b) => b - a),
    "the best match first, whatever the source",
  );
  assert.equal(result.stats.audience.concepts, 1);
  const none = generateCandidates({
    code: "NET-100",
    guide,
    scope: scopeOf(),
    pools,
    options: { audience: false, audienceOnly: true },
  });
  assert.deepEqual(none.audience, []);
});

test("the options come in the order of the sheet: what a model named first, then the search", () => {
  const list = [
    { source: "P4", title: "a" },
    { source: "P5", title: "b" },
    { source: "P1", title: "c", alsoProposed: true },
    { source: "P2", title: "d" },
  ];
  assert.deepEqual(
    optionsInOrder(list).map((c) => c.title),
    ["b", "c", "a", "d"],
  );
});

test("the proposal prompt asks for a choice and says that other sites are added by hand", () => {
  const audience = parseAudience(az104.lines);
  const batches = audienceBatches({
    concepts: audienceConcepts(audience),
    audience,
    exam: { code: "AZ-104", name: "Microsoft Azure Administrator" },
  });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].tasks.length, 4);
  const prompt = audiencePrompt({
    ...batches[0],
    batchId: "az-104-audience-1",
  });
  assert.match(prompt, /You should be familiar with/);
  assert.match(prompt, /two to five pages/);
  assert.match(prompt, /A person adds resources from other sites by hand/);
  assert.match(prompt, /"batchId": "az-104-audience-1"/);
});

test("the sheet numbers the options, shows the decision and says when there is none", () => {
  const audience = parseAudience(az104.lines);
  const [first] = audienceConcepts(audience);
  const options = {
    concepts: [
      {
        key: first.key,
        candidates: [
          {
            source: "P4",
            title: "Search page",
            target: { kind: "docs", path: "/a/b" },
          },
          {
            source: "P5",
            title: "Named page",
            target: { kind: "module", path: "/training/modules/m" },
            proposal: { why: "A beginner overview." },
          },
        ],
      },
    ],
  };
  const decisions = setConcept(emptyDecisions("AZ-104"), first, [
    pickFromUrl({
      url: "https://www.netacad.com/courses/it-essentials",
      title: "IT Essentials",
      today: TODAY,
    }),
  ]);
  const sheet = renderSheet({ code: "AZ-104", audience, options, decisions });
  assert.match(sheet, /## 1\. Operating systems/);
  assert.match(
    sheet,
    /\*\*Decided:\*\* \[IT Essentials\]\(https:\/\/www\.netacad\.com\/courses\/it-essentials\) \(other site\)/,
  );
  assert.match(
    sheet,
    /1\. \[Named page\].*named by a model\): A beginner overview\./,
  );
  assert.match(sheet, /2\. \[Search page\].*found by search/);
  assert.match(
    sheet,
    /## 2\. Networking[\s\S]*\*\*Not decided yet\.\*\*[\s\S]*No options were proposed\./,
  );
});

// ---- the page
function courseWithAudience(decide) {
  const { course } = exampleCourse();
  const guideAudience = parseAudience(az104.lines);
  const concepts = audienceConcepts(guideAudience);
  let d = emptyDecisions("GH-900");
  for (const [i, picks] of Object.entries(decide(concepts)))
    d = setConcept(d, concepts[i], picks);
  course.audience = buildAudience(guideAudience, d);
  return course;
}

test("the page opens with the audience profile: a card per chosen resource, the other concepts as text", () => {
  const course = courseWithAudience(() => ({
    1: [
      pickFromUrl({
        url: "https://www.netacad.com/courses/networking-basics",
        title: "Networking Basics (Cisco Networking Academy)",
        today: TODAY,
      }),
    ],
    3: [
      pickFromUrl({
        url: "https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview",
        title: "Hyper-V on Windows Server",
        today: TODAY,
      }),
      pickFromUrl({
        url: "https://example.com/virtualization",
        title: "Another course",
        today: TODAY,
      }),
    ],
    2: [],
  }));
  const page = renderCourse(course);
  assert.ok(
    page.indexOf("## Audience profile") < page.indexOf("## Understand Git"),
  );
  assert.match(page, /### You should be familiar with\n\n<CardGrid>/);
  assert.match(
    page,
    /<LinkCard title="Networking" description="Networking Basics \(Cisco Networking Academy\)" href="https:\/\/www\.netacad\.com\/courses\/networking-basics" target="_blank"\/>/,
  );
  assert.match(
    page,
    /<LinkCard title="Virtualization" description="Hyper-V on Windows Server" href="https:\/\/learn\.microsoft\.com\/windows-server\/virtualization\/hyper-v\/overview\?WT\.mc_id=studentamb_165290" target="_blank"\/>/,
  );
  assert.match(
    page,
    /<LinkCard title="Virtualization" description="Another course" href="https:\/\/example\.com\/virtualization"/,
  );
  assert.match(page, /<\/CardGrid>\n\n- Operating systems\n- Servers\n/);
  assert.ok(
    !/- Networking\n/.test(page),
    "a concept with a card is not repeated as text",
  );
  assert.ok(
    !/- Servers[\s\S]*- Servers/.test(page),
    "a concept decided to need no resource is text, once",
  );
  assert.ok(
    !/no resource chosen yet/.test(page),
    "the published page has no review note",
  );
});

test("the review copy counts the concepts nobody has decided; a concept decided to need none is not counted", () => {
  const course = courseWithAudience(() => ({ 0: [] }));
  const review = renderCourse(course, { review: { picks: [] } });
  assert.match(
    review,
    /8 concepts have no resource chosen yet and are listed as text\. Choose one with node scripts\/course-audience\.mjs\./,
  );
});

test("a course without an audience renders as before, and the tree of the page is still the guide's", () => {
  const { course } = exampleCourse();
  assert.ok(!/Audience profile/.test(renderCourse(course)));
  const plain = treeFromCourseMdx(renderCourse(course));
  const withAudience = treeFromCourseMdx(
    renderCourse(courseWithAudience(() => ({ 1: [] }))),
  );
  assert.equal(diffTrees(plain, withAudience).identical, true);
});

// ---- the command line
function hub() {
  const base = mkdtempSync(join(tmpdir(), "course-audience-"));
  temps.push(base);
  mkdirSync(join(base, "hub", "src", "data_files"), { recursive: true });
  writeFileSync(
    join(base, "hub", "src", "data_files", "learn-exams.json"),
    JSON.stringify({ studyGuides: [az104] }),
  );
  return { hub: join(base, "hub"), tmp: join(base, "tmp") };
}
const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
  };
};
const run = async (w, args, extra = {}) => {
  const io = capture();
  const code = await main(args, {
    root: w.hub,
    tmp: w.tmp,
    env: {},
    log: io.log,
    error: io.error,
    ...extra,
  });
  return { code, ...io };
};

test("add, choose, none and clear write the decisions file; a concept is named by number, key or wording", async () => {
  const w = hub();
  const file = join(
    w.hub,
    "src",
    "data_files",
    "course-audience",
    "AZ-104.json",
  );
  const options = join(w.tmp, "options.json");
  mkdirSync(w.tmp, { recursive: true });
  const concepts = audienceConcepts(parseAudience(az104.lines));
  writeFileSync(
    options,
    JSON.stringify({
      concepts: [
        {
          key: concepts[3].key,
          candidates: [
            {
              source: "P4",
              title: "Search page",
              target: { kind: "docs", path: "/a/b" },
            },
            {
              source: "P5",
              title: "Named page",
              target: { kind: "module", path: "/training/modules/hyper-v" },
            },
          ],
        },
      ],
    }),
  );
  const common = ["--today", TODAY];
  let r = await run(w, [
    "add",
    "az-104",
    "Networking",
    "--url",
    "https://www.netacad.com/courses/networking-basics",
    "--title",
    "Networking Basics",
    ...common,
  ]);
  assert.equal(r.code, 0, r.err.join("\n"));
  const saved = () => JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved().concepts[0].picks[0].kind, "external");
  // a second page for the same concept is added, the same address twice is refused
  r = await run(w, [
    "add",
    "AZ-104",
    "2",
    "--url",
    "https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-overview",
    "--title",
    "Virtual networks",
    ...common,
  ]);
  assert.equal(r.code, 0);
  assert.equal(saved().concepts[0].picks.length, 2);
  r = await run(w, [
    "add",
    "AZ-104",
    "Networking",
    "--url",
    "https://www.netacad.com/courses/networking-basics",
    "--title",
    "Again",
    ...common,
  ]);
  assert.equal(r.code, 2);
  assert.match(r.err.join("\n"), /already chosen/);
  // choose takes the options in the order of the sheet: the model's page is number 1
  r = await run(w, [
    "choose",
    "AZ-104",
    "4",
    "1",
    "--options",
    options,
    ...common,
  ]);
  assert.equal(r.code, 0, r.err.join("\n"));
  const virtualization = saved().concepts.find(
    (c) => c.key === concepts[3].key,
  );
  assert.equal(virtualization.picks[0].path, "/training/modules/hyper-v");
  assert.equal(virtualization.picks[0].source, "option");
  r = await run(w, [
    "choose",
    "AZ-104",
    "4",
    "7",
    "--options",
    options,
    ...common,
  ]);
  assert.equal(r.code, 2);
  assert.match(r.err.join("\n"), /no option number 7/);
  r = await run(w, ["none", "AZ-104", "PowerShell", ...common]);
  assert.equal(r.code, 0);
  assert.deepEqual(
    saved().concepts.find((c) => c.text === "PowerShell").picks,
    [],
  );
  r = await run(w, ["clear", "AZ-104", "PowerShell"]);
  assert.equal(
    saved().concepts.some((c) => c.text === "PowerShell"),
    false,
  );
  r = await run(w, ["status", "AZ-104"]);
  assert.match(
    r.out.join("\n"),
    /2\. Networking: Networking Basics <https:\/\/www\.netacad\.com[^>]*> \(other site\); Virtual networks/,
  );
  assert.match(r.out.join("\n"), /9\. Microsoft Entra ID: not decided/);
  // a concept that matches several is not guessed
  r = await run(w, ["none", "AZ-104", "Azure", ...common]);
  assert.equal(r.code, 2);
  assert.match(r.err.join("\n"), /matches several concepts/);
  r = await run(w, ["none", "AZ-104", "99"]);
  assert.match(r.err.join("\n"), /no concept number 99/);
});

test("an invalid decisions file stops the commands with exit code 1, and the sheet works without options", async () => {
  const w = hub();
  const dir = join(w.hub, "src", "data_files", "course-audience");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "AZ-104.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "audience-decisions",
      code: "AZ-104",
      concepts: [
        {
          key: "audience/a/b",
          text: "B",
          picks: [
            {
              title: "x",
              href: "http://nope",
              kind: "external",
              source: "maintainer",
              decidedAt: TODAY,
            },
          ],
        },
      ],
    }),
  );
  let r = await run(w, ["status", "AZ-104"]);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /is not an https address/);
  rmSync(join(dir, "AZ-104.json"));
  r = await run(w, ["sheet", "AZ-104"]);
  assert.equal(r.code, 0);
  assert.match(r.out.join("\n"), /## 1\. Operating systems/);
  assert.match(r.err.join("\n"), /No options file/);
});

test("prepare writes one prompt per list, and merge refuses to run without answers", async () => {
  const w = hub();
  const r = await run(w, ["prepare", "AZ-104"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  const dir = join(w.tmp, "course-propose");
  const prompt = readFileSync(
    join(dir, "AZ-104.audience-01.propose.md"),
    "utf8",
  );
  assert.match(prompt, /Operating systems/);
  const batch = JSON.parse(
    readFileSync(join(dir, "AZ-104.audience-02.propose-batch.json"), "utf8"),
  );
  assert.equal(batch.tasks.length, 5);
  const m = await run(w, [
    "merge",
    "AZ-104",
    "--options",
    join(w.tmp, "none.json"),
  ]);
  assert.equal(m.code, 2);
  assert.match(m.err.join("\n"), /No AZ-104\.audience-\*\.proposals\.json/);
});

test("usage errors: no command, no code, an unknown option, a guide without an audience profile", async () => {
  const w = hub();
  assert.equal((await run(w, [])).code, 2);
  assert.equal((await run(w, ["status"])).code, 2);
  assert.equal((await run(w, ["status", "AZ-104", "--nope"])).code, 2);
  assert.equal((await run(w, ["status", "AZ-999"])).code, 2);
});
