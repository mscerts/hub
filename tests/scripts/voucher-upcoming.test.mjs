import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isUpcomingVoucher,
  readVoucherStarts,
} from "../../src/utils/voucher-upcoming.mjs";
import { voucherDisplayFields } from "../../src/utils/voucher-fields.ts";

const at = (iso) => new Date(`${iso}T12:00:00Z`);

test("an offer is upcoming until its start day, which is already live", () => {
  assert.equal(isUpcomingVoucher("2026-11-02", at("2026-10-30")), true);
  assert.equal(isUpcomingVoucher("2026-11-02", at("2026-11-01")), true);
  assert.equal(isUpcomingVoucher("2026-11-02", at("2026-11-02")), false);
  assert.equal(isUpcomingVoucher("2026-11-02", at("2026-12-01")), false);
  assert.equal(
    isUpcomingVoucher(new Date("2026-11-02"), at("2026-10-30")),
    true,
    "the Date the schema produces works too",
  );
});

test("no or a bad start day is never upcoming", () => {
  for (const value of [undefined, null, "", "soon", "2026-13-01"]) {
    assert.equal(isUpcomingVoucher(value, at("2026-10-30")), false);
  }
});

test("readVoucherStarts reads the frontmatter day as written", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voucher-upcoming-"));
  const dir = path.join(root, "src", "content", "docs", "vouchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "a.mdx"),
    "---\ntitle: A\nvoucherStarts: 2026-11-02\n---\nbody\n",
  );
  writeFileSync(
    path.join(dir, "b.mdx"),
    '---\ntitle: B\nvoucherStarts: "2026-11-03"\n---\n',
  );
  writeFileSync(
    path.join(dir, "c.mdx"),
    "---\ntitle: C\n---\nvoucherStarts: 2026-11-04\n",
  );
  assert.equal(readVoucherStarts("a", root), "2026-11-02");
  assert.equal(readVoucherStarts("b", root), "2026-11-03");
  assert.equal(
    readVoucherStarts("c", root),
    undefined,
    "only the frontmatter counts",
  );
  assert.equal(readVoucherStarts("missing", root), undefined);
});

test("the schema accepts voucherStarts like the other calendar days", () => {
  const field = voucherDisplayFields.voucherStarts;
  assert.ok(field.safeParse(new Date("2026-11-02")).success);
  assert.ok(field.safeParse("2026-11-02").success);
  assert.ok(field.safeParse(undefined).success);
  assert.ok(!field.safeParse("2026-02-31").success);
});
