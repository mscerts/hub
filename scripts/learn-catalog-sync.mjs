#!/usr/bin/env node
/**
 * Build a local cache of Microsoft Learn training modules for AI-assisted
 * content research (name, product category, product(s), subjects, units).
 *
 * Usage:
 *   node scripts/learn-catalog-sync.mjs
 *
 * Data source: https://learn.microsoft.com/api/catalog/
 * Output: src/data_files/learn-catalog.json
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const OUTPUT_FILE = join(root, "src", "data_files", "learn-catalog.json");
const CATALOG_BASE = "https://learn.microsoft.com/api/catalog/";
const MIN_MODULES = 2800; // failsafe: abort if the filtered result looks too small (API/schema change)

// Top-level Microsoft Learn product categories relevant to certifications
// tracked on this site (see AGENTS.md's per-area exam code mapping). Extend
// this list if a new exam area maps to a Learn product not covered here.
const ALLOWED_CATEGORIES = [
  "azure",
  "dynamics-365",
  "github",
  "m365",
  "power-platform",
  "fabric",
  "entra",
  "microsoft-sentinel",
  "microsoft-defender",
  "microsoft-purview",
  "priva",
  "security-copilot",
  "ms-copilot",
  "intune",
  "mem",
  "viva",
  "office-365",
  "office-teams",
  "microsoft-teams-phone",
  "agent-365",
  "agent-framework",
  "sql-server",
  "windows",
  "office-sp",
  "office-exchange",
  "industry-solutions",
  "ms-graph",
  "dotnet",
  "office-adaptive-cards",
  "aspnet",
  "aspnet-core",
  "bing",
  "office-excel",
  "m365-ems-advanced-threat-analytics",
  "microsoft-authentication-library",
  "microsoft-edge",
  "office-forms",
  "microsoft-search",
  "microsoft-whiteboard",
  "office",
  "office-onedrive",
  "office-onenote",
  "office-outlook",
  "office-powerpoint",
  "sysinternals",
  "vs",
  "vs-app-center",
  "vs-code",
  "windows-server",
  "office-word",
];

// Microsoft's own `subjects` tagging is sparse and inconsistent (e.g. "Introduction
// to Azure Firewall" has no "Networking" tag even though Firewall is a networking
// product, while a near-duplicate Firewall module does have it). This table adds
// well-known, high-confidence subject ids for specific products when Microsoft's
// tagging misses them. It supplements official subjects, never removes them, and
// only covers products with one obvious, unambiguous subject — it is not a full
// per-module content classification. Values are subject ids (resolved to display
// names the same way official subject tags are).
const PRODUCT_SUBJECT_HINTS = {
  // Networking
  "azure-application-gateway": ["networking"],
  "azure-bastion": ["networking"],
  "azure-cdn": ["networking"],
  "azure-ddos-protection": ["networking"],
  "azure-dns": ["networking"],
  "azure-expressroute": ["networking"],
  "azure-firewall": ["networking"],
  "azure-firewall-manager": ["networking"],
  "azure-front-door": ["networking"],
  "azure-load-balancer": ["networking"],
  "azure-network-watcher": ["networking"],
  "azure-traffic-manager": ["networking"],
  "azure-virtual-network": ["networking"],
  "azure-virtual-wan": ["networking"],
  "azure-vpn-gateway": ["networking"],
  "azure-web-application-firewall": ["networking"],

  // Databases / data engineering
  "azure-cosmos-db": ["databases"],
  "azure-sql-database": ["databases"],
  "azure-sql-managed-instance": ["databases"],
  "azure-database-mysql": ["databases"],
  "azure-database-postgresql": ["databases"],
  "azure-cache-redis": ["cache"],
  "azure-managed-redis": ["cache"],
  "azure-synapse-analytics": ["data-engineering"],
  "azure-data-factory": ["data-engineering"],
  "azure-databricks": ["data-engineering"],
  "azure-data-lake": ["data-engineering"],
  "azure-data-lake-storage": ["data-engineering"],
  "azure-data-explorer": ["data-engineering"],

  // AI
  "azure-machine-learning": ["machine-learning"],
  "azure-machine-learning-designer": ["machine-learning"],
  "azure-machine-learning-studio": ["machine-learning"],
  "azure-openai": ["generative-ai"],
  "azure-custom-vision": ["machine-learning"],
  "azure-bot-service": ["chatbots"],
  "azure-speech": ["natural-language-processing"],
  "azure-translator-speech": ["natural-language-processing"],
  "azure-translator-text": ["natural-language-processing"],

  // Identity & security
  "entra": ["identity-access"],
  "entra-id": ["identity-access"],
  "entra-id-protection": ["identity-access"],
  "entra-identity-governance": ["identity-access"],
  "entra-permissions-management": ["identity-access"],
  "entra-verified-id": ["identity-access"],
  "entra-workload-identities": ["identity-access"],
  "entra-external-id": ["identity-access"],
  "active-directory": ["identity-access"],
  "azure-key-vault": ["key-management"],
  "microsoft-sentinel": ["threat-protection"],
  "microsoft-defender": ["threat-protection"],
  "m365-defender": ["threat-protection"],
  "defender-endpoint": ["threat-protection"],
  "defender-for-cloud": ["threat-protection"],
  "defender-for-cloud-apps": ["threat-protection"],
  "defender-for-iot": ["threat-protection"],
  "defender-for-threat-intelligence": ["threat-protection"],
  "defender-identity": ["threat-protection"],
  "defender-office365": ["threat-protection"],
  "defender-xdr": ["threat-protection"],
  "azure-information-protection": ["information-protection-governance"],
  "microsoft-purview": ["information-protection-governance", "compliance"],
  "priva": ["compliance"],

  // Device management
  "intune": ["device-management"],

  // Power Platform / data platform (only products with one clear, undiluted
  // subject on manual review — e.g. Power Apps/Dataverse were dropped because
  // they're used as a broad co-tag on many Copilot Studio/AI Builder modules
  // that aren't really about app development or databases)
  "power-bi": ["data-visualization"],
  "power-automate": ["automation"],
  "fabric": ["data-engineering"],

  // Containers & DevOps
  "azure-kubernetes-service": ["containers"],
  "azure-container-instances": ["containers"],
  "azure-container-apps": ["containers"],
  "azure-container-registry": ["containers"],
  "azure-devops": ["devops"],
  "azure-pipelines": ["devops"],
  "azure-boards": ["devops"],
  "azure-repos": ["devops"],
  "azure-artifacts": ["devops"],
  "azure-test-plans": ["devops"],

  // IT management / monitoring
  "azure-backup": ["it-management-monitoring"],
  "azure-site-recovery": ["it-management-monitoring"],
  "azure-monitor": ["it-management-monitoring"],
  "azure-log-analytics": ["it-management-monitoring"],

  // Automation / serverless
  "azure-automation": ["automation"],
  "azure-logic-apps": ["automation"],
  "azure-functions": ["serverless-computing"],

  // App development frameworks (bare "dotnet"/"vs"/"vs-code" were deliberately
  // left unmapped — sampling showed those generic tags span web/desktop/mobile/
  // cloud content with no single fitting subject)
  "aspnet": ["backend-development"],
  "aspnet-core": ["backend-development"],
  "blazor": ["frontend-development"],
  "dotnet-maui": ["mobile-development"],
  "ms-graph": ["backend-development"],

  // Education (Microsoft Learn has no official "Education" subject — see
  // CUSTOM_SUBJECTS below. Sampling confirmed m365-education is a clean,
  // undiluted signal: every module carrying it is genuinely K-12/higher-ed content)
  "m365-education": ["education"],
};

// Subject ids invented for this cache because no official Microsoft Learn
// subject fits (checked the full `?type=subjects` taxonomy — there is no
// education-related entry). Resolved the same way as official subject ids;
// distinguishable only by not appearing in the live `?type=subjects` response.
const CUSTOM_SUBJECTS = {
  education: "Education",
};

async function fetchJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === attempts) throw new Error(`Failed to fetch ${url}: ${err.message}`);
      console.warn(`  retry ${attempt}/${attempts - 1} for ${url} (${err.message})`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

// Flattens a two-level catalog taxonomy (products or subjects) into lookup maps.
function flattenTaxonomy(entries) {
  const nameById = new Map();
  const topIdById = new Map();
  for (const top of entries) {
    nameById.set(top.id, top.name);
    topIdById.set(top.id, top.id);
    for (const child of top.children ?? []) {
      nameById.set(child.id, child.name);
      topIdById.set(child.id, top.id);
    }
  }
  return { nameById, topIdById };
}

function normalizeUrl(url) {
  if (!url) return url;
  return url.replace("/en-us/", "/").replace(/([?&])WT\.mc_id=[^&]*/, "$1WT.mc_id=studentamb_165290");
}

