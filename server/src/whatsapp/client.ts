/**
 * Baileys WhatsApp client wrapper.
 *
 * Handles connection, authentication, auto-reconnect, and exposes
 * the socket for use by the presence tracking engine.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  ConnectionState,
  Browsers,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { join } from "path";
import { logger } from "../utils/logger";
import qrcode from "qrcode-terminal";

const AUTH_DIR = join(__dirname, "..", "..", "auth_info");

export type ConnectionCallback = (state: Partial<ConnectionState>) => void;

let socket: WASocket | null = null;
let connectionListeners: ConnectionCallback[] = [];
let currentQR: string | null = null;

export function onConnectionChange(cb: ConnectionCallback) {
  connectionListeners.push(cb);
}

export function getSocket(): WASocket {
  if (!socket) throw new Error("WhatsApp client not initialised");
  return socket;
}

/** Returns the latest QR string if awaiting scan, or null if already authenticated. */
export function getCurrentQR(): string | null {
  return currentQR;
}

/**
 * Log out from WhatsApp and clear the persisted session.
 * On next connection the user will need to scan a QR code again.
 */
export async function logoutWhatsApp(): Promise<void> {
  if (!socket) throw new Error("WhatsApp client not initialised");

  try {
    await socket.logout();
  } catch (err) {
    logger.warn({ err }, "Baileys logout() failed — forcing auth clear");
  }

  // Wipe the auth directory so next startup starts fresh with a QR
  const fs = await import("fs/promises");
  try {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    await fs.mkdir(AUTH_DIR, { recursive: true });
    logger.info("Auth state cleared");
  } catch (err) {
    logger.error({ err }, "Could not clear auth_info directory");
  }

  // Null out the socket so getSocket() throws until re-auth completes
  socket = null;

  // Reconnect — this will display a fresh QR code for scanning
  setTimeout(() => connectWhatsApp(), 2000);
}

export async function connectWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Fetch the latest WhatsApp Web protocol version so WhatsApp's servers
  // don't reject us with 405 (outdated client)
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Using WhatsApp Web version");

  const sock = makeWASocket({
    version,
    auth: state,
    // Browsers.macOS registers as a valid client — needed to avoid 405
    browser: Browsers.macOS("GST Tracker"),
    // Silence Baileys' verbose internal logs — we only need WARN+ from it
    logger: logger.child({ module: "baileys" }, { level: "warn" }) as any,
    syncFullHistory: false,
    // Mark our own client as online — required for WhatsApp to push us
    // presence updates from other contacts. With false, WhatsApp treats us
    // as a background/offline client and sends no presence events.
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    // Ignore status broadcasts and group messages entirely.
    // We ONLY need 1-on-1 presence updates. Group/status messages trigger
    // decryption errors that stall Baileys' message queue and block presence.
    shouldIgnoreJid: (jid: string) =>
      jid.includes("@broadcast") ||
      jid.includes("status@") ||
      jid.includes("@g.us") ||
      jid.includes("@newsletter"),
    // Stub message retrieval — we never need historical messages for presence
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Show QR code (terminal + expose via HTTP endpoint)
    if (qr) {
      currentQR = qr;
      logger.info("Scan this QR code with WhatsApp on your phone:");
      logger.info("  Or open: http://YOUR_SERVER_IP:3000/api/qr");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      currentQR = null;
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      logger.warn({ reason }, "Connection closed");

      if (shouldReconnect) {
        logger.info("Reconnecting in 5 seconds...");
        setTimeout(() => connectWhatsApp(), 5000);
      } else {
        logger.error("Logged out. Delete auth_info/ and re-scan QR.");
      }
    }

    if (connection === "open") {
      logger.info("Connected to WhatsApp");
    }

    // Notify all listeners
    connectionListeners.forEach((cb) => cb(update));
  });

  socket = sock;
  return sock;
}
