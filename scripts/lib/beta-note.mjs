/**
 * The beta exam note: the `:::note` box with the beta timeline that every beta
 * exam page carries directly after its beta `:::tip` (AGENTS.md, "Beta Exam
 * Pages"). The dates are calculated here, in UTC, from the day the beta period
 * began; the wording for the three states of the Skills Hub announcement
 * ("announced", "pending", "unannounced") is generated here, and
 * tests/scripts/beta-pages.test.mjs holds the real pages to it. Pure functions:
 * no I/O, no clock, no locale. Imports nothing.
 */

export const ABOUT_BETA_EXAMS_URL =
  "https://learn.microsoft.com/credentials/support/about-beta-exams?WT.mc_id=studentamb_165290";
export const SKILLS_HUB_BLOG_URL =
  "https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog?WT.mc_id=studentamb_165290";
// A new beta exam may stay "pending" (the Skills Hub announcement with the
// discount code is still expected) this many days after the beta start; after
// that it is "unannounced". Nothing here reads a clock: the monitors apply it.
export const PENDING_ANNOUNCEMENT_DAYS = 7;
export const BETA_NOTE_STATES = Object.freeze([
  "announced",
  "pending",
  "unannounced",
]);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_MS = 24 * 60 * 60 * 1000;
// Microsoft releases a beta exam 10-12 weeks after the beta period begins and
// its scores about 10 days after that.
const GO_LIVE_FROM_DAYS = 70;
const GO_LIVE_TO_DAYS = 84;
const SCORES_AFTER_DAYS = 10;

const BETA_EXAMS_PAGE = "/certs/vouchers/betaexams/";
// Wording that tells the states apart; the generator and the checker share it.
const PENDING_MARKER = "has not been published for this exam yet";
const UNANNOUNCED_MARKER = "We have not found an official go-live announcement";
const ANNOUNCED_MARKER = "[announcement](";
const BETA_TIP_TEXT = "This is a beta exam.";

function parseIsoDay(value, what) {
  const match =
    typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC rolls 2026-02-31 over into March, so the parts must read back.
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }
  }
  throw new Error(
    `${what} must be a real day written YYYY-MM-DD (got ${JSON.stringify(value)}).`,
  );
}

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

/**
 * "October 30, 2026" for a Date or a YYYY-MM-DD string, read in UTC with
 * English month names (no locale of the machine is involved).
 */
