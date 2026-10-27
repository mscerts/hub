/**
 * The audience profile of a course (docs/course-audience.md): what an exam's study guide says a candidate should
 * already know or have done ("You should be familiar with: operating systems, networking ...", "In addition, you
 * should have experience with: PowerShell, Azure CLI ..."). The process only PROPOSES resources for these concepts;
 * the maintainer decides, concept by concept, which resource serves it best, and may add a page of any site (a
 * networking course the maintainer picked on another vendor's site, say). Nothing here is accepted automatically.
 *
 * Pure logic (no I/O, no network): the parser of the guide's audience section, the concept keys, the decisions file
 * and its checks, the proposal prompt and the review sheet. The command line is scripts/course-audience.mjs.
 */

import { parseAudience, squish } from "./course-guide.mjs";

export { parseAudience };

export const AUDIENCE_SCHEMA_VERSION = 1;
export const AUDIENCE_DECISIONS_KIND = "audience-decisions";
export const AUDIENCE_OPTIONS_KIND = "audience-options";
export const PICK_SOURCES = Object.freeze(["option", "maintainer"]);
export const PICK_KINDS = Object.freeze(["learn", "external"]);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const present = (v) => typeof v === "string" && v.trim() !== "";

/** A lower-case, hyphenated form for keys. */
export function slug(text, max = 60) {
  return squish(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/**
 * The concepts that need a resource: every item of a prerequisite list, in the guide's order, with a key that
 * stays the same while the wording does (`audience/<lead>/<item>`), the list it belongs to and its number.
 */
export function audienceConcepts(audience) {
  const out = [];
  const leads = new Map();
  (audience?.lists ?? []).forEach((l, index) => {
    if (l.kind !== "prerequisite") return;
    let lead = slug(l.lead || `list-${index + 1}`, 40);
    const seen = leads.get(lead) ?? 0;
    leads.set(lead, seen + 1);
    if (seen > 0) lead = `${lead}-${seen + 1}`;
    for (const text of l.items)
      out.push({ key: `audience/${lead}/${slug(text)}`, text, list: index });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The maintainer's decisions
// ---------------------------------------------------------------------------
/** An empty decisions file. */
export function emptyDecisions(code) {
  return {
    schemaVersion: AUDIENCE_SCHEMA_VERSION,
    kind: AUDIENCE_DECISIONS_KIND,
    code,
    concepts: [],
  };
}

/** Where a pick points: a Learn page by its path (kind "learn") or any https address (kind "external"). */
export function hostOf(href) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The pick for an address the maintainer gives: a learn.microsoft.com address is a Learn pick, any other an external one. */
export function pickFromUrl({ url, title, why = null, today }) {
  const host = hostOf(url);
  if (!host) throw new Error(`${url} is not an https address`);
  const learn = host === "learn.microsoft.com";
  const pick = {
    title: squish(title),
    href: url,
    kind: learn ? "learn" : "external",
    source: "maintainer",
    decidedAt: today,
  };
  if (learn) pick.path = new URL(url).pathname.replace(/^\/en-us/i, "");
  if (why) pick.why = squish(why);
  return pick;
}

/** The pick for an option the process proposed (a candidate of the options file). */
export function pickFromOption(option, { title = null, today }) {
  const path = option.target.path;
  return {
    title: squish(title ?? option.title),
    href: `https://learn.microsoft.com${path}`,
    kind: "learn",
    path,
    source: "option",
    decidedAt: today,
  };
}

/** Sets the picks of a concept (an empty list is the decision that the concept needs no resource). */
export function setConcept(decisions, concept, picks) {
  const concepts = decisions.concepts.filter((c) => c.key !== concept.key);
  concepts.push({ key: concept.key, text: concept.text, picks });
  concepts.sort((a, b) => byText(a.key, b.key));
  return { ...decisions, concepts };
}

/** The decisions file removes a concept again (the maintainer changed their mind). */
export function clearConcept(decisions, concept) {
  return {
    ...decisions,
    concepts: decisions.concepts.filter((c) => c.key !== concept.key),
  };
}

/** The problems of a single pick (a list of texts). */
export function pickProblems(pick) {
  const problems = [];
  if (!present(pick?.title)) problems.push("a pick needs a title");
  const host = hostOf(pick?.href);
  if (!host) problems.push(`${pick?.href ?? "?"} is not an https address`);
  if (!PICK_KINDS.includes(pick?.kind))
    problems.push(`kind must be ${PICK_KINDS.join(" or ")}`);
  else if (host && (pick.kind === "learn") !== (host === "learn.microsoft.com"))
    problems.push(
      `${pick.href}: a learn pick is on learn.microsoft.com and an external one is not`,
    );
  if (pick?.kind === "learn") {
    const path = pick.path;
    if (!present(path) || !path.startsWith("/") || /\/en-us\//i.test(path))
      problems.push(
        `${pick.href}: a learn pick needs its path without a locale`,
      );
    else if (
      host &&
      new URL(pick.href).pathname.replace(/^\/en-us/i, "") !== path
    )
      problems.push(`${pick.href}: the path does not match the address`);
  }
  if (!PICK_SOURCES.includes(pick?.source))
    problems.push(`source must be ${PICK_SOURCES.join(" or ")}`);
  if (!isDay(pick?.decidedAt)) problems.push("decidedAt must be YYYY-MM-DD");
  return problems;
}

/**
 * The problems of a decisions file against the guide's audience: the right kind and code, every concept a concept
 * of the guide, no pick that fails `pickProblems`. A concept the guide dropped is a warning (the guide changed).
 */
export function decisionsProblems(file, { code, audience }) {
  const problems = [];
  const warnings = [];
  if (!file || typeof file !== "object")
    return { problems: ["the decisions are not a JSON object"], warnings };
  if (file.kind !== AUDIENCE_DECISIONS_KIND)
    problems.push(`kind must be "${AUDIENCE_DECISIONS_KIND}"`);
  if (file.schemaVersion !== AUDIENCE_SCHEMA_VERSION)
    problems.push(`schemaVersion must be ${AUDIENCE_SCHEMA_VERSION}`);
  if (code && file.code !== code)
    problems.push(`the decisions are for ${file.code}, not ${code}`);
  if (!Array.isArray(file.concepts)) {
    problems.push("concepts must be a list");
    return { problems, warnings };
  }
  const known = new Map(audienceConcepts(audience).map((c) => [c.key, c]));
  const seen = new Set();
  for (const c of file.concepts) {
    if (!present(c?.key) || !present(c?.text)) {
      problems.push(`a concept needs key and text: ${JSON.stringify(c)}`);
      continue;
    }
    if (seen.has(c.key)) problems.push(`${c.key} is decided twice`);
    seen.add(c.key);
    if (audience && !known.has(c.key))
      warnings.push(`${c.key} is no longer a concept of the study guide`);
    else if (known.has(c.key) && known.get(c.key).text !== c.text)
      warnings.push(
        `${c.key}: the guide now says "${known.get(c.key).text}", the decision was made for "${c.text}"`,
      );
    if (!Array.isArray(c.picks)) {
      problems.push(`${c.key}: picks must be a list`);
      continue;
    }
    const hrefs = new Set();
    for (const pick of c.picks) {
      for (const p of pickProblems(pick)) problems.push(`${c.key}: ${p}`);
      if (hrefs.has(pick?.href))
        problems.push(`${c.key}: ${pick.href} appears twice`);
      hrefs.add(pick?.href);
    }
  }
  return { problems, warnings };
}

/**
 * The audience profile of a course file: the guide's audience with the maintainer's picks. A concept without a
 * decision has no `picks` (the page then lists it as text); a concept decided to need no resource has an empty list.
 * `decisions` may be null (nothing decided yet).
 */
export function buildAudience(audience, decisions) {
  if (!audience) return null;
  const decided = new Map((decisions?.concepts ?? []).map((c) => [c.key, c]));
  const keys = new Map(
    audienceConcepts(audience).map((c) => [`${c.list}|${c.text}`, c.key]),
  );
  return {
    intro: [...audience.intro],
    lists: audience.lists.map((l, index) => ({
      ...(l.lead ? { lead: l.lead } : {}),
      kind: l.kind,
      items: l.items.map((text) => {
        if (l.kind !== "prerequisite") return { text };
        const key = keys.get(`${index}|${text}`);
        const d = decided.get(key);
        return {
          key,
          text,
          ...(d ? { picks: d.picks.map((p) => ({ ...p })) } : {}),
        };
      }),
    })),
  };
}

/** The concepts of a built audience, in order: `{ key, text, picks }` (picks undefined while undecided). */
export function eachConcept(audience) {
  return (audience?.lists ?? [])
    .filter((l) => l.kind === "prerequisite")
    .flatMap((l) => l.items);
}

/** The problems of the audience of a course file, against the guide's when it is given. */
export function audienceProblems(audience, { guideAudience = null } = {}) {
  const errors = [];
  const warnings = [];
  if (audience === undefined || audience === null) return { errors, warnings };
  if (!Array.isArray(audience.intro) || !Array.isArray(audience.lists))
    return {
      errors: ["audience needs an intro list and a list of lists"],
      warnings,
    };
  for (const l of audience.lists) {
    if (
      !["prerequisite", "role"].includes(l?.kind) ||
      !Array.isArray(l.items)
    ) {
      errors.push(`an audience list needs a kind and items: ${l?.lead ?? "?"}`);
      continue;
    }
    for (const item of l.items) {
      if (!present(item?.text)) errors.push("an audience item needs text");
      if (l.kind === "prerequisite" && !present(item?.key))
        errors.push(`${item?.text}: a concept needs a key`);
      for (const pick of item?.picks ?? [])
        for (const p of pickProblems(pick)) errors.push(`${item.text}: ${p}`);
    }
  }
  if (guideAudience) {
    const text = (a) =>
      JSON.stringify([
        a.intro,
        a.lists.map((l) => [
          l.kind,
          l.lead ?? null,
          l.items.map((i) => i.text ?? i),
        ]),
      ]);
    if (text(audience) !== text(guideAudience))
      errors.push(
        "the audience profile differs from the study guide's: the guide changed since the course was built",
      );
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// The proposal prompt: one batch per list of concepts
// ---------------------------------------------------------------------------
/**
 * One batch per prerequisite list: `{ schemaVersion, kind: "propose", batchId, exam, inputs, group, tasks }`, in the
 * shape of the proposals of the tasks (course-propose.mjs), so that its checks and its merge are used unchanged.
 */
export function audienceBatches({
  concepts,
  audience,
  exam,
  guideHash = null,
}) {
  const byList = new Map();
  for (const c of concepts) {
    const list = byList.get(c.list) ?? [];
    list.push({ key: c.key, text: c.text });
    byList.set(c.list, list);
  }
  return [...byList].map(([index, tasks]) => ({
    schemaVersion: 1,
    kind: "propose",
    batchId: tasks[0].key.split("/").slice(0, 2).join("/"),
    exam,
    inputs: { guideHash },
    group: {
      domain: "Audience profile",
      title: audience.lists[index].lead ?? "Prerequisites",
    },
    tasks,
  }));
}

export function audiencePrompt(batch) {
  const lines = batch.tasks.map((t) => `- \`${t.key}\`: ${t.text}`).join("\n");
  return `# Which Microsoft Learn pages cover these prerequisites?

You are helping to build a study course for the Microsoft exam **${batch.exam.code}${batch.exam.name ? `: ${batch.exam.name}` : ""}**. Its study guide says a candidate **${batch.group.title}** the items below. For each item, name the pages on Microsoft Learn (learn.microsoft.com) that a person who lacks this background could read to catch up.

## Items

${lines}

## What to name

- **Documentation articles** (concept, overview, how-to, tutorial) at their address after the host, for example \`/windows-server/virtualization/hyper-v/overview\`.
- **Training modules** at \`/training/modules/<module-name>\`.
- Nothing else: no learning paths, courses, videos, exams or pages of other sites. A person adds resources from other sites by hand.

## Rules

1. **Answer from what you know.** Do not open files, browse or search; nothing but this prompt is available to you.
2. **Offer a choice.** A person will pick the page that serves the item best, so name the two to five pages you consider the best candidates, from an overview to a hands-on introduction, and say what each gives. An item Learn covers badly gets an empty list.
3. Prefer a page that teaches the item to a beginner over a reference page or a landing page, and over a page about one product's feature when a general introduction exists.
4. **Write the address exactly as you remember it.** If you are not sure of it, still give your best guess and the exact title of the page: a script looks the page up and drops what does not exist.
5. \`why\` is at most 15 words and says what the page gives for the item.
6. Answer for **every item** above, using its key.

## Answer

Reply with one JSON object and nothing else; save it as the file you were told to. The format:

\`\`\`json
{
  "schemaVersion": 1,
  "kind": "proposals",
  "batchId": ${JSON.stringify(batch.batchId)},
  "proposedBy": "<the model or session that answered>",
  "tasks": [
    { "task": "<item key>", "pages": [ { "path": "/windows-server/virtualization/hyper-v/overview", "title": "Hyper-V on Windows Server", "why": "at most 15 words: what the page gives" } ] }
  ]
}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// The review sheet
// ---------------------------------------------------------------------------
const SOURCE_TEXT = {
  P1: "the exam's own course",
  P2: "listed by the exam's course",
  P3: "another exam's course",
  P4: "found by search",
  P5: "named by a model",
};

/**
 * The options of a concept in the order the sheet numbers them: the pages a model named first (the search finds
 * words, a model knows what teaches a beginner the topic), then the search results by how well they match.
 */
export function optionsInOrder(candidates) {
  const proposed = (c) => c.source === "P5" || c.alsoProposed === true;
  return [
    ...candidates.filter(proposed),
    ...candidates.filter((c) => !proposed(c)),
  ];
}

/**
 * The sheet the maintainer reads: every concept with its numbered options and what is decided so far. The
 * numbers are the ones `choose` takes.
 */
export function renderSheet({ code, audience, options, decisions }) {
  const decided = new Map((decisions?.concepts ?? []).map((c) => [c.key, c]));
  const optionsOf = new Map((options?.concepts ?? []).map((c) => [c.key, c]));
  const out = [
    `# ${code} audience profile: resources to decide`,
    "",
    ...(audience?.intro ?? []).flatMap((p) => [p, ""]),
    "Pick the resource that serves each concept best. `node scripts/course-audience.mjs choose <CODE> <concept number> <option numbers>` takes options from this sheet, `add` takes any address (another vendor's course, say), `none` records that a concept needs no resource. Nothing is chosen for you.",
    "",
  ];
  const concepts = audienceConcepts(audience);
  concepts.forEach((c, i) => {
    const d = decided.get(c.key);
    out.push(
      `## ${i + 1}. ${c.text}`,
      "",
      `*${audience.lists[c.list].lead ?? "Prerequisites"}*`,
      "",
    );
    if (d)
      out.push(
        d.picks.length
          ? `**Decided:** ${d.picks.map((p) => `[${p.title}](${p.href})${p.kind === "external" ? " (other site)" : ""}`).join("; ")}`
          : "**Decided:** needs no resource",
        "",
      );
    else out.push("**Not decided yet.**", "");
    const found = optionsInOrder(optionsOf.get(c.key)?.candidates ?? []);
    if (found.length === 0) out.push("No options were proposed.", "");
    found.forEach((o, n) => {
      const where = o.target.kind === "module" ? "module" : "docs";
      out.push(
        `${n + 1}. [${o.title}](https://learn.microsoft.com${o.target.path}) (${where}, ${SOURCE_TEXT[o.source] ?? o.source}${o.alsoProposed ? ", also named by a model" : ""})${o.proposal?.why ? `: ${o.proposal.why}` : ""}`,
      );
    });
    out.push("");
  });
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
