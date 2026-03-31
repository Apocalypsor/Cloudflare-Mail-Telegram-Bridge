import { isAdmin } from "@bot/auth";
import {
  accountDetailKeyboard,
  accountDetailText,
  formatUserName,
} from "@bot/formatters";
import { clearBotState, getBotState, setBotState } from "@bot/state";
import {
  createAccount,
  getAllAccounts,
  getAuthorizedAccount,
  getOwnAccounts,
  getVisibleAccounts,
  updateAccount,
} from "@db/accounts";
import { putOAuthBotMsg } from "@db/kv";
import { getAllUsers, getUserByTelegramId } from "@db/users";
import { t } from "@i18n";
import { cleanupAndDeleteAccount } from "@services/account";
import { generateOAuthUrl } from "@services/email/gmail/oauth";
import { generateOAuthUrl as generateMsOAuthUrl } from "@services/email/outlook/oauth";
import { getEmailProvider } from "@services/email/provider";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Account, Env } from "@/types";
import { AccountType } from "@/types";

async function resolveAccount(env: Env, fromId: number, accountIdStr: string) {
  const userId = String(fromId);
  const accountId = parseInt(accountIdStr, 10);
  const admin = isAdmin(userId, env);
  const account = await getAuthorizedAccount(env.DB, accountId, userId, admin);
  return { userId, accountId, admin, account };
}

export function accountListKeyboard(
  accounts: Account[],
  options?: { isAdmin?: boolean; showAll?: boolean; showBack?: boolean },
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const acc of accounts) {
    const status =
      acc.type === AccountType.Imap ? "📬" : acc.refresh_token ? "✅" : "❌";
    const display = acc.email || `#${acc.id}`;
    kb.text(`${status} ${display}`, `acc:${acc.id}`).row();
  }
  kb.text(t("accounts:list.addAccount"), "add").row();
  if (options?.isAdmin) {
    const back = options.showBack ? "" : ":s";
    kb.text(
      options.showAll
        ? t("accounts:list.collapse")
        : t("accounts:list.viewAll"),
      options.showAll ? `accs${back}` : `accs:all${back}`,
    ).row();
  }
  if (options?.showBack) kb.text(t("common:button.back"), "menu");
  return kb;
}

