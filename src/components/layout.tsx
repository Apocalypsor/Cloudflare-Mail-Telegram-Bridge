import type { Child } from 'hono/jsx';

export function Layout({ title, children }: { title: string; children: Child }) {
	return (
		<html lang="zh-CN">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<script src="https://cdn.tailwindcss.com" />
			</head>
			<body class="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center p-6 font-sans">{children}</body>
		</html>
	);
}

export function BackLink({ secret }: { secret: string }) {
	return (
		<p class="mt-5">
			<a href={`/?secret=${encodeURIComponent(secret)}`} class="text-blue-400 hover:text-blue-300 text-sm">
				&larr; 返回主页
			</a>
		</p>
	);
}

export function Card({ children, class: className }: { children: Child; class?: string }) {
	return <main class={`w-full bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-xl ${className ?? ''}`}>{children}</main>;
}
