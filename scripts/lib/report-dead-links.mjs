// Shared by the availability checks that run between lychee and `scripts/link-failures.mjs`
// (`youtube-availability.mjs`, `levelup-availability.mjs`): read the links of lychee's report that
// answered fine, and add the ones a platform-specific check found gone to the report as dead links.
// The Link Checker then judges them like any other dead link: reported after two runs on different
// days, in the same issue and tracker, with the file and line.

/** Links with fewer than this many answers are not judged by their share of gone ones. */
export const MIN_FOR_SHARE = 20;

/**
 * The links of a lychee report that worked, for which `describe(url)` returns a target (not null):
 * Map of link -> { target, pages }. Links lychee already listed as dead are left out. `pages` are the
 * input files of the report that contain the link.
 */
export function collectSuccessfulLinks(report, describe) {
  const found = new Map();
  const map = report?.success_map;
  if (map && typeof map === "object") {
    for (const [page, list] of Object.entries(map)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item.url !== "string") continue;
        const target = describe(item.url);
        if (!target) continue;
        const entry = found.get(item.url) ?? { target, pages: new Set() };
        found.set(item.url, entry);
        entry.pages.add(page);
      }
    }
  }
  for (const list of Object.values(report?.error_map ?? {}))
    if (Array.isArray(list))
      for (const item of list) if (item?.url) found.delete(item.url);
  return found;
}

/**
 * Add dead links to the report's `error_map`, one entry per page that contains the link, and fix the
 * counters. `items` is [{ url, pages, code, text }]. Returns { added, links } (entries added, the
 * distinct links, sorted). The report is changed in place; nothing is added for an empty list.
 */
export function addDeadEntries(report, items) {
  const added = [];
  for (const { url, pages, code, text } of [...items].sort((a, b) =>
    a.url < b.url ? -1 : 1,
  )) {
    report.error_map ??= {};
    for (const page of [...pages].sort()) {
      (report.error_map[page] ??= []).push({ url, status: { text, code } });
      added.push(url);
    }
  }
  if (added.length > 0) {
    if (Number.isFinite(report.errors)) report.errors += added.length;
    if (Number.isFinite(report.successful))
      report.successful = Math.max(0, report.successful - added.length);
  }
  return { added: added.length, links: [...new Set(added)].sort() };
}

/**
 * Whether the number of links that look gone is a change of the platform or of its answers and not that
 * many deletions: more than `maxGone`, or (with at least MIN_FOR_SHARE links asked) more than
 * `maxGoneShare` of them.
 */
export function looksLikeAChange({ asked, gone }, { maxGone, maxGoneShare }) {
  return (
    gone > maxGone || (asked >= MIN_FOR_SHARE && gone / asked > maxGoneShare)
  );
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A number from the environment, or the fallback. */
export function envNumber(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n)
    ? n
    : fallback;
}
