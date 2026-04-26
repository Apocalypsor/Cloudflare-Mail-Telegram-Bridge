import { Button, Card, Chip, Skeleton } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { ROUTE_MAIL_API } from "@worker/handlers/hono/routes";
import { useState } from "react";
import { z } from "zod";
import { api } from "@/api/client";
import { mailPreviewResponseSchema } from "@/api/schemas";
import { MailBodyFrame } from "@/components/mail-body-frame";
import { WebLayout } from "@/components/web-layout";
import { type MailAction, useMailActions } from "@/hooks/use-mail-actions";
import { useSession } from "@/hooks/use-session";

const searchSchema = z.object({
  accountId: z.coerce.number(),
  t: z.string(),
  folder: z.string().optional(),
});

export const Route = createFileRoute("/mail/$id")({
  component: WebMailPage,
  validateSearch: zodValidator(searchSchema),
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
  const metaRows: [string, string][] = [];
  if (d.meta.from) metaRows.push(["From", d.meta.from]);
  if (d.meta.to) metaRows.push(["To", d.meta.to]);
  if (d.accountEmail) metaRows.push(["Account", d.accountEmail]);
  if (d.meta.date) metaRows.push(["Date", d.meta.date]);

  return (
    <WebLayout>
      <article>
        {d.meta.subject && (
          <h1 className="text-2xl sm:text-[28px] md:text-[32px] font-semibold tracking-tight leading-tight break-words mb-4 text-zinc-100">
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
          useProxy={useProxy}
          onToggleProxy={() => setUseProxy((v) => !v)}
          onChanged={() => qc.invalidateQueries({ queryKey })}
        />

        {/* 正文直接包在原生 div 里 —— HeroUI Card 默认带内边距，iframe 会
            被推出圆角之外。用 overflow-hidden + rounded-xl 把四角切齐。
            结构和 miniapp `telegram-app/mail.$id.tsx` 完全一致。 */}
        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
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

interface ToolbarProps {
  emailMessageId: string;
  accountId: number;
  token: string;
  starred: boolean;
  inJunk: boolean;
  inArchive: boolean;
  canArchive: boolean;
  useProxy: boolean;
  onToggleProxy: () => void;
  onChanged: () => void;
}

function WebMailToolbar(props: ToolbarProps) {
  const session = useSession();
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(
    null,
  );

  const {
    starred,
    done,
    pending,
    run: runAction,
  } = useMailActions({
    emailMessageId: props.emailMessageId,
    accountId: props.accountId,
    token: props.token,
    initialStarred: props.starred,
    onChanged: props.onChanged,
  });

  async function run(action: MailAction, starredNext?: boolean) {
    setMsg(null);
    const r = await runAction(action, starredNext);
    setMsg(
      r.ok
        ? { text: r.message ?? "操作成功", kind: "ok" }
        : { text: r.error ?? "操作失败", kind: "error" },
    );
  }

  // 邮件操作需要 Telegram 登录（session cookie）—— Worker 的
  // `requireSessionOrMiniApp` middleware 对未登录请求返 401。session 没
  // 拿到（加载中或未登录）直接不渲染 toolbar，用户走 header 右上的 "登录"
  // 链接进 `/login`，回来后 session 就有了，toolbar 自然出现。
  if (!session.data) return null;

  const isDisabled = done || pending;

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {!props.inArchive && (
        <AccentButton
          label={starred ? "✅ 已星标" : "⭐ 星标"}
          tone={starred ? "success-soft" : "neutral"}
          isDisabled={isDisabled}
          onPress={() => run("toggle-star", !starred)}
        />
      )}
      {props.inJunk ? (
        <>
          <AccentButton
            label="📥 移到收件箱"
            tone="accent"
            isDisabled={isDisabled}
            onPress={() => run("move-to-inbox")}
          />
          <AccentButton
            label="🗑 删除"
            tone="danger"
            isDisabled={isDisabled}
            onPress={() => run("trash")}
          />
        </>
      ) : props.inArchive ? (
        <AccentButton
          label="📥 移出归档"
          tone="accent"
          isDisabled={isDisabled}
          onPress={() => run("unarchive")}
        />
      ) : (
        <>
          {props.canArchive && (
            <AccentButton
              label="📥 归档"
              tone="neutral"
              isDisabled={isDisabled}
              onPress={() => run("archive")}
            />
          )}
          <AccentButton
            label="🚫 标记为垃圾"
            tone="danger"
            isDisabled={isDisabled}
            onPress={() => run("mark-as-junk")}
          />
        </>
      )}
      {/* CORS 图片代理 toggle —— 不会发请求、不影响 pending；放在所有状态
          按钮之后，inbox 默认会自然落在「标记为垃圾」旁边。 */}
      <AccentButton
        label={props.useProxy ? "🖼 图片代理 开" : "🖼 图片代理 关"}
        tone={props.useProxy ? "success-soft" : "neutral"}
        isDisabled={false}
        onPress={props.onToggleProxy}
      />
      {msg && !pending && (
        <Chip
          className={
            msg.kind === "error"
              ? "bg-red-950/50 text-red-300 border border-red-900/60"
              : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
          }
          size="sm"
        >
          {msg.kind === "ok" ? "✓" : "✕"} {msg.text}
        </Chip>
      )}
    </div>
  );
}

/**
 * 给 HeroUI Button 套一层 tone → className 映射，保证邮件操作按钮在 web
 * 上视觉和 miniapp MailFab 一致：zinc 中性 / emerald 强调 / red 危险 /
 * soft emerald（已星标等成功态）。
 */
function AccentButton({
  label,
  tone,
  isDisabled,
  onPress,
}: {
  label: string;
  tone: "neutral" | "accent" | "danger" | "success-soft";
  isDisabled: boolean;
  onPress: () => void;
}) {
  const className = {
    neutral:
      "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
    accent:
      "bg-emerald-500 hover:bg-emerald-400 text-emerald-950 border border-emerald-500",
    danger: "bg-red-600 hover:bg-red-500 text-white border border-red-600",
    "success-soft":
      "bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800",
  }[tone];

  return (
    <Button
      onPress={onPress}
      isDisabled={isDisabled}
      size="sm"
      className={`rounded-full font-medium ${className}`}
    >
      {label}
    </Button>
  );
}
