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
  type Reminder,
  updatePendingReminder,
} from "@db/reminders";
import { requireMiniAppAuth } from "@handlers/hono/middleware";
import {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_SEARCH,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@handlers/hono/routes";
import { getEmailProvider, PROVIDERS } from "@providers";
import { getMailList, isMailListType, searchMail } from "@services/mail-list";
import {
  markAllAsRead,
  refreshEmailKeyboardAfterReminderChange,
  trashAllJunkEmails,
} from "@services/message-actions";
import {
  REMINDER_PER_USER_LIMIT,
  REMINDER_TEXT_MAX,
} from "@services/reminders";
import { generateMailTokenById, verifyMailTokenById } from "@utils/mail-token";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "@/types";

const miniapp = new Hono<AppEnv>();

/**
 * 校验 (accountId, emailMessageId, token) 三元组：token 是 mail-preview 用的 HMAC，
 * 等价于"持有该邮件的查看权"。返回查到的 account；否则返回错误响应。
 */
async function resolveEmailContext(
  c: Context<AppEnv>,
  accountIdRaw: unknown,
  emailMessageId: unknown,
  token: unknown,
): Promise<
  | {
      ok: true;
      account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>;
      accountId: number;
      emailMessageId: string;
    }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return { ok: false, status: 400, error: "Invalid accountId" };
  if (typeof emailMessageId !== "string" || !emailMessageId)
    return { ok: false, status: 400, error: "Invalid emailMessageId" };
  if (typeof token !== "string" || !token)
    return { ok: false, status: 400, error: "Invalid token" };

  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    emailMessageId,
    accountId,
    token,
  );
  if (!valid) return { ok: false, status: 403, error: "Forbidden" };

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return { ok: false, status: 404, error: "账号不存在" };
  return { ok: true, account, accountId, emailMessageId };
}

/** LLM 投递时抽取并存到 message_map.reminder_metadata 的 JSON 形状（与前端共享）。
 *  和 worker/services/llm.ts 的 ReminderMetadata 同义但用 snake_case，因为这就是
 *  存盘格式 + API 返回格式。 */
type StoredReminderMetadata = {
  remind_date: string | null;
  remind_time: string | null;
  timezone: string | null;
  text: string | null;
  confidence: number;
};

/** 安全地把 message_map.reminder_metadata 的 JSON 字符串还原成对象；解析失败 → null。
 *  老邮件 / LLM 抽取失败 / 低置信度 → 字段本身就是 NULL，这里 short-circuit 返回 null。 */
function parseReminderMetadata(
  raw: string | null,
): StoredReminderMetadata | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<StoredReminderMetadata>;
    if (typeof obj.confidence !== "number") return null;
    return {
      remind_date: typeof obj.remind_date === "string" ? obj.remind_date : null,
      remind_time: typeof obj.remind_time === "string" ? obj.remind_time : null,
      timezone: typeof obj.timezone === "string" ? obj.timezone : null,
      text: typeof obj.text === "string" ? obj.text : null,
      confidence: obj.confidence,
    };
  } catch {
    return null;
  }
}

/** 找投递时存的 mapping 和邮件展示文本 + LLM 抽取的提醒元数据。
 *  优先级：mapping.short_summary（LLM 一句话摘要，已在 mapping 查询里返回，零 I/O）
 *  → KV 缓存 subject（preview 打开过才有）→ provider 现拉 subject（兜底）。
 *  reminder_metadata 直接从 mapping 行解析，永远零 I/O。 */
async function lookupEmailContext(
  c: Context<AppEnv>,
  account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>,
  emailMessageId: string,
): Promise<{
  tgChatId: string | null;
  tgMessageId: number | null;
  subject: string | null;
  reminderMetadata: StoredReminderMetadata | null;
}> {
  const mappings = await getMappingsByEmailIds(c.env.DB, account.id, [
    emailMessageId,
  ]);
  const m = mappings[0];
  const reminderMetadata = parseReminderMetadata(m?.reminder_metadata ?? null);

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
    reminderMetadata,
  };
}

