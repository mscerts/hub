import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";
import { EXAM_AREAS } from "../../scripts/lib/areas.mjs";

const root = resolve(import.meta.dirname, "../..");

function walkMdx(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkMdx(full, out);
    else if (/\.(mdx|md)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

function stripCommentsAndFences(raw) {
  return raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) =>
      "\n".repeat(m.split("\n").length - 1),
    )
    .replace(/<!--[\s\S]*?-->/g, (m) => "\n".repeat(m.split("\n").length - 1))
    .replace(/^```[\s\S]*?^```/gm, (m) =>
      "\n".repeat(m.split("\n").length - 1),
    );
}

const THIRD_PARTY_NO_TRACKING_HOSTS = new Set([
  "github.com",
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  "microsoftlearning.github.io",
  "microsoft.github.io",
]);

const LEGACY_INTERNAL_PREFIX_RE =
  /^\/(?:wiki|wiki-next|azure|aibusiness|dynamics|github|microsoft365|power|security|guide|prepare|vouchers|labs|courses)(?:\/|$)/;

/**
 * Validate a single link extracted from MDX content.
 * Returns an array of human-readable problem strings.
 */
export function checkContentLink({
  file,
  line,
  href,
  title = "",
  hasTargetBlank = false,
  isExamPage = false,
  isActiveDocs = false,
  archivedIds = new Set(),
}) {
  const problems = [];
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
    return problems;
  }

  const loc = `${file}:${line}`;
  if (href.includes("#") && href.indexOf("?") > href.indexOf("#")) {
    problems.push(`${loc}: query string appears after #fragment in "${href}"`);
  }

  if (href.startsWith("/") || href.startsWith("https://msfthub.com")) {
    const relPath = href.replace(/^https:\/\/msfthub\.com/, "") || "/";
    if (hasTargetBlank) {
      problems.push(`${loc}: internal link carries target="_blank": "${href}"`);
    }
    const cleanPath = relPath.split("#")[0].split("?")[0];
    if (
      cleanPath !== "/" &&
      !cleanPath.endsWith("/") &&
      !/\.[a-z0-9]+$/i.test(cleanPath)
    ) {
      problems.push(`${loc}: internal link omits trailing slash: "${href}"`);
    }
    if (LEGACY_INTERNAL_PREFIX_RE.test(cleanPath)) {
      problems.push(
        `${loc}: internal link uses legacy non-/certs/ path: "${href}"`,
      );
    }
    const certSlug = cleanPath.match(/^\/certs\/(.+?)\/$/)?.[1];
    if (
      isActiveDocs &&
      certSlug &&
      !certSlug.startsWith("archive/") &&
      archivedIds.has(certSlug.toLowerCase())
    ) {
      problems.push(
        `${loc}: active docs page links to archived route "${href}" instead of "/certs/archive/${certSlug.toLowerCase()}/"`,
      );
    }
    return problems;
  }

  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return problems;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "learn.microsoft.com" || host.endsWith(".learn.microsoft.com")) {
    if (/^\/[a-z]{2}-[a-z]{2}(?:\/|$)/i.test(parsed.pathname)) {
      problems.push(`${loc}: Learn URL contains locale segment: "${href}"`);
    }
    // Pearson VUE handoff links intentionally carry no tracking parameter (AGENTS.md > Beta voucher format).
    if (
      !parsed.pathname.includes("/schedule-through-pearson-vue") &&
      parsed.searchParams.get("WT.mc_id") !== "studentamb_165290"
    ) {
      problems.push(
        `${loc}: Learn URL missing WT.mc_id=studentamb_165290: "${href}"`,
      );
    }
  }

  if (host === "www.measureup.com" || host === "measureup.com") {
    if (parsed.hash !== "#u44") {
      problems.push(`${loc}: MeasureUp URL missing #u44 fragment: "${href}"`);
    }
  }

  if (THIRD_PARTY_NO_TRACKING_HOSTS.has(host) && href.includes("WT.mc_id")) {
    problems.push(
      `${loc}: third-party URL carries Microsoft tracking param: "${href}"`,
    );
  }

  if (isExamPage && host === "esi.microsoft.com" && title) {
    if (
      /Instructor Lead|Instructed-led/i.test(title) ||
      (!title.includes("Microsoft Enterprise Skills Initiative") &&
        !title.startsWith("Exam "))
    ) {
      problems.push(`${loc}: non-canonical ESI LinkCard title "${title}"`);
    }
  }

  return problems;
}

export function expectedPrepareTier(code, examName) {
  if (["AB-730", "AB-731", "GH-700"].includes(code)) return "business";
  if (
    examName.includes("Fundamentals") ||
    code === "GH-900" ||
    code === "AB-900"
  ) {
    return "fundamentals";
  }
  return "role-based";
}

