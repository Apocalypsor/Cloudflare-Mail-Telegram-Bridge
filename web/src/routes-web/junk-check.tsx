import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  extractErrorMessage,
  redirectToLoginOnUnauthorized,
} from "@/api/client";
import { ROUTE_JUNK_CHECK_API } from "@/api/routes";
import { junkCheckResponseSchema } from "@/api/schemas";
import { SessionGatePlaceholder } from "@/components/session-gate-placeholder";
import { WebLayout } from "@/components/web-layout";
import { useRequireTelegramLogin } from "@/hooks/use-require-telegram-login";

export const Route = createFileRoute("/junk-check")({
  component: JunkCheckPage,
});

function JunkCheckPage() {
  const session = useRequireTelegramLogin();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const raw = await api
        .post(ROUTE_JUNK_CHECK_API.replace(/^\//, ""), {
          json: { subject, body },
        })
        .json();
      return junkCheckResponseSchema.parse(raw);
    },
    onMutate: () => setError(null),
    onError: async (err) => {
      if (redirectToLoginOnUnauthorized(err)) return;
      setError(await extractErrorMessage(err));
    },
  });

  const result = mut.data;
  const hasValidResult = result && !result.error;

  if (session.isLoading || session.isRedirecting || !session.data) {
    return (
      <WebLayout subtitle="垃圾邮件检测">
        <SessionGatePlaceholder redirecting={session.isRedirecting} />
      </WebLayout>
    );
  }

  return (
    <WebLayout subtitle="垃圾邮件检测">
      <section className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">
            🚫 垃圾邮件检测
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            粘贴邮件主题和正文，AI 判断是否为垃圾邮件并给出分类理由
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
          <div>
            <label
              htmlFor="subject-input"
              className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
            >
              Subject
            </label>
            <input
              id="subject-input"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="邮件主题（可选）"
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm outline-none focus:border-emerald-500 placeholder:text-zinc-600 transition-colors"
            />
          </div>
          <div>
            <label
              htmlFor="body-input"
              className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
            >
              Body
            </label>
            <textarea
              id="body-input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="粘贴邮件正文内容…"
              className="w-full min-h-[200px] px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm resize-y outline-none focus:border-emerald-500 placeholder:text-zinc-600 transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !body.trim()}
            className="w-full px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {mut.isPending ? "检测中…" : "开始检测"}
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-400">
            {error}
          </div>
        )}
        {result?.error && (
          <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-400">
            错误：{result.error}
          </div>
        )}
        {hasValidResult && <ResultCard result={result} />}
      </section>
    </WebLayout>
  );
}

function ResultCard({
  result,
}: {
  result: {
    isJunk: boolean;
    junkConfidence: number;
    summary: string;
    tags: string[];
  };
}) {
  const pct = Math.round(result.junkConfidence * 100);
  const isJunk = result.isJunk;

  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        isJunk
          ? "border-red-900/60 bg-red-950/20"
          : "border-emerald-900/60 bg-emerald-950/20"
      }`}
    >
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center justify-center w-10 h-10 rounded-full text-xl ${
              isJunk ? "bg-red-500/20" : "bg-emerald-500/20"
            }`}
          >
            {isJunk ? "🚫" : "✅"}
          </span>
          <div>
            <div
              className={`text-lg font-semibold ${
                isJunk ? "text-red-300" : "text-emerald-300"
              }`}
            >
              {isJunk ? "垃圾邮件" : "正常邮件"}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              判断置信度 {pct}%
            </div>
          </div>
        </div>
      </div>

      {/* confidence bar */}
      <div className="px-5 pb-3">
        <div className="h-1.5 rounded-full bg-zinc-900 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isJunk ? "bg-red-500" : "bg-emerald-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {(result.tags.length > 0 || result.summary) && (
        <div className="border-t border-zinc-800/60 px-5 py-4 space-y-3 bg-zinc-950/30">
          {result.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2.5 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {result.summary && (
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {result.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
