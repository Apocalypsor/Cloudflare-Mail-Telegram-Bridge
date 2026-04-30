import { Spinner } from "@heroui/react";
import type { Reminder } from "@worker/api/modules/reminders/model";

export function Card({
  it,
  canOpen,
  isOverdue,
  isDeleting,
  onOpen,
  onDelete,
  onEdit,
}: {
  it: Reminder;
  canOpen: boolean;
  isOverdue: boolean;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  // 内容显示优先级 fallback：备注 > short_summary > 邮件 subject。
  // 取第一个非空，仅显示一行；都为空则 italic 占位。
  const text = it.text.trim();
  const display = text
    ? { icon: "📝", value: text }
    : it.email_summary
      ? { icon: "📧", value: it.email_summary }
      : it.email_subject
        ? { icon: "📧", value: it.email_subject }
        : null;

  const inner = (
    <>
      {display ? (
        <div className="flex gap-1.5 items-start text-[15px] leading-relaxed break-words text-zinc-100">
          <span className="shrink-0">{display.icon}</span>
          <span className="flex-1">{display.value}</span>
        </div>
      ) : (
        <div className="text-sm text-zinc-500 italic">无备注</div>
      )}
    </>
  );

  return (
    <div
      className={`relative rounded-xl border transition-colors min-h-20 ${
        isOverdue
          ? "border-zinc-800/70 bg-zinc-900/60"
          : "border-zinc-800 bg-zinc-900"
      } ${canOpen ? "hover:border-emerald-500/40" : ""}`}
    >
      {canOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left p-3.5 pr-12 cursor-pointer"
        >
          {inner}
        </button>
      ) : (
        <div className="p-3.5 pr-12">{inner}</div>
      )}

      {/* 按钮竖排：✏️ 在上，🗑 在下，靠右贴边。listOnly 与否都用同一布局 */}
      <div className="absolute top-1.5 right-1.5 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={onEdit}
          aria-label="编辑提醒"
          className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-500 hover:bg-zinc-800 hover:text-emerald-300 active:bg-zinc-700 transition-colors"
        >
          <span className="text-sm">✏️</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label="删除提醒"
          className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-500 hover:bg-zinc-800 hover:text-red-400 active:bg-zinc-700 transition-colors disabled:opacity-40"
        >
          {isDeleting ? (
            <Spinner size="sm" />
          ) : (
            <span className="text-sm">🗑</span>
          )}
        </button>
      </div>
    </div>
  );
}
