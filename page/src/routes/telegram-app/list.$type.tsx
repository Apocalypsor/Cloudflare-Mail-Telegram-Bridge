import { Skeleton, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
} from "@worker/handlers/hono/routes";
import { useMemo, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import {
  bulkActionResponseSchema,
  type MailListType,
  mailListResponseSchema,
  mailListTypeSchema,
} from "@/api/schemas";
import { extractErrorMessage } from "@/api/utils";
import { MailListByAccount } from "@/components/mail-list-by-account";
import { MAIL_LIST_TITLES, MAIL_LIST_TYPES } from "@/constants";
import { useBackButton } from "@/hooks/use-back-button";
import { useNavigateToMail } from "@/hooks/use-navigate-to-mail";
import { confirmPopup, notifyHaptic } from "@/utils/tg";

interface BulkAction {
  label: string;
  url: string;
  confirmText: string;
  danger?: boolean;
}

const BULK_ACTIONS: Partial<Record<MailListType, BulkAction>> = {
  unread: {
    label: "✓ 全部已读",
    url: ROUTE_MINI_APP_API_MARK_ALL_READ,
    confirmText: "把所有未读邮件标记为已读？",
  },
  junk: {
    label: "🗑 清空垃圾",
    url: ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
    confirmText: "清空所有账号的垃圾邮件？此操作不可撤销。",
    danger: true,
  },
};

const searchSchema = z.object({
  cache: fallback(z.coerce.boolean().optional(), undefined),
});

export const Route = createFileRoute("/telegram-app/list/$type")({
  component: MailListPage,
  validateSearch: zodValidator(searchSchema),
  beforeLoad: ({ params }) => {
    if (!MAIL_LIST_TYPES.includes(params.type as MailListType)) {
      throw notFound();
    }
  },
});

function MailListPage() {
  const { type: typeParam } = Route.useParams();
  const type = mailListTypeSchema.parse(typeParam);
  const bulk = BULK_ACTIONS[type];
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
    () => (type === "junk" ? "junk" : type === "archived" ? "archive" : ""),
    [type],
  );

  const listQuery = useQuery({
    queryKey: ["mail-list", type],
    queryFn: async () => {
      const data = await api
        .get(ROUTE_MINI_APP_API_LIST.replace(":type", type).replace(/^\//, ""))
        .json();
      return mailListResponseSchema.parse(data);
    },
  });

  const bulkMut = useMutation({
    mutationFn: async () => {
      if (!bulk) throw new Error("no bulk action");
      const data = await api.post(bulk.url.replace(/^\//, "")).json();
      return bulkActionResponseSchema.parse(data);
    },
    onSuccess: (data) => {
      const msg =
        `✅ 成功 ${data.success} 封` +
        (data.failed > 0 ? `，❌ ${data.failed} 封失败` : "");
      setMeta({ msg, kind: "ok" });
      notifyHaptic(data.failed > 0 ? "warning" : "success");
      qc.invalidateQueries({ queryKey: ["mail-list", type] });
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
          {MAIL_LIST_TITLES[type]}
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
              qc.invalidateQueries({ queryKey: ["mail-list", type] })
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
              className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3"
            >
              <Skeleton className="h-4 w-1/3 rounded-md" />
              <Skeleton className="h-3 w-full rounded-md" />
              <Skeleton className="h-3 w-5/6 rounded-md" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-10 text-center text-sm text-red-400">
          查询失败
        </div>
      ) : !data?.total ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
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
