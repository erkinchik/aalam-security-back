import { EmergencyStatus } from '@prisma/client';

/**
 * Operator presence thresholds.
 *
 * A single Redis key (`operator:<id>:heartbeat`, value = Date.now()) backs two
 * levels of freshness, so the TTL is the longest one and callers compare the
 * stored timestamp instead of relying on key existence.
 */

/** TTL of the heartbeat key. Must be >= the longest threshold below. */
export const HEARTBEAT_TTL_SECONDS = 300;

/** Зелёная точка «онлайн» в списке операторов у админа. Ни на что не влияет. */
export const ONLINE_THRESHOLD_MS = 35_000;

/**
 * После какого молчания принятый вызов возвращается в пул.
 *
 * Раньше здесь стоял порог онлайна — 35 секунд. Оператор принимал вызов, ехал,
 * экран гас, JS-таймер пульса замирал, и вызов уходил другому, пока человек был
 * уже в дороге. Две минуты переживают гашение экрана и короткий провал связи;
 * открытый сокет продлевает присутствие и без HTTP-пинга.
 */
export const RECLAIM_ASSIGNMENT_THRESHOLD_MS = 120_000;

/**
 * Longer silence than this means the device is gone for good (app killed,
 * phone dead), so the shift is dropped and SOS stops being routed there.
 *
 * Строго больше RECLAIM_ASSIGNMENT_THRESHOLD_MS: вызовы обязаны освободиться
 * раньше, чем снимется смена, иначе они зависнут на операторе, который уже
 * ничего не получает.
 */
export const SHIFT_ALIVE_THRESHOLD_MS = 180_000;

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
