import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attrVal,
  cleanDocBody,
  expandCertRoadmap,
  expandMeasureUpCard,
  extractLinks,
  unwrapActiveCourseVersion,
} from "../scripts/bundle.ts";
import { examTools } from "../src/tools/exams.ts";
import {
  blogTools,
  courseTools,
  guideTools,
  labTools,
  voucherTools,
} from "../src/tools/rest.ts";
import type { ContentBundle } from "../src/types.ts";

function parseResult(result: { content: { text: string }[]; isError?: boolean }) {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

describe("bundle extraction helpers", () => {
  test("preserves apostrophes and HTML entities in LinkCard attributes", () => {
    assert.equal(
      attrVal(
        `title="John Christopher's Course on Udemy" href="https://example.com"`,
        "title",
      ),
      "John Christopher's Course on Udemy",
    );
    assert.equal(
      attrVal(`title="Exam &quot;Beta&quot; &amp; Prep"`, "title"),
      'Exam "Beta" & Prep',
    );
  });

  test("writes the certification roadmap into the page as a nested list", () => {
    const body = expandCertRoadmap("Intro\n\n<CertRoadmap />\n");
    assert.match(body, /^- How much do you already work with Microsoft technology\?/m);
    assert.match(body, /AZ-104 \(\/certs\/azure\/az-104\/\)/);
    assert.equal(expandCertRoadmap("no roadmap"), "no roadmap");
  });

  test("writes the products of a bare MeasureUp card into the page, like a page that spells them out", () => {
    const bare = "<MeasureUpCard />\n";
    const links = extractLinks(bare, "2026-11-26", "AZ-104");
    assert.deepEqual(
      links.map((link) => [link.title, link.tab]),
      [
        ["MeasureUp Assessment", "MeasureUp"],
        ["MeasureUp Practice Test", "MeasureUp"],
      ],
    );
    for (const link of links)
      assert.match(link.href, /^https:\/\/www\.measureup\.com\/.+#u44$/);
    assert.equal(extractLinks(bare, "2026-11-26").length, 0);
    assert.equal(expandMeasureUpCard(bare), bare);
  });

  test("ignores commented-out tabs/cards and groups post-Tabs MeasureUp links separately", () => {
    const mdx = `
import { Tabs, TabItem, LinkCard } from '@components/docs';

{/*
<TabItem label="Applied Skills">
  <LinkCard title="Commented Skill" href="https://example.com/commented" />
</TabItem>
*/}

<LinkCard title="Study Guide" href="https://learn.microsoft.com/guide" />

<Tabs>
  <TabItem label="Paid">
    <LinkCard title="John Christopher's Course on Udemy" href="https://udemy.example/course" />
  </TabItem>
  <TabItem label="Misc">
    <LinkCard title="Community Repo" href="https://github.com/example/repo" />
  </TabItem>
</Tabs>

<MeasureUpCard>
  <CardGrid slot="products">
    <LinkCard title="MeasureUp Practice Test" href="https://www.measureup.com/test#u44" />
  </CardGrid>
</MeasureUpCard>
`;
    const links = extractLinks(mdx);
    assert.deepEqual(links, [
      {
        title: "Study Guide",
        href: "https://learn.microsoft.com/guide",
      },
      {
        title: "John Christopher's Course on Udemy",
        href: "https://udemy.example/course",
        tab: "Paid",
      },
      {
        title: "Community Repo",
        href: "https://github.com/example/repo",
        tab: "Misc",
      },
      {
        title: "MeasureUp Practice Test",
        href: "https://www.measureup.com/test#u44",
        tab: "MeasureUp",
      },
    ]);

    const body = cleanDocBody(`${mdx}\n:::note\nImportant detail.\n:::`);
    assert.doesNotMatch(body, /\{\/\*|Commented Skill|:::/);
    assert.match(body, /> \*\*NOTE:\*\*\n> Important detail\./);
  });

  test("selects only the active CourseVersions slot and converts HTML headings", () => {
    const mdx = `
<CourseVersions effective="2027-01-11" currentLabel="Current" upcomingLabel="Upcoming">
<div slot="intro">:::caution\nChanging soon\n:::</div>
<div slot="current">
<div class="course-legend">:::note\nLegend\n:::</div>
<h2 id="current-domain">Current Domain <span class="course-mark">Leaves</span></h2>
<LinkCard title="Current Module" href="https://learn.microsoft.com/current" />
</div>
<div slot="upcoming">
<div class="course-legend">:::note\nUpcoming legend\n:::</div>
<h2 id="upcoming-domain">Upcoming Domain</h2>
<LinkCard title="Upcoming Module" href="https://learn.microsoft.com/upcoming" />
</div>
</CourseVersions>
`;
    assert.deepEqual(extractLinks(mdx, "2026-11-18"), [
      { title: "Current Module", href: "https://learn.microsoft.com/current" },
    ]);
    assert.deepEqual(extractLinks(mdx, "2027-01-11"), [
      { title: "Upcoming Module", href: "https://learn.microsoft.com/upcoming" },
    ]);
    const currentBody = cleanDocBody(unwrapActiveCourseVersion(mdx, "2026-11-18"));
    assert.match(currentBody, /## Current Domain/);
    assert.doesNotMatch(currentBody, /Upcoming Domain|Leaves|Legend/);
  });
});

describe("MCP content tools", () => {
  const sampleBundle: ContentBundle = {
    generatedAt: "2026-11-18T00:00:00.000Z",
    contentTrust: "untrusted",
    docs: [
      {
        slug: "azure/az-104",
        title: "AZ-104 Study Materials",
        examName: "Microsoft Azure Administrator",
        description: "Study materials for AZ-104.",
        category: "azure",
        links: [
          {
            title: "Microsoft Learn",
            href: "https://learn.microsoft.com/training/courses/az-104t00?WT.mc_id=studentamb_165290",
            tab: "Text",
          },
        ],
        body: "Overview",
      },
      {
        slug: "vouchers/studentdiscount",
        title: "Student Exam Discount",
        description: "Academic discounts.",
        category: "vouchers",
        voucherCategory: "Special",
        links: [],
        body: "Verify academic status.",
      },
      {
        slug: "vouchers/virtualtrainingdays",
        title: "Virtual Training Days",
        description: "Paused voucher page without voucherCategory.",
        category: "vouchers",
        links: [],
        body: "Paused.",
      },
      {
        slug: "guide/schedulingexam",
        title: "Scheduling an Exam",
        description: "How to schedule.",
        category: "guide",
        links: [],
        body: "Steps.",
      },
      {
        slug: "prepare/role-based",
        title: "How to Prepare for Role-Based Exams",
        description: "Role-based exam readiness.",
        category: "prepare",
        links: [],
        body: "Readiness.",
      },
      {
        slug: "labs/azure/az-104",
        title: "AZ-104 Hands-on Labs",
        description: "Practical AZ-104 labs.",
        category: "labs",
        links: [
          {
            title: "Manage Entra ID",
            href: "https://learn.microsoft.com/training/modules/example",
            tab: "Microsoft Learn",
          },
        ],
        body: "Lab notes.",
      },
      {
        slug: "labs/labtemplate",
        title: "Lab Template",
        category: "labs",
        links: [],
        body: "Template",
      },
      {
        slug: "courses/az-104",
        title: "AZ-104 Study Guide Course",
        description: "Structured AZ-104 course.",
        category: "courses",
        links: [
          {
            title: "Understand Entra ID",
            href: "https://learn.microsoft.com/training/modules/understand-aad",
            tab: "Learning",
          },
        ],
        body: "## Manage Azure identities",
      },
    ],
    blog: [
      {
        slug: "new-site-and-changes",
        title: "New Site",
        description: "Site launch",
        pubDate: "2026-01-01",
        authors: [{ name: "Maintainer" }],
        tags: ["news"],
        readTime: 3,
        body: "Post body",
      },
    ],
  };

  test("searches examName and returns canonical /certs/ URLs", async () => {
    const tools = examTools(sampleBundle);
    const search = tools.find((t) => t.definition.name === "msfthub_search_exams")!;
    const matches = parseResult(
      await search.handler({ query: "Azure Administrator" }),
    ) as Array<{ slug: string; examName?: string; url: string }>;
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.examName, "Microsoft Azure Administrator");
    assert.equal(matches[0]?.url, "https://msfthub.com/certs/azure/az-104/");
  });

  test("excludes paused/unlisted vouchers lacking voucherCategory", async () => {
    const tools = voucherTools(sampleBundle);
    const list = tools.find((t) => t.definition.name === "msfthub_list_vouchers")!;
    const get = tools.find((t) => t.definition.name === "msfthub_get_voucher")!;
    const items = parseResult(await list.handler({})) as Array<{
      slug: string;
      url: string;
    }>;
    assert.deepEqual(items.map((i) => i.slug), ["vouchers/studentdiscount"]);
    assert.equal(items[0]?.url, "https://msfthub.com/certs/vouchers/studentdiscount/");

    const paused = await get.handler({ slug: "virtualtrainingdays" });
    assert.equal(paused.isError, true);
  });

  test("includes both guide and prepare pages in guideTools", async () => {
    const tools = guideTools(sampleBundle);
    const list = tools.find((t) => t.definition.name === "msfthub_list_guides")!;
    const items = parseResult(await list.handler({})) as Array<{ slug: string }>;
    assert.deepEqual(
      items.map((i) => i.slug),
      ["guide/schedulingexam", "prepare/role-based"],
    );
  });

  test("matches lab pages by exact exam code without substring false positives", async () => {
    const [getLabs] = labTools(sampleBundle);
    assert.ok(getLabs);

    for (const bad of ["azure", "lab", "labtemplate"]) {
      const res = await getLabs.handler({ exam: bad });
      assert.equal(res.isError, true, `expected '${bad}' not to match`);
    }

    for (const valid of ["AZ-104", "az104", "labs/azure/az-104"]) {
      const found = parseResult(await getLabs.handler({ exam: valid })) as {
        url: string;
        labsByCategory: Record<string, unknown[]>;
      };
      assert.equal(found.url, "https://msfthub.com/certs/labs/azure/az-104/");
      assert.equal(found.labsByCategory["Microsoft Learn"]?.length, 1);
    }
  });

  test("lists and retrieves Study Guide Courses and canonical blog URLs", async () => {
    const cTools = courseTools(sampleBundle);
    const listCourses = cTools.find(
      (t) => t.definition.name === "msfthub_list_courses",
    )!;
    const getCourse = cTools.find(
      (t) => t.definition.name === "msfthub_get_course",
    )!;

    const listed = parseResult(
      await listCourses.handler({ category: "azure" }),
    ) as Array<{ exam: string; url: string; resourceCount: number }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.exam, "AZ-104");
    assert.equal(listed[0]?.url, "https://msfthub.com/certs/courses/az-104/");
    assert.equal(listed[0]?.resourceCount, 1);

    const course = parseResult(await getCourse.handler({ exam: "AZ-104" })) as {
      exam: string;
      resources: Record<string, unknown[]>;
    };
    assert.equal(course.exam, "AZ-104");
    assert.equal(course.resources["Learning"]?.length, 1);

    const [listBlog] = blogTools(sampleBundle);
    const posts = parseResult(await listBlog!.handler({})) as Array<{
      url: string;
    }>;
    assert.equal(posts[0]?.url, "https://msfthub.com/news/new-site-and-changes/");
  });
});
