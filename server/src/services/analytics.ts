/**
 * Analytics Aggregation Service
 *
 * Runs periodically (via node-cron) to compute daily_stats from sessions.
 * Can also be triggered manually for backfill.
 */

import { pool } from "../db/connection";
import * as db from "../db/queries";
import { logger } from "../utils/logger";

/** Aggregate daily stats for a specific date (YYYY-MM-DD). */
export async function aggregateDay(date: string) {
  const contacts = await db.getAllContacts();

  for (const contact of contacts) {
    try {
      const result = await pool.query(
        `SELECT
           COUNT(*)::INTEGER                          AS session_count,
           COALESCE(SUM(duration_s), 0)::INTEGER      AS total_online_s,
           MIN(start_time::TIME)                       AS first_seen,
           MAX(COALESCE(end_time, NOW())::TIME)        AS last_seen
         FROM sessions
         WHERE contact_id = $1
           AND start_time::DATE = $2`,
        [contact.id, date]
      );

      const stats = result.rows[0];
      if (stats.session_count === 0) continue;

      // Compute peak hour: the hour with the most online seconds
      const peakResult = await pool.query(
        `SELECT
           EXTRACT(HOUR FROM start_time)::INTEGER AS hour,
           SUM(LEAST(duration_s, 3600))::INTEGER AS seconds
         FROM sessions
         WHERE contact_id = $1
           AND start_time::DATE = $2
           AND duration_s IS NOT NULL
         GROUP BY hour
         ORDER BY seconds DESC
         LIMIT 1`,
        [contact.id, date]
      );

      const peakHour = peakResult.rows[0]?.hour ?? null;

      await db.upsertDailyStats(
        contact.id,
        date,
        stats.total_online_s,
        stats.session_count,
        stats.first_seen,
        stats.last_seen,
        peakHour
      );
    } catch (err) {
      logger.error({ err, contactId: contact.id, date }, "Failed to aggregate daily stats");
    }
  }

  logger.info({ date }, "Daily stats aggregation complete");
}

/** Get formatted analytics for a contact over a date range. */
export async function getAnalytics(contactId: string, from: string, to: string) {
  const stats = await db.getDailyStats(contactId, from, to);
  const sessions = await db.getSessions(contactId, from, to);

  const totalOnline = stats.reduce((sum, s) => sum + s.total_online_s, 0);
  const totalSessions = stats.reduce((sum, s) => sum + s.session_count, 0);
  const daysTracked = stats.length;

  return {
    summary: {
      totalOnlineSeconds: totalOnline,
      totalOnlineHours: Math.round((totalOnline / 3600) * 10) / 10,
      totalSessions,
      daysTracked,
      avgDailyOnlineMinutes: daysTracked > 0
        ? Math.round(totalOnline / daysTracked / 60)
        : 0,
      avgSessionsPerDay: daysTracked > 0
        ? Math.round((totalSessions / daysTracked) * 10) / 10
        : 0,
    },
    dailyStats: stats,
    recentSessions: sessions.slice(0, 50),
  };
}
