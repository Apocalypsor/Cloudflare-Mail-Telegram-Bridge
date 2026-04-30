import {
  buildEmailKeyboard,
  buildInitialEmailKeyboard,
} from "@worker/bot/keyboards";
import {
  deleteMessage,
  sendTextMessage,
  sendWithAttachments,
  setReplyMarkup,
} from "@worker/clients/telegram";
import { putFailedEmail } from "@worker/db/failed-emails";
import { putMessageMapping, updateShortSummary } from "@worker/db/message-map";
import {
  editMessageWithAnalysis,
  prepareEmailContent,
} from "@worker/handlers/queue/utils/format";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { wrapExpandableQuote } from "@worker/utils/markdown-v2";
import { syncStarPinState } from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import PostalMime from "postal-mime";

/**
 * 解析 raw email 并发送到账号对应的 Telegram chat。
 *
 * 流程：
 *  1. 远端状态 reconcile（队列入队 → 消费的窗口里用户可能在远端把邮件挪走 → 跳过投递）
 *  2. parse + 渲染 header + body（共用 `prepareEmailContent`，跟 retry 流复用）
 *  3. 发"最小键盘"消息 → 拿 sentMessageId → 写 mapping → 升级到完整键盘
 *  4. （可选）后台 LLM 分析 + edit message；失败入 `failed_emails` 等 cron 重试
 */
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
