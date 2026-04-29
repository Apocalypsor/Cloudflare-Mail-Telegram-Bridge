import { Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { ROUTE_REMINDERS_API } from "@worker/handlers/hono/routes";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import { okResponseSchema, reminderResponseSchema } from "@/api/schemas";
import { extractErrorMessage } from "@/api/utils";
import { useBackButton } from "@/hooks/use-back-button";
import { useNavigateToMail } from "@/hooks/use-navigate-to-mail";
import { INPUT_CLASS } from "@/styles/inputs";
import { notifyHaptic } from "@/utils/tg";
import { ReminderEmailCard } from "./-components/email-card";
import {
  DEVICE_TZ_VALUE,
  formatInTz,
  parseWallClockInTz,
  resolveTz,
  TZ_GROUPS,
} from "./-utils/tz";

const searchSchema = z.object({
  back: fallback(z.string().optional(), undefined),
});

export const Route = createFileRoute("/telegram-app/reminders/edit/$id")({
  component: EditReminderPage,
  validateSearch: zodValidator(searchSchema),
});

function EditReminderPage() {
  const { id: idParam } = Route.useParams();
  const search = Route.useSearch();
  const id = Number(idParam);
  const navigate = useNavigate();
  const navigateToMail = useNavigateToMail();
  const qc = useQueryClient();

  // 时区每次进页面默认本地（跟 reminders 主页一致），可临时切换
  const [timezone, setTimezone] = useState<string>(DEVICE_TZ_VALUE);
  const tz = useMemo(() => resolveTz(timezone), [timezone]);

  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [text, setText] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);

  const reminderQuery = useQuery({
    queryKey: ["reminder", id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: async () => {
      const data = await api
        .get(`${ROUTE_REMINDERS_API.replace(/^\//, "")}/${id}`)
        .json();
      return reminderResponseSchema.parse(data);
    },
  });

  // reminder 拉到后用当前 tz 把 remind_at 倒回 wall clock，**只填一次**。
  // 后续用户改 tz 时 form 值不动（保持跟创建流一致：tz 只影响解释，不自动换算）。
  useEffect(() => {
    if (initialized) return;
    const r = reminderQuery.data?.reminder;
    if (!r) return;
    const w = formatInTz(new Date(r.remind_at), tz);
    setDate(w.ymd);
    setTime(w.hm);
    setText(r.text);
    setInitialized(true);
  }, [reminderQuery.data, tz, initialized]);

  function goBack() {
    if (search.back) window.location.href = search.back;
    else navigate({ to: "/telegram-app/reminders", search: {} });
  }

  useBackButton(search.back ?? "/telegram-app/reminders");

  const updateMut = useMutation({
    mutationFn: async () => {
      const dt = parseWallClockInTz(date, time, tz);
      if (Number.isNaN(dt.getTime())) throw new Error("时间格式错误");
      if (dt.getTime() <= Date.now()) throw new Error("提醒时间需在未来");
      const data = await api
        .patch(`${ROUTE_REMINDERS_API.replace(/^\//, "")}/${id}`, {
          json: { text: text.trim(), remind_at: dt.toISOString() },
        })
        .json();
      const parsed = okResponseSchema.parse(data);
      if (!parsed.ok) throw new Error(parsed.error || "保存失败");
    },
    onSuccess: () => {
      notifyHaptic("success");
      // 失效列表缓存，让返回主页时拿到最新值
      qc.invalidateQueries({ queryKey: ["reminders"] });
      qc.invalidateQueries({ queryKey: ["reminder", id] });
      goBack();
    },
    onError: async (err) =>
      setStatus({ msg: await extractErrorMessage(err), kind: "error" }),
  });

  const minDate = useMemo(() => formatInTz(new Date(), tz).ymd, [tz]);
  const fieldClass = `text-[15px] ${INPUT_CLASS}`;

  if (reminderQuery.isError) {
    return (
      <div className="max-w-xl mx-auto p-6">
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-center text-sm text-red-400">
          提醒加载失败
        </div>
      </div>
    );
  }

  const r = reminderQuery.data?.reminder;

  return (
    <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">
          ✏️ 编辑提醒
        </h1>
      </header>

      <ReminderEmailCard
        subject={r ? r.email_summary || r.email_subject : null}
        accountEmail={null}
        loading={reminderQuery.isLoading}
        error={false}
        onClick={() => {
          if (r?.account_id && r.email_message_id && r.mail_token) {
            navigateToMail(r.account_id, r.email_message_id, r.mail_token);
          }
        }}
      />

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

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <div>
          <label
            htmlFor="edit-date"
            className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
          >
            提醒时间
          </label>
          <div className="flex gap-2">
            <input
              id="edit-date"
              type="date"
              value={date}
              min={minDate}
              onChange={(e) => setDate(e.target.value)}
              className={`flex-1 min-w-0 ${fieldClass}`}
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={`flex-[0_0_38%] min-w-0 ${fieldClass}`}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="edit-tz"
            className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
          >
            时区
          </label>
          <select
            id="edit-tz"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className={`w-full ${fieldClass} appearance-none cursor-pointer`}
          >
            <option value={DEVICE_TZ_VALUE}>设备本地（{tz}）</option>
            {TZ_GROUPS.map((g) => (
              <optgroup key={g.region} label={g.region}>
                {g.items.map((it) => (
                  <option key={it.value} value={it.value}>
                    {it.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="edit-text"
            className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
          >
            备注（可选）
          </label>
          <textarea
            id="edit-text"
            maxLength={1000}
            placeholder="可留空 —— 不填只发送邮件主题和链接"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoCorrect="off"
            autoCapitalize="off"
            className={`w-full min-h-[80px] resize-y ${fieldClass}`}
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={goBack}
            disabled={updateMut.isPending}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700 transition-colors disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus(null);
              updateMut.mutate();
            }}
            disabled={!initialized || updateMut.isPending}
            className="flex-1 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-colors disabled:opacity-40 flex items-center justify-center"
          >
            {updateMut.isPending ? <Spinner size="sm" /> : "保存"}
          </button>
        </div>

        <div className="text-xs text-zinc-500">
          时间按 <span className="text-zinc-300">{tz}</span> 解释
        </div>
      </div>
    </div>
  );
}
