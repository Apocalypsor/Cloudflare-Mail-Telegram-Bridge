import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import {
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
} from "@worker/handlers/hono/routes";
import { useMemo, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import {
  emailContextResponseSchema,
  okResponseSchema,
  remindersListResponseSchema,
} from "@/api/schemas";
import { extractErrorMessage } from "@/api/utils";
import { useBackButton } from "@/hooks/use-back-button";
import { useNavigateToMail } from "@/hooks/use-navigate-to-mail";
import { getTelegram } from "@/providers/telegram";
import { ReminderAddSection } from "./-components/add-section";
import { ReminderEmailCard } from "./-components/email-card";
import { ReminderTimeline } from "./-components/timeline";
import { PRESETS, presetToDate } from "./-utils/presets";
import {
  DEVICE_TZ_VALUE,
  formatInTz,
  parseWallClockInTz,
  resolveTz,
} from "./-utils/tz";

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

export const Route = createFileRoute("/telegram-app/reminders/")({
  component: RemindersPage,
  validateSearch: zodValidator(searchSchema),
});

function RemindersPage() {
  const search: Search = Route.useSearch();
  const navigateToMail = useNavigateToMail();
  const listOnly = !search.accountId || !search.emailMessageId || !search.token;

  const qc = useQueryClient();
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);
  const [timezone, setTimezone] = useState<string>(DEVICE_TZ_VALUE);
  const tz = useMemo(() => resolveTz(timezone), [timezone]);

  const [date, setDate] = useState<string>(
    () =>
      formatInTz(new Date(Date.now() + 60_000), resolveTz(DEVICE_TZ_VALUE)).ymd,
  );
  const [time, setTime] = useState<string>(
    () =>
      formatInTz(new Date(Date.now() + 60_000), resolveTz(DEVICE_TZ_VALUE)).hm,
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
      const dt = parseWallClockInTz(date, time, tz);
      if (Number.isNaN(dt.getTime())) throw new Error("时间格式错误");
      if (dt.getTime() <= Date.now()) throw new Error("提醒时间需在未来");
      const data = await api
        .post(ROUTE_REMINDERS_API.replace(/^\//, ""), {
          json: {
            text: text.trim(),
            remind_at: dt.toISOString(),
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
      const next = formatInTz(new Date(Date.now() + 60_000), tz);
      setDate(next.ymd);
      setTime(next.hm);
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
    const target = presetToDate(PRESETS[idx].mins, tz);
    const { ymd: y, hm: h } = formatInTz(target, tz);
    setDate(y);
    setTime(h);
    setActivePreset(idx);
  }

  const minDate = useMemo(() => formatInTz(new Date(), tz).ymd, [tz]);

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
        <ReminderEmailCard
          subject={emailCtx.data?.subject ?? null}
          accountEmail={emailCtx.data?.accountEmail ?? null}
          loading={emailCtx.isLoading}
          error={emailCtx.isError}
          onClick={() => {
            if (search.accountId && search.emailMessageId && search.token)
              navigateToMail(
                search.accountId,
                search.emailMessageId,
                search.token,
              );
          }}
        />
      )}

      {!listOnly && (
        <ReminderAddSection
          date={date}
          time={time}
          text={text}
          minDate={minDate}
          timezone={timezone}
          tzLabel={tz}
          activePreset={activePreset}
          saving={createMut.isPending}
          status={status}
          onDateChange={setDate}
          onTimeChange={setTime}
          onTextChange={setText}
          onTimezoneChange={setTimezone}
          onPreset={applyPreset}
          onSave={() => {
            setStatus(null);
            createMut.mutate();
          }}
        />
      )}

      <ReminderTimeline
        listOnly={listOnly}
        reminders={reminders}
        loading={remindersQuery.isLoading}
        deletingId={deleteMut.isPending ? (deleteMut.variables ?? null) : null}
        onDelete={(id) => deleteMut.mutate(id)}
        onOpenMail={(r) => {
          if (!r.account_id || !r.email_message_id || !r.mail_token) return;
          navigateToMail(r.account_id, r.email_message_id, r.mail_token);
        }}
      />
    </div>
  );
}
