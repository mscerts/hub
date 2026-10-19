/**
 * The candidate generator: for every task of an exam's study guide, a SHORTLIST of Microsoft Learn modules,
 * units and documentation pages that might cover it, each tagged with where it came from. Pure: no I/O, no
 * network; the command line is scripts/course-candidates.mjs (docs/course-candidates.md).
 *
 * It does not decide anything. It is lexical (BM25 over titles, descriptions and URL words), so it finds pages
 * that share the words of a task, and it is noisy by nature; the product constraint and the hard filters below
 * take out what is plainly wrong, and the judging step (docs/courses.md) decides what belongs.
 *
 * Provenance (the course file's `source`):
 *   P1  a module or unit of the exam's own official course
 *   P2  a documentation page that such a module lists in its last unit (learnsync's module-links.json)
 *   P3  a module or unit of ANOTHER exam's official course (AZ-700 for an AZ-104 networking task)
 *   P4  anything else the catalogs have: a module no course uses, a documentation page no module lists
 *
 * The product constraint. A task has an ANCHOR: the best P1 modules for it, the products they carry and the
 * documentation FAMILIES (first path segments, /azure/virtual-network, /entra/id-governance) their last unit
 * lists. A page outside the anchor is a different product area and is dropped, which is what keeps SAP, Cosmos
 * DB, SQL and Teams pages and the entitlement-management pages (identity governance, not an Azure
 * administrator's job) out of an Azure Active Directory task. A task with no good P1 module is anchored on
 * the whole exam, and says so.
 *
 * Hard filters (a page failing one is counted, never listed): not-in-cache, moved, removed, not-english,
 * retired, boilerplate (a link that nearly every module lists), out-of-scope-product.
 */

import { LexicalIndex, queryTerms } from "./course-lexical.mjs";
import { learnPath } from "./course-scope.mjs";
import { flattenTasks } from "./course-status.mjs";

export const CANDIDATES_SCHEMA_VERSION = 1;

/** A documentation page that more modules than this list is boilerplate (a community blog, aka.ms/FindATrainer). */
export const BOILERPLATE_MODULES = 25;

/** A third path segment with at least this many pages below it is a section of its family. */
export const SECTION_PAGES = 5;

/** How many documentation pages a module's title is matched against to infer its families. */
const INFER_PAGES = 5;

/**
 * No limit. A task has as many candidates as there are relevant pages: a page that covers the task is judged
 * however many others do, because there is no such thing as too many resources. The only thresholds are the
 * absolute coverage ones below (how much of the task's own words a page must contain) and the hard filters
 * (retired, not in the caches, out of the exam's product families). A limit can still be passed as an option, to
 * look at a short list.
 */
export const NO_LIMIT = Infinity;

export const DEFAULTS = Object.freeze({
  limits: Object.freeze({
    p1Module: NO_LIMIT,
    p1Unit: NO_LIMIT,
    p2Docs: NO_LIMIT,
    p3Module: NO_LIMIT,
    p3Unit: NO_LIMIT,
    p4Module: NO_LIMIT,
    p4Docs: NO_LIMIT,
    p1GroupModule: NO_LIMIT,
  }),
  // the share of a task's weight a page must contain, per provenance: the further from the exam's own course,
  // the more of the task a page has to cover
  minCoverage: Object.freeze({ P1: 0.34, P2: 0.5, P3: 0.5, P4: 0.6 }),
  // a page is kept only if it scores at least this share of the best page's score: 0 keeps every page that
  // passes the coverage threshold (a relevant page is not dropped for scoring below another)
  relativeFloor: 0,
  anchorCoverage: 0.5,
  anchorModules: 3,
  anchorRelative: 0.5,
  anchorFamilyShare: 0.1,
  moduleFamilyShare: 0.5,
  genericProductCoverage: 0.75,
  weakAnchorCoverage: 0.8,
  relaxFactor: 0.6,
  foreignFamilyFactor: 0.35,
  siblingSectionFactor: 0.6,
  recommendBoost: 1.3,
  groupCoverage: 0.5,
  anchorBoost: 1.25,
  viaBoost: 1.2,
  genericProductShare: 0.08,
  // how many ranked pages a search examines at most: every one
  scan: NO_LIMIT,
});

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lower = (s) => String(s ?? "").toLowerCase();

// Documentation families are the first two path segments; these roots name the service one level deeper.
const DEEP_ROOTS = new Set([
  "/cli/azure",
  "/rest/api",
  "/powershell/module",
  "/azure/templates",
  "/azure/developer",
]);

/** The documentation family of a Learn path: `/azure/virtual-network/x/y` -> `/azure/virtual-network`. */
export function docFamily(path) {
  const parts = String(path).split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  const two = `/${parts.slice(0, 2).join("/")}`;
  if (parts.length > 2 && DEEP_ROOTS.has(two))
    return `/${parts.slice(0, 3).join("/")}`;
  return two;
}

