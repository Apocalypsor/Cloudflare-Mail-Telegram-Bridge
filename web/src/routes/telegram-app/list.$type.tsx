import { Button, Card, Chip, Skeleton, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { useMemo, useState } from "react";
import { z } from "zod";
import { api, extractErrorMessage } from "@/api/client";
import {
  bulkActionResponseSchema,
  type MailListType,
  mailListResponseSchema,
  mailListTypeSchema,
} from "@/api/schemas";
import { useBackButton } from "@/hooks/useBackButton";
import {
  MAIL_LIST_TITLES,
  MAIL_LIST_TYPES,
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
} from "@/paths";
import { getTelegram } from "@/providers/telegram";

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
      getTelegram()?.HapticFeedback?.notificationOccurred(
        data.failed > 0 ? "warning" : "success",
      );
      qc.invalidateQueries({ queryKey: ["mail-list", type] });
    },
    onError: async (err) =>
      setMeta({ msg: await extractErrorMessage(err), kind: "error" }),
  });

  function handleBulk() {
    if (!bulk) return;
    const tg = getTelegram();
    const run = () => {
      // 不再写 loadingText，按钮自己走 isDisabled + Spinner
      setMeta(null);
      bulkMut.mutate();
    };
    if (tg?.showConfirm) {
      tg.showConfirm(bulk.confirmText, (ok) => {
        if (ok) run();
      });
    } else if (window.confirm(bulk.confirmText)) {
      run();
    }
  }

  function openMail(id: string, accountId: number, token: string) {
    const back = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    const folder = folderHint ? `&folder=${folderHint}` : "";
    window.location.href = `/telegram-app/mail/${encodeURIComponent(id)}?accountId=${accountId}&t=${encodeURIComponent(token)}${folder}&back=${back}`;
  }

  const data = listQuery.data;
  const isError = listQuery.isError;
  const isRefreshing = listQuery.isFetching;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex justify-between items-center gap-2">
        <h1 className="text-xl font-semibold text-[color:var(--foreground)]">
          {MAIL_LIST_TITLES[type]}
        </h1>
        <div className="flex items-center gap-2">
          {bulk && (
            <Button
              type="button"
              onClick={handleBulk}
              isDisabled={bulkMut.isPending}
              variant={bulk.danger ? "danger-soft" : "outline"}
              size="sm"
              className="rounded-full"
            >
              {bulkMut.isPending ? <Spinner size="sm" /> : bulk.label}
            </Button>
          )}
          <Button
            isIconOnly
            variant="outline"
            size="sm"
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["mail-list", type] })
            }
            aria-label="强制刷新"
            className={`rounded-full ${isRefreshing ? "animate-spin" : ""}`}
          >
            ↻
          </Button>
        </div>
      </div>

      <div
        className={`text-[13px] min-h-[18px] ${
          meta?.kind === "error"
            ? "text-[color:var(--danger)]"
            : meta?.kind === "ok"
              ? "text-[color:var(--success)]"
              : "text-[color:var(--muted)]"
        }`}
      >
        {meta?.msg ?? (data?.total != null ? `共 ${data.total} 封` : "")}
      </div>

      {listQuery.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-4 space-y-3">
              <Skeleton className="h-4 w-1/3 rounded-md" />
              <Skeleton className="h-3 w-full rounded-md" />
              <Skeleton className="h-3 w-5/6 rounded-md" />
            </Card>
          ))}
        </div>
      ) : isError ? (
        <Card className="p-10 text-center">
          <div className="text-sm text-[color:var(--danger)]">查询失败</div>
        </Card>
      ) : !data?.total ? (
        <Card className="p-10 text-center">
          <div className="text-sm text-[color:var(--muted)]">暂无邮件</div>
        </Card>
      ) : (
        data.results.map((r) => {
          if (r.error) {
            return (
              <AccountBox
                key={r.accountId}
                errored
                label={r.accountEmail || `Account #${r.accountId}`}
              >
                <div className="px-4 py-3 text-sm text-[color:var(--danger)]">
                  查询失败
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
              <ul className="divide-y divide-[color:var(--surface-secondary)]">
                {r.items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => openMail(it.id, r.accountId, it.token)}
                      className="block w-full text-left px-4 py-3 text-sm break-words hover:bg-[color:var(--surface-secondary)] active:bg-[color:var(--surface-tertiary)] transition-colors"
                    >
                      {it.title || "(无主题)"}
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
    <Card className="overflow-hidden">
      <div
        className={`flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] ${
          errored ? "text-[color:var(--danger)]" : "text-[color:var(--muted)]"
        }`}
      >
        <span className="truncate">{label}</span>
        {count != null && (
          <Chip size="sm" variant="soft" color="accent">
            {count}
          </Chip>
        )}
      </div>
      {children}
    </Card>
  );
}
