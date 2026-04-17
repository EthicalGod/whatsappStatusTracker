/**
 * GST Tracker — Server Entry Point
 *
 * Starts the Fastify server, connects to WhatsApp via Baileys,
 * and begins tracking presence for all active contacts.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createServer } from "http";
import cron from "node-cron";

import { config } from "./config";
import { logger } from "./utils/logger";
import { initDB } from "./db/connection";
import { connectWhatsApp, onConnectionChange, getSocket } from "./whatsapp/client";
import { startTracking } from "./whatsapp/presence";
import { onPresenceChange } from "./whatsapp/presence";
import { registerRoutes } from "./api/routes";
import { setupWebSocket } from "./api/websocket";
import { aggregateDay } from "./services/analytics";
import { notifyOnline } from "./services/notify";

async function main() {
  // 1. Initialise database
  await initDB();
  logger.info("Database ready");

  // 2. Set up Fastify + HTTP server
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: config.frontendUrl });
  await registerRoutes(app);

  const httpServer = createServer(app.server);
  setupWebSocket(httpServer);

  // 3. Connect to WhatsApp
  await connectWhatsApp();

  // Start tracking once connected — use getSocket() so we always get the
  // current live socket (not a stale reference after a reconnect).
  let hasStarted = false;
  onConnectionChange((update) => {
    if (update.connection === "open" && !hasStarted) {
      hasStarted = true;
      startTracking(getSocket());
    }
  });

  // 4. Send push notifications when contacts come online
  onPresenceChange((contactId, name, status) => {
    if (status === "online") {
      notifyOnline(name).catch((err) =>
        logger.error(err, "Failed to send push notification")
      );
    }
  });

  // 5. Aggregate daily stats at midnight
  cron.schedule("5 0 * * *", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    aggregateDay(yesterday).catch((err) =>
      logger.error(err, "Daily aggregation failed")
    );
  });

  // Also aggregate current day every hour for live stats
  cron.schedule("0 * * * *", () => {
    const today = new Date().toISOString().slice(0, 10);
    aggregateDay(today).catch((err) =>
      logger.error(err, "Hourly aggregation failed")
    );
  });

  // 6. Start listening
  httpServer.listen(config.port, () => {
    logger.info(`Server running on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
