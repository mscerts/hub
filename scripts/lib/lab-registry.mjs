/**
 * The lab registry: every Microsoft Learn hands-on page and the exams it belongs to. Pure: no I/O, no network.
 * The monitor around it is scripts/lab-registry-sync.mjs (docs/monitors/lab-registry.md).
 *
 * What counts as a hands-on page (maintainer, 2026-10-21; Learn only, GitHub lab files are not part of it):
 *   exercise            a unit whose title has the word "exercise"
 *   exercise (address)  a unit whose address has the word "exercise" while the title does not ("Monitor VM host
 *                       data" at .../3-exercise-create-virtual-machine), except a set-up unit ("Prepare for ...")
 *   lab, simulation     a unit whose title starts with "Lab" or "Simulation" and a separator
 *   guided project, challenge project
 *                       a whole module (kind "module"); its units are not entries of their own. A module
 *                       whose own title has the word "exercise" ("Guided exercise - ...") is one the same way
 *   demonstration       a unit whose title starts with "Demo" or "Demonstration", or whose address starts with
 *                       "demo-" (a video, a procedure or a click-through guide: all three are in)
 *   demo link           a unit whose page links a demo host (CloudGuides, Highlights); found by reading the page
 *   applied skill       /credentials/applied-skills/<slug> (the Applied Skills Monitor owns their lifecycle)
 *   tutorial, quickstart
 *                       a docs page that scripts/lib/course-handson.mjs calls so, in a docs family the hub already
 *                       uses, without the Microsoft Entra app gallery tutorials
 * Reading material (concept modules, how-to docs, overviews, learning paths, practical modules without an
 * "Exercise" label) is NOT in the registry.
 *
 * An entry is { key, kind, why, title, path, exams, state, ... }:
 *   key    the canonical address; a unit's has no position number (Learn reshuffles "6-exercise-x" to "7-exercise-x")
 *   kind   "unit" | "module" | "docs" | "applied-skill"
 *   exams  { "AZ-104": "course" | "page" | "judged" | "maintainer" }: which exam, and how the link was made
 *   skip   exams whose lab page is deliberately without it (the sync never adds them again)
 *   state  "active" (has an exam) | "new" (none yet) | "no-exam" (decided: belongs to none) |
 *          "excluded" (decided: not hands-on after all) | "retiring" (Learn no longer lists it)
 */

import { handsOnReason } from "./course-handson.mjs";
import { learnPath } from "./course-scope.mjs";

export const REGISTRY_SCHEMA = 1;
export const STATES = Object.freeze([
  "active",
  "new",
  "no-exam",
  "excluded",
  "retiring",
]);
export const KINDS = Object.freeze(["unit", "module", "docs", "applied-skill"]);
export const ORIGINS = Object.freeze([
  "course",
  "page",
  "judged",
  "maintainer",
]);
export const WHYS = Object.freeze([
  "exercise",
  "lab",
  "simulation",
  "guided project",
  "challenge project",
  "demonstration",
  "demo link",
  "applied skill",
  "tutorial",
  "quickstart",
]);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const MODULE_ROOT = String.raw`\/training\/(?:modules|saas|azure-databases|research)\/[^/]+`;
const MODULE_RE = new RegExp(`^(${MODULE_ROOT})(?:\\/|$)`);
const UNIT_RE = new RegExp(`^${MODULE_ROOT}\\/[^/]+$`);

/** /training/modules/a/6-exercise-x -> /training/modules/a/exercise-x (module and docs addresses are unchanged). */
export function stripPosition(path) {
  return String(path).replace(/\/\d+-([^/]+)$/, "/$1");
}

/** The canonical key of a Learn address: no host, locale, query or trailing slash, lower case, no unit position. */
export function keyOf(input, { unit = false } = {}) {
  const path = learnPath(input);
  if (!path) return null;
  return unit ? stripPosition(path) : path;
}

/** /training/modules/a/6-x -> /training/modules/a; null for anything that is not under a module. */
export function moduleOf(path) {
  return MODULE_RE.exec(String(path))?.[1] ?? null;
}

/** Whether the address is a unit of a module. */
export const isUnitPath = (path) => UNIT_RE.test(String(path));

// ---------------------------------------------------------------------------
// What counts as hands-on
// ---------------------------------------------------------------------------

