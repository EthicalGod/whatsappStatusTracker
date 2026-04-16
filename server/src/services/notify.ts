/**
 * Push notification service.
 * Sends browser push notifications when tracked contacts come online.
 */

import webpush from "web-push";
import { pool } from "../db/connection";
import { config } from "../config";
import { logger } from "../utils/logger";

if (config.vapid.publicKey && config.vapid.privateKey) {
  webpush.setVapidDetails(
    config.vapid.email,
    config.vapid.publicKey,
    config.vapid.privateKey
  );
}

export async function saveSubscription(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}) {
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO NOTHING`,
    [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

export async function notifyOnline(contactName: string) {
  if (!config.vapid.publicKey) return;

  const { rows } = await pool.query("SELECT * FROM push_subscriptions");

  const payload = JSON.stringify({
    title: "GST Tracker",
    body: `${contactName} is now online`,
    icon: "/icon-192.png",
  });

  for (const sub of rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
        },
        payload
      );
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove it
        await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
      } else {
        logger.error({ err, endpoint: sub.endpoint }, "Push notification failed");
      }
    }
  }
}
