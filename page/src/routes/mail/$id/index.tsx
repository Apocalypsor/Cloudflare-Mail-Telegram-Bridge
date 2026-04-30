import { Card, Skeleton } from "@heroui/react";
import { api } from "@page/api/client";
import { validateSearch } from "@page/api/utils";
import { MailBodyFrame } from "@page/components/mail-body-frame";
import { MailMeta } from "@page/components/mail-meta";
import { WebLayout } from "@page/components/web-layout";
import { Type as t } from "@sinclair/typebox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { WebMailToolbar } from "./-components/web-toolbar";

const Search = t.Object({
  accountId: t.Number(),
  t: t.String(),
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
});

export const Route = createFileRoute("/mail/$id/")({
  component: WebMailPage,
  validateSearch: validateSearch(Search),
});

function WebMailPage() {
  const { id: emailMessageId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();
  // CORS 代理 toggle —— 默认开启，由 toolbar 里的按钮切换；MailBodyFrame
  // 根据这个值决定渲染 proxiedHtml 还是 rawHtml。
  const [useProxy, setUseProxy] = useState(true);

  // Cache key 和 Mini App `/telegram-app/mail/$id` 共用 —— 同一个 API
  // (`ROUTE_MAIL_API`)，shape 相同，本来就该共享缓存。
  const queryKey = [
    "mail-preview",
    emailMessageId,
    search.accountId,
    search.folder,
  ];

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await api.api.mail({ id: emailMessageId }).get({
        query: {
          accountId: String(search.accountId),
          t: search.t,
          folder: search.folder,
        },
      });
      if (error) throw error;
      return data;
    },
    retry: false,
  });

  if (q.isLoading) {
    return (
      <WebLayout>
        <article className="space-y-4">
          <Skeleton className="h-9 w-2/3 rounded-md" />
          <Skeleton className="h-4 w-1/3 rounded-md" />
          <Skeleton className="h-4 w-1/2 rounded-md" />
          <Card className="mt-8 bg-zinc-900 border border-zinc-800 p-6 space-y-3">
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-11/12 rounded-md" />
            <Skeleton className="h-4 w-10/12 rounded-md" />
            <Skeleton className="h-4 w-9/12 rounded-md" />
          </Card>
        </article>
      </WebLayout>
    );
  }
  if (q.isError || !q.data) {
    return (
      <WebLayout>
        <Card className="max-w-md mx-auto mt-16 border border-red-900/50 bg-red-950/30 p-6 text-center">
          <div className="text-red-400 text-base font-medium">邮件加载失败</div>
          <p className="text-sm text-zinc-500 mt-2">
            链接可能已过期或参数错误。
          </p>
        </Card>
      </WebLayout>
    );
  }

  const d = q.data;

  return (
    <WebLayout>
      <article>
        {d.meta.subject && (
          <h1 className="text-2xl sm:text-[28px] md:text-[32px] font-semibold tracking-tight leading-tight break-words mb-4 text-zinc-100">
            {d.meta.subject}
          </h1>
        )}

        <MailMeta meta={d.meta} accountEmail={d.accountEmail} />

        <WebMailToolbar
          emailMessageId={emailMessageId}
          accountId={search.accountId}
          token={search.t}
          starred={d.starred}
          inJunk={d.inJunk}
          inArchive={d.inArchive}
          canArchive={d.canArchive}
          useProxy={useProxy}
          onToggleProxy={() => setUseProxy((v) => !v)}
          onChanged={() => qc.invalidateQueries({ queryKey })}
        />

        {/* 正文直接包在原生 div 里 —— HeroUI Card 默认带内边距，iframe 会
            被推出圆角之外。用 overflow-hidden + rounded-xl 把四角切齐。
            结构和 miniapp `telegram-app/mail.$id.tsx` 完全一致。 */}
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden shadow-[inset_0_8px_16px_-12px_rgba(0,0,0,0.5)]">
          <MailBodyFrame
            bodyHtml={d.bodyHtml}
            bodyHtmlRaw={d.bodyHtmlRaw}
            useProxy={useProxy}
          />
        </div>
      </article>
    </WebLayout>
  );
}