export function formatLongDate(dateOrIso) {
  const date =
    dateOrIso instanceof Date ? dateOrIso : parseIsoDay(dateOrIso, "A date");
  if (Number.isNaN(date.getTime())) {
    throw new Error("A date must be a valid Date (got an Invalid Date).");
  }
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * The windows that follow a beta start (YYYY-MM-DD): the exam goes live 10-12
 * weeks later, its scores about 10 days after that. UTC Date objects plus the
 * same dates as text ({ start, goLiveFrom, goLiveTo, scoresFrom, scoresTo,
 * startText, goLiveFromText, goLiveToText, scoresFromText, scoresToText }).
 * Throws for anything that is not a real day.
 */
export function betaTimeline(startIso) {
  const start = parseIsoDay(startIso, "The beta start");
  const goLiveFrom = addDays(start, GO_LIVE_FROM_DAYS);
  const goLiveTo = addDays(start, GO_LIVE_TO_DAYS);
  const scoresFrom = addDays(goLiveFrom, SCORES_AFTER_DAYS);
  const scoresTo = addDays(goLiveTo, SCORES_AFTER_DAYS);
  return {
    start,
    goLiveFrom,
    goLiveTo,
    scoresFrom,
    scoresTo,
    startText: formatLongDate(start),
    goLiveFromText: formatLongDate(goLiveFrom),
    goLiveToText: formatLongDate(goLiveTo),
    scoresFromText: formatLongDate(scoresFrom),
    scoresToText: formatLongDate(scoresTo),
  };
}

// A link target that is safe to write into `[text](url)` in an MDX page.
function isAnnouncementUrl(value) {
  if (!value.startsWith("https://") || /[\s(){}<>\\]/.test(value)) return false;
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The state of the announcement in src/data_files/beta-exams.json:
 * "pending" and "unannounced" as they are, an https URL as "announced". Throws
 * for anything else.
 */
export function announcementState(value) {
  if (value === "pending" || value === "unannounced") return value;
  if (typeof value === "string" && isAnnouncementUrl(value)) return "announced";
  throw new Error(
    `An announcement must be "pending", "unannounced" or an https URL without spaces or brackets (got ${JSON.stringify(value)}).`,
  );
}

// Microsoft's own go-live wording as a fragment; "" when there is none.
function expectsFragment(expects, state) {
  if (expects === undefined || expects === null) return "";
  if (typeof expects !== "string") {
    throw new Error(
      `"expects" must be a string (got ${JSON.stringify(expects)}).`,
    );
  }
  const fragment = expects.trim();
  if (fragment === "") return "";
  if (state !== "announced") {
    throw new Error(
      `"expects" is the go-live wording of Microsoft's announcement, so it only goes with an announced note (the announcement is "${state}").`,
    );
  }
  if (/[\r\n]/.test(fragment) || /[{}<>]/.test(fragment)) {
    throw new Error(
      '"expects" must be one line without { } < > (MDX would read them as code).',
    );
  }
  if (fragment.endsWith(".")) {
    throw new Error(
      `"expects" continues the sentence "Microsoft's announcement expects ..." and the note adds the final period itself (got ${JSON.stringify(expects)}).`,
    );
  }
  return fragment;
}

/**
 * The complete `:::note ... :::` block (no trailing newline) for a beta start
 * (YYYY-MM-DD) and the announcement value of the tracker ("pending",
 * "unannounced" or the announcement URL). For an announced exam `expects` is
 * Microsoft's own go-live wording as a fragment, for example "general
 * availability of this certification in October 2026"; without it the note only
 * says that Microsoft announced the exam.
 */
export function buildBetaNote({ start, announcement, expects } = {}) {
  const timeline = betaTimeline(start);
  const state = announcementState(announcement);
  const fragment = expectsFragment(expects, state);

  const opening = `The beta period began on ${timeline.startText}.`;
  const goLive = (who) =>
    `${who} usually releases a beta exam as generally available [10-12 weeks after the beta period begins](${ABOUT_BETA_EXAMS_URL}), so counting from ${timeline.startText} this exam is expected to leave beta between ${timeline.goLiveFromText} and ${timeline.goLiveToText}.`;
  const scores = `Beta scores are released about 10 days after that, so expect results between ${timeline.scoresFromText} and ${timeline.scoresToText}.`;
  const estimates =
    "These dates are estimates and can shift, and waiting for a score can take up to 14 weeks.";
  const more = (extra = "") =>
    `See the [Beta Exams](${BETA_EXAMS_PAGE}) page for more information${extra}.`;

  let sentences;
  if (state === "announced") {
    const announced = fragment
      ? `Microsoft's [announcement](${announcement}) expects ${fragment}.`
      : `Microsoft announced this beta exam in its [announcement](${announcement}).`;
    sentences = [
      opening,
      announced,
      goLive("Microsoft also"),
      scores,
      estimates,
      more(),
    ];
  } else if (state === "pending") {
    const blog = `Microsoft usually announces a new beta exam on the [Skills Hub blog](${SKILLS_HUB_BLOG_URL}) with an 80% discount code for the first 300 candidates. That announcement ${PENDING_MARKER} and should arrive within a few days, so check back before you pay full price.`;
    sentences = [
      opening,
      blog,
      goLive("Microsoft"),
      scores,
      estimates,
      more(" about the 80% discount and early access to codes"),
    ];
  } else {
    sentences = [
      opening,
      `${UNANNOUNCED_MARKER} from Microsoft yet.`,
      goLive("Microsoft"),
      scores,
      estimates,
      more(),
    ];
  }
  return `:::note\n${sentences.join(" ")}\n:::`;
}

// The `:::name` ... `:::` blocks of an MDX text outside code fences, in order.
function directiveBlocks(mdxText) {
  const lines = String(mdxText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
    if (fence) {
      if (fenceMark?.[0] === fence[0] && fenceMark.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      continue;
    }
    const component = /^<BetaBanner>\s*$/.test(lines[i]);
    const name = component ? "tip" : /^:::(\w+)[ \t]*$/.exec(lines[i])?.[1];
    if (!name) continue;
    let end = i + 1;
    const closing = component ? /^<\/BetaBanner>\s*$/ : /^:::[ \t]*$/;
    while (end < lines.length && !closing.test(lines[end])) end++;
    if (end === lines.length) break; // never closed
    blocks.push({ name, from: i, to: end, body: lines.slice(i + 1, end) });
    i = end;
  }
  return { lines, blocks };
}

/**
 * What an exam page has right after its beta `:::tip` (the block that says
 * "This is a beta exam."): { hasTip, noteCount, text }, noteCount being the
 * number of `:::note` blocks that follow the tip with nothing but blank lines
 * between them and text the body of the first one (LF line endings, trimmed).
 */
export function inspectBetaNote(mdxText) {
  const { lines, blocks } = directiveBlocks(mdxText);
  const tip = blocks.findIndex(
    (block) =>
      block.name === "tip" &&
      block.body.join(" ").replace(/\s+/g, " ").includes(BETA_TIP_TEXT),
  );
  if (tip < 0) return { hasTip: false, noteCount: 0, text: "" };
  let noteCount = 0;
  let text = "";
  let previousEnd = blocks[tip].to;
  for (const block of blocks.slice(tip + 1)) {
    const between = lines.slice(previousEnd + 1, block.from);
    if (block.name !== "note" || between.some((line) => line.trim() !== "")) {
      break;
    }
    if (noteCount === 0) text = block.body.join("\n").trim();
    noteCount++;
    previousEnd = block.to;
  }
  return { hasTip: true, noteCount, text };
}

/**
 * The text of the one `:::note` that directly follows the beta `:::tip` of an
 * exam page: { found, text }. found is false (and text empty) when the page has
 * no beta tip, no note right after it, or more than one.
 */
export function findBetaNote(mdxText) {
  const { hasTip, noteCount, text } = inspectBetaNote(mdxText);
  const found = hasTip && noteCount === 1;
  return { found, text: found ? text : "" };
}

const flatten = (text) => text.replace(/\s+/g, " ").trim();
const unfenced = (text) =>
  text
    .replace(/^\s*:::note[ \t]*(\r?\n|$)/, "")
    .replace(/(^|\r?\n)[ \t]*:::\s*$/, "");
const withoutQuery = (url) => url.split(/[?#]/)[0];
const urlsIn = (text) => text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
const DATE = "[A-Z][a-z]+ \\d{1,2}, \\d{4}";
const windowsIn = (text) =>
  [...text.matchAll(new RegExp(`between ${DATE} and ${DATE}`, "g"))].map(
    (match) => match[0],
  );
const quoted = (items) => items.map((item) => `"${item}"`).join(" and ");
const TRACKER = "src/data_files/beta-exams.json";

// The beta start, the go-live window and the score window of the note.
function checkDates(text, start, timeline, problems) {
  const goLive = `between ${timeline.goLiveFromText} and ${timeline.goLiveToText}`;
  const scores = `between ${timeline.scoresFromText} and ${timeline.scoresToText}`;
  const windows = windowsIn(text);
  // What the note says instead, for a message that points at the wrong date.
  const instead = (own) => {
    const others = windows.filter((window) => window !== own);
    return others.length > 0 ? `; the note has ${quoted(others)}` : "";
  };

  const opening = `The beta period began on ${timeline.startText}.`;
  if (!text.startsWith(opening)) {
    const said = new RegExp(`^The beta period began on (${DATE})\\.`).exec(
      text,
    )?.[1];
    problems.push(
      said
        ? `the note says the beta period began on ${said}, but betaStart in ${TRACKER} is ${start} (${timeline.startText})`
        : `the note must start with "${opening}" (betaStart ${start} in ${TRACKER})`,
    );
  }
  if (!text.includes(goLive)) {
    problems.push(
      `the note must give the go-live window as "${goLive}" (beta start + 10 to 12 weeks)${instead(scores)}`,
    );
  }
  if (!text.includes(scores)) {
    problems.push(
      `the note must give the score window as "${scores}" (the go-live window + 10 days)${instead(goLive)}`,
    );
  }
}

// The wording of the announcement state, and none of another state's.
function checkState(text, state, announcement, problems) {
  const says = {
    pending: text.includes(PENDING_MARKER),
    unannounced: text.includes(UNANNOUNCED_MARKER),
    announced: text.includes(ANNOUNCED_MARKER),
  };
  const markers = {
    pending: PENDING_MARKER,
    unannounced: UNANNOUNCED_MARKER,
    announced: ANNOUNCED_MARKER,
  };
  const wanted = withoutQuery(announcement);
  const linksAnnouncement = urlsIn(text).some(
    (url) => withoutQuery(url) === wanted,
  );
  const own = state === "announced" ? linksAnnouncement : says[state];
  const foreign = BETA_NOTE_STATES.filter(
    (other) => other !== state && says[other],
  );
  const tracker = `beta-exams.json says announcement "${announcement}"`;

  if (foreign.length > 0 && !own) {
    problems.push(`the note says ${quoted(foreign)} but ${tracker}`);
    return;
  }
  for (const other of foreign) {
    problems.push(
      `the note mixes in the "${other}" wording ("${markers[other]}") although ${tracker}`,
    );
  }
  if (state === "announced" && !linksAnnouncement) {
    const linked = [...text.matchAll(/\[announcement\]\(\s*<?([^\s)>]+)/g)].map(
      (match) => withoutQuery(match[1]),
    );
    problems.push(
      `the note must link the announcement ${wanted} (compared without the query string)${linked.length > 0 ? `; it links ${linked.join(" and ")} instead` : ""}`,
    );
  }
  if (state === "pending") {
    if (!says.pending) {
      problems.push(
        `the note must say that the announcement is still pending: "${PENDING_MARKER}"`,
      );
    }
    if (!text.includes(SKILLS_HUB_BLOG_URL)) {
      problems.push(
        `the note must link the Skills Hub blog: [Skills Hub blog](${SKILLS_HUB_BLOG_URL})`,
      );
    }
    if (!text.includes("80% discount")) {
      problems.push('the note must mention the "80% discount"');
    }
  }
  if (state === "unannounced" && !says.unannounced) {
    problems.push(
      `the note must say that no announcement was found: "${UNANNOUNCED_MARKER}"`,
    );
  }
}

/**
 * The problems of a note text for a beta start and the announcement value of
 * the tracker, as messages (an empty array means the note is fine). The text is
 * what findBetaNote returns; the whole `:::note ... :::` block, as buildBetaNote
 * writes it, is accepted too. The check is on structure, not on equality, so an
 * exam may add its own sentences: the note must start with the beta start, give
 * the go-live window and the score window as calculated from it, link the Beta
 * Exams page and Microsoft's page about beta exams, carry the wording of its own
 * announcement state and none of another state's. For an announced note
 * `expects`, when given, must appear.
 */
export function checkBetaNote({ noteText, start, announcement, expects } = {}) {
  const problems = [];
  let timeline = null;
  let state = null;
  try {
    timeline = betaTimeline(start);
  } catch (error) {
    problems.push(`betaStart in ${TRACKER} cannot be used: ${error.message}`);
  }
  try {
    state = announcementState(announcement);
  } catch (error) {
    problems.push(
      `announcement in ${TRACKER} cannot be used: ${error.message}`,
    );
  }
  const text = flatten(unfenced(typeof noteText === "string" ? noteText : ""));
  if (text === "") {
    problems.push("there is no note text to check");
    return problems;
  }
  if (timeline) checkDates(text, start, timeline, problems);
  if (!text.includes(BETA_EXAMS_PAGE)) {
    problems.push(
      `the note must link the Beta Exams page: [Beta Exams](${BETA_EXAMS_PAGE})`,
    );
  }
  if (!text.includes(ABOUT_BETA_EXAMS_URL)) {
    problems.push(
      `the note must link Microsoft's page about beta exams: [10-12 weeks after the beta period begins](${ABOUT_BETA_EXAMS_URL})`,
    );
  }
  if (state) checkState(text, state, announcement, problems);

  const fragment = typeof expects === "string" ? flatten(expects) : "";
  if (fragment !== "") {
    if (state === "announced") {
      if (!text.includes(fragment)) {
        problems.push(
          `the note must carry Microsoft's go-live wording: "expects ${fragment}"`,
        );
      }
    } else if (state) {
      problems.push(
        `"expects" only goes with an announced note, but the announcement is "${state}"`,
      );
    }
  }
  return problems;
}
