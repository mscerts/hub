# Agent Instructions — Microsoft Certification Hub

> For AI coding agents working on this repository.
> Keep this file updated as the project evolves.

---

## Identity

You are working on **msfthub.com** — a community site providing free study-material collections for Microsoft certification exams. Be direct, efficient, and preserve the existing code style.

Maintainers plan work on a private task board. If `.tasks.local.json` exists in the repository root, follow the Task Board section below; otherwise ignore it.

---

## Task Board (private)

The board is a private GitHub Projects board. It is the source of truth for what to work on and for handoffs between sessions, agents, and people. Use it only through the helper, run from the repository root:

```bash
node scripts/tasks.mjs <command>
```

| Command | Purpose |
|---------|---------|
| `list` | Open items (`--all` includes Done, `--mine` shows only yours) |
| `show <ref>` | Title, status, priority, due date, owner, link, and the item's Log |
| `start <ref>` | Claim the item: sets you as assignee |
| `note <ref> "<text>"` | Append a timestamped line to the item's Log |
| `add "<title>" --body "<text>"` | Create a new item (default Status, or `--status`/`--priority`/`--due`) |
| `link <ref> <pr-url>` | Record the pull request on the item |
| `status <ref> "<option>"` / `priority <ref> "<P0\|P1\|P2>"` / `due <ref> "<date>"` | Set the item's category, urgency, or due date |
| `done <ref>` | Move the item to Done |
| `unclaim <ref>` | Release your claim: clears the assignee |
| `archive <ref>` | Archive the item (hides it from `list`) |

`<ref>` is the REF column from `list`. Run `node scripts/tasks.mjs help` for all options.

### Workflow

1. At the start of a session, run `list`. If the user named a task, `show` it and read its Log; otherwise ask which item to take instead of picking one yourself.
2. Before editing files for an item, run `start <ref>`. If it reports the item is claimed by someone else, stop and tell the user. If the item names a task prompt from `.github/prompts/`, follow that prompt.
3. Run `note` when you make a decision, hit a blocker, or end a session: what changed, what is left, and what the next agent needs to know. The Log is the only handoff between sessions and tools, so write it for a reader with no other context. If you can't finish it and won't be returning to it, also run `unclaim` so someone else can pick it up.
4. After opening a pull request, run `link <ref> <pr-url>` and `note` that it's ready for review. Run `done` only when the user confirms the work is finished.
5. If you notice something worth doing outside the current task, don't add it to the board immediately — see "Surfacing things you notice" below.

If a board command fails (not configured, authentication, missing option), stop and report the error. Don't edit `.tasks.local.json`, change `gh` authentication, or modify `scripts/tasks.mjs` to work around it.

### Surfacing things you notice

While working on anything else, if you find room for improvement or an issue unrelated to the task at hand, present it to the user before continuing — describe what you found and why it matters — instead of silently fixing it or filing it away.

- If the user approves or rejects it, that's the end of it either way. Don't create a board item.
- If the user ignores it (moves on without addressing it, changes topic, ends the session), gather as much context as you can — what you found, where, why it matters, and how you noticed it — and file it on the board yourself. See `.tasks.lifecycle.md` for which column and exact command to use.

### Column lifecycle and priority

Items follow an intended path as they go from idea to done, and once structured, each needs a priority (how urgent) alongside its column (what kind of work) — some moves need the user's confirmation first. This is documented in `.tasks.lifecycle.md` in the repository root — a local, gitignored file, not part of this public repository, since it names the board's private column structure and priority scheme. Read it before creating or moving any board item, or before setting a priority. If it doesn't exist on your machine, ask the user for the column names and rules instead of guessing. These rules describe normal operation — an explicit instruction from the user overrides any of them.

### Board content stays private

This repository is public. Never copy task titles, bodies, Log notes, plans, or refs/IDs into anything that reaches this repository or its GitHub pages: commit messages, branch names, pull request titles and descriptions, code comments, content pages, issues, or review comments. Describe public changes by what they do (for example, "Fix broken lab links on the SC-300 page"), not by the plan behind them. Links go one way: the board may point to public pull requests; public content never points to the board.

---

## Project Context

