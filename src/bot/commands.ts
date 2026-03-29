import { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import { KV_BOT_COMMANDS_VERSION_KEY } from "@/constants";
import type { Env } from "@/types";

// 修改此列表后更新 BOT_COMMANDS_VERSION，会自动同步到 Telegram
const BOT_COMMANDS_VERSION = 6;

export const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: "打开管理面板" },
  { command: "help", description: "查看帮助信息" },
  { command: "accounts", description: "查看我的邮箱账号" },
  { command: "sync", description: "同步所有邮箱" },
  { command: "unread", description: "查看未读邮件" },
  { command: "starred", description: "查看星标邮件" },
  { command: "junk", description: "查看垃圾邮件" },
  { command: "users", description: "查看用户列表（管理员）" },
];

export const HELP_TEXT = `📬 *Telemail 帮助*

*命令列表*
/start \\- 打开管理面板
/help \\- 查看帮助信息
/accounts \\- 查看我的邮箱账号
/sync \\- 同步所有邮箱
/unread \\- 查看未读邮件
/starred \\- 查看星标邮件
/junk \\- 查看垃圾邮件
/users \\- 查看用户列表（管理员）

*功能说明*
• 支持 Gmail / Outlook / IMAP 邮箱转发到 Telegram
• 点击 ⭐ 按钮可星标/取消星标邮件，星标自动标记已读
• 点击 🚫 按钮可标记为垃圾邮件并删除消息
• 对消息添加 emoji reaction 可标记邮件为已读
• 打开邮件预览页可移到收件箱、标记垃圾或删除
• 配置 LLM 后自动生成 AI 摘要，高置信度垃圾邮件自动过滤`;

/**
 * 同步 Bot 命令菜单到 Telegram。
 * 使用 KV 存储版本号，仅在 BOT_COMMANDS_VERSION 变化时调用 setMyCommands。
 */
export async function syncBotCommands(env: Env): Promise<void> {
  const cached = await env.EMAIL_KV.get(KV_BOT_COMMANDS_VERSION_KEY);
  if (cached === String(BOT_COMMANDS_VERSION)) return;

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  await api.setMyCommands(BOT_COMMANDS);
  await env.EMAIL_KV.put(
    KV_BOT_COMMANDS_VERSION_KEY,
    String(BOT_COMMANDS_VERSION),
  );
}
