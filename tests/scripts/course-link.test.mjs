import assert from "node:assert/strict";
import test from "node:test";
import {
  upcomingCourseComplete,
  upcomingCourseHref,
} from "../../src/utils/guide-changes/course-link.mjs";

const upcoming = { kind: "upcoming" };

test("a complete upcoming course counts as complete; anything left to build or confirm does not", () => {
  assert.equal(upcomingCourseComplete({}), true);
  assert.equal(upcomingCourseComplete({ pending: {} }), true);
  assert.equal(
    upcomingCourseComplete({ pending: { added: [], confirm: [] } }),
    true,
  );
  for (const key of ["added", "confirm", "foundations"])
    assert.equal(
      upcomingCourseComplete({ pending: { [key]: ["x"] } }),
      false,
      key,
    );
  assert.equal(
    upcomingCourseComplete(undefined),
    true,
    "no pending list at all",
  );
});

test("the banner links the upcoming tab only while the change is upcoming and the upcoming course is complete", () => {
  const complete = { code: "DP-700" };
  assert.equal(
    upcomingCourseHref("DP-700", upcoming, complete),
    "/certs/courses/dp-700/#upcoming",
  );
  // no upcoming course, or one with things left: no link
  assert.equal(upcomingCourseHref("DP-700", upcoming, undefined), undefined);
  assert.equal(
    upcomingCourseHref("DP-700", upcoming, { pending: { added: ["a"] } }),
    undefined,
  );
  // from the effective day the course page is the new course alone: no tab to link
  assert.equal(
    upcomingCourseHref("DP-700", { kind: "recent" }, complete),
    undefined,
  );
  assert.equal(upcomingCourseHref("DP-700", null, complete), undefined);
});
