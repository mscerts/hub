import assert from "node:assert/strict";
import test from "node:test";
import { RELATIONS } from "../../scripts/lib/course-format.mjs";
import {
  CONFIDENCE,
  DEFAULT_BATCH_CANDIDATES,
  FLAGS,
  STANCES,
  VERDICTS,
  buildBatches,
  buildSkepticBatch,
  estimateTokens,
  evidenceOf,
  findQuote,
  judgePrompt,
  mergeJudged,
  normalizeText,
  quoteTermCoverage,
  rubricText,
  skepticPrompt,
  splitTasks,
  validateJudgments,
  validateSkeptic,
} from "../../scripts/lib/course-judge.mjs";
import {
  EXAM,
  batches,
  candidatesFile,
  judgmentsFor,
  skepticFor,
} from "./helpers/example-judging.mjs";

const one = () => batches().batches[0];
const label = (task, target) => `${task} | ${target}`;
const findCandidate = (batch, source, kind) => {
  for (const task of batch.tasks) {
    const c = task.candidates.find(
      (x) => x.source === source && (!kind || x.target.kind === kind),
    );
    if (c) return { task, c };
  }
  throw new Error(`no ${source} ${kind} candidate`);
};

test("quotes are compared by words: case, quote marks, dashes and spacing do not matter", () => {
  assert.equal(
    normalizeText("  User-defined   ROUTES — Microsoft’s “guide” "),
    "user defined routes microsofts guide",
  );
  const evidence = [
    { where: "unit title", text: "Create custom user-defined routes" },
    { where: "module title", text: "Manage traffic flow" },
  ];
  assert.deepEqual(findQuote("custom USER defined routes", evidence), {
    verified: true,
    where: "unit title",
  });
  assert.equal(findQuote("traffic flow", evidence).where, "module title");
  assert.equal(findQuote("custom user-defined", evidence).verified, true);
  assert.equal(
    findQuote("custom user defin", evidence).verified,
    false,
    "whole words only",
  );
  assert.equal(
    findQuote("routes custom", evidence).verified,
    false,
    "the order of the words counts",
  );
  assert.equal(findQuote("", evidence).verified, false);
  assert.equal(findQuote("something else", evidence).verified, false);
  assert.equal(
    findQuote("routes", evidence).verified,
    false,
    "one word of a longer snippet is not a quote",
  );
  assert.equal(
    findQuote("Subnets", [{ where: "unit title", text: "Subnets" }]).verified,
    true,
    "a whole one-word snippet is",
  );
  assert.equal(findQuote("x y", undefined).verified, false);
});

test("how much of the task's wording a quote carries, an abbreviation counting for its long form", () => {
  assert.equal(
    quoteTermCoverage(
      "Configure user-defined routes",
      "Create user-defined routes",
    ),
    1,
  );
  const part = quoteTermCoverage(
    "Configure virtual network peering",
    "Peering virtual networks",
  );
  assert.equal(part, 1, "stems match: networks is network");
  assert.ok(
    quoteTermCoverage("Manage external users", "Manage your users") < 1,
  );
  assert.equal(
    quoteTermCoverage("Use RBAC", "Azure role-based access control"),
    1,
    "the abbreviation in the task, the long form in the quote",
  );
  assert.equal(
    quoteTermCoverage("Use role-based access control", "Azure RBAC"),
    1,
    "the long form in the task, the abbreviation in the quote",
  );
  assert.ok(
    quoteTermCoverage(
      "Assign roles with RBAC",
      "Azure role-based access control",
    ) < 1,
    "assign is not in the quote",
  );
  assert.equal(
    quoteTermCoverage("Manage external users", "Something unrelated"),
    0,
  );
  assert.equal(
    quoteTermCoverage("Configure", "anything"),
    1,
    "no distinctive term to miss",
  );
});

