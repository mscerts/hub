/**
 * bundle.ts — runs at build time (Node.js via tsx)
 * Reads all MDX files from ../src/content/, parses frontmatter + LinkCards,
 * and writes content-bundle.json for the CF Worker to import.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = path.resolve(__dirname, "../../src/content");
const OUT_FILE = path.resolve(__dirname, "../content-bundle.json");

// ─── Types ─────────────────────────────────────────────────────────────────

interface ResourceLink {
  title: string;
  href: string;
  description?: string;
  tab?: string;
}

interface DocPage {
  slug: string;
  title: string;
  description?: string;
  category: string;
  links: ResourceLink[];
}

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  updatedDate?: string;
  authors: { name: string }[];
  tags: string[];
  readTime: number;
  body: string;
}

interface ContentBundle {
  docs: DocPage[];
  blog: BlogPost[];
  generatedAt: string;
}

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
  return path
    .relative(base, filePath)
    .replace(/\.mdx?$/, "")
    .replace(/\\/g, "/");
}

function categoryFrom(filePath: string, base: string): string {
  const rel = path.relative(base, filePath);
  const parts = rel.split(path.sep);
  return parts.length > 1 ? (parts[0] ?? "root") : "root";
}

function attrVal(attrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}=["']([^"']*?)["']`).exec(attrs);
  return m?.[1];
}

function buildTabMap(src: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /<TabItem\s[^>]*label=["']([^"']+)["'][^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) map.set(m.index, m[1]);
  return map;
}

function tabForOffset(
  offset: number,
  tabs: Map<number, string>,
): string | undefined {
  let result: string | undefined;
  for (const [start, label] of tabs) {
    if (start < offset) result = label;
    else break;
  }
  return result;
}

function extractLinks(src: string): ResourceLink[] {
  const tabs = buildTabMap(src);
  const links: ResourceLink[] = [];
  const re = /<LinkCard\s([^>]*?)(?:\/>|>[\s\S]*?<\/LinkCard>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1];
    const title = attrVal(attrs, "title");
    const href = attrVal(attrs, "href");
    if (!title || !href) continue;
    const description = attrVal(attrs, "description");
    const tab = tabForOffset(m.index, tabs);
    links.push({
      title,
      href,
      ...(description ? { description } : {}),
      ...(tab ? { tab } : {}),
    });
  }
  return links;
}

// ─── Build docs ─────────────────────────────────────────────────────────────

function buildDocs(): DocPage[] {
  const docsDir = path.join(CONTENT_ROOT, "docs");
  return walkDir(docsDir).map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);
    return {
      slug: slugFrom(file, docsDir),
      title: String(data["title"] ?? ""),
      ...(data["description"]
        ? { description: String(data["description"]) }
        : {}),
      category: categoryFrom(file, docsDir),
      links: extractLinks(content),
    };
  });
}

// ─── Build blog ─────────────────────────────────────────────────────────────

function buildBlog(): BlogPost[] {
  const blogDir = path.join(CONTENT_ROOT, "blog");
  if (!fs.existsSync(blogDir)) return [];
  return walkDir(blogDir).map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);
    const authors = Array.isArray(data["authors"])
      ? (data["authors"] as { name: string }[]).map((a) => ({ name: a.name }))
      : [];
    return {
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
      body: content,
    };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const bundle: ContentBundle = {
  docs: buildDocs(),
  blog: buildBlog(),
  generatedAt: new Date().toISOString(),
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
