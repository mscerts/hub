# Agent Instructions — Microsoft Certification Hub

> For AI coding agents working on this repository.
> Keep this file updated as the project evolves.

---

## Identity

You are working on **msfthub.com** — a community site providing free study-material collections for Microsoft certification exams. Be direct, efficient, and preserve the existing code style.

If you are an authorized agent, you will have access to the tasks repository which you should refer to.

---

## Project Context

- **Repo:** https://github.com/mscerts/hub
- **Site:** https://msfthub.com
- **Stack:** Astro 7, native MDX content collections, Tailwind
- **Package manager:** pnpm (do not use npm or yarn)
- **Build:** `pnpm build` = Astro checks, static build, and Pagefind indexing → output in `dist/`
- **Preview:** `pnpm dev` for local development

---

## Directory Structure

```
src/
├── components/
│   ├── sections/              # Landing page sections (features, testimonials, navbar&footer, misc)
│   ├── docs/                 # Docs shell, navigation, templates, and MDX components
│   ├── ui/                   # Shared site UI
│   ├── WikiList.astro        # Auto-generates wiki cards by directory prefix
│   ├── VoucherList.astro     # Auto-generates voucher cards by voucherCategory frontmatter
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
│   └── blog/                 # Blog collection (authors, pubDate, cardImage, readTime, tags)
├── pages/certs/               # Canonical wiki index, docs renderer, and Markdown endpoint
├── data_files/
│   ├── constants.ts          # Site metadata (title, description, SEO, OG)
│   ├── faqs.json
│   ├── features.json
│   ├── learn-catalog.json    # Cache of MS Learn modules (see Learn Catalog Cache section)
│   ├── docs-catalog.json     # Cache of MS Learn docs pages (see Docs Catalog Cache section)
│   └── mega_link.ts
├── content.config.ts         # Content schemas (docs + blog collections)
astro.config.mjs              # Redirects and Astro integrations
```

## Content Collections

### `docs` collection
Uses the local schema in `src/content.config.ts`, including:
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
- **Internal links:** canonical docs paths start with `/certs/`, use lowercase, and normally have a trailing slash, for example `/certs/labs/azure/az-800/`.
- Third-party links such as GitHub and YouTube do not receive Microsoft tracking parameters.
- Practice assessment IDs are exam-specific and have no reliable public registry; obtain and verify each ID from Microsoft Learn.

