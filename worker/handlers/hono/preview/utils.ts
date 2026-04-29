import { getAccountById } from "@db/accounts";
import { verifyMailTokenById } from "@utils/mail-token";
import type { Context } from "hono";
import type { Account, AppEnv } from "@/types";

export type MailActionBody = {
  accountId?: number;
  token?: string;
};

/**
 * (emailMessageId, accountId, token) 三元组校验 —— GET 预览页和 POST 动作
 * 共用的核心逻辑。输入全走 `unknown`，调用方从 body / query / param 拿什么
 * 就塞什么。返回 `Response` 失败不走这里 —— 调用方按自己的错误格式包装。
 */
export async function resolveMailContext(
  env: AppEnv["Bindings"],
  emailMessageId: string | undefined,
  accountIdRaw: unknown,
  tokenRaw: unknown,
): Promise<
  | { ok: true; account: Account; emailMessageId: string; token: string }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  if (!emailMessageId)
    return { ok: false, status: 400, error: "Invalid emailMessageId" };
  const accountId =
    typeof accountIdRaw === "number" ? accountIdRaw : Number(accountIdRaw);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return { ok: false, status: 400, error: "Invalid accountId" };
  if (typeof tokenRaw !== "string" || !tokenRaw)
    return { ok: false, status: 400, error: "Invalid token" };
  const valid = await verifyMailTokenById(
    env.ADMIN_SECRET,
    emailMessageId,
    accountId,
    tokenRaw,
  );
  if (!valid) return { ok: false, status: 403, error: "Forbidden" };
  const account = await getAccountById(env.DB, accountId);
  if (!account) return { ok: false, status: 404, error: "Account not found" };
  return { ok: true, account, emailMessageId, token: tokenRaw };
}

/**
 * 预览页 POST 邮件操作的公共入口：解析 body + 校验 token + 取 account
 * + **校验 account 归属**（必须是当前登录用户的，admin 全过）。
 *
 * 调用方必须先挂 `requireSessionOrMiniApp` middleware（c.var.userId / isAdmin
 * 才会有值）。失败时返回 `Response`（调用方直接 return）。
 */
export async function resolveMailAction<
  B extends MailActionBody = MailActionBody,
>(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; account: Account; emailMessageId: string; body: B }
  | { ok: false; response: Response }
> {
  const body = (await c.req.json()) as B;
  const ctx = await resolveMailContext(
    c.env,
    c.req.param("id"),
    body.accountId,
    body.token,
  );
  if (!ctx.ok) {
    return {
      ok: false,
      response: c.json({ ok: false, error: ctx.error }, ctx.status),
    };
  }

  // token 只证明持有人有看这封邮件的权限，不证明就是账号 owner ——
  // 必须再 check `account.telegram_user_id === current user`，否则别人
  // 拿到链接 + 自己 TG 登录就能替 owner 操作邮件。admin 全过。
  const userId = c.get("userId");
  const isAdmin = c.get("isAdmin");
  if (!isAdmin && ctx.account.telegram_user_id !== userId) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "Forbidden" }, 403),
    };
  }

  return {
    ok: true,
    account: ctx.account,
    emailMessageId: ctx.emailMessageId,
    body,
  };
}