async function main() {
  console.log("Fetching product taxonomy...");
  const { products } = await fetchJson(`${CATALOG_BASE}?type=products`);
  const { nameById: productNameById, topIdById: productTopIdById } = flattenTaxonomy(products);

  console.log("Fetching subject taxonomy...");
  const { subjects } = await fetchJson(`${CATALOG_BASE}?type=subjects`);
  const { nameById: subjectNameById } = flattenTaxonomy(subjects);
  for (const [id, name] of Object.entries(CUSTOM_SUBJECTS)) {
    if (!subjectNameById.has(id)) subjectNameById.set(id, name);
  }

  console.log("Fetching modules and units (large download, ~10MB)...");
  const { modules, units } = await fetchJson(`${CATALOG_BASE}?type=modules,units&locale=en-us`);
  const unitTitleByUid = new Map(units.map((u) => [u.uid, u.title]));

  const allowedTopIds = new Set(ALLOWED_CATEGORIES);
  const categoryNameByTopId = new Map(ALLOWED_CATEGORIES.map((id) => [id, productNameById.get(id) ?? id]));

  const result = [];
  let missingUnitTitles = 0;
  let unresolvedProducts = 0;
  let modulesWithHintedSubjects = 0;

  for (const mod of modules) {
    const topIds = new Set();
    const productNames = new Set();
    const hintedSubjectIds = new Set();

    for (const productId of mod.products ?? []) {
      const topId = productTopIdById.get(productId);
      if (topId) {
        topIds.add(topId);
      } else {
        unresolvedProducts++;
      }
      productNames.add(productNameById.get(productId) ?? productId);
      for (const subjectId of PRODUCT_SUBJECT_HINTS[productId] ?? []) {
        hintedSubjectIds.add(subjectId);
      }
    }

    const isRelevant = [...topIds].some((id) => allowedTopIds.has(id));
    if (!isRelevant) continue;

    const categories = [...topIds]
      .filter((id) => allowedTopIds.has(id))
      .map((id) => categoryNameByTopId.get(id))
      .sort();

    const unitTitles = (mod.units ?? []).map((uid) => {
      const title = unitTitleByUid.get(uid);
      if (!title) missingUnitTitles++;
      return title ?? uid;
    });

    const subjectIds = new Set(mod.subjects ?? []);
    let hintAdded = false;
    for (const id of hintedSubjectIds) {
      if (!subjectIds.has(id)) hintAdded = true;
      subjectIds.add(id);
    }
    if (hintAdded) modulesWithHintedSubjects++;

    result.push({
      uid: mod.uid,
      title: mod.title,
      url: normalizeUrl(mod.url),
      categories,
      products: [...productNames].sort(),
      subjects: [...subjectIds].map((id) => subjectNameById.get(id) ?? id).sort(),
      units: unitTitles,
    });
  }

  result.sort((a, b) => a.uid.localeCompare(b.uid));

  if (result.length < MIN_MODULES) {
    console.error(
      `Only ${result.length} modules matched (expected >= ${MIN_MODULES}). Aborting without writing — the catalog API schema may have changed.`
    );
    process.exit(1);
  }

  const output = {
    lastChecked: new Date().toISOString(),
    sourceApi: `${CATALOG_BASE}?type=modules,units,products,subjects`,
    categoryFilter: ALLOWED_CATEGORIES,
    totalModules: result.length,
    modules: result,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");

  console.log(`Wrote ${result.length} modules to ${OUTPUT_FILE}`);
  console.log(`  (${modules.length} modules seen total, ${modules.length - result.length} excluded by category filter)`);
  console.log(`  ${modulesWithHintedSubjects} modules got a subject added via PRODUCT_SUBJECT_HINTS`);
  if (missingUnitTitles) console.warn(`  ${missingUnitTitles} unit titles could not be resolved (fell back to uid)`);
  if (unresolvedProducts) console.warn(`  ${unresolvedProducts} product ids could not be resolved to a category`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
