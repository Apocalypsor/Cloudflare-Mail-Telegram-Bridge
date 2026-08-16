import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import { useBackButton } from "@page/hooks/use-back-button";
import { confirmPopup, notifyHaptic, openExternalLink } from "@page/utils/tg";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { AccountResponse } from "@worker/api/modules/accounts/model";
import { useState } from "react";
import { AccountCard } from "./-components/account-card";
import { ErrorBox } from "./-components/error-box";
import {
  ACCOUNT_DETAIL_QUERY_KEY,
  unwrapAccountDetail,
  unwrapOAuthResponse,
} from "./-utils/api";
import { currentBusyAccountId } from "./-utils/state";

const AccountDetailPage = () => {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);

  useBackButton("/telegram-app/accounts");

  const detailQuery = useQuery({
    queryKey: ACCOUNT_DETAIL_QUERY_KEY(id),
    queryFn: async () => {
      const { data, error } = await api.api.accounts({ id }).get();
      if (error) throw error;
      return unwrapAccountDetail(data);
    },
  });

  const invalidateAccount = () => {
    qc.invalidateQueries({ queryKey: ACCOUNT_DETAIL_QUERY_KEY(id) });
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const handleError = async (err: unknown) => {
    setStatus({ msg: await extractErrorMessage(err), kind: "error" });
    notifyHaptic("error");
  };

  const authUrlMut = useMutation({
    mutationFn: async (accountId: number) => {
      const { data, error } = await api.api
        .accounts({ id: String(accountId) })
        ["oauth-url"].post();
      if (error) throw error;
      return unwrapOAuthResponse(data);
    },
    onSuccess: (data) => {
      setStatus({ msg: "正在打开授权页", kind: "ok" });
      openExternalLink(data.oauthUrl);
    },
    onError: handleError,
  });

  const renewMut = useMutation({
    mutationFn: async (accountId: number) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        ["renew-push"].post();
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "Watch 已续订", kind: "ok" });
      notifyHaptic("success");
      invalidateAccount();
    },
    onError: handleError,
  });

  const chatMut = useMutation({
    mutationFn: async ({
      accountId,
      chatId,
      topicId,
    }: {
      accountId: number;
      chatId: string;
      topicId: number | null;
    }) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        ["chat-id"].patch({ chatId, topicId });
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "Chat ID 已更新", kind: "ok" });
      notifyHaptic("success");
      invalidateAccount();
    },
    onError: handleError,
  });

  const disabledMut = useMutation({
    mutationFn: async ({
      accountId,
      disabled,
    }: {
      accountId: number;
      disabled: boolean;
    }) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        .disabled.patch({ disabled });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      setStatus({
        msg: variables.disabled ? "账号已禁用" : "账号已启用",
        kind: "ok",
      });
      notifyHaptic("success");
      invalidateAccount();
    },
    onError: handleError,
  });

  const ownerMut = useMutation({
    mutationFn: async ({
      accountId,
      telegramUserId,
    }: {
      accountId: number;
      telegramUserId: string;
    }) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        .owner.patch({ telegramUserId });
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "所有者已更新", kind: "ok" });
      notifyHaptic("success");
      invalidateAccount();
    },
    onError: handleError,
  });

  const archiveMut = useMutation({
    mutationFn: async ({
      accountId,
      labelId,
    }: {
      accountId: number;
      labelId: string | null;
    }) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        ["archive-label"].put({ labelId });
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "归档标签已保存", kind: "ok" });
      notifyHaptic("success");
      invalidateAccount();
    },
    onError: handleError,
  });

  const deleteMut = useMutation({
    mutationFn: async (accountId: number) => {
      const { error } = await api.api
        .accounts({ id: String(accountId) })
        .delete();
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "账号已删除", kind: "ok" });
      notifyHaptic("success");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      navigate({ to: "/telegram-app/accounts", replace: true });
    },
    onError: handleError,
  });

  const data = detailQuery.data;
  const accountBusyId = currentBusyAccountId({
    authUrlMut,
    renewMut,
    chatMut,
    disabledMut,
    ownerMut,
    archiveMut,
    deleteMut,
  });

  const confirmDelete = async (account: AccountResponse) => {
    const label = account.email || `#${account.id}`;
    if (!(await confirmPopup(`删除账号 ${label}？`))) return;
    deleteMut.mutate(account.id);
  };

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-zinc-100 wrap-break-word">
            {data?.account.email || (data ? `#${data.account.id}` : "账号详情")}
          </h1>
          {data && (
            <p className="mt-1 text-xs text-zinc-500">
              #{data.account.id} · {data.account.typeName}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => invalidateAccount()}
          aria-label="刷新账号"
          className={`size-9 rounded-full border border-zinc-800 bg-zinc-950 text-zinc-300 active:bg-zinc-800 ${
            detailQuery.isFetching ? "animate-spin" : ""
          }`}
        >
          ↻
        </button>
      </header>

      {status && (
        <output
          aria-live="polite"
          className={`block rounded-lg border px-4 py-2.5 text-sm font-medium ${
            status.kind === "error"
              ? "border-red-900/60 bg-red-950/40 text-red-300"
              : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {status.msg}
        </output>
      )}

      {detailQuery.isLoading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <Spinner size="lg" color="success" />
        </div>
      ) : detailQuery.isError || !data ? (
        <ErrorBox error={detailQuery.error} fallback="账号加载失败" />
      ) : (
        <AccountCard
          account={data.account}
          users={data.users}
          busy={accountBusyId === data.account.id}
          onAuthorize={(accountId) => authUrlMut.mutate(accountId)}
          onRenewPush={(accountId) => renewMut.mutate(accountId)}
          onUpdateChatId={(accountId, chatId, topicId) =>
            chatMut.mutate({ accountId, chatId, topicId })
          }
          onToggleDisabled={(accountId, disabled) =>
            disabledMut.mutate({ accountId, disabled })
          }
          onAssignOwner={(accountId, telegramUserId) =>
            ownerMut.mutate({ accountId, telegramUserId })
          }
          onDelete={confirmDelete}
          onSetArchiveLabel={(accountId, labelId) =>
            archiveMut.mutate({ accountId, labelId })
          }
        />
      )}
    </div>
  );
};

export const Route = createFileRoute("/telegram-app/accounts/$id")({
  component: AccountDetailPage,
});
