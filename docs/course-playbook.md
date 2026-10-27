# The course playbook: the pilot and the rollout

_How the course tooling is run on real exams, in order, and how anyone can tell whether it worked. Repo-wide rules live in [AGENTS.md](../AGENTS.md). The format of a course is in [courses.md](courses.md); each step has its own runbook, linked below._

**Nothing here runs by itself and nothing here is run until the maintainer asks.** The pilot (an exam, a gold set, a blind run, a measurement) and the rollout (the other exams) are procedures. The tools exist and are tested on an invented exam; no real exam has been put through the whole chain.

## The chain

| #   | Step                                                                                | Command                                                                                               | Output (default `<tmp>` = the system temp folder)                                                                                      | Who decides                                                                                                                       |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Study guide and scope (to look at; the later steps read the same inputs themselves) | `node scripts/course-source.mjs <CODE>`                                                               | `<tmp>/course-source/` (guide tree, scope map)                                                                                         | nobody: it reads what Learn says ([course-source.md](course-source.md))                                                           |
| 2   | Candidates                                                                          | `node scripts/course-candidates.mjs <CODE>`                                                           | `<tmp>/course-candidates/<CODE>.candidates.json`                                                                                       | the code: a shortlist per task ([course-candidates.md](course-candidates.md))                                                     |
| 2b  | Fundamentals shortlist                                                              | part of `course-candidates.mjs` (a pseudo-task per skill group, [courses.md](courses.md))             | the `foundations` list of the candidates file                                                                                          | no AI                                                                                                                             |
| 2c  | Audience profile options                                                            | `node scripts/course-audience.mjs options <CODE>`, then `prepare` and `merge` for a model's proposals | `<tmp>/course-audience/<CODE>.audience.json`                                                                                           | **the maintainer decides** each concept (`sheet`, `choose`, `add`); no judge, no gates ([course-audience.md](course-audience.md)) |
| 3   | Judging                                                                             | `node scripts/course-judge.mjs prepare <CODE>`, then the prompts go to a model, then `check`, `merge` | `<tmp>/course-judge/<CODE>.<nn>-<group>.*`                                                                                             | a model (the judge), checked mechanically ([course-judging.md](course-judging.md))                                                |
| 4   | Gates and queue                                                                     | `node scripts/course-gates.mjs gate <CODE>`, then `show`, then answers by hand, then `resolve`        | `<tmp>/course-gates/<CODE>.gated.json`, `<CODE>.queue.json`; the remembered decisions in `src/data_files/course-decisions/<CODE>.json` | the rules accept or reject; **the maintainer answers the queue** ([course-gates.md](course-gates.md))                             |
| 5   | Build                                                                               | `node scripts/course-build.mjs <CODE>`                                                                | `<tmp>/course-build/<CODE>.json`                                                                                                       | nobody: it writes down what was decided ([course-build.md](course-build.md))                                                      |
| 6   | Check and render                                                                    | `node scripts/course-file.mjs validate <CODE> --live`, then `render`                                  | `src/data_files/courses/<CODE>.json`, the page and its review copy                                                                     | **the maintainer moves the file, reads the review copy and links the page** ([courses.md](courses.md))                            |
| -   | Rebuild check                                                                       | `node scripts/course-status.mjs <CODE>`                                                               | prints what to redo                                                                                                                    | the maintainer, when Learn or the guide changed                                                                                   |

Measuring, for the pilot and for every batch after it: `node scripts/course-pilot.mjs` (below). The size of the whole job: `node scripts/course-rollout.mjs`.

Two rules the whole chain keeps:

- **A course changes only when Learn or the exam changes.** The course file carries the guide hash and the scope fingerprint; step 5 refuses inputs that moved since the candidates were made; step 6's rebuild check says what to redo.
- **The AI decides a pick alone when the judge is sure of it; the maintainer is the final judge of the rest.** Since 2026-10-21 every pick the judge makes is in the course when its quote is in the evidence, whatever its source and class (marked samples of AZ-104 support it, [course-gates.md](course-gates.md); there is no skeptic any more). The picks the judge is **not sure** of, or flagged as another role, product area or licensing tier, are in it too and are marked orange, with the judge's reason, on the review copy of the course page; the maintainer reads them there and gives the numbers to drop (`course-gates.mjs review`). A reject the judge is **not sure** of waits in the queue. Only a reject the judge is sure of (`high` or `medium` confidence) is final; it is remembered, not shown.
- **No page is left out for being one too many.** A task has as many resources as there are relevant pages; the shortlist has no cap and the judges are told so ([course-candidates.md](course-candidates.md), [course-judging.md](course-judging.md)). What costs is judging time, which is why a big skill group is cut into parts.

