/**
 * JS runtime 用的颜色常量 —— 和 `styles/theme.css` 的 CSS 变量保持同步。
 *
 * 目前唯一消费方是 `MailFab`：TG MainButton / SecondaryButton 是宿主绘制的
 * 原生按钮，setParams 要的是字面 hex 字符串，没法读 CSS 变量；放这里集中
 * 管理，换配色时 theme.css 和本文件一起改。
 */
export const THEME_COLORS = {
  /** emerald-500，accent 主色 */
  accent: "#10b981",
  /** emerald-950，accent 上的文字色（TG MainButton text_color） */
  accentOn: "#022c22",
  /** zinc-800，中性副按钮 */
  neutral: "#27272a",
  /** zinc-100，中性按钮上的文字色 */
  neutralOn: "#f4f4f5",
} as const;
