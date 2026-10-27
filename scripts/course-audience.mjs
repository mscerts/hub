#!/usr/bin/env node
/**
 * The audience profile of a course (docs/course-audience.md): options for the concepts a study guide says a
 * candidate should know already, and the maintainer's decision for each. The process proposes; a person chooses,
 * and may add a page of any site.
 *
 *   node scripts/course-audience.mjs options <CODE> [--out DIR] [--max N]
 *       Searches Learn for every concept of the guide's prerequisite lists ("You should be familiar with: ...")
 *       and writes the options (at most N per concept, default 12) to DIR/<CODE>.audience.json.
 *   node scripts/course-audience.mjs prepare <CODE> [--out DIR]
 *       Writes a proposal prompt per list of concepts, for a model to name Learn pages from its own knowledge;
 *       check the answers with course-propose.mjs check <prefix>.
 *   node scripts/course-audience.mjs merge <CODE> [--options FILE] [--answers DIR] [--out FILE]
 *       Adds the pages a model named (and that exist) to the options as source P5.
 *   node scripts/course-audience.mjs sheet <CODE> [--options FILE] [--decisions FILE] [--out FILE]
 *       Prints (or writes) the sheet to read: every concept, its numbered options and what is decided so far.
 *   node scripts/course-audience.mjs status <CODE> [--decisions FILE]
 *       Lists the concepts and their decisions.
 *   node scripts/course-audience.mjs choose <CODE> <concept> <option numbers> [--title TEXT] [--options FILE] [--decisions FILE]
 *       Decides a concept: the options of the sheet with those numbers, e.g. "choose AZ-104 4 1,3".
 *   node scripts/course-audience.mjs add <CODE> <concept> --url URL --title TEXT [--why TEXT] [--decisions FILE]
 *       Adds any page to a concept, whatever site it is on; the title is the name of the resource.
 *   node scripts/course-audience.mjs none <CODE> <concept> [--decisions FILE]
 *       Records that a concept needs no resource.
 *   node scripts/course-audience.mjs clear <CODE> <concept> [--decisions FILE]
 *       Forgets the decision again.
 * <concept> is its number on the sheet, its key or a part of its wording. `choose`, `add`, `none` and `clear`
 * add to what is decided (a second `add` for the same concept adds a second page); `choose` and `none`
 * replace the options chosen before. The decisions are kept in src/data_files/course-audience/<CODE>.json, which
 * the maintainer commits: they are the one thing in the chain that is written by hand.
 *
 * Exit code: 0 done, 1 a decisions file that is not valid, 2 usage or input error.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPools } from "./course-candidates.mjs";
import { readGuides } from "./course-source.mjs";
import {
  AUDIENCE_OPTIONS_KIND,
  AUDIENCE_SCHEMA_VERSION,
  audienceBatches,
  audienceConcepts,
  audiencePrompt,
  clearConcept,
  decisionsProblems,
  emptyDecisions,
  optionsInOrder,
  pickFromOption,
  pickFromUrl,
  renderSheet,
  setConcept,
} from "./lib/course-audience.mjs";
import { generateCandidates } from "./lib/course-candidates.mjs";
import { parseGuide } from "./lib/course-guide.mjs";
import { mergeProposals, validateProposals } from "./lib/course-propose.mjs";
import { buildScopeMap } from "./lib/course-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = [
  "options",
  "prepare",
  "merge",
  "sheet",
  "status",
  "choose",
  "add",
  "none",
  "clear",
];
const USAGE = `Usage: node scripts/course-audience.mjs options <CODE> [--out DIR] [--max N]
       node scripts/course-audience.mjs prepare <CODE> [--out DIR]
       node scripts/course-audience.mjs merge <CODE> [--options FILE] [--answers DIR] [--out FILE]
       node scripts/course-audience.mjs sheet <CODE> [--options FILE] [--decisions FILE] [--out FILE]
       node scripts/course-audience.mjs status <CODE> [--decisions FILE]
       node scripts/course-audience.mjs choose <CODE> <concept> <option numbers> [--title TEXT] [--options FILE] [--decisions FILE]
       node scripts/course-audience.mjs add <CODE> <concept> --url URL --title TEXT [--why TEXT] [--decisions FILE]
       node scripts/course-audience.mjs none <CODE> <concept> [--decisions FILE]
       node scripts/course-audience.mjs clear <CODE> <concept> [--decisions FILE]`;

const VALUE_OPTIONS = [
  "--out",
  "--max",
  "--options",
  "--answers",
  "--decisions",
  "--title",
  "--url",
  "--why",
  "--today",
];

function parseArgs(argv) {
  const options = { command: null, code: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_OPTIONS.includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (!options.command) options.command = arg;
    else if (!options.code) options.code = arg.toUpperCase();
    else options.positional.push(arg);
  }
  if (!COMMANDS.includes(options.command))
    throw new Error(`A command is required: ${COMMANDS.join(", ")}`);
  if (!options.code) throw new Error("An exam code is required");
  if (options.max !== undefined) {
    options.max = Number(options.max);
    if (!Number.isInteger(options.max) || options.max < 1)
      throw new Error("--max takes a whole number of at least 1");
  }
  return options;
}

const readJson = (file, what) => {
  if (!existsSync(file)) throw new Error(`${what} ${file} does not exist.`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const writeJson = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const today = (options) =>
  options.today ?? new Date().toISOString().slice(0, 10);

function loadGuide(code, { env, root }) {
  const guides = readGuides(
    env.LEARN_EXAMS_FILE || join(root, "src", "data_files", "learn-exams.json"),
  );
  const stored = guides.get(code);
  if (!stored) throw new Error(`No stored study guide text for ${code}.`);
  const guide = { ...parseGuide(stored.lines), hash: stored.hash };
  if (!guide.ok)
    throw new Error(`${code}: the study guide does not parse completely.`);
  if (!guide.audience)
    throw new Error(`${code}: the study guide has no audience profile.`);
  return { guide, stored };
}

const decisionsFile = (options, root) =>
  options.decisions ??
  join(root, "src", "data_files", "course-audience", `${options.code}.json`);

function readDecisions(options, root, audience) {
  const file = decisionsFile(options, root);
  if (!existsSync(file))
    return { file, decisions: emptyDecisions(options.code) };
  const decisions = readJson(file, "the decisions file");
  const { problems } = decisionsProblems(decisions, {
    code: options.code,
    audience,
  });
  if (problems.length) {
    const e = new Error(`${file} is not valid:\n  ${problems.join("\n  ")}`);
    e.exitCode = 1;
    throw e;
  }
  return { file, decisions };
}

/** The concept a command names: its number on the sheet, its key or a unique part of its wording. */
function findConcept(concepts, ref) {
  if (ref === undefined)
    throw new Error("Name a concept (number, key or text)");
  if (/^\d+$/.test(ref)) {
    const concept = concepts[Number(ref) - 1];
    if (!concept) throw new Error(`There is no concept number ${ref}`);
    return concept;
  }
  const exact = concepts.filter((c) => c.key === ref);
  if (exact.length === 1) return exact[0];
  const part = concepts.filter((c) =>
    c.text.toLowerCase().includes(ref.toLowerCase()),
  );
  if (part.length === 1) return part[0];
  throw new Error(
    part.length === 0
      ? `No concept matches "${ref}"`
      : `"${ref}" matches several concepts: ${part.map((c) => c.text).join("; ")}`,
  );
}

