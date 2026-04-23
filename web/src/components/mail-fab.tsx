import { useCallback, useMemo, useRef, useState } from "react";
import { api, extractErrorMessage } from "@/lib/api";
import { okResponseSchema } from "@/lib/schemas";
import {
  getTelegram,
  type PopupButton,
  useMainButton,
  useSecondaryButton,
} from "@/lib/tg";

export interface MailFabProps {
  emailMessageId: string;
  accountId: number;
  token: string;
  starred: boolean;
  inJunk: boolean;
  inArchive: boolean;
  canArchive: boolean;
  /** 邮件主题；用于分享时的预设文字 */
  subject?: string | null;
  /** 浏览器打开邮件的 URL；用作分享链接。缺失 → 不显示分享入口 */
  webMailUrl?: string | null;
  /** 跳到 TG 原消息的 deep link。缺失 → 不显示跳转入口 */
  tgMessageLink?: string | null;
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
  /** 执行后邮件就离开当前视图了（归档 / 垃圾 / 删除等），之后 MainButton 隐藏 */
  terminal: boolean;
}

type ExtraId = "share" | "tg-link";

interface ExtraDef {
  id: ExtraId;
  label: string;
  run: () => void;
}

/**
 * 邮件预览页的操作入口 —— 用 TG 原生 MainButton + SecondaryButton +
 * showPopup 做，**不渲染任何 DOM**。
 *
 *   MainButton "⚡ 操作" → popup: 星标 / 归档 / 标垃圾（按邮件状态）
 *   SecondaryButton     → 分享 + 跳 TG 原消息
 *     两者都有 → "🔗 更多" → popup 选
 *     只有一个 → 按钮直接做那个事
 *     都没有   → 隐藏
 *
 * popup 有 3 按钮硬上限，所以邮件状态动作和分享/跳转拆到两个原生按钮里。
 *
 * 成功后：HapticFeedback + onChanged() refetch 数据；terminal 动作（归档/删除/
 * 标垃圾/移出归档/移回）成功后 MainButton 自隐藏，SecondaryButton 保持（分享
 * 一封已归档的邮件仍有意义）。
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
  subject,
  webMailUrl,
  tgMessageLink,
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

  // ─── 邮件状态动作（MainButton） ────────────────────────────────────────

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
        // title + message 都不能为空：TG 客户端对 message 校验严格，
        // 空串会让 popup 静默不弹
        title: "邮件操作",
        message: "选择要执行的操作",
        buttons: actions.map<PopupButton>((a) => ({
          id: a.id,
          type: a.type,
          text: a.label,
        })),
      },
      (buttonId) => {
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
    // Main 用 TG 主题按钮蓝（accent），明确写出来和 Secondary 的色区分
    color: "#3b82f6",
    textColor: "#ffffff",
  });

  // ─── 分享 / 跳 TG 原消息（SecondaryButton） ──────────────────────────────

  const doShare = useCallback(() => {
    const tg = getTelegram();
    if (!webMailUrl) return;
    const shareText = subject ? `📧 ${subject}` : "";
    const shareLink =
      `https://t.me/share/url?url=${encodeURIComponent(webMailUrl)}` +
      `&text=${encodeURIComponent(shareText)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(shareLink);
    else window.open(shareLink, "_blank", "noopener");
  }, [webMailUrl, subject]);

  const doOpenTg = useCallback(() => {
    const tg = getTelegram();
    if (!tgMessageLink) return;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(tgMessageLink);
      // 某些 TG 客户端跳转后不会自动关 Mini App —— 兜底显式 close
      setTimeout(() => tg.close?.(), 50);
    } else {
      window.open(tgMessageLink, "_blank", "noopener");
    }
  }, [tgMessageLink]);

  const extras = useMemo<ExtraDef[]>(() => {
    const list: ExtraDef[] = [];
    if (webMailUrl) list.push({ id: "share", label: "📤 分享", run: doShare });
    if (tgMessageLink)
      list.push({ id: "tg-link", label: "💬 跳到 TG 原消息", run: doOpenTg });
    return list;
  }, [webMailUrl, tgMessageLink, doShare, doOpenTg]);

  const handleSecondaryButtonClick = useCallback(() => {
    if (extras.length === 0) return;
    if (extras.length === 1) {
      extras[0].run();
      return;
    }
    const tg = getTelegram();
    if (!tg?.showPopup) {
      extras[0].run();
      return;
    }
    tg.showPopup(
      {
        title: "更多",
        message: "选择要执行的操作",
        buttons: extras.map<PopupButton>((e) => ({
          id: e.id,
          type: "default",
          text: e.label,
        })),
      },
      (buttonId) => {
        if (!buttonId) return;
        const e = extras.find((x) => x.id === buttonId);
        if (e) e.run();
      },
    );
  }, [extras]);

  const secondaryButtonText =
    extras.length === 0
      ? undefined
      : extras.length === 1
        ? extras[0].label
        : "🔗 更多";

  useSecondaryButton({
    text: secondaryButtonText,
    onClick: handleSecondaryButtonClick,
    // position 'right' 表示 Secondary 放右边 → Main 自然在左边
    position: "right",
    // Secondary 用板岩灰填充，跟 Main 的蓝色拉开差距
    color: "#475569",
    textColor: "#ffffff",
  });

  // 没渲染任何 DOM —— UI 全在 TG 宿主
  return null;
}
