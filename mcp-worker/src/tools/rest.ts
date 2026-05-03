import type { RegisteredTool } from "../protocol.ts";
import type { ContentBundle, DocPage } from "../types.ts";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function notFound(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function findDoc(docs: DocPage[], slug: string): DocPage | undefined {
  const lower = slug.toLowerCase();
  return docs.find(
    (d) =>
      d.slug.toLowerCase() === lower ||
      d.slug.toLowerCase().endsWith(`/${lower}`),
  );
}

function groupLinks(doc: DocPage) {
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
  return grouped;
}

export function voucherTools(bundle: ContentBundle): RegisteredTool[] {
  const vouchers = bundle.docs.filter(
    (d: DocPage) => d.category === "vouchers",
  );

  return [
    {
      definition: {
        name: "msfthub_list_vouchers",
        description:
          "List all discounted Microsoft exam voucher programs on msfthub. " +
          "Includes free and discounted exam voucher opportunities.",
        inputSchema: { type: "object", properties: {} },
      },
      handler() {
        return json(
          vouchers.map((v: DocPage) => ({
            slug: v.slug,
            title: v.title,
            description: v.description,
            url: `https://msfthub.com/${v.slug}`,
          })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_voucher",
        description:
          "Get full details and links for a specific exam voucher program. " +
          "Use slug from msfthub_list_vouchers, e.g. 'virtualtrainingdays', 'betaexams'.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "Voucher slug, e.g. 'virtualtrainingdays', 'betaexams', 'partnerweek'",
            },
          },
          required: ["slug"],
        },
      },
      handler({ slug }) {
        const doc = findDoc(vouchers, String(slug));
        if (!doc)
          return notFound(
            `Voucher '${slug}' not found. Use msfthub_list_vouchers to see available programs.`,
          );

        return json({
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          url: `https://msfthub.com/${doc.slug}`,
          content: doc.body,
          links: groupLinks(doc),
        });
      },
    },
  ];
}

export function guideTools(bundle: ContentBundle): RegisteredTool[] {
  const guides = bundle.docs.filter((d: DocPage) => d.category === "guide");

  return [
    {
      definition: {
        name: "msfthub_list_guides",
        description:
          "List all certification program guide pages on msfthub. " +
          "Covers scheduling exams, certification dashboard, renewal, student opportunities, and more.",
        inputSchema: { type: "object", properties: {} },
      },
      handler() {
        return json(
          guides.map((g: DocPage) => ({
            slug: g.slug,
            title: g.title,
            description: g.description,
            url: `https://msfthub.com/${g.slug}`,
          })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_guide",
        description:
          "Get content and links from a specific certification guide page. " +
          "Use slug from msfthub_list_guides, e.g. 'schedulingexam', 'certificationrenewal'.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "Guide slug, e.g. 'schedulingexam', 'certificationrenewal', 'studentopportunities'",
            },
          },
          required: ["slug"],
        },
      },
      handler({ slug }) {
        const doc = findDoc(guides, String(slug));
        if (!doc)
          return notFound(
            `Guide '${slug}' not found. Use msfthub_list_guides to see available guides.`,
          );

        return json({
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          url: `https://msfthub.com/${doc.slug}`,
          content: doc.body,
          links: doc.links,
        });
      },
    },
  ];
}

export function labTools(bundle: ContentBundle): RegisteredTool[] {
  const labs = bundle.docs.filter((d: DocPage) => d.category === "labs");

  return [
    {
      definition: {
        name: "msfthub_get_exam_labs",
        description:
          "Get lab exercise resources for a specific Microsoft certification exam. " +
          "Returns links to Microsoft Learn labs and hands-on exercises.",
        inputSchema: {
          type: "object",
          properties: {
            exam: {
              type: "string",
              description: "Exam code, e.g. 'AZ-900', 'SC-300', 'DP-900'",
            },
          },
          required: ["exam"],
        },
      },
      handler({ exam }) {
        const lower = String(exam).toLowerCase().replace(/-/g, "");
        const doc = labs.find(
          (d: DocPage) =>
            d.slug.toLowerCase().includes(lower) ||
            d.slug.toLowerCase().endsWith(`/${String(exam).toLowerCase()}`),
        );

        if (!doc)
          return notFound(
            `No lab page found for exam '${exam}'. Labs may not be available for all exams.`,
          );

        return json({
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          url: `https://msfthub.com/${doc.slug}`,
          content: doc.body,
          labs: doc.links,
        });
      },
    },
  ];
}

export function blogTools(bundle: ContentBundle): RegisteredTool[] {
  return [
    {
      definition: {
        name: "msfthub_list_blog_posts",
        description:
          "List all msfthub blog posts covering Microsoft certification news, " +
          "site updates, new voucher offers, and announcements.",
        inputSchema: { type: "object", properties: {} },
      },
      handler() {
        return json(
          bundle.blog.map((p) => ({
            slug: p.slug,
            title: p.title,
            description: p.description,
            pubDate: p.pubDate,
            updatedDate: p.updatedDate,
            authors: p.authors,
            tags: p.tags,
            readTime: p.readTime,
            url: `https://msfthub.com/news/${p.slug}`,
          })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_blog_post",
        description:
          "Get the full content and metadata of a specific msfthub blog post. " +
          "Use slug from msfthub_list_blog_posts.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Blog post slug, e.g. 'new-site-and-changes'",
            },
          },
          required: ["slug"],
        },
      },
      handler({ slug }) {
        const post = bundle.blog.find(
          (p) => p.slug === slug || p.slug.endsWith(`/${slug}`),
        );

        if (!post)
          return notFound(
            `Blog post '${slug}' not found. Use msfthub_list_blog_posts to see available posts.`,
          );

        return json({
          slug: post.slug,
          title: post.title,
          description: post.description,
          pubDate: post.pubDate,
          updatedDate: post.updatedDate,
          authors: post.authors,
          tags: post.tags,
          readTime: post.readTime,
          url: `https://msfthub.com/news/${post.slug}`,
          content: post.body,
        });
      },
    },
  ];
}
