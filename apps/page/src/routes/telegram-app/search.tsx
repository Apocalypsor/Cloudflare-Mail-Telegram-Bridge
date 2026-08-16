import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage, validateSearch } from "@page/api/utils";
import {
  MailListAddressMeta,
  MailListFlat,
} from "@page/components/mail-list-flat";
import { MailListSkeleton } from "@page/components/mail-list-skeleton";
import { useBackButton } from "@page/hooks/use-back-button";
import { useInfiniteScrollSentinel } from "@page/hooks/use-infinite-scroll-sentinel";
import { useNavigateToMail } from "@page/hooks/use-navigate-to-mail";
import { INPUT_CLASS } from "@page/styles/inputs";
import {
  collectMailListErrors,
  encodeMailListCursor,
  flattenMailListPages,
  getNextMailListCursor,
  MAIL_LIST_PAGE_SIZE,
  type MailListCursor,
} from "@page/utils/mail-list-pagination";
import { Type as t } from "@sinclair/typebox";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

const SearchPage = () => {
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

  const searchQuery = useInfiniteQuery({
    queryKey: ["search", q],
    enabled: q.length > 0,
    initialPageParam: undefined as MailListCursor | undefined,
    // 搜索结果在用户停留期间认为是新鲜的；切回页面不重新打 provider
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async ({ pageParam }) => {
      const cursor = encodeMailListCursor(pageParam);
      const { data, error } = await api.api["mini-app"].search.get({
        query: {
          q,
          limit: MAIL_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: getNextMailListCursor,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = input.trim();
    if (!next || next === q) return;
    navigate({ to: "/telegram-app/search", search: { q: next } });
  };

  const pages = searchQuery.data?.pages;
  const firstPage = pages?.[0];
  const items = flattenMailListPages(pages);
  const accountErrors = collectMailListErrors(pages);
  const handleLoadMore = useCallback(() => {
    if (!searchQuery.hasNextPage || searchQuery.isFetchingNextPage) return;
    void searchQuery.fetchNextPage();
  }, [
    searchQuery.fetchNextPage,
    searchQuery.hasNextPage,
    searchQuery.isFetchingNextPage,
  ]);
  const loadMoreRef = useInfiniteScrollSentinel({
    enabled: Boolean(
      searchQuery.hasNextPage && !searchQuery.isFetchingNextPage,
    ),
    onLoadMore: handleLoadMore,
  });
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
          className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-[colors,transform] duration-100 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center min-w-17"
        >
          {searchQuery.isFetching ? <Spinner size="sm" /> : "搜索"}
        </button>
      </form>

      <div
        className={`text-[13px] min-h-4.5 ${
          errMsg ? "text-red-400" : "text-zinc-500"
        }`}
      >
        {errMsg ??
          (firstPage
            ? `已载入 ${items.length} 封匹配 “${firstPage.query}”`
            : "支持跨所有账号检索（Gmail / Outlook 走原生搜索语法）")}
      </div>

      {!q ? null : searchQuery.isLoading ? (
        <MailListSkeleton />
      ) : !firstPage ? null : items.length === 0 &&
        accountErrors.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          无匹配邮件
        </div>
      ) : (
        <>
          <MailListFlat
            items={items}
            errors={accountErrors}
            errorLabel={(r) => `搜索失败：${r.error}`}
          >
            {(it) => (
              <button
                type="button"
                onClick={() => navigateToMail(it.accountId, it.id, it.token)}
                className="block w-full text-left px-4 py-3 hover:bg-zinc-800/60 active:bg-zinc-800 transition-colors"
              >
                <div className="text-sm text-emerald-300 wrap-break-word">
                  {it.title || "(无主题)"}
                </div>
                <MailListAddressMeta item={it} />
              </button>
            )}
          </MailListFlat>
          <div
            ref={loadMoreRef}
            className="min-h-10 flex items-center justify-center"
          >
            {searchQuery.isFetchingNextPage ? (
              <Spinner size="sm" />
            ) : searchQuery.hasNextPage ? (
              <span className="text-xs text-zinc-600">继续加载</span>
            ) : (
              <span className="text-xs text-zinc-700">已全部载入</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const Search = t.Object({ q: t.Optional(t.String()) });

export const Route = createFileRoute("/telegram-app/search")({
  component: SearchPage,
  validateSearch: validateSearch(Search),
});
