export const formatMailDate = (date: Date): string => {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 完整精确时间，给 tooltip 用：跟系统 locale 走（含时区缩写如 `GMT+8` / `PDT`） */
export const formatExactTime = (date: Date): string => {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
};

/** 邮件时间显示：`"YYYY年M月D日 HH:mm"`，按浏览器本地时区。
 *  `Date.prototype.getHours()` 等默认走 local TZ，不需要额外处理。 */
const pad = (n: number) => String(n).padStart(2, "0");
