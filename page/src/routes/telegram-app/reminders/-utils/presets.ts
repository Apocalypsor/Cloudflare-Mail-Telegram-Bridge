import { addDayToYmd, formatInTz, parseWallClockInTz } from "./tz";

export const PRESETS: {
  label: string;
  mins: number | "tonight20" | "tomorrow9";
}[] = [
  { label: "10 分钟", mins: 10 },
  { label: "30 分钟", mins: 30 },
  { label: "1 小时", mins: 60 },
  { label: "3 小时", mins: 180 },
  { label: "今晚 20:00", mins: "tonight20" },
  { label: "明早 09:00", mins: "tomorrow9" },
];

/** 把 preset 解析成具体的 Date instant；wall-clock 类（今晚/明早）按选中时区算 —— 只有这样
 *  "今晚 20:00" 才符合用户在该时区的直觉。 */
export function presetToDate(
  kind: (typeof PRESETS)[number]["mins"],
  tz: string,
): Date {
  if (typeof kind === "number") return new Date(Date.now() + kind * 60_000);
  const todayYmd = formatInTz(new Date(), tz).ymd;
  if (kind === "tomorrow9") {
    return parseWallClockInTz(addDayToYmd(todayYmd), "09:00", tz);
  }
  // tonight20: 已过 20:00 → 顺延到明天
  let target = parseWallClockInTz(todayYmd, "20:00", tz);
  if (target.getTime() <= Date.now()) {
    target = parseWallClockInTz(addDayToYmd(todayYmd), "20:00", tz);
  }
  return target;
}
