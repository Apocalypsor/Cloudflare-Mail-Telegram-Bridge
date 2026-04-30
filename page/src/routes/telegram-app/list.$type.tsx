import { Skeleton, Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage, validateSearch } from "@page/api/utils";
import { MailListByAccount } from "@page/components/mail-list-by-account";
import { MAIL_LIST_TITLES, MAIL_LIST_TYPES } from "@page/constants";
import { useBackButton } from "@page/hooks/use-back-button";
import { useNavigateToMail } from "@page/hooks/use-navigate-to-mail";
import { confirmPopup, notifyHaptic } from "@page/utils/tg";
import { Type as t } from "@sinclair/typebox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { MailListType } from "@worker/api/modules/miniapp/model";
import { useMemo, useState } from "react";

interface BulkAction {
  label: string;
  run: () => Promise<{ success: number; failed: number }>;
  confirmText: string;
  danger?: boolean;
}

const BULK_ACTIONS: Partial<Record<MailListType, BulkAction>> = {
  unread: {
    label: "✓ 全部已读",
    run: async () => {
      const { data, error } =
        await api.api["mini-app"]["mark-all-as-read"].post();
      if (error) throw error;
      return data;
    },
    confirmText: "把所有未读邮件标记为已读？",
  },
  junk: {
    label: "🗑 清空垃圾",
    run: async () => {
      const { data, error } =
        await api.api["mini-app"]["trash-all-junk"].post();
      if (error) throw error;
      return data;
    },
    confirmText: "清空所有账号的垃圾邮件？此操作不可撤销。",
    danger: true,
  },
};

function isMailListType(s: string): s is MailListType {
  return (MAIL_LIST_TYPES as readonly string[]).includes(s);
}

const Search = t.Object({ cache: t.Optional(t.Boolean()) });

export const Route = createFileRoute("/telegram-app/list/$type")({
  component: MailListPage,
  validateSearch: validateSearch(Search),
  beforeLoad: ({ params }) => {
    if (!isMailListType(params.type)) throw notFound();
  },
});

function MailListPage() {
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

  const listQuery = useQuery({
    queryKey: ["mail-list", listType],
    queryFn: async () => {
      const { data, error } = await api.api["mini-app"]
        .list({ type: listType })
        .get();
      if (error) throw error;
      return data;
    },
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

  async function handleBulk() {
    if (!bulk) return;
    if (!(await confirmPopup(bulk.confirmText))) return;
    setMeta(null);
    bulkMut.mutate();
  }

  const data = listQuery.data;
  const isError = listQuery.isError;
  const isRefreshing = listQuery.isFetching;

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
        className={`text-[13px] min-h-[18px] ${
          meta?.kind === "error"
            ? "text-red-400"
            : meta?.kind === "ok"
              ? "text-emerald-400"
              : "text-zinc-500"
        }`}
      >
        {meta?.msg ?? (data?.total != null ? `共 ${data.total} 封` : "")}
      </div>

      {listQuery.isLoading ? (
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
      ) : isError ? (
        <div className="rounded-2xl border border-red-900/50 bg-red-950/30 p-10 text-center text-sm text-red-400">
          查询失败
        </div>
      ) : !data?.total ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          暂无邮件
        </div>
      ) : (
        <MailListByAccount results={data.results} errorLabel={() => "查询失败"}>
          {(it, accountId) => (
            <button
              type="button"
              onClick={() =>
                navigateToMail(accountId, it.id, it.token, {
                  folder: folderHint || undefined,
                })
              }
              className="block w-full text-left px-4 py-3 text-sm text-zinc-100 break-words hover:bg-zinc-800/60 active:bg-zinc-800 transition-colors"
            >
              {it.title || "(无主题)"}
            </button>
          )}
        </MailListByAccount>
      )}
    </div>
  );
}
