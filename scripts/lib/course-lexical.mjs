/**
 * A small lexical search for the candidate generator (docs/course-candidates.md): a tokenizer with a light
 * stemmer, query terms that weigh the study guide's action verbs down, and a BM25 inverted index over
 * weighted fields. Pure: no I/O, no network, deterministic (ties are broken by id).
 *
 * It only shortlists. It does not know what a good answer is; it knows which titles and descriptions share the
 * words of a task, how rare those words are, and how much of the task a page covers.
 */

import { ALIASES } from "./course-aliases.mjs";

/** Words that carry no topic. */
export const STOPWORDS = new Set(
  (
    "a an and are as at be been by can do does for from has have how if in into is it its of on or " +
    "that the their them then there these this those to up via was were what when where which while " +
    "who why will with within without your you using use used between across about also any each " +
    "other such than too very per not no different various multiple existing new appropriate specific " +
    "common basic"
  ).split(" "),
);

/**
 * The verbs a study guide task starts with. They say what to do, not what the topic is, so a query keeps them
 * at a low weight: "Configure user-defined routes" must not prefer a page just because it says "configure".
 */
export const GENERIC_WORDS = new Set(
  (
    "configure manage implement create deploy design plan perform identify determine evaluate describe " +
    "explain select choose build administer provision set enable apply resolve define recommend " +
    "understand work working"
  ).split(" "),
);

export const GENERIC_WEIGHT = 0.25;

