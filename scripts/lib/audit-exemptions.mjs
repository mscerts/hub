/**
 * Exam pages that the Missing Resources Audit (scripts/audit-missing-resources.mjs)
 * leaves out of a list on purpose, each with the reason. An exempt exam is not
 * written to src/data_files/missing-resources.json for that resource type, so the
 * list only holds gaps that someone can still fill. tests/scripts/audit-exemptions.test.mjs
 * keeps every exemption true: the exam page exists, and the exam still lacks the
 * resource (an exemption for an exam that has since got one must be removed).
 * Imports nothing.
 */

// Resource type (the key of the JSON) -> exam code -> why it has no such resource.
export const EXEMPT = Object.freeze({
  "GitHub Labs": Object.freeze({
    "AB-100":
      "design/architect-tier exam with no lab page by design (AGENTS.md, Lab Pages)",
    "AZ-305":
      "design/architect-tier exam with no lab page by design; its repository holds case studies, linked from the exam page",
    "AB-731":
      "no-code leadership exam; no lab repository found (checked 2026-10-16)",
    "AZ-401":
      "no course yet, so no lab repository; the Learn plan exercises are Learn-hosted (checked 2026-10-16). The Lab Repo Check reports the repository when it appears",
    "GH-700":
      "no course yet, so no lab repository (checked 2026-10-16). The Lab Repo Check reports the repository when it appears",
    "GH-100":
      "no GitHub lab repository for GitHub's own certifications; the Learn exercises wrap GitHub Skills repositories and are on the Microsoft Learn tab (checked 2026-10-16)",
    "GH-200":
      "no GitHub lab repository for GitHub's own certifications; the Learn exercises wrap GitHub Skills repositories and are on the Microsoft Learn tab (checked 2026-10-16)",
    "GH-300":
      "no GitHub lab repository for GitHub's own certifications; the Learn exercises wrap GitHub Skills repositories and are on the Microsoft Learn tab (checked 2026-10-16)",
    "GH-500":
      "no GitHub lab repository for GitHub's own certifications; the Learn exercises wrap GitHub Skills repositories and are on the Microsoft Learn tab (checked 2026-10-16)",
    "GH-900":
      "no GitHub lab repository for GitHub's own certifications; the Learn exercises wrap GitHub Skills repositories and are on the Microsoft Learn tab (checked 2026-10-16)",
    "AZ-700":
      "the course repository's exercises are the Learn exercise units that wrap them, already on the Microsoft Learn tab; its 17 instructor demos (Instructions/Demos) are not on Learn, and the maintainers decided not to list them (2026-10-16)",
    "DP-750":
      "the course repository's labs are the Learn exercise units that wrap them, already on the Microsoft Learn tab (checked 2026-10-16)",
  }),
});

/**
 * Does the lab page (comments already stripped) have a Microsoft GitHub tab with a card in it?
 * With the exam's `code`, a card titled with another exam's code (`MB-330: Case Study 1`, a lab
 * kept from the predecessor) is not the exam's own lab and does not count, like the borrowed
 * buttons of an exam page.
 */
export function hasGithubLabsTab(labText, code) {
  const tab = labText.match(
    /<TabItem label="Microsoft GitHub"[^>]*>([\s\S]*?)<\/TabItem>/,
  );
  if (!tab) return false;
  for (const card of tab[1].matchAll(/<LinkCard\b[^>]*?\btitle="([^"]*)"/g)) {
    const borrowed = card[1].trim().match(/^([A-Z]{2,3}-\d{3}):\s/)?.[1];
    if (!code || !borrowed || borrowed === code) return true;
  }
  return false;
}

/** Is this exam left out of the list of this resource type on purpose? */
export function isExempt(key, code) {
  return Object.hasOwn(EXEMPT[key] ?? {}, code);
}
