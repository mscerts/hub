// A scratch GitHub for the tests that run a workflow's bash step for real: a bare
// "origin", the work tree a runner would have checked out, and a second clone for
// the pushes that land meanwhile. It exists because of three portability bugs found
// on Linux CI, on Windows and in hardened git setups:
//   findBash           on Windows `bash` on PATH may be the WSL launcher, which
//                      cannot run a git that pushes to a Windows path
//   rejectFirstPushes  the hook has to be executable, or Linux git skips it
//                      silently and the push goes through
//   gitDir             a bare repository is inspected with --git-dir, never from
//                      inside it (safe.bareRepository=explicit refuses that)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

const pathVariable = (env) =>
  Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ??
  "";

/**
 * process.env plus `extra`; a value of undefined removes the variable. Variable
 * names are case-insensitive on Windows (`Path` is `PATH`): an override replaces
 * the existing spelling instead of adding a second one.
 */
function mergeEnv(extra = {}) {
  const merged = { ...process.env };
  for (const [name, value] of Object.entries(extra)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(merged)) {
        if (existing.toUpperCase() === name.toUpperCase()) {
          delete merged[existing];
        }
      }
    }
    merged[name] = value;
  }
  return merged;
}

/** Runs a program to its end: { code, stdout, stderr }. It never throws; a program that cannot start has code -1. */
export function exec(
  cwd,
  command,
  args = [],
  env = {},
  { timeout = 120_000 } = {},
) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env: mergeEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      done({ code: -1, stdout, stderr: `${stderr}${error}` }),
    );
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * What to add to the environment of `bash`. On Windows that is Git for Windows'
 * own folders first, as in a Git Bash window: sh, sleep and git are found there
 * even when the PATH of the process does not list them.
 */
function bashEnv(bash, platform = process.platform) {
  if (platform !== "win32" || !/[\\/]bin[\\/]bash\.exe$/i.test(bash)) return {};
  const gitRoot = win32.dirname(win32.dirname(bash));
  return {
    PATH: [
      win32.join(gitRoot, "usr", "bin"),
      win32.join(gitRoot, "bin"),
      pathVariable(process.env),
    ].join(";"),
  };
}

function bashRuns(bash) {
  const result = spawnSync(bash, ["-c", "git --version"], {
    env: mergeEnv(bashEnv(bash)),
    windowsHide: true,
    timeout: 30_000,
  });
  return result.status === 0;
}

// Git for Windows keeps git.exe in <root>\cmd, <root>\bin or <root>\mingw64\bin
// and bash.exe in <root>\bin.
function gitRootOf(gitExe) {
  const folder = win32.dirname(gitExe);
  const parent = win32.dirname(folder);
  return /^mingw(32|64)$/i.test(win32.basename(parent))
    ? win32.dirname(parent)
    : parent;
}

/**
 * A bash that can run a workflow's `run:` script against the paths of this
 * machine, or null when there is none (the caller then SKIPS its tests and says
 * why; it must never pass without running them).
 *
 * Linux and macOS: `bash` from PATH. Windows: Git for Windows' bash.exe, looked
 * for next to the git.exe on PATH (<root>\cmd\git.exe -> <root>\bin\bash.exe) and
 * then in the usual install folders. `bash` on PATH is not used there: it is
 * usually C:\Windows\System32\bash.exe, the WSL launcher, which runs a Linux git
 * that cannot push to a Windows path ("ssh: Could not resolve hostname c").
 * A bash is only returned when it runs `git --version`.
 */
export function findBash({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  works = bashRuns,
} = {}) {
  if (platform !== "win32") return works("bash") ? "bash" : null;
  const candidates = [];
  for (const entry of pathVariable(env).split(";")) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (folder === "") continue;
    const gitExe = win32.join(folder, "git.exe");
    if (exists(gitExe)) {
      candidates.push(win32.join(gitRootOf(gitExe), "bin", "bash.exe"));
    }
  }
  for (const base of [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
    "C:\\Program Files",
  ]) {
    if (base) candidates.push(win32.join(base, "Git", "bin", "bash.exe"));
  }
  if (env.LOCALAPPDATA) {
    candidates.push(
      win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    );
  }
  for (const candidate of new Set(candidates)) {
    if (exists(candidate) && works(candidate)) return candidate;
  }
  return null;
}

/** The value for node:test's `skip` option: false when a bash was found, otherwise the reason. */
export function bashSkipReason(bash) {
  return bash
    ? false
    : "no bash that runs git was found (Windows: Git for Windows' bash.exe next to git.exe; elsewhere: bash on PATH), so the workflow steps cannot be run";
}

/** Runs a script the way the Actions runner runs a `run:` step: `bash -e`, no profile. */
export function runBash(bash, script, { cwd, env = {} }) {
  return exec(cwd, bash, ["--noprofile", "--norc", "-e", "-c", script], {
    ...bashEnv(bash),
    ...env,
  });
}

const IDENTITY = [
  "-c",
  "user.name=scratch",
  "-c",
  "user.email=scratch@example.com",
];

/**
 * A bare origin, a work tree cloned from it (with `files` committed as "init" and
 * pushed) and, with `withOther`, a second clone for concurrent pushes. Every git
 * command of the scratch runs with a clean configuration: nothing from the
 * developer's git setup (signing, hooks, aliases, autocrlf), bare repositories
 * only through --git-dir (safe.bareRepository=explicit, so a test that looks into
 * the origin from inside it fails everywhere and not only on hardened machines),
 * and no network protocol (a step that does reach for github.com fails at once).
 * The returned object also holds `env` (the environment to run steps with) and
 * helpers that read the origin with --git-dir. Call `cleanup()` when done.
 */
