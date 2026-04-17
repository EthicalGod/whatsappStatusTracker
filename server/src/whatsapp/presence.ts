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
import { isWithinSchedule, hasSchedules } from "../services/schedules";
import { getSocket } from "./client";

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

// Tracks which sockets already have our listeners attached, so callers can
// invoke startTracking on every reconnect without double-binding.
const boundSockets = new WeakSet<WASocket>();
let timersInstalled = false;

/**
 * Attach presence tracking to a socket. Safe to call on every reconnect —
 * event listeners are re-bound to the fresh socket, while state (contactStatus,
 * LID maps) and global timers are kept intact.
 */
export async function startTracking(sock: WASocket) {
  if (boundSockets.has(sock)) return; // idempotent for the same socket
  boundSockets.add(sock);

  const contacts = await db.getActiveContacts();
  logger.info({ count: contacts.length, jids: contacts.map(c => c.jid) }, "Starting presence tracking");

  // Register presence event handler — fresh per socket, because sock.ev is
  // a new EventEmitter each connect.
  sock.ev.on("presence.update", handlePresenceUpdate);

  // Silently build LID ↔ phone mapping from chat/message events.
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

  // Stagger subscriptions to avoid rate limits. On reconnect, contactStatus
  // already has entries — we just re-subscribe on the new socket.
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    if (!contactStatus.has(contact.jid)) {
      contactStatus.set(contact.jid, {
        contactId: contact.id,
        name: contact.name,
        isOnline: false,
        lastChange: new Date(),
      });
    }

    setTimeout(async () => {
      try {
        await resolveAndCacheLid(sock, contact.jid);
        await withTimeout(sock.presenceSubscribe(contact.jid), 5000);
        logger.info({ jid: contact.jid, name: contact.name }, "Subscribed to presence");
      } catch (err) {
        logger.error({ err, jid: contact.jid }, "Failed to subscribe to presence");
      }
    }, i * config.tracking.subscriptionStaggerMs);
  }

  // Install global timers only once — they use getSocket() internally so they
  // always operate on the current live socket, even across reconnects.
  if (!timersInstalled) {
    timersInstalled = true;
    keepSelfAvailable();
    setTimeout(() => retryLidResolution(), 20_000);
    setTimeout(() => retryLidResolution(), 60_000);
    setInterval(() => resubscribeAll(), config.tracking.resubscribeIntervalMs);
    setInterval(enforceSchedules, 60_000); // close out-of-window sessions
  }
}

/**
 * Once a minute, check every in-memory online contact. If the current time
 * has drifted outside that contact's tracking window, treat it as an OFFLINE
 * transition — close the session, aggregate, and fire the WS event.
 */
async function enforceSchedules() {
  for (const [jid, state] of contactStatus) {
    if (!state.isOnline) continue;
    if (isWithinSchedule(state.contactId)) continue;

    logger.info({ name: state.name }, "Window ended — closing session");
    state.isOnline = false;
    state.lastChange = new Date();
    if (state.offlineTimer) {
      clearTimeout(state.offlineTimer);
      state.offlineTimer = undefined;
    }
    db.logPresence(state.contactId, "offline").catch(() => {});
    try {
      await db.closeSession(state.contactId);
      const today = new Date().toISOString().slice(0, 10);
      await aggregateDay(today);
    } catch (err) {
      logger.error({ err, jid }, "Failed to close out-of-window session");
    }
    listeners.forEach((cb) => cb(state.contactId, state.name, "offline"));
  }
}

/**
 * Retry `onWhatsApp()` for any tracked contact whose LID we haven't learned yet.
 * Called periodically after connection stabilises.
 */
async function retryLidResolution() {
  let sock: WASocket;
  try {
    sock = getSocket();
  } catch {
    return; // not connected yet
  }
  for (const [storedJid] of contactStatus) {
    const phone = phoneFromJid(storedJid);
    if (phoneToLid.has(phone)) continue; // already mapped
    await resolveAndCacheLid(sock, storedJid);
  }
}

/**
 * Continuously mark our own account as "available" so WhatsApp's server
 * pushes us presence updates for contacts we've subscribed to.
 *
 * Problem: Baileys' `markOnlineOnConnect: true` tries to send a presence
 * update on connect, but on a freshly-paired account the `creds.me.name`
 * field is empty, so Baileys logs "no name present, ignoring presence
 * update request..." and skips it. Result: WhatsApp thinks we're offline
 * and never pushes us presence events.
 *
 * Fix: (1) wait for creds.update to populate a name, then send ourselves,
 * and (2) re-send every 60 seconds to keep the server's idle timer reset.
 */
/**
 * Decide whether the tracker account should be marked "available" to
 * WhatsApp right now. Rules:
 *  - Any tracked contact with NO schedules forces 24/7 availability
 *    (otherwise we'd silently stop tracking them).
 *  - Otherwise, be available iff at least one scheduled contact's window
 *    includes the current time (union semantics).
 *  - If no contacts are tracked at all, we still broadcast available so
 *    the account stays linked and ready for new additions.
 */
function shouldSelfBeAvailable(): boolean {
  if (contactStatus.size === 0) return true;
  for (const [, state] of contactStatus) {
    if (!hasSchedules(state.contactId)) return true;
    if (isWithinSchedule(state.contactId)) return true;
  }
  return false;
}

