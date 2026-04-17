/**
 * Per-contact tracking windows.
 *
 * Cached in memory to keep the presence hot path cheap. The cache is
 * refreshed on startup and whenever a schedule is saved via the API.
 */

import * as db from "../db/queries";
import { logger } from "../utils/logger";

type Slot = { day_of_week: number; start_minutes: number; end_minutes: number };

// contactId -> list of slots
const cache = new Map<string, Slot[]>();

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return parseInt(h) * 60 + parseInt(m);
}

export async function refreshScheduleCache() {
  const all = await db.getAllSchedules();
  cache.clear();
  for (const s of all) {
    const arr = cache.get(s.contact_id) ?? [];
    arr.push({
      day_of_week: s.day_of_week,
      start_minutes: toMinutes(s.start_time),
      end_minutes: toMinutes(s.end_time),
    });
    cache.set(s.contact_id, arr);
  }
  logger.info({ contacts: cache.size }, "Schedule cache refreshed");
}

/**
 * True if the given contact should be tracked *right now*.
 * A contact with no schedules is tracked 24/7.
 */
export function isWithinSchedule(contactId: string, at: Date = new Date()): boolean {
  const slots = cache.get(contactId);
  if (!slots || slots.length === 0) return true; // unrestricted

  const dow = at.getDay(); // 0=Sun
  const mins = at.getHours() * 60 + at.getMinutes();
  return slots.some(
    (s) => s.day_of_week === dow && mins >= s.start_minutes && mins < s.end_minutes
  );
}

/** Returns contact ids that currently have at least one schedule configured. */
export function scheduledContactIds(): string[] {
  return Array.from(cache.keys());
}
