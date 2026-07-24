---
name: "Hub: Retirement/Beta Banner Components"
description: "Create shared <RetirementBanner> and <BetaBanner> components to standardize exam retirement/beta notices."
agent: edit
argument-hint: "Optional: which pages to migrate as examples (default AZ-800 retirement + AZ-802 beta)."
---

# Task: Shared <RetirementBanner> / <BetaBanner> components

Retirement and beta notices are currently hand-written `:::caution` admonitions on each exam page.
They have drifted: wrong dates, stale/placeholder replacement names, redundant lines, missing
cross-links, and (in a few cases historically) invented replacement exams. Replace them with two
small components that enforce one consistent, correct format.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX. Package manager **pnpm**. Build: `pnpm build` = `astro check && astro build`; preview: `pnpm dev`.
- **Exam pages:** `src/content/docs/<area>/<CODE>.mdx` (`<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`); routes are lower-case (`/azure/az-800/`).
- **Local components** live in `src/components/*.astro`. MDX can `import` and use `.astro` components.
- **Current banner format** (see `src/content/docs/azure/AZ-800.mdx` and `src/content/docs/power/PL-200.mdx`) — a `:::caution` block containing, in order:
  1. A retirement sentence + date (e.g. "The exam is being retired on September 30, 2026."). Some say the **certification remains/renewable** even though the exam retires — that distinction matters and must be preserved.
  2. "It will be replaced by `[CODE: Name](/area/code/)`." (a Markdown link — these **do** render inside admonitions/components).
  3. A beta line (e.g. "AZ-802 is coming to beta in June 2026." / "AB-410 entered beta in April 2026.").
  4. The reassurance line: "Microsoft Learn always takes a while to update with certification retirements so don't panic if you can't see it there yet."
- Starlight renders `:::caution` as `<Aside type="caution">`; `:::note` as `<Aside type="note">`. Importing `Aside` from `@astrojs/starlight/components` lets a component emit the same box.

## What to do
1. **`<RetirementBanner>`** (in `src/components/`) with props such as:
   - `retireDate` (string), `certRetires` (boolean — true = exam **and** certification retire; false = exam retires but cert remains/renewable),
   - `replacementCode`, `replacementName`, `replacementArea` (or a full `replacementHref`) → builds the `/area/code/` Markdown-style link,
   - optional `betaDate`, optional `note`.
   It should render an `<Aside type="caution">` with the four-part structure above, including the working internal link and the reassurance line. Allow "no direct replacement" gracefully (omit the replacement sentence).
2. **`<BetaBanner>`** with props like `code`, `name`, `betaDate`/`betaSince`, optional `note` → renders an `<Aside type="note">` (or `caution`) indicating the exam is in beta / upcoming. Reference page: `src/content/docs/azure/AZ-802.mdx` (an UPCOMING exam).
3. **Migrate the example pages** (default `AZ-800` retirement and `AZ-802` beta) to use the components, copying only the **existing verified** values from those pages. Keep the rendered box visually equivalent.
4. **Verify:** `pnpm dev` to confirm the banner (and its internal link) renders correctly; `pnpm build` (`astro check`) must pass.

## Important cross-source note
The sidebar in `astro.config.mjs` carries **parallel** per-exam badges (`RETIRING` / `BETA` / `UPCOMING`). The component does **not** control the sidebar. While migrating, **flag any mismatch** between a page's banner and its sidebar badge (e.g. a page with a retirement banner but no `RETIRING` badge), but only change the sidebar if the user asks.

## Ground rules
- **Never invent** dates, replacement exams, or names. Use only values already present on the page; if a value looks wrong/unverifiable, flag it rather than guessing or "fixing" it here.
- Internal links must point to **existing** pages (`/area/code/` that resolves to a file in `src/content/docs/<area>/`).
- Edit with the editor, not terminal redirection. Re-read files right before editing.
- Keep output equivalent; don't redesign the admonition. Don't create markdown docs to summarize work.

## Done when
- `<RetirementBanner>` and `<BetaBanner>` exist in `src/components/`.
- At least one retirement page (`AZ-800`) and one beta/upcoming page (`AZ-802`) use them, rendering equivalent boxes with working internal links.
- Any banner↔sidebar-badge mismatches are reported.
- `pnpm build` passes.
