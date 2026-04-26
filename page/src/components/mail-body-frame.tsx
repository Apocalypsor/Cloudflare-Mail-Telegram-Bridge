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
    function onLoad() {
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
        // 慢网兜底：所有 subresource (img/css/font) 都加载完后再测一次。
        // contentWindow 的 load 比 iframe 的 onLoad 触发更晚 —— iframe load
        // 在 srcdoc DOM parse 完就 fire，contentWindow load 等所有外部资源
        // 完成。两个事件都接，覆盖各种边界。
        f?.contentWindow?.addEventListener("load", resize);
        // ResizeObserver 必须观察 body —— documentElement (<html>) 在 iframe
        // 里默认尺寸 = iframe viewport，不会因为内部内容生长而变化，观察它
        // 永远不 fire；body 才会随内容（图片加载、字体替换）实际增高。
        if (doc.body) {
          const ro = new ResizeObserver(resize);
          ro.observe(doc.body);
          observers.push(ro);
        }
      } catch {
        /* ignore */
      }
    }

    f.addEventListener("load", onLoad);
    window.addEventListener("resize", resize);
    return () => {
      f.removeEventListener("load", onLoad);
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