const DEMONSTRATION_TITLE = /^demo(?:nstration)?\b/i;
const DEMONSTRATION_SLUG = /^demo-/;
const SETUP_TITLE = /^prepare for\b/i;
const ADDRESS_EXERCISE = /(^|-)exercises?(-|$)/;
const GALLERY = /^\/entra\/identity\/saas-apps\//;
// the landing page of a docs product ("Azure Vision documentation - Quickstarts, Tutorials, ...") and a series
// overview ("Deployment Overview", "Overview of ...") sit at tutorial/quickstart addresses but are not a hands-on page
const LANDING =
  /\bdocumentation\b|^overview\b|\boverview\s*$|\boverview and\b/i;

/** The last segment of an address without the position Learn puts in front of it ("6-", "7a-"). */
const slugOf = (path) =>
  String(path)
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/^\d+[a-z]?-/, "") ?? "";

/**
 * Why a unit is hands-on, or null. `moduleTitle` is the title of its module in the catalog. Units of a guided or
 * challenge project are not asked: the module is the entry.
 */
export function classifyUnit({ unitPath, title, moduleTitle }) {
  const text = String(title ?? "");
  const named = handsOnReason({
    kind: "unit",
    path: unitPath,
    title: text,
    moduleTitle,
  });
  if (named === "guided project" || named === "challenge project") return null;
  if (named) return named;
  if (SETUP_TITLE.test(text)) return null;
  const slug = slugOf(unitPath);
  if (ADDRESS_EXERCISE.test(slug)) return "exercise";
  if (DEMONSTRATION_TITLE.test(text) || DEMONSTRATION_SLUG.test(slug))
    return "demonstration";
  return null;
}

/** "guided project" | "challenge project" for a project module, else null. */
export function classifyModule({ path, title }) {
  return handsOnReason({ kind: "module", path, title });
}

/** The docs family of an address: its first two segments (azure/virtual-network). */
export function docsFamily(path) {
  return String(path).split("/").filter(Boolean).slice(0, 2).join("/");
}

/** "tutorial" | "quickstart" for a docs page of the registry's scope, else null. */
export function classifyDocs({ path, title }, families) {
  if (GALLERY.test(path) || LANDING.test(title ?? "")) return null;
  if (families && !families.has(docsFamily(path))) return null;
  return handsOnReason({ kind: "docs", path, title });
}

/** The demo hosts a Learn unit page links: "cloudguides" and/or "highlights", in that order. */
export function demoHostsIn(html) {
  const found = [];
  const text = String(html);
  if (/https?:\/\/(?:[a-z0-9-]+\.)*cloudguides\.com\b/i.test(text))
    found.push("cloudguides");
  if (/https?:\/\/(?:[a-z0-9-]+\.)*highlights\.guide\b/i.test(text))
    found.push("highlights");
  return found;
}

