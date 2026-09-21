#!/usr/bin/env node
/**
 * Weekly sync of the Microsoft Applied Skills cache.
 *
 * Usage:
 *   node scripts/applied-skills-sync.mjs
 *
 * Fetches the Applied Skills listing from Microsoft Learn, cross-references
 * it against the lab pages in this repo, and writes
 * src/data_files/applied-skills-cache.json grouped into three categories:
 *   - active   — listed on Microsoft Learn AND linked from a lab page.
 *   - new      — listed on Microsoft Learn but not linked from any lab page
 *                yet; needs to be added to the matching lab page(s).
 *   - retiring — no longer listed on Microsoft Learn but still linked from a
 *                lab page; needs to be removed from the matching lab page(s).
 * Entries carry an optional `retirementDate` (YYYY-MM-DD) when the Learn page
 * exposes one — a future date is an announced retirement, a past date means the
 * assessment is already retired.
 *
 * Promotion/drop rules applied each run:
 *   - "new" is promoted to "active" once a lab page links to it.
 *   - "active" or "new" becomes "retiring" once it disappears from the
 *     listing.
 *   - "retiring" becomes "active" again if it re-appears in the listing.
 *   - "retiring" is dropped from the cache once no lab page links to it
 *     anymore (nothing left to process).
 *
 * Env overrides (defaults shown):
 *   LISTING_URL           Applied Skills credential-browse API endpoint
 *   BASELINE_FILE         src/data_files/applied-skills-cache.json
 *   REPORT_FILE           <tmpdir>/applied-skills-report.md
 *   ERROR_FILE            <tmpdir>/applied-skills-error.md
 *   GITHUB_OUTPUT         <tmpdir>/github-output
 *   MIN_SKILLS            10
 *   MAX_RETIRED_PCT       50
 *   MAX_PAGE_FAILURE_PCT  50
 *   FETCH_DELAY_MS        500
 *
 * Writes GITHUB_OUTPUT keys: changes_found, baseline_updated, extraction_failed.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const LISTING_URL =
  process.env.LISTING_URL ??
  "https://learn.microsoft.com/api/contentbrowser/search/credentials?locale=en-us&%24filter=credential_types%2Fany(t%3A%20t%20eq%20'applied%20skills')&%24top=100";
const BASELINE_FILE = resolveFromRoot(
  process.env.BASELINE_FILE ?? "src/data_files/applied-skills-cache.json",
);
const REPORT_FILE =
  process.env.REPORT_FILE ?? join(tmpdir(), "applied-skills-report.md");
const ERROR_FILE =
  process.env.ERROR_FILE ?? join(tmpdir(), "applied-skills-error.md");
const GITHUB_OUTPUT =
  process.env.GITHUB_OUTPUT ?? join(tmpdir(), "github-output");

const MIN_SKILLS = Number(process.env.MIN_SKILLS ?? 10);
const MAX_RETIRED_PCT = Number(process.env.MAX_RETIRED_PCT ?? 50);
const MAX_PAGE_FAILURE_PCT = Number(process.env.MAX_PAGE_FAILURE_PCT ?? 50);
const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS ?? 500);

const PAGE_BASE = "https://learn.microsoft.com/credentials/applied-skills/";
const TRACKING = "?WT.mc_id=studentamb_165290";
const LABS_DIR = join(root, "src", "content", "docs", "labs");
const DOCS_DIR = join(root, "src", "content", "docs");
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function writeOutput(obj) {
  const lines = Object.entries(obj)
    .map(([key, value]) => `${key}=${String(value).toLowerCase()}\n`)
    .join("");
  appendFileSync(GITHUB_OUTPUT, lines);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  writeFileSync(ERROR_FILE, `${message}\n`);
  writeOutput({
    changes_found: false,
    baseline_updated: false,
    extraction_failed: true,
  });
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, { attempts = 3, retryOn404 = false } = {}) {
  let lastStatus;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text: await response.text(),
        };
      }

      if (response.status === 404 && !retryOn404) {
        return { ok: false, status: 404 };
      }

      lastStatus = response.status;
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${response.status})`,
      );
    } catch (error) {
      lastError = error;
      console.error(
        `WARNING: ${url} attempt ${attempt} failed (${error.message})`,
      );
    }

    if (attempt < attempts) await sleep(attempt * 5000);
  }

  return { ok: false, status: lastStatus, error: lastError };
}

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function slugFromUrl(url) {
  const match = url?.match(/applied-skills\/([^/?#"']+)/i);
  return match ? match[1].toLowerCase() : null;
}

function skillUrl(slug) {
  return `${PAGE_BASE}${slug}/${TRACKING}`;
}

function stripPrefix(title) {
  return title.replace(/^Microsoft Applied Skills:\s*/i, "").trim();
}

