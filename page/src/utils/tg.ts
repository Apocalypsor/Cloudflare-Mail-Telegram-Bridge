import {
  closeMiniApp,
  hapticFeedbackImpactOccurred,
  hapticFeedbackNotificationOccurred,
  openLink,
  openTelegramLink,
  showPopup,
} from "@telegram-apps/sdk-react";

/** Haptic 通知 —— 包了 SDK 的 isAvailable + 静默失败，让 callers 一行调用。
 *  非 TG 环境（普通浏览器）静默 no-op。 */
export function notifyHaptic(kind: "success" | "warning" | "error"): void {
  if (hapticFeedbackNotificationOccurred.isAvailable())
    hapticFeedbackNotificationOccurred(kind);
}

export function impactHaptic(
  kind: "light" | "medium" | "heavy" | "rigid" | "soft",
): void {
  if (hapticFeedbackImpactOccurred.isAvailable())
    hapticFeedbackImpactOccurred(kind);
}

/** 弹原生确认 popup。OK / 取消，Promise resolve(true|false)。
 *  TG 不可用 → 退到 `window.confirm`。 */
export async function confirmPopup(message: string): Promise<boolean> {
  if (showPopup.isAvailable()) {
    try {
      const id = await showPopup({
        message,
        buttons: [
          { id: "ok", type: "default", text: "确定" },
          { id: "cancel", type: "cancel" },
        ],
      });
      return id === "ok";
    } catch {
      return false;
    }
  }
  return window.confirm(message);
}

/** 弹原生 alert 提示。TG 不可用 → 退到 `window.alert`。 */
export async function alertPopup(message: string): Promise<void> {
  if (showPopup.isAvailable()) {
    try {
      await showPopup({
        message,
        buttons: [{ id: "ok", type: "default", text: "确定" }],
      });
      return;
    } catch {
      return;
    }
  }
  window.alert(message);
}

/** 打开外部 URL（http/https）。TG 用原生 `openLink`，其他环境用新窗口。 */
export function openExternalLink(url: string): void {
  if (openLink.isAvailable()) {
    openLink(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** 打开 t.me/* 链接。TG 用原生 `openTelegramLink`（会自动 close Mini App），
 *  其他环境用新窗口。 */
export function openTgLink(url: string): void {
  if (openTelegramLink.isAvailable()) {
    openTelegramLink(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** 主动关闭 Mini App。某些 TG 客户端 `openTelegramLink` 跳转后不自动关，需要
 *  caller 显式调一下。非 TG 环境 no-op。 */
export function closeMiniAppSafe(): void {
  if (closeMiniApp.isAvailable()) closeMiniApp();
}
