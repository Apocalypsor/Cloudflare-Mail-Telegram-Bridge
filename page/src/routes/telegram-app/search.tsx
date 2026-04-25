import { Skeleton, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { useEffect, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import { ROUTE_MINI_APP_API_SEARCH } from "@/api/routes";
import { mailSearchResponseSchema } from "@/api/schemas";
import { useBackButton } from "@/hooks/use-back-button";

// 查询字串放 URL，目的有二：
// 1) 搜索状态可被浏览器 / TG WebView 历史保留 —— 点击邮件后回退能回到带结果的搜索页
// 2) useQuery 用 q 做 cacheKey，回退时直接 hit 缓存，不再发请求
const searchSchema = z.object({
  q: fallback(z.string().optional(), undefined),
});

export const Route = createFileRoute("/telegram-app/search")({
  component: SearchPage,
  validateSearch: zodValidator(searchSchema),
});

function SearchPage() {
  const { q: urlQ } = Route.useSearch();
  const navigate = useNavigate();

  // 搜索页是从主菜单进入的根页 —— 不显示 BackButton
  useBackButton(undefined);

  // input 是 URL 的可编辑镜像。URL 变化时同步过来（含从 mail 页回退到这里的场景）。
  const [input, setInput] = useState(urlQ ?? "");
  useEffect(() => {
    setInput(urlQ ?? "");
  }, [urlQ]);

  const q = (urlQ ?? "").trim();

  const searchQuery = useQuery({
    queryKey: ["search", q],
    enabled: q.length > 0,
    // 搜索结果在用户停留期间认为是新鲜的；切回页面不重新打 provider
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      const data = await api
        .get(ROUTE_MINI_APP_API_SEARCH.replace(/^\//, ""), {
          searchParams: { q },
        })
        .json();
      return mailSearchResponseSchema.parse(data);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = input.trim();
    if (!next || next === q) return;
    navigate({ to: "/telegram-app/search", search: { q: next } });
  }

  function openMail(id: string, accountId: number, token: string) {
    const back = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/telegram-app/mail/${encodeURIComponent(id)}?accountId=${accountId}&t=${encodeURIComponent(token)}&back=${back}`;
  }

  const data = searchQuery.data;
  const errMsg = searchQuery.error ? extractErrorSync(searchQuery.error) : null;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <h1 className="text-xl font-semibold text-zinc-100">🔍 搜索邮件</h1>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="search"
          enterKeyHint="search"
          placeholder="关键词、发件人、主题…"
          maxLength={200}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-[15px] outline-none focus:border-emerald-500 placeholder:text-zinc-600 transition-colors"
        />
        <button
          type="submit"
          disabled={searchQuery.isFetching || !input.trim()}
          className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center min-w-[68px]"
        >
          {searchQuery.isFetching ? <Spinner size="sm" /> : "搜索"}
        </button>
      </form>

      <div
        className={`text-[13px] min-h-[18px] ${
          errMsg ? "text-red-400" : "text-zinc-500"
        }`}
      >
        {errMsg ??
          (data
            ? `找到 ${data.total} 封匹配 “${data.query}”`
            : "支持跨所有账号检索（Gmail / Outlook 走原生搜索语法）")}
      </div>

      {!q ? null : searchQuery.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3"
            >
              <Skeleton className="h-4 w-1/3 rounded-md" />
              <Skeleton className="h-3 w-full rounded-md" />
              <Skeleton className="h-3 w-5/6 rounded-md" />
            </div>
          ))}
        </div>
      ) : !data ? null : !data.total ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          无匹配邮件
        </div>
      ) : (
        data.results.map((r) => {
          if (r.error) {
            return (
              <AccountBox
                key={r.accountId}
                errored
                label={r.accountEmail || `Account #${r.accountId}`}
              >
                <div className="px-4 py-3 text-sm text-red-400">
                  搜索失败：{r.error}
                </div>
              </AccountBox>
            );
          }
          if (!r.total) return null;
          return (
            <AccountBox
              key={r.accountId}
              label={r.accountEmail || `Account #${r.accountId}`}
              count={r.total}
            >
              <ul className="divide-y divide-zinc-800">
                {r.items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => openMail(it.id, r.accountId, it.token)}
                      className="block w-full text-left px-4 py-3 hover:bg-zinc-800/60 active:bg-zinc-800 transition-colors"
                    >
                      <div className="text-sm text-zinc-100 break-words">
                        {it.title || "(无主题)"}
                      </div>
                      {it.from && (
                        <div className="text-xs text-zinc-500 break-words mt-1">
                          {it.from}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </AccountBox>
          );
        })
      )}
    </div>
  );
}

// useQuery 错误同步取一个能渲染的字符串。HTTPError body 解析需要 async，
// 这里暂时只读 message —— ky 错误对象的 .message 已经包含 status + URL，
// 对调试足够；要看后端 error 字段可以打开网络面板。
function extractErrorSync(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function AccountBox({
  label,
  count,
  errored,
  children,
}: {
  label: string;
  count?: number;
  errored?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div
        className={`flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] bg-zinc-950/30 border-b border-zinc-800 ${
          errored ? "text-red-400" : "text-zinc-400"
        }`}
      >
        <span className="truncate font-medium">{label}</span>
        {count != null && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
