import { access, stat } from "node:fs/promises";

const pagefindScript = "dist/pagefind/pagefind.js";

try {
  await access(pagefindScript);
  const { size } = await stat(pagefindScript);

  if (size === 0) throw new Error("file is empty");
  console.log(`Verified Pagefind index: ${pagefindScript} (${size} bytes)`);
} catch (error) {
  console.error(`Pagefind index verification failed: ${error.message}`);
  process.exitCode = 1;
}
