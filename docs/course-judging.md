# Judging the candidates: verdicts, confidence and evidence quotes

*Runbook of the judging protocol (`scripts/course-judge.mjs`, `scripts/lib/course-judge.mjs`). Repo-wide rules live in [AGENTS.md](../AGENTS.md). Its input is the shortlist of [course-candidates.md](course-candidates.md); the classes it uses are those of [courses.md](courses.md). What happens to a verdict next (the approval gates and the review queue) is [course-gates.md](course-gates.md).*

The candidate generator finds pages that share the words of a task. It cannot tell which of them belong in a course. A judge (an AI) does that, one skill group at a time, and this protocol makes the answer **checkable**:

- the judge must give every candidate a **verdict**, a reason, a **confidence** and, for a pick, a **quote** that a script verifies really is in the text it was shown;
- the checked answer is merged with its batch into one judged file, which is what the gates decide on.

There is no second model that challenges the picks: a skeptic stage existed until 2026-10-21 and was removed (see "No skeptic" below).

No AI is part of the code. The scripts build prompts and check, verify and merge answers; a person or an agent session gives a prompt to a model and saves its JSON answer. That keeps keys and model calls out of the repository and out of CI.

## The verdicts

| Verdict | Meaning |
|---------|---------|
| `core` | Covers the task **as the study guide words it**. |
| `supporting` | Not in the guide, but part of the job the task belongs to. Needs a `relation` (`prerequisite`, `same-workflow`, `operate`, `deeper`; their meanings are those of `RELATIONS` in `course-format.mjs`, and the prompt is built from them). |
| `reject` | Everything else, above all **out of scope**: another job role, product area, licensing tier or specialty, however close the keywords look (the model case is AZ-104's "Manage external users" and a page on entitlement management). Also a page that only mentions the keywords, a generic overview, a retired page. |

These are the two classes of a course pick plus rejection; a rejection is what the rejected list of the course file remembers.

The judge may also **flag** a candidate it picks: `other-role`, `other-sub-product`, `licensing-tier`, `level-mismatch`, `preview`, `outdated` (meanings in `FLAGS`). The gates mark a pick that carries one of the first three for review on the course page; the others are warnings. It gives a `confidence` (`high`, `medium`, `low`).

**Two rules of the maintainer, built into the rubric (2026-10-19):**

- **A task has no limit of pages.** A relevant page is a pick, however many others the task already has.
- **A judge that is not sure does not dismiss.** It gives the verdict it leans to with `confidence: low` and says what it is unsure about; it must not lower a verdict "to be safe" or reject what it cannot place (the first rubric said "when in doubt take the lower one", which pushed doubtful pages down into rejects; that rule is gone). A `low` goes to the maintainer, who is the final judge: a `low` pick and a `low` **reject** both wait in the queue ([course-gates.md](course-gates.md)); only a reject with `high` or `medium` confidence is final. A `low` reject should carry a quote, so that the maintainer sees what the judge saw.

## Fundamentals tasks

The fundamentals of a skill group ([courses.md](courses.md)) are judged in the batch of the group, as its **last task**, marked `"foundation": true` with the group's task wordings in `groupTasks`; the prompt then has an extra "Fundamentals" section (`foundationRubricText()`). The verdicts for such a task are only **`foundation`** (a page that teaches the theory, concepts, terminology, architecture or "how it works" behind the group's tasks at an introductory or conceptual level: be liberal, pick it even when it covers one concept of several, overlaps another page or comes from another exam's fundamentals course) and **`reject`** (a procedure, anything hands-on, an advanced deep dive, another role or product area, a page that only mentions the words, a retired page). `core`, `supporting` and a `relation` are sent back for these tasks, and `foundation` is sent back for a real task. A `foundation` pick needs a `quote` like any pick; `why` names the concept the page teaches; flags and confidence are as before, so an unsure pick is marked for review.

`node scripts/course-judge.mjs prepare <CODE> --foundations-only` writes batches of the fundamentals alone (the tasks are left out, their wordings stay as context), which is the cheap way to judge them on their own; `--group` picks one skill group.

## The files

All of a batch's files share a prefix, `<CODE>.<nn>-<group>` (for example `AZ-104.03-manage-microsoft-entra-users-and-groups`), in `<tmp>/course-judge` unless `--out` says otherwise. Nothing is written to the repository.

**A big group is cut into parts.** A skill group with more than 150 candidates (`--max-candidates N`, default `DEFAULT_BATCH_CANDIDATES`) is split into parts of at most that many, in task order and, within a task, in provenance order (`P1` first, `P4` last); a task with more candidates than a part holds continues in the next. A part has its own prefix (`AZ-104.08-create-and-configure-virtual-machines-p3of19`), `batchId` (`<group>#3`) and `part` field, and is judged, checked and merged on its own; its prompt says which part it is. Every candidate is in exactly one part, nothing is dropped, and the gates read the merged parts as one exam. The batch is written to the prompt as compact JSON (no indentation, about a third fewer tokens than pretty-printed).

| File | Written by | What it is |
|------|-----------|------------|
| `<prefix>.batch.json` | `prepare` | The skill group: its tasks, and per task every candidate with where it came from and its **evidence**. |
| `<prefix>.judge.md` | `prepare` | The judge's prompt: rubric, answer format and the batch. |
| `<prefix>.judgments.json` | the judge | The answer. |
| `<prefix>.judged.json` | `merge` | The judge's answer per candidate. |

The **evidence** of a candidate is the text a judge may quote: for a module its title, its unit titles and its products; for a unit its own title, its module's title and the other units of that module; for a documentation page its title, its description and the texts of the links modules use to point to it. It is exactly what the quote check compares with, so the check never depends on anything the judge did not see.

## The judge's answer

```json
{
  "schemaVersion": 1,
  "kind": "judgments",
  "batchId": "networking/configure",
  "judgedBy": "the model or session",
  "judgments": [
    { "task": "<task key>", "target": "/training/modules/x/3-unit", "verdict": "core",
      "why": "One plain sentence.", "quote": "words copied exactly from one evidence snippet",
      "flags": [], "confidence": "high" },
    { "task": "<task key>", "target": "/azure/y/z", "verdict": "supporting", "relation": "prerequisite", "why": "...",
      "quote": "...", "flags": ["preview"], "confidence": "medium" },
    { "task": "<task key>", "target": "/entra/id-governance/w", "verdict": "reject",
      "why": "Identity governance, not part of this job.", "flags": ["other-sub-product"], "confidence": "high" }
  ]
}
```

`check` sends an answer back for each of these (the judge redoes only those entries):

- not the batch's `batchId`, wrong `kind` or `schemaVersion`;
- a candidate not judged, judged twice, or a task or target that is not in the batch;
- a verdict that is not `core`, `supporting` or `reject`; a `supporting` pick without a valid relation; a relation on anything else;
- no `why`, or one over 300 characters; flags that are not in the list; a confidence that is not `high`, `medium` or `low`;
- a pick without a `quote`, an empty one, or one over 200 characters;
- **a pick whose quote is not in the evidence.** The quote is compared by whole words, ignoring case, quote marks, dashes and spacing; it must be at least two words unless it is a whole one-word snippet, and the words must be in order. A `reject` may carry a quote, which is checked and reported but never sends the answer back.

Each quote also gets a `quoteTermCoverage`: the share of the task's distinctive words (an abbreviation counting for its long form) that the quote contains. It is only recorded; the gates will use it, because a quote that says nothing of the task is no evidence for it.

## No skeptic

A second, independent model (the *skeptic*) used to try to refute every pick; its stance (`uphold`, `downgrade`, `refute`) was merged into the judged file and a refutation queued the pick for the maintainer. **It was removed on 2026-10-21**, together with the `skeptic` command, `--no-skeptic` and the `agreement` field, after the maintainer's own answers were compared with it (AZ-104):

- It refuted 76 of the 907 picks (8%), downgraded 39 and upheld 792. It never refuted a pick the judge had high confidence in (0 of 268); 55 of the 76 refutations were on the 125 picks the judge was unsure of. A downgrade only changes the order on the page.
- Of 18 refused pages in a random sample of the queue, the maintainer kept 13 (72%; 95% interval 49% to 88%). The refusals the maintainer overruled said "beyond the exam's level", "a better page is already picked" or "a different direction".
- The prompt was narrowed to "refute only a page that is wrong" (2026-10-20) and the skeptic re-run, blind, over 103 pages the maintainer had marked (97 kept, 6 dropped): it refused 2 pages, both kept, and none of the 6 dropped. It read the Google Cloud copy as "the tool is the one the task names" and the Windows Server hybrid backup as "an Azure administrator configures the same policies". The old prompt refused 5 of the 6, and 13 of the 97 kept pages with them.
- The re-run cost about 540,000 subagent tokens for those 103 pages (roughly 4.7 million for all picks); on prompt volume the skeptic was a third to a half of the judging work.

What replaced it: the judge's own confidence and out-of-scope flags. A pick the judge is not sure of (`confidence: low`) or flagged `other-role`, `other-sub-product` or `licensing-tier` is in the course and is marked, with the judge's reason, on the review copy of the course page, where the maintainer reads it and gives the numbers to drop ([course-gates.md](course-gates.md)). Of the 9 flagged pages among the 103, the maintainer dropped 2 (22%); of the 94 unflagged ones, 4 (4%). Old runs keep their `skeptic` and `agreement` fields; nothing reads them.

## The judged file

`merge` writes, per candidate, `judge` (verdict, relation, reason, confidence, quote with `quoteVerified`, `quoteWhere` and `quoteTermCoverage`, flags) and the candidate's own card (target, title, source, `via`, signals) without the evidence, which stays in the batch; `flags` repeats the judge's flags. `stats` counts candidates, verdicts and unverified quotes. `merge` refuses a judgments file that `check` would send back, unless `--keep-unverified` keeps a quote that is not in the evidence and marks it (`quoteVerified: false`), which the gates queue.

## Running it

```bash
node scripts/course-candidates.mjs AZ-104                  # the shortlist (course-candidates.md)
node scripts/course-judge.mjs prepare AZ-104 [--group "external"] [--max-candidates 150]   # batches and prompts; prints their size
# give <prefix>.judge.md to the judge, save its JSON as <prefix>.judgments.json
node scripts/course-judge.mjs check <prefix>               # exit 1: the judge redoes the listed entries
node scripts/course-judge.mjs merge <prefix>               # <prefix>.judged.json
```

How to run it:

- **Who judges:** a local Claude session; with subagents, one per skill group, each given only the contents of `<prefix>.judge.md`. The repository holds no API keys and nothing runs in CI.
- **Redo only what `check` lists.** Send the judge the entries it names and ask for corrected entries; replace those in the file and check again.
- **Estimate the cost first.** `prepare` prints the size of every prompt in rough tokens (characters / 4) and the total. Measured on AZ-104 on 2026-10-17 (shortlist capped): 15 batches, about 0.6 million prompt tokens, and about 5 million tokens of subagent usage in all for judge and skeptic (the skeptic stage has gone since, so expect about two thirds of that) (each session reads its prompt in several steps, so usage is a multiple of the prompt). With no cap (2026-10-19): 13,099 candidates, 95 parts of 3,000 to 45,000 tokens each and about 2.2 million prompt tokens, so expect roughly two to three times that usage. Paths for `check`: use forward slashes in Git Bash (backslashes are eaten there).

## Not covered here

- **The approval gates, the review queue and remembered decisions** read the judged files: auto-accept (a pick the judge made, any source and confidence, with a quote that is in the evidence; one the judge is not sure of or flagged as out of scope is marked for review; hands-on pages the judge picked), queue (an unverified quote, low confidence in a **reject**) and auto-reject (a reject the judge is sure of, classic material, hands-on pages the judge did not pick). See [course-gates.md](course-gates.md).
- **The quote check is on the cached text only** (titles, unit titles, descriptions, link texts). It proves the judge did not make a quote up, not that the page's body says what the judge infers; it cannot be stricter without fetching the live page. If quotes prove too loose, a live check at judge time is the next step.
- **Rejections are not challenged.** A wrong rejection is only caught when the judge itself was unsure (`low` confidence), which sends it to the maintainer; a confident wrong rejection costs recall, not correctness.
- **`judgedBy` is free text.** Nothing checks which model answered.
- **One exam has been judged, once.** AZ-104, on 2026-10-17 with the shortlist capped, at the maintainer's request (30 subagent sessions). The rubric and the shortlist have changed since (see above); the formal pilot ([course-playbook.md](course-playbook.md)) has not been run.

## Tests

`tests/scripts/course-judge.test.mjs` and `course-judge-cli.test.mjs`, offline. They use `tests/scripts/helpers/example-judging.mjs`, which builds candidates and valid answers on the invented corner of Learn of `example-candidates.mjs`; nothing in it says what a real exam covers or how a real judge answers.