### Exam Page Anatomy (canonical structure)
1. Frontmatter: `title: "<CODE> Study Materials"`, `description`
2. Imports from `@components/docs`: `LinkCard`, `CardGrid`, `Card`, `Tabs`, `TabItem`, `Aside`
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
- Files are lowercase at `src/content/docs/labs/<area>/<code>.mdx`; routes are `/certs/labs/<area>/<code>/`.
- Required title: `<CODE> Labs`. When a description is present, use the verified exam name, for example: `Lab exercises for <CODE>: <Exam Name>. Includes Microsoft Learn and Microsoft GitHub labs.`
- No blank line before the closing frontmatter fence, between frontmatter and imports, or between `<Tabs>` and the first `<TabItem>`.
- Import only used docs components from `@components/docs`. Common imports are `LinkCard`, `CardGrid`, `Card`, `Tabs`, and `TabItem`.
- Canonical tab order: Applied Skills, Microsoft Learn, Microsoft GitHub. Guided Labs was removed and must not be reintroduced.
- Always preserve a commented-out tab placeholder when a category has no real resources; do not use an active empty tab or blank active `LinkCard` placeholder.
- Design/architect-tier exams whose only real hands-on resource is a case-study collection (not sandboxed exercises) should not get a lab page at all — link only the case-study collection from the exam page's Get Started card, no `Exam Labs` LinkCard. Confirmed: AZ-305 (case studies at `microsoftlearning.github.io/AZ-305-DesigningMicrosoftAzureInfrastructureSolutions`), SC-100 (case studies at `github.com/Azure/AzureArchitectureExampleScenarios`), and AB-100 (Agentic AI Business Solutions Architect — no case-study collection exists yet either, just conceptual course content) — all three had lab pages removed for this reason. Check for an existing "Exam/GitHub Case Studies" LinkCard, or confirm no genuine hands-on content exists, before creating a lab page for any new design/architect-tier exam.
- Indent using two-space nesting: outer `<Tabs>` at column 0; `<TabItem>` and `<CardGrid>` at 2 spaces; `<LinkCard>` at 4 spaces. Add 2 spaces per nested Tabs level.
- Docs directives (`:::note`, `:::tip`, `:::caution`) remain flush at column 0 even inside tabs.
- Strip trailing whitespace. Historical pages are not fully uniform, so normalize touched blocks only unless broad cleanup is requested.
- Preserve the known SC-900 setup `LinkCard` outside its `CardGrid`; it is an intentional out-of-scope legacy exception.
- Known verified resources: AZ-120 has three Learn exercises from `explore-azure-center-sap-solutions`; AZ-900 uses `MicrosoftLearning/AZ-900-Microsoft-Azure-Fundamentals`; SC-401 already includes `MicrosoftLearning/SC-401T00-Information-Security-Administrator`; the Azure Monitor Lab (Learn labs index) is a good cross-fit for monitoring-heavy Azure exams and is already used on AZ-104, AZ-204, AZ-500, AZ-700, and AZ-801. Do not duplicate them.
- More known verified GitHub repos (all under `MicrosoftLearning`, GitHub Pages exercise index at `microsoftlearning.github.io/<repo>/`): AI-901 uses `mslearn-ai-fundamentals` (current successor to the archived `AI-900-AIFundamentals`); AI-200 uses `mslearn-azure-ai`; AI-500 uses `mslearn-ai-multi-agents`; SC-500 uses `mslearn-sec-identity`; AB-900 uses `Administer-and-Secure-agents-with-Microsoft-Agent-365`. When a repo has been superseded (older repo's README says "please use \<new-repo\>"), always use the new one. GitHub's own certifications (GH-*) do not have dedicated GitHub-org lab repos — their official prep path is Microsoft Learn only (per `resources.github.com/learn/certifications/`); do not invent one. Only two GitHub-tagged Applied Skills exist as of this writing: "Accelerate app development by using GitHub Copilot" (matches GH-300) and "Automate Azure Load Testing by using GitHub Actions" (matches GH-200).
- When searching GitHub for a course's lab repo, `github.com/search?q=...` rate-limits quickly (HTTP 429); prefer `github.com/orgs/MicrosoftLearning/repositories?q=<term>` instead, which is not rate-limited and searches the same repo set by keyword.
- Old claims that AZ-140, MD-102, MS-102, MS-700, or SC-900 have zero Learn exercises are unverified and must not be relied on.

### Lab Page Workflow
- Start from the nearest existing lab page for the same exam family or area, then match its structure instead of inventing a new layout.
- Create or edit lab pages to stay consistent with the canonical lab format used across the repo: frontmatter, imports, optional note, then `<Tabs>` with the established tab order.
- Keep descriptions aligned to the verified exam name and the exam-focused wording used elsewhere in the repository.
- Add only resources that are verified on Microsoft Learn or Microsoft-owned GitHub pages; do not infer labs, courses, or workshop titles from URL patterns alone.
- When a Microsoft Learn module/exercise is itself just a wrapper around a specific GitHub repo (the Learn page's setup/instructions point to and are based on that same repo), link the Learn version only, not the GitHub repo directly — don't list the same lab twice across the Microsoft Learn and Microsoft GitHub tabs. Only add a separate Microsoft GitHub entry when the repo is a genuinely distinct resource (no matching Learn wrapper exists for it).
- When a tab has no real content, comment out the entire tab block if the surrounding pages use that pattern; do not leave an active empty tab or an empty `CardGrid` unless the page already uses that convention and the task explicitly requires preserving it.
- Keep notes short and functional. Use `:::note` for availability or context, `:::tip` for light guidance, and `:::caution` for retirements, gaps, or replacement exams.
- Preserve existing links and wording when normalizing formatting. Make focused edits only in the touched block rather than reformatting the whole page.
- After creating or materially changing a lab page, link it from the matching exam page with an `Exam Labs` card only when the lab page actually exists.
- Validate every lab-page edit with `pnpm build` before finishing.

To discover genuine Microsoft Learn exercise units:
1. Fetch `https://learn.microsoft.com/training/courses/<code>t00` and read its `learn_item` learning-path UIDs.
2. Query `https://learn.microsoft.com/api/catalog/?uid=<comma-separated-path-uids>` to obtain each learning path's module UIDs.
3. Resolve each module's ordered `units` from the catalog.
4. Test each unit against the hands-on syntax below. Do not infer exercises from URL slugs; some exercise slugs do not contain the word "exercise".
5. Build the unit URL as `<module-base-url>/<1-based-unit-position>-<unit-slug>/?WT.mc_id=studentamb_165290`, remove `/en-us/`, and use the catalog's unit title as display text. **Caveat**: the catalog's `units` array position does not always match the real live-page URL number — some modules have hidden/non-sequential units in their live nav (numbering can skip a value, e.g. 1,2,3,5,6,7,8,9) that the catalog silently compresses into a gapless array, shifting every position from the gap onward. When adding a brand-new reference or resolving any doubt/conflict, cross-check by fetching the module's own index page (`https://learn.microsoft.com/training/modules/<slug>/`) — its nav list shows the real numbered slugs directly — rather than trusting the catalog's bare position number alone.

**Hands-on unit/module syntax** (verified 2026-08-29 against all ~27,000 cached unit titles — see `src/data_files/learn-catalog.json`):
- Primary signal: `unit.title` contains the whole word `Exercise` **anywhere** (case-insensitive), not just as a prefix — real titles include `Exercise - X`, `Exercise – X` (en dash), `Optional exercise - X`, `Hands-on exercise - X`, and suffix forms like `X exercise`/`X Exercise`. A prefix-only check misses ~3% of genuine exercises.
- Secondary signal: `unit.title` **starts with** `Lab` or `Simulation` followed by a separator (space, colon, or dash/en dash/em dash), e.g. `Lab - Configure...`, `Simulation - Create...`. Do not match these words anywhere in the title (bare "lab"/"simulation" appear often in non-hands-on reading content, e.g. "Understand DLP...simulation mode").
- Module-level override: if the **module's own title** starts with `Guided Project` or `Challenge Project`/`Challenge project` (any dash variant), treat every unit in that module as hands-on — these are whole modules structured as a single guided build, not individual "Exercise"-titled steps.
- Rejected as too noisy after sampling (majority of hits were unrelated reading content, not hands-on): bare `Practice` (almost always "best practices"), bare `Challenge` outside the module-title override (mostly topical "challenges" discussions), `Sandbox`, `Workshop` as a unit-level signal (an "Online workshop" *module* is just a title label — its own units still use the normal `Exercise -` pattern, so no extra rule is needed).
- Fallback for the rare unit whose title didn't resolve in the catalog (falls back to its raw uid in the cache): check whether the uid contains `.exercise-`.
- **Applied Skills are a separate content type**, not part of this modules/units catalog at all — they live under `https://learn.microsoft.com/credentials/applied-skills/<slug>` (a distinct URL namespace, inherently hands-on by definition, no title-pattern matching needed). Don't expect to find them in `learn-catalog.json`; discover and verify them the normal way (search Microsoft Learn directly) for the Applied Skills tab.

### Voucher Pages
- Files are lowercase slugs at `src/content/docs/vouchers/<slug>.mdx`; routes are `/certs/vouchers/<slug>/`.
- Frontmatter requires `title`, `description`, and `voucherCategory`, with category exactly `"100%"`, `"50%"`, or `"Special"`.
- `VoucherList.astro` automatically includes categorized pages on the voucher index, sorted by title. The sidebar remains hand-maintained.
- Common content uses `LinkButton`, `Steps`, `CardGrid`, and docs directives. Use notes for the core offer, cautions/dangers for restrictions, and clear CTA buttons.
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
9. Add a secondary button to `/certs/vouchers/betaexams/` for general beta-exam information.

Verify all voucher percentages, codes, limits, deadlines, exclusions, announcement links, and scheduling links from the official source. These facts are time-sensitive; do not record changing inventory totals in this file.

### Components
- Local components live in `src/components/*.astro`
- MDX can import `.astro` components directly
- Use the `@components/docs` barrel for docs components.
- Do not nest `Card` components inside other cards.
- Use `CardGrid` for groups of `LinkCard`s. Empty grids are tolerated on canonical exam tabs but should not be introduced on lab tabs.
- External `LinkCard` and `LinkButton` targets use `target="_blank"`; internal links generally do not need it.
- `LinkCard` requires `title` and `href`; `description` is optional and should stay concise.
- For new exam tab blocks, prefer two-space increments (`TabItem` 2, `CardGrid` 4, `LinkCard` 6) without reformatting unrelated legacy content.

### Docs Rendering
- `/certs/` is owned by `src/pages/certs/index.astro`.
- `/certs/<content-id>/` is rendered by `src/pages/certs/[...slug].astro` through `DocsPage.astro` and `DocsShell.astro`.
- Legacy content paths and `/wiki-next/*` redirect permanently to `/certs/*`.
- `remark-callouts.mjs` converts `:::note`, `:::tip`, `:::caution`, and `:::danger` directives to the local `Aside` component.

### Banner System
`AnnouncementBanner.astro` — dismissible banner with localStorage persistence (versioned via `version` prop).
Rendered by `MainLayout.astro` when enabled.

### Key Dependencies
- **@astrojs/mdx** + **@astrojs/markdown-remark** — MDX and Unified remark processing
- **sharp** + **sharp-ico** — Image processing
- **preline** — UI components
- **tailwindcss v4** + **@tailwindcss/typography** + **@tailwindcss/forms**

### CSS
Global styles are in `src/assets/styles/global.css`; docs-specific styles are scoped to the canonical docs components.

### Logo
- Light: `/src/images/logo_light.svg`
- Dark: `/src/images/logo_dark.svg`
- Favicon: `/favicon.svg`

### Sidebar
- **Hand-maintained** in `src/data_files/docs-sidebar.ts`
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
pnpm build                      # astro check + Astro build + Pagefind index
pnpm dev                        # Local preview
```

- Build must pass with 0 errors before committing.
- `pnpm build` generates and verifies `dist/pagefind/pagefind.js`; use `pnpm preview` to test site search locally.
- Plain `pnpm dev` does not generate a Pagefind index, so search requires a completed production build.
- `astro check` reports Zod deprecation hints (20 total) — these are upstream, ignore them.
- The build validates frontmatter/schema types, MDX syntax, TypeScript, collection uniqueness, and static rendering.
- The build does **not** validate external link availability, tracking parameters, assessment IDs, exam names, voucher accuracy, or duplicate content. Verify these manually against authoritative sources.
- When redirects change, test the old route against the dev server.
- Use `pnpm install --frozen-lockfile` for reproducible installs; commit `pnpm-lock.yaml` when dependencies change.

---

## Link Checker

Automated internal/external link validation, separate from the build.

- **Workflow:** `.github/workflows/link-checker.yml`
- **On pull requests** touching `src/content/**`, the workflow file, or `.lycheeignore`: builds the site, then runs `lychee` against `dist/**/*.html` to check internal links only (`--exclude 'https?://.*'`). A broken internal link **fails the PR** (`fail: true`, plus an explicit failing step).
- **On schedule** (Monday 06:00 UTC) and manual trigger: also crawls the live site with `linkinator` to check external links, skipping known flaky domains (see `.lycheeignore`: measureup.com, discord.gg/discord.com, linkedin.com, x.com, threads.net, reddit.com). Opens a GitHub issue on failure.
- Lychee results are cached (`.lycheecache`, keyed by commit SHA) to speed up repeated runs.
- **Implication for content removal:** when deleting a page (voucher, exam, lab, etc.), search the whole repo — including `src/content/blog/**` — for internal links to it. Convert any remaining references to plain text instead of leaving a dangling `LinkCard`/Markdown link, since a broken internal link will fail the PR's link-checker run.

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
- **Node version:** 24 (current LTS)

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

## Learn Catalog Cache

Local, AI-queryable cache of Microsoft Learn training modules (name, product category, product(s), subjects, unit names), so an agent can find "all modules about product X" without re-scraping Learn each time.

- **Data file:** `src/data_files/learn-catalog.json` — not imported by the site; a pure reference dataset for content research.
- **Script:** `scripts/learn-catalog-sync.mjs` — Node (ESM, zero dependencies, uses global `fetch`). Run with `node scripts/learn-catalog-sync.mjs`.
- **Workflow:** `.github/workflows/learn-catalog-monitor.yml` — runs Monday 07:00 UTC + manual trigger; commits the refreshed file directly (no PR, same pattern as MeasureUp) and opens an issue only if the sync fails.
- **Source:** `https://learn.microsoft.com/api/catalog/` (`type=modules,units,products,subjects`).

### Catalog API shape (important — not obvious from the API itself)
- `?type=products` and `?type=subjects` each return a **flat top-level list where every entry has `parent_uid: null`**; the real hierarchy lives in a `children: [{id, name}]` array on each top-level entry, 2 levels deep. No child id is duplicated under multiple parents.
- A module's `products` array can mix top-level ids (e.g. `github`) and child ids (e.g. `azure-cosmos-db`) from *different* parents in the same module — modules are not confined to one category.
- The `product=<id>` query filter matches **only the literal tag**, not the category hierarchy (filtering `product=azure` excludes a module tagged only `azure-devops`, even though DevOps is a child of Azure). Reliable category classification requires pulling the full unfiltered catalog and resolving each module's product ids against the children map yourself — don't rely on the query filter for "everything in category X".
- `units` is a **separate top-level array** in the catalog response (uid, title, duration, locale, last_modified) — a module only lists ordered unit *uids*; resolve titles via this array instead of fetching each module/unit individually.
- Full unfiltered catalog (as of 2026-08-29): 3,425 modules, 27,557 units, 60 top-level products (220 child products); ~5.5MB modules + ~5.8MB units + ~15KB products, all `locale: en-us` by default.

### Category filter
`ALLOWED_CATEGORIES` in `scripts/learn-catalog-sync.mjs` is an explicit allowlist of top-level product ids (50 of 60). It covers every cert-tracked area (Azure, M365 family, Dynamics 365, Power Platform, GitHub, Fabric, Entra, Sentinel, Defender, Purview, Priva, Security Copilot, Copilot, Intune/MEM, Viva, Teams, agent-365/agent-framework, SQL Server, Windows, SharePoint, Exchange, Industry Solutions, Graph) plus generic dev/productivity categories (.NET, ASP.NET/ASP.NET Core, Visual Studio/VS Code/App Center, Bing, Microsoft Edge, Microsoft Authentication Library, Sysinternals, Windows Server, Microsoft Search, Microsoft Whiteboard, Adaptive Cards, Microsoft Forms, and the standalone Office apps: Excel, Word, PowerPoint, Outlook, OneNote, OneDrive, plus the generic `office` and `m365-ems-advanced-threat-analytics` tags). This keeps 3,357 of 3,425 modules. Only 10 categories remain excluded as not relevant to any tracked content: Consumer, HoloLens, Microsoft MakeCode, Minecraft, Mixed Reality Toolkit, Quantum Development Kit, Surface, Xbox, `ms-website` (a small ~11-module bucket for AppSource/Azure Marketplace/Microsoft Education Center partner-publishing content), and `playwright` (a single Learn module about the open-source Playwright test framework — no Microsoft cert exists for it). Edit the array directly to add/remove a category — no other code changes needed.

### Module record schema
```json
{
  "uid": "learn.wwl.introduction-development-operations-principles-for-machine-learn",
  "title": "Introduction to DevOps principles for machine learning",
  "url": "https://learn.microsoft.com/training/modules/.../?WT.mc_id=studentamb_165290",
  "categories": ["Azure", "GitHub"],
  "products": ["Azure DevOps", "GitHub", "Machine Learning"],
  "subjects": ["DevOps"],
  "units": ["Introduction", "...", "Summary"]
}
```
- `categories` = resolved top-level parent name(s), restricted to `ALLOWED_CATEGORIES` matches; `products` = every tagged product's display name (parent- or child-level, whichever was tagged), unrestricted.
- `units` are titles only (no uids), in module order; a small number (~120 of ~19,000 as of the initial run) fall back to the raw unit uid because the catalog's `units` array didn't include that uid — a minor upstream data inconsistency, not a bug.
- URLs are normalized the same way as content pages: `/en-us/` stripped, `WT.mc_id` rewritten to `studentamb_165290`.
- Records are sorted by `uid` for stable, minimal diffs between refreshes.

### Subject enrichment
Microsoft's own `subjects` tagging is sparse and inconsistent (as of the 2026-08-29 snapshot, 415 of 3,357 modules have zero subjects at all, down from 638 before enrichment; near-duplicate modules can also be tagged differently — e.g. "Introduction to Azure Firewall" had no "Networking" tag despite being a firewall module, while a similar Firewall module did). `PRODUCT_SUBJECT_HINTS` in `scripts/learn-catalog-sync.mjs` is a deterministic product-id → subject-id table that adds a subject when a module has a well-known, unambiguous product (networking appliances, specific databases, AI services, identity/Defender/Purview products, device management, Power BI/Power Automate/Fabric, containers, Azure DevOps, monitoring/backup, automation/serverless, app-development frameworks, Education) and Microsoft's own tag is missing it. It only **adds** subjects, never removes Microsoft's own tags, and covers ~80 high-confidence product ids — it is not a full content classification of every module, so gaps can still remain for products not in the table (see "Known residual gaps" below).
- **Verified empirically, not just by code review**: cross-checked all 3,357 modules' official `subjects` against the generated cache — 0 violations (every official tag survives; the merge is `new Set(mod.subjects)` + `.add()` only, never `.delete()`/reassignment). Re-run this check after touching the merge logic: fetch `?type=modules,subjects`, resolve each module's raw subject ids to names, and confirm every one is present in that module's cache entry.
- **Custom subjects** (`CUSTOM_SUBJECTS` in the script): ids invented because no official Microsoft Learn subject fits, merged into the same resolution map as official ones so they're indistinguishable in the output format. Currently one: `education` → "Education" (Microsoft Learn's `?type=subjects` taxonomy has no education-related entry at all, yet `m365-education`-tagged modules — K-12/higher-ed content — are a large, clean, consistent cluster: 68 modules, was 93% zero-subject before this tag).
- **Products considered and deliberately rejected** after sampling actual module titles (high-level "% missing" stats looked compelling but the products turned out to be broad co-tags on unrelated content, so adding the hint would have been inaccurate): `power-apps` (Custom app development — diluted by Copilot Studio/AI Builder modules that aren't app-building), `dataverse` (databases — same dilution), `office-sp`/SharePoint (Collaboration — tiny, weak sample), `office-exchange`/Exchange (Communication — sampled modules were actually about Purview/Defender compliance auditing, not messaging), `office-teams`/Teams (Collaboration/Communication — diluted by Power Platform/Copilot extension modules built on top of Teams), `ms-copilot` and `agent-365` (chatbots/generative-ai — used as a broad co-tag across modules that are really about the underlying platform, e.g. "Build a Power Apps canvas app... with Copilot in Power Apps" is a Power Apps module, not a chatbot-building one). Don't re-add these without re-sampling real module titles first — the aggregate gap % alone is not sufficient evidence.
- **Known residual gaps (deliberately left unfixed)**: a per-product zero-subject report (group all modules by product, sort by zero-subject count) shows the bare umbrella tags `Azure` (759 modules, 118 zero — 93 of those have *no other product tag at all*), `Windows`, `windows-11`, `Office 365`, and `Windows Server` are each too heterogeneous for one hint (samples span everything from accessibility to Active Directory to IIS to K-12 classroom content within the same tag). Fixing these would need either fragile title-keyword matching or non-durable per-uid overrides (which would just be silently discarded on the next resync, since the file always regenerates from the live API) — neither meets the bar used for every other entry in this table. Re-derive this report (`group by product → count, zero-subject count`) before investing more time here rather than guessing which products still have gaps.
- Extend the table (grouped by category, values are subject ids from `?type=subjects`, or a new `CUSTOM_SUBJECTS` entry if nothing fits) if you spot another consistent, undiluted gap — sample several real modules with that product before adding a rule, the same way the accepted entries above were checked.

### Failsafe
Script aborts (`process.exit(1)`, nothing written) if fewer than `MIN_MODULES` (2,800) modules match after filtering — signals the catalog API schema likely changed.

### Running locally
```bash
node scripts/learn-catalog-sync.mjs
```

---

## Docs Catalog Cache

Local, AI-queryable cache of Microsoft Learn **documentation** pages (title, url, product, subproduct, description) — the docs-portal sibling of the Learn Catalog Cache above, which only covers training modules. Documentation has no bulk API, so this is built by shallow-cloning each product's public docs repo on GitHub instead.

- **Data file:** `src/data_files/docs-catalog.json` — not imported by the site; a pure reference dataset for content research, same role as `learn-catalog.json`.
- **Script:** `scripts/docs-catalog-sync.mjs` — Node (ESM, zero dependencies, uses `git` via `execSync`). Run with `node scripts/docs-catalog-sync.mjs`.
- **Workflow:** `.github/workflows/docs-catalog-monitor.yml` — runs Monday 08:00 UTC + manual trigger; commits the refreshed file directly (no PR, same pattern as MeasureUp/Learn Catalog) and opens an issue if any repo fails or the sync falls below the failsafe threshold. The commit step runs even if the sync step reports failure (`if: ${{ !cancelled() }}`), so a partial failure (one repo down) still commits the data gathered from the repos that succeeded.
- **Source:** one `git clone --filter=blob:none --sparse --depth 1 --no-checkout` per repo in the `REPOS` array in the script, sequentially (not parallel — clones are fast enough, ~2-30s each, that parallelizing isn't worth the added complexity; see AGENTS.md's general preference for simple, single-script/single-workflow automation matching the Learn Catalog and MeasureUp patterns).

### Why git clone instead of an API
Microsoft's Learn Platform API and `/api/catalog/` only cover Modules/Units/Learning Paths/Applied Skills/Certifications/Exams/Instructor-Led Courses — not documentation. Documentation lives in ~dozens of open-source `MicrosoftDocs/*` GitHub repos (CC BY 4.0 content, MIT code, public-contribution repos — safe to cache metadata from). A blobless/sparse/shallow clone avoids the GitHub REST API's rate limits entirely (it uses git's smart HTTP protocol, not `api.github.com`) and is fast: azure-docs (the largest repo used), at 159MB/~15K files with full history, clones and checks out in under 30 seconds when filtered this way.

### Repo config shape and the critical gotcha
Each `REPOS` entry is `{ name, repoUrl, targets: [{ sourceFolder, baseUrlPath }] }`. A repo can have multiple `targets` (multiple docsets sharing one clone) — `defender-docs` has 15. Optional per-repo overrides exist for repos that don't follow the docfx/Microsoft Learn convention: `domain` (default `learn.microsoft.com`), `descriptionField` (default `description`, the frontmatter key to read for the description), and `productFromPath` (derive `product` from the first path segment under `sourceFolder` instead of an `ms.service`-style frontmatter tag). See the `github-docs` section below for the one repo that uses all three.

**`baseUrlPath` must be manually verified against a real live page fetch — never trust a repo's `.openpublishing.publish.config.json` → `docsets_to_publish[].build_output_subfolder` literally.** That value is frequently an internal build alias, not the public URL segment. Confirmed mismatches found while building this cache:
| Repo/docset | `build_output_subfolder` (wrong) | Real live URL base (verified) |
|---|---|---|
| entra-docs | `entra-docs` | `entra` |
| fabric-docs | `fabric-docs` | `fabric` |
| windowsserverdocs | `WindowsServerDocs-VSTS` | `windows-server` |
| defender-docs: sentinel | `sentinel-azure` | `azure/sentinel` (nested under Azure) |
| defender-docs: defender-for-cloud | `defender-for-cloud` | `azure/defender-for-cloud` (nested under Azure) |
| defender-docs: easm | `easm-azure` | `azure/external-attack-surface-management` |
| defender-docs: exposure-management | `exposure-management` | `security-exposure-management` |
| defender-docs: defender-for-identity | `ATP-Docs` (legacy alias) | `defender-for-identity` |
| defender-docs: defender (landing/overview docset) | `defender` | `unified-secops` |
| defender-docs: defender-for-iot / d4iot-azure | `defender-for-iot` / `d4iot-azure` | both publish under `azure/defender-for-iot` |
| microsoft-365-docs: copilot | `microsoft-365-copilot` | `microsoft-365/copilot` (canonicalUrl nests it under the same `microsoft-365/` prefix as the repo's other docset, not a separate top-level path) |

Roughly half of `defender-docs`' docsets needed correction this way, while `defender-endpoint`, `defender-cloud-apps`, `defender-xdr`, `defender-business`, `defender-office-365`, `defender-vulnerability-management`, and `unified-secops-platform` all matched their literal config value. There's no reliable way to predict which case a new repo/docset falls into — always spot-check a sample file's constructed URL with `microsoft_docs_fetch` (or equivalent) before adding it, the same way every repo in the current list was verified. `power-platform` also has an unrelated second docset (`project-sophia`/`ps-docs`) deliberately excluded as out of scope, and `defender-docs`' `advanced-threat-analytics` (ATA) docset is excluded as a legacy/retired product superseded by Defender for Identity.

### Dynamics 365 tier: a shared namespace, not per-repo aliases
Dynamics 365 documentation is fragmented across ~10 separate `MicrosoftDocs/*` repos (one per product area, found via `github.com/orgs/MicrosoftDocs/repositories?q=dynamics`), and most publish under a **shared `dynamics365/` URL namespace** rather than a distinct per-repo segment — each repo's `.openpublishing.publish.config.json` `build_output_subfolder` (e.g. `customer-engagement`, `d365F-O`, `dynamics365-contact-center`, `dynamics-365-order-management`, `dynamics365guidance`) is **never** the real live path.

**The critical distinction is whether the product name survives as a real folder *inside* the sourceFolder, or whether the sourceFolder itself *is* the product** (confirmed live, then re-confirmed by a duplicate-URL audit across the whole generated catalog — see below):
- `dynamics-365-customer-engagement` (`sourceFolder: "ce"`) and `dynamics-365-unified-operations-public` (`sourceFolder: "articles"`) are generic containers holding *multiple* product subfolders (`ce/sales/`, `ce/customer-service/`, `articles/finance/`, `articles/supply-chain/`, etc.) — those subfolder names become the URL segment for free, so `baseUrlPath: "dynamics365"` alone is correct.
- Every other single-product repo uses its product name (or an alias of it) *as* the `sourceFolder` itself (`contact-center`, `mr-docs`, `topics`, `guidance`, `articles`-for-project-operations) — using it as `sourceFolder` strips it from the relative path, so it **must be re-added explicitly** to `baseUrlPath`, e.g. `dynamics365/contact-center`, `dynamics365/guidance`, `dynamics365/project-operations`, `dynamics365/intelligent-order-management`. `dynamics-365-mixed-reality` is the trickiest case: its folder is named `mr-docs`, but the real live segment is `mixed-reality` — folder name and URL segment don't always match, so verify each one, don't infer from the folder name. The Business Central pair follows the same rule: `dynamics365/business-central` (`dynamics365smb-docs`) and `dynamics365/business-central/dev-itpro` (`dynamics365smb-devitpro-pb`, a *separate* repo from `dynamics365smb-docs` despite covering the same product).

**This was originally implemented wrong** for 5 repos (`dynamics-365-project-operations`, `dynamics-365-contact-center`, `dynamics-365-mixed-reality`, `dynamics-365-intelligent-order-management`, `dynamics365-guidance`) — each had `baseUrlPath: "dynamics365"` alone, producing URLs missing the product segment entirely (e.g. `dynamics365/administer/...` instead of `dynamics365/contact-center/administer/...`). It surfaced only because two of the broken URLs happened to collide (`dynamics365/overview` and `dynamics365/whats-new/whats-new-home-page`, each claimed by two different repos' root-level files) and got caught by a **whole-catalog duplicate-URL check** (`Group-Object url | Where Count -gt 1`) — run this check after adding or changing any repo, since a passing `pnpm build` and a plausible-looking entry count do not catch wrong-but-well-formed URLs.

Excluded from this tier as legacy/retired (no current cert relevance, docs frozen or product discontinued): `msftdynamicsgpdocs` (Dynamics GP), `DynamicsAX2012-technet`/`-msdn` (AX 2012), `nav-content` (Dynamics NAV, Business Central's predecessor), `dynamics365-docs-templates` (archived, templates only), `dynamics-365-supply-chain-insights` (stale since 2022, folded into `dynamics-365-unified-operations-public`), `dynamics-365-ai` (stale since Nov 2024, superseded by per-app Copilot content), and **`dynamics-365-fraud-protection`** — confirmed via the repo's own `includes/deprecation.md` that support ended February 3, 2026 and the product is no longer purchasable; it no longer appears in the live Dynamics 365 documentation hub page at all. `dynamics365-industry-solutions` has no `.openpublishing.publish.config.json`; it's a generic community repo, not a docs source. Also note: `dynamics-365-mixed-reality` (Guides and Remote Assist) is included since it's still live, but Microsoft has announced both products retire December 31, 2026 — revisit after that date.

### Branch handling
The script uses a bare `git checkout` (no branch name) after the `--no-checkout` clone, which resolves to each repo's actual default branch automatically — confirmed necessary since not all repos use `main` (`microsoft-365-docs` uses `public`). Do not hardcode a branch name per repo.

### m365copilot-docs and the Purview/Priva dead end
`m365copilot-docs` (Microsoft 365 Copilot **extensibility**/developer docs — declarative agents, plugins, adaptive cards, Agent Builder) is a distinct repo from `microsoft-365-docs`' own `copilot/` folder (which covers agent *governance*: `agent-essentials/`, `copilot-control-system/`). Both share the `microsoft-365/copilot/` URL prefix with no overlapping subfolders (`extensibility/` vs. `agent-essentials/`/`copilot-control-system/`), confirmed via canonicalUrl, so no duplicate entries. Normal docfx repo, no overrides needed beyond `baseUrlPath: "microsoft-365/copilot/extensibility"`.

By contrast, **Purview and Priva were investigated and confirmed to have no public repo**, correcting an earlier assumption that their content was folded into `microsoft-365-docs`' `security/` folder — that folder actually contains only 2 real content files (checked directly, not just repo-searched). A live Purview/Priva page's own frontmatter (`original_content_git_url`) reveals the true source repos are `Purview-pr` and `OfficeDocs-Privacy-pr` — but only the `-pr` (internal/staging) forms exist; the expected public counterparts (`Purview`, `OfficeDocs-Privacy`, dropping the `-pr` suffix per the pattern every other repo in this cache follows) both 404, and neither turns up in an org-wide repo search for "purview", "priva", or "compliance" either. Same closed status as the Office-suite family and Windows client docs — revisit only if Microsoft changes its publishing model.

### github-docs: a different org, domain, and pipeline entirely
`github/docs` (the open-source repo behind docs.github.com, GH-* exam content) is not a MicrosoftDocs/docfx repo at all — it's Next.js + Liquid templating, so it needed three repo-level overrides instead of the usual `baseUrlPath` verification: `domain: "docs.github.com"`, `descriptionField: "intro"` (its frontmatter uses `intro` where docfx repos use `description`), and `productFromPath: true` (there's no `ms.service`-equivalent tag, so `product` is the top-level `content/` folder name, e.g. `actions`, `copilot`, `codespaces`). No locale prefix is needed — `docs.github.com/<path>` resolves the same as `/en/<path>`.

