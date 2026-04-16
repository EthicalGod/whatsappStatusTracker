import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { logger } from "../utils/logger";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  logger.error(err, "Unexpected database pool error");
});

/** Run schema.sql to initialise the database tables. */
export async function initDB() {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  try {
    await pool.query(sql);
    logger.info("Database schema initialised.");
  } catch (err) {
    logger.error(err, "Failed to initialise database schema");
    throw err;
  }
}
