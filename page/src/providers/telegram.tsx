import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { THEME_COLORS } from "@/styles/theme";

export type PopupButtonType =
  | "default"
  | "destructive"
  | "ok"
  | "close"
  | "cancel";

export interface PopupButton {
  id?: string;
  type?: PopupButtonType;
  text?: string;
}

export interface PopupParams {
  title?: string;
  message: string;
  buttons?: PopupButton[];
}

export interface TelegramMainButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  setParams: (params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }) => void;
}

export interface TelegramSecondaryButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  setParams: (params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
    position?: "left" | "right" | "top" | "bottom";
  }) => void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    start_param?: string;
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
  };
  version?: string;
  platform?: string;
  colorScheme?: "light" | "dark";
  isVerticalSwipesEnabled?: boolean;
  isFullscreen?: boolean;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  ready: () => void;
  expand: () => void;
  close?: () => void;
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  /** Bot API 8.0+。老客户端上是 undefined，调用前要判存在。 */
  requestFullscreen?: () => void;
  /** Bot API 8.0+。 */
  exitFullscreen?: () => void;
  /** 判断宿主客户端是否 ≥ 指定 Bot API 版本。 */
  isVersionAtLeast?: (version: string) => boolean;
  /**
   * Bot API 6.1+ 支持 "bg_color" / "secondary_bg_color" 主题键；
   * 6.9+ 额外支持 `#RRGGBB` 字面 hex。
   */
  setHeaderColor?: (color: string) => void;
  /** Bot API 6.1+，hex 从 6.9+ 开始支持。 */
  setBackgroundColor?: (color: string) => void;
  /** Bot API 7.10+。 */
  setBottomBarColor?: (color: string) => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  showConfirm?: (msg: string, cb: (ok: boolean) => void) => void;
  showAlert?: (msg: string, cb?: () => void) => void;
  showPopup?: (params: PopupParams, cb?: (buttonId: string) => void) => void;
  MainButton?: TelegramMainButton;
  SecondaryButton?: TelegramSecondaryButton;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  /** Mini App 右上角 ⋮ 菜单里的 "Settings" 入口；无文本、无样式 —— 纯 onClick 回调。
   *  对象存在性：Bot API 6.1+（仅 `settingsButtonClicked` 事件）。
   *  下面这些方法：Bot API **7.0+**。
   *  另外 @BotFather 必须把 bot 的 menu button 配为 "settings"，否则 show() 是 no-op。 */
  SettingsButton?: {
    isVisible?: boolean;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  HapticFeedback?: {
    notificationOccurred: (kind: "success" | "warning" | "error") => void;
    impactOccurred: (kind: "light" | "medium" | "heavy") => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegram(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  return getTelegram()?.initData ?? "";
}

/**
 * iPad 嗅探 —— TG `tg.platform` 对 iPhone / iPad 都返回 `"ios"`，只能靠
 * UA + touch 区分。iPadOS 13+ 默认伪装成 Mac UA，所以加一个 touch 兜底。
 */
function isIPad(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return true;
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

const TelegramContext = createContext<TelegramWebApp | null>(null);

// 挂根部一次。Back/Main/Secondary 按钮的可见性由子页面各自声明 —— React
// effect 运行顺序是子先于父，这里 show/hide 会被子组件覆盖。
//
// Mini App 永远走 zinc/emerald 固定深色（和 web 一致），不跟 TG 客户端的
// light/dark，所以不再监听 themeChanged。
//
// 仅 iPad 请求 Bot API 8.0 的 `requestFullscreen()`：TG 客户端会收起常规
// 标题栏，换成顶部的浮动 pill + 菜单，和 BotFather 的 chrome 观感一致。
// iPhone 和桌面 TG 保持传统标题栏。老客户端没这方法自动跳过。
export function TelegramProvider({ children }: { children: ReactNode }) {
  const [tg] = useState<TelegramWebApp | null>(() => getTelegram());

  useEffect(() => {
    // TG SDK 无条件加载（web 页面也会跑到这里），但只在真正的 TG session
    // 里才做 TG-specific 初始化 —— `initData` 非空是 TG 客户端启动的可靠
    // 信号（浏览器里直接开 `/mail/:id` 这类 web 页时 SDK stub 存在但
    // `initData` 为空字符串）。
    if (!tg || !tg.initData) return;
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    // 把 TG 客户端绘制的 header / background / bottom-bar 染成我们的 zinc-950
    // —— 非 fullscreen 模式下 TG 默认会跟客户端 light/dark 主题走，导致标题
    // 栏或下拉回弹区域漏出浅色。用字面 hex 而不是 "bg_color" 主题键，免得
    // 跟 TG 自己的主题变量耦合。
    // 版本要求：setHeaderColor/setBackgroundColor 接受 hex 从 6.9+；
    // setBottomBarColor 从 7.10+。
    if (tg.isVersionAtLeast?.("6.9")) {
      tg.setHeaderColor?.(THEME_COLORS.bg);
      tg.setBackgroundColor?.(THEME_COLORS.bg);
    }
    if (tg.isVersionAtLeast?.("7.10")) {
      tg.setBottomBarColor?.(THEME_COLORS.bg);
    }
    if (
      isIPad() &&
      tg.isVersionAtLeast?.("8.0") &&
      tg.requestFullscreen &&
      !tg.isFullscreen
    ) {
      tg.requestFullscreen();
    }
  }, [tg]);

  return (
    <TelegramContext.Provider value={tg}>{children}</TelegramContext.Provider>
  );
}

export function useTelegram(): TelegramWebApp | null {
  return useContext(TelegramContext);
}
