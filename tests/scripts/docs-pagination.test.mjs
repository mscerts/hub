import test from "node:test";
import assert from "node:assert/strict";
import { docsPagination } from "../../src/utils/docs-pagination.mjs";

const first = { label: "Introduction", href: "/certs/guide/introduction/" };
const second = { label: "Overview", href: "/certs/guide/overview/" };
const third = { label: "Prepare", href: "/certs/prepare/studymaterials/" };
const items = [
  {
    label: "Guide",
    children: [first, { label: "Nested", children: [second] }],
  },
  { label: "Placeholder" },
  third,
];

test("pagination follows nested sidebar leaf order and skips placeholders", () => {
  assert.deepEqual(docsPagination(items, second.href), {
    previous: first,
    next: third,
  });
  assert.deepEqual(docsPagination(items, second.href.slice(0, -1)), {
    previous: first,
    next: third,
  });
});
test("first, last, and unlisted pages have no invented neighbors", () => {
  assert.deepEqual(docsPagination(items, first.href), {
    previous: undefined,
    next: second,
  });
  assert.deepEqual(docsPagination(items, third.href), {
    previous: second,
    next: undefined,
  });
  assert.deepEqual(docsPagination(items, "/certs/archive/old/"), {});
  assert.deepEqual(docsPagination([], first.href), {});
});
