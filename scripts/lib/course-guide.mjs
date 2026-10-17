/**
 * Study guide parser: the text of a Microsoft Learn study guide -> a tree of
 * domain (with its weight) / skill group / task, plus a comparison of two such trees.
 * Pure: no I/O, no network. The CLI is scripts/course-source.mjs (docs/course-source.md).
 *
 * Input is the guide as the New Exam Monitor stores it (`studyGuides[].lines` of
 * src/data_files/learn-exams.json): one string per line, headings as `## Title`,
 * bullets as `- text`.
 *
 * Why the parser anchors on the "Skills at a glance" list and not on heading depth:
 * 54 of the 56 hub guides use `### domain` / `#### group` / `- task`, but GH-900's guide
 * has an h1 domain and an h2 used as a group (Microsoft's authoring slips), so the
 * depth of a heading proves nothing. The glance list names every domain and its weight;
 * a heading whose text is one of those names starts that domain, any other heading
 * inside the skills section is a skill group, and the bullets under it are its tasks.
 */

const DASHES = /[‐-―−]/g;

/** Whitespace collapsed, typographic quotes and dashes made plain, trimmed. Case is kept. */
export function squish(text) {
  return String(text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower-cased, punctuation-free form used to match a heading with a glance bullet. */
export function normalizeTitle(text) {
  return squish(text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const WEIGHT_AT_END = /\s*\((\d+)(?:\s*[-‐-―−]\s*(\d+))?\s*%\)\s*$/;

/** "Manage storage (15–20%)" -> { title: "Manage storage", weight: { min: 15, max: 20 } }; no weight -> weight null. */
export function splitWeight(text) {
  const clean = squish(text);
  const match = clean.match(WEIGHT_AT_END);
  if (!match) return { title: clean, weight: null };
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return { title: clean.slice(0, match.index).trim(), weight: { min, max } };
}

/** { level, text } for a markdown heading line, else null. */
export function parseHeading(line) {
  const match = String(line ?? "").match(/^(#{1,6})\s+(.*\S)\s*$/);
  return match ? { level: match[1].length, text: squish(match[2]) } : null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * The "as of" date of the skills measured: from `## Skills measured as of April 17, 2026`
 * or `### Skills at a glance as of January 2026` (month only). { text, iso } where `iso` is
 * YYYY-MM-DD for a full date, YYYY-MM for a month, or null; the whole object is null when
 * the guide states none.
 */
export function parseAsOf(lines) {
  for (const line of lines) {
    const heading = parseHeading(line);
    if (!heading || !/skills/i.test(heading.text)) continue;
    const match = heading.text.match(/\bas of\s+(.+)$/i);
    if (!match) continue;
    const text = squish(match[1]);
    const full = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    const monthIndex = (name) => MONTHS.indexOf(name.toLowerCase());
    if (full && monthIndex(full[1]) >= 0) {
      return {
        text,
        iso: `${full[3]}-${String(monthIndex(full[1]) + 1).padStart(2, "0")}-${full[2].padStart(2, "0")}`,
      };
    }
    const partial = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (partial && monthIndex(partial[1]) >= 0)
      return {
        text,
        iso: `${partial[2]}-${String(monthIndex(partial[1]) + 1).padStart(2, "0")}`,
      };
    return { text, iso: null };
  }
  return null;
}

/** Headings after the last domain that end the skills measured. */
const END_OF_SKILLS =
  /^(study resources|additional study resources|study guide resources|related content|next steps|feedback|learn more)\b/i;
/** A group title that looks like page furniture rather than a skill group: reported as a warning. */
const SUSPICIOUS_GROUP =
  /^(study|practice|resources|training|certification|exam\b)/i;

const wordsOf = (text) =>
  new Set(normalizeTitle(text).split(" ").filter(Boolean));

/** Share of words two titles have in common (Jaccard), 0 to 1. */
export function overlap(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * GH-300's glance list names one domain twice ("Use GitHub Copilot features" and "GitHub Copilot
 * features", both 25-30%) and the guide has one section for it. A glance entry that has NO section of its
 * own (`taken` holds the ones that have) and whose words are a subset of another entry's with the same
 * weight is that duplicate: its index goes into the returned set, with a warning. Two entries that both
 * have a section are two domains (AB-410 has "Create a foundation for intelligent applications" and "Create
 * intelligent applications", both 25-30%).
 */
function findDuplicateDomains(named, taken, warnings) {
  const dropped = new Set();
  for (const [i, entry] of named.entries()) {
    if (taken.has(i) || !entry.weight) continue;
    const words = wordsOf(entry.title);
    for (const [j, other] of named.entries()) {
      if (
        j === i ||
        dropped.has(j) ||
        !other.weight ||
        other.weight.min !== entry.weight.min ||
        other.weight.max !== entry.weight.max
      )
        continue;
      const otherWords = wordsOf(other.title);
      if (
        otherWords.size >= words.size &&
        [...words].every((w) => otherWords.has(w))
      ) {
        dropped.add(i);
        warnings.push(
          `the skills-at-a-glance list names "${entry.title}" twice (also as "${other.title}")`,
        );
        break;
      }
    }
  }
  return dropped;
}

const slug = (text) =>
  normalizeTitle(text).replace(/ /g, "-").slice(0, 60).replace(/-+$/, "");

/**
 * Parse one guide.
 * Returns { ok, asOf, domains: [{ title, weight, headingLevel, groups: [{ title, implicit?, tasks: [{ key, text }] }] }],
 *           stats: { domains, groups, tasks }, warnings: [string] }.
 * `ok` is false when no domain was found, a domain of the glance list has no section, or a domain has
 * no task: a consumer must not use such a tree as if it were complete.
 * A group with `implicit: true` collects bullets that sit directly under a domain (title = the domain).
 * A task `key` is "<domain>/<group>/<task>" in slug form, unique within the guide.
 */
export function parseGuide(lines) {
  const warnings = [];
  const list = Array.isArray(lines) ? lines.map((l) => String(l ?? "")) : [];
  const asOf = parseAsOf(list);

  // 1. the domains named by the "Skills at a glance" list (fallback: headings that carry a weight)
  const glanceAt = list.findIndex((line) =>
    /^#{1,6}\s+skills at a glance\b/i.test(line),
  );
  let named = [];
  let scanFrom = 0;
  if (glanceAt >= 0) {
    for (let i = glanceAt + 1; i < list.length; i++) {
      if (parseHeading(list[i])) {
        scanFrom = i;
        break;
      }
      const bullet = list[i].match(/^-\s+(.*\S)\s*$/);
      if (bullet) named.push(splitWeight(bullet[1]));
      scanFrom = i + 1;
    }
  } else {
    const skillsAt = list.findIndex((line) =>
      /^#{1,6}\s+(skills measured|domains)\b/i.test(line),
    );
    scanFrom = skillsAt >= 0 ? skillsAt + 1 : 0;
    for (let i = scanFrom; i < list.length; i++) {
      const heading = parseHeading(list[i]);
      if (heading && WEIGHT_AT_END.test(heading.text))
        named.push(splitWeight(heading.text));
    }
    if (named.length > 0)
      warnings.push(
        'the guide has no "Skills at a glance" list: the domains are the headings that carry a weight',
      );
  }
  if (named.length === 0) {
    return {
      ok: false,
      asOf,
      domains: [],
      stats: { domains: 0, groups: 0, tasks: 0 },
      warnings: [
        ...warnings,
        "no domains found: the guide has neither a skills-at-a-glance list nor weighted headings",
      ],
    };
  }

  // 2. which heading starts which domain. Pass 1: the same name. Pass 2 (Microsoft words the glance bullet
  // and the heading differently now and then): an unused heading with the same weight and the most words
  // in common.
  const headings = [];
  let firstWeighted = -1;
  for (let i = scanFrom; i < list.length; i++) {
    const heading = parseHeading(list[i]);
    if (!heading) continue;
    const split = splitWeight(heading.text);
    if (firstWeighted < 0 && split.weight) firstWeighted = i;
    if (
      firstWeighted >= 0 &&
      i > firstWeighted &&
      END_OF_SKILLS.test(heading.text)
    )
      break;
    headings.push({
      line: i,
      level: heading.level,
      text: heading.text,
      ...split,
    });
  }
  const byName = new Map(named.map((d, i) => [normalizeTitle(d.title), i]));
  const domainAt = new Map(); // line -> glance index
  const taken = new Set(); // glance indexes
  for (const h of headings) {
    const index = byName.get(normalizeTitle(h.title));
    if (index !== undefined && !taken.has(index)) {
      taken.add(index);
      domainAt.set(h.line, index);
    }
  }
  const dropped = findDuplicateDomains(named, taken, warnings);
  for (const [index, d] of named.entries()) {
    if (taken.has(index) || dropped.has(index) || !d.weight) continue;
    let best = null;
    for (const h of headings) {
      if (
        domainAt.has(h.line) ||
        !h.weight ||
        h.weight.min !== d.weight.min ||
        h.weight.max !== d.weight.max
      )
        continue;
      const score = overlap(d.title, h.title);
      if (score >= 0.25 && (!best || score > best.score)) best = { h, score };
    }
    if (best) {
      taken.add(index);
      domainAt.set(best.h.line, index);
      warnings.push(
        `domain "${d.title}" (glance list) is the section "${best.h.title}": the guide words them differently`,
      );
    }
  }

  // 3. walk the skills section
  const used = taken;
  const domains = [];
  let domain = null;
  let group = null;
  for (let i = scanFrom; i < list.length; i++) {
    const heading = parseHeading(list[i]);
    if (heading) {
      if (domains.length > 0 && END_OF_SKILLS.test(heading.text)) break;
      if (domainAt.has(i)) {
        const index = domainAt.get(i);
        domain = {
          title: named[index].title,
          weight: named[index].weight,
          headingLevel: heading.level,
          groups: [],
        };
        if (
          normalizeTitle(splitWeight(heading.text).title) !==
          normalizeTitle(named[index].title)
        )
          domain.headingText = splitWeight(heading.text).title;
        domains.push(domain);
        group = null;
        continue;
      }
      if (!domain) continue; // notes and other headings before the first domain
      group = { title: heading.text, tasks: [] };
      domain.groups.push(group);
      continue;
    }
    const bullet = list[i].match(/^-\s+(.*\S)\s*$/);
    if (!bullet || !domain) continue;
    if (!group) {
      group = { title: domain.title, implicit: true, tasks: [] };
      domain.groups.push(group);
    }
    group.tasks.push({ text: squish(bullet[1]) });
  }

  // 3. keys and checks
  const seen = new Set();
  for (const d of domains) {
    for (const g of d.groups) {
      g.tasks = g.tasks.map((task) => {
        let key = `${slug(d.title)}/${slug(g.title)}/${slug(task.text)}`;
        for (let n = 2; seen.has(key); n++)
          key = `${slug(d.title)}/${slug(g.title)}/${slug(task.text)}-${n}`;
        seen.add(key);
        return { key, text: task.text };
      });
      if (SUSPICIOUS_GROUP.test(g.title) && !g.implicit)
        warnings.push(
          `group "${g.title}" in "${d.title}" looks like page furniture, not a skill group`,
        );
    }
    if (d.groups.reduce((n, g) => n + g.tasks.length, 0) === 0)
      warnings.push(`domain "${d.title}" has no tasks`);
  }
  for (const [index, d] of named.entries())
    if (!used.has(index) && !dropped.has(index))
      warnings.push(
        `domain "${d.title}" is in the skills-at-a-glance list but has no section`,
      );
  const levels = new Set(domains.map((d) => d.headingLevel));
  if (levels.size > 1)
    warnings.push(
      `the domain headings use different levels (${[...levels].sort().join(", ")}): the guide's headings are irregular`,
    );
  const weightless = domains.filter((d) => !d.weight).length;
  if (weightless > 0) warnings.push(`${weightless} domain(s) carry no weight`);

  const stats = {
    domains: domains.length,
    groups: domains.reduce((n, d) => n + d.groups.length, 0),
    tasks: domains.reduce(
      (n, d) => n + d.groups.reduce((m, g) => m + g.tasks.length, 0),
      0,
    ),
  };
  const ok =
    domains.length > 0 &&
    used.size === named.length - dropped.size &&
    domains.every((d) => d.groups.some((g) => g.tasks.length > 0));
  return { ok, asOf, domains, stats, warnings };
}

// ---------------------------------------------------------------------------------------------
// comparing two trees
// ---------------------------------------------------------------------------------------------

const textOf = (task) => (typeof task === "string" ? task : task.text);

/**
 * Compare an expected tree (the guide) with an actual one (a course): both { domains: [{ title,
 * groups: [{ title, tasks: [string | { text }] }] }] }. Matching is by title (whitespace, quote and dash
 * variants ignored, case kept), level by level, so one inserted task is one difference, not a cascade.
 * Returns { identical, differences: [{ kind, at, expected?, actual? }] } with kind in
 * missing-domain, extra-domain, missing-group, extra-group, missing-task, extra-task,
 * reordered-domains, reordered-groups, reordered-tasks.
 */
export function diffTrees(expected, actual) {
  const differences = [];
  const compareLevel = (
    kindName,
    expectedItems,
    actualItems,
    titleOf,
    at,
    recurse,
  ) => {
    const actualByTitle = new Map(
      actualItems.map((item) => [squish(titleOf(item)), item]),
    );
    const expectedTitles = new Set(
      expectedItems.map((item) => squish(titleOf(item))),
    );
    for (const item of expectedItems) {
      const title = squish(titleOf(item));
      const other = actualByTitle.get(title);
      if (!other)
        differences.push({
          kind: `missing-${kindName}`,
          at: [...at, title],
          expected: title,
        });
      else recurse?.(item, other, [...at, title]);
    }
    for (const item of actualItems) {
      const title = squish(titleOf(item));
      if (!expectedTitles.has(title))
        differences.push({
          kind: `extra-${kindName}`,
          at: [...at, title],
          actual: title,
        });
    }
    const common = (items, otherTitles) =>
      items
        .map((item) => squish(titleOf(item)))
        .filter((t) => otherTitles.has(t));
    const a = common(expectedItems, new Set(actualByTitle.keys()));
    const b = common(actualItems, expectedTitles);
    if (a.length === b.length && a.some((t, i) => t !== b[i]))
      differences.push({ kind: `reordered-${kindName}s`, at });
  };
  compareLevel(
    "domain",
    expected.domains,
    actual.domains,
    (d) => d.title,
    [],
    (ed, ad, at) =>
      compareLevel(
        "group",
        ed.groups,
        ad.groups,
        (g) => g.title,
        at,
        (eg, ag, at2) =>
          compareLevel("task", eg.tasks, ag.tasks, textOf, at2, null),
      ),
  );
  return { identical: differences.length === 0, differences };
}

/**
 * The tree of a course page written like the AZ-104 test course: `##` domain (weight in the title),
 * `###` skill group, `####` task. Headings before the first weighted domain ("Audience profile" and
 * its sub-headings) are ignored. Returns { domains } in the shape diffTrees reads.
 */
export function treeFromCourseMdx(mdx) {
  const domains = [];
  let domain = null;
  let group = null;
  let inCode = false;
  for (const raw of String(mdx ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    if (/^```/.test(raw)) inCode = !inCode;
    if (inCode) continue;
    const parsedHeading = parseHeading(raw);
    if (!parsedHeading) continue;
    // the renderer escapes { } < > so MDX does not read them as code; undo it
    const heading = {
      level: parsedHeading.level,
      text: parsedHeading.text.replace(/\\([{}<>])/g, "$1"),
    };
    if (heading.level === 2) {
      const { title, weight } = splitWeight(heading.text);
      domain = weight ? { title, weight, groups: [] } : null;
      if (domain) domains.push(domain);
      group = null;
    } else if (heading.level === 3 && domain) {
      group = { title: heading.text, tasks: [] };
      domain.groups.push(group);
    } else if (heading.level === 4 && group) {
      group.tasks.push({ text: heading.text });
    }
  }
  return { domains };
}
