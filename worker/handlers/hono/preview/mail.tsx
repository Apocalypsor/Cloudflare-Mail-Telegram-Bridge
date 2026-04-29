import { buildEmailKeyboard } from "@bot/keyboards";
import { getMappingsByEmailIds } from "@db/message-map";
import { requireSessionOrMiniApp } from "@handlers/hono/middleware";
import {
  ROUTE_MAIL_API,
  ROUTE_MAIL_ARCHIVE,
  ROUTE_MAIL_MARK_JUNK,
  ROUTE_MAIL_MOVE_TO_INBOX,
  ROUTE_MAIL_TOGGLE_STAR,
  ROUTE_MAIL_TRASH,
  ROUTE_MAIL_UNARCHIVE,
} from "@handlers/hono/routes";
import { accountCanArchive, getEmailProvider } from "@providers";
import { deliverEmailToTelegram } from "@services/bridge";
import { loadMailForPreview } from "@services/mail-preview";
import {
  cleanupTgForEmail,
  markEmailAsRead,
  syncStarPinState,
} from "@services/message-actions";
import { buildTgMessageLink, setReplyMarkup } from "@services/telegram";
import { buildWebMailUrl } from "@utils/mail-token";
import { reportErrorToObservability } from "@utils/observability";
import type { Hono } from "hono";
import type { Account, AppEnv } from "@/types";
import { resolveMailAction, resolveMailContext } from "./utils";

/** 注册邮件操作 API：GET 预览 + POST mutations（move/trash/junk/archive/unarchive/star）。
 *  邮件内容预览页 /mail/:id 在 Pages，这里只留 API。 */