test("the evidence of a candidate is the text a judge may quote: titles, units, descriptions, link texts", () => {
  const { batches: bs, pools, candidates } = batches();
  const task = candidates.tasks[0];
  const find = (kind, source) =>
    task.candidates.find((c) => c.target.kind === kind && c.source === source);
  const module = evidenceOf(find("module", "P1"), pools);
  assert.deepEqual(module.slice(0, 2), [
    {
      where: "module title",
      text: "Manage and control traffic flow with routes",
    },
    { where: "unit title", text: "Introduction" },
  ]);
  assert.ok(
    module.some(
      (e) => e.where === "products" && /Virtual Network/.test(e.text),
    ),
  );
  const unit = evidenceOf(find("unit", "P1"), pools);
  assert.equal(unit[0].where, "unit title");
  assert.equal(unit[1].where, "module title");
  assert.ok(unit.some((e) => e.where === "unit of the same module"));
  assert.ok(
    !unit.some(
      (e) => e.where === "unit of the same module" && e.text === unit[0].text,
    ),
    "the unit itself is not listed twice",
  );
  const docs = evidenceOf(find("docs", "P2"), pools);
  assert.equal(docs[0].where, "page title");
  assert.ok(docs.some((e) => e.where === "page description"));
  assert.ok(
    docs.some((e) => e.where === "link text of a module that lists the page"),
  );
  assert.deepEqual(
    evidenceOf(
      { target: { kind: "module", path: "/training/modules/nope" } },
      pools,
    ),
    [],
  );
  assert.ok(bs.length > 0);
});

test("one batch per skill group: the group's tasks, every candidate with its evidence and where it came from", () => {
  const { batches: bs, candidates } = batches();
  assert.equal(bs.length, 1, "the invented guide has one skill group");
  const batch = bs[0];
  assert.equal(batch.kind, "judge");
  assert.equal(batch.batchId, "networking/configure");
  assert.deepEqual(batch.exam, {
    code: "NET-100",
    name: "Network Administrator",
  });
  assert.equal(batch.inputs.guideHash, "guide-hash");
  assert.match(batch.inputs.scopeFingerprint, /^[0-9a-f]{40}$/);
  assert.deepEqual(batch.group, {
    domain: "Networking",
    title: "Configure virtual networks",
    tasks: ["Configure user-defined routes", "Manage external users"],
  });
  assert.equal(batch.tasks.length, 2);
  const routes = batch.tasks[0];
  assert.equal(routes.candidates.length, candidates.tasks[0].candidates.length);
  assert.ok(
    routes.anchor.includes("Manage and control traffic flow with routes"),
  );
  for (const c of routes.candidates) {
    assert.ok(c.evidence.length > 0, c.target.path);
    assert.ok(["P1", "P2", "P3", "P4"].includes(c.source));
    assert.equal(typeof c.coverage, "number");
  }
  const p2 = routes.candidates.find((c) => c.source === "P2");
  assert.deepEqual(p2.via, {
    path: "/training/modules/manage-traffic-routes",
    title: "Manage and control traffic flow with routes",
  });
  const recommended = routes.candidates.find((c) => c.signals.recommendedBy);
  assert.deepEqual(recommended.signals.recommendedBy, [
    "Configure virtual network peering",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), batch, "plain data");
});

