import { visit } from "unist-util-visit";

const calloutTypes = new Set(["note", "tip", "caution", "danger"]);

function plainLabelText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(plainLabelText).join("");
}

export default function remarkCallouts() {
  return (tree) => {
    visit(tree, "containerDirective", (node) => {
      if (!calloutTypes.has(node.name)) return;
      const type = node.name;
      const attributes = [
        {
          type: "mdxJsxAttribute",
          name: "type",
          value: type,
        },
      ];

      if (node.children?.[0]?.data?.directiveLabel) {
        const labelNode = node.children.shift();
        const title = plainLabelText(labelNode).trim();
        if (title) {
          attributes.push({
            type: "mdxJsxAttribute",
            name: "title",
            value: title,
          });
        }
      }

      node.type = "mdxJsxFlowElement";
      node.name = "Aside";
      node.attributes = attributes;
    });
  };
}
