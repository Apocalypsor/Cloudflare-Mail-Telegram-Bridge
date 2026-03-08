import { ROUTE_GMAIL_WATCH, ROUTE_OAUTH_GOOGLE } from '../constants';
import { BackLink, Card, Layout } from './layout';

export function HomePage({ error }: { error?: string }) {
	return (
		<Layout title="Gmail → Telegram Bridge">
			<Card class="max-w-md">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">Gmail → Telegram Bridge</h1>
				<p class="text-sm text-slate-400">请输入密钥以继续</p>
				{error && <p class="text-sm text-red-400 mt-3">{error}</p>}
				<form method="post" action="/" class="mt-4 space-y-3">
					<label for="secret" class="block text-sm text-slate-400">
						Secret
					</label>
					<input
						id="secret"
						name="secret"
						type="password"
						placeholder="GMAIL_WATCH_SECRET"
						required
						autofocus
						class="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
					/>
					<button type="submit" class="w-full py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors">
						进入
					</button>
				</form>
			</Card>
		</Layout>
	);
}

export function DashboardPage({ secret }: { secret: string }) {
	const oauthUrl = `${ROUTE_OAUTH_GOOGLE}?secret=${encodeURIComponent(secret)}`;
	const watchUrl = `${ROUTE_GMAIL_WATCH}?secret=${encodeURIComponent(secret)}`;

	const watchScript = `
document.getElementById('watch-btn').addEventListener('click', async function () {
  const btn = this, res = document.getElementById('watch-result');
  btn.disabled = true; btn.textContent = '请求中…';
  try {
    const r = await fetch('${watchUrl}', { method: 'POST' });
    const t = await r.text();
    res.textContent = t;
    res.className = r.ok
      ? 'mt-3 p-3 rounded-lg text-sm bg-emerald-900/50 text-emerald-300'
      : 'mt-3 p-3 rounded-lg text-sm bg-red-900/50 text-red-300';
  } catch {
    res.textContent = '网络错误';
    res.className = 'mt-3 p-3 rounded-lg text-sm bg-red-900/50 text-red-300';
  } finally { btn.disabled = false; btn.textContent = '刷新 Gmail Watch'; }
});`;

	return (
		<Layout title="Dashboard — Gmail → Telegram Bridge">
			<Card class="max-w-md">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">Dashboard</h1>
				<p class="text-sm text-slate-400">选择一个操作</p>
				<div class="grid gap-3 mt-4">
					<a
						class="block w-full py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg text-center transition-colors"
						href={oauthUrl}
					>
						开始 Google OAuth 授权
					</a>
					<button
						class="w-full py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold rounded-lg transition-colors"
						id="watch-btn"
						type="button"
					>
						刷新 Gmail Watch
					</button>
					<a
						class="block w-full py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold rounded-lg text-center transition-colors"
						href={`/preview?secret=${encodeURIComponent(secret)}`}
					>
						HTML → Telegram 预览
					</a>
				</div>
				<div id="watch-result" class="hidden" />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: watchScript }} />
		</Layout>
	);
}

function previewScript(secret: string) {
	const url = `/preview?secret=${encodeURIComponent(secret)}`;
	return `
document.getElementById('convert-btn').addEventListener('click', async function () {
  const btn = this;
  const html = document.getElementById('html-input').value;
  if (!html.trim()) return;
  btn.disabled = true; btn.textContent = '转换中…';
  try {
    const r = await fetch('${url}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    const data = await r.json();
    document.getElementById('output').textContent = data.result;
    document.getElementById('meta').textContent = '长度: ' + data.length + ' 字符';
  } catch {
    document.getElementById('output').textContent = '请求失败';
  } finally { btn.disabled = false; btn.textContent = '转换'; }
});`;
}

export function PreviewPage({ secret }: { secret: string }) {
	return (
		<Layout title="HTML Preview — Gmail → Telegram Bridge">
			<Card class="max-w-5xl">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">HTML → Telegram 预览</h1>
				<p class="text-sm text-slate-400">粘贴邮件 HTML，查看处理后发送到 Telegram 的 MarkdownV2 结果</p>
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
						<label class="block text-sm text-slate-400 mb-1.5">输出 MarkdownV2</label>
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
				<BackLink secret={secret} />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: previewScript(secret) }} />
		</Layout>
	);
}
