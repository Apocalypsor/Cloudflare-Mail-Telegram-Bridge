import { useEffect } from "react";

/**
 * Telegram WebApp SDK wrapper：在 TG WebView 里 `window.Telegram.WebApp` 由
 * `telegram-web-app.js` 注入；非 TG 环境（本地 Vite 直连预览）下返回 null。
 * 组件里统一用 `getTelegram()` 取，null-safe 调用。
 */

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
  /** Bot API 7.10+：底部副按钮，和 MainButton 并排。老客户端 undefined，
   *  useSecondaryButton 自动 no-op */
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

/** 获取 initData；非 TG 环境返回空字符串，后端 401 会自然拒绝 */
export function getInitData(): string {
  return getTelegram()?.initData ?? "";
}

/** 把当前 TG colorScheme 写到 `<html data-theme>`，HeroUI 主题跟着切。
 *  非 TG 环境（本地 Vite）落到系统偏好。 */
export function syncThemeFromTelegram(): void {
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

/**
 * App 启动时调用一次：ready + expand + 主题 + 禁垂直滑动。
 *
 * `disableVerticalSwipes()`：Mini App 内部滚长列表到顶部还继续拉会触发"下滑
 * 关闭"，误触体验差。应用级默认关掉。老 TG 客户端（< 7.7）没这个方法，调用
 * 直接走到 undefined 的 `?.` 无副作用。
 *
 * **注意不碰 BackButton / MainButton / SecondaryButton**。那几个按钮由页面
 * 自己的 hook 声明状态；父组件 hide 会和子组件 show 冲突（React effect 运行
 * 顺序是子先于父）。
 */
export function initTelegramChrome(): void {
  const tg = getTelegram();
  syncThemeFromTelegram();
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.onEvent?.("themeChanged", syncThemeFromTelegram);
}

/**
 * 页面声明 BackButton 行为：
 *   useBackButton(url)        → 显示返回键，点击 location.href = url
 *   useBackButton(undefined)  → 隐藏返回键（根页面）
 */
export function useBackButton(targetUrl: string | undefined): void {
  useEffect(() => {
    const tg = getTelegram();
    const bb = tg?.BackButton;
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

export interface MainButtonConfig {
  /** 按钮显示文字；undefined = 隐藏按钮 */
  text: string | undefined;
  onClick: () => void;
  /** true = 显示内置 progress 指示器（loading 态），按钮自动变半透明 */
  loading?: boolean;
  /** 禁用（灰色、不可点），默认 false */
  disabled?: boolean;
  /** 背景填充色（hex，`#RRGGBB`）；不设 → 跟 TG 主题 */
  color?: string;
  /** 文字颜色（hex）；不设 → 跟 TG 主题 */
  textColor?: string;
}

export interface SecondaryButtonConfig extends MainButtonConfig {
  /** Secondary 相对 Main 的位置；默认 "right"（Main 在左 / Secondary 在右） */
  position?: "left" | "right" | "top" | "bottom";
}

/**
 * MainButton / SecondaryButton 的公共行为：挂文字 + 启用 / 进度 / 可见性 +
 * 配色 + 位置（仅 Secondary），卸载自动 hide + offClick。
 *
 * `text` / `is_active` / `is_visible` 走 `setText` + `enable/disable` +
 * `show/hide` 三段而不是 `setParams`：Android 客户端历史上对 `setParams` 的
 * 可见性 / 启用状态组合有兼容问题（见 vkruglikov/react-telegram-web-app
 * discussion #69 / 类似 issue 一堆）。三段式是 TG 官方示例的写法，所有客户端
 * 都稳。
 *
 * `color` / `text_color` / `position` 不受那个 bug 影响，可以走 `setParams`
 * 单独下发。
 */
function useBottomButton(
  getBtn: () => TelegramMainButton | TelegramSecondaryButton | undefined,
  config: SecondaryButtonConfig,
): void {
  const { text, onClick, loading, disabled, color, textColor, position } =
    config;
  useEffect(() => {
    const btn = getBtn();
    if (!btn) return;
    if (!text) {
      btn.hide();
      return;
    }
    btn.setText(text);
    if (disabled || loading) btn.disable();
    else btn.enable();
    if (loading) btn.showProgress(false);
    else btn.hideProgress();
    // 颜色 / 位置用 setParams 单独下发，避免 is_active / is_visible 的兼容坑
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
    btn.show();
    btn.onClick(onClick);
    return () => {
      btn.offClick(onClick);
      btn.hideProgress();
      btn.hide();
    };
  }, [text, onClick, loading, disabled, color, textColor, position, getBtn]);
}

const getMainButton = () => getTelegram()?.MainButton;
const getSecondaryButton = () => getTelegram()?.SecondaryButton;

/** 页面声明 MainButton。详见 `useBottomButton`。 */
export function useMainButton(config: MainButtonConfig): void {
  useBottomButton(getMainButton, config);
}

/** 页面声明 SecondaryButton（Bot API 7.10+）。老客户端无此 API，自动 no-op。 */
export function useSecondaryButton(config: SecondaryButtonConfig): void {
  useBottomButton(getSecondaryButton, config);
}
