import type { ReactNode } from "react";
import type { MailListAccountResult, MailListItem } from "@/api/schemas";
import { AccountBox } from "./account-box";

/** 邮件列表按账号分组渲染 —— `list.$type` / `search` 两个页面都按"账号 →
 *  邮件 li"这套结构画。差异（错误文案 + 邮件 li 的内部布局）通过 props 提供：
 *
 *   - `errorLabel(r)`: 该账号查询失败时，AccountBox 内的红色提示文本
 *   - `children(item, accountId)`: 渲染单封邮件的 `<button>` 内容（caller 负责点击行为） */
export function MailListByAccount({
  results,
  errorLabel,
  children,
}: {
  results: MailListAccountResult[];
  errorLabel: (r: MailListAccountResult) => string;
  children: (item: MailListItem, accountId: number) => ReactNode;
}) {
  return (
    <>
      {results.map((r) => {
        if (r.error) {
          return (
            <AccountBox
              key={r.accountId}
              errored
              label={r.accountEmail || `Account #${r.accountId}`}
            >
              <div className="px-4 py-3 text-sm text-red-400">
                {errorLabel(r)}
              </div>
            </AccountBox>
          );
        }
        if (!r.total) return null;
        return (
          <AccountBox
            key={r.accountId}
            label={r.accountEmail || `Account #${r.accountId}`}
            count={r.total}
          >
            <ul className="divide-y divide-zinc-800">
              {r.items.map((it) => (
                <li key={it.id}>{children(it, r.accountId)}</li>
              ))}
            </ul>
          </AccountBox>
        );
      })}
    </>
  );
}
