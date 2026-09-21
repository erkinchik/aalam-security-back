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
 * После какого молчания принятый, но не начатый (ASSIGNED) вызов возвращается
 * в пул.
 *
 * Вызов «В работе» (IN_PROGRESS) по молчанию не отбирается вовсе: оператор
 * уходит из приложения в навигатор или звонок, на iOS оно в фоне засыпает, и
 * пульс замолкает ровно тогда, когда человек едет на вызов. Такой вызов снимает
 * только админ.
 */
export const RECLAIM_ASSIGNMENT_THRESHOLD_MS = 120_000;

/**
 * Longer silence than this means the device is gone for good (app killed,
 * phone dead), so the shift is dropped and SOS stops being routed there.
 *
 * Строго больше RECLAIM_ASSIGNMENT_THRESHOLD_MS: вызовы ASSIGNED освобождаются
 * раньше, чем снимется смена. Смена оператора с вызовом «В работе» не
 * снимается — иначе приложение спрятало бы вызов за экраном начала смены.
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
