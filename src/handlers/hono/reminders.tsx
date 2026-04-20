import { MiniAppMailListPage } from "@components/miniapp/mail-list";
import { MiniAppMailPage } from "@components/miniapp/mail-page";
import { RemindersPage } from "@components/miniapp/reminders";
import { MiniAppRouterPage } from "@components/miniapp/router";
import { getAccountById } from "@db/accounts";
import {
  getCachedMailData,
  getCachedMailList,
  putCachedMailData,
  putCachedMailList,
} from "@db/kv";
import { getMappingsByEmailIds, getMessageMapping } from "@db/message-map";
import {
  countPendingReminders,
  createReminder,
  deletePendingReminder,
  getReminderById,
  listPendingReminders,
  listPendingRemindersForEmail,
} from "@db/reminders";
import { requireMiniAppAuth } from "@handlers/hono/middleware";
import {
  ROUTE_MINI_APP,
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_LIST,
  ROUTE_MINI_APP_MAIL,
  ROUTE_MINI_APP_REMINDERS,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@handlers/hono/routes";
import { accountCanArchive, getEmailProvider, PROVIDERS } from "@providers";
import { getMailList, isMailListType } from "@services/mail-list";
import {
  buildWebMailUrl,
  generateMailTokenById,
  loadMailForPreview,
  verifyMailTokenById,
} from "@services/mail-preview";
import { refreshEmailKeyboardAfterReminderChange } from "@services/message-actions";
import {
  REMINDER_PER_USER_LIMIT,
  REMINDER_TEXT_MAX,
} from "@services/reminders";
import { buildTgMessageLink } from "@services/telegram";
import type { Context } from "hono";
import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "@/types";

const reminders = new Hono<AppEnv>();

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
// 鉴权策略：
//  - 页面路由（/telegram-app/*）裸开，因为 Mini App 在 TG WebView 里没 cookie，
//    无法套 requireTelegramLogin。Mail 页内部走 token 校验；其它页 JS 调 API
//    时再校验。
//  - 所有 API（/api/reminders/*, /api/mini-app/*）走 requireMiniAppAuth 中间
//    件，统一在 c.var.userId 里给到鉴权用户。
//
// /telegram-app          → 路由页（仅群聊 deep link 会落到这里）
// /telegram-app/reminders → 提醒设置（私聊 web_app 直接来；群聊 r_ 经路由跳来）
// /telegram-app/mail/:id  → 邮件预览（私聊 web_app 直接来；群聊 m_ 经路由跳来）

reminders.use("/api/reminders/*", requireMiniAppAuth);
reminders.use(ROUTE_REMINDERS_API, requireMiniAppAuth);
reminders.use("/api/mini-app/*", requireMiniAppAuth);

reminders.get(ROUTE_MINI_APP, (c) => c.html(<MiniAppRouterPage />));

reminders.get(ROUTE_MINI_APP_REMINDERS, (c) => c.html(<RemindersPage />));

reminders.get(ROUTE_MINI_APP_LIST, (c) => {
  const type = c.req.param("type");
  if (!isMailListType(type)) return c.text("Unknown list type", 404);
  return c.html(<MiniAppMailListPage type={type} />);
});

// 列表 JSON API：复用 services/mail-list 同一份数据，bot 文本回复也走它。
// 默认每次都拉新数据（保守，bot/refresh 等场景）；?cache=true 时优先 KV（60s TTL，
// Mini App 默认调用带这个 flag，强制刷新按钮去掉）。
reminders.get(ROUTE_MINI_APP_API_LIST, async (c) => {
  const userId = c.get("userId");
  const type = c.req.param("type");
  if (!isMailListType(type)) return c.json({ error: "Unknown list type" }, 400);

  const useCache = c.req.query("cache") === "true";
  if (useCache) {
    const cached = await getCachedMailList(c.env.EMAIL_KV, userId, type);
    if (cached)
      return c.body(cached, 200, { "content-type": "application/json" });
  }

  const result = await getMailList(c.env, userId, type);
  // 副作用（starred 同步键盘 / junk 清 mapping）后台跑，不阻塞响应
  if (result.pendingSideEffects.length > 0) {
    c.executionCtx.waitUntil(
      Promise.allSettled(result.pendingSideEffects.map((t) => t())),
    );
  }
  const json = JSON.stringify({
    type: result.type,
    results: result.results,
    total: result.total,
  });
  // 总是写 KV：哪怕这次是强制刷新，也让下一次 cache=true 拿到新鲜的
  c.executionCtx.waitUntil(
    putCachedMailList(c.env.EMAIL_KV, userId, type, json).catch(() => {}),
  );
  return c.body(json, 200, { "content-type": "application/json" });
});

reminders.get(ROUTE_MINI_APP_MAIL, async (c) => {
  // Token 鉴权（与 /mail/:id 同一套），渲染换 MiniAppMailPage（TG 主题色 + SDK）
  const messageId = c.req.param("id");
  const token = c.req.query("t");
  const accountIdParam = c.req.query("accountId");
  if (!messageId || !token || !accountIdParam)
    return c.text("Missing params", 400);
  const accountId = Number(accountIdParam);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return c.text("Invalid accountId", 400);
  if (
    !(await verifyMailTokenById(
      c.env.ADMIN_SECRET,
      messageId,
      accountId,
      token,
    ))
  )
    return c.text("Forbidden", 403);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  const result = await loadMailForPreview(
    c.env,
    account,
    messageId,
    c.req.query("folder"),
  );
  if (!result.ok) return c.text(result.reason, result.status);

  // Mini app 专属：浏览器打开按钮 + TG 原消息跳转链接
  const webMailUrl = c.env.WORKER_URL
    ? buildWebMailUrl(
        c.env.WORKER_URL,
        messageId,
        account.id,
        token,
        result.fetchFolder !== "inbox" ? result.fetchFolder : undefined,
      )
    : "";
  const mailMappings = await getMappingsByEmailIds(c.env.DB, account.id, [
    messageId,
  ]);
  const mapping = mailMappings[0];
  const tgMessageLink = mapping
    ? buildTgMessageLink(mapping.tg_chat_id, mapping.tg_message_id)
    : undefined;

  return c.html(
    <MiniAppMailPage
      meta={result.meta}
      messageId={messageId}
      accountId={account.id}
      token={token}
      inJunk={result.inJunk}
      inArchive={result.fetchFolder === "archive"}
      starred={result.starred}
      canArchive={accountCanArchive(account)}
      accountEmail={account.email}
      webMailUrl={webMailUrl}
      tgMessageLink={tgMessageLink}
    >
      {raw(result.proxiedHtml)}
    </MiniAppMailPage>,
  );
});

// ─── API: 解析群聊 deep link 的 start_param ──────────────────────────────────
// 群聊用 t.me/<bot>?startapp=<chatId>_<tgMsgId> 跳进 Mini App，这里把短 id
// 还原成 (accountId, messageId, token)。鉴权：account.telegram_user_id 必须
// 等于当前 initData 的 user.id —— 即只有账号主人能为自己邮件设提醒，防止
// 群里别的成员拿 deep link 给账号主人塞 reminder。

reminders.get(ROUTE_REMINDERS_API_RESOLVE_CONTEXT, async (c) => {
  const userId = c.get("userId");

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
  // userId 不直接用 —— token 已经够 —— 但 middleware 保证已鉴权
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

// ─── API: 列表 ────────────────────────────────────────────────────────────────
// 不带参数 → 返回用户所有 pending（list-only 模式 / 主菜单"我的提醒"）
// 带 (accountId, messageId, token) → 仅返回该邮件的 pending（邮件模式：⏰ 按钮）

reminders.get(ROUTE_REMINDERS_API, async (c) => {
  const userId = c.get("userId");

  const accountIdQ = c.req.query("accountId");
  const messageIdQ = c.req.query("messageId");
  const tokenQ = c.req.query("token");
  if (accountIdQ || messageIdQ || tokenQ) {
    // 任一存在则三件套都得有效
    const ctx = await resolveEmailContext(c, accountIdQ, messageIdQ, tokenQ);
    if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
    const items = await listPendingRemindersForEmail(
      c.env.DB,
      userId,
      ctx.accountId,
      ctx.messageId,
    );
    return c.json({ reminders: items });
  }

  const items = await listPendingReminders(c.env.DB, userId);
  return c.json({ reminders: items });
});

// ─── API: 创建（必须带邮件上下文） ───────────────────────────────────────────

reminders.post(ROUTE_REMINDERS_API, async (c) => {
  const userId = c.get("userId");

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
  // 后台刷新邮件 TG 消息的键盘 —— ⏰ 按钮上的 count 立即 +1
  c.executionCtx.waitUntil(
    refreshEmailKeyboardAfterReminderChange(
      c.env,
      ctx.account,
      ctx.messageId,
    ).catch(() => {}),
  );
  return c.json({ ok: true, id });
});

// ─── API: 删除 ───────────────────────────────────────────────────────────────

reminders.delete(ROUTE_REMINDERS_API_ITEM, async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ ok: false, error: "Invalid id" }, 400);

  // 删除前先读出 account_id + email_message_id，删除后用来刷键盘
  const reminder = await getReminderById(c.env.DB, id);
  if (!reminder || reminder.telegram_user_id !== userId)
    return c.json({ ok: false, error: "未找到提醒" }, 404);

  const ok = await deletePendingReminder(c.env.DB, userId, id);
  if (!ok) return c.json({ ok: false, error: "未找到提醒" }, 404);

  if (reminder.account_id != null && reminder.email_message_id != null) {
    const accountId = reminder.account_id;
    const emailMessageId = reminder.email_message_id;
    c.executionCtx.waitUntil(
      (async () => {
        const account = await getAccountById(c.env.DB, accountId);
        if (account) {
          await refreshEmailKeyboardAfterReminderChange(
            c.env,
            account,
            emailMessageId,
          ).catch(() => {});
        }
      })(),
    );
  }
  return c.json({ ok: true });
});

export default reminders;
