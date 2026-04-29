import { Chip, Skeleton, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import {
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
} from "@worker/handlers/hono/routes";
import { type CSSProperties, useMemo, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import {
  emailContextResponseSchema,
  okResponseSchema,
  type Reminder,
  remindersListResponseSchema,
} from "@/api/schemas";
import { extractErrorMessage } from "@/api/utils";
import { useBackButton } from "@/hooks/use-back-button";
import { getTelegram } from "@/providers/telegram";

// 三件套任缺其一 → 退化为"所有待提醒"列表模式。用 fallback 吞掉格式错误，
// 避免脏 URL 让整页崩在 errorComponent。
// `back` 由从邮件预览页跳进来时带上，存在则渲染 TG BackButton 跳回。
const searchSchema = z.object({
  accountId: fallback(z.coerce.number().optional(), undefined),
  emailMessageId: fallback(z.string().optional(), undefined),
  token: fallback(z.string().optional(), undefined),
  back: fallback(z.string().optional(), undefined),
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

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type DateLabel = {
  primary: string;
  secondary: string;
  isToday: boolean;
  isPast: boolean;
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dateLabel(d: Date): DateLabel {
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const wd = WEEKDAYS[d.getDay()];
  if (dayDiff === 0)
    return { primary: "今天", secondary: md, isToday: true, isPast: false };
  if (dayDiff === 1)
    return { primary: "明天", secondary: md, isToday: false, isPast: false };
  if (dayDiff > 1 && dayDiff < 7)
    return { primary: wd, secondary: md, isToday: false, isPast: false };
  if (dayDiff < 0)
    return { primary: "已过", secondary: md, isToday: false, isPast: true };
  return { primary: md, secondary: wd, isToday: false, isPast: false };
}

type ReminderGroup = { date: Date; items: Reminder[] };

function groupRemindersByDate(reminders: Reminder[]): ReminderGroup[] {
  const groups = new Map<string, ReminderGroup>();
  for (const r of reminders) {
    const d = new Date(r.remind_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = ymd(d);
    let group = groups.get(key);
    if (!group) {
      group = { date: startOfDay(d), items: [] };
      groups.set(key, group);
    }
    group.items.push(r);
  }
  for (const g of groups.values()) {
    g.items.sort(
      (a, b) =>
        new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime(),
    );
  }
  return Array.from(groups.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
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
  const navigate = useNavigate();
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
    const back = window.location.pathname + window.location.search;
    navigate({
      to: "/telegram-app/mail/$id",
      params: { id: search.emailMessageId ?? "" },
      search: {
        accountId: search.accountId ?? 0,
        t: search.token ?? "",
        back,
      },
    });
  }

  const minDate = ymd(new Date());

  // 主菜单 / deep link 直达 → 不显示 BackButton；从邮件页带 ?back= 进来 → 显示并跳回
  useBackButton(search.back);

  const reminders = remindersQuery.data?.reminders ?? [];

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-5">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">
            {listOnly ? "⏰ 我的提醒" : "⏰ 邮件提醒"}
          </h1>
          {listOnly && reminders.length > 0 && (
            <span className="text-sm text-zinc-500 tabular-nums">
              共{" "}
              <span className="text-emerald-400 font-semibold">
                {reminders.length}
              </span>{" "}
              条
            </span>
          )}
        </div>
        {listOnly && (
          <p className="text-xs text-zinc-500">沿时间线由近至远排列</p>
        )}
      </header>

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

      <TimelineList
        listOnly={listOnly}
        reminders={reminders}
        loading={remindersQuery.isLoading}
        deletingId={deleteMut.isPending ? (deleteMut.variables ?? null) : null}
        onDelete={(id) => deleteMut.mutate(id)}
        onOpenMail={(r) => {
          if (!r.account_id || !r.email_message_id || !r.mail_token) return;
          const back = window.location.pathname + window.location.search;
          navigate({
            to: "/telegram-app/mail/$id",
            params: { id: r.email_message_id },
            search: {
              accountId: r.account_id,
              t: r.mail_token,
              back,
            },
          });
        }}
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
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left rounded-xl border border-zinc-800 border-l-4 border-l-emerald-500 bg-zinc-900 p-4 hover:bg-zinc-900/80 active:bg-zinc-900/60 transition-colors cursor-pointer"
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4 rounded-md" />
          <Skeleton className="h-3 w-1/2 rounded-md" />
        </div>
      ) : (
        <>
          <div className="text-[15px] font-semibold break-words text-zinc-100">
            {error ? "邮件信息加载失败" : subject || "(无主题)"}
          </div>
          {accountEmail && (
            <div className="text-xs text-zinc-500 mt-1">
              账号: {accountEmail}
            </div>
          )}
          <div className="text-[11px] text-emerald-400 mt-2">
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
  const inputClass =
    "px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-[15px] outline-none focus:border-emerald-500 placeholder:text-zinc-600 transition-colors";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
      <div>
        <label
          htmlFor="when-date"
          className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
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
            className={`flex-1 min-w-0 ${inputClass}`}
          />
          <input
            type="time"
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className={`flex-[0_0_38%] min-w-0 ${inputClass}`}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p, i) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onPreset(i)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors border ${
              activePreset === i
                ? "bg-emerald-500 border-emerald-500 text-emerald-950"
                : "bg-zinc-800 border-zinc-700 text-zinc-100 hover:bg-zinc-700"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div>
        <label
          htmlFor="remind-text"
          className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
        >
          备注（可选）
        </label>
        <textarea
          id="remind-text"
          maxLength={1000}
          placeholder="可留空 —— 不填只发送邮件主题和链接"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          className={`w-full min-h-[80px] resize-y ${inputClass}`}
        />
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="w-full px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
      >
        {saving ? <Spinner size="sm" /> : "保存提醒"}
      </button>

      {status && (
        <div
          className={`text-sm text-center ${
            status.kind === "error" ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {status.msg}
        </div>
      )}

      <div className="text-xs text-zinc-500">时间按你设备的本地时区</div>
    </div>
  );
}

// Flat row union: the timeline alternates date headers and items, but they all
// share the same column layout so a single rail can bridge through both.
type TimelineRow =
  | { kind: "date"; key: string; date: Date; count: number }
  | { kind: "item"; key: string; reminder: Reminder };

// mt-3 (12px) between adjacent items / between a date and its first item;
// mt-6 (24px) before a new date section. The rail's bottom segment extends
// `-nextGap` so it lands exactly on the next row's top.
const GAP_TO_DATE = 24;
const GAP_DEFAULT = 12;

function TimelineList({
  listOnly,
  reminders,
  loading,
  deletingId,
  onDelete,
  onOpenMail,
}: {
  listOnly: boolean;
  reminders: Reminder[];
  loading: boolean;
  deletingId: number | null;
  onDelete: (id: number) => void;
  onOpenMail: (r: Reminder) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 items-start">
            <Skeleton className="w-24 h-4 rounded mt-3.5 shrink-0" />
            <div className="w-4 shrink-0 flex justify-center pt-5">
              <Skeleton className="w-3 h-3 rounded-full" />
            </div>
            <Skeleton className="flex-1 h-20 rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (reminders.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
        <div className="text-4xl mb-3 opacity-80">📭</div>
        <div className="text-sm text-zinc-400">
          {listOnly ? "暂无待提醒事项" : "本邮件还没有设过提醒"}
        </div>
        {listOnly && (
          <div className="text-xs text-zinc-600 mt-2">
            在邮件消息上点 ⏰ 即可设定
          </div>
        )}
      </div>
    );
  }

  const groups = groupRemindersByDate(reminders);
  const now = Date.now();

  const rows: TimelineRow[] = [];
  for (const g of groups) {
    rows.push({
      kind: "date",
      key: `d-${g.date.toISOString()}`,
      date: g.date,
      count: g.items.length,
    });
    for (const it of g.items) {
      rows.push({ kind: "item", key: `i-${it.id}`, reminder: it });
    }
  }

  return (
    <div>
      {rows.map((row, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === rows.length - 1;
        const next = rows[idx + 1];
        const nextGap = next?.kind === "date" ? GAP_TO_DATE : GAP_DEFAULT;
        const marginClass = isFirst
          ? ""
          : row.kind === "date"
            ? "mt-6"
            : "mt-3";

        if (row.kind === "date") {
          return (
            <TimelineDateRow
              key={row.key}
              date={row.date}
              count={row.count}
              isFirst={isFirst}
              isLast={isLast}
              nextGap={nextGap}
              className={marginClass}
            />
          );
        }
        return (
          <TimelineItem
            key={row.key}
            it={row.reminder}
            listOnly={listOnly}
            isFirst={isFirst}
            isLast={isLast}
            nextGap={nextGap}
            now={now}
            isDeleting={deletingId === row.reminder.id}
            onOpen={() => onOpenMail(row.reminder)}
            onDelete={() => onDelete(row.reminder.id)}
            className={marginClass}
          />
        );
      })}
    </div>
  );
}

function TimelineDateRow({
  date,
  count,
  isFirst,
  isLast,
  nextGap,
  className,
}: {
  date: Date;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  nextGap: number;
  className: string;
}) {
  const label = dateLabel(date);
  const chipClass = label.isToday
    ? "bg-emerald-500 text-emerald-950 font-semibold"
    : label.isPast
      ? "bg-zinc-800 text-zinc-400 border border-zinc-700"
      : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";
  const dotColor = label.isToday
    ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
    : label.isPast
      ? "bg-zinc-600"
      : "bg-emerald-400";

  // Chip (size=sm) is 24px tall → center at y=12px from row top. We anchor
  // the rail dot and right-side divider to that y so chip + dot + divider
  // line up across the row, with the secondary date hanging below the chip.
  return (
    <div className={`flex gap-3 items-start ${className}`}>
      <div className="w-16 shrink-0 flex flex-col items-end gap-1">
        <Chip size="sm" className={chipClass}>
          {label.primary}
        </Chip>
        {label.secondary && (
          <div className="text-[11px] text-zinc-500 leading-tight tabular-nums">
            {label.secondary}
          </div>
        )}
      </div>

      <div className="relative w-4 shrink-0 self-stretch">
        {!isFirst && (
          <div
            className="absolute left-1/2 -translate-x-px top-0 w-px bg-zinc-800"
            style={{ height: "12px" }}
          />
        )}
        {!isLast && (
          <div
            className="absolute left-1/2 -translate-x-px w-px bg-zinc-800"
            style={{ top: "12px", bottom: `-${nextGap}px` }}
          />
        )}
        <div
          className={`absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full ring-4 ring-zinc-950 z-10 ${dotColor}`}
          style={{ top: "7px" }}
        />
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2 h-6">
        <div className="flex-1 h-px bg-gradient-to-r from-zinc-700 to-transparent" />
        <span className="text-[11px] text-zinc-600 tabular-nums">
          {count} 项
        </span>
      </div>
    </div>
  );
}

function TimelineItem({
  it,
  listOnly,
  isFirst,
  isLast,
  nextGap,
  now,
  isDeleting,
  onOpen,
  onDelete,
  className,
}: {
  it: Reminder;
  listOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  nextGap: number;
  now: number;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
  className: string;
}) {
  const d = new Date(it.remind_at);
  const time = hm(d);
  const ts = d.getTime();
  const isOverdue = ts < now;
  // Pulse only when reminder fires within the next hour — avoids a wall of pulses for far-future items.
  const isImminent = !isOverdue && ts - now < 60 * 60_000;
  const canOpen = Boolean(
    listOnly && it.account_id && it.email_message_id && it.mail_token,
  );

  const bottomStyle: CSSProperties = { top: "26px", bottom: `-${nextGap}px` };

  return (
    <article className={`flex gap-3 items-start ${className}`}>
      <div className="w-16 shrink-0 pt-3.5 text-right">
        <div
          className={`text-[15px] font-semibold tabular-nums leading-tight ${
            isOverdue ? "text-zinc-500" : "text-zinc-100"
          }`}
        >
          {time}
        </div>
      </div>

      <div className="relative w-4 shrink-0 self-stretch">
        {!isFirst && (
          <div className="absolute left-1/2 -translate-x-px top-0 h-[26px] w-px bg-zinc-800" />
        )}
        {!isLast && (
          <div
            className="absolute left-1/2 -translate-x-px w-px bg-zinc-800"
            style={bottomStyle}
          />
        )}
        <div
          className={`absolute left-1/2 -translate-x-1/2 top-[20px] w-3 h-3 rounded-full ring-4 ring-zinc-950 z-10 ${
            isOverdue
              ? "bg-zinc-600"
              : "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.55)]"
          }`}
        />
        {isImminent && (
          <div className="absolute left-1/2 -translate-x-1/2 top-[20px] w-3 h-3 rounded-full bg-emerald-500/40 animate-ping" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <TimelineCard
          it={it}
          listOnly={listOnly}
          canOpen={canOpen}
          isOverdue={isOverdue}
          isDeleting={isDeleting}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}

function TimelineCard({
  it,
  listOnly,
  canOpen,
  isOverdue,
  isDeleting,
  onOpen,
  onDelete,
}: {
  it: Reminder;
  listOnly: boolean;
  canOpen: boolean;
  isOverdue: boolean;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const showEmail = listOnly && Boolean(it.email_summary || it.email_subject);
  const hasText = it.text.trim().length > 0;

  const inner = (
    <>
      {showEmail && (
        <div className="flex gap-1.5 items-start text-[13px] leading-relaxed text-zinc-300 break-words">
          <span className="shrink-0">📧</span>
          <span className="flex-1">{it.email_summary || it.email_subject}</span>
        </div>
      )}
      {hasText && (
        <div
          className={`text-[15px] leading-relaxed break-words text-zinc-100 ${
            showEmail ? "mt-1.5" : ""
          }`}
        >
          {it.text}
        </div>
      )}
      {!showEmail && !hasText && (
        <div className="text-sm text-zinc-500 italic">无备注</div>
      )}
      {canOpen && (
        <div className="text-[11px] text-emerald-400 mt-2">查看邮件 →</div>
      )}
    </>
  );

  return (
    <div
      className={`relative rounded-xl border transition-colors ${
        isOverdue
          ? "border-zinc-800/70 bg-zinc-900/60"
          : "border-zinc-800 bg-zinc-900"
      } ${canOpen ? "hover:border-emerald-500/40" : ""}`}
    >
      {canOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left p-3.5 pr-12 cursor-pointer"
        >
          {inner}
        </button>
      ) : (
        <div className="p-3.5 pr-12">{inner}</div>
      )}

      <button
        type="button"
        onClick={onDelete}
        disabled={isDeleting}
        aria-label="删除提醒"
        className="absolute top-1.5 right-1.5 w-8 h-8 rounded-full flex items-center justify-center text-zinc-500 hover:bg-zinc-800 hover:text-red-400 active:bg-zinc-700 transition-colors disabled:opacity-40"
      >
        {isDeleting ? (
          <Spinner size="sm" />
        ) : (
          <span className="text-sm">🗑</span>
        )}
      </button>
    </div>
  );
}