// Learn areas that are not documentation: a "docs" pick cannot be one of them.
const NOT_DOCS =
  /^\/(training|credentials|shows|answers|events|users|collections|community|assessments)(\/|$)/;
const GENERIC_UNITS =
  /^(introduction|summary|summary and resources|module assessment|knowledge check|check your knowledge|conclusion|next steps|congratulations|learning objectives)$/i;

/** exam -> official course numbers of every module: Map modulePath -> [{ number, exam }]. */
export function officialModuleIndex({ courses, learningPaths, modules }) {
  const pathByUid = new Map((learningPaths ?? []).map((p) => [p.uid, p]));
  const moduleByUid = new Map((modules ?? []).map((m) => [m.uid, m]));
  const index = new Map();
  const add = (modulePath, entry) => {
    const list = index.get(modulePath) ?? [];
    if (!list.some((e) => e.number === entry.number)) list.push(entry);
    index.set(modulePath, list);
  };
  for (const course of courses ?? []) {
    const number = String(course.course_number ?? "");
    const exam =
      number.match(/^([A-Z]{2,3}-\d{3})T/i)?.[1]?.toUpperCase() ??
      String((Array.isArray(course.exam) ? course.exam[0] : course.exam) ?? "")
        .replace(/^exam\./i, "")
        .toUpperCase();
    const entry = { number, exam };
    for (const item of course.study_guide ?? []) {
      const learningPath = pathByUid.get(item.uid);
      if (learningPath)
        for (const modulePath of learningPath.modules ?? [])
          add(modulePath, entry);
      else if (moduleByUid.has(item.uid))
        add(moduleByUid.get(item.uid).path, entry);
    }
  }
  return index;
}

const nonLatinShare = (text) => {
  const letters = String(text ?? "").match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return 1 - latin / letters.length;
};

/**
 * Everything the generator searches, built once from learnsync's files and reused for every exam.
 *   catalog      learn-catalog.json (modules, removed)
 *   courses      the catalog API's course list (with study_guide)
 *   learningPaths learn-content.json learningPaths
 *   moduleLinks  module-links.json (optional)
 *   docs         docs-catalog.json (optional, large): without it only the documentation pages that modules list
 *                can be candidates
 *   docPaths     Set of every live Learn path (docs-urls.txt), optional: enables the not-in-cache filter
 *   redirects    docs-redirects.json, optional: enables the moved filter
 */
