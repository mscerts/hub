/**
 * The judging protocol (docs/course-judging.md): what an AI judge is asked for every candidate of a skill group,
 * what it must answer, and the mechanical checks on its answer. Pure: no I/O, no network, no AI. The command
 * line is scripts/course-judge.mjs.
 *
 *   batch        the candidates of one skill group with the text a judge may quote (the evidence)
 *   judgments    the judge's answer: per candidate a verdict (core, supporting, reject), a reason and, for a pick,
 *                a quote from the evidence. The quote is checked by a script: it must really be there.
 *   judged       the answer merged with the batch: what the approval gates read
 *
 * The AI is not part of this code. A person or an agent session gives the prompt of a batch to a model and saves
 * its JSON answer; this module builds the prompts and validates, verifies and merges the answers.
 */

import { RELATIONS } from "./course-format.mjs";
import { contentStems, queryTerms } from "./course-lexical.mjs";

export const JUDGE_SCHEMA_VERSION = 1;

/** The judge's verdicts: the two classes of a course pick, and rejection. */
export const VERDICTS = Object.freeze(["core", "supporting", "reject"]);

/** What a judge may flag about a candidate; the gates mark a pick with an out-of-scope flag (other-role, other-sub-product, licensing-tier) for review and keep the others as warnings. */
export const FLAGS = Object.freeze({
  "other-role": "written for a different job role than the exam's",
  "other-sub-product":
    "another product area or sub-product than the task's (identity governance beside external identities)",
  "licensing-tier":
    "needs a licence or tier that is outside what the exam covers",
  "level-mismatch":
    "much more advanced, or much more basic, than the exam's level",
  preview: "is about a feature in preview",
  outdated:
    "retired, renamed or probably out of date (an old product name, a retirement notice)",
});

export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);

const MAX_QUOTE_CHARS = 200;
const MAX_WHY_CHARS = 300;
const MAX_EVIDENCE_UNITS = 30;
const MAX_LINK_TEXTS = 5;

const present = (value) => typeof value === "string" && value.trim() !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Text for comparing a quote with the evidence: case, quote marks, dashes and spacing do not matter. */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Is the quote in the evidence? `evidence` is a list of { where, text }. The quote must be whole words of one
 * snippet, and at least two words unless it is a whole one-word snippet. Returns { verified, where }.
 */
export function findQuote(quote, evidence) {
  const wanted = normalizeText(quote);
  if (wanted === "") return { verified: false, where: null };
  for (const snippet of evidence ?? []) {
    const text = normalizeText(snippet.text);
    if (text === wanted) return { verified: true, where: snippet.where };
    if (wanted.includes(" ") && ` ${text} `.includes(` ${wanted} `))
      return { verified: true, where: snippet.where };
  }
  return { verified: false, where: null };
}

/**
 * How much of a task's own wording a quote carries: the share of its distinctive terms the quote contains
 * (an abbreviation counts for its long form). The gates read it: a quote that says nothing of the task is
 * no evidence for it.
 */
export function quoteTermCoverage(taskText, quote) {
  const terms = queryTerms(taskText).terms.filter(
    (t) => !t.context && !t.generic,
  );
  if (terms.length === 0) return 1;
  const stems = new Set(contentStems(quote));
  const matched = new Set(
    terms.filter((t) => stems.has(t.term)).map((t) => t.term),
  );
  for (const t of terms)
    if (t.role === "concept" && matched.has(t.term))
      for (const part of terms)
        if (part.group === t.group) matched.add(part.term);
  return (
    Math.round(
      (terms.filter((t) => matched.has(t.term)).length / terms.length) * 100,
    ) / 100
  );
}

