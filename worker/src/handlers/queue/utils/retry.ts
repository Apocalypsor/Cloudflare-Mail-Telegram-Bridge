import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { getAccountById } from "@worker/db/accounts";
import {
  deleteFailedEmail,
  type FailedEmail,
  getAllFailedEmails,
} from "@worker/db/failed-emails";
import {
  getMessageMapping,
  type MessageMapping,
  updateShortSummary,
} from "@worker/db/message-map";
import {
  editMessageWithAnalysis,
  prepareEmailContent,
} from "@worker/handlers/queue/utils/format";
import { t } from "@worker/i18n";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { MessageLocation } from "@worker/providers/types";
import type { Account, Env } from "@worker/types";
import { reconcileMessageState } from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import PostalMime from "postal-mime";

/**
 * 已投递邮件的"二次处理"路径 —— 给三个入口共用：
 *  - bot ↻ 按钮：手动 refresh
 *  - cron 每小时：retry 之前 LLM 分析挂掉的（`failed_emails` 表）
 *  - bot 管理面板：按 id 单条 retry
 *
 * 都先做 `reconcileMessageState`：邮件已不在 inbox（被 junk / archive / 删了）
 * → 清掉 TG 消息 + mapping 直接返回；仍在 inbox 才走 LLM + edit message。
 */

type ReanalyzeResult =
  | { status: "analyzed" }
  | { status: "removed"; location: Exclude<MessageLocation, "inbox"> };

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
