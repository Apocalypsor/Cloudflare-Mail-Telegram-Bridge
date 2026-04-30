import { authAny } from "@worker/api/plugins/auth-any";
import { cf } from "@worker/api/plugins/cf";
import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { buildTgMessageLink, setReplyMarkup } from "@worker/clients/telegram";
import { getMappingsByEmailIds } from "@worker/db/message-map";
import { deliverEmailToTelegram } from "@worker/handlers/queue/bridge";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import { buildWebMailUrl } from "@worker/utils/mail-token";
import {
  cleanupTgForEmail,
  markEmailAsRead,
  syncStarPinState,
} from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import { Elysia } from "elysia";
import {
  MailActionBody,
  MailGetQuery,
  MailParams,
  MailToggleStarBody,
} from "./model";
import { loadMailForRendering, resolveMailContext } from "./utils";

/**
 * Mail preview API + 6 mutations:
 *  - GET    /api/mail/:id              token-only auth → preview JSON
 *  - POST   /api/mail/:id/move-to-inbox | trash | mark-as-junk | archive | unarchive | toggle-star
 *           三件套 (accountId/token) + session OR mini-app auth → 校验 owner → 执行
 *
 * 鉴权拆两路：
 *  - GET 走 token only（持有 token = 有权看，不要求登录）
 *  - POST 都走 authAny（要求登录），再叠 token 三件套校验邮件归属
 */

// ─── GET preview (token-only) ──────────────────────────────────────────────
const mailGet = new Elysia({ name: "controller.mail.get" }).use(cf).get(
  "/api/mail/:id",
  async ({ env, executionCtx, params, query, status }) => {
    const ctx = await resolveMailContext(
      env,
      params.id,
      query.accountId,
      query.t,
    );
    if (!ctx.ok) return status(ctx.status, { error: ctx.error });
    const { account, emailMessageId, token } = ctx;

    const result = await loadMailForRendering(
      env,
      account,
      emailMessageId,
      query.folder,
    );
    if (!result.ok) return status(result.status, { error: result.reason });

    // 用户打开预览 = 看过这封邮件，标已读（best-effort）
    executionCtx.waitUntil(markEmailAsRead(env, account, emailMessageId));

    const webMailUrl = env.WORKER_URL
      ? buildWebMailUrl(
          env.WORKER_URL,
          emailMessageId,
          account.id,
          token,
          result.fetchFolder !== "inbox" ? result.fetchFolder : undefined,
        )
      : "";
    const mailMappings = await getMappingsByEmailIds(env.DB, account.id, [
      emailMessageId,
    ]);
    const mapping = mailMappings[0];
    const tgMessageLink = mapping
      ? buildTgMessageLink(mapping.tg_chat_id, mapping.tg_message_id)
      : null;

    return {
      meta: result.meta,
      accountEmail: account.email,
      bodyHtml: result.proxiedHtml,
      bodyHtmlRaw: result.rawHtml,
      inJunk: result.inJunk,
      inArchive: result.fetchFolder === "archive",
      starred: result.starred,
      canArchive: accountCanArchive(account),
      webMailUrl,
      tgMessageLink,
    };
  },
  { params: MailParams, query: MailGetQuery },
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
      const ctx = await resolveMailContext(env, id, accountId, token);
      if (!ctx.ok) return status(ctx.status, { ok: false, error: ctx.error });
      if (!isAdmin && ctx.account.telegram_user_id !== userId) {
        return status(403, { ok: false, error: "Forbidden" });
      }
      return { account: ctx.account, emailMessageId: ctx.emailMessageId };
    },
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
    async ({ env, executionCtx, account, emailMessageId, status }) => {
      try {
        const provider = getEmailProvider(account, env);
        executionCtx.waitUntil(markEmailAsRead(env, account, emailMessageId));
        await provider.trashMessage(emailMessageId);
        await cleanupTgForEmail(env, account.id, emailMessageId);
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
        const provider = getEmailProvider(account, env);
        executionCtx.waitUntil(markEmailAsRead(env, account, emailMessageId));
        await provider.markAsJunk(emailMessageId);
        await cleanupTgForEmail(env, account.id, emailMessageId);
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
        const provider = getEmailProvider(account, env);
        executionCtx.waitUntil(markEmailAsRead(env, account, emailMessageId));
        await provider.archiveMessage(emailMessageId);
        await cleanupTgForEmail(env, account.id, emailMessageId);
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
          executionCtx.waitUntil(markEmailAsRead(env, account, emailMessageId));
          await provider.addStar(emailMessageId);
        } else {
          await provider.removeStar(emailMessageId);
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
          await setReplyMarkup(
            env.TELEGRAM_BOT_TOKEN,
            m.tg_chat_id,
            m.tg_message_id,
            keyboard,
          ).catch(() => {});
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
  .use(mailMutations);
