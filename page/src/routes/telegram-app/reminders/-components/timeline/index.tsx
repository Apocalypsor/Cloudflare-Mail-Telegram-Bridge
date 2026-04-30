import { Skeleton } from "@heroui/react";
import type { Reminder } from "@worker/api/modules/reminders/model";
import { useMemo } from "react";
import {
  GAP_DEFAULT,
  GAP_TO_DATE,
  groupRemindersByDate,
} from "../../-utils/timeline";
import { DateRow } from "./date-row";
import { ItemRow } from "./item-row";

// Flat row union: the timeline alternates date headers and items, but they all
// share the same column layout so a single rail can bridge through both.
type TimelineRow =
  | { kind: "date"; key: string; date: Date; count: number }
  | { kind: "item"; key: string; reminder: Reminder };

export function ReminderTimeline({
  listOnly,
  reminders,
  loading,
  deletingId,
  onDelete,
  onEdit,
  onOpenMail,
}: {
  listOnly: boolean;
  reminders: Reminder[];
  loading: boolean;
  deletingId: number | null;
  onDelete: (id: number) => void;
  onEdit: (id: number) => void;
  onOpenMail: (r: Reminder) => void;
}) {
  // groupRemindersByDate 和 rows 拼装只依赖 reminders；reminders 没变就别重算。
  // useMemo 必须在任何条件 return 之前，才不踩 rules-of-hooks。
  // now 故意每渲染抓一次 —— "isOverdue" / "isImminent" 要看当前时间，缓存反而错。
  const rows = useMemo<TimelineRow[]>(() => {
    const list: TimelineRow[] = [];
    for (const g of groupRemindersByDate(reminders)) {
      list.push({
        kind: "date",
        key: `d-${g.date.toISOString()}`,
        date: g.date,
        count: g.items.length,
      });
      for (const it of g.items) {
        list.push({ kind: "item", key: `i-${it.id}`, reminder: it });
      }
    }
    return list;
  }, [reminders]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-2 sm:gap-3 items-start">
            <Skeleton className="w-16 h-4 rounded mt-3.5 shrink-0" />
            <div className="w-4 shrink-0 flex justify-center pt-5">
              <Skeleton className="w-3 h-3 rounded-full" />
            </div>
            <Skeleton className="flex-1 h-20 rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (reminders.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
        <div className="text-4xl mb-3 opacity-80">📭</div>
        <div className="text-sm text-zinc-400">
          {listOnly ? "暂无待提醒事项" : "本邮件还没有设过提醒"}
        </div>
        {listOnly && (
          <div className="text-xs text-zinc-600 mt-2">
            在邮件消息上点 ⏰ 即可设定
          </div>
        )}
      </div>
    );
  }

  const now = Date.now();

  return (
    <div>
      {rows.map((row, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === rows.length - 1;
        const next = rows[idx + 1];
        const nextGap = next?.kind === "date" ? GAP_TO_DATE : GAP_DEFAULT;
        const marginClass = isFirst
          ? ""
          : row.kind === "date"
            ? "mt-6"
            : "mt-3";

        if (row.kind === "date") {
          return (
            <DateRow
              key={row.key}
              date={row.date}
              count={row.count}
              isFirst={isFirst}
              isLast={isLast}
              nextGap={nextGap}
              className={marginClass}
            />
          );
        }
        return (
          <ItemRow
            key={row.key}
            it={row.reminder}
            listOnly={listOnly}
            isFirst={isFirst}
            isLast={isLast}
            nextGap={nextGap}
            now={now}
            isDeleting={deletingId === row.reminder.id}
            onOpen={() => onOpenMail(row.reminder)}
            onDelete={() => onDelete(row.reminder.id)}
            onEdit={() => onEdit(row.reminder.id)}
            className={marginClass}
          />
        );
      })}
    </div>
  );
}
