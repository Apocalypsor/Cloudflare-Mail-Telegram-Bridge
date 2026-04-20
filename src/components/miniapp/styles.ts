/** Mini App 各页面共享的基础样式：TG 主题 CSS 变量 + 全局 reset。
 *  各页面在 <style> 里把 BASE_CSS 和自己的 PAGE_CSS 拼起来。 */
export const MINIAPP_BASE_CSS = `
:root {
  color-scheme: light dark;
  --bg: var(--tg-theme-bg-color, #0f172a);
  --surface: var(--tg-theme-secondary-bg-color, #1e293b);
  --text: var(--tg-theme-text-color, #e2e8f0);
  --hint: var(--tg-theme-hint-color, #94a3b8);
  --link: var(--tg-theme-link-color, #60a5fa);
  --button: var(--tg-theme-button-color, #3b82f6);
  --button-text: var(--tg-theme-button-text-color, #ffffff);
  --separator: var(--tg-theme-section-separator-color, rgba(127,127,127,.18));
  --danger: #ef4444;
  --border: rgba(127,127,127,.18);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 15px;
  line-height: 1.5;
  -webkit-tap-highlight-color: transparent;
}
`;
