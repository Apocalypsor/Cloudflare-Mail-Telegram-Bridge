import { RemindersPage } from "@components/reminders";
import { getAccountById } from "@db/accounts";
import { getCachedMailData, putCachedMailData } from "@db/kv";
import { getMappingsByEmailIds, getMessageMapping } from "@db/message-map";
import {
  countPendingReminders,
  createReminder,
  deletePendingReminder,
  listPendingReminders,
} from "@db/reminders";
import { getUserByTelegramId } from "@db/users";
import {
  ROUTE_MINI_APP,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@handlers/hono/routes";
import { getEmailProvider, PROVIDERS } from "@providers";
import {
  generateMailTokenById,
  verifyMailTokenById,
} from "@services/mail-preview";
import {
  REMINDER_PER_USER_LIMIT,
  REMINDER_TEXT_MAX,
} from "@services/reminders";
import { verifyTgInitData } from "@utils/tg-init-data";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "@/types";

const reminders = new Hono<AppEnv>();

/**
 * 校验 Mini App 调用：从 X-Telegram-Init-Data 头读取 initData，验签后取 user.id；
 * 还需确保该 telegram 用户已被审批（与 requireTelegramLogin 同口径），否则拒绝。
 */
async function authMiniApp(c: Context<AppEnv>): Promise<string | null> {
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

/**
 * 校验 (accountId, messageId, token) 三元组：token 是 mail-preview 用的 HMAC，
 * 等价于"持有该邮件的查看权"。返回查到的 account；否则返回错误响应。
 */
async function resolveEmailContext(
  c: Context<AppEnv>,
  accountIdRaw: unknown,
  messageId: unknown,
  token: unknown,
): Promise<
  | {
      ok: true;
      account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>;
      accountId: number;
      messageId: string;
    }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return { ok: false, status: 400, error: "Invalid accountId" };
  if (typeof messageId !== "string" || !messageId)
    return { ok: false, status: 400, error: "Invalid messageId" };
  if (typeof token !== "string" || !token)
    return { ok: false, status: 400, error: "Invalid token" };

  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    messageId,
    accountId,
    token,
  );
  if (!valid) return { ok: false, status: 403, error: "Forbidden" };

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return { ok: false, status: 404, error: "账号不存在" };
  return { ok: true, account, accountId, messageId };
}

/** 找投递时存的 mapping 和邮件展示文本。
 *  优先级：mapping.short_summary（LLM 一句话摘要，已在 mapping 查询里返回，零 I/O）
 *  → KV 缓存 subject（preview 打开过才有）→ provider 现拉 subject（兜底）。 */
