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
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  ready: () => void;
  expand: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  showConfirm?: (msg: string, cb: (ok: boolean) => void) => void;
  showAlert?: (msg: string, cb?: () => void) => void;
  /** 原生弹窗；按钮数量 <= 3。点击后 cb 拿到按钮 id（未设 id 时是空字符串）。 */
  showPopup?: (params: PopupParams, cb?: (buttonId: string) => void) => void;
  MainButton?: TelegramMainButton;
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
 * App 启动时调用一次：ready + expand + 主题。
 *
 * **注意不碰 BackButton / MainButton**。那两个按钮由页面用 `useBackButton` /
 * `useMainButton` 自己声明状态；父组件 hide 会和子组件 show 冲突（React effect
 * 运行顺序是子先于父）。
 */
export function initTelegramChrome(): void {
  const tg = getTelegram();
  syncThemeFromTelegram();
  if (!tg) return;
  tg.ready();
  tg.expand();
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
}

/**
 * 页面声明 MainButton：
 *   text 有值 → 显示按钮 + 文字 + 绑点击
 *   text 为 undefined → 隐藏按钮
 * 卸载时自动 hide + 摘 handler。
 *
 * **注意**：实现走 `setText` + `enable/disable` + `show/hide` 三段式而不是
 * `setParams`，因为 Android 客户端历史上对 `setParams` 的可见性 / 启用状态有
 * 兼容问题（见 vkruglikov/react-telegram-web-app discussion #69 / 类似 issue
 * 一堆）。三段式是 TG 官方示例的写法，所有客户端都稳。
 *
 * onClick 每次变化都会重新摘旧 handler 绑新的 —— 保证 cb 闭包拿到最新
 * props/state，不会指向陈旧值。
 */
export function useMainButton({
  text,
  onClick,
  loading,
  disabled,
}: MainButtonConfig): void {
  useEffect(() => {
    const tg = getTelegram();
    const mb = tg?.MainButton;
    if (!mb) return;
    if (!text) {
      mb.hide();
      return;
    }
    mb.setText(text);
    if (disabled || loading) mb.disable();
    else mb.enable();
    if (loading) mb.showProgress(false);
    else mb.hideProgress();
    mb.show();
    mb.onClick(onClick);
    return () => {
      mb.offClick(onClick);
      mb.hideProgress();
      mb.hide();
    };
  }, [text, onClick, loading, disabled]);
}
