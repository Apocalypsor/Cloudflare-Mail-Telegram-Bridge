/**
 * 时区工具：UI 端 wall-clock ↔ UTC instant 互转 + 下拉用的精选 IANA 列表。
 *
 * 不上 IANA 全集（~440 条对手机选择器太长）；列了一份覆盖各大洲主要业务中心 +
 * 中文用户高频出差地的精简清单，按 continent 分组。每条带 shortOffset 标签
 * （DST 期间会自动反映为夏令时偏移）。
 */

export const DEVICE_TZ_VALUE = "device";

const COMMON_TZS_BY_REGION: { region: string; values: string[] }[] = [
  {
    region: "Asia",
    values: [
      "Asia/Shanghai",
      "Asia/Hong_Kong",
      "Asia/Taipei",
      "Asia/Tokyo",
      "Asia/Seoul",
      "Asia/Singapore",
      "Asia/Bangkok",
      "Asia/Kuala_Lumpur",
      "Asia/Jakarta",
      "Asia/Manila",
      "Asia/Kolkata",
      "Asia/Karachi",
      "Asia/Dubai",
      "Asia/Tehran",
    ],
  },
  {
    region: "Europe",
    values: [
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Europe/Madrid",
      "Europe/Rome",
      "Europe/Amsterdam",
      "Europe/Athens",
      "Europe/Istanbul",
      "Europe/Moscow",
    ],
  },
  {
    region: "America",
    values: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Los_Angeles",
      "America/Anchorage",
      "America/Toronto",
      "America/Vancouver",
      "America/Mexico_City",
      "America/Sao_Paulo",
      "America/Buenos_Aires",
    ],
  },
  {
    region: "Africa",
    values: ["Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg"],
  },
  {
    region: "Oceania",
    values: [
      "Australia/Perth",
      "Australia/Sydney",
      "Pacific/Auckland",
      "Pacific/Honolulu",
    ],
  },
  { region: "UTC", values: ["UTC"] },
];

function tzShortOffset(tz: string): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    });
    return (
      dtf.formatToParts(new Date()).find((p) => p.type === "timeZoneName")
        ?.value ?? ""
    );
  } catch {
    return "";
  }
}

export type TzGroup = {
  region: string;
  items: { value: string; label: string }[];
};

export const TZ_GROUPS: TzGroup[] = COMMON_TZS_BY_REGION.map(
  ({ region, values }) => ({
    region,
    items: values.map((value) => {
      const off = tzShortOffset(value);
      return { value, label: off ? `${value} (${off})` : value };
    }),
  }),
);

export function getDeviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveTz(value: string): string {
  return value === DEVICE_TZ_VALUE ? getDeviceTz() : value;
}

function fmt2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 把 UTC instant 在 tz 里渲染成 wall-clock {ymd, hm} —— 默认输入和 minDate 用 */
export function formatInTz(d: Date, tz: string): { ymd: string; hm: string } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA 的 hour: "2-digit" 在 hour12:false 下偶尔会输出 "24" 表示 00 —— 折一下
  const h = get("hour") === "24" ? "00" : get("hour");
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hm: `${h}:${get("minute")}`,
  };
}

/** 把 tz 里的 wall-clock {date, time} 解析成 UTC Date instant —— 提交前用 */
export function parseWallClockInTz(
  date: string,
  time: string,
  tz: string,
): Date {
  // 先按 UTC 探测一遍，再问 Intl 当时该时区的偏移，最后用 ISO 字符串带 offset 解析
  const probe = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(probe.getTime())) return new Date(Number.NaN);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  });
  const offRaw = dtf
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value;
  // longOffset 大多输出 "GMT+08:00" / "GMT-05:00"；UTC 时输出 "GMT"
  const offset =
    offRaw && offRaw !== "GMT" ? offRaw.replace(/^GMT/, "") : "+00:00";
  return new Date(`${date}T${time}:00${offset}`);
}

/** "YYYY-MM-DD" + 1 天 → "YYYY-MM-DD"。tomorrow / 今晚顺延场景用。 */
export function addDayToYmd(s: string): string {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return s;
  const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  return `${next.getUTCFullYear()}-${fmt2(next.getUTCMonth() + 1)}-${fmt2(next.getUTCDate())}`;
}
