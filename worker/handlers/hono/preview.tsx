import { buildEmailKeyboard } from "@bot/keyboards";
import { getAccountById } from "@db/accounts";
import { getMappingsByEmailIds } from "@db/message-map";
import {
  requireSessionOrMiniApp,
  requireTelegramLogin,
} from "@handlers/hono/middleware";
import {
  ROUTE_CORS_PROXY,
  ROUTE_JUNK_CHECK_API,
  ROUTE_MAIL_API,
  ROUTE_MAIL_ARCHIVE,
  ROUTE_MAIL_MARK_JUNK,
  ROUTE_MAIL_MOVE_TO_INBOX,
  ROUTE_MAIL_TOGGLE_STAR,
  ROUTE_MAIL_TRASH,
  ROUTE_MAIL_UNARCHIVE,
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
import { buildTgMessageLink, setReplyMarkup } from "@services/telegram";
import { formatBody } from "@utils/format";
import { http } from "@utils/http";
import { verifyProxySignature } from "@utils/mail-html";
import { buildWebMailUrl, verifyMailTokenById } from "@utils/mail-token";
import { reportErrorToObservability } from "@utils/observability";
import type { Context } from "hono";
import { Hono } from "hono";
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
 * (emailMessageId, accountId, token) 三元组校验 —— GET 预览页和 POST 动作
 * 共用的核心逻辑。输入全走 `unknown`，调用方从 body / query / param 拿什么
 * 就塞什么。返回 `Response` 失败不走这里 —— 调用方按自己的错误格式包装。
 */
async function resolveMailContext(
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
 * 预览页 POST 邮件操作的公共入口：解析 body + 校验 token + 取 account。
 * 失败时返回 `Response`（调用方直接 return）；成功返回 `{ account, emailMessageId, body }`。
 */
async function resolveMailAction<B extends MailActionBody = MailActionBody>(
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
  return {
    ok: true,
    account: ctx.account,
    emailMessageId: ctx.emailMessageId,
    body,
  };
}

// ─── HTML 格式化预览工具 ─────────────────────────────────────────────────────
// 页面 /preview 已搬到 Pages（page/src/routes/preview.tsx），只留 API。

preview.post(ROUTE_PREVIEW_API, loginGuard, async (c) => {
  const { html } = await c.req.json<{ html?: string }>();
  if (!html) return c.json({ result: "", length: 0 });
  const result = formatBody(undefined, html, MAX_BODY_CHARS);
  return c.json({ result, length: result.length });
});

// ─── 垃圾邮件检测工具 ────────────────────────────────────────────────────────
// 页面 /junk-check 已搬到 Pages，只留 API。

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

// ─── 邮件操作 API ────────────────────────────────────────────────────────────
// 邮件内容预览页 /mail/:id 已搬到 Pages（page/src/routes/mail.$id.tsx），通过
// GET /api/mail/:id 拿 JSON。Worker 只保留下面这些 POST action。

// 邮件预览 JSON API：Web 和 Mini App 的 mail preview 页都调这个。
// 鉴权只走 token（HMAC-signed with emailMessageId + accountId + ADMIN_SECRET）
// —— 持有 token = 有权看这封邮件；不需要叠 initData。
preview.get(ROUTE_MAIL_API, async (c) => {
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
    inJunk: result.inJunk,
    inArchive: result.fetchFolder === "archive",
    starred: result.starred,
    canArchive: accountCanArchive(account),
    webMailUrl,
    tgMessageLink,
  });
});

preview.post(ROUTE_MAIL_MOVE_TO_INBOX, requireSessionOrMiniApp, async (c) => {
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

preview.post(ROUTE_MAIL_TRASH, requireSessionOrMiniApp, async (c) => {
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

preview.post(ROUTE_MAIL_MARK_JUNK, requireSessionOrMiniApp, async (c) => {
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

preview.post(ROUTE_MAIL_ARCHIVE, requireSessionOrMiniApp, async (c) => {
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

preview.post(ROUTE_MAIL_UNARCHIVE, requireSessionOrMiniApp, async (c) => {
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

preview.post(ROUTE_MAIL_TOGGLE_STAR, requireSessionOrMiniApp, async (c) => {
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