/** The docs families the hub already uses: the first two segments of every Learn docs link in its pages' text. */
export function familiesFromContent(texts) {
  const families = new Set();
  const link =
    /learn\.microsoft\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^\s"')?#<>\]]+)/gi;
  for (const text of texts) {
    for (const m of String(text).matchAll(link)) {
      const path = `/${m[1]}`.toLowerCase();
      if (/^\/(training|credentials)\//.test(path)) continue;
      families.add(docsFamily(path));
    }
  }
  return families;
}

/**
 * The docs families Microsoft itself points to from the last unit of the given modules (learnsync's
 * module-links.json): the first two segments of every docs link of those modules. The hub passes the modules of
 * the official courses of its exams, so a family counts when a course of an exam sends its learners there.
 */
export function familiesFromModuleLinks(moduleLinks, modulePaths) {
  const wanted = new Set(modulePaths);
  const families = new Set();
  for (const record of moduleLinks?.modules ?? []) {
    if (!wanted.has(record.path)) continue;
    for (const link of record.links ?? []) {
      if (link.kind !== "docs") continue;
      const path = learnPath(link.path ?? link.url ?? "");
      if (!path || /^\/(training|credentials)\//.test(path)) continue;
      families.add(docsFamily(path));
    }
  }
  return families;
}

// ---------------------------------------------------------------------------
// The universe: every hands-on page learnsync (plus the Applied Skills cache) knows
// ---------------------------------------------------------------------------

/**
 * { entries: Map key -> candidate, modules: [{ path, title, unitSig, units }], stats } from
 *   catalog   learn-catalog.json  ({ modules: [{ path, title, units, unitUrls, unitSig, ... }] })
 *   docs      docs-catalog.json rows ([{ title, url }]) or null
 *   skills    the Applied Skills cache ({ active, new, retiring }) or null: active and new are listed
 *   families  the Set of docs families (docsFamily) the hub uses, or null for all
 * A candidate is { key, kind, why, title, path, module? }; each module lists ALL its units
 * ({ key, path, title, module }) for the page reads.
 */
export function buildUniverse({ catalog, docs, skills, families }) {
  const entries = new Map();
  const stats = { units: 0, projects: 0, docs: 0, skills: 0 };
  const modules = [];
  for (const mod of catalog?.modules ?? []) {
    const modulePath = learnPath(mod.path);
    if (!modulePath) continue;
    const unitPaths = Array.isArray(mod.unitUrls) ? mod.unitUrls : [];
    const unitTitles = Array.isArray(mod.units) ? mod.units : [];
    const units = [];
    unitTitles.forEach((title, i) => {
      const raw = unitPaths[i];
      if (!raw) return;
      const unitPath = learnPath(raw);
      units.push({
        key: keyOf(unitPath, { unit: true }),
        path: unitPath,
        title,
        module: modulePath,
      });
    });
    modules.push({
      path: modulePath,
      title: mod.title,
      unitSig: mod.unitSig ?? null,
      units,
    });
    const project = classifyModule({ path: modulePath, title: mod.title });
    if (project) {
      entries.set(modulePath, {
        key: modulePath,
        kind: "module",
        why: project,
        title: mod.title,
        path: modulePath,
      });
      stats.projects++;
      continue;
    }
    for (const unit of units) {
      const why = classifyUnit({
        unitPath: unit.path,
        title: unit.title,
        moduleTitle: mod.title,
      });
      if (!why) continue;
      entries.set(unit.key, {
        key: unit.key,
        kind: "unit",
        why,
        title: unit.title,
        path: unit.path,
        module: modulePath,
      });
      stats.units++;
    }
  }
  if (skills) {
    for (const group of ["active", "new"]) {
      for (const skill of skills[group] ?? []) {
        const key = keyOf(skill.url);
        if (!key?.startsWith("/credentials/applied-skills/")) continue;
        entries.set(key, {
          key,
          kind: "applied-skill",
          why: "applied skill",
          title: skill.name,
          path: key,
        });
        stats.skills++;
      }
    }
  }
  for (const row of docs ?? []) {
    if (!/learn\.microsoft\.com/.test(row.url ?? "")) continue;
    const path = learnPath(row.url);
    if (!path) continue;
    const why = classifyDocs({ path, title: row.title }, families);
    if (!why) continue;
    entries.set(path, {
      key: path,
      kind: "docs",
      why,
      title: row.title,
      path,
    });
    stats.docs++;
  }
  return { entries, modules, stats };
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

/** "labs/azure/az-104" -> "AZ-104"; null for anything that is not a per-exam lab page id. */
export function examOfLabPage(id) {
  const m = /^labs\/[a-z0-9]+\/([a-z]{2,3}-\d{3})$/i.exec(String(id));
  return m ? m[1].toUpperCase() : null;
}

/**
 * The exams of every module through their official courses: Map modulePath -> Set(exam code).
 * `scopeOf(code)` returns the scope map of buildScopeMap (course-scope.mjs) for one exam.
 */
export function examsByModule(codes, scopeOf) {
  const out = new Map();
  for (const code of codes) {
    const scope = scopeOf(code);
    if (!scope?.ok) continue;
    for (const mod of scope.modules) {
      if (!out.has(mod.path)) out.set(mod.path, new Set());
      out.get(mod.path).add(code);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lab page cards
// ---------------------------------------------------------------------------

const LINK_CARD = /<LinkCard\b[^>]*?\bhref="([^"]*)"/g;
const stripComments = (mdx) =>
  mdx.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "");

/** The canonical Learn addresses of the cards of one lab page (comments stripped). */
export function labPageCards(mdx) {
  const paths = new Set();
  for (const m of stripComments(String(mdx)).matchAll(LINK_CARD)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!/^https?:\/\/learn\.microsoft\.com\//i.test(href)) continue;
    const path = learnPath(href);
    if (path) paths.add(path);
  }
  return paths;
}

/** { paths, unitKeys, modules } of a set of card addresses: what the coverage test needs. */
export function cardIndex(paths) {
  const index = {
    paths: new Set(paths),
    unitKeys: new Set(),
    modules: new Set(),
  };
  for (const path of index.paths) {
    const mod = moduleOf(path);
    if (!mod) continue;
    if (path === mod) index.modules.add(mod);
    else index.unitKeys.add(stripPosition(path));
  }
  return index;
}

/**
 * Whether a lab page (its cardIndex) has an entry:
 *   unit             the same unit (any position), or a card for its module (a module link covers its units)
 *   module (project) a card for the module, or for any unit of it
 *   docs, skill      the same address
 */
export function covers(entry, index) {
  switch (entry.kind) {
    case "unit":
      return (
        index.unitKeys.has(entry.key) ||
        index.modules.has(moduleOf(entry.key) ?? "")
      );
    case "module": {
      if (index.modules.has(entry.key)) return true;
      const prefix = `${entry.key}/`;
      for (const p of index.paths) if (p.startsWith(prefix)) return true;
      return false;
    }
    default:
      return index.paths.has(entry.key);
  }
}

// ---------------------------------------------------------------------------
// The registry file
// ---------------------------------------------------------------------------

export function emptyRegistry() {
  return {
    schemaVersion: REGISTRY_SCHEMA,
    lastSynced: null,
    scanned: {},
    entries: [],
  };
}

/** Parse and validate the text of the registry; throws an Error that names the first problem. */
export function parseRegistry(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`the lab registry is not valid JSON: ${error.message}`);
  }
  if (!data || data.schemaVersion !== REGISTRY_SCHEMA)
    throw new Error(
      `the lab registry has schemaVersion ${data?.schemaVersion}, expected ${REGISTRY_SCHEMA}`,
    );
  if (!Array.isArray(data.entries))
    throw new Error("the lab registry has no entries list");
  if (!data.scanned || typeof data.scanned !== "object") data.scanned = {};
  const seen = new Set();
  for (const entry of data.entries) {
    const where = `entry ${entry?.key ?? JSON.stringify(entry)}`;
    if (typeof entry.key !== "string" || !entry.key.startsWith("/"))
      throw new Error(`${where}: key must be a canonical address`);
    if (seen.has(entry.key)) throw new Error(`${where}: key appears twice`);
    seen.add(entry.key);
    if (!KINDS.includes(entry.kind))
      throw new Error(`${where}: unknown kind ${entry.kind}`);
    if (!WHYS.includes(entry.why))
      throw new Error(`${where}: unknown why ${entry.why}`);
    if (!STATES.includes(entry.state))
      throw new Error(`${where}: unknown state ${entry.state}`);
    for (const [exam, origin] of Object.entries(entry.exams ?? {})) {
      if (!/^[A-Z]{2,3}-\d{3}$/.test(exam))
        throw new Error(`${where}: ${exam} is not an exam code`);
      if (!ORIGINS.includes(origin))
        throw new Error(`${where}: unknown origin ${origin} for ${exam}`);
    }
    if (entry.state === "active" && Object.keys(entry.exams ?? {}).length === 0)
      throw new Error(`${where}: an active entry needs an exam`);
  }
  return data;
}

const FIELD_ORDER = [
  "key",
  "kind",
  "why",
  "title",
  "path",
  "demo",
  "exams",
  "skip",
  "state",
  "firstSeen",
  "goneSince",
  "note",
];

function orderedEntry(entry) {
  const out = {};
  for (const field of FIELD_ORDER) {
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (field === "exams") {
      out.exams = Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => byText(a, b)),
      );
      continue;
    }
    out[field] = value;
  }
  return out;
}