## Before any run

1. `git fetch origin`, and work on the merged state: the monitors push their trackers (`learn-exams.json` among them) to `main` all the time, so the stored study guide must be today's.
2. A learnsync checkout at current `main` (`LEARNSYNC_DIR`, default `../learnsync`). The module-links cache is what makes the best source (`P2`) work: the tools warn when it is missing, and its `lastChecked` says how old it is (the rollout table lists how many modules of each exam have harvested links).
3. `pnpm format:check`, `node --test tests/scripts/*.test.mjs` and `pnpm build` are green on the checkout the run starts from.
4. Decide who runs the model sessions. The judge is a fresh session, shown neither the hand-made course page nor the gold file. In Git Bash give the tools forward-slash paths (`C:/Users/...`): backslashes are eaten there.
5. Keep what a run produced. The tools write to the system temp folder, and the judgments of one exam cost millions of tokens, so copy the folders of a run (`course-judge`, `course-gates`, `course-build`, `course-candidates`) to `.course-runs/<CODE>-<date>/` in the hub folder, which git ignores. A judged exam can be gated, answered and built again from those files without judging it a second time.

## The pilot

The pilot answers one question: **can the automatic part be trusted, so that the maintainer's time goes to the queue and not to re-checking everything?** It runs on AZ-104 first because a hand-made page for it exists to compare with, then on a small slice of two more exams.

### P1. The gold set (before the pipeline runs)

```bash
node scripts/course-pilot.mjs gold-template src/content/docs/courses/az-104course.mdx --include entitlement
```

It draws 25 picks of the existing page, spread over the domains and tasks, always including every pick whose address or title contains the `--include` text (the entitlement management card, which does not belong to AZ-104). `--size` and `--seed` change the sample; the same seed draws the same picks again.

The maintainer opens the file (`<tmp>/course-pilot/AZ-104.gold.json`) and sets `mark` of **every** pick:

- `keep`: a page they would put in a course for this task, as the page does;
- `drop`: a page that should not be there (wrong exam, wrong product, out of date, too deep, an unrelated page).

Add a `note` for a mark that is a judgement call. Do this **before** looking at what the pipeline produces and do not show the file to the sessions that run the judge. The file names the skill groups (`groups`) the pipeline has to run on for the comparison to mean anything.

### P2. The blind run

On the groups of the gold file (or the whole exam, if the budget allows), run steps 1 to 4 of the chain. Run the judge per skill group with `course-judge.mjs prepare AZ-104 --group "<group>"`. The tools never read the hand-made page; the one thing that makes the run not blind is a session that has been shown the gold file or the page, so do not.