/** The text a judge may quote for a candidate: [{ where, text }]. */
export function evidenceOf(candidate, pools) {
  const out = [];
  const { kind, path } = candidate.target;
  if (kind === "module") {
    const m = pools.modules.get(path);
    if (m) {
      out.push({ where: "module title", text: m.title });
      m.units
        .slice(0, MAX_EVIDENCE_UNITS)
        .forEach((unit) => out.push({ where: "unit title", text: unit }));
      if (m.products.length)
        out.push({ where: "products", text: m.products.join(", ") });
    }
  } else if (kind === "unit") {
    const u = pools.units.get(path);
    const m = u && pools.modules.get(u.module);
    if (u) out.push({ where: "unit title", text: u.title });
    if (m) {
      out.push({ where: "module title", text: m.title });
      m.units
        .filter((unit) => unit !== u.title)
        .slice(0, 12)
        .forEach((unit) =>
          out.push({ where: "unit of the same module", text: unit }),
        );
    }
  } else if (kind === "docs") {
    const d = pools.docMeta.get(path);
    if (d) {
      out.push({ where: "page title", text: d.title });
      if (d.description)
        out.push({ where: "page description", text: d.description });
    }
    for (const text of [...(pools.linkTexts?.get(path) ?? [])].slice(
      0,
      MAX_LINK_TEXTS,
    ))
      out.push({ where: "link text of a module that lists the page", text });
  }
  return out.filter((e) => present(e.text));
}

const moduleCard = (pools, path) => {
  const m = pools.modules.get(path);
  return m ? { path, title: m.title } : { path, title: path };
};

/**
 * One batch per skill group of a candidates file (course-candidates.mjs). `exam` is { code, name }.
 * Returns [{ schemaVersion, kind: "judge", batchId, exam, inputs, group, tasks }].
 */
export function buildBatches({
  candidates,
  pools,
  exam,
  maxCandidates = DEFAULT_BATCH_CANDIDATES,
}) {
  const groups = new Map();
  for (const task of candidates.tasks) {
    const groupId = task.key.split("/").slice(0, 2).join("/");
    if (!groups.has(groupId))
      groups.set(groupId, {
        domain: task.domain,
        title: task.group,
        tasks: [],
      });
    groups.get(groupId).tasks.push(task);
  }
  const candidateOf = (c) => ({
    target: c.target,
    title: c.title,
    source: c.source,
    ...(c.via ? { via: moduleCard(pools, c.via) } : {}),
    ...(c.module ? { module: c.module } : {}),
    ...(c.courses ? { courses: c.courses } : {}),
    ...(c.unitSig ? { unitSig: c.unitSig } : {}),
    coverage: c.coverage,
    signals: {
      ...(c.anchored !== undefined ? { anchored: c.anchored } : {}),
      ...(c.foreignFamily ? { foreignFamily: true } : {}),
      ...(c.siblingSection ? { siblingSection: true } : {}),
      ...(c.viaGroup ? { viaGroup: true } : {}),
      ...(c.relaxed ? { relaxed: true } : {}),
      ...(c.recommendedBy
        ? {
            recommendedBy: c.recommendedBy.map(
              (p) => moduleCard(pools, p).title,
            ),
          }
        : {}),
    },
    evidence: evidenceOf(c, pools),
  });
  const batches = [];
  for (const [groupId, group] of groups) {
    const parts = splitTasks(group.tasks, maxCandidates);
    parts.forEach((part, n) =>
      batches.push({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        kind: "judge",
        batchId: parts.length > 1 ? `${groupId}#${n + 1}` : groupId,
        ...(parts.length > 1 ? { part: { n: n + 1, of: parts.length } } : {}),
        exam,
        inputs: {
          guideHash: candidates.inputs?.guideHash ?? null,
          scopeFingerprint: candidates.inputs?.scopeFingerprint ?? null,
        },
        group: {
          domain: group.domain,
          title: group.title,
          tasks: group.tasks.map((t) => t.text),
        },
        tasks: part.map(({ task, candidates: list }) => ({
          key: task.key,
          text: task.text,
          noP1: task.noP1,
          anchor: (task.anchor?.modules ?? []).map((m) => m.title),
          candidates: list.map(candidateOf),
        })),
      }),
    );
  }
  return batches;
}

/** The most candidates one judge session gets (about 40,000 tokens of prompt). */
export const DEFAULT_BATCH_CANDIDATES = 150;

/**
 * Cut the tasks of a skill group into parts of at most `max` candidates, in task order and, within a task, in
 * provenance order. A task with more candidates than a part holds is continued in the next part. Nothing is
 * dropped: every candidate is in exactly one part. Returns [[{ task, candidates }]]; one part when the group fits.
 */
