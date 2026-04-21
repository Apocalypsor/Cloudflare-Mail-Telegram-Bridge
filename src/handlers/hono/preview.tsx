import { buildEmailKeyboard } from "@bot/keyboards";
import { JunkCheckPage } from "@components/web/junk-check";
import { MailPage } from "@components/web/mail-page";
import { PreviewPage } from "@components/web/preview";
import { getAccountById } from "@db/accounts";
import { getMappingsByEmailIds } from "@db/message-map";
import { requireTelegramLogin } from "@handlers/hono/middleware";
import {
  ROUTE_CORS_PROXY,
  ROUTE_JUNK_CHECK,
  ROUTE_JUNK_CHECK_API,
  ROUTE_MAIL,
  ROUTE_MAIL_ARCHIVE,
  ROUTE_MAIL_MARK_JUNK,
  ROUTE_MAIL_MOVE_TO_INBOX,
  ROUTE_MAIL_TOGGLE_STAR,
  ROUTE_MAIL_TRASH,
  ROUTE_MAIL_UNARCHIVE,
  ROUTE_PREVIEW,
  ROUTE_PREVIEW_API,
} from "@handlers/hono/routes";
import { accountCanArchive, getEmailProvider } from "@providers";
import { deliverEmailToTelegram } from "@services/bridge";
import { analyzeEmail } from "@services/llm";
import { loadMailForPreview } from "@services/mail-preview";
import {
  cleanupTgForEmail,
  markEmailAsRead,
  syncStarPinState,
} from "@services/message-actions";
import { setReplyMarkup } from "@services/telegram";
import { formatBody } from "@utils/format";
import { http } from "@utils/http";
import { verifyProxySignature } from "@utils/mail-html";
import { verifyMailTokenById } from "@utils/mail-token";
import { reportErrorToObservability } from "@utils/observability";
import type { Context } from "hono";
import { Hono } from "hono";
import { raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPError } from "ky";
import { MAX_BODY_CHARS } from "@/constants";
import type { Account, AppEnv } from "@/types";

const preview = new Hono<AppEnv>();

const loginGuard = requireTelegramLogin();

type MailActionBody = {
  accountId?: number;
  token?: string;
};

/**
 * 预览页 POST 邮件操作的公共入口：解析 body + 校验 token + 取 account。
 * 失败时返回 `Response`（调用方直接 return）；成功返回 `{ account, emailMessageId }`。
 */
export async function resolveMailAction<
  B extends MailActionBody = MailActionBody,
>(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; account: Account; emailMessageId: string; body: B }
  | { ok: false; response: Response }
> {
  const emailMessageId = c.req.param("id");
  const body = (await c.req.json()) as B;
  if (!emailMessageId || !body.accountId || !body.token) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "参数缺失" }, 400),
    };
  }
  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    emailMessageId,
    body.accountId,
    body.token,
  );
  if (!valid) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "无效的 token" }, 403),
    };
  }
  const account = await getAccountById(c.env.DB, body.accountId);
  if (!account) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "账号未找到" }, 404),
    };
  }
  return { ok: true, account, emailMessageId, body };
}

// ─── HTML 格式化预览工具 ─────────────────────────────────────────────────────

preview.get(ROUTE_PREVIEW, loginGuard, (c) => {
  return c.html(<PreviewPage />);
});

preview.post(ROUTE_PREVIEW_API, loginGuard, async (c) => {
  const { html } = await c.req.json<{ html?: string }>();
  if (!html) return c.json({ result: "", length: 0 });
  const result = formatBody(undefined, html, MAX_BODY_CHARS);
  return c.json({ result, length: result.length });
});

// ─── 垃圾邮件检测工具 ────────────────────────────────────────────────────────

preview.get(ROUTE_JUNK_CHECK, loginGuard, (c) => {
  return c.html(<JunkCheckPage />);
});

