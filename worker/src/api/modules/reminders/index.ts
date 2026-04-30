import {
  enrichReminders,
  lookupEmailContext,
  resolveEmailContext,
} from "@worker/api/modules/miniapp/utils";
import { authMiniApp } from "@worker/api/plugins/auth-miniapp";
import { cf } from "@worker/api/plugins/cf";
import { REMINDER_PER_USER_LIMIT, REMINDER_TEXT_MAX } from "@worker/constants";
import { getAccountById } from "@worker/db/accounts";
import { getMessageMapping } from "@worker/db/message-map";
import {
  countPendingReminders,
  createReminder,
  deletePendingReminder,
  getReminderById,
  listPendingReminders,
  listPendingRemindersForEmail,
  updatePendingReminder,
} from "@worker/db/reminders";
import { generateMailTokenById } from "@worker/utils/mail-token";
import { refreshEmailKeyboardAfterReminderChange } from "@worker/utils/message-actions";
import { Elysia } from "elysia";
import {
  CreateBody,
  EmailContextQuery,
  ListQuery,
  ReminderId,
  ResolveContextQuery,
  UpdateBody,
} from "./model";

/** Reminders CRUD + email-context + resolve-context（群聊 deep link）。 */
export const remindersController = new Elysia({
  name: "controller.reminders",
})
  .use(cf)
  .use(authMiniApp)

  // 群聊 deep link 解析：start_param → (accountId, emailMessageId, token)
  .get(
    "/api/reminders/resolve-context",
    async ({ env, userId, query, status }) => {
      const start = query.start ?? "";
      const m = start.match(/^(-?\d+)_(\d+)$/);
      if (!m) return status(400, { error: "Invalid start_param" });
      const chatId = m[1];
      const tgMessageId = Number(m[2]);

      const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
      if (!mapping) return status(404, { error: "邮件已过期或不存在" });

      const account = await getAccountById(env.DB, mapping.account_id);
      if (!account) return status(404, { error: "账号不存在" });
      if (account.telegram_user_id !== userId)
        return status(403, { error: "无权为该邮件设提醒" });

      const token = await generateMailTokenById(
        env.ADMIN_SECRET,
        mapping.email_message_id,
        mapping.account_id,
      );
      return {
        accountId: mapping.account_id,
        emailMessageId: mapping.email_message_id,
        token,
      };
    },
    { query: ResolveContextQuery },
  )

  // 邮件上下文（页面初始化时拉 subject 显示）
  .get(
    "/api/reminders/email-context",
    async ({ env, query, status }) => {
      const ctx = await resolveEmailContext(
        env,
        query.accountId,
        query.emailMessageId,
        query.token,
      );
      if (!ctx.ok) return status(ctx.status, { error: ctx.error });

      const { subject, tgChatId } = await lookupEmailContext(
        env,
        ctx.account,
        ctx.emailMessageId,
      );
      return {
        subject,
        accountEmail: ctx.account.email,
        deliveredToChat: tgChatId,
      };
    },
    { query: EmailContextQuery },
  )

  // List：无 query 返回 user 的所有 pending；带三件套则返回该邮件的 pending
  .get(
    "/api/reminders",
    async ({ env, userId, query, status }) => {
      const { accountId, emailMessageId, token } = query;
      if (accountId || emailMessageId || token) {
        const ctx = await resolveEmailContext(
          env,
          accountId,
          emailMessageId,
          token,
        );
        if (!ctx.ok) return status(ctx.status, { error: ctx.error });
        const items = await listPendingRemindersForEmail(
          env.DB,
          userId,
          ctx.accountId,
          ctx.emailMessageId,
        );
        return { reminders: items };
      }
      const items = await listPendingReminders(env.DB, userId);
      return { reminders: await enrichReminders(env, items) };
    },
    { query: ListQuery },
  )

  // Create
  .post(
    "/api/reminders",
    async ({ env, executionCtx, userId, body, status }) => {
      const ctx = await resolveEmailContext(
        env,
        body.accountId,
        body.emailMessageId,
        body.token,
      );
      if (!ctx.ok) return status(ctx.status, { ok: false, error: ctx.error });

      const text = (body.text ?? "").trim();
      if (text.length > REMINDER_TEXT_MAX)
        return status(400, {
          ok: false,
          error: `备注超过 ${REMINDER_TEXT_MAX} 字`,
        });

      const remindAt = (body.remind_at ?? "").trim();
      const ts = Date.parse(remindAt);
      if (Number.isNaN(ts))
        return status(400, { ok: false, error: "时间格式错误" });
      // 30s 宽限：客户端时钟偏移
      if (ts <= Date.now() - 30_000)
        return status(400, { ok: false, error: "提醒时间需在未来" });

      const count = await countPendingReminders(env.DB, userId);
      if (count >= REMINDER_PER_USER_LIMIT)
        return status(400, {
          ok: false,
          error: `待提醒数已达上限 ${REMINDER_PER_USER_LIMIT}`,
        });

      const { tgChatId, tgMessageId, subject } = await lookupEmailContext(
        env,
        ctx.account,
        ctx.emailMessageId,
      );

      const id = await createReminder(env.DB, {
        telegramUserId: userId,
        text,
        remindAtIso: new Date(ts).toISOString(),
        accountId: ctx.accountId,
        emailMessageId: ctx.emailMessageId,
        emailSubject: subject ?? undefined,
        tgChatId: tgChatId ?? undefined,
        tgMessageId: tgMessageId ?? undefined,
      });

      executionCtx.waitUntil(
        refreshEmailKeyboardAfterReminderChange(
          env,
          ctx.account,
          ctx.emailMessageId,
        ).catch(() => {}),
      );
      return { ok: true, id };
    },
    { body: CreateBody },
  )

  // Get single（编辑页加载用，附带 mail_token + email_summary）
  .get(
    "/api/reminders/:id",
    async ({ env, userId, params, status }) => {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0)
        return status(400, { error: "Invalid id" });
      const reminder = await getReminderById(env.DB, id);
      if (!reminder || reminder.telegram_user_id !== userId)
        return status(404, { error: "未找到提醒" });
      const [enriched] = await enrichReminders(env, [reminder]);
      return { reminder: enriched };
    },
    { params: ReminderId },
  )

  // Update
  .patch(
    "/api/reminders/:id",
    async ({ env, userId, params, body, status }) => {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0)
        return status(400, { ok: false, error: "Invalid id" });

      const text = (body.text ?? "").trim();
      if (text.length > REMINDER_TEXT_MAX)
        return status(400, {
          ok: false,
          error: `备注超过 ${REMINDER_TEXT_MAX} 字`,
        });
      const ts = Date.parse((body.remind_at ?? "").trim());
      if (Number.isNaN(ts))
        return status(400, { ok: false, error: "时间格式错误" });
      if (ts <= Date.now() - 30_000)
        return status(400, { ok: false, error: "提醒时间需在未来" });

      const ok = await updatePendingReminder(env.DB, userId, id, {
        text,
        remindAtIso: new Date(ts).toISOString(),
      });
      if (!ok) return status(404, { ok: false, error: "未找到提醒" });
      return { ok: true };
    },
    { params: ReminderId, body: UpdateBody },
  )

  // Delete
  .delete(
    "/api/reminders/:id",
    async ({ env, executionCtx, userId, params, status }) => {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0)
        return status(400, { ok: false, error: "Invalid id" });

      const reminder = await getReminderById(env.DB, id);
      if (!reminder || reminder.telegram_user_id !== userId)
        return status(404, { ok: false, error: "未找到提醒" });

      const ok = await deletePendingReminder(env.DB, userId, id);
      if (!ok) return status(404, { ok: false, error: "未找到提醒" });

      if (reminder.account_id != null && reminder.email_message_id != null) {
        const accountId = reminder.account_id;
        const emailMessageId = reminder.email_message_id;
        executionCtx.waitUntil(
          (async () => {
            const account = await getAccountById(env.DB, accountId);
            if (account) {
              await refreshEmailKeyboardAfterReminderChange(
                env,
                account,
                emailMessageId,
              ).catch(() => {});
            }
          })(),
        );
      }
      return { ok: true };
    },
    { params: ReminderId },
  );
