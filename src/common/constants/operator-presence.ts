import { EmergencyStatus } from '@prisma/client';

/**
 * Operator presence thresholds.
 *
 * A single Redis key (`operator:<id>:heartbeat`, value = Date.now()) backs two
 * levels of freshness, so the TTL is the longest one and callers compare the
 * stored timestamp instead of relying on key existence.
 */

/** TTL of the heartbeat key. Must be >= SHIFT_ALIVE_THRESHOLD_MS. */
export const HEARTBEAT_TTL_SECONDS = 120;

/** Operator counts as online (admin list, cron un-assigning stale sessions). */
export const ONLINE_THRESHOLD_MS = 35_000;

/**
 * Longer silence than this means the device is gone for good (app killed,
 * phone dead), so the shift is dropped and SOS stops being routed there.
 */
export const SHIFT_ALIVE_THRESHOLD_MS = 120_000;

/** Statuses that keep an operator busy — they block ending a shift. */
export const OPEN_ASSIGNED_STATUSES = [
  EmergencyStatus.ASSIGNED,
  EmergencyStatus.IN_PROGRESS,
];

/** Parses a raw heartbeat value; null when missing or malformed. */
export function parseHeartbeat(raw: string | null): number | null {
  if (!raw) return null;
  const ts = parseInt(raw, 10);
  return Number.isNaN(ts) ? null : ts;
}

/** True when the heartbeat is newer than the given threshold. */
export function isHeartbeatFresh(
  raw: string | null,
  thresholdMs: number,
): boolean {
  const ts = parseHeartbeat(raw);
  return ts != null && Date.now() - ts < thresholdMs;
}