export function registerMailRoutes(app: Hono<AppEnv>): void {
  // 邮件预览 JSON API：Web 和 Mini App 的 mail preview 页都调这个。
  // 鉴权只走 token（HMAC-signed with emailMessageId + accountId + ADMIN_SECRET）
  // —— 持有 token = 有权看这封邮件；不需要叠 initData。
  app.get(ROUTE_MAIL_API, async (c) => {
    const ctx = await resolveMailContext(
      c.env,
      c.req.param("id"),
      c.req.query("accountId"),
      c.req.query("t"),
    );
    if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
    const { account, emailMessageId, token } = ctx;

    const result = await loadMailForPreview(
      c.env,
      account,
      emailMessageId,
      c.req.query("folder"),
    );
    if (!result.ok) return c.json({ error: result.reason }, result.status);

    // 用户打开预览 = 看过这封邮件，标已读（best-effort，不阻塞响应）
    c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));

    const webMailUrl = c.env.WORKER_URL
      ? buildWebMailUrl(
          c.env.WORKER_URL,
          emailMessageId,
          account.id,
          token,
          result.fetchFolder !== "inbox" ? result.fetchFolder : undefined,
        )
      : "";
    const mailMappings = await getMappingsByEmailIds(c.env.DB, account.id, [
      emailMessageId,
    ]);
    const mapping = mailMappings[0];
    const tgMessageLink = mapping
      ? buildTgMessageLink(mapping.tg_chat_id, mapping.tg_message_id)
      : null;

    return c.json({
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
    });
  });

  app.post(ROUTE_MAIL_MOVE_TO_INBOX, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId } = resolved;
    try {
      const provider = getEmailProvider(account, c.env);
      // IMAP/Outlook move 之后原 id 失效（IMAP 换 UID，Outlook Graph 换 id），
      // 所以必须在 move 之前先把 raw 从垃圾箱拉下来，然后用 move 返回的新 id 建 mapping。
      const raw = await provider.fetchRawEmail(emailMessageId, "junk");
      const newEmailMessageId = await provider.moveToInbox(emailMessageId);

      c.executionCtx.waitUntil(
        deliverEmailToTelegram(
          raw,
          newEmailMessageId,
          account as Account,
          c.env,
          c.executionCtx.waitUntil.bind(c.executionCtx),
        ).catch((err) =>
          reportErrorToObservability(
            c.env,
            "preview.redeliver_after_move_failed",
            err,
            { accountId: account.id },
          ),
        ),
      );

      return c.json({ ok: true, message: "已移至收件箱并重新投递" });
    } catch (err) {
      await reportErrorToObservability(
        c.env,
        "preview.move_to_inbox_failed",
        err,
        { accountId: account.id },
      );
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });

  app.post(ROUTE_MAIL_TRASH, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId } = resolved;
    try {
      const provider = getEmailProvider(account, c.env);
      c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));
      await provider.trashMessage(emailMessageId);
      await cleanupTgForEmail(c.env, account.id, emailMessageId);
      return c.json({ ok: true, message: "已删除" });
    } catch (err) {
      await reportErrorToObservability(c.env, "preview.trash_failed", err, {
        accountId: account.id,
      });
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });

  app.post(ROUTE_MAIL_MARK_JUNK, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId } = resolved;
    try {
      const provider = getEmailProvider(account, c.env);
      c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));
      await provider.markAsJunk(emailMessageId);
      await cleanupTgForEmail(c.env, account.id, emailMessageId);
      return c.json({ ok: true, message: "已标记为垃圾邮件" });
    } catch (err) {
      await reportErrorToObservability(c.env, "preview.mark_junk_failed", err, {
        accountId: account.id,
      });
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });

  app.post(ROUTE_MAIL_ARCHIVE, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId } = resolved;
    if (!accountCanArchive(account))
      return c.json(
        { ok: false, error: "Gmail 归档需要在账号设置里指定归档标签" },
        400,
      );
    try {
      const provider = getEmailProvider(account, c.env);
      c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));
      await provider.archiveMessage(emailMessageId);
      await cleanupTgForEmail(c.env, account.id, emailMessageId);
      return c.json({ ok: true, message: "已归档" });
    } catch (err) {
      await reportErrorToObservability(c.env, "preview.archive_failed", err, {
        accountId: account.id,
      });
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });

  app.post(ROUTE_MAIL_UNARCHIVE, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId } = resolved;
    try {
      const provider = getEmailProvider(account, c.env);
      // 和 move-to-inbox 同样的顺序：先抓原文（此时还在归档里），再 unarchive 拿新 id，最后重新投递
      const raw = await provider.fetchRawEmail(emailMessageId, "archive");
      const newEmailMessageId = await provider.unarchiveMessage(emailMessageId);

      c.executionCtx.waitUntil(
        deliverEmailToTelegram(
          raw,
          newEmailMessageId,
          account as Account,
          c.env,
          c.executionCtx.waitUntil.bind(c.executionCtx),
        ).catch((err) =>
          reportErrorToObservability(
            c.env,
            "preview.redeliver_after_unarchive_failed",
            err,
            { accountId: account.id },
          ),
        ),
      );

      return c.json({ ok: true, message: "已移至收件箱并重新投递" });
    } catch (err) {
      await reportErrorToObservability(c.env, "preview.unarchive_failed", err, {
        accountId: account.id,
      });
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });

  app.post(ROUTE_MAIL_TOGGLE_STAR, requireSessionOrMiniApp, async (c) => {
    const resolved = await resolveMailAction<{
      accountId?: number;
      token?: string;
      starred?: boolean;
    }>(c);
    if (!resolved.ok) return resolved.response;
    const { account, emailMessageId, body } = resolved;
    if (body.starred == null)
      return c.json({ ok: false, error: "参数缺失" }, 400);
    try {
      const provider = getEmailProvider(account, c.env);
      if (body.starred) {
        // 加星 = 用户看过 → 同步标已读（取消星标不改读状态）
        c.executionCtx.waitUntil(
          markEmailAsRead(c.env, account, emailMessageId),
        );
        await provider.addStar(emailMessageId);
      } else {
        await provider.removeStar(emailMessageId);
      }

      // 同步更新 Telegram 消息的星标按钮 + 置顶状态
      const mappings = await getMappingsByEmailIds(c.env.DB, account.id, [
        emailMessageId,
      ]);
      if (mappings.length > 0) {
        const m = mappings[0];
        const keyboard = await buildEmailKeyboard(
          c.env,
          emailMessageId,
          account.id,
          body.starred,
          accountCanArchive(account),
          m.tg_chat_id,
          m.tg_message_id,
        );
        await setReplyMarkup(
          c.env.TELEGRAM_BOT_TOKEN,
          m.tg_chat_id,
          m.tg_message_id,
          keyboard,
        ).catch(() => {});
        await syncStarPinState(
          c.env,
          m.tg_chat_id,
          m.tg_message_id,
          body.starred,
        );
      }

      return c.json({
        ok: true,
        message: body.starred ? "已加星标" : "已取消星标",
        starred: body.starred,
      });
    } catch (err) {
      await reportErrorToObservability(
        c.env,
        "preview.toggle_star_failed",
        err,
        { accountId: account.id },
      );
      return c.json({ ok: false, error: "操作失败" }, 500);
    }
  });
}