test("the judge's prompt carries the rubric, the answer format and the batch itself", () => {
  const batch = one();
  const prompt = judgePrompt(batch);
  assert.match(prompt, /Exam: \*\*NET-100: Network Administrator\*\*/);
  assert.match(
    prompt,
    /Skill group: \*\*Networking > Configure virtual networks\*\*/,
  );
  for (const verdict of VERDICTS)
    assert.ok(prompt.includes(`\`${verdict}\``), verdict);
  for (const [key, r] of Object.entries(RELATIONS)) {
    assert.ok(prompt.includes(`\`${key}\``), key);
    assert.ok(
      prompt.includes(r.meaning),
      `the meaning of ${key} comes from the course format`,
    );
  }
  for (const [key, meaning] of Object.entries(FLAGS)) {
    assert.ok(prompt.includes(`\`${key}\``), key);
    assert.ok(prompt.includes(meaning));
  }
  assert.match(prompt, /entitlement management/, "the model rejection");
  assert.match(prompt, /out of scope/i);
  assert.match(prompt, /exactly/, "the quote rule");
  const json = prompt.match(/## The batch\n\n```json\n([\s\S]*?)\n```/)[1];
  assert.deepEqual(JSON.parse(json), batch);
  assert.ok(prompt.includes('"kind": "judgments"'));
  assert.ok(estimateTokens(prompt) > estimateTokens(JSON.stringify(batch)) / 2);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(rubricText(), rubricText());
});

const count = (batch) =>
  batch.tasks.reduce((n, t) => n + t.candidates.length, 0);
const idsOf = (list) =>
  list.flatMap((b) =>
    b.tasks.flatMap((t) =>
      t.candidates.map((c) => label(t.key, c.target.path)),
    ),
  );

test("a skill group with more candidates than a session should get is cut into parts, and nothing is left out", () => {
  const { candidates, pools } = candidatesFile();
  const whole = buildBatches({
    candidates,
    pools,
    exam: EXAM,
    maxCandidates: Infinity,
  });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].part, undefined);
  assert.equal(whole[0].batchId, "networking/configure");
  const total = count(whole[0]);
  assert.ok(total > 6, "the invented group has enough candidates to cut");

  const parts = buildBatches({
    candidates,
    pools,
    exam: EXAM,
    maxCandidates: 6,
  });
  assert.equal(parts.length, Math.ceil(total / 6));
  parts.forEach((b, n) => {
    assert.equal(b.batchId, `networking/configure#${n + 1}`);
    assert.deepEqual(b.part, { n: n + 1, of: parts.length });
    assert.ok(count(b) <= 6, `part ${n + 1} holds ${count(b)}`);
    assert.deepEqual(
      b.group,
      whole[0].group,
      "every part knows the whole group",
    );
    assert.deepEqual(b.inputs, whole[0].inputs);
  });
  // every candidate of every task, once, in the same order
  assert.deepEqual(idsOf(parts), idsOf(whole));
  // a part is a batch like any other: it validates on its own, and a made-up quote is still caught
  for (const b of parts) {
    const v = validateJudgments(b, judgmentsFor(b));
    assert.deepEqual(v.errors, []);
    assert.equal(v.items.size, count(b));
  }
  const first = parts[0];
  assert.match(
    validateJudgments(first, {
      ...judgmentsFor(parts[1]),
    }).errors.join("\n"),
    /batchId .* is not the batch's/,
  );
});

test("splitTasks fills a part before it starts the next, continues a task across parts and never splits a small group", () => {
  const task = (key, n) => ({
    key,
    candidates: Array.from({ length: n }, (_, i) => `${key}${i}`),
  });
  const tasks = [task("a", 3), task("b", 4), task("c", 0), task("d", 2)];
  const parts = splitTasks(tasks, 4);
  assert.deepEqual(
    parts.map((p) => p.map((x) => `${x.task.key}:${x.candidates.join("")}`)),
    [["a:a0a1a2", "b:b0"], ["b:b1b2b3", "d:d0"], ["d:d1"]],
  );
  assert.equal(splitTasks(tasks, 9).length, 1, "9 candidates fit exactly");
  assert.equal(splitTasks(tasks, 100).length, 1);
  assert.equal(splitTasks(tasks, Infinity).length, 1);
  assert.deepEqual(splitTasks([task("e", 0)], 3), [
    [{ task: { key: "e", candidates: [] }, candidates: [] }],
  ]);
  assert.equal(DEFAULT_BATCH_CANDIDATES, 150);
});

