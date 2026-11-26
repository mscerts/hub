import { readFileSync } from "node:fs";
import path from "node:path";

// MeasureUp sells bundles of the practice tests of two to four exams. The MeasureUp Monitor keeps them in
// `src/data_files/measureup-products.json` (`bundles`: id, MeasureUp's own name, the product address from its
// listing and the exam codes its product page includes), and the MeasureUp card of an exam page shows the
// ones that include the exam, unless one of the exams in the bundle is retired (a bundle holds the tests of
// every exam in it). Nothing here derives an address or an exam code from a name.

/** The seven areas of the exam pages (`scripts/lib/areas.mjs`), the only pages that carry a MeasureUp card. */
const AREAS =
  "(?:aibusiness|azure|dynamics|github|microsoft365|power|security)";

/**
 * @typedef {{ id: string, name: string, url: string, examCodes: string[] }} Bundle
 * @typedef {{ title: string, href: string, description: string }} BundleCard
 */

/**
 * The bundles of the baseline, or [] when the file has none (or cannot be read).
 * @returns {Bundle[]}
 */
export function readBundles(root = process.cwd()) {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.resolve(root, "src", "data_files", "measureup-products.json"),
        "utf8",
      ),
    );
    return Array.isArray(parsed.bundles) ? parsed.bundles : [];
  } catch {
    return [];
  }
}

/**
 * The exam codes Microsoft has retired by `today` (UTC): the exams of Learn's retirement schedule that are
 * retired, or scheduled for a day before today, and the exams of the hub's retirement tracker whose day has
 * passed. An exam is still on offer on its retirement day itself, like the RETIRING badge.
 * @returns {Set<string>}
 */
export function readRetiredExamCodes(root = process.cwd(), today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const read = (file) => {
    try {
      return JSON.parse(
        readFileSync(path.resolve(root, "src", "data_files", file), "utf8"),
      );
    } catch {
      return {};
    }
  };
  const retired = new Set();
  for (const row of read("retirement-schedule.json").rows ?? [])
    if (
      row?.kind === "exam" &&
      row.code &&
      (row.status === "retired" || (row.date && row.date < day))
    )
      retired.add(String(row.code).toUpperCase());
  for (const entry of read("retiring-exams.json").exams ?? [])
    if (entry?.code && entry.retirementDate && entry.retirementDate < day)
      retired.add(String(entry.code).toUpperCase());
  return retired;
}

/** The exam code of a docs page address, "/certs/azure/az-104/" -> "AZ-104", else undefined. */
export function examCodeOfPath(pathname) {
  const match = new RegExp(`^/certs/${AREAS}/([a-z]{2,3}-\\d{3})/?$`, "i").exec(
    pathname ?? "",
  );
  return match?.[1].toUpperCase();
}

/** The exam code of a docs collection id, "azure/az-104" -> "AZ-104", else undefined. */
export function examCodeOfEntryId(id) {
  const match = new RegExp(`^${AREAS}/([a-z]{2,3}-\\d{3})$`, "i").exec(
    id ?? "",
  );
  return match?.[1].toUpperCase();
}

const withTracking = (url) => (url.includes("#u44") ? url : `${url}#u44`);

/** "Bundle Azure Administrator (AZ-900 + AZ-104)" -> "Azure Administrator (AZ-900 + AZ-104)". */
function bundleLabel(bundle) {
  const special = /^Bundle\s*\(([^)]*)\)\s*:\s*(.+)$/i.exec(bundle.name);
  if (special)
    return `${special[2].trim()} (${special[1].split(/\s*,\s*/).join(" + ")})`;
  return bundle.name.replace(/^Bundle\s+/i, "");
}

/**
 * The bundles that include an exam, for the card of its page: [{ title, href, description }], by name.
 * A bundle with an exam that is retired (`retired`, default: what Microsoft has retired today) is left out.
 * @param {string | undefined} code
 * @param {Bundle[]} [bundles]
 * @param {Set<string>} [retired]
 * @returns {BundleCard[]}
 */
export function bundlesForExam(
  code,
  bundles = readBundles(),
  retired = readRetiredExamCodes(),
) {
  if (!code) return [];
  const wanted = code.toUpperCase();
  return bundles
    .filter(
      (bundle) =>
        bundle.url &&
        (bundle.examCodes ?? []).includes(wanted) &&
        !(bundle.examCodes ?? []).some((examCode) => retired.has(examCode)),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((bundle) => ({
      title: `MeasureUp Bundle: ${bundleLabel(bundle)}`,
      href: withTracking(bundle.url),
      description: `Practice tests for ${bundle.examCodes.join(", ")} in one purchase.`,
    }));
}

/**
 * @typedef {{ id: string, name: string, examCode: string, type: string, url: string }} Product
 * @typedef {{ title: string, href: string }} ProductCard
 */

/**
 * The products the MeasureUp Monitor follows (assessments, practice tests, certkits), or [] when the file
 * has none (or cannot be read).
 * @returns {Product[]}
 */
export function readProducts(root = process.cwd()) {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.resolve(root, "src", "data_files", "measureup-products.json"),
        "utf8",
      ),
    );
    return Array.isArray(parsed.products) ? parsed.products : [];
  } catch {
    return [];
  }
}

// The cards of the MeasureUp block of an exam page, in the order of the page: the type of product, the title of
// its card and the name MeasureUp gives the English product ("Assessment AZ-104: ...", "Microsoft Practice Test
// AZ-104: ..."). MeasureUp also lists some products in Japanese under the same exam code; the English one wins.
// Certkits are not here: they sit in the Paid tab of the page, which is written by hand.
const CARD_PRODUCTS = [
  { type: "assessment", title: "MeasureUp Assessment", name: /^Assessment\s+/i },
  {
    type: "practice-test",
    title: "MeasureUp Practice Test",
    name: /^Microsoft Practice Test\s+/i,
  },
];

/**
 * The product cards of an exam page: the exam's assessment and practice test from the baseline, each with
 * the `#u44` fragment. An exam MeasureUp has no product for gets none. Nothing derives an address from a name.
 * @param {string | undefined} code
 * @param {Product[]} [products]
 * @returns {ProductCard[]}
 */
export function productsForExam(code, products = readProducts()) {
  if (!code) return [];
  const wanted = code.toUpperCase();
  /** @type {ProductCard[]} */
  const cards = [];
  for (const { type, title, name } of CARD_PRODUCTS) {
    const found = products.filter(
      (product) =>
        product.url &&
        product.type === type &&
        String(product.examCode).toUpperCase() === wanted,
    );
    const pick =
      found.find((product) => name.test(product.name)) ??
      found.find((product) => /^[\x20-\x7e]+$/.test(product.name)) ??
      found[0];
    if (pick) cards.push({ title, href: withTracking(pick.url) });
  }
  return cards;
}
