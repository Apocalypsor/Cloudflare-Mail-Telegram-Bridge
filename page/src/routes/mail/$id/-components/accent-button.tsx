import { Button } from "@heroui/react";

/** Web 版邮件 toolbar 上的小按钮 —— tone 决定 zinc/emerald/red/soft-emerald 配色。
 *  视觉对齐 miniapp 的 MailFab：
 *   - neutral: zinc 中性，默认背景
 *   - accent: emerald 强调，主要操作（移到收件箱 / 移出归档）
 *   - danger: red 危险，垃圾 / 删除
 *   - success-soft: 绿色弱填充，已激活的状态（已星标） */
export function AccentButton({
  label,
  tone,
  isDisabled,
  onPress,
}: {
  label: string;
  tone: "neutral" | "accent" | "danger" | "success-soft";
  isDisabled: boolean;
  onPress: () => void;
}) {
  const className = {
    neutral:
      "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
    accent:
      "bg-emerald-500 hover:bg-emerald-400 text-emerald-950 border border-emerald-500",
    danger: "bg-red-600 hover:bg-red-500 text-white border border-red-600",
    "success-soft":
      "bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800",
  }[tone];

  return (
    <Button
      onPress={onPress}
      isDisabled={isDisabled}
      size="sm"
      className={`rounded-full font-medium ${className}`}
    >
      {label}
    </Button>
  );
}
