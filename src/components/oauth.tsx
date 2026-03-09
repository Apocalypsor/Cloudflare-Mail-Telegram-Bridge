import { BackLink, Card, Layout } from './layout';

export function OAuthSetupPage({
	startUrl,
	callbackUrl,
	accountEmail,
}: {
	startUrl: string;
	callbackUrl: string;
	accountEmail: string;
}) {
	return (
		<Layout title="Gmail OAuth 授权">
			<Card class="max-w-3xl">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">Gmail OAuth 授权</h1>
				<p class="text-sm text-slate-400 leading-relaxed">
					为账号 <code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">{accountEmail}</code> 授权 Gmail 访问权限。
					使用当前 Worker 的{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">GMAIL_CLIENT_ID</code> 和{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">GMAIL_CLIENT_SECRET</code> 发起 OAuth，然后把{' '}
					<code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">refresh_token</code> 保存到 D1 数据库。
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
						<strong class="text-slate-200">请确认登录的是 {accountEmail}</strong>，回调成功后 refresh_token 会自动保存。
					</li>
				</ol>
				<a
					class="inline-block mt-5 px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
					href={startUrl}
				>
					开始授权
				</a>
				<BackLink />
			</Card>
		</Layout>
	);
}

const copyScript = `
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
}) {
	const title = refreshToken ? 'OAuth 授权成功' : '本次未返回 Refresh Token';
	const statusText = refreshToken
		? `已为 ${accountEmail} 保存 refresh_token 到数据库，后续会自动使用。Watch 已自动续订。`
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
					<p class="mt-3 text-sm text-amber-300">请重新执行授权流程，并确认登录的是 {accountEmail}。</p>
				)}
				<p class="mt-4 text-sm text-slate-400">
					返回 scope: <code class="px-1.5 py-0.5 bg-slate-900 rounded text-blue-300 text-xs">{scope}</code>
					{typeof expiresIn === 'number' && `，access_token 有效期约 ${expiresIn} 秒`}。
				</p>
				<BackLink />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: copyScript }} />
		</Layout>
	);
}

export function OAuthErrorPage({ title, detail }: { title: string; detail: string }) {
	return (
		<Layout title={title}>
			<Card class="max-w-3xl">
				<h1 class="text-2xl font-bold text-red-400 mb-3">{title}</h1>
				<pre class="p-3 bg-slate-900 border border-slate-700 rounded-lg font-mono text-xs text-red-400 whitespace-pre-wrap break-words overflow-auto">
					{detail}
				</pre>
				<BackLink />
			</Card>
		</Layout>
	);
}
