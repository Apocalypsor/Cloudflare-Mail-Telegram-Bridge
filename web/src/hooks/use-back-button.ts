import { useEffect } from "react";
import { getTelegram } from "@/providers/telegram";

// useBackButton(url)        → 显示，点击跳 url
// useBackButton(undefined)  → 隐藏（根页面）
export function useBackButton(targetUrl: string | undefined): void {
  useEffect(() => {
    const bb = getTelegram()?.BackButton;
    if (!bb) return;
    if (!targetUrl) {
      bb.hide();
      return;
    }
    const handler = () => {
      window.location.href = targetUrl;
    };
    bb.show();
    bb.onClick(handler);
    return () => {
      bb.offClick(handler);
      bb.hide();
    };
  }, [targetUrl]);
}