export function registerAccountHandlers(bot: Bot, env: Env) {
  // ─── /accounts: 快速查看账号列表 ────────────────────────────────────────
  bot.command("accounts", async (ctx) => {
    const userId = String(ctx.from?.id);
    const admin = isAdmin(userId, env);

    if (!admin) {
      const user = await getUserByTelegramId(env.DB, userId);
      if (!user || user.approved !== 1) {
        return ctx.reply(t("common:admin.awaitingApproval"));
      }
    }

    const accounts = admin
      ? await getOwnAccounts(env.DB, userId)
      : await getVisibleAccounts(env.DB, userId, false);
    const text =
      accounts.length > 0
        ? t("accounts:list.myAccounts", { count: accounts.length })
        : t("accounts:list.noAccounts");
    return ctx.reply(text, {
      reply_markup: accountListKeyboard(accounts, { isAdmin: admin }),
    });
  });

  // Account list (default: own accounts only)
  bot.callbackQuery("accs", async (ctx) => {
    const userId = String(ctx.from.id);
    await clearBotState(env, userId);
    const admin = isAdmin(userId, env);
    const accounts = admin
      ? await getOwnAccounts(env.DB, userId)
      : await getVisibleAccounts(env.DB, userId, false);

    const text =
      accounts.length > 0
        ? t("accounts:list.myAccounts", { count: accounts.length })
        : t("accounts:list.noAccounts");
    await ctx.editMessageText(text, {
      reply_markup: accountListKeyboard(accounts, {
        isAdmin: admin,
        showBack: true,
      }),
    });
    await ctx.answerCallbackQuery();
  });

  // Account list (admin: show all accounts, from menu)
  bot.callbackQuery("accs:all", async (ctx) => {
    const userId = String(ctx.from.id);
    await clearBotState(env, userId);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accounts = await getAllAccounts(env.DB);
    const text = t("accounts:list.allAccounts", { count: accounts.length });
    await ctx.editMessageText(text, {
      reply_markup: accountListKeyboard(accounts, {
        isAdmin: true,
        showAll: true,
        showBack: true,
      }),
    });
    await ctx.answerCallbackQuery();
  });

  // Account list (admin: show all accounts, standalone from /accounts)
  bot.callbackQuery("accs:all:s", async (ctx) => {
    const userId = String(ctx.from.id);
    await clearBotState(env, userId);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accounts = await getAllAccounts(env.DB);
    const text = t("accounts:list.allAccounts", { count: accounts.length });
    await ctx.editMessageText(text, {
      reply_markup: accountListKeyboard(accounts, {
        isAdmin: true,
        showAll: true,
      }),
    });
    await ctx.answerCallbackQuery();
  });

  // Account list (standalone: collapse back to own accounts)
  bot.callbackQuery("accs:s", async (ctx) => {
    const userId = String(ctx.from.id);
    await clearBotState(env, userId);
    const accounts = await getOwnAccounts(env.DB, userId);

    const text =
      accounts.length > 0
        ? t("accounts:list.myAccounts", { count: accounts.length })
        : t("accounts:list.noAccounts");
    await ctx.editMessageText(text, {
      reply_markup: accountListKeyboard(accounts, { isAdmin: true }),
    });
    await ctx.answerCallbackQuery();
  });

  // Account detail
  bot.callbackQuery(/^acc:(\d+)$/, async (ctx) => {
    const { userId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    await clearBotState(env, userId);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    let ownerName: string | undefined;
    if (admin && account.telegram_user_id) {
      const owner = await getUserByTelegramId(env.DB, account.telegram_user_id);
      ownerName = owner?.username
        ? `@${owner.username}`
        : formatUserName(owner ?? { first_name: account.telegram_user_id });
    } else if (admin) {
      ownerName = "";
    }
    await ctx.editMessageText(accountDetailText(account, ownerName), {
      reply_markup: accountDetailKeyboard(account),
    });
    await ctx.answerCallbackQuery();
  });

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
    if (account.type === AccountType.Imap)
      return ctx.answerCallbackQuery({
        text: t("accounts:oauth.imapNoOAuth"),
      });

    try {
      const origin = env.WORKER_URL?.replace(/\/$/, "") || "";
      const isOutlook = account.type === AccountType.Outlook;
      const oauthUrl = isOutlook
        ? await generateMsOAuthUrl(env, accountId, origin)
        : await generateOAuthUrl(env, accountId, origin);
      const providerName = isOutlook ? "Microsoft" : "Google";

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

  // Delete confirmation prompt
  bot.callbackQuery(/^acc:(\d+):del$/, async (ctx) => {
    const { accountId, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const kb = new InlineKeyboard()
      .text(t("common:button.confirm_delete"), `acc:${accountId}:dy`)
      .text(t("common:button.cancelPlain"), `acc:${accountId}`);
    await ctx.editMessageText(
      t("accounts:delete.confirm", {
        id: accountId,
        email: account.email || t("common:label.notSet"),
        chatId: account.chat_id,
      }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Confirm delete
  bot.callbackQuery(/^acc:(\d+):dy$/, async (ctx) => {
    const { userId, accountId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    await cleanupAndDeleteAccount(env, account);

    const accounts = admin
      ? await getOwnAccounts(env.DB, userId)
      : await getVisibleAccounts(env.DB, userId, false);
    await ctx.editMessageText(
      t("accounts:delete.deleted", { id: accountId, count: accounts.length }),
      {
        reply_markup: accountListKeyboard(accounts, {
          isAdmin: admin,
          showBack: true,
        }),
      },
    );
    await ctx.answerCallbackQuery({ text: t("common:deleted") });
  });

  // Edit menu
  bot.callbackQuery(/^acc:(\d+):edit$/, async (ctx) => {
    const { userId, accountId, admin, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    await clearBotState(env, userId);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    const kb = new InlineKeyboard()
      .text(t("accounts:edit.chatId"), `acc:${accountId}:eci`)
      .row();
    if (admin) {
      kb.text(t("accounts:edit.assignOwner"), `acc:${accountId}:own`).row();
    }
    kb.text(t("common:button.back"), `acc:${accountId}`);

    await ctx.editMessageText(
      `${t("accounts:edit.title", { id: accountId })}\n\n${accountDetailText(account)}\n\n${t("accounts:edit.selectItem")}`,
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Edit Chat ID
  bot.callbackQuery(/^acc:(\d+):eci$/, async (ctx) => {
    const { userId, accountId, account } = await resolveAccount(
      env,
      ctx.from.id,
      ctx.match?.[1],
    );
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFound"),
      });

    await setBotState(env, userId, { action: "edit_chatid", accountId });
    const kb = new InlineKeyboard().text(
      t("common:button.cancel"),
      `acc:${accountId}:edit`,
    );
    await ctx.editMessageText(
      t("accounts:edit.chatIdPrompt", { current: account.chat_id }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Owner selection (admin)
  bot.callbackQuery(/^acc:(\d+):own$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accountId = parseInt(ctx.match?.[1], 10);
    const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });

    const users = await getAllUsers(env.DB);
    const kb = new InlineKeyboard();
    for (const u of users) {
      const name = formatUserName(u);
      const current =
        u.telegram_id === account.telegram_user_id
          ? t("accounts:edit.ownerCurrent")
          : "";
      kb.text(`${name}${current}`, `edown:${accountId}:${u.telegram_id}`).row();
    }
    kb.text(t("common:button.back"), `acc:${accountId}:edit`);

    await ctx.editMessageText(
      t("accounts:edit.ownerTitle", {
        id: accountId,
        current: account.telegram_user_id || t("common:label.none"),
      }),
      {
        reply_markup: kb,
      },
    );
    await ctx.answerCallbackQuery();
  });

  // Confirm owner change
  bot.callbackQuery(/^edown:(\d+):(\d+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    if (!isAdmin(userId, env))
      return ctx.answerCallbackQuery({ text: t("common:error.unauthorized") });

    const accountId = parseInt(ctx.match?.[1], 10);
    const newOwner = ctx.match?.[2];
    const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!account)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });

    await updateAccount(env.DB, accountId, account.chat_id, newOwner);
    const updated = await getAuthorizedAccount(env.DB, accountId, userId, true);
    if (!updated)
      return ctx.answerCallbackQuery({
        text: t("common:error.accountNotFoundShort"),
      });
    const newOwnerUser = await getUserByTelegramId(env.DB, newOwner);
    const ownerName = newOwnerUser?.username
      ? `@${newOwnerUser.username}`
      : formatUserName(newOwnerUser ?? { first_name: newOwner });
    await ctx.editMessageText(accountDetailText(updated, ownerName), {
      reply_markup: accountDetailKeyboard(updated),
    });
    await ctx.answerCallbackQuery({
      text: t("accounts:edit.ownerAssigned", { owner: newOwner }),
    });
  });

  // Start add flow
  bot.callbackQuery("add", async (ctx) => {
    const userId = String(ctx.from.id);
    await setBotState(env, userId, { action: "add", step: "chat_id" });

    const kb = new InlineKeyboard()
      .text(t("accounts:add.useCurrent", { id: userId }), "addme")
      .row()
      .text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(t("accounts:add.promptChatId"), {
      reply_markup: kb,
    });
    await ctx.answerCallbackQuery();
  });

  // Add with own chat ID shortcut
  bot.callbackQuery("addme", async (ctx) => {
    const userId = String(ctx.from.id);
    await setBotState(env, userId, {
      action: "add",
      step: "type",
      chatId: userId,
    });

    const kb = new InlineKeyboard()
      .text(t("accounts:add.gmail"), "addtype:gmail")
      .row()
      .text(t("accounts:add.outlook"), "addtype:outlook")
      .row()
      .text(t("accounts:add.imap"), "addtype:imap")
      .row()
      .text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:add.selectTypePrompt", { chatId: userId }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });

  // Type selection: Gmail
  bot.callbackQuery("addtype:gmail", async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add" || state.step !== "type") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    try {
      const account = await createAccount(env.DB, state.chatId, userId);
      await clearBotState(env, userId);

      const origin = env.WORKER_URL?.replace(/\/$/, "") || "";
      const oauthUrl = await generateOAuthUrl(env, account.id, origin);
      const kb = new InlineKeyboard()
        .url(t("accounts:button.clickAuthGoogle"), oauthUrl)
        .row()
        .text(t("common:button.viewAccount"), `acc:${account.id}`);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await putOAuthBotMsg(env.EMAIL_KV, account.id, {
          chatId: String(msg.chat.id),
          messageId: msg.message_id,
        });
      }

      await ctx.editMessageText(
        t("accounts:gmail.created", {
          id: account.id,
          chatId: state.chatId,
        }),
        {
          reply_markup: kb,
        },
      );
    } catch (err) {
      await clearBotState(env, userId);
      await reportErrorToObservability(env, "bot.create_account_failed", err);
      await ctx.editMessageText(t("common:error.createFailed"));
    }
    await ctx.answerCallbackQuery();
  });

  // Type selection: Outlook
  bot.callbackQuery("addtype:outlook", async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add" || state.step !== "type") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
      return ctx.answerCallbackQuery({
        text: t("accounts:add.msNotConfigured"),
      });
    }

    try {
      const account = await createAccount(
        env.DB,
        state.chatId,
        userId,
        AccountType.Outlook,
      );
      await clearBotState(env, userId);

      const origin = env.WORKER_URL?.replace(/\/$/, "") || "";
      const oauthUrl = await generateMsOAuthUrl(env, account.id, origin);
      const kb = new InlineKeyboard()
        .url(t("accounts:button.clickAuthMicrosoft"), oauthUrl)
        .row()
        .text(t("common:button.viewAccount"), `acc:${account.id}`);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await putOAuthBotMsg(env.EMAIL_KV, account.id, {
          chatId: String(msg.chat.id),
          messageId: msg.message_id,
        });
      }

      await ctx.editMessageText(
        t("accounts:outlook.created", {
          id: account.id,
          chatId: state.chatId,
        }),
        {
          reply_markup: kb,
        },
      );
    } catch (err) {
      await clearBotState(env, userId);
      await reportErrorToObservability(env, "bot.create_account_failed", err);
      await ctx.editMessageText(t("common:error.createFailed"));
    }
    await ctx.answerCallbackQuery();
  });

  // Type selection: IMAP
  bot.callbackQuery("addtype:imap", async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add" || state.step !== "type") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
      return ctx.answerCallbackQuery({
        text: t("accounts:add.imapNotConfigured"),
      });
    }

    await setBotState(env, userId, {
      action: "add_imap",
      step: "host",
      chatId: state.chatId,
    });
    const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:imap.promptHost", { chatId: state.chatId }),
      {
        reply_markup: kb,
      },
    );
    await ctx.answerCallbackQuery();
  });

  // IMAP: secure selection (Yes/No inline buttons)
  bot.callbackQuery(/^imapsecure:(yes|no)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    const state = await getBotState(env, userId);
    if (!state || state.action !== "add_imap" || state.step !== "secure") {
      return ctx.answerCallbackQuery({
        text: t("common:error.operationExpired"),
      });
    }

    const secure = ctx.match?.[1] === "yes";
    await setBotState(env, userId, {
      ...state,
      step: "user",
      imapSecure: secure,
    });
    const kb = new InlineKeyboard().text(t("common:button.cancel"), "accs");
    await ctx.editMessageText(
      t("accounts:imap.promptUser", {
        server: `${state.imapHost}:${state.imapPort} ${secure ? "(TLS)" : `(${t("accounts:imap.noTls")})`}`,
      }),
      { reply_markup: kb },
    );
    await ctx.answerCallbackQuery();
  });
}