// Copied from audit-missing-resources.mjs to stay consistent with lab-page parsing.
function normalize(content) {
  return content.replace(/\r\n/g, "\n");
}

function isDraft(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  return frontmatter ? /^draft:\s*true\s*$/m.test(frontmatter[1]) : false;
}

function stripComments(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function sortByName(entries) {
  return [...entries].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, "en", { numeric: true });
    return byName !== 0
      ? byName
      : a.url.localeCompare(b.url, "en", { numeric: true });
  });
}

// ---------------------------------------------------------------------------
// Step 1: Fetch the listing
// ---------------------------------------------------------------------------
async function fetchListing() {
  let count = null;
  const results = [];
  let pagesFetched = 0;
  let page;

  do {
    const url =
      pagesFetched === 0
        ? LISTING_URL
        : `${LISTING_URL}&%24skip=${results.length}`;
    const response = await fetchText(url, { attempts: 3, retryOn404: true });
    pagesFetched++;

    if (!response.ok) {
      fail(
        `Failed to fetch the Applied Skills listing from Microsoft Learn (status ${
          response.status ?? "network error"
        }). The API may be down, blocking requests, or its shape may have changed.`,
      );
      return null;
    }

    try {
      page = JSON.parse(response.text);
    } catch {
      fail(
        "Failed to fetch the Applied Skills listing from Microsoft Learn (invalid JSON response). " +
          "The API may be down, blocking requests, or its shape may have changed.",
      );
      return null;
    }

    if (count === null) count = page.count;

    if (!Array.isArray(page.results)) {
      fail(
        "Failed to fetch the Applied Skills listing from Microsoft Learn (missing results array). " +
          "The API may be down, blocking requests, or its shape may have changed.",
      );
      return null;
    }

    if (page.results.length === 0) break;
    results.push(...page.results);
  } while (results.length < count && pagesFetched < 20);

  const map = new Map();
  for (const result of results) {
    if (result.hidden === true) continue;
    const slug = slugFromUrl(result.url);
    if (!slug) continue;
    map.set(slug, {
      title: stripPrefix(result.title ?? ""),
      displayProducts: result.display_products ?? [],
    });
  }

  if (map.size < MIN_SKILLS) {
    fail(
      `Applied Skills listing returned only ${map.size} skills (expected at least ${MIN_SKILLS}). ` +
        "The API shape or filter may have changed; the cache was not modified.",
    );
    return null;
  }

  console.log(
    `Fetched ${results.length} listing entries (${map.size} visible skills).`,
  );
  return map;
}

// ---------------------------------------------------------------------------
// Step 2: Load the baseline
// ---------------------------------------------------------------------------
function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) {
    console.log("No baseline found. Creating initial cache...");
    return { active: [], new: [], retiring: [] };
  }

  const raw = readFileSync(BASELINE_FILE, "utf8").trim();
  if (!raw) {
    console.log("No baseline found. Creating initial cache...");
    return { active: [], new: [], retiring: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(
      `Corrupt baseline at ${relative(root, BASELINE_FILE)} (invalid JSON). The cache was not modified.`,
    );
    return null;
  }

  if (
    !Array.isArray(parsed.active) ||
    !Array.isArray(parsed.new) ||
    !Array.isArray(parsed.retiring)
  ) {
    fail(
      `Corrupt baseline at ${relative(root, BASELINE_FILE)} (missing active/new/retiring array). ` +
        "The cache was not modified.",
    );
    return null;
  }

  return parsed;
}

