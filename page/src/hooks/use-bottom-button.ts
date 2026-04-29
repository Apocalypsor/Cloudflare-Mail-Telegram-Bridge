import { useEffect } from "react";
import {
  getTelegram,
  type TelegramMainButton,
  type TelegramSecondaryButton,
} from "@/providers/telegram";

export interface MainButtonConfig {
  text: string | undefined;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  color?: string;
  textColor?: string;
}

export interface SecondaryButtonConfig extends MainButtonConfig {
  position?: "left" | "right" | "top" | "bottom";
}

// 拆三个 effect：可见性 / 配置 / 点击。避免 loading 切换时整块 hide→show
// 闪烁（之前一锅 effect + 单 cleanup 调 hide 就是这个 bug）。
//
// `setText` + `enable/disable` + `show/hide` 走三段单方法调用，不用
// `setParams({is_active, is_visible})` —— Android 客户端老有兼容坑
// （vkruglikov/react-telegram-web-app #69）。color/position 不受影响，
// 安心走 setParams。
function useBottomButton(
  getBtn: () => TelegramMainButton | TelegramSecondaryButton | undefined,
  config: SecondaryButtonConfig,
): void {
  const { text, onClick, loading, disabled, color, textColor, position } =
    config;
  const visible = Boolean(text);

  useEffect(() => {
    const btn = getBtn();
    if (!btn) return;
    if (visible) {
      btn.show();
      return () => {
        btn.hideProgress();
        btn.hide();
      };
    }
    btn.hide();
  }, [visible, getBtn]);

  useEffect(() => {
    const btn = getBtn();
    if (!btn || !text) return;
    btn.setText(text);
    if (disabled || loading) btn.disable();
    else btn.enable();
    if (loading) btn.showProgress(false);
    else btn.hideProgress();
    const params: {
      color?: string;
      text_color?: string;
      position?: "left" | "right" | "top" | "bottom";
    } = {};
    if (color) params.color = color;
    if (textColor) params.text_color = textColor;
    if (position) params.position = position;
    if (Object.keys(params).length > 0) {
      (btn.setParams as (p: typeof params) => void)(params);
    }
  }, [text, loading, disabled, color, textColor, position, getBtn]);

  useEffect(() => {
    const btn = getBtn();
    if (!btn || !text) return;
    btn.onClick(onClick);
    return () => {
      btn.offClick(onClick);
    };
  }, [onClick, text, getBtn]);
}

const getMainButton = () => getTelegram()?.MainButton;
const getSecondaryButton = () => getTelegram()?.SecondaryButton;

export function useMainButton(config: MainButtonConfig): void {
  useBottomButton(getMainButton, config);
}

export function useSecondaryButton(config: SecondaryButtonConfig): void {
  useBottomButton(getSecondaryButton, config);
}

/** TG SettingsButton（右上角 ⋮ 里的 "Settings" 入口）。`onClick` 缺失 → 隐藏；
 *  方法不存在（Bot API < 7.0 / 浏览器 / @BotFather 未配 menu button = settings）
 *  → 静默无操作，由 caller 自行 fallback 渲染入口。
 *  检测用 `typeof show === "function"`：仅靠对象存在不够，6.1-6.9 可能暴露事件
 *  但没方法。 */
export function useSettingsButton(onClick: (() => void) | undefined): void {
  useEffect(() => {
    const btn = getTelegram()?.SettingsButton;
    if (!btn || typeof btn.show !== "function") return;
    if (!onClick) {
      btn.hide();
      return;
    }
    btn.onClick(onClick);
    btn.show();
    return () => {
      btn.offClick(onClick);
      btn.hide();
    };
  }, [onClick]);
}
