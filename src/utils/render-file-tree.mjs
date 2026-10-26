import { parseFragment, serialize } from "parse5";

const icon = (folder) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="file-tree-icon">${
    folder
      ? '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>'
      : '<path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6"/>'
  }</svg>`;

export function renderFileTree(html) {
  const fragment = parseFragment(html);
  const walk = (node) => {
    for (const child of [...(node.childNodes ?? [])]) walk(child);
    if (node.tagName !== "li") return;

    const children = node.childNodes;
    const list = children.find((child) => child.tagName === "ul");
    const label = children
      .filter((child) => child !== list)
      .flatMap((child) => (child.tagName === "p" ? child.childNodes : [child]));
    const text = (node) =>
      node.value ?? (node.childNodes ?? []).map(text).join("");
    const name = label.map(text).join("").trim().split(/\s/)[0];
    const folder = !!list || (name && !name.includes("."));
    const wrapper = parseFragment(
      list
        ? `<details open><summary>${icon(true)}</summary></details>`
        : `<span class="file-tree-file">${icon(folder)}</span>`,
    ).childNodes[0];
    const target = list ? wrapper.childNodes[0] : wrapper;
    for (const child of label) {
      child.parentNode = target;
      target.childNodes.push(child);
    }
    if (list) {
      list.parentNode = wrapper;
      wrapper.childNodes.push(list);
    }
    wrapper.parentNode = node;
    node.childNodes = [wrapper];
  };
  walk(fragment);
  return serialize(fragment);
}
