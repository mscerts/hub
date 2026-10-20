# Hands-on pages: from the course to the lab page

*Runbook of `scripts/course-labs.mjs` and `scripts/lib/course-labs.mjs`, with the rules of `scripts/lib/course-handson.mjs`. Repo-wide rules live in [AGENTS.md](../AGENTS.md), the lab page rules under "Lab Pages" and "Lab Page Workflow". The builder that writes the input is [course-build.md](course-build.md).*

A course page does not show hands-on material, and a lab page is where it belongs (maintainer, 2026-10-20). The builder leaves the accepted hands-on pages out of the course and lists them in `<out>.routing.json`; this tool compares that list with the exam's lab page and prints the cards the lab page lacks. **It changes nothing**: a lab page's layout differs from exam to exam (AZ-104's Microsoft Learn tab has a sub-tab per area), so a person places the cards.

```bash
node scripts/course-labs.mjs AZ-104 --routing <tmp>/course-build/AZ-104.routing.json [--lab FILE]
```

## What counts as hands-on

`handsOnReason` (`scripts/lib/course-handson.mjs`), in this order:

| Page | Hands-on when |
|------|---------------|
| any | the address is an Applied Skill (`/credentials/applied-skills/`) |
| a module | its title starts with "Guided project" or "Challenge project", or its slug starts with `guided-project-` or `challenge-project-` |
| a unit | its module is such a project (by the module's title in the catalog, or by the slug), whatever the unit's own title says |
| any | the title has the whole word "exercise" (anywhere, any case), or starts with "Lab" or "Simulation" and a separator (`-`, `–`, `—`, `:`); bare "lab" or "simulation" inside a title is reading |
| a docs page | the title has the word "tutorial" or "quickstart", or an address segment is `tutorial(s)`, `quickstart(s)`, `quick-create…` or `quick-start…` (a quickstart whose title lost its prefix) |

The first four are the syntax of AGENTS.md ("Hands-on unit/module syntax"). **The tutorial and quickstart rule is the maintainer's** (2026-10-20: a tutorial belongs on the lab page like an exercise); a how-to or a concept page is not hands-on. A module that merely contains exercise units is not hands-on as a whole: it stays in the course, and its exercise units are on the lab page.

## What the report says

- which of the routed pages the lab page has already: the same address, the same unit under another position number, or (for a project module) any unit of that module;
- for each missing page the `LinkCard` line to add, grouped by the domain of the study guide, titled like the lab page's own (no "Exercise - " or "Simulation - " prefix, a capital first letter; a tutorial, a quickstart and a project keep their names), with the hub's tracking parameter and no description;
- the tabs of the lab page, to place the cards by.

Exit code 0 when the report was printed; 2 for a usage problem, a routing file that is not one (or is for another exam), or an exam without a lab page (create it first, "Lab Pages" in AGENTS.md).

## Working it

1. Build the course (`course-build.mjs`); read the summary line: how many hands-on pages, how many repeats.
2. Run this tool; add the missing cards to the lab page by hand in the tab that fits (a domain's area; Learn exercises and docs tutorials sit together), in the editor.
3. Run it again: nothing should be missing.
4. `pnpm build` (the lab page is a normal page).

## Tests

`tests/scripts/course-handson.test.mjs`, `course-labs.test.mjs` (this tool) and `course-routing.test.mjs` (the builder's side), offline.
