/**
 * Pure URL and title normalization helpers for client-side saved bookmarks.
 */

/**
 * @param {string} pathname
 * @returns {string}
 */
export function normalizeBookmarkPath(pathname) {
  const clean = (pathname || "/").split("?")[0]?.split("#")[0] || "/";
  if (clean === "/") return "/";
  return clean.endsWith("/") ? clean : `${clean}/`;
}

/**
 * @param {string} rawTitle
 * @returns {string}
 */
export function cleanBookmarkTitle(rawTitle) {
  const trimmed = String(rawTitle ?? "")
    .replace(/\s*[|–-]\s*Microsoft Certification Hub\s*$/i, "")
    .replace(/\s*[|–-]\s*MSFTHub\s*$/i, "")
    .trim();
  return trimmed || "Microsoft Certification Hub";
}
