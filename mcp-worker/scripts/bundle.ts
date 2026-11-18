/**
 * bundle.ts — runs at build time (Node.js via tsx)
 * Reads all MDX files from ../src/content/, parses frontmatter + LinkCards,
 * and writes content-bundle.json for the CF Worker to import.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSafeBundledContent } from "./content-safety.ts";
import type { BlogPost, ContentBundle, DocPage, ResourceLink } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = path.resolve(__dirname, "../../src/content");
const OUT_FILE = path.resolve(__dirname, "../content-bundle.json");

const VOUCHER_CATEGORIES = new Set(["100%", "50%", "Special"]);
const EXCLUDED_DOC_SLUGS = new Set([
  "guide/markdown",
  "labs/labcollection",
  "labs/labtemplate",
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md"))
      results.push(full);
  }
  return results;
}

function slugFrom(filePath: string, base: string): string {
  // Site routes are lowercase regardless of filename case (e.g. AZ-104.mdx -> azure/az-104)
  return path
    .relative(base, filePath)
    .replace(/\.mdx?$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function categoryFrom(filePath: string, base: string): string {
  const rel = path.relative(base, filePath);
  const parts = rel.split(path.sep);
  return parts.length > 1 ? (parts[0] ?? "root") : "root";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

export function attrVal(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}=(["'])([\\s\\S]*?)\\1`).exec(attrs);
  return m?.[2] !== undefined ? decodeHtmlEntities(m[2]) : undefined;
}

function extractSlotDiv(html: string, slotName: string): string | null {
  const openRe = new RegExp(`<div\\b[^>]*\\bslot=(["'])${slotName}\\1[^>]*>`);
  const openMatch = openRe.exec(html);
  if (!openMatch) return null;

  const contentStart = openMatch.index + openMatch[0].length;
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0] === "</div>") {
      depth--;
      if (depth === 0) return html.slice(contentStart, m.index);
    } else {
      depth++;
    }
  }
  return html.slice(contentStart);
}

export function unwrapActiveCourseVersion(
  src: string,
  todayIso = new Date().toISOString().slice(0, 10),
): string {
  return src.replace(
    /<CourseVersions\b([^>]*)>([\s\S]*?)<\/CourseVersions>/g,
    (_full, attrs: string, inner: string) => {
      const effective = attrVal(attrs, "effective");
      const wanted = effective && effective <= todayIso ? "upcoming" : "current";
      const slotHtml = extractSlotDiv(inner, wanted) ?? inner;
      return slotHtml
        .replace(/<div\b[^>]*\bclass=(["'])[^"']*\bcourse-legend\b[^"']*\1[^>]*>[\s\S]*?<\/div>/g, "")
        .replace(/<span\b[^>]*\bclass=(["'])[^"']*\bcourse-mark\b[^"']*\1[^>]*>[\s\S]*?<\/span>/g, "");
    },
  );
}

interface SectionRange {
  start: number;
  end: number;
  label: string;
}

function buildSectionRanges(src: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const stack: { start: number; label: string }[] = [];
  const tabRe = /<TabItem\b([^>]*)>|<\/TabItem>/g;
  let m: RegExpExecArray | null;
  while ((m = tabRe.exec(src)) !== null) {
    if (m[0] === "</TabItem>") {
      const open = stack.pop();
      if (open) {
        ranges.push({
          start: open.start,
          end: m.index + m[0].length,
          label: open.label,
        });
      }
    } else {
      const label = attrVal(m[1] ?? "", "label");
      if (label) stack.push({ start: m.index, label });
    }
  }

  const measureUpRe =
    /<MeasureUpCard\b[^>]*?(?:\/>|>[\s\S]*?<\/MeasureUpCard>)|<Card\b[^>]*\btitle=(["'])MeasureUp Practice Tests\1[^>]*>[\s\S]*?<\/Card>/g;
  while ((m = measureUpRe.exec(src)) !== null) {
    ranges.push({
      start: m.index,
      end: m.index + m[0].length,
      label: "MeasureUp",
    });
  }

  return ranges;
}

function tabForOffset(
  offset: number,
  ranges: SectionRange[],
): string | undefined {
  let best: SectionRange | undefined;
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) {
      if (!best || range.end - range.start < best.end - best.start) {
        best = range;
      }
    }
  }
  return best?.label;
}

export function extractLinks(
  rawSrc: string,
  todayIso = new Date().toISOString().slice(0, 10),
): ResourceLink[] {
  const src = unwrapActiveCourseVersion(stripComments(rawSrc), todayIso);
  const ranges = buildSectionRanges(src);
  const links: ResourceLink[] = [];
  const re = /<LinkCard\s([^>]*?)(?:\/>|>[\s\S]*?<\/LinkCard>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1] ?? "";
    const title = attrVal(attrs, "title");
    const href = attrVal(attrs, "href");
    if (!title || !href) continue;
    const description = attrVal(attrs, "description");
    const tab = tabForOffset(m.index, ranges);
    links.push({
      title,
      href,
      ...(description ? { description } : {}),
      ...(tab ? { tab } : {}),
    });
  }
  return links;
}

export function cleanDocBody(
  rawSrc: string,
  todayIso = new Date().toISOString().slice(0, 10),
): string {
  return unwrapActiveCourseVersion(stripComments(rawSrc), todayIso)
    // Imports are MDX implementation detail, not useful content.
    .replace(/^import\s+.*?;\s*$/gm, "")
    // Convert plain HTML headings (used in CourseVersions) into Markdown headings before tag stripping.
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g,
      (_full, level: string, inner: string) =>
        `${"#".repeat(Number(level))} ${inner.replace(/<\/?\w+\b[^>]*>/g, "").replace(/\s+/g, " ").trim()}`,
    )
    // Convert callout directives into clean Markdown blockquotes.
    .replace(
      /^:::(note|tip|caution|danger)(?:\[([^\]]*)\])?[ \t]*\r?\n([\s\S]*?)\r?\n:::[ \t]*$/gm,
      (_full, kind: string, label: string | undefined, inner: string) => {
        const heading = (label?.trim() || kind.toUpperCase());
        const quoted = inner
          .trim()
          .split(/\r?\n/)
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `> **${heading}:**\n${quoted}`;
      },
    )
    // LinkCards are returned as structured resources separately.
    .replace(/<LinkCard\s[^>]*?(?:\/>|>[\s\S]*?<\/LinkCard>)/g, "")
    // Remove common layout/component wrappers but keep inner prose.
    .replace(/<\/?(?:CardGrid|Card|Tabs|TabItem|Aside|Steps|FileTree|LinkButton|Badge|Icon|BetaBanner|RetirementBanner|MeasureUpCard|RelatedCerts)\b[^>]*>/g, "")
    // Drop remaining self-closing JSX/HTML widgets.
    .replace(/<\w+\b[^>]*\/>/g, "")
    // Drop remaining opening/closing tags while preserving inner text.
    .replace(/<\/?\w+\b[^>]*>/g, "")
    // Normalize whitespace without destroying markdown lists/headings.
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatIsoDay(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

// ─── Build docs ─────────────────────────────────────────────────────────────

export function buildDocs(
  todayIso = new Date().toISOString().slice(0, 10),
): DocPage[] {
  const docsDir = path.join(CONTENT_ROOT, "docs");
  return walkDir(docsDir).flatMap((file): DocPage[] => {
    const slug = slugFrom(file, docsDir);
    if (
      EXCLUDED_DOC_SLUGS.has(slug) ||
      (slug.startsWith("courses/") && slug.endsWith("-review"))
    ) {
      return [];
    }
    const raw = fs.readFileSync(file, "utf8");
    assertSafeBundledContent(raw, path.relative(CONTENT_ROOT, file));
    const { data, content } = matter(raw);
    // a draft is not published on the site (src/pages/certs/[...slug].astro), so it is not served here either
    if (data["draft"] === true) return [];
    const voucherCategory =
      typeof data["voucherCategory"] === "string" &&
      VOUCHER_CATEGORIES.has(data["voucherCategory"])
        ? (data["voucherCategory"] as "100%" | "50%" | "Special")
        : undefined;
    const voucherStarts = formatIsoDay(data["voucherStarts"]);
    const voucherEnds = formatIsoDay(data["voucherEnds"]);
    return [{
      slug,
      title: String(data["title"] ?? ""),
      ...(typeof data["examName"] === "string" && data["examName"].trim()
        ? { examName: data["examName"].trim() }
        : {}),
      ...(data["description"]
        ? { description: String(data["description"]) }
        : {}),
      category: categoryFrom(file, docsDir),
      ...(voucherCategory ? { voucherCategory } : {}),
      ...(voucherStarts ? { voucherStarts } : {}),
      ...(voucherEnds ? { voucherEnds } : {}),
      links: extractLinks(content, todayIso),
      body: cleanDocBody(content, todayIso),
    }];
  });
}

// ─── Build blog ─────────────────────────────────────────────────────────────

export function buildBlog(): BlogPost[] {
  const blogDir = path.join(CONTENT_ROOT, "blog");
  if (!fs.existsSync(blogDir)) return [];
  return walkDir(blogDir).flatMap((file): BlogPost[] => {
    const raw = fs.readFileSync(file, "utf8");
    assertSafeBundledContent(raw, path.relative(CONTENT_ROOT, file));
    const { data, content } = matter(raw);
    if (data["draft"] === true) return [];
    const authors = Array.isArray(data["authors"])
      ? (data["authors"] as { name: string }[]).map((a) => ({ name: a.name }))
      : [];
    return [{
      slug: slugFrom(file, blogDir),
      title: String(data["title"] ?? ""),
      description: String(data["description"] ?? ""),
      pubDate: String(data["pubDate"] ?? ""),
      ...(data["updatedDate"]
        ? { updatedDate: String(data["updatedDate"]) }
        : {}),
      authors,
      tags: Array.isArray(data["tags"]) ? (data["tags"] as string[]) : [],
      readTime: Number(data["readTime"] ?? 0),
      body: stripComments(content).trim(),
    }];
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const bundle: ContentBundle = {
    docs: buildDocs(),
    blog: buildBlog(),
    generatedAt: new Date().toISOString(),
    contentTrust: "untrusted",
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(bundle, null, 2));

  const docCount = bundle.docs.length;
  const blogCount = bundle.blog.length;
  const totalLinks = bundle.docs.reduce((n, d) => n + d.links.length, 0);
  const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);

  console.log(`✓ content-bundle.json written (${sizeKb} KB)`);
  console.log(
    `  ${docCount} docs | ${blogCount} blog posts | ${totalLinks} total links`,
  );
}