type EnrichedReminder = Reminder & {
  mail_token: string | null;
  email_summary: string | null;
};

/** 给 listOnly 模式（主菜单"我的提醒"）的 reminder 列表附加：
 *   - `mail_token`: 基于 (emailMessageId, accountId) 的 HMAC，与键盘里 web 链接用的同一份。
 *     前端点击提醒跳邮件预览页要用，不扩大用户已有的访问权。
 *   - `email_summary`: message_map 里 LLM 一句话摘要的最新值，前端 fallback 到 email_subject。
 *  按 (accountId, emailMessageId) 去重 —— 同一封邮件的多条提醒共享同一份 HMAC + mapping，
 *  避免重复计算。mapping 批量查 + HMAC 计算两路并发。 */
async function enrichReminders(
  c: Context<AppEnv>,
  items: Reminder[],
): Promise<EnrichedReminder[]> {
  const uniq = new Map<string, { accountId: number; emailMessageId: string }>();
  for (const r of items) {
    if (r.account_id && r.email_message_id)
      uniq.set(`${r.account_id}:${r.email_message_id}`, {
        accountId: r.account_id,
        emailMessageId: r.email_message_id,
      });
  }

  const idsByAccount = new Map<number, string[]>();
  for (const { accountId, emailMessageId } of uniq.values()) {
    const arr = idsByAccount.get(accountId);
    if (arr) arr.push(emailMessageId);
    else idsByAccount.set(accountId, [emailMessageId]);
  }

  const tokenByKey = new Map<string, string>();
  const summaryByKey = new Map<string, string>();
  await Promise.all([
    ...Array.from(idsByAccount.entries()).map(async ([accountId, ids]) => {
      const mappings = await getMappingsByEmailIds(c.env.DB, accountId, ids);
      for (const m of mappings) {
        if (m.short_summary)
          summaryByKey.set(
            `${accountId}:${m.email_message_id}`,
            m.short_summary,
          );
      }
    }),
    ...Array.from(uniq.entries()).map(async ([key, v]) => {
      tokenByKey.set(
        key,
        await generateMailTokenById(
          c.env.ADMIN_SECRET,
          v.emailMessageId,
          v.accountId,
        ),
      );
    }),
  ]);

  return items.map((r) => {
    const key =
      r.account_id && r.email_message_id
        ? `${r.account_id}:${r.email_message_id}`
        : null;
    return {
      ...r,
      mail_token: key ? (tokenByKey.get(key) ?? null) : null,
      email_summary: key ? (summaryByKey.get(key) ?? null) : null,
    };
  });
}

// ─── Mini App API ──────────────────────────────────────────────────────────
// 鉴权策略：
//  - 本文件下的所有 API（/api/reminders/*, /api/mini-app/*）走 requireMiniAppAuth
//    中间件，统一在 c.var.userId 里给到鉴权用户（X-Telegram-Init-Data 头签名校验）。
//  - 邮件正文预览 API 是 GET /api/mail/:id，在 `preview.tsx` 里，走 token-only
//    （Web 浏览器里也能调，不需要 initData），不经这里的中间件。
//  - Mini App 页面（/telegram-app/*）本身由前端 SPA（Cloudflare Pages）渲染，
//    不在 Worker 上。方案 A：同域 + Workers Routes 分流 /api/* → Worker。

miniapp.use("/api/reminders/*", requireMiniAppAuth);
miniapp.use(ROUTE_REMINDERS_API, requireMiniAppAuth);
miniapp.use("/api/mini-app/*", requireMiniAppAuth);

