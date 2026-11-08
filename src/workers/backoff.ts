const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const EMAIL_SCHEDULE_MS: readonly number[] = [
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  60 * MINUTE,
];

const STOCK_CHECK_SCHEDULE_MS: readonly number[] = [
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
];

const JITTER = 0.1;

function backoff(schedule: readonly number[], attempts: number, random: () => number): number {
  const index = Math.min(Math.max(Math.floor(attempts), 1), schedule.length) - 1;
  const base = schedule[index] ?? 0;
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

/**
 * Delay before the next send. `attempts` counts attempts made, including the one that just failed,
 * which is RequestRow.attempts after a claim. Values below 1 are treated as 1.
 */
export function emailBackoffMs(attempts: number, random: () => number = Math.random): number {
  return backoff(EMAIL_SCHEDULE_MS, attempts, random);
}

/**
 * Delay before the next check. `attempts` counts attempts made, including the one that just failed.
 * StockCheckClaim.attempts counts earlier failures only, so pass claim.attempts + 1.
 */
export function stockCheckBackoffMs(attempts: number, random: () => number = Math.random): number {
  return backoff(STOCK_CHECK_SCHEDULE_MS, attempts, random);
}
