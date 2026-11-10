import assert from "node:assert/strict";
import test from "node:test";
import {
  GUIDE_CHANGE_RECENT_DAYS,
  daysUntil,
  guideChangeSentence,
  guideChangeWhen,
} from "../../src/utils/guide-change-date.mjs";

const at = (iso) => new Date(`${iso}T23:59:59Z`);
const EFFECTIVE = "2026-11-16";
const LABEL = "November 16, 2026";
const sentence = (iso) => {
  const when = guideChangeWhen(EFFECTIVE, at(iso));
  return when ? guideChangeSentence(when, LABEL) : null;
};

test("the recent window is one month", () => {
  assert.equal(GUIDE_CHANGE_RECENT_DAYS, 30);
});

test("days are whole UTC days, whatever the time of day", () => {
  assert.equal(daysUntil(EFFECTIVE, new Date("2026-11-10T00:00:00Z")), 6);
  assert.equal(daysUntil(EFFECTIVE, new Date("2026-11-10T23:59:59Z")), 6);
  assert.equal(daysUntil(EFFECTIVE, new Date("2026-11-16T12:00:00Z")), 0);
  assert.equal(daysUntil(EFFECTIVE, new Date("2026-11-17T00:00:00Z")), -1);
});

test("a change that is still ahead is upcoming", () => {
  assert.deepEqual(guideChangeWhen(EFFECTIVE, at("2026-11-10")), {
    kind: "upcoming",
    days: 6,
  });
  assert.equal(
    sentence("2026-11-10"),
    "The skills measured change on November 16, 2026 (in 6 days).",
  );
  assert.equal(
    sentence("2026-11-15"),
    "The skills measured change on November 16, 2026 (in 1 day).",
  );
});

test("the effective day itself is day 0 of the recent window", () => {
  assert.deepEqual(guideChangeWhen(EFFECTIVE, at("2026-11-16")), {
    kind: "recent",
    daysAgo: 0,
  });
  assert.equal(
    sentence("2026-11-16"),
    "The skills measured changed today, November 16, 2026.",
  );
  assert.equal(
    sentence("2026-11-17"),
    "The skills measured changed on November 16, 2026 (1 day ago).",
  );
});

test("the last day shown is the effective day plus 29, the 30th day hides it", () => {
  assert.equal(
    sentence("2026-12-15"),
    "The skills measured changed on November 16, 2026 (29 days ago).",
  );
  assert.equal(guideChangeWhen(EFFECTIVE, at("2026-12-16")), null);
  assert.equal(sentence("2027-03-01"), null);
});

test("a date we saw, not one Microsoft stated, says so", () => {
  const when = (iso) => guideChangeWhen("2026-11-02", at(iso));
  assert.equal(
    guideChangeSentence(when("2026-11-10"), "November 2, 2026", "seen"),
    "We saw the skills measured change on November 2, 2026 (8 days ago).",
  );
  assert.equal(
    guideChangeSentence(when("2026-11-02"), "November 2, 2026", "seen"),
    "We saw the skills measured change today, November 2, 2026.",
  );
  // an upcoming change always has a date the guide itself states
  assert.equal(
    guideChangeSentence(
      guideChangeWhen("2026-11-16", at("2026-11-10")),
      "November 16, 2026",
      "seen",
    ),
    "The skills measured change on November 16, 2026 (in 6 days).",
  );
});

test("a different window length is honoured", () => {
  assert.deepEqual(guideChangeWhen(EFFECTIVE, at("2026-11-20"), 5), {
    kind: "recent",
    daysAgo: 4,
  });
  assert.equal(guideChangeWhen(EFFECTIVE, at("2026-11-21"), 5), null);
});
