/** Read the official name independently of the page's SEO description. */
export function readExamName(source) {
  const frontmatter = String(source).match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/,
  )?.[1];
  const value = frontmatter?.match(/^examName:[ \t]*(.+)$/m)?.[1]?.trim();
  if (!value) return "";
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
