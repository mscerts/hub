#!/usr/bin/env node
/**
 * Clone or fast-forward the mscerts/learnsync research cache into .course-runs/learnsync (gitignored) and verify
 * that all six catalog and documentation cache files required by the course pipeline are present and non-empty.
 *
 *   node scripts/learnsync-sync.mjs [--dir DIR] [--repo URL] [--check]
 *
 * Exit code: 0 ready, 1 cache incomplete after sync/check, 2 usage or git error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LEARNSYNC_REPO =
  "https://github.com/mscerts/learnsync.git";
export const REQUIRED_CACHE_FILES = [
  "data/learn-catalog.json",
  "data/module-links.json",
  "data/docs-catalog.json",
  "data/docs-urls.txt",
  "data/docs-redirects.json",
  "data/docs-toc.json",
];

const USAGE = `Usage: node scripts/learnsync-sync.mjs [--dir DIR] [--repo URL] [--check]`;

function parseArgs(argv) {
  const options = {
    dir: null,
    repo: DEFAULT_LEARNSYNC_REPO,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--dir" || arg === "--repo") {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

/** Verify that all six learnsync cache files exist and are non-empty. */
export function checkLearnsyncCaches(dir) {
  const missing = [];
  const present = [];
  for (const rel of REQUIRED_CACHE_FILES) {
    const full = join(dir, rel);
    if (!existsSync(full)) {
      missing.push(`${rel} (missing)`);
      continue;
    }
    const size = statSync(full).size;
    if (size === 0) {
      missing.push(`${rel} (empty)`);
      continue;
    }
    present.push({ file: rel, bytes: size });
  }
  return { ok: missing.length === 0, missing, present };
}

function defaultRunGit(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

export async function main(argv, deps = {}) {
  const {
    root = repoRoot,
    env = process.env,
    log = console.log,
    error = console.error,
    runGit = defaultRunGit,
  } = deps;
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }

  const targetDir = resolve(
    options.dir ?? env.LEARNSYNC_DIR ?? join(root, ".course-runs", "learnsync"),
  );

  if (!options.check) {
    try {
      if (existsSync(join(targetDir, ".git"))) {
        log(`Updating learnsync in ${targetDir}...`);
        runGit(["-C", targetDir, "pull", "--ff-only"], root);
      } else {
        mkdirSync(dirname(targetDir), { recursive: true });
        log(`Cloning ${options.repo} into ${targetDir}...`);
        runGit(["clone", "--depth", "1", options.repo, targetDir], root);
      }
    } catch (e) {
      error(`Git sync failed for ${targetDir}: ${e.message}`);
      return 2;
    }
  }

  const check = checkLearnsyncCaches(targetDir);
  if (!check.ok) {
    error(
      `learnsync cache in ${targetDir} is incomplete:\n  ${check.missing.join("\n  ")}`,
    );
    return 1;
  }
  const totalMb = (
    check.present.reduce((sum, f) => sum + f.bytes, 0) /
    (1024 * 1024)
  ).toFixed(1);
  log(
    `learnsync ready at ${targetDir} (${check.present.length}/${REQUIRED_CACHE_FILES.length} cache files, ${totalMb} MB).`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exit(await main(process.argv.slice(2)));
}
