import type { Reminder } from "@worker/api/modules/reminders/model";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export type DateLabel = {
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
export function hm(d: Date): string {
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function dateLabel(d: Date): DateLabel {
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

export type ReminderGroup = { date: Date; items: Reminder[] };

export function groupRemindersByDate(reminders: Reminder[]): ReminderGroup[] {
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

// mt-3 (12px) between adjacent items / between a date and its first item;
// mt-6 (24px) before a new date section. The rail's bottom segment extends
// `-nextGap` so it lands exactly on the next row's top.
export const GAP_TO_DATE = 24;
export const GAP_DEFAULT = 12;
