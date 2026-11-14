export function docsPagination(items, currentPath, options = {}) {
  const flatten = (entries) =>
    entries.flatMap((item) =>
      item.children?.length
        ? flatten(item.children)
        : item.href
          ? [{ label: item.label, href: item.href }]
          : [],
    );
  const normalize = (path) => path.replace(/\/$/, "") || "/";
  const groups = items.map((item) => flatten([item]));
  const group = groups.find((pages) =>
    pages.some((page) => normalize(page.href) === normalize(currentPath)),
  );
  if (!group) return {};

  const current = group.findIndex(
    (page) => normalize(page.href) === normalize(currentPath),
  );
  const override = (value, fallback) => {
    if (value === false) return undefined;
    if (typeof value === "string") {
      const target = flatten(items).find(
        (page) => normalize(page.href) === normalize(value),
      );
      return target ?? { label: value, href: value };
    }
    return fallback;
  };

  return {
    previous: override(options.prev, group[current - 1]),
    next: override(options.next, group[current + 1]),
  };
}