/** The text of a registry: a header, then one entry per line, entries sorted by key. */
export function serializeRegistry(registry) {
  const sorted = [...registry.entries].sort((a, b) => byText(a.key, b.key));
  const scanned = Object.fromEntries(
    Object.entries(registry.scanned ?? {}).sort(([a], [b]) => byText(a, b)),
  );
  const lines = sorted.map(
    (entry) => `    ${JSON.stringify(orderedEntry(entry))}`,
  );
  return (
    `{\n  "schemaVersion": ${registry.schemaVersion},\n` +
    `  "lastSynced": ${JSON.stringify(registry.lastSynced ?? null)},\n` +
    `  "reported": ${JSON.stringify(registry.reported ?? null)},\n` +
    `  "scanned": ${JSON.stringify(scanned)},\n` +
    `  "entries": [\n${lines.join(",\n")}${lines.length ? "\n" : ""}  ]\n}\n`
  );
}

/** The same registry without `lastSynced`: what "did anything change" compares. */
export const comparable = (registry) =>
  serializeRegistry({ ...registry, lastSynced: null });

/** The state an entry has from its exams alone: "active" when it has one, else "new". */
export const stateFromExams = (entry) =>
  Object.keys(entry.exams ?? {}).length > 0 ? "active" : "new";

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

