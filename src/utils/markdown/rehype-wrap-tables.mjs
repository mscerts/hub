import { visit } from "unist-util-visit";

export default function rehypeWrapTables() {
  return (tree) => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName !== "table" || !parent || index === undefined) return;

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["docs-table-wrapper"] },
        children: [node],
      };
    });
  };
}