test("the prompt of a part says so, and the batch is written compactly", () => {
  const { candidates, pools } = candidatesFile();
  const [first, second] = buildBatches({
    candidates,
    pools,
    exam: EXAM,
    maxCandidates: 6,
  });
  const prompt = judgePrompt(second);
  assert.match(
    prompt,
    /This is part 2 of \d+ of the group: the other parts hold the other candidates of the same tasks/,
  );
  assert.ok(
    !/This is part/.test(judgePrompt(one())),
    "a group in one piece says nothing",
  );
  const json = prompt.match(/## The batch\n\n```json\n([\s\S]*?)\n```/)[1];
  assert.equal(json.includes("\n"), false, "one line, no indentation");
  assert.deepEqual(JSON.parse(json), second);
  assert.equal(first.part.n, 1);
});

test("the rubric tells the judge to say when it is not sure instead of dismissing the page, and that a task has no limit of pages", () => {
  const rubric = rubricText();
  assert.match(
    rubric,
    /When you are not sure, say so; never dismiss a page to be safe/,
  );
  assert.match(rubric, /set `confidence` to `low`/);
  assert.match(
    rubric,
    /the maintainer, who is the final judge of every page you are unsure about/,
  );
  assert.match(rubric, /a reject with `high` or `medium` confidence is final/);
  assert.match(rubric, /There is no limit to how many pages a task may have/);
  // the old advice pushed doubtful pages down into rejects
  assert.ok(!/take the lower one/.test(rubric));
  assert.ok(!/anything you cannot place/.test(rubric));
  // the rules are numbered without a gap or a repeat
  const numbers = [...rubric.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => i + 1),
  );
});

test("a valid answer passes: every candidate judged once, picks quoted from the evidence", () => {
  const batch = one();
  const v = validateJudgments(batch, judgmentsFor(batch));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unverified, []);
  const total = batch.tasks.reduce((n, t) => n + t.candidates.length, 0);
  assert.equal(v.items.size, total);
  assert.equal(v.judgedBy, "test judge");
  const { task, c } = findCandidate(batch, "P1", "module");
  const item = v.items.get(label(task.key, c.target.path));
  assert.equal(item.quote.verified, true);
  assert.equal(item.quote.where, "module title");
  assert.equal(typeof item.quote.termCoverage, "number");
});

test("an answer is sent back for each way it can be wrong", () => {
  const batch = one();
  const bad = (edit) => validateJudgments(batch, judgmentsFor(batch, edit));
  const first = (v) => v.errors[0];

  assert.match(validateJudgments(batch, null).errors[0], /not a JSON object/);
  const wrongFile = judgmentsFor(batch);
  Object.assign(wrongFile, { schemaVersion: 2, kind: "x", batchId: "other" });
  const wrong = validateJudgments(batch, wrongFile).errors.join("\n");
  assert.match(wrong, /schemaVersion must be 1/);
  assert.match(wrong, /kind must be "judgments"/);
  assert.match(
    wrong,
    /batchId "other" is not the batch's "networking\/configure"/,
  );
  assert.match(
    validateJudgments(batch, {
      ...judgmentsFor(batch),
      judgments: "no",
    }).errors.join(),
    /judgments must be a list/,
  );

  let dropped = false;
  const missing = bad((j) => (dropped ? j : ((dropped = true), null)));
  assert.match(first(missing), /not judged$/);

  const twice = validateJudgments(batch, {
    ...judgmentsFor(batch),
    judgments: [
      ...judgmentsFor(batch).judgments,
      judgmentsFor(batch).judgments[0],
    ],
  });
  assert.match(twice.errors.join("\n"), /judged twice/);

  const unknown = validateJudgments(batch, {
    ...judgmentsFor(batch),
    judgments: [
      ...judgmentsFor(batch).judgments,
      { task: "nope", target: "/x" },
      { task: batch.tasks[0].key, target: "/training/modules/nope" },
      "text",
    ],
  });
  const text = unknown.errors.join("\n");
  assert.match(text, /the task "nope" is not in the batch/);
  assert.match(text, /not a candidate of that task/);
  assert.match(text, /not an object/);

  assert.match(
    first(bad((j) => ({ ...j, verdict: "maybe" }))),
    /verdict must be one of core, supporting, reject/,
  );
  assert.match(
    bad((j) =>
      j.verdict === "supporting" ? { ...j, relation: undefined } : j,
    ).errors.join("\n"),
    /a supporting pick needs a relation/,
  );
  assert.match(
    bad((j) =>
      j.verdict === "supporting" ? { ...j, relation: "friend" } : j,
    ).errors.join("\n"),
    /a supporting pick needs a relation/,
  );
  assert.match(
    bad((j) =>
      j.verdict === "core" ? { ...j, relation: "operate" } : j,
    ).errors.join("\n"),
    /only a supporting pick has a relation/,
  );
  assert.match(first(bad((j) => ({ ...j, why: " " }))), /why is required/);
  assert.match(
    first(bad((j) => ({ ...j, why: "x".repeat(301) }))),
    /why is longer than 300/,
  );
  assert.match(
    first(bad((j) => ({ ...j, flags: ["spicy"] }))),
    /flags must be a list of/,
  );
  assert.match(
    first(bad((j) => ({ ...j, flags: "preview" }))),
    /flags must be a list of/,
  );
  assert.match(
    first(bad((j) => ({ ...j, confidence: "sure" }))),
    /confidence must be one of high, medium, low/,
  );
  assert.match(
    bad((j) =>
      j.verdict === "core" ? { ...j, quote: undefined } : j,
    ).errors.join("\n"),
    /a pick needs a quote/,
  );
  assert.match(first(bad((j) => ({ ...j, quote: "  " }))), /quote is empty/);
  assert.match(
    first(bad((j) => ({ ...j, quote: "word ".repeat(50) }))),
    /quote is longer than 200/,
  );
});

