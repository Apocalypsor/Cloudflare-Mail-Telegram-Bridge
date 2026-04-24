import { getBotInfo } from "@bot/index";
import { LoginDeniedPage, LoginPage } from "@components/web/login";
import { getUserByTelegramId, upsertUser } from "@db/users";
import {
  ROUTE_LOGIN,
  ROUTE_LOGIN_CALLBACK,
  ROUTE_SESSION_WHOAMI,
} from "@handlers/hono/routes";
import {
  generateSessionCookie,
  type TelegramLoginData,
  verifySessionCookie,
  verifyTelegramLogin,
} from "@utils/session";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "@/constants";
import type { AppEnv } from "@/types";

const auth = new Hono<AppEnv>();

/**
 * Session 探测接口 —— 非 Mini App 的 web 页（/preview, /junk-check）在挂载
 * 时调用。跟 `requireTelegramLogin()` 用的是同一套 session cookie + approved
 * 校验，但失败返回 401 JSON（不是 302），让 SPA 自己决定怎么跳 `/login`。
 */
auth.get(ROUTE_SESSION_WHOAMI, async (c) => {
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  if (cookie) {
    const telegramId = await verifySessionCookie(c.env.ADMIN_SECRET, cookie);
    if (telegramId) {
      const user = await getUserByTelegramId(c.env.DB, telegramId);
      const isAdmin = telegramId === c.env.ADMIN_TELEGRAM_ID;
      if (user && (user.approved || isAdmin)) {
        return c.json({
          telegramId,
          isAdmin,
          firstName: user.first_name,
          username: user.username,
        });
      }
    }
  }
  return c.json({ error: "Unauthorized" }, 401);
});

auth.get(ROUTE_LOGIN, async (c) => {
  const returnTo = c.req.query("return_to") || "/";
  const botInfo = await getBotInfo(c.env);
  return c.html(
    <LoginPage botUsername={botInfo.username} returnTo={returnTo} />,
  );
});

auth.get(ROUTE_LOGIN_CALLBACK, async (c) => {
  const { id, first_name, last_name, username, photo_url, auth_date, hash } =
    c.req.query() as Record<string, string>;
  const returnTo = c.req.query("return_to") || "/";

  if (!id || !first_name || !auth_date || !hash) {
    return c.text("Missing Telegram auth data", 400);
  }

  const loginData: TelegramLoginData = { id, first_name, auth_date, hash };
  if (last_name) loginData.last_name = last_name;
  if (username) loginData.username = username;
  if (photo_url) loginData.photo_url = photo_url;

  const valid = await verifyTelegramLogin(c.env.TELEGRAM_BOT_TOKEN, loginData);
  if (!valid) return c.text("Invalid Telegram auth data", 403);

  // Upsert 用户记录，管理员自动 approved
  const isAdmin = id === c.env.ADMIN_TELEGRAM_ID;
  await upsertUser(
    c.env.DB,
    id,
    first_name,
    last_name,
    username,
    photo_url,
    isAdmin ? 1 : undefined,
  );

  // 非管理员需要检查 approved 状态
  if (!isAdmin) {
    const user = await getUserByTelegramId(c.env.DB, id);
    if (!user?.approved) {
      return c.html(<LoginDeniedPage />, 403);
    }
  }

  const session = await generateSessionCookie(c.env.ADMIN_SECRET, id);
  setCookie(c, SESSION_COOKIE_NAME, session.value, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: session.maxAge,
  });

  return c.redirect(returnTo);
});

export default auth;
