/**
 * Course placement (docs/course-placement.md): which exam pages a Microsoft Learn course that is not an exam's own
 * course (AI-3026, SC-5006, AZ-2008, ...) belongs on. It suggests; a person decides. Pure: no I/O, no network,
 * deterministic. The pools come from `buildPools` (scripts/lib/course-candidates.mjs), the guides from `parseGuide`.
 *
 * Three channels, kept apart so that every suggestion says why it is there:
 *   shared   The course's modules that an exam's OFFICIAL course lists too (`pools.official`). Deterministic and
 *            the strongest evidence.
 *   guide    The course's title and module titles as a query against the study guide text of every exam (name,
 *            domains, skill groups, tasks), BM25 with the pipeline's stemmer and abbreviations. Measured on the 52
 *            official exam courses of 2026-10-20: the course's own exam was first for 47 and in the first three
 *            for all 52.
 *   groups   Skill groups (and tasks) of an exam whose words the course's modules contain almost completely
 *            (`groupCoverage`), with the module index's rarity weights: "Implement Microsoft Security Copilot" is
 *            covered by a course about Security Copilot. Weaker as a ranking (35 of 52 first), but it finds exams
 *            the guide match misses, and its evidence is something a person can read.
 * The order is a plain count of the evidence, not a blended score: an exam that several channels agree on comes
 * before one that a single channel names (see `suggestExams`), and `reasons` has all three channels for every
 * suggestion so a person can judge it.
 */

import { LexicalIndex, queryTerms } from "./course-lexical.mjs";

export const PLACEMENT_DEFAULTS = Object.freeze({
  // the share of a skill group's (or task's) terms the course's modules must contain
  groupCoverage: 0.85,
  // a group needs this many distinctive words (verbs and the domain's words do not count), a task this many
  minGroupTerms: 2,
  minTaskTerms: 3,
  // how many exams the guide match contributes, and the share of the course's words an exam's guide must contain
  guideMatches: 3,
  minGuideCoverage: 0.2,
  // the share of the course's modules an exam's official course must contain to count as a real overlap
  minSharedShare: 0.3,
  // how many suggestions are returned at most
  maxSuggestions: 6,
});

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The code a course number stands for, which is also the name of its short link
 * (https://aka.ms/<CODE>onYouTube): AZ-104T00-A -> AZ-104, SC-5006-A -> SC-5006 (a
 * four-digit course has no T00 part). "" for anything else.
 */
export function courseCode(number) {
  const upper = String(number ?? "")
    .trim()
    .toUpperCase();
  const exam = /^([A-Z]{1,4}-\d{3})T\d{2}(?![\dA-Z])/.exec(upper);
  if (exam) return exam[1];
  const skill = /^([A-Z]{1,4}-\d{4})(?!\d)/.exec(upper);
  return skill ? skill[1] : "";
}

/**
 * The modules of a course: its `study_guide` entries are learning paths (resolved through `learningPaths`) or
 * modules. Returns { modules: [{ path, title, units }], unresolved: [uid] }. A module that is not in the catalog
 * (out of scope, removed) is left out and counted in `missing`.
 */
export function courseModules(course, { learningPaths, modules }) {
  const pathByUid = new Map((learningPaths ?? []).map((p) => [p.uid, p]));
  const moduleByUid = new Map((modules ?? []).map((m) => [m.uid, m]));
  const moduleByPath = new Map((modules ?? []).map((m) => [m.path, m]));
  const found = new Map();
  const unresolved = [];
  let missing = 0;
  const add = (path) => {
    const record = moduleByPath.get(path);
    if (!record) {
      missing++;
      return;
    }
    if (!found.has(path)) {
      found.set(path, {
        path,
        title: record.title ?? path,
        units: Array.isArray(record.units) ? record.units : [],
      });
    }
  };
  for (const entry of course?.study_guide ?? []) {
    const learningPath = pathByUid.get(entry.uid);
    if (learningPath) for (const path of learningPath.modules ?? []) add(path);
    else if (moduleByUid.has(entry.uid)) add(moduleByUid.get(entry.uid).path);
    else unresolved.push(entry.uid);
  }
  return { modules: [...found.values()], unresolved, missing };
}

/**
 * The study guides as the placement reads them: `guides` is a Map code -> { name, tree } (tree from `parseGuide`,
 * only complete ones). The index has one document per exam: its name (weight 3), domain titles (2), skill group
 * titles (1.5) and task texts (1).
 */