export function buildPools({
  catalog,
  courses,
  learningPaths,
  moduleLinks = null,
  docs = null,
  docPaths = null,
  redirects = null,
  boilerplateModules = BOILERPLATE_MODULES,
}) {
  const modules = new Map();
  for (const m of catalog?.modules ?? []) {
    if (!m?.path) continue;
    modules.set(m.path, {
      path: m.path,
      title: m.title ?? m.path,
      products: Array.isArray(m.products) ? m.products : [],
      units: Array.isArray(m.units) ? m.units : [],
      unitUrls: Array.isArray(m.unitUrls) ? m.unitUrls : null,
      unitSig: m.unitSig ?? null,
    });
  }
  const removed = new Set((catalog?.removed ?? []).map((r) => r.path));
  const official = officialModuleIndex({
    courses,
    learningPaths,
    modules: catalog?.modules ?? [],
  });

  const productCount = new Map();
  for (const m of modules.values())
    for (const p of new Set(m.products.map(lower)))
      productCount.set(p, (productCount.get(p) ?? 0) + 1);
  const productShare = (product) =>
    (productCount.get(lower(product)) ?? 0) / (modules.size || 1);

  const moduleIndex = new LexicalIndex();
  for (const m of modules.values()) {
    moduleIndex.add(m.path, [
      { text: m.title, weight: 3, phrase: true },
      {
        text: m.units.filter((u) => !GENERIC_UNITS.test(u.trim())).join(" "),
        weight: 1,
      },
      { text: m.products.join(" "), weight: 0.5 },
    ]);
  }
  moduleIndex.finalize();

  // units of the modules some official course uses (a unit deep link needs the real URL, unitUrls)
  const unitIndex = new LexicalIndex();
  const units = new Map();
  let unitsUnmapped = 0;
  for (const m of modules.values()) {
    if (!official.has(m.path)) continue;
    if (!m.unitUrls || m.unitUrls.length !== m.units.length) {
      unitsUnmapped++;
      continue;
    }
    m.units.forEach((title, i) => {
      if (GENERIC_UNITS.test(title.trim())) return;
      const path = m.unitUrls[i];
      units.set(path, { path, module: m.path, title, position: i + 1 });
      unitIndex.add(path, [
        { text: title, weight: 3, phrase: true },
        { text: m.title, weight: 0.5 },
      ]);
    });
  }
  unitIndex.finalize();

  // what the modules' last units list: the link texts, how many modules list a page, a module's families.
  // A page that more than `boilerplateModules` modules list is boilerplate: no candidate, and no family either.
  const linkTexts = new Map();
  const moduleCount = new Map();
  const listedDocs = (record) => [
    ...new Map(
      (record.links ?? [])
        .filter((l) => l.kind === "docs" && l.path && !NOT_DOCS.test(l.path))
        .map((l) => [l.path, l]),
    ).values(),
  ];
  for (const record of moduleLinks?.modules ?? [])
    for (const link of listedDocs(record)) {
      moduleCount.set(link.path, (moduleCount.get(link.path) ?? 0) + 1);
    }
  const boilerplate = new Set(
    [...moduleCount].filter(([, n]) => n > boilerplateModules).map(([p]) => p),
  );
  const recommendedBy = new Map(); // module path -> modules whose last unit points to it ("Learn more with self-paced training")
  for (const record of moduleLinks?.modules ?? [])
    for (const link of record.links ?? [])
      if (
        link.kind === "training" &&
        /^\/training\/modules\//.test(link.path ?? "")
      ) {
        const list = recommendedBy.get(link.path) ?? [];
        if (!list.includes(record.path)) list.push(record.path);
        recommendedBy.set(link.path, list);
      }
  const linkFamilies = new Map();
  for (const record of moduleLinks?.modules ?? []) {
    const families = new Map(); // family -> how many of the module's links are in it
    for (const link of record.links ?? []) {
      if (
        link.kind === "docs" &&
        link.path &&
        link.text &&
        !NOT_DOCS.test(link.path)
      ) {
        const texts = linkTexts.get(link.path) ?? new Set();
        texts.add(link.text);
        linkTexts.set(link.path, texts);
      }
    }
    for (const link of listedDocs(record)) {
      if (boilerplate.has(link.path)) continue;
      const family = docFamily(link.path);
      families.set(family, (families.get(family) ?? 0) + 1);
    }
    if (families.size) linkFamilies.set(record.path, families);
  }

  const docMeta = new Map();
  for (const r of docs ?? []) {
    let url;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    if (url.hostname !== "learn.microsoft.com") continue;
    const path = learnPath(r.url);
    if (!path || NOT_DOCS.test(path)) continue;
    docMeta.set(path, {
      path,
      title: r.title ?? path,
      description: r.description ?? "",
      fromLink: false,
    });
  }
  for (const [path, texts] of linkTexts)
    if (!docMeta.has(path))
      docMeta.set(path, {
        path,
        title: [...texts][0],
        description: "",
        fromLink: true,
      });
  const docsIndex = new LexicalIndex();
  for (const d of docMeta.values())
    docsIndex.add(d.path, [
      { text: d.title, weight: 3, phrase: true },
      { text: d.description, weight: 1 },
      { text: d.path.split("/").join(" ").replace(/-/g, " "), weight: 1.5 },
      { text: [...(linkTexts.get(d.path) ?? [])].join(" "), weight: 2 },
    ]);
  docsIndex.finalize();

  const movedFrom = new Set(
    (redirects ?? [])
      .filter((r) => r.kind === "moved" || r.kind === "retired")
      .map((r) => r.from),
  );

  // Sections: a documentation family often holds sub-areas (/entra/external-id/customers beside the
  // workforce pages). A third path segment that has at least `SECTION_PAGES` pages below it is one.
  const sectionPages = new Map();
  for (const path of docPaths ?? docMeta.keys()) {
    const parts = path.split("/");
    if (parts.length < 5) continue;
    const prefix = parts.slice(0, 4).join("/");
    sectionPages.set(prefix, (sectionPages.get(prefix) ?? 0) + 1);
  }
  const sections = new Set(
    [...sectionPages].filter(([, n]) => n >= SECTION_PAGES).map(([p]) => p),
  );
  const sectionOf = (path) => {
    const family = docFamily(path);
    const parts = path.split("/");
    if (family.split("/").length > 3 || parts.length < 5) return family;
    const prefix = parts.slice(0, 4).join("/");
    return sections.has(prefix) ? prefix : family;
  };

  const pools = {
    modules,
    removed,
    official,
    moduleIndex,
    unitIndex,
    units,
    unitsUnmapped,
    docMeta,
    docsIndex,
    docPaths,
    movedFrom,
    boilerplate,
    linkFamilies,
    recommendedBy,
    linkTexts,
    sectionOf,
    productShare,
    hasDocsCatalog: Array.isArray(docs) && docs.length > 0,
    modulesWithLinks: moduleLinks?.modules?.length ?? 0,
  };

  // The families of a module: those of the documentation its last unit lists, else (every module no
  // course uses, a quarter of the official ones) those of the documentation pages that best match its
  // title. Learn's product tags say far less ("Azure", or a SharePoint module tagged Virtual Machines).
  const inferred = new Map();
  pools.familiesOf = (modulePath) => {
    const listed = linkFamilies.get(modulePath);
    if (listed) return listed;
    if (inferred.has(modulePath)) return inferred.get(modulePath);
    let families = null;
    const title = modules.get(modulePath)?.title;
    if (title && docMeta.size > 0) {
      const found = docsIndex.search(queryTerms(title), {
        minCoverage: 0.6,
        limit: INFER_PAGES,
        scan: 200,
        classify: (id) =>
          hardFilter(
            { kind: "docs", path: id, title: docMeta.get(id).title },
            pools,
          ),
      });
      if (found.hits.length >= 2) {
        families = new Map();
        for (const h of found.hits) {
          const family = docFamily(h.id);
          families.set(family, (families.get(family) ?? 0) + 1);
        }
      }
    }
    inferred.set(modulePath, families);
    return families;
  };
  return pools;
}

