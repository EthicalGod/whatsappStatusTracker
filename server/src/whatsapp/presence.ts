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

// In-memory state: tracks current online status per JID
const contactStatus = new Map<string, {
  contactId: string;
  name: string;
  isOnline: boolean;
  lastChange: Date;
  offlineTimer?: NodeJS.Timeout; // grace period before marking offline
}>();

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
  logger.info({ count: contacts.length }, "Starting presence tracking");

  // Register presence event handler
  sock.ev.on("presence.update", handlePresenceUpdate);

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
        await sock.presenceSubscribe(contact.jid);
        logger.debug({ jid: contact.jid, name: contact.name }, "Subscribed to presence");
      } catch (err) {
        logger.error({ err, jid: contact.jid }, "Failed to subscribe to presence");
      }
    }, i * config.tracking.subscriptionStaggerMs);
  }

  // Re-subscribe periodically (presence subscriptions expire)
  setInterval(() => resubscribeAll(sock), config.tracking.resubscribeIntervalMs);
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
    await sock.presenceSubscribe(contact.jid);
    logger.info({ jid: contact.jid, name: contact.name }, "Subscribed to new contact");
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

/** Handle incoming presence update from Baileys. */
function handlePresenceUpdate(update: { id: string; presences: Record<string, { lastKnownPresence: string }> }) {
  const jid = update.id;
  const state = contactStatus.get(jid);
  if (!state) return; // not a tracked contact

  const presenceData = update.presences[jid];
  if (!presenceData) return;

  const presence = presenceData.lastKnownPresence;
  // Baileys presence values: "available", "unavailable", "composing", "recording"

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

      // Record in database
      db.logPresence(state.contactId, "online").catch((err) =>
        logger.error(err, "Failed to log presence")
      );
      db.openSession(state.contactId).catch((err) =>
        logger.error(err, "Failed to open session")
      );

      // Notify real-time listeners
      listeners.forEach((cb) => cb(state.contactId, state.name, "online"));
    }
  } else if (presence === "unavailable") {
    // Contact went OFFLINE — use grace period to avoid flicker
    if (state.isOnline && !state.offlineTimer) {
      state.offlineTimer = setTimeout(() => {
        state.isOnline = false;
        state.lastChange = new Date();
        state.offlineTimer = undefined;
        logger.info({ name: state.name, jid }, "OFFLINE");

        db.logPresence(state.contactId, "offline").catch((err) =>
          logger.error(err, "Failed to log presence")
        );
        db.closeSession(state.contactId).catch((err) =>
          logger.error(err, "Failed to close session")
        );

        listeners.forEach((cb) => cb(state.contactId, state.name, "offline"));
      }, config.tracking.offlineGracePeriodMs);
    }
  }
}
