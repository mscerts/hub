# Agent Instructions — Microsoft Certification Hub

> For AI coding agents working on this repository.
> Keep this file updated as the project evolves.

---

## Identity

You are working on **msfthub.com** — a community site providing free study-material collections for Microsoft certification exams. Be direct, efficient, and preserve the existing code style.

---

## Project Context

- **Repo:** https://github.com/mscerts/hub
- **Site:** https://msfthub.com
- **Stack:** Astro 6 + Starlight (`@astrojs/starlight` ^0.39), MDX, Tailwind
- **Package manager:** pnpm (do not use npm or yarn)
- **Build:** `pnpm build` = `astro check && astro build` → static output in `dist/`
- **Preview:** `pnpm dev` for local development

---

## Directory Structure

```
src/
├── components/
│   ├── sections/              # Landing page sections (features, testimonials, navbar&footer, misc)
│   ├── ui/
│   │   ├── starlight/        # Starlight component overrides (Head, SiteTitle, TableOfContents, etc.)
│   │   ├── banners/          # AnnouncementBanner, CookieConsentBanner
│   │   └── modals/           # CookieConsentModal
│   ├── WikiList.astro        # Auto-generates wiki cards by directory prefix
│   ├── VoucherList.astro     # Auto-generates voucher cards by voucherCategory frontmatter
│   ├── MarkdownContent.astro # Custom markdown wrapper
│   └── PartnerBadge.astro
├── content/
│   ├── docs/
│   │   ├── aibusiness/       # AI Business exam pages (AB-*)
│   │   ├── azure/            # Azure exam pages (AZ-*, AI-*, DP-*)
│   │   ├── dynamics/         # Dynamics 365 exam pages (MB-*)
│   │   ├── github/           # GitHub exam pages (GH-*)
│   │   ├── microsoft365/     # M365 exam pages (MS-*, MD-*)
│   │   ├── power/            # Power Platform exam pages (PL-*)
│   │   ├── security/         # Security exam pages (SC-*)
│   │   ├── guide/            # Certification program guide (8 pages)
│   │   ├── prepare/          # How-to-prepare pages (5 pages)
│   │   ├── vouchers/         # Discounted exam voucher pages
│   │   ├── labs/             # Lab collections (per-exam lab pages, parallel to exam structure)
│   │   └── wiki.mdx          # Wiki index page (uses WikiList component)
│   └── blog/                 # Blog collection (authors, pubDate, cardImage, readTime, tags)
├── data_files/
│   ├── constants.ts          # Site metadata (title, description, SEO, OG)
│   ├── faqs.json
│   ├── features.json
│   └── mega_link.ts
├── content.config.ts         # Content schemas (docs + blog collections)
astro.config.mjs              # Sidebar, redirects, integrations, component overrides
```

## Content Collections

### `docs` collection
Extends Starlight's `docsSchema` with one custom field:
```ts
voucherCategory: z.enum(["100%", "50%", "Special"]).optional()
```
Used by `VoucherList.astro` to auto-categorize voucher pages.

### `blog` collection
Schema: `title`, `description`, `authors` (array with name/image), `pubDate`, `updatedDate?`, `cardImage`, `cardImageAlt?`, `readTime`, `tags?`, `draft?`

---

## Conventions

### Exam Pages
- One MDX file per exam at `src/content/docs/<area>/<CODE>.mdx`
- Routes are lowercase: `/azure/az-800/`, `/power/pl-200/`
- Filenames are uppercase: `AZ-800.mdx`, `PL-200.mdx`
- `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`
- Area mapping: `azure` = AZ-*, AI-*, DP-*; `aibusiness` = AB-*; `dynamics` = MB-*; `github` = GH-*; `microsoft365` = MS-* and MD-*; `power` = PL-*; `security` = SC-*.
- Astro collection IDs preserve filename case (for example, `azure/AZ-800`), while rendered routes are lowercase.
- Frontmatter title is `<CODE> Study Materials`.
- Frontmatter description must use the exact template: `Collection of study materials for the certification exam <CODE>: <Exam Name>. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`
- Use the official exam name, not the certification name. Verify it against Microsoft Learn; these names often differ.
- Exam pages do not use `voucherCategory`.

