---
name: "Hub: CI Link Checker"
description: "Add automated link-checking (broken/dead/malformed URLs) to CI for the mscerts/hub site."
agent: edit
argument-hint: "Optional: preferred tool (lychee or linkinator) and whether external checks should block PRs."
---

# Task: Add automated link-checking to CI

Add a GitHub Actions workflow that catches broken, dead, and malformed links automatically, so the
hand-fixing we currently do (dead links, domain-less `href`s, double-`?` URLs, wrong/retired exam
links) is caught by CI instead of by humans.

## Project context
- **Repo:** Microsoft Certification Hub — https://github.com/mscerts/hub, deployed at https://msfthub.com. A community site of free study-material collections for Microsoft certification exams.
- **Stack:** Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX content, Tailwind. Package manager: **pnpm** (see `pnpm-lock.yaml`).
- **Run/build:** `pnpm dev` (local preview); `pnpm build` = `astro check && astro build` → static output in `dist/`; `pnpm preview` serves the build.
- **Content lives in** `src/content/docs/**/*.mdx`. Internal links are Astro routes like `/azure/az-800/`, `/labs/azure/az-800/`, `/vouchers/...`, `/wiki`. These only resolve against the **built site**, so validating internal links by scanning raw MDX would produce false positives — crawl `dist/` (or `astro preview`) instead.
- **Redirects** are defined in `astro.config.mjs` under `redirects: { ... }` (e.g. `"/guide": "/guide/introduction"`). The checker must **follow redirects**.
- **Lots of external hosts:** `learn.microsoft.com`, `measureup.com`, `youtube.com`, `amzn.to` (affiliate), `pluralsight.com`, `udemy.com`, `linkedin.com/learning`, `whizlabs.com`, `comptia.org`, `esi.microsoft.com`. Some of these (LinkedIn, Udemy) routinely return 403/999 to bots even though the page is fine.

## What to do
1. **Pick a tool.** Recommended: **lychee** (`lycheeverse/lychee-action`) — fast, handles internal + external, redirects, excludes. `linkinator` (Node, crawls a running `astro preview`) is an acceptable alternative. Confirm the user's preference if given.
2. **Split into two concerns:**
   - **Internal link integrity** (blocking on PRs): build the site, then check that every internal/relative link resolves in `dist/`. This must be reliable and fast.
   - **External URL liveness** (non-blocking / scheduled): check external URLs on a weekly `cron` (and `workflow_dispatch`), since external hosts are flaky and rate-limited. Failing PRs on a transient LinkedIn 999 would be noise.
3. **Add the workflow** at `.github/workflows/link-check.yml`. Use `pnpm/action-setup` + `actions/setup-node` (Node 20, pnpm cache), `pnpm install --frozen-lockfile`, `pnpm build`, then run the checker against `./dist/**/*.html` with `--base ./dist` so relative routes resolve. A reasonable starting point (verify the action version before committing):
   ```yaml
   name: Link Check
   on:
     pull_request:
       paths: ["src/content/**", "astro.config.mjs", "src/**"]
     schedule:
       - cron: "0 6 * * 1" # weekly, Mon 06:00 UTC — external checks
     workflow_dispatch:
   ```
4. **Add an excludes/config file** (`lychee.toml` or `.lycheeignore`) with **commented** entries for hosts that block bots (e.g. `linkedin.com`, `udemy.com`) and for `mailto:`/anchor-only links. Accept `200/206/3xx`. Do **not** strip or rewrite tracking params (`?WT.mc_id=studentamb_165290`, MeasureUp `#u44`) — leave URLs intact.
5. **Baseline it.** Run the checker locally once (`pnpm build` then the checker) and **triage real breakages** before turning the gate on. Fix genuine broken internal links; add justified excludes (with comments) for false positives. Report anything ambiguous instead of guessing.
6. **Document** how to run it locally — a short "Link checking" note in `README.md` and/or a `package.json` script (e.g. `"check:links"`).
7. Consider having the scheduled external job **open an issue** on failure (e.g. via `lychee-action`'s output + `peter-evans/create-issue-from-file`) rather than failing silently.

## Ground rules
- **Never invent** URLs or excludes to make CI pass — fix real breaks, exclude only verifiably-flaky hosts (with a comment saying why).
- Edit/create files with the editor, not terminal redirection. Re-read files right before editing.
- Keep changes scoped to CI + minimal docs; don't refactor content.
- Don't create markdown files just to document your work (a short README section is fine).

## Done when
- `.github/workflows/link-check.yml` exists with a blocking internal-link job and a scheduled non-blocking external job.
- A config/ignore file with commented, justified excludes exists.
- The internal-link job passes on a clean baseline (after triaging current failures).
- README documents how to run it locally.
