import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { daysUntil } from "../guide-change-date.mjs";
import {
  bundlesForExam,
  examCodeOfEntryId,
  productsForExam,
} from "../measureup-bundles.mjs";
import { readRoadmap, roadmapOutline } from "../cert-roadmap.mjs";
import remarkCallouts from "./remark-callouts.mjs";

type MdxAttribute = {
  type: string;
  name?: string;
  value?: unknown;
};

type MdxNode = {
  type: string;
  name?: string;
  value?: string;
  url?: string;
  depth?: number;
  ordered?: boolean;
  spread?: boolean;
  attributes?: MdxAttribute[];
  children?: MdxNode[];
};

type MarkdownEntry = {
  id?: string;
  data: {
    title?: string;
    description?: string;
  };
  body?: string;
};

function attributeValue(node: MdxNode, name: string): string | undefined {
  const attribute = node.attributes?.find(
    (item) => item.type === "mdxJsxAttribute" && item.name === name,
  );
  return typeof attribute?.value === "string" ? attribute.value : undefined;
}

function attributeBoolean(node: MdxNode, name: string): boolean {
  const attribute = node.attributes?.find(
    (item) => item.type === "mdxJsxAttribute" && item.name === name,
  );
  if (!attribute) return false;
  if (attribute.value === null) return true;
  if (typeof attribute.value === "string") return attribute.value === "true";
  if (
    typeof attribute.value === "object" &&
    attribute.value !== null &&
    "value" in attribute.value
  ) {
    return (
      String((attribute.value as { value?: unknown }).value).trim() === "true"
    );
  }
  return false;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function parseRetireDateUtc(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const month = MONTHS.indexOf((match[1] ?? "").toLowerCase());
  if (month === -1) return null;
  return Date.UTC(Number(match[3]), month, Number(match[2]));
}

function paragraphNode(...children: MdxNode[]): MdxNode {
  return { type: "paragraph", children };
}

function asideBlockquoteNode(label: string, children: MdxNode[]): MdxNode {
  return {
    type: "blockquote",
    children: [
      paragraphNode({ type: "strong", children: [textNode(`${label}:`)] }),
      ...children,
    ],
  };
}

function textNode(value: string): MdxNode {
  return { type: "text", value };
}

function headingNode(title: string, href?: string): MdxNode {
  return {
    type: "heading",
    depth: 3,
    children: href
      ? [{ type: "link", url: href, children: [textNode(title)] }]
      : [textNode(title)],
  };
}

function childrenOf(node: MdxNode): MdxNode[] {
  return node.children ?? [];
}

/** The text of a node and its children, leaving out the badges of a course page with two versions. */
function plainText(node: MdxNode): string {
  if (node.type === "text") return node.value ?? "";
  if (attributeValue(node, "class")?.split(/\s+/).includes("course-mark"))
    return "";
  return childrenOf(node).map(plainText).join("");
}

type SerializeOptions = {
  /** The hub's code of the exam the page is about: the MeasureUp card lists the bundles that include it. */
  examCode?: string;
  /** The bundles to choose from (default: those of the MeasureUp baseline). */
  bundles?: Parameters<typeof bundlesForExam>[1];
  /** The MeasureUp products to choose from (default: those of the MeasureUp baseline). */
  products?: Parameters<typeof productsForExam>[1];
  /** The exam codes that are retired (default: what Microsoft has retired today). */
  retired?: Set<string>;
};

export async function serializeMdx(
  body: string,
  options: SerializeOptions = {},
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkMdx)
    .use(remarkCallouts)
    .use(() => (tree: MdxNode) => {
      tree.children = tree.children?.filter((node) => node.type !== "mdxjsEsm");
      visit(
        tree,
        (
          node: MdxNode,
          index: number | undefined,
          parent: MdxNode | undefined,
        ) => {
          if (index === undefined || !parent) return;

          if (
            (node.type === "mdxFlowExpression" ||
              node.type === "mdxTextExpression") &&
            node.value?.trim().startsWith("/*")
          ) {
            parent.children?.splice(index, 1);
            return index;
          }

          if (
            node.type !== "mdxJsxFlowElement" &&
            node.type !== "mdxJsxTextElement"
          )
            return;

          const name = node.name;
          const children = childrenOf(node);

          // A course page with two versions (docs/course-next.md): the copy is the course in force on the day the
          // site is built, the upcoming one from its effective day on, without the notes about the marks.
          if (name === "CourseVersions") {
            const effective = attributeValue(node, "effective");
            const wanted =
              effective && daysUntil(effective) <= 0 ? "upcoming" : "current";
            const slot = children.find(
              (child) =>
                child.name === "div" &&
                attributeValue(child, "slot") === wanted,
            );
            parent.children?.splice(
              index,
              1,
              ...(slot ? childrenOf(slot) : []),
            );
            return index;
          }

          if (
            name === "div" &&
            attributeValue(node, "class")
              ?.split(/\s+/)
              .includes("course-legend")
          ) {
            parent.children?.splice(index, 1);
            return index;
          }

          // the plain HTML headings of such a page are headings of the copy
          const level = name?.match(/^h([1-6])$/)?.[1];
          if (level) {
            parent.children?.splice(index, 1, {
              type: "heading",
              depth: Number(level),
              children: [textNode(plainText(node).replace(/\s+/g, " ").trim())],
            });
            return index;
          }

          if (name === "Tabs" || name === "CardGrid" || name === "Steps") {
            parent.children?.splice(index, 1, ...children);
            return index;
          }

          if (name === "TabItem" || name === "Step") {
            const label =
              attributeValue(node, "label") ?? attributeValue(node, "title");
            parent.children?.splice(
              index,
              1,
              ...(label ? [headingNode(label), ...children] : children),
            );
            return index;
          }

          if (name === "Aside") {
            const title = attributeValue(node, "title")?.trim();
            const type =
              title || (attributeValue(node, "type") ?? "note").toUpperCase();
            parent.children?.splice(
              index,
              1,
              asideBlockquoteNode(type, children),
            );
            return index;
          }

          if (name === "BetaBanner") {
            const summary = attributeValue(node, "summary");
            const note = attributeValue(node, "note");
            const extra: MdxNode[] = [];
            if (summary) extra.push(paragraphNode(textNode(summary)));
            if (note) extra.push(paragraphNode(textNode(note)));
            parent.children?.splice(
              index,
              1,
              asideBlockquoteNode("TIP", [...extra, ...children]),
            );
            return index;
          }

          if (name === "RetirementBanner") {
            const retireDate =
              attributeValue(node, "retireDate") ?? "an upcoming date";
            const certRetires = attributeBoolean(node, "certRetires");
            const certificationName = attributeValue(node, "certificationName");
            const replacementCode = attributeValue(node, "replacementCode");
            const replacementName = attributeValue(node, "replacementName");
            const replacementArea = attributeValue(node, "replacementArea");
            const replacementHref =
              attributeValue(node, "replacementHref") ??
              (replacementArea && replacementCode
                ? `/certs/${replacementArea}/${replacementCode.toLowerCase()}/`
                : undefined);
            const betaNote = attributeValue(node, "betaNote");
            const customNote = attributeValue(node, "note");

            const retireTime = parseRetireDateUtc(retireDate);
            const now = new Date();
            const todayUtc = Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate(),
            );
            const retired = retireTime !== null && retireTime < todayUtc;
            const leadText = retired
              ? certRetires
                ? `Exam and its certification${certificationName ? `, ${certificationName},` : ""} were retired on ${retireDate}.`
                : `The exam was retired on ${retireDate}. The certification remains, meaning you can renew it if you already have it.`
              : certRetires
                ? `Exam and its certification${certificationName ? `, ${certificationName},` : ""} are being retired on ${retireDate}.`
                : `The exam is being retired on ${retireDate}. The certification will remain, meaning you can renew it if you already have it.`;

            const bannerChildren: MdxNode[] = [
              paragraphNode(textNode(leadText)),
            ];
            if (replacementHref && replacementCode) {
              const label = `${replacementCode}${replacementName ? `: ${replacementName}` : ""}`;
              bannerChildren.push(
                paragraphNode(
                  textNode(
                    retired ? "It was replaced by " : "It will be replaced by ",
                  ),
                  {
                    type: "link",
                    url: replacementHref,
                    children: [textNode(label)],
                  },
                  textNode("."),
                ),
              );
            }
            if (betaNote)
              bannerChildren.push(paragraphNode(textNode(betaNote)));
            bannerChildren.push(...children);
            const closingNote =
              customNote ??
              (retired
                ? undefined
                : "Microsoft Learn always takes a while to update with certification retirements so don't panic if you can't see it there yet.");
            if (closingNote) {
              bannerChildren.push(paragraphNode(textNode(closingNote)));
            }
            parent.children?.splice(
              index,
              1,
              asideBlockquoteNode("CAUTION", bannerChildren),
            );
            return index;
          }

          if (name === "MeasureUpCard") {
            const ensureU44 = (url: string) =>
              url.includes("#u44") ? url : `${url}#u44`;
            const assessmentUrl = attributeValue(node, "assessmentUrl");
            const practiceTestUrl = attributeValue(node, "practiceTestUrl");
            const productsSlot = children.filter(
              (child) => attributeValue(child, "slot") === "products",
            );
            const beforeDiscountSlot = children.filter(
              (child) => attributeValue(child, "slot") === "before-discount",
            );
            const defaultSlot = children.filter(
              (child) => !attributeValue(child, "slot"),
            );
            const productNodes: MdxNode[] =
              productsSlot.length > 0
                ? productsSlot
                : !assessmentUrl && !practiceTestUrl
                  ? productsForExam(options.examCode, options.products).map(
                      (product) => headingNode(product.title, product.href),
                    )
                  : [
                      ...(assessmentUrl
                        ? [
                            headingNode(
                              "MeasureUp Assessment",
                              ensureU44(assessmentUrl),
                            ),
                          ]
                        : []),
                      ...(practiceTestUrl
                        ? [
                            headingNode(
                              "MeasureUp Practice Test",
                              ensureU44(practiceTestUrl),
                            ),
                          ]
                        : []),
                    ];

            const bundleCards = bundlesForExam(
              options.examCode,
              options.bundles,
              options.retired,
            );
            parent.children?.splice(
              index,
              1,
              headingNode("MeasureUp Practice Tests"),
              ...productNodes,
              headingNode(
                "MeasureUp Subscriptions",
                "https://www.measureup.com/subscription-plans-for-individuals#u44",
              ),
              paragraphNode(
                textNode(
                  "Official Microsoft Practice tests. They are expensive but they will prepare you for the exam. They are harder than normal exam questions but that helps even more to identify your weak areas and where you need to study more. There are also cheaper assessments but they contain less questions and no explanations.",
                ),
              ),
              paragraphNode(
                textNode(
                  "MeasureUp also offers subscriptions in case you are planning to take multiple exams in the next 12 months.",
                ),
              ),
              ...beforeDiscountSlot,
              asideBlockquoteNode("TIP", [
                paragraphNode(
                  textNode("Use our code "),
                  { type: "strong", children: [textNode("MSFTHUB")] },
                  textNode(
                    " for an exclusive 15% discount on the MeasureUp store!",
                  ),
                ),
              ]),
              ...(bundleCards.length > 0
                ? [
                    paragraphNode(
                      textNode("Discounted bundles with other exams:"),
                    ),
                    ...bundleCards.map((bundle) =>
                      headingNode(bundle.title, bundle.href),
                    ),
                  ]
                : []),
              ...defaultSlot,
            );
            return index;
          }

          if (name === "CertRoadmap") {
            // the decision tree is a page of links in the browser; the copy lists it as one nested list
            type Item = ReturnType<typeof roadmapOutline>[number];
            const toList = (items: Item[]): MdxNode => ({
              type: "list",
              ordered: false,
              spread: false,
              children: items.map((item) => ({
                type: "listItem",
                spread: false,
                children: [
                  paragraphNode(
                    item.href
                      ? {
                          type: "link",
                          url: item.href,
                          children: [textNode(item.text)],
                        }
                      : textNode(item.text),
                  ),
                  ...(item.children?.length ? [toList(item.children)] : []),
                ],
              })),
            });
            parent.children?.splice(
              index,
              1,
              toList(roadmapOutline(readRoadmap())),
            );
            return index;
          }

          if (name === "RelatedCerts") {
            parent.children?.splice(index, 1);
            return index;
          }

          if (name === "Card" || name === "LinkCard") {
            const title = attributeValue(node, "title") ?? "Card";
            const href = attributeValue(node, "href");
            const description = attributeValue(node, "description");
            const extra = description
              ? [{ type: "paragraph", children: [textNode(description)] }]
              : [];
            parent.children?.splice(
              index,
              1,
              headingNode(title, name === "LinkCard" ? href : undefined),
              ...extra,
              ...children,
            );
            return index;
          }

          if (name === "LinkButton") {
            const href = attributeValue(node, "href");
            const label =
              children.length > 0 ? children : [textNode("Open link")];
            parent.children?.splice(
              index,
              1,
              href
                ? {
                    type: "paragraph",
                    children: [{ type: "link", url: href, children: label }],
                  }
                : { type: "paragraph", children: label },
            );
            return index;
          }

          if (name && /^[A-Z]/.test(name)) {
            parent.children?.splice(index, 1, ...children);
            return index;
          }
        },
      );
    })
    .use(remarkStringify);

  const result = await processor.process(body);
  return result.toString();
}

export function serializeFrontmatter(data: MarkdownEntry["data"]): string {
  const lines = ["---"];
  if (data.title) lines.push(`title: ${JSON.stringify(data.title)}`);
  if (data.description)
    lines.push(`description: ${JSON.stringify(data.description)}`);
  lines.push("---", "");
  return lines.join("\n");
}

export async function serializeEntry(entry: MarkdownEntry): Promise<string> {
  const examCode = examCodeOfEntryId(entry.id);
  return `${serializeFrontmatter(entry.data)}${(await serializeMdx(entry.body ?? "", { examCode })).trim()}\n`;
}
