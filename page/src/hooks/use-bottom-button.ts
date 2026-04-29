import {
  hideSettingsButton,
  offMainButtonClick,
  offSecondaryButtonClick,
  offSettingsButtonClick,
  onMainButtonClick,
  onSecondaryButtonClick,
  onSettingsButtonClick,
  type RGB,
  type SecondaryButtonPosition,
  setMainButtonParams,
  setSecondaryButtonParams,
  showSettingsButton,
} from "@telegram-apps/sdk-react";
import { useEffect } from "react";

export interface MainButtonConfig {
  text: string | undefined;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  color?: RGB;
  textColor?: RGB;
}

export interface SecondaryButtonConfig extends MainButtonConfig {
  position?: SecondaryButtonPosition;
}

// SDK 的 setParams 一次性提交所有变更，比之前 `setText` + `enable/disable` +
// `show/hide` 多次调用更稳，老 Android 客户端在分段调用时的兼容坑
// (vkruglikov/react-telegram-web-app #69) 也避开了。
export function useMainButton({
  text,
  onClick,
  loading,
  disabled,
  color,
  textColor,
}: MainButtonConfig): void {
  const visible = Boolean(text);

  useEffect(() => {
    if (!setMainButtonParams.isAvailable()) return;
    setMainButtonParams({
      ...(text ? { text } : {}),
      isVisible: visible,
      isEnabled: !(disabled || loading),
      isLoaderVisible: !!loading,
      ...(color ? { backgroundColor: color } : {}),
      ...(textColor ? { textColor } : {}),
    });
    return () => {
      if (setMainButtonParams.isAvailable())
        setMainButtonParams({ isVisible: false, isLoaderVisible: false });
    };
  }, [text, visible, loading, disabled, color, textColor]);

  useEffect(() => {
    if (!text || !onMainButtonClick.isAvailable()) return;
    onMainButtonClick(onClick);
    return () => {
      if (offMainButtonClick.isAvailable()) offMainButtonClick(onClick);
    };
  }, [onClick, text]);
}

export function useSecondaryButton({
  text,
  onClick,
  loading,
  disabled,
  color,
  textColor,
  position,
}: SecondaryButtonConfig): void {
  const visible = Boolean(text);

  useEffect(() => {
    if (!setSecondaryButtonParams.isAvailable()) return;
    setSecondaryButtonParams({
      ...(text ? { text } : {}),
      isVisible: visible,
      isEnabled: !(disabled || loading),
      isLoaderVisible: !!loading,
      ...(color ? { backgroundColor: color } : {}),
      ...(textColor ? { textColor } : {}),
      ...(position ? { position } : {}),
    });
    return () => {
      if (setSecondaryButtonParams.isAvailable())
        setSecondaryButtonParams({ isVisible: false, isLoaderVisible: false });
    };
  }, [text, visible, loading, disabled, color, textColor, position]);

  useEffect(() => {
    if (!text || !onSecondaryButtonClick.isAvailable()) return;
    onSecondaryButtonClick(onClick);
    return () => {
      if (offSecondaryButtonClick.isAvailable())
        offSecondaryButtonClick(onClick);
    };
  }, [onClick, text]);
}

/** TG SettingsButton（右上角 ⋮ 里的 "Settings" 入口）。`onClick` 缺失 → 隐藏；
 *  Bot API < 7.0 / 浏览器 / @BotFather 未配 menu button = settings → SDK
 *  isAvailable 返回 false，全部 no-op，由 caller 自行 fallback。 */
export function useSettingsButton(onClick: (() => void) | undefined): void {
  useEffect(() => {
    if (!onClick) {
      if (hideSettingsButton.isAvailable()) hideSettingsButton();
      return;
    }
    if (onSettingsButtonClick.isAvailable()) onSettingsButtonClick(onClick);
    if (showSettingsButton.isAvailable()) showSettingsButton();
    return () => {
      if (offSettingsButtonClick.isAvailable()) offSettingsButtonClick(onClick);
      if (hideSettingsButton.isAvailable()) hideSettingsButton();
    };
  }, [onClick]);
}