// 列表 JSON API：复用 services/mail-list 同一份数据，bot 文本回复也走它。
// 默认每次都拉新数据（保守，bot/refresh 等场景）；?cache=true 时优先 KV（60s TTL，
// Mini App 默认调用带这个 flag，强制刷新按钮去掉）。
miniapp.get(ROUTE_MINI_APP_API_LIST, async (c) => {
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

// 一键已读 / 一键清垃圾：直接复用 services/message-actions 里 bot 也在用的实现，
// 走 requireMiniAppAuth → c.var.userId 已校验。返回 { success, failed } 让客户端
// 自己拼提示文案。
miniapp.post(ROUTE_MINI_APP_API_MARK_ALL_READ, async (c) => {
  const userId = c.get("userId");
  const result = await markAllAsRead(c.env, userId);
  return c.json(result);
});

miniapp.post(ROUTE_MINI_APP_API_TRASH_ALL_JUNK, async (c) => {
  const userId = c.get("userId");
  const result = await trashAllJunkEmails(c.env, userId);
  return c.json(result);
});

// 跨账号邮件搜索 —— 结果形状跟 list API 一样，前端可复用渲染。
// 鉴权由 `/api/mini-app/*` 中间件 (`requireMiniAppAuth`) 完成；只搜当前用户
// 自己 enabled 的账号，所以无需额外授权检查。
miniapp.get(ROUTE_MINI_APP_API_SEARCH, async (c) => {
  const userId = c.get("userId");
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "缺少搜索关键词" }, 400);
  if (q.length > 200) return c.json({ error: "关键词过长" }, 400);

  const result = await searchMail(c.env, userId, q);
  return c.json(result);
});

// 邮件预览 JSON API 已搬到 `preview.tsx`（GET /api/mail/:id），走 token-only
// 鉴权 —— Web 浏览器里的 /mail/:id 页也能直接用，不需要 initData。

// ─── API: 解析群聊 deep link 的 start_param ──────────────────────────────────
// 群聊用 t.me/<bot>?startapp=<chatId>_<tgMsgId> 跳进 Mini App，这里把短 id
// 还原成 (accountId, emailMessageId, token)。鉴权：account.telegram_user_id 必须
// 等于当前 initData 的 user.id —— 即只有账号主人能为自己邮件设提醒，防止
// 群里别的成员拿 deep link 给账号主人塞 reminder。

miniapp.get(ROUTE_REMINDERS_API_RESOLVE_CONTEXT, async (c) => {
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
    emailMessageId: mapping.email_message_id,
    token,
  });
});

// ─── API: 邮件上下文（页面初始化时拉取 subject 显示） ────────────────────────

miniapp.get(ROUTE_REMINDERS_API_EMAIL_CONTEXT, async (c) => {
  // userId 不直接用 —— token 已经够 —— 但 middleware 保证已鉴权
  const ctx = await resolveEmailContext(
    c,
    c.req.query("accountId"),
    c.req.query("emailMessageId"),
    c.req.query("token"),
  );
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);

  const { subject, tgChatId, reminderMetadata } = await lookupEmailContext(
    c,
    ctx.account,
    ctx.emailMessageId,
  );
  return c.json({
    subject,
    accountEmail: ctx.account.email,
    deliveredToChat: tgChatId,
    // 投递时第二次 LLM 调用的产物，前端用来预填提醒表单（机票/酒店/订单等）。
    // null = 未分析 / 无可操作事件 / LLM 未配置；前端静默不预填。
    reminderMetadata,
  });
});

// ─── API: 列表 ────────────────────────────────────────────────────────────────
// 不带参数 → 返回用户所有 pending（list-only 模式 / 主菜单"我的提醒"）
// 带 (accountId, emailMessageId, token) → 仅返回该邮件的 pending（邮件模式：⏰ 按钮）

