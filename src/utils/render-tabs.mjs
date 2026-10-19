import { parseFragment, serialize } from "parse5";

export function renderTabPanels(html, idPrefix) {
  const fragment = parseFragment(html);
  const panels = fragment.childNodes.filter((node) =>
    node.attrs?.some((attr) => attr.name === "data-docs-tabs-content"),
  );
  const tabs = panels.map((panel, index) => {
    const label =
      panel.attrs.find((attr) => attr.name === "data-docs-tab-label")?.value ||
      `Tab ${index + 1}`;
    const id = `${idPrefix}-panel-${index}`;
    const attributes = new Map(
      panel.attrs.map(({ name, value }) => [name, value]),
    );
    attributes.set("id", id);
    attributes.set("role", "tabpanel");
    attributes.set("aria-labelledby", `${id}-tab`);
    attributes.set("tabindex", "0");
    if (index === 0) attributes.delete("hidden");
    else attributes.set("hidden", "");
    panel.attrs = [...attributes].map(([name, value]) => ({ name, value }));

    const fallback = parseFragment("<h3 hidden data-docs-tab-fallback></h3>")
      .childNodes[0];
    fallback.childNodes.push({
      nodeName: "#text",
      value: label,
      parentNode: fallback,
    });
    fallback.parentNode = panel;
    panel.childNodes.unshift(fallback);
    return { label, id };
  });
  return { html: serialize(fragment), tabs };
}
