/**
 * The sidebar groups of the Microsoft Learn documentation (learnsync's data/docs-toc.json, docs/course-candidates.md):
 * pages that sit in the same group of a docs page's left sidebar are about the same topic ("Add users and groups >
 * Groups" holds both "Manage groups" and "Learn about groups"), so a page found for a task brings its neighbours.
 * Pure: no I/O. The file is written by learnsync's docs sidebar sync (docs/monitors/learn-research-caches.md).
 */

/**
 * The lookup of a docs-toc.json: `pages` (how many pages are in a group), `groupsOf(path)` the groups a page is in
 * (`{ toc, title, landing, pages }`) and `siblingsOf(path)` the other pages of those groups in sidebar order.
 * A file that is not a docs-toc (or null) gives an empty lookup.
 */
export function buildTocLookup(file) {
  const byPage = new Map();
  if (file && Array.isArray(file.tocs)) {
    for (const toc of file.tocs) {
      for (const group of toc?.groups ?? []) {
        const entry = {
          toc: toc.path,
          title: group.title ?? [],
          landing: group.landing ?? null,
          pages: group.pages ?? [],
        };
        for (const page of entry.landing
          ? [entry.landing, ...entry.pages]
          : entry.pages) {
          const list = byPage.get(page) ?? [];
          list.push(entry);
          byPage.set(page, list);
        }
      }
    }
  }
  return {
    pages: byPage.size,
    groupsOf: (path) => byPage.get(path) ?? [],
    siblingsOf: (path) => {
      const seen = new Set([path]);
      const out = [];
      for (const g of byPage.get(path) ?? [])
        for (const p of g.landing ? [g.landing, ...g.pages] : g.pages) {
          if (seen.has(p)) continue;
          seen.add(p);
          out.push(p);
        }
      return out;
    },
  };
}

/**
 * Microsoft names its concept articles by convention (`concept-learn-about-groups`, `what-is-x`, `x-overview`,
 * `introduction-to-x`): a page whose address says so is theory, whatever its title says.
 */
export const CONCEPT_SLUG =
  /(^|\/)(concept-|what-is-|introduction|overview|about-)|-(overview|concepts?|introduction)$/;

/** Whether the address of a documentation page names a concept article. */
export const isConceptPath = (path) =>
  CONCEPT_SLUG.test(String(path).split("/").slice(-1)[0] ?? "");
