#!/usr/bin/env node
// Finds YouTube videos and playlists that the hub links and that no longer exist.
//
// YouTube answers HTTP 200 for the page of a deleted video or playlist, so lychee (which only
// reads status codes) cannot see it. The oEmbed endpoint of YouTube can: it answers 404 (or 400
// for an id that was never valid) for a video or playlist that does not exist, and 200 with the
// title for one that does. This script runs between lychee and `scripts/link-failures.mjs`: it
// reads the YouTube links of lychee's report, asks oEmbed about each one and adds the ones that do
// not exist to the report's `error_map` as dead links. Everything after that is the existing
// Link Checker: a link is reported only after two runs on different days, in the one running issue
// "Link Checker: dead external links", with the file and line that contain it.
//
// What counts as gone: oEmbed 404 or 400. Anything else says nothing about the page and changes
// nothing: 401 (a private video, or one whose owner switched embedding off: a playlist that plays
// fine answers 401 too), 403, 429, 5xx, a timeout, a network error.
//
// Failsafe: more than MAX_GONE links, or (with at least 20 asked) more than MAX_GONE_SHARE of the
// links asked, answering "gone" in one run looks like a change of the endpoint and not that many deletions: the report is
// left as it was and the run says so.
//
// Dependency-free Node. The report is only rewritten when a link is added to it.
//
// Run it locally (after `pnpm build` and the lychee command of docs/monitors/link-checker.md):
//   node scripts/youtube-availability.mjs
// Environment (all optional):
//   LYCHEE_JSON         lychee/external.json     the report to read and, when needed, rewrite
//   YOUTUBE_CHECK       1                        0 switches the check off
//   OEMBED_URL          https://www.youtube.com/oembed
//   REQUEST_INTERVAL_MS 500                      pause between two requests
//   REQUEST_TIMEOUT_MS  15000
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

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * What a YouTube address points at: { kind: "video" | "playlist", id } or null (a channel, a
 * handle, a search, a file, an id that cannot be one). The same video or playlist under another
 * form of address has the same id.
 */
export function youtubeTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") {
    return parts.length === 1 && VIDEO_ID.test(parts[0])
      ? { kind: "video", id: parts[0] }
      : null;
  }
  if (parts[0] === "watch") {
    const id = parsed.searchParams.get("v") ?? "";
    return VIDEO_ID.test(id) ? { kind: "video", id } : null;
  }
  if (parts[0] === "playlist") {
    const id = parsed.searchParams.get("list") ?? "";
    return PLAYLIST_ID.test(id) ? { kind: "playlist", id } : null;
  }
  if (
    (parts[0] === "live" || parts[0] === "embed" || parts[0] === "shorts") &&
    parts.length === 2 &&
    VIDEO_ID.test(parts[1])
  )
    return { kind: "video", id: parts[1] };
  return null;
}

/** The address oEmbed is asked about: the canonical form of the target. */
export function canonicalUrl(target) {
  return target.kind === "video"
    ? `https://www.youtube.com/watch?v=${target.id}`
    : `https://www.youtube.com/playlist?list=${target.id}`;
}

/**
 * What an oEmbed answer says: "ok" (200), "gone" (404, or 400 for an id that does not exist) or
 * "unknown" (everything else: it says nothing about the page).
 */
export function oembedVerdict(status) {
  if (status === 200) return "ok";
  if (status === 404 || status === 400) return "gone";
  return "unknown";
}

/**
 * The YouTube links of a lychee report: Map of link -> { target, pages }. The report lists the links
 * that worked in `success_map` (lychee writes it at verbose level, which lychee-external.toml sets),
 * the dead ones in `error_map`; only links that lychee did not already call dead are of interest.
 */
export function collectYoutubeLinks(report) {
  return collectSuccessfulLinks(report, youtubeTarget);
}

/**
 * Ask oEmbed about every distinct video and playlist, one request at a time. `links` is the Map of
 * collectYoutubeLinks. Returns Map of canonical address -> { target, verdict, status } (status null
 * for a network error or a timeout).
 */
