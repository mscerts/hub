import { unified } from "unified";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";

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
  attributes?: MdxAttribute[];
  children?: MdxNode[];
};

type MarkdownEntry = {
  data: {
    title?: string;
    description?: string;
  };
  body?: string;
};

function attributeValue(node: MdxNode, name: string): string | undefined {
  const attribute = node.attributes?.find((item) => item.type === "mdxJsxAttribute" && item.name === name);
  return typeof attribute?.value === "string" ? attribute.value : undefined;
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

export async function serializeMdx(body: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(() => (tree: MdxNode) => {
      tree.children = tree.children?.filter((node) => node.type !== "mdxjsEsm");
      visit(tree, (node: MdxNode, index: number | undefined, parent: MdxNode | undefined) => {
        if (index === undefined || !parent) return;

        if ((node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") && node.value?.trim().startsWith("/*")) {
          parent.children?.splice(index, 1);
          return index;
        }

        if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;

        const name = node.name;
        const children = childrenOf(node);

        if (name === "Tabs" || name === "CardGrid" || name === "Steps") {
          parent.children?.splice(index, 1, ...children);
          return index;
        }

        if (name === "TabItem" || name === "Step") {
          const label = attributeValue(node, "label") ?? attributeValue(node, "title");
          parent.children?.splice(index, 1, ...(label ? [headingNode(label), ...children] : children));
          return index;
        }

        if (name === "Aside") {
          const type = (attributeValue(node, "type") ?? "note").toUpperCase();
          parent.children?.splice(index, 1, {
            type: "blockquote",
            children: [{ type: "paragraph", children: [{ type: "strong", children: [textNode(`${type}:`)] }] }, ...children],
          });
          return index;
        }

        if (name === "Card" || name === "LinkCard") {
          const title = attributeValue(node, "title") ?? "Card";
          const href = attributeValue(node, "href");
          const description = attributeValue(node, "description");
          const extra = description ? [{ type: "paragraph", children: [textNode(description)] }] : [];
          parent.children?.splice(index, 1, headingNode(title, name === "LinkCard" ? href : undefined), ...extra, ...children);
          return index;
        }

        if (name === "LinkButton") {
          const href = attributeValue(node, "href");
          const label = children.length > 0 ? children : [textNode("Open link")];
          parent.children?.splice(index, 1, href ? { type: "paragraph", children: [{ type: "link", url: href, children: label }] } : { type: "paragraph", children: label });
          return index;
        }

        if (name && /^[A-Z]/.test(name)) {
          parent.children?.splice(index, 1, ...children);
          return index;
        }
      });
    })
    .use(remarkStringify);

  const result = await processor.process(body);
  return result.toString();
}

export function serializeFrontmatter(data: MarkdownEntry["data"]): string {
  const lines = ["---"];
  if (data.title) lines.push(`title: ${JSON.stringify(data.title)}`);
  if (data.description) lines.push(`description: ${JSON.stringify(data.description)}`);
  lines.push("---", "");
  return lines.join("\n");
}

export async function serializeEntry(entry: MarkdownEntry): Promise<string> {
  return `${serializeFrontmatter(entry.data)}${(await serializeMdx(entry.body ?? "")).trim()}\n`;
}
