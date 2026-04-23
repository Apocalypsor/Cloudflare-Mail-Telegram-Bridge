import { useEffect } from "react";
import {
  getTelegram,
  type TelegramMainButton,
  type TelegramSecondaryButton,
} from "@/providers/telegram";

export interface MainButtonConfig {
  /** 按钮显示文字；undefined = 隐藏按钮 */
  text: string | undefined;
  onClick: () => void;
  /** true = 显示内置 progress 指示器（loading 态），按钮自动变半透明 */
  loading?: boolean;
  /** 禁用（灰色、不可点），默认 false */
  disabled?: boolean;
  /** 背景填充色（hex，`#RRGGBB`）；不设 → 跟 TG 主题 */
  color?: string;
  /** 文字颜色（hex）；不设 → 跟 TG 主题 */
  textColor?: string;
}

export interface SecondaryButtonConfig extends MainButtonConfig {
  /** Secondary 相对 Main 的位置；默认 "right"（Main 在左 / Secondary 在右） */
  position?: "left" | "right" | "top" | "bottom";
}

/**
 * MainButton / SecondaryButton 的公共行为 —— 拆成三个 useEffect，按职责隔离
 * 依赖，**避免状态切换（比如点星标 loading → idle）导致按钮 hide → show
 * 闪烁**。
 *
 * 1) 可见性：只依赖 `visible`（text 是否非空）。状态 flip 时才 hide/show。
 * 2) 配置：setText / enable / showProgress / color / position，只 mutate，
 *    不碰可见性。
 * 3) 点击：onClick / offClick，视觉上透明。
 *
 * `text` / `is_active` / `is_visible` 走 `setText` + `enable/disable` +
 * `show/hide` 三段而不是 `setParams`：Android 客户端历史上对 `setParams` 的
 * 可见性 / 启用状态组合有兼容问题（vkruglikov/react-telegram-web-app #69）。
 * `color` / `text_color` / `position` 不受那个 bug 影响，走 `setParams`。
 */
function useBottomButton(
  getBtn: () => TelegramMainButton | TelegramSecondaryButton | undefined,
  config: SecondaryButtonConfig,
): void {
  const { text, onClick, loading, disabled, color, textColor, position } =
    config;
  const visible = Boolean(text);

  // 1) 可见性
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

  // 2) 配置（文字 / 启用 / 进度 / 颜色 / 位置）
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

  // 3) 点击
  useEffect(() => {
    const btn = getBtn();
    if (!btn || !text) return;
    btn.onClick(onClick);
    return () => {
      btn.offClick(onClick);
    };
  }, [onClick, text, getBtn]);
}

// getBtn 用 module-level 稳定引用，避免 useBottomButton 的 deps 无限变
const getMainButton = () => getTelegram()?.MainButton;
const getSecondaryButton = () => getTelegram()?.SecondaryButton;

/** 页面声明 MainButton。详见 `useBottomButton`。 */
export function useMainButton(config: MainButtonConfig): void {
  useBottomButton(getMainButton, config);
}

/** 页面声明 SecondaryButton（Bot API 7.10+）。老客户端无此 API，自动 no-op。 */
export function useSecondaryButton(config: SecondaryButtonConfig): void {
  useBottomButton(getSecondaryButton, config);
}
