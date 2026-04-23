import { useCallback, useMemo, useRef, useState } from "react";
import { api, extractErrorMessage } from "@/lib/api";
import { okResponseSchema } from "@/lib/schemas";
import { getTelegram, type PopupButton, useMainButton } from "@/lib/tg";

export interface MailFabProps {
  emailMessageId: string;
  accountId: number;
  token: string;
  starred: boolean;
  inJunk: boolean;
  inArchive: boolean;
  canArchive: boolean;
  /** FAB 动作成功后通知父组件 refetch 预览数据；交给 caller 处理 */
  onChanged?: () => void;
}

type Action =
  | "toggle-star"
  | "archive"
  | "unarchive"
  | "trash"
  | "mark-as-junk"
  | "move-to-inbox";

interface ActionDef {
  id: Action;
  label: string;
  type: PopupButton["type"];
  /** 执行后邮件就离开当前视图了（归档 / 垃圾 / 删除等），之后 FAB 隐藏 */
  terminal: boolean;
}

/**
 * 邮件预览页的操作入口 —— 用 TG 原生 MainButton + showPopup 做，不渲染任何
 * DOM。组件本身只管状态 + 调 API，UI 全部由 TG 宿主绘制。
 *
 *   多个动作可选：MainButton 显示 "⚡ 操作" → 点击弹 showPopup action sheet
 *   仅一个动作（归档状态下的"移出归档"）：MainButton 直接显示该动作，一键完成
 *
 * 成功后：触觉反馈 + onChanged() 让页面 refetch 数据；操作是终端的（归档 /
 * 删除 / 标垃圾 / 移出归档 / 移回收件箱）就把 MainButton 自己藏掉。
 * 失败：showAlert(error)。
 */
export function MailFab({
  emailMessageId,
  accountId,
  token,
  starred: initialStarred,
  inJunk,
  inArchive,
  canArchive,
  onChanged,
}: MailFabProps) {
  const [starred, setStarred] = useState(initialStarred);
  const [pending, setPending] = useState(false);
  /** 终端动作完成后为 true，MainButton 自动隐藏 */
  const [done, setDone] = useState(false);

  // props 塞 ref：runAction 里只从 ref 读，就不用在 useCallback deps 里列它们，
  // 同时永远拿到最新值，避免 biome 的 useExhaustiveDependencies 和 props 闭包冲突
  const propsRef = useRef({ emailMessageId, accountId, token });
  propsRef.current = { emailMessageId, accountId, token };

  const actions = useMemo<ActionDef[]>(() => {
    if (inArchive) {
      return [
        {
          id: "unarchive",
          label: "📥 移出归档",
          type: "default",
          terminal: true,
        },
      ];
    }
    if (inJunk) {
      return [
        {
          id: "toggle-star",
          label: starred ? "✅ 取消星标" : "⭐ 星标",
          type: "default",
          terminal: false,
        },
        {
          id: "move-to-inbox",
          label: "📥 移到收件箱",
          type: "default",
          terminal: true,
        },
        {
          id: "trash",
          label: "🗑 删除邮件",
          type: "destructive",
          terminal: true,
        },
      ];
    }
    // Inbox 默认
    const list: ActionDef[] = [
      {
        id: "toggle-star",
        label: starred ? "✅ 取消星标" : "⭐ 星标",
        type: "default",
        terminal: false,
      },
    ];
    if (canArchive) {
      list.push({
        id: "archive",
        label: "📥 归档",
        type: "default",
        terminal: true,
      });
    }
    list.push({
      id: "mark-as-junk",
      label: "🚫 标记为垃圾",
      type: "destructive",
      terminal: true,
    });
    return list;
  }, [inArchive, inJunk, canArchive, starred]);

  const runAction = useCallback(
    async (action: Action, isTerminal: boolean) => {
      const tg = getTelegram();
      const p = propsRef.current;
      setPending(true);
      try {
        const body: Record<string, unknown> = {
          accountId: p.accountId,
          token: p.token,
        };
        if (action === "toggle-star") body.starred = !starred;
        const raw = await api
          .post(`api/mail/${encodeURIComponent(p.emailMessageId)}/${action}`, {
            json: body,
          })
          .json();
        const res = okResponseSchema.parse(raw);
        if (res.ok) {
          tg?.HapticFeedback?.notificationOccurred("success");
          if (action === "toggle-star") setStarred(!starred);
          if (isTerminal) setDone(true);
          onChanged?.();
        } else {
          tg?.HapticFeedback?.notificationOccurred("error");
          tg?.showAlert?.(res.error ?? "操作失败");
        }
      } catch (e) {
        tg?.HapticFeedback?.notificationOccurred("error");
        tg?.showAlert?.(await extractErrorMessage(e));
      } finally {
        setPending(false);
      }
    },
    [starred, onChanged],
  );

  const handleMainButtonClick = useCallback(() => {
    if (actions.length === 0) return;
    if (actions.length === 1) {
      // 单动作：MainButton 直接执行，不走 popup
      const a = actions[0];
      runAction(a.id, a.terminal);
      return;
    }
    const tg = getTelegram();
    if (!tg?.showPopup) {
      // 兜底（极老的 TG 客户端没 showPopup）：直接跑第一个动作
      const a = actions[0];
      runAction(a.id, a.terminal);
      return;
    }
    tg.showPopup(
      {
        title: "邮件操作",
        message: "",
        buttons: actions.map<PopupButton>((a) => ({
          id: a.id,
          type: a.type,
          text: a.label,
        })),
      },
      (buttonId) => {
        // 用户取消（点外面 / swipe down）→ buttonId 是空串
        if (!buttonId) return;
        const a = actions.find((x) => x.id === buttonId);
        if (a) runAction(a.id, a.terminal);
      },
    );
  }, [actions, runAction]);

  const mainButtonText = done
    ? undefined
    : actions.length === 1
      ? actions[0].label
      : "⚡ 操作";

  useMainButton({
    text: mainButtonText,
    onClick: handleMainButtonClick,
    loading: pending,
    disabled: pending,
  });

  // 没渲染任何 DOM —— UI 全在 TG 宿主
  return null;
}
