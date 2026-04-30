import { Button, Spinner } from "@heroui/react";
import { api } from "@page/api/client";
import {
  extractErrorMessage,
  redirectToLoginOnUnauthorized,
} from "@page/api/utils";
import { SessionGatedWebLayout } from "@page/components/session-gated-web-layout";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/preview")({
  component: PreviewPage,
});

function PreviewPage() {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.api.preview.post({ html });
      if (error) throw error;
      return data;
    },
    onSuccess: () => setError(null),
    onError: async (err) => {
      if (redirectToLoginOnUnauthorized(err)) return;
      setError(await extractErrorMessage(err));
    },
  });

  const data = mut.data;

  return (
    <SessionGatedWebLayout subtitle="HTML → MarkdownV2">
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
          <Button
            onPress={() => mut.mutate()}
            isDisabled={mut.isPending || !html.trim()}
            className="shrink-0 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold self-start sm:self-auto"
            size="md"
          >
            {mut.isPending ? (
              <span className="flex items-center gap-1.5">
                <Spinner size="sm" /> 转换中…
              </span>
            ) : (
              "转换 →"
            )}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Pane label="INPUT" subLabel="HTML" sideLabel={`${html.length} 字符`}>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="<html>..."
              spellCheck={false}
              className="block w-full h-full p-4 bg-transparent text-emerald-300 font-mono text-[13px] leading-6 resize-none outline-none placeholder:text-zinc-700"
            />
          </Pane>

          <Pane
            label="OUTPUT"
            subLabel="MarkdownV2"
            sideLabel={
              data ? `${data.length} 字符` : error ? "错误" : "等待输入"
            }
          >
            <div className="h-full p-4 overflow-auto">
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
            </div>
          </Pane>
        </div>
      </section>
    </SessionGatedWebLayout>
  );
}

/**
 * 分栏容器：顶栏 label + subLabel + sideLabel（字符数 / 状态），下面给调用
 * 者放 textarea 或 pre。用 Card overflow-hidden 统一圆角 + 边框。
 */
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
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950/30">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold tracking-widest text-emerald-500">
            {label}
          </span>
          <span className="text-xs text-zinc-500">{subLabel}</span>
        </div>
        <span className="text-xs text-zinc-600 tabular-nums">{sideLabel}</span>
      </div>
      <div className="h-72 sm:h-96 lg:h-[480px]">{children}</div>
    </div>
  );
}
