import { readFileSync } from "node:fs";
import path from "node:path";
import { AREA_BY_PREFIX } from "../../scripts/lib/areas.mjs";
import { visibleExamStatuses } from "../data_files/exam-status.mjs";

// The certification roadmap (`/certs/guide/roadmap/`) is a decision tree kept in `src/data_files/cert-roadmap.json`:
// `steps` are questions whose answers lead to another step or to a result, and every result names the exams
// to take. Nothing here makes up an exam, an address or a status: a code is turned into the address of the
// hub's own exam page, and `tests/scripts/cert-roadmap.test.mjs` fails when a code has no page or the exam is
// retired or retiring.

/**
 * @typedef {{ label: string, next: string }} RoadmapAnswer
 * @typedef {{ question: string, help?: string, answers: RoadmapAnswer[] }} RoadmapStep
 * @typedef {{ code: string, role: "start" | "then" | "optional" }} RoadmapExam
 * @typedef {{ title: string, summary: string, exams: RoadmapExam[], next?: { label: string, to: string }, link?: { label: string, href: string } }} RoadmapResult
 * @typedef {{ text: string, href?: string, children?: OutlineItem[] }} OutlineItem
 * @typedef {{ start: string, steps: Record<string, RoadmapStep>, results: Record<string, RoadmapResult> }} Roadmap
 */

/**
 * The roadmap of the data file.
 * @returns {Roadmap}
 */
export function readRoadmap(root = process.cwd()) {
  return JSON.parse(
    readFileSync(
      path.resolve(root, "src", "data_files", "cert-roadmap.json"),
      "utf8",
    ),
  );
}

/** The area folder of an exam code, "AZ-104" -> "azure", else undefined. */
export function examAreaOf(code) {
  return AREA_BY_PREFIX[String(code).split("-")[0].toUpperCase()];
}

/** The address of an exam's page on the hub, "AZ-104" -> "/certs/azure/az-104/". */
export function examHref(code) {
  const area = examAreaOf(code);
  if (!area) throw new Error(`No area for exam code ${code}`);
  return `/certs/${area}/${String(code).toLowerCase()}/`;
}

/** The id an HTML element of a step or result carries; `prefix` keeps the ids of two roadmaps on one page apart. */
export const panelId = (id, prefix = "roadmap") => `${prefix}-${id}`;

/**
 * The steps and results a roadmap that starts at `start` can reach: through the answers and through the
 * "next" link of a result. A roadmap placed on another page renders only these.
 * @param {Roadmap} roadmap
 * @returns {Set<string>}
 */
export function reachableIds(roadmap, start = roadmap.start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const step = roadmap.steps[id];
    if (step) for (const answer of step.answers) queue.push(answer.next);
    const result = roadmap.results[id];
    if (result?.next) queue.push(result.next.to);
  }
  return seen;
}

/** Every exam code the roadmap names, sorted, without repeats. */
export function examCodesOf(roadmap) {
  const codes = new Set();
  for (const result of Object.values(roadmap.results))
    for (const exam of result.exams) codes.add(exam.code);
  return [...codes].sort();
}

/**
 * What is wrong with the shape of a roadmap, as a list of sentences (empty when it is sound): answers that lead
 * nowhere, ids used twice, steps or results nothing leads to, a path that loops, a result without exams or link.
 * @param {Roadmap} roadmap
 * @returns {string[]}
 */
