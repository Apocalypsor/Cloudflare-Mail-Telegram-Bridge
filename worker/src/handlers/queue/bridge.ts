import {
  buildEmailKeyboard,
  buildInitialEmailKeyboard,
} from "@worker/bot/keyboards";
import { analyzeEmail, type EmailAnalysis } from "@worker/clients/llm";
import {
  deleteMessage,
  editMessageCaption,
  editTextMessage,
  sendTextMessage,
  sendWithAttachments,
  setReplyMarkup,
  TG_CAPTION_LIMIT,
  TG_MSG_LIMIT,
} from "@worker/clients/telegram";
import { MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE } from "@worker/constants";
import { getAccountById } from "@worker/db/accounts";
import {
  deleteFailedEmail,
  type FailedEmail,
  getAllFailedEmails,
  putFailedEmail,
} from "@worker/db/failed-emails";
import {
  getMessageMapping,
  type MessageMapping,
  putMessageMapping,
  updateShortSummary,
} from "@worker/db/message-map";
import { t } from "@worker/i18n";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { MessageLocation } from "@worker/providers/types";
import type { Account, EmailQueueMessage, Env } from "@worker/types";
import {
  formatBody,
  htmlToMarkdown,
  toTelegramMdV2,
} from "@worker/utils/format";
import { escapeMdV2, wrapExpandableQuote } from "@worker/utils/markdown-v2";
import {
  reconcileMessageState,
  syncStarPinState,
} from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import PostalMime from "postal-mime";

// ---------------------------------------------------------------------------
// 私有 helper
// ---------------------------------------------------------------------------

function getEmailPlainBody(email: { text?: string; html?: string }): string {
  if (email.text?.trim()) return email.text;
  if (email.html) {
    try {
      return htmlToMarkdown(email.html);
    } catch {
      return "";
    }
  }
  return "";
}

function buildTelegramHeader(
  fromName: string,
  fromAddress: string,
  recipient: string,
  subject: string,
  accountEmail?: string,
): string {
  const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, {
    timeZone: MESSAGE_DATE_TIMEZONE,
  });
  const lines = [
    `*${t("bridge:header.from")}*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`,
    `*${t("bridge:header.to")}*  ${escapeMdV2(recipient)}`,
  ];
  if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
    lines.push(`*${t("bridge:header.account")}*  ${escapeMdV2(accountEmail)}`);
  }
  lines.push(
    `*${t("bridge:header.time")}*  ${escapeMdV2(date)}`,
    `*${t("bridge:header.subject")}*  ${escapeMdV2(subject)}`,
    ``,
    ``,
  );
  return lines.join("\n");
}

/** 从解析后的邮件中提取 TG 消息所需的各项内容 */
function prepareEmailContent(
  email: {
    subject?: string;
    to?: { address?: string }[];
    from?: { name?: string; address?: string };
    text?: string;
    html?: string;
  },
  account: Account,
  isCaption: boolean,
) {
  const subject = email.subject || t("common:label.noSubject");
  const recipient =
    email.to?.map((addr) => addr.address).join(", ") ||
    account.email ||
    `Account #${account.id}`;
  const header = buildTelegramHeader(
    email.from?.name || "",
    email.from?.address || t("common:label.unknown"),
    recipient,
    subject,
    account.email ?? undefined,
  );
  const charLimit = isCaption ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;
  const bodyBudget = Math.max(
    Math.floor((charLimit - header.length) * 0.9),
    100,
  );
  const formattedBody = formatBody(email.text, email.html, bodyBudget);
  const plainBody = getEmailPlainBody(email);
  return { subject, header, formattedBody, plainBody };
}

