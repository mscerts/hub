// Helpers for the tests of the older monitors (voucher-challenge-sync,
// beta-exam-check and applied-skills-sync): the real script runs in a child
// process against a local fake of Microsoft Learn, and the test reads back what
// the workflow would see (the GITHUB_OUTPUT keys, the report, the error file).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * A local HTTP server. `route(path, { status, body, type })` sets what a path
 * answers (anything else is a 404); `hits` lists the paths asked, in order.
 */
export async function startServer() {
  const routes = new Map();
  const hits = [];
  const server = createServer((request, response) => {
    const path = request.url.split("?")[0];
    hits.push(path);
    const route = routes.get(path);
    response.statusCode = route ? (route.status ?? 200) : 404;
    response.setHeader("content-type", route?.type ?? "text/html");
    response.end(route ? (route.body ?? "") : "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    hits,
    route: (path, route) => routes.set(path, route),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const readIfThere = (file) =>
  existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;

/** The `key=value` lines of a GITHUB_OUTPUT file as an object. */
export function readOutputs(file) {
  const outputs = {};
  for (const line of (readIfThere(file) ?? "").split("\n").filter(Boolean)) {
    const at = line.indexOf("=");
    outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

/**
 * Runs a monitor script the way the workflow does and reads back what it wrote.
 * `dir` holds the output, report and error files of the run (they are removed
 * before each run), `env` is what every run gets, `execArgv` goes to node before
 * the script. The environment of the test process is passed on, except what a
 * GitHub runner sets: it must not change what a script writes.
 */
export function monitorRunner({ script, dir, env = {}, execArgv = [] }) {
  const files = {
    output: join(dir, "github-output"),
    report: join(dir, "report.md"),
    error: join(dir, "error.md"),
  };
  return {
    files,
    run: (extraEnv = {}) => {
      for (const file of Object.values(files)) rmSync(file, { force: true });
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [...execArgv, script], {
          env: {
            ...process.env,
            GITHUB_ACTIONS: "",
            ...env,
            GITHUB_OUTPUT: files.output,
            REPORT_FILE: files.report,
            ERROR_FILE: files.error,
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) =>
          resolve({
            code,
            stdout,
            stderr,
            outputs: readOutputs(files.output),
            report: readIfThere(files.report),
            error: readIfThere(files.error),
          }),
        );
      });
    },
  };
}
