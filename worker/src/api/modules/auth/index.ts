import { cf } from "@worker/api/plugins/cf";
import { getBotInfo } from "@worker/bot/index";
import { SESSION_COOKIE_NAME } from "@worker/constants";
import { getUserByTelegramId, upsertUser } from "@worker/db/users";
import {
  generateSessionCookie,
  type TelegramLoginData,
  verifySessionCookie,
  verifyTelegramLogin,
} from "@worker/utils/session";
import { Elysia } from "elysia";
import { LoginCallbackQuery } from "./model";

/**
 * Auth controller —— web 登录页相关 API：
 *  - GET  /api/session/whoami       Session 探测（401 = 未登录）
 *  - POST /api/session/logout       清 cookie
 *  - GET  /api/public/bot-info      公开拉 bot username（登录页用）
 *  - GET  /api/login/callback       TG Login Widget 回调，验签 + 下 cookie + 302
 */
export const authController = new Elysia({ name: "controller.auth" })
  .use(cf)

  // Session whoami
  .get("/api/session/whoami", async ({ env, cookie, status }) => {
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
    return {
      telegramId,
      isAdmin,
      firstName: user.first_name,
      username: user.username,
    };
  })

  // Logout
  .post("/api/session/logout", ({ cookie }) => {
    cookie[SESSION_COOKIE_NAME].remove();
    return { ok: true };
  })

  // Public bot info
  .get("/api/public/bot-info", async ({ env }) => {
    const botInfo = await getBotInfo(env);
    return { botUsername: botInfo.username };
  })

  // TG Login callback
  .get(
    "/api/login/callback",
    async ({ env, query, cookie, redirect, status }) => {
      const {
        id,
        first_name,
        last_name,
        username,
        photo_url,
        auth_date,
        hash,
        return_to,
      } = query;
      const returnTo = return_to || "/";

      if (!id || !first_name || !auth_date || !hash) {
        return status(400, "Missing Telegram auth data");
      }

      const loginData: TelegramLoginData = { id, first_name, auth_date, hash };
      if (last_name) loginData.last_name = last_name;
      if (username) loginData.username = username;
      if (photo_url) loginData.photo_url = photo_url;

      const valid = await verifyTelegramLogin(
        env.TELEGRAM_BOT_TOKEN,
        loginData,
      );
      if (!valid) return status(403, "Invalid Telegram auth data");

      const isAdmin = id === env.ADMIN_TELEGRAM_ID;
      await upsertUser(
        env.DB,
        id,
        first_name,
        last_name,
        username,
        photo_url,
        isAdmin ? 1 : undefined,
      );

      // 非管理员要 approved
      if (!isAdmin) {
        const user = await getUserByTelegramId(env.DB, id);
        if (!user?.approved) {
          return redirect(`/login?denied=1&uid=${encodeURIComponent(id)}`);
        }
      }

      const session = await generateSessionCookie(env.ADMIN_SECRET, id);
      cookie[SESSION_COOKIE_NAME].set({
        value: session.value,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: session.maxAge,
      });

      return redirect(returnTo);
    },
    { query: LoginCallbackQuery },
  );
