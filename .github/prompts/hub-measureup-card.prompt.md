---
name: "Hub: MeasureUp Card Component"
description: "Create a shared <MeasureUpCard> component for the repeated MeasureUp practice-test block on exam pages."
agent: agent
argument-hint: "Optional: which pages to migrate first (default AZ-800 + PL-200)."
---

# Task: Shared <MeasureUpCard> component

Every exam page repeats the same ~12-line MeasureUp block at the bottom, plus the same MeasureUp
cards in the `Tests` tab. The only things that vary are the two MeasureUp product URLs. Extract this
into a component so the boilerplate (paragraph, subscriptions link, discount notice) is defined once.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX. Package manager **pnpm**. Build: `pnpm build` = `astro check && astro build`; preview: `pnpm dev`.
- **Exam pages:** `src/content/docs/<area>/<CODE>.mdx`; routes lower-case (`/azure/az-800/`).
- **Local components** live in `src/components/*.astro`. MDX can `import` and use `.astro` components.
- **The repeated block** (see the bottom of `src/content/docs/azure/AZ-800.mdx` and `src/content/docs/power/PL-200.mdx`):
  ```mdx
  <Card title="MeasureUp Practice Tests" icon="open-book">
  <CardGrid>
    <LinkCard title="MeasureUp Assessment" href="<assessmentUrl>#u44" target="_blank"/>
    <LinkCard title="MeasureUp Practice Test" href="<practiceTestUrl>#u44" target="_blank"/>
  </CardGrid>
    <LinkCard title="MeasureUp Subscriptions" href="https://www.measureup.com/subscription-plans-for-individuals#u44" target="_blank"/>
    Official Microsoft Practice tests. They are expensive but ... (standard paragraph) ...
    <Aside type="tip">Use our code **MSFTHUB** for an exclusive 15% discount on the MeasureUp store!</Aside>
  </Card>
  ```
  The same two MeasureUp cards (Assessment + Practice Test) also appear inside the `Tests` `TabItem`.
- **Invariants:** the Subscriptions URL, the standard paragraph, the `MSFTHUB` discount `<Aside>`, and the `#u44` fragment are **constant** across all pages. Only `assessmentUrl` and `practiceTestUrl` change per exam (they embed the exam-name slug).

## What to do
1. **`<MeasureUpCard>`** (in `src/components/`) — the bottom block — with props `assessmentUrl` and `practiceTestUrl`. Hard-code the constant Subscriptions URL, paragraph, and the `MSFTHUB` discount `<Aside>` inside the component. Ensure the `#u44` fragment is always present (append it if a passed URL lacks it). Import `Card, CardGrid, LinkCard, Aside` from `@astrojs/starlight/components`.
2. **(Optional) `<MeasureUpTabCards>`** — the Assessment + Practice Test pair used inside the `Tests` tab — same two URL props, so a page declares the URLs once.
3. **Migrate 2 pilot pages** (default `AZ-800`, `PL-200`), copying the **existing** MeasureUp URLs from each page verbatim. Do not fabricate product slugs — MeasureUp pages geo-redirect but exist; reuse what's already on the page.
4. **Verify:** `pnpm dev` to confirm identical rendering; `pnpm build` (`astro check`) must pass.

## Composition note
This component is a building block for the larger `<ExamPage>` refactor (separate prompt). Keep its
API small and data-only so `<ExamPage>` can render it from exam data later.

## Ground rules
- **Never invent** MeasureUp URLs/slugs — copy existing ones during migration.
- Always preserve `#u44` and the `MSFTHUB` discount notice.
- Edit with the editor, not terminal redirection. Re-read files right before editing.
- Keep rendered output identical. Don't create markdown docs to summarize work.

## Done when
- `<MeasureUpCard>` exists in `src/components/` and is used on at least `AZ-800` and `PL-200` with identical output.
- The constant copy + `MSFTHUB`/`#u44` are centralized in the component.
- `pnpm build` passes.
