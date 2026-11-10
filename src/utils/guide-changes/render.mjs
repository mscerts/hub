// The Study Guide Changes page of one exam, as HTML, from its history. Pure: the Astro route
// (src/pages/certs/changelog/[code].astro) only places the result. Runbook: docs/study-guide-changes.md.
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";
import { areaGraph, groupGraph, mergeGuides } from "./compare.mjs";
import {
  MOVE_THRESHOLD,
  REWRITTEN_SHARE,
  audienceLines,
  diffVersions,
  changeKind,
  entryKind,
} from "./diff.mjs";
import { dayBefore, prettyDate, summarise, versionState } from "./state.mjs";

export const esc = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Additions are green AND underlined, removals red and struck through: colour is never the only cue.
const INS_CLASS =
  "underline decoration-1 underline-offset-2 text-green-700 dark:text-green-400";
const DEL_CLASS = "line-through text-red-600 dark:text-red-400";
export const ins = (text) => `<ins class="${INS_CLASS}">${esc(text)}</ins>`;
export const del = (text) => `<del class="${DEL_CLASS}">${esc(text)}</del>`;

/** Word by word comparison of two texts: removed words struck through in red, new words green. */
export function wordDiff(a, b) {
  const x = a.split(/\s+/);
  const y = b.split(/\s+/);
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        x[i] === y[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let removed = [];
  let added = [];
  const flush = () => {
    if (removed.length) out.push(del(removed.join(" ")));
    if (added.length) out.push(ins(added.join(" ")));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      flush();
      out.push(esc(x[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  while (i < n) removed.push(x[i++]);
  while (j < m) added.push(y[j++]);
  flush();
  return out.join(" ");
}

/**
 * The HTML of one aligned entry: unchanged, reworded in place, added or removed. `links` turns the name of a
 * domain into a link to its heading (the comparison of two exams): `{ old(title), new(title) }`.
 */
const MOVED_TAG = "ml-1 text-xs text-muted-foreground";
const plainLinks = { old: esc, new: esc, group: esc };
function entryHtml(entry, strip = (s) => s, links = plainLinks) {
  // A skill that moved to another domain (a comparison of two exams): in place, with where it went or came from.
  if (entry.kind === "moved-in")
    return `${wordDiff(strip(entry.old), strip(entry.new))} <span class="${MOVED_TAG}">← from ${links.old(entry.from.domain)}${entry.alsoFrom ? ` and ${entry.alsoFrom} more skill${entry.alsoFrom === 1 ? "" : "s"} of the old guide` : ""}</span>`;
  if (entry.kind === "covered")
    return `<span class="text-muted-foreground">${esc(strip(entry.old))}</span> <span class="${MOVED_TAG}">→ covered at a higher level by ${links.group(entry.to.group)}</span>`;
  if (entry.kind === "moved-out")
    return `${del(strip(entry.old))} <span class="${MOVED_TAG}">→ now in ${links.new(entry.to.domain)}</span>`;
  const kind = entryKind(entry);
  if (kind === "same") return esc(strip(entry.new));
  if (kind === "reworded") return wordDiff(strip(entry.old), strip(entry.new));
  return kind === "added" ? ins(strip(entry.new)) : del(strip(entry.old));
}

const range = (w) => (w.min === w.max ? `${w.min}%` : `${w.min}–${w.max}%`);
const nowrap = (html) => `<span class="whitespace-nowrap">${html}</span>`; // keeps "25–30%" on one line on a phone

const table = (head, rows) =>
  `<div class="docs-table-wrapper subtle-scrollbar"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

const BUTTON_CLASS =
  "group not-prose inline-flex h-10 max-w-full min-w-0 cursor-pointer list-none items-center justify-center gap-2 rounded-lg border border-border bg-card px-5 text-center text-sm font-medium text-card-foreground no-underline shadow-sm transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden";
// Rotate only when this dropdown's own <details> is open (a nested one must not follow its parent).
const CHEVRON =
  '<svg class="size-4 shrink-0 transition-transform [details[open]>summary>&]:rotate-180" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>';

/** A dropdown whose trigger is styled like the site's secondary button (LinkButton, size lg). */
export function dropdown(label, content, { open = false } = {}) {
  return `<details class="my-4"${open ? " open" : ""}><summary class="${BUTTON_CLASS}">${esc(label)} ${CHEVRON}</summary><div class="mt-4">${content}</div></details>`;
}

const textOf = (entry) => entry.new ?? entry.old;

/** Lines of an audience profile (bullets or paragraphs) as HTML, from aligned entries. */
function linesHtml(entries) {
  let html = "";
  let list = [];
  const flush = () => {
    if (list.length) html += `<ul>${list.join("")}</ul>`;
    list = [];
  };
  for (const entry of entries) {
    const bullet = /^- /.test(textOf(entry));
    const inner = entryHtml(entry, (s) => s.replace(/^- /, ""));
    if (bullet) list.push(`<li>${inner}</li>`);
    else {
      flush();
      html += `<p>${inner}</p>`;
    }
  }
  flush();
  return html;
}

const plainEntries = (lines) => lines.map((line) => ({ old: line, new: line }));

const titleOfLines = (lines) =>
  (
    lines.find((line) => /^## Skills measured/.test(line)) ??
    "## Skills measured"
  ).replace(/^## /, "");

function guideDoc({ title, audience, glance, body, audienceOpen = false }) {
  return `<h3>${esc(title)}</h3>${dropdown("Audience profile", audience, { open: audienceOpen })}<h4>Skills at a glance</h4>${glance}${body}`;
}

/** One version of the guide, laid out like Microsoft's page. */
function plainDoc(lines) {
  const tree = parseGuide(lines);
  const audience = linesHtml(plainEntries(audienceLines(lines)));
  if (!tree.ok) {
    const rest = lines.filter((line) => !/^## Skills measured/.test(line));
    return `<h3>${esc(titleOfLines(lines))}</h3>${linesHtml(plainEntries(rest))}`;
  }
  const glance = `<ul>${tree.domains.map((d) => `<li>${esc(d.title)} (${range(d.weight)})</li>`).join("")}</ul>`;
  const body = tree.domains
    .map(
      (d) =>
        `<h4>${esc(d.title)} (${range(d.weight)})</h4>${d.groups
          .map(
            (g) =>
              `<h5>${esc(g.title)}</h5><ul>${g.tasks.map((t) => `<li>${esc(t.text)}</li>`).join("")}</ul>`,
          )
          .join("")}`,
    )
    .join("");
  return guideDoc({ title: titleOfLines(lines), audience, glance, body });
}

// A title that Microsoft reworded between two exams (`oldTitle` is set by diffVersions) is a word diff.
const titleHtml = (entry) =>
  entry.oldTitle ? wordDiff(entry.oldTitle, entry.title) : esc(entry.title);

const domainHead = (domain) => {
  const { old: oldWeight, new: newWeight } = domain.weights;
  if (domain.status === "added")
    return ins(`${domain.title} (${range(newWeight)})`);
  if (domain.status === "removed")
    return del(`${domain.title} (${range(oldWeight)})`);
  const a = range(oldWeight);
  const b = range(newWeight);
  return `${titleHtml(domain)} (${a === b ? a : `${del(a)} ${ins(b)}`})`;
};

/**
 * The skills part of a comparison: glance list and the domains, with the differences in place. `compare` is set
 * for the comparison of two exams: `{ id(domain), links, glanceNote(domain) }` gives every domain heading an id
 * (so notes can link to it), turns the names of domains in the notes into links, and adds to each line of the
 * glance list how that area changed.
 */
function diffSkills(diff, compare = null) {
  const note = (d) => {
    const html = compare?.glanceNote(d);
    return html ? ` <span class="${MOVED_TAG}">${html}</span>` : "";
  };
  const glance = `<ul>${diff.domains.map((d) => `<li>${domainHead(d)}${note(d)}</li>`).join("")}</ul>`;
  const body = diff.domains
    .map(
      (d) =>
        `<h4${compare ? ` id="${compare.id(d)}" class="scroll-mt-24"` : ""}>${domainHead(d)}</h4>${d.groups
          .map((g) => {
            const head =
              g.status === "added"
                ? ins(g.title)
                : g.status === "removed"
                  ? del(g.title)
                  : titleHtml(g);
            return `<h5${compare ? ` id="${compare.groupId(d, g)}" class="scroll-mt-24"` : ""}>${head}</h5><ul>${g.items.map((item) => `<li>${entryHtml(item, undefined, compare?.links)}</li>`).join("")}</ul>`;
          })
          .join("")}`,
    )
    .join("");
  return { glance, body };
}

const LEGEND = `${ins("Green underlined")} text was added or reworded. ${del("Red strikethrough")} text was removed or replaced. Everything else is unchanged. This is the whole study guide, so you can see each change in place.`;

function diffDoc(diff, titleLines, { audienceOpen, title, compare = null }) {
  const { glance, body } = diffSkills(diff, compare);
  return guideDoc({
    title: title ?? titleOfLines(titleLines),
    audience: linesHtml(diff.audience.entries),
    glance,
    body,
    audienceOpen,
  });
}

function weightsTable(diff, newLabel) {
  const rows = diff.domains
    .filter((d) => d.status === "same")
    .map((d) => {
      const delta =
        (d.weights.new.min + d.weights.new.max) / 2 -
        (d.weights.old.min + d.weights.old.max) / 2;
      const points =
        delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ −${Math.abs(delta)}` : "•";
      return [
        esc(d.title),
        nowrap(range(d.weights.old)),
        `${nowrap(`<strong>${range(d.weights.new)}</strong>`)} ${nowrap(points)}`,
      ];
    });
  // Three columns at most: the site's CSS wraps those to fit a phone, four or more scroll sideways.
  return table(["Domain", "Now", esc(newLabel)], rows);
}

/** The skills of a domain of a comparison: those of the old guide (`old`) or of the new one. */
function skillsOf(domain, side) {
  return domain.groups.reduce(
    (n, g) =>
      n +
      g.items.filter((i) =>
        side === "old"
          ? i.kind !== "added" && i.kind !== "moved-in"
          : i.new !== undefined,
      ).length,
    0,
  );
}

/** `wentTo(domain)` is what to say in place of the new weight of a domain that is not in the new guide. */
function domainSummary(
  diff,
  labels = ["Before", "Now"],
  tag = () => "",
  wentTo = () => "–",
) {
  const cell = (weight, skills) =>
    `${nowrap(range(weight))} · ${skills} skill${skills === 1 ? "" : "s"}`;
  const ordered = [
    ...diff.domains.filter((d) => d.status !== "removed"),
    ...diff.domains.filter((d) => d.status === "removed"),
  ];
  return table(
    ["Domain", ...labels.map(esc)],
    ordered.map((d) => [
      d.status === "added"
        ? ins(d.title)
        : d.status === "removed"
          ? del(d.title)
          : titleHtml(d),
      d.weights.old
        ? `${tag(d) ? `${esc(tag(d))}: ` : ""}${cell(d.weights.old, skillsOf(d, "old"))}`
        : "–",
      d.weights.new
        ? `<strong>${cell(d.weights.new, skillsOf(d, "new"))}</strong>`
        : wentTo(d),
    ]),
  );
}

/** `matching`: the skills of two different exams are matched by topic, so unmatched skills may just be reworded a lot. */
function countsTable(diff, { matching = false } = {}) {
  const { stats, audience } = diff;
  return table(
    ["What", "Result"],
    [
      [
        matching ? "New skills with no close match" : "Skills added",
        `<strong>${stats.added}</strong>`,
      ],
      [
        matching ? "Old skills with no close match" : "Skills removed",
        `<strong>${stats.removed}</strong>`,
      ],
      ["Skills reworded", `<strong>${stats.reworded}</strong>`],
      ...(stats.moved
        ? [
            [
              "Skills moved to another domain",
              `<strong>${stats.moved}</strong>`,
            ],
          ]
        : []),
      ...(stats.covered
        ? [
            [
              "Skills covered at a higher level",
              `<strong>${stats.covered}</strong>`,
            ],
          ]
        : []),
      [
        "Skills in total",
        `<strong>${stats.totalNow}</strong> (was ${stats.totalBefore})`,
      ],
      [
        "Domain weights",
        !diff.domains.some((d) => d.status === "same")
          ? "<strong>not comparable</strong>: no domain is the same"
          : stats.weightsChanged
            ? "<strong>changed</strong> (shown in the headings below)"
            : "unchanged",
      ],
      [
        "Audience profile",
        audience.changed ? "<strong>changed</strong>" : "unchanged",
      ],
    ],
  );
}

const heading = (id, text) => `<h3 id="${id}">${esc(text)}</h3>`;

/** The body of a comparison, by how big the change is. Returns `{ html, headings }`. */
function changeBody(diff, kind, { upcomingOn = null } = {}) {
  const headings = [];
  const h = (id, text) => {
    headings.push({ depth: 2, slug: id, text });
    return heading(id, text);
  };
  if (kind === "none")
    return {
      html: "<p>No skills were added, removed or reworded, and the domain weights did not change.</p>",
      headings,
    };
  if (kind === "unreadable")
    return {
      html: `${h("what-changed", "What changed")}<p>This guide's structure could not be read, so the lines of the guide are compared one by one.</p>${linesHtml(diff.lineEntries)}`,
      headings,
    };
  if (kind === "weights") {
    const hint = upcomingOn
      ? `<p><strong>What this means for you.</strong> If you sit the exam before ${prettyDate(upcomingOn)}, prepare against the <strong>Current</strong> tab. From ${prettyDate(upcomingOn)} the <strong>Upcoming</strong> tab applies. The skills themselves did not change, so the same material is still in scope: only the share of the exam each domain makes up moves.</p>`
      : "";
    return {
      html: `${h("domain-weights", "Domain weights")}${weightsTable(
        diff,
        upcomingOn
          ? `From ${prettyDate(upcomingOn)
              .replace(/^(\w{3})\w*/, "$1")
              .replace(/, \d{4}$/, "")}`
          : "Now",
      )}${h("skills", "Skills")}<p>No skills were added, removed or reworded. All ${diff.stats.totalNow} skill statements are worded exactly the same in both versions: only the weight of each domain changed.</p>${hint}`,
      headings,
    };
  }
  if (kind === "rewritten") {
    const { stats } = diff;
    return {
      html: `<p><strong>This guide was largely rewritten:</strong> ${stats.added + stats.reworded} of ${stats.totalNow} skills are new or reworded (${stats.added} added, ${stats.reworded} reworded, ${stats.removed} removed). Start with the domains below. The <strong>Current</strong> and <strong>Previous</strong> tabs hold the full versions.</p>${h("what-changed-at-a-glance", "What changed at a glance")}${countsTable(diff)}${h("domains", "Domains")}${domainSummary(diff)}${dropdown("Show every change", `<p>${LEGEND}</p>${diffDoc(diff, diff.curLines, { audienceOpen: false })}`)}`,
      headings,
    };
  }
  return {
    html: `<p>${LEGEND}</p>${h("what-changed-at-a-glance", "What changed at a glance")}${countsTable(diff)}${h("skills-measured", "Skills measured")}${diffDoc(diff, diff.curLines, { audienceOpen: diff.audience.changed })}`,
    headings,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyEntries(history) {
  const entries = [];
  const versions = history.versions;
  const describe = (before, after) => {
    const diff = diffVersions(before, after);
    const kind = changeKind(diff);
    return { diff, kind, summary: summarise(diff, kind) };
  };
  const detail = ({ diff, kind }) => {
    if (kind === "weights")
      return `${weightsTable(diff, "Now")}<p>No skills were added, removed or reworded.</p>`;
    if (kind === "none")
      return "<p>No skills were added, removed or reworded, and the domain weights did not change.</p>";
    if (kind === "unreadable") return linesHtml(diff.lineEntries);
    const { body } = diffSkills(diff);
    const audience = diff.audience.changed
      ? dropdown("Audience profile", linesHtml(diff.audience.entries), {
          open: true,
        })
      : "";
    return `${kind === "rewritten" ? domainSummary(diff) : ""}${audience}${body}`;
  };

  versions.forEach((v, index) => {
    const label = v.asOf
      ? `skills measured as of ${prettyDate(v.asOf)}`
      : "no date stated";
    if (index === 0) {
      const tree = parseGuide(v.lines);
      const counts = tree.ok
        ? `${tree.stats.domains} domains, ${tree.stats.groups} skill groups, ${tree.stats.tasks} skills.`
        : "";
      entries.push({
        day: v.firstSeen,
        order: v.n * 10,
        summary: `<strong>${prettyDate(v.firstSeen)}</strong>: first version recorded (${label}).`,
        body: `<p>${counts} See the <strong>Current</strong> tab for the full outline.</p>`,
      });
      if (v.priorOnPage && v.asOf) {
        const d = describe(v.priorOnPage.lines, v.lines);
        entries.push({
          day: v.asOf,
          order: v.n * 10 - 1,
          summary: `<strong>${prettyDate(v.asOf)}</strong>: change listed on Microsoft's own page (before our records). ${esc(d.summary)}`,
          body: detail(d),
        });
      }
    } else {
      const d = describe(versions[index - 1].lines, v.lines);
      const when = v.asOf
        ? v.asOf > v.firstSeen
          ? `new version published, effective ${prettyDate(v.asOf)}`
          : `new version published, dated ${prettyDate(v.asOf)}`
        : "new version published, no date stated";
      const earlier =
        v.asOf && versions[index - 1].asOf && v.asOf < versions[index - 1].asOf;
      entries.push({
        day: v.firstSeen,
        order: v.n * 10,
        summary: `<strong>${prettyDate(v.firstSeen)}</strong>: ${when}.${d.summary ? ` ${esc(d.summary)}` : ""}`,
        body: `${earlier ? "<p>Microsoft's page now shows a version whose date is earlier than the one we had recorded. We treat the page as the source of truth, so the version on it is the current one.</p>" : ""}${detail(d)}`,
      });
    }
    (v.corrections ?? []).forEach((c, i) => {
      const after = v.corrections[i + 1]?.before ?? v.lines;
      const d = describe(c.before, after);
      entries.push({
        day: c.day,
        order: v.n * 10 + 1 + i,
        summary: `<strong>${prettyDate(c.day)}</strong>: corrected, the guide's date (${v.asOf ? prettyDate(v.asOf) : "none"}) stayed the same.${d.summary ? ` ${esc(d.summary)}` : ""}`,
        body: detail(d),
      });
    });
  });
  return entries.sort((a, b) =>
    a.day === b.day ? b.order - a.order : a.day < b.day ? 1 : -1,
  );
}

function historyTab(history) {
  const first = history.versions[0];
  const intro = `<p>Every recorded change to this study guide, newest first. We started recording on ${prettyDate(first.firstSeen)}; earlier history is not available yet.</p>`;
  const entries = historyEntries(history);
  const list = entries
    .map(
      (entry, i) =>
        `<details class="my-2"${i === 0 ? " open" : ""}><summary>${entry.summary}</summary><div class="mt-3">${entry.body}</div></details>`,
    )
    .join("");
  return `${intro}${history.versions.length === 1 && !first.priorOnPage ? "<p>No changes recorded yet.</p>" : ""}${list}`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const versionLabel = (v) =>
  v.asOf
    ? `of ${prettyDate(v.asOf)}`
    : `we first saw on ${prettyDate(v.firstSeen)}`;

function changesTab(history, st) {
  const first = history.versions[0];
  if (!st.pair) {
    const announced =
      st.upcoming && !st.current
        ? `<p>A new version is dated ${prettyDate(st.upcoming.asOf)}, and we have not recorded the version before it. It is on the <strong>Upcoming</strong> tab.</p>`
        : "";
    return {
      note: `<p><strong>No changes recorded.</strong> We have recorded this study guide since ${prettyDate(first.firstSeen)} and its skills measured have not changed since. If they do, the change will appear here first.</p>`,
      html: `${announced}<p>The <strong>Current</strong> tab shows the guide as it is today, and <strong>History</strong> will list every change we record.</p>`,
      headings: [],
    };
  }
  const { pair, change } = st;
  const { effective } = change;
  let note;
  if (pair.to === st.upcoming) {
    note = `<p><strong>A new version takes effect on ${prettyDate(effective.date)}.</strong> Until then the version ${versionLabel(st.current ?? pair.from)} is the one you are tested on. The changes below are from that version to the new one.</p>`;
  } else if (pair.fromSource === "onPage") {
    note = effective
      ? `<p><strong>Microsoft's page itself lists the version before this one.</strong> The change took effect on ${prettyDate(effective.date)}, which is before we started recording. The differences are below for reference.</p>`
      : "<p><strong>Microsoft's page itself lists the version before this one</strong>, but states no date for the change. The differences are below for reference.</p>";
  } else if (effective.basis === "seen") {
    note = `<p><strong>We saw the study guide change on ${prettyDate(effective.date)}.</strong>${pair.to.asOf ? "" : " Microsoft states no effective date for the new version, and it is already on Microsoft's page."}${change.regressed ? ` Microsoft's page now shows a version dated ${prettyDate(pair.to.asOf)}, earlier than the ${prettyDate(pair.from.asOf)} version it replaced. We treat the page as the source of truth, so the new version is the current one.` : ""}</p>`;
  } else {
    note = `<p><strong>The new version took effect on ${prettyDate(effective.date)}.</strong></p>`;
  }
  if (change.kind === "none" && pair.to !== st.upcoming)
    note = `<p><strong>The guide's date changed${pair.from.asOf ? ` from ${prettyDate(pair.from.asOf)}` : ""}${pair.to.asOf ? ` to ${prettyDate(pair.to.asOf)}` : ""}, but its skills did not.</strong> We saw it on ${prettyDate(pair.to.firstSeen)}.</p>`;
  const body = changeBody(change.diff, change.kind, {
    upcomingOn: pair.to === st.upcoming ? pair.to.asOf : null,
  });
  return { note, html: body.html, headings: body.headings };
}

// ---------------------------------------------------------------------------
// Comparison with the exam that replaces / is replaced by this one
// ---------------------------------------------------------------------------

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * How the areas of the old guide(s) became those of the new one, from the hand-made areas of the pair
 * (compare-areas.mjs) and the diff: links to the domain headings, a note for each line of the glance list, the
 * line to show for a domain that is not in the new guide, and the table of every area. Entries that name a
 * title no guide has any more are skipped.
 */
function areaModel(diff, areas, groups, { to, tag }) {
  const oldOf = new Map();
  const newOf = new Map();
  const ids = new Map();
  for (const d of diff.domains) {
    const id = `cmp-${slug(d.title)}${d.status === "removed" ? "-old" : ""}`;
    ids.set(d, id);
    if (d.status !== "added") oldOf.set(d.oldTitle ?? d.title, d);
    if (d.status !== "removed") newOf.set(d.title, d);
  }
  const link = (map) => (title) => {
    const d = map.get(title);
    return d
      ? `<a href="#${ids.get(d)}" class="text-inherit underline decoration-dotted underline-offset-2 hover:text-primary">${esc(title)}</a>`
      : esc(title);
  };
  const oldGroupOf = new Map();
  const newGroupOf = new Map();
  const groupIds = new Map();
  for (const d of diff.domains)
    for (const g of d.groups) {
      groupIds.set(
        g,
        `cmp-g-${slug(d.title)}-${slug(g.title)}${g.status === "added" ? "" : d.status === "removed" || g.status === "removed" ? "-old" : ""}`,
      );
      if (g.status !== "added") oldGroupOf.set(g.oldTitle ?? g.title, g);
      if (g.status !== "removed") newGroupOf.set(g.title, g);
    }
  const groupLink = (title) => {
    const g = newGroupOf.get(title);
    return g
      ? `<a href="#${groupIds.get(g)}" class="text-inherit underline decoration-dotted underline-offset-2 hover:text-primary">${esc(title)}</a>`
      : esc(title);
  };
  const links = { old: link(oldOf), new: link(newOf), group: groupLink };
  const entries = (areas ?? [])
    .map((a) => ({
      from: a.from.filter((t) => oldOf.has(t)),
      to: a.to.filter((t) => newOf.has(t)),
      note: a.note,
      whole: a,
    }))
    .filter(
      (e) =>
        (e.whole.from.length === 0 || e.from.length > 0) &&
        (e.whole.to.length === 0 || e.to.length > 0) &&
        e.from.length + e.to.length > 0,
    );
  const union = (pick, match) => [
    ...new Set(entries.filter(match).flatMap(pick)),
  ];
  // A minor entry (a small part of a domain went somewhere else) is in the table but not in the notes.
  const sourcesOf = (title) =>
    union(
      (e) => e.from,
      (e) => !e.whole.minor && e.to.includes(title),
    );
  const targetsOf = (title) =>
    union(
      (e) => e.to,
      (e) => !e.whole.minor && e.from.includes(title),
    );
  const minorTargetsOf = (title) =>
    union(
      (e) => e.to,
      (e) => e.whole.minor && e.from.includes(title),
    );
  const list = (titles, linkOf) => {
    const html = titles.map(linkOf);
    return html.length > 1
      ? `${html.slice(0, -1).join(", ")} and ${html.at(-1)}`
      : html[0];
  };

  const glanceNote = (d) => {
    if (d.status === "removed") {
      const targets = targetsOf(d.title);
      if (!targets.length)
        return minorTargetsOf(d.title).length
          ? `— mostly not in ${to.code}`
          : `— not in ${to.code}`;
      return targets.length > 1
        ? `— split into ${list(targets, links.new)}`
        : sourcesOf(targets[0]).length > 1
          ? `— merged into ${links.new(targets[0])}`
          : `— now ${links.new(targets[0])}`;
    }
    const sources = sourcesOf(d.title);
    if (sources.length > 1) return `— merged from ${list(sources, links.old)}`;
    if (sources.length === 1)
      // One to one: nothing to add, a renamed domain already shows its old title struck through.
      return targetsOf(sources[0]).length > 1
        ? `— split from ${links.old(sources[0])}`
        : "";
    return d.status === "added" ? `— new in ${to.code}` : "";
  };
  const wentTo = (d) => {
    const targets = targetsOf(d.title);
    if (targets.length) return `<em>→ ${list(targets, esc)}</em>`;
    return minorTargetsOf(d.title).length
      ? `<em>mostly not in ${esc(to.code)}</em>`
      : `<em>not in ${esc(to.code)}</em>`;
  };

  const sizeOf = (d, side) => {
    const n = skillsOf(d, side);
    return `${nowrap(range(d.weights[side]))}, ${n} skill${n === 1 ? "" : "s"}`;
  };
  const cellOf = (titles, map, side, linkOf) =>
    titles
      .map((t) => {
        const from = side === "old" ? tag(t) : "";
        return `${from ? `${esc(from)}: ` : ""}${linkOf(t)} <span class="${MOVED_TAG}">(${sizeOf(map.get(t), side)})</span>`;
      })
      .join("<br>");
  const labelOf = (e) =>
    e.whole.label
      ? `${e.whole.label}.`
      : !e.from.length
        ? "New."
        : !e.to.length
          ? `Not in ${to.code}.`
          : e.from.length > 1 && e.to.length > 1
            ? "Regrouped."
            : e.from.length > 1
              ? "Merged."
              : e.to.length > 1
                ? "Split."
                : e.from[0] !== e.to[0]
                  ? "Renamed."
                  : "Carried over.";
  const rows = entries.map((e) => [
    e.from.length ? cellOf(e.from, oldOf, "old", links.old) : "–",
    e.to.length ? cellOf(e.to, newOf, "new", links.new) : "–",
    `<strong>${labelOf(e)}</strong> ${esc(e.note)}`,
  ]);
  const graph = areaGraph(areas);

  // The group by group table: every entry of the hand-made group pairing that still names real groups.
  const groupEntries = (groups ?? [])
    .map((e) => ({
      from: e.from.filter((t) => oldGroupOf.has(t)),
      to: e.to.filter((t) => newGroupOf.has(t)),
      whole: e,
    }))
    .filter(
      (e) =>
        (e.whole.from.length === 0 || e.from.length > 0) &&
        (e.whole.to.length === 0 || e.to.length > 0) &&
        e.from.length + e.to.length > 0,
    );
  const groupLabelOf = (e) =>
    e.whole.label
      ? `${e.whole.label}.`
      : e.whole.broader
        ? "Higher level."
        : !e.from.length
          ? "New."
          : !e.to.length
            ? `Not in ${to.code}.`
            : e.from.length > 1 && e.to.length > 1
              ? "Regrouped."
              : e.from.length > 1
                ? "Merged."
                : e.to.length > 1
                  ? "Split."
                  : "Carried over.";
  const groupSkills = (g, side) =>
    g.items.filter((i) =>
      side === "old"
        ? i.kind !== "added" && i.kind !== "moved-in"
        : i.new !== undefined,
    ).length;
  const groupCell = (titles, map, side) =>
    titles
      .map((t) => {
        const g = map.get(t);
        const n = groupSkills(g, side);
        const from = side === "old" ? tag(t) : "";
        return `${from ? `${esc(from)}: ` : ""}${side === "old" ? esc(t) : groupLink(t)} <span class="${MOVED_TAG}">(${n} skill${n === 1 ? "" : "s"})</span>`;
      })
      .join("<br>");
  const groupRows = groupEntries.map((e) => [
    e.from.length ? groupCell(e.from, oldGroupOf, "old") : "–",
    e.to.length ? groupCell(e.to, newGroupOf, "new") : "–",
    `<strong>${groupLabelOf(e)}</strong>${e.whole.note ? ` ${esc(e.whole.note)}` : ""}`,
  ]);
  return {
    pairDomains: graph.pairs,
    moveEdges: graph.edges,
    groupMap: groupGraph(groups),
    groupTable: (fromShort) =>
      groupRows.length
        ? table(
            [`${fromShort} group`, `${to.code} group`, "What changed"],
            groupRows,
          )
        : "",
    compare: {
      id: (d) => ids.get(d),
      groupId: (d, g) => groupIds.get(g),
      links,
      glanceNote,
    },
    wentTo,
    table: (fromShort) =>
      table([`${fromShort} area`, `${to.code} area`, "What changed"], rows),
    has: entries.length > 0,
  };
}

/**
 * The tab that compares the study guide of the exam(s) being replaced with the one of the replacement
 * (AZ-400 and AZ-401), the same on the pages of all of them. `compare` is `{ from, to, retirements?, blurb?,
 * titleThreshold? }`: `from` is a list of `{ code, history }` (several when one exam replaces two, their
 * guides are merged, see mergeGuides), `to` the replacement, `retirements` the `{ code, date }` of the
 * replaced exams, `areas` how the domains became the new ones, judged by hand (compare-areas.mjs). Null when a
 * guide has not been recorded. Group titles are paired by similarity, because two exams word them differently;
 * domains are paired, and skills matched across domains, only as `areas` says.
 */
function compareTab(
  {
    from,
    to,
    retirements = [],
    blurb = "",
    titleThreshold = 0.5,
    areas = null,
    groups = null,
  },
  now,
) {
  const live = (history) => {
    const st = versionState(history, now);
    return st.current ?? st.upcoming;
  };
  const olds = from
    .map((f) => ({ code: f.code, version: live(f.history) }))
    .filter((f) => f.version);
  const b = live(to.history);
  if (!b || olds.length < from.length) return null;
  const merged =
    olds.length > 1
      ? mergeGuides(olds.map((o) => ({ code: o.code, lines: o.version.lines })))
      : { lines: olds[0].version.lines, sources: new Map() };
  const graph = areaGraph(areas);
  const diff = diffVersions(merged.lines, b.lines, {
    titleThreshold,
    ...(areas
      ? {
          moveThreshold: MOVE_THRESHOLD,
          pairDomains: graph.pairs,
          moveEdges: graph.edges,
          groupMap: groups ? groupGraph(groups) : null,
        }
      : {}),
  });
  if (!diff.ok) return null;

  const list = (codes) =>
    codes.length > 1
      ? `${codes.slice(0, -1).join(", ")} and ${codes.at(-1)}`
      : codes[0];
  const fromList = list(olds.map((o) => o.code));
  const fromShort = olds.map((o) => o.code).join(" + ");
  const area = areaModel(diff, areas, groups, {
    to,
    tag: (title) => merged.sources.get(title) ?? "",
  });
  const guideOf = (code, v) =>
    `the ${code} study guide (${v.asOf ? `skills measured as of ${prettyDate(v.asOf)}` : `no date stated, first seen ${prettyDate(v.firstSeen)}`})`;
  const today = now.toISOString().slice(0, 10);
  const dates = [...new Set(retirements.map((x) => x.date))];
  const retired = dates
    .map((date) => {
      const codes = retirements
        .filter((x) => x.date === date)
        .map((x) => x.code);
      return `${list(codes)} ${date < today ? "retired" : codes.length > 1 ? "retire" : "retires"} on ${prettyDate(date)}`;
    })
    .join("; ");
  const note = `<p>${blurb || `<strong>${to.code} is the replacement for ${fromList}.</strong>`}${
    retired ? ` ${retired[0].toUpperCase()}${retired.slice(1)}.` : ""
  } This compares ${list(olds.map((o) => guideOf(o.code, o.version)))} with ${guideOf(to.code, b)}, as they stand today${
    olds.length > 1
      ? `; the ${fromList} guides are put together as one, and each old domain shows which exam it came from`
      : ""
  }. It is refreshed whenever a guide changes.</p>`;

  const { stats } = diff;
  const headings = [];
  const h = (id, text) => {
    headings.push({ depth: 2, slug: id, text });
    return heading(id, text);
  };
  const legend = `<p>${ins("Green underlined")} text is in ${to.code} but not in ${fromList}, or is worded differently. ${del("Red strikethrough")} text is in ${fromList} but not in ${to.code}. Everything else is the same in both. Skills are matched by topic, so a skill that was reworded a lot can show as removed and added.${stats.moved ? ` A grey note after a skill says it moved to another domain: where it is now, or where it came from. The notes in "Skills at a glance" say how each area changed.` : ""} This is the whole ${to.code} study guide, so you can see each difference in place.</p>`;
  const be = (n) => (n === 1 ? "is" : "are");
  const skills = (n) => `${n} skill${n === 1 ? "" : "s"}`;
  const summary = `<p>${to.code} measures ${skills(stats.totalNow)}; ${fromList} ${olds.length > 1 ? "measure" : "measures"} ${stats.totalBefore}. Compared with ${fromList}, ${skills(stats.added)} ${be(stats.added)} new, ${stats.reworded} ${be(stats.reworded)} reworded,${stats.moved ? ` ${stats.moved} ${be(stats.moved)} about the same topic but in a different domain,` : ""}${stats.covered ? ` ${stats.covered} ${be(stats.covered)} covered at a higher level by broader skills,` : ""} and ${stats.removed} ${be(stats.removed)} not matched by any skill of ${to.code}.${
    stats.changedShare > REWRITTEN_SHARE
      ? " Most of the guide is different, so start with the domains below."
      : ""
  }</p>`;
  const same =
    stats.added +
      stats.removed +
      stats.reworded +
      stats.moved +
      stats.covered ===
      0 &&
    !stats.weightsChanged &&
    !diff.audience.changed;
  const html = same
    ? `<p>The skills measured, the domain weights and the audience profile are the same in both guides.</p>`
    : `${summary}${h("what-is-different-at-a-glance", "What is different at a glance")}${countsTable(diff, { matching: true })}${h("domains-compared", "Domains")}${domainSummary(diff, [fromShort, to.code], (d) => merged.sources.get(d.oldTitle ?? d.title) ?? "", area.wentTo)}${
        area.has
          ? `${h("how-the-areas-changed", "How the areas changed")}<p>Judged by reading the two guides side by side. Click an area to jump to it in the full guide below.</p>${area.table(fromShort)}${area.groupTable(fromShort) ? dropdown("Group by group", `<p>The same, one level down: how each group of ${fromShort} became a group of ${to.code}. A group marked Higher level is covered by broader skills: the skills of the old group that have no counterpart are shown as covered by it, not as removed.</p>${area.groupTable(fromShort)}`) : ""}`
          : ""
      }${dropdown("Show every difference", `${legend}${diffDoc(diff, diff.curLines, { audienceOpen: false, title: `${to.code} skills measured, compared to ${fromList}`, compare: area.has ? area.compare : null })}`)}`;
  return { note, html, headings };
}

/**
 * Everything the route needs for one exam: `{ title, description, tabs: [{ label, note?, html }],
 * headings, state }`. `now` decides what is current, upcoming and previous; `compare` adds the Compared to tab
 * (see compareTab).
 * @param {{ code: string, versions: any[] }} history
 * @param {{ now?: Date, compare?: { from: { code: string, history: any }[], to: { code: string, history: any }, retirements?: { code: string, date: string }[], blurb?: string, titleThreshold?: number } | null }} [options]
 */
export function buildChangePage(
  history,
  { now = new Date(), compare = null } = {},
) {
  const code = history.code;
  const title = `${code} Study Guide Changes`;
  const description = `What changed in the ${code} study guide, shown in place, with the current, upcoming and previous versions side by side.`;
  if (!history.versions.length)
    return {
      code,
      title,
      description,
      tabs: [
        {
          label: "Changes",
          note: "<p><strong>We have not recorded this study guide yet.</strong> The study guides of the exams the hub covers are recorded every day; once this exam's guide has been recorded, what changes in it appears here.</p>",
          html: "<p>Until then, the official guide is linked above.</p>",
        },
      ],
      headings: [],
      state: null,
    };
  const st = versionState(history, now);
  const tabs = [];
  const changes = changesTab(history, st);
  tabs.push({ label: "Changes", note: changes.note, html: changes.html });
  const comparison = compare ? compareTab(compare, now) : null;
  if (comparison) {
    const other = compare.from.some((f) => f.history === history)
      ? compare.to.code
      : compare.from.map((f) => f.code).join(" + ");
    tabs.push({
      label: `Compared to ${other}`,
      note: comparison.note,
      html: comparison.html,
    });
  }

  if (st.current) {
    const until = st.upcoming
      ? `Applies to exams taken until ${prettyDate(dayBefore(st.upcoming.asOf))}.`
      : st.current.asOf
        ? `Microsoft's page labels this version "as of ${prettyDate(st.current.asOf)}".`
        : `The version we first saw on ${prettyDate(st.current.firstSeen)}. Microsoft states no effective date for it.`;
    tabs.push({
      label: "Current",
      html: `<p>${until}</p>${plainDoc(st.current.lines)}`,
    });
  }
  if (st.upcoming)
    tabs.push({
      label: "Upcoming",
      html: `<p>Applies to exams taken from ${prettyDate(st.upcoming.asOf)}. First seen on ${prettyDate(st.upcoming.firstSeen)}. This is the version on Microsoft's page today.</p>${plainDoc(st.upcoming.lines)}`,
    });
  if (st.previous) {
    const intro =
      st.previousSource === "onPage"
        ? `The version Microsoft's page lists as "prior to ${st.previous.asOf ? prettyDate(st.previous.asOf) : "the current version"}".`
        : `${st.previous.asOf ? `Dated ${prettyDate(st.previous.asOf)}. ` : ""}First recorded on ${prettyDate(st.previous.firstSeen)}; replaced on ${prettyDate((st.current ?? st.upcoming).firstSeen)}.`;
    tabs.push({
      label: "Previous",
      html: `<p>${intro}</p>${plainDoc(st.previous.lines)}`,
    });
  }
  tabs.push({ label: "History", html: historyTab(history) });

  return {
    code,
    title,
    description,
    tabs,
    headings: [...changes.headings, ...(comparison?.headings ?? [])],
    state: st,
  };
}