### URL Formats (normalized — preserve these)
- **Exam (preferred when published):** `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290`
- Some beta/new exams use a certification slug instead of `/exams/<code>`; use Microsoft's verified current destination rather than forcing a URL pattern.
- **Study guide:** `https://learn.microsoft.com/credentials/certifications/resources/study-guides/<code>?WT.mc_id=studentamb_165290`
- **Practice assessment:** `https://learn.microsoft.com/credentials/certifications/exams/<code>/practice/assessment?assessment-type=practice&assessmentId=<ID>&WT.mc_id=studentamb_165290`
- **No `/en-us/`** locale segments. Keep `?WT.mc_id=studentamb_165290` tracking params.
- **MeasureUp links** keep `#u44` fragment (code **MSFTHUB**).
- **Training course:** `https://learn.microsoft.com/training/courses/<code>t00?WT.mc_id=studentamb_165290` only after verifying that the course exists.
- **Internal links:** lowercase paths with a leading slash and normally a trailing slash, for example `/labs/azure/az-800/`; preserve established top-level routes such as `/wiki`.
- Third-party links such as GitHub and YouTube do not receive Microsoft tracking parameters.
- Practice assessment IDs are exam-specific and have no reliable public registry; obtain and verify each ID from Microsoft Learn.

### Exam Page Anatomy (canonical structure)
1. Frontmatter: `title: "<CODE> Study Materials"`, `description`
2. Imports from `@astrojs/starlight/components`: `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`
3. Optional status banner: `:::tip` for beta/resource scarcity; `:::caution` for retirement and replacement details
4. `<Card title="Get Started" icon="star">` → Exam link, Study Guide link, and Exam Labs link only when the matching lab page exists
5. `<Tabs>` with `TabItem`s: Text, Videos, Tests, Paid, Misc
6. Closing `</Card>`, then bottom `<Card title="MeasureUp Practice Tests" icon="open-book">` block with `<Aside>` for MSFTHUB discount; if no products exist, use a tip stating that MeasureUp has not released material yet

Resource placement:
- **Text:** Official Learn courses/paths, documentation, and reputable written guides.
- **Videos:** Verified video courses, exam reviews, and directly relevant technical sessions.
- **Tests:** Free practice assessments and legitimate free tests.
- **Paid:** Paid courses, assessments, and practice-test products.
- **Misc:** Repositories, tools, communities, reference implementations, and supporting standards.
- Keep all five exam tabs, even if some are empty. Sparse beta pages are expected.
- If an announced official course is future-dated, include its verified availability date in the description.
- Retiring pages retain valid existing resources and link to the verified replacement exam.

### Lab Pages
- Files are lowercase at `src/content/docs/labs/<area>/<code>.mdx`; routes are `/labs/<area>/<code>/`.
- Required title: `<CODE> Labs`. When a description is present, use the verified exam name, for example: `Lab exercises for <CODE>: <Exam Name>. Includes Microsoft Learn and Microsoft GitHub labs.`
- No blank line before the closing frontmatter fence, between frontmatter and imports, or between `<Tabs>` and the first `<TabItem>`.
- Import only used Starlight components. Common imports are `LinkCard`, `CardGrid`, `Card`, `Tabs`, and `TabItem`.
- Canonical tab order: Applied Skills, Microsoft Learn, Microsoft GitHub. Guided Labs was removed and must not be reintroduced.
- Always preserve a commented-out tab placeholder when a category has no real resources; do not use an active empty tab or blank active `LinkCard` placeholder.
- Indent using two-space nesting: outer `<Tabs>` at column 0; `<TabItem>` and `<CardGrid>` at 2 spaces; `<LinkCard>` at 4 spaces. Add 2 spaces per nested Tabs level.
- Starlight directives (`:::note`, `:::tip`, `:::caution`) remain flush at column 0 even inside tabs.
- Strip trailing whitespace. Historical pages are not fully uniform, so normalize touched blocks only unless broad cleanup is requested.
- Preserve the known SC-900 setup `LinkCard` outside its `CardGrid`; it is an intentional out-of-scope legacy exception.
- Known verified resources: AZ-120 has three Learn exercises from `explore-azure-center-sap-solutions`; AZ-900 uses `MicrosoftLearning/AZ-900-Microsoft-Azure-Fundamentals`; SC-401 already includes `MicrosoftLearning/SC-401T00-Information-Security-Administrator`. Do not duplicate them.
- Old claims that AZ-140, MD-102, MS-102, MS-700, or SC-900 have zero Learn exercises are unverified and must not be relied on.

To discover genuine Microsoft Learn exercise units:
1. Fetch `https://learn.microsoft.com/training/courses/<code>t00` and read its `learn_item` learning-path UIDs.
2. Query `https://learn.microsoft.com/api/catalog/?uid=<comma-separated-path-uids>` to obtain each learning path's module UIDs.
3. Resolve each module's ordered `units` from the catalog.
4. Look up each unit object and test whether `unit.title` starts with `Exercise` (case-insensitive). Do not infer exercises from URL slugs; some exercise slugs do not contain that word.
5. Build the unit URL as `<module-base-url>/<1-based-unit-position>-<unit-slug>/?WT.mc_id=studentamb_165290`, remove `/en-us/`, and use the catalog's unit title as display text.