test("a quote that is not in the evidence is not an error but is listed, and the entry is still kept", () => {
  const batch = one();
  const { task, c } = findCandidate(batch, "P1", "module");
  const v = validateJudgments(
    batch,
    judgmentsFor(batch, (j) =>
      j.target === c.target.path && j.task === task.key
        ? { ...j, quote: "an invented sentence" }
        : j,
    ),
  );
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unverified, [
    { task: task.key, target: c.target.path, quote: "an invented sentence" },
  ]);
  assert.equal(
    v.items.get(label(task.key, c.target.path)).quote.verified,
    false,
  );
});

test("a rejection needs no quote, but one it gives is checked", () => {
  const batch = one();
  const { task, c } = findCandidate(batch, "P4", "docs");
  const none = validateJudgments(batch, judgmentsFor(batch));
  assert.deepEqual(none.errors, []);
  assert.equal(none.items.get(label(task.key, c.target.path)).quote, null);
  const checked = validateJudgments(
    batch,
    judgmentsFor(batch, (j) =>
      j.target === c.target.path && j.task === task.key
        ? { ...j, quote: "not in the evidence at all" }
        : j,
    ),
  );
  assert.deepEqual(checked.errors, []);
  assert.equal(
    checked.unverified.length,
    0,
    "a reject's quote is no reason to send it back",
  );
  assert.equal(
    checked.items.get(label(task.key, c.target.path)).quote.verified,
    false,
  );
});

