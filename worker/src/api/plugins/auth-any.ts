import { SESSION_COOKIE_NAME } from "@worker/constants";
import { getUserByTelegramId } from "@worker/db/users";
import { verifySessionCookie } from "@worker/utils/session";
import { verifyTgInitData } from "@worker/utils/tg-init-data";
import { Elysia } from "elysia";
import { cf } from "./cf";

/**
 * 邮件操作类 API（POST /api/mail/:id/*）共用的鉴权 —— Mini App 调用带
 * `X-Telegram-Init-Data`，web 登录用户带 session cookie，任一通过即可。
 * 失败返回 401 JSON（不是 302，避免 XHR 被当 HTML 响应跟进重定向）。
 */
export const authAny = new Elysia({ name: "auth-any" })
  .use(cf)
  .derive({ as: "scoped" }, async ({ env, cookie, headers, status }) => {
    // 1) Session cookie
    const sessionValue = cookie[SESSION_COOKIE_NAME]?.value as
      | string
      | undefined;
    if (sessionValue) {
      const telegramId = await verifySessionCookie(
        env.ADMIN_SECRET,
        sessionValue,
      );
      if (telegramId) {
        const isAdmin = telegramId === env.ADMIN_TELEGRAM_ID;
        const user = await getUserByTelegramId(env.DB, telegramId);
        if (user && (user.approved || isAdmin)) {
          return { userId: telegramId, isAdmin };
        }
      }
    }

    // 2) Mini App init data
    const initData = headers["x-telegram-init-data"];
    if (initData) {
      const tgUser = await verifyTgInitData(env.TELEGRAM_BOT_TOKEN, initData);
      if (tgUser) {
        const telegramId = String(tgUser.id);
        const isAdmin = telegramId === env.ADMIN_TELEGRAM_ID;
        if (isAdmin) return { userId: telegramId, isAdmin };
        const dbUser = await getUserByTelegramId(env.DB, telegramId);
        if (dbUser?.approved === 1) return { userId: telegramId, isAdmin };
      }
    }

    return status(401, { error: "Unauthorized" });
  });
