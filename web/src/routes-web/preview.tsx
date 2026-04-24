import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  extractErrorMessage,
  redirectToLoginOnUnauthorized,
} from "@/api/client";
import { ROUTE_PREVIEW_API } from "@/api/routes";
import { previewResponseSchema } from "@/api/schemas";
import { WebLayout } from "@/components/web-layout";

export const Route = createFileRoute("/preview")({
  component: PreviewPage,
});

function PreviewPage() {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const raw = await api
        .post(ROUTE_PREVIEW_API.replace(/^\//, ""), { json: { html } })
        .json();
      return previewResponseSchema.parse(raw);
    },
    onSuccess: () => setError(null),
    onError: async (err) => {
      if (redirectToLoginOnUnauthorized(err)) return;
      setError(await extractErrorMessage(err));
    },
  });

  const data = mut.data;

  return (
    <WebLayout subtitle="HTML → MarkdownV2">
      <section>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">
              HTML → Telegram 预览
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              粘贴邮件 HTML，查看处理后发送到 Telegram 的 MarkdownV2 文本
            </p>
          </div>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !html.trim()}
            className="shrink-0 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed self-start sm:self-auto"
          >
            {mut.isPending ? "转换中…" : "转换 →"}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Pane label="INPUT" subLabel="HTML" sideLabel={`${html.length} 字符`}>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="<html>..."
              spellCheck={false}
              className="w-full h-72 sm:h-96 lg:h-[480px] bg-transparent text-emerald-300 font-mono text-[13px] leading-6 resize-none outline-none placeholder:text-zinc-700"
            />
          </Pane>

          <Pane
            label="OUTPUT"
            subLabel="MarkdownV2"
            sideLabel={
              data ? `${data.length} 字符` : error ? "错误" : "等待输入"
            }
          >
            {error ? (
              <div className="font-mono text-[13px] text-red-400 whitespace-pre-wrap">
                {error}
              </div>
            ) : data ? (
              <pre className="font-mono text-[13px] leading-6 text-emerald-300 whitespace-pre-wrap break-all">
                {data.result}
              </pre>
            ) : (
              <div className="text-zinc-700 font-mono text-[13px]">
                转换结果将显示在这里
              </div>
            )}
          </Pane>
        </div>
      </section>
    </WebLayout>
  );
}

function Pane({
  label,
  subLabel,
  sideLabel,
  children,
}: {
  label: string;
  subLabel: string;
  sideLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold tracking-widest text-emerald-500">
            {label}
          </span>
          <span className="text-xs text-zinc-500">{subLabel}</span>
        </div>
        <span className="text-xs text-zinc-600 tabular-nums">{sideLabel}</span>
      </div>
      <div className="p-4 min-h-72 sm:min-h-96 lg:min-h-[480px]">
        {children}
      </div>
    </div>
  );
}
