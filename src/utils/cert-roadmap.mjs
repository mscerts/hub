import { readFileSync } from "node:fs";
import path from "node:path";
import { AREA_BY_PREFIX } from "../../scripts/lib/areas.mjs";

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

/** The id an HTML element of a step or result carries. */
export const panelId = (id) => `roadmap-${id}`;

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

  const reached = new Set([start]);
  const visiting = new Set();
  const visit = (id, trail) => {
    if (id in results) {
      reached.add(id);
      return;
    }
    const step = steps[id];
    if (!step) return;
    reached.add(id);
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
    for (const answer of step.answers ?? []) {
      if (!answer.label?.trim())
        problems.push(`Step "${id}" has an answer without a label`);
      if (!(answer.next in steps) && !(answer.next in results))
        problems.push(`Step "${id}": "${answer.next}" does not exist`);
    }
    if (!reached.has(id)) problems.push(`Step "${id}" cannot be reached`);
  }
  for (const [id, result] of Object.entries(results)) {
    if (!result.title?.trim()) problems.push(`Result "${id}" has no title`);
    if (!result.summary?.trim()) problems.push(`Result "${id}" has no summary`);
    if (!reached.has(id)) problems.push(`Result "${id}" cannot be reached`);
    if (result.exams.length === 0 && !result.link)
      problems.push(`Result "${id}" names no exam and has no link`);
    if (
      result.exams.length > 0 &&
      !result.exams.some((e) => e.role === "start")
    )
      problems.push(`Result "${id}" has no exam to start with`);
    const seen = new Set();
    for (const exam of result.exams) {
      if (seen.has(exam.code))
        problems.push(`Result "${id}" names ${exam.code} twice`);
      seen.add(exam.code);
      if (!examAreaOf(exam.code))
        problems.push(`Result "${id}": no area for ${exam.code}`);
    }
    if (result.next && !(result.next.to in steps))
      problems.push(`Result "${id}": "${result.next.to}" is not a step`);
  }
  return problems;
}

/**
 * The whole roadmap as one nested list for the Markdown copy of the page: a question, its answers, and under
 * each answer the next question or the exams to take. A step several answers lead to is written out
 * at each of them (the tree is small), so each branch reads on its own.
 * @param {Roadmap} roadmap
 * @param {(code: string) => string} [describe] the text after an exam code ("Microsoft Azure Administrator")
 * @returns {OutlineItem[]}
 */
export function roadmapOutline(roadmap, describe = () => "") {
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
    return lines;
  };
  const step = (id) => {
    const item = roadmap.steps[id];
    return {
      text: item.question,
      children: item.answers.map((answer) => ({
        text: answer.label,
        children:
          answer.next in roadmap.results
            ? result(answer.next)
            : [step(answer.next)],
      })),
    };
  };
  return [step(roadmap.start)];
}
