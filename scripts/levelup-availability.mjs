#!/usr/bin/env node
// Finds LevelUp course pages that no longer exist.
//
// The voucher pages link the course pages of Microsoft's partner skilling site
// (`https://skillupwithlevelup.com/course-detail/<id>`). When a course is removed, its address does
// not answer 404: it answers HTTP 200 and shows the home page of the site instead, so lychee (which
// only reads status codes) calls it fine. A course page that exists has a breadcrumb right after
// the navigation ("Home", "Courses", the course title); the home page has none.
//
// This script runs between lychee and `scripts/link-failures.mjs`, like youtube-availability.mjs: it
// reads the LevelUp course links of lychee's report, fetches each page and adds the ones that are
// not a course page to the report's `error_map` as dead links. Everything after that is the existing
// Link Checker: reported after two runs on different days, in the one running issue.
//
// What counts as gone: HTTP 404 or 410, or HTTP 200 with the navigation (the "Login" entry) and no
// course breadcrumb after it. A page without the navigation (a challenge page, another layout), a 403, a 429,
// a 5xx, a timeout or a network error says nothing and changes nothing. A redesign that drops the
// breadcrumb from every course page looks like a flood: more than MAX_GONE links, or (with at
// least 20 asked) more than MAX_GONE_SHARE of them, and nothing is added.
//
// Dependency-free Node. The report is only rewritten when a link is added to it.
//
// Environment (all optional):
//   LYCHEE_JSON         lychee/external.json     the report to read and, when needed, rewrite
//   LEVELUP_CHECK       1                        0 switches the check off
//   LEVELUP_BASE_URL    (the host of each link)  tests send every request to a local server
//   REQUEST_INTERVAL_MS 500
//   REQUEST_TIMEOUT_MS  20000
//   MAX_RUN_MS          180000                   after this long the links not asked yet stay unanswered
//   MAX_GONE            10
//   MAX_GONE_SHARE      0.25
//   DRY_RUN             0                        1 prints what would change and writes nothing
//   GITHUB_STEP_SUMMARY a file the job summary is appended to

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addDeadEntries,
  collectSuccessfulLinks,
  envNumber,
  looksLikeAChange,
  sleep,
} from "./lib/report-dead-links.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT = "msfthub-link-check (+https://msfthub.com)";

/** The course a LevelUp address points at: { id } or null (the journeys, the catalogue, any other page). */
export function levelupCourse(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!/^(www\.)?skillupwithlevelup\.com$/i.test(parsed.hostname)) return null;
  const match = /^\/course-detail\/(\d+)\/?$/.exec(parsed.pathname);
  return match ? { id: match[1] } : null;
}

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** The text lines of an HTML page: no scripts or styles, one line per piece of text. */
export function textLines(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * The breadcrumb of a course page: the lines "Home", "Courses" (or "All Courses") and the course
 * title right after the navigation, which ends with the "Login" entry. Returns the title, "" when
 * the page has a navigation but no such breadcrumb (the home page), or null when it has no
 * navigation at all (not a page of this layout: nothing can be said).
 */
export function courseTitle(html) {
  const lines = textLines(html);
  const login = lines.indexOf("Login");
  if (login < 0) return null;
  const [home, courses, title] = lines.slice(login + 1, login + 4);
  return home === "Home" &&
    (courses === "Courses" || courses === "All Courses") &&
    title
    ? title
    : "";
}

/**
 * What a page says about its course: "ok", "gone" or "unknown" (and why, for a gone one).
 * 404 and 410 are gone; 200 is a course page only with its breadcrumb.
 */
export function courseVerdict(status, html = "") {
  if (status === 404 || status === 410)
    return { verdict: "gone", why: `HTTP ${status}` };
  if (status !== 200) return { verdict: "unknown" };
  const title = courseTitle(html);
  if (title === null) return { verdict: "unknown" };
  return title
    ? { verdict: "ok", title }
    : { verdict: "gone", why: "the address shows the home page" };
}

/** The text that becomes the reason of the dead link in the issue. */
export function goneReason(why) {
  return `LevelUp: this course page no longer exists (${why})`;
}

/** The LevelUp course links of a lychee report: Map of link -> { target, pages }. */
export function collectLevelupLinks(report) {
  return collectSuccessfulLinks(report, levelupCourse);
}

/**
 * Fetch every distinct course page, one at a time. Returns Map of link -> { target, verdict, why?,
 * title?, status } (status null for a network error or a timeout).
 */
export async function checkCourses(links, options = {}) {
  const {
    baseUrl = null,
    intervalMs = 500,
    timeoutMs = 20_000,
    deadlineMs = 180_000,
    fetchImpl = fetch,
  } = options;
  const started = Date.now();
  const answers = new Map();
  let first = true;
  for (const [url, { target }] of [...links].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (!first && intervalMs > 0) await sleep(intervalMs);
    first = false;
    if (Date.now() - started > deadlineMs) {
      answers.set(url, { target, status: null, verdict: "unknown" });
      continue;
    }
    let status = null;
    let html = "";
    try {
      const address = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/course-detail/${target.id}`
        : url;
      const response = await fetchImpl(address, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      html = status === 200 ? await response.text() : "";
      if (status !== 200) await response.body?.cancel?.();
    } catch {
      status = null;
    }
    answers.set(url, {
      target,
      status,
      ...(status === null
        ? { verdict: "unknown" }
        : courseVerdict(status, html)),
    });
  }
  return answers;
}

/** Add the course pages that are gone to the report as dead links. Returns { added, links }. */
export function addGoneCourses(report, links, answers) {
  const items = [];
  for (const [url, { pages }] of links) {
    const answer = answers.get(url);
    if (answer?.verdict === "gone")
      items.push({ url, pages, code: 404, text: goneReason(answer.why) });
  }
  return addDeadEntries(report, items);
}

/**
 * Judge a whole report: fetch its LevelUp course pages and add the gone ones. Returns { asked, gone,
 * unknown, tooMany, added, links }; the report is only changed when nothing looks wrong.
 */
export async function checkReport(report, options = {}) {
  const maxGone = options.maxGone ?? 10;
  const maxGoneShare = options.maxGoneShare ?? 0.25;
  const links = collectLevelupLinks(report);
  if (links.size === 0)
    return {
      asked: 0,
      gone: 0,
      unknown: 0,
      tooMany: false,
      added: 0,
      links: [],
    };
  const answers = await checkCourses(links, options);
  const all = [...answers.values()];
  const gone = all.filter((a) => a.verdict === "gone").length;
  const unknown = all.filter((a) => a.verdict === "unknown").length;
  const tooMany = looksLikeAChange(
    { asked: all.length, gone },
    { maxGone, maxGoneShare },
  );
  if (tooMany)
    return { asked: all.length, gone, unknown, tooMany, added: 0, links: [] };
  return {
    asked: all.length,
    gone,
    unknown,
    tooMany,
    ...addGoneCourses(report, links, answers),
  };
}

function summaryText({ asked, gone, unknown, tooMany, links }) {
  const lines = ["### LevelUp course pages", ""];
  if (asked === 0) {
    lines.push("No LevelUp course page link in the report to check.");
  } else {
    lines.push(
      `Fetched ${asked} LevelUp course pages: ${gone} no longer exist, ${unknown} gave no clear answer (blocked, a timeout, another layout).`,
    );
    if (tooMany)
      lines.push(
        "",
        "That many missing course pages in one run looks like a change of the site, not that many removals. None was added to the report.",
      );
    else if (links.length > 0)
      lines.push(
        "",
        "Added to the report as dead links (reported after two runs on different days):",
        ...links.map((url) => `- ${url}`),
      );
  }
  return `${lines.join("\n")}\n`;
}

export async function main(e = process.env) {
  if (e.LEVELUP_CHECK === "0") {
    console.log("LevelUp course page check is switched off (LEVELUP_CHECK=0).");
    return 0;
  }
  const file = resolve(ROOT, e.LYCHEE_JSON || "lychee/external.json");
  if (!existsSync(file)) {
    console.warn(
      `::warning::No lychee report at ${file}: no LevelUp course page check.`,
    );
    return 0;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(
      `::warning::lychee's report is not valid JSON (${err.message}): no LevelUp course page check. The judging step will say what is wrong.`,
    );
    return 0;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return 0;
  const result = await checkReport(report, {
    baseUrl: e.LEVELUP_BASE_URL || null,
    intervalMs: envNumber(e.REQUEST_INTERVAL_MS, 500),
    timeoutMs: envNumber(e.REQUEST_TIMEOUT_MS, 20_000),
    deadlineMs: envNumber(e.MAX_RUN_MS, 180_000),
    maxGone: envNumber(e.MAX_GONE, 10),
    maxGoneShare: envNumber(e.MAX_GONE_SHARE, 0.25),
  });
  const text = summaryText(result);
  process.stdout.write(text);
  if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (result.tooMany)
    console.warn(
      `::warning::${result.gone} of ${result.asked} LevelUp course pages look gone at once: not trusted, nothing added.`,
    );
  if (result.added > 0 && e.DRY_RUN !== "1")
    writeFileSync(file, JSON.stringify(report));
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.env).then(
    (code) => process.exit(code),
    (err) => {
      // The check is an addition to the link check: its own failure never stops the judging
      console.warn(
        `::warning::The LevelUp course page check failed: ${err.message}`,
      );
      process.exit(0);
    },
  );
}