test("the skeptic gets the picks only, each with the judge's claim", () => {
  const batch = one();
  const v = validateJudgments(batch, judgmentsFor(batch));
  const sk = buildSkepticBatch(batch, v);
  assert.equal(sk.kind, "skeptic-batch");
  assert.equal(sk.batchId, batch.batchId);
  const picks = [...v.items.values()].filter(
    (i) => i.judgment.verdict !== "reject",
  ).length;
  assert.equal(
    sk.tasks.reduce((n, t) => n + t.candidates.length, 0),
    picks,
  );
  for (const t of sk.tasks)
    for (const c of t.candidates) {
      assert.ok(["core", "supporting"].includes(c.judge.verdict));
      assert.ok(c.judge.why && c.judge.quote);
      assert.ok(c.evidence.length > 0, "the skeptic sees the same evidence");
    }
  const none = buildSkepticBatch(
    batch,
    validateJudgments(
      batch,
      judgmentsFor(batch, (j) => ({
        ...j,
        verdict: "reject",
        relation: undefined,
      })),
    ),
  );
  assert.deepEqual(none.tasks, []);
  const prompt = skepticPrompt(sk);
  assert.match(prompt, /skeptic/);
  for (const stance of Object.keys(STANCES))
    assert.ok(prompt.includes(`\`${stance}\``), stance);
  assert.ok(prompt.includes('"kind": "skeptic"'));
  assert.deepEqual(
    JSON.parse(prompt.match(/## The batch\n\n```json\n([\s\S]*?)\n```/)[1]),
    sk,
  );
});

test("the skeptic's answer is checked like the judge's", () => {
  const batch = one();
  const v = validateJudgments(batch, judgmentsFor(batch));
  const sk = buildSkepticBatch(batch, v);
  const ok = validateSkeptic(sk, skepticFor(sk));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.unverified, []);
  assert.equal(ok.judgedBy, "test skeptic");
  const bad = (edit) => validateSkeptic(sk, skepticFor(sk, edit));
  const core = (_, c) => c.judge.verdict === "core";
  const supporting = (_, c) => c.judge.verdict === "supporting";

  assert.match(
    bad((a) => ({ ...a, stance: "shrug" })).errors[0],
    /stance must be one of uphold, downgrade, refute/,
  );
  assert.match(
    bad((a, c) => (core(a, c) ? { ...a, stance: "downgrade" } : a)).errors.join(
      "\n",
    ),
    /a downgrade needs a relation/,
  );
  assert.deepEqual(
    bad((a, c) =>
      core(a, c) ? { ...a, stance: "downgrade", relation: "operate" } : a,
    ).errors,
    [],
  );
  assert.match(
    bad((a, c) =>
      supporting(a, c) ? { ...a, stance: "downgrade", relation: "operate" } : a,
    ).errors.join("\n"),
    /only a core pick can be downgraded/,
  );
  assert.match(
    bad((a) => ({ ...a, relation: "operate" })).errors.join("\n"),
    /only a downgrade has a relation/,
  );
  assert.match(
    bad((a) => ({ ...a, reason: "" })).errors[0],
    /reason is required/,
  );
  assert.match(
    bad((a) => ({ ...a, flags: ["x"] })).errors[0],
    /flags must be a list/,
  );
  let first = true;
  assert.match(
    bad((a) => (first ? ((first = false), null) : a)).errors[0],
    /not answered$/,
  );
  assert.match(
    validateSkeptic(sk, {
      ...skepticFor(sk),
      answers: [
        ...skepticFor(sk).answers,
        {
          task: sk.tasks[0].key,
          target: "/training/modules/nope",
          stance: "uphold",
          reason: "x",
        },
      ],
    }).errors.join("\n"),
    /not a pick of that task/,
  );
  const withQuote = bad((a, c) => ({ ...a, quote: c.evidence[0].text }));
  assert.deepEqual(withQuote.errors, []);
  assert.equal([...withQuote.items.values()][0].quote.verified, true);
  const invented = bad((a) => ({ ...a, quote: "nothing like it" }));
  assert.equal(invented.unverified.length, ok.items.size);
  assert.match(validateSkeptic(sk, null).errors[0], /not a JSON object/);
  assert.match(
    validateSkeptic(sk, {
      ...skepticFor(sk),
      batchId: "x",
      kind: "y",
      schemaVersion: 0,
    }).errors.join("\n"),
    /batchId.*\n?.*|kind must be "skeptic"/,
  );
});

test("merging keeps every candidate with both answers, whether they agree, and the union of the flags", () => {
  const batch = one();
  const v = validateJudgments(
    batch,
    judgmentsFor(batch, (j) =>
      j.verdict === "core" ? { ...j, flags: ["preview"] } : j,
    ),
  );
  const sk = buildSkepticBatch(batch, v);
  const picks = sk.tasks.flatMap((t) => t.candidates.map((c) => [t.key, c]));
  const downgraded = picks.find(([, c]) => c.judge.verdict === "core");
  const refuted = picks.find(([, c]) => c.judge.verdict === "supporting");
  const skeptic = validateSkeptic(
    sk,
    skepticFor(sk, (a, c, task) => {
      if (
        task.key === downgraded[0] &&
        c.target.path === downgraded[1].target.path
      )
        return {
          ...a,
          stance: "downgrade",
          relation: "operate",
          flags: ["outdated"],
        };
      if (task.key === refuted[0] && c.target.path === refuted[1].target.path)
        return { ...a, stance: "refute", reason: "Another product area." };
      return a;
    }),
  );
  const merged = mergeJudged(batch, v, skeptic);
  assert.equal(merged.kind, "judged");
  assert.equal(merged.judgedBy, "test judge");
  assert.equal(merged.skepticBy, "test skeptic");
  const items = merged.tasks.flatMap((t) => t.items);
  assert.equal(
    items.length,
    batch.tasks.reduce((n, t) => n + t.candidates.length, 0),
  );
  for (const item of items)
    assert.equal(item.evidence, undefined, "the evidence stays in the batch");

  const find = (key, c) =>
    merged.tasks
      .find((t) => t.key === key)
      .items.find((i) => i.target.path === c.target.path);
  const d = find(...downgraded);
  assert.equal(d.agreement, "disagree");
  assert.equal(d.disagreement, "downgrade");
  assert.deepEqual(d.flags, ["outdated", "preview"]);
  assert.equal(d.skeptic.relation, "operate");
  assert.equal(d.judge.verdict, "core");
  assert.equal(d.judge.quoteVerified, true);
  assert.equal(typeof d.judge.quoteTermCoverage, "number");
  const r = find(...refuted);
  assert.equal(r.agreement, "disagree");
  assert.equal(r.disagreement, "refute");
  const agreed = items.find((i) => i.agreement === "agree");
  assert.ok(agreed);
  const rejected = items.find((i) => i.judge.verdict === "reject");
  assert.equal(rejected.agreement, "unchallenged");
  assert.equal(rejected.skeptic, undefined);
  assert.equal(rejected.judge.quote, undefined);

  const s = merged.stats;
  assert.equal(s.candidates, items.length);
  assert.equal(s.core + s.supporting + s.reject, s.candidates);
  assert.equal(s.agree + s.disagree, s.core + s.supporting);
  assert.ok(s.disagree >= 2);
  assert.equal(s.unverifiedQuotes, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), merged);
});

