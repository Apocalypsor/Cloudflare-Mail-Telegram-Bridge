import { ROUTE_ACCOUNTS, ROUTE_CLEAR_ALL_KV, ROUTE_GMAIL_WATCH, ROUTE_OAUTH_GOOGLE, ROUTE_PREVIEW, ROUTE_PREVIEW_API } from '../handlers/hono/routes';
import type { Account, TelegramUser } from '../types';
import { BackLink, Card, Layout } from './layout';

function userDisplayName(u: TelegramUser): string {
	let name = u.first_name;
	if (u.last_name) name += ` ${u.last_name}`;
	if (u.username) name += ` (@${u.username})`;
	return name;
}

function UserSelect({ name, value, users, placeholder }: { name: string; value?: string | null; users: TelegramUser[]; placeholder: string }) {
	return (
		<select
			name={name}
			class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
		>
			<option value="">{placeholder}</option>
			{users.map((u) => (
				<option value={u.telegram_id} selected={u.telegram_id === value}>
					{userDisplayName(u)}
				</option>
			))}
		</select>
	);
}

export function HomePage({ botUsername, error }: { botUsername: string; error?: string }) {
	return (
		<Layout title="Telemail">
			<Card class="max-w-md">
				<h1 class="text-2xl font-bold text-slate-100 mb-3">Telemail</h1>
				<p class="text-sm text-slate-400">请使用 Telegram 登录</p>
				<p class="text-xs text-slate-500 mt-2">
					登录前请先向{' '}
					<a href={`https://t.me/${botUsername}`} target="_blank" class="text-blue-400 hover:underline">
						@{botUsername}
					</a>
					{' '}发送 /start
				</p>
				{error && <p class="text-sm text-red-400 mt-3">{error}</p>}
				<div
					class="mt-4 flex justify-center"
					dangerouslySetInnerHTML={{
						__html: `<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${botUsername}" data-size="large" data-auth-url="/auth/telegram"></script>`,
					}}
				/>
			</Card>
		</Layout>
	);
}

function dashboardScript() {
	return `
var res = document.getElementById('action-result');
function showResult(text, ok) {
  res.textContent = text;
  res.className = ok
    ? 'mt-3 p-3 rounded-lg text-sm bg-emerald-900/50 text-emerald-300'
    : 'mt-3 p-3 rounded-lg text-sm bg-red-900/50 text-red-300';
}

var watchAllBtn = document.getElementById('watch-all-btn');
if (watchAllBtn) watchAllBtn.addEventListener('click', async function () {
  var btn = this;
  btn.disabled = true; btn.textContent = '请求中…';
  try {
    var r = await fetch('${ROUTE_GMAIL_WATCH}', { method: 'POST' });
    showResult(await r.text(), r.ok);
  } catch { showResult('网络错误', false); }
  finally { btn.disabled = false; btn.textContent = 'Renew All Watches'; }
});

var clearAllKvBtn = document.getElementById('clear-all-kv-btn');
if (clearAllKvBtn) clearAllKvBtn.addEventListener('click', async function () {
  if (!confirm('确定要清空所有 KV 缓存吗？（access_token、history_id、消息去重、OAuth state 等全部删除）')) return;
  var btn = this;
  btn.disabled = true; btn.textContent = '清空中…';
  try {
    var r = await fetch('${ROUTE_CLEAR_ALL_KV}', { method: 'POST' });
    showResult(await r.text(), r.ok);
  } catch { showResult('网络错误', false); }
  finally { btn.disabled = false; btn.textContent = '清空全局 KV 缓存'; }
});

document.querySelectorAll('.watch-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    var id = this.dataset.id;
    this.disabled = true; this.textContent = '…';
    try {
      var r = await fetch('/api/accounts/' + id + '/watch', { method: 'POST' });
      showResult(await r.text(), r.ok);
    } catch { showResult('网络错误', false); }
    finally { this.disabled = false; this.textContent = 'Watch'; }
  });
});

document.querySelectorAll('.clear-cache-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    if (!confirm('确定要清除该账号的缓存吗？（access_token + history_id）')) return;
    var id = this.dataset.id;
    this.disabled = true; this.textContent = '…';
    try {
      var r = await fetch('/api/accounts/' + id + '/clear-cache', { method: 'POST' });
      showResult(await r.text(), r.ok);
    } catch { showResult('网络错误', false); }
    finally { this.disabled = false; this.textContent = '清除缓存'; }
  });
});

document.querySelectorAll('.delete-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    if (!confirm('确定要删除这个账号吗？')) return;
    var id = this.dataset.id;
    this.disabled = true;
    try {
      var r = await fetch('/api/accounts/' + id + '/delete', { method: 'POST' });
      if (r.ok) location.reload();
      else showResult(await r.text(), false);
    } catch { showResult('网络错误', false); }
    finally { this.disabled = false; }
  });
});

document.querySelectorAll('.edit-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var id = this.dataset.id;
    var row = document.getElementById('acc-' + id);
    var form = document.getElementById('edit-' + id);
    if (row) row.style.display = 'none';
    if (form) form.style.display = '';
  });
});

document.querySelectorAll('.edit-cancel').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var id = this.dataset.id;
    var row = document.getElementById('acc-' + id);
    var form = document.getElementById('edit-' + id);
    if (row) row.style.display = '';
    if (form) form.style.display = 'none';
  });
});`;
}

