import { authAny } from "@worker/api/plugins/auth-any";
import { cf } from "@worker/api/plugins/cf";
import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { LLMClient } from "@worker/clients/llm";
import { TelegramClient } from "@worker/clients/telegram";
import { getMappingsByEmailIds } from "@worker/db/message-map";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import { buildWebMailUrl } from "@worker/utils/mail/token";
import { deliverEmailToTelegram } from "@worker/utils/mail-delivery/deliver";
import { refreshEmail } from "@worker/utils/mail-delivery/retry";
import {
  archiveEmailAndCleanup,
  markEmailAsJunkAndCleanup,
  markEmailAsRead,
  syncStarPinState,
  trashEmailAndCleanup,
} from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import { getWorkerBaseUrl } from "@worker/utils/url";
import { Elysia } from "elysia";
import {
  MailActionBody,
  MailAttachmentQuery,
  MailGetQuery,
  MailParams,
  MailToggleStarBody,
} from "./model";
import { MailService } from "./service";
import { contentDisposition, schedulePreviewTelegramCleanup } from "./utils";

/**
 * Mail preview API + 6 mutations:
 *  - GET    /api/mail/:id              token-only auth → preview JSON
 *  - POST   /api/mail/:id/move-to-inbox | trash | mark-as-junk | archive | unarchive | toggle-star
 *           三件套 (accountId/token) + session OR mini-app auth → 校验 owner → 执行
 *  - POST   /api/mail/:id/refresh      同样鉴权 → 重新跑 LLM 分析并编辑 TG 消息
 *
 * 鉴权拆两路：
 *  - GET 走 token only（持有 token = 有权看，不要求登录）
 *  - POST 都走 authAny（要求登录），再叠 token 三件套校验邮件归属
 */

// ─── GET preview (token-only) ──────────────────────────────────────────────
const mailGet = new Elysia({ name: "controller.mail.get" }).use(cf).get(
  "/api/mail/:id",
  async ({ env, executionCtx, params, query, status }) => {
    const ctx = await MailService.resolveContext(
      env,
      query.accountId,
      params.id,
      query.t,
    );
    if (!ctx.ok) return status(ctx.status, { error: ctx.error });
    const { account, emailMessageId, token } = ctx;

    const result = await MailService.loadForRendering(
      env,
      account,
      emailMessageId,
      query.folder,
    );
    if (!result.ok) {
      if (result.location && result.location !== "inbox") {
        schedulePreviewTelegramCleanup(
          executionCtx,
          env,
          account.id,
          emailMessageId,
        );
      }
      return status(result.status, { error: result.reason });
    }

    executionCtx.waitUntil(
      markEmailAsRead(env, account, emailMessageId, result.fetchFolder),
    );

    const webMailUrl = buildWebMailUrl(
      getWorkerBaseUrl(env),
      emailMessageId,
      account.id,
      token,
      result.fetchFolder !== "inbox" ? result.fetchFolder : undefined,
    );
    const mailMappings = await getMappingsByEmailIds(env.DB, account.id, [
      emailMessageId,
    ]);
    const mapping = mailMappings[0];
    if (result.location !== "inbox") {
      schedulePreviewTelegramCleanup(
        executionCtx,
        env,
        account.id,
        emailMessageId,
      );
    }
    const tgMessageLink =
      mapping && result.location === "inbox"
        ? TelegramClient.buildMessageLink(
            mapping.tg_chat_id,
            mapping.tg_message_id,
            mapping.tg_thread_id,
          )
        : null;

    return {
      meta: result.meta,
      accountEmail: account.email,
      bodyHtml: result.proxiedHtml,
      bodyHtmlRaw: result.rawHtml,
      attachments: result.attachments,
      folder: result.fetchFolder,
      inJunk: result.inJunk,
      inArchive: result.location === "archive",
      starred: result.starred,
      canArchive: accountCanArchive(account),
      webMailUrl,
      tgMessageLink,
    };
  },
  { params: MailParams, query: MailGetQuery },
);

