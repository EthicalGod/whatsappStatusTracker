/**
 * REST API routes.
 */

import { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import * as db from "../db/queries";
import { pool } from "../db/connection";
import { getSocket, getCurrentQR, logoutWhatsApp, isWhatsAppConnected } from "../whatsapp/client";
import { subscribeToContact, unsubscribeFromContact, getCurrentStatuses, forceAvailabilityReevaluation } from "../whatsapp/presence";
import { getAnalytics } from "../services/analytics";
import { refreshScheduleCache } from "../services/schedules";
import { saveSubscription } from "../services/notify";
import { logger } from "../utils/logger";

export async function registerRoutes(app: FastifyInstance) {

  // ── Health check (fast, no DB, no WhatsApp) ──────────────────────
  app.get("/api/health", async () => {
    return { ok: true, timestamp: new Date().toISOString() };
  });

  // ── Log out of WhatsApp ──────────────────────────────────────────
  app.post("/api/whatsapp/logout", async (_req, reply) => {
    try {
      await logoutWhatsApp();
      return reply.status(200).send({ ok: true, message: "Logged out. Re-scan QR to reconnect." });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── QR Code for WhatsApp auth ────────────────────────────────────

  app.get("/api/qr", async (_req, reply) => {
    const qr = getCurrentQR();
    if (!qr) {
      return reply.type("text/html").send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5">
          <h2 style="color:#075E54">WhatsApp already connected</h2>
          <p style="color:#667781">No QR code needed. <a href="/">Go to dashboard</a></p>
        </body></html>
      `);
    }

    const dataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
    return reply.type("text/html").send(`
      <html>
        <head>
          <title>Scan QR — GST Tracker</title>
          <meta http-equiv="refresh" content="20">
        </head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5">
          <h2 style="color:#075E54">Scan with WhatsApp</h2>
          <p style="color:#667781;margin:0 0 20px">
            Open WhatsApp → Settings → Linked Devices → Link a Device
          </p>
          <img src="${dataUrl}" alt="QR Code" style="background:white;padding:12px;border-radius:8px" />
          <p style="color:#667781;font-size:12px;margin-top:20px">
            Page auto-refreshes every 20 seconds
          </p>
        </body>
      </html>
    `);
  });

  // JSON endpoint for the dashboard Sign In modal.
  app.get("/api/qr/data", async () => {
    if (isWhatsAppConnected()) return { connected: true, qrDataUrl: null };
    const qr = getCurrentQR();
    if (!qr) return { connected: false, qrDataUrl: null }; // waiting for QR
    const qrDataUrl = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
    return { connected: false, qrDataUrl };
  });

  // ── Contacts ─────────────────────────────────────────────────────

  app.get("/api/contacts", async () => {
    // Only active contacts — removed ones keep their rows for historical
    // session data but should not appear in the sidebar.
    const contacts = await db.getActiveContacts();
    const statuses = getCurrentStatuses();

    return contacts.map((c) => ({
      ...c,
      currentStatus: statuses[c.jid]?.isOnline ? "online" : "offline",
      lastChange: statuses[c.jid]?.since || null,
    }));
  });

  app.post<{ Body: { phone: string; name: string } }>("/api/contacts", async (req, reply) => {
    const start = Date.now();
    logger.info({ body: req.body }, "POST /api/contacts received");

    const { phone, name } = req.body;
    if (!phone || !name) {
      return reply.status(400).send({ error: "phone and name are required" });
    }

    let contact;
    try {
      contact = await db.addContact(phone.replace(/\D/g, ""), name);
      logger.info({ ms: Date.now() - start, contact: contact.id }, "Contact saved to DB");
    } catch (err) {
      logger.error({ err }, "DB insert failed");
      return reply.status(500).send({ error: "Database error" });
    }

    // Fire-and-forget the WhatsApp subscription
    setImmediate(() => {
      try {
        const sock = getSocket();
        subscribeToContact(sock, contact).catch((err) =>
          logger.error({ err }, "Background subscribe failed")
        );
      } catch (err) {
        logger.warn("WhatsApp not connected yet — subscribe will retry");
      }
    });

    logger.info({ ms: Date.now() - start }, "Responding 201");
    return reply.status(201).send(contact);
  });

  app.delete<{ Params: { id: string } }>("/api/contacts/:id", async (req, reply) => {
    const contact = await db.getContactById(req.params.id);
    if (!contact) return reply.status(404).send({ error: "Contact not found" });

    await db.removeContact(req.params.id);
    unsubscribeFromContact(contact.jid);

    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/contacts/:id", async (req, reply) => {
    const contact = await db.getContactById(req.params.id);
    if (!contact) return reply.status(404).send({ error: "Contact not found" });

    const statuses = getCurrentStatuses();
    return {
      ...contact,
      currentStatus: statuses[contact.jid]?.isOnline ? "online" : "offline",
      lastChange: statuses[contact.jid]?.since || null,
    };
  });

  // ── Sessions ─────────────────────────────────────────────────────

  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/contacts/:id/sessions", async (req) => {
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
    const to = req.query.to || new Date().toISOString();
    return db.getSessions(req.params.id, from, to);
  });

  // ── Global Tracking Schedule ─────────────────────────────────────

  app.get("/api/schedule/global", async () => {
    return db.getGlobalSchedule();
  });

  // Replace the whole global schedule atomically. Body:
  //   [] — clears the schedule (track 24/7)
  //   [{ day_of_week, start_time: "HH:MM", end_time: "HH:MM" }, ...]
  app.put<{
    Body: Array<{ day_of_week: number; start_time: string; end_time: string }>;
  }>("/api/schedule/global", async (req, reply) => {
    const slots = Array.isArray(req.body) ? req.body : [];
    for (const s of slots) {
      if (
        typeof s.day_of_week !== "number" ||
        s.day_of_week < 0 ||
        s.day_of_week > 6 ||
        !/^\d{2}:\d{2}$/.test(s.start_time) ||
        !/^\d{2}:\d{2}$/.test(s.end_time) ||
        s.start_time >= s.end_time
      ) {
        return reply.status(400).send({ error: "Invalid slot", slot: s });
      }
    }
    const saved = await db.setGlobalSchedule(slots);
    await refreshScheduleCache();
    forceAvailabilityReevaluation();
    return saved;
  });

  // ── Analytics ────────────────────────────────────────────────────

  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/contacts/:id/analytics", async (req) => {
    // `from`: start of the window 30 days ago at 00:00 UTC.
    // `to`: *end* of today at 23:59:59.999 UTC — NOT the start of today,
    //       otherwise every session recorded after midnight UTC would be
    //       excluded from `recentSessions` (the sessions query uses
    //       start_time <= to).
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString();
    return getAnalytics(req.params.id, from, to);
  });

  app.get<{ Querystring: { date?: string } }>("/api/analytics/summary", async (req) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    return db.getAllDailyStats(date);
  });

  // ── CSV export ───────────────────────────────────────────────────
  //
  // Columns (matches the legacy whatsapp_activity.csv format):
  //   label, start_time, end_time, duration_seconds
  //
  // Times are rendered in the server's local timezone as YYYY-MM-DD HH:MM:SS.
  // Only closed sessions are exported (end_time IS NOT NULL) so the duration
  // column is always populated.
  app.get<{
    Querystring: { from?: string; to?: string; contactId?: string };
  }>("/api/export/sessions.csv", async (req, reply) => {
    const { from, to, contactId } = req.query;
    const conditions: string[] = ["s.end_time IS NOT NULL"];
    const params: any[] = [];
    if (contactId) {
      params.push(contactId);
      conditions.push(`s.contact_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`s.start_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`s.start_time <= $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT c.name AS label, s.start_time, s.end_time, s.duration_s
         FROM sessions s
         JOIN contacts c ON c.id = s.contact_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.start_time ASC`,
      params
    );

    const fmt = (d: Date) => {
      const pad = (n: number) => n.toString().padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const escape = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

    const lines = ["label,start_time,end_time,duration_seconds"];
    for (const r of rows) {
      lines.push(
        [
          escape(r.label),
          fmt(new Date(r.start_time)),
          fmt(new Date(r.end_time)),
          r.duration_s,
        ].join(",")
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const filename = contactId
      ? `whatsapp_activity_${today}_${contactId.slice(0, 8)}.csv`
      : `whatsapp_activity_${today}.csv`;

    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(lines.join("\n") + "\n");
  });

  // ── Status (real-time snapshot) ──────────────────────────────────

  app.get("/api/status", async () => {
    return getCurrentStatuses();
  });

  // ── Push Notifications ───────────────────────────────────────────

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    "/api/push/subscribe",
    async (req, reply) => {
      await saveSubscription(req.body);
      return reply.status(201).send({ ok: true });
    }
  );
}
