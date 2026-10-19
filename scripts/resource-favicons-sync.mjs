import { readdir, readFile, mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  download,
  faviconCandidates,
  normalizeFavicon,
} from "./lib/resource-favicons.mjs";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("src/data_files/resource-favicons.json", root);
const output = new URL("public/resource-favicons/", root);
const fallbackDomains = {
  "engagehub.microsoft.com": "www.microsoft.com",
  "get.pnpm.io": "pnpm.io",
  "images.unsplash.com": "unsplash.com",
  "microsoftlearning.github.io": "github.com",
  "tatrck.com": "eu2.mindhub.com",
  "trk.udemy.com": "www.udemy.com",
};

async function resourceDomains(directory) {
  const domains = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) {
      for (const domain of await resourceDomains(url)) domains.add(domain);
    } else if (/\.(?:mdx?|astro)$/.test(entry.name)) {
      const text = await readFile(url, "utf8");
      for (const [link] of text.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)) {
        const domain = new URL(link).hostname;
        if (
          domain.includes(".") &&
          !["msfthub.com", "www.msfthub.com"].includes(domain)
        )
          domains.add(domain);
      }
    }
  }
  return domains;
}

async function sync() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => !["--refresh", "--list", "--google-fallbacks"].includes(arg),
    )
  )
    throw new Error(
      "Usage: node scripts/resource-favicons-sync.mjs [--refresh] [--list] [--google-fallbacks]",
    );
  const domains = [
    ...(await resourceDomains(new URL("src/content/", root))),
  ].sort();
  if (args.includes("--list")) {
    console.log(domains.join("\n"));
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    manifest = {};
  }
  await mkdir(output, { recursive: true });
  let next = 0,
    fetched = 0,
    cached = 0,
    failed = 0;
  async function worker() {
    while (next < domains.length) {
      const domain = domains[next++];
      if (manifest[domain] && !args.includes("--refresh")) {
        try {
          await access(new URL(`public${manifest[domain].path}`, root));
          cached++;
          continue;
        } catch {
          /* Restore a missing cache file. */
        }
      }
      let candidates = [`https://${domain}/favicon.ico`];
      try {
        const page = await download(`https://${domain}/`, 512 * 1024);
        candidates = faviconCandidates(page.buffer.toString("utf8"), page.url);
      } catch {
        /* Some sites block homepage requests but still serve their icon. */
      }
      let lastError;
      // Always retain /favicon.ico, even when the homepage advertises many icons.
      for (const url of [
        ...new Set([...candidates.slice(0, 3), ...candidates.slice(-1)]),
      ]) {
        try {
          const icon = await download(url, 2 * 1024 * 1024);
          const png = await normalizeFavicon(icon.buffer);
          const hash = createHash("sha256")
            .update(png)
            .digest("hex")
            .slice(0, 16);
          const filename = `${domain}-${hash}.png`;
          await writeFile(new URL(filename, output), png);
          manifest[domain] = {
            path: `/resource-favicons/${filename}`,
            sourceUrl: icon.url,
          };
          fetched++;
          console.log(`Cached ${domain}`);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError && args.includes("--google-fallbacks")) {
        const fallbackHost = fallbackDomains[domain] ?? domain;
        if (manifest[fallbackHost] && !args.includes("--refresh")) {
          manifest[domain] = { ...manifest[fallbackHost] };
          fetched++;
          console.log(`Reused ${fallbackHost} icon for ${domain}`);
          lastError = undefined;
        } else {
          const googleUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(fallbackHost)}&sz=64`;
          try {
            const icon = await download(googleUrl, 2 * 1024 * 1024);
            const png = await normalizeFavicon(icon.buffer);
            const hash = createHash("sha256")
              .update(png)
              .digest("hex")
              .slice(0, 16);
            const filename = `${domain}-${hash}.png`;
            await writeFile(new URL(filename, output), png);
            manifest[domain] = {
              path: `/resource-favicons/${filename}`,
              sourceUrl: googleUrl,
            };
            fetched++;
            console.log(`Cached ${domain} from ${fallbackHost} favicon cache`);
            lastError = undefined;
          } catch (error) {
            lastError = error;
          }
        }
      }
      if (lastError) {
        failed++;
        console.warn(
          `Fallback for ${domain}: ${lastError.message.slice(0, 180)}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(manifestUrl, JSON.stringify(sorted, null, 2) + "\n");
  console.log(
    `Favicons: ${fetched} fetched, ${cached} already cached, ${failed} unavailable. Existing icons are retained on refresh failures.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sync().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