/**
 * Bring the registry up to date. Pure.
 *   previous       the parsed registry (emptyRegistry() on the first run)
 *   universe       buildUniverse(...)
 *   courseExams    Map modulePath -> Set(exam)  (examsByModule)
 *   pageExams      Map exam -> cardIndex of its lab page
 *   demoUnits      Map unitKey -> { hosts, path, title, module } found by reading pages this run
 *   scanned        Map modulePath -> unitSig of the modules whose pages were read this run
 *   today          YYYY-MM-DD
 * Returns { registry, changes }; changes lists what happened this run:
 *   added[]     entries that did not exist     mapped[]  { key, exam, origin } links made
 *   retiring[]  entries Learn stopped listing  back[]    retiring entries listed again
 *   dropped[]   retiring entries no lab page links any more        changed[]  { key, from, to } titles
 */
export function syncRegistry({
  previous,
  universe,
  courseExams = new Map(),
  pageExams = new Map(),
  demoUnits = new Map(),
  scanned = new Map(),
  today,
}) {
  const changes = {
    added: [],
    mapped: [],
    retiring: [],
    back: [],
    dropped: [],
    changed: [],
  };
  const prior = new Map(previous.entries.map((e) => [e.key, e]));
  const next = new Map();

  const candidates = new Map(universe.entries);
  for (const [key, found] of demoUnits) {
    const known = candidates.get(key);
    if (known) candidates.set(key, { ...known, demo: found.hosts });
    else
      candidates.set(key, {
        key,
        kind: "unit",
        why: "demo link",
        title: found.title,
        path: found.path,
        module: found.module,
        demo: found.hosts,
      });
  }
  const listedUnits = new Set(
    universe.modules.flatMap((m) => m.units.map((u) => u.key)),
  );

  for (const [key, found] of candidates) {
    const old = prior.get(key);
    const entry = old
      ? { ...old, exams: { ...(old.exams ?? {}) } }
      : {
          key,
          kind: found.kind,
          why: found.why,
          exams: {},
          state: "new",
          firstSeen: today,
        };
    if (!old) changes.added.push(entry);
    else {
      if (old.title !== found.title || old.path !== found.path)
        changes.changed.push({ key, from: old.title, to: found.title });
      if (old.state === "retiring") {
        delete entry.goneSince;
        entry.state = "new";
        changes.back.push(entry);
      }
    }
    entry.kind = found.kind;
    entry.title = found.title;
    entry.path = found.path;
    if (!old || old.why === "demo link" || found.why !== "demo link")
      entry.why = found.why;
    const demo = found.demo ?? old?.demo;
    if (demo?.length) entry.demo = demo;
    finish(entry, found.module ?? null, courseExams, pageExams, changes);
    next.set(key, entry);
  }

  // Entries that are not candidates now.
  for (const [key, old] of prior) {
    if (candidates.has(key)) continue;
    const mod = moduleOf(key);
    // A demo-link unit is only found by reading its page: still listed and not read this run = still there.
    if (
      old.why === "demo link" &&
      listedUnits.has(key) &&
      !scanned.has(mod ?? "")
    ) {
      const entry = { ...old, exams: { ...(old.exams ?? {}) } };
      finish(entry, mod, courseExams, pageExams, changes);
      next.set(key, entry);
      continue;
    }
    // Decided not to be hands-on: nothing links it, nothing to retire.
    if (old.state === "excluded" && !listedUnits.has(key)) {
      changes.dropped.push(old);
      continue;
    }
    if (old.state === "excluded") {
      next.set(key, old);
      continue;
    }
    const linked = [...pageExams.values()].some((index) => covers(old, index));
    if (!linked) {
      changes.dropped.push(old);
      continue;
    }
    const entry = {
      ...old,
      state: "retiring",
      goneSince: old.goneSince ?? today,
    };
    if (old.state !== "retiring") changes.retiring.push(entry);
    next.set(key, entry);
  }

  const scannedOut = { ...(previous.scanned ?? {}) };
  for (const [mod, sig] of scanned) scannedOut[mod] = sig;
  const present = new Set(universe.modules.map((m) => m.path));
  for (const mod of Object.keys(scannedOut))
    if (!present.has(mod)) delete scannedOut[mod];

  return {
    registry: {
      schemaVersion: REGISTRY_SCHEMA,
      lastSynced: today,
      scanned: scannedOut,
      entries: [...next.values()].sort((a, b) => byText(a.key, b.key)),
    },
    changes,
  };
}