Record, as the run goes (these are the numbers the rollout's budget comes from):

- the size of each prompt (`prepare` prints a rough token count) and the real usage of the judge sessions;
- the wall-clock time of the judge work;
- every answer that `check` or `merge` rejected, and what the model did about it.

### P3. The queue

`course-gates.mjs show AZ-104`, answer in the queue file, `resolve`, gate again (the answered items now carry the maintainer's decision, and the same question is never asked again). **Time the answering**: minutes per queue item is the number the rollout's review budget is built on.

### P4. The measurement

```bash
node scripts/course-pilot.mjs sample AZ-104 --size 60          # a random sample of what the gates accepted on their own
# open each url, set "correct" to true or false in <tmp>/course-pilot/AZ-104.sample.json
node scripts/course-pilot.mjs measure AZ-104 --gold <tmp>/course-pilot/AZ-104.gold.json --sample <tmp>/course-pilot/AZ-104.sample.json
```

`measure` prints one line per criterion and exits 0 only when every one is measured and passed:

| Criterion                                                | Pass         | Why this number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic acceptances that are right (the marked sample) | at least 95% | What the gates accept alone is what the maintainer never sees; 1 in 20 wrong is the most a reader should meet. The score also prints how low the share could really be: 38 of 40 is 95% observed and could be 83% in truth, which is why the sample is 60 or more when the population allows.                                                                                                                                                                                                                                               |
| Gold keeps that the pipeline accepted or queued          | at least 90% | Recall: the pipeline must not lose what a person would have picked. A keep found as another page of the same module counts, and is named.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Gold drops that the gates accepted on their own          | none         | The entitlement management card is in the set on purpose. One page the gates let through that a person marked drop means the gates are too loose, whatever the percentages say.                                                                                                                                                                                                                                                                                                                                                             |
| Share of the judge's picks that waited in the queue      | at most 25%  | Above it the review is the whole job and not the exception. `gate` prints why items wait (`queueReasons`); if one reason dominates, that is the thing to tune. **Open question:** the first AZ-104 run queued 67% of the picks (every `P4` page waited by policy) and, with the rule that unsure rejects wait too, more. Since 2026-10-20 the gates accept a sure and agreed pick of any source, so what waits is what the AI is unsure about; measure the share again and let the maintainer decide whether 25% is still the right number. |

Not measured by the tool, and required: every pick is a current Learn page (`course-build.mjs <CODE> --urls --live` refuses otherwise), and the **review minutes and AI cost per exam**, which the pilot records by hand from P2 and P3 (they decide whether the rollout is affordable).

### P5. The slice

The same chain on a small slice of other exams, to see what AZ-104 alone cannot show:

- **AZ-104, "Implement and manage virtual networking"** (the three networking skill groups): the exam's own course does not cover everything the guide asks; the AZ-700 modules do. This is the cross-exam case, where the judge must call a page `core` of another exam's course (`P3`); since 2026-10-20 the gates accept it when the judge is sure of it.
- **SC-300, "Plan and automate identity governance"** (entitlement management, access reviews, privileged access): the same product area that the AZ-104 gold set marks as out of scope. The check is that a page rejected for AZ-104 as `other-role` is allowed for SC-300, and that it is the guide's task that decides, not the page. If SC-300's guide has changed by then, **PL-300** is the alternative: a different area, a different guide shape (Power BI), a catalog of another kind.

Measure the slice as in P4 (a sample of at least 30 automatic acceptances per exam) and add the gold set only where the maintainer has marked one.

### P6. The decision

- **Pass:** all four criteria met on AZ-104 and the slice, and the budget numbers (review minutes per exam, AI cost per exam) are acceptable to the maintainer. The rollout may start; the maintainer says so.
- **Fail:** change the thing the failure points at, then run P2 to P4 again **with a new sample seed** (a sample that was looked at once is not an independent measure) and the same gold set:

| Failure                                       | Where to look                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A false accept, or the right share is too low | the gate rules (`scripts/lib/course-gates.mjs`: `coreQuoteCoverage`, what counts as agreement, which sources auto-accept) and the judge's rubric (`scripts/lib/course-judge.mjs`). Look at the wrong items by source (`P1` to `P4`): a bad source means the generator, a bad class or relation means the rubric. |
| Keeps lost, "never a candidate"               | the generator, not the judge: `course-candidates.mjs <CODE> --task "<text>"` shows what the task's shortlist holds. Missing synonyms go to `scripts/lib/course-aliases.mjs`; a missing source is a gap in the learnsync caches.                                                                                  |
| Keeps lost, "rejected by the judge"           | the rubric, or a gold mark the maintainer reconsiders.                                                                                                                                                                                                                                                           |
| The queue is too long                         | `queueReasons` of the `gate` output.                                                                                                                                                                                                                                                                             |
| Picks that are not current pages              | the learnsync caches are old: run its monitors, then `course-candidates.mjs` again.                                                                                                                                                                                                                              |

A failed pilot is a finding, not a delay. Write down what changed and what the second run measured.

## The rollout

```bash
node scripts/course-rollout.mjs [--pilot AZ-104] [--minutes-per-item N] [--picks-per-task N] [--queue-share F]
```

It reads the stored study guides, the exam statuses of `src/data_files/exam-status.mjs` and Learn's data (one request for the course list, learnsync's files) and prints every exam as a row, wave by wave. Nothing is written. `--minutes-per-item` turns the expected queue into hours of review; `--picks-per-task` and `--queue-share` replace the defaults (the picks per task of the hand-made AZ-104 page, a quarter in the queue) with what the pilot measured.

### The waves

| Wave      | Exams                                                                                                                                          | Why                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pilot`   | the ones named with `--pilot`                                                                                                                  | the maintainer's choice, never the tool's                                                                                                                          |
| 1         | a stable guide that parses, an official course on Learn with at least 6 modules (`--thin`) of which some have harvested links; no status badge | the process is proven here first: rich catalogs, little risk of a rebuild. Worked richest catalog first (most modules with harvested links)                        |
| 2         | the same, but `NEW` (generally available for less than 90 days)                                                                                | their Learn material is still settling, and wave 1 will have taught the process                                                                                    |
| `decide`  | no official course, fewer than 6 modules, or no module with harvested links at all                                                             | the maintainer decides whether a course makes sense, whether to run the learnsync harvest first, or whether the course would be mostly the documentation shortlist |
| `later`   | `BETA`, `UPCOMING`, `AT RISK`, `RETIRING`                                                                                                      | a course built now is rebuilt soon (a beta exam's official course often does not exist yet)                                                                        |
| `blocked` | the stored guide does not parse completely                                                                                                     | fix the parser first (`course-source.mjs --survey`, then a fixture of the new shape)                                                                               |
| `skip`    | `RETIRED`                                                                                                                                      | a course for an exam that no longer exists is no use                                                                                                               |

A guide whose "skills measured as of" day is still ahead does **not** wait: the stored text already is that version. The row says so, because Learn's official course can lag the guide, and the rebuild check will catch a later change.

### Working a wave

Wave 1 is long. Work it in **batches of about five exams**, richest first, and measure between batches:

1. Run the chain (steps 1 to 5) for each exam of the batch. The maintainer answers each queue.
2. Per exam, a spot check of at least 20 automatic acceptances (`sample --size 20`, then `measure`, which also prints the queue share). A pick the maintainer finds wrong is rejected and remembered (`resolve`), exactly like a queue answer.
3. **Stop the batch** when an exam's sample is under 90% right, a false accept turns up in what the maintainer reads anyway, or the learnsync caches are older than a week. Find the cause with the table in P6, fix it, and re-run the exam that tripped it before going on.
4. After the batch, `course-rollout.mjs` again with the measured numbers: the review budget for the next one is the batch's own minutes per exam, not the estimate.

Each finished exam ends the same way: `course-build.mjs`, the maintainer moves the file to `src/data_files/courses/<CODE>.json`, `course-file.mjs validate <CODE> --live`, `render --out src/content/docs/courses/<code>course.mdx`, and `pnpm build`. There are no draft pages: the page is an ordinary page of the site that nothing links until the maintainer does.

### The review budget

For an exam with `T` tasks: expected picks = `T` × picks per task, expected queue = picks × queue share, review time = queue × minutes per queue item, plus the spot check (20 items × minutes per sampled item). The table prints the first two; the pilot supplies the rest. An exam whose expected queue is out of proportion (many tasks, thin catalog) goes to the end of its wave, or to `decide`.

### Keeping courses true

The rebuild check (`course-status.mjs <CODE>`, or `--all`) compares a course with today's guide and today's Learn: `current`, `review` (the official course changed shape) or `stale` (tasks changed, or a pick's target is gone). It says which tasks to redo; a rebuild is the chain again for those tasks, and the decisions file means the maintainer is not asked twice. Nothing runs it on a schedule yet; whether it should is a decision for after the pilot.

## Not covered

- **Running anything.** The pilot, a batch and the rollout all start with the maintainer asking.
- **A scheduled monitor** for courses. The rebuild check is a command.
- **Linking.** A course page is reachable by its address from the day it is rendered (there are no drafts); linking courses from the exam pages, the sidebar or the landing page is a separate decision.
- **Judging quality beyond the four criteria.** The criteria say the automatic part is as good as a person's pick on a sample; they do not say a course is complete, and a task with no pick is the explicit "nothing for this task" state, not an error.

## Tests

`tests/scripts/course-pilot.test.mjs` and `course-pilot-cli.test.mjs` (the gold set, the sample, the scores, the command line) and `course-rollout.test.mjs` (the waves and the table), offline, on the invented exam and on the stored GH-900, AZ-104, MB-310 and AB-100 guides of `tests/fixtures/course-source/`.