- **Repo:** https://github.com/mscerts/hub
- **Site:** https://msfthub.com
- **Stack:** Astro 7, native MDX content collections, Tailwind
- **Package manager:** pnpm (do not use npm or yarn)
- **Build:** `pnpm build` = Astro checks, static build, and Pagefind indexing with `astro build --force` → output in `dist/`
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
│   ├── LabList.astro         # Auto-generates lab index cards from labs/<area>/ pages
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
│   │   ├── labs.mdx          # Lab index page (uses LabList component)
│   └── blog/                 # Blog collection (authors, pubDate, cardImage, readTime, tags)
├── pages/certs/               # Canonical wiki index, docs renderer, and Markdown endpoint
├── data_files/
│   ├── applied-skills-cache.json # Generated by scripts/applied-skills-sync.mjs (see Applied Skills Monitor)
│   ├── constants.ts          # Site metadata (title, description, SEO, OG)
│   ├── faqs.json
│   ├── features.json
│   ├── mega_link.ts
│   └── missing-resources.json # Generated by scripts/audit-missing-resources.mjs (see Missing Resources Audit)
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
- Canonical routes are lowercase under `/certs/`: `/certs/azure/az-800/`, `/certs/power/pl-300/`
- Filenames are uppercase: `AZ-800.mdx`, `PL-300.mdx`
- `<area>` ∈ `aibusiness | azure | dynamics | github | microsoft365 | power | security`
- Area mapping: `azure` = AZ-*, AI-*, DP-*; `aibusiness` = AB-*; `dynamics` = MB-*; `github` = GH-*; `microsoft365` = MS-* and MD-*; `power` = PL-*; `security` = SC-*.
- Astro collection IDs are lowercase regardless of filename case (`AZ-800.mdx` -> id `azure/az-800`), and the canonical renderer exposes them at `/certs/azure/az-800/`. Changing only a filename's case never changes its URL and needs no redirect. It does, however, poison Astro's incremental content-layer cache; `pnpm build` passes `--force` to clear that cache, which makes such renames safe.
- Frontmatter title is `<CODE> Study Materials`.
- Frontmatter description must use the exact template: `Collection of study materials for the certification exam <CODE>: <Exam Name>. Contains official Microsoft Learn materials, labs, videos, practice tests and paid courses.`
- Use the official exam name, not the certification name. Verify it against Microsoft Learn; these names often differ.
- Exam pages do not use `voucherCategory`.
- After creating a new exam page (or adding resource links to an existing one), run `node scripts/audit-missing-resources.mjs` and commit the regenerated `src/data_files/missing-resources.json` (see Missing Resources Audit).

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
3. Optional status banner: `:::tip` for beta/resource scarcity; `:::caution` for retirement, replacement details, or an unconfirmed at-risk change
4. `<Card title="Get Started" icon="star">` -> Exam link, Study Guide link, optional Exam Labs/Case Studies link, and the matching How to Prepare LinkCard as the final resource
5. `<Tabs>` with `TabItem`s: Text, Videos, Tests, Paid, Misc
6. Closing `</Card>`, then bottom `<Card title="MeasureUp Practice Tests" icon="open-book">` block with `<Aside>` for MSFTHUB discount; if no products exist, use a tip stating that MeasureUp has not released material yet

Resource placement:
- **Text:** Official Learn courses/paths, documentation, and reputable written guides.
- **Videos:** Verified video courses, exam reviews, and directly relevant technical sessions.
- **Tests:** Free practice assessments and legitimate free tests.
- **Paid:** Paid courses, assessments, and practice-test products.
- **Misc:** Repositories, tools, communities, reference implementations, and supporting standards. Microsoft Agent Academy (`https://microsoft.github.io/agent-academy/`) belongs here only on exam pages where Copilot Studio / Copilot-and-agent building or administration is a core, named topic (not an incidental mention, and not a different Copilot product like GitHub Copilot) — currently AB-410, AB-620, AB-650, AB-730, AB-900.
- Keep all five exam tabs, even if some are empty. Sparse beta pages are expected.
- If an announced official course is future-dated, include its verified availability date in the description.
- Retiring pages retain valid existing resources and link to the verified replacement exam.

### How to Prepare LinkCard (all exam pages)
- Every exam page's "Get Started" card ends with a `LinkCard` to the matching `/certs/prepare/` guide: the last `LinkCard`-type resource (after Exam Labs/Exam Case Studies/GitHub Case Studies if present, otherwise right after Study Guide) and before any `RelatedCerts` component.
- Classification (verify against Microsoft Learn for any new exam before assuming):
  - **Fundamentals** -> `/certs/prepare/fundamentals/`: exam name contains "Fundamentals" (AI-901, AZ-900, DP-900, PL-900, SC-900), GitHub's "Foundations" tier (GH-900), and AB-900.
  - **Business** -> `/certs/prepare/business/`: AB-730, AB-731 (non-technical AI Business Professional/Leader tier).
  - **Role-based** -> `/certs/prepare/role-based/`: everything else (Associate/Expert/Specialty, all areas) — one page covers all three tiers.