export function buildGuideIndex(guides) {
  const index = new LexicalIndex();
  for (const [code, { name, tree }] of [...guides].sort((a, b) =>
    byText(a[0], b[0]),
  )) {
    const domains = [];
    const groups = [];
    const tasks = [];
    for (const domain of tree.domains) {
      domains.push(domain.title);
      for (const group of domain.groups) {
        groups.push(group.title);
        for (const task of group.tasks) tasks.push(task.text);
      }
    }
    index.add(code, [
      { text: name ?? code, weight: 3 },
      { text: domains.join(" . "), weight: 2 },
      { text: groups.join(" . "), weight: 1.5 },
      { text: tasks.join(" . "), weight: 1 },
    ]);
  }
  return index.finalize();
}

/** The text a course is searched with: its title twice, then the title of every module. */
export function courseProfile(course, modules) {
  const title = String(course?.title ?? "");
  return [title, title, ...modules.map((m) => m.title)]
    .filter(Boolean)
    .join(" . ");
}

const distinctTerms = (query) =>
  query.terms.filter((t) => !t.generic && !t.context).length;

/**
 * The skill groups and tasks of one exam that the course's modules cover (see "groups" above).
 * Returns { groups: [title], tasks: number }.
 */
export function coveredByModules(tree, modulePaths, pools, options) {
  const include = (id) => modulePaths.has(id);
  const covers = (query) =>
    pools.moduleIndex.search(query, {
      include,
      minCoverage: options.groupCoverage,
      limit: 1,
    }).hits.length > 0;
  const groups = [];
  let tasks = 0;
  for (const domain of tree.domains) {
    for (const group of domain.groups) {
      if (group.implicit) continue;
      const query = queryTerms(group.title);
      if (distinctTerms(query) >= options.minGroupTerms && covers(query)) {
        groups.push(group.title);
      }
      for (const task of group.tasks) {
        const taskQuery = queryTerms(task.text);
        if (
          distinctTerms(taskQuery) >= options.minTaskTerms &&
          covers(taskQuery)
        ) {
          tasks++;
        }
      }
    }
  }
  return { groups, tasks };
}

/** strong: three or more points (a real overlap plus another channel); likely: two; possible: one. */
export function confidenceOf(points) {
  if (points >= 3) return "strong";
  if (points >= 2) return "likely";
  return "possible";
}

/**
 * Suggestions for one course.
 *   course    a course of the catalog API (title, study_guide)
 *   modules   courseModules(...).modules (may be empty: the course is then searched by its title alone)
 *   guides    Map code -> { name, tree }
 *   guideIndex buildGuideIndex(guides)
 *   pools     buildPools(...) (moduleIndex, official)
 * Returns { suggestions: [{ exam, name, points, confidence, reasons }], note }
 *   points    the evidence behind the suggestion: 2 for a real overlap of modules (`minSharedShare` of the
 *             course), 0.5 for a smaller one, 1 for a top guide match, 1 for a skill group the course covers.
 *             Exams are listed by points, then by the share of modules, the groups covered and the guide rank.
 *   reasons   { shared: { count, total, modules, strong } | null,
 *               guide: { rank, coverage, words, strong } | null,
 *               groups: { groups: [title], tasks } | null }
 *   note      set when nothing was found: why
 */
