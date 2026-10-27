# The audience profile: resources the maintainer decides

_Runbook of `scripts/course-audience.mjs` and `scripts/lib/course-audience.mjs`. Repo-wide rules live in [AGENTS.md](../AGENTS.md). The course file and the page are described in [courses.md](courses.md), the candidate generator in [course-candidates.md](course-candidates.md), the proposals of a model in [course-proposals.md](course-proposals.md)._

A study guide opens with an **audience profile**: who the exam is for and what a candidate should already know ("You should be familiar with: operating systems, networking, servers, virtualization", "In addition, you should have experience with: PowerShell, Azure CLI, the Azure portal, ARM templates or Bicep, Microsoft Entra ID"). The course page opens with the same section, and a concept can have a button to a resource that helps a candidate who lacks that background.

**Unlike every other pick of the course, these are decided by the maintainer alone** (2026-10-26). The process proposes options; nothing is accepted, rejected or ranked by a judge, and nothing is chosen automatically. A concept like "Networking" is general: there are many fine resources, some are not on Microsoft Learn at all (the networking and IT courses of the Cisco Networking Academy, say), and only a person can say which serves the course best. So the chain here has one automatic step (options) and one manual step (the decision), and the decision may be a page of **any** https site.

## What is parsed

`parseAudience` in `scripts/lib/course-guide.mjs` (and `parseGuide(...).audience`) reads the section of the stored guide (`## Audience profile`, any heading level) up to the next heading:

- `intro`: the paragraphs before the first list, shown on the page as written.
- `lists`: every list with the line that leads it. A list is a `prerequisite` list when its lead says what a candidate should be **familiar with**, **know**, **have experience with** and so on (`familiar`, `experience`, `knowledge`, `proficien…`, `background`, `competenc…`, `skilled`, `understanding`, `training in`), and a `role` list otherwise, or when the lead says **responsibilities** or **tasks**. A role list is shown as text; only the items of a prerequisite list are **concepts** with a key (`audience/<lead>/<item>`) and can get resources.
- A guide that describes the audience in prose only (SC-300: "You should be familiar with Azure, Microsoft 365 services ... and Active Directory Domain Services") has no list and so no concept. 57 of the 57 stored guides have the section; AZ-104 has two prerequisite lists with 9 concepts. Writing the concepts of a prose guide by hand is not built.

## The commands

```bash
node scripts/course-audience.mjs options AZ-104 [--out DIR] [--max N]   # options per concept: the same search as the fundamentals, N per concept (12)
node scripts/course-audience.mjs prepare AZ-104 [--out DIR]               # a proposal prompt per list of concepts
# give each <prefix>.propose.md to a FRESH model session, save its JSON as <prefix>.proposals.json
node scripts/course-propose.mjs check <prefix>                            # the same check as for the tasks
node scripts/course-audience.mjs merge AZ-104 --options FILE --answers DIR  # the pages that exist are added as P5
node scripts/course-audience.mjs sheet AZ-104 --options FILE --out sheet.md # the sheet to read
node scripts/course-audience.mjs choose AZ-104 4 1,3                      # concept 4: options 1 and 3 of the sheet
node scripts/course-audience.mjs add AZ-104 "Networking" --url https://www.netacad.com/courses/networking-basics --title "Networking Basics (Cisco Networking Academy)" --why "..."
node scripts/course-audience.mjs none AZ-104 PowerShell                   # the concept needs no resource
node scripts/course-audience.mjs clear AZ-104 PowerShell                  # forget the decision
node scripts/course-audience.mjs status AZ-104                            # concepts and decisions
```

Defaults: the options are `<tmp>/course-audience/<CODE>.audience.json`, the proposals `<tmp>/course-propose/<CODE>.audience-<nn>.*`, the decisions `src/data_files/course-audience/<CODE>.json`. A `<concept>` is its number on the sheet, its key or a unique part of its wording. `choose` and `none` replace what was decided for the concept; `add` adds a page (the same address twice is refused). Exit codes: 0 done, 1 a decisions file that is not valid, 2 usage or input error.

