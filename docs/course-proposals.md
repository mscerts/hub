# Model proposals: the pages a word search cannot find

*Runbook of the proposal step (`scripts/course-propose.mjs`, `scripts/lib/course-propose.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). It sits between the [candidate generator](course-candidates.md) and the [judging protocol](course-judging.md); the classes and sources it feeds are those of [courses.md](courses.md).*

The candidate generator finds a page when the page's title, description, address or link texts share words with a task. A page that teaches the task without those words is invisible to it: on AZ-104, 140 of the 365 pages of a single-prompt course page were on no shortlist even with every limit off, 115 of them relevant when judged (see "Why" below). A model knows such pages. This step asks a model, task by task, which Microsoft Learn pages teach it, **checks that every page it names exists**, and adds the ones that do to the shortlist as a fifth source, **`P5`**. Everything after that is unchanged: the judge and the skeptic decide whether a `P5` page belongs, exactly as for a page the word search found.

No AI is part of the code. The scripts build prompts and look pages up; a person or an agent session gives a prompt to a model and saves its JSON answer.

## What a proposal proves

That the page exists, nothing more. A model writes addresses from memory, so some are old (Learn moved them), some are slightly wrong and some do not exist. The check follows, in this order:

1. **The address.** Host and language stripped, lower case, no query, fragment or trailing slash. A page that is not on `learn.microsoft.com` is dropped (`not-learn`); a learning path, course, credential or video is not a page a course can pick (`not-a-page`).
2. **Learn's moves** (`docs-redirects.json`, followed up to five times): a page that moved lives at its new address whatever the old one still says (`how: moved`).
3. **The address as written**, when it is a live page of the catalog (`how: path`). A training module is looked up in the module catalog; a unit of a module outside the exam's courses becomes its module (`how: unit`).
4. **The title**, when the address failed: the exact title, with or without the product the catalog appends ("Assign roles using the portal - Azure RBAC"), in the area the model named; the same title on several pages is settled by the closest address and never guessed on a tie (`how: title`, `ambiguous-title`).
5. The hard filters of the generator (retired, moved, not in the cache, boilerplate, not English) drop what exists but must not be offered (`dropped`).

A page that is live but has no text in the catalog cannot be judged and is counted as `no-catalog-text`.

## The files

All of a batch's files share a prefix, `<CODE>.<nn>-<group>`, in `<tmp>/course-propose` unless `--out` says otherwise. Nothing is written to the repository.

| File | Written by | What it is |
|------|-----------|------------|
| `<prefix>.propose-batch.json` | `prepare` | The skill group and its tasks (key and wording). **Nothing the word search found is in it.** |
| `<prefix>.propose.md` | `prepare` | The prompt: the tasks, what to name, the rules, the answer format. |
| `<prefix>.proposals.json` | the model | The answer: per task a list of `{ path, title, why }`. |

The prompt tells the model to answer from what it knows (no files, browsing or search), that there is **no limit and no minimum** per task (the maintainer's rule: a relevant page is a pick, however many there are), to give its best guess and the exact title when it is unsure of an address, and not to pad. Its examples are from an unrelated product so that they do not steer the answer.

`check` validates an answer against its batch: the right `kind`, `schemaVersion` and `batchId`, every task a key of the batch and answered once, every page with a path or a title, a `why` of at most 200 characters. A task left out is not an error (the model may know nothing for it).

## The merge

`merge` reads the generator's candidates file and every `<CODE>.*.proposals.json` of the answers folder, looks each page up, and writes a copy of the candidates file in which:

- a proposed page the generator already had is marked **`alsoProposed: true`** (the word search and a model agree), and is not added again; a proposed module counts as already there when one of its units is a candidate;
- every other page that exists is added with `source: "P5"`, after the task's other candidates, with the word search's score and coverage as a hint (they are often low; the judge is told they are not evidence), the model's `why` and how the page was found (`proposal: { why, asked, how }`);
- `stats.bySource` counts `P5`.

`--only-new` keeps just the new `P5` candidates (every task stays, so a skill group keeps its tasks), to judge them without judging the shortlist again. The report (`<out>.report.json` and the printed summary) says how many pages were proposed, how many exist and how (address, move, unit, title), how many were already candidates or new, and the ones that were not found or were dropped, with the reason.

## Running it

```bash
node scripts/course-candidates.mjs AZ-104                       # the word search first (course-candidates.md)
node scripts/course-propose.mjs prepare AZ-104                  # a batch and a prompt per skill group (about 800-900 tokens each)
# give each <prefix>.propose.md to a FRESH model session, save its JSON as <prefix>.proposals.json
node scripts/course-propose.mjs check <prefix>                  # exit 1: the model corrects the entries listed
node scripts/course-propose.mjs merge AZ-104 --only-new --out <tmp>/course-candidates/AZ-104.p5.json
node scripts/course-judge.mjs prepare AZ-104 --candidates <tmp>/course-candidates/AZ-104.p5.json --out <dir>
# judge, check, skeptic, merge as in course-judging.md; then gate with the judged files of both runs in one folder
```

- **Who proposes:** a local Claude session per few skill groups, given only the prompt. It must not see the exam's existing course page or the shortlist: a proposal is only independent of the word search, and a fair test of the step, if the model answers from its own knowledge.
- **Judge the new pages only.** `--only-new` makes a candidates file with just the `P5` pages the shortlist did not have. If the earlier shortlist was judged already, judge this file into its own folder and give `course-gates.mjs gate --judged` one folder that holds the judged files of both runs (rename the second run's files so that their prefixes differ, for example `AZ-104.p5-01-...`). A page that both found is judged in the first run only; the flag `alsoProposed` is in the full merged candidates file (without `--only-new`).
- **The judge's rubric** says what `P5` is and that being named is no evidence.

## Policy

A `P5` pick is the maintainer's call, like a `P4` pick (`approvalPolicy` in `course-format.mjs`; the queue says "named by a model only (P5)"). The proposal source adds candidates; it does not change who may approve them. Whether a pick that the judge was sure of and the skeptic upheld may go onto the page without waiting, whatever its source, is a separate gate decision for the maintainer.

## Why (AZ-104, 2026-10-20)

Measured with the single-prompt course page as a source of proposals: of its 212 pages the pipeline had never judged, the judge and skeptic found 185 relevant (87%); the 134 of them on no shortlist at all, even with no limits, were 86% relevant, and for 45 of the 82 tasks they were the only relevant page. Thresholds do not reach them: asking less of a page's words gives 5 to 8 points of reach for 2 to 3.5 times the candidates. The generator's index holds a page's title, description, address words and link texts, not its body (of 41 task words the index missed on a sample of 16 pages, 28 were in the body), and a task whose exam course has no strong module of its own asks a search-found page to cover 80% of the task's words (29 of the 82 tasks; the generator reaches 38% of the original page's picks there against 75% elsewhere).

**The run** (AZ-104, 2026-10-20): one session per skill group (15), prompt only, no shortlist and no course page. The model proposed 507 pages; 481 exist (418 by the address, 53 found by asking Learn where the old address leads, 10 by the exact title), 26 do not or cannot be judged. 150 were on the judged shortlist already, 12 were repeats and **319 were new** (308 docs pages, 11 modules; 75 tasks gain at least one). The judge picked 308 and the skeptic refuted 4: 304 stand, 296 of them firm, against the shortlist's 599 picks of 1,496 candidates; 6 were rejected with confidence. On the 95 pages that this judge and the earlier experiment's judge both saw, the relevant/rejected call was the same every time. A pick rate this high is expected for pages chosen for a task and is **not a measure of precision**: the judge reads titles and descriptions only, and a person has not checked a sample (a read of 28 of the 196 firm proposals that are not on the original page found them all plausible, 6 of them broad overview pages labelled prerequisite).

What it adds: with the 599 picks of the first run, 903 picks and all 82 tasks with 3 or more (73 before; 9 tasks lifted, 72 gain a page). It reaches 193 of the original page's 365 picks, the word search with every limit off 225, the two together 285; of the 140 picks no word search reaches, the model names 60. In the 29 tasks without a strong module the model reaches 48% of the original page's picks there and the search 38%. The two sources are complements.

The gates leave every proposal in the queue (the policy above), so the accepted page does not change (196 picks). A simulation of a gate that also accepts a queued pick the judge is sure of and the skeptic upholds, whatever its source, gives 723 picks with 79 tasks at 3 or more (441 and 64 if proposals are left out); the course format would first have to allow that decision. The full comparison with the single-prompt page is in the run folder, not in the repository.

## Tests

`tests/scripts/course-propose.test.mjs` (prompt, answer check, lookup, merge) and `course-propose-cli.test.mjs` (the commands), offline, on the invented corner of Learn of `tests/scripts/helpers/example-candidates.mjs`: addresses in every written form, a moved page, a title rescue, a tie, a module, a unit, a removed module, a retired page, a live page without text, and a merge in which the word search and the model agree.
