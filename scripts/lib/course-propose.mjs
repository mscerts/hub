/**
 * Model proposals (docs/course-proposals.md): a model names, from its own knowledge, the Microsoft Learn pages a
 * student of an exam should read for each task of the study guide; a script checks that every named page exists
 * (following Learn's moves, and looking a page up by its title when the address is wrong) and adds the ones that
 * exist to the shortlist of the candidate generator as a fifth source, P5. A word search can only find a page that
 * shares words with the task in its title, description and address; a model knows pages that do not. Pure: no I/O,
 * no network, no AI. The command line is scripts/course-propose.mjs.
 *
 * What a proposal proves is that the page exists, nothing more: the judge and the skeptic decide whether it belongs,
 * exactly as for a page the word search found.
 */

import { hardFilter, docFamily } from "./course-candidates.mjs";
import { queryTerms } from "./course-lexical.mjs";
import { learnPath } from "./course-scope.mjs";

export const PROPOSE_SCHEMA_VERSION = 1;
export const MAX_WHY_CHARS = 200;
const MAX_REDIRECT_HOPS = 5;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Learn areas that are not documentation pages (the same list the generator uses for "a docs pick").
const NOT_DOCS =
  /^\/(training|credentials|shows|answers|events|users|collections|community|assessments)(\/|$)/;

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------
/**
 * One batch per skill group of the guide: { schemaVersion, kind: "propose", batchId, exam, inputs, group, tasks }.
 * `tasks` are the guide's tasks (flattenTasks: key, text, domain, group); only the keys and the wording go to the
 * model, never what the candidate generator found, so that a proposal is independent of the word search.
 */
export function buildProposalBatches({ tasks, exam, guideHash = null }) {
  const groups = new Map();
  for (const task of tasks) {
    const groupId = task.key.split("/").slice(0, 2).join("/");
    if (!groups.has(groupId))
      groups.set(groupId, {
        domain: task.domain,
        title: task.group,
        tasks: [],
      });
    groups.get(groupId).tasks.push({ key: task.key, text: task.text });
  }
  return [...groups].map(([groupId, group]) => ({
    schemaVersion: PROPOSE_SCHEMA_VERSION,
    kind: "propose",
    batchId: groupId,
    exam,
    inputs: { guideHash },
    group: { domain: group.domain, title: group.title },
    tasks: group.tasks,
  }));
}

const answerShape = (batchId) => `{
  "schemaVersion": ${PROPOSE_SCHEMA_VERSION},
  "kind": "proposals",
  "batchId": ${JSON.stringify(batchId)},
  "proposedBy": "<the model or session that answered>",
  "tasks": [
    {
      "task": "<task key>",
      "pages": [
        { "path": "/power-bi/fundamentals/power-bi-overview", "title": "What is Power BI?", "why": "at most 15 words: what the page gives for this task" }
      ]
    }
  ]
}`;

