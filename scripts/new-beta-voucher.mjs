#!/usr/bin/env node
/**
 * Scaffold the beta voucher page of a beta exam ("Beta voucher format" under
 * "Voucher Pages" in AGENTS.md): the page of the 80% discount that Microsoft
 * announces on the Skills Hub blog.
 *
 * Usage:
 *   node scripts/new-beta-voucher.mjs --code AZ-401 \
 *        --announcement "https://techcommunity.microsoft.com/blog/skills-hub-blog/<post>/<id>" \
 *        --discount-code AZ401Glendon --deadline 2026-11-02 \
 *        --certification "Microsoft Certified: Agentic DevOps Engineer Expert" \
 *        --about "It validates your ability to ..." \
 *        --register-url "https://learn.microsoft.com/credentials/certifications/exams/az-401"
 *
 * Options (everything but --name and --schedule-url is required):
 *   --code            Exam code (AZ-401)
 *   --announcement    The Skills Hub post of the announcement
 *   --discount-code   The code of the post, as written there
 *   --deadline        YYYY-MM-DD, the last day to take the exam at the discount
 *   --certification   The certification as the post names it
 *   --about           One to three sentences from the post: what the exam
 *                     validates and who it is for
 *   --register-url    The Learn page where the exam is ordered
 *   --name            The exam name (default: the entry of the exam in beta-exams.json)
 *   --schedule-url    A working Pearson VUE scheduling link, only when the default
 *                     one needs replacing (it must be for this exam)
 *
 * The script writes the page and nothing else: the sidebar entry, the card on the
 * exam page and the announcement in beta-exams.json are for the maintainer, and it
 * says so. Links get the hub's tracking parameter and lose their /en-us/ segment.
 * It never overwrites a page.
 *
 * Environment (for tests):
 *   DOCS_DIR          where the page goes (default src/content/docs)
 *   BETA_EXAMS_FILE   src/data_files/beta-exams.json
 *   TODAY             today's UTC date, YYYY-MM-DD (default: the clock)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TRACKING,
  areaOf,
  betaVoucherSlug,
  buildBetaVoucherPage,
  findBetaVoucherProblems,
} from "./lib/beta-voucher.mjs";
import { formatLongDate } from "./lib/beta-note.mjs";
import { UsageError, parseArgs } from "./new-exam.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const needText = (value, what) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`${what} is required.`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (/[{}<>]/.test(text)) {
    throw new UsageError(
      `${what} must not contain { } < > (they break the MDX page).`,
    );
  }
  return text;
};

/** An https URL on the given hosts, without /en-us/, query and fragment. */
function cleanUrl(value, what, hosts) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new UsageError(
      `${what} must be a full https URL (got ${JSON.stringify(value)}).`,
    );
  }
  if (url.protocol !== "https:" || !hosts.includes(url.hostname)) {
    throw new UsageError(
      `${what} must be an https URL on ${hosts.join(" or ")} (got ${url.protocol}//${url.hostname}).`,
    );
  }
  url.pathname = url.pathname.replace(/^\/en-us\//i, "/");
  return url;
}

/** Same, with the hub's tracking parameter and nothing else after the path. */
function trackedUrl(value, what, hosts) {
  const url = cleanUrl(value, what, hosts);
  return `${url.origin}${url.pathname}?${TRACKING}`;
}

// The path as the maintainer knows it: from the repository root, with slashes.
function shown(file) {
  const path = relative(root, file).split(sep).join("/");
  return path.startsWith("..") || isAbsolute(path) ? file : path;
}

const fromRoot = (path, fallback) =>
  path ? (isAbsolute(path) ? path : join(root, path)) : fallback;

