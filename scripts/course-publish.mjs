#!/usr/bin/env node
/**
 * Publish a built Study Guide Course into the repository in one verified step:
 *   1. Refuses an unreviewed build (non-empty <source>.review.json) unless --allow-review is given.
 *   2. Validates the course file against the stored study guide and learnsync (--live by default; --offline skips
 *      live HTTP probes). Never overwrites src/data_files/courses/<CODE>.json if validation fails.
 *   3. Copies the validated course file to src/data_files/courses/<CODE>.json (when --from or --run-dir is given).
 *   4. Renders src/content/docs/courses/<code-lower>.mdx.
 *   5. Deletes any leftover src/content/docs/courses/<code-lower>-review.mdx.
 *   6. Adds and verifies the <CODE> Study Guide Course LinkCard on the exam page.
 *
 *   node scripts/course-publish.mjs <CODE> [--from FILE] [--run-dir DIR] [--offline] [--allow-review]
 *
 * Exit code: 0 published, 1 validation or review check failed, 2 usage or input error.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cardStatus,
  coursePath,
  examPages,
  withCard,
} from "./course-cards.mjs";
import { main as courseFileMain } from "./course-file.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: node scripts/course-publish.mjs <CODE> [--from FILE] [--run-dir DIR] [--offline] [--allow-review]`;

function parseArgs(argv) {
  const options = {
    code: null,
    from: null,
    runDir: null,
    offline: false,
    allowReview: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--offline") options.offline = true;
    else if (arg === "--allow-review") options.allowReview = true;
    else if (arg === "--from" || arg === "--run-dir") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      const key = arg === "--run-dir" ? "runDir" : "from";
      options[key] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (options.code) throw new Error("Only one exam code can be given");
    else options.code = arg.toUpperCase();
  }
  if (!options.code || !/^[A-Z]{2,3}-\d{3}$/.test(options.code)) {
    throw new Error("A valid exam code (for example AB-650) is required");
  }
  return options;
}

export async function main(argv, deps = {}) {
  const {
    root = repoRoot,
    env = process.env,
    log = console.log,
    error = console.error,
    verdictsFor,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }

  const code = options.code;
  const slug = code.toLowerCase();
  const destJson = join(root, "src", "data_files", "courses", `${code}.json`);
  const sourceJson = options.from
    ? resolve(options.from)
    : options.runDir
      ? resolve(join(options.runDir, "build", `${code}.json`))
      : destJson;

  if (!existsSync(sourceJson)) {
    error(`Course file not found: ${sourceJson}`);
    return 2;
  }

  const reviewSidecar = `${sourceJson}.review.json`;
  const altReviewSidecar = sourceJson.replace(/\.json$/, ".review.json");
  const activeReviewFile = existsSync(altReviewSidecar)
    ? altReviewSidecar
    : existsSync(reviewSidecar)
      ? reviewSidecar
      : null;
  if (activeReviewFile && !options.allowReview) {
    const reviewData = JSON.parse(readFileSync(activeReviewFile, "utf8"));
    if (Array.isArray(reviewData.picks) && reviewData.picks.length > 0) {
      error(
        `${code}: ${reviewData.picks.length} undecided orange review pick(s) remain in ${activeReviewFile}. Run 'node scripts/course-gates.mjs review ${code} --drop ...', gate, and rebuild before publishing (or pass --allow-review).`,
      );
      return 1;
    }
  }

  const validateArgs = [
    "validate",
    sourceJson,
    ...(options.offline ? [] : ["--live"]),
  ];
  const valCode = await courseFileMain(validateArgs, {
    root,
    env,
    log,
    error,
    verdictsFor,
  });
  if (valCode !== 0) return valCode;

  if (resolve(sourceJson) !== resolve(destJson)) {
    const parsed = JSON.parse(readFileSync(sourceJson, "utf8"));
    mkdirSync(dirname(destJson), { recursive: true });
    writeFileSync(destJson, `${JSON.stringify(parsed, null, 2)}\n`);
    log(`Copied ${sourceJson} -> ${destJson}`);
  }

  const outMdx = join(root, "src", "content", "docs", "courses", `${slug}.mdx`);
  const renderCode = await courseFileMain(["render", code, "--out", outMdx], {
    root,
    env,
    log,
    error,
    verdictsFor,
  });
  if (renderCode !== 0) return renderCode;

  const reviewMdx = join(
    root,
    "src",
    "content",
    "docs",
    "courses",
    `${slug}-review.mdx`,
  );
  if (existsSync(reviewMdx)) {
    rmSync(reviewMdx);
    log(`Removed temporary review page ${reviewMdx}`);
  }

  const pages = examPages(root);
  const examFile = pages.get(code);
  if (!examFile) {
    error(
      `${code}: no exam page found under src/content/docs/<area>/${code}.mdx`,
    );
    return 1;
  }
  const before = readFileSync(examFile, "utf8");
  const statusBefore = cardStatus(before, code);
  if (statusBefore === "missing") {
    writeFileSync(examFile, withCard(before, code));
    log(`Added ${code} Study Guide Course card to ${examFile}`);
  }
  const statusAfter = cardStatus(readFileSync(examFile, "utf8"), code);
  if (statusAfter !== "ok") {
    error(
      `${code}: Study Guide Course card status on ${examFile} is '${statusAfter}' (fix placement by hand).`,
    );
    return 1;
  }

  const routesFile = join(root, "src", "data_files", "public-routes.json");
  const route = coursePath(code);
  if (existsSync(routesFile)) {
    const routesData = JSON.parse(readFileSync(routesFile, "utf8"));
    const routesList = Array.isArray(routesData)
      ? routesData
      : (routesData.routes ?? []);
    if (!routesList.includes(route)) {
      log(
        `Note: ${route} is not in src/data_files/public-routes.json yet: run 'pnpm exec astro build --force && node scripts/verify-route-manifest.mjs --update' before committing.`,
      );
    }
  }

  log(`${code}: published ${destJson} and ${outMdx}.`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exit(await main(process.argv.slice(2)));
}
