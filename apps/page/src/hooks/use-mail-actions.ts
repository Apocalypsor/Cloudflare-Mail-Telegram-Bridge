import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import type { MailAccess } from "@page/utils/mail-content";
import { useCallback, useRef, useState } from "react";

/**
 * 邮件预览页能触发的服务端动作。和 worker `api/modules/mail` 的 mutation 路由一一对应。
 */
export type MailAction =
  | "toggle-star"
  | "archive"
  | "unarchive"
  | "trash"
  | "mark-as-junk"
  | "move-to-inbox";

interface MailActionResult {
  action: MailAction;
  /** toggle-star 时携带本次切到的 starred 状态 */
  starredNext?: boolean;
  ok: boolean;
  /** 服务端 200 但 ok=false 时的错误信息，或网络错误信息 */
  error?: string;
  /** 服务端 ok=true 时返回的提示文案 */
  message?: string;
}

interface UseMailActionsOptions {
  emailMessageId: string;
  initialStarred: boolean;
  /** 邮件当前 folder（来自预览页 search.folder）。仅 toggle-star 用到 ——
   *  IMAP 需要它选对 mailbox 加 / 去 \Flagged；不传按 INBOX。 */
  folder?: "inbox" | "junk" | "archive";
  /** 任意动作成功后回调（caller 一般用来 invalidate query 重拉预览） */
  onChanged?: () => void;
}

type UseMailActionsParams = UseMailActionsOptions & MailAccess;

interface UseMailActionsReturn {
  starred: boolean;
  /** 任一 terminal 动作成功后变 true，UI 应隐藏后续入口 */
  done: boolean;
  pending: boolean;
  /**
   * 触发一次动作。返回 result 让 caller 决定如何反馈（web 用 Chip，
   * Mini App 用 TG showAlert + HapticFeedback）。`toggle-star` 时
   * `starredNext` 必填。
   */
  run: (action: MailAction, starredNext?: boolean) => Promise<MailActionResult>;
}

/** 终端动作 —— 执行后邮件就离开当前视图（归档/删除/标垃圾），UI 应隐藏后续操作入口。 */
const TERMINAL_ACTIONS: ReadonlySet<MailAction> = new Set([
  "archive",
  "unarchive",
  "trash",
  "mark-as-junk",
  "move-to-inbox",
]);

const isTerminalMailAction = (action: MailAction): boolean => {
  return TERMINAL_ACTIONS.has(action);
};

/**
 * 邮件预览页操作的共享逻辑：发 POST /api/mail/:id/<action>，维护本地
 * starred / done / pending state，成功调 onChanged。UI 反馈（toast / Chip /
 * TG popup）交给 caller。
 */
export const useMailActions = (
  params: UseMailActionsParams,
): UseMailActionsReturn => {
  const [starred, setStarred] = useState(params.initialStarred);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const propsRef = useRef(params);
  propsRef.current = params;

  const run = useCallback(
    async (
      action: MailAction,
      starredNext?: boolean,
    ): Promise<MailActionResult> => {
      const { emailMessageId, folder, onChanged } = propsRef.current;
      setPending(true);
      try {
        const m = api.api.mail({ id: emailMessageId });
        const body =
          propsRef.current.access !== undefined
            ? { access: propsRef.current.access }
            : {
                accountId: propsRef.current.accountId,
                token: propsRef.current.token,
              };
        const result = await (action === "toggle-star"
          ? m["toggle-star"].post({
              ...body,
              starred: starredNext ?? false,
              folder,
            })
          : action === "archive"
            ? m.archive.post(body)
            : action === "unarchive"
              ? m.unarchive.post(body)
              : action === "trash"
                ? m.trash.post(body)
                : action === "mark-as-junk"
                  ? m["mark-as-junk"].post(body)
                  : m["move-to-inbox"].post(body));
        if (result.error) {
          const value = result.error.value as { error?: string } | string;
          const msg =
            typeof value === "string"
              ? value
              : (value?.error ?? String(result.error.status));
          return { action, starredNext, ok: false, error: msg };
        }
        if (action === "toggle-star" && starredNext !== undefined) {
          setStarred(starredNext);
        }
        if (isTerminalMailAction(action)) setDone(true);
        onChanged?.();
        return {
          action,
          starredNext,
          ok: true,
          message: result.data.message,
        };
      } catch (err) {
        return {
          action,
          starredNext,
          ok: false,
          error: await extractErrorMessage(err),
        };
      } finally {
        setPending(false);
      }
    },
    [],
  );

  return { starred, done, pending, run };
};
