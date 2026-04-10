import { buildEmailKeyboard } from "@bot/keyboards";
import { JunkCheckPage } from "@components/junk-check";
import { MailPage } from "@components/mail-page";
import { PreviewPage } from "@components/preview";
import { getAccountByEmail, getAccountById } from "@db/accounts";
import { getCachedMailData, putCachedMailData } from "@db/kv";
import { deleteMappingByEmailId, getMappingsByEmailIds } from "@db/message-map";
import { requireTelegramLogin } from "@handlers/hono/middleware";
import {
  ROUTE_CORS_PROXY,
  ROUTE_JUNK_CHECK,
  ROUTE_JUNK_CHECK_API,
  ROUTE_MAIL,
  ROUTE_MAIL_MARK_JUNK,
  ROUTE_MAIL_MOVE_TO_INBOX,
  ROUTE_MAIL_TOGGLE_STAR,
  ROUTE_MAIL_TRASH,
  ROUTE_PREVIEW,
  ROUTE_PREVIEW_API,
} from "@handlers/hono/routes";
import { type GmailProvider, getEmailProvider } from "@providers";
import { deliverEmailToTelegram } from "@services/bridge";
import { analyzeEmail } from "@services/llm";
import {
  buildCidMapFromAttachments,
  type CidMap,
  proxyImages,
  replaceCidReferences,
  verifyMailToken,
  verifyMailTokenById,
  verifyProxySignature,
} from "@services/mail-preview";
import { deleteMessage, setReplyMarkup } from "@services/telegram";
import { formatAddress, formatBody, wrapPlainText } from "@utils/format";
import { http } from "@utils/http";
import { reportErrorToObservability } from "@utils/observability";
import { Hono } from "hono";
import { raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPError } from "ky";
import PostalMime from "postal-mime";
import { MAX_BODY_CHARS } from "@/constants";
import { type Account, AccountType, type AppEnv, type MailMeta } from "@/types";

const preview = new Hono<AppEnv>();

const loginGuard = requireTelegramLogin();

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
  const messageId = c.req.param("id");
  const token = c.req.query("t");
  // 新格式：accountId（推荐）；旧格式：email + chatId（向后兼容）
  const accountIdParam = c.req.query("accountId");
  const chatId = c.req.query("chatId");
  const accountEmail = c.req.query("email");

  if (!messageId || !token) return c.text("Missing params", 400);

  let account = null;
  if (accountIdParam) {
    const accountId = Number(accountIdParam);
    if (!Number.isInteger(accountId) || accountId <= 0)
      return c.text("Invalid accountId", 400);
    const valid = await verifyMailTokenById(
      c.env.ADMIN_SECRET,
      messageId,
      accountId,
      token,
    );
    if (!valid) return c.text("Forbidden", 403);
    account = await getAccountById(c.env.DB, accountId);
  } else {
    if (!chatId || !accountEmail) return c.text("Missing params", 400);
    const valid = await verifyMailToken(
      c.env.ADMIN_SECRET,
      messageId,
      accountEmail,
      chatId,
      token,
    );
    if (!valid) return c.text("Forbidden", 403);
    account = await getAccountByEmail(c.env.DB, accountEmail);
    if (account && account.chat_id !== chatId) account = null;
  }

  if (!account) return c.text("Account not found", 404);

  // 检查邮件是否在垃圾邮件文件夹和星标状态，决定 FAB 按钮
  const provider = getEmailProvider(account, c.env);
  const [inJunk, starred] = await Promise.all([
    provider.isJunk(messageId).catch(() => false),
    provider.isStarred(messageId).catch(() => false),
  ]);
  const pageProps = {
    messageId,
    accountId: account.id,
    token: token as string,
    inJunk,
    starred,
    accountEmail: account.email,
  };

  // KV 缓存（所有类型共用）
  const cached = await getCachedMailData(c.env.EMAIL_KV, messageId);
  if (cached) {
    const proxied = await proxyImages(cached.html, c.env.ADMIN_SECRET);
    return c.html(
      <MailPage meta={cached.meta ?? {}} {...pageProps}>
        {raw(proxied)}
      </MailPage>,
    );
  }

  let html: string | null = null;
  let cidMap: CidMap = new Map();
  let meta: MailMeta = {};

  if (account.type === AccountType.Gmail) {
    if (!account.refresh_token) return c.text("Account not authorized", 403);
    const result = await (provider as GmailProvider).fetchMailContent(
      messageId,
    );
    if (result) {
      html = result.html;
      cidMap = result.cidMap;
      meta = result.meta;
    }
  } else {
    // IMAP + Outlook: 获取原始 MIME 并解析
    if (account.type !== AccountType.Imap && !account.refresh_token)
      return c.text("Account not authorized", 403);
    const rawEmail = await provider.fetchRawEmail(
      messageId,
      inJunk ? "junk" : "inbox",
    );
    const email = await new PostalMime().parse(rawEmail);
    html = email.html ?? (email.text ? wrapPlainText(email.text) : null);
    cidMap = buildCidMapFromAttachments(email.attachments);
    meta = {
      subject: email.subject ?? null,
      from: email.from ? formatAddress(email.from) : null,
      to: email.to?.map(formatAddress).join(", ") ?? null,
      date: email.date ?? null,
    };
  }

  if (!html) return c.text("No content in this email", 404);

  html = replaceCidReferences(html, cidMap);
  await putCachedMailData(c.env.EMAIL_KV, messageId, { html, meta });
  const proxied = await proxyImages(html, c.env.ADMIN_SECRET);
  return c.html(
    <MailPage meta={meta} {...pageProps}>
      {raw(proxied)}
    </MailPage>,
  );
});

