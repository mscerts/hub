/**
 * The delay before a retried HTTP request. Imports nothing.
 */

/**
 * Milliseconds to wait before attempt `attempt + 1` (`attempt` counts from 1).
 * A Retry-After header (seconds, or an HTTP date measured against `now`) is
 * obeyed, a date in the past meaning no wait; without a usable one the wait is
 * `baseMs * 2 ** (attempt - 1)`. Never more than `maxMs`.
 */
export function retryDelayMs({
  attempt,
  retryAfter,
  baseMs,
  maxMs,
  now = Date.now(),
}) {
  let ms = null;
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) ms = Math.max(0, date - now);
    }
  }
  if (ms === null) ms = baseMs * 2 ** (attempt - 1);
  return Math.min(ms, maxMs);
}
