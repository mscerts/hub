---
name: "Hub: Related Certifications Block"
description: "Add a consistent 'Related certifications / learning pathway' cross-link block to exam pages."
agent: edit
argument-hint: "Optional: which area/pages to pilot first (default: Security or Azure AI)."
---

# Task: "Related certifications / pathway" cross-link block

Add a consistent block that links each exam to its **related certifications** — fundamentals →
associate → expert progressions, prerequisites, and sibling exams — to improve navigation. This
extends the cross-linking already added inside retirement banners.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX. Package manager **pnpm**. Build: `pnpm build` = `astro check && astro build`; preview: `pnpm dev`.
- **Exam pages:** `src/content/docs/<area>/<CODE>.mdx`; `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`. Routes are lower-case (`/azure/az-104/`).
- **The set of existing exam pages** = the files under `src/content/docs/<area>/` and the entries in the hand-maintained sidebar in `astro.config.mjs`. Only link to pages that actually exist.
- **Local components** live in `src/components/*.astro` (e.g. `VoucherList.astro`, `WikiList.astro`) — match their conventions. Small shared data/maps live under `src/data_files/` (e.g. `constants.ts`). MDX can import `.astro` components.
- Markdown links work inside Starlight components/admonitions, e.g. `[AZ-305: ...](/azure/az-305/)`.

## What to do
1. **Build `<RelatedCerts>`** (in `src/components/`) that takes an array of related exams — e.g. `items={[{ code: "AZ-104", name: "...", area: "azure" }, ...]}` — and renders a compact, clearly-labelled block (heading like "Related certifications" or "Learning pathway") of internal links to `/area/code/`. Keep it visually consistent with existing cards (consider `<LinkCard>`/`<CardGrid>` from `@astrojs/starlight/components`). Optionally show the relationship type (prerequisite / next step / sibling).
2. **(Optional) central relationship map.** Instead of hand-listing on every page, consider a map keyed by exam code in `src/data_files/` (e.g. `related.ts`) so relationships live in one place; the component looks up the current code. Start simple if that's faster.
3. **Pilot on one area first** (default Security or Azure AI) to nail the format and placement (top vs bottom of the page), then expand. Example relationships to model (verify each target page exists before linking):
   - Security: `SC-900` (fundamentals) → `SC-200` / `SC-300` / `AZ-500` (associate) → `SC-100` (expert).
   - Azure AI: `AI-900` (fundamentals) → `AI-102` (associate).
   - Azure core: `AZ-900` → `AZ-104` → `AZ-305`.
4. **Respect retirements:** when an exam is retiring, point "next step" relationships at the **successor** exam where appropriate (cross-check the page's retirement banner).
5. **Verify:** every link resolves to an existing page; `pnpm build` (`astro check`) passes; `pnpm dev` shows the block rendering with working links.

## Ground rules
- **Only link to pages that exist.** Do not link an exam that has no page — verify each target file exists under `src/content/docs/<area>/` before linking.
- Don't invent certification relationships — base them on real Microsoft role-based paths (fundamentals/associate/expert) and prerequisites.
- Edit with the editor, not terminal redirection. Re-read files right before editing.
- Keep placement and styling consistent across pages. Don't redesign the pages.
- Don't create markdown docs to summarize work.

## Done when
- `<RelatedCerts>` (and optional relationship map) exists in `src/components/` / `src/data_files/`.
- A pilot area's pages render the block with **only valid** internal links, placed consistently.
- `pnpm build` passes. A short note describes how to add relationships for more pages.
