/**
 * GST Tracker — Server Entry Point
 *
 * Starts the Fastify server, connects to WhatsApp via Baileys,
 * and begins tracking presence for all active contacts.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import cron from "node-cron";

import { config } from "./config";
import { logger } from "./utils/logger";
import { initDB, pool } from "./db/connection";
import { connectWhatsApp, onConnectionChange, getSocket } from "./whatsapp/client";
import { startTracking } from "./whatsapp/presence";
import { onPresenceChange } from "./whatsapp/presence";
import { registerRoutes } from "./api/routes";
import { setupWebSocket } from "./api/websocket";
import { aggregateDay } from "./services/analytics";
import { refreshScheduleCache } from "./services/schedules";
import { notifyOnline } from "./services/notify";

/**
 * Close any sessions left open from a previous server run (crash, restart, etc).
 * Without this, a contact who was online when the server died would show a
 * ghost "Now (live)" session in the dashboard forever.
 */
async function closeOrphanSessions() {
  const { rowCount } = await pool.query(
    `UPDATE sessions
     SET end_time = NOW(),
         duration_s = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
     WHERE end_time IS NULL`
  );
  if (rowCount && rowCount > 0) {
    logger.warn(`Closed ${rowCount} orphan session(s) on startup`);
  }
}

async function main() {
  // 1. Initialise database
  await initDB();
  await closeOrphanSessions();
  await refreshScheduleCache();
  logger.info("Database ready");

  // 2. Set up Fastify
  const app = Fastify({ logger: false });
  // CORS: allow the full set of methods we actually use. Fastify's default
  // only allows GET/HEAD/POST, which breaks DELETE (remove contact) and PUT.
  await app.register(cors, {
    origin: config.frontendUrl,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await registerRoutes(app);

  // 3. Start listening FIRST (binds Fastify to the port)
  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(`Server running on http://0.0.0.0:${config.port}`);

  // 4. Attach Socket.io to the now-listening server
  setupWebSocket(app.server);

  // 5. Connect to WhatsApp
  await connectWhatsApp();

  // (Re)start tracking on every connection open. startTracking is idempotent
  // per socket — listeners are bound exactly once to each fresh socket, and
  // global timers are installed exactly once across the process lifetime.
  // This is what keeps presence working after Baileys' post-QR stream:error
  // 515 reconnect (where a brand-new WASocket replaces the original).
  onConnectionChange((update) => {
    if (update.connection === "open") {
      setTimeout(() => {
        logger.info("Starting tracking");
        startTracking(getSocket()).catch((err) =>
          logger.error({ err }, "startTracking failed")
        );
      }, 2000);
    }
  });

  // 6. Push notifications when contacts come online
  onPresenceChange((contactId, name, status) => {
    if (status === "online") {
      notifyOnline(name).catch((err) =>
        logger.error(err, "Failed to send push notification")
      );
    }
  });

  // 7. Daily stats aggregation
  cron.schedule("5 0 * * *", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    aggregateDay(yesterday).catch((err) =>
      logger.error(err, "Daily aggregation failed")
    );
  });
  cron.schedule("0 * * * *", () => {
    const today = new Date().toISOString().slice(0, 10);
    aggregateDay(today).catch((err) =>
      logger.error(err, "Hourly aggregation failed")
    );
  });
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