export async function checkAvailability(links, options = {}) {
  const {
    oembedUrl = "https://www.youtube.com/oembed",
    intervalMs = 500,
    timeoutMs = 15_000,
    deadlineMs = 180_000,
    fetchImpl = fetch,
  } = options;
  const started = Date.now();
  const targets = new Map();
  for (const { target } of links.values())
    targets.set(canonicalUrl(target), target);
  const answers = new Map();
  let first = true;
  for (const [address, target] of [...targets].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (!first && intervalMs > 0) await sleep(intervalMs);
    first = false;
    let status = null;
    // out of time: the rest is left unanswered (it says nothing), so the step always ends
    if (Date.now() - started > deadlineMs) {
      answers.set(address, { target, status, verdict: "unknown" });
      continue;
    }
    try {
      const response = await fetchImpl(
        `${oembedUrl}?format=json&url=${encodeURIComponent(address)}`,
        { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" },
      );
      status = response.status;
      await response.body?.cancel?.();
    } catch {
      status = null;
    }
    answers.set(address, {
      target,
      status,
      verdict: status === null ? "unknown" : oembedVerdict(status),
    });
  }
  return answers;
}

/** The text that becomes the reason of the dead link in the issue. */
export function goneReason(target, status) {
  const what = target.kind === "video" ? "video" : "playlist";
  return `YouTube: this ${what} does not exist or was removed (oEmbed answered ${status})`;
}

/**
 * Add the links that do not exist to the report's `error_map`, one entry per page that contains the
 * link, and fix the counters. Returns { added, links } (the number of entries and the links, sorted).
 * Nothing is added when there is nothing to add; the report is changed in place.
 */
export function addGoneLinks(report, links, answers) {
  const items = [];
  for (const [url, { target, pages }] of links) {
    const answer = answers.get(canonicalUrl(target));
    if (answer?.verdict === "gone")
      items.push({
        url,
        pages,
        code: 404,
        text: goneReason(target, answer.status),
      });
  }
  return addDeadEntries(report, items);
}

/**
 * Judge a whole report: the oEmbed answers for its YouTube links and what to do about them.
 * Returns { asked, gone, unknown, tooMany, added?, links? }; the report is only changed when
 * nothing looks wrong with the answers (`tooMany` false).
 */
export async function checkReport(report, options = {}) {
  const maxGone = options.maxGone ?? 10;
  const maxGoneShare = options.maxGoneShare ?? 0.25;
  const links = collectYoutubeLinks(report);
  if (links.size === 0)
    return {
      asked: 0,
      gone: 0,
      unknown: 0,
      tooMany: false,
      added: 0,
      links: [],
    };
  const answers = await checkAvailability(links, options);
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
    ...addGoneLinks(report, links, answers),
  };
}

function summaryText({ asked, gone, unknown, tooMany, links }) {
  const lines = ["### YouTube availability", ""];
  if (asked === 0) {
    lines.push("No YouTube video or playlist link in the report to check.");
  } else {
    lines.push(
      `Asked oEmbed about ${asked} videos and playlists: ${gone} do not exist, ${unknown} gave no clear answer (private or not embeddable, rate limit, a timeout).`,
    );
    if (tooMany)
      lines.push(
        "",
        `That many missing links in one run looks like a change of the endpoint, not that many deletions. None was added to the report.`,
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
  if (e.YOUTUBE_CHECK === "0") {
    console.log(
      "YouTube availability check is switched off (YOUTUBE_CHECK=0).",
    );
    return 0;
  }
  const file = resolve(ROOT, e.LYCHEE_JSON || "lychee/external.json");
  if (!existsSync(file)) {
    console.warn(`::warning::No lychee report at ${file}: no YouTube check.`);
    return 0;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(
      `::warning::lychee's report is not valid JSON (${err.message}): no YouTube check. The judging step will say what is wrong.`,
    );
    return 0;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return 0;
  if (!report.success_map || Object.keys(report.success_map).length === 0)
    console.warn(
      "::warning::The lychee report lists no successful links (success_map): lychee did not run verbose, so no YouTube link can be checked.",
    );
  const result = await checkReport(report, {
    oembedUrl: e.OEMBED_URL || undefined,
    intervalMs: envNumber(e.REQUEST_INTERVAL_MS, 500),
    timeoutMs: envNumber(e.REQUEST_TIMEOUT_MS, 15_000),
    deadlineMs: envNumber(e.MAX_RUN_MS, 180_000),
    maxGone: envNumber(e.MAX_GONE, 10),
    maxGoneShare: envNumber(e.MAX_GONE_SHARE, 0.25),
  });
  const text = summaryText(result);
  process.stdout.write(text);
  if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (result.tooMany)
    console.warn(
      `::warning::${result.gone} of ${result.asked} YouTube links look gone at once: not trusted, nothing added.`,
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
        `::warning::The YouTube availability check failed: ${err.message}`,
      );
      process.exit(0);
    },
  );
}
