import { THEME_COLORS } from "@page/styles/theme";
import {
  bindViewportCssVars,
  disableVerticalSwipes,
  expandViewport,
  init,
  isFullscreen,
  isTMA,
  miniAppReady,
  mountBackButton,
  mountMainButton,
  mountMiniAppSync,
  mountSecondaryButton,
  mountSettingsButton,
  mountSwipeBehavior,
  mountThemeParamsSync,
  mountViewport,
  requestFullscreen,
  retrieveLaunchParams,
  retrieveRawInitData,
  setMiniAppBackgroundColor,
  setMiniAppBottomBarColor,
  setMiniAppHeaderColor,
} from "@telegram-apps/sdk-react";
import { type ReactNode, useEffect } from "react";

/** Raw initData 头给 ky 用（`api/client.ts` 注入到 `X-Telegram-Init-Data`）。
 *  非 TG 环境下 SDK 抛 `LaunchParamsRetrieveError`，吞掉返回空串。 */
export function getInitData(): string {
  try {
    return retrieveRawInitData() ?? "";
  } catch {
    return "";
  }
}

function isMobilePlatform(): boolean {
  try {
    const p = retrieveLaunchParams().tgWebAppPlatform;
    return p === "ios" || p === "android" || p === "android_x";
  } catch {
    return false;
  }
}

/**
 * 挂根部一次。`isTMA()` 同步嗅探当前环境是不是 TG WebApp（试着从 URL hash /
 * sessionStorage 解 launch params）—— 浏览器里直接打开 web 路由（`/mail/:id` 等）
 * 会走这里但不在 TG，跳过所有 SDK 操作。
 *
 * Bot API 版本和功能可用性由各自 `xxx.isAvailable()` 在 SDK 内部判断；调用前不
 * 必再手写 `isVersionAtLeast`。
 *
 * Mini App 永远走 zinc/emerald 固定深色（和 web 一致），不跟 TG 客户端的
 * light/dark，所以直接 `setMiniAppHeaderColor(THEME_COLORS.bg)` 等覆盖。
 *
 * 移动端（iOS / Android）请求 Bot API 8.0 的 `requestFullscreen()`：手机屏幕小，
 * 多挤出 ~50px 给内容用。`bindViewportCssVars()` 把 viewport state 镜像到
 * `--tg-viewport-*` CSS 变量，`app.css` 里 body padding sum 两套 inset
 * （safe-area + content-safe-area）避开刘海 / 浮动 chrome。
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (!isTMA()) return;

    const cleanup = init();

    // 同步 mount —— 这些 component 的 mount 立即完成，后续 setParams / show 等
    // 调用马上能用。每步 isAvailable 兜底，老客户端没的功能直接跳过。
    if (mountMiniAppSync.isAvailable()) mountMiniAppSync();
    if (mountThemeParamsSync.isAvailable()) mountThemeParamsSync();
    if (mountBackButton.isAvailable()) mountBackButton();
    if (mountMainButton.isAvailable()) mountMainButton();
    if (mountSecondaryButton.isAvailable()) mountSecondaryButton();
    if (mountSettingsButton.isAvailable()) mountSettingsButton();
    if (mountSwipeBehavior.isAvailable()) mountSwipeBehavior();

    if (miniAppReady.isAvailable()) miniAppReady();
    if (disableVerticalSwipes.isAvailable()) disableVerticalSwipes();

    if (setMiniAppHeaderColor.isAvailable())
      setMiniAppHeaderColor(THEME_COLORS.bg);
    if (setMiniAppBackgroundColor.isAvailable())
      setMiniAppBackgroundColor(THEME_COLORS.bg);
    if (setMiniAppBottomBarColor.isAvailable())
      setMiniAppBottomBarColor(THEME_COLORS.bg);

    // viewport mount 是异步的（要等 TG 把状态 postMessage 回来），expand /
    // requestFullscreen 这些依赖 viewport 已 mount 才能 isAvailable=true，
    // 所以链在 .then 里跑。组件卸载用 aborted 防 race。
    let aborted = false;
    if (mountViewport.isAvailable()) {
      mountViewport()
        .then(() => {
          if (aborted) return;
          // 把 viewport state（safe-area / content-safe-area / height 等）镜像
          // 到 CSS 变量，`app.css` 里 body padding 读这些 var 给浮动 chrome / 刘海
          // 留位。SDK 默认前缀是 `--tg-viewport-*`，由 app.css 直接消费。
          if (bindViewportCssVars.isAvailable()) bindViewportCssVars();
          if (expandViewport.isAvailable()) expandViewport();
          if (
            isMobilePlatform() &&
            requestFullscreen.isAvailable() &&
            !isFullscreen()
          ) {
            requestFullscreen().catch(() => {
              // 手机不支持 / 用户拒绝 / TG 已经全屏 —— 都吞掉
            });
          }
        })
        .catch(() => {});
    }

    return () => {
      aborted = true;
      cleanup();
    };
  }, []);

  return <>{children}</>;
}
