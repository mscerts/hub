#!/usr/bin/env node
/**
 * Scaffold a new exam study-materials page.
 *
 * Usage:
 *   node scripts/new-exam.mjs --code AZ-999 --name "Microsoft Azure Whatever"
 *   node scripts/new-exam.mjs --code AZ-999 --name "Microsoft Azure Whatever" \
 *        --beta --beta-start 2026-10-14
 *
 * Options:
 *   --code        Exam code (e.g. AZ-104, SC-900)                    [required]
 *   --name        Official exam name from Microsoft Learn            [required]
 *   --beta        The exam is in beta: the page opens with the standard beta
 *                 :::tip and the beta timeline :::note ("Beta Exam Pages" in
 *                 AGENTS.md); needs --beta-start
 *   --beta-start  YYYY-MM-DD, the day the beta period began, from the official
 *                 announcement or the maintainers (never guessed)
 *   --labs        Include an Exam Labs link (assumes /certs/labs/<area>/<code>/ exists)
 *
 * The note is written in the "pending" variant while the beta start is at most
 * PENDING_ANNOUNCEMENT_DAYS days before today and in the "unannounced" one after
 * that (scripts/lib/beta-note.mjs). The script writes the page and nothing else:
 * the BETA badge and the beta-exams.json entry are for the maintainer, and it
 * says so.
 *
 * Environment (for tests):
 *   DOCS_DIR  where the page goes (default src/content/docs)
 *   TODAY     today's UTC date, YYYY-MM-DD (default: the clock)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AREA_BY_PREFIX as AREA_MAP } from "./lib/areas.mjs";
import {
  PENDING_ANNOUNCEMENT_DAYS,
  betaTimeline,
  buildBetaNote,
} from "./lib/beta-note.mjs";

export { AREA_MAP };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;

// The standard beta text of the beta exam pages ("Beta Exam Pages" in
// AGENTS.md), exactly as on src/content/docs/azure/AZ-401.mdx.
const BETA_TIP = `:::tip
This is a beta exam. The content is still being developed and there are not many resources available yet. We will update this page as we find more resources and as the exam content is finalized.

If you have any resources that you would like to recommend, please let us know and we will add them.
:::`;

/** A problem with the command line; the message is printed as it is. */
export class UsageError extends Error {}

/** `--key value` pairs and `--flag`s of the command line: { key: value | true }. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      args[key] = value;
      if (value !== true) i++;
    }
  }
  return args;
}

// A real day written YYYY-MM-DD, as a UTC Date (the check of the shared lib).
function parseDay(value, what) {
  try {
    return betaTimeline(value).start;
  } catch {
    throw new UsageError(
      `${what} must be a real day written YYYY-MM-DD (got ${JSON.stringify(value)}).`,
    );
  }
}

/**
 * The beta data of a page for a beta start and today (both YYYY-MM-DD):
 * { start, state, daysSince }. The note starts as "pending" (the Skills Hub
 * announcement is still due) while at most PENDING_ANNOUNCEMENT_DAYS days have
 * passed since the start, and as "unannounced" after that; a start after today
 * is pending too (daysSince is negative).
 */
export function betaFor(start, today) {
  const startDay = parseDay(start, "--beta-start");
  const daysSince = (parseDay(today, "TODAY") - startDay) / DAY_MS;
  return {
    start,
    state: daysSince <= PENDING_ANNOUNCEMENT_DAYS ? "pending" : "unannounced",
    daysSince,
  };
}

