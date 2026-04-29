import { Skeleton } from "@heroui/react";

/** 提醒页头部的邮件卡片 —— 显示当前邮件的 subject + account；点击跳邮件预览页。 */
export function ReminderEmailCard({
  subject,
  accountEmail,
  loading,
  error,
  onClick,
}: {
  subject: string | null;
  accountEmail: string | null;
  loading: boolean;
  error: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left rounded-xl border border-zinc-800 border-l-4 border-l-emerald-500 bg-zinc-900 p-4 hover:bg-zinc-900/80 active:bg-zinc-900/60 transition-colors cursor-pointer"
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4 rounded-md" />
          <Skeleton className="h-3 w-1/2 rounded-md" />
        </div>
      ) : (
        <>
          <div className="text-[15px] font-semibold break-words text-zinc-100">
            {error ? "邮件信息加载失败" : subject || "(无主题)"}
          </div>
          {accountEmail && (
            <div className="text-xs text-zinc-500 mt-1">
              账号: {accountEmail}
            </div>
          )}
          <div className="text-[11px] text-emerald-400 mt-2">
            点击查看邮件 →
          </div>
        </>
      )}
    </button>
  );
}
