#!/usr/bin/env node
/**
 * Audit exam pages for missing standard resource links.
 *
 * Usage:
 *   node scripts/audit-missing-resources.mjs
 *
 * Re-run after creating/editing any exam page (e.g. after scripts/new-exam.mjs)
 * and commit the regenerated JSON. Detection matches LinkCard button titles
 * (the `title="..."` attribute) — it does NOT consult hrefs, and it does NOT
 * verify the resource exists on the vendor site.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const AREAS = [
  "aibusiness",
  "azure",
  "dynamics",
  "github",
  "microsoft365",
  "power",
  "security",
];

const EXAM_FILE_RE = /^([A-Z]{2,3}-\d{3})\.mdx$/;

// ---------------------------------------------------------------------------
// Resource types — table keys live here. Matching is against LinkCard button
// titles exactly as they appear in the `title="..."` attribute, not hrefs.
// Add a new type by adding the button title it should look for.
// Buttons borrowed from a predecessor exam (`AZ-800: MeasureUp Assessment` on
// AZ-802) intentionally do not count — the page still lacks its own resource.
// ---------------------------------------------------------------------------
const RESOURCE_TYPES = [
  {
    key: "MS Learn Course",
    test: ({ titles }) => titles.some((t) => t === "Microsoft Learn"),
  },
  {
    key: "MS Learn Practice Assessment",
    test: ({ titles }) =>
      titles.some((t) => t.startsWith("Microsoft Learn Practice Assessment")),
  },
  {
    key: "MS Learn Exam Readiness Zone",
    test: ({ titles }) =>
      titles.some((t) => t === "Microsoft Learn Exam Readiness Zone"),
  },
  {
    key: "MS Learn On-Demand Instructor-led Training",
    test: ({ titles }) =>
      titles.some((t) =>
        t.startsWith("On Demand Instructor-led Training Series"),
      ),
  },
  {
    key: "Exam Labs",
    test: ({ titles }) => titles.some((t) => t === "Exam Labs"),
  },
  {
    key: "GitHub Labs",
    test: ({ labText }) => {
      const tab = labText.match(
        /<TabItem label="Microsoft GitHub"[^>]*>([\s\S]*?)<\/TabItem>/,
      );
      return !!tab && /<LinkCard\b/.test(tab[1]);
    },
  },
  {
    key: "MeasureUp",
    test: ({ titles }) =>
      titles.some(
        (t) => t.startsWith("MeasureUp ") && t !== "MeasureUp Subscriptions",
      ),
  },
  {
    key: "Whizlabs",
    test: ({ titles }) => titles.some((t) => /^Whizlabs?\b/i.test(t)),
  },
  {
    key: "Pluralsight",
    test: ({ titles }) => titles.some((t) => /^Pluralsight\b/i.test(t)),
  },
  {
    key: "Udemy",
    test: ({ titles }) => titles.some((t) => /\bUdemy\b/i.test(t)),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

// LinkCard `title="..."` attributes are buttons; `<Card title=...>` and
// `<TabItem label=...>` are not, so only the former is matched.
const LINKCARD_TITLE_RE = /<LinkCard\b[^>]*?\btitle="([^"]*)"/g;

function collectTitles(examMdx) {
  const titles = [];
  for (const m of examMdx.matchAll(LINKCARD_TITLE_RE)) titles.push(m[1].trim());
  return titles;
}

function buildLabText(area, codeLower) {
  const labPath = join(
    root,
    "src",
    "content",
    "docs",
    "labs",
    area,
    `${codeLower}.mdx`,
  );
  if (!existsSync(labPath)) return "";
  return stripComments(normalize(readFileSync(labPath, "utf8")));
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const results = {};
for (const { key } of RESOURCE_TYPES) results[key] = [];

let scannedCount = 0;

for (const area of AREAS) {
  const areaDir = join(root, "src", "content", "docs", area);
  if (!existsSync(areaDir)) continue;

  for (const entry of readdirSync(areaDir)) {
    const match = entry.match(EXAM_FILE_RE);
    if (!match) continue;
    const code = match[1];

    const raw = normalize(readFileSync(join(areaDir, entry), "utf8"));
    if (isDraft(raw)) continue;

    scannedCount++;

    const examMdx = stripComments(raw);
    const titles = collectTitles(examMdx);
    const labText = buildLabText(area, code.toLowerCase());
    const ctx = { titles, labText };

    for (const { key, test } of RESOURCE_TYPES) {
      if (!test(ctx)) results[key].push(code);
    }
  }
}

if (scannedCount === 0) {
  console.error(
    "❌  No exam pages found. Check the area directories under src/content/docs/.",
  );
  process.exit(1);
}

for (const key of Object.keys(results)) {
  results[key].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// ---------------------------------------------------------------------------
// Write and report
// ---------------------------------------------------------------------------
const outPath = join(root, "src", "data_files", "missing-resources.json");
writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n", "utf8");

console.log(`Scanned ${scannedCount} exam pages.`);
for (const [key, codes] of Object.entries(results)) {
  console.log(`${key}: ${codes.length} missing`);
}
console.log(relative(root, outPath));
