import { Skeleton } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { api } from "@/api/client";
import { ROUTE_MAIL_API } from "@/api/routes";
import { mailPreviewResponseSchema } from "@/api/schemas";
import { MailBodyFrame } from "@/components/mail-body-frame";
import { MailFab } from "@/components/mail-fab";
import { useBackButton } from "@/hooks/use-back-button";
import { getTelegram } from "@/providers/telegram";

// accountId + t 必填：缺失 → validateSearch 抛出，由父级 errorComponent 渲染。
// folder / back 可选。
const searchSchema = z.object({
  accountId: z.coerce.number(),
  t: z.string(),
  folder: z.string().optional(),
  back: z.string().optional(),
});

export const Route = createFileRoute("/telegram-app/mail/$id")({
  component: MailPreviewPage,
  validateSearch: zodValidator(searchSchema),
});

function MailPreviewPage() {
  const { id: emailMessageId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();

  const queryKey = [
    "mail-preview",
    emailMessageId,
    search.accountId,
    search.folder,
  ];

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const url = ROUTE_MAIL_API.replace(
        ":id",
        encodeURIComponent(emailMessageId),
      ).replace(/^\//, "");
      const searchParams: Record<string, string> = {
        accountId: String(search.accountId),
        t: search.t,
      };
      if (search.folder) searchParams.folder = search.folder;
      const data = await api.get(url, { searchParams }).json();
      return mailPreviewResponseSchema.parse(data);
    },
  });

  // BackButton：URL 带 ?back= 时显示并跳回该 URL；没有就隐藏（从 bot 按钮直接进来）
  useBackButton(search.back);

  if (q.isLoading) {
    return (
      <div>
        <div className="bg-[color:var(--surface)] border-b border-[color:var(--surface-secondary)] px-4 py-3 space-y-2">
          <Skeleton className="h-6 w-2/3 rounded-md" />
          <Skeleton className="h-3 w-1/3 rounded-md" />
          <Skeleton className="h-3 w-1/2 rounded-md" />
        </div>
        <div className="px-4 py-4 space-y-3">
          <Skeleton className="h-4 w-full rounded-md" />
          <Skeleton className="h-4 w-11/12 rounded-md" />
          <Skeleton className="h-4 w-10/12 rounded-md" />
          <Skeleton className="h-4 w-9/12 rounded-md" />
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="p-5 text-sm text-[color:var(--danger)]">邮件加载失败</div>
    );
  }

  const d = q.data;
  return (
    <>
      <MailMetaHeader
        subject={d.meta.subject ?? null}
        from={d.meta.from ?? null}
        to={d.meta.to ?? null}
        date={d.meta.date ?? null}
        accountEmail={d.accountEmail}
        webMailUrl={d.webMailUrl}
      />
      {/* MainButton 由 TG 宿主绘制在屏幕底部外，不占页面盒子；正文只需常规边距 */}
      <div className="px-4 py-4 pb-8 break-words">
        <MailBodyFrame bodyHtml={d.bodyHtml} />
      </div>
      <MailFab
        emailMessageId={emailMessageId}
        accountId={search.accountId}
        token={search.t}
        starred={d.starred}
        inJunk={d.inJunk}
        inArchive={d.inArchive}
        canArchive={d.canArchive}
        subject={d.meta.subject ?? null}
        webMailUrl={d.webMailUrl}
        tgMessageLink={d.tgMessageLink}
        onChanged={() => qc.invalidateQueries({ queryKey })}
      />
    </>
  );
}

/**
 * 邮件 meta 信息头：标题（可点 → 浏览器打开原文） + From/To/Account/Date。
 * 分享 / 跳 TG 原消息两个动作已移到底部 SecondaryButton，这里不再渲染。
 */
function MailMetaHeader({
  subject,
  from,
  to,
  date,
  accountEmail,
  webMailUrl,
}: {
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  accountEmail: string | null;
  webMailUrl: string;
}) {
  if (!subject && !from && !to && !accountEmail && !date) return null;

  function openInBrowser(e: React.MouseEvent) {
    if (!webMailUrl) return;
    e.preventDefault();
    const tg = getTelegram();
    if (tg?.openLink) tg.openLink(webMailUrl);
    else window.open(webMailUrl, "_blank", "noopener");
  }

  return (
    <div className="bg-[color:var(--surface)] text-[color:var(--surface-foreground)] border-b border-[color:var(--surface-secondary)] px-4 py-3 text-[13px] leading-7">
      {subject &&
        (webMailUrl ? (
          <a
            href={webMailUrl}
            onClick={openInBrowser}
            title="在浏览器打开"
            className="block text-[22px] font-semibold break-words text-[color:var(--accent)] mb-1.5 active:opacity-60 no-underline"
          >
            {subject}
            <span className="text-sm opacity-70 ml-1">↗</span>
          </a>
        ) : (
          <div className="text-[22px] font-semibold break-words text-[color:var(--accent)] mb-1.5">
            {subject}
          </div>
        ))}

      {from && (
        <div>
          <span className="text-[color:var(--muted)]">From:</span> {from}
        </div>
      )}
      {to && (
        <div>
          <span className="text-[color:var(--muted)]">To:</span> {to}
        </div>
      )}
      {accountEmail && (
        <div>
          <span className="text-[color:var(--muted)]">Account:</span>{" "}
          {accountEmail}
        </div>
      )}
      {date && (
        <div>
          <span className="text-[color:var(--muted)]">Date:</span> {date}
        </div>
      )}
    </div>
  );
}
