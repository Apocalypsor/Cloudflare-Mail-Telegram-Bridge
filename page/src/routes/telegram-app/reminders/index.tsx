import { api } from "@page/api/client";
import { extractErrorMessage, validateSearch } from "@page/api/utils";
import { useBackButton } from "@page/hooks/use-back-button";
import { useNavigateToMail } from "@page/hooks/use-navigate-to-mail";
import { confirmPopup, notifyHaptic } from "@page/utils/tg";
import { Type as t } from "@sinclair/typebox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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

// 三件套任缺其一 → 退化为"所有待提醒"列表模式。
// `back` 由从邮件预览页跳进来时带上，存在则渲染 TG BackButton 跳回。
const Search = t.Object({
  accountId: t.Optional(t.Number()),
  emailMessageId: t.Optional(t.String()),
  token: t.Optional(t.String()),
  back: t.Optional(t.String()),
});

export const Route = createFileRoute("/telegram-app/reminders/")({
  component: RemindersPage,
  validateSearch: validateSearch(Search),
});

function RemindersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
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
      const { data, error } = await api.api.reminders["email-context"].get({
        query: {
          accountId: String(search.accountId),
          emailMessageId: search.emailMessageId ?? "",
          token: search.token ?? "",
        },
      });
      if (error) throw error;
      return data;
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
      const query = listOnly
        ? {}
        : {
            accountId: String(search.accountId),
            emailMessageId: search.emailMessageId ?? "",
            token: search.token ?? "",
          };
      const { data, error } = await api.api.reminders.get({ query });
      if (error) throw error;
      return data;
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const dt = parseWallClockInTz(date, time, tz);
      if (Number.isNaN(dt.getTime())) throw new Error("时间格式错误");
      if (dt.getTime() <= Date.now()) throw new Error("提醒时间需在未来");
      const { data, error } = await api.api.reminders.post({
        text: text.trim(),
        remind_at: dt.toISOString(),
        accountId: search.accountId,
        emailMessageId: search.emailMessageId,
        token: search.token,
      });
      if (error) throw error;
      return { ...data, savedAt: dt };
    },
    onSuccess: ({ savedAt }) => {
      const wall = formatInTz(savedAt, tz);
      setStatus({
        msg: `✅ 已设置提醒：${wall.ymd} ${wall.hm}`,
        kind: "ok",
      });
      setText("");
      const next = formatInTz(new Date(Date.now() + 60_000), tz);
      setDate(next.ymd);
      setTime(next.hm);
      setActivePreset(null);
      notifyHaptic("success");
      qc.invalidateQueries({ queryKey: remindersKey });
    },
    onError: async (err) => {
      setStatus({ msg: await extractErrorMessage(err), kind: "error" });
    },
  });

  // 状态消息 4 秒自动消失（仅 ok 态；error 留着等用户手动 retry 看完）
  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await api.api.reminders({ id: String(id) }).delete();
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: remindersKey }),
    onError: async (err) =>
      setStatus({ msg: await extractErrorMessage(err), kind: "error" }),
  });

  // 删除前要求确认 —— TG popup / 浏览器 window.confirm 由 confirmPopup 统一
  async function confirmDelete(id: number) {
    if (!(await confirmPopup("确定删除这条提醒？"))) return;
    setStatus(null);
    deleteMut.mutate(id);
  }

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
    <div className="max-w-xl mx-auto px-3 py-4 sm:p-6 space-y-5">
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
        onDelete={confirmDelete}
        onEdit={(id) => {
          const back = window.location.pathname + window.location.search;
          navigate({
            to: "/telegram-app/reminders/edit/$id",
            params: { id: String(id) },
            search: { back },
          });
        }}
        onOpenMail={(r) => {
          if (!r.account_id || !r.email_message_id || !r.mail_token) return;
          navigateToMail(r.account_id, r.email_message_id, r.mail_token);
        }}
      />
    </div>
  );
}