test("without a skeptic every pick is unchallenged, and a quote that was kept without being verified is marked and counted", () => {
  const batch = one();
  const { task, c } = findCandidate(batch, "P1", "unit");
  const v = validateJudgments(
    batch,
    judgmentsFor(batch, (j) =>
      j.task === task.key && j.target === c.target.path
        ? { ...j, quote: "made up words" }
        : j,
    ),
  );
  const merged = mergeJudged(batch, v, null);
  assert.equal(merged.skepticBy, null);
  assert.ok(
    merged.tasks
      .flatMap((t) => t.items)
      .every((i) => i.agreement === "unchallenged"),
  );
  assert.equal(merged.stats.unverifiedQuotes, 1);
  const item = merged.tasks
    .find((t) => t.key === task.key)
    .items.find((i) => i.target.path === c.target.path);
  assert.equal(item.judge.quoteVerified, false);
  assert.equal(item.judge.quoteWhere, undefined);
});

test("constants are the ones the docs and the prompts name", () => {
  assert.deepEqual([...VERDICTS], ["core", "supporting", "reject"]);
  assert.deepEqual([...CONFIDENCE], ["high", "medium", "low"]);
  assert.deepEqual(Object.keys(STANCES), ["uphold", "downgrade", "refute"]);
  assert.ok(Object.keys(FLAGS).includes("other-sub-product"));
  const { candidates, pools } = candidatesFile();
  assert.equal(
    buildBatches({
      candidates,
      pools,
      exam: { code: "NET-100", name: null },
    })[0].exam.name,
    null,
  );
});
