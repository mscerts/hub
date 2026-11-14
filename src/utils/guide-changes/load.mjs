// The study guide histories, loaded for the build (Vite resolves the glob at build time).
// Tests and scripts read the files with scripts/lib/guide-history.mjs instead.
const files = import.meta.glob("/src/data_files/study-guide-history/*.json", {
  eager: true,
  import: "default",
});

/** Every history, sorted by exam code. */
export const studyGuideHistories = Object.values(files)
  .map((history) => /** @type {{ code: string, versions: any[] }} */ (history))
  .sort((a, b) => a.code.localeCompare(b.code));

/** The history of one exam, or undefined when the exam has none. */
export const studyGuideHistory = (code) =>
  studyGuideHistories.find((history) => history.code === code);