/** Add the exams an entry gets from its official courses and from the lab pages that cover it; set its state. */
function finish(entry, modulePath, courseExams, pageExams, changes) {
  if (entry.state === "excluded") return;
  const skip = new Set(entry.skip ?? []);
  const add = (exam, origin) => {
    if (skip.has(exam) || entry.exams[exam]) return;
    entry.exams[exam] = origin;
    changes.mapped.push({ key: entry.key, exam, origin });
  };
  const home = modulePath ?? (entry.kind === "module" ? entry.key : null);
  if (home) for (const exam of courseExams.get(home) ?? []) add(exam, "course");
  for (const [exam, index] of pageExams)
    if (covers(entry, index)) add(exam, "page");
  if (Object.keys(entry.exams).length > 0) entry.state = "active";
  else if (entry.state !== "no-exam") entry.state = "new";
}

// ---------------------------------------------------------------------------
// The check: the registry against the lab pages
// ---------------------------------------------------------------------------

/**
 * { missing, extras, pairs, covered, noPage }:
 *   missing  [{ exam, key, kind, why, title, path }]: an entry the registry ties to an exam whose lab page lacks it
 *   extras   Map exam -> [address]: Learn cards of the lab page that no registry entry accounts for (kept by hand)
 *   pairs    (entry, exam) pairs checked; covered how many are on their page
 *   noPage   exams of the registry that have no lab page (nothing to check)
 */
export function checkLabPages({ registry, pageExams, hasLabPage }) {
  const missing = [];
  const noPage = new Set();
  let pairs = 0;
  let covered = 0;
  for (const entry of registry.entries) {
    if (entry.state !== "active" && entry.state !== "retiring") continue;
    for (const exam of Object.keys(entry.exams ?? {})) {
      if (!hasLabPage(exam)) {
        noPage.add(exam);
        continue;
      }
      pairs++;
      if (covers(entry, pageExams.get(exam) ?? cardIndex([]))) covered++;
      else
        missing.push({
          exam,
          key: entry.key,
          kind: entry.kind,
          why: entry.why,
          title: entry.title,
          path: entry.path,
        });
    }
  }
  const entryKeys = new Set(registry.entries.map((e) => e.key));
  const modulesWithEntries = new Set(
    registry.entries
      .filter((e) => e.kind === "unit")
      .map((e) => moduleOf(e.key)),
  );
  const extras = new Map();
  for (const [exam, index] of pageExams) {
    const list = [];
    for (const path of index.paths) {
      const mod = moduleOf(path);
      if (mod && path === mod) {
        if (entryKeys.has(path) || modulesWithEntries.has(path)) continue;
      } else if (mod) {
        if (entryKeys.has(stripPosition(path)) || entryKeys.has(mod)) continue;
      } else if (entryKeys.has(path)) continue;
      list.push(path);
    }
    if (list.length) extras.set(exam, list.sort(byText));
  }
  missing.sort(
    (a, b) => byText(a.exam, b.exam) || byText(a.title ?? "", b.title ?? ""),
  );
  return { missing, extras, pairs, covered, noPage: [...noPage].sort(byText) };
}

// ---------------------------------------------------------------------------
// Counts and the report
// ---------------------------------------------------------------------------

/** { total, active, new, noExam, excluded, retiring, byKind, byWhy } of a registry. */
export function summarize(registry) {
  const out = {
    total: registry.entries.length,
    active: 0,
    new: 0,
    noExam: 0,
    excluded: 0,
    retiring: 0,
    byKind: {},
    byWhy: {},
  };
  for (const entry of registry.entries) {
    if (entry.state === "no-exam") out.noExam++;
    else out[entry.state]++;
    out.byKind[entry.kind] = (out.byKind[entry.kind] ?? 0) + 1;
    out.byWhy[entry.why] = (out.byWhy[entry.why] ?? 0) + 1;
  }
  return out;
}

