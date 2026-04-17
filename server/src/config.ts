import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3001"),
  databaseUrl: process.env.DATABASE_URL || "postgresql://gst:gst_password@localhost:5432/gst_tracker",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  nodeEnv: process.env.NODE_ENV || "development",
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    email: process.env.VAPID_EMAIL || "",
  },
  // Presence tracking settings
  tracking: {
    // Delay between subscribing to each contact (ms) to avoid rate limits
    subscriptionStaggerMs: 500,
    // Re-subscribe interval (Baileys presence subscriptions expire)
    resubscribeIntervalMs: 5 * 60 * 1000, // 5 minutes (was 10)
    // How long to wait before marking an "unavailable" contact as offline
    offlineGracePeriodMs: 30 * 1000, // 30 seconds
  },
};