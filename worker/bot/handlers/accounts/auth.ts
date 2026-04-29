import {
  accountDetailKeyboard,
  accountDetailText,
} from "@bot/utils/formatters";
import { setArchiveFolder } from "@db/accounts";
import { putOAuthBotMsg } from "@db/kv";
import { t } from "@i18n";
import { type GmailProvider, getEmailProvider, PROVIDERS } from "@providers";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";
import { resolveAccount, resolveOwnerName } from "./utils";

/** 注册 OAuth / push renew / archive 标签管理类回调。 */
export function registerAuthCallbacks(bot: Bot, env: Env) {
  // OAuth authorization (Gmail / Outlook)
  bot.callbackQuery(/^acc:(\d+):auth$/, async (ctx) => {
    const { accountId, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });
    const oauth = PROVIDERS[account.type].oauth;
    if (!oauth)
      return ctx.answerCallbackQuery({
        text: t("accounts:oauth.imapNoOAuth"),
      });

    try {
      const origin = env.WORKER_URL?.replace(/\/$/, "") || "";
      const callbackUrl = `${origin}/oauth/${account.type}/callback`;
      const oauthUrl = await oauth.generateOAuthUrl(
        env,
        accountId,
        callbackUrl,
      );
      const providerName = oauth.name;

      const kb = new InlineKeyboard()
        .url(t("accounts:button.clickAuth"), oauthUrl)
        .row()
        .text(t("common:button.back"), `acc:${accountId}`);
      await ctx.editMessageText(
        t("accounts:oauth.prompt", {
          provider: providerName,
          account: account.email || `#${account.id}`,
        }),
        { reply_markup: kb },
      );

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await putOAuthBotMsg(env.EMAIL_KV, accountId, {
          chatId: String(msg.chat.id),
          messageId: msg.message_id,
        });
      }
    } catch (err) {
      await reportErrorToObservability(env, "bot.oauth_url_gen_failed", err);
      return ctx.answerCallbackQuery({
        text: t("common:error.genOAuthFailed"),
      });
    }
    await ctx.answerCallbackQuery();
  });

  // Renew watch / subscription (Gmail / Outlook)
  bot.callbackQuery(/^acc:(\d+):w$/, async (ctx) => {
    const { account } = await resolveAccount(env, ctx.from.id, ctx.match?.[1]);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });
    if (!account.refresh_token)
      return ctx.answerCallbackQuery({
        text: t("accounts:oauth.notAuthorized"),
      });

    try {
      const provider = getEmailProvider(account, env);
      await provider.renewPush();
      await ctx.answerCallbackQuery({
        text: t("accounts:oauth.watchRenewed", { email: account.email }),
      });
    } catch (err) {
      await reportErrorToObservability(env, "bot.watch_renew_failed", err);
      await ctx.answerCallbackQuery({
        text: t("accounts:oauth.watchFailed"),
      });
    }
  });

  // Gmail archive label picker
  bot.callbackQuery(/^acc:(\d+):arc$/, async (ctx) => {
    const { account } = await resolveAccount(env, ctx.from.id, ctx.match?.[1]);
    if (!account || !PROVIDERS[account.type].needsArchiveSetup)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });
    if (!account.refresh_token)
      return ctx.answerCallbackQuery({
        text: t("accounts:oauth.notAuthorized"),
      });

    let labels: { id: string; name: string }[];
    try {
      const provider = getEmailProvider(account, env) as GmailProvider;
      labels = await provider.listLabels();
    } catch (err) {
      await reportErrorToObservability(
        env,
        "bot.list_gmail_labels_failed",
        err,
      );
      return ctx.answerCallbackQuery({
        text: t("archive:listLabelsFailed"),
      });
    }

    const kb = new InlineKeyboard();
    if (account.archive_folder) {
      kb.text(t("archive:clearLabel"), `arc:${account.id}:clear`).row();
    }
    for (const label of labels) {
      const current = label.id === account.archive_folder ? " ✅" : "";
      kb.text(`${label.name}${current}`, `arc:${account.id}:${label.id}`).row();
    }
    kb.text(t("common:button.back"), `acc:${account.id}`);

    await ctx.editMessageText(
      t("archive:pickerPrompt", {
        current:
          account.archive_folder_name ||
          account.archive_folder ||
          t("common:label.notSet"),
      }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Save selected archive label
  bot.callbackQuery(/^arc:(\d+):(.+)$/, async (ctx) => {
    const { accountId, account, admin } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account || !PROVIDERS[account.type].needsArchiveSetup)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const choice = ctx.match?.[2];
    let newId: string | null;
    let newName: string | null;
    if (choice === "clear") {
      newId = null;
      newName = null;
    } else {
      newId = choice ?? null;
      // 回查一次 labels，用 ID 取到对应 name 再存（Gmail API 归档需要 ID，但 UI 要展示 name）
      try {
        const provider = getEmailProvider(account, env) as GmailProvider;
        const labels = await provider.listLabels();
        newName = labels.find((l) => l.id === newId)?.name ?? null;
      } catch (err) {
        await reportErrorToObservability(
          env,
          "bot.resolve_gmail_label_name_failed",
          err,
        );
        newName = null;
      }
    }
    await setArchiveFolder(env.DB, accountId, newId, newName);

    const ownerName = await resolveOwnerName(
      env.DB,
      admin,
      account.telegram_user_id,
    );
    const updated = {
      ...account,
      archive_folder: newId,
      archive_folder_name: newName,
    };
    await ctx.editMessageText(accountDetailText(updated, ownerName), {
      reply_markup: accountDetailKeyboard(updated),
    });
    await ctx.answerCallbackQuery({
      text: newId ? t("archive:labelSaved") : t("archive:labelCleared"),
    });
  });
}
