import { Card, Layout } from '@components/layout';

export function LoginPage({ botUsername, returnTo }: { botUsername: string; returnTo: string }) {
	const callbackScript = `
function onTelegramAuth(user) {
  var params = new URLSearchParams(user);
  params.set('return_to', ${JSON.stringify(returnTo)});
  window.location.href = '/login/callback?' + params.toString();
}`;

	return (
		<Layout title="Telegram 登录">
			<Card class="max-w-md text-center">
				<h1 class="text-2xl font-bold text-slate-100 mb-4">请先登录</h1>
				<p class="text-sm text-slate-400 mb-6">使用 Telegram 账号登录后才能访问此页面。</p>
				<div class="flex justify-center">
					<script
						async
						src="https://telegram.org/js/telegram-widget.js?22"
						data-telegram-login={botUsername}
						data-size="large"
						data-onauth="onTelegramAuth(user)"
						data-request-access="write"
					/>
				</div>
				<script dangerouslySetInnerHTML={{ __html: callbackScript }} />
			</Card>
		</Layout>
	);
}

export function LoginDeniedPage() {
	return (
		<Layout title="访问被拒绝">
			<Card class="max-w-md text-center">
				<h1 class="text-2xl font-bold text-red-400 mb-4">访问被拒绝</h1>
				<p class="text-sm text-slate-400">你的 Telegram 账号尚未获得批准。请联系管理员。</p>
			</Card>
		</Layout>
	);
}