function scaffold(args, env) {
  const code = args.code?.toString().toUpperCase();
  if (!code) {
    throw new UsageError(
      "Usage: node scripts/new-beta-voucher.mjs --code AZ-401 --announcement <Skills Hub post URL> --discount-code <CODE>\n" +
        '       --deadline YYYY-MM-DD --certification "<certification>" --about "<what the exam validates>" --register-url <Learn URL>\n' +
        '       Optional: --name "<exam name>" (default: beta-exams.json)  --schedule-url <Pearson VUE scheduling link>',
    );
  }
  if (!/^[A-Z]{2,3}-\d{3}$/.test(code)) {
    throw new UsageError(
      `Invalid exam code: "${code}". Expected format: AZ-401, GH-700, etc.`,
    );
  }
  const area = areaOf(code);
  if (!area) {
    throw new UsageError(`Unknown prefix "${code.split("-")[0]}" in ${code}.`);
  }

  const today = env.TODAY || new Date().toISOString().slice(0, 10);

  const deadline = args.deadline === true ? undefined : args.deadline;
  try {
    formatLongDate(String(deadline));
  } catch {
    throw new UsageError(
      `--deadline must be a real day written YYYY-MM-DD, the last day to take the exam at the discount (got ${JSON.stringify(deadline ?? null)}).`,
    );
  }
  if (String(deadline) < today) {
    throw new UsageError(
      `--deadline ${deadline} is before today (${today}): an offer that has ended gets no new page.`,
    );
  }

  const discountCode = args["discount-code"];
  if (
    typeof discountCode !== "string" ||
    !/^[A-Za-z0-9-]{3,40}$/.test(discountCode)
  ) {
    throw new UsageError(
      `--discount-code must be the code of the post: letters, digits and hyphens (got ${JSON.stringify(discountCode ?? null)}).`,
    );
  }

  const certification = needText(args.certification, "--certification");
  let about = needText(args.about, "--about");
  if (!/[.!?]$/.test(about)) about += ".";

  // The exam name: the argument, else the entry of the exam in beta-exams.json.
  let examName =
    args.name === undefined ? undefined : needText(args.name, "--name");
  if (examName === undefined) {
    const file = fromRoot(
      env.BETA_EXAMS_FILE,
      join(root, "src", "data_files", "beta-exams.json"),
    );
    try {
      const tracker = JSON.parse(readFileSync(file, "utf8"));
      examName = tracker.exams?.find((exam) => exam.code === code)?.name;
    } catch {
      // handled below
    }
    if (!examName) {
      throw new UsageError(
        `${code} has no entry with a name in ${shown(file)}: add it first or pass --name "<exam name>".`,
      );
    }
  }

  const announcementUrl = trackedUrl(args.announcement, "--announcement", [
    "techcommunity.microsoft.com",
    "learn.microsoft.com",
  ]);
  const registerUrl = trackedUrl(args["register-url"], "--register-url", [
    "learn.microsoft.com",
  ]);

  let scheduleUrl;
  if (args["schedule-url"] !== undefined) {
    const url = cleanUrl(args["schedule-url"], "--schedule-url", [
      "learn.microsoft.com",
    ]);
    if (
      !url.pathname.includes("schedule-through-pearson-vue") ||
      url.searchParams.get("examUid") !== `exam.${code}`
    ) {
      throw new UsageError(
        `--schedule-url must be the Pearson VUE scheduling link of ${code} (…/schedule-through-pearson-vue?examUid=exam.${code}&examUrl=…).`,
      );
    }
    // the link as the maintainer gave it, with /en-us/ removed: no tracking parameter
    scheduleUrl = `${url.origin}${url.pathname}${url.search}`
      .replace(/%3A/gi, ":")
      .replace(/%2F/gi, "/");
  }

  const docsDir = fromRoot(env.DOCS_DIR, join(root, "src", "content", "docs"));
  const slug = betaVoucherSlug(code);
  const filePath = join(docsDir, "vouchers", `${slug}.mdx`);
  const page = shown(filePath);
  if (existsSync(filePath)) {
    throw new UsageError(`File already exists: ${page}`);
  }

  const mdx = buildBetaVoucherPage({
    code,
    examName,
    certification,
    about,
    announcementUrl,
    discountCode,
    deadline: String(deadline),
    registerUrl,
    scheduleUrl,
  });
  const problems = findBetaVoucherProblems(mdx);
  if (problems.length > 0) {
    throw new UsageError(
      `The generated page does not pass its own layout check (${problems.join("; ")}). Fix the arguments.`,
    );
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, mdx, "utf8");

  const when = formatLongDate(String(deadline));
  console.log(`✅  Created: ${page}`);
  console.log("");
  console.log("Next steps (the script writes nothing else):");
  console.log(
    `  1. Read the page once against the announcement: the offer note, the code, the deadline (${when}) and the exclusions.`,
  );
  console.log(
    `  2. Sidebar: add this first in voucherItems in src/data_files/docs-sidebar.ts:`,
  );
  console.log(`       {`);
  console.log(`         label: "Exam ${code} (beta)",`);
  console.log(`         href: docsPath("vouchers/${slug}"),`);
  console.log(`         badge: { text: "*80%", variant: "tip" },`);
  console.log(`       },`);
  console.log(
    `  3. Exam page: add this card to Get Started in src/content/docs/${area}/${code}.mdx, after the study guide and before the How to Prepare card:`,
  );
  console.log(
    `       <LinkCard title="Exam ${code} (beta)" href="/certs/vouchers/${slug}/" description="The first 300 people who take the beta exam on or before ${when} can get 80% off."/>`,
  );
  console.log(
    `  4. Tracker: set "announcement" of ${code} in src/data_files/beta-exams.json to ${announcementUrl}`,
  );
  console.log(
    `     then print the note and put it on the exam page: node scripts/beta-note.mjs --code ${code} --expects "<Microsoft's go-live wording>"`,
  );
  console.log(
    `  5. Run: pnpm dev, then open http://localhost:4321/certs/vouchers/${slug}/`,
  );
  console.log(`  6. Run: pnpm build && pnpm test:scripts`);
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
