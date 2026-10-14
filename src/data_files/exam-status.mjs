export const examStatuses = {
  azure: {
    "AZ-400": { text: "AT RISK", variant: "caution" },
    "AZ-401": { text: "BETA", variant: "tip" },
    "AZ-800": { text: "RETIRED", variant: "note" },
    "AZ-801": { text: "RETIRED", variant: "note" },
  },
  github: {
    "GH-700": { text: "BETA", variant: "tip" },
  },
  aibusiness: {
    "AB-650": { text: "BETA", variant: "tip" },
  },
  microsoft365: {
    "MS-102": { text: "RETIRING", variant: "danger" },
  },
  security: {},
  power: {},
  dynamics: {},
};

// Statuses describe the current exam lifecycle state. Add an exam here when
// Microsoft confirms that it has moved from beta to general availability.
// RETIRING becomes RETIRED once the retirement date in retiring-exams.json has
// passed (the same cut-off as the RetirementBanner: the date is before today,
// UTC); the tracker entry stays as history.
export const examStatusNames = {
  BETA: "Beta",
  GA: "Generally Available",
  AT_RISK: "At risk",
  RETIRING: "Retiring",
  RETIRED: "Retired",
  UPCOMING: "Upcoming",
};

export const examStatusStyles = {
  BETA: "bg-[#a855f7]/15 text-[#d8b4fe]",
  GA: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
  AT_RISK: "bg-amber-400/15 text-amber-300",
  RETIRING: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  RETIRED: "bg-gray-100 text-gray-700 dark:bg-[#64748b]/15 dark:text-[#cbd5e1]",
  UPCOMING: "bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
};

export const voucherBadgeStyles = {
  "100%":
    "bg-purple-100 text-purple-800 dark:bg-purple-400/15 dark:text-purple-300",
  "50%":
    "bg-orange-100 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
  Special: "bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
};
