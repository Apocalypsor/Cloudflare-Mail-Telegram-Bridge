import { Button, Card, Chip, Skeleton, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { api, extractErrorMessage } from "@/lib/api";
import {
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
} from "@/lib/routes";
import {
  emailContextResponseSchema,
  okResponseSchema,
  type Reminder,
  remindersListResponseSchema,
} from "@/lib/schemas";
import { getTelegram } from "@/lib/tg";

// 三件套任缺其一 → 退化为"所有待提醒"列表模式。用 fallback 吞掉格式错误，
// 避免脏 URL 让整页崩在 errorComponent。
const searchSchema = z.object({
  accountId: fallback(z.coerce.number().optional(), undefined),
  emailMessageId: fallback(z.string().optional(), undefined),
  token: fallback(z.string().optional(), undefined),
});

type Search = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/telegram-app/reminders")({
  component: RemindersPage,
  validateSearch: zodValidator(searchSchema),
});

const PRESETS: { label: string; mins: number | "tonight20" | "tomorrow9" }[] = [
  { label: "10 分钟", mins: 10 },
  { label: "30 分钟", mins: 30 },
  { label: "1 小时", mins: 60 },
  { label: "3 小时", mins: 180 },
  { label: "今晚 20:00", mins: "tonight20" },
  { label: "明早 09:00", mins: "tomorrow9" },
];

function fmt2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${fmt2(d.getMonth() + 1)}-${fmt2(d.getDate())}`;
}
function hm(d: Date): string {
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${fmt2(d.getMonth() + 1)}-${fmt2(d.getDate())} ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function presetToDate(kind: (typeof PRESETS)[number]["mins"]): Date {
  if (kind === "tomorrow9") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  if (kind === "tonight20") {
    const d = new Date();
    d.setHours(20, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(Date.now() + kind * 60_000);
}

function RemindersPage() {
  const search: Search = Route.useSearch();
  const listOnly = !search.accountId || !search.emailMessageId || !search.token;

  const qc = useQueryClient();
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);
  const [date, setDate] = useState<string>(() =>
    ymd(new Date(Date.now() + 60_000)),
  );
  const [time, setTime] = useState<string>(() =>
    hm(new Date(Date.now() + 60_000)),
  );
  const [text, setText] = useState("");
  const [activePreset, setActivePreset] = useState<number | null>(null);

  const emailCtx = useQuery({
    queryKey: [
      "email-context",
      search.accountId,
      search.emailMessageId,
      search.token,
    ],
    enabled: !listOnly,
    queryFn: async () => {
      const data = await api
        .get(ROUTE_REMINDERS_API_EMAIL_CONTEXT.replace(/^\//, ""), {
          searchParams: {
            accountId: String(search.accountId),
            emailMessageId: search.emailMessageId ?? "",
            token: search.token ?? "",
          },
        })
        .json();
      return emailContextResponseSchema.parse(data);
    },
  });

  const remindersKey = useMemo(
    () =>
      listOnly
        ? ["reminders", "all"]
        : ["reminders", search.accountId, search.emailMessageId, search.token],
    [listOnly, search.accountId, search.emailMessageId, search.token],
  );

  const remindersQuery = useQuery({
    queryKey: remindersKey,
    queryFn: async () => {
      const searchParams: Record<string, string> = {};
      if (!listOnly) {
        searchParams.accountId = String(search.accountId);
        searchParams.emailMessageId = search.emailMessageId ?? "";
        searchParams.token = search.token ?? "";
      }
      const data = await api
        .get(ROUTE_REMINDERS_API.replace(/^\//, ""), { searchParams })
        .json();
      return remindersListResponseSchema.parse(data);
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const localDt = new Date(`${date}T${time}`);
      if (Number.isNaN(localDt.getTime())) throw new Error("时间格式错误");
      if (localDt.getTime() <= Date.now()) throw new Error("提醒时间需在未来");
      const data = await api
        .post(ROUTE_REMINDERS_API.replace(/^\//, ""), {
          json: {
            text: text.trim(),
            remind_at: localDt.toISOString(),
            accountId: search.accountId,
            emailMessageId: search.emailMessageId,
            token: search.token,
          },
        })
        .json();
      const parsed = okResponseSchema.parse(data);
      if (!parsed.ok) throw new Error(parsed.error || "保存失败");
      return parsed;
    },
    onSuccess: () => {
      setStatus({ msg: "✅ 已设定提醒", kind: "ok" });
      setText("");
      const d = new Date(Date.now() + 60_000);
      setDate(ymd(d));
      setTime(hm(d));
      setActivePreset(null);
      getTelegram()?.HapticFeedback?.notificationOccurred("success");
      qc.invalidateQueries({ queryKey: remindersKey });
    },
    onError: async (err) => {
      setStatus({ msg: await extractErrorMessage(err), kind: "error" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      await api
        .delete(`${ROUTE_REMINDERS_API.replace(/^\//, "")}/${id}`)
        .json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: remindersKey }),
    onError: async (err) =>
      setStatus({ msg: await extractErrorMessage(err), kind: "error" }),
  });

  function applyPreset(idx: number) {
    const d = presetToDate(PRESETS[idx].mins);
    setDate(ymd(d));
    setTime(hm(d));
    setActivePreset(idx);
  }

  function openMail() {
    if (listOnly) return;
    const back = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href =
      `/telegram-app/mail/${encodeURIComponent(search.emailMessageId ?? "")}` +
      `?accountId=${search.accountId}&t=${encodeURIComponent(search.token ?? "")}&back=${back}`;
  }

  const minDate = ymd(new Date());

  useEffect(() => {
    getTelegram()?.BackButton?.hide();
  }, []);

  const reminders = remindersQuery.data?.reminders ?? [];

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-4">
      <h1 className="text-xl font-semibold text-[color:var(--foreground)]">
        {listOnly ? "⏰ 我的提醒" : "⏰ 邮件提醒"}
      </h1>

      {!listOnly && (
        <EmailCard
          subject={emailCtx.data?.subject ?? null}
          accountEmail={emailCtx.data?.accountEmail ?? null}
          loading={emailCtx.isLoading}
          error={emailCtx.isError}
          onClick={openMail}
        />
      )}

      {!listOnly && (
        <AddSection
          date={date}
          time={time}
          text={text}
          minDate={minDate}
          activePreset={activePreset}
          saving={createMut.isPending}
          status={status}
          onDateChange={setDate}
          onTimeChange={setTime}
          onTextChange={setText}
          onPreset={applyPreset}
          onSave={() => {
            setStatus(null);
            createMut.mutate();
          }}
        />
      )}

      <ListSection
        listOnly={listOnly}
        reminders={reminders}
        loading={remindersQuery.isLoading}
        deletingId={deleteMut.isPending ? (deleteMut.variables ?? null) : null}
        onDelete={(id) => deleteMut.mutate(id)}
      />
    </div>
  );
}