function indexBaseline(baseline) {
  const map = new Map();
  for (const category of ["active", "new", "retiring"]) {
    for (const entry of baseline[category]) {
      const slug = slugFromUrl(entry.url);
      if (!slug) {
        console.error(
          `WARNING: baseline entry "${entry.name}" has no resolvable slug; skipping.`,
        );
        continue;
      }
      map.set(slug, { category, entry });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step 3: Scan lab pages
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scanLabPages() {
  const bySlug = new Map();
  const files = existsSync(LABS_DIR) ? walk(LABS_DIR) : [];

  for (const file of files) {
    const raw = normalize(readFileSync(file, "utf8"));
    if (isDraft(raw)) continue;

    const content = stripComments(raw);
    const pageId = relative(DOCS_DIR, file)
      .replace(/\\/g, "/")
      .replace(/\.mdx?$/, "");

    // `/applied-skills/resources/study-guides/...` is a study-guide path, not a skill slug.
    for (const match of content.matchAll(
      /credentials\/applied-skills\/(?!resources\b)([a-z0-9][a-z0-9-]*)/gi,
    )) {
      const slug = match[1].toLowerCase();
      if (!bySlug.has(slug)) bySlug.set(slug, new Set());
      bySlug.get(slug).add(pageId);
    }
  }

  const result = new Map();
  for (const [slug, pages] of bySlug) {
    result.set(
      slug,
      [...pages].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    );
  }

  console.log(
    `Scanned ${files.length} lab pages; ${result.size} distinct Applied Skills linked.`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Step 4: Fetch each skill's detail page
// ---------------------------------------------------------------------------
function parseSkillPage(html) {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1Match ? stripPrefix(stripTags(h1Match[1])) : null;

  const products = [];
  const productRe =
    /href="[^"]*\/credentials\/browse\/\?products=([a-z0-9-]+)&(?:amp;)?credential_types=applied%20skills"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(productRe)) {
    const label = stripTags(match[2]);
    if (label && !products.includes(label)) products.push(label);
  }

  // Delisted skills often lack the warning box but always carry this meta tag.
  const dateMatch = html.match(
    /<meta name="retirementDate" content="(\d{4}-\d{2}-\d{2})[^"]*"/i,
  );
  const retirementDate = dateMatch ? dateMatch[1] : null;
  const retired =
    /<div class="WARNING">[\s\S]*?has been retired/i.test(html) ||
    (retirementDate !== null && Date.parse(retirementDate) <= Date.now());

  return { name, products, retired, retirementDate };
}

function isLive(slug, listing, details) {
  return listing.has(slug) && details.get(slug)?.retired !== true;
}

async function fetchSkillDetails(universe, listing, baseline) {
  const details = new Map();
  let pageFailures = 0;
  const slugs = [...universe].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    if (i > 0) await sleep(FETCH_DELAY_MS);

    const response = await fetchText(`${PAGE_BASE}${slug}/`);
    const listed = listing.get(slug);
    const prev = baseline.get(slug);
    const parsed = response.ok ? parseSkillPage(response.text) : null;

    if (response.ok && parsed?.name) {
      details.set(slug, parsed);
      continue;
    }

    if (response.status !== 404) pageFailures++;

    const fallbackName = listed ? listed.title : prev ? prev.entry.name : slug;
    const fallbackProducts = prev
      ? prev.entry.products
      : listed
        ? listed.displayProducts
        : [];
    console.error(
      `WARNING: could not read Applied Skills page for "${slug}" (status ${
        response.status ?? "network error"
      }); using fallback data.`,
    );
    details.set(slug, {
      name: fallbackName,
      products: fallbackProducts,
      retired: false,
      retirementDate: prev?.entry.retirementDate ?? null,
    });
  }

  const failurePct = slugs.length > 0 ? (pageFailures / slugs.length) * 100 : 0;
  if (failurePct > MAX_PAGE_FAILURE_PCT) {
    fail(
      `${pageFailures} of ${slugs.length} Applied Skills detail-page fetches failed ` +
        `(${failurePct.toFixed(1)}%), exceeding MAX_PAGE_FAILURE_PCT. The site may be blocking ` +
        "requests; the cache was not modified.",
    );
    return null;
  }

  console.log(
    `Fetched ${slugs.length} Applied Skills detail pages (${pageFailures} failures).`,
  );
  return details;
}

// ---------------------------------------------------------------------------
// Step 5: Categorize
// ---------------------------------------------------------------------------
function categorize(universe, listing, baseline, labScan, details) {
  const active = [];
  const newArr = [];
  const retiring = [];
  const newlyNew = [];
  const newlyRetiring = [];

  const slugs = [...universe].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );

  for (const slug of slugs) {
    const detail = details.get(slug);
    const prev = baseline.get(slug)?.category;
    const labPages = labScan.get(slug) ?? [];
    const entry = {
      name: detail.name,
      url: skillUrl(slug),
      products: detail.products,
      labPages,
      ...(detail.retirementDate
        ? { retirementDate: detail.retirementDate }
        : {}),
    };

    if (isLive(slug, listing, details)) {
      if (prev === "active") {
        active.push(entry);
      } else if (prev === "retiring") {
        console.log(
          `"${entry.name}" re-appeared in the listing; moved from retiring back to active.`,
        );
        active.push(entry);
      } else if (prev === "new") {
        if (labPages.length > 0) {
          console.log(
            `"${entry.name}" promoted from new to active (now linked from a lab page).`,
          );
          active.push(entry);
        } else {
          newArr.push(entry);
        }
      } else if (labPages.length > 0) {
        active.push(entry);
      } else {
        newArr.push(entry);
        newlyNew.push(entry);
      }
      continue;
    }

    if (prev === undefined && labPages.length === 0) continue;

    const isNewlyRetiring =
      prev === undefined || prev === "active" || prev === "new";
    if (isNewlyRetiring) newlyRetiring.push(entry);

    if (labPages.length === 0) {
      console.log(
        `Dropped "${entry.name}" from the cache (no longer listed, no lab-page references left).`,
      );
      continue;
    }

    retiring.push(entry);
  }

  return { active, new: newArr, retiring, newlyNew, newlyRetiring };
}