async function lookupEmailContext(
  c: Context<AppEnv>,
  account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>,
  emailMessageId: string,
): Promise<{
  tgChatId: string | null;
  tgMessageId: number | null;
  subject: string | null;
}> {
  const mappings = await getMappingsByEmailIds(c.env.DB, account.id, [
    emailMessageId,
  ]);
  const m = mappings[0];

  // 1) LLM 摘要（已经在 mapping 行里）
  let subject: string | null = m?.short_summary ?? null;

  // 2) 没 LLM 摘要 → 三 folder 查 KV 缓存（preview.tsx 写入）
  if (subject == null) {
    for (const folder of ["inbox", "junk", "archive"] as const) {
      const cached = await getCachedMailData(
        c.env.EMAIL_KV,
        account.id,
        folder,
        emailMessageId,
      );
      if (cached?.meta?.subject) {
        subject = cached.meta.subject;
        break;
      }
    }
  }

  // 3) 还没有 → 现拉一次 fetchForPreview，写回 KV 给下次用。OAuth provider
  //    没授权 / 邮件已删 → 静默回退，UI 兜底 "(无主题)"。
  if (subject == null) {
    const needsAuth = PROVIDERS[account.type].oauth && !account.refresh_token;
    if (!needsAuth) {
      try {
        const provider = getEmailProvider(account, c.env);
        const result = await provider.fetchForPreview(emailMessageId, "inbox");
        if (result?.meta?.subject) {
          subject = result.meta.subject;
          await putCachedMailData(
            c.env.EMAIL_KV,
            account.id,
            "inbox",
            emailMessageId,
            { html: result.html, meta: result.meta },
          ).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    tgChatId: m?.tg_chat_id ?? null,
    tgMessageId: m?.tg_message_id ?? null,
    subject,
  };
}

// ─── Mini App 页面 ──────────────────────────────────────────────────────────
// 鉴权放在 API 层（initData 校验），页面本身可裸开 —— Mini App 必须能在 TG WebView
// 里直接打开，没有 cookie，无法套 requireTelegramLogin。

reminders.get(ROUTE_MINI_APP, (c) => {
  return c.html(<RemindersPage />);
});

// ─── API: 解析群聊 deep link 的 start_param ──────────────────────────────────
// 群聊用 t.me/<bot>?startapp=<chatId>_<tgMsgId> 跳进 Mini App，这里把短 id
// 还原成 (accountId, messageId, token)。鉴权：account.telegram_user_id 必须
// 等于当前 initData 的 user.id —— 即只有账号主人能为自己邮件设提醒，防止
// 群里别的成员拿 deep link 给账号主人塞 reminder。

reminders.get(ROUTE_REMINDERS_API_RESOLVE_CONTEXT, async (c) => {
  const userId = await authMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const start = c.req.query("start") ?? "";
  // 形如 -1001234567890_5678 或 1234567890_5678
  const m = start.match(/^(-?\d+)_(\d+)$/);
  if (!m) return c.json({ error: "Invalid start_param" }, 400);
  const chatId = m[1];
  const tgMessageId = Number(m[2]);

  const mapping = await getMessageMapping(c.env.DB, chatId, tgMessageId);
  if (!mapping) return c.json({ error: "邮件已过期或不存在" }, 404);

  const account = await getAccountById(c.env.DB, mapping.account_id);
  if (!account) return c.json({ error: "账号不存在" }, 404);
  if (account.telegram_user_id !== userId)
    return c.json({ error: "无权为该邮件设提醒" }, 403);

  const token = await generateMailTokenById(
    c.env.ADMIN_SECRET,
    mapping.email_message_id,
    mapping.account_id,
  );
  return c.json({
    accountId: mapping.account_id,
    messageId: mapping.email_message_id,
    token,
  });
});

// ─── API: 邮件上下文（页面初始化时拉取 subject 显示） ────────────────────────

reminders.get(ROUTE_REMINDERS_API_EMAIL_CONTEXT, async (c) => {
  const userId = await authMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const ctx = await resolveEmailContext(
    c,
    c.req.query("accountId"),
    c.req.query("messageId"),
    c.req.query("token"),
  );
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);

  const { subject, tgChatId } = await lookupEmailContext(
    c,
    ctx.account,
    ctx.messageId,
  );
  return c.json({
    subject,
    accountEmail: ctx.account.email,
    deliveredToChat: tgChatId,
  });
});

// ─── API: 列表（用户所有 pending） ───────────────────────────────────────────

reminders.get(ROUTE_REMINDERS_API, async (c) => {
  const userId = await authMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const items = await listPendingReminders(c.env.DB, userId);
  return c.json({ reminders: items });
});

// ─── API: 创建（必须带邮件上下文） ───────────────────────────────────────────

reminders.post(ROUTE_REMINDERS_API, async (c) => {
  const userId = await authMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req
    .json<{
      text?: string;
      remind_at?: string;
      accountId?: number;
      messageId?: string;
      token?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ ok: false, error: "请求格式错误" }, 400);

  // 邮件上下文校验：三件套必填
  const ctx = await resolveEmailContext(
    c,
    body.accountId,
    body.messageId,
    body.token,
  );
  if (!ctx.ok) return c.json({ ok: false, error: ctx.error }, ctx.status);

  const text = (body.text ?? "").trim();
  if (text.length > REMINDER_TEXT_MAX)
    return c.json(
      { ok: false, error: `备注超过 ${REMINDER_TEXT_MAX} 字` },
      400,
    );

  const remindAt = (body.remind_at ?? "").trim();
  const ts = Date.parse(remindAt);
  if (Number.isNaN(ts))
    return c.json({ ok: false, error: "时间格式错误" }, 400);
  // 30 秒宽限：客户端时钟稍偏也允许
  if (ts <= Date.now() - 30_000)
    return c.json({ ok: false, error: "提醒时间需在未来" }, 400);

  const count = await countPendingReminders(c.env.DB, userId);
  if (count >= REMINDER_PER_USER_LIMIT)
    return c.json(
      { ok: false, error: `待提醒数已达上限 ${REMINDER_PER_USER_LIMIT}` },
      400,
    );

  const { tgChatId, tgMessageId, subject } = await lookupEmailContext(
    c,
    ctx.account,
    ctx.messageId,
  );

  const id = await createReminder(c.env.DB, {
    telegramUserId: userId,
    text,
    remindAtIso: new Date(ts).toISOString(),
    accountId: ctx.accountId,
    emailMessageId: ctx.messageId,
    emailSubject: subject ?? undefined,
    tgChatId: tgChatId ?? undefined,
    tgMessageId: tgMessageId ?? undefined,
  });
  return c.json({ ok: true, id });
});

// ─── API: 删除 ───────────────────────────────────────────────────────────────

reminders.delete(ROUTE_REMINDERS_API_ITEM, async (c) => {
  const userId = await authMiniApp(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ ok: false, error: "Invalid id" }, 400);
  const ok = await deletePendingReminder(c.env.DB, userId, id);
  if (!ok) return c.json({ ok: false, error: "未找到提醒" }, 404);
  return c.json({ ok: true });
});

export default reminders;