test("checkContentLink catches the URL, tracking, affiliate and archive mistakes seen in audits", () => {
  const archivedIds = new Set(["azure/az-800"]);
  assert.match(
    checkContentLink({
      file: "a.mdx",
      line: 3,
      href: "https://learn.microsoft.com/en-us/training/?WT.mc_id=studentamb_165290",
    }).join("\n"),
    /locale segment/,
  );
  assert.match(
    checkContentLink({
      file: "a.mdx",
      line: 4,
      href: "https://learn.microsoft.com/azure/cost#alert?WT.mc_id=studentamb_165290",
    }).join("\n"),
    /query string appears after #fragment/,
  );
  assert.match(
    checkContentLink({
      file: "a.mdx",
      line: 5,
      href: "https://www.measureup.com/microsoft.html",
    }).join("\n"),
    /#u44/,
  );
  assert.match(
    checkContentLink({
      file: "a.mdx",
      line: 6,
      href: "/certs/labs/azure/az-104/",
      hasTargetBlank: true,
    }).join("\n"),
    /target="_blank"/,
  );
  assert.match(
    checkContentLink({
      file: "a.mdx",
      line: 7,
      href: "/certs/azure/az-800/",
      isActiveDocs: true,
      archivedIds,
    }).join("\n"),
    /archived route/,
  );
  assert.match(
    checkContentLink({
      file: "AZ-104.mdx",
      line: 8,
      href: "https://esi.microsoft.com/Search?q=AZ-104",
      title: "Microsoft Enterprise Skills Initiative Instructor Lead course",
      isExamPage: true,
    }).join("\n"),
    /non-canonical ESI/,
  );
});

test("all content files use normalized URLs, canonical internal routes and ::: callout directives", () => {
  const archivedIds = new Set(
    walkMdx(join(root, "src", "content", "archive")).map((f) =>
      relative(join(root, "src", "content", "archive"), f)
        .replace(/\\/g, "/")
        .replace(/\.(mdx|md)$/i, "")
        .toLowerCase(),
    ),
  );

  const problems = [];

  for (const collection of ["docs", "archive", "blog"]) {
    for (const full of walkMdx(join(root, "src", "content", collection))) {
      const rel = relative(root, full).replace(/\\/g, "/");
      const raw = readFileSync(full, "utf8");
      const cleaned = stripCommentsAndFences(raw);

      if (/<Aside\b/.test(cleaned)) {
        problems.push(
          `${rel}: uses raw <Aside> JSX instead of :::note/:::tip/:::caution/:::danger directive`,
        );
      }

      // guide/markdown.mdx is an internal rendering showcase with synthetic links.
      if (
        rel === "src/content/docs/guide/markdown.mdx" ||
        collection === "archive"
      ) {
        continue;
      }

      const isExamPage =
        /^src\/content\/docs\/(?:aibusiness|azure|dynamics|github|microsoft365|power|security)\/[A-Z]{2,3}-\d{3}\.mdx$/.test(
          rel,
        );
      const isActiveDocs = collection === "docs";

      cleaned.split(/\r?\n/).forEach((line, i) => {
        const lineNo = i + 1;
        for (const m of line.matchAll(
          /<(?:LinkCard|LinkButton)\b([^>]*?)\/?>/g,
        )) {
          const attrs = m[1];
          const href = attrs.match(/\bhref="([^"]+)"/)?.[1] ?? "";
          const title = attrs.match(/\btitle="([^"]+)"/)?.[1] ?? "";
          const hasTargetBlank = /\btarget="_blank"/.test(attrs);
          problems.push(
            ...checkContentLink({
              file: rel,
              line: lineNo,
              href,
              title,
              hasTargetBlank,
              isExamPage,
              isActiveDocs,
              archivedIds,
            }),
          );
        }

        const withoutInlineCode = line.replace(/`[^`]*`/g, "");
        for (const m of withoutInlineCode.matchAll(
          /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g,
        )) {
          problems.push(
            ...checkContentLink({
              file: rel,
              line: lineNo,
              href: m[2],
              title: m[1],
              isExamPage,
              isActiveDocs,
              archivedIds,
            }),
          );
        }
      });
    }
  }

  assert.deepEqual(problems, []);
});

test("every exam page keeps practice tests out of Paid and ends Get Started with the matching How to Prepare card", () => {
  const problems = [];

  for (const area of EXAM_AREAS) {
    const dir = join(root, "src", "content", "docs", area);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".mdx")) continue;
      const full = join(dir, file);
      const rel = relative(root, full).replace(/\\/g, "/");
      const raw = readFileSync(full, "utf8");
      if (/^draft:\s*true\s*$/m.test(raw)) continue;

      const code = basename(file, ".mdx").toUpperCase();
      const examName =
        raw.match(/^examName:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
      const cleaned = stripCommentsAndFences(raw);

      const paidBody =
        cleaned.match(/<TabItem\s+label="Paid">([\s\S]*?)<\/TabItem>/)?.[1] ??
        "";
      for (const m of paidBody.matchAll(/<LinkCard\b[^>]*\btitle="([^"]+)"/g)) {
        const cardTitle = m[1];
        if (
          /\b(?:Practice Tests?|Practice Exams?|Assessments?)\b/i.test(
            cardTitle,
          ) &&
          !/\b(?:Course|Certkit)\b/i.test(cardTitle)
        ) {
          problems.push(
            `${rel}: practice-test card "${cardTitle}" sits in Paid tab instead of Tests tab`,
          );
        }
      }

      const getStarted =
        cleaned.match(
          /<Card\s+title="Get Started"[^>]*>([\s\S]*?)<Tabs>/,
        )?.[1] ?? "";
      const gsCards = [
        ...getStarted.matchAll(
          /<LinkCard\b[^>]*\btitle="([^"]+)"[^>]*\bhref="([^"]+)"/g,
        ),
      ];
      const lastCard = gsCards.at(-1);
      const tier = expectedPrepareTier(code, examName);
      const expectedHref = `/certs/prepare/${tier}/`;
      if (!lastCard || lastCard[2] !== expectedHref) {
        problems.push(
          `${rel}: last Get Started LinkCard must point to ${expectedHref} (found ${lastCard?.[2] ?? "none"})`,
        );
      }
    }
  }

  assert.deepEqual(problems, []);
});
