import { Chip, Skeleton, Spinner } from "@heroui/react";
import { type CSSProperties, useMemo } from "react";
import type { Reminder } from "@/api/schemas";

// 时间线渲染：日期 chip + 圆点导轨 + 卡片。dateLabel / groupRemindersByDate / hm
// 都是这套 UI 的私有 helper，只有这里用到 → 不外提。

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type DateLabel = {
  primary: string;
  secondary: string;
  isToday: boolean;
  isPast: boolean;
};

function fmt2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${fmt2(d.getMonth() + 1)}-${fmt2(d.getDate())}`;
}
function hm(d: Date): string {
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dateLabel(d: Date): DateLabel {
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const wd = WEEKDAYS[d.getDay()];
  if (dayDiff === 0)
    return { primary: "今天", secondary: md, isToday: true, isPast: false };
  if (dayDiff === 1)
    return { primary: "明天", secondary: md, isToday: false, isPast: false };
  if (dayDiff > 1 && dayDiff < 7)
    return { primary: wd, secondary: md, isToday: false, isPast: false };
  if (dayDiff < 0)
    return { primary: "已过", secondary: md, isToday: false, isPast: true };
  return { primary: md, secondary: wd, isToday: false, isPast: false };
}

type ReminderGroup = { date: Date; items: Reminder[] };

function groupRemindersByDate(reminders: Reminder[]): ReminderGroup[] {
  const groups = new Map<string, ReminderGroup>();
  for (const r of reminders) {
    const d = new Date(r.remind_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = ymd(d);
    let group = groups.get(key);
    if (!group) {
      group = { date: startOfDay(d), items: [] };
      groups.set(key, group);
    }
    group.items.push(r);
  }
  for (const g of groups.values()) {
    g.items.sort(
      (a, b) =>
        new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime(),
    );
  }
  return Array.from(groups.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
}

// Flat row union: the timeline alternates date headers and items, but they all
// share the same column layout so a single rail can bridge through both.
type TimelineRow =
  | { kind: "date"; key: string; date: Date; count: number }
  | { kind: "item"; key: string; reminder: Reminder };

// mt-3 (12px) between adjacent items / between a date and its first item;
// mt-6 (24px) before a new date section. The rail's bottom segment extends
// `-nextGap` so it lands exactly on the next row's top.
const GAP_TO_DATE = 24;
const GAP_DEFAULT = 12;

export function ReminderTimeline({
  listOnly,
  reminders,
  loading,
  deletingId,
  onDelete,
  onOpenMail,
}: {
  listOnly: boolean;
  reminders: Reminder[];
  loading: boolean;
  deletingId: number | null;
  onDelete: (id: number) => void;
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
          <div key={i} className="flex gap-3 items-start">
            <Skeleton className="w-24 h-4 rounded mt-3.5 shrink-0" />
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
            className={marginClass}
          />
        );
      })}
    </div>
  );
}

function DateRow({
  date,
  count,
  isFirst,
  isLast,
  nextGap,
  className,
}: {
  date: Date;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  nextGap: number;
  className: string;
}) {
  const label = dateLabel(date);
  const chipClass = label.isToday
    ? "bg-emerald-500 text-emerald-950 font-semibold"
    : label.isPast
      ? "bg-zinc-800 text-zinc-400 border border-zinc-700"
      : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
  const dotColor = label.isToday
    ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
    : label.isPast
      ? "bg-zinc-600"
      : "bg-emerald-400";

  // Chip (size=sm) is 24px tall → center at y=12px from row top. We anchor
  // the rail dot and right-side divider to that y so chip + dot + divider
  // line up across the row, with the secondary date hanging below the chip.
  return (
    <div className={`flex gap-3 items-start ${className}`}>
      <div className="w-16 shrink-0 flex flex-col items-end gap-1">
        <Chip size="sm" className={chipClass}>
          {label.primary}
        </Chip>
        {label.secondary && (
          <div className="text-[11px] text-zinc-500 leading-tight tabular-nums">
            {label.secondary}
          </div>
        )}
      </div>

      <div className="relative w-4 shrink-0 self-stretch">
        {!isFirst && (
          <div
            className="absolute left-1/2 -translate-x-px top-0 w-px bg-zinc-800"
            style={{ height: "12px" }}
          />
        )}
        {!isLast && (
          <div
            className="absolute left-1/2 -translate-x-px w-px bg-zinc-800"
            style={{ top: "12px", bottom: `-${nextGap}px` }}
          />
        )}
        <div
          className={`absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full ring-4 ring-zinc-950 z-10 ${dotColor}`}
          style={{ top: "7px" }}
        />
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2 h-6">
        <div className="flex-1 h-px bg-gradient-to-r from-zinc-700 to-transparent" />
        <span className="text-[11px] text-zinc-600 tabular-nums">
          {count} 项
        </span>
      </div>
    </div>
  );
}

function ItemRow({
  it,
  listOnly,
  isFirst,
  isLast,
  nextGap,
  now,
  isDeleting,
  onOpen,
  onDelete,
  className,
}: {
  it: Reminder;
  listOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  nextGap: number;
  now: number;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
  className: string;
}) {
  const d = new Date(it.remind_at);
  const time = hm(d);
  const ts = d.getTime();
  const isOverdue = ts < now;
  // Pulse only when reminder fires within the next hour — avoids a wall of pulses for far-future items.
  const isImminent = !isOverdue && ts - now < 60 * 60_000;
  const canOpen = Boolean(
    listOnly && it.account_id && it.email_message_id && it.mail_token,
  );

  const bottomStyle: CSSProperties = { top: "26px", bottom: `-${nextGap}px` };

  return (
    <article className={`flex gap-3 items-start ${className}`}>
      <div className="w-16 shrink-0 pt-3.5 text-right">
        <div
          className={`text-[15px] font-semibold tabular-nums leading-tight ${
            isOverdue ? "text-zinc-500" : "text-zinc-100"
          }`}
        >
          {time}
        </div>
      </div>

      <div className="relative w-4 shrink-0 self-stretch">
        {!isFirst && (
          <div className="absolute left-1/2 -translate-x-px top-0 h-[26px] w-px bg-zinc-800" />
        )}
        {!isLast && (
          <div
            className="absolute left-1/2 -translate-x-px w-px bg-zinc-800"
            style={bottomStyle}
          />
        )}
        <div
          className={`absolute left-1/2 -translate-x-1/2 top-[20px] w-3 h-3 rounded-full ring-4 ring-zinc-950 z-10 ${
            isOverdue
              ? "bg-zinc-600"
              : "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.55)]"
          }`}
        />
        {isImminent && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[20px] w-3 h-3 rounded-full bg-emerald-500/40 animate-ping" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <Card
          it={it}
          listOnly={listOnly}
          canOpen={canOpen}
          isOverdue={isOverdue}
          isDeleting={isDeleting}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}

function Card({
  it,
  listOnly,
  canOpen,
  isOverdue,
  isDeleting,
  onOpen,
  onDelete,
}: {
  it: Reminder;
  listOnly: boolean;
  canOpen: boolean;
  isOverdue: boolean;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const showEmail = listOnly && Boolean(it.email_summary || it.email_subject);
  const hasText = it.text.trim().length > 0;

  const inner = (
    <>
      {showEmail && (
        <div className="flex gap-1.5 items-start text-[13px] leading-relaxed text-zinc-300 break-words">
          <span className="shrink-0">📧</span>
          <span className="flex-1">{it.email_summary || it.email_subject}</span>
        </div>
      )}
      {hasText && (
        <div
          className={`text-[15px] leading-relaxed break-words text-zinc-100 ${
            showEmail ? "mt-1.5" : ""
          }`}
        >
          {it.text}
        </div>
      )}
      {!showEmail && !hasText && (
        <div className="text-sm text-zinc-500 italic">无备注</div>
      )}
      {canOpen && (
        <div className="text-[11px] text-emerald-400 mt-2">查看邮件 →</div>
      )}
    </>
  );

  return (
    <div
      className={`relative rounded-xl border transition-colors ${
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

      <button
        type="button"
        onClick={onDelete}
        disabled={isDeleting}
        aria-label="删除提醒"
        className="absolute top-1.5 right-1.5 w-8 h-8 rounded-full flex items-center justify-center text-zinc-500 hover:bg-zinc-800 hover:text-red-400 active:bg-zinc-700 transition-colors disabled:opacity-40"
      >
        {isDeleting ? (
          <Spinner size="sm" />
        ) : (
          <span className="text-sm">🗑</span>
        )}
      </button>
    </div>
  );
}
