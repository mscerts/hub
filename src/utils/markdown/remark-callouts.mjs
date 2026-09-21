import { visit } from "unist-util-visit";

const calloutTypes = new Set(["note", "tip", "caution", "danger"]);

export default function remarkCallouts() {
  return (tree) => {
    visit(tree, "containerDirective", (node) => {
      if (!calloutTypes.has(node.name)) return;
      const type = node.name;

      node.type = "mdxJsxFlowElement";
      node.name = "Aside";
      node.attributes = [
        {
          type: "mdxJsxAttribute",
          name: "type",
          value: type,
        },
      ];
    });
  };
}