function accountDisplayName(acc: Account): string {
	if (acc.email) return acc.label ? `${acc.label} — ${acc.email}` : acc.email;
	return acc.label || `Account #${acc.id}`;
}

export function DashboardPage({ accounts, error, isAdmin, users = [], userId }: { accounts: Account[]; error?: string; isAdmin: boolean; users?: TelegramUser[]; userId: string }) {
	return (
		<Layout title="Dashboard — Telemail">
			<Card class="max-w-4xl">
				<div class="flex items-center justify-between mb-1">
					<h1 class="text-2xl font-bold text-slate-100">Dashboard</h1>
					<a href="/logout" class="px-3 py-1.5 bg-slate-700 hover:bg-red-700 text-slate-200 text-sm font-medium rounded-lg transition-colors">
						登出
					</a>
				</div>
				<p class="text-sm text-slate-400 mb-4">管理 Gmail 账号和 Telegram 转发</p>

				{error && <p class="text-sm text-red-400 mb-3 p-3 bg-red-900/30 rounded-lg">{error}</p>}

				{/* ── 账号列表 ─────────────────────────────────────────── */}
				<h2 class="text-lg font-semibold text-slate-100 mb-2">Accounts</h2>

				{accounts.length === 0 ? (
					<p class="text-sm text-slate-500 mb-4">还没有账号，请在下方添加。</p>
				) : (
					<div class="space-y-2 mb-4">
						{accounts.map((acc) => (
							<div>
								{/* ── 显示行 ── */}
								<div id={`acc-${acc.id}`} class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-slate-900 border border-slate-700 rounded-lg">
									<div class="min-w-0">
										<p class="text-sm text-slate-200 font-medium truncate">{accountDisplayName(acc)}</p>
										<p class="text-xs text-slate-500">
											Chat ID: {acc.chat_id}
											{isAdmin && acc.telegram_user_id && (() => {
												const owner = users.find((u) => u.telegram_id === acc.telegram_user_id);
												return (
													<span class="ml-2 text-slate-600">
														Owner: {owner?.username ? `@${owner.username}` : owner?.first_name ?? acc.telegram_user_id}
													</span>
												);
											})()}
											{!acc.email && <span class="ml-2 text-amber-400">（待授权获取邮箱）</span>}
										</p>
									</div>
									<div class="flex items-center gap-1.5 flex-shrink-0">
										<span
											class={`text-xs px-2 py-0.5 rounded ${acc.refresh_token ? 'bg-emerald-900/50 text-emerald-300' : 'bg-amber-900/50 text-amber-300'}`}
										>
											{acc.refresh_token ? '已授权' : '未授权'}
										</span>
										<a
											class="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
											href={`${ROUTE_OAUTH_GOOGLE}?account=${acc.id}`}
										>
											{acc.refresh_token ? '重新授权' : '授权'}
										</a>
										{acc.refresh_token && (
											<button class="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors watch-btn" data-id={String(acc.id)} type="button">
												Watch
											</button>
										)}
										<button class="text-xs px-2 py-1 bg-slate-600 hover:bg-slate-500 text-slate-200 rounded transition-colors edit-btn" data-id={String(acc.id)} type="button">
											编辑
										</button>
										<button class="text-xs px-2 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded transition-colors clear-cache-btn" data-id={String(acc.id)} type="button">
											清除缓存
										</button>
										<button class="text-xs px-2 py-1 bg-red-700 hover:bg-red-800 text-white rounded transition-colors delete-btn" data-id={String(acc.id)} type="button">
											删除
										</button>
									</div>
								</div>
								{/* ── 编辑表单（默认隐藏） ── */}
								<form
									id={`edit-${acc.id}`}
									method="post"
									action={`/api/accounts/${acc.id}/edit`}
									class="p-3 bg-slate-900 border border-blue-600 rounded-lg space-y-3 mt-1"
									style="display:none"
								>
									<p class="text-xs text-slate-400">编辑 {accountDisplayName(acc)}</p>
									<div class={`grid grid-cols-1 ${isAdmin ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-3`}>
										<div>
											<label class="block text-xs text-slate-400 mb-1">Telegram Chat ID *</label>
											<input
												name="chat_id"
												required
												value={acc.chat_id}
												class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
											/>
										</div>
										<div>
											<label class="block text-xs text-slate-400 mb-1">Label</label>
											<input
												name="label"
												value={acc.label || ''}
												class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
											/>
										</div>
										{isAdmin && (
											<div>
												<label class="block text-xs text-slate-400 mb-1">Owner</label>
												<UserSelect name="telegram_user_id" value={acc.telegram_user_id} users={users} placeholder="留空取消绑定" />
											</div>
										)}
									</div>
									<div class="flex gap-2">
										<button type="submit" class="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg transition-colors">
											保存
										</button>
										<button type="button" class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors edit-cancel" data-id={String(acc.id)}>
											取消
										</button>
									</div>
								</form>
							</div>
						))}
					</div>
				)}

				{/* ── 添加账号 ─────────────────────────────────────────── */}
				<h2 class="text-lg font-semibold text-slate-100 mt-5 mb-2">Add Account</h2>
				<p class="text-xs text-slate-500 mb-2">添加后通过 OAuth 授权，邮箱地址将自动从 Gmail API 获取。</p>
				<form method="post" action={ROUTE_ACCOUNTS} class="space-y-3">
					<div class={`grid grid-cols-1 ${isAdmin ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-3`}>
						<div>
							<label class="block text-xs text-slate-400 mb-1">Telegram Chat ID *</label>
							<input
								name="chat_id"
								required
								value={userId}
								placeholder="-1001234567890"
								class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
							/>
						</div>
						<div>
							<label class="block text-xs text-slate-400 mb-1">Label</label>
							<input
								name="label"
								placeholder="Personal"
								class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
							/>
						</div>
						{isAdmin && (
							<div>
								<label class="block text-xs text-slate-400 mb-1">Owner</label>
								<UserSelect name="telegram_user_id" users={users} placeholder="留空则绑定自己" />
							</div>
						)}
					</div>
					<button type="submit" class="px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm">
						添加账号
					</button>
				</form>

				{/* ── 全局操作（管理员可见） ─────────────────────────── */}
				<div class="border-t border-slate-700 mt-6 pt-4 flex flex-wrap gap-3">
					{isAdmin && (
						<button
							id="watch-all-btn"
							type="button"
							class="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold rounded-lg transition-colors text-sm"
						>
							Renew All Watches
						</button>
					)}
					<a
						class="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold rounded-lg text-center transition-colors text-sm"
						href={ROUTE_PREVIEW}
					>
						HTML → Telegram 预览
					</a>
					{isAdmin && (
						<button
							id="clear-all-kv-btn"
							type="button"
							class="px-4 py-2.5 bg-red-700 hover:bg-red-800 text-white font-semibold rounded-lg transition-colors text-sm"
						>
							清空全局 KV 缓存
						</button>
					)}
				</div>

				<div id="action-result" class="hidden" />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: dashboardScript() }} />
		</Layout>
	);
}

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
				<BackLink />
			</Card>
			<script dangerouslySetInnerHTML={{ __html: previewScript() }} />
		</Layout>
	);
}
