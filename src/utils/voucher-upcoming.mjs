import { readFileSync } from "node:fs";
import path from "node:path";

// A voucher page whose offer has not started yet carries `voucherStarts:
// YYYY-MM-DD` in its frontmatter. The offer is upcoming until that day, UTC:
// on the start day itself it is live. The UPCOMING tag therefore goes away by
// itself at the next build, the way a NEW exam badge does.

/** True while `starts` (a Date at UTC midnight, or YYYY-MM-DD) is after today in UTC. */
export function isUpcomingVoucher(starts, now = new Date()) {
  if (starts === undefined || starts === null || starts === "") return false;
  const day = starts instanceof Date ? starts : new Date(`${starts}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return false;
  return day.toISOString().slice(0, 10) > now.toISOString().slice(0, 10);
}

/** The `voucherStarts` day of src/content/docs/vouchers/<slug>.mdx as written, else undefined. */
export function readVoucherStarts(slug, root = process.cwd()) {
  try {
    const text = readFileSync(
      path.resolve(root, "src", "content", "docs", "vouchers", `${slug}.mdx`),
      "utf8",
    );
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    return /^voucherStarts:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(
      frontmatter,
    )?.[1];
  } catch {
    return undefined;
  }
}
