import { useEffect, useRef } from "react";

/**
 * 邮件正文用 sandbox iframe 渲染：邮件自带 `<style>` / `body{...}` 等全局选择
 * 器隔离在 iframe 文档里，防止泄漏到外层。`<base target="_blank">` 让链接走新
 * 窗口。不开 `allow-scripts`，邮件里的 JS 一律不跑。
 *
 * 父组件通过 onLoad 读 `contentDocument.scrollHeight` 动态调 iframe 高度
 * （img onload + ResizeObserver + window resize 各触发一次）。
 *
 * `bodyHtml` 是 worker 端走过 CORS 代理签名改写的版本，`bodyHtmlRaw` 是未改写的
 * 原始 HTML。组件本身只渲染 iframe；toggle 由父组件控制（web 在 toolbar、
 * miniapp 在 SecondaryButton 里），通过 `useProxy` prop 切换正文源。
 */
export function MailBodyFrame({
  bodyHtml,
  bodyHtmlRaw,
  useProxy = true,
}: {
  bodyHtml: string;
  bodyHtmlRaw: string;
  useProxy?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  // 注入两行 CSS：
  // - `html,body{overflow:hidden}` —— iframe 高度由外层 resize() 管，内层不需要
  //   也不应该有自己的 scrollbar；亚像素四舍五入或 body 默认 margin 经常造成
  //   1-2px 偏差让 iframe 显示自己的 scrollbar。
  // - `body{margin:0}` —— 去掉默认 8px margin，让 scrollHeight 测量更准。
  const srcDoc = `<base target="_blank"><style>html,body{overflow:hidden!important;}body{margin:0;}</style>${
    useProxy ? bodyHtml : bodyHtmlRaw
  }`;

  useEffect(() => {
    const f = frameRef.current;
    if (!f) return;

    let observers: ResizeObserver[] = [];

    function resize() {
      try {
        const doc = f?.contentDocument;
        if (!doc || !f) return;
        const h = Math.max(
          doc.documentElement?.scrollHeight ?? 0,
          doc.body?.scrollHeight ?? 0,
        );
        if (h > 0) f.style.height = `${h}px`;
      } catch {
        /* cross-origin (shouldn't happen with srcdoc) */
      }
    }

    function teardownObservers() {
      for (const o of observers) o.disconnect();
      observers = [];
    }

    // DOM parse 完就跑（不等图片）—— 邮件常带十几张走 cors-proxy 的图，
    // 等 iframe load 事件（要所有 subresource 完成）会让 iframe 在默认
    // ~150px 卡好几秒。这里挂 img onload + ResizeObserver(body)，图片陆续
    // 加载时会自动把 iframe 撑高。切换代理 → srcDoc 变 → iframe 重载新文档
    // → load 事件再次触发 setup，先 disconnect 旧 ResizeObserver 避免泄漏。
    function setup() {
      teardownObservers();
      resize();
      try {
        const doc = f?.contentDocument;
        if (!doc) return;
        doc.querySelectorAll("img").forEach((img) => {
          if (!img.complete) {
            img.addEventListener("load", resize);
            img.addEventListener("error", resize);
          }
        });
        if (doc.body) {
          const ro = new ResizeObserver(resize);
          ro.observe(doc.body);
          observers.push(ro);
        }
      } catch {
        /* ignore */
      }
    }

    // initial：srcDoc iframe 在 commit 后 load 事件可能已经 fire 过，所以
    // readyState 不是 loading 就立即 setup 一次；后续每次 srcDoc 变更都会
    // 走 iframe load 事件分支。
    const doc = f.contentDocument;
    if (doc && doc.readyState !== "loading") setup();
    f.addEventListener("load", setup);
    window.addEventListener("resize", resize);
    // 低频 poll 兜底：单张 hung image (cors-proxy 超时 / 源站不响应) 会让
    // ResizeObserver / load / img.onload 这些事件信号全部不 fire，iframe
    // 卡在那张图加载之前的高度。前 30 秒每秒强制 resize 一次，覆盖
    // 一切事件驱动信号失效的极端情况。
    let pollCount = 0;
    const pollId = window.setInterval(() => {
      resize();
      if (++pollCount >= 30) window.clearInterval(pollId);
    }, 1000);
    return () => {
      f.removeEventListener("load", setup);
      window.removeEventListener("resize", resize);
      window.clearInterval(pollId);
      teardownObservers();
    };
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="邮件正文"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{
        width: "100%",
        border: 0,
        display: "block",
        background: "#fff",
        colorScheme: "light",
      }}
    />
  );
}
