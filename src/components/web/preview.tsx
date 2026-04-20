import { Card, Layout } from "@components/web/layout";
import { ROUTE_PREVIEW_API } from "@handlers/hono/routes";

function previewScript() {
  return `
document.getElementById('convert-btn').addEventListener('click', async function () {
  var btn = this;
  var html = document.getElementById('html-input').value;
  if (!html.trim()) return;
  btn.disabled = true; btn.textContent = '转换中…';
  try {
    var r = await fetch('${ROUTE_PREVIEW_API}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: html }),
    });
    var data = await r.json();
    document.getElementById('output').textContent = data.result;
    document.getElementById('meta').textContent = '长度: ' + data.length + ' 字符';
  } catch {
    document.getElementById('output').textContent = '请求失败';
  } finally { btn.disabled = false; btn.textContent = '转换'; }
});`;
}

export function PreviewPage() {
  return (
    <Layout title="HTML Preview — Telemail">
      <Card class="max-w-5xl">
        <h1 class="text-2xl font-bold text-slate-100 mb-3">
          HTML → Telegram 预览
        </h1>
        <p class="text-sm text-slate-400">
          粘贴邮件 HTML，查看处理后发送到 Telegram 的 MarkdownV2 结果
        </p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label for="html-input" class="block text-sm text-slate-400 mb-1.5">
              输入 HTML
            </label>
            <textarea
              id="html-input"
              placeholder="<html>...</html>"
              class="w-full min-h-[300px] p-3 bg-slate-900 border border-slate-700 rounded-lg text-blue-300 font-mono text-xs resize-y outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <span class="block text-sm text-slate-400 mb-1.5">
              输出 MarkdownV2
            </span>
            <div
              id="output"
              class="min-h-[300px] p-3 bg-slate-900 border border-slate-700 rounded-lg text-blue-300 font-mono text-xs whitespace-pre-wrap break-all overflow-auto"
            >
              （结果将显示在这里）
            </div>
          </div>
        </div>
        <button
          class="mt-3 px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
          id="convert-btn"
          type="button"
        >
          转换
        </button>
        <div id="meta" class="mt-2 text-xs text-slate-400" />
      </Card>
      <script dangerouslySetInnerHTML={{ __html: previewScript() }} />
    </Layout>
  );
}
