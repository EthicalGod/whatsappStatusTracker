/**
 * Global tracking window.
 *
 * One schedule applies to every tracked contact. Cached in memory for the
 * presence hot path; refreshed on boot and whenever the schedule is saved.
 */

import * as db from "../db/queries";
import { logger } from "../utils/logger";

type Slot = { day_of_week: number; start_minutes: number; end_minutes: number };

let cache: Slot[] = [];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return parseInt(h) * 60 + parseInt(m);
}

export async function refreshScheduleCache() {
  const rows = await db.getGlobalSchedule();
  cache = rows.map((r) => ({
    day_of_week: r.day_of_week,
    start_minutes: toMinutes(r.start_time),
    end_minutes: toMinutes(r.end_time),
  }));
  logger.info({ slots: cache.length }, "Global schedule cache refreshed");
}

/**
 * True if tracking should be active right now.
 * Empty schedule = 24/7 tracking (no restriction).
 */
export function isWithinSchedule(_contactId?: string, at: Date = new Date()): boolean {
  if (cache.length === 0) return true; // unrestricted
  const dow = at.getDay();
  const mins = at.getHours() * 60 + at.getMinutes();
  return cache.some(
    (s) => s.day_of_week === dow && mins >= s.start_minutes && mins < s.end_minutes
  );
}

/** Returns true if any global schedule slots are configured. */
export function hasSchedules(_contactId?: string): boolean {
  return cache.length > 0;
}