preview.post(ROUTE_JUNK_CHECK_API, loginGuard, async (c) => {
  const { subject, body } = await c.req.json<{
    subject?: string;
    body?: string;
  }>();
  if (!c.env.LLM_API_URL || !c.env.LLM_API_KEY || !c.env.LLM_MODEL)
    return c.json({ error: "LLM not configured" }, 500);
  const result = await analyzeEmail(
    c.env.LLM_API_URL,
    c.env.LLM_API_KEY,
    c.env.LLM_MODEL,
    subject ?? "",
    body ?? "",
  );
  return c.json({
    isJunk: result.isJunk,
    junkConfidence: result.junkConfidence,
    summary: result.summary,
    tags: result.tags,
  });
});

// ─── 邮件内容预览 ────────────────────────────────────────────────────────────

preview.get(ROUTE_MAIL, async (c) => {
  const emailMessageId = c.req.param("id");
  const token = c.req.query("t");
  const accountIdParam = c.req.query("accountId");

  if (!emailMessageId || !token || !accountIdParam)
    return c.text("Missing params", 400);
  const accountId = Number(accountIdParam);
  if (!Number.isInteger(accountId) || accountId <= 0)
    return c.text("Invalid accountId", 400);

  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    emailMessageId,
    accountId,
    token,
  );
  if (!valid) return c.text("Forbidden", 403);

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  // folder 提示：list handler 会为 /archived / /junk 的预览链接带上 folder，
  // 用来给 IMAP 指定 UID 所在的文件夹（per-folder scope，INBOX / junk / archive 的 UID 不通用）
  const result = await loadMailForPreview(
    c.env,
    account,
    emailMessageId,
    c.req.query("folder"),
  );
  if (!result.ok) return c.text(result.reason, result.status);

  // 用户打开预览 = 看过这封邮件，标已读（best-effort，不阻塞响应）
  c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));

  return c.html(
    <MailPage
      meta={result.meta}
      emailMessageId={emailMessageId}
      accountId={account.id}
      token={token as string}
      inJunk={result.inJunk}
      inArchive={result.fetchFolder === "archive"}
      starred={result.starred}
      canArchive={accountCanArchive(account)}
      accountEmail={account.email}
    >
      {raw(result.proxiedHtml)}
    </MailPage>,
  );
});

// ─── 邮件操作 API ────────────────────────────────────────────────────────────

preview.post(ROUTE_MAIL_MOVE_TO_INBOX, async (c) => {
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

preview.post(ROUTE_MAIL_TRASH, async (c) => {
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

preview.post(ROUTE_MAIL_MARK_JUNK, async (c) => {
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

preview.post(ROUTE_MAIL_ARCHIVE, async (c) => {
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

preview.post(ROUTE_MAIL_UNARCHIVE, async (c) => {
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

preview.post(ROUTE_MAIL_TOGGLE_STAR, async (c) => {
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
      c.executionCtx.waitUntil(markEmailAsRead(c.env, account, emailMessageId));
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
    await reportErrorToObservability(c.env, "preview.toggle_star_failed", err, {
      accountId: account.id,
    });
    return c.json({ ok: false, error: "操作失败" }, 500);
  }
});

// ─── 通用 CORS 代理 ────────────────────────────────────────────────────────

preview.get(ROUTE_CORS_PROXY, async (c) => {
  const url = c.req.query("url");
  const sig = c.req.query("sig");
  if (!url || !sig) return c.text("Missing url or sig", 400);
  if (!verifyProxySignature(c.env.ADMIN_SECRET, url, sig))
    return c.text("Invalid signature", 403);

  try {
    const resp = await http.get(url);
    const contentType =
      resp.headers.get("content-type") ?? "application/octet-stream";
    return new Response(resp.body, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400",
      },
    });
  } catch (err) {
    if (err instanceof HTTPError)
      return c.text(
        "Upstream error",
        err.response.status as ContentfulStatusCode,
      );
    return c.text("Failed to fetch image", 502);
  }
});

export default preview;
