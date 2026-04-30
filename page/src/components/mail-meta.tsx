import type { MailGetResponse } from "@worker/api/modules/mail/model";

/** 邮件 meta 块（From / To / Account / Date）。web `/mail/$id` 和 miniapp
 *  `/telegram-app/mail/$id` 两边渲染一字不差，统一这一份。 */
export function MailMeta({
  meta,
  accountEmail,
}: {
  meta: MailGetResponse["meta"];
  accountEmail: MailGetResponse["accountEmail"];
}) {
  const rows: [string, string][] = [];
  if (meta.from) rows.push(["From", meta.from]);
  if (meta.to) rows.push(["To", meta.to]);
  if (accountEmail) rows.push(["Account", accountEmail]);
  if (meta.date) rows.push(["Date", meta.date]);

  if (rows.length === 0) return null;

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-6">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-zinc-500">{label}</dt>
          <dd className="text-zinc-300 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
