// The exam code of a docs collection entry and the address of its Study Guide Changes page. Pure, so
// scripts and tests can import it (guide-change.mjs reads the history files with Vite's import.meta.glob).

const EXAM_ID =
  /^(aibusiness|azure|dynamics|github|microsoft365|power|security)\/([a-z]{2,3}-\d{2,4})$/;

/** "azure/dp-700" -> "DP-700"; anything that is not an exam page -> null. */
export function examCodeOfEntry(id) {
  const match = String(id).match(EXAM_ID);
  return match ? match[2].toUpperCase() : null;
}

/** The address of an exam's Study Guide Changes page. */
export const changePath = (code) => `/certs/changelog/${code.toLowerCase()}/`;
