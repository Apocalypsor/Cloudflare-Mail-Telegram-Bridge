import { Card } from "@heroui/react";
import { validateSearch } from "@page/api/utils";
import { AppPendingSkeleton } from "@page/components/app-pending-skeleton";
import { MailAttachments } from "@page/components/mail-attachments";
import { MailBodyFrame } from "@page/components/mail-body-frame";
import { MailMeta } from "@page/components/mail-meta";
import { MailStatusBadges } from "@page/components/mail-status-badges";
import { WebLayout } from "@page/components/web-layout";
import {
  buildMailAttachmentUrl,
  mailContentQueryOptions,
  normalizeMailContentSearch,
} from "@page/utils/mail-content";
import { Type as t } from "@sinclair/typebox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { WebMailToolbar } from "./-components/web-toolbar";

const WebMailPage = () => {
  const { id: emailMessageId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();
  // CORS 代理 toggle —— 默认开启，由 toolbar 里的按钮切换；MailBodyFrame
  // 根据这个值决定渲染 proxiedHtml 还是 rawHtml。
  const [useProxy, setUseProxy] = useState(true);

  // Cache key 和 Mini App `/telegram-app/mail/$id` 共用 —— 同一个 API
  // (`ROUTE_MAIL_API`)，shape 相同，本来就该共享缓存。
  const queryOptions = mailContentQueryOptions({
    emailMessageId,
    accountId: search.accountId,
    token: search.t,
    access: search.access,
    folder: search.folder,
  });
  const q = useQuery({
    ...queryOptions,
    retry: false,
  });

  if (q.isLoading) {
    return <AppPendingSkeleton surface="web" />;
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

        <MailStatusBadges inArchive={d.inArchive} starred={d.starred} />

        <MailMeta meta={d.meta} accountEmail={d.accountEmail} />

        <WebMailToolbar
          emailMessageId={emailMessageId}
          accountId={search.accountId}
          token={search.t}
          starred={d.starred}
          inJunk={d.inJunk}
          inArchive={d.inArchive}
          canArchive={d.canArchive}
          folder={search.folder}
          useProxy={useProxy}
          onToggleProxy={() => setUseProxy((v) => !v)}
          onChanged={() =>
            qc.invalidateQueries({ queryKey: queryOptions.queryKey })
          }
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

        <MailAttachments
          attachments={d.attachments}
          getDownloadUrl={(attachmentId) =>
            buildMailAttachmentUrl({
              emailMessageId,
              accountId: search.accountId,
              token: search.t,
              access: search.access,
              folder: d.folder,
              attachmentId,
            })
          }
        />
      </article>
    </WebLayout>
  );
};
const Search = t.Object({
  access: t.Optional(t.String()),
  accountId: t.Optional(t.Number()),
  t: t.Optional(t.String()),
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
});

const validateMailSearchFields = validateSearch(Search);
const validateMailSearch = (input: Record<string, unknown>) => {
  return normalizeMailContentSearch(validateMailSearchFields(input));
};

export const Route = createFileRoute("/mail/$id/")({
  component: WebMailPage,
  validateSearch: validateMailSearch,
});
