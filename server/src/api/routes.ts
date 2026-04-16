/**
 * REST API routes.
 */

import { FastifyInstance } from "fastify";
import * as db from "../db/queries";
import { getSocket } from "../whatsapp/client";
import { subscribeToContact, unsubscribeFromContact, getCurrentStatuses } from "../whatsapp/presence";
import { getAnalytics } from "../services/analytics";
import { saveSubscription } from "../services/notify";

export async function registerRoutes(app: FastifyInstance) {

  // ── Contacts ─────────────────────────────────────────────────────

  app.get("/api/contacts", async () => {
    const contacts = await db.getAllContacts();
    const statuses = getCurrentStatuses();

    return contacts.map((c) => ({
      ...c,
      currentStatus: statuses[c.jid]?.isOnline ? "online" : "offline",
      lastChange: statuses[c.jid]?.since || null,
    }));
  });

  app.post<{ Body: { phone: string; name: string } }>("/api/contacts", async (req, reply) => {
    const { phone, name } = req.body;
    if (!phone || !name) {
      return reply.status(400).send({ error: "phone and name are required" });
    }

    const contact = await db.addContact(phone.replace(/\D/g, ""), name);

    // Start tracking immediately
    try {
      const sock = getSocket();
      await subscribeToContact(sock, contact);
    } catch {
      // WhatsApp not connected yet — will subscribe on next reconnect
    }

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

  // ── Analytics ────────────────────────────────────────────────────

  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/contacts/:id/analytics", async (req) => {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    return getAnalytics(req.params.id, from, to);
  });

  app.get<{ Querystring: { date?: string } }>("/api/analytics/summary", async (req) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    return db.getAllDailyStats(date);
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