miniapp.get(ROUTE_REMINDERS_API, async (c) => {
  const userId = c.get("userId");

  const accountIdQ = c.req.query("accountId");
  const emailMessageIdQ = c.req.query("emailMessageId");
  const tokenQ = c.req.query("token");
  if (accountIdQ || emailMessageIdQ || tokenQ) {
    // 任一存在则三件套都得有效
    const ctx = await resolveEmailContext(
      c,
      accountIdQ,
      emailMessageIdQ,
      tokenQ,
    );
    if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
    const items = await listPendingRemindersForEmail(
      c.env.DB,
      userId,
      ctx.accountId,
      ctx.emailMessageId,
    );
    // 邮件模式：前端已有 token + subject，summary/mail_token 用不到，跳过 enrich。
    return c.json({ reminders: items });
  }

  const items = await listPendingReminders(c.env.DB, userId);
  return c.json({ reminders: await enrichReminders(c, items) });
});

// ─── API: 创建（必须带邮件上下文） ───────────────────────────────────────────

miniapp.post(ROUTE_REMINDERS_API, async (c) => {
  const userId = c.get("userId");

  const body = await c.req
    .json<{
      text?: string;
      remind_at?: string;
      accountId?: number;
      emailMessageId?: string;
      token?: string;
    }>()
    .catch(() => null);
  if (!body) return c.json({ ok: false, error: "请求格式错误" }, 400);

  // 邮件上下文校验：三件套必填
  const ctx = await resolveEmailContext(
    c,
    body.accountId,
    body.emailMessageId,
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
    ctx.emailMessageId,
  );

  const id = await createReminder(c.env.DB, {
    telegramUserId: userId,
    text,
    remindAtIso: new Date(ts).toISOString(),
    accountId: ctx.accountId,
    emailMessageId: ctx.emailMessageId,
    emailSubject: subject ?? undefined,
    tgChatId: tgChatId ?? undefined,
    tgMessageId: tgMessageId ?? undefined,
  });
  // 后台刷新邮件 TG 消息的键盘 —— ⏰ 按钮上的 count 立即 +1
  c.executionCtx.waitUntil(
    refreshEmailKeyboardAfterReminderChange(
      c.env,
      ctx.account,
      ctx.emailMessageId,
    ).catch(() => {}),
  );
  return c.json({ ok: true, id });
});

// ─── API: 取单个提醒（编辑页加载用） ─────────────────────────────────────────
// 复用 enrichReminders 给单条加 mail_token + email_summary，让编辑页顶部的邮件
// 卡片可以点击跳邮件预览。

miniapp.get(ROUTE_REMINDERS_API_ITEM, async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: "Invalid id" }, 400);
  const reminder = await getReminderById(c.env.DB, id);
  if (!reminder || reminder.telegram_user_id !== userId)
    return c.json({ error: "未找到提醒" }, 404);
  const [enriched] = await enrichReminders(c, [reminder]);
  return c.json({ reminder: enriched });
});

// ─── API: 编辑（只允许改 text + remind_at；邮件上下文不变） ──────────────────

miniapp.patch(ROUTE_REMINDERS_API_ITEM, async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ ok: false, error: "Invalid id" }, 400);

  const body = await c.req
    .json<{ text?: string; remind_at?: string }>()
    .catch(() => null);
  if (!body) return c.json({ ok: false, error: "请求格式错误" }, 400);

  const text = (body.text ?? "").trim();
  if (text.length > REMINDER_TEXT_MAX)
    return c.json(
      { ok: false, error: `备注超过 ${REMINDER_TEXT_MAX} 字` },
      400,
    );
  const ts = Date.parse((body.remind_at ?? "").trim());
  if (Number.isNaN(ts))
    return c.json({ ok: false, error: "时间格式错误" }, 400);
  if (ts <= Date.now() - 30_000)
    return c.json({ ok: false, error: "提醒时间需在未来" }, 400);

  const ok = await updatePendingReminder(c.env.DB, userId, id, {
    text,
    remindAtIso: new Date(ts).toISOString(),
  });
  if (!ok) return c.json({ ok: false, error: "未找到提醒" }, 404);
  return c.json({ ok: true });
});

// ─── API: 删除 ───────────────────────────────────────────────────────────────

miniapp.delete(ROUTE_REMINDERS_API_ITEM, async (c) => {
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

export default miniapp;
