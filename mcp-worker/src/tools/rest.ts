import type { RegisteredTool } from "../protocol.ts";
import type { ContentBundle, DocPage } from "../types.ts";

const AREA_BY_PREFIX: Record<string, string> = {
  AB: "aibusiness",
  AI: "azure",
  AZ: "azure",
  DP: "azure",
  GH: "github",
  MB: "dynamics",
  MD: "microsoft365",
  MS: "microsoft365",
  PL: "power",
  SC: "security",
};

const COURSE_AREAS = [
  "azure",
  "aibusiness",
  "github",
  "microsoft365",
  "security",
  "power",
  "dynamics",
] as const;

function canonicalDocUrl(slug: string): string {
  return `https://msfthub.com/certs/${slug}/`;
}

function canonicalBlogUrl(slug: string): string {
  return `https://msfthub.com/news/${slug}/`;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function notFound(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function findDoc(docs: DocPage[], slug: string): DocPage | undefined {
  const lower = slug.trim().toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return docs.find((d) => {
    const docSlug = d.slug.toLowerCase();
    const tail = docSlug.split("/").pop() ?? "";
    return (
      docSlug === lower ||
      tail === lower ||
      (compact.length > 0 && tail.replace(/[^a-z0-9]/g, "") === compact)
    );
  });
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

function courseExamCode(slug: string): string {
  return (slug.split("/").pop() ?? slug).toUpperCase();
}

function courseArea(slug: string): string | undefined {
  const prefix = courseExamCode(slug).split("-")[0] ?? "";
  return AREA_BY_PREFIX[prefix];
}

export function voucherTools(bundle: ContentBundle): RegisteredTool[] {
  // Only categorized voucher pages are active offers (paused/ended pages omit voucherCategory).
  const vouchers = bundle.docs.filter(
    (d: DocPage) => d.category === "vouchers" && Boolean(d.voucherCategory),
  );

  return [
    {
      definition: {
        name: "msfthub_list_vouchers",
        description:
          "List active discounted Microsoft exam voucher programs on msfthub. " +
          "Includes free and discounted exam voucher opportunities.",
        inputSchema: { type: "object", properties: {} },
      },
      handler() {
        return json(
          vouchers.map((v: DocPage) => ({
            slug: v.slug,
            title: v.title,
            description: v.description,
            voucherCategory: v.voucherCategory,
            ...(v.voucherStarts ? { voucherStarts: v.voucherStarts } : {}),
            ...(v.voucherEnds ? { voucherEnds: v.voucherEnds } : {}),
            url: canonicalDocUrl(v.slug),
          })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_voucher",
        description:
          "Get full details and links for a specific active exam voucher program. " +
          "Use slug from msfthub_list_vouchers, e.g. 'studentdiscount', 'betaexams'.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "Voucher slug, e.g. 'studentdiscount', 'betaexams', 'partnerweek'",
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
          voucherCategory: doc.voucherCategory,
          ...(doc.voucherStarts ? { voucherStarts: doc.voucherStarts } : {}),
          ...(doc.voucherEnds ? { voucherEnds: doc.voucherEnds } : {}),
          url: canonicalDocUrl(doc.slug),
          content: doc.body,
          links: groupLinks(doc),
        });
      },
    },
  ];
}

export function guideTools(bundle: ContentBundle): RegisteredTool[] {
  const guides = bundle.docs.filter(
    (d: DocPage) =>
      (d.category === "guide" && d.slug !== "guide/markdown") ||
      d.category === "prepare",
  );

  return [
    {
      definition: {
        name: "msfthub_list_guides",
        description:
          "List all certification program and exam preparation guide pages on msfthub. " +
          "Covers scheduling exams, certification dashboard, renewal, student opportunities, and how to prepare.",
        inputSchema: { type: "object", properties: {} },
      },
      handler() {
        return json(
          guides.map((g: DocPage) => ({
            slug: g.slug,
            title: g.title,
            description: g.description,
            category: g.category,
            url: canonicalDocUrl(g.slug),
          })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_guide",
        description:
          "Get content and links from a specific certification or preparation guide page. " +
          "Use slug from msfthub_list_guides, e.g. 'schedulingexam', 'certificationrenewal', 'role-based'.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "Guide slug, e.g. 'schedulingexam', 'certificationrenewal', 'fundamentals', 'role-based'",
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
          category: doc.category,
          url: canonicalDocUrl(doc.slug),
          content: doc.body,
          links: doc.links,
        });
      },
    },
  ];
}

export function labTools(bundle: ContentBundle): RegisteredTool[] {
  const labs = bundle.docs.filter(
    (d: DocPage) => d.category === "labs" && /^labs\/[^/]+\/[^/]+$/.test(d.slug),
  );

  return [
    {
      definition: {
        name: "msfthub_get_exam_labs",
        description:
          "Get lab exercise resources for a specific Microsoft certification exam. " +
          "Returns links to Applied Skills, Microsoft Learn labs, and GitHub hands-on exercises.",
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
        const raw = String(exam).trim().toLowerCase();
        const normalized = raw
          .replace(/^(?:certs\/)?(?:labs\/)?(?:[a-z0-9]+\/)?/, "")
          .replace(/[^a-z0-9]/g, "");
        const doc =
          normalized.length > 0
            ? labs.find((d: DocPage) => {
                const docSlug = d.slug.toLowerCase();
                const code = (docSlug.split("/").pop() ?? "").replace(
                  /[^a-z0-9]/g,
                  "",
                );
                return docSlug === raw || code === normalized;
              })
            : undefined;

        if (!doc)
          return notFound(
            `No lab page found for exam '${exam}'. Labs may not be available for all exams.`,
          );

        return json({
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          url: canonicalDocUrl(doc.slug),
          content: doc.body,
          labs: doc.links,
          labsByCategory: groupLinks(doc),
        });
      },
    },
  ];
}

export function courseTools(bundle: ContentBundle): RegisteredTool[] {
  const courses = bundle.docs.filter(
    (d: DocPage) => d.category === "courses" && !d.slug.endsWith("-review"),
  );

  return [
    {
      definition: {
        name: "msfthub_list_courses",
        description:
          "List structured Study Guide Courses on msfthub. " +
          "Each course maps official study guide skills task-by-task to Microsoft Learn modules and documentation.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [...COURSE_AREAS],
              description:
                "Optional exam area filter: azure | aibusiness | github | microsoft365 | security | power | dynamics",
            },
          },
        },
      },
      handler({ category }) {
        return json(
          courses
            .filter(
              (c: DocPage) => !category || courseArea(c.slug) === category,
            )
            .map((c: DocPage) => ({
              exam: courseExamCode(c.slug),
              slug: c.slug,
              title: c.title,
              description: c.description,
              category: courseArea(c.slug),
              resourceCount: c.links.length,
              url: canonicalDocUrl(c.slug),
            })),
        );
      },
    },

    {
      definition: {
        name: "msfthub_get_course",
        description:
          "Get the structured Study Guide Course for a Microsoft certification exam, " +
          "including task-by-task learning modules and documentation links. " +
          "Pass the exam code, e.g. 'AZ-104', 'SC-300', 'PL-300'.",
        inputSchema: {
          type: "object",
          properties: {
            exam: {
              type: "string",
              description: "Exam code or course slug, e.g. 'AZ-104', 'SC-300'",
            },
          },
          required: ["exam"],
        },
      },
      handler({ exam }) {
        const doc = findDoc(courses, String(exam));
        if (!doc)
          return notFound(
            `Study Guide Course '${exam}' not found. Use msfthub_list_courses to see available courses.`,
          );

        return json({
          exam: courseExamCode(doc.slug),
          slug: doc.slug,
          title: doc.title,
          description: doc.description,
          category: courseArea(doc.slug),
          url: canonicalDocUrl(doc.slug),
          content: doc.body,
          resources: groupLinks(doc),
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
            url: canonicalBlogUrl(p.slug),
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
          url: canonicalBlogUrl(post.slug),
          content: post.body,
        });
      },
    },
  ];
}
