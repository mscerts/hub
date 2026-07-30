#!/usr/bin/env node
/**
 * Scaffold a new exam study-materials page.
 *
 * Usage:
 *   node scripts/new-exam.mjs --code AZ-999 --name "Microsoft Azure Whatever"
 *
 * Options:
 *   --code   Exam code (e.g. AZ-104, SC-900)      [required]
 *   --name   Official exam name from Microsoft Learn [required]
 *   --beta   Mark page with BETA status banner
 *   --labs   Include an Exam Labs link (assumes /labs/<area>/<code>/ exists)
 */

import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = {};
const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i++) {
  if (raw[i].startsWith("--")) {
    const key = raw[i].slice(2);
    const value = raw[i + 1] && !raw[i + 1].startsWith("--") ? raw[i + 1] : true;
    args[key] = value;
    if (value !== true) i++;
  }
}

const code = args.code?.toString().toUpperCase();
const name = args.name?.toString();
const isBeta = Boolean(args.beta);
const hasLabs = Boolean(args.labs);

if (!code || !name) {
  console.error(
    'Usage: node scripts/new-exam.mjs --code AZ-999 --name "Microsoft Azure Whatever"\n' +
      "       Optional: --beta  (marks page as beta)\n" +
      "                 --labs  (adds Exam Labs link)"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate and resolve area
// ---------------------------------------------------------------------------
if (!/^[A-Z]{2,3}-\d{3}$/.test(code)) {
  console.error(
    `❌  Invalid exam code: "${code}". Expected format: AZ-104, SC-900, GH-100, etc.`
  );
  process.exit(1);
}

const prefix = code.split("-")[0];

const AREA_MAP = {
  AZ: "azure",
  AI: "azure",
  DP: "azure",
  GH: "github",
  AB: "aibusiness",
  MS: "microsoft365",
  MD: "microsoft365",
  PL: "power",
  SC: "security",
  MB: "dynamics",
};

const area = AREA_MAP[prefix];
if (!area) {
  console.error(
    `❌  Unknown prefix "${prefix}". Supported prefixes: ${Object.keys(AREA_MAP).join(", ")}`
  );
  process.exit(1);
}

const codeLC = code.toLowerCase();
const filePath = join(root, "src", "content", "docs", area, `${code}.mdx`);

if (existsSync(filePath)) {
  console.error(`❌  File already exists: src/content/docs/${area}/${code}.mdx`);
  process.exit(1);
}

function escapeYaml(str) {
  return str.replace(/"/g, '\\"');
}

function escapeJsxAttr(str) {
  return str.replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Build the MDX content
// ---------------------------------------------------------------------------
const description = `Collection of study materials for the certification exam ${code}: ${name}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`;

const examUrl = `https://learn.microsoft.com/credentials/certifications/exams/${codeLC}?WT.mc_id=studentamb_165290`;
const studyGuideUrl = `https://learn.microsoft.com/credentials/certifications/resources/study-guides/${codeLC}?WT.mc_id=studentamb_165290`;
const learnUrl = `https://learn.microsoft.com/training/courses/${codeLC}t00?WT.mc_id=studentamb_165290`;

const labsLink = hasLabs
  ? `\n  <LinkCard title="Exam Labs" href="/labs/${area}/${codeLC}/" target="_blank" description="Collection of all lab exercises that Microsoft offers."/>`
  : "";

const betaBanner = isBeta
  ? `\nimport BetaBanner from '../../../components/BetaBanner.astro';\n\n<BetaBanner summary="This exam is currently in beta. Content and assessment structure may change before general availability." />`
  : "";

const content = `---
title: ${code} Study Materials
description: "${escapeYaml(description)}"
---
import { Aside, Card, CardGrid, LinkCard, TabItem, Tabs } from '@astrojs/starlight/components';${betaBanner}

<Card title="Get Started" icon="star">

  <LinkCard title="Exam ${code}: ${escapeJsxAttr(name)}" href="${examUrl}" target="_blank" description=""/>

  <LinkCard title="${code} Study Guide" href="${studyGuideUrl}" target="_blank" description="Study guide contains topics and information you need to know to successfully prepare for the exam."/>${labsLink}

---
<Tabs>
  <TabItem label="Text">
    <LinkCard title="Microsoft Learn" href="${learnUrl}" target="_blank" description=""/>
  </TabItem>

  <TabItem label="Videos">
    <CardGrid>
    </CardGrid>
  </TabItem>

  <TabItem label="Tests">
    <CardGrid>
    </CardGrid>
  </TabItem>

  <TabItem label="Paid">
    <CardGrid>
    </CardGrid>
  </TabItem>

  <TabItem label="Misc">
    <CardGrid>
    </CardGrid>
  </TabItem>
</Tabs>

</Card>

:::tip
MeasureUp has not released any material for this exam yet.
:::
`;

// ---------------------------------------------------------------------------
// Write and report
// ---------------------------------------------------------------------------
writeFileSync(filePath, content, "utf8");

console.log(`✅  Created: src/content/docs/${area}/${code}.mdx`);
console.log("");
console.log("Next steps:");
console.log(
  `  1. Open src/content/docs/${area}/${code}.mdx and:`
);
console.log(`       • Verify the exam URL and update the Get Started description`);
console.log(`       • Confirm the training course URL exists and update the description`);
if (isBeta) {
  console.log(`       • Update BetaBanner summary and note props with exam-specific details`);
}
if (!hasLabs) {
  console.log(
    `       • If a lab page exists at /labs/${area}/${codeLC}/, add it with --labs next time or add it manually`
  );
}
console.log(
  `  2. If this exam is BETA or RETIRING, add it to examBadges in astro.config.mjs`
);
console.log(
  `  3. Run: pnpm dev — then visit http://localhost:4321/${area}/${codeLC}/`
);
console.log(`  4. Run: pnpm build — to verify the page passes type checking`);
