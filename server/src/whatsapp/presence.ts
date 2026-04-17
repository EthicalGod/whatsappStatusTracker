/**
 * Presence Tracking Engine
 *
 * Subscribes to presence updates for tracked contacts via Baileys.
 * Unlike DOM polling (Selenium approach), this uses WhatsApp's native
 * presence protocol — no browser, no DOM hacks, no focus tricks.
 *
 * How it works:
 * 1. For each tracked contact, call sock.presenceSubscribe(jid)
 * 2. Baileys fires 'presence.update' events when the contact's status changes
 * 3. We record transitions (online→offline, offline→online) in the database
 * 4. Presence subscriptions expire after ~10 minutes, so we re-subscribe periodically
 */

import { WASocket } from "@whiskeysockets/baileys";
import { config } from "../config";
import { logger } from "../utils/logger";
import * as db from "../db/queries";
import { aggregateDay } from "../services/analytics";

// In-memory state: tracks current online status per JID
const contactStatus = new Map<string, {
  contactId: string;
  name: string;
  isOnline: boolean;
  lastChange: Date;
  offlineTimer?: NodeJS.Timeout; // grace period before marking offline
}>();

// WhatsApp identifies users by TWO different JID formats:
//   - Phone format:  "919999414559@s.whatsapp.net"  (what we subscribe with)
//   - LID format:    "167795866263691@lid"          (what presence updates use)
// We need to map between them. Populated from chats.update events.
const lidToPhone = new Map<string, string>(); // lid → phone
const phoneToLid = new Map<string, string>(); // phone → lid

// Callback for real-time updates (Socket.io will register here)
type PresenceCallback = (contactId: string, name: string, status: "online" | "offline") => void;
const listeners: PresenceCallback[] = [];

export function onPresenceChange(cb: PresenceCallback) {
  listeners.push(cb);
}

export function getCurrentStatuses() {
  const result: Record<string, { name: string; isOnline: boolean; since: Date }> = {};
  for (const [jid, state] of contactStatus) {
    result[jid] = {
      name: state.name,
      isOnline: state.isOnline,
      since: state.lastChange,
    };
  }
  return result;
}

/** Subscribe to presence for all active contacts. */
export async function startTracking(sock: WASocket) {
  const contacts = await db.getActiveContacts();
  logger.info({ count: contacts.length, jids: contacts.map(c => c.jid) }, "Starting presence tracking");

  // Register presence event handler
  sock.ev.on("presence.update", handlePresenceUpdate);

  // Silently build LID ↔ phone mapping from chat/message events.
  // WhatsApp sends presence updates with LIDs but we subscribe with phone JIDs.
  sock.ev.on("chats.update" as any, (updates: any[]) => {
    for (const chat of updates) extractJidMapping(chat);
  });
  sock.ev.on("chats.upsert" as any, (chats: any[]) => {
    for (const chat of chats) extractJidMapping(chat);
  });
  sock.ev.on("messages.upsert" as any, ({ messages }: any) => {
    for (const msg of messages || []) {
      if (msg.key) extractJidMapping(msg.key);
    }
  });

  // Stagger subscriptions to avoid rate limits
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    contactStatus.set(contact.jid, {
      contactId: contact.id,
      name: contact.name,
      isOnline: false,
      lastChange: new Date(),
    });

    setTimeout(async () => {
      try {
        // Pre-resolve LID so the first presence event can match immediately
        await resolveAndCacheLid(sock, contact.jid);
        await withTimeout(sock.presenceSubscribe(contact.jid), 5000);
        logger.info({ jid: contact.jid, name: contact.name }, "Subscribed to presence");
      } catch (err) {
        logger.error({ err, jid: contact.jid }, "Failed to subscribe to presence");
      }
    }, i * config.tracking.subscriptionStaggerMs);
  }

  // Re-subscribe periodically (presence subscriptions expire)
  setInterval(() => resubscribeAll(sock), config.tracking.resubscribeIntervalMs);
}

