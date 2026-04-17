import { pool } from "./connection";

// ── Contacts ──────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  phone: string;
  name: string;
  jid: string;
  is_active: boolean;
  created_at: Date;
}

export async function getAllContacts(): Promise<Contact[]> {
  const { rows } = await pool.query(
    "SELECT * FROM contacts ORDER BY name"
  );
  return rows;
}

export async function getActiveContacts(): Promise<Contact[]> {
  const { rows } = await pool.query(
    "SELECT * FROM contacts WHERE is_active = true ORDER BY name"
  );
  return rows;
}

export async function addContact(phone: string, name: string): Promise<Contact> {
  const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";
  const { rows } = await pool.query(
    `INSERT INTO contacts (phone, name, jid)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = $2, is_active = true
     RETURNING *`,
    [phone, name, jid]
  );
  return rows[0];
}

export async function removeContact(id: string): Promise<void> {
  await pool.query("UPDATE contacts SET is_active = false WHERE id = $1", [id]);
}

export async function getContactById(id: string): Promise<Contact | null> {
  const { rows } = await pool.query("SELECT * FROM contacts WHERE id = $1", [id]);
  return rows[0] || null;
}

// ── Presence Logs ─────────────────────────────────────────────────────

export async function logPresence(contactId: string, status: "online" | "offline") {
  await pool.query(
    "INSERT INTO presence_logs (contact_id, status) VALUES ($1, $2)",
    [contactId, status]
  );
}

// ── Sessions ──────────────────────────────────────────────────────────

export async function openSession(contactId: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sessions (contact_id, start_time)
     VALUES ($1, NOW())
     RETURNING id`,
    [contactId]
  );
  return rows[0].id;
}

export async function closeSession(contactId: string) {
  await pool.query(
    `UPDATE sessions
     SET end_time = NOW(),
         duration_s = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
     WHERE contact_id = $1 AND end_time IS NULL`,
    [contactId]
  );
}

export async function getOpenSession(contactId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE contact_id = $1 AND end_time IS NULL LIMIT 1",
    [contactId]
  );
  return rows[0] || null;
}

export async function getSessions(
  contactId: string,
  from: string,
  to: string
) {
  const { rows } = await pool.query(
    `SELECT * FROM sessions
     WHERE contact_id = $1
       AND start_time >= $2
       AND start_time <= $3
     ORDER BY start_time DESC`,
    [contactId, from, to]
  );
  return rows;
}

// ── Daily Stats ───────────────────────────────────────────────────────

export async function upsertDailyStats(
  contactId: string,
  date: string,
  totalOnlineS: number,
  sessionCount: number,
  firstSeen: string | null,
  lastSeen: string | null,
  peakHour: number | null
) {
  await pool.query(
    `INSERT INTO daily_stats (contact_id, date, total_online_s, session_count, first_seen, last_seen, peak_hour)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (contact_id, date) DO UPDATE SET
       total_online_s = $3,
       session_count = $4,
       first_seen = $5,
       last_seen = $6,
       peak_hour = $7`,
    [contactId, date, totalOnlineS, sessionCount, firstSeen, lastSeen, peakHour]
  );
}

export async function getDailyStats(contactId: string, from: string, to: string) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_stats
     WHERE contact_id = $1 AND date >= $2 AND date <= $3
     ORDER BY date DESC`,
    [contactId, from, to]
  );
  return rows;
}

// ── Tracking Schedules ────────────────────────────────────────────────

export interface Schedule {
  id: number;
  contact_id: string;
  day_of_week: number; // 0=Sun..6=Sat
  start_time: string;  // "HH:MM" or "HH:MM:SS"
  end_time: string;
}

export async function getSchedules(contactId: string): Promise<Schedule[]> {
  const { rows } = await pool.query(
    `SELECT id, contact_id, day_of_week,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time
       FROM tracking_schedules
      WHERE contact_id = $1
      ORDER BY day_of_week, start_time`,
    [contactId]
  );
  return rows;
}

export async function getAllSchedules(): Promise<Schedule[]> {
  const { rows } = await pool.query(
    `SELECT id, contact_id, day_of_week,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time
       FROM tracking_schedules`
  );
  return rows;
}

/** Replace all schedules for a contact atomically. */
export async function setSchedules(
  contactId: string,
  slots: Array<{ day_of_week: number; start_time: string; end_time: string }>
): Promise<Schedule[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM tracking_schedules WHERE contact_id = $1", [contactId]);
    for (const s of slots) {
      await client.query(
        `INSERT INTO tracking_schedules (contact_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [contactId, s.day_of_week, s.start_time, s.end_time]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return getSchedules(contactId);
}

// ── Global Schedule ───────────────────────────────────────────────────

export interface GlobalSlot {
  id?: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export async function getGlobalSchedule(): Promise<GlobalSlot[]> {
  const { rows } = await pool.query(
    `SELECT id, day_of_week,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time
       FROM global_tracking_schedule
      ORDER BY day_of_week, start_time`
  );
  return rows;
}

export async function setGlobalSchedule(
  slots: Array<{ day_of_week: number; start_time: string; end_time: string }>
): Promise<GlobalSlot[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM global_tracking_schedule");
    for (const s of slots) {
      await client.query(
        `INSERT INTO global_tracking_schedule (day_of_week, start_time, end_time)
         VALUES ($1, $2, $3)`,
        [s.day_of_week, s.start_time, s.end_time]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return getGlobalSchedule();
}

export async function getAllDailyStats(date: string) {
  const { rows } = await pool.query(
    `SELECT ds.*, c.name, c.phone
     FROM daily_stats ds
     JOIN contacts c ON c.id = ds.contact_id
     WHERE ds.date = $1
     ORDER BY ds.total_online_s DESC`,
    [date]
  );
  return rows;
}