function EmailCard({
  subject,
  accountEmail,
  loading,
  error,
  onClick,
}: {
  subject: string | null;
  accountEmail: string | null;
  loading: boolean;
  error: boolean;
  onClick: () => void;
}) {
  // Card 不是多态（只能 div），包一层 button 做交互；外观保持卡片感
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left rounded-xl border-l-4 border-[color:var(--accent)] bg-[color:var(--surface)] text-[color:var(--surface-foreground)] shadow-sm p-4 hover:opacity-90 active:opacity-75 transition-opacity cursor-pointer"
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4 rounded-md" />
          <Skeleton className="h-3 w-1/2 rounded-md" />
        </div>
      ) : (
        <>
          <div className="text-[15px] font-semibold break-words">
            {error ? "邮件信息加载失败" : subject || "(无主题)"}
          </div>
          {accountEmail && (
            <div className="text-xs text-[color:var(--muted)] mt-1">
              账号: {accountEmail}
            </div>
          )}
          <div className="text-[11px] text-[color:var(--accent)] mt-2">
            点击查看邮件 →
          </div>
        </>
      )}
    </button>
  );
}

function AddSection({
  date,
  time,
  text,
  minDate,
  activePreset,
  saving,
  status,
  onDateChange,
  onTimeChange,
  onTextChange,
  onPreset,
  onSave,
}: {
  date: string;
  time: string;
  text: string;
  minDate: string;
  activePreset: number | null;
  saving: boolean;
  status: { msg: string; kind: "ok" | "error" } | null;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  onTextChange: (v: string) => void;
  onPreset: (idx: number) => void;
  onSave: () => void;
}) {
  return (
    <Card className="p-4 space-y-4">
      <div>
        <label
          htmlFor="when-date"
          className="block text-xs text-[color:var(--muted)] mb-2"
        >
          提醒时间
        </label>
        <div className="flex gap-2">
          <input
            id="when-date"
            type="date"
            value={date}
            min={minDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2.5 rounded-lg border border-[color:var(--field-border,transparent)] bg-[color:var(--field-background)] text-[color:var(--field-foreground)] text-[15px] outline-none focus:ring-2 focus:ring-[color:var(--accent)]/40"
          />
          <input
            type="time"
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className="flex-[0_0_38%] min-w-0 px-3 py-2.5 rounded-lg border border-[color:var(--field-border,transparent)] bg-[color:var(--field-background)] text-[color:var(--field-foreground)] text-[15px] outline-none focus:ring-2 focus:ring-[color:var(--accent)]/40"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p, i) => (
          <Button
            key={p.label}
            type="button"
            onClick={() => onPreset(i)}
            variant={activePreset === i ? "primary" : "outline"}
            size="sm"
            className="rounded-full"
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div>
        <label
          htmlFor="remind-text"
          className="block text-xs text-[color:var(--muted)] mb-2"
        >
          备注（可选）
        </label>
        <textarea
          id="remind-text"
          maxLength={1000}
          placeholder="可留空 —— 不填只发送邮件主题和链接"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          className="w-full min-h-[80px] px-3 py-2.5 rounded-lg border border-[color:var(--field-border,transparent)] bg-[color:var(--field-background)] text-[color:var(--field-foreground)] text-[15px] resize-y outline-none focus:ring-2 focus:ring-[color:var(--accent)]/40 placeholder:text-[color:var(--field-placeholder)]"
        />
      </div>

      <Button
        onClick={onSave}
        isDisabled={saving}
        variant="primary"
        size="lg"
        fullWidth
      >
        {saving ? (
          <span className="inline-flex items-center gap-2">
            <Spinner size="sm" />
            保存中…
          </span>
        ) : (
          "保存提醒"
        )}
      </Button>

      {status && (
        <div
          className={`text-sm text-center ${
            status.kind === "error"
              ? "text-[color:var(--danger)]"
              : "text-[color:var(--success)]"
          }`}
        >
          {status.msg}
        </div>
      )}

      <div className="text-xs text-[color:var(--muted)]">
        时间按你设备的本地时区
      </div>
    </Card>
  );
}

function ListSection({
  listOnly,
  reminders,
  loading,
  deletingId,
  onDelete,
}: {
  listOnly: boolean;
  reminders: Reminder[];
  loading: boolean;
  deletingId: number | null;
  onDelete: (id: number) => void;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-[color:var(--muted)] mb-3 flex items-center gap-2">
        <span>{listOnly ? "所有待提醒" : "已设的提醒"}</span>
        {reminders.length > 0 && (
          <Chip size="sm" variant="soft" color="accent">
            {reminders.length}
          </Chip>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2 py-2">
              <Skeleton className="h-3 w-1/3 rounded-md" />
              <Skeleton className="h-4 w-4/5 rounded-md" />
            </div>
          ))}
        </div>
      ) : reminders.length === 0 ? (
        <div className="text-sm text-[color:var(--muted)] py-2">
          {listOnly ? "暂无待提醒事项" : "本邮件还没有设过提醒"}
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--surface-secondary)]/80">
          {reminders.map((it) => (
            <li
              key={it.id}
              className="flex items-start justify-between gap-3 py-3 first:pt-1 last:pb-1"
            >
              <div className="flex flex-col min-w-0 flex-1">
                <div className="text-xs text-[color:var(--muted)] mb-1">
                  {fmtWhen(it.remind_at)}
                </div>
                {listOnly && it.email_subject && (
                  <div className="text-[13px] text-[color:var(--muted)] break-words">
                    📧 {it.email_subject}
                  </div>
                )}
                {it.text && (
                  <div className="text-sm break-words text-[color:var(--foreground)] mt-0.5">
                    {it.text}
                  </div>
                )}
              </div>
              <Button
                isIconOnly
                variant="ghost"
                size="sm"
                onClick={() => onDelete(it.id)}
                isDisabled={deletingId === it.id}
                aria-label="删除提醒"
              >
                {deletingId === it.id ? <Spinner size="sm" /> : "🗑"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
