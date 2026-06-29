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

### URL Formats (normalized — preserve these)
- **Exam:** `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290`
- **Study guide:** `https://learn.microsoft.com/credentials/certifications/resources/study-guides/<code>?WT.mc_id=studentamb_165290`
- **Practice assessment:** `https://learn.microsoft.com/credentials/certifications/exams/<code>/practice/assessment?assessment-type=practice&assessmentId=<ID>&WT.mc_id=studentamb_165290`
- **No `/en-us/`** locale segments. Keep `?WT.mc_id=studentamb_165290` tracking params.
- **MeasureUp links** keep `#u44` fragment (code **MSFTHUB**).

### Exam Page Anatomy (canonical structure)
1. Frontmatter: `title: "<CODE> Study Materials"`, `description`
2. Imports from `@astrojs/starlight/components`: `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`
3. Optional `:::caution` retirement/beta banner
4. `<Card title="Get Started" icon="star">` → Exam link, Study Guide link, Exam Labs link
5. `<Tabs>` with `TabItem`s: Text, Videos, Tests, Paid, Misc
6. Closing `</Card>`, then bottom `<Card title="MeasureUp Practice Tests" icon="open-book">` block with `<Aside>` for MSFTHUB discount

### Components
- Local components live in `src/components/*.astro`
- MDX can import `.astro` components directly
- Use `@astrojs/starlight/components` for `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`

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

### Redirects
- Defined in `astro.config.mjs` under `redirects: { ... }`

---

## Content Rules

- **No exam dumps.** Ever.
- **No inventing** URLs, IDs, dates, names, or course titles. Verify against Microsoft Learn.
- Preserve all tracking params (`?WT.mc_id=studentamb_165290`, `#u44`).
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

Automated weekly check for new Microsoft practice tests on MeasureUp.

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
