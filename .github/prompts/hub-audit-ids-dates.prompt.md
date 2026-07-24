---
name: "Hub: Audit Assessment IDs & Dates"
description: "Audit every exam page's practice assessmentId, retirement/beta dates, names, descriptions, and URLs against official Microsoft Learn."
agent: edit
argument-hint: "Optional: limit to an area (e.g. azure) or a list of exam codes; default = all."
---

# Task: Audit assessment IDs, dates & metadata against official sources

A prior audit found ~5 wrong `assessmentId`s (copy-pasted from other exams), several wrong retirement
dates, and descriptions copy-pasted from the wrong exam. This task systematically verifies each exam
page's metadata against official Microsoft Learn and applies only **verified** corrections.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, https://msfthub.com. Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX. Package manager **pnpm**. Build: `pnpm build` = `astro check && astro build`.
- **Exam pages:** `src/content/docs/<area>/<CODE>.mdx`; `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`. Routes lower-case.
- **Sidebar is hand-maintained** in `astro.config.mjs` with per-exam badges (`RETIRING` / `BETA` / `UPCOMING`) — a **parallel source of truth** to the on-page banners.
- **URL conventions (normalized — keep them):**
  - Exam: `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290` (or cert-slug form `.../certifications/<cert-slug>?WT...`).
  - Study guide: `https://learn.microsoft.com/credentials/certifications/resources/study-guides/<code>?WT...`.
  - Practice assessment: `https://learn.microsoft.com/credentials/certifications/exams/<code>/practice/assessment?assessment-type=practice&assessmentId=<ID>&WT...`.
  - No `/en-us/` (or any) locale segment. Microsoft links keep `?WT.mc_id=studentamb_165290`; MeasureUp links keep `#u44` (code **MSFTHUB**).

## For each exam page, verify against official Microsoft Learn
1. **`assessmentId`** in the practice-assessment URL — open the exam's **official** practice assessment and confirm the numeric `assessmentId` matches. Wrong/duplicate IDs (copied from another exam) are the most common bug.
2. **Retirement / beta dates** in the `:::caution` banner — confirm against the official certification/exam page and study guide. Confirm the **replacement** exam is correct and its internal link `/area/code/` resolves to an existing page.
3. **Exam name / title** and the **frontmatter `description`** — confirm they describe *this* exam (catch text copy-pasted from a different exam).
4. **Exam URL & study-guide URL** — confirm they resolve and use the canonical normalized forms above.
5. **Sidebar vs banner consistency** — cross-check the badge in `astro.config.mjs` (`RETIRING`/`BETA`/`UPCOMING`) against the page's banner; flag mismatches (e.g. retirement banner present but no `RETIRING` badge, or a `BETA` badge with no beta note).

## How to work
- Process area-by-area (or the codes/area given in the argument). Use web search / page fetches against `learn.microsoft.com` to verify; do not rely on memory.
- **Produce a concise findings list**: `exam → field → current value → correct value → source URL`. Group by area.
- **Apply only verified corrections.** Where a value **cannot** be verified, **do not change it** — list it as "needs manual check." Don't guess.
- **Skip `GH-200`'s `assessmentId` (1001)** — the maintainer has confirmed it is correct; do not flag or change it.

## Ground rules
- **Never invent** IDs, dates, names, or URLs. Official Microsoft Learn is the only source of truth; if unverifiable, flag rather than change.
- **No exam dumps.**
- Preserve tracking params and the canonical URL forms.
- Edit with the editor, not terminal redirection. Re-read files right before editing (maintainers may have changed them).
- Don't create markdown docs to summarize work — report findings in chat.

## Done when
- Every targeted exam page is checked on all five points above.
- A grouped findings list is reported (current vs correct vs source).
- Verified corrections are applied; unverifiable items are clearly flagged for manual review.
- `pnpm build` (`astro check`) passes.