// ─── 邮件操作 API ────────────────────────────────────────────────────────────

preview.post(ROUTE_MAIL_MOVE_TO_INBOX, async (c) => {
  const messageId = c.req.param("id");
  const body = (await c.req.json()) as { accountId?: number; token?: string };
  if (!messageId || !body.accountId || !body.token)
    return c.json({ ok: false, error: "参数缺失" }, 400);
  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    messageId,
    body.accountId,
    body.token,
  );
  if (!valid) return c.json({ ok: false, error: "无效的 token" }, 403);
  const account = await getAccountById(c.env.DB, body.accountId);
  if (!account) return c.json({ ok: false, error: "账号未找到" }, 404);
  try {
    const provider = getEmailProvider(account, c.env);
    // IMAP/Outlook move 之后原 id 失效（IMAP 换 UID，Outlook Graph 换 id），
    // 所以必须在 move 之前先把 raw 从垃圾箱拉下来，然后用 move 返回的新 id 建 mapping。
    const raw = await provider.fetchRawEmail(messageId, "junk");
    const newMessageId = await provider.moveToInbox(messageId);

    c.executionCtx.waitUntil(
      deliverEmailToTelegram(
        raw,
        newMessageId,
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
  const messageId = c.req.param("id");
  const body = (await c.req.json()) as { accountId?: number; token?: string };
  if (!messageId || !body.accountId || !body.token)
    return c.json({ ok: false, error: "参数缺失" }, 400);
  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    messageId,
    body.accountId,
    body.token,
  );
  if (!valid) return c.json({ ok: false, error: "无效的 token" }, 403);
  const account = await getAccountById(c.env.DB, body.accountId);
  if (!account) return c.json({ ok: false, error: "账号未找到" }, 404);
  try {
    const provider = getEmailProvider(account, c.env);
    await provider.trashMessage(messageId);
    return c.json({ ok: true, message: "已删除" });
  } catch {
    return c.json({ ok: false, error: "操作失败" }, 500);
  }
});

preview.post(ROUTE_MAIL_MARK_JUNK, async (c) => {
  const messageId = c.req.param("id");
  const body = (await c.req.json()) as { accountId?: number; token?: string };
  if (!messageId || !body.accountId || !body.token)
    return c.json({ ok: false, error: "参数缺失" }, 400);
  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    messageId,
    body.accountId,
    body.token,
  );
  if (!valid) return c.json({ ok: false, error: "无效的 token" }, 403);
  const account = await getAccountById(c.env.DB, body.accountId);
  if (!account) return c.json({ ok: false, error: "账号未找到" }, 404);
  try {
    const provider = getEmailProvider(account, c.env);
    await provider.markAsJunk(messageId);

    // 删除对应的 TG 消息和映射
    const mappings = await getMappingsByEmailIds(c.env.DB, body.accountId, [
      messageId,
    ]);
    if (mappings.length > 0) {
      const m = mappings[0];
      await deleteMessage(
        c.env.TELEGRAM_BOT_TOKEN,
        m.tg_chat_id,
        m.tg_message_id,
      ).catch(() => {});
      await deleteMappingByEmailId(c.env.DB, messageId, body.accountId).catch(
        () => {},
      );
    }

    return c.json({ ok: true, message: "已标记为垃圾邮件" });
  } catch {
    return c.json({ ok: false, error: "操作失败" }, 500);
  }
});

preview.post(ROUTE_MAIL_TOGGLE_STAR, async (c) => {
  const messageId = c.req.param("id");
  const body = (await c.req.json()) as {
    accountId?: number;
    token?: string;
    starred?: boolean;
  };
  if (!messageId || !body.accountId || !body.token || body.starred == null)
    return c.json({ ok: false, error: "参数缺失" }, 400);
  const valid = await verifyMailTokenById(
    c.env.ADMIN_SECRET,
    messageId,
    body.accountId,
    body.token,
  );
  if (!valid) return c.json({ ok: false, error: "无效的 token" }, 403);
  const account = await getAccountById(c.env.DB, body.accountId);
  if (!account) return c.json({ ok: false, error: "账号未找到" }, 404);
  try {
    const provider = getEmailProvider(account, c.env);
    if (body.starred) {
      await provider.addStar(messageId);
    } else {
      await provider.removeStar(messageId);
    }

    // 同步更新 Telegram 消息的星标按钮
    const mappings = await getMappingsByEmailIds(c.env.DB, body.accountId, [
      messageId,
    ]);
    if (mappings.length > 0) {
      const m = mappings[0];
      const keyboard = await buildEmailKeyboard(
        c.env,
        messageId,
        account.id,
        body.starred,
      );
      await setReplyMarkup(
        c.env.TELEGRAM_BOT_TOKEN,
        m.tg_chat_id,
        m.tg_message_id,
        keyboard,
      ).catch(() => {});
    }

    return c.json({
      ok: true,
      message: body.starred ? "已加星标" : "已取消星标",
      starred: body.starred,
    });
  } catch {
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
