import { useEffect, useRef } from "react";
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

  // 点击 handler 走 ref：每次 onClick 变（label 切换、props 变都会让上层
  // useCallback 重建）就 register/unregister 一轮，Mac TG Desktop 几次循环
  // 后会进入 onClick 不再 fire 的死锁状态。这里只在按钮可见性变化时重新
  // 挂一个稳定 wrapper，wrapper 跑的时候去 ref 里读最新 callback。
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onClickRef.current = onClick;
  });

  useEffect(() => {
    const btn = getBtn();
    if (!btn || !visible) return;
    const wrapped = () => onClickRef.current();
    btn.onClick(wrapped);
    return () => {
      btn.offClick(wrapped);
    };
  }, [visible, getBtn]);
}

const getMainButton = () => getTelegram()?.MainButton;
const getSecondaryButton = () => getTelegram()?.SecondaryButton;

export function useMainButton(config: MainButtonConfig): void {
  useBottomButton(getMainButton, config);
}

export function useSecondaryButton(config: SecondaryButtonConfig): void {
  useBottomButton(getSecondaryButton, config);
}
