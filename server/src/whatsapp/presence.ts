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

// Per-phone timestamp of the last presenceSubscribe() call. Used to gate the
// heuristic LID binding: only @lid presence events that arrive within a short
// window of a subscribe call are likely responses to OUR subscription;
// anything else is spurious traffic from the auth history's other contacts
// and must not be used to bind.
const lastSubscribeAt = new Map<string, number>();
const HEURISTIC_BIND_WINDOW_MS = 10_000;

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
// Identity of the last authenticated WhatsApp account (creds.me.id). If this
// changes across reconnects (user signed out and linked a different account),
// we must invalidate LID mappings and any cached online state — they were
// computed relative to the previous account and will be wrong for the new one.
let lastIdentity: string | null = null;

/**
 * Attach presence tracking to a socket. Safe to call on every reconnect —
 * event listeners are re-bound to the fresh socket, while state (contactStatus,
 * LID maps) and global timers are kept intact.
 */
export async function startTracking(sock: WASocket) {
  if (boundSockets.has(sock)) return; // idempotent for the same socket
  boundSockets.add(sock);

  // Detect a WhatsApp account switch and wipe state that belongs to the old
  // account. LIDs are *per-account* — the same phone has a different @lid
  // when viewed through a different logged-in account.
  const currentIdentity = sock.authState.creds.me?.id ?? null;
  if (lastIdentity && currentIdentity && lastIdentity !== currentIdentity) {
    logger.warn(
      { from: lastIdentity, to: currentIdentity },
      "Account switched — resetting LID maps and contact presence state"
    );
    lidToPhone.clear();
    phoneToLid.clear();
    lastSubscribeAt.clear();
    for (const [, state] of contactStatus) {
      if (state.isOnline) {
        db.closeSession(state.contactId).catch(() => {});
      }
      state.isOnline = false;
      state.lastChange = new Date();
      if (state.offlineTimer) {
        clearTimeout(state.offlineTimer);
        state.offlineTimer = undefined;
      }
    }
  }
  if (currentIdentity) lastIdentity = currentIdentity;

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
        lastSubscribeAt.set(phoneFromJid(contact.jid), Date.now());
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
    // Keep trying forever at 2 min cadence for any contact that's still
    // unmapped. It's a no-op once all contacts resolve.
    setInterval(retryLidResolution, 120_000);
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
 * WhatsApp right now. Slots are strictly opt-in:
 *  - No schedule configured (empty) → tracker is OFF (broadcast unavailable).
 *  - Schedule configured → available only when the current time falls
 *    inside at least one of the global slots.
 */
function shouldSelfBeAvailable(): boolean {
  return isWithinSchedule();
}

// Memoised so we can detect idle→active transitions and fire a fresh
// round of `presenceSubscribe()` (WhatsApp drops subs when we go offline).
let lastSelfAvailable: boolean | null = null;

// Holds the active trySend closure so forceAvailabilityReevaluation can
// fire an immediate tick instead of waiting for the 60-second interval.
let pokeSelfAvailable: (() => Promise<void>) | null = null;

/**
 * Reset the memo AND fire an immediate availability tick. Call this
 * whenever the schedule cache changes (e.g. the user saves a new schedule)
 * so transitions into/out of a slot take effect within seconds rather
 * than up to 60s (the normal tick interval).
 */
export function forceAvailabilityReevaluation() {
  lastSelfAvailable = null;
  if (pokeSelfAvailable) {
    pokeSelfAvailable().catch(() => {});
  }
  // Also close any session that the new schedule says should be closed,
  // without waiting for the next 60-second enforceSchedules tick.
  enforceSchedules().catch(() => {});
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
      // Always set a fallback name on the creds, not just when going
      // available. Baileys has internal periodic presence broadcasts that
      // otherwise log "no name present, ignoring presence update request..."
      // every ~30 seconds while we're idle. Setting the name is harmless
      // (never shown to other users) and silences the noise.
      if (sock.authState.creds.me && !sock.authState.creds.me.name) {
        sock.authState.creds.me.name = "GST Tracker";
      }
      await sock.sendPresenceUpdate(wantAvailable ? "available" : "unavailable");
      if (prev !== wantAvailable) {
        logger.info({ wantAvailable }, "Self presence flipped");
      }

      // Transitioning back into a tracking window — re-subscribe to every
      // tracked contact so WhatsApp resumes pushing their presence. Also
      // true on the very first tick after boot (prev === null).
      if (wantAvailable && prev !== true) {
        logger.info("Entering tracking window — re-subscribing all contacts");
        resubscribeAll().catch(() => {});
      }
    } catch (err: any) {
      const code = err?.output?.statusCode;
      if (code !== 428) {
        logger.warn({ err }, "Failed to send self presence update");
      }
    }
  };

  pokeSelfAvailable = trySend;
  setTimeout(trySend, 3000);
  setInterval(trySend, 30_000); // tighter cadence = less drift at slot edges
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
    // Authoritative Baileys API: checks its own signalRepository mapping cache
    // first, then falls back to a USync fetch against WhatsApp's server.
    // Returns the actual LID or null. Avoids heuristic guessing entirely.
    const repo: any = (sock as any).signalRepository;
    if (!repo?.lidMapping?.getLIDForPN) {
      logger.warn("signalRepository.lidMapping not available on this Baileys version");
      return;
    }
    const lid: string | null = await withTimeout(
      repo.lidMapping.getLIDForPN(phoneJid),
      10_000
    );
    if (!lid) {
      logger.debug({ phoneJid }, "getLIDForPN returned null — will retry");
      return;
    }
    const lidKey = normaliseLid(lid);
    const phoneNum = phoneFromJid(phoneJid);
    lidToPhone.set(lidKey, phoneNum);
    phoneToLid.set(phoneNum, lidKey);
    logger.info({ phone: phoneNum, lid: lidKey }, "Resolved LID via signalRepository");
  } catch (err) {
    logger.warn({ err, phoneJid }, "Could not resolve LID");
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
    lastSubscribeAt.set(phoneFromJid(contact.jid), Date.now());
    logger.info({ jid: contact.jid, name: contact.name }, "Subscribed to new contact");

    // Schedule periodic re-subscribes every 5 minutes for THIS contact.
    setInterval(() => {
      if (contactStatus.has(contact.jid)) {
        sock.presenceSubscribe(contact.jid).catch(() => {});
        lastSubscribeAt.set(phoneFromJid(contact.jid), Date.now());
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
        lastSubscribeAt.set(phoneFromJid(jids[i]), Date.now());
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

    // Heuristic fallback: if only ONE tracked contact is still unmapped AND
    // we called presenceSubscribe on it within the last ~10 seconds, this
    // @lid event is almost certainly a response to OUR subscribe. Anything
    // older is spurious traffic from the auth history (other contacts whose
    // chats are still in sync) and we must not let it hijack the binding.
    const unmapped = Array.from(contactStatus.entries()).filter(
      ([storedJid]) => !phoneToLid.has(phoneFromJid(storedJid))
    );
    if (unmapped.length === 1) {
      const [storedJid, state] = unmapped[0];
      const phoneNum = phoneFromJid(storedJid);
      const subAt = lastSubscribeAt.get(phoneNum) ?? 0;
      const age = Date.now() - subAt;
      if (age <= HEURISTIC_BIND_WINDOW_MS) {
        lidToPhone.set(normalisedLid, phoneNum);
        phoneToLid.set(phoneNum, normalisedLid);
        logger.info(
          { lid: normalisedLid, phone: phoneNum, name: state.name, ageMs: age },
          "Heuristically bound LID to sole unmapped contact"
        );
        return state;
      }
      logger.debug(
        { lid: normalisedLid, phone: phoneNum, ageMs: age },
        "Skipping heuristic bind — too long since last subscribe"
      );
    }
  }

  return undefined;
}

/** Handle incoming presence update from Baileys. */
async function handlePresenceUpdate(update: { id: string; presences: Record<string, { lastKnownPresence: string }> }) {
  const jid = update.id;
  const state = findContactByJid(jid);
  if (!state) {
    if (isLid(jid)) {
      logger.warn({ jid, mappedLids: Array.from(lidToPhone.keys()) }, "Dropped presence: unmapped LID");
      // Best-effort recovery: kick a resolve for every tracked contact that
      // still has no LID. If WhatsApp has the mapping cached now (often true
      // after a few presence events), the very next event will route.
      retryLidResolution().catch(() => {});
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