export async function main(argv, deps = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    fetchImpl = globalThis.fetch,
    root = repoRoot,
    tmp = tmpdir(),
    loadPoolsImpl = loadPools,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    const { guide, stored } = loadGuide(options.code, { env, root });
    const concepts = audienceConcepts(guide.audience);
    const optionsFile =
      options.options ??
      join(tmp, "course-audience", `${options.code}.audience.json`);

    if (options.command === "options") {
      const loaded = await loadPoolsImpl({ root, env, fetchImpl });
      const scope = buildScopeMap({
        code: options.code,
        courses: loaded.courses,
        learningPaths: loaded.learnsync.content.learningPaths,
        modules: loaded.learnsync.catalog.modules,
        moduleLinks: loaded.learnsync.moduleLinks,
      });
      const result = generateCandidates({
        code: options.code,
        guide,
        scope,
        pools: loaded.pools,
        options: {
          audienceOnly: true,
          ...(options.max ? { audienceMax: options.max } : {}),
        },
      });
      const out = options.out
        ? join(options.out, `${options.code}.audience.json`)
        : optionsFile;
      writeJson(out, {
        schemaVersion: AUDIENCE_SCHEMA_VERSION,
        kind: AUDIENCE_OPTIONS_KIND,
        code: options.code,
        builtAt: today(options),
        inputs: { guideHash: guide.hash ?? null },
        concepts: result.audience,
      });
      const s = result.stats.audience;
      log(
        `${options.code}: ${s.concepts} concepts, ${s.candidates} options; ${s.withoutCandidates} concepts without any`,
      );
      log(`Wrote ${out}`);
      return 0;
    }

    if (options.command === "prepare") {
      const batches = audienceBatches({
        concepts,
        audience: guide.audience,
        exam: { code: options.code, name: stored.name ?? null },
        guideHash: stored.hash ?? null,
      });
      const outDir = options.out ?? join(tmp, "course-propose");
      mkdirSync(outDir, { recursive: true });
      batches.forEach((batch, i) => {
        const prefix = join(
          outDir,
          `${options.code}.audience-${String(i + 1).padStart(2, "0")}`,
        );
        batch.batchId = `${options.code.toLowerCase()}-audience-${i + 1}`;
        writeJson(`${prefix}.propose-batch.json`, batch);
        writeFileSync(`${prefix}.propose.md`, audiencePrompt(batch));
        log(`${prefix}: ${batch.tasks.length} concepts`);
      });
      return 0;
    }

    if (options.command === "merge") {
      const answersDir = options.answers ?? join(tmp, "course-propose");
      const files = existsSync(answersDir)
        ? readdirSync(answersDir)
            .filter(
              (f) =>
                f.startsWith(`${options.code}.audience-`) &&
                f.endsWith(".proposals.json"),
            )
            .sort()
        : [];
      if (files.length === 0) {
        error(`No ${options.code}.audience-*.proposals.json in ${answersDir}.`);
        return 2;
      }
      const answers = [];
      for (const f of files) {
        const prefix = join(answersDir, f.replace(/\.proposals\.json$/, ""));
        const batch = readJson(
          `${prefix}.propose-batch.json`,
          "the batch file",
        );
        const result = validateProposals(
          batch,
          readJson(join(answersDir, f), f),
        );
        if (result.problems.length) {
          for (const p of result.problems) error(`  ${f}: ${p}`);
          return 1;
        }
        answers.push(result);
      }
      const base = readJson(optionsFile, "the options file");
      const loaded = await loadPoolsImpl({ root, env, fetchImpl });
      const { candidates, report } = mergeProposals({
        candidates: { tasks: base.concepts },
        answers,
        pools: loaded.pools,
        redirects: loaded.docs?.redirects ?? [],
      });
      const out = options.out ?? optionsFile;
      writeJson(out, { ...base, concepts: candidates.tasks });
      log(
        `${report.proposed} pages proposed for ${report.tasksAnswered} concepts: ${report.ok} exist, ${report.alreadyCandidates} were options already, ${report.added} added; not found ${Object.values(report.unresolved).reduce((a, b) => a + b, 0)}`,
      );
      log(`Wrote ${out}`);
      return 0;
    }

    const { file, decisions } = readDecisions(options, root, guide.audience);

    if (options.command === "sheet" || options.command === "status") {
      if (options.command === "status") {
        const decided = new Map(decisions.concepts.map((c) => [c.key, c]));
        concepts.forEach((c, i) => {
          const d = decided.get(c.key);
          log(
            `${i + 1}. ${c.text}: ${
              !d
                ? "not decided"
                : d.picks.length === 0
                  ? "needs no resource"
                  : d.picks
                      .map(
                        (p) =>
                          `${p.title} <${p.href}>${p.kind === "external" ? " (other site)" : ""}`,
                      )
                      .join("; ")
            }`,
          );
        });
        return 0;
      }
      const options_ = existsSync(optionsFile)
        ? readJson(optionsFile, "the options file")
        : null;
      if (!options_)
        error(
          `No options file (${optionsFile}): the sheet lists the concepts only. Run options first.`,
        );
      const sheet = renderSheet({
        code: options.code,
        audience: guide.audience,
        options: options_,
        decisions,
      });
      if (options.out) {
        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, sheet);
        log(`Wrote ${options.out}`);
      } else log(sheet);
      return 0;
    }

    // the commands that decide
    const concept = findConcept(concepts, options.positional[0]);
    const known =
      decisions.concepts.find((c) => c.key === concept.key)?.picks ?? [];
    let next;
    if (options.command === "clear") next = clearConcept(decisions, concept);
    else if (options.command === "none")
      next = setConcept(decisions, concept, []);
    else if (options.command === "add") {
      if (!options.url || !options.title)
        throw new Error("add needs --url and --title");
      const pick = pickFromUrl({
        url: options.url,
        title: options.title,
        why: options.why ?? null,
        today: today(options),
      });
      if (known.some((p) => p.href === pick.href))
        throw new Error(`${pick.href} is already chosen for ${concept.text}`);
      next = setConcept(decisions, concept, [...known, pick]);
    } else {
      const numbers = (options.positional[1] ?? "")
        .split(",")
        .map((n) => Number(n.trim()))
        .filter(Boolean);
      if (numbers.length === 0)
        throw new Error("choose needs the option numbers, e.g. 1,3");
      const base = readJson(optionsFile, "the options file");
      const entry = base.concepts.find((c) => c.key === concept.key);
      const picks = numbers.map((n) => {
        const option = optionsInOrder(entry?.candidates ?? [])[n - 1];
        if (!option)
          throw new Error(`${concept.text} has no option number ${n}`);
        return pickFromOption(option, {
          title: numbers.length === 1 ? (options.title ?? null) : null,
          today: today(options),
        });
      });
      next = setConcept(decisions, concept, picks);
    }
    const checked = decisionsProblems(next, {
      code: options.code,
      audience: guide.audience,
    });
    if (checked.problems.length) throw new Error(checked.problems.join("\n"));
    writeJson(file, next);
    log(`Wrote ${file}`);
    return 0;
  } catch (e) {
    error(e.message);
    return e.exitCode ?? 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
