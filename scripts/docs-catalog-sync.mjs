#!/usr/bin/env node
/**
 * Build a local cache of Microsoft Learn documentation pages (title, url,
 * product, subproduct, description) for AI-assisted content research — the
 * docs-portal equivalent of learn-catalog.json, which only covers training
 * modules.
 *
 * Usage:
 *   node scripts/docs-catalog-sync.mjs
 *
 * Data source: git clone (blobless, sparse, shallow) of each repo in REPOS.
 * Output: src/data_files/docs-catalog.json
 *
 * Adding a repo: find its .openpublishing.publish.config.json on GitHub for
 * docsets_to_publish[].build_source_folder, then VERIFY the real live base
 * URL against a sample page fetch. build_output_subfolder is often an
 * internal-only alias, not the public URL segment — confirmed mismatches
 * seen so far: entra-docs ("entra-docs" -> real "entra"), fabric-docs
 * ("fabric-docs" -> real "fabric"), windowsserverdocs
 * ("WindowsServerDocs-VSTS" -> real "windows-server"), and multiple
 * defender-docs docsets (see comments below). Never trust the config
 * literally — spot-check before adding a new repo or docset.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const OUTPUT_FILE = join(root, "src", "data_files", "docs-catalog.json");
const MIN_ENTRIES = 20000; // failsafe: abort write if far below expected scale (systemic breakage, not one repo's hiccup)

// Each entry: one repo, cloned once, walked across one or more docsets
// ("targets"). baseUrlPath is the VERIFIED live URL segment (see header
// note) -- not necessarily the docset's build_output_subfolder.
const REPOS = [
  {
    name: "azure-docs",
    repoUrl: "https://github.com/MicrosoftDocs/azure-docs.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "azure" }],
  },
  {
    name: "entra-docs",
    repoUrl: "https://github.com/MicrosoftDocs/entra-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "entra" }],
  },
  {
    name: "fabric-docs",
    repoUrl: "https://github.com/MicrosoftDocs/fabric-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "fabric" }],
  },
  {
    name: "sql-docs",
    repoUrl: "https://github.com/MicrosoftDocs/sql-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "sql" }],
  },
  {
    name: "power-platform",
    repoUrl: "https://github.com/MicrosoftDocs/power-platform.git",
    // repo also has a "project-sophia"/ps-docs docset -- unrelated internal project, excluded
    targets: [{ sourceFolder: "power-platform", baseUrlPath: "power-platform" }],
  },
  {
    name: "memdocs",
    repoUrl: "https://github.com/MicrosoftDocs/memdocs.git",
    targets: [
      { sourceFolder: "intune", baseUrlPath: "intune" },
      { sourceFolder: "autopilot", baseUrlPath: "autopilot" },
    ],
  },
  {
    name: "windowsserverdocs",
    repoUrl: "https://github.com/MicrosoftDocs/windowsserverdocs.git",
    targets: [{ sourceFolder: "WindowsServerDocs", baseUrlPath: "windows-server" }],
  },
  {
    name: "defender-docs",
    repoUrl: "https://github.com/MicrosoftDocs/defender-docs.git",
    // repo also has an "advanced-threat-analytics" (ATA) docset -- legacy/retired product, superseded by defender-for-identity, excluded
    targets: [
      { sourceFolder: "defender-endpoint", baseUrlPath: "defender-endpoint" },
      { sourceFolder: "defender-for-cloud-apps", baseUrlPath: "defender-cloud-apps" },
      { sourceFolder: "defender-xdr", baseUrlPath: "defender-xdr" },
      { sourceFolder: "defender-business", baseUrlPath: "defender-business" },
      { sourceFolder: "defender-office-365", baseUrlPath: "defender-office-365" },
      { sourceFolder: "defender-vulnerability-management", baseUrlPath: "defender-vulnerability-management" },
      { sourceFolder: "defender-for-identity", baseUrlPath: "defender-for-identity" },
      { sourceFolder: "defender-for-cloud", baseUrlPath: "azure/defender-for-cloud" },
      { sourceFolder: "sentinel", baseUrlPath: "azure/sentinel" },
      { sourceFolder: "easm", baseUrlPath: "azure/external-attack-surface-management" },
      { sourceFolder: "exposure-management", baseUrlPath: "security-exposure-management" },
      { sourceFolder: "unified-secops-platform", baseUrlPath: "unified-secops-platform" },
      { sourceFolder: "defender", baseUrlPath: "unified-secops" },
      { sourceFolder: "defender-for-iot-azure", baseUrlPath: "azure/defender-for-iot" },
      { sourceFolder: "defender-for-iot", baseUrlPath: "azure/defender-for-iot" },
    ],
  },
  {
    // medium tier: single repo, but narrower in scope than its name implies -- see AGENTS.md
    name: "microsoft-365-docs",
    repoUrl: "https://github.com/MicrosoftDocs/microsoft-365-docs.git",
    targets: [
      { sourceFolder: "microsoft-365", baseUrlPath: "microsoft-365" },
      // canonicalUrl resolves under microsoft-365/copilot, NOT the docset's own "microsoft-365-copilot" alias
      { sourceFolder: "copilot", baseUrlPath: "microsoft-365/copilot" },
    ],
  },
  // hard tier: Dynamics 365, fragmented across many separate repos (one per product area).
  // Almost all collapse to a single target under dynamics365/ -- product-specific folder
  // names (sales/, customer-service/, finance/, supply-chain/, etc.) are already embedded
  // in each repo and become the URL segment directly, same pattern as azure-docs.
  // Excluded as legacy/retired (no current cert relevance, docs frozen or product retired):
  // msftdynamicsgpdocs (Dynamics GP), DynamicsAX2012-technet/-msdn (AX 2012), nav-content
  // (Dynamics NAV, predecessor to Business Central), dynamics365-docs-templates (archived
  // template repo, no content), dynamics-365-supply-chain-insights (stale since 2022,
  // folded into dynamics-365-unified-operations-public), dynamics-365-ai (stale since Nov
  // 2024, superseded by per-app Copilot content). dynamics-365-fraud-protection is excluded
  // too: confirmed via its own docs (includes/deprecation.md) that support ended Feb 3,
  // 2026 and the product is no longer purchasable -- it no longer appears in the live
  // Dynamics 365 documentation hub. dynamics365-industry-solutions has no publish config;
  // it's a community repo, not a docs source.
  {
    name: "dynamics-365-customer-engagement",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-customer-engagement.git",
    targets: [{ sourceFolder: "ce", baseUrlPath: "dynamics365" }],
  },
  {
    name: "dynamics-365-unified-operations-public",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-unified-operations-public.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "dynamics365" }],
  },
  {
    name: "dynamics365smb-docs",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365smb-docs.git",
    targets: [{ sourceFolder: "business-central", baseUrlPath: "dynamics365/business-central" }],
  },
  {
    name: "dynamics365smb-devitpro-pb",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365smb-devitpro-pb.git",
    targets: [{ sourceFolder: "dev-itpro", baseUrlPath: "dynamics365/business-central/dev-itpro" }],
  },
  {
    name: "dynamics-365-project-operations",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-project-operations.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "dynamics365/project-operations" }],
  },
  {
    name: "dynamics-365-contact-center",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-contact-center.git",
    targets: [{ sourceFolder: "contact-center", baseUrlPath: "dynamics365/contact-center" }],
  },
  {
    // Dynamics 365 Guides and Remote Assist retire Dec 31, 2026 -- still live, revisit after that date
    name: "dynamics-365-mixed-reality",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-mixed-reality.git",
    // real live segment is "mixed-reality", NOT the "mr-docs" folder name
    targets: [{ sourceFolder: "mr-docs", baseUrlPath: "dynamics365/mixed-reality" }],
  },
  {
    name: "dynamics-365-intelligent-order-management",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-intelligent-order-management.git",
    targets: [{ sourceFolder: "topics", baseUrlPath: "dynamics365/intelligent-order-management" }],
  },
  {
    name: "dynamics365-guidance",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365-guidance.git",
    targets: [{ sourceFolder: "guidance", baseUrlPath: "dynamics365/guidance" }],
  },
  {
    // Copilot extensibility/developer docs (declarative agents, plugins, adaptive cards) --
    // a separate repo from microsoft-365-docs' own copilot/ folder (agent-essentials,
    // copilot-control-system). Both share the microsoft-365/copilot/ URL prefix but with
    // no overlapping subfolders, so no duplicate entries.
    name: "m365copilot-docs",
    repoUrl: "https://github.com/MicrosoftDocs/m365copilot-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "microsoft-365/copilot/extensibility" }],
  },
  {
    // Different org (github, not MicrosoftDocs), different domain, and a Next.js-based
    // pipeline instead of docfx -- frontmatter uses "intro" instead of "description" and
    // has no ms.service/ms.subservice equivalent, so "product" is derived from the
    // top-level content/ folder name instead (e.g. "actions", "copilot", "codespaces").
    // No locale prefix needed -- docs.github.com/<path> resolves the same as /en/<path>.
    name: "github-docs",
    repoUrl: "https://github.com/github/docs.git",
    domain: "docs.github.com",
    descriptionField: "intro",
    productFromPath: true,
    targets: [{ sourceFolder: "content", baseUrlPath: "" }],
  },
];

const SKIP_DIRS = new Set(["includes", "media", "_themes", "breadcrumb", "archive"]);

function cloneRepo(repo, targetDir) {
  console.log(`  Cloning ${repo.name} (blobless, sparse, shallow)...`);
  const t0 = Date.now();
  execSync(
    `git clone --filter=blob:none --sparse --depth 1 --no-checkout --quiet ${repo.repoUrl} "${targetDir}"`,
    { stdio: "inherit" }
  );
  const sparsePaths = repo.targets
    .flatMap((t) => [`"${t.sourceFolder}/**/*.md"`, `"${t.sourceFolder}/*.md"`])
    .join(" ");
  execSync(`git sparse-checkout set --no-cone ${sparsePaths}`, { cwd: targetDir, stdio: "inherit" });
  execSync(`git checkout --quiet`, { cwd: targetDir, stdio: "inherit" }); // no branch arg: resolves to each repo's actual default branch (not always "main")
  console.log(`  Clone + checkout took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function walkMarkdownFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, results);
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return fm;
}

function cleanTitle(title) {
  return title.replace(/\s*[|\-]\s*Microsoft (Docs|Learn|Azure)\s*$/i, "").trim();
}

// github/docs (Next.js/Liquid pipeline, unlike every other docfx-based repo here) embeds
// unresolved template tags like "{% data variables.product.github %}" in raw frontmatter text.
function stripLiquidTags(text) {
  if (!text) return text;
  const cleaned = text
    .replace(/\{%\s*data\s+variables\.product\.(?:github|prodname_dotcom|prodname_ghe_cloud|prodname_ghe_server)\s*%\}/gi, "GitHub")
    .replace(/\{%[^%]*%\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || null;
}

function buildUrl(filePath, sourceRoot, baseUrlPath, domain) {
  const rel = relative(sourceRoot, filePath).replace(/\\/g, "/").replace(/\.md$/, "");
  return baseUrlPath ? `https://${domain}/${baseUrlPath}/${rel}` : `https://${domain}/${rel}`;
}

function processRepo(repo, entries) {
  const domain = repo.domain || "learn.microsoft.com";
  const descriptionField = repo.descriptionField || "description";
  const tmpDir = mkdtempSync(join(tmpdir(), "docs-catalog-"));
  try {
    cloneRepo(repo, tmpDir);
    for (const target of repo.targets) {
      const sourceRoot = join(tmpDir, target.sourceFolder);
      const files = walkMarkdownFiles(sourceRoot);
      let added = 0;
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !fm.title) continue;
        const rel = relative(sourceRoot, file).replace(/\\/g, "/");
        entries.push({
          title: cleanTitle(stripLiquidTags(fm.title) || fm.title),
          url: buildUrl(file, sourceRoot, target.baseUrlPath, domain),
          product: repo.productFromPath ? rel.split("/")[0] : fm["ms.service"] || null,
          subproduct: repo.productFromPath ? null : fm["ms.subservice"] || null,
          description: stripLiquidTags(fm[descriptionField]),
        });
        added++;
      }
      console.log(`  ${target.sourceFolder}/ -> ${target.baseUrlPath}/ (${added} entries)`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const entries = [];
const failedRepos = [];

for (const repo of REPOS) {
  console.log(`\n${repo.name}:`);
  try {
    processRepo(repo, entries);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    failedRepos.push(repo.name);
  }
}

console.log(`\nTotal entries: ${entries.length}`);
if (failedRepos.length) console.log(`Repos that failed: ${failedRepos.join(", ")}`);

if (entries.length < MIN_ENTRIES) {
  console.error(`Aborting write: only ${entries.length} entries, expected at least ${MIN_ENTRIES}.`);
  process.exit(1);
}

writeFileSync(OUTPUT_FILE, JSON.stringify(entries));
const sizeMB = (Buffer.byteLength(JSON.stringify(entries)) / 1024 / 1024).toFixed(1);
console.log(`Wrote ${OUTPUT_FILE} (${sizeMB} MB)`);

if (failedRepos.length) process.exit(1); // still commits (file already written above); signals CI to open an issue
