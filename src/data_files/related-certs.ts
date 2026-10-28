// Official certification requirements, verified October 28, 2026.
// PL-400 is now AB-400, earning the same Power Platform Developer certification.
export const certificationRequirements = [
  {
    expert: "AZ-305",
    prerequisites: ["AZ-104"],
    source:
      "https://learn.microsoft.com/credentials/certifications/azure-solutions-architect/",
    kind: "certification",
  },
  {
    expert: "SC-100",
    prerequisites: ["SC-200", "SC-300", "SC-500"],
    source:
      "https://learn.microsoft.com/credentials/certifications/cybersecurity-architect-expert/",
    kind: "certification",
  },
  {
    expert: "MS-102",
    prerequisites: ["MD-102", "MS-700", "SC-300", "SC-401"],
    source:
      "https://learn.microsoft.com/credentials/certifications/m365-administrator-expert/",
    kind: "certification",
  },
  {
    expert: "AZ-400",
    prerequisites: ["AZ-104", "AZ-204"],
    source:
      "https://learn.microsoft.com/credentials/certifications/devops-engineer/",
    kind: "certification",
  },
  {
    expert: "AZ-401",
    prerequisites: ["AZ-104", "GH-300"],
    source:
      "https://techcommunity.microsoft.com/blog/skills-hub-blog/new-microsoft-certified-agentic-devops-engineer-expert/4528356",
    kind: "exam",
  },
  {
    expert: "AB-100",
    prerequisites: [
      "MB-330",
      "AB-400",
      "MB-230",
      "MB-310",
      "MB-500",
      "MB-800",
      "MB-820",
      "AI-300",
      "AI-103",
      "AB-620",
      "AB-210",
      "AB-410",
      "AB-250",
    ],
    source:
      "https://learn.microsoft.com/credentials/certifications/agentic-ai-business-solutions-architect/",
    kind: "certification",
  },
] as const;

// These prerequisite certifications do not have study-material pages on the hub.
export const externalPrerequisites: Record<
  string,
  { name: string; href: string }
> = {
  "MB-500": {
    name: "Dynamics 365: Finance and Operations Apps Developer Associate",
    href: "https://learn.microsoft.com/credentials/certifications/d365-finance-and-operations-apps-developer-associate/",
  },
  "MB-800": {
    name: "Dynamics 365 Business Central Functional Consultant Associate",
    href: "https://learn.microsoft.com/credentials/certifications/d365-business-central-functional-consultant-associate/",
  },
  "MB-820": {
    name: "Dynamics 365 Business Central Developer Associate",
    href: "https://learn.microsoft.com/credentials/certifications/d365-business-central-developer-associate/",
  },
};
