import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import { INPUT_CLASS } from "@page/styles/inputs";
import { useQuery } from "@tanstack/react-query";
import type {
  AccountResponse,
  AccountUserOption,
} from "@worker/api/modules/accounts/model";
import { useEffect, useState } from "react";
import { unwrapArchiveLabels } from "../-utils/api";
import { parseOptionalTopicId, topicIdInputValue } from "../-utils/topic";

interface AccountCardProps {
  account: AccountResponse;
  users: AccountUserOption[];
  busy?: boolean;
  onAuthorize: (accountId: number) => void;
  onRenewPush: (accountId: number) => void;
  onUpdateChatId: (
    accountId: number,
    chatId: string,
    topicId: number | null,
  ) => void;
  onToggleDisabled: (accountId: number, disabled: boolean) => void;
  onAssignOwner: (accountId: number, telegramUserId: string) => void;
  onDelete: (account: AccountResponse) => void;
  onSetArchiveLabel: (accountId: number, labelId: string | null) => void;
}

interface ArchivePickerProps {
  value: string;
  loading: boolean;
  error: unknown;
  labels: { id: string; name: string }[];
  busy?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export const AccountCard = ({
  account,
  users,
  busy,
  onAuthorize,
  onRenewPush,
  onUpdateChatId,
  onToggleDisabled,
  onAssignOwner,
  onDelete,
  onSetArchiveLabel,
}: AccountCardProps) => {
  const [chatId, setChatId] = useState(account.chatId);
  const [topicId, setTopicId] = useState(topicIdInputValue(account.topicId));
  const [ownerId, setOwnerId] = useState(account.ownerTelegramId ?? "");
  const [archiveLabelId, setArchiveLabelId] = useState(
    account.archiveFolder ?? "",
  );

  useEffect(() => {
    setChatId(account.chatId);
    setTopicId(topicIdInputValue(account.topicId));
    setOwnerId(account.ownerTelegramId ?? "");
    setArchiveLabelId(account.archiveFolder ?? "");
  }, [account]);

  const labelsQuery = useQuery({
    queryKey: ["account-archive-labels", account.id],
    enabled: account.needsArchiveSetup && account.authorized,
    queryFn: async () => {
      const { data, error } = await api.api
        .accounts({ id: String(account.id) })
        ["archive-labels"].get();
      if (error) throw error;
      return unwrapArchiveLabels(data).labels;
    },
  });

  const archiveLabel =
    account.archiveFolderName || account.archiveFolder || "未设置";
  const parsedTopicId = parseOptionalTopicId(topicId);
  const topicChanged = parsedTopicId !== account.topicId;
  const destinationChanged = chatId.trim() !== account.chatId || topicChanged;
  const canSaveDestination =
    chatId.trim().length > 0 &&
    parsedTopicId !== undefined &&
    destinationChanged;

  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 space-y-5">
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-zinc-500">Status</dt>
        <dd className="min-w-0 flex flex-wrap gap-2">
          <StatusPill active={!account.disabled}>
            {account.disabled ? "已禁用" : "启用中"}
          </StatusPill>
          {account.oauth && (
            <StatusPill active={account.authorized}>
              {account.authorized ? "已授权" : "未授权"}
            </StatusPill>
          )}
          {busy && <Spinner size="sm" color="success" />}
        </dd>
        <Meta label="Email" value={account.email || `#${account.id}`} />
        <Meta label="Type" value={account.typeName} />
        {account.topicId != null && (
          <Meta label="Topic" value={String(account.topicId)} />
        )}
        {account.imapHost && (
          <Meta
            label="Server"
            value={`${account.imapHost}:${account.imapPort ?? ""}${
              account.imapSecure ? " TLS" : ""
            }`}
          />
        )}
        {account.imapUser && <Meta label="User" value={account.imapUser} />}
        {account.imapForwardAddress && (
          <Meta label="Forward" value={account.imapForwardAddress} />
        )}
        {account.ownerTelegramId && (
          <Meta
            label="Owner"
            value={account.ownerName || account.ownerTelegramId}
          />
        )}
        {account.needsArchiveSetup && (
          <Meta label="Archive" value={archiveLabel} />
        )}
      </dl>

      <div className="border-t border-zinc-800 pt-4 space-y-4">
        <section className="space-y-2">
          <span className="block text-sm font-semibold text-zinc-300">
            投递位置
          </span>
          <div className="grid gap-2">
            <input
              value={chatId}
              inputMode="numeric"
              aria-label="Chat ID"
              placeholder="Chat ID"
              onChange={(event) => setChatId(event.target.value)}
              className={`min-w-0 text-[15px] ${INPUT_CLASS}`}
            />
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                value={topicId}
                inputMode="numeric"
                aria-label="Topic ID"
                placeholder="Topic ID（可选）"
                onChange={(event) => setTopicId(event.target.value)}
                className={`min-w-0 text-[15px] ${INPUT_CLASS}`}
              />
              <button
                type="button"
                disabled={busy || !canSaveDestination}
                onClick={() => {
                  if (parsedTopicId === undefined) return;
                  onUpdateChatId(account.id, chatId, parsedTopicId);
                }}
                className="min-w-16 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </div>
        </section>

        {users.length > 0 && (
          <section className="space-y-2">
            <span className="block text-sm font-semibold text-zinc-300">
              所有者
            </span>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                value={ownerId}
                onChange={(event) => setOwnerId(event.target.value)}
                className={`min-w-0 text-[15px] ${INPUT_CLASS}`}
              >
                <option value="" disabled>
                  选择用户
                </option>
                {users.map((user) => (
                  <option key={user.telegramId} value={user.telegramId}>
                    {user.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={
                  busy || !ownerId || ownerId === account.ownerTelegramId
                }
                onClick={() => onAssignOwner(account.id, ownerId)}
                className="min-w-16 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </section>
        )}

        {account.needsArchiveSetup && account.authorized && (
          <section className="space-y-2">
            <span className="block text-sm font-semibold text-zinc-300">
              归档标签
            </span>
            <ArchivePicker
              value={archiveLabelId}
              loading={labelsQuery.isLoading}
              error={labelsQuery.error}
              labels={labelsQuery.data ?? []}
              busy={busy}
              onChange={setArchiveLabelId}
              onSave={() =>
                onSetArchiveLabel(account.id, archiveLabelId || null)
              }
            />
          </section>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-4 grid grid-cols-2 gap-2">
        {account.oauth && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAuthorize(account.id)}
            className="min-h-10 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 text-sm font-semibold text-emerald-300 active:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {account.authorized ? "重新授权" : "授权"}
          </button>
        )}
        {account.oauth && account.authorized && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onRenewPush(account.id)}
            className="min-h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm font-semibold text-zinc-300 active:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            续订 Watch
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggleDisabled(account.id, !account.disabled)}
          className="min-h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm font-semibold text-zinc-300 active:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {account.disabled ? "启用" : "禁用"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(account)}
          className="min-h-10 rounded-lg border border-red-900/60 bg-red-950/35 px-3 text-sm font-semibold text-red-300 active:bg-red-950/60 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          删除
        </button>
      </div>
    </article>
  );
};

const Meta = ({ label, value }: { label: string; value: string }) => (
  <>
    <dt className="text-zinc-500">{label}</dt>
    <dd className="min-w-0 text-zinc-300 wrap-break-word">{value}</dd>
  </>
);

const StatusPill = ({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) => (
  <span
    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
      active
        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
        : "border-zinc-800 bg-zinc-950 text-zinc-500"
    }`}
  >
    {children}
  </span>
);

const ArchivePicker = ({
  value,
  loading,
  error,
  labels,
  busy,
  onChange,
  onSave,
}: ArchivePickerProps) => {
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!error) {
      setErrorText(null);
      return;
    }
    let cancelled = false;
    extractErrorMessage(error).then((message) => {
      if (!cancelled) setErrorText(message);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  if (loading) {
    return (
      <div className="flex min-h-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950">
        <Spinner size="sm" />
      </div>
    );
  }

  if (errorText) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/35 px-3 py-2 text-sm text-red-300">
        {errorText}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-w-0 text-[15px] ${INPUT_CLASS}`}
      >
        <option value="">不归档</option>
        {labels.map((label) => (
          <option key={label.id} value={label.id}>
            {label.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={onSave}
        className="min-w-16 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        保存
      </button>
    </div>
  );
};
