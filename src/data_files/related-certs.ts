export type ExamArea =
  | "azure"
  | "security"
  | "github"
  | "aibusiness"
  | "microsoft365"
  | "power"
  | "dynamics";

export interface RelatedCertItem {
  code: string;
  name: string;
  area: ExamArea;
  relation: "Prerequisite" | "Next step" | "Sibling";
}

export const relatedCertsByExam: Record<string, RelatedCertItem[]> = {
  "AZ-900": [
    { code: "AZ-104", name: "Microsoft Azure Administrator", area: "azure", relation: "Next step" },
    { code: "AZ-305", name: "Designing Microsoft Azure Infrastructure Solutions", area: "azure", relation: "Next step" },
  ],
  "AZ-104": [
    { code: "AZ-900", name: "Microsoft Azure Fundamentals", area: "azure", relation: "Prerequisite" },
    { code: "AZ-305", name: "Designing Microsoft Azure Infrastructure Solutions", area: "azure", relation: "Next step" },
    { code: "AZ-400", name: "Designing and Implementing Microsoft DevOps Solutions", area: "azure", relation: "Sibling" },
  ],
  "AZ-305": [
    { code: "AZ-104", name: "Microsoft Azure Administrator", area: "azure", relation: "Prerequisite" },
    { code: "AZ-500", name: "Microsoft Azure Security Technologies", area: "azure", relation: "Sibling" },
    { code: "AZ-700", name: "Designing and Implementing Microsoft Azure Networking Solutions", area: "azure", relation: "Sibling" },
  ],
  "AI-901": [
    { code: "AI-103", name: "Developing AI Apps and Agents on Azure", area: "azure", relation: "Next step" },
    { code: "AZ-900", name: "Microsoft Azure Fundamentals", area: "azure", relation: "Sibling" },
  ],
  "AI-103": [
    { code: "AI-901", name: "Microsoft Azure AI Fundamentals", area: "azure", relation: "Prerequisite" },
    { code: "AZ-104", name: "Microsoft Azure Administrator", area: "azure", relation: "Sibling" },
  ],
  "SC-900": [
    { code: "SC-200", name: "Microsoft Security Operations Analyst", area: "security", relation: "Next step" },
    { code: "SC-300", name: "Microsoft Identity and Access Administrator", area: "security", relation: "Next step" },
    { code: "AZ-500", name: "Microsoft Azure Security Technologies", area: "azure", relation: "Next step" },
    { code: "SC-100", name: "Cybersecurity Architect", area: "security", relation: "Next step" },
  ],
  "SC-200": [
    { code: "SC-900", name: "Security, Compliance, and Identity Fundamentals", area: "security", relation: "Prerequisite" },
    { code: "SC-300", name: "Microsoft Identity and Access Administrator", area: "security", relation: "Sibling" },
    { code: "SC-100", name: "Cybersecurity Architect", area: "security", relation: "Next step" },
  ],
  "SC-300": [
    { code: "SC-900", name: "Security, Compliance, and Identity Fundamentals", area: "security", relation: "Prerequisite" },
    { code: "SC-200", name: "Microsoft Security Operations Analyst", area: "security", relation: "Sibling" },
    { code: "SC-100", name: "Cybersecurity Architect", area: "security", relation: "Next step" },
  ],
  "SC-100": [
    { code: "SC-200", name: "Microsoft Security Operations Analyst", area: "security", relation: "Prerequisite" },
    { code: "SC-300", name: "Microsoft Identity and Access Administrator", area: "security", relation: "Prerequisite" },
    { code: "AZ-500", name: "Microsoft Azure Security Technologies", area: "azure", relation: "Sibling" },
  ],
};
