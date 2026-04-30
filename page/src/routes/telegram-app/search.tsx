import { Skeleton, Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage, validateSearch } from "@page/api/utils";
import { MailListByAccount } from "@page/components/mail-list-by-account";
import { useBackButton } from "@page/hooks/use-back-button";
import { useNavigateToMail } from "@page/hooks/use-navigate-to-mail";
import { INPUT_CLASS } from "@page/styles/inputs";
import { Type as t } from "@sinclair/typebox";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

// 查询字串放 URL，目的有二：
// 1) 搜索状态可被浏览器 / TG WebView 历史保留 —— 点击邮件后回退能回到带结果的搜索页
// 2) useQuery 用 q 做 cacheKey，回退时直接 hit 缓存，不再发请求
const Search = t.Object({ q: t.Optional(t.String()) });

export const Route = createFileRoute("/telegram-app/search")({
  component: SearchPage,
  validateSearch: validateSearch(Search),
});

function SearchPage() {
  const { q: urlQ } = Route.useSearch();
  const navigate = useNavigate();
  const navigateToMail = useNavigateToMail();

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
      const { data, error } = await api.api["mini-app"].search.get({
        query: { q },
      });
      if (error) throw error;
      return data;
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = input.trim();
    if (!next || next === q) return;
    navigate({ to: "/telegram-app/search", search: { q: next } });
  }

  const data = searchQuery.data;
  // 用 async extractErrorMessage 拉响应 body 里的 `error` 字段（比裸 message
  // 信息量大得多）。结果存 state 里，error 变化时刷新。
  const [errMsg, setErrMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!searchQuery.error) {
      setErrMsg(null);
      return;
    }
    let cancelled = false;
    extractErrorMessage(searchQuery.error).then((msg) => {
      if (!cancelled) setErrMsg(msg);
    });
    return () => {
      cancelled = true;
    };
  }, [searchQuery.error]);

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
          className={`flex-1 min-w-0 text-[15px] ${INPUT_CLASS}`}
        />
        <button
          type="submit"
          disabled={searchQuery.isFetching || !input.trim()}
          className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-[colors,transform] duration-100 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center min-w-[68px]"
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
              className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 space-y-3"
            >
              <Skeleton className="h-4 w-1/3 rounded-md" />
              <Skeleton className="h-3 w-full rounded-md" />
              <Skeleton className="h-3 w-5/6 rounded-md" />
            </div>
          ))}
        </div>
      ) : !data ? null : !data.total ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          无匹配邮件
        </div>
      ) : (
        <MailListByAccount
          results={data.results}
          errorLabel={(r) => `搜索失败：${r.error}`}
        >
          {(it, accountId) => (
            <button
              type="button"
              onClick={() => navigateToMail(accountId, it.id, it.token)}
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
          )}
        </MailListByAccount>
      )}
    </div>
  );
}