const mailAttachmentGet = new Elysia({
  name: "controller.mail.attachment.get",
})
  .use(cf)
  .get(
    "/api/mail/:id/attachment",
    async ({ env, params, query, status }) => {
      const ctx = await MailService.resolveContext(
        env,
        query.accountId,
        params.id,
        query.t,
      );
      if (!ctx.ok) return status(ctx.status, { error: ctx.error });

      const provider = getEmailProvider(ctx.account, env);
      const attachment = await provider.fetchAttachment(
        ctx.emailMessageId,
        query.attachmentId,
        query.folder ?? "inbox",
      );
      if (!attachment) return status(404, { error: "Attachment not found" });

      const mime = attachment.mimeType || "application/octet-stream";
      return new Response(attachment.body, {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": contentDisposition(attachment.filename),
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    { params: MailParams, query: MailAttachmentQuery },
  );

// ─── POST mutations (session OR mini-app auth + token check) ──────────────
const mailMutations = new Elysia({ name: "controller.mail.mutations" })
  .use(cf)
  .use(authAny)
  // 共用的 owner check + context resolve macro: 把 body.{accountId, token}
  // 配合 :id 拼出 (account, emailMessageId)，并校验 account 归当前 user。
  .resolve(
    { as: "scoped" },
    async ({ env, params, body, userId, isAdmin, status }) => {
      const id = (params as { id: string }).id;
      const { accountId, token } = body as MailActionBody;
      const ctx = await MailService.resolveContext(env, accountId, id, token);
      if (!ctx.ok) return status(ctx.status, { ok: false, error: ctx.error });
      if (!isAdmin && ctx.account.telegram_user_id !== userId) {
        return status(403, { ok: false, error: "Forbidden" });
      }
      return { account: ctx.account, emailMessageId: ctx.emailMessageId };
    },
  )

  .post(
    "/api/mail/:id/refresh",
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      try {
        if (!LLMClient.isConfigured(env)) {
          return status(400, { ok: false, error: "LLM 未配置" });
        }

        const mailMappings = await getMappingsByEmailIds(env.DB, account.id, [
          emailMessageId,
        ]);
        const mapping = mailMappings[0];
        if (!mapping) {
          return status(404, {
            ok: false,
            error: "Telegram message mapping not found",
          });
        }

        executionCtx.waitUntil(
          (async () => {
            const result = await refreshEmail(
              env,
              mapping.tg_chat_id,
              mapping.tg_message_id,
            );
            if (!result.ok) {
              await reportErrorToObservability(
                env,
                "preview.refresh_failed",
                new Error(result.reason),
                { accountId: account.id },
              );
            }
          })().catch((err) =>
            reportErrorToObservability(env, "preview.refresh_failed", err, {
              accountId: account.id,
            }),
          ),
        );

        return {
          ok: true,
          message: "已开始后台刷新",
        };
      } catch (err) {
        await reportErrorToObservability(env, "preview.refresh_failed", err, {
          accountId: account.id,
        });
        return status(500, { ok: false, error: "刷新失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/move-to-inbox",
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      try {
        const provider = getEmailProvider(account, env);
        // IMAP/Outlook move 之后原 id 失效；先抓 raw 再 move 拿新 id
        const raw = await provider.fetchRawEmail(emailMessageId, "junk");
        const newEmailMessageId = await provider.moveToInbox(emailMessageId);
        const waitUntil = executionCtx.waitUntil.bind(executionCtx);
        executionCtx.waitUntil(
          deliverEmailToTelegram(
            raw,
            newEmailMessageId,
            account,
            env,
            waitUntil,
          ).catch((err) =>
            reportErrorToObservability(
              env,
              "preview.redeliver_after_move_failed",
              err,
              { accountId: account.id },
            ),
          ),
        );
        return { ok: true, message: "已移至收件箱并重新投递" };
      } catch (err) {
        await reportErrorToObservability(
          env,
          "preview.move_to_inbox_failed",
          err,
          { accountId: account.id },
        );
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/trash",
    async ({ env, account, emailMessageId, status }) => {
      try {
        await trashEmailAndCleanup(env, account, emailMessageId);
        return { ok: true, message: "已删除" };
      } catch (err) {
        await reportErrorToObservability(env, "preview.trash_failed", err, {
          accountId: account.id,
        });
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/mark-as-junk",
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      try {
        await markEmailAsJunkAndCleanup(env, account, emailMessageId, {
          waitUntil: executionCtx.waitUntil.bind(executionCtx),
        });
        return { ok: true, message: "已标记为垃圾邮件" };
      } catch (err) {
        await reportErrorToObservability(env, "preview.mark_junk_failed", err, {
          accountId: account.id,
        });
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/archive",
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      if (!accountCanArchive(account)) {
        return status(400, {
          ok: false,
          error: "Gmail 归档需要在账号设置里指定归档标签",
        });
      }
      try {
        await archiveEmailAndCleanup(env, account, emailMessageId, {
          waitUntil: executionCtx.waitUntil.bind(executionCtx),
        });
        return { ok: true, message: "已归档" };
      } catch (err) {
        await reportErrorToObservability(env, "preview.archive_failed", err, {
          accountId: account.id,
        });
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/unarchive",
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      try {
        const provider = getEmailProvider(account, env);
        const raw = await provider.fetchRawEmail(emailMessageId, "archive");
        const newEmailMessageId =
          await provider.unarchiveMessage(emailMessageId);
        const waitUntil = executionCtx.waitUntil.bind(executionCtx);
        executionCtx.waitUntil(
          deliverEmailToTelegram(
            raw,
            newEmailMessageId,
            account,
            env,
            waitUntil,
          ).catch((err) =>
            reportErrorToObservability(
              env,
              "preview.redeliver_after_unarchive_failed",
              err,
              { accountId: account.id },
            ),
          ),
        );
        return { ok: true, message: "已移至收件箱并重新投递" };
      } catch (err) {
        await reportErrorToObservability(env, "preview.unarchive_failed", err, {
          accountId: account.id,
        });
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailActionBody },
  )

  .post(
    "/api/mail/:id/toggle-star",
    async ({ env, executionCtx, account, emailMessageId, body, status }) => {
      try {
        const provider = getEmailProvider(account, env);
        if (body.starred) {
          executionCtx.waitUntil(
            markEmailAsRead(env, account, emailMessageId, body.folder),
          );
          await provider.addStar(emailMessageId, body.folder);
        } else {
          await provider.removeStar(emailMessageId, body.folder);
        }

        const mappings = await getMappingsByEmailIds(env.DB, account.id, [
          emailMessageId,
        ]);
        if (mappings.length > 0) {
          const m = mappings[0];
          const keyboard = await buildEmailKeyboard(
            env,
            emailMessageId,
            account.id,
            body.starred,
            accountCanArchive(account),
            m.tg_chat_id,
            m.tg_message_id,
          );
          await new TelegramClient(env)
            .setReplyMarkup(m.tg_chat_id, m.tg_message_id, keyboard)
            .catch(() => {});
          await syncStarPinState(
            env,
            m.tg_chat_id,
            m.tg_message_id,
            body.starred,
          );
        }

        return {
          ok: true,
          message: body.starred ? "已加星标" : "已取消星标",
          starred: body.starred,
        };
      } catch (err) {
        await reportErrorToObservability(
          env,
          "preview.toggle_star_failed",
          err,
          { accountId: account.id },
        );
        return status(500, { ok: false, error: "操作失败" });
      }
    },
    { params: MailParams, body: MailToggleStarBody },
  );

export const mailController = new Elysia({ name: "controller.mail" })
  .use(mailGet)
  .use(mailAttachmentGet)
  .use(mailMutations);
