import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import {
  MailListAddressMeta,
  MailListFlat,
} from "@page/components/mail-list-flat";
import { MailListSkeleton } from "@page/components/mail-list-skeleton";
import { MAIL_LIST_TITLES } from "@page/constants";
import { useBackButton } from "@page/hooks/use-back-button";
import { useInfiniteScrollSentinel } from "@page/hooks/use-infinite-scroll-sentinel";
import { useNavigateToMail } from "@page/hooks/use-navigate-to-mail";
import {
  collectMailListErrors,
  encodeMailListCursor,
  flattenMailListPages,
  getNextMailListCursor,
  MAIL_LIST_PAGE_SIZE,
  type MailListCursor,
} from "@page/utils/mail-list-pagination";
import { confirmPopup, notifyHaptic } from "@page/utils/tg";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { MailListType } from "@worker/api/modules/miniapp/model";
import { useCallback, useMemo, useState } from "react";
import { BULK_ACTIONS, isMailListType } from "./-utils";

const MailListPage = () => {
  const { type: typeParam } = Route.useParams();
  if (!isMailListType(typeParam)) throw notFound();
  const listType: MailListType = typeParam;
  const bulk = BULK_ACTIONS[listType];
  const navigateToMail = useNavigateToMail();

  // 列表页从 bot 按钮直接进来，没有上一级，不显示 BackButton
  useBackButton(undefined);

  const qc = useQueryClient();
  const [meta, setMeta] = useState<{
    msg: string;
    kind: "ok" | "error" | "";
  } | null>(null);

  // junk/archived 列表：mail 页 fetch 需要 folder 提示给 IMAP 定位 UID
  const folderHint = useMemo(
    () =>
      listType === "junk" ? "junk" : listType === "archived" ? "archive" : "",
    [listType],
  );

  const listQuery = useInfiniteQuery({
    queryKey: ["mail-list", listType],
    initialPageParam: undefined as MailListCursor | undefined,
    queryFn: async ({ pageParam }) => {
      const cursor = encodeMailListCursor(pageParam);
      const { data, error } = await api.api["mini-app"]
        .list({ type: listType })
        .get({
          query: {
            limit: MAIL_LIST_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          },
        });
      if (error) throw error;
      return data;
    },
    getNextPageParam: getNextMailListCursor,
  });

  const bulkMut = useMutation({
    mutationFn: async () => {
      if (!bulk) throw new Error("no bulk action");
      return await bulk.run();
    },
    onSuccess: (data) => {
      const msg =
        `✅ 成功 ${data.success} 封` +
        (data.failed > 0 ? `，❌ ${data.failed} 封失败` : "");
      setMeta({ msg, kind: "ok" });
      notifyHaptic(data.failed > 0 ? "warning" : "success");
      qc.invalidateQueries({ queryKey: ["mail-list", listType] });
    },
    onError: async (err) =>
      setMeta({ msg: await extractErrorMessage(err), kind: "error" }),
  });

  const handleBulk = async () => {
    if (!bulk) return;
    if (!(await confirmPopup(bulk.confirmText))) return;
    setMeta(null);
    bulkMut.mutate();
  };

  const items = flattenMailListPages(listQuery.data?.pages);
  const accountErrors = collectMailListErrors(listQuery.data?.pages);
  const isError = listQuery.isError;
  const isRefreshing = listQuery.isFetching;
  const handleLoadMore = useCallback(() => {
    if (!listQuery.hasNextPage || listQuery.isFetchingNextPage) return;
    void listQuery.fetchNextPage();
  }, [
    listQuery.fetchNextPage,
    listQuery.hasNextPage,
    listQuery.isFetchingNextPage,
  ]);
  const loadMoreRef = useInfiniteScrollSentinel({
    enabled: Boolean(listQuery.hasNextPage && !listQuery.isFetchingNextPage),
    onLoadMore: handleLoadMore,
  });

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex justify-between items-center gap-2">
        <h1 className="text-xl font-semibold text-zinc-100">
          {MAIL_LIST_TITLES[listType]}
        </h1>
        <div className="flex items-center gap-2">
          {bulk && (
            <button
              type="button"
              onClick={handleBulk}
              disabled={bulkMut.isPending}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 ${
                bulk.danger
                  ? "bg-red-950/40 hover:bg-red-950/60 text-red-300 border border-red-900/60"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700"
              }`}
            >
              {bulkMut.isPending ? <Spinner size="sm" /> : bulk.label}
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["mail-list", listType] })
            }
            aria-label="强制刷新"
            className={`w-8 h-8 rounded-full flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors ${
              isRefreshing ? "animate-spin" : ""
            }`}
          >
            ↻
          </button>
        </div>
      </div>

      <div
        className={`text-[13px] min-h-4.5 ${
          meta?.kind === "error"
            ? "text-red-400"
            : meta?.kind === "ok"
              ? "text-emerald-400"
              : "text-zinc-500"
        }`}
      >
        {meta?.msg ?? (items.length > 0 ? `已载入 ${items.length} 封` : "")}
      </div>

      {listQuery.isLoading ? (
        <MailListSkeleton />
      ) : isError ? (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/30 p-10 text-center text-sm text-red-400">
          查询失败
        </div>
      ) : items.length === 0 && accountErrors.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          暂无邮件
        </div>
      ) : (
        <>
          <MailListFlat
            items={items}
            errors={accountErrors}
            errorLabel={() => "查询失败"}
          >
            {(it) => (
              <button
                type="button"
                onClick={() =>
                  navigateToMail(it.accountId, it.id, it.token, {
                    folder: folderHint || undefined,
                  })
                }
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
            {listQuery.isFetchingNextPage ? (
              <Spinner size="sm" />
            ) : listQuery.hasNextPage ? (
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

export const Route = createFileRoute("/telegram-app/list/$type")({
  component: MailListPage,
  beforeLoad: ({ params }) => {
    if (!isMailListType(params.type)) throw notFound();
  },
});
