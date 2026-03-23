// Format the date to a string (e.g., "Jan 15, 2024")
export function formatDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  return new Date(date).toLocaleDateString("en-US", options);
}

// Capitalize the first letter of a string
export function capitalize(str: string): string {
  if (typeof str !== "string" || str.length === 0) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Calculate reading time based on word count (average 200 words per minute)
export function calculateReadingTime(content: string): number {
  const wordsPerMinute = 200;
  const wordCount = content.trim().split(/\s+/).length;
  const readingTime = Math.ceil(wordCount / wordsPerMinute);
  return readingTime;
}

// Get current year for copyright notices
export function getCurrentYear(): string {
  const date = new Date();
  return String(date.getFullYear());
}
