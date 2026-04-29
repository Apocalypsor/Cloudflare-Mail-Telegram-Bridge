import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** 跳到 Mini App 邮件预览页 `/telegram-app/mail/$id` 的统一入口。
 *  自动用 window.location 拼 `back=` 让 TG BackButton 能回到当前页。
 *  `folder` 给 IMAP 列表（junk / archive）传，让预览页定位 UID。 */
export function useNavigateToMail() {
  const navigate = useNavigate();
  return useCallback(
    (
      accountId: number,
      emailMessageId: string,
      token: string,
      opts?: { folder?: string },
    ) => {
      const back = window.location.pathname + window.location.search;
      navigate({
        to: "/telegram-app/mail/$id",
        params: { id: emailMessageId },
        search: {
          accountId,
          t: token,
          ...(opts?.folder ? { folder: opts.folder } : {}),
          back,
        },
      });
    },
    [navigate],
  );
}
