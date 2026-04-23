import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Telegram WebApp SDK 集中地：类型 + 取 TG 实例的原语 + React Provider /
 * `useTelegram` hook。
 *
 * TG 实例本质是 `window.Telegram.WebApp`（全局单例），所以两种访问方式都有：
 *   - `getTelegram()` 模块级同步函数，供 callback / 非 React 代码用（比如
 *     事件回调里要立即取一下 `HapticFeedback`）
 *   - `useTelegram()` React hook，订阅 context；组件里用，强制在 Provider 下
 */

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** showPopup 按钮类型，映射到 TG 原生渲染（destructive 会渲染为红色等）。 */
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
  buttons?: PopupButton[]; // max 3
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

/** SecondaryButton — Bot API 7.10+ (2024-09)。与 MainButton 并排显示在底部，
 *  接口和 MainButton 近乎一致，多一个 `position` 参数控位。 */
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
  /** "light" | "dark"，由 TG 宿主按当前主题推断 */
  colorScheme?: "light" | "dark";
  /** 垂直滑动关闭的开关（Bot API 7.7+） */
  isVerticalSwipesEnabled?: boolean;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  ready: () => void;
  expand: () => void;
  close?: () => void;
  /** Bot API 7.7+：禁止手势下滑关闭，避免误触（长列表滑到顶部继续拉会触发） */
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  showConfirm?: (msg: string, cb: (ok: boolean) => void) => void;
  showAlert?: (msg: string, cb?: () => void) => void;
  /** 原生弹窗；按钮数量 <= 3。点击后 cb 拿到按钮 id（未设 id 时是空字符串）。 */
  showPopup?: (params: PopupParams, cb?: (buttonId: string) => void) => void;
  MainButton?: TelegramMainButton;
  /** Bot API 7.10+：底部副按钮，和 MainButton 并排 */
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

// ─── 模块级原语 ────────────────────────────────────────────────────────────

/** 直接从 `window.Telegram.WebApp` 取；非 TG 环境（比如本地浏览器直接访问
 *  Pages preview）返回 null。 */
export function getTelegram(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

/** 获取 initData；非 TG 环境返回空字符串，后端 401 会自然拒绝 */
export function getInitData(): string {
  return getTelegram()?.initData ?? "";
}

/** 把当前 TG colorScheme 写到 `<html data-theme>`，HeroUI 主题跟着切。
 *  非 TG 环境（本地 Vite）落到系统偏好。 */
function syncThemeFromTelegram(): void {
  if (typeof document === "undefined") return;
  const tg = getTelegram();
  const scheme =
    tg?.colorScheme ??
    (window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  document.documentElement.dataset.theme = scheme;
  document.documentElement.classList.toggle("dark", scheme === "dark");
}

// ─── Provider + hook ───────────────────────────────────────────────────────

const TelegramContext = createContext<TelegramWebApp | null>(null);

/**
 * 挂在 App 根部一次。
 *   - ready + expand + disableVerticalSwipes 一把 TG chrome 初始化
 *   - 监听 themeChanged 事件，实时同步 `data-theme`
 *   - 把 TG 实例通过 context 吐给子树
 *
 * **不碰 BackButton / MainButton / SecondaryButton** —— 那几个按钮由各自的
 * 子页面用 hook 声明状态；父组件 hide 会和子组件 show 冲突（React effect
 * 运行顺序是子先于父）。
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  const [tg] = useState<TelegramWebApp | null>(() => getTelegram());

  useEffect(() => {
    syncThemeFromTelegram();
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    tg.onEvent?.("themeChanged", syncThemeFromTelegram);
    return () => {
      tg.offEvent?.("themeChanged", syncThemeFromTelegram);
    };
  }, [tg]);

  return (
    <TelegramContext.Provider value={tg}>{children}</TelegramContext.Provider>
  );
}

/** 组件内订阅 TG 实例。非 TG 环境下拿到 null —— 调用方需要自己 null-safe
 *  （例如 `tg?.HapticFeedback?.notificationOccurred("success")`）。 */
export function useTelegram(): TelegramWebApp | null {
  return useContext(TelegramContext);
}