export function splitTasks(tasks, max) {
  const total = tasks.reduce((n, t) => n + t.candidates.length, 0);
  if (!Number.isFinite(max) || total <= max)
    return [tasks.map((task) => ({ task, candidates: task.candidates }))];
  const parts = [];
  let current = [];
  let room = max;
  for (const task of tasks) {
    let rest = task.candidates;
    while (rest.length > 0) {
      const take = rest.slice(0, room);
      current.push({ task, candidates: take });
      rest = rest.slice(take.length);
      room -= take.length;
      if (room === 0) {
        parts.push(current);
        current = [];
        room = max;
      }
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** A rough size of a prompt, to estimate the cost of a run before it is made. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const relationLines = () =>
  Object.entries(RELATIONS)
    .map(([key, r]) => `  - \`${key}\`: ${r.meaning}`)
    .join("\n");
const flagLines = () =>
  Object.entries(FLAGS)
    .map(([key, meaning]) => `  - \`${key}\`: ${meaning}`)
    .join("\n");

// compact on purpose: the indentation of a pretty-printed batch is about a third of its tokens
const fence = (json) => `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;

/** The rubric every judge gets, built from the constants of the course format so the two cannot drift. */
export function rubricText() {
  return `## The three verdicts

- \`core\`: the candidate covers the task **as the study guide words it**. Someone who studies it learns what the task asks for.
- \`supporting\`: **not in the guide, but part of the job the task belongs to**: something a working professional doing this task meets, although the guide does not name it. It needs a \`relation\`:
${relationLines()}
- \`reject\`: everything else. Above all, **out of scope**: a different job role, product area, licensing tier or specialty, however close the keywords look. Model case: for AZ-104's task "Manage external users", a page on onboarding external users with *entitlement management* (identity governance) is not an Azure administrator's job: reject it, with the reason. Also reject a page that only mentions the keywords, a generic overview that does not help with the task, and a retired page. There is no limit to how many pages a task may have: if a page is relevant, it is a pick, however many others the task already has.

Rules:

1. Judge **every** candidate of **every** task, once. Do not skip one and do not add one.
2. The guide's wording decides what is \`core\`. When a candidate covers the topic but not what the task asks for, it is \`supporting\` at best.
3. **When you are not sure, say so; never dismiss a page to be safe.** If you cannot decide between two verdicts, or cannot place the page, give the verdict you lean to and set \`confidence\` to \`low\` (do not lower the verdict, and do not reject what you cannot place). A pick or a reject with \`low\` confidence goes to the maintainer, who is the final judge of every page you are unsure about; a reject with \`high\` or \`medium\` confidence is final.
4. A pick (\`core\` or \`supporting\`) needs a \`quote\`: words copied **exactly** from one snippet of that candidate's \`evidence\` (two or more words, at most ${MAX_QUOTE_CHARS} characters, no paraphrase, no ellipsis). A script checks it, and an answer with a quote that is not in the evidence is sent back. A \`reject\` may carry a quote too, and one with \`low\` confidence should: it shows the maintainer what you saw.
5. \`why\` is one plain sentence (at most ${MAX_WHY_CHARS} characters). For a \`supporting\` pick it says why a professional doing the task meets this; for a \`reject\` it says what puts it out of scope, and with \`low\` confidence what you are unsure about.
6. \`flags\` lists what is wrong with the candidate even when you pick it (none is fine):
${flagLines()}
7. \`confidence\` is \`high\`, \`medium\` or \`low\`: how sure you are of the verdict. Say \`low\` whenever you would be guessing; a \`low\` is a question for the maintainer, not a failure.
8. The candidate's \`signals\` and \`coverage\` come from a word search; they are hints about where it came from, not evidence. \`source\` says which pool: P1 the exam's own course, P2 documentation its modules list, P3 another exam's course, P4 anything else a word search found, P5 a page a model named for this task from its own knowledge (a script confirmed that the page exists). That a page was found or named is no evidence that it belongs: judge it on its evidence like any other.
9. You may use what you know about the exam and the product, but do not invent: if the evidence does not show it, you cannot quote it.`;
}

const verdictShape = `{
  "schemaVersion": ${JUDGE_SCHEMA_VERSION},
  "kind": "judgments",
  "batchId": "<the batchId of the input>",
  "judgedBy": "<the model or session that judged>",
  "judgments": [
    {
      "task": "<task key>",
      "target": "<candidate target.path>",
      "verdict": "core | supporting | reject",
      "relation": "only for supporting: prerequisite | same-workflow | operate | deeper",
      "why": "one sentence",
      "quote": "words copied exactly from one evidence snippet (required for core and supporting)",
      "flags": ["zero or more of: ${Object.keys(FLAGS).join(", ")}"],
      "confidence": "high | medium | low"
    }
  ]
}`;

/** The prompt for a judge batch, as Markdown: rubric, answer format and the batch itself. */
export function judgePrompt(batch) {
  return `# Judge the candidates of one skill group

Exam: **${batch.exam.code}: ${batch.exam.name ?? ""}**
Skill group: **${batch.group.domain} > ${batch.group.title}**${
    batch.part
      ? `\nThis is part ${batch.part.n} of ${batch.part.of} of the group: the other parts hold the other candidates of the same tasks. Judge only the candidates below.`
      : ""
  }

You are judging which Microsoft Learn modules, units and documentation pages belong in a study course for this exam. Each task below comes from the exam's study guide; each candidate was found by a search and has not been looked at yet. Answer from the evidence shown.

${rubricText()}

## Answer format

Reply with JSON only (no prose), in this shape, with one entry in \`judgments\` per candidate of every task:

${"```json"}
${verdictShape}
${"```"}

## The skill group

Tasks of this group (for context: a candidate may belong to a neighbouring task): ${batch.group.tasks.map((t) => `"${t}"`).join("; ")}

## The batch

${fence(batch)}
`;
}

// ---------------------------------------------------------------------------
// Validating the judge's answer
// ---------------------------------------------------------------------------

const idOf = (task, target) => `${task} | ${target}`;

function indexBatch(batch) {
  const tasks = new Map();
  for (const task of batch.tasks) {
    const candidates = new Map();
    for (const c of task.candidates) candidates.set(c.target.path, c);
    tasks.set(task.key, { task, candidates });
  }
  return tasks;
}

/**
 * Check a judgments file against its batch. Returns
 * { errors, unverified, items } where `errors` are structural problems, `unverified` the picks whose quote is
 * not in the evidence, and `items` the judgments by `task | target` (valid ones only) with the result of the quote
 * check. An answer with errors or unverified quotes is sent back to the judge.
 */
export function validateJudgments(batch, file) {
  const errors = [];
  const unverified = [];
  const items = new Map();
  if (!file || typeof file !== "object")
    return {
      errors: ["the judgments file is not a JSON object"],
      unverified,
      items,
    };
  if (file.schemaVersion !== JUDGE_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${JUDGE_SCHEMA_VERSION}`);
  if (file.kind !== "judgments") errors.push('kind must be "judgments"');
  if (file.batchId !== batch.batchId)
    errors.push(
      `batchId "${file.batchId}" is not the batch's "${batch.batchId}"`,
    );
  if (!Array.isArray(file.judgments)) {
    errors.push("judgments must be a list");
    return { errors, unverified, items };
  }
  const index = indexBatch(batch);
  const seen = new Set();
  for (const [n, j] of file.judgments.entries()) {
    const where = `judgment ${n + 1}`;
    if (!j || typeof j !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    const entry = index.get(j.task);
    const candidate = entry?.candidates.get(j.target);
    const label = idOf(j.task, j.target);
    if (!entry) {
      errors.push(`${where}: the task "${j.task}" is not in the batch`);
      continue;
    }
    if (!candidate) {
      errors.push(`${label}: not a candidate of that task`);
      continue;
    }
    if (seen.has(label)) {
      errors.push(`${label}: judged twice`);
      continue;
    }
    seen.add(label);
    const before = errors.length;
    if (!VERDICTS.includes(j.verdict))
      errors.push(`${label}: verdict must be one of ${VERDICTS.join(", ")}`);
    if (j.verdict === "supporting") {
      if (!Object.hasOwn(RELATIONS, j.relation))
        errors.push(
          `${label}: a supporting pick needs a relation (${Object.keys(RELATIONS).join(", ")})`,
        );
    } else if (j.relation !== undefined)
      errors.push(`${label}: only a supporting pick has a relation`);
    if (!present(j.why)) errors.push(`${label}: why is required`);
    else if (j.why.length > MAX_WHY_CHARS)
      errors.push(`${label}: why is longer than ${MAX_WHY_CHARS} characters`);
    if (
      j.flags !== undefined &&
      (!Array.isArray(j.flags) || j.flags.some((f) => !Object.hasOwn(FLAGS, f)))
    )
      errors.push(
        `${label}: flags must be a list of ${Object.keys(FLAGS).join(", ")}`,
      );
    if (!CONFIDENCE.includes(j.confidence))
      errors.push(
        `${label}: confidence must be one of ${CONFIDENCE.join(", ")}`,
      );
    const pick = j.verdict === "core" || j.verdict === "supporting";
    let check = null;
    if (j.quote !== undefined && !present(j.quote))
      errors.push(`${label}: quote is empty`);
    else if (present(j.quote)) {
      if (j.quote.length > MAX_QUOTE_CHARS)
        errors.push(
          `${label}: quote is longer than ${MAX_QUOTE_CHARS} characters`,
        );
      else {
        check = findQuote(j.quote, candidate.evidence);
        if (!check.verified && pick)
          unverified.push({ task: j.task, target: j.target, quote: j.quote });
      }
    } else if (pick) errors.push(`${label}: a pick needs a quote`);
    if (errors.length === before)
      items.set(label, {
        judgment: j,
        quote: check
          ? {
              verified: check.verified,
              where: check.where,
              termCoverage: quoteTermCoverage(entry.task.text, j.quote),
            }
          : null,
      });
  }
  for (const [key, { candidates }] of index)
    for (const path of candidates.keys())
      if (!seen.has(idOf(key, path)))
        errors.push(`${idOf(key, path)}: not judged`);
  return { errors, unverified, items, judgedBy: file.judgedBy ?? null };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Merge a validated judgments file into the judged group. Every candidate of the batch is in it, with the judge's
 * answer. A quote that is not in the evidence is kept and marked.
 */
export function mergeJudged(batch, judged) {
  const tasks = batch.tasks.map((task) => ({
    key: task.key,
    text: task.text,
    noP1: task.noP1,
    items: task.candidates.map((c) => {
      const label = idOf(task.key, c.target.path);
      const j = judged.items.get(label);
      const { evidence, ...card } = c;
      const verdict = j.judgment;
      const flags = [...new Set(verdict.flags ?? [])].sort(byText);
      return {
        ...card,
        judge: {
          verdict: verdict.verdict,
          ...(verdict.relation ? { relation: verdict.relation } : {}),
          why: verdict.why,
          ...(verdict.quote
            ? {
                quote: verdict.quote,
                quoteVerified: j.quote?.verified ?? false,
                ...(j.quote?.where ? { quoteWhere: j.quote.where } : {}),
                quoteTermCoverage: j.quote?.termCoverage ?? 0,
              }
            : {}),
          flags: verdict.flags ?? [],
          confidence: verdict.confidence,
        },
        flags,
      };
    }),
  }));
  const items = tasks.flatMap((t) => t.items);
  const count = (fn) => items.filter(fn).length;
  return {
    schemaVersion: JUDGE_SCHEMA_VERSION,
    kind: "judged",
    batchId: batch.batchId,
    exam: batch.exam,
    inputs: batch.inputs,
    group: batch.group,
    judgedBy: judged.judgedBy ?? null,
    tasks,
    stats: {
      candidates: items.length,
      core: count((i) => i.judge.verdict === "core"),
      supporting: count((i) => i.judge.verdict === "supporting"),
      reject: count((i) => i.judge.verdict === "reject"),
      unverifiedQuotes: count(
        (i) => i.judge.quote !== undefined && i.judge.quoteVerified === false,
      ),
    },
  };
}