/** The hard filters. Returns the reason a page is dropped, or null. */
export function hardFilter({ kind, path, title }, pools) {
  if (/^\/[a-z]{2}-[a-z]{2}(\/|$)/i.test(path) || nonLatinShare(title) > 0.3)
    return "not-english";
  if (
    /\/(previous-versions|archive)(\/|$)/.test(path) ||
    /[([]\s*(retired|deprecated)\s*[)\]]/i.test(title ?? "") ||
    /^\s*(retired|deprecated)\s*:/i.test(title ?? "")
  )
    return "retired";
  if (kind === "docs") {
    if (pools.docPaths && !pools.docPaths.has(path)) return "not-in-cache";
    if (pools.movedFrom.has(path)) return "moved";
    if (pools.boilerplate.has(path)) return "boilerplate";
  }
  return null;
}

const moduleOfUnit = (pools, unitPath) => pools.units.get(unitPath)?.module;

/**
 * What the exam is about, as far as its official course tells: the modules' products and the families of the
 * documentation they list. The fallback anchor of a task that has no good module of its own.
 */
export function examProfile(pools, scope) {
  const products = new Map();
  const families = new Set();
  const sections = new Set();
  for (const m of scope.modules ?? []) {
    for (const link of m.resources?.links ?? [])
      if (
        link.kind === "docs" &&
        link.path &&
        !pools.boilerplate.has(link.path)
      )
        sections.add(pools.sectionOf(link.path));
    for (const p of new Set(
      (pools.modules.get(m.path)?.products ?? []).map(lower),
    ))
      products.set(p, (products.get(p) ?? 0) + 1);
    for (const f of pools.linkFamilies.get(m.path)?.keys() ?? [])
      families.add(f);
  }
  return {
    products: [...products.keys()].sort(byText),
    families: [...families].sort(byText),
    sections: [...sections].sort(byText),
  };
}

const GROUP_ORDER = [
  "P1 module",
  "P1 unit",
  "P2 docs",
  "P3 module",
  "P3 unit",
  "P4 module",
  "P4 docs",
];
const dedupe = (list) => [...new Set(list)];
const round2 = (n) => Math.round(n * 100) / 100;

