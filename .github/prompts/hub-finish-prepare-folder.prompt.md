---
name: "Hub: Finish the prepare/ Folder"
description: "Complete the orphaned prepare/ how-to-prepare pages (fill the studymaterials stub) and wire them into navigation."
agent: edit
---

# Task: Complete & wire up the `prepare/` folder

The `prepare/` section (how-to-prepare guidance) exists but is unfinished and **orphaned** — it is not
in the sidebar and not linked from anywhere, and its main page is a stub. Finish the content and make
it reachable. (The old `guide/howtoprepare.mdx` page was deleted in favour of this folder.)

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX. Package manager **pnpm**. Build: `pnpm build` = `astro check && astro build`; preview: `pnpm dev`.
- **Content** lives in `src/content/docs/`. The **sidebar is hand-maintained** in `astro.config.mjs` (`starlight({ sidebar: [...] })`) — pages only appear in nav if added there. **Redirects** are in the same file under `redirects: { ... }`.
- **Existing guide pages** are in `src/content/docs/guide/` (Introduction, Overview, Scheduling an Exam, Certification Dashboard, Exam Experience, Opportunities for Students, Certification Renewal, Microsoft Partner Employees) — these are in the sidebar's "Certification Program Guide" group. Match their tone/structure.
- **The `/wiki` page** is the big curated list of study materials; `prepare/` pages should link out to `/wiki` and to relevant exam pages rather than duplicating everything.

## Current state of `src/content/docs/prepare/`
- `business.mdx`, `fundamentals.mdx`, `role-based.mdx`, `labs.mdx` — fleshed out (e.g. `fundamentals.mdx` has notes, study-time, "how to prepare" steps, links to `/wiki`). Review for completeness/consistency.
- `studymaterials.mdx` — **a STUB**: it has only headings (`## Text Resources` → `### Microsoft Learn` / `### Books`, `## Videos`, `## Practice Tests` → `### MeasureUp` / `### AI Generated Practice Tests`) and no body content. This is the main "navigating study materials" page and needs real content.
- The folder is **not referenced** in `astro.config.mjs` and **not linked** from any content (it's unreachable).

## What to do
1. **Fill the `studymaterials.mdx` stub** with real, verified content under its existing headings:
   - **Microsoft Learn** (official courses/modules), **Books**, **Videos** (e.g. Exam Readiness Zone), **MeasureUp** (mention the `**MSFTHUB**` 15% discount code and `#u44` links, consistent with exam pages), **AI Generated Practice Tests** (describe responsibly; **no exam dumps**). Keep the site's friendly, practical tone (see `fundamentals.mdx`).
2. **Review the other prepare pages** for completeness and consistency; fix obvious gaps/typos. Don't over-rewrite finished pages.
3. **Wire the folder into navigation** in `astro.config.mjs`: add a sidebar group (e.g. "How to Prepare") listing the prepare pages, **or** fold them into the existing "Certification Program Guide" group — pick whatever fits the IA best and is consistent. Also add sensible cross-links from the Guide pages and/or `/wiki` to these pages.
4. **Reconcile the deleted page's URL.** `guide/howtoprepare.mdx` was removed and there is currently **no redirect** for `/guide/howtoprepare/` (only `"/guide/officialstudymaterials/": "https://msfthub.com/wiki/"` exists). If `/guide/howtoprepare/` may have been public, add a redirect in `astro.config.mjs` (e.g. to `/prepare/studymaterials/` or `/wiki/`). Verify before adding.
5. **Verify:** `pnpm build` (`astro check`) passes; the prepare pages are reachable in `pnpm dev`; all internal links resolve.

## Ground rules
- **Never invent** URLs, course names, or facts — verify against official Microsoft Learn. No exam dumps.
- Keep tracking params (`?WT.mc_id=studentamb_165290`) and MeasureUp `#u44` + `MSFTHUB` where you add such links.
- Edit with the editor, not terminal redirection. Re-read files right before editing.
- Don't redesign finished pages; just complete/connect them. Don't create extra markdown docs to summarize work.

## Done when
- `studymaterials.mdx` (and any other stubs) contain real, verified content.
- The `prepare/` pages are reachable via the sidebar and/or in-content links.
- The `/guide/howtoprepare/` redirect is added if warranted.
- `pnpm build` passes and all internal links resolve.
