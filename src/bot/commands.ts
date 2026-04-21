import { getBotCommandsVersion, putBotCommandsVersion } from "@db/kv";
import { t } from "@i18n";
import { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import type { Env } from "@/types";

// 修改 BOT_COMMANDS / ADMIN_COMMANDS 后更新此版本号，会自动 setMyCommands 同步
const BOT_COMMANDS_VERSION = 10;

/** Telegram `/` 自动补全菜单里展示的命令 —— 所有用户可见 */
const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: t("commands:start") },
  { command: "help", description: t("commands:help") },
  { command: "accounts", description: t("commands:accounts") },
  { command: "sync", description: t("commands:sync") },
  { command: "unread", description: t("commands:unread") },
  { command: "starred", description: t("commands:starred") },
  { command: "junk", description: t("commands:junk") },
  { command: "archived", description: t("commands:archived") },
];

/** 管理员命令 —— 不进 setMyCommands（避免普通用户在补全菜单看到），
 *  只在 `/help` 给管理员的回复里附加列出。 */
const ADMIN_COMMANDS: BotCommand[] = [
  { command: "users", description: t("commands:users") },
  { command: "secrets", description: t("commands:secrets") },
];

function formatCommandList(commands: BotCommand[]): string {
  return commands.map((c) => `/${c.command} \\- ${c.description}`).join("\n");
}

/** 构造 /help 回复文本。管理员额外看到 `ADMIN_COMMANDS` 那一段。 */
export function helpText(admin: boolean): string {
  const blocks = [
    t("commands:helpTitle"),
    "",
    t("commands:helpCommands"),
    formatCommandList(BOT_COMMANDS),
  ];
  if (admin) {
    blocks.push(
      "",
      t("commands:helpAdminCommands"),
      formatCommandList(ADMIN_COMMANDS),
    );
  }
  blocks.push(
    "",
    t("commands:helpFeatures"),
    t("commands:helpFeature1"),
    t("commands:helpFeature2"),
    t("commands:helpFeature3"),
    t("commands:helpFeature4"),
    t("commands:helpFeature5"),
    t("commands:helpFeature6"),
  );
  return blocks.join("\n");
}

/**
 * 同步 Bot 命令菜单到 Telegram。
 * 使用 KV 存储版本号，仅在 BOT_COMMANDS_VERSION 变化时调用 setMyCommands。
 * 仅同步 BOT_COMMANDS（普通用户可见），ADMIN_COMMANDS 永不进菜单。
 */
export async function syncBotCommands(env: Env): Promise<void> {
  const cached = await getBotCommandsVersion(env.EMAIL_KV);
  if (cached === String(BOT_COMMANDS_VERSION)) return;

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  await api.setMyCommands(BOT_COMMANDS);
  await putBotCommandsVersion(env.EMAIL_KV, String(BOT_COMMANDS_VERSION));
}