Raw frontmatter text also contains unresolved Liquid tags like `{% data variables.product.github %}` (54% of `intro` values had at least one, sampled against the full repo). A `stripLiquidTags()` helper resolves the handful of common `variables.product.*` tags to "GitHub" and strips any other `{%...%}` tag outright — applied to both `title` and `description` for every repo (harmless no-op for docfx repos, which never contain this syntax). This cleans 99.9% of entries; a small number (3 of 3,741, all product-name tags like `variables.copilot.copilot_cli` with no text around them) fall back to the raw tag in the title so it's never blank — a known, accepted gap, not worth a full per-variable resolution table for 0.08% of entries.

### Entry schema
```json
{
  "title": "Import SOAP API to Azure API Management",
  "url": "https://learn.microsoft.com/azure/api-management/import-soap-api",
  "product": "azure-api-management",
  "subproduct": null,
  "description": "Learn how to import a SOAP API to Azure API Management as a WSDL specification..."
}
```
- `title`/`description`/`product`/`subproduct` come from a file's frontmatter (`title`, `description`, `ms.service`, `ms.subservice`) via a simple line-based parser (not a full YAML parser — would break on multi-line block-scalar values, though none were observed in practice). Files without a parseable `title` are skipped.
- `url` is built from the file's path relative to its target's `sourceFolder`, joined to the verified `baseUrlPath` (see gotcha above) — no `/en-us/`, no `.md` extension.
- Frontmatter is inconsistently tagged across repos: expect a meaningful fraction of entries with `product: null` (varies by repo, roughly a quarter to a third overall) — this mirrors the same sparsity seen in the Learn Catalog's official `subjects` tagging and isn't a bug.

