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
  /** 当前 CORS 图片代理是否开启 —— 决定 SecondaryButton 文案 */
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

/**
 * 邮件预览页的操作入口 —— 用 TG 原生 MainButton + SecondaryButton +
 * showPopup 做，**不渲染任何 DOM**。
 *
 *   MainButton "⚡ 操作" → popup: 星标 / 归档 / 标垃圾（按邮件状态）
 *   SecondaryButton     → 一键切换 CORS 图片代理（直接 toggle，不走 popup）
 *
 * popup 有 3 按钮硬上限，所以邮件状态动作单独走 MainButton；SecondaryButton
 * 留给图片代理 toggle —— 高频操作（一封邮件可能反复切换）适合一键，不再
 * 走「更多」popup 选项。
 *
 * 成功后：HapticFeedback + onChanged() refetch 数据；terminal 动作（归档/删除/
 * 标垃圾/移出归档/移回）成功后 MainButton 自隐藏。
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

  // ─── 图片代理 toggle（SecondaryButton） ────────────────────────────────

  const handleSecondaryButtonClick = useCallback(() => {
    const tg = getTelegram();
    tg?.HapticFeedback?.impactOccurred("light");
    onToggleProxy();
  }, [onToggleProxy]);

  useSecondaryButton({
    text: useProxy ? "🖼 关闭图片代理" : "🖼 开启图片代理",
    onClick: handleSecondaryButtonClick,
    // position 'bottom'：Secondary 落在 Main 下方独占一行（全宽横向按钮）。
    // 用 'left' / 'right' 时 Mac / Desktop TG 客户端会把 Secondary 渲染成
    // 窄方块，中文文案被压成竖排（每个字一行），跟全宽横向的 Main 风格不
    // 一致；mobile 上 left/right 才是平分宽度。bottom 是跨平台最稳的选项。
    position: "bottom",
    // Secondary 用 zinc 中性填充，跟 Main 的 emerald 拉开差距
    color: THEME_COLORS.neutral,
    textColor: THEME_COLORS.neutralOn,
  });

  // 没渲染任何 DOM —— UI 全在 TG 宿主
  return null;
}