export async function makeScratchRemote({
  prefix = "scratch-remote-",
  branch = "main",
  files = { "README.md": "init\n" },
  message = "init",
  withOther = true,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const other = join(dir, "other");
  const gitconfig = join(dir, "gitconfig");
  await writeFile(gitconfig, "[safe]\n\tbareRepository = explicit\n");
  const env = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    // Left over when the tests run inside a git hook: they would point every git
    // command at the repository that is committing.
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_PREFIX: undefined,
    GIT_NAMESPACE: undefined,
  };
  const git = async (cwd, ...args) => {
    const result = await exec(cwd, "git", args, env);
    assert.equal(
      result.code,
      0,
      `git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ${result.stderr.trim()}`,
    );
    return result.stdout.trim();
  };
  const write = async (root, path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };

  await git(dir, "init", "--bare", "-b", branch, origin);
  await git(dir, "init", "-b", branch, work);
  for (const [path, content] of Object.entries(files)) {
    await write(work, path, content);
  }
  await git(work, "add", ".");
  await git(work, ...IDENTITY, "commit", "-m", message);
  await git(work, "remote", "add", "origin", origin);
  await git(work, "push", "-u", "origin", branch);
  if (withOther) await git(dir, "clone", origin, other);

  const remote = {
    dir,
    origin,
    work,
    other,
    branch,
    env,
    gitconfig,
    git,
    write,
    // A temporary folder that cannot be removed (a virus scanner holds a file on
    // Windows) is no reason to fail a test that passed.
    cleanup: () =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }).catch(() => {}),
    /** Sets a key of the scratch's own git configuration (the "global" one every command reads). */
    config: (key, value) => git(dir, "config", "--file", gitconfig, key, value),
    /** Sends everything that is fetched from or pushed to `url` to the origin instead (a step that points `origin` at github.com). */
    redirect: (url) => remote.config(`url.${origin}.insteadOf`, url),
    subjects: async (ref = branch) =>
      (await gitDir(remote, "log", "--format=%s", ref)).split("\n"),
    /** The files the newest commit of the origin changes. */
    changedFiles: async (ref = branch) => {
      const names = await gitDir(
        remote,
        "show",
        "--name-only",
        "--format=",
        ref,
      );
      return names === "" ? [] : names.split("\n");
    },
    /** Every file of the origin's branch. */
    files: async (ref = branch) =>
      (await gitDir(remote, "ls-tree", "-r", "--name-only", ref)).split("\n"),
    show: (path, ref = branch) => gitDir(remote, "show", `${ref}:${path}`),
    /** Someone else pushes to the branch after the work tree was checked out. */
    concurrentPush: async (
      path = "elsewhere.txt",
      content = "from another clone\n",
      subject = "elsewhere",
    ) => {
      await git(other, "pull", "--rebase");
      await write(other, path, content);
      await git(other, "add", ".");
      await git(other, ...IDENTITY, "commit", "-m", subject);
      await git(other, "push", "origin", branch);
    },
  };
  return remote;
}

/**
 * git against the bare origin: `git --git-dir=<origin> ...`, run from the
 * scratch directory and never from inside the bare repository, which a hardened
 * git (safe.bareRepository=explicit) refuses to use. Returns the trimmed output
 * and fails the test when git fails.
 */
export function gitDir(remote, ...args) {
  return remote.git(remote.dir, `--git-dir=${remote.origin}`, ...args);
}

const shellQuote = (path) =>
  `'${(process.platform === "win32" ? path.replace(/\\/g, "/") : path).replace(/'/g, `'\\''`)}'`;

const attemptsFile = (remote) => join(remote.dir, "push-attempts");

/** How many pushes the origin has seen since rejectFirstPushes (rejected or not). */
export async function pushAttempts(remote) {
  return Number((await readFile(attemptsFile(remote), "utf8")).trim());
}

/**
 * Makes the origin reject its first `count` pushes (and count every push), like a
 * push that landed on main between the rebase and ours. The hook is a pre-receive
 * script; it MUST be executable: without the exec bit Linux git ignores it
 * silently, nothing is rejected and a test that expects the rejection fails only
 * on Linux. So it is written with mode 0o755 and chmod-ed afterwards (the mode of
 * writeFile is cut by the umask and ignored for a file that already exists).
 */
export async function rejectFirstPushes(remote, count) {
  const hook = join(remote.origin, "hooks", "pre-receive");
  await mkdir(dirname(hook), { recursive: true });
  await writeFile(attemptsFile(remote), "0\n");
  const script = [
    "#!/bin/sh",
    `counter=${shellQuote(attemptsFile(remote))}`,
    "n=0",
    '[ -f "$counter" ] && read -r n < "$counter"',
    "n=$((n + 1))",
    'echo "$n" > "$counter"',
    `if [ "$n" -le ${count} ]; then`,
    `  echo "push $n rejected by the scratch remote (it rejects the first ${count})" >&2`,
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(hook, script, { mode: 0o755 });
  await chmod(hook, 0o755);
  if (process.platform !== "win32") {
    assert.ok(
      statSync(hook).mode & 0o111,
      `${hook} is not executable: git would skip it without a word`,
    );
  }
}
