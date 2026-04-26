import { useEffect, useRef } from "react";

/**
 * 邮件正文用 sandbox iframe 渲染：邮件自带 `<style>` / `body{...}` 等全局选择
 * 器隔离在 iframe 文档里，防止泄漏到外层。`<base target="_blank">` 让链接走新
 * 窗口。不开 `allow-scripts`，邮件里的 JS 一律不跑。
 *
 * 父组件通过 onLoad 读 `contentDocument.scrollHeight` 动态调 iframe 高度
 * （img onload + ResizeObserver + window resize 各触发一次）。
 */
export function MailBodyFrame({ bodyHtml }: { bodyHtml: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const f = frameRef.current;
    if (!f) return;

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

    const observers: ResizeObserver[] = [];
    // DOM parse 完就跑（不等图片）—— 邮件常带十几张走 cors-proxy 的图，
    // 等 iframe load 事件（要所有 subresource 完成）会让 iframe 在默认
    // ~150px 卡好几秒。这里挂 img onload + ResizeObserver(body)，图片陆续
    // 加载时会自动把 iframe 撑高。
    function setup() {
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

    const doc = f.contentDocument;
    // readyState `loading` = DOM 还在 parse；`interactive` = DOM 已 parse、
    // 资源未加载完；`complete` = 全部完成。我们要的是"DOM 一可用就 setup"。
    if (doc && doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", setup, { once: true });
    } else {
      setup();
    }
    // 全部 subresource 完成后再 resize 一次兜底（处理无 width/height 属性
    // 的图片、字体替换等可能改 layout 的尾声情况）。
    f.addEventListener("load", resize);
    window.addEventListener("resize", resize);
    return () => {
      doc?.removeEventListener("DOMContentLoaded", setup);
      f.removeEventListener("load", resize);
      window.removeEventListener("resize", resize);
      for (const o of observers) o.disconnect();
    };
  }, []);

  // 注入两行 CSS：
  // - `html,body{overflow:hidden}` —— iframe 高度由外层 resize() 管，内层不需要
  //   也不应该有自己的 scrollbar；亚像素四舍五入或 body 默认 margin 经常造成
  //   1-2px 偏差让 iframe 显示自己的 scrollbar。
  // - `body{margin:0}` —— 去掉默认 8px margin，让 scrollHeight 测量更准。
  const srcDoc = `<base target="_blank"><style>html,body{overflow:hidden!important;}body{margin:0;}</style>${bodyHtml}`;
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
