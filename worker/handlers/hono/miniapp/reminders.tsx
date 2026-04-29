import { getAccountById } from "@db/accounts";
import { getMessageMapping } from "@db/message-map";
import {
  countPendingReminders,
  createReminder,
  deletePendingReminder,
  getReminderById,
  listPendingReminders,
  listPendingRemindersForEmail,
  updatePendingReminder,
} from "@db/reminders";
import {
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@handlers/hono/routes";
import { refreshEmailKeyboardAfterReminderChange } from "@services/message-actions";
import {
  REMINDER_PER_USER_LIMIT,
  REMINDER_TEXT_MAX,
} from "@services/reminders";
import { generateMailTokenById } from "@utils/mail-token";
import type { Hono } from "hono";
import type { AppEnv } from "@/types";
import {
  enrichReminders,
  lookupEmailContext,
  resolveEmailContext,
} from "./utils";

/** 注册 reminders API 路由：解析群聊 deep link / 查邮件上下文 / CRUD。
 *  鉴权由父级 `requireMiniAppAuth` 中间件统一处理。 */
export function registerReminderRoutes(app: Hono<AppEnv>): void {
  // ─── API: 解析群聊 deep link 的 start_param ──────────────────────────────────
  // 群聊用 t.me/<bot>?startapp=<chatId>_<tgMsgId> 跳进 Mini App，这里把短 id
  // 还原成 (accountId, emailMessageId, token)。鉴权：account.telegram_user_id 必须
  // 等于当前 initData 的 user.id —— 即只有账号主人能为自己邮件设提醒，防止
  // 群里别的成员拿 deep link 给账号主人塞 reminder。
  app.get(ROUTE_REMINDERS_API_RESOLVE_CONTEXT, async (c) => {
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
  app.get(ROUTE_REMINDERS_API_EMAIL_CONTEXT, async (c) => {
    // userId 不直接用 —— token 已经够 —— 但 middleware 保证已鉴权
    const ctx = await resolveEmailContext(
      c,
      c.req.query("accountId"),
      c.req.query("emailMessageId"),
      c.req.query("token"),
    );
    if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);

    const { subject, tgChatId } = await lookupEmailContext(
      c,
      ctx.account,
      ctx.emailMessageId,
    );
    return c.json({
      subject,
      accountEmail: ctx.account.email,
      deliveredToChat: tgChatId,
    });
  });

  // ─── API: 列表 ────────────────────────────────────────────────────────────────
  // 不带参数 → 返回用户所有 pending（list-only 模式 / 主菜单"我的提醒"）
  // 带 (accountId, emailMessageId, token) → 仅返回该邮件的 pending（邮件模式：⏰ 按钮）
  app.get(ROUTE_REMINDERS_API, async (c) => {
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
  app.post(ROUTE_REMINDERS_API, async (c) => {
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
  app.get(ROUTE_REMINDERS_API_ITEM, async (c) => {
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
  app.patch(ROUTE_REMINDERS_API_ITEM, async (c) => {
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
  app.delete(ROUTE_REMINDERS_API_ITEM, async (c) => {
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
}