### Voucher Pages
- Files are lowercase slugs at `src/content/docs/vouchers/<slug>.mdx`; routes are `/vouchers/<slug>/`.
- Frontmatter requires `title`, `description`, and `voucherCategory`, with category exactly `"100%"`, `"50%"`, or `"Special"`.
- `VoucherList.astro` automatically includes categorized pages on the voucher index, sorted by title. The sidebar remains hand-maintained.
- Common content uses `LinkButton`, `Steps`, `CardGrid`, and Starlight directives. Use notes for the core offer, cautions/dangers for restrictions, and clear CTA buttons.
- Voucher sidebar badges show the discount. An asterisk (for example, `*80%`) indicates limited availability or conditions.

Beta voucher format:
1. Title `Exam <CODE> (beta)` and a concise discount description.
2. Import `LinkButton` and `Steps`.
3. Primary `Read Official Announcement` button.
4. `:::note` with candidate limit, deadline, discount, and code.
5. Short paragraph explaining the exam/certification.
6. `## How to claim the 80% discount` with registration, deadline, and code steps.
7. Closing `:::tip` covering first-come availability and country exclusions.
8. Add a caution when a verified scheduling URL is broken, with the working URL.
9. Add a secondary button to `/vouchers/betaexams/` for general beta-exam information.

Verify all voucher percentages, codes, limits, deadlines, exclusions, announcement links, and scheduling links from the official source. These facts are time-sensitive; do not record changing inventory totals in this file.

### Components
- Local components live in `src/components/*.astro`
- MDX can import `.astro` components directly
- Use `@astrojs/starlight/components` for `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`
- Do not nest `Card` components inside other cards.
- Use `CardGrid` for groups of `LinkCard`s. Empty grids are tolerated on canonical exam tabs but should not be introduced on lab tabs.
- External `LinkCard` and `LinkButton` targets use `target="_blank"`; internal links generally do not need it.
- `LinkCard` requires `title` and `href`; `description` is optional and should stay concise.
- For new exam tab blocks, prefer two-space increments (`TabItem` 2, `CardGrid` 4, `LinkCard` 6) without reformatting unrelated legacy content.

### Starlight Component Overrides
Defined in `astro.config.mjs` under `starlight({ components: { ... } })`:
- `SiteTitle` → `./src/components/ui/starlight/SiteTitle.astro`
- `Head` → `./src/components/ui/starlight/Head.astro` (meta, scripts, banners)
- `MobileMenuFooter` → `./src/components/ui/starlight/MobileMenuFooter.astro`
- `TableOfContents` → `./src/components/ui/starlight/TableOfContents.astro`
- `PageTitle` → `./src/components/ui/starlight/page-actions/PageTitle.astro`
- `MarkdownContent` → `./src/components/MarkdownContent.astro`

### Banner System
`AnnouncementBanner.astro` — dismissible banner with localStorage persistence (versioned via `version` prop).
Currently configured in `Head.astro` to promote AI/AB certifications, linking to `/wiki`.

### Key Dependencies
- **astro-vtbot** — View Transitions enhancement (used in Head.astro)
- **@astrojs/partytown** — Offloads analytics scripts to web worker
- **starlight-image-zoom** — Image zoom on Starlight pages
- **sharp** + **sharp-ico** — Image processing
- **preline** — UI components
- **tailwindcss v4** + **@tailwindcss/typography** + **@tailwindcss/forms**

### CSS
Custom CSS files (loaded conditionally via `NO_GRADIENTS` env var):
- `./src/landing.css` — Landing page styles
- `./src/custom.css` — Global custom styles
- `./src/assets/styles/starlight.css` — Starlight overrides

### Logo
- Light: `/src/images/logo_light.svg`
- Dark: `/src/images/logo_dark.svg`
- Favicon: `/favicon.svg`

### Sidebar
- **Hand-maintained** in `astro.config.mjs` under `starlight({ sidebar: [...] })`
- Pages only appear in nav if explicitly added there
- Per-exam badges: `RETIRING`, `BETA`, `UPCOMING`
- Keep exam entries in code order. GA exams have no badge; beta uses `{ text: "BETA", variant: "tip" }`; retiring uses `{ text: "RETIRING", variant: "danger" }`.
- Wiki pages are separate from the sidebar: `WikiList.astro` auto-discovers exam pages by area prefix, sorts collection IDs, and extracts a short name from the canonical exam-description template.
- `VoucherList.astro` filters docs by `voucherCategory`, sorts by title, and constructs `/${doc.id}/` routes.

