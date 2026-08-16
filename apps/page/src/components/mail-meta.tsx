import { formatExactTime, formatMailDate } from "@page/utils/format-time";
import type { MailGetResponse } from "@worker/api/modules/mail/model";

interface Row {
  label: string;
  value: string;
  /** 鼠标悬停 tooltip（Date 行展示完整时间含时区，避免相对/简化形式丢精度） */
  title?: string;
}

/** 邮件 meta 块（From / To / Account / Date）。web `/mail/$id` 和 miniapp
 *  `/telegram-app/mail/$id` 两边渲染一字不差，统一这一份。 */
export const MailMeta = ({
  meta,
  accountEmail,
}: {
  meta: MailGetResponse["meta"];
  accountEmail: MailGetResponse["accountEmail"];
}) => {
  const rows: Row[] = [];
  if (meta.from) rows.push({ label: "From", value: meta.from });
  if (meta.to) rows.push({ label: "To", value: meta.to });
  if (accountEmail) rows.push({ label: "Account", value: accountEmail });
  if (meta.date) {
    rows.push({
      label: "Date",
      value: formatMailDate(meta.date),
      title: formatExactTime(meta.date),
    });
  }

  if (rows.length === 0) return null;

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-6">
      {rows.map(({ label, value, title }) => (
        <div key={label} className="contents">
          <dt className="text-zinc-500">{label}</dt>
          <dd className="text-zinc-300 wrap-break-word" title={title}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
};
