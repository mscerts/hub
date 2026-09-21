import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { linkRel } from "../../src/utils/link-rel.ts";
import { resolveIcon } from "../../src/components/ui/icons/resolve-icon.ts";

const root = resolve(import.meta.dirname, "../..");

test("blank links receive safe relation tokens", () => {
  assert.equal(linkRel("_blank"), "noopener noreferrer");
  assert.equal(
    linkRel("_BLANK", "external opener"),
    "external noopener noreferrer",
  );
  assert.equal(linkRel("_self", "external"), "external");
});

test("icon lookup rejects unknown names", () => {
  assert.ok(resolveIcon("github").paths.length > 0);
  assert.throws(() => resolveIcon("not-a-real-icon"), /Unknown icon/);
});

function run(script, env) {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
}

async function fixtureServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("sitemap validator checks the local build and rejects broken pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sitemap-test-"));
  const index = join(dir, "sitemap-index.xml");
  const report = join(dir, "report.md");
  const output = join(dir, "output");
  await writeFile(
    index,
    "<sitemapindex><sitemap><loc>https://msfthub.com/sitemap-0.xml</loc></sitemap></sitemapindex>",
  );
  let broken = false;
  const server = await fixtureServer((request, response) => {
    if (request.url === "/sitemap-0.xml")
      return response.end(
        "<urlset><url><loc>https://msfthub.com/page/</loc></url></urlset>",
      );
    response.statusCode = broken ? 404 : 200;
    response.end("ok");
  });
  try {
    const env = {
      SITEMAP_INDEX: index,
      REPORT: report,
      GITHUB_OUTPUT: output,
      CHECK_ORIGIN: server.origin,
    };
    assert.equal((await run("scripts/sitemap-check.sh", env)).code, 0);
    broken = true;
    await writeFile(output, "");
    assert.equal((await run("scripts/sitemap-check.sh", env)).code, 1);
    assert.match(await readFile(output, "utf8"), /has_issues=true/);
  } finally {
    await server.close();
  }
});

test("MeasureUp rejects malformed product data without changing its baseline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "measureup-test-"));
  const baseline = join(dir, "baseline.json");
  const output = join(dir, "output");
  const error = join(dir, "error.md");
  const server = await fixtureServer((_request, response) => {
    response.end(
      'toolbar-number">1\ntoolbar-number">1\ntoolbar-number">1\n<script>var dl4Objects = [invalid];</script>',
    );
  });
  try {
    const result = await run("scripts/measureup-check.sh", {
      BASE_URL: server.origin,
      BASELINE_FILE: baseline,
      TEMP_DIR: join(dir, "scan"),
      REPORT_FILE: join(dir, "report.md"),
      ERROR_FILE: error,
      GITHUB_OUTPUT: output,
      MIN_PRODUCTS: "1",
    });
    assert.equal(result.code, 1);
    assert.match(await readFile(output, "utf8"), /extraction_failed=true/);
    assert.match(await readFile(error, "utf8"), /malformed/);
  } finally {
    await server.close();
  }
});
