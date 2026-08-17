export const examStatuses = {
  azure: {
    "AZ-400": { text: "ENDANGERED", variant: "caution" },
    "AZ-500": { text: "RETIRING", variant: "danger" },
    "AZ-800": { text: "RETIRING", variant: "danger" },
    "AZ-801": { text: "RETIRING", variant: "danger" },
    "AZ-802": { text: "BETA", variant: "tip" },
    "AI-300": { text: "BETA", variant: "tip" },
    "AI-500": { text: "BETA", variant: "tip" },
    "DP-800": { text: "BETA", variant: "tip" },
  },
  github: {
    "GH-600": { text: "BETA", variant: "tip" },
  },
  aibusiness: {
    "AB-620": { text: "BETA", variant: "tip" },
    "AB-650": { text: "BETA", variant: "tip" },
  },
  microsoft365: {
    "MS-102": { text: "RETIRING", variant: "danger" },
  },
  security: {
    "SC-500": { text: "BETA", variant: "tip" },
  },
  power: {
    "PL-200": { text: "RETIRING", variant: "danger" },
  },
  dynamics: {},
};

// Statuses describe the current exam lifecycle state. Add an exam here when
// Microsoft confirms that it has moved from beta to general availability.
export const examStatusNames = {
  BETA: "Beta",
  GA: "Generally Available",
  ENDANGERED: "Endangered",
  RETIRING: "Retiring",
};

export const examStatusStyles = {
  BETA: "bg-purple-100 text-purple-800 dark:bg-purple-400/15 dark:text-purple-300",
  GA: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
  ENDANGERED:
    "bg-orange-100 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
  RETIRING: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
};

export const voucherBadgeStyles = {
  "100%":
    "bg-purple-100 text-purple-800 dark:bg-purple-400/15 dark:text-purple-300",
  "50%":
    "bg-orange-100 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
  Special: "bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
};
