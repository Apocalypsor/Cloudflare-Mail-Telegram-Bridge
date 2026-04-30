import { getUserByTelegramId } from "@worker/db/users";
import { verifyTgInitData } from "@worker/utils/tg-init-data";
import { Elysia } from "elysia";
import { cf } from "./cf";

/**
 * Mini App 鉴权：X-Telegram-Init-Data 头验签 + users.approved 检查（管理员豁免）。
 * 失败返回 401 JSON。通过则在 context 里挂 `userId` + `isAdmin`。
 */
export const authMiniApp = new Elysia({ name: "auth-miniapp" })
  .use(cf)
  .derive({ as: "scoped" }, async ({ env, headers, status }) => {
    const initData = headers["x-telegram-init-data"];
    if (!initData) return status(401, { error: "Unauthorized" });

    const tgUser = await verifyTgInitData(env.TELEGRAM_BOT_TOKEN, initData);
    if (!tgUser) return status(401, { error: "Unauthorized" });

    const telegramId = String(tgUser.id);
    const isAdmin = telegramId === env.ADMIN_TELEGRAM_ID;
    if (isAdmin) return { userId: telegramId, isAdmin };

    const dbUser = await getUserByTelegramId(env.DB, telegramId);
    if (!dbUser || dbUser.approved !== 1) {
      return status(401, { error: "Unauthorized" });
    }
    return { userId: telegramId, isAdmin };
  });