/** The entries that need a person: new ones (no exam yet) and retiring ones some lab page still links. */
export function worklist(registry, pageExams) {
  const unmapped = registry.entries
    .filter((e) => e.state === "new")
    .sort(
      (a, b) =>
        byText(b.firstSeen ?? "", a.firstSeen ?? "") || byText(a.key, b.key),
    );
  const retiring = registry.entries
    .filter((e) => e.state === "retiring")
    .map((e) => ({
      entry: e,
      pages: [...pageExams]
        .filter(([, index]) => covers(e, index))
        .map(([exam]) => exam)
        .sort(byText),
    }));
  return { unmapped, retiring };
}

const cell = (text) =>
  String(text ?? "")
    .replace(/[|\r\n]+/g, " ")
    .replace(/[`<>@#]/g, (c) => `​${c}`)
    .trim();
const learnLink = (path) => `https://learn.microsoft.com${path}`;

/**
 * The Markdown of the running issue and the job summary. Pure. Rows are capped per table (`maxRows`); the headings
 * give the full counts. `date` is the day of the run. Returns "" when nothing needs a person.
 */
export function buildReport({
  registry,
  work,
  check,
  changes,
  date,
  maxRows = 60,
  notes = [],
}) {
  const needs =
    work.unmapped.length + work.retiring.length + check.missing.length;
  if (needs === 0) return "";
  const lines = [`## Lab registry ${date}`, ""];
  const sums = summarize(registry);
  lines.push(
    `${sums.total} hands-on pages: ${sums.active} with an exam, ${sums.new} without one yet, ${sums.noExam} decided to belong to none, ${sums.excluded} excluded, ${sums.retiring} retiring. This run: ${changes.added.length} new, ${changes.mapped.length} exam links made, ${changes.retiring.length} stopped being listed.`,
    "",
  );
  const table = (head, rows) => {
    const shown = rows.slice(0, maxRows);
    const out = [
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
    ];
    for (const row of shown) out.push(`| ${row.map(cell).join(" | ")} |`);
    if (rows.length > shown.length)
      out.push("", `…and ${rows.length - shown.length} more.`);
    return out;
  };
  if (check.missing.length) {
    lines.push(
      `### Lab pages that lack a page the registry ties to their exam (${check.missing.length})`,
      "",
      `Add the card to the lab page of the exam (\`AGENTS.md > Lab Page Workflow\`), or put the exam into the entry's \`skip\` list when the page should not have it. ${check.covered} of ${check.pairs} pairs are on their page.`,
      "",
      ...table(
        ["Exam", "Page", "Type"],
        check.missing.map((m) => [
          m.exam,
          `${m.title} ${learnLink(m.path)}`,
          m.why,
        ]),
      ),
      "",
    );
  }
  if (work.unmapped.length) {
    lines.push(
      `### Hands-on pages without an exam (${work.unmapped.length})`,
      "",
      "Newest first. Decide which exams each belongs to (or `no-exam`), then add the cards to those lab pages.",
      "",
      ...table(
        ["Page", "Type", "First seen"],
        work.unmapped.map((e) => [
          `${e.title} ${learnLink(e.path)}`,
          e.why,
          e.firstSeen,
        ]),
      ),
      "",
    );
  }
  if (work.retiring.length) {
    lines.push(
      `### Pages Learn no longer lists that a lab page still links (${work.retiring.length})`,
      "",
      "Remove or replace the card (the Learn URL Check reports the dead address too).",
      "",
      ...table(
        ["Page", "Lab pages", "Gone since"],
        work.retiring.map(({ entry, pages }) => [
          `${entry.title} ${learnLink(entry.path)}`,
          pages.join(", "),
          entry.goneSince,
        ]),
      ),
      "",
    );
  }
  if (check.extras.size) {
    const total = [...check.extras.values()].reduce(
      (n, list) => n + list.length,
      0,
    );
    lines.push(
      `### Cards on lab pages that are not in the registry (${total}, information)`,
      "",
      "Reading material, how-to docs, learning paths and practical modules without an Exercise label are outside the registry by decision (2026-10-21); they stay on the pages until someone removes them.",
      "",
    );
  }
  for (const note of notes) lines.push(`> ${note}`, "");
  return lines.join("\n").trimEnd() + "\n";
}