// Memoised so we can detect idle→active transitions and fire a fresh
// round of `presenceSubscribe()` (WhatsApp drops subs when we go offline).
let lastSelfAvailable: boolean | null = null;

/**
 * Reset the memo so the next `keepSelfAvailable` tick re-evaluates from
 * scratch. Call this whenever the schedule cache changes (e.g. the user
 * saves a new schedule) so the transition re-fires subscriptions even
 * inside a 60-second poll window.
 */
export function forceAvailabilityReevaluation() {
  lastSelfAvailable = null;
}

function keepSelfAvailable() {
  const trySend = async () => {
    let sock: WASocket;
    try {
      sock = getSocket();
    } catch {
      return; // socket not initialised (or just logged out)
    }

    const wantAvailable = shouldSelfBeAvailable();
    const prev = lastSelfAvailable;
    lastSelfAvailable = wantAvailable;

    try {
      if (wantAvailable && sock.authState.creds.me && !sock.authState.creds.me.name) {
        // Placeholder so Baileys' "no name present" guard clears on fresh pair.
        sock.authState.creds.me.name = "GST Tracker";
      }
      await sock.sendPresenceUpdate(wantAvailable ? "available" : "unavailable");
      logger.debug({ wantAvailable }, "Self presence update sent");

      // Idle → active transition: re-subscribe to every tracked contact so
      // WhatsApp restarts pushing us their presence.
      if (wantAvailable && prev === false) {
        logger.info("Re-entering tracking window — re-subscribing all contacts");
        resubscribeAll().catch(() => {});
      }
    } catch (err: any) {
      const code = err?.output?.statusCode;
      if (code !== 428) {
        logger.warn({ err }, "Failed to send self presence update");
      }
    }
  };

  setTimeout(trySend, 3000);
  setInterval(trySend, 60_000);
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
      const lidKey = normaliseLid(String(lid));
      const phoneNum = phoneFromJid(phoneJid);
      lidToPhone.set(lidKey, phoneNum);
      phoneToLid.set(phoneNum, lidKey);
      logger.info({ phone: phoneNum, lid: lidKey }, "Pre-resolved LID mapping");
    } else {
      logger.debug({ phoneJid }, "onWhatsApp returned no LID — will learn via heuristic or chat events");
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
async function resubscribeAll() {
  let sock: WASocket;
  try {
    sock = getSocket();
  } catch {
    return;
  }
  const jids = Array.from(contactStatus.keys());
  logger.debug({ count: jids.length }, "Re-subscribing to presence for all contacts");

  for (let i = 0; i < jids.length; i++) {
    setTimeout(async () => {
      try {
        await sock.presenceSubscribe(jids[i]);
      } catch {
        // ignore — will retry next cycle
      }
    }, i * 500);
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
 * Normalise a LID to `<num>@lid` form, stripping any `:device` suffix.
 * Input may be "167795866263691@lid" or "167795866263691:0@lid".
 */
function normaliseLid(lid: string): string {
  const localPart = lid.split("@")[0].split(":")[0];
  return `${localPart}@lid`;
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
    const lidKey = normaliseLid(lid);
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
    const normalisedLid = normaliseLid(jid);
    const phoneFromLid = lidToPhone.get(normalisedLid);
    if (phoneFromLid) {
      for (const [storedJid, state] of contactStatus) {
        if (phoneFromJid(storedJid) === phoneFromLid) return state;
      }
    }

    // Heuristic fallback: if only ONE tracked contact is still unmapped,
    // this LID must belong to them. Common when onWhatsApp() doesn't return
    // the `lid` field (older/partial Baileys versions) — we can't resolve
    // proactively, so we bind on first arrival instead.
    const unmapped = Array.from(contactStatus.entries()).filter(
      ([storedJid]) => !phoneToLid.has(phoneFromJid(storedJid))
    );
    if (unmapped.length === 1) {
      const [storedJid, state] = unmapped[0];
      const phoneNum = phoneFromJid(storedJid);
      lidToPhone.set(normalisedLid, phoneNum);
      phoneToLid.set(phoneNum, normalisedLid);
      logger.info(
        { lid: normalisedLid, phone: phoneNum, name: state.name },
        "Heuristically bound LID to sole unmapped contact"
      );
      return state;
    }
  }

  return undefined;
}

/** Handle incoming presence update from Baileys. */
async function handlePresenceUpdate(update: { id: string; presences: Record<string, { lastKnownPresence: string }> }) {
  const jid = update.id;
  const state = findContactByJid(jid);
  if (!state) {
    // Log dropped events for LIDs we haven't mapped — this tells us whether
    // the mapping is the blocker vs. events genuinely not arriving.
    if (isLid(jid)) {
      logger.warn({ jid, mappedLids: Array.from(lidToPhone.keys()) }, "Dropped presence: unmapped LID");
    }
    return;
  }

  // Pull the presence value — may be keyed by a different JID format than `id`
  let presence: string | undefined;
  for (const key of Object.keys(update.presences)) {
    presence = update.presences[key]?.lastKnownPresence;
    if (presence) break;
  }
  if (!presence) return;

  if (presence === "available" || presence === "composing" || presence === "recording") {
    // Respect per-contact tracking windows: outside a configured slot,
    // we simply ignore online events so no session opens.
    if (!isWithinSchedule(state.contactId)) {
      logger.debug({ name: state.name }, "Skipping ONLINE — outside tracking window");
      return;
    }
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