export function proposalPrompt(batch) {
  const taskLines = batch.tasks
    .map((t) => `- \`${t.key}\`: ${t.text}`)
    .join("\n");
  return `# Which Microsoft Learn pages teach these tasks?

You are helping to build a study course for the Microsoft exam **${batch.exam.code}${batch.exam.name ? `: ${batch.exam.name}` : ""}**. The official study guide lists the tasks below for the skill group **${batch.group.title}** (domain: ${batch.group.domain}). For each task, name the pages on Microsoft Learn (learn.microsoft.com) that a person preparing for the exam should read or work through to learn it.

## Tasks

${taskLines}

## What to name

- **Documentation articles** (how-to, concept, tutorial, quickstart, reference where it teaches) at their address after the host, for example \`/power-bi/fundamentals/power-bi-overview\`.
- **Training modules** at \`/training/modules/<module-name>\`.
- Nothing else: no learning paths, courses, videos, exams or pages of other sites.

## Rules

1. **Answer from what you know.** Do not open files, browse or search; nothing but this prompt is available to you.
2. **There is no limit and no minimum.** Name every page you believe genuinely helps with the task, however many; a task taught by one good page gets one. Do not pad with pages that only mention the topic, and do not skip a good page because the task already has others.
3. Prefer the page that teaches or shows how to do the task over a landing page, and include a service overview when it is the right introduction to the task.
4. **Write the address exactly as you remember it.** If you are not sure of it, still give your best guess and the exact title of the page: a script looks the page up (it follows Learn's moves and falls back to the title) and drops what does not exist, so a wrong guess costs nothing and a missing page is lost.
5. \`why\` is at most 15 words and says what the page gives for the task.
6. Answer for **every task** above, using its key. A task you cannot name a page for gets an empty list.

## Answer

Reply with one JSON object and nothing else; save it as the file you were told to. The format:

\`\`\`json
${answerShape(batch.batchId)}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Checking an answer (no lookup of the pages yet)
// ---------------------------------------------------------------------------
const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Validates a proposals file against its batch. Returns { problems: [text], tasks: Map(taskKey -> [page]) }.
 * A page is { path, title, why }; a task the file leaves out has no entry (it is not an error: the model may
 * know nothing for it).
 */
export function validateProposals(batch, file) {
  const problems = [];
  const tasks = new Map();
  if (!file || typeof file !== "object") {
    return { problems: ["the answer is not a JSON object"], tasks };
  }
  if (file.kind !== "proposals") problems.push('kind must be "proposals"');
  if (file.schemaVersion !== PROPOSE_SCHEMA_VERSION)
    problems.push(`schemaVersion must be ${PROPOSE_SCHEMA_VERSION}`);
  if (file.batchId !== batch.batchId)
    problems.push(`batchId must be "${batch.batchId}", not "${file.batchId}"`);
  if (!Array.isArray(file.tasks)) {
    problems.push("tasks must be a list");
    return { problems, tasks };
  }
  const known = new Set(batch.tasks.map((t) => t.key));
  for (const entry of file.tasks) {
    const key = entry?.task;
    if (!known.has(key)) {
      problems.push(`"${key}" is not a task of this batch`);
      continue;
    }
    if (tasks.has(key)) {
      problems.push(`task "${key}" is answered twice`);
      continue;
    }
    if (!Array.isArray(entry.pages)) {
      problems.push(`task "${key}": pages must be a list`);
      continue;
    }
    const pages = [];
    entry.pages.forEach((page, i) => {
      const where = `task "${key}", page ${i + 1}`;
      if (!page || typeof page !== "object") {
        problems.push(`${where}: not an object`);
        return;
      }
      if (!isText(page.path) && !isText(page.title)) {
        problems.push(`${where}: needs a path or a title`);
        return;
      }
      if (page.path !== undefined && typeof page.path !== "string")
        problems.push(`${where}: path must be text`);
      if (page.title !== undefined && typeof page.title !== "string")
        problems.push(`${where}: title must be text`);
      if (page.why !== undefined) {
        if (typeof page.why !== "string")
          problems.push(`${where}: why must be text`);
        else if (page.why.length > MAX_WHY_CHARS)
          problems.push(`${where}: why is over ${MAX_WHY_CHARS} characters`);
      }
      pages.push({
        path: typeof page.path === "string" ? page.path.trim() : "",
        title: typeof page.title === "string" ? page.title.trim() : "",
        why: typeof page.why === "string" ? page.why.trim() : "",
      });
    });
    tasks.set(key, pages);
  }
  return { problems, tasks };
}

// ---------------------------------------------------------------------------
// Looking the pages up
// ---------------------------------------------------------------------------
/** A title as the lookup compares it: lower case, letters and digits only. */
export function normalizeTitle(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The catalog titles end in the product ("Assign Azure roles using the Azure portal - Azure RBAC"). */
const withoutProduct = (title) =>
  String(title ?? "").replace(/\s+[-–—]\s+[^-–—]+$/, "");

/**
 * What the lookups need, built once from the pools and docs-redirects.json: the moves of documentation pages and a
 * title index of the documentation catalog.
 */
export function buildResolver(pools, redirects = []) {
  const moves = new Map();
  const liveFrom = new Set(); // moves that a live request found (probeLiveMoves), not the catalogs
  for (const r of redirects ?? []) {
    if ((r.kind === "moved" || r.kind === "retired") && r.from && r.to) {
      moves.set(r.from, r.to);
      if (r.live) liveFrom.add(r.from);
    }
  }
  const titles = new Map(); // normalized title -> [paths]
  const add = (key, path) => {
    if (!key) return;
    const list = titles.get(key) ?? [];
    if (!list.includes(path)) list.push(path);
    titles.set(key, list);
  };
  for (const [path, meta] of pools.docMeta) {
    add(normalizeTitle(meta.title), path);
    add(normalizeTitle(withoutProduct(meta.title)), path);
  }
  const moduleTitles = new Map();
  for (const [path, m] of pools.modules) {
    const key = normalizeTitle(m.title);
    const list = moduleTitles.get(key) ?? [];
    list.push(path);
    moduleTitles.set(key, list);
  }
  return { pools, moves, liveFrom, titles, moduleTitles };
}

/**
 * Learn's own redirects for addresses the catalogs do not know. learnsync's move list is far from complete (on
 * AZ-104, 50 of the 66 unknown addresses a model wrote were old addresses that Learn redirects to a page of the
 * catalog), and a request to the page itself is the only complete source. One request per distinct address, one at a
 * time. Returns { moves: [{ from, to, kind: "moved", live: true }], failed: [{ path, status | error }] }; an address
 * that answers 200 at its own place or is not found moves nowhere.
 */
export async function probeLiveMoves({
  paths,
  fetchImpl = globalThis.fetch,
  origin = "https://learn.microsoft.com",
  delayMs = 250,
}) {
  const moves = [];
  const failed = [];
  for (const asked of [...new Set(paths)]) {
    try {
      const response = await fetchImpl(`${origin}${asked}`, {
        redirect: "follow",
        headers: { "user-agent": "msfthub-course-propose" },
      });
      try {
        await response.body?.cancel();
      } catch {
        /* the final address is all that is needed */
      }
      if (!response.ok) {
        failed.push({ path: asked, status: response.status });
      } else {
        const final = learnPath(response.url);
        if (final && final !== asked)
          moves.push({ from: asked, to: final, kind: "moved", live: true });
      }
    } catch (error) {
      failed.push({ path: asked, error: error?.message ?? String(error) });
    }
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  }
  return { moves, failed };
}

const commonPrefix = (a, b) => {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};

/** Of several pages with the same title, the one whose address is closest to the one asked for; null on a tie. */
function closest(paths, asked) {
  if (paths.length === 1) return paths[0];
  const scored = paths
    .map((p) => [p, commonPrefix(p, asked)])
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  return scored[0][1] > scored[1][1] ? scored[0][0] : null;
}

/**
 * Looks one proposed page up. `page` is { path, title }. Returns
 *   { status: "ok", path, kind, title, how, asked }       how: "path" | "moved" | "live" | "unit" | "title"
 *   { status: "dropped", path, kind, reason, asked }       it exists but a hard filter drops it (retired, ...)
 *   { status: "unresolved", reason, asked }                it is not a page of the catalogs
 * `asked` is the address as the model wrote it (canonical form), "" when only a title was given.
 */
export function resolveProposal(page, resolver) {
  const { pools, moves, liveFrom, titles, moduleTitles } = resolver;
  // Where a page that moved lives now: the first address along its moves that is a page of the catalogs.
  const follow = (start) => {
    let path = start;
    const how = liveFrom.has(start) ? "live" : "moved";
    for (let hop = 0; hop < MAX_REDIRECT_HOPS && moves.has(path); hop++) {
      path = learnPath(moves.get(path)) ?? path;
      if (
        pools.docMeta.has(path) &&
        (!pools.docPaths || pools.docPaths.has(path))
      )
        return {
          path,
          kind: "docs",
          how,
          title: pools.docMeta.get(path).title,
        };
      const parts = path.split("/").filter(Boolean);
      if (
        parts[0] === "training" &&
        parts[1] === "modules" &&
        parts.length === 3 &&
        pools.modules.has(path)
      )
        return {
          path,
          kind: "module",
          how,
          title: pools.modules.get(path).title,
        };
    }
    return null;
  };
  let asked = "";
  if (page.path) {
    let url;
    try {
      url = new URL(page.path, "https://learn.microsoft.com");
    } catch {
      return {
        status: "unresolved",
        reason: "not-an-address",
        asked: page.path,
      };
    }
    if (url.hostname !== "learn.microsoft.com")
      return { status: "unresolved", reason: "not-learn", asked: page.path };
    asked = learnPath(url.href) ?? "";
  }
  const found = (path, kind, how, title) => {
    const reason =
      kind === "docs"
        ? hardFilter({ kind: "docs", path, title }, pools)
        : pools.removed.has(path)
          ? "removed"
          : hardFilter({ kind, path, title }, pools);
    return reason
      ? { status: "dropped", path, kind, reason, asked }
      : { status: "ok", path, kind, title, how, asked };
  };

  if (asked) {
    const parts = asked.split("/").filter(Boolean);
    // training modules and units
    if (
      parts[0] === "training" &&
      parts[1] === "modules" &&
      parts.length >= 3
    ) {
      const modulePath = `/${parts.slice(0, 3).join("/")}`;
      if (parts.length === 3 && pools.modules.has(modulePath))
        return found(
          modulePath,
          "module",
          "path",
          pools.modules.get(modulePath).title,
        );
      if (parts.length > 3 && pools.units.has(asked))
        return found(asked, "unit", "path", pools.units.get(asked).title);
      if (parts.length > 3 && pools.modules.has(modulePath))
        return found(
          modulePath,
          "module",
          "unit",
          pools.modules.get(modulePath).title,
        );
      const movedTo = follow(modulePath);
      if (movedTo)
        return found(movedTo.path, movedTo.kind, movedTo.how, movedTo.title);
      if (pools.removed.has(modulePath))
        return { status: "unresolved", reason: "module-removed", asked };
      // fall through to the title lookup
    } else if (NOT_DOCS.test(asked)) {
      return { status: "unresolved", reason: "not-a-page", asked };
    } else {
      // documentation: Learn's moves first (a page that moved lives at its new address, whatever the old one
      // still says), then the address as written
      const live = (p) =>
        pools.docMeta.has(p) && (!pools.docPaths || pools.docPaths.has(p));
      const movedTo = follow(asked);
      if (movedTo)
        return found(movedTo.path, movedTo.kind, movedTo.how, movedTo.title);
      if (live(asked))
        return found(asked, "docs", "path", pools.docMeta.get(asked).title);
      if (pools.docPaths?.has(asked) && !pools.docMeta.has(asked))
        return { status: "unresolved", reason: "no-catalog-text", asked };
    }
  }

  // the title
  const key = normalizeTitle(withoutProduct(page.title));
  if (key) {
    const modulePaths = moduleTitles.get(normalizeTitle(page.title));
    const wantsModule = /^\/training\/modules\//.test(asked);
    if (modulePaths && (wantsModule || !asked)) {
      const m = closest(modulePaths, asked);
      if (m) return found(m, "module", "title", pools.modules.get(m).title);
    }
    const hits =
      titles.get(key) ?? titles.get(normalizeTitle(page.title)) ?? [];
    if (hits.length > 0) {
      // the same title can belong to several products: only a page in the area the model named counts
      const sameArea = asked
        ? hits.filter((p) => p.split("/")[1] === asked.split("/")[1])
        : hits;
      const path = sameArea.length > 0 ? closest(sameArea, asked || "") : null;
      if (path)
        return found(path, "docs", "title", pools.docMeta.get(path).title);
      return { status: "unresolved", reason: "ambiguous-title", asked };
    }
  }
  return {
    status: "unresolved",
    reason: asked ? "not-found" : "no-address",
    asked,
  };
}

// ---------------------------------------------------------------------------
// Merging into the candidates
// ---------------------------------------------------------------------------
/** The coverage of one page for a task, as the word search would have scored it (a hint for the judge, never a gate). */
function coverageOf(pools, kind, path, task) {
  const query = queryTerms(task.text, { context: task.group });
  const index = kind === "docs" ? pools.docsIndex : pools.moduleIndex;
  if (kind === "unit") return { coverage: 0, score: 0, matched: [] };
  const hit = index.search(query, {
    include: (id) => id === path,
    minCoverage: 0,
    limit: 1,
    scan: Infinity,
  }).hits[0];
  return hit
    ? {
        coverage: hit.coverage,
        score: hit.score,
        matched: [...new Set(hit.matched)],
      }
    : { coverage: 0, score: 0, matched: [] };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Adds the proposals to a candidates file. `answers` is a list of validated answers ({ tasks: Map }); returns
 *   { candidates, report }
 * `candidates` is a copy of the file in which every proposed page that exists is a candidate: one the generator
 * already had is marked `alsoProposed: true` (the word search and a model agree), a new one is added with source
 * "P5", the order of the tasks' lists being the generator's with the P5 candidates last. `report` counts what
 * happened to every proposal. With `onlyNew` the candidates are the new P5 ones only (to judge just them).
 */
export function mergeProposals({
  candidates,
  answers,
  pools,
  redirects = [],
  onlyNew = false,
}) {
  const resolver = buildResolver(pools, redirects);
  const proposedByTask = new Map();
  for (const answer of answers)
    for (const [key, pages] of answer.tasks) {
      const list = proposedByTask.get(key) ?? [];
      list.push(...pages);
      proposedByTask.set(key, list);
    }
  const report = {
    tasksAnswered: proposedByTask.size,
    proposed: 0,
    ok: 0,
    how: { path: 0, moved: 0, live: 0, unit: 0, title: 0 },
    alreadyCandidates: 0,
    added: 0,
    duplicates: 0,
    dropped: {},
    unresolved: {},
    unresolvedPages: [],
    droppedPages: [],
    addedByKind: { module: 0, unit: 0, docs: 0 },
    tasksWithNew: 0,
  };
  const tasks = candidates.tasks.map((task) => {
    const proposals = proposedByTask.get(task.key) ?? [];
    const existing = task.candidates.map((c) => ({ ...c }));
    const byPath = new Map(existing.map((c) => [c.target.path, c]));
    const moduleOf = (path) => {
      const p = path.split("/").filter(Boolean);
      return p[0] === "training" && p[1] === "modules"
        ? `/${p.slice(0, 3).join("/")}`
        : null;
    };
    const added = [];
    const seen = new Set();
    for (const page of proposals) {
      report.proposed++;
      const r = resolveProposal(page, resolver);
      if (r.status === "unresolved") {
        report.unresolved[r.reason] = (report.unresolved[r.reason] ?? 0) + 1;
        report.unresolvedPages.push({
          task: task.key,
          asked: r.asked || page.title,
          title: page.title,
          reason: r.reason,
        });
        continue;
      }
      if (r.status === "dropped") {
        report.dropped[r.reason] = (report.dropped[r.reason] ?? 0) + 1;
        report.droppedPages.push({
          task: task.key,
          path: r.path,
          reason: r.reason,
        });
        continue;
      }
      report.ok++;
      report.how[r.how]++;
      if (seen.has(r.path)) {
        report.duplicates++;
        continue;
      }
      seen.add(r.path);
      const known = byPath.get(r.path);
      // a proposed module is already there when one of its units is a candidate
      const unitOfIt =
        !known && r.kind === "module"
          ? existing.find(
              (c) =>
                c.target.kind === "unit" && moduleOf(c.target.path) === r.path,
            )
          : null;
      if (known || unitOfIt) {
        (known ?? unitOfIt).alsoProposed = true;
        report.alreadyCandidates++;
        continue;
      }
      const hint = coverageOf(pools, r.kind, r.path, task);
      added.push({
        target: { kind: r.kind, path: r.path },
        title: r.title,
        source: "P5",
        rank: added.length + 1,
        score: round2(hint.score),
        coverage: round2(hint.coverage),
        matched: hint.matched,
        ...(r.kind === "module"
          ? { unitSig: pools.modules.get(r.path).unitSig }
          : {}),
        ...(r.kind === "docs" ? { family: docFamily(r.path) } : {}),
        proposal: {
          ...(page.why ? { why: page.why } : {}),
          ...(r.asked && r.asked !== r.path ? { asked: r.asked } : {}),
          how: r.how,
        },
      });
      report.added++;
      report.addedByKind[r.kind]++;
    }
    if (added.length > 0) report.tasksWithNew++;
    return { ...task, candidates: onlyNew ? added : [...existing, ...added] };
  });
  const total = tasks.reduce((n, t) => n + t.candidates.length, 0);
  const bySource = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  for (const t of tasks)
    for (const c of t.candidates)
      bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  return {
    candidates: {
      ...candidates,
      tasks,
      stats: { ...(candidates.stats ?? {}), candidates: total, bySource },
    },
    report,
  };
}
