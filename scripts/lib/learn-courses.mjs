/**
 * The Learn course tracker (docs/monitors/learn-courses.md): every course of the Microsoft Learn catalog, and which
 * hub exam pages it is assigned to. Pure: no I/O, no network, deterministic. The script (scripts/learn-courses-sync.mjs)
 * reads the world and writes the file; everything that decides is here.
 *
 * Two kinds of course (maintainer, 2026-10-21):
 *   exam    a course whose number is <CODE>T<nn> with <CODE> an exam on Learn (AZ-104T00). It belongs to ITS exam's
 *           page only, or temporarily to the exam that replaces it. Assigned by the rule, no proposal.
 *   other   everything else (the four-digit AI-3026 and SC-5006, DP-605T00 which is no exam, education courses...).
 *           Mapped to exam pages by relevancy: the script proposes, the maintainer confirms or rejects. Never placed
 *           automatically.
 *
 * A course entry:
 *   key         the catalog uid without "course." (az-104t00); also the last part of its Learn address
 *   uid, number, code, title, url, levels, roles, products, pathsHash, summaryHash   the catalog, refreshed each run
 *   kind        exam | other
 *   exam        the exam of an exam course (the number's code, or the hub page the maintainer set: `examPage`)
 *   skills      [{ slug, count, total }]  Applied Skills at least half of whose modules are in the course (mechanical)
 *   pages       [{ page, state, origin, temporary?, confidence?, why?, note? }]  the hub exam pages it is assigned to
 *                 state   proposed | confirmed | rejected   (only the maintainer moves a page out of proposed, except
 *                         the exam rule and a hub page that already has the course's card)
 *                 origin  exam | replacement | card | modules | guide | groups | maintainer
 *   state       new (needs a decision) | active (a confirmed page) | no-page (decided: none) | removed (left the catalog)
 *   review      set by the sync when the learning paths of a course with a confirmed page changed; the maintainer
 *               deletes it after looking
 *   ack         a removed course that hub pages deliberately still link (its recording still works)
 *   firstSeen, lastSeen, goneSince, missingRuns, note
 */

export const SCHEMA_VERSION = 1;
export const KINDS = ["exam", "other"];
export const STATES = ["new", "active", "no-page", "removed"];
export const PAGE_STATES = ["proposed", "confirmed", "rejected"];
export const ORIGINS = [
  "exam",
  "replacement",
  "card",
  "modules",
  "guide",
  "groups",
  "maintainer",
];

/** The share of a skill's modules a course must contain for the skill to count as built on it. */
export const SKILL_SHARE = 0.5;
/** Runs in a row a course must be missing from the catalog before it counts as removed. */
export const REMOVED_AFTER_RUNS = 2;
/** How many pages a proposal names at most. */
export const MAX_PROPOSALS = 4;
/** Roles that only education courses have (Minecraft Education, Teams for Education, the 21st century learning design). */
export const EDUCATION_ROLES = [
  "k-12-educator",
  "higher-ed-educator",
  "school-leader",
];
/** A course for educators: some role of it is an education role. */
export const isEducation = (roles) =>
  (roles ?? []).some((r) => EDUCATION_ROLES.includes(r));

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const EXAM_CODE = /^[A-Z]{2,3}-\d{3}$/;

// ---------------------------------------------------------------------------
// The catalog -> an entry's own fields
// ---------------------------------------------------------------------------

/** FNV-1a style short hash of a string (stable, no crypto needed): 8 hex digits. */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The code a course number stands for: AZ-104T00-A -> AZ-104, SC-5006 -> SC-5006, anything else "". */
export function courseCode(number) {
  const upper = String(number ?? "")
    .trim()
    .toUpperCase();
  const exam = /^([A-Z]{1,4}-\d{3})T\d{2}(?![\dA-Z])/.exec(upper);
  if (exam) return exam[1];
  const skill = /^([A-Z]{1,4}-\d{4})(?!\d)/.exec(upper);
  return skill ? skill[1] : "";
}

