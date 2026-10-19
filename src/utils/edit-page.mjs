import { isAbsolute, relative } from "node:path";

export function editPageUrl(filePath, root = process.cwd()) {
  if (!filePath) return undefined;
  const path = (
    isAbsolute(filePath) ? relative(root, filePath) : filePath
  ).replaceAll("\\", "/");
  if (
    !path.startsWith("src/") ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new Error(`Invalid edit-page source path: ${path}`);
  }
  return `https://github.com/mscerts/hub/edit/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}
