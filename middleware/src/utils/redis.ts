import { createClient } from "redis";
import { config } from "../config";

const KEY_PREFIX = "telemail:lastUid:";

let redis: ReturnType<typeof createClient> | null = null;

if (config.redisUrl) {
  redis = createClient({ url: config.redisUrl });
  redis.on("error", (err) => {
    console.error("[Redis] Error:", err.message);
  });
  redis.on("ready", () => {
    console.log("[Redis] Connected");
  });
  redis.connect().catch(() => {});
}

export const getLastUid = async (accountId: number): Promise<number | null> => {
  if (!redis?.isReady) return null;
  try {
    const val = await redis.get(`${KEY_PREFIX}${accountId}`);
    return val ? Number.parseInt(val, 10) : null;
  } catch {
    return null;
  }
};

export const setLastUid = async (
  accountId: number,
  uid: number,
): Promise<void> => {
  if (!redis?.isReady) return;
  try {
    await redis.set(`${KEY_PREFIX}${accountId}`, uid.toString());
  } catch {}
};
