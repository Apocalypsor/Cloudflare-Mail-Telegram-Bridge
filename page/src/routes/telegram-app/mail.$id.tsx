import { Skeleton } from "@heroui/react";
import { api } from "@page/api/client";
import { validateSearch } from "@page/api/utils";
import { MailBodyFrame } from "@page/components/mail-body-frame";
import { MailFab } from "@page/components/mail-fab";
import { MailMeta } from "@page/components/mail-meta";
import { useBackButton } from "@page/hooks/use-back-button";
import { openExternalLink } from "@page/utils/tg";
import { Type as t } from "@sinclair/typebox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

// accountId + t 必填：缺失 → validateSearch 抛出，由父级 errorComponent 渲染。
// folder / back 可选。
const Search = t.Object({
  accountId: t.Number(),
  t: t.String(),
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
  back: t.Optional(t.String()),
});

export const Route = createFileRoute("/telegram-app/mail/$id")({
  component: MailPreviewPage,
  validateSearch: validateSearch(Search),
});

function MailPreviewPage() {
  const { id: emailMessageId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onSetReminder = useCallback(() => {
    const back = window.location.pathname + window.location.search;
    navigate({
      to: "/telegram-app/reminders",
      search: {
        accountId: search.accountId,
        emailMessageId,
        token: search.t,
        back,
      },
    });
  }, [navigate, search.accountId, search.t, emailMessageId]);
  // CORS 代理 toggle —— 默认开启，由 MailFab SecondaryButton 切换；
  // MailBodyFrame 根据这个值决定渲染 proxiedHtml 还是 rawHtml。
  const [useProxy, setUseProxy] = useState(true);

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
  });

  // BackButton：URL 带 ?back= 时显示并跳回该 URL；没有就隐藏（从 bot 按钮直接进来）
  useBackButton(search.back);

  if (q.isLoading) {
    return (
      <article className="max-w-3xl mx-auto px-4 py-6 animate-pulse space-y-4">
        <Skeleton className="h-9 w-2/3 rounded-md" />
        <Skeleton className="h-4 w-1/3 rounded-md" />
        <Skeleton className="h-4 w-1/2 rounded-md" />
        <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-3">
          <Skeleton className="h-4 w-full rounded-md" />
          <Skeleton className="h-4 w-11/12 rounded-md" />
          <Skeleton className="h-4 w-10/12 rounded-md" />
          <Skeleton className="h-4 w-9/12 rounded-md" />
        </div>
      </article>
    );
  }
  if (q.isError || !q.data) {
    return <div className="p-5 text-sm text-red-400">邮件加载失败</div>;
  }

  const d = q.data;

  return (
    <>
      {/* 结构和间距都对齐 web `/mail/:id` —— 正常内容流（不置顶），滚动时
         subject/meta 跟着走。MailFab 底部 TG 原生按钮代替 web 的 toolbar。 */}
      <article className="max-w-3xl mx-auto px-4 py-6 break-words">
        {d.meta.subject && (
          <Subject subject={d.meta.subject} webMailUrl={d.webMailUrl} />
        )}

        <MailMeta meta={d.meta} accountEmail={d.accountEmail} />

        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden shadow-[inset_0_8px_16px_-12px_rgba(0,0,0,0.5)]">
          <MailBodyFrame
            bodyHtml={d.bodyHtml}
            bodyHtmlRaw={d.bodyHtmlRaw}
            useProxy={useProxy}
          />
        </div>
      </article>

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
        useProxy={useProxy}
        onToggleProxy={() => setUseProxy((v) => !v)}
        onSetReminder={onSetReminder}
        onChanged={() => qc.invalidateQueries({ queryKey })}
      />
    </>
  );
}

/**
 * 邮件标题：结构沿用 web 的 `<h1>` 尺寸（text-2xl → text-[32px]）和布局，
 * 但 miniapp 这里 subject 是个实实在在的 link（点击 → TG 浏览器打开原文）。
 * 为了让用户看出来可点，标题染 emerald 并带下划线，再加个 `↗` 图标；
 * 无 webMailUrl 时退化成 web 同款的纯 zinc-100 h1。
 */
function Subject({
  subject,
  webMailUrl,
}: {
  subject: string;
  webMailUrl: string;
}) {
  const baseClass =
    "text-2xl sm:text-[28px] md:text-[32px] font-semibold tracking-tight leading-tight break-words mb-4";

  if (!webMailUrl) {
    return <h1 className={`${baseClass} text-zinc-100`}>{subject}</h1>;
  }

  function openInBrowser(e: React.MouseEvent) {
    e.preventDefault();
    openExternalLink(webMailUrl);
  }

  return (
    <h1 className={baseClass}>
      <a
        href={webMailUrl}
        onClick={openInBrowser}
        title="在浏览器打开"
        className="text-emerald-400 underline decoration-emerald-500/40 decoration-2 underline-offset-4 active:opacity-60"
      >
        {subject}
        <span className="text-base font-normal opacity-70 ml-2">↗</span>
      </a>
    </h1>
  );
}
