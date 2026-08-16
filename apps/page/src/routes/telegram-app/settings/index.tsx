import { Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import { extractErrorMessage } from "@page/api/utils";
import { useBackButton } from "@page/hooks/use-back-button";
import { INPUT_CLASS } from "@page/styles/inputs";
import { confirmPopup, notifyHaptic } from "@page/utils/tg";
import { getDeviceTimeZoneOrDefault } from "@page/utils/time-zone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const SETTINGS_QUERY_KEY = ["settings", "things"];

const SettingsPage = () => {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);

  useBackButton("/telegram-app/reminders");

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await api.api.settings.things.get();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    const data = settingsQuery.data;
    if (!data) return;
    setEmail(data.email ?? "");
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!settingsQuery.error) return;
    let cancelled = false;
    extractErrorMessage(settingsQuery.error).then((msg) => {
      if (!cancelled) setStatus({ msg, kind: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [settingsQuery.error]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: {
        email: string;
        password?: string;
      } = {
        email: email.trim(),
      };
      const nextPassword = password.trim();
      if (nextPassword) body.password = nextPassword;

      const { data, error } = await api.api.settings.things.put(body);
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, data);
      setEmail(data.email ?? "");
      setPassword("");
      setStatus({ msg: "已保存 Things 设置", kind: "ok" });
      notifyHaptic("success");
    },
    onError: async (err) => {
      setStatus({ msg: await extractErrorMessage(err), kind: "error" });
      notifyHaptic("error");
    },
  });

  const disconnectMut = useMutation({
    mutationFn: async () => {
      const { error } = await api.api.settings.things.delete();
      if (error) throw error;
    },
    onSuccess: () => {
      qc.setQueryData(SETTINGS_QUERY_KEY, {
        enabled: false,
        email: null,
        user_timezone:
          settingsQuery.data?.user_timezone ?? getDeviceTimeZoneOrDefault(),
        hasPassword: false,
      });
      setEmail("");
      setPassword("");
      setStatus({ msg: "已断开 Things Cloud", kind: "ok" });
      notifyHaptic("success");
    },
    onError: async (err) => {
      setStatus({ msg: await extractErrorMessage(err), kind: "error" });
      notifyHaptic("error");
    },
  });

  const handleDisconnect = async () => {
    if (!(await confirmPopup("断开 Things Cloud？"))) return;
    setStatus(null);
    disconnectMut.mutate();
  };

  const hasPassword = settingsQuery.data?.hasPassword ?? false;
  const displayUserTimezone =
    settingsQuery.data?.user_timezone ?? getDeviceTimeZoneOrDefault();
  const busy =
    settingsQuery.isLoading || saveMut.isPending || disconnectMut.isPending;

  return (
    <div className="max-w-xl mx-auto px-3 py-4 sm:p-6 space-y-5">
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">
            Things
          </h1>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${
              settingsQuery.data?.enabled
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-zinc-800 bg-zinc-900 text-zinc-500"
            }`}
          >
            {settingsQuery.data?.enabled ? "已连接" : "未连接"}
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          到期的邮件提醒会创建到 Things Today。
        </p>
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

      <form
        className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setStatus(null);
          saveMut.mutate();
        }}
      >
        {settingsQuery.isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner size="lg" color="success" />
          </div>
        ) : (
          <>
            <label className="block">
              <span className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2">
                Things Cloud 邮箱
              </span>
              <input
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className={`w-full text-[15px] ${INPUT_CLASS}`}
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2">
                密码
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  hasPassword ? "留空保留当前密码" : "Things Cloud 密码"
                }
                className={`w-full text-[15px] ${INPUT_CLASS}`}
              />
            </label>

            <div>
              <span className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2">
                用户时区
              </span>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-[15px] text-zinc-300 break-words">
                {displayUserTimezone}
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="flex-1 min-w-0 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-[colors,transform] duration-100 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center"
              >
                {saveMut.isPending ? <Spinner size="sm" /> : "保存"}
              </button>
              <button
                type="button"
                disabled={busy || !settingsQuery.data?.enabled}
                onClick={handleDisconnect}
                className="px-4 py-2.5 rounded-lg border border-zinc-800 text-sm font-semibold text-zinc-300 hover:border-red-500/60 hover:text-red-300 active:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                断开
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
};

export const Route = createFileRoute("/telegram-app/settings/")({
  component: SettingsPage,
});