/** 调用 LLM 分析邮件并编辑 Telegram 消息（验证码 / 摘要 + 标签），返回分析结果 */
async function editMessageWithAnalysis(
  env: Env,
  tgToken: string,
  chatId: string,
  tgMessageId: number,
  isCaption: boolean,
  header: string,
  subject: string,
  plainBody: string,
  formattedBody: string,
  keyboard: unknown,
): Promise<EmailAnalysis> {
  const editMsg = (newText: string) =>
    isCaption
      ? editMessageCaption(tgToken, chatId, tgMessageId, newText, keyboard)
      : editTextMessage(tgToken, chatId, tgMessageId, newText, keyboard);

  const result = await analyzeEmail(
    env.LLM_API_URL as string,
    env.LLM_API_KEY as string,
    env.LLM_MODEL as string,
    subject,
    plainBody,
  );

  // 高置信度垃圾邮件仅添加 Junk 标签，不移动到垃圾箱
  if (
    result.isJunk &&
    result.junkConfidence >= 0.8 &&
    !result.tags.some((tag) => /^junk$/i.test(tag))
  ) {
    result.tags.push("Junk");
  }

  const tagsLine =
    result.tags.length > 0
      ? `\n\n${result.tags.map((tag: string) => `\\#${escapeMdV2(tag.replace(/\s+/g, "_"))}`).join("  ")}`
      : "";

  if (result.verificationCode && formattedBody) {
    const codeSection = `*${t("bridge:verificationCode")}*  \`${escapeMdV2(result.verificationCode)}\`\n\n`;
    await editMsg(
      header + codeSection + wrapExpandableQuote(formattedBody) + tagsLine,
    );
    console.log("Verification code extracted");
    return result;
  }

  const summarySection = `*${escapeMdV2(t("bridge:aiSummary"))}*\n\n${toTelegramMdV2(result.summary)}`;
  await editMsg(header + summarySection + tagsLine);
  return result;
}

// ---------------------------------------------------------------------------
// 核心投递（Gmail + IMAP + Outlook 共用）
// ---------------------------------------------------------------------------