## Where the options come from

- **The search** (`options`): `generateCandidates` with `audienceOnly`. A concept goes through the same search as the fundamentals of a skill group (looser thresholds than a task, hands-on pages dropped) and the list is cut to the best `--max` by **how many of the concept's words a page covers**, not by source: a concept is a word or two, and the exam's own course would otherwise fill the list with its modules. The search is weak for such general words (on AZ-104 "Operating systems" gets Azure Monitor Agent pages, "Virtualization" gets SQL data virtualization): the options are a place to look, not a recommendation.
- **A model** (`prepare`, `merge`): a fresh session names two to five pages per concept from its own knowledge, offering a choice from an overview to a hands-on introduction, with a `why` of at most 15 words. A script checks that every page exists (the same lookup as [course-proposals.md](course-proposals.md), `P5`). Only pages of Learn are proposed. On AZ-104 36 pages were named, 15 exist and 20 were not found; the sheet lists the pages a model named **first**, then the search results.
- **The maintainer** (`add`): any https address and a title for the resource. Nothing checks that the page exists or is current; the maintainer chose it. A Learn address is stored as a Learn pick (path without the locale, the tracking parameter is added by the page), any other as an external pick.

## The decisions file

`src/data_files/course-audience/<CODE>.json`, committed by the maintainer, kept sorted by key:

```json
{
  "schemaVersion": 1,
  "kind": "audience-decisions",
  "code": "AZ-104",
  "concepts": [
    {
      "key": "audience/you-should-be-familiar-with/networking",
      "text": "Networking",
      "picks": [
        {
          "title": "Networking Basics (Cisco Networking Academy)",
          "href": "https://www.netacad.com/courses/networking-basics",
          "kind": "external",
          "source": "maintainer",
          "why": "Picked by the maintainer on the Cisco Networking Academy site.",
          "decidedAt": "2026-10-26"
        }
      ]
    }
  ]
}
```

`source` is `option` (chosen from the sheet) or `maintainer` (added by address). A concept with an empty `picks` list is decided to need no resource; a concept that is not in the file is not decided yet. A decision for a concept the guide no longer has, or worded differently, is a warning (the guide changed).

## In the course file and on the page

`course-build.mjs` reads the decisions (`--audience FILE` for another file) and writes the guide's audience into the course file as `audience: { intro, lists: [{ lead, kind, items: [{ key, text, picks? }] }] }`. It is not part of the tasks: it is not a pick of a task, so "every page appears once" does not apply to it, the rebuild check does not count it among the picks, and a Learn page chosen here that is also a pick of a task is only a **warning** of the validator (the maintainer decided).

The page opens with `## Audience profile` before the first domain: the guide's paragraphs, then for each list a heading and a card for **each chosen resource** (title = the concept, description = the resource's name, the button goes to the resource; a Learn address gets the tracking parameter, an external one opens as it is), then the concepts without a resource as a plain list. The review copy adds a note counting the concepts nobody has decided yet. The sections of the page that the study guide tree check reads (`course-source.mjs --check`) do not include it.

## Keeping it true

The validator refuses a course whose audience differs from the guide's (`the audience profile differs from the study guide's`), and the rebuild check (`course-status.mjs`) reports **review** when the guide's audience profile changed since the course was built: the concepts that were added or removed (choose resources for them) or the wording.

## Not covered

- Prose-only audience profiles have no concepts.
- No check that an external address still answers; the Link Checker's allowlist is not extended to these.
- The options are not judged and not ranked beyond the order above; asking a judge would mean the AI decides.

## Tests

`tests/scripts/course-audience.test.mjs`, offline: the parser on the stored AZ-104 guide and invented shapes, the keys, the picks and their checks, the decisions file, the options of the generator on the invented exam, the prompt, the sheet, the page, and the command line on a temporary hub.
