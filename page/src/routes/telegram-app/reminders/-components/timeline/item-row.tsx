import type { Reminder } from "@worker/api/modules/reminders/model";
import type { CSSProperties } from "react";
import { hm } from "../../-utils/timeline";
import { Card } from "./card";

export function ItemRow({
  it,
  listOnly,
  isFirst,
  isLast,
  nextGap,
  now,
  isDeleting,
  onOpen,
  onDelete,
  onEdit,
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
  onEdit: () => void;
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
    <article className={`flex gap-2 sm:gap-3 items-start ${className}`}>
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
          canOpen={canOpen}
          isOverdue={isOverdue}
          isDeleting={isDeleting}
          onOpen={onOpen}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      </div>
    </article>
  );
}
