import { useEffect } from "react";
import { getTelegram } from "@/providers/telegram";

/**
 * 页面声明 BackButton 行为：
 *   useBackButton(url)        → 显示返回键，点击 location.href = url
 *   useBackButton(undefined)  → 隐藏返回键（根页面）
 *
 * 卸载时自动 hide + 摘 handler。每页调用一次。
 */
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
