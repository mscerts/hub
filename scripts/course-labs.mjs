#!/usr/bin/env node
/**
 * The hands-on pages a course leaves out, against the exam's lab page (docs/course-labs.md).
 *
 *   node scripts/course-labs.mjs <CODE> --routing FILE [--lab FILE]
 *       Reads the routing file that scripts/course-build.mjs writes beside the course file (FILE.routing.json:
 *       every accepted exercise, simulation, guided project, tutorial and quickstart, which a course does not
 *       show because the lab page collects them) and the exam's lab page (default
 *       src/content/docs/labs/<area>/<code>.mdx). Prints the pages the lab page already has and, for every page
 *       it lacks, the LinkCard to add, grouped by the domain of the study guide and by the lab page's tabs.
 *       It changes nothing: a lab page's layout differs from exam to exam, so a person places the cards.
 *
 * Exit code: 0 the report was printed, 2 usage or input error (no routing file, no lab page).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AREA_BY_PREFIX } from "./lib/areas.mjs";
import {
  cardLine,
  cardTitle,
  compareWithLabPage,
  tabLabels,
} from "./lib/course-labs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-labs.mjs <CODE> --routing FILE [--lab FILE]`;

function parseArgs(argv) {
  const options = { code: null, routing: null, lab: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--routing", "--lab"].includes(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  if (!options.code) throw new Error("An exam code is required");
  if (!options.routing) throw new Error("--routing FILE is required");
  return options;
}

/** The lab page of an exam, or null when the exam code has no area. */
export function labPageFile(code, root = repoRoot) {
  const area = AREA_BY_PREFIX[code.split("-")[0]];
  return area
    ? join(root, "src", "content", "docs", "labs", area, `${code.toLowerCase()}.mdx`)
    : null;
}

/** The command line, dependencies injectable. Returns the exit code. */
export function main(argv, deps = {}) {
  const { log = console.log, error = console.error, root = repoRoot } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  let routing;
  try {
    routing = JSON.parse(readFileSync(resolve(options.routing), "utf8"));
  } catch (e) {
    error(`Cannot read the routing file ${options.routing}: ${e.message}`);
    return 2;
  }
  if (routing.kind !== "routing" || !Array.isArray(routing.handsOn)) {
    error(`${options.routing} is not a routing file.`);
    return 2;
  }
  if (routing.code !== options.code) {
    error(`${options.routing} is for ${routing.code}, not ${options.code}.`);
    return 2;
  }
  const labFile = options.lab
    ? resolve(options.lab)
    : labPageFile(options.code, root);
  if (!labFile || !existsSync(labFile)) {
    error(
      `${options.code} has no lab page${labFile ? ` (${labFile})` : ""}: create one first (AGENTS.md, Lab Pages), then run this again.`,
    );
    return 2;
  }
  const mdx = readFileSync(labFile, "utf8");
  const { present, missing } = compareWithLabPage({
    handsOn: routing.handsOn,
    mdx,
  });
  log(
    `${options.code}: ${routing.handsOn.length} hands-on pages were accepted for the course; ${present.length} are on the lab page already, ${missing.length} are missing.`,
  );
  log(`Lab page: ${labFile}`);
  log(`Its tabs: ${tabLabels(mdx).join(", ")}`);
  let domain = null;
  for (const entry of missing) {
    if (entry.domain !== domain) {
      domain = entry.domain;
      log(`\n# ${domain}`);
    }
    log(`${cardLine(entry)}   <!-- ${entry.reason}; ${entry.kind} -->`);
  }
  if (missing.length) {
    const byReason = {};
    for (const e of missing) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    log(
      `\nMissing by kind: ${Object.entries(byReason)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}. Titles are written like the lab page's (${cardTitle(missing[0])}).`,
    );
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
