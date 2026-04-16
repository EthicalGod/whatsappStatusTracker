/**
 * Socket.io real-time layer.
 *
 * Clients connect and receive live presence updates + connection state.
 */

import { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { config } from "../config";
import { onPresenceChange, getCurrentStatuses } from "../whatsapp/presence";
import { onConnectionChange } from "../whatsapp/client";
import { logger } from "../utils/logger";

let io: SocketServer;

export function setupWebSocket(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: {
      origin: config.frontendUrl,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    logger.debug({ id: socket.id }, "WebSocket client connected");

    // Send current statuses on connect
    socket.emit("contacts:status", getCurrentStatuses());

    socket.on("disconnect", () => {
      logger.debug({ id: socket.id }, "WebSocket client disconnected");
    });
  });

  // Forward presence changes to all connected clients
  onPresenceChange((contactId, name, status) => {
    io.emit("presence:update", { contactId, name, status, timestamp: new Date() });
  });

  // Forward WhatsApp connection state to clients
  onConnectionChange((state) => {
    io.emit("whatsapp:connection", state);
  });

  logger.info("WebSocket server ready");
}
