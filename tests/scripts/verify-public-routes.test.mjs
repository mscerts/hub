import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyBuiltHtmlAnchorsAndAssets } from "../../scripts/verify-public-routes.mjs";

function makeScratchDist(files) {
  const dir = mkdtempSync(join(tmpdir(), "verify-public-routes-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("verifyBuiltHtmlAnchorsAndAssets passes valid anchors and existing OG/JSON-LD images", async () => {
  const dist = makeScratchDist({
    "_astro/social.png": "png",
    "index.html": `<!DOCTYPE html><html><head>
      <meta property="og:image" content="https://msfthub.com/_astro/social.png">
      <script type="application/ld+json">{"@type":"WebSite","image":"https://msfthub.com/_astro/social.png"}</script>
    </head><body><main><h1 id="welcome">Welcome</h1><a href="/guide/#section-one">Read</a></main></body></html>`,
    "guide/index.html": `<!DOCTYPE html><html><body><main><h2 id="section-one">Section</h2><a href="#section-one">Self</a></main></body></html>`,
    "old/index.html": `<!DOCTYPE html><meta http-equiv="refresh" content="0;url=/guide/">`,
  });
  try {
    const res = await verifyBuiltHtmlAnchorsAndAssets(dist);
    assert.equal(res.checkedPages, 2);
    assert.deepEqual(res.errors, []);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("verifyBuiltHtmlAnchorsAndAssets catches missing #fragment ids and missing JSON-LD /social.png images", async () => {
  const dist = makeScratchDist({
    "news/index.html": `<!DOCTYPE html><html><head>
      <script type="application/ld+json">{"@type":"Blog","blogPost":[{"image":"https://msfthub.com/social.png"}]}</script>
    </head><body><main><a href="/guide/#wrong-anchor">Broken hash</a></main></body></html>`,
    "guide/index.html": `<!DOCTYPE html><html><body><main><h2 id="real-anchor">Real</h2></main></body></html>`,
  });
  try {
    const { errors } = await verifyBuiltHtmlAnchorsAndAssets(dist);
    assert.equal(errors.length, 2);
    assert.match(errors.join("\n"), /missing id="#wrong-anchor"/);
    assert.match(errors.join("\n"), /social\.png.*does not exist in dist/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
