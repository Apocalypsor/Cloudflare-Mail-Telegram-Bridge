import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

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
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
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
