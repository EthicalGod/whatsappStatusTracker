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
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { join } from "path";
import { logger } from "../utils/logger";
import qrcode from "qrcode-terminal";

const AUTH_DIR = join(__dirname, "..", "..", "auth_info");

export type ConnectionCallback = (state: Partial<ConnectionState>) => void;

let socket: WASocket | null = null;
let connectionListeners: ConnectionCallback[] = [];

export function onConnectionChange(cb: ConnectionCallback) {
  connectionListeners.push(cb);
}

export function getSocket(): WASocket {
  if (!socket) throw new Error("WhatsApp client not initialised");
  return socket;
}

export async function connectWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR display ourselves
    logger: logger.child({ module: "baileys" }) as any,
    // Don't sync full chat history — we only need presence
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Show QR code in terminal for first-time auth
    if (qr) {
      logger.info("Scan this QR code with WhatsApp on your phone:");
      qrcode.generate(qr, { small: true });
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
