import { getBotInfo } from "@bot/index";
import { getUserByTelegramId, upsertUser } from "@db/users";
import {
  ROUTE_LOGIN,
  ROUTE_LOGIN_CALLBACK,
  ROUTE_PUBLIC_BOT_INFO,
  ROUTE_SESSION_LOGOUT,
  ROUTE_SESSION_WHOAMI,
} from "@handlers/hono/routes";
import {
  generateSessionCookie,
  type TelegramLoginData,
  verifySessionCookie,
  verifyTelegramLogin,
} from "@utils/session";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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

/**
 * 登出 —— 把 session cookie 清掉（set `Max-Age=0`），web 页 header 下拉
 * 菜单点 "登出" 调这个。没有 session 也无所谓，清一次就完事。
 */
auth.post(ROUTE_SESSION_LOGOUT, async (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

/**
 * 公开接口 —— 登录页 SPA 在挂载时拉 bot username 用来渲染 TG Login Widget。
 * bot username 不是 secret，不需要鉴权。
 */
auth.get(ROUTE_PUBLIC_BOT_INFO, async (c) => {
  const botInfo = await getBotInfo(c.env);
  return c.json({ botUsername: botInfo.username });
});

/**
 * TG Login Widget 的回调 —— 登录页（Pages 的 /login）里 widget 用 GET 带
 * query 跳过来。验签成功 + 已 approved → 下 session cookie，302 回 `returnTo`；
 * 未 approved → 302 到 `/login?denied=1`（Pages SPA 显示拒绝态）；其他错误
 * 用普通 text 兜底（这些都是不该发生的情况，SPA 上看到自然回到登录页重试）。
 */
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
      const denyUrl = `${ROUTE_LOGIN}?denied=1&uid=${encodeURIComponent(id)}`;
      return c.redirect(denyUrl);
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
