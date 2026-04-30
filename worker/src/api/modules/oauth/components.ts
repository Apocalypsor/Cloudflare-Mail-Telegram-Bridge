import { Html } from "@elysiajs/html";

/** kitajs/html `JSX.Element` 实际就是 string | Promise<string> —— 不引 JSX 命名空间，
 *  避免 page 端 `react-jsx` 全局 JSX 冲突。 */
type HtmlElement = string | Promise<string>;
type HtmlChild =
  | HtmlElement
  | HtmlChild[]
  | null
  | undefined
  | boolean
  | number;

const h = Html.createElement as (
  name: string,
  attrs: Record<string, unknown> | null,
  ...children: HtmlChild[]
) => HtmlElement;

/**
 * Worker SSR 的极简外壳 —— OAuth 流程几个过渡页 (`/oauth/...`) 在用。
 *
 * 之前跟 Page 走一样的 Tailwind，build 时 `scripts/build-css.mjs` 把整套
 * Tailwind JIT 打包成 31KB 字符串 embed 进来。就几个页面，完全不值。现在
 * 手写一份 semantic CSS 直接 inline 到 `<style>`，配色和 Page 一致
 * （zinc-950 背景 + emerald accent）。
 *
 * 用 `Html.createElement` 函数调用而不是 JSX 语法 —— Page 端 tsconfig
 * `jsx: react-jsx` 跟 worker 这里 `jsxFactory: Html.createElement` 是冲突的。
 * 跨包做 Eden 类型推导时 page 会读到这个文件，函数调用形式两边都能解析。
 */
const INLINE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #09090b;
    color: #f4f4f5;
    display: flex;
    justify-content: center;
    padding: 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-tap-highlight-color: transparent;
  }
  .card {
    width: 100%;
    max-width: 48rem;
    margin-block: auto;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 1rem;
    padding: 1.5rem;
  }
  .card > * + * { margin-top: 0.75rem; }
  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 0.75rem 0;
    letter-spacing: -0.025em;
  }
  .title-ok { color: #6ee7b7; }
  .title-warn { color: #fcd34d; }
  .title-err { color: #f87171; }
  p { margin: 0; font-size: 0.875rem; line-height: 1.625; color: #a1a1aa; }
  strong { color: #f4f4f5; font-weight: 600; }
  .text-warn { color: #fcd34d; }
  code {
    padding: 0.125rem 0.375rem;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.25rem;
    color: #6ee7b7;
    font-size: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    word-break: break-all;
  }
  ol.steps {
    margin: 0.75rem 0 0 1.25rem;
    padding: 0;
    list-style: decimal;
  }
  ol.steps > li { margin-block: 0.5rem; }
  ol.steps > li:first-child { margin-top: 0; }
  .btn {
    display: inline-block;
    margin-top: 1.25rem;
    padding: 0.75rem 1rem;
    background: #10b981;
    color: #022c22;
    font-weight: 600;
    font-size: 0.875rem;
    text-decoration: none;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background-color 0.15s;
  }
  .btn:hover { background: #34d399; }
  .token-input {
    margin-top: 1rem;
    width: 100%;
    min-height: 100px;
    padding: 0.75rem;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    color: #6ee7b7;
    resize: vertical;
  }
  pre.error {
    margin: 0;
    padding: 0.75rem;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    color: #f87171;
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
  }
`;

const COPY_SCRIPT = `
var btn = document.getElementById('copy');
var input = document.getElementById('token');
if (btn && input) {
  btn.addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(input.value);
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = '复制 Token'; }, 1200);
    } catch {
      btn.textContent = '复制失败';
    }
  });
}`;

function Layout(title: string, body: HtmlChild): HtmlElement {
  return h("html", { lang: "zh-CN" }, [
    h("head", null, [
      h("meta", { charset: "utf-8" }),
      h("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      }),
      h("title", null, title),
      h("link", { rel: "icon", type: "image/png", href: "/favicon.png" }),
      h("style", null, INLINE_CSS),
    ]),
    h("body", null, body),
  ]);
}

function Card(children: HtmlChild, className?: string): HtmlElement {
  return h(
    "main",
    { class: `card${className ? ` ${className}` : ""}` },
    children,
  );
}

export function OAuthSetupPage({
  startUrl,
  callbackUrl,
  accountEmail,
}: {
  startUrl: string;
  callbackUrl: string;
  accountEmail: string;
}): HtmlElement {
  return Layout(
    "OAuth 授权",
    Card([
      h("h1", null, "OAuth 授权"),
      h("p", null, [
        "为账号 ",
        h("code", null, accountEmail),
        " 授权邮箱访问权限。回调成功后 ",
        h("code", null, "refresh_token"),
        " 会自动保存到 D1 数据库。",
      ]),
      h("ol", { class: "steps" }, [
        h("li", null, [
          "在 OAuth 应用的 ",
          h("strong", null, "Redirect URIs"),
          " 添加：",
          h("code", null, callbackUrl),
        ]),
        h("li", null, "点击下方按钮完成授权。"),
        h("li", null, [
          h("strong", null, `请确认登录的是 ${accountEmail}`),
          "，回调成功后 refresh_token 会自动保存。",
        ]),
      ]),
      h("a", { class: "btn", href: startUrl }, "开始授权"),
    ]),
  );
}

export function OAuthCallbackPage({
  refreshToken,
  scope,
  expiresIn,
  accountEmail,
}: {
  refreshToken: string | undefined;
  scope: string;
  expiresIn: number | undefined;
  accountEmail: string;
}): HtmlElement {
  const title = refreshToken ? "OAuth 授权成功" : "本次未返回 Refresh Token";
  const statusText = refreshToken
    ? `已为 ${accountEmail} 保存 refresh_token 到数据库，后续会自动使用。Watch 已自动续订。`
    : "Google 返回成功，但没有 refresh_token。通常是同一账号已授权过且未强制重新授权。";

  const tokenBlock = refreshToken
    ? h("div", null, [
        h(
          "textarea",
          { id: "token", readonly: true, class: "token-input" },
          refreshToken,
        ),
        h("button", { type: "button", id: "copy", class: "btn" }, "复制 Token"),
      ])
    : h(
        "p",
        { class: "text-warn" },
        `请重新执行授权流程，并确认登录的是 ${accountEmail}。`,
      );

  const expiryNote =
    typeof expiresIn === "number"
      ? `，access_token 有效期约 ${expiresIn} 秒`
      : "";

  return Layout(title, [
    Card([
      h("h1", { class: refreshToken ? "title-ok" : "title-warn" }, title),
      h("p", null, statusText),
      tokenBlock,
      h("p", null, ["返回 scope: ", h("code", null, scope), `${expiryNote}。`]),
    ]),
    h("script", null, COPY_SCRIPT),
  ]);
}

export function OAuthErrorPage({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): HtmlElement {
  return Layout(
    title,
    Card([
      h("h1", { class: "title-err" }, title),
      h("pre", { class: "error" }, detail),
    ]),
  );
}
