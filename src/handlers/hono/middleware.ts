import { getUserByTelegramId } from "@db/users";
import { ROUTE_LOGIN } from "@handlers/hono/routes";
import { timingSafeEqual } from "@utils/hash";
import { verifySessionCookie } from "@utils/session";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "@/constants";
import type { AppEnv } from "@/types";
import { verifyTgInitData } from "@/utils/tg-init-data";

/** 校验 query param 中的共享密钥（用于 GMAIL_PUSH_SECRET） */
export function requireSecret(
  secretKey: "GMAIL_PUSH_SECRET",
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const provided = c.req.query("secret");
    if (!provided || !timingSafeEqual(provided, c.env[secretKey])) {
      return c.text("Forbidden", 403);
    }
    await next();
  };
}

/** 校验 Authorization: Bearer 头（用于 IMAP 中间件） */
export function requireBearer(
  secretKey: "IMAP_BRIDGE_SECRET",
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = c.env[secretKey];
    if (!provided || !expected || !timingSafeEqual(provided, expected)) {
      return c.text("Unauthorized", 401);
    }
    await next();
  };
}

/** Telegram Login 会话保护：未登录则跳转登录页 */
export function requireTelegramLogin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE_NAME);
    if (cookie) {
      const telegramId = await verifySessionCookie(c.env.ADMIN_SECRET, cookie);
      if (telegramId) {
        const user = await getUserByTelegramId(c.env.DB, telegramId);
        if (user && (user.approved || telegramId === c.env.ADMIN_TELEGRAM_ID)) {
          c.set("userId", telegramId);
          c.set("isAdmin", telegramId === c.env.ADMIN_TELEGRAM_ID);
          await next();
          return;
        }
      }
    }
    const returnTo = new URL(c.req.url).pathname + new URL(c.req.url).search;
    const loginUrl = `${ROUTE_LOGIN}?return_to=${encodeURIComponent(returnTo)}`;
    return c.redirect(loginUrl);
  };
}

/** 校验 Mini App 调用：X-Telegram-Init-Data 头验签 + users.approved 检查。
 *  通过则把 telegram_user_id 放进 c.var.userId（同 requireTelegramLogin 接口）。 */
export async function authenticateMiniApp(
  c: Context<AppEnv>,
): Promise<string | null> {
  const initData = c.req.header("x-telegram-init-data");
  if (!initData) return null;
  const tgUser = await verifyTgInitData(c.env.TELEGRAM_BOT_TOKEN, initData);
  if (!tgUser) return null;
  const telegramId = String(tgUser.id);
  if (telegramId === c.env.ADMIN_TELEGRAM_ID) return telegramId;
  const dbUser = await getUserByTelegramId(c.env.DB, telegramId);
  if (!dbUser || dbUser.approved !== 1) return null;
  return telegramId;
}

/** 中间件：所有 Mini App API 路由共享。auth 失败返回 401；通过则把 userId
 *  写到 c.var.userId，handler 用 `c.get("userId")` 取（非 null）。 */
export async function requireMiniAppAuth(
  c: Context<AppEnv>,
  next: () => Promise<void>,
) {
  const userId = await authenticateMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  c.set("isAdmin", userId === c.env.ADMIN_TELEGRAM_ID);
  await next();
}
