import { useRouter } from "@tanstack/react-router";
import {
  closeMiniApp,
  offBackButtonClick,
  onBackButtonClick,
  showBackButton,
} from "@telegram-apps/sdk-react";
import { useEffect } from "react";

// BackButton 始终显示 —— TG 客户端（特别是 macOS Desktop WebView）在 SPA 路由
// 切换后会自动把 BackButton 状态回弹到 visible，反复抹掉只会闪烁。干脆始终显示，
// 按 targetUrl 决定点击行为：
//   targetUrl 有  → SPA 跳过去（router.history.push，避免 window.location.href
//                  硬刷新跟 SDK postMessage 时序撞车）
//   targetUrl 无  → closeMiniApp 关掉小程序（根页 = 没有上一页可退，直接退出）
//
// 非 TG 环境 / 老客户端：SDK 自身的 isAvailable 兜底，全部 no-op。
export function useBackButton(targetUrl: string | undefined): void {
  const router = useRouter();

  useEffect(() => {
    const handler = targetUrl
      ? () => router.history.push(targetUrl)
      : () => {
          if (closeMiniApp.isAvailable()) closeMiniApp();
        };
    if (showBackButton.isAvailable()) showBackButton();
    if (onBackButtonClick.isAvailable()) onBackButtonClick(handler);
    return () => {
      if (offBackButtonClick.isAvailable()) offBackButtonClick(handler);
    };
  }, [targetUrl, router]);
}
