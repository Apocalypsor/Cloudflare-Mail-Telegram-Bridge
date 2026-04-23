import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useState } from "react";
import { z } from "zod";
import { api, extractErrorMessage } from "@/api/client";
import { ROUTE_MAIL_API } from "@/api/routes";
import { mailPreviewResponseSchema, okResponseSchema } from "@/api/schemas";
import { MailBodyFrame } from "@/components/mail-body-frame";
import { WebLayout } from "@/components/web-layout";

const searchSchema = z.object({
  accountId: z.coerce.number(),
  t: z.string(),
  folder: z.string().optional(),
});

export const Route = createFileRoute("/mail/$id")({
  component: WebMailPage,
  validateSearch: zodValidator(searchSchema),
});

type Action =
  | "toggle-star"
  | "archive"
  | "unarchive"
  | "trash"
  | "mark-as-junk"
  | "move-to-inbox";

function WebMailPage() {
  const { id: emailMessageId } = Route.useParams();
  const search = Route.useSearch();
  const qc = useQueryClient();

  const queryKey = [
    "web-mail-preview",
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
    retry: false,
  });

  if (q.isLoading) {
    return (
      <WebLayout>
        <div className="animate-pulse space-y-4">
          <div className="h-9 w-2/3 rounded-md bg-zinc-800" />
          <div className="h-4 w-1/3 rounded-md bg-zinc-800" />
          <div className="h-4 w-1/2 rounded-md bg-zinc-800" />
          <div className="mt-8 rounded-xl bg-zinc-900 border border-zinc-800 p-6 space-y-3">
            <div className="h-4 w-full rounded-md bg-zinc-800" />
            <div className="h-4 w-11/12 rounded-md bg-zinc-800" />
            <div className="h-4 w-10/12 rounded-md bg-zinc-800" />
            <div className="h-4 w-9/12 rounded-md bg-zinc-800" />
          </div>
        </div>
      </WebLayout>
    );
  }
  if (q.isError || !q.data) {
    return (
      <WebLayout>
        <div className="max-w-md mx-auto mt-16 rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-center">
          <div className="text-red-400">邮件加载失败</div>
          <p className="text-sm text-zinc-500 mt-2">
            链接可能已过期或参数错误。
          </p>
        </div>
      </WebLayout>
    );
  }

  const d = q.data;
  const metaRows: [string, string][] = [];
  if (d.meta.from) metaRows.push(["From", d.meta.from]);
  if (d.meta.to) metaRows.push(["To", d.meta.to]);
  if (d.accountEmail) metaRows.push(["Account", d.accountEmail]);
  if (d.meta.date) metaRows.push(["Date", d.meta.date]);

  return (
    <WebLayout>
      <article>
        {d.meta.subject && (
          <h1 className="text-2xl sm:text-[28px] md:text-[32px] font-semibold tracking-tight leading-tight break-words mb-4">
            {d.meta.subject}
          </h1>
        )}

        {metaRows.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-6">
            {metaRows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-zinc-500">{label}</dt>
                <dd className="text-zinc-300 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        <WebMailToolbar
          emailMessageId={emailMessageId}
          accountId={search.accountId}
          token={search.t}
          starred={d.starred}
          inJunk={d.inJunk}
          inArchive={d.inArchive}
          canArchive={d.canArchive}
          onChanged={() => qc.invalidateQueries({ queryKey })}
        />

        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-6 overflow-hidden">
          <MailBodyFrame bodyHtml={d.bodyHtml} />
        </div>
      </article>
    </WebLayout>
  );
}

interface ToolbarProps {
  emailMessageId: string;
  accountId: number;
  token: string;
  starred: boolean;
  inJunk: boolean;
  inArchive: boolean;
  canArchive: boolean;
  onChanged: () => void;
}

function WebMailToolbar(props: ToolbarProps) {
  const [starred, setStarred] = useState(props.starred);
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(
    null,
  );

  const mut = useMutation({
    mutationFn: async ({
      action,
      starredNext,
    }: {
      action: Action;
      starredNext?: boolean;
    }) => {
      const body: Record<string, unknown> = {
        accountId: props.accountId,
        token: props.token,
      };
      if (starredNext !== undefined) body.starred = starredNext;
      const raw = await api
        .post(
          `api/mail/${encodeURIComponent(props.emailMessageId)}/${action}`,
          { json: body },
        )
        .json();
      return { action, starredNext, res: okResponseSchema.parse(raw) };
    },
    onSuccess: ({ action, starredNext, res }) => {
      if (!res.ok) {
        setMsg({ text: res.error ?? "操作失败", kind: "error" });
        return;
      }
      setMsg({ text: res.message ?? "操作成功", kind: "ok" });
      if (action === "toggle-star" && starredNext !== undefined) {
        setStarred(starredNext);
      } else {
        setDone(true);
      }
      props.onChanged();
    },
    onError: async (err) => {
      setMsg({ text: await extractErrorMessage(err), kind: "error" });
    },
  });

  function run(action: Action, starredNext?: boolean) {
    setMsg(null);
    mut.mutate({ action, starredNext });
  }

  const disabled = done || mut.isPending;

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {!props.inArchive && (
        <ToolbarBtn
          label={starred ? "✅ 已星标" : "⭐ 星标"}
          tone={starred ? "success" : "default"}
          disabled={disabled}
          onClick={() => run("toggle-star", !starred)}
        />
      )}
      {props.inJunk ? (
        <>
          <ToolbarBtn
            label="📥 移到收件箱"
            tone="accent"
            disabled={disabled}
            onClick={() => run("move-to-inbox")}
          />
          <ToolbarBtn
            label="🗑 删除"
            tone="danger"
            disabled={disabled}
            onClick={() => run("trash")}
          />
        </>
      ) : props.inArchive ? (
        <ToolbarBtn
          label="📥 移出归档"
          tone="accent"
          disabled={disabled}
          onClick={() => run("unarchive")}
        />
      ) : (
        <>
          {props.canArchive && (
            <ToolbarBtn
              label="📥 归档"
              tone="default"
              disabled={disabled}
              onClick={() => run("archive")}
            />
          )}
          <ToolbarBtn
            label="🚫 标记为垃圾"
            tone="danger"
            disabled={disabled}
            onClick={() => run("mark-as-junk")}
          />
        </>
      )}
      {mut.isPending && (
        <span className="text-xs text-zinc-500 ml-1">处理中…</span>
      )}
      {msg && !mut.isPending && (
        <span
          className={`text-sm ml-1 ${
            msg.kind === "error" ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {msg.kind === "ok" ? "✓" : "✕"} {msg.text}
        </span>
      )}
    </div>
  );
}

function ToolbarBtn({
  label,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  tone: "default" | "accent" | "danger" | "success";
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClass = {
    default:
      "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
    accent:
      "bg-emerald-500 hover:bg-emerald-400 text-emerald-950 border border-emerald-500",
    danger: "bg-red-600 hover:bg-red-500 text-white border border-red-600",
    success:
      "bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800",
  }[tone];

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${toneClass}`}
    >
      {label}
    </button>
  );
}