export function roadmapProblems(roadmap) {
  const problems = [];
  const { start, steps, results } = roadmap;
  for (const id of Object.keys(steps))
    if (id in results) problems.push(`"${id}" is both a step and a result`);
  if (!(start in steps)) problems.push(`The start "${start}" is not a step`);

  // what the wizard can show from the start: through the answers and the "next" button of a result
  const reached = start in steps ? reachableIds(roadmap) : new Set();
  const visiting = new Set();
  const visit = (id, trail) => {
    if (id in results) return;
    const step = steps[id];
    if (!step) return;
    if (visiting.has(id)) {
      problems.push(`The answers loop: ${[...trail, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const answer of step.answers) visit(answer.next, [...trail, id]);
    visiting.delete(id);
  };
  if (start in steps) visit(start, []);

  for (const [id, step] of Object.entries(steps)) {
    if (!step.question?.trim()) problems.push(`Step "${id}" has no question`);
    if (!Array.isArray(step.answers) || step.answers.length < 2)
      problems.push(`Step "${id}" needs at least two answers`);
    const labels = new Set();
    for (const answer of step.answers ?? []) {
      if (!answer.label?.trim())
        problems.push(`Step "${id}" has an answer without a label`);
      else if (labels.has(answer.label))
        problems.push(`Step "${id}" has the answer "${answer.label}" twice`);
      labels.add(answer.label);
      if (!(answer.next in steps) && !(answer.next in results))
        problems.push(`Step "${id}": "${answer.next}" does not exist`);
    }
    if (!reached.has(id)) problems.push(`Step "${id}" cannot be reached`);
  }
  for (const [id, result] of Object.entries(results)) {
    if (!result.title?.trim()) problems.push(`Result "${id}" has no title`);
    if (!result.summary?.trim()) problems.push(`Result "${id}" has no summary`);
    if (!reached.has(id)) problems.push(`Result "${id}" cannot be reached`);
    if (!Array.isArray(result.exams)) {
      problems.push(`Result "${id}" has no exams list`);
      continue;
    }
    if (result.exams.length === 0 && !result.link)
      problems.push(`Result "${id}" names no exam and has no link`);
    if (
      result.exams.length > 0 &&
      !result.exams.some((e) => e.role === "start")
    )
      problems.push(`Result "${id}" has no exam to start with`);
    const seen = new Set();
    for (const exam of result.exams) {
      if (!["start", "then", "optional"].includes(exam.role))
        problems.push(
          `Result "${id}": ${exam.code} has the role "${exam.role}"`,
        );
      if (seen.has(exam.code))
        problems.push(`Result "${id}" names ${exam.code} twice`);
      seen.add(exam.code);
      if (!examAreaOf(exam.code))
        problems.push(`Result "${id}": no area for ${exam.code}`);
    }
    if (
      result.link &&
      !/^(https:\/\/\S+|\/certs\/[a-z0-9\-/]+\/)$/.test(result.link.href ?? "")
    )
      problems.push(
        `Result "${id}": the link "${result.link.href}" is not an https address or a lowercase /certs/ path with a trailing slash`,
      );
    if (result.next && !(result.next.to in steps))
      problems.push(`Result "${id}": "${result.next.to}" is not a step`);
  }
  return problems;
}

/**
 * The whole roadmap as one nested list for the Markdown copy of the page: a question, its answers, and under
 * each answer the next question or the exams to take.
 * @param {Roadmap} roadmap
 * @param {(code: string) => string} [describe] the text after an exam code ("Microsoft Azure Administrator")
 * @param {string} [start] the step to start from (default: the start of the roadmap)
 * @returns {OutlineItem[]}
 */
export function roadmapOutline(
  roadmap,
  describe = () => "",
  start = roadmap.start,
) {
  const result = (id) => {
    const item = roadmap.results[id];
    const lines = [{ text: `${item.title}: ${item.summary}` }];
    for (const exam of item.exams) {
      const detail = describe(exam.code);
      const prefix =
        exam.role === "optional"
          ? "Optional: "
          : exam.role === "then"
            ? "Then: "
            : "";
      lines.push({
        text: `${prefix}${exam.code}${detail ? `: ${detail}` : ""}`,
        href: examHref(exam.code),
      });
    }
    if (item.link) lines.push({ text: item.link.label, href: item.link.href });
    if (item.next)
      lines.push({
        text: `${item.next.label} Continue with: ${roadmap.steps[item.next.to]?.question ?? item.next.to}`,
      });
    return lines;
  };
  // a question several answers lead to is written out once, where it first appears
  const written = new Set();
  const step = (id) => {
    const item = roadmap.steps[id];
    if (written.has(id))
      return { text: `${item.question} (the answers are listed above)` };
    written.add(id);
    return {
      text: item.question,
      children: [
        ...(item.help ? [{ text: `Note: ${item.help}` }] : []),
        ...item.answers.map((answer) => ({
          text: answer.label,
          children:
            answer.next in roadmap.results
              ? result(answer.next)
              : [step(answer.next)],
        })),
      ],
    };
  };
  if (!(start in roadmap.steps))
    throw new Error(`The roadmap has no step "${start}" to start from`);
  return [step(start)];
}

/**
 * The name and the badge of an exam as the exam page gives them, "Microsoft Azure Administrator" or
 * "Designing and Implementing Microsoft Agentic DevOps Solutions (beta)", for the Markdown copy and the MCP bundle
 * (the page itself reads the same from the content collection). Empty when the page cannot be read.
 * @param {string} code
 * @returns {string}
 */
export function describeExam(code, root = process.cwd()) {
  const area = examAreaOf(code);
  if (!area) return "";
  let text;
  try {
    text = readFileSync(
      path.resolve(root, "src", "content", "docs", area, `${code}.mdx`),
      "utf8",
    );
  } catch {
    return "";
  }
  const name = /^examName:\s*"?(.*?)"?\s*$/m.exec(text)?.[1] ?? "";
  const status = Object.assign({}, ...Object.values(visibleExamStatuses()))[
    code
  ]?.text;
  const word = { BETA: "beta", RETIRING: "retiring" }[status ?? ""];
  return name ? `${name}${word ? ` (${word})` : ""}` : "";
}