/** The candidates of one task. `ctx` is built by generateCandidates. */
function candidatesForTask(task, ctx) {
  const { pools, options, own, listed, profile, courseNumbers } = ctx;
  const query = queryTerms(task.text, { context: task.group });
  const result = {
    key: task.key,
    text: task.text,
    domain: task.domain,
    group: task.group,
    query: query.terms.map((t) => ({ word: t.word, weight: t.weight })),
    anchor: null,
    candidates: [],
    dropped: {},
    noP1: true,
  };
  if (query.terms.length === 0) return result;

  const dropped = new Map();
  const noteDropped = (map) => {
    for (const [reason, entry] of map) {
      const known = dropped.get(reason) ?? { count: 0, samples: [] };
      known.count += entry.count;
      for (const s of entry.samples)
        if (known.samples.length < 3) known.samples.push(s);
      dropped.set(reason, known);
    }
  };
  const titleOf = (kind, path) =>
    kind === "docs"
      ? (pools.docMeta.get(path)?.title ?? path)
      : kind === "unit"
        ? (pools.units.get(path)?.title ?? path)
        : (pools.modules.get(path)?.title ?? path);
  const moduleOf = (kind, id) =>
    kind === "unit" ? moduleOfUnit(pools, id) : id;

  // ---- the hard filters of a module / unit / documentation page
  const moduleFilter = (kind) => (id) => {
    const path = moduleOf(kind, id);
    if (!path || pools.removed.has(path)) return "removed";
    if (!pools.modules.has(path)) return "not-in-cache";
    return hardFilter({ kind, path: id, title: titleOf(kind, id) }, pools);
  };
  const docsFilter = (id) =>
    hardFilter({ kind: "docs", path: id, title: titleOf("docs", id) }, pools);

  // ---- P1: the exam's own course, and the task's anchor
  const search = (index, opts) =>
    index.search(query, { scan: options.scan, ...opts });
  const p1Modules = search(pools.moduleIndex, {
    include: (id) => own.has(id),
    classify: moduleFilter("module"),
    minCoverage: options.minCoverage.P1,
    limit: Math.max(options.limits.p1Module, options.anchorModules),
  });
  noteDropped(p1Modules.dropped);
  const bestModule = p1Modules.hits[0]?.score ?? 0;
  const anchorHits = p1Modules.hits
    .filter(
      (h) =>
        h.coverage >= options.anchorCoverage &&
        h.score >= options.anchorRelative * bestModule,
    )
    .slice(0, options.anchorModules);
  const strongAnchor = anchorHits.length > 0;

  // The anchor's families are those that hold a real share of the links its modules list (one licensing link
  // in an identity module does not make /microsoft-365/admin part of the task). The anchor only BOOSTS: what
  // the exam as a whole does not touch is dropped (the exam families below), but a task whose own modules say
  // little about it (AZ-104's external users) must still find pages in a neighbouring family.
  const anchorProducts = new Set();
  const familyLinks = new Map();
  for (const h of anchorHits) {
    for (const p of pools.modules.get(h.id)?.products ?? [])
      anchorProducts.add(lower(p));
    for (const [f, n] of pools.familiesOf(h.id) ?? [])
      familyLinks.set(f, (familyLinks.get(f) ?? 0) + n);
  }
  const linkTotal = [...familyLinks.values()].reduce((a, b) => a + b, 0);
  const topFamily = [...familyLinks].sort(
    (a, b) => b[1] - a[1] || byText(a[0], b[0]),
  )[0]?.[0];
  const anchorFamilies = new Set(
    [...familyLinks]
      .filter(
        ([f, n]) =>
          f === topFamily || n / linkTotal >= options.anchorFamilyShare,
      )
      .map(([f]) => f),
  );
  result.anchor = {
    basis: strongAnchor ? "p1-top" : "exam",
    modules: anchorHits.map((h) => ({
      path: h.id,
      title: titleOf("module", h.id),
    })),
    products: [...anchorProducts].sort(byText),
    families: [...anchorFamilies].sort(byText),
  };

  // ---- the product constraint: what the EXAM touches
  // A module fits when most of the documentation it lists is in a family some module of the exam lists. A
  // module that lists none (every module no course uses) fits by its specific products (Virtual Machines,
  // Cosmos DB; "Azure" is on a quarter of all modules and says nothing); with only generic products it has to
  // cover the task well. A task with no good module of its own (the official course skips it: resource
  // locks, cost management) cannot say which family it belongs to, so it may use any family under the roots
  // the exam touches (/azure, /entra) and must cover the task much better to be listed.
  const rootOf = (family) => `/${family.split("/")[1] ?? ""}`;
  const examFamilies = new Set(
    strongAnchor ? profile.families : profile.families.map(rootOf),
  );
  const familyKey = strongAnchor ? (f) => f : rootOf;
  const examProducts = new Set(profile.products);
  const isSpecific = (p) =>
    pools.productShare(p) <= options.genericProductShare;
  const examSpecific = new Set([...examProducts].filter(isSpecific));
  const share = (path, families, key = (f) => f) => {
    const fam = pools.familiesOf(path);
    if (!fam || fam.size === 0) return null;
    let inside = 0;
    let all = 0;
    for (const [f, n] of fam) {
      all += n;
      if (families.has(key(f))) inside += n;
    }
    return inside / all;
  };
  const moduleFits = (path, coverage) => {
    const inside = share(path, examFamilies, familyKey);
    if (inside !== null && examFamilies.size > 0)
      return inside >= options.moduleFamilyShare;
    const mine = (pools.modules.get(path)?.products ?? []).map(lower);
    const mineSpecific = mine.filter(isSpecific);
    if (mineSpecific.length > 0 && examSpecific.size > 0)
      return mineSpecific.some((p) => examSpecific.has(p));
    return (
      mine.some((p) => examProducts.has(p)) &&
      coverage >= options.genericProductCoverage
    );
  };
  const fitFilter = (kind) => (id, hit) =>
    moduleFilter(kind)(id) ??
    (moduleFits(moduleOf(kind, id), hit.coverage)
      ? null
      : "out-of-scope-product");
  const docFilter = (id) =>
    docsFilter(id) ??
    (examFamilies.size === 0 || examFamilies.has(familyKey(docFamily(id)))
      ? null
      : "out-of-scope-product");
  // the coverage a P3 / P4 page needs: stricter for a task the exam's own course does not cover. A task that
  // finds nothing at all is searched once more with every threshold scaled down (the candidates say so).
  let relax = 1;
  const minCoverageFor = (source) =>
    relax *
    (strongAnchor
      ? options.minCoverage[source]
      : Math.max(options.minCoverage[source], options.weakAnchorCoverage));

  // a candidate inside the anchor ranks higher; it is a ranking signal, never a filter
  const anchoredModule = (path) => {
    if (!strongAnchor) return false;
    const inside = share(path, anchorFamilies);
    if (inside !== null) return inside >= options.moduleFamilyShare;
    return (pools.modules.get(path)?.products ?? [])
      .map(lower)
      .some((p) => isSpecific(p) && anchorProducts.has(p));
  };
  const anchoredDoc = (path) =>
    strongAnchor && anchorFamilies.has(docFamily(path));
  const anchorPaths = new Set(anchorHits.map((h) => h.id));

  // ---- collect: search a pool, rank, keep the best of it
  const out = [];
  const floor = (hits) => {
    const best = hits[0]?.score ?? 0;
    return hits.filter((h) => h.score >= options.relativeFloor * best);
  };
  const gather = ({
    group,
    index,
    include,
    classify,
    minCoverage,
    limit,
    boost = () => ({}),
    describe,
  }) => {
    const found = search(index, {
      include,
      classify,
      minCoverage,
      limit: limit * 2,
    });
    noteDropped(found.dropped);
    const ranked = found.hits
      .map((hit) => {
        const { factor = 1, ...flags } = boost(hit.id);
        return { ...hit, score: hit.score * factor, flags };
      })
      .sort((a, b) => b.score - a.score || byText(a.id, b.id));
    for (const hit of floor(ranked).slice(0, limit))
      out.push({ group, hit, ...describe(hit) });
  };
  // A task with a strong anchor ranks pages inside it higher. A task without one may use families under the
  // exam's roots, but a family no module of the exam lists is foreign: it ranks far lower, so that it only
  // shows when nothing from the exam's own families does (cost management for AZ-104 yes; identity
  // governance beside a page that really covers external users no). A module that one of the exam's modules
  // recommends ("Learn more with self-paced training") ranks higher; a page in a section of a family that no
  // module of the exam lists (/entra/external-id/customers when the exam lists the workforce pages) lower.
  const examStrict = new Set(profile.families);
  const examSections = new Set(profile.sections);
  const foreignModule = (path) => {
    const inside = share(path, examStrict);
    return inside !== null && inside < options.moduleFamilyShare;
  };
  const foreignDoc = (path) =>
    examStrict.size > 0 && !examStrict.has(docFamily(path));
  const siblingSection = (path) => {
    if (!examStrict.has(docFamily(path))) return false;
    const section = pools.sectionOf(path);
    return section !== docFamily(path) && !examSections.has(section);
  };
  const signals = ({ anchored, foreign, recommended = [], sibling }) => {
    let factor = 1;
    const flags = {};
    if (strongAnchor) {
      flags.anchored = anchored;
      if (anchored) factor *= options.anchorBoost;
    } else if (foreign) {
      factor *= options.foreignFamilyFactor;
      flags.foreignFamily = true;
    }
    if (recommended.length > 0) {
      factor *= options.recommendBoost;
      flags.recommendedBy = recommended.slice(0, 3);
    }
    if (sibling) {
      factor *= options.siblingSectionFactor;
      flags.siblingSection = true;
    }
    return { factor, ...flags };
  };
  const moduleBoost = (kind) => (id) => {
    const path = moduleOf(kind, id);
    return signals({
      anchored: strongAnchor && anchoredModule(path),
      foreign: foreignModule(path),
      recommended: (pools.recommendedBy.get(path) ?? []).filter((m) =>
        own.has(m),
      ),
    });
  };
  const docBoost = (id) =>
    signals({
      anchored: strongAnchor && anchoredDoc(id),
      foreign: foreignDoc(id),
      sibling: siblingSection(id),
    });
  const flagsOf = (h) => ({
    ...(strongAnchor ? { anchored: h.flags.anchored } : {}),
    ...(h.flags.foreignFamily ? { foreignFamily: true } : {}),
    ...(h.flags.recommendedBy ? { recommendedBy: h.flags.recommendedBy } : {}),
    ...(h.flags.siblingSection ? { siblingSection: true } : {}),
  });
  const courseNumbersOf = (path) =>
    pools.official.get(path).map((e) => e.number);
  const moduleCard = (path) => {
    const m = pools.modules.get(path);
    return { path: m.path, title: m.title };
  };

  const p1Module = (h) => {
    const m = pools.modules.get(h.id);
    return {
      source: "P1",
      target: { kind: "module", path: h.id },
      title: m.title,
      unitSig: m.unitSig,
      products: m.products,
      courses: courseNumbers,
    };
  };
  const runPass = () => {
    out.length = 0;
    dropped.clear();
    gather({
      group: "P1 module",
      index: pools.moduleIndex,
      include: (id) => own.has(id),
      classify: moduleFilter("module"),
      minCoverage: relax * options.minCoverage.P1,
      limit: options.limits.p1Module,
      describe: p1Module,
    });
    gather({
      group: "P1 unit",
      index: pools.unitIndex,
      include: (id) => own.has(moduleOfUnit(pools, id)),
      classify: moduleFilter("unit"),
      minCoverage: relax * options.minCoverage.P1,
      limit: options.limits.p1Unit,
      describe: (h) => {
        const u = pools.units.get(h.id);
        return {
          source: "P1",
          target: { kind: "unit", path: h.id },
          title: u.title,
          module: moduleCard(u.module),
          unitSig: pools.modules.get(u.module).unitSig,
          courses: courseNumbers,
        };
      },
    });

    // ---- P2: documentation the exam's own modules list; the module that lists it is `via`
    const viaOf = (id) =>
      listed.get(id).find((m) => anchorPaths.has(m)) ?? listed.get(id)[0];
    gather({
      group: "P2 docs",
      index: pools.docsIndex,
      include: (id) => listed.has(id),
      classify: docsFilter,
      minCoverage: relax * options.minCoverage.P2,
      limit: options.limits.p2Docs,
      boost: (id) =>
        anchorPaths.has(viaOf(id)) ? { factor: options.viaBoost } : {},
      describe: (h) => {
        const meta = pools.docMeta.get(h.id);
        const others = listed.get(h.id).length - 1;
        return {
          source: "P2",
          target: { kind: "docs", path: h.id },
          title: meta.title,
          via: viaOf(h.id),
          ...(others > 0 ? { alsoListedBy: others } : {}),
          family: docFamily(h.id),
          ...(meta.fromLink ? { titleFromLink: true } : {}),
        };
      },
    });

    // ---- P3: another exam's official course
    gather({
      group: "P3 module",
      index: pools.moduleIndex,
      include: (id) => pools.official.has(id) && !own.has(id),
      classify: fitFilter("module"),
      minCoverage: minCoverageFor("P3"),
      limit: options.limits.p3Module,
      boost: moduleBoost("module"),
      describe: (h) => {
        const m = pools.modules.get(h.id);
        return {
          source: "P3",
          target: { kind: "module", path: h.id },
          title: m.title,
          unitSig: m.unitSig,
          products: m.products,
          courses: courseNumbersOf(h.id),
          ...flagsOf(h),
        };
      },
    });
    gather({
      group: "P3 unit",
      index: pools.unitIndex,
      include: (id) => {
        const path = moduleOfUnit(pools, id);
        return path && pools.official.has(path) && !own.has(path);
      },
      classify: fitFilter("unit"),
      minCoverage: minCoverageFor("P3"),
      limit: options.limits.p3Unit,
      boost: moduleBoost("unit"),
      describe: (h) => {
        const u = pools.units.get(h.id);
        return {
          source: "P3",
          target: { kind: "unit", path: h.id },
          title: u.title,
          module: moduleCard(u.module),
          unitSig: pools.modules.get(u.module).unitSig,
          courses: courseNumbersOf(u.module),
          ...flagsOf(h),
        };
      },
    });

    // ---- P4: anything else the catalogs have
    gather({
      group: "P4 module",
      index: pools.moduleIndex,
      include: (id) => !pools.official.has(id) && !own.has(id),
      classify: fitFilter("module"),
      minCoverage: minCoverageFor("P4"),
      limit: options.limits.p4Module,
      boost: moduleBoost("module"),
      describe: (h) => {
        const m = pools.modules.get(h.id);
        return {
          source: "P4",
          target: { kind: "module", path: h.id },
          title: m.title,
          unitSig: m.unitSig,
          products: m.products,
          ...flagsOf(h),
        };
      },
    });
    gather({
      group: "P4 docs",
      index: pools.docsIndex,
      include: (id) => !listed.has(id),
      classify: docFilter,
      minCoverage: minCoverageFor("P4"),
      limit: options.limits.p4Docs,
      boost: docBoost,
      describe: (h) => ({
        source: "P4",
        target: { kind: "docs", path: h.id },
        title: pools.docMeta.get(h.id).title,
        family: docFamily(h.id),
        ...flagsOf(h),
      }),
    });
  };
  runPass();
  let relaxed = false;
  if (out.length === 0 && options.relaxFactor < 1) {
    relax = options.relaxFactor;
    relaxed = true;
    runPass();
  }

  // The official course is organised by skill group, and a task's own words may not be in any of its titles
  // ("Assign roles at different scopes" is in the module about role-based access control). A task with no
  // module of its own is offered the modules that best fit its skill group, marked as such.
  let viaGroup = false;
  if (!out.some((o) => o.source === "P1" && o.target.kind === "module")) {
    if (!ctx.groupModules.has(task.group)) {
      const groupQuery = queryTerms(task.group);
      ctx.groupModules.set(
        task.group,
        groupQuery.terms.length === 0
          ? []
          : pools.moduleIndex.search(groupQuery, {
              include: (id) => own.has(id),
              classify: moduleFilter("module"),
              minCoverage: options.groupCoverage,
              limit: options.limits.p1GroupModule,
              scan: options.scan,
            }).hits,
      );
    }
    for (const h of ctx.groupModules.get(task.group)) {
      viaGroup = true;
      out.push({
        group: "P1 module",
        hit: { ...h, flags: {} },
        ...p1Module(h),
        viaGroup: true,
      });
    }
  }

  const rankIn = new Map();
  // provenance order, whatever order the passes found them in (the skill group's modules come last)
  const order = (o) => GROUP_ORDER.indexOf(o.group);
  out.sort((a, b) => order(a) - order(b));
  result.candidates = out.map(
    ({ group, hit, target, title, source, ...rest }) => {
      const rank = (rankIn.get(group) ?? 0) + 1;
      rankIn.set(group, rank);
      return {
        target,
        title,
        source,
        rank,
        score: round2(hit.score),
        coverage: round2(hit.coverage),
        matched: dedupe(hit.matched),
        ...(relaxed ? { relaxed: true } : {}),
        ...rest,
      };
    },
  );
  result.noP1 = !result.candidates.some(
    (c) => c.source === "P1" && !c.viaGroup,
  );
  if (viaGroup) result.viaGroup = true;
  if (relaxed) result.relaxed = true;
  result.dropped = Object.fromEntries(
    [...dropped]
      .sort((a, b) => byText(a[0], b[0]))
      .map(([reason, entry]) => [
        reason,
        {
          count: entry.count,
          samples: entry.samples.map((s) => ({
            path: s.id,
            score: round2(s.score),
          })),
        },
      ]),
  );
  return result;
}

