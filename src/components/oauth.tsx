import { KV_GMAIL_REFRESH_TOKEN } from '../constants';
import { BackLink, Card, Layout } from './layout';

export function OAuthSetupPage({
	startUrl,
	callbackUrl,
	watchUrl,
	secret,
}: {
	startUrl: string;
	callbackUrl: string;
	watchUrl: string;
	secret: string;
}) {
	return (
		<Layout title="Gmail OAuth Token Helper">
			<Card class="max-w-3xl">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">生成 Gmail Refresh Token</h1>
				<p class="text-sm text-slate-400 leading-relaxed">
					这个页面会使用你当前 Worker 的 <code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">GMAIL_CLIENT_ID</code> 和{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">GMAIL_CLIENT_SECRET</code> 发起 OAuth，然后把新的{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">refresh_token</code> 自动保存到{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">EMAIL_KV</code>。
				</p>
				<ol class="mt-3 ml-5 space-y-2 list-decimal text-sm text-slate-400 leading-relaxed">
					<li>
						在 Google Cloud OAuth Client 的 <strong class="text-slate-200">Authorized redirect URIs</strong> 添加：
						<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs break-all">{callbackUrl}</code>
					</li>
					<li>
						点击下方按钮，完成 Google 授权（会请求{' '}
						<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">gmail.readonly</code>）。
					</li>
					<li>
						回调成功后会自动写入 KV 键：
						<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">{KV_GMAIL_REFRESH_TOKEN}</code>。
					</li>
					<li>
						更新后调用 <code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs break-all">{watchUrl}</code> 续订 watch。
					</li>
				</ol>
				<a
					class="inline-block mt-5 px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
					href={startUrl}
				>
					开始授权并生成 Refresh Token
				</a>
				<p class="mt-3 text-xs text-slate-500">
					入口受 <code class="px-1 py-0.5 bg-slate-900 rounded text-blue-300">?secret=...</code> 保护，使用和{' '}
					<code class="px-1 py-0.5 bg-slate-900 rounded text-blue-300">/gmail/watch</code> 同一个密钥。
				</p>
				<BackLink secret={secret} />
			</Card>
		</Layout>
	);
}

const copyScript = `
const btn = document.getElementById('copy');
const input = document.getElementById('token');
if (btn && input) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制 Token'; }, 1200);
    } catch {
      btn.textContent = '复制失败';
    }
  });
}`;

export function OAuthCallbackPage({
	refreshToken,
	scope,
	expiresIn,
	watchUrl,
	secret,
}: {
	refreshToken: string | undefined;
	scope: string;
	expiresIn: number | undefined;
	watchUrl: string;
	secret: string;
}) {
	const title = refreshToken ? 'Refresh Token 已保存到 KV' : '本次未返回 Refresh Token';
	const statusText = refreshToken
		? `已写入 EMAIL_KV 的键 ${KV_GMAIL_REFRESH_TOKEN}，后续会自动使用。`
		: 'Google 返回成功，但没有 refresh_token。通常是同一账号已授权过且未强制重新授权。';

	return (
		<Layout title={title}>
			<Card class="max-w-3xl">
				<h1 class={`text-2xl font-bold mb-3 ${refreshToken ? 'text-emerald-300' : 'text-amber-300'}`}>{title}</h1>
				<p class="text-sm text-slate-400">{statusText}</p>
				{refreshToken ? (
					<div class="mt-4">
						<textarea
							id="token"
							readonly
							class="w-full min-h-[100px] p-3 bg-slate-900 border border-slate-700 rounded-lg font-mono text-xs text-blue-300 resize-y"
						>
							{refreshToken}
						</textarea>
						<button
							id="copy"
							class="mt-3 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
						>
							复制 Token
						</button>
					</div>
				) : (
					<p class="mt-3 text-sm text-amber-300">请重新执行授权流程，并确认登录的是目标 Google 账号。</p>
				)}
				<h2 class="text-lg font-bold text-slate-100 mt-5 mb-2">下一步</h2>
				<ol class="ml-5 list-decimal text-sm text-slate-400">
					<li>续订 Gmail watch：</li>
				</ol>
				<pre class="mt-2 p-3 bg-slate-900 border border-slate-700 rounded-lg font-mono text-xs text-blue-300 overflow-auto">
					{`curl -X POST "${watchUrl}"`}
				</pre>
				{refreshToken && (
					<p class="mt-3 text-sm text-slate-400">
						refresh_token 已保存到 KV 键{' '}
						<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">{KV_GMAIL_REFRESH_TOKEN}</code>。
					</p>
				)}
				<p class="mt-2 text-sm text-slate-400">
					返回 scope: <code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">{scope}</code>
					{typeof expiresIn === 'number' && `，access_token 有效期约 ${expiresIn} 秒`}。
				</p>
				<BackLink secret={secret} />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: copyScript }} />
		</Layout>
	);
}

export function OAuthErrorPage({ title, detail, secret }: { title: string; detail: string; secret: string }) {
	return (
		<Layout title={title}>
			<Card class="max-w-3xl">
				<h1 class="text-2xl font-bold text-red-400 mb-3">{title}</h1>
				<pre class="p-3 bg-slate-900 border border-slate-700 rounded-lg font-mono text-xs text-red-400 whitespace-pre-wrap break-words overflow-auto">
					{detail}
				</pre>
				<BackLink secret={secret} />
			</Card>
		</Layout>
	);
}