// ---------------------------------------------------------------------------
// Step 6: Write cache + outputs
// ---------------------------------------------------------------------------
function buildReport({
  newlyNew,
  newlyRetiring,
  listedCount,
  active,
  newArr,
  retiring,
}) {
  const sections = ["## Applied Skills changes detected"];

  if (newlyNew.length > 0) {
    const rows = sortByName(newlyNew)
      .map(
        (entry) =>
          `| ${entry.name} | ${entry.products.join(", ") || "—"} | [Link](${entry.url}) |`,
      )
      .join("\n");
    sections.push(
      `### New Applied Skills (${newlyNew.length}) — add to matching lab pages\n` +
        "| Applied Skill | Products | URL |\n" +
        "|---------------|----------|-----|\n" +
        rows,
    );
  }

  if (newlyRetiring.length > 0) {
    const rows = sortByName(newlyRetiring)
      .map(
        (entry) =>
          `| ${entry.name} | ${entry.retirementDate ?? "—"} | ${entry.labPages.join(", ") || "—"} | ` +
          `[Link](${entry.url}) |`,
      )
      .join("\n");
    sections.push(
      `### Retired Applied Skills (${newlyRetiring.length}) — remove from lab pages\n` +
        "| Applied Skill | Retired on | Lab pages | URL |\n" +
        "|---------------|------------|-----------|-----|\n" +
        rows,
    );
  }

  sections.push(
    `---\n- **Listed on Microsoft Learn:** ${listedCount}\n` +
      `- **Active:** ${active.length} · **New (to process):** ${newArr.length} · ` +
      `**Retiring (to process):** ${retiring.length}`,
  );

  sections.push(
    'See `src/data_files/applied-skills-cache.json` and the "Applied Skills Monitor" section of ' +
      "`AGENTS.md` for how to process these.",
  );

  return sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Applied Skills Monitor ===");
  console.log(`Started: ${new Date().toISOString()}`);

  console.log("Fetching Applied Skills listing...");
  const listing = await fetchListing();

  console.log("Loading baseline cache...");
  const rawBaseline = loadBaseline();
  const baseline = indexBaseline(rawBaseline);

  console.log("Scanning lab pages...");
  const labScan = scanLabPages();

  const universe = new Set([
    ...listing.keys(),
    ...baseline.keys(),
    ...labScan.keys(),
  ]);
  console.log(`Universe: ${universe.size} distinct Applied Skills slugs.`);

  console.log("Fetching Applied Skills detail pages...");
  const details = await fetchSkillDetails(universe, listing, baseline);

  const {
    active,
    new: newArr,
    retiring,
    newlyNew,
    newlyRetiring,
  } = categorize(universe, listing, baseline, labScan, details);

  const baselineKnownCount = baseline.size;
  if (baselineKnownCount >= 1) {
    const pct = (newlyRetiring.length * 100) / baselineKnownCount;
    if (pct > MAX_RETIRED_PCT) {
      fail(
        `${newlyRetiring.length} of ${baselineKnownCount} previously known Applied Skills disappeared ` +
          `from the listing at once (${pct.toFixed(1)}%), exceeding MAX_RETIRED_PCT — the listing API ` +
          "probably changed; the cache was not modified.",
      );
      return;
    }
  }

  const next = {
    lastSynced: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    active: sortByName(active),
    new: sortByName(newArr),
    retiring: sortByName(retiring),
  };

  const baselineExists = existsSync(BASELINE_FILE);
  const baselineComparable = JSON.stringify({
    active: sortByName(rawBaseline.active),
    new: sortByName(rawBaseline.new),
    retiring: sortByName(rawBaseline.retiring),
  });
  const nextComparable = JSON.stringify({
    active: next.active,
    new: next.new,
    retiring: next.retiring,
  });
  const changed = !baselineExists || baselineComparable !== nextComparable;

  if (changed) {
    writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  const changesFound = newlyNew.length > 0 || newlyRetiring.length > 0;

  if (changesFound) {
    writeFileSync(
      REPORT_FILE,
      buildReport({
        newlyNew,
        newlyRetiring,
        listedCount: listing.size,
        active,
        newArr,
        retiring,
      }),
      "utf8",
    );
  }

  writeOutput({
    changes_found: changesFound,
    baseline_updated: changed,
    extraction_failed: false,
  });

  console.log(
    `Listed: ${listing.size} · Active: ${active.length} · New: ${newArr.length} · Retiring: ${retiring.length}`,
  );
  console.log(
    `New this run: ${newlyNew.length > 0 ? newlyNew.map((e) => e.name).join(", ") : "—"}`,
  );
  console.log(
    `Retired this run: ${newlyRetiring.length > 0 ? newlyRetiring.map((e) => e.name).join(", ") : "—"}`,
  );
  console.log(changed ? "Cache updated" : "Cache unchanged");
  console.log("=== Done ===");
}

main().catch((err) => {
  fail(`Unexpected error: ${err?.stack ?? err}`);
});