const escapeYaml = (text) => text.replace(/"/g, '\\"');
const escapeJsxAttr = (text) => text.replace(/"/g, "&quot;");

/** The MDX of the new page; `beta` is { start, state } for a beta exam. */
export function buildPage({ code, name, area, labs = false, beta = null }) {
  const codeLC = code.toLowerCase();
  const description = `Collection of study materials for the certification exam ${code}: ${name}. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`;

  const examUrl = `https://learn.microsoft.com/credentials/certifications/exams/${codeLC}?WT.mc_id=studentamb_165290`;
  const studyGuideUrl = `https://learn.microsoft.com/credentials/certifications/resources/study-guides/${codeLC}?WT.mc_id=studentamb_165290`;
  const learnUrl = `https://learn.microsoft.com/training/courses/${codeLC}t00?WT.mc_id=studentamb_165290`;

  const labsLink = labs
    ? `\n  <LinkCard title="Exam Labs" href="/certs/labs/${area}/${codeLC}/" description="Collection of all lab exercises that Microsoft offers."/>`
    : "";

  // The beta tip, then its timeline note as a box of its own right after it.
  const betaBlock = beta
    ? `\n\n${BETA_TIP}\n\n${buildBetaNote({ start: beta.start, announcement: beta.state })}`
    : "";

  return `---
title: ${code} Study Materials
description: "${escapeYaml(description)}"
---
import { Aside, Card, CardGrid, LinkCard, TabItem, Tabs } from '@components/docs';${betaBlock}

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
}

// The path as the maintainer knows it: from the repository root, with slashes.
function shown(file) {
  const path = relative(root, file).split(sep).join("/");
  return path.startsWith("..") || isAbsolute(path) ? file : path;
}

function scaffold(args, env) {
  const code = args.code?.toString().toUpperCase();
  const name = args.name?.toString();
  const isBeta = Boolean(args.beta);
  const hasLabs = Boolean(args.labs);

  if (!code || !name) {
    throw new UsageError(
      'Usage: node scripts/new-exam.mjs --code AZ-999 --name "Microsoft Azure Whatever"\n' +
        "       Optional: --beta --beta-start YYYY-MM-DD  (marks page as beta; the start is the day the beta\n" +
        "                 period began, from the official announcement, and --beta needs it)\n" +
        "                 --labs  (adds Exam Labs link)",
    );
  }

  // ---------------------------------------------------------------------------
  // Validate and resolve area
  // ---------------------------------------------------------------------------
  if (!/^[A-Z]{2,3}-\d{3}$/.test(code)) {
    throw new UsageError(
      `Invalid exam code: "${code}". Expected format: AZ-104, SC-900, GH-100, etc.`,
    );
  }

  const prefix = code.split("-")[0];
  const area = AREA_MAP[prefix];
  if (!area) {
    throw new UsageError(
      `Unknown prefix "${prefix}". Supported prefixes: ${Object.keys(AREA_MAP).join(", ")}`,
    );
  }

  // ---------------------------------------------------------------------------
  // The beta start: needed for a beta page, never guessed
  // ---------------------------------------------------------------------------
  let beta = null;
  if (args["beta-start"] !== undefined && !isBeta) {
    throw new UsageError("--beta-start only goes with --beta.");
  }
  if (isBeta) {
    if (args["beta-start"] === undefined || args["beta-start"] === true) {
      throw new UsageError(
        "--beta needs --beta-start YYYY-MM-DD, the day the beta period began. Take it from the official " +
          'announcement or ask the maintainers: it is never guessed, and "first detected" in the new-exam issue is not it.',
      );
    }
    beta = betaFor(
      String(args["beta-start"]),
      env.TODAY || new Date().toISOString().slice(0, 10),
    );
  }

  const docsDir = env.DOCS_DIR
    ? isAbsolute(env.DOCS_DIR)
      ? env.DOCS_DIR
      : join(root, env.DOCS_DIR)
    : join(root, "src", "content", "docs");
  const filePath = join(docsDir, area, `${code}.mdx`);
  const page = shown(filePath);

  if (existsSync(filePath)) {
    throw new UsageError(`File already exists: ${page}`);
  }

  // ---------------------------------------------------------------------------
  // Write and report
  // ---------------------------------------------------------------------------
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    buildPage({ code, name, area, labs: hasLabs, beta }),
    "utf8",
  );

  const codeLC = code.toLowerCase();
  console.log(`✅  Created: ${page}`);
  if (beta && beta.daysSince < 0) {
    console.log(
      `⚠️  The beta start ${beta.start} is after today, but the note says the beta period began on that day: check the date.`,
    );
  }
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Open ${page} and:`);
  console.log(
    `       • Verify the exam URL and update the Get Started description`,
  );
  console.log(
    `       • Confirm the training course URL exists and update the description`,
  );
  if (beta) {
    console.log(
      `       • Check the beta note (the "${beta.state}" variant for a beta start of ${beta.start}) against the official announcement`,
    );
  }
  if (!hasLabs) {
    console.log(
      `       • If a lab page exists at /certs/labs/${area}/${codeLC}/, add it with --labs next time or add it manually`,
    );
  }
  if (beta) {
    console.log(
      `  2. This exam is BETA and this script writes neither of these files: add { text: "BETA", variant: "tip" } for ${code} under "${area}" in src/data_files/exam-status.mjs, and an entry for ${code} to src/data_files/beta-exams.json with "betaStart": "${beta.start}" and "announcement": "${beta.state}"`,
    );
    console.log(
      `     When Microsoft's announcement appears, set "announcement" to its URL and print the note again: node scripts/beta-note.mjs --code ${code}`,
    );
  } else {
    console.log(
      `  2. If this exam is BETA or RETIRING, add it to src/data_files/exam-status.mjs`,
    );
  }
  console.log(
    `  3. Run: pnpm dev — then visit http://localhost:4321/certs/${area}/${codeLC}/`,
  );
  console.log(`  4. Run: pnpm build — to verify the page passes type checking`);
}

/**
 * Writes the page for the command line `argv`. Returns the exit code: a problem
 * with the arguments is printed (and is 1), not thrown.
 */
export function main(argv, env = process.env) {
  try {
    scaffold(parseArgs(argv), env);
    return 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(
      error.message.startsWith("Usage:")
        ? error.message
        : `❌  ${error.message}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