/** A light stemmer: plural, -ing, -ed and a trailing e, applied to query and documents alike. */
export function stem(word) {
  let w = word;
  if (w.length <= 3 || /^\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(x|ch|sh|z)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (/[^su]s$/.test(w) && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** The lower-case alphanumeric words of a text, in order ("user-defined" is two words). */
export function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Abbreviations and their long forms (course-aliases.mjs) are one concept: both a task and a page that says
// either gets the concept token "@rbac", and the search matches on it.
const conceptOfWord = new Map();
const phrasesByFirstStem = new Map();
for (const alias of ALIASES) {
  for (const word of alias.words) conceptOfWord.set(word, alias.concept);
  for (const phrase of alias.phrases) {
    const stems = words(phrase)
      .filter((w) => !STOPWORDS.has(w))
      .map(stem);
    const list = phrasesByFirstStem.get(stems[0]) ?? [];
    list.push({ stems, concept: alias.concept });
    phrasesByFirstStem.set(stems[0], list);
  }
}

/**
 * The long form of an alias starting at `at` in a list of stems: { concept, length } or null.
 */
function phraseAt(stems, at) {
  for (const p of phrasesByFirstStem.get(stems[at]) ?? [])
    if (p.stems.every((s, i) => stems[at + i] === s))
      return { concept: p.concept, length: p.stems.length };
  return null;
}

/** The concepts a text mentions, by abbreviation or by long form, in order of appearance, without repeats. */
function conceptsOf(rawWords, stems) {
  const found = [];
  for (const w of rawWords)
    if (conceptOfWord.has(w)) found.push(conceptOfWord.get(w));
  for (let i = 0; i < stems.length; i++) {
    const hit = phraseAt(stems, i);
    if (hit) found.push(hit.concept);
  }
  return [...new Set(found)];
}

/**
 * The stemmed content words of a text (stopwords removed), in order: the sequence a phrase is matched on,
 * followed by the concept tokens of the abbreviations and long forms the text mentions.
 */
export function contentStems(text) {
  const raw = words(text);
  const stems = raw.filter((w) => !STOPWORDS.has(w)).map(stem);
  const concepts = conceptsOf(raw, stems);
  return concepts.length ? [...stems, ...concepts.map((c) => `@${c}`)] : stems;
}

/**
 * Query terms of a task. `context` (the skill group's title) adds terms at a lower weight; they only help to
 * tell apart tasks that are vague on their own ("Configure access").
 * Returns { terms: [{ term, word, weight, context? }], bigrams: [[a, b]] } where `term` is the stem, `word` the word as
 * written and `bigrams` the neighbouring non-generic terms of the task itself.
 */
export function queryTerms(text, { context = "", contextWeight = 0.4 } = {}) {
  const items = [];
  for (const word of words(text)) {
    if (STOPWORDS.has(word)) continue;
    const abbreviation = conceptOfWord.get(word);
    items.push({
      word,
      term: abbreviation ? `@${abbreviation}` : stem(word),
      weight: GENERIC_WORDS.has(word) ? GENERIC_WEIGHT : 1,
    });
  }
  // A long form ("role based access control") keeps its words, so a page with some of them still counts, and
  // gains the concept term its abbreviation has; the words and the concept are one group, and a page that has
  // the concept covers the whole group.
  const stems = items.map((item) => item.term);
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    const hit = phraseAt(stems, i);
    if (!hit) continue;
    groups.push({
      id: `g${groups.length}`,
      concept: hit.concept,
      from: i,
      length: hit.length,
    });
    i += hit.length - 1;
  }
  const byTerm = new Map();
  const put = (entry) => {
    const known = byTerm.get(entry.term);
    if (!known || known.weight < entry.weight) byTerm.set(entry.term, entry);
  };
  const sequence = [];
  items.forEach((item, i) => {
    const group = groups.find((g) => i >= g.from && i < g.from + g.length);
    sequence.push({ term: item.term, generic: item.weight < 1 });
    put({
      term: item.term,
      word: item.word,
      weight: item.weight,
      ...(item.weight < 1 ? { generic: true } : {}),
      ...(group ? { group: group.id, role: "part" } : {}),
    });
  });
  for (const g of groups)
    put({
      term: `@${g.concept}`,
      word: items
        .slice(g.from, g.from + g.length)
        .map((item) => item.word)
        .join(" "),
      weight: 1,
      group: g.id,
      role: "concept",
    });
  for (const word of words(context)) {
    if (STOPWORDS.has(word) || GENERIC_WORDS.has(word)) continue;
    const term = stem(word);
    if (!byTerm.has(term))
      byTerm.set(term, { term, word, weight: contextWeight, context: true });
  }
  const bigrams = [];
  for (let i = 0; i + 1 < sequence.length; i++) {
    if (sequence[i].generic || sequence[i + 1].generic) continue;
    if (sequence[i].term === sequence[i + 1].term) continue;
    bigrams.push([sequence[i].term, sequence[i + 1].term]);
  }
  return { terms: [...byTerm.values()], bigrams };
}

const hasBigram = (seq, a, b) => {
  for (let i = 0; i + 1 < seq.length; i++)
    if (seq[i] === a && seq[i + 1] === b) return true;
  return false;
};

const sumValues = (map) => [...map.values()].reduce((a, b) => a + b, 0);

/** BM25 over fields with weights; documents are added once, then `finalize()`, then `search()`. */
export class LexicalIndex {
  constructor({ k1 = 1.2, b = 0.75, phraseBonus = 1.5 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.phraseBonus = phraseBonus;
    this.ids = [];
    this.lengths = [];
    this.sequences = [];
    this.postings = new Map();
    this.avgLength = 0;
    this.sealed = false;
  }

  get size() {
    return this.ids.length;
  }

  /**
   * Add one document. `fields` is a list of { text, weight, phrase? }: a term found in a field counts `weight`
   * times per occurrence; the (first) field marked `phrase` is kept as a word sequence for phrase matching.
   */
  add(id, fields) {
    if (this.sealed) throw new Error("the index is finalized");
    const index = this.ids.length;
    const tf = new Map();
    let length = 0;
    let sequence = null;
    for (const field of fields) {
      if (!field.text) continue;
      const stems = contentStems(field.text);
      if (field.phrase && sequence === null) sequence = stems;
      for (const term of stems) {
        tf.set(term, (tf.get(term) ?? 0) + field.weight);
        length += field.weight;
      }
    }
    this.ids.push(id);
    this.lengths.push(length);
    this.sequences.push(sequence ?? []);
    for (const [term, count] of tf) {
      let list = this.postings.get(term);
      if (!list) this.postings.set(term, (list = []));
      list.push(index, count);
    }
  }

  finalize() {
    const n = this.ids.length;
    this.avgLength = n ? this.lengths.reduce((a, b) => a + b, 0) / n : 0;
    this.sealed = true;
    return this;
  }

  idf(term) {
    const df = (this.postings.get(term)?.length ?? 0) / 2;
    return Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
  }

  /**
   * Search. `query` comes from `queryTerms`. Options:
   *   include(id)   silent pre-filter: ids it rejects are not candidates at all (membership of a pool)
   *   classify(id)  null to keep, or the REASON a hard filter drops the page; dropped pages are counted
   *   minCoverage   share of the task's own terms (each weighed by its rarity in this index; the skill group's
   *                 context terms do not count) a page must contain (0..1)
   *   limit         how many pages to keep
   *   scan          how many ranked pages to examine at most
   * Returns { hits: [{ id, score, coverage, matched: [word] }], dropped: Map(reason -> { count, samples }), examined }.
   */
  search(
    query,
    {
      include = null,
      classify = null,
      minCoverage = 0,
      limit = 10,
      scan = 3000,
    } = {},
  ) {
    if (!this.sealed) throw new Error("finalize() the index before searching");
    const scores = new Map();
    const matched = new Map();
    // coverage weighs a term by its rarity: a page that has the distinctive word of a task covers more of it
    // than a page that only has "users". A word no page of this index has still counts (and is the rarest of
    // all): when nothing has the task's distinctive word, nothing covers the task.
    let totalWeight = 0;
    const groupWeight = new Map(); // alias group -> the weight of its words
    for (const q of query.terms) {
      const list = this.postings.get(q.term);
      const idf = this.idf(q.term);
      const weight = q.weight * idf;
      if (!q.context && !q.generic) {
        if (!q.group) totalWeight += weight;
        else if (q.role === "part")
          groupWeight.set(q.group, (groupWeight.get(q.group) ?? 0) + weight);
      }
      if (!list) continue;
      for (let i = 0; i < list.length; i += 2) {
        const doc = list[i];
        if (include && !include(this.ids[doc])) continue;
        const tf = list[i + 1];
        const norm =
          1 - this.b + (this.b * this.lengths[doc]) / (this.avgLength || 1);
        const part = weight * ((tf * (this.k1 + 1)) / (tf + this.k1 * norm));
        scores.set(doc, (scores.get(doc) ?? 0) + part);
        let m = matched.get(doc);
        if (!m) matched.set(doc, (m = []));
        m.push({
          word: q.word,
          weight: q.context ? 0 : weight,
          context: !!q.context,
          generic: !!q.generic,
          group: q.group,
          role: q.role,
        });
      }
    }
    const ranked = [];
    for (const [doc, base] of scores) {
      const m = matched.get(doc);
      // a verb ("configure") can only add to a page's coverage, never take from it: titles rarely say it
      let generic = 0;
      let covered = 0;
      const partsOf = new Map();
      const conceptOf = new Set();
      for (const x of m) {
        if (x.context) continue;
        if (x.generic) generic += x.weight;
        else if (!x.group) covered += x.weight;
        else if (x.role === "concept") conceptOf.add(x.group);
        else partsOf.set(x.group, (partsOf.get(x.group) ?? 0) + x.weight);
      }
      // an alias group is covered whole by its concept (the abbreviation or the long form), else by its words
      for (const [id, whole] of groupWeight)
        covered += conceptOf.has(id) ? whole : (partsOf.get(id) ?? 0);
      const denominator = totalWeight + sumValues(groupWeight);
      const coverage = denominator
        ? (covered + generic) / (denominator + generic)
        : 0;
      if (coverage < minCoverage) continue;
      // a page that only shares a verb ("configure") or the group's words says nothing about the task
      if (!m.some((x) => !x.context && !x.generic)) continue;
      let score = base;
      const seq = this.sequences[doc];
      for (const [a, b] of query.bigrams)
        if (hasBigram(seq, a, b))
          score += this.phraseBonus * 0.5 * (this.idf(a) + this.idf(b));
      ranked.push({
        id: this.ids[doc],
        score,
        coverage,
        matched: m
          .filter(
            (x) => !x.context && !(x.role === "part" && conceptOf.has(x.group)),
          )
          .map((x) => x.word),
      });
    }
    ranked.sort(
      (x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    const hits = [];
    const dropped = new Map();
    let examined = 0;
    for (const hit of ranked) {
      if (hits.length >= limit || examined >= scan) break;
      examined++;
      const reason = classify ? classify(hit.id, hit) : null;
      if (reason) {
        const entry = dropped.get(reason) ?? { count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 3) entry.samples.push(hit);
        dropped.set(reason, entry);
        continue;
      }
      hits.push(hit);
    }
    return { hits, dropped, examined };
  }
}
