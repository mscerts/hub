import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { retryDelayMs } from "../../scripts/lib/retry.mjs";

const root = resolve(import.meta.dirname, "../..");
const NOW = Date.parse("2026-10-09T06:00:00Z");
const opts = { baseMs: 1000, maxMs: 60000, now: NOW };

// The function the monitors each had a copy of (six of them, byte for byte).
function legacyRetryDelayMs({
  attempt,
  retryAfter,
  baseMs,
  maxMs,
  now = Date.now(),
}) {
  let ms = null;
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) ms = Math.max(0, date - now);
    }
  }
  if (ms === null) ms = baseMs * 2 ** (attempt - 1);
  return Math.min(ms, maxMs);
}

test("Retry-After in seconds is obeyed, also 0 and fractions", () => {
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "7", ...opts }), 7000);
  assert.equal(retryDelayMs({ attempt: 3, retryAfter: "7", ...opts }), 7000);
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "0", ...opts }), 0);
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: "1.5", ...opts }), 1500);
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: 7, ...opts }), 7000);
});

test("Retry-After as an HTTP date is measured against now; a past date means no wait", () => {
  const at = (date) => ({ attempt: 1, retryAfter: date, ...opts });
  assert.equal(retryDelayMs(at("Fri, 09 Oct 2026 06:00:30 GMT")), 30000);
  assert.equal(retryDelayMs(at("Fri, 09 Oct 2026 06:00:00 GMT")), 0);
  assert.equal(retryDelayMs(at("Thu, 01 Jan 2026 00:00:00 GMT")), 0);
  // Another clock, same date: only `now` moves the answer.
  assert.equal(
    retryDelayMs({
      ...at("Fri, 09 Oct 2026 06:00:30 GMT"),
      now: NOW + 10000,
    }),
    20000,
  );
});

test("without `now` the date is measured against the clock", () => {
  const retryAfter = new Date(Date.now() + 30000).toUTCString();
  const ms = retryDelayMs({
    attempt: 1,
    retryAfter,
    baseMs: 1,
    maxMs: 60000,
  });
  // An HTTP date has a resolution of one second.
  assert.ok(ms > 27000 && ms <= 30000, String(ms));
});

test("no header, or one that is neither seconds nor a date, backs off exponentially", () => {
  for (const retryAfter of [
    undefined,
    null,
    "",
    "soon",
    "abc",
    "NaN",
    "Infinity",
  ]) {
    assert.equal(retryDelayMs({ attempt: 1, retryAfter, ...opts }), 1000);
    assert.equal(retryDelayMs({ attempt: 2, retryAfter, ...opts }), 2000);
    assert.equal(retryDelayMs({ attempt: 3, retryAfter, ...opts }), 4000);
    assert.equal(retryDelayMs({ attempt: 5, retryAfter, ...opts }), 16000);
  }
  // Doubling, not the linear 1x, 2x, 3x that MeasureUp's copy had.
  const third = retryDelayMs({ attempt: 3, baseMs: 5000, maxMs: 60000 });
  assert.equal(third, 20000);
});

test("every delay is capped at maxMs", () => {
  assert.equal(retryDelayMs({ attempt: 10, retryAfter: null, ...opts }), 60000);
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "3600", ...opts }),
    60000,
  );
  assert.equal(
    retryDelayMs({
      attempt: 1,
      retryAfter: "Fri, 09 Oct 2026 07:00:00 GMT",
      ...opts,
    }),
    60000,
  );
  assert.equal(
    retryDelayMs({ attempt: 1, retryAfter: "7", baseMs: 1000, maxMs: 5000 }),
    5000,
  );
});

test("it agrees with the copies it replaces for everything the monitors meet", () => {
  const headers = [
    undefined,
    null,
    "",
    "0",
    "7",
    "1.5",
    "3600",
    "soon",
    "Infinity",
    "Fri, 09 Oct 2026 06:00:30 GMT",
    "Thu, 01 Jan 2026 00:00:00 GMT",
    "Friday, 09-Oct-26 06:00:30 GMT",
  ];
  for (const retryAfter of headers) {
    for (const attempt of [1, 2, 3, 4, 10]) {
      for (const [baseMs, maxMs] of [
        [1000, 60000],
        [3000, 60000],
        [5000, 20000],
      ]) {
        const args = { attempt, retryAfter, baseMs, maxMs, now: NOW };
        assert.equal(
          retryDelayMs(args),
          legacyRetryDelayMs(args),
          JSON.stringify(args),
        );
      }
    }
  }
});

test("the module imports nothing", () => {
  const source = readFileSync(join(root, "scripts/lib/retry.mjs"), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\(|\brequire\(/m);
});