export function suggestExams({
  course,
  modules,
  guides,
  guideIndex,
  pools,
  options = {},
}) {
  const opts = { ...PLACEMENT_DEFAULTS, ...options };
  const paths = new Set(modules.map((m) => m.path));
  const byExam = new Map();
  const entry = (exam) => {
    let e = byExam.get(exam);
    if (!e) {
      e = {
        exam,
        name: guides.get(exam)?.name ?? null,
        points: 0,
        reasons: { shared: null, guide: null, groups: null },
      };
      byExam.set(exam, e);
    }
    return e;
  };

  // shared modules
  const shared = new Map();
  for (const module of modules) {
    for (const official of pools.official.get(module.path) ?? []) {
      if (!official.exam) continue;
      const list = shared.get(official.exam) ?? [];
      if (!list.includes(module.title)) list.push(module.title);
      shared.set(official.exam, list);
    }
  }
  for (const [exam, titles] of shared) {
    const e = entry(exam);
    const strong = titles.length >= opts.minSharedShare * modules.length;
    e.reasons.shared = {
      count: titles.length,
      total: modules.length,
      modules: titles,
      strong,
    };
    e.points += strong ? 2 : 0.5;
  }

  // guide match
  const query = queryTerms(courseProfile(course, modules));
  const found = guideIndex.search(query, {
    limit: Math.max(opts.guideMatches * 4, 12),
    minCoverage: 0,
  });
  // the words that say most (the rarest ones among the exams' guides) come first
  const weightOf = new Map(
    query.terms.map((t) => [t.word, t.weight * guideIndex.idf(t.term)]),
  );
  let rank = 0;
  for (const hit of found.hits) {
    rank++;
    const words = [...new Set(hit.matched ?? [])]
      .sort(
        (a, b) =>
          (weightOf.get(b) ?? 0) - (weightOf.get(a) ?? 0) || byText(a, b),
      )
      .slice(0, 8);
    const strong =
      rank <= opts.guideMatches && hit.coverage >= opts.minGuideCoverage;
    // a weaker match only explains an exam that has other evidence
    if (!strong && !byExam.has(hit.id)) continue;
    const e = entry(hit.id);
    e.reasons.guide = { rank, coverage: hit.coverage, words, strong };
    if (strong) e.points += 1;
  }

  // skill groups the modules cover
  if (paths.size > 0) {
    const covered = [];
    for (const [exam, { tree }] of guides) {
      const found2 = coveredByModules(tree, paths, pools, opts);
      if (found2.groups.length > 0 || found2.tasks > 0) {
        covered.push([exam, found2]);
      }
    }
    covered.sort(
      (a, b) =>
        b[1].groups.length * 3 +
          b[1].tasks -
          (a[1].groups.length * 3 + a[1].tasks) || byText(a[0], b[0]),
    );
    for (const [exam, result] of covered) {
      // a group is evidence; tasks alone only decorate an exam that is already there
      if (result.groups.length === 0 && !byExam.has(exam)) continue;
      const e = entry(exam);
      e.reasons.groups = result;
      if (result.groups.length > 0) e.points += 1;
    }
  }

  const shareOf = (e) => (e.reasons.shared ? e.reasons.shared.count : 0);
  const groupsOf = (e) =>
    e.reasons.groups
      ? e.reasons.groups.groups.length * 3 + e.reasons.groups.tasks
      : 0;
  const rankOf = (e) => e.reasons.guide?.rank ?? Infinity;
  const ordered = [...byExam.values()]
    // a weak overlap of modules alone, or tasks alone, is not a suggestion; and the course's own exam
    // (DP-605 for DP-605T00) shares everything with it and says nothing about where it belongs
    .filter(
      (e) => e.points >= 1 && e.exam !== courseCode(course?.course_number),
    )
    .sort(
      (a, b) =>
        b.points - a.points ||
        shareOf(b) - shareOf(a) ||
        groupsOf(b) - groupsOf(a) ||
        rankOf(a) - rankOf(b) ||
        byText(a.exam, b.exam),
    )
    .slice(0, opts.maxSuggestions)
    .map((e) => ({ ...e, confidence: confidenceOf(e.points) }));

  let note = null;
  if (ordered.length === 0) {
    note =
      modules.length === 0
        ? "the course has no modules in the catalog and its title is too generic to match a study guide"
        : "no exam shares its modules, matches its words or has a skill group it covers: probably not tied to an exam";
  }
  return { suggestions: ordered, note };
}

/**
 * One line a person can read: "AI-103, strong (shares 9 of 9 modules with its official course; guide match #3:
 * agents, foundry; covers the skill group “Build agents by using Foundry”)".
 */
export function describeSuggestion(suggestion, { groupsShown = 2 } = {}) {
  const parts = [];
  const { shared, guide, groups } = suggestion.reasons;
  if (shared) {
    parts.push(
      `shares ${shared.count} of ${shared.total} modules with its official course`,
    );
  }
  if (guide) {
    const words = guide.words.filter((w) => w.length > 2).slice(0, 5);
    parts.push(
      `guide match #${guide.rank}${words.length ? `: ${words.join(", ")}` : ""}`,
    );
  }
  if (groups?.groups.length) {
    const shown = groups.groups
      .slice(0, groupsShown)
      .map((g) => `“${g}”`)
      .join(", ");
    const more = groups.groups.length - groupsShown;
    parts.push(
      `covers the skill ${groups.groups.length === 1 ? "group" : "groups"} ${shown}${more > 0 ? ` and ${more} more` : ""}`,
    );
  } else if (groups?.tasks) {
    parts.push(
      `covers ${groups.tasks} ${groups.tasks === 1 ? "task" : "tasks"}`,
    );
  }
  const label = suggestion.confidence ? `, ${suggestion.confidence}` : "";
  return `${suggestion.exam}${label}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}
