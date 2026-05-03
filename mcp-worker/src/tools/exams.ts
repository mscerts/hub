import type { RegisteredTool, ToolResult } from "../protocol.ts";
import type { ContentBundle, DocPage } from "../types.ts";

const EXAM_CATEGORIES = [
  "azure",
  "aibusiness",
  "github",
  "microsoft365",
  "security",
  "power",
  "dynamics",
] as const;

function isExamCategory(cat: string): boolean {
  return (EXAM_CATEGORIES as readonly string[]).includes(cat);
}

function findDoc(docs: DocPage[], slug: string): DocPage | undefined {
  const lower = slug.toLowerCase();
  return docs.find(
    (d) =>
      d.slug.toLowerCase() === lower ||
      d.slug.toLowerCase().endsWith(`/${lower}`),
  );
}

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function notFound(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function examTools(bundle: ContentBundle): RegisteredTool[] {
  return [
    // ── msfthub_list_exams ───────────────────────────────────────────────────
    {
      definition: {
        name: "msfthub_list_exams",
        description:
          "List Microsoft certification exam study pages on msfthub. " +
          "Filter by category to narrow results.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [...EXAM_CATEGORIES],
              description:
                "Filter by category: azure | aibusiness | github | microsoft365 | security | power | dynamics",
            },
          },
        },
      },
      handler({ category }) {
        const exams = bundle.docs
          .filter((d: DocPage) => isExamCategory(d.category))
          .filter((d: DocPage) => !category || d.category === category)
          .map((d: DocPage) => ({
            slug: d.slug,
            title: d.title,
            description: d.description,
            category: d.category,
            url: `https://msfthub.com/${d.slug}`,
          }));
        return json(exams);
      },
    },

    // ── msfthub_get_exam ─────────────────────────────────────────────────────
    {
      definition: {
        name: "msfthub_get_exam",
        description:
          "Get all study resources for a specific Microsoft certification exam, " +
          "grouped by resource type (free courses, videos, practice tests, paid, misc). " +
          "Pass the exam code, e.g. 'AZ-900', 'SC-300', 'DP-900'.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Exam code, e.g. 'AZ-900', 'SC-300', 'GH-200'",
            },
          },
          required: ["slug"],
        },
      },
      handler({ slug }) {
        const doc = findDoc(
          bundle.docs.filter((d: DocPage) => isExamCategory(d.category)),
          String(slug),
        );
        if (!doc)
          return notFound(
            `Exam '${slug}' not found. Use msfthub_list_exams to see available exams.`,
          );

        const grouped: Record<
          string,
          { title: string; href: string; description?: string }[]
        > = {};
        for (const link of doc.links) {
          const tab = link.tab ?? "General";
          if (!grouped[tab]) grouped[tab] = [];
          grouped[tab].push({
            title: link.title,
            href: link.href,
            ...(link.description ? { description: link.description } : {}),
          });
        }

        return json({
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          category: doc.category,
          url: `https://msfthub.com/${doc.slug}`,
          content: doc.body,
          resources: grouped,
        });
      },
    },

    // ── msfthub_search_exams ─────────────────────────────────────────────────
    {
      definition: {
        name: "msfthub_search_exams",
        description:
          "Search Microsoft certification exam pages by keyword. " +
          "Searches titles and descriptions.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Keywords, e.g. 'Azure fundamentals', 'identity security'",
            },
          },
          required: ["query"],
        },
      },
      handler({ query }) {
        const lower = String(query).toLowerCase();
        const matches = bundle.docs
          .filter((d: DocPage) => isExamCategory(d.category))
          .filter(
            (d: DocPage) =>
              d.title.toLowerCase().includes(lower) ||
              (d.description ?? "").toLowerCase().includes(lower) ||
              d.slug.toLowerCase().includes(lower),
          )
          .map((d: DocPage) => ({
            slug: d.slug,
            title: d.title,
            description: d.description,
            category: d.category,
            url: `https://msfthub.com/${d.slug}`,
          }));
        return json(matches);
      },
    },
  ];
}
