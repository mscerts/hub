import test from "node:test";
import assert from "node:assert/strict";
import { docsPagination } from "../../src/utils/docs-pagination.mjs";

const first = { label: "Introduction", href: "/certs/guide/introduction/" };
const second = { label: "Overview", href: "/certs/guide/overview/" };
const guideThird = { label: "Scheduling", href: "/certs/guide/scheduling/" };
const third = { label: "Prepare", href: "/certs/prepare/studymaterials/" };
const fourth = { label: "Exam", href: "/certs/azure/az-104/" };
const items = [
  {
    label: "Guide",
    children: [first, { label: "Nested", children: [second, guideThird] }],
  },
  { label: "Placeholder" },
  third,
  { label: "Exams", children: [fourth] },
];

test("pagination follows nested sidebar leaf order within its top-level group", () => {
  assert.deepEqual(docsPagination(items, second.href), {
    previous: first,
    next: guideThird,
  });
  assert.deepEqual(docsPagination(items, second.href.slice(0, -1)), {
    previous: first,
    next: guideThird,
  });
});
test("pagination does not cross top-level groups", () => {
  assert.deepEqual(docsPagination(items, third.href), {
    previous: undefined,
    next: undefined,
  });
});
test("first, last, and unlisted pages have no invented neighbors", () => {
  assert.deepEqual(docsPagination(items, first.href), {
    previous: undefined,
    next: second,
  });
  assert.deepEqual(docsPagination(items, third.href), {
    previous: undefined,
    next: undefined,
  });
  assert.deepEqual(docsPagination(items, "/certs/archive/old/"), {});
  assert.deepEqual(docsPagination([], first.href), {});
});

test("frontmatter can independently disable or override each direction", () => {
  assert.deepEqual(docsPagination(items, second.href, { prev: false }), {
    previous: undefined,
    next: guideThird,
  });
  assert.deepEqual(docsPagination(items, second.href, { next: false }), {
    previous: first,
    next: undefined,
  });
  assert.deepEqual(docsPagination(items, second.href, { prev: first.href }), {
    previous: first,
    next: guideThird,
  });
  assert.deepEqual(
    docsPagination(items, first.href, { next: "/custom/next/" }),
    {
      previous: undefined,
      next: { label: "/custom/next/", href: "/custom/next/" },
    },
  );
});
