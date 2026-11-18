import { access, readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function walkHtmlFiles(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "pagefind" || ent.name === "_astro") continue;
      await walkHtmlFiles(full, out);
    } else if (ent.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

function collectLocalJsonLdImages(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectLocalJsonLdImages(item, out);
    return out;
  }
  if (typeof value.image === "string") out.push(value.image);
  else if (Array.isArray(value.image)) {
    for (const img of value.image) {
      if (typeof img === "string") out.push(img);
      else if (img && typeof img.url === "string") out.push(img.url);
    }
  } else if (value.image && typeof value.image.url === "string") {
    out.push(value.image.url);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object")
      collectLocalJsonLdImages(child, out);
  }
  return out;
}

/**
 * Verify across a built `dist/` tree that:
 * 1. Every internal `#fragment` link resolves to an actual `id="..."` on the target HTML page.
 * 2. Every `https://msfthub.com/...` image referenced in `<meta property="og:image">`,
 *    `<meta name="twitter:image">`, or JSON-LD structured data exists in `dist/`.
 */
export async function verifyBuiltHtmlAnchorsAndAssets(
  distDir,
  siteOrigin = "https://msfthub.com",
) {
  const htmlFiles = await walkHtmlFiles(distDir);
  const pageByRoute = new Map();

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    // Skip Astro's generated `<meta http-equiv="refresh">` redirect stub files.
    if (/http-equiv=["']refresh["']/i.test(html) && !/<main\b/i.test(html)) {
      continue;
    }
    const rel =
      "/" +
      relative(distDir, file)
        .replace(/\\/g, "/")
        .replace(/(^|\/)index\.html$/, "$1");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    pageByRoute.set(rel, { file, html, ids });
  }

  const errors = [];

  for (const [route, { html }] of pageByRoute) {
    // 1. Check internal `#fragment` links
    for (const m of html.matchAll(/<a\b[^>]*?\bhref="([^"]*#[^"]+)"/gi)) {
      const rawHref = m[1].replaceAll("&amp;", "&");
      if (
        /^(?:https?:)?\/\//i.test(rawHref) &&
        !rawHref.startsWith(siteOrigin)
      ) {
        continue;
      }
      const localRef = rawHref.startsWith(siteOrigin)
        ? rawHref.slice(siteOrigin.length) || "/"
        : rawHref;
      const hashIdx = localRef.indexOf("#");
      if (hashIdx === -1) continue;
      const rawPath = localRef.slice(0, hashIdx).split("?")[0];
      const rawFrag = localRef.slice(hashIdx + 1);
      if (!rawFrag) continue;

      let fragment = rawFrag;
      try {
        fragment = decodeURIComponent(rawFrag);
      } catch {
        // Leave malformed percent-encoding as-is so the id lookup fails explicitly.
      }

      const targetRoute = !rawPath
        ? route
        : rawPath.endsWith("/") || /\.[a-z0-9]+$/i.test(rawPath)
          ? rawPath
          : `${rawPath}/`;
      const target = pageByRoute.get(targetRoute);
      if (!target) {
        errors.push(
          `${route}: anchor link "${rawHref}" targets missing page "${targetRoute}"`,
        );
        continue;
      }
      if (!target.ids.has(fragment)) {
        errors.push(
          `${route}: anchor link "${rawHref}" targets missing id="#${fragment}" on "${targetRoute}"`,
        );
      }
    }

    // 2. Check og:image, twitter:image, and JSON-LD local image URLs
    const assetUrls = [];
    for (const m of html.matchAll(
      /<meta\b[^>]*?(?:property|name)="(?:og:image|twitter:image)"[^>]*?\bcontent="([^"]+)"|<meta\b[^>]*?\bcontent="([^"]+)"[^>]*?(?:property|name)="(?:og:image|twitter:image)"/gi,
    )) {
      assetUrls.push(m[1] ?? m[2]);
    }
    for (const m of html.matchAll(
      /<script\b[^>]*?type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
    )) {
      try {
        const data = JSON.parse(m[1]);
        collectLocalJsonLdImages(data, assetUrls);
      } catch {
        errors.push(`${route}: invalid JSON-LD script payload`);
      }
    }

    for (const assetUrl of assetUrls) {
      if (!assetUrl?.startsWith(siteOrigin)) continue;
      const pathname = new URL(assetUrl).pathname;
      try {
        await access(join(distDir, pathname.replace(/^\//, "")));
      } catch {
        errors.push(
          `${route}: metadata/JSON-LD image "${assetUrl}" does not exist in dist/`,
        );
      }
    }
  }

  return { checkedPages: pageByRoute.size, errors };
}

export async function verifyPublicRoutes(
  distDir = fileURLToPath(new URL("../dist", import.meta.url)),
) {
  const read = (p) => readFile(join(distDir, p), "utf8");
  const [index, sitemap, redirects] = await Promise.all([
    read("certs/index.html"),
    read("sitemap-0.xml"),
    read("_redirects"),
  ]);
  assert.match(index, /Microsoft Exam Study Materials/);
  for (const area of [
    "azure",
    "github",
    "aibusiness",
    "dynamics",
    "microsoft365",
    "power",
    "security",
  ]) {
    assert.match(
      index,
      new RegExp(`href="/certs/${area}/[^"/]+/"`),
      `missing ${area} exam listing`,
    );
  }
  assert.doesNotMatch(sitemap, /<loc>[^<]*\/(?:wiki|wiki-next)\//);
  assert.doesNotMatch(sitemap, /<loc>[^<]*\/certs\/guide\/markdown\//);
  const rules = new Map(
    redirects
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/).slice(0, 2)),
  );
  for (const [source, target] of [
    ["/azure/az-104/", "/certs/azure/az-104/"],
    ["/azure/az-104.md", "/certs/azure/az-104.md"],
    ["/wiki/azure/az-104.md", "/certs/azure/az-104.md"],
    ["/wiki/", "/certs/"],
    ["/vouchers/ab650beta/", "/certs/archive/vouchers/ab650beta/"],
  ])
    assert.equal(rules.get(source), target, source);
  assert.ok(
    rules.size <= 2000,
    "Cloudflare Pages permits at most 2000 static redirects",
  );
  for (const target of new Set(rules.values())) {
    if (!target.startsWith("/")) continue;
    const file = target.endsWith("/") ? `${target}index.html` : target;
    await access(join(distDir, file.replace(/^\//, "")));
  }
  for (const [, href] of index.matchAll(/href="(\/certs\/[^"?#]+\/)"/g)) {
    await access(join(distDir, `${href.replace(/^\//, "")}index.html`));
  }

  const { checkedPages, errors } =
    await verifyBuiltHtmlAnchorsAndAssets(distDir);
  assert.deepEqual(errors, []);

  console.log(
    `Verified exam index, sitemap exclusions, ${checkedPages} HTML pages' anchors/assets, and ${rules.size} deployment redirects.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await verifyPublicRoutes();
}
