import { Chip } from "@heroui/react";
import { useState } from "react";
import { type MailAction, useMailActions } from "@/hooks/use-mail-actions";
import { useSession } from "@/hooks/use-session";
import { AccentButton } from "./accent-button";

/** Web 版邮件 toolbar：星标 / 归档 / 标垃圾 / 图片代理切换。
 *  miniapp 那一套用 TG 原生 Main+SecondaryButton 走 popup；web 这套是真 DOM
 *  按钮平铺。共用 useMailActions hook 控制状态转换和后端调用。 */
export function WebMailToolbar({
  emailMessageId,
  accountId,
  token,
  starred: initialStarred,
  inJunk,
  inArchive,
  canArchive,
  useProxy,
  onToggleProxy,
  onChanged,
}: {
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
}) {
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
    emailMessageId,
    accountId,
    token,
    initialStarred,
    onChanged,
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
      {!inArchive && (
        <AccentButton
          label={starred ? "✅ 已星标" : "⭐ 星标"}
          tone={starred ? "success-soft" : "neutral"}
          isDisabled={isDisabled}
          onPress={() => run("toggle-star", !starred)}
        />
      )}
      {inJunk ? (
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
      ) : inArchive ? (
        <AccentButton
          label="📥 移出归档"
          tone="accent"
          isDisabled={isDisabled}
          onPress={() => run("unarchive")}
        />
      ) : (
        <>
          {canArchive && (
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
        label={useProxy ? "🖼 图片代理 开" : "🖼 图片代理 关"}
        tone={useProxy ? "success-soft" : "neutral"}
        isDisabled={false}
        onPress={onToggleProxy}
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