/** The key of a catalog course: its uid without "course.", lower case. */
export const keyOfCourse = (course) =>
  String(course?.uid ?? "")
    .replace(/^course\./i, "")
    .trim()
    .toLowerCase();

const sortedStrings = (list) =>
  [...new Set((list ?? []).filter((x) => typeof x === "string"))].sort(byText);

/** The hash of the learning paths and modules a course lists (what "its learning path list changed" compares). */
export function pathsHashOf(course) {
  return shortHash(
    (course?.study_guide ?? [])
      .map((s) => `${s.type}:${s.uid}`)
      .sort(byText)
      .join("\n"),
  );
}

const cleanText = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The slug of an Applied Skill: the last part of its address. */
export function skillSlug(skill) {
  const path = String(skill?.url ?? skill?.uid ?? "").split(/[?#]/)[0];
  const m = /applied-skills\/([^/]+)/.exec(path);
  return m ? m[1] : String(skill?.uid ?? "").replace(/^applied-skill\./, "");
}

/**
 * The fields of an entry that come from the catalog alone. `kind` and `exam` follow the number:
 * an exam course is <CODE>T<nn> with <CODE> in `examCodes`.
 */
export function catalogFields(course, { examCodes }) {
  const number = String(course?.course_number ?? "").trim();
  const code = courseCode(number);
  const isExam = /^[A-Z]{1,4}-\d{3}T\d{2}/i.test(number) && examCodes.has(code);
  const url = String(course?.url ?? "");
  const path = /\/training\/courses\/[^/?#]+/i.exec(url)?.[0] ?? "";
  return {
    uid: String(course?.uid ?? ""),
    number,
    code,
    title: cleanText(course?.title),
    kind: isExam ? "exam" : "other",
    ...(isExam ? { exam: code } : {}),
    url: path.toLowerCase(),
    levels: sortedStrings(course?.levels),
    roles: sortedStrings(course?.roles),
    products: sortedStrings(course?.products),
    pathsHash: pathsHashOf(course),
    summaryHash: shortHash(cleanText(course?.summary)),
  };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export function emptyFile() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSynced: null,
    reported: { signature: null, date: null },
    courses: [],
  };
}

/** Parse and validate the text of the file; throws an Error that names the first problem. */
export function parseFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`the course tracker is not valid JSON: ${error.message}`);
  }
  if (!data || data.schemaVersion !== SCHEMA_VERSION)
    throw new Error(
      `the course tracker has schemaVersion ${data?.schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
  if (!Array.isArray(data.courses))
    throw new Error("the course tracker has no courses list");
  const seen = new Set();
  for (const c of data.courses) {
    const where = `course ${c?.key ?? JSON.stringify(c)}`;
    if (typeof c.key !== "string" || c.key === "")
      throw new Error(`${where}: key is missing`);
    if (seen.has(c.key)) throw new Error(`${where}: key appears twice`);
    seen.add(c.key);
    if (!KINDS.includes(c.kind))
      throw new Error(`${where}: unknown kind ${c.kind}`);
    if (!STATES.includes(c.state))
      throw new Error(`${where}: unknown state ${c.state}`);
    for (const p of c.pages ?? []) {
      if (!EXAM_CODE.test(p.page))
        throw new Error(`${where}: ${p.page} is not an exam page code`);
      if (!PAGE_STATES.includes(p.state))
        throw new Error(`${where}: unknown page state ${p.state}`);
      if (!ORIGINS.includes(p.origin))
        throw new Error(`${where}: unknown origin ${p.origin}`);
    }
    if (c.state === "active" && !hasConfirmed(c))
      throw new Error(`${where}: an active course needs a confirmed page`);
    // the file leaves empty lists out; the code reads them as lists
    for (const field of ["pages", "skills", "levels", "roles", "products"])
      c[field] ??= [];
  }
  return data;
}

const FIELD_ORDER = [
  "key",
  "uid",
  "number",
  "code",
  "title",
  "kind",
  "exam",
  "examPage",
  "url",
  "levels",
  "roles",
  "products",
  "pathsHash",
  "summaryHash",
  "skills",
  "pages",
  "state",
  "review",
  "ack",
  "firstSeen",
  "lastSeen",
  "goneSince",
  "missingRuns",
  "note",
];

function orderedEntry(entry) {
  const out = {};
  for (const field of FIELD_ORDER) {
    const value = entry[field];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field] = value;
  }
  return out;
}

/** The text of the file: a header, then one course per line, sorted by key. */
export function serializeFile(file) {
  const sorted = [...file.courses].sort((a, b) => byText(a.key, b.key));
  const lines = sorted.map((c) => `    ${JSON.stringify(orderedEntry(c))}`);
  return (
    `{\n  "schemaVersion": ${file.schemaVersion},\n` +
    `  "lastSynced": ${JSON.stringify(file.lastSynced ?? null)},\n` +
    `  "reported": ${JSON.stringify(file.reported ?? null)},\n` +
    `  "courses": [\n${lines.join(",\n")}${lines.length ? "\n" : ""}  ]\n}\n`
  );
}

/** The same file without `lastSynced`: what "did anything change" compares. */
export const comparable = (file) =>
  serializeFile({ ...file, lastSynced: null });

export const hasConfirmed = (course) =>
  (course.pages ?? []).some((p) => p.state === "confirmed");

// ---------------------------------------------------------------------------
// Module sets and Applied Skills
// ---------------------------------------------------------------------------

/**
 * The Applied Skills built on a course: those at least `SKILL_SHARE` of whose modules the course contains.
 *   courseModules  Set of module paths of the course
 *   skills         [{ slug, modules: Set }]
 * Returns [{ slug, count, total }] sorted by slug.
 */
export function skillsBuiltOn(courseModules, skills) {
  const out = [];
  for (const skill of skills) {
    const total = skill.modules.size;
    if (total === 0) continue;
    let count = 0;
    for (const path of skill.modules) if (courseModules.has(path)) count++;
    if (count > 0 && count / total >= SKILL_SHARE)
      out.push({ slug: skill.slug, count, total });
  }
  return out.sort((a, b) => byText(a.slug, b.slug));
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/** Merge the mechanical pages into the pages the entry already has: same page, keep the maintainer's state. */
function mergePage(pages, incoming) {
  const at = pages.findIndex((p) => p.page === incoming.page);
  if (at < 0) {
    pages.push(incoming);
    return;
  }
  const have = pages[at];
  // a decision of the maintainer (confirmed or rejected) is never overwritten by a mechanical origin
  if (have.state === "rejected") return;
  if (have.state === "confirmed") return;
  pages[at] = { ...have, ...incoming, state: incoming.state };
}

/**
 * The pages an exam course is assigned to by the rule:
 *   its exam's page, when the hub has one (origin exam, confirmed);
 *   the page of the exam that replaces its exam while that exam retires (origin replacement, temporary, proposed
 *   until the maintainer confirms it).
 * `hubPages` is a Map exam code -> { file, archived }; `retiring` the entries of retiring-exams.json.
 */
export function examPages(entry, { hubPages, retiring }) {
  const exam = entry.examPage || entry.exam;
  const pages = [];
  if (exam && hubPages.has(exam))
    pages.push({ page: exam, state: "confirmed", origin: "exam" });
  for (const r of retiring ?? []) {
    if (r.code !== exam || !r.replacementCode) continue;
    if (!hubPages.has(r.replacementCode)) continue;
    pages.push({
      page: r.replacementCode,
      state: "proposed",
      origin: "replacement",
      temporary: { for: exam },
    });
  }
  return pages;
}

const originOfReasons = (reasons) =>
  reasons?.shared
    ? "modules"
    : reasons?.groups?.groups?.length
      ? "groups"
      : "guide";

/**
 * Turn the placement tool's suggestions into proposed pages. Pages the hub does not have are dropped, and so is the
 * course's own exam. `describe(suggestion)` makes the sentence the issue shows.
 */
export function proposalsFrom(
  suggestions,
  { hubPages, exclude = [], describe },
) {
  const out = [];
  for (const s of suggestions ?? []) {
    if (!hubPages.has(s.exam) || hubPages.get(s.exam).archived) continue;
    if (exclude.includes(s.exam)) continue;
    out.push({
      page: s.exam,
      state: "proposed",
      origin: originOfReasons(s.reasons),
      confidence: s.confidence,
      // "AB-650, likely (...)" becomes "likely (...)": the page is named next to it
      why: describe
        ? describe(s).replace(new RegExp(`^${s.exam},?\\s*`), "")
        : "",
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

/**
 * Bring the file up to date. Pure.
 *   previous     the parsed file (emptyFile() on the first run)
 *   courses      the catalog API's course records
 *   examCodes    Set of exam codes that exist on Learn
 *   hubPages     Map exam code -> { file, archived } of the hub's exam pages (docs and archive)
 *   retiring     the entries of retiring-exams.json
 *   modulesOf    (record) -> Set of module paths (a course or an Applied Skill)
 *   skills       [{ slug, modules: Set }] the Applied Skills of the catalog (null: not readable, keep what is there)
 *   cards        the hub's course cards (scanCourseCards): { file, page, archived, kind: learn|youtube, key, code }
 *   videos       Map code -> { playlist }  the Course Videos Monitor's baseline
 *   propose      (record, entry) -> placement suggestions for a course that needs a decision (may be async-free)
 *   today        YYYY-MM-DD
 * Returns { file, changes }:
 *   added[] changed[] removed[] back[] ghosts[]   keys
 */
export function syncCourses({
  previous,
  courses,
  examCodes,
  hubPages,
  retiring = [],
  modulesOf,
  skills = [],
  cards = [],
  videos = new Map(),
  propose = () => [],
  describe,
  today,
}) {
  const prev = new Map(previous.courses.map((c) => [c.key, c]));
  const changes = { added: [], changed: [], removed: [], back: [], ghosts: [] };
  const out = [];
  const seen = new Set();

  const hasCard = (entry, page, kinds) =>
    cards.some(
      (card) =>
        card.page === page &&
        kinds.includes(card.kind) &&
        ((card.kind === "learn" && card.key === entry.key) ||
          (card.kind === "youtube" &&
            entry.code &&
            (card.code === entry.code ||
              (videos.get(entry.code)?.playlist &&
                card.playlist === videos.get(entry.code).playlist)))),
    );
  const cardPages = (entry) => [
    ...new Set(
      cards
        .filter(
          (card) =>
            card.page && hasCard(entry, card.page, ["learn", "youtube"]),
        )
        .map((card) => card.page),
    ),
  ];

  for (const course of courses) {
    const key = keyOfCourse(course);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = prev.get(key);
    const fields = catalogFields(course, { examCodes });
    const entry = {
      ...(old ?? {}),
      key,
      ...fields,
      pages: (old?.pages ?? []).map((p) => ({ ...p })),
      firstSeen: old?.firstSeen ?? today,
      lastSeen: today,
    };
    delete entry.goneSince;
    delete entry.missingRuns;
    if (old?.exam && fields.kind !== "exam") delete entry.exam;

    // what changed in the catalog
    if (!old) changes.added.push(key);
    else {
      const what = [];
      if (old.title !== fields.title) what.push("title");
      if (old.pathsHash !== fields.pathsHash) what.push("learning paths");
      if (what.length) changes.changed.push({ key, what });
      if (
        old.pathsHash !== fields.pathsHash &&
        hasConfirmed(old) &&
        !old.review
      )
        entry.review = { since: today, what: "its learning path list changed" };
      if (old.state === "removed") changes.back.push(key);
    }

    // Applied Skills built on it (mechanical)
    // null: the Applied Skills could not be read this run, so what is there stays
    entry.skills = skills
      ? skillsBuiltOn(modulesOf(course), skills)
      : (old?.skills ?? []);

    if (entry.kind === "exam") {
      // the rule: its exam's page, a replacement temporarily; the maintainer's decision on a replacement is kept
      entry.pages = entry.pages.filter(
        (p) => p.origin !== "exam" && p.origin !== "replacement",
      );
      const decided = new Map(
        (old?.pages ?? [])
          .filter((p) => p.origin === "replacement")
          .map((p) => [p.page, p]),
      );
      for (const page of examPages(entry, { hubPages, retiring })) {
        const before = decided.get(page.page);
        entry.pages.push(
          before && before.state !== "proposed"
            ? { ...page, state: before.state }
            : page,
        );
      }
      entry.state = hasConfirmed(entry) ? "active" : "no-page";
      delete entry.review;
    } else {
      // other courses: the hub's own cards confirm, the placement proposes for a course that needs a decision
      for (const page of cardPages(entry))
        mergePage(entry.pages, { page, state: "confirmed", origin: "card" });
      if (hasConfirmed(entry)) entry.state = "active";
      else if (old?.state === "no-page") entry.state = "no-page";
      else if (!old && isEducation(entry.roles)) {
        // a course for teachers and school leaders is no certification material: decided once, when it first shows up
        entry.state = "no-page";
        entry.note =
          "education course (its roles): belongs to no certification page";
      } else entry.state = "new";
      if (entry.state === "new") {
        entry.pages = entry.pages.filter((p) => p.state !== "proposed");
        const proposed = proposalsFrom(propose(course, entry), {
          hubPages,
          exclude: entry.pages.map((p) => p.page),
          describe,
        });
        entry.pages.push(...proposed);
      }
    }
    entry.pages.sort((a, b) => byText(a.page, b.page));
    out.push(entry);
  }

  // courses that are not in the catalog this run
  for (const old of previous.courses) {
    if (seen.has(old.key)) continue;
    const entry = { ...old, pages: (old.pages ?? []).map((p) => ({ ...p })) };
    if (old.state === "removed") {
      out.push(entry);
      continue;
    }
    const runs = (old.missingRuns ?? 0) + 1;
    if (runs >= REMOVED_AFTER_RUNS) {
      entry.state = "removed";
      entry.goneSince = today;
      delete entry.missingRuns;
      changes.removed.push(old.key);
    } else {
      entry.missingRuns = runs;
    }
    out.push(entry);
  }

  // a four-digit course that a hub YouTube card names but the catalog does not have (AI-3016): a removed entry
  const have = new Set(out.map((e) => e.code).filter(Boolean));
  for (const card of cards) {
    if (card.kind !== "youtube" || !/^[A-Z]{1,4}-\d{4}$/.test(card.code ?? ""))
      continue;
    if (have.has(card.code)) continue;
    have.add(card.code);
    const key = card.code.toLowerCase();
    if (out.some((e) => e.key === key)) continue;
    out.push({
      key,
      uid: "",
      number: card.code,
      code: card.code,
      title: "",
      kind: "other",
      pages: [],
      state: "removed",
      firstSeen: today,
      lastSeen: today,
      goneSince: today,
      note: "not in the Learn catalog; a hub card for its recording exists",
    });
    changes.ghosts.push(key);
  }

  return {
    file: {
      schemaVersion: SCHEMA_VERSION,
      lastSynced: today,
      reported: previous.reported ?? { signature: null, date: null },
      courses: out.sort((a, b) => byText(a.key, b.key)),
    },
    changes,
  };
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

/**
 * What the hub says about the tracked courses, and what needs a person. Pure.
 *   file       the synced file
 *   hubPages   Map exam code -> { file, archived }
 *   cards      the hub's course cards (scanCourseCards)
 *   retiring   retiring-exams.json entries
 *   skillsCache  applied-skills-cache.json ({ retiring: [{ name, url }] } or null)
 *   videos     Map code -> { playlist }
 *   today      YYYY-MM-DD
 * Returns { fresh, replacements, missing, gone, temporary, reviews, skills }:
 *   fresh      the courses that need a decision (state new)
 *   replacements  [{ course, page, for }]  an exam course proposed for the page of its exam's replacement
 *   missing    [{ course, page, file, cards[] }]  a confirmed page of an active exam page that has no card for the course
 *   gone       [{ course, files[] }]  a removed course that hub pages still link (not acknowledged)
 *   temporary  [{ course, page, for, why }]  a temporary assignment to review
 *   reviews    the courses with a `review` flag
 *   skills     [{ course, slug }]  a retired Applied Skill built on a tracked course
 */
export function checkHub({
  file,
  hubPages,
  cards,
  retiring = [],
  skillsCache = null,
  videos = new Map(),
  today,
}) {
  const result = {
    fresh: [],
    replacements: [],
    missing: [],
    gone: [],
    temporary: [],
    reviews: [],
    skills: [],
  };
  const courseByKey = new Map(file.courses.map((c) => [c.key, c]));
  const examCourseOf = new Map(); // exam code -> an exam course entry that is not removed
  for (const c of file.courses)
    if (c.kind === "exam" && c.state !== "removed")
      examCourseOf.set(c.examPage || c.exam, c);

  const linked = (course) =>
    cards.filter(
      (card) =>
        (card.kind === "learn" && card.key === course.key) ||
        (card.kind === "youtube" &&
          course.code &&
          (card.code === course.code ||
            (videos.get(course.code)?.playlist &&
              card.playlist === videos.get(course.code).playlist))),
    );

  for (const course of file.courses) {
    if (course.state === "new" && course.kind === "other")
      result.fresh.push(course);
    if (course.review) result.reviews.push(course);

    if (course.state === "removed") {
      const files = [...new Set(linked(course).map((c) => c.file))].sort(
        byText,
      );
      if (files.length && !course.ack) result.gone.push({ course, files });
      continue;
    }

    for (const p of course.pages ?? []) {
      const hub = hubPages.get(p.page);
      if (p.state === "confirmed" && hub && !hub.archived) {
        // a confirmed page needs the Learn page of the course; the recording's card does not stand in for it
        const have = linked(course).filter((c) => c.page === p.page);
        if (!have.some((c) => c.kind === "learn"))
          result.missing.push({
            course,
            page: p.page,
            file: hub.file,
            // the recording's card is only suggested when the page has none yet
            cards: suggestedCards(course, videos).filter(
              (card, i) => i === 0 || !have.some((c) => c.kind === "youtube"),
            ),
          });
      }
      if (p.temporary && p.state === "proposed")
        result.replacements.push({
          course,
          page: p.page,
          for: p.temporary.for,
        });
      if (p.temporary && p.state === "confirmed") {
        const retire = retiring.find((r) => r.code === p.temporary.for);
        const own = examCourseOf.get(p.page);
        let why = "";
        if (retire?.retirementDate && retire.retirementDate < today)
          why = `${p.temporary.for} retired on ${retire.retirementDate}`;
        else if (own && own.key !== course.key)
          why = `${p.page} has its own course now (${own.number || own.key})`;
        if (why)
          result.temporary.push({
            course,
            page: p.page,
            for: p.temporary.for,
            why,
          });
      }
    }
  }

  // an Applied Skill that retires while a tracked course is built on it
  const retiringSkills = new Set(
    (skillsCache?.retiring ?? []).map((s) => skillSlug({ url: s.url ?? "" })),
  );
  for (const course of file.courses)
    for (const s of course.skills ?? [])
      if (retiringSkills.has(s.slug))
        result.skills.push({ course, slug: s.slug });

  void courseByKey;
  return result;
}

/** The cards a person would add for a course: its Learn page and, when a recording exists, the YouTube card. */
export function suggestedCards(course, videos = new Map()) {
  const cards = [];
  const href = `https://learn.microsoft.com/training/courses/${course.key}?WT.mc_id=studentamb_165290`;
  const label = course.code || course.number || course.key;
  // an exam course is the exam's own, the code in its title says nothing for a four-digit course: the topic does
  const topic = course.title
    ? ` description="${course.title.replace(/"/g, "&quot;")}"`
    : "";
  cards.push(
    course.kind === "exam"
      ? `<LinkCard title="Microsoft Learn" href="${href}" target="_blank"/>`
      : `<LinkCard title="Microsoft Learn ${label} Course" href="${href}" target="_blank"${topic}/>`,
  );
  if (course.code && videos.get(course.code)?.playlist)
    cards.push(
      `<LinkCard title="Microsoft Learn ${course.code} Course on YouTube" href="https://aka.ms/${course.code}onYouTube" target="_blank"/>`,
    );
  return cards;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** How many things need a person. */
export function needsCount(view) {
  return (
    view.fresh.length +
    view.replacements.length +
    view.missing.length +
    view.gone.length +
    view.temporary.length +
    view.reviews.length +
    view.skills.length
  );
}

/** A stable fingerprint of what needs a person: the signature of the running issue. */
export function signatureOf(view, hash = shortHash) {
  const parts = [
    ...view.fresh.map(
      (c) => `n|${c.key}|${c.pages.map((p) => p.page).join(",")}`,
    ),
    ...view.replacements.map((r) => `p|${r.course.key}|${r.page}`),
    ...view.missing.map((m) => `m|${m.course.key}|${m.page}`),
    ...view.gone.map((g) => `g|${g.course.key}`),
    ...view.temporary.map((t) => `t|${t.course.key}|${t.page}`),
    ...view.reviews.map((c) => `r|${c.key}|${c.review.since}`),
    ...view.skills.map((s) => `s|${s.course.key}|${s.slug}`),
  ].sort(byText);
  return hash(parts.join("\n"));
}

const esc = (text) =>
  String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ");
const courseLabel = (c) => {
  const name = c.number || c.key;
  const link = c.url
    ? `[${esc(name)}](https://learn.microsoft.com${c.url}?WT.mc_id=studentamb_165290)`
    : esc(name);
  return c.title ? `${link} ${esc(c.title)}` : link;
};

/**
 * The text of the running issue; "" when nothing needs a person.
 *   summary  { total, byState, added, removed, changed } for the first lines
 */
export function buildReport({
  file,
  view,
  changes,
  summary,
  date,
  maxRows = 60,
  notes = [],
}) {
  if (needsCount(view) === 0) return "";
  const lines = [`## Learn courses ${date}`, ""];
  lines.push(
    `${summary.total} Learn courses tracked (${summary.exam} exam courses, ${summary.other} others): ${summary.active} assigned to hub pages, ${summary.new} waiting for a decision, ${summary.noPage} decided to belong to no page, ${summary.removed} removed from the catalog. This run: ${changes.added.length} new, ${changes.removed.length} removed, ${changes.changed.length} changed.`,
    "",
    'Decide by editing `src/data_files/learn-courses.json`: set a proposed page to `confirmed` or `rejected`, or set the course to `"state": "no-page"`. Nothing is placed automatically. Then add the card to the page and the next run sees it.',
    "",
  );
  const table = (head, rows) => {
    const shown = rows.slice(0, maxRows);
    const out = [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...shown,
    ];
    if (rows.length > shown.length)
      out.push(
        `| ... ${rows.length - shown.length} more | ${head
          .slice(1)
          .map(() => "")
          .join(" | ")} |`,
      );
    return out;
  };

  if (view.fresh.length) {
    lines.push(
      `### Courses waiting for a decision (${view.fresh.length})`,
      "",
      "A course that is no exam's own. The proposals are by relevancy (modules shared with an exam's official course, the study guide text, skill groups the modules cover); a proposal says why.",
      "",
      ...table(
        ["Course", "Roles / products", "Built-on skills", "Proposed pages"],
        view.fresh.map((c) => {
          const proposals = c.pages.filter((p) => p.state === "proposed");
          return `| ${courseLabel(c)} | ${esc([...c.roles, ...c.products].slice(0, 5).join(", ")) || "-"} | ${esc(c.skills.map((s) => `${s.slug} (${s.count} of ${s.total})`).join(", ")) || "-"} | ${proposals.length ? proposals.map((p) => `**${p.page}** ${esc(p.why)}`).join("<br>") : "none found: probably no hub page"} |`;
        }),
      ),
      "",
    );
  }
  if (view.replacements.length) {
    lines.push(
      `### Exam courses proposed for a replacement page (${view.replacements.length})`,
      "",
      "A course belongs to its own exam's page. While that exam retires, it may also go on the page of the exam that replaces it. Set the page to `confirmed` to keep it there for now (it is then watched and reported when it is time to remove it) or to `rejected`.",
      "",
      ...table(
        ["Course", "Replacement page", "Replaces"],
        view.replacements.map(
          (r) => `| ${courseLabel(r.course)} | ${r.page} | ${r.for} |`,
        ),
      ),
      "",
    );
  }
  if (view.missing.length) {
    lines.push(
      `### Confirmed pages that lack the course card (${view.missing.length})`,
      "",
      ...table(
        ["Page", "Course", "Card to add"],
        view.missing.map(
          (m) =>
            `| \`${m.file}\` | ${courseLabel(m.course)} | ${m.cards.map((c) => `\`${esc(c)}\``).join("<br>")} |`,
        ),
      ),
      "",
    );
  }
  if (view.gone.length) {
    lines.push(
      `### Courses that are not (or no longer) in the Learn catalog but hub pages still link (${view.gone.length})`,
      "",
      'Remove the card from each page, or set `"ack": true` on the course when the link is meant to stay (a recording that still works, a course Learn does not list).',
      "",
      ...table(
        ["Course", "Pages that link it"],
        view.gone.map(
          (g) =>
            `| ${courseLabel(g.course)} | ${g.files.map((f) => `\`${f}\``).join("<br>")} |`,
        ),
      ),
      "",
    );
  }
  if (view.temporary.length) {
    lines.push(
      `### Temporary assignments to review (${view.temporary.length})`,
      "",
      "A course of a retiring exam sits on the page of its replacement, and it is time to look at that. Remove the card and the page entry when it is no longer wanted, or make it permanent by deleting `temporary`.",
      "",
      ...table(
        ["Course", "Page", "Why now"],
        view.temporary.map(
          (t) =>
            `| ${courseLabel(t.course)} | ${t.page} (temporary for ${t.for}) | ${esc(t.why)} |`,
        ),
      ),
      "",
    );
  }
  if (view.reviews.length) {
    lines.push(
      `### Courses to look at again (${view.reviews.length})`,
      "",
      "Their learning paths changed, so the pages they are assigned to may be out of date. Delete the `review` field after looking.",
      "",
      ...table(
        ["Course", "Pages", "Since", "What"],
        view.reviews.map(
          (c) =>
            `| ${courseLabel(c)} | ${esc(
              c.pages
                .filter((p) => p.state === "confirmed")
                .map((p) => p.page)
                .join(", "),
            )} | ${c.review.since} | ${esc(c.review.what)} |`,
        ),
      ),
      "",
    );
  }
  if (view.skills.length) {
    lines.push(
      `### Retiring Applied Skills built on a tracked course (${view.skills.length})`,
      "",
      ...table(
        ["Course", "Applied Skill"],
        view.skills.map((s) => `| ${courseLabel(s.course)} | ${esc(s.slug)} |`),
      ),
      "",
    );
  }
  for (const note of notes) lines.push(`> ${note}`, "");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Counts for the first line of the report and the log. */
export function summarize(file) {
  const s = {
    total: file.courses.length,
    exam: 0,
    other: 0,
    active: 0,
    new: 0,
    noPage: 0,
    removed: 0,
  };
  for (const c of file.courses) {
    if (c.kind === "exam") s.exam++;
    else s.other++;
    if (c.state === "active") s.active++;
    else if (c.state === "new") s.new++;
    else if (c.state === "no-page") s.noPage++;
    else if (c.state === "removed") s.removed++;
  }
  return s;
}
