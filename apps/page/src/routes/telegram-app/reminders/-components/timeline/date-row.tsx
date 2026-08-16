import { Chip } from "@heroui/react";
import { dateLabel } from "../../-utils/timeline";

export const DateRow = ({
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
}) => {
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
    <div className={`flex gap-2 sm:gap-3 items-start ${className}`}>
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
        <div className="flex-1 h-px bg-linear-to-r from-zinc-700 to-transparent" />
        <span className="text-[11px] text-zinc-600 tabular-nums">
          {count} 项
        </span>
      </div>
    </div>
  );
};
