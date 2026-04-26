import { useCallback, useMemo } from "react";
import { useMainButton, useSecondaryButton } from "@/hooks/use-bottom-button";
import { type MailAction, useMailActions } from "@/hooks/use-mail-actions";
import { getTelegram, type PopupButton } from "@/providers/telegram";
import { THEME_COLORS } from "@/styles/theme";

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
  /** 当前 CORS 图片代理是否开启 —— 决定 SecondaryButton 里 toggle 文案 */
  useProxy: boolean;
  /** 切换 CORS 图片代理；点击 SecondaryButton 时调用，纯前端状态切换 */
  onToggleProxy: () => void;
  /** FAB 动作成功后通知父组件 refetch 预览数据；交给 caller 处理 */
  onChanged?: () => void;
}

interface ActionDef {
  id: MailAction;
  label: string;
  type: PopupButton["type"];
  /** 执行后邮件就离开当前视图了（归档 / 垃圾 / 删除等），之后 MainButton 隐藏 */
  terminal: boolean;
}

type ExtraId = "share" | "tg-link" | "toggle-proxy";

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
  useProxy,
  onToggleProxy,
  onChanged,
}: MailFabProps) {
  const { starred, done, pending, run } = useMailActions({
    emailMessageId,
    accountId,
    token,
    initialStarred,
    onChanged,
  });

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

  /**
   * 跑一个动作，处理 TG 端的 Haptic + 错误 alert。useMailActions 的 hook
   * 已经管 starred/done/pending 状态和 onChanged 回调，这里只负责 TG 特有的
   * 反馈 UI。toggle-star 用 hook 当前 starred 计算下一态。
   */
  const runWithFeedback = useCallback(
    async (action: MailAction) => {
      const tg = getTelegram();
      const starredNext = action === "toggle-star" ? !starred : undefined;
      const r = await run(action, starredNext);
      if (r.ok) {
        tg?.HapticFeedback?.notificationOccurred("success");
      } else {
        tg?.HapticFeedback?.notificationOccurred("error");
        tg?.showAlert?.(r.error ?? "操作失败");
      }
    },
    [run, starred],
  );

  const handleMainButtonClick = useCallback(() => {
    if (actions.length === 0) return;
    if (actions.length === 1) {
      // 单动作：MainButton 直接执行，不走 popup
      runWithFeedback(actions[0].id);
      return;
    }
    const tg = getTelegram();
    if (!tg?.showPopup) {
      // 兜底（极老的 TG 客户端没 showPopup）：直接跑第一个动作
      runWithFeedback(actions[0].id);
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
        if (a) runWithFeedback(a.id);
      },
    );
  }, [actions, runWithFeedback]);

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
    // Main 用 emerald accent（和 web / miniapp UI 主色一致），
    // 和 Secondary 的中性灰拉开差距
    color: THEME_COLORS.accent,
    textColor: THEME_COLORS.accentOn,
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
    // CORS 图片代理 toggle 总是出现在 SecondaryButton 里 —— 单独 extra 时
    // SecondaryButton 直接做 toggle；和分享/跳转共存时在「更多」popup 里选。
    list.push({
      id: "toggle-proxy",
      label: useProxy ? "🖼 关闭图片代理" : "🖼 开启图片代理",
      run: onToggleProxy,
    });
    return list;
  }, [webMailUrl, tgMessageLink, useProxy, doShare, doOpenTg, onToggleProxy]);

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
    // Secondary 用 zinc 中性填充，跟 Main 的 emerald 拉开差距
    color: THEME_COLORS.neutral,
    textColor: THEME_COLORS.neutralOn,
  });

  // 没渲染任何 DOM —— UI 全在 TG 宿主
  return null;
}
