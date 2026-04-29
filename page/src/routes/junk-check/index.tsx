import { Button, Card, Spinner } from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ROUTE_JUNK_CHECK_API } from "@worker/handlers/hono/routes";
import { useState } from "react";
import { api } from "@/api/client";
import { junkCheckResponseSchema } from "@/api/schemas";
import {
  extractErrorMessage,
  redirectToLoginOnUnauthorized,
} from "@/api/utils";
import { SessionGatedWebLayout } from "@/components/session-gated-web-layout";
import { INPUT_CLASS } from "@/styles/inputs";
import { ResultCard } from "./-components/result-card";

export const Route = createFileRoute("/junk-check/")({
  component: JunkCheckPage,
});

function JunkCheckPage() {
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

  const inputClass = `w-full text-sm ${INPUT_CLASS}`;

  return (
    <SessionGatedWebLayout subtitle="垃圾邮件检测">
      <section className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">
            🚫 垃圾邮件检测
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            粘贴邮件主题和正文，AI 判断是否为垃圾邮件并给出分类理由
          </p>
        </div>

        <Card className="bg-zinc-900 border border-zinc-800 p-5 space-y-4">
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
              className={inputClass}
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
              className={`${inputClass} min-h-[200px] resize-y`}
            />
          </div>

          <Button
            onPress={() => mut.mutate()}
            isDisabled={mut.isPending || !body.trim()}
            fullWidth
            className="bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold"
          >
            {mut.isPending ? (
              <span className="flex items-center gap-1.5">
                <Spinner size="sm" /> 检测中…
              </span>
            ) : (
              "开始检测"
            )}
          </Button>
        </Card>

        {error && (
          <Card className="bg-red-950/30 border border-red-900/50 p-4 text-sm text-red-400">
            {error}
          </Card>
        )}
        {result?.error && (
          <Card className="bg-red-950/30 border border-red-900/50 p-4 text-sm text-red-400">
            错误：{result.error}
          </Card>
        )}
        {hasValidResult && <ResultCard result={result} />}
      </section>
    </SessionGatedWebLayout>
  );
}
