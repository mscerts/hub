---
name: "Hub: Data-driven Exam Pages"
description: "Refactor the repeated exam-page MDX into a data-driven <ExamPage> component to eliminate copy-paste bugs."
agent: edit
argument-hint: "Optional: which exam(s) to migrate first (default AZ-800 + PL-200)."
---

# Task: Make exam pages data-driven

Today every exam page is hand-written MDX that duplicates the same structure. Almost every bug we
have found came from hand-copying: swapped course titles, descriptions copy-pasted from a different
exam, duplicate/incorrect `assessmentId`s, wrong cross-links, malformed URLs. Move the repeated
structure into a single component (plus typed data) so these bugs become structurally impossible.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX, Tailwind. Package manager **pnpm**.
- **Run/build:** `pnpm dev` (preview), `pnpm build` = `astro check && astro build`.
- **Exam pages:** one MDX per exam at `src/content/docs/<area>/<CODE>.mdx`, `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`. Filenames usually upper-case (`AZ-800.mdx`); routes lower-case (`/azure/az-800/`).
- **Local components** live in `src/components/*.astro` (e.g. `VoucherList.astro`, `WikiList.astro`) — match their conventions. MDX can import `.astro` components.
- **Reference page (canonical structure):** `src/content/docs/azure/AZ-800.mdx`. Anatomy:
  1. Frontmatter `title: "<CODE> Study Materials"`, `description`.
  2. Imports from `@astrojs/starlight/components` (`LinkCard, CardGrid, Card, Tabs, TabItem, Aside`).
  3. Optional `:::caution` retirement/beta banner.
  4. `<Card title="Get Started" icon="star">` → Exam link, Study Guide link, Exam Labs link.
  5. `<Tabs>` with `TabItem`s `Text`, `Videos`, `Tests`, `Paid`, `Misc` (each a mix of `<LinkCard>` and `<CardGrid>`).
  6. Closing `</Card>`, then a bottom `<Card title="MeasureUp Practice Tests" icon="open-book">` block ending in `<Aside type="tip">Use our code **MSFTHUB** ...</Aside>`.
- **URL conventions (already normalized repo-wide — keep them):**
  - Exam: `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290` (or cert-slug form `.../certifications/<cert-slug>?WT...`).
  - Study guide: `https://learn.microsoft.com/credentials/certifications/resources/study-guides/<code>?WT...`.
  - Practice assessment: `https://learn.microsoft.com/credentials/certifications/exams/<code>/practice/assessment?assessment-type=practice&assessmentId=<ID>&WT...`.
  - **No `/en-us/`** (or any) locale segment. Microsoft links carry `?WT.mc_id=studentamb_165290`; MeasureUp links carry `#u44` (code **MSFTHUB**).
- **Content schema** is in `src/content.config.ts` (the `docs` collection extends Starlight's `docsSchema` — it already adds `voucherCategory`). This is where new exam frontmatter fields would go.

## Recommended approach (incremental — do NOT mass-migrate blindly)
1. **Design the data shape.** Per exam capture: `code`, `name`, `area`, `examUrl` (or `certSlug`), `studyGuideUrl` (or derive from `code`), `assessmentId` (derive the practice URL), `labsPath`, optional `retirement`/`beta` info, and arrays for `text` / `videos` / `tests` / `paid` / `misc` resources (`{ title, href, description? }`). Decide between:
   - **(a) Components + frontmatter schema:** keep the MDX page but extend `docsSchema` in `src/content.config.ts` with the exam fields and render via `<ExamPage>` + subcomponents; or
   - **(b) Dedicated data collection:** `src/content/exams/*.yaml` + a generated route. Prefer **(a)** first — smaller blast radius.
2. **Build `<ExamPage>`** (in `src/components/`) that renders the Get Started card, the Tabs, and the MeasureUp block from data, **auto-applying** the canonical URL shapes and the `?WT.mc_id=studentamb_165290` / `#u44` params so individual pages can't omit them. Reuse `<RetirementBanner>` and `<MeasureUpCard>` if those components exist (see the related prompts); otherwise build minimal inline versions and leave a note.
3. **Migrate 2 pilot pages first** (default `AZ-800` and `PL-200`). Copy **every** existing resource link exactly — migration must be loss-less.
4. **Verify parity:** run `pnpm dev` and diff the rendered pilot pages against the originals (same links, same text, same order). Run `pnpm build` (`astro check`) — must pass.
5. Only after parity is confirmed, document "how to add a new exam" and (optionally) migrate the rest in batches, re-checking parity each batch.

## Ground rules
- **Never invent** URLs, IDs, dates, or course titles. When migrating, copy existing verified values; if a value looks wrong, flag it (don't silently change it here — that's the audit prompt's job).
- Preserve all tracking params and the canonical URL forms above.
- Edit with the editor, not terminal redirection. Re-read files right before editing.
- Keep the rendered output identical for migrated pages. Don't redesign the page.
- Don't create markdown docs to summarize your work.

## Done when
- `<ExamPage>` (+ any subcomponents) and the data shape/schema exist.
- `AZ-800` and `PL-200` are migrated with **identical** rendered output and all links preserved.
- Canonical URLs + tracking params are applied automatically by the component.
- `pnpm build` passes. A short "adding a new exam" note exists.
