import { Skeleton } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useEffect } from "react";
import { z } from "zod";
import { MailBodyFrame } from "@/components/mail-body-frame";
import { MailFab } from "@/components/mail-fab";
import { api } from "@/lib/api";
import { ROUTE_MINI_APP_API_MAIL } from "@/lib/routes";
import { mailPreviewResponseSchema } from "@/lib/schemas";
import { getTelegram } from "@/lib/tg";

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
      const url = ROUTE_MINI_APP_API_MAIL.replace(
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

  // BackButton 绑定：URL 带 ?back= 时显示，点击跳回该 URL（mail-list / reminders）
  useEffect(() => {
    const tg = getTelegram();
    const bb = tg?.BackButton;
    if (!bb) return;
    if (!search.back) {
      bb.hide();
      return;
    }
    const handler = () => {
      window.location.href = search.back as string;
    };
    bb.show();
    bb.onClick(handler);
    return () => {
      bb.offClick(handler);
      bb.hide();
    };
  }, [search.back]);

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
        tgMessageLink={d.tgMessageLink}
      />
      <div className="px-4 py-4 pb-24 break-words">
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
        onChanged={() => qc.invalidateQueries({ queryKey })}
      />
    </>
  );
}

function MailMetaHeader({
  subject,
  from,
  to,
  date,
  accountEmail,
  webMailUrl,
  tgMessageLink,
}: {
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  accountEmail: string | null;
  webMailUrl: string;
  tgMessageLink: string | null;
}) {
  if (!subject && !from && !to && !accountEmail && !date) return null;
  const shareText = subject ? `📧 ${subject}` : "";

  function openExternal(
    e: React.MouseEvent,
    url: string,
    kind: "tg" | "browser",
  ) {
    e.preventDefault();
    const tg = getTelegram();
    if (kind === "tg" && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      // 某些 TG 客户端不会自动关 Mini App —— 兜底显式 close
      setTimeout(() => tg.close?.(), 50);
    } else if (tg?.openLink) {
      tg.openLink(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  function share(e: React.MouseEvent) {
    e.preventDefault();
    const url = webMailUrl;
    if (!url) return;
    const shareLink =
      `https://t.me/share/url?url=${encodeURIComponent(url)}` +
      `&text=${encodeURIComponent(shareText)}`;
    const tg = getTelegram();
    if (tg?.openTelegramLink) tg.openTelegramLink(shareLink);
    else window.open(shareLink, "_blank", "noopener");
  }

  return (
    <div className="bg-[color:var(--surface)] text-[color:var(--surface-foreground)] border-b border-[color:var(--surface-secondary)] px-4 py-3 text-[13px] leading-7">
      {subject &&
        (webMailUrl ? (
          <a
            href={webMailUrl}
            onClick={(e) => openExternal(e, webMailUrl, "browser")}
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

      <div className="flex gap-3 flex-wrap mt-1.5">
        {tgMessageLink && (
          <a
            href={tgMessageLink}
            onClick={(e) => openExternal(e, tgMessageLink, "tg")}
            className="text-xs text-[color:var(--accent)] active:opacity-60 no-underline"
          >
            💬 跳到 TG 原消息
          </a>
        )}
        {webMailUrl && (
          <button
            type="button"
            onClick={share}
            className="text-xs text-[color:var(--accent)] active:opacity-60 bg-transparent border-0 p-0 cursor-pointer"
          >
            📤 分享
          </button>
        )}
      </div>

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