/** Wrap a promise with a timeout so a stuck Baileys call can't hang us. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Proactively resolve a phone number to its WhatsApp LID and cache it.
 * Without this, we'd only learn the LID mapping passively when the contact
 * sends a message — meaning the FIRST online event would be missed because
 * presence updates arrive keyed by LID, not phone JID.
 */
async function resolveAndCacheLid(sock: WASocket, phoneJid: string): Promise<void> {
  try {
    const result = await withTimeout(sock.onWhatsApp(phoneJid), 8000);
    const info = result?.[0];
    if (!info?.exists) {
      logger.warn({ phoneJid }, "Contact not found on WhatsApp");
      return;
    }

    // Baileys returns `lid` as separate field in newer versions
    const lid = (info as any).lid;
    if (lid) {
      const lidKey = String(lid).split(":")[0] + "@lid";
      const phoneNum = phoneFromJid(phoneJid);
      lidToPhone.set(lidKey, phoneNum);
      phoneToLid.set(phoneNum, lidKey);
      logger.info({ phone: phoneNum, lid: lidKey }, "Pre-resolved LID mapping");
    } else {
      logger.debug({ phoneJid }, "onWhatsApp returned no LID — will learn passively");
    }
  } catch (err) {
    logger.warn({ err, phoneJid }, "Could not pre-resolve LID");
  }
}

/** Subscribe to a single new contact (called when user adds a contact via API). */
export async function subscribeToContact(sock: WASocket, contact: db.Contact) {
  contactStatus.set(contact.jid, {
    contactId: contact.id,
    name: contact.name,
    isOnline: false,
    lastChange: new Date(),
  });

  try {
    // Pre-resolve LID so the first online event matches immediately
    await resolveAndCacheLid(sock, contact.jid);

    await withTimeout(sock.presenceSubscribe(contact.jid), 5000);
    logger.info({ jid: contact.jid, name: contact.name }, "Subscribed to new contact");

    // Schedule periodic re-subscribes every 5 minutes for THIS contact.
    setInterval(() => {
      if (contactStatus.has(contact.jid)) {
        sock.presenceSubscribe(contact.jid).catch(() => {});
      }
    }, 5 * 60 * 1000);
  } catch (err) {
    logger.error({ err, jid: contact.jid }, "Failed to subscribe to new contact");
  }
}

/** Unsubscribe from a contact (called when user removes a contact). */
export function unsubscribeFromContact(jid: string) {
  const state = contactStatus.get(jid);
  if (state?.offlineTimer) clearTimeout(state.offlineTimer);
  contactStatus.delete(jid);
  logger.info({ jid }, "Unsubscribed from contact");
}

/** Re-subscribe to all tracked contacts (presence subs expire). */
async function resubscribeAll(sock: WASocket) {
  const jids = Array.from(contactStatus.keys());
  logger.debug({ count: jids.length }, "Re-subscribing to presence for all contacts");

  for (let i = 0; i < jids.length; i++) {
    setTimeout(async () => {
      try {
        await sock.presenceSubscribe(jids[i]);
      } catch {
        // ignore — will retry next cycle
      }
    }, i * 500); // faster stagger for re-subs (already established)
  }
}

