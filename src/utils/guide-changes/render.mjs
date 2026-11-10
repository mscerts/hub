// The Study Guide Changes page of one exam, as HTML, from its history. Pure: the Astro route
// (src/pages/certs/changelog/[code].astro) only places the result. Runbook: docs/study-guide-changes.md.
import { parseGuide } from "../../../scripts/lib/course-guide.mjs";
import { audienceLines, diffVersions, changeKind, entryKind } from "./diff.mjs";
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

/** The HTML of one aligned entry: unchanged, reworded in place, added or removed. */
function entryHtml(entry, strip = (s) => s) {
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

const domainHead = (domain) => {
  const { old: oldWeight, new: newWeight } = domain.weights;
  if (domain.status === "added")
    return ins(`${domain.title} (${range(newWeight)})`);
  if (domain.status === "removed")
    return del(`${domain.title} (${range(oldWeight)})`);
  const a = range(oldWeight);
  const b = range(newWeight);
  return `${esc(domain.title)} (${a === b ? a : `${del(a)} ${ins(b)}`})`;
};

/** The skills part of a comparison: glance list and the domains, with the differences in place. */
function diffSkills(diff) {
  const glance = `<ul>${diff.domains.map((d) => `<li>${domainHead(d)}</li>`).join("")}</ul>`;
  const body = diff.domains
    .map(
      (d) =>
        `<h4>${domainHead(d)}</h4>${d.groups
          .map((g) => {
            const head =
              g.status === "added"
                ? ins(g.title)
                : g.status === "removed"
                  ? del(g.title)
                  : esc(g.title);
            return `<h5>${head}</h5><ul>${g.items.map((item) => `<li>${entryHtml(item)}</li>`).join("")}</ul>`;
          })
          .join("")}`,
    )
    .join("");
  return { glance, body };
}

const LEGEND = `${ins("Green underlined")} text was added or reworded. ${del("Red strikethrough")} text was removed or replaced. Everything else is unchanged. This is the whole study guide, so you can see each change in place.`;

function diffDoc(diff, titleLines, { audienceOpen }) {
  const { glance, body } = diffSkills(diff);
  return guideDoc({
    title: titleOfLines(titleLines),
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

function domainSummary(diff) {
  const cell = (weight, skills) =>
    `${nowrap(range(weight))} · ${skills} skills`;
  const skillsOf = (domain, side) =>
    domain.groups.reduce(
      (n, g) =>
        n +
        g.items.filter((i) =>
          side === "old" ? i.old !== undefined : i.new !== undefined,
        ).length,
      0,
    );
  const ordered = [
    ...diff.domains.filter((d) => d.status !== "removed"),
    ...diff.domains.filter((d) => d.status === "removed"),
  ];
  return table(
    ["Domain", "Before", "Now"],
    ordered.map((d) => [
      d.status === "added"
        ? ins(d.title)
        : d.status === "removed"
          ? del(d.title)
          : esc(d.title),
      d.weights.old ? cell(d.weights.old, skillsOf(d, "old")) : "–",
      d.weights.new
        ? `<strong>${cell(d.weights.new, skillsOf(d, "new"))}</strong>`
        : "–",
    ]),
  );
}

function countsTable(diff) {
  const { stats, audience } = diff;
  return table(
    ["What", "Result"],
    [
      ["Skills added", `<strong>${stats.added}</strong>`],
      ["Skills removed", `<strong>${stats.removed}</strong>`],
      ["Skills reworded", `<strong>${stats.reworded}</strong>`],
      [
        "Skills in total",
        `<strong>${stats.totalNow}</strong> (was ${stats.totalBefore})`,
      ],
      [
        "Domain weights",
        stats.weightsChanged
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

/**
 * Everything the route needs for one exam: `{ title, description, tabs: [{ label, note?, html }],
 * headings, state }`. `now` decides what is current, upcoming and previous.
 */
export function buildChangePage(history, { now = new Date() } = {}) {
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
    headings: changes.headings,
    state: st,
  };
}