/**
 * The candidates of every task of an exam.
 *   code    the exam code
 *   guide   the parsed study guide (parseGuide, with `hash` when known)
 *   scope   the exam scope map (buildScopeMap)
 *   pools   buildPools(...)
 *   options overrides of DEFAULTS (limits and minCoverage are merged key by key)
 * Returns { schemaVersion, code, params, inputs, exam, tasks, stats, warnings }.
 */
export function generateCandidates({
  code,
  guide,
  scope,
  pools,
  options = {},
}) {
  const opts = {
    ...DEFAULTS,
    ...options,
    limits: { ...DEFAULTS.limits, ...(options.limits ?? {}) },
    minCoverage: { ...DEFAULTS.minCoverage, ...(options.minCoverage ?? {}) },
  };
  const warnings = [...(scope.warnings ?? [])];
  if (!scope.ok)
    warnings.push(
      `${code} has no official course: no P1 or P2 candidates, every task is anchored on nothing`,
    );
  if (!pools.hasDocsCatalog)
    warnings.push(
      "no docs-catalog.json: only documentation pages that modules list can be candidates (no P4 docs)",
    );
  if (pools.modulesWithLinks === 0)
    warnings.push("no module-links.json: no P2 candidates and no families");
  if (!pools.docPaths)
    warnings.push("no docs-urls.txt: the not-in-cache filter is off");
  if (!pools.movedFrom.size)
    warnings.push("no docs-redirects.json entries: the moved filter is off");

  const own = new Set((scope.modules ?? []).map((m) => m.path));
  const listed = new Map();
  for (const m of scope.modules ?? [])
    for (const link of m.resources?.links ?? []) {
      if (link.kind !== "docs" || !link.path || NOT_DOCS.test(link.path))
        continue;
      const list = listed.get(link.path) ?? [];
      if (!list.includes(m.path)) list.push(m.path);
      listed.set(link.path, list);
    }
  const profile = examProfile(pools, scope);
  const courseNumbers = (scope.courses ?? []).map((c) => c.number);
  const ctx = {
    pools,
    options: opts,
    own,
    listed,
    profile,
    courseNumbers,
    groupModules: new Map(),
  };

  const tasks = flattenTasks(guide).map((task) => candidatesForTask(task, ctx));
  const bySource = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let candidates = 0;
  for (const t of tasks)
    for (const c of t.candidates) {
      bySource[c.source]++;
      candidates++;
    }
  return {
    schemaVersion: CANDIDATES_SCHEMA_VERSION,
    code,
    params: {
      // JSON has no infinity: null means no limit
      limits: Object.fromEntries(
        Object.entries(opts.limits).map(([k, v]) => [
          k,
          Number.isFinite(v) ? v : null,
        ]),
      ),
      scan: Number.isFinite(opts.scan) ? opts.scan : null,
      minCoverage: opts.minCoverage,
      relativeFloor: opts.relativeFloor,
      anchorCoverage: opts.anchorCoverage,
      anchorModules: opts.anchorModules,
      anchorRelative: opts.anchorRelative,
      anchorFamilyShare: opts.anchorFamilyShare,
      anchorBoost: opts.anchorBoost,
      viaBoost: opts.viaBoost,
      moduleFamilyShare: opts.moduleFamilyShare,
      genericProductCoverage: opts.genericProductCoverage,
      weakAnchorCoverage: opts.weakAnchorCoverage,
      relaxFactor: opts.relaxFactor,
      foreignFamilyFactor: opts.foreignFamilyFactor,
      siblingSectionFactor: opts.siblingSectionFactor,
      recommendBoost: opts.recommendBoost,
      groupCoverage: opts.groupCoverage,
      genericProductShare: opts.genericProductShare,
    },
    inputs: {
      guideHash: guide.hash ?? null,
      scopeFingerprint: scope.inputs?.fingerprint ?? null,
      moduleLinksChecked: scope.inputs?.moduleLinksChecked ?? null,
      docsCatalog: pools.hasDocsCatalog,
    },
    exam: profile,
    tasks,
    stats: {
      tasks: tasks.length,
      tasksWithoutP1: tasks.filter((t) => t.noP1).length,
      tasksWithoutCandidates: tasks.filter((t) => t.candidates.length === 0)
        .length,
      candidates,
      bySource,
    },
    warnings,
  };
}
