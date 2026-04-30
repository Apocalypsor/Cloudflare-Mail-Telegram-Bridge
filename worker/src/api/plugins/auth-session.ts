import { SESSION_COOKIE_NAME } from "@worker/constants";
import { getUserByTelegramId } from "@worker/db/users";
import { verifySessionCookie } from "@worker/utils/session";
import { Elysia, status } from "elysia";
import { cf } from "./cf";

/**
 * Session cookie 鉴权：tg_session cookie 验签 + users.approved 检查（管理员豁免）。
 * 失败返回 401 JSON。通过则在 context 里挂 `userId` + `isAdmin`。
 */
export const authSession = new Elysia({ name: "auth-session" })
  .use(cf)
  .derive({ as: "scoped" }, async ({ env, cookie }) => {
    const sessionValue = cookie[SESSION_COOKIE_NAME]?.value as
      | string
      | undefined;
    if (!sessionValue) return status(401, { error: "Unauthorized" });

    const telegramId = await verifySessionCookie(
      env.ADMIN_SECRET,
      sessionValue,
    );
    if (!telegramId) return status(401, { error: "Unauthorized" });

    const isAdmin = telegramId === env.ADMIN_TELEGRAM_ID;
    const user = await getUserByTelegramId(env.DB, telegramId);
    if (!user || (!user.approved && !isAdmin)) {
      return status(401, { error: "Unauthorized" });
    }
    return { userId: telegramId, isAdmin };
  });