/** Extract just the phone number from any JID format. */
function phoneFromJid(jid: string): string {
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

/** Is this JID in LID format (@lid)? */
function isLid(jid: string): boolean {
  return jid.includes("@lid");
}

/**
 * Record a LID ↔ phone mapping from anywhere both identifiers are present.
 * Called with:  { remoteJid, remoteJidAlt }  from chats/messages events.
 */
function extractJidMapping(obj: any) {
  const a = obj?.remoteJid || obj?.id;
  const b = obj?.remoteJidAlt;
  if (!a || !b || a === b) return;

  const lid = isLid(a) ? a : (isLid(b) ? b : null);
  const phoneJid = !isLid(a) && a.includes("@s.whatsapp.net") ? a
                 : !isLid(b) && b.includes("@s.whatsapp.net") ? b
                 : null;

  if (lid && phoneJid) {
    const lidKey = lid.split(":")[0] + "@lid";        // normalise (strip ":NN" suffix)
    const phoneNum = phoneFromJid(phoneJid);
    if (!lidToPhone.has(lidKey)) {
      lidToPhone.set(lidKey, phoneNum);
      phoneToLid.set(phoneNum, lidKey);
      logger.info({ lid: lidKey, phone: phoneNum }, "Learned LID mapping");
    }
  }
}

/** Look up a tracked contact by any JID form (phone-based or LID). */
function findContactByJid(jid: string) {
  // First try direct phone number extraction
  const targetPhone = phoneFromJid(jid);
  for (const [storedJid, state] of contactStatus) {
    if (phoneFromJid(storedJid) === targetPhone) return state;
  }

  // If this is a LID, resolve it to a phone number and try again
  if (isLid(jid)) {
    const normalisedLid = jid.split(":")[0] + "@lid";
    const phoneFromLid = lidToPhone.get(normalisedLid);
    if (phoneFromLid) {
      for (const [storedJid, state] of contactStatus) {
        if (phoneFromJid(storedJid) === phoneFromLid) return state;
      }
    }
  }

  return undefined;
}

/** Handle incoming presence update from Baileys. */
async function handlePresenceUpdate(update: { id: string; presences: Record<string, { lastKnownPresence: string }> }) {
  const jid = update.id;
  const state = findContactByJid(jid);
  if (!state) return; // untracked contact

  // Pull the presence value — may be keyed by a different JID format than `id`
  let presence: string | undefined;
  for (const key of Object.keys(update.presences)) {
    presence = update.presences[key]?.lastKnownPresence;
    if (presence) break;
  }
  if (!presence) return;

  if (presence === "available" || presence === "composing" || presence === "recording") {
    // Contact is ONLINE (composing/recording also mean online)
    if (state.offlineTimer) {
      clearTimeout(state.offlineTimer);
      state.offlineTimer = undefined;
    }

    if (!state.isOnline) {
      state.isOnline = true;
      state.lastChange = new Date();
      logger.info({ name: state.name, jid }, "ONLINE");

      // Fire-and-forget presence log (not on UI critical path)
      db.logPresence(state.contactId, "online").catch((err) =>
        logger.error(err, "Failed to log presence")
      );

      // AWAIT the session write BEFORE firing the WS event so the frontend's
      // refetch always sees the new row.
      try {
        await db.openSession(state.contactId);
      } catch (err) {
        logger.error({ err }, "Failed to open session");
      }

      // Notify real-time listeners (dashboard + push notifications)
      listeners.forEach((cb) => cb(state.contactId, state.name, "online"));
    }
  } else if (presence === "unavailable") {
    // Contact went OFFLINE — use grace period to avoid flicker
    if (state.isOnline && !state.offlineTimer) {
      state.offlineTimer = setTimeout(async () => {
        state.isOnline = false;
        state.lastChange = new Date();
        state.offlineTimer = undefined;
        logger.info({ name: state.name, jid }, "OFFLINE");

        // Fire-and-forget presence log
        db.logPresence(state.contactId, "offline").catch((err) =>
          logger.error(err, "Failed to log presence")
        );

        // AWAIT closeSession + aggregateDay BEFORE firing the WS event so
        // the frontend's refetch sees the final end_time + updated daily_stats.
        try {
          await db.closeSession(state.contactId);
          const today = new Date().toISOString().slice(0, 10);
          await aggregateDay(today);
        } catch (err) {
          logger.error({ err }, "Failed to close session / aggregate");
        }

        listeners.forEach((cb) => cb(state.contactId, state.name, "offline"));
      }, config.tracking.offlineGracePeriodMs);
    }
  }
}
