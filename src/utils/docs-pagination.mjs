export function docsPagination(items, currentPath) {
  const flatten = (entries) =>
    entries.flatMap((item) =>
      item.children?.length
        ? flatten(item.children)
        : item.href
          ? [{ label: item.label, href: item.href }]
          : [],
    );
  const pages = flatten(items);
  const current = pages.findIndex(
    (page) => page.href.replace(/\/$/, "") === currentPath.replace(/\/$/, ""),
  );
  return current < 0
    ? {}
    : { previous: pages[current - 1], next: pages[current + 1] };
}
