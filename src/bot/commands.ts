import { getBotCommandsVersion, putBotCommandsVersion } from "@db/kv";
import { t } from "@i18n";
import { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import type { Env } from "@/types";

// 修改此列表后更新 BOT_COMMANDS_VERSION，会自动同步到 Telegram
const BOT_COMMANDS_VERSION = 7;

export const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: t("commands:start") },
  { command: "help", description: t("commands:help") },
  { command: "accounts", description: t("commands:accounts") },
  { command: "sync", description: t("commands:sync") },
  { command: "unread", description: t("commands:unread") },
  { command: "starred", description: t("commands:starred") },
  { command: "junk", description: t("commands:junk") },
  { command: "archived", description: t("commands:archived") },
  { command: "users", description: t("commands:users") },
];

export const HELP_TEXT = `${t("commands:helpTitle")}

${t("commands:helpCommands")}
/start \\- ${t("commands:start")}
/help \\- ${t("commands:help")}
/accounts \\- ${t("commands:accounts")}
/sync \\- ${t("commands:sync")}
/unread \\- ${t("commands:unread")}
/starred \\- ${t("commands:starred")}
/junk \\- ${t("commands:junk")}
/archived \\- ${t("commands:archived")}
/users \\- ${t("commands:users")}

${t("commands:helpFeatures")}
${t("commands:helpFeature1")}
${t("commands:helpFeature2")}
${t("commands:helpFeature3")}
${t("commands:helpFeature4")}
${t("commands:helpFeature5")}
${t("commands:helpFeature6")}`;

/**
 * 同步 Bot 命令菜单到 Telegram。
 * 使用 KV 存储版本号，仅在 BOT_COMMANDS_VERSION 变化时调用 setMyCommands。
 */
export async function syncBotCommands(env: Env): Promise<void> {
  const cached = await getBotCommandsVersion(env.EMAIL_KV);
  if (cached === String(BOT_COMMANDS_VERSION)) return;

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  await api.setMyCommands(BOT_COMMANDS);
  await putBotCommandsVersion(env.EMAIL_KV, String(BOT_COMMANDS_VERSION));
}