/** 解析 raw email 并发送到账号对应的 Telegram chat。 */
export async function deliverEmailToTelegram(
  rawEmail: ArrayBuffer,
  emailMessageId: string,
  account: Account,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = account.chat_id;

  const parser = new PostalMime();
  const email = await parser.parse(rawEmail);

  // 查远端状态：队列入队到处理之间可能已被用户在远端 junk/archive/delete；仅 inbox 才投递。
  // 顺带拿到 starred 给初始 keyboard，避免 TG 键盘从 ☆ → ★ 闪烁
  const provider = getEmailProvider(account, env);
  const state = await provider
    .resolveMessageState(emailMessageId)
    .catch(() => null);
  if (state && state.location !== "inbox") {
    console.log(
      `Skip delivery: email=${emailMessageId} already at ${state.location} on remote`,
    );
    return;
  }
  const initialStarred = state?.location === "inbox" ? state.starred : false;

  const hasAttachments = !!(email.attachments && email.attachments.length > 0);
  const hasSingleAttachment = hasAttachments && email.attachments?.length === 1;
  const { subject, header, formattedBody, plainBody } = prepareEmailContent(
    email,
    account,
    hasSingleAttachment,
  );
  const text = header + wrapExpandableQuote(formattedBody);

  const hasLlm = !!(env.LLM_API_URL && env.LLM_API_KEY && env.LLM_MODEL);

  // 投递流程：先带"最小键盘"（仅刷新）发消息 → 拿到 sentMessageId → 建
  // 完整键盘 → setReplyMarkup 升级。首发就挂刷新键是保底 —— 完整键盘要求
  // tgMessageId 才能构造群聊 Mini App deep link，只能后补；如果后补那步
  // failed，`.catch(() => {})` 会把错误吞掉，用户就永远看不到任何键盘。
  // 有了这个初始刷新键，至少还能手动 refresh 触发重建。
  const initialKeyboard = buildInitialEmailKeyboard();
  let sentMessageId: number;
  if (hasAttachments) {
    sentMessageId = await sendWithAttachments(
      tgToken,
      chatId,
      text,
      email.attachments || [],
      initialKeyboard,
    );
  } else {
    sentMessageId = await sendTextMessage(
      tgToken,
      chatId,
      text,
      initialKeyboard,
    );
  }

  const inserted = await putMessageMapping(env.DB, {
    tg_message_id: sentMessageId,
    tg_chat_id: chatId,
    email_message_id: emailMessageId,
    account_id: account.id,
  });

  // 唯一索引冲突 → 说明另一个并发请求已经投递过，撤回本次重复消息
  if (!inserted) {
    console.log(
      `Duplicate delivery detected for ${emailMessageId}, deleting duplicate Telegram message`,
    );
    await deleteMessage(tgToken, chatId, sentMessageId).catch(() => {});
    return;
  }

  const keyboard = await buildEmailKeyboard(
    env,
    emailMessageId,
    account.id,
    initialStarred,
    accountCanArchive(account),
    chatId,
    sentMessageId,
  );
  await setReplyMarkup(tgToken, chatId, sentMessageId, keyboard).catch(
    () => {},
  );

  if (initialStarred) {
    // 新消息投递完 + 初始就是 star → 同步置顶
    await syncStarPinState(env, chatId, sentMessageId, true);
  }

  if (!hasLlm) return;

  if (!plainBody.trim()) return;

  waitUntil(
    (async () => {
      try {
        // LLM edit 里重建一次键盘取最新 reminder count（期间用户可能刚设了提醒，
        // /api/reminders 那边也在并发 setReplyMarkup；这里重建保证 edit 不会把
        // 键盘回退到陈旧状态）
        const fullKeyboard = await buildEmailKeyboard(
          env,
          emailMessageId,
          account.id,
          initialStarred,
          accountCanArchive(account),
          chatId,
          sentMessageId,
        );
        const analysis = await editMessageWithAnalysis(
          env,
          tgToken,
          chatId,
          sentMessageId,
          hasSingleAttachment,
          header,
          subject,
          plainBody,
          formattedBody,
          fullKeyboard,
        );
        if (analysis.shortSummary) {
          await updateShortSummary(
            env.DB,
            account.id,
            emailMessageId,
            analysis.shortSummary,
          ).catch((e) =>
            reportErrorToObservability(
              env,
              "bridge.update_short_summary_error",
              e,
            ),
          );
        }
      } catch (err) {
        console.error(
          `LLM analysis failed for email ${emailMessageId}, saving to failed_emails`,
          err,
        );
        await putFailedEmail(env.DB, {
          account_id: account.id,
          email_message_id: emailMessageId,
          tg_chat_id: chatId,
          tg_message_id: sentMessageId,
          is_caption: hasSingleAttachment ? 1 : 0,
          subject,
          error_message: err instanceof Error ? err.message : String(err),
        }).catch((e) =>
          reportErrorToObservability(
            env,
            "bridge.save_failed_email_record_error",
            e,
          ),
        );
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// 队列消费：统一处理 Gmail + IMAP 邮件消息
// ---------------------------------------------------------------------------

/** 按账号类型拉取原始邮件并投递到 Telegram */
export async function processEmailMessage(
  msg: EmailQueueMessage,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const account = await getAccountById(env.DB, msg.accountId);
  if (!account) {
    console.log(
      `Account ${msg.accountId} not found, skipping email ${msg.emailMessageId}`,
    );
    return;
  }
  if (account.disabled) {
    console.log(
      `Account ${msg.accountId} is disabled, dropping email ${msg.emailMessageId}`,
    );
    return;
  }

  const provider = getEmailProvider(account, env);
  const rawEmail = await provider.fetchRawEmail(msg.emailMessageId);

  await deliverEmailToTelegram(
    rawEmail,
    msg.emailMessageId,
    account,
    env,
    waitUntil,
  );
}

// ---------------------------------------------------------------------------
// 失败邮件重试
// ---------------------------------------------------------------------------

type ReanalyzeResult =
  | { status: "analyzed" }
  | { status: "removed"; location: Exclude<MessageLocation, "inbox"> };

/**
 * 重新拉取邮件并执行 LLM 分析，编辑 Telegram 消息。
 * 第一步先做全状态对账（junk / archive / deleted / inbox）—— 不在收件箱的直接清理
 * 返回，跳过后续拉邮件 + LLM 分析。
 */
async function reanalyzeEmail(
  env: Env,
  account: Account,
  mapping: MessageMapping,
  isCaption: boolean,
): Promise<ReanalyzeResult> {
  const reconcile = await reconcileMessageState(env, account, mapping);
  if (reconcile.status === "removed") {
    return { status: "removed", location: reconcile.location };
  }

  const { email_message_id, tg_chat_id, tg_message_id } = mapping;
  const provider = getEmailProvider(account, env);
  const rawEmail = await provider.fetchRawEmail(email_message_id);
  const parser = new PostalMime();
  const email = await parser.parse(rawEmail);

  const { subject, header, formattedBody, plainBody } = prepareEmailContent(
    email,
    account,
    isCaption,
  );
  if (!plainBody.trim()) return { status: "analyzed" };

  const keyboard = await buildEmailKeyboard(
    env,
    email_message_id,
    account.id,
    reconcile.starred,
    accountCanArchive(account),
    tg_chat_id,
    tg_message_id,
  );

  const analysis = await editMessageWithAnalysis(
    env,
    env.TELEGRAM_BOT_TOKEN,
    tg_chat_id,
    tg_message_id,
    isCaption,
    header,
    subject,
    plainBody,
    formattedBody,
    keyboard,
  );
  if (analysis.shortSummary) {
    await updateShortSummary(
      env.DB,
      account.id,
      email_message_id,
      analysis.shortSummary,
    ).catch((e) =>
      reportErrorToObservability(env, "bridge.update_short_summary_error", e),
    );
  }
  return { status: "analyzed" };
}

/** 重试单封失败邮件的 LLM 摘要处理，成功后自动删除失败记录 */
export async function retryFailedEmail(
  failed: FailedEmail,
  env: Env,
): Promise<void> {
  const account = await getAccountById(env.DB, failed.account_id);
  if (!account) throw new Error(`Account ${failed.account_id} not found`);

  if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL)
    throw new Error("LLM not configured");

  // 拉真正的 mapping；已消失就视为孤儿
  // —— 原消息大概率已被 junk/archive 路径清理掉了，对应的 failed_email 没必要再重试
  const mapping = await getMessageMapping(
    env.DB,
    failed.tg_chat_id,
    failed.tg_message_id,
  );
  if (!mapping) {
    console.log(
      `Orphaned failed_email id=${failed.id} (mapping gone, likely removed by junk/archive/delete); clearing`,
    );
    await deleteFailedEmail(env.DB, failed.id);
    return;
  }

  await reanalyzeEmail(env, account, mapping, !!failed.is_caption);

  // removed 也算「处理完」—— 邮件已不在 inbox，没必要再重试
  await deleteFailedEmail(env.DB, failed.id);
}

/** 刷新邮件：先对账远端状态（junk/archive/deleted/inbox），仅 inbox 时重新 LLM 分析 */
export async function refreshEmail(
  env: Env,
  chatId: string,
  tgMessageId: number,
  isCaption: boolean,
): Promise<
  | { ok: true; removed?: "junk" | "archive" | "deleted" }
  | { ok: false; reason: string }
> {
  if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
    return { ok: false, reason: t("bridge:refreshNoLlm") };
  }

  const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
  if (!mapping) {
    return { ok: false, reason: t("common:error.mappingNotFound") };
  }

  const account = await getAccountById(env.DB, mapping.account_id);
  if (!account) {
    return { ok: false, reason: t("common:error.accountNotFoundShort") };
  }

  const result = await reanalyzeEmail(env, account, mapping, isCaption);
  if (result.status === "removed") {
    return { ok: true, removed: result.location };
  }
  return { ok: true };
}

/** 重试所有失败邮件，返回 { success, failed } 计数 */
export async function retryAllFailedEmails(
  env: Env,
): Promise<{ success: number; failed: number }> {
  const items = await getAllFailedEmails(env.DB);
  let success = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await retryFailedEmail(item, env);
      success++;
    } catch (err) {
      await reportErrorToObservability(env, "bridge.retry_failed", err, {
        failedEmailId: item.id,
      });
      failed++;
    }
  }
  return { success, failed };
}
