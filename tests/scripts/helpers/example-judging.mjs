// Candidates, batches and answers for the judging tests, on the invented corner of Learn of
// example-candidates.mjs. Nothing here says what a real exam covers or how a real judge answers.
import {
  buildPools,
  generateCandidates,
} from "../../../scripts/lib/course-candidates.mjs";
import {
  buildBatches,
  mergeJudged,
  validateJudgments,
} from "../../../scripts/lib/course-judge.mjs";
import { candidateWorld, guideOf, scopeOf } from "./example-candidates.mjs";

export const EXAM = { code: "NET-100", name: "Network Administrator" };
export const TASKS = ["Configure user-defined routes", "Manage external users"];

export function worldPools() {
  const world = candidateWorld();
  const pools = buildPools({ ...world, boilerplateModules: 2 });
  return { world, pools };
}

/**
 * The generator's candidates file for TASKS (or other tasks). The fundamentals of the skill groups are left out
 * unless `foundations` is true, so that the tests of the tasks keep their data. The generator's default offers only
 * the hands-on units (a module is placed once, as a module); `units: "all"` offers every unit, for the tests that
 * need a unit candidate or an older gated file that still holds one.
 */
export function candidatesFile(
  tasks = TASKS,
  { foundations = false, units = "hands-on" } = {},
) {
  const { world, pools } = worldPools();
  const candidates = generateCandidates({
    code: EXAM.code,
    guide: guideOf(tasks),
    scope: scopeOf(world),
    pools,
    options: {
      genericProductShare: 0.6,
      units,
      ...(foundations ? {} : { foundations: false }),
    },
  });
  return { candidates, pools };
}

/** The judge batches of TASKS. */
export function batches(tasks = TASKS, options = {}) {
  const { candidates, pools } = candidatesFile(tasks, options);
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
      // the fundamentals task of a skill group has its own verdicts: foundation or reject
      if (task.foundation) {
        const base = {
          task: task.key,
          target: c.target.path,
          verdict: c.source === "P4" ? "reject" : "foundation",
          why:
            c.source === "P4"
              ? "Found by search only and not part of the group's theory."
              : "Teaches a concept behind the tasks of the group.",
          ...(c.source === "P4" ? {} : { quote: firstQuote(c) }),
          flags: [],
          confidence: "high",
        };
        const edited = edit(base, c, task);
        if (edited) judgments.push(edited);
        continue;
      }
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

/**
 * The judged file (course-judge.mjs merge) of a batch: the judgments of `judgmentsFor`, each changed by
 * `judge(judgment, candidate, task)`.
 */
export function judgedFor(batch, { judge } = {}) {
  const judged = validateJudgments(batch, judgmentsFor(batch, judge));
  return mergeJudged(batch, judged);
}

/**
 * A judged file with something for every gate: P1 and P2 core with a good quote, P3 supporting (the judge is not sure
 * of the units, so they wait for the maintainer), P4 supporting (flagged as another role, so they wait too), the
 * rest rejected.
 */
export function exampleJudged(options = {}) {
  const { batches: bs } = batches(TASKS, options);
  return judgedFor(bs[0], {
    judge: (j, c) =>
      c.source === "P4"
        ? {
            ...j,
            verdict: "supporting",
            relation: "same-workflow",
            why: "A neighbouring step of the job.",
            quote: c.evidence[0].text,
            flags: ["other-role"],
          }
        : j.verdict === "core"
          ? {
              ...j,
              quote:
                c.evidence.find((e) => /user-defined|route/i.test(e.text))
                  ?.text ?? j.quote,
            }
          : c.source === "P3" && c.target.kind === "unit"
            ? { ...j, confidence: "low" }
            : j,
  });
}
