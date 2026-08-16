import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import { useBackButton } from "@page/hooks/use-back-button";
import { confirmPopup, notifyHaptic } from "@page/utils/tg";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { UserResponse } from "@worker/api/modules/users/model";
import { useState } from "react";
import {
  formatUserLastLogin,
  USERS_QUERY_KEY,
  type UserActionInput,
} from "./-utils";

const UsersPage = () => {
  const qc = useQueryClient();
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);

  useBackButton(undefined);

  const usersQuery = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await api.api.users.get();
      if (error) throw error;
      return data.users;
    },
  });

  const invalidateUsers = () => {
    qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const handleError = async (err: unknown) => {
    setStatus({ msg: await extractErrorMessage(err), kind: "error" });
    notifyHaptic("error");
  };

  const approveMut = useMutation({
    mutationFn: async (telegramId: string) => {
      const { error } = await api.api.users({ id: telegramId }).approve.post();
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "用户已批准", kind: "ok" });
      notifyHaptic("success");
      invalidateUsers();
    },
    onError: handleError,
  });

  const revokeMut = useMutation({
    mutationFn: async (telegramId: string) => {
      const { error } = await api.api.users({ id: telegramId }).revoke.post();
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "用户权限已撤回", kind: "ok" });
      notifyHaptic("success");
      invalidateUsers();
    },
    onError: handleError,
  });

  const deleteMut = useMutation({
    mutationFn: async (telegramId: string) => {
      const { error } = await api.api.users({ id: telegramId }).delete();
      if (error) throw error;
    },
    onSuccess: () => {
      setStatus({ msg: "用户已删除", kind: "ok" });
      notifyHaptic("success");
      invalidateUsers();
    },
    onError: handleError,
  });

  const busyUserId =
    approveMut.variables ?? revokeMut.variables ?? deleteMut.variables ?? null;
  const busy =
    approveMut.isPending || revokeMut.isPending || deleteMut.isPending;

  const confirmRevoke = async (user: UserActionInput) => {
    if (!(await confirmPopup(`撤回 ${user.name} 的权限？`))) return;
    revokeMut.mutate(user.telegramId);
  };

  const confirmDelete = async (user: UserActionInput) => {
    if (!(await confirmPopup(`删除用户 ${user.name} 及其账号？`))) return;
    deleteMut.mutate(user.telegramId);
  };

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-zinc-100">用户管理</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {usersQuery.data ? `${usersQuery.data.length} 个用户` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => invalidateUsers()}
          aria-label="刷新用户"
          className={`size-9 rounded-full border border-zinc-800 bg-zinc-950 text-zinc-300 active:bg-zinc-800 ${
            usersQuery.isFetching ? "animate-spin" : ""
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

      {usersQuery.isLoading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <Spinner size="lg" color="success" />
        </div>
      ) : usersQuery.isError ? (
        <div className="rounded-2xl border border-red-900/60 bg-red-950/35 p-5 text-sm text-red-300">
          {status?.kind === "error" ? status.msg : "用户加载失败"}
        </div>
      ) : usersQuery.data?.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-10 text-center text-sm text-zinc-500">
          暂无用户
        </div>
      ) : (
        <div className="space-y-3">
          {usersQuery.data?.map((user) => (
            <UserCard
              key={user.telegramId}
              user={user}
              busy={busy && busyUserId === user.telegramId}
              disabled={busy}
              onApprove={() => approveMut.mutate(user.telegramId)}
              onRevoke={() => confirmRevoke(user)}
              onDelete={() => confirmDelete(user)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const UserCard = ({
  user,
  busy,
  disabled,
  onApprove,
  onRevoke,
  onDelete,
}: {
  user: UserResponse;
  busy: boolean;
  disabled: boolean;
  onApprove: () => void;
  onRevoke: () => void;
  onDelete: () => void;
}) => {
  const handle = user.username ? `@${user.username}` : user.telegramId;
  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-zinc-100 wrap-break-word">
            {user.name}
          </h2>
          <p className="mt-1 text-xs text-zinc-500 wrap-break-word">{handle}</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${
            user.approved
              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              : "border-amber-500/40 bg-amber-500/15 text-amber-300"
          }`}
        >
          {user.approved ? "已批准" : "待审批"}
        </span>
      </div>

      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-sm">
        <Meta label="Telegram" value={user.telegramId} />
        <Meta label="账号数" value={String(user.accountCount)} />
        <Meta label="最近登录" value={formatUserLastLogin(user.lastLoginAt)} />
      </dl>

      <div className="grid grid-cols-2 gap-2 border-t border-zinc-800 pt-4">
        {user.approved ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onRevoke}
            className="min-h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm font-semibold text-zinc-300 active:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            撤回
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={onApprove}
            className="min-h-10 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 text-sm font-semibold text-emerald-300 active:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            批准
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onDelete}
          className="min-h-10 rounded-lg border border-red-900/60 bg-red-950/35 px-3 text-sm font-semibold text-red-300 active:bg-red-950/60 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          删除
        </button>
      </div>

      {busy && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Spinner size="sm" color="success" />
          处理中
        </div>
      )}
    </article>
  );
};

const Meta = ({ label, value }: { label: string; value: string }) => (
  <>
    <dt className="text-zinc-500">{label}</dt>
    <dd className="min-w-0 text-zinc-300 wrap-break-word">{value}</dd>
  </>
);

export const Route = createFileRoute("/telegram-app/users")({
  component: UsersPage,
});