### Current scope: easy + medium + Dynamics 365 done (as of 2026-08-30)
Repos are added in tiers of increasing topology complexity — verify and pilot each tier before moving to the next:
- ✅ **Easy tier (done):** one repo each, single or small number of clean docsets — `azure-docs`, `entra-docs`, `fabric-docs`, `sql-docs`, `power-platform`, `memdocs` (Intune + Autopilot), `windowsserverdocs`, `defender-docs` (15 docsets, see table above), `github-docs` (GH-* exam content — the original plan called for this repo but it was initially missed; added later, see dedicated section above). **46,830 entries** (43,089 initial + 3,741 `github-docs`), 13.2 MB before `github-docs`.
- ✅ **Medium tier (done):** `microsoft-365-docs` — a real repo but narrower in scope than its name implies: covers `microsoft-365/` (admin, security, backup, business-premium, frontline, managed-desktop, migration, loop, whiteboard, commerce, lighthouse, bookings, and more — nearly all top-level subfolders, ~20 of them) plus `copilot/` (Agent 365 governance content under `agent-essentials/` and `copilot-control-system/`). It does **not** contain Teams, Viva, Exchange, or SharePoint content despite the repo name. **1,170 entries** (1,006 + 164).
- ✅ **Dynamics 365 (done, part of the former hard tier):** ~10 repos, all resolving to a shared `dynamics365/` namespace — see the dedicated section above for the URL-pattern discovery and exclusions. `dynamics-365-customer-engagement` (4,526), `dynamics-365-unified-operations-public` (5,862), `dynamics365smb-docs` (2,111), `dynamics365smb-devitpro-pb` (5,809), `dynamics-365-project-operations` (878), `dynamics-365-contact-center` (169), `dynamics-365-mixed-reality` (248), `dynamics-365-intelligent-order-management` (83), `dynamics365-guidance` (583). **21,439 entries** added this tier.
- ✅ **AI Business / Copilot extensibility (done):** `m365copilot-docs` — **265 entries**, see dedicated section above. Its sibling products, Purview and Priva, were investigated and confirmed to have no public repo (see same section) — same closed status as Office-suite/Windows client below.
- **Office-suite family — confirmed to have no dedicated repo at all (investigated 2026-08-30):** Teams, Exchange, SharePoint, Outlook, Viva, Word/Excel/PowerPoint, OneDrive, and OneNote admin/end-user documentation has **no clean canonical public GitHub source repo**, unlike every product added so far. Searched exhaustively via `github.com/orgs/MicrosoftDocs/repositories?q=<term>` per product plus direct repo-name guesses; every lead was one of:
  - **Developer-only**, not admin/end-user docs: `msteams-docs` and `Microsoft-teams-docs` (Teams developer platform), `office-developer-exchange-docs`, `office-developer-client-docs`, `office-developer-word-pia-ref-dotnet`, `office-developer-excel-pia-ref-dotnet`, `office-developer-outlook-pia-ref-dotnet`, `office-developer-sharepoint-server-2013-ref-dotnet` (most of these are also legacy/archived, e.g. SharePoint Server 2013).
  - **A narrow utility repo, not general docs**: `OfficeDocs-SharePoint-PowerShell` is a PowerShell cmdlet reference only.
  - **Legacy/archived locale-only content with no unsuffixed canonical repo**: `OfficeDocs-SkypeForBusiness.de-DE` / `-pr.<locale>` (Teams predecessor content), `OfficeDocs-Exchange-Test-pr.<locale>`, `office-shared-outlook.<locale>`, `OfficeDocs-O365SecComp-pr.<locale>` (likely predecessor to security/compliance content, now split across Purview/Priva's own private-only repos — see the `m365copilot-docs` section above) — every one of these is locale-suffixed or `-pr`-suffixed (internal staging) with no plain unsuffixed repo behind it.
  - **Zero matches at all**: Viva, OneDrive, OneNote.
  - Direct guesses for a plain canonical name (`OfficeDocs-SkypeForBusiness`, `OfficeDocs-Exchange`, `OfficeDocs-SharePoint`, `OfficeDocs-Outlook`) all 404.
  - `microsoft-365-docs` itself was double-checked as a fallback (its `microsoft-365/topics/` folder, the one unexplained generic-sounding subfolder) — contains only 2 meta-articles about a "topics" system migration, not Teams/Exchange/SharePoint/Outlook content.
  
  **Conclusion: this tier is closed, not merely deferred.** These products' admin docs likely use a different, non-public-contribution authoring pipeline than the ~20 repos already integrated. Re-check only if Microsoft changes its publishing model for these products.
- **Also confirmed to have no dedicated repo:** Windows client IT-pro/admin docs (11 `windows*` repos found, all developer/driver/API-reference-focused — genuinely no admin-docs repo exists) and Agent 365 (no standalone repo — content lives inside `microsoft-365-docs`' `copilot/` folder and likely `entra-docs`, both already in scope).
- **Final total: 68,534 entries, 21.3 MB.** All planned tiers are now done or confirmed closed — no further repos are currently known to be addable.

### Failsafe
Script aborts (`process.exit(1)`, nothing written) if total entries across all repos fall below `MIN_ENTRIES` (20,000) — signals systemic breakage (e.g., the git clone technique stops working), as opposed to one repo having a transient issue.

### Running locally
```bash
node scripts/docs-catalog-sync.mjs
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
