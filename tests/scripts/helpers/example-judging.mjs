// Candidates, batches and answers for the judging tests, on the invented corner of Learn of
// example-candidates.mjs. Nothing here says what a real exam covers or how a real judge answers.
import {
  buildPools,
  generateCandidates,
} from "../../../scripts/lib/course-candidates.mjs";
import {
  buildBatches,
  buildSkepticBatch,
  mergeJudged,
  validateJudgments,
  validateSkeptic,
} from "../../../scripts/lib/course-judge.mjs";
import { candidateWorld, guideOf, scopeOf } from "./example-candidates.mjs";

export const EXAM = { code: "NET-100", name: "Network Administrator" };
export const TASKS = ["Configure user-defined routes", "Manage external users"];

export function worldPools() {
  const world = candidateWorld();
  const pools = buildPools({ ...world, boilerplateModules: 2 });
  return { world, pools };
}

/** The generator's candidates file for TASKS (or other tasks). */
export function candidatesFile(tasks = TASKS) {
  const { world, pools } = worldPools();
  const candidates = generateCandidates({
    code: EXAM.code,
    guide: guideOf(tasks),
    scope: scopeOf(world),
    pools,
    options: { genericProductShare: 0.6 },
  });
  return { candidates, pools };
}

/** The judge batches of TASKS. */
export function batches(tasks = TASKS) {
  const { candidates, pools } = candidatesFile(tasks);
  return {
    batches: buildBatches({ candidates, pools, exam: EXAM }),
    candidates,
    pools,
  };
}

const firstQuote = (candidate) => candidate.evidence[0].text;

/**
 * A valid judgments file for a batch: P1 and P2 candidates are core, P3 supporting (prerequisite), the rest rejected.
 * `edit(judgment, candidate, task)` may change an entry; returning null drops it.
 */
export function judgmentsFor(batch, edit = (j) => j) {
  const judgments = [];
  for (const task of batch.tasks)
    for (const c of task.candidates) {
      const pick = c.source === "P1" || c.source === "P2";
      const base = {
        task: task.key,
        target: c.target.path,
        verdict: pick ? "core" : c.source === "P3" ? "supporting" : "reject",
        ...(c.source === "P3" ? { relation: "prerequisite" } : {}),
        why:
          c.source === "P4"
            ? "Found by search only and not part of the exam's job."
            : "Covers the task as the guide words it.",
        ...(c.source === "P4" ? {} : { quote: firstQuote(c) }),
        flags: [],
        confidence: "high",
      };
      const edited = edit(base, c, task);
      if (edited) judgments.push(edited);
    }
  return {
    schemaVersion: 1,
    kind: "judgments",
    batchId: batch.batchId,
    judgedBy: "test judge",
    judgments,
  };
}

/** A valid skeptic file for a skeptic batch: every pick upheld, or `edit(answer, candidate, task)`. */
export function skepticFor(skBatch, edit = (a) => a) {
  const answers = [];
  for (const task of skBatch.tasks)
    for (const c of task.candidates) {
      const edited = edit(
        {
          task: task.key,
          target: c.target.path,
          stance: "uphold",
          reason: "Could not refute it.",
        },
        c,
        task,
      );
      if (edited) answers.push(edited);
    }
  return {
    schemaVersion: 1,
    kind: "skeptic",
    batchId: skBatch.batchId,
    judgedBy: "test skeptic",
    answers,
  };
}

/**
 * The judged file (course-judge.mjs merge) of a batch: the judgments of `judgmentsFor` and a skeptic that upholds
 * every pick, each changed by `judge(judgment, candidate, task)` and `skeptic(answer, candidate, task)`.
 */
export function judgedFor(batch, { judge, skeptic } = {}) {
  const judged = validateJudgments(batch, judgmentsFor(batch, judge));
  const skBatch = buildSkepticBatch(batch, judged);
  const answers = validateSkeptic(skBatch, skepticFor(skBatch, skeptic));
  return mergeJudged(batch, judged, answers);
}

/**
 * A judged file with something for every gate: P1 and P2 core with a good quote, P3 supporting (the skeptic refutes the
 * units), P4 supporting (the skeptic refutes them, so they wait for the maintainer), the rest rejected.
 */
export function exampleJudged() {
  const { batches: bs } = batches();
  return judgedFor(bs[0], {
    judge: (j, c) =>
      c.source === "P4"
        ? {
            ...j,
            verdict: "supporting",
            relation: "same-workflow",
            why: "A neighbouring step of the job.",
            quote: c.evidence[0].text,
          }
        : j.verdict === "core"
          ? {
              ...j,
              quote:
                c.evidence.find((e) => /user-defined|route/i.test(e.text))
                  ?.text ?? j.quote,
            }
          : j,
    skeptic: (a, c) =>
      (c.source === "P3" && c.target.kind === "unit") || c.source === "P4"
        ? { ...a, stance: "refute", reason: "Another exam's job." }
        : a,
  });
}