- Wording:
  - Fundamentals: `title="How to Prepare for Fundamentals Exams" href="/certs/prepare/fundamentals/" description="Guidance on study time, resources, and readiness for Microsoft Fundamentals exams."`
  - Business: `title="How to Prepare for Business Exams" href="/certs/prepare/business/" description="Guidance on study time, resources, and readiness for Microsoft Business exams."`
  - Role-based: `title="How to Prepare for Role-Based Exams" href="/certs/prepare/role-based/" description="Guidance on hands-on practice, documentation, and readiness for Microsoft role-based exams."`
- No `target="_blank"` (internal link). Add this LinkCard, with the correct classification, to any new exam page.

### Endangered Exam Treatment (unconfirmed change — distinct from Retiring)
- Use when Microsoft signals a *possible* future change (a new exam, a level change, an objective-domain/blueprint survey) but nothing is confirmed — do not use RETIRING language or badges for these.
- Add a `:::caution` banner at the top citing the concrete evidence (announcement post, survey, etc.) with a source link. Keep it terse and structurally consistent: new exam code + title (if known), "may replace X", "could mean retirement", "neither confirmed", one source link.
- Sidebar badge: `{ text: "AT RISK", variant: "caution" }` in `src/data_files/exam-status.mjs`, keyed by area then exam code.
- Examples: AZ-400 (potential AZ-401: Designing and Implementing Microsoft Agentic DevOps), DP-420 (potential DP-421: Building Data-Driven AI Applications with Azure Cosmos DB).
- Keep all existing resources intact; this is an informational heads-up, not a retirement.

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
- Known verified resources: AZ-120 has three Learn exercises from `explore-azure-center-sap-solutions`; AZ-900 uses `MicrosoftLearning/AZ-900-Microsoft-Azure-Fundamentals`; SC-401 already includes `MicrosoftLearning/SC-401T00-Information-Security-Administrator`; the Azure Monitor Lab (Learn labs index) is a good cross-fit for monitoring-heavy Azure exams and is already used on AZ-104, AZ-204, AZ-700, and AZ-801. Do not duplicate them.
- More known verified GitHub repos (all under `MicrosoftLearning`, GitHub Pages exercise index at `microsoftlearning.github.io/<repo>/`): AI-901 uses `mslearn-ai-fundamentals` (current successor to the archived `AI-900-AIFundamentals`); AI-200 uses `mslearn-azure-ai`; AI-500 uses `mslearn-ai-multi-agents`; SC-500 uses `mslearn-sec-identity`; AB-900 uses `Administer-and-Secure-agents-with-Microsoft-Agent-365`; AZ-802 uses `AZ-802-Windows-Server-Administrator-Associate` (8 labs, no `LAB_AK_` answer-key variants yet) and additionally carries the AZ-800/AZ-801 repo labs prefixed `AZ-800: `/`AZ-801: ` because AZ-802 merges both retiring exams — the AZ-802T00 Learn paths are knowledge-based apart from the Azure Monitor VM exercise. When a repo has been superseded (older repo's README says "please use \<new-repo\>"), always use the new one. GitHub's own certifications (GH-*) do not have dedicated GitHub-org lab repos — their official prep path is Microsoft Learn only (per `resources.github.com/learn/certifications/`); do not invent one. GitHub-tagged Applied Skills do exist, though (product `GitHub` in the Applied Skills cache — currently the GitHub Copilot ones, GitHub Actions load testing, and GitHub secret scanning), and they belong on the matching GH-* lab page's Applied Skills tab (GH-200, GH-300, GH-500) as well as on AZ-400 where the study guide covers the same topic. Microsoft occasionally renames a skill without changing its slug (e.g. "Accelerate app development…" → "Accelerate AI-assisted development by using GitHub Copilot"); when the cache's `name` differs from a LinkCard title, update the title and keep the href.
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
- After creating or materially changing a lab page, link it from the matching exam page with an `Exam Labs` card only when the lab page actually exists. The lab index (`src/content/docs/labs.mdx`) is auto-generated by `LabList.astro` from `labs/<area>/<code>.mdx` files (card title `<CODE>: <Exam Name>` is derived from the lab description), so it needs no manual entry.
- For the Applied Skills tab, start from `src/data_files/applied-skills-cache.json` (see Applied Skills Monitor): `new` lists skills not yet linked from any lab page together with their products (to match them to exams), `active` shows where each skill is already linked, and anything in `retiring` must be removed from the lab pages it lists. Re-run `node scripts/applied-skills-sync.mjs` after editing Applied Skills links so `labPages` stays current.
- Validate every lab-page edit with `pnpm build` before finishing.

To discover genuine Microsoft Learn exercise units:
1. Fetch `https://learn.microsoft.com/training/courses/<code>t00` and read its `learn_item` learning-path UIDs.
2. Query `https://learn.microsoft.com/api/catalog/?uid=<comma-separated-path-uids>` to obtain each learning path's module UIDs.
3. Resolve each module's ordered `units` from the catalog.
4. Test each unit against the hands-on syntax below. Do not infer exercises from URL slugs; some exercise slugs do not contain the word "exercise".
5. Build the unit URL as `<module-base-url>/<1-based-unit-position>-<unit-slug>/?WT.mc_id=studentamb_165290`, remove `/en-us/`, and use the catalog's unit title as display text. **Caveat**: the catalog's `units` array position does not always match the real live-page URL number — some modules have hidden/non-sequential units in their live nav (numbering can skip a value, e.g. 1,2,3,5,6,7,8,9) that the catalog silently compresses into a gapless array, shifting every position from the gap onward. When adding a brand-new reference or resolving any doubt/conflict, cross-check by fetching the module's own index page (`https://learn.microsoft.com/training/modules/<slug>/`) — its nav list shows the real numbered slugs directly — rather than trusting the catalog's bare position number alone.

**Hands-on unit/module syntax** (verified 2026-08-29 against all ~27,000 cached unit titles — see `data/learn-catalog.json` in [mscerts/learnsync](https://github.com/mscerts/learnsync)):
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
- When adding a new resource `LinkCard` to an existing `CardGrid`, place it last unless it is an official Microsoft resource — a Microsoft resource goes after any other Microsoft resources already in that grid, or first if it would be the only resource in the grid.
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
- Guide, preparation, voucher, and top-level area groups are hand-maintained in `src/data_files/docs-sidebar.ts`.
- Exam entries are generated from the matching `src/content/docs/<area>/` directory by `buildExamItems()`; new exam pages appear automatically.
- Exam status badges are maintained in `src/data_files/exam-status.mjs`: `RETIRING`, `BETA`, and `AT RISK`.
- Keep exam entries in code order. GA exams have no badge; beta uses `{ text: "BETA", variant: "tip" }`; retiring uses `{ text: "RETIRING", variant: "danger" }`.
- Wiki pages are separate from the sidebar: `WikiList.astro` auto-discovers exam pages by area prefix, sorts collection IDs, and extracts a short name from the canonical exam-description template.
- `VoucherList.astro` filters docs by `voucherCategory`, sorts by title, and constructs `/certs/${voucher.id}/` routes.

### Redirects
- Defined in `astro.config.mjs` under `redirects: { ... }`
- Add redirects when exams are renamed/moved or certification structures change; retain legacy routes to avoid broken inbound links.

---

## Content Rules

- **No exam dumps.** Ever.
- **No inventing** URLs, IDs, dates, names, or course titles. Verify against Microsoft Learn.
- Use the Microsoft Learn MCP tools (`microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search`) for that verification when they are available. If you could not verify something, say so instead of guessing.
- Preserve all tracking params (`?WT.mc_id=studentamb_165290`, `#u44`).
- Prefer official Microsoft resources and Microsoft-maintained GitHub repositories. Third-party resources must be reputable and directly relevant.
- Verify exact resource titles and destination URLs before adding them. Never infer labs, courses, assessment IDs, release dates, voucher details, or MeasureUp products from URL patterns alone.
- Keep rendered output identical when refactoring — don't redesign pages.
- Edit with the editor, not terminal redirection. Re-read files right before editing.

---

## Build & Verify

```bash
pnpm install --frozen-lockfile  # Install deps
pnpm build                      # astro check + astro build --force + Pagefind index
pnpm dev                        # Local preview
```

- Build must pass with 0 errors before committing.
- `pnpm build` generates and verifies `dist/pagefind/pagefind.js`; use `pnpm preview` to test site search locally.
- Plain `pnpm dev` does not generate a Pagefind index, so search requires a completed production build.
- `astro build --force` clears the content-layer data store (`node_modules/.astro/data-store.json`) on every build. Cloudflare Pages restores that directory from its build cache, and the incremental loader keys entries on ID + content digest, so a file whose path changed but whose content did not (e.g. a case-only rename) would otherwise keep a stale `filePath` and fail with `Rolldown failed to resolve import "astro:content-layer-deferred-module?...fileName=<old path>"`. The full resync costs about one second on this site; do not remove the flag.
- `astro check` reports Zod deprecation hints (20 total) — these are upstream, ignore them.
- The build validates frontmatter/schema types, MDX syntax, TypeScript, collection uniqueness, and static rendering.
- The build does **not** validate external link availability, tracking parameters, assessment IDs, exam names, voucher accuracy, or duplicate content. Verify these manually against authoritative sources.
- When redirects change, test the old route against the dev server.
- Use `pnpm install --frozen-lockfile` for reproducible installs; commit `pnpm-lock.yaml` when dependencies change.
- No environment variables or secrets are required to build the site; analytics IDs (Google Analytics, Clarity, GTM) are hardcoded in astro.config.mjs.

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
| `LabList.astro` | Auto-generates lab index cards from `labs/<area>/<code>.mdx` pages |
| `VoucherList.astro` | Auto-generates voucher cards by `voucherCategory` frontmatter |
| `MainLayout.astro` | Global document shell, metadata, scripts, and banner integration |
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

## Applied Skills Monitor

Weekly sync of a cache of every Microsoft Applied Skills credential, cross-referenced with the lab pages that link to it. Not rendered on the site, not part of the build.

- **Workflow:** `.github/workflows/applied-skills-monitor.yml` — runs Monday 06:30 UTC + manual trigger
- **Script:** `scripts/applied-skills-sync.mjs` — Node, no dependencies; run with `node scripts/applied-skills-sync.mjs`
- **Cache:** `src/data_files/applied-skills-cache.json` — `{ lastSynced, active: [...], new: [...], retiring: [...] }`
- **On new or retired skills:** opens a GitHub issue (`enhancement`) listing them with products / affected lab pages
- **On failure:** opens a GitHub issue (`bug`) — listing API down or reshaped, too many detail pages failing, corrupt cache

### Data sources
1. **Listing:** `https://learn.microsoft.com/api/contentbrowser/search/credentials?locale=en-us&$filter=credential_types/any(t: t eq 'applied skills')&$top=100` — the JSON API behind `learn.microsoft.com/credentials/browse/?credential_types=applied%20skills`. Paged with `$skip`; `hidden: true` entries are ignored. Retired skills are silently dropped from this listing.
2. **Detail page** `https://learn.microsoft.com/credentials/applied-skills/<slug>/` for every skill (listed, cached, or linked from a lab page): the `<h1>` gives the name (leading `Microsoft Applied Skills:` stripped), the `Product` links in "At a glance" give the product names exactly as shown on the page (the listing's `display_products` adds parent products such as `Windows` that the page does not show, so it is only a fallback), and `<meta name="retirementDate">` / the `has been retired` warning box flag retirement. Retired pages usually keep returning HTTP 200 with a past `retirementDate` and no warning box.
3. **Lab pages:** every non-draft `src/content/docs/labs/**/*.mdx` (comments stripped) is scanned for `credentials/applied-skills/<slug>`; the `resources/study-guides/...` path is not a skill and is skipped.

### Entry shape
`{ name, url, products, labPages, retirementDate? }` — `url` is the repo-normalized form `https://learn.microsoft.com/credentials/applied-skills/<slug>/?WT.mc_id=studentamb_165290` (copy-paste ready for a `LinkCard`); `labPages` are collection IDs like `labs/azure/az-900`; `retirementDate` (`YYYY-MM-DD`) appears only when the page exposes one — a future date is an announced retirement of a still-active skill.

### Category rules (applied every run)
- Listed on Learn and not in the cache → `new` if no lab page links it, otherwise straight to `active`.
- `new` → `active` automatically once any lab page links it. To mark a skill as intentionally unmapped (no matching exam, e.g. the C# one), move its entry to `active` by hand; manual placement in `active` is preserved even with empty `labPages`.
- `active`/`new` → `retiring` when the skill disappears from the listing or its page reports retirement; a lab-page link to a slug that is not on Learn at all is also reported as `retiring`.
- `retiring` entries stay until no lab page links them, then they are dropped automatically. `retiring` → `active` if the skill is re-listed.
- The issue only reports skills that changed category *this run*; items already sitting in `new`/`retiring` are not re-reported.

### Failsafes (no cache write, failure issue instead)
- Listing fetch fails after 3 attempts, returns invalid JSON, or yields `< MIN_SKILLS` (10) visible skills
- More than `MAX_RETIRED_PCT` (50%) of previously known skills vanish in one run (listing API probably changed)
- More than `MAX_PAGE_FAILURE_PCT` (50%) of detail pages fail with non-404 errors (site blocking); individual failures fall back to cached/listing data with a warning
- Corrupt cache JSON

### Working the list
1. `new`: verify the skill on Microsoft Learn, decide which exam(s) it fits (use `products`), add a `LinkCard` to the Applied Skills tab of the matching lab page(s) following Lab Pages conventions, or move the entry to `active` if it maps to no exam.
2. `retiring`: remove the `LinkCard` from every page in `labPages` (keep the commented-out tab placeholder if the tab becomes empty).
3. Re-run `node scripts/applied-skills-sync.mjs` and commit the regenerated JSON together with the page edits. The file is only rewritten when `active`/`new`/`retiring` actually change.

---

## Missing Resources Audit

Internal to-do list of exam pages that lack a link of a given resource type. Not rendered on the site, not in the sidebar, not part of the build or CI.

- **Script:** `scripts/audit-missing-resources.mjs` — run with `node scripts/audit-missing-resources.mjs`
- **Output:** `src/data_files/missing-resources.json` — `{ "<Resource Type>": ["<CODE>", ...] }`, codes sorted alphanumerically
- **Scope:** every `<CODE>.mdx` in the seven exam areas; pages with `draft: true` are skipped

### What it checks
Only whether the button is present **on our page** — it does not verify that the resource exists on Microsoft Learn or the vendor site. Detection is by `LinkCard` **title**, not URL: a page counts as having a resource type when one of its `<LinkCard title="...">` buttons matches. Hrefs are never inspected.

| Key | Counts as present when the page has a `LinkCard` titled |
|-----|----------------------------------------------------------|
| MS Learn Course | exactly `Microsoft Learn` |
| MS Learn Practice Assessment | starting with `Microsoft Learn Practice Assessment` (covers the `(AI Skills Navigator)` variant) |
| MS Learn Exam Readiness Zone | exactly `Microsoft Learn Exam Readiness Zone` |
| MS Learn On-Demand Instructor-led Training | starting with `On Demand Instructor-led Training Series` (a `: <subtitle>` suffix is fine) |
| Exam Labs | exactly `Exam Labs` |
| GitHub Labs | n/a on the exam page — present when `labs/<area>/<code>.mdx` exists and its active `<TabItem label="Microsoft GitHub">` tab contains at least one `LinkCard` |
| MeasureUp | starting with `MeasureUp ` except `MeasureUp Subscriptions` (the generic link on every page); data-driven pages also count `measureUpReleased: true` |
| Whizlabs | starting with `Whizlab`/`Whizlabs` (case-insensitive) |
| Pluralsight | starting with `Pluralsight` |
| Udemy | containing the word `Udemy` anywhere |

- MDX (`{/* */}`) and HTML (`<!-- -->`) comments are stripped first, so commented-out placeholders count as missing.
- Only `<LinkCard>` titles are read; `<Card title="MeasureUp Practice Tests">` containers and `<TabItem label>`s are ignored.
- Buttons borrowed from a predecessor exam (`AZ-800: MeasureUp Assessment` on AZ-802, `AZ-500: Pluralsight Course` on SC-500) intentionally do **not** count — the page still lacks its own resource, which is exactly what the periodic sweep should look for.
- Because detection is name-based, new buttons must use the canonical titles above (e.g. `John Christopher's Course on Udemy`, not `John Christopher SC-200 Course`) or they will be reported as missing.
- Data-driven pages (`examPages["<CODE>"]` from `src/data_files/exam-pages.ts`) are checked against the `title:` fields of their entry in that file.
- To track a new resource type, add one entry to `RESOURCE_TYPES` in the script with the button title it should look for, and re-run.

### Working the list
1. Pick a key and an exam code from the JSON.
2. Verify the resource actually exists for that exam (Microsoft Learn, MeasureUp, vendor site). Never infer it from URL patterns — see Content Rules.
3. If it exists, add it to the exam page in the correct tab (Exam Page Anatomy) using the normalized URL Formats and tracking params.
4. If it does not exist, leave the entry; the list is expected to contain permanent gaps.
5. Re-run the script and commit the regenerated JSON together with the page edits.

### Known intentional gaps (do not "fix")
- **Exam Labs / GitHub Labs:** AB-100, AZ-305, SC-100 — design/architect-tier exams with no lab page by design (see Lab Pages).
- **GitHub Labs:** GH-100, GH-200, GH-300, GH-500, GH-900 — no `MicrosoftLearning` lab repos exist for GitHub's own certifications (see Lab Pages). GH-600 is covered via other Microsoft-owned GitHub repos.

---

## Beta and Retiring Exam Tracking

Two small trackers, populated once from `examStatuses` in `src/data_files/exam-status.mjs` and maintained by hand from then on, back automated notifications for exam lifecycle changes. Neither file is rendered on the site, part of the build, or re-synced automatically — the one-time sync scripts exist only for bootstrapping or a full manual resync.

### Beta exam tracker
- **File:** `src/data_files/beta-exams.json` — `{ lastSynced, exams: [{ code, area, name, url, flaggedGA, flaggedAt? }] }`
- **Sync script (one-time/manual):** `scripts/beta-exams-sync.mjs` — rebuilds the file from every `examStatuses[area][code]` entry with `{ text: "BETA", variant: "tip" }`, pulling the exam name from that page's frontmatter `description` and building the canonical `https://learn.microsoft.com/credentials/certifications/exams/<code>?WT.mc_id=studentamb_165290` URL (fall back to the page's verified certification-slug URL if that 404s). Run with `node scripts/beta-exams-sync.mjs` only to bootstrap or force a full resync — it overwrites the file.
- **Monitor workflow:** `.github/workflows/beta-exam-monitor.yml` — runs daily 07:00 UTC + manual trigger; script `scripts/beta-exam-check.mjs` fetches each untracked-as-GA exam's Microsoft Learn URL and checks whether the page `<title>` still contains `(beta)` (Microsoft appends this to the exam and certification name for the duration of the beta, e.g. "Microsoft 365 Certified: Microsoft 365 and AI Services Administrator Associate (beta)").
- **On a beta exam going GA:** opens a GitHub issue (`enhancement`) naming the exam(s); marks the entry `flaggedGA: true` so it isn't reported again. A fetch failure is never treated as "went GA" — only a successful fetch confirming the `(beta)` marker is gone triggers the flag.
- **On failure:** opens a GitHub issue (`bug`) only when every tracked exam's fetch failed (site down or blocking requests); a single exam's fetch failure is logged as a warning and skipped that run.
- **Working the list:** verify the exam is genuinely GA on Microsoft Learn, remove its `BETA` status from `src/data_files/exam-status.mjs`, update the exam page's `:::tip` beta banner and Get Started card, then delete its entry from `beta-exams.json` (or leave it `flaggedGA: true` if you'd rather keep history — the monitor will not re-report it either way).

### Retiring exam tracker
- **File:** `src/data_files/retiring-exams.json` — `{ lastSynced, exams: [{ code, area, name, retirementDate, replacementCode?, notified, notifiedAt? }] }`; `retirementDate` is `YYYY-MM-DD`.
- **Sync script (one-time/manual):** `scripts/retiring-exams-sync.mjs` — rebuilds the file from every `examStatuses[area][code]` entry with `{ text: "RETIRING", variant: "danger" }`, pulling the exam name from that page's frontmatter `description` and the retirement date from its `<RetirementBanner retireDate="...">` prop or inline `:::caution` text (whichever the page uses), normalized to ISO. Run with `node scripts/retiring-exams-sync.mjs` only to bootstrap or force a full resync — it overwrites the file, but preserves any existing `notified`/`notifiedAt` state.
- **Monitor workflow:** `.github/workflows/retiring-exam-monitor.yml` — runs daily 05:00 UTC + manual trigger; script `scripts/retiring-exam-check.mjs` does pure date math against the tracker (no network calls) and flags any exam whose `retirementDate` is yesterday (UTC) or earlier and not yet `notified`.
- **On a retirement notification:** opens a GitHub issue (`enhancement`) naming the exam(s) and their retirement date; marks the entry `notified: true` so it fires exactly once, even if a workflow run is missed for a day or two.
- **On failure:** opens a GitHub issue (`bug`) only when the tracker file itself is corrupt/unreadable.
- **Working the list:** confirm the exam is actually retired (Microsoft Learn, the page's `RetirementBanner`/`:::caution` text), update the exam page to reflect retirement, then either remove the `RETIRING` status from `src/data_files/exam-status.mjs` (if replaced by a new exam already tracked separately) or leave the entry in `retiring-exams.json` as a historical record — the monitor will not re-notify a `notified: true` entry.

### Adding a new exam to either tracker
When an exam newly becomes beta or retiring (i.e. you're adding `{ text: "BETA", variant: "tip" }` or `{ text: "RETIRING", variant: "danger" }` to `examStatuses` in `src/data_files/exam-status.mjs` for the first time), also add a matching entry directly to `src/data_files/beta-exams.json` or `src/data_files/retiring-exams.json` by hand — the sync scripts are not re-run automatically for single additions.

---

## Partner Designation Skilling Requirements

Tracks the Microsoft Partner solution-area pages that back the three-level skilling tabs on `src/content/docs/guide/partneremployees.mdx` ("New Microsoft Partner designations" section), and alerts when Microsoft changes one of those pages so the static tab content can be re-verified. Not rendered on the site itself, not part of the build.

- **File:** `src/data_files/partner-designations.json` — `{ lastSynced, pages: [{ label, url, areas, contentHash, lastChanged? }] }`
- **Monitor workflow:** `.github/workflows/partner-designations-monitor.yml` — runs Monday 08:00 UTC + manual trigger; script `scripts/partner-designations-check.mjs` fetches each tracked Partner Center page, strips it to normalized plain text, and hashes it (SHA-256). It does **not** attempt to re-parse certification names or point values automatically — the prose formatting differs too much page to page (mandatory-gate steps for the three Azure areas and Security vs. flat per-person lists for Business Applications and Modern Work) to parse reliably without silent breakage. A hash mismatch just means "this page's content changed since we last checked" and needs a human to re-read it.
- **Tracked pages:** the Azure solutions page covers three areas at once (Data & AI, Digital & App Innovation, Infrastructure), so it's tracked as a single entry with all three listed in `areas`; Security, Business Applications, and Modern Work are each their own entry.
- **On first run for a page** (`contentHash` is `null`): the current hash is recorded as the baseline silently — no issue is opened, since there's nothing to compare against yet.
- **On a real change:** opens a GitHub issue (`enhancement`) naming the page(s)/area(s) that changed; updates `contentHash`/`lastChanged` so the same change isn't reported again next run.
- **On failure:** opens a GitHub issue (`bug`) only when every tracked page's fetch failed (site down or blocking requests); a single page's fetch failure is logged as a warning and skipped that run.
- **Working the list:** open the page's URL, re-read its "Skilling" category (mandatory-gate certifications, scored certifications, and the per-tier point values/caps), and update the matching Level 1/2/3 tabs in `partneremployees.mdx` to match — including the "Total skilling points: X/70" line for that area. Also update the certification lists' retirement footnotes if Microsoft added or resolved one.

---

## Microsoft Learn Content Research Caches

The local, AI-queryable JSON caches of Microsoft Learn training modules and
documentation pages (formerly `src/data_files/learn-catalog.json` and
`docs-catalog.json`, their sync scripts, and their weekly GitHub Actions
workflows) have moved to a dedicated repo: **https://github.com/mscerts/learnsync**.

They were always pure reference datasets for content research — never
imported by this site's build — so extracting them keeps this repo's history
and CI focused on the actual site, while the caches get their own
independent weekly refresh schedule, issue tracker, and quarantine-triage
workflow.

- **Learn Catalog** (training modules): `data/learn-catalog.json` in that repo, built by `scripts/learn-catalog-sync.mjs`.
- **Docs Catalog** (documentation pages): `data/docs-catalog.json` (+ `data/docs-catalog-invalid.json` quarantine list) in that repo, built by `scripts/docs-catalog-sync.mjs`.

See `mscerts/learnsync`'s own `AGENTS.md` for the full operational detail:
category filters, subject-enrichment rules, per-repo URL gotchas, the
automated link-checking/quarantine model, and the auto-filed
"investigate newly broken URLs" issue flow. If you're doing content research
that needs either cache (e.g. the hands-on unit/module syntax convention
above), clone that repo or fetch the file directly from its `main` branch.

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
