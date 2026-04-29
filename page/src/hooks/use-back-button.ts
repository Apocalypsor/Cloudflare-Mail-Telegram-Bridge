import {
  hideBackButton,
  offBackButtonClick,
  onBackButtonClick,
  showBackButton,
} from "@telegram-apps/sdk-react";
import { useEffect } from "react";

// useBackButton(url)        → 显示，点击跳 url
// useBackButton(undefined)  → 隐藏（根页面）
// 非 TG 环境 / 老客户端 SDK 自身的 isAvailable 兜底，全部 no-op。
export function useBackButton(targetUrl: string | undefined): void {
  useEffect(() => {
    if (!targetUrl) {
      if (hideBackButton.isAvailable()) hideBackButton();
      return;
    }
    const handler = () => {
      window.location.href = targetUrl;
    };
    if (showBackButton.isAvailable()) showBackButton();
    if (onBackButtonClick.isAvailable()) onBackButtonClick(handler);
    return () => {
      if (offBackButtonClick.isAvailable()) offBackButtonClick(handler);
      if (hideBackButton.isAvailable()) hideBackButton();
    };
  }, [targetUrl]);
}
