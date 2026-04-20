import { Card, Layout } from "@components/web/layout";
import { ROUTE_JUNK_CHECK_API } from "@handlers/hono/routes";

function junkCheckScript() {
  return `
document.getElementById('check-btn').addEventListener('click', async function () {
  var btn = this;
  var subject = document.getElementById('subject-input').value;
  var body = document.getElementById('body-input').value;
  if (!body.trim()) return;
  btn.disabled = true; btn.textContent = '检测中…';
  document.getElementById('result').classList.add('hidden');
  try {
    var r = await fetch('${ROUTE_JUNK_CHECK_API}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: subject, body: body }),
    });
    var data = await r.json();
    if (data.error) { document.getElementById('result-text').textContent = '错误: ' + data.error; document.getElementById('result').className = 'mt-4 p-4 rounded-lg bg-slate-700 border border-slate-600'; document.getElementById('result').classList.remove('hidden'); return; }
    var pct = Math.round(data.junkConfidence * 100);
    var isJunk = data.isJunk;
    var label = isJunk ? '🚫 垃圾邮件' : '✅ 正常邮件';
    var colorClass = isJunk ? 'bg-red-900 border-red-700' : 'bg-green-900 border-green-700';
    document.getElementById('result').className = 'mt-4 p-4 rounded-lg border ' + colorClass;
    document.getElementById('result-label').textContent = label;
    document.getElementById('result-confidence').textContent = '置信度: ' + pct + '%';
    document.getElementById('result-tags').textContent = data.tags && data.tags.length ? '标签: ' + data.tags.join(', ') : '';
    document.getElementById('result-summary').textContent = data.summary || '';
    document.getElementById('result').classList.remove('hidden');
  } catch {
    document.getElementById('result-text').textContent = '请求失败';
    document.getElementById('result').className = 'mt-4 p-4 rounded-lg bg-slate-700 border border-slate-600';
    document.getElementById('result').classList.remove('hidden');
  } finally { btn.disabled = false; btn.textContent = '检测'; }
});`;
}

export function JunkCheckPage() {
  return (
    <Layout title="垃圾邮件检测 — Telemail">
      <Card class="max-w-2xl">
        <h1 class="text-2xl font-bold text-slate-100 mb-1">🚫 垃圾邮件检测</h1>
        <p class="text-sm text-slate-400 mb-4">
          输入邮件主题和正文，AI 判断是否为垃圾邮件
        </p>
        <div class="space-y-3">
          <div>
            <label
              for="subject-input"
              class="block text-sm text-slate-400 mb-1"
            >
              主题
            </label>
            <input
              id="subject-input"
              type="text"
              placeholder="邮件主题（可选）"
              class="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div>
            <label for="body-input" class="block text-sm text-slate-400 mb-1">
              正文
            </label>
            <textarea
              id="body-input"
              placeholder="粘贴邮件正文内容…"
              class="w-full min-h-[200px] p-3 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm resize-y outline-none focus:border-blue-500 transition-colors"
            />
          </div>
        </div>
        <button
          class="mt-3 px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
          id="check-btn"
          type="button"
        >
          检测
        </button>
        <div id="result" class="hidden mt-4 p-4 rounded-lg">
          <div id="result-label" class="text-lg font-bold mb-1" />
          <div id="result-confidence" class="text-sm text-slate-300 mb-1" />
          <div id="result-tags" class="text-sm text-slate-400 mb-2" />
          <div
            id="result-summary"
            class="text-sm text-slate-200 whitespace-pre-wrap"
          />
          <div id="result-text" class="text-sm text-slate-200" />
        </div>
      </Card>
      <script dangerouslySetInnerHTML={{ __html: junkCheckScript() }} />
    </Layout>
  );
}
