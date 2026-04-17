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
    logger: logger.child({ module: "baileys" }) as any,
    syncFullHistory: false,
    // Match real browser behaviour — some WhatsApp checks need these
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
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
