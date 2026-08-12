/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
export const escapeMdV2 = (str: string): string => {
  if (!str) return "";
  return str.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
};