### Redirects
- Defined in `astro.config.mjs` under `redirects: { ... }`
- Add redirects when exams are renamed/moved or certification structures change; retain legacy routes to avoid broken inbound links.

---

## Content Rules

- **No exam dumps.** Ever.
- **No inventing** URLs, IDs, dates, names, or course titles. Verify against Microsoft Learn.
- Preserve all tracking params (`?WT.mc_id=studentamb_165290`, `#u44`).
- Prefer official Microsoft resources and Microsoft-maintained GitHub repositories. Third-party resources must be reputable and directly relevant.
- Verify exact resource titles and destination URLs before adding them. Never infer labs, courses, assessment IDs, release dates, voucher details, or MeasureUp products from URL patterns alone.
- Keep rendered output identical when refactoring — don't redesign pages.
- Edit with the editor, not terminal redirection. Re-read files right before editing.

---

## Build & Verify

```bash
pnpm install --frozen-lockfile  # Install deps
pnpm build                      # astro check + astro build
pnpm dev                        # Local preview
```

- Build must pass with 0 errors before committing.
- `astro check` reports Zod deprecation hints (20 total) — these are upstream, ignore them.
- The build validates frontmatter/schema types, MDX syntax, TypeScript, collection uniqueness, and static rendering.
- The build does **not** validate external link availability, tracking parameters, assessment IDs, exam names, voucher accuracy, or duplicate content. Verify these manually against authoritative sources.
- When redirects change, test the old route against the dev server.
- Use `pnpm install --frozen-lockfile` for reproducible installs; commit `pnpm-lock.yaml` when dependencies change.

---

## Key Components

| Component | Purpose |
|-----------|---------|
| `WikiList.astro` | Auto-generates wiki cards by directory prefix |
| `VoucherList.astro` | Auto-generates voucher cards by `voucherCategory` frontmatter |
| `Head.astro` | Global head (meta, scripts, banner) |
| `MainLayout.astro` | Main layout wrapper |

---

## CI/CD

- **Platform:** Cloudflare Pages
- **Build command:** `pnpm build`
- **Output directory:** `dist`
- **Node version:** 20

---

## MeasureUp Monitor

Automated weekly check for new Microsoft practice tests on MeasureUp. I must add that it doesn't track bundles thanks to MeasureUp devs.

- **Workflow:** `.github/workflows/measureup-monitor.yml` — runs Monday 06:00 UTC + manual trigger
- **Script:** `scripts/measureup-check.sh` — scrapes all pages, compares against baseline
- **Baseline:** `src/data_files/measureup-products.json` — tracked product list (145 products as of 2026-06-29)
- **On new products:** Opens a GitHub issue with a table of new tests
- **On failure:** Opens a GitHub issue alerting that extraction broke (HTML structure change, site down, etc.)

### How it works
1. Fetches `measureup.com/microsoft.html` (all paginated pages)
2. Extracts product data from `dl4Objects` JavaScript variable (structured JSON, not HTML parsing)
3. Compares extracted product IDs against baseline
4. If new products found → GitHub issue with details
5. If extraction fails or >50% products are "new" → failure issue (likely HTML changed)
6. Updates baseline JSON after each run

### Failsafes
- `< 100` products extracted → fails and alerts
- `> 50%` products "new" → fails and alerts (HTML probably changed)
- Curl failures → retries 3x, skips page if still failing
- Corrupt baseline → fails and alerts

### Running locally
```bash
GITHUB_OUTPUT=/tmp/github-output bash scripts/measureup-check.sh
```

---

## Repository Memory

- Merge durable guidance from every `/memories/repo/` file into the relevant section of this `AGENTS.md` file.
- When adding or changing repository memory, update `AGENTS.md` in the same task and consolidate overlapping guidance instead of duplicating it.
- If a memory file conflicts with `AGENTS.md` or another memory file, ask the user which rule should take precedence before merging.
- Do not merge temporary `/memories/session/` notes unless the user explicitly promotes them to durable repository guidance.

---

## Task Prompts

Detailed improvement tasks are defined in `.github/prompts/`. Each prompt file contains:
- Project context and conventions
- Step-by-step instructions
- Ground rules and verification steps

Available prompts:
- `hub-audit-ids-dates` — Audit assessment IDs and dates against Microsoft Learn
- `hub-ci-link-check` — Add automated link checking to CI
- `hub-exam-page-component` — Data-driven exam pages
- `hub-finish-prepare-folder` — Complete orphaned prepare/ folder
- `hub-measureup-card` — Shared MeasureUp card component
- `hub-related-certs-block` — Related certifications cross-link block
- `hub-retirement-banner` — Shared retirement/beta banner components

Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
