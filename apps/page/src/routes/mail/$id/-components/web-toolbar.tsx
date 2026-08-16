import { Chip } from "@heroui/react";
import { type MailAction, useMailActions } from "@page/hooks/use-mail-actions";
import { useSession } from "@page/hooks/use-session";
import type { MailAccess } from "@page/utils/mail-content";
import { useState } from "react";
import { AccentButton } from "./accent-button";

interface WebMailToolbarProps {
  emailMessageId: string;
  mailAccess: MailAccess;
  starred: boolean;
  inJunk: boolean;
  inArchive: boolean;
  canArchive: boolean;
  /** toggle-star 透传给后端，IMAP 用以选对 mailbox */
  folder?: "inbox" | "junk" | "archive";
  useProxy: boolean;
  onToggleProxy: () => void;
  onChanged: () => void;
}

/** Web 版邮件 toolbar：星标 / 归档 / 标垃圾 / 图片代理切换。
 *  miniapp 那一套用 TG 原生 Main+SecondaryButton 走 popup；web 这套是真 DOM
 *  按钮平铺。共用 useMailActions hook 控制状态转换和后端调用。
 *
 *  图片代理开关只是本地切换 proxied/raw HTML，不发后端请求；即使浏览器未登录，
 *  只要邮件 token 有效也应该可用。 */
export const WebMailToolbar = ({
  emailMessageId,
  mailAccess,
  starred: initialStarred,
  inJunk,
  inArchive,
  canArchive,
  folder,
  useProxy,
  onToggleProxy,
  onChanged,
}: WebMailToolbarProps) => {
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
    ...mailAccess,
    initialStarred,
    folder,
    onChanged,
  });

  const runWithFeedback = async (action: MailAction, starredNext?: boolean) => {
    if (
      action === "archive" &&
      !window.confirm("归档这封邮件？它会从当前收件箱视图移出。")
    ) {
      return;
    }
    setMsg(null);
    const r = await runAction(action, starredNext);
    setMsg(
      r.ok
        ? { text: r.message ?? "操作成功", kind: "ok" }
        : { text: r.error ?? "操作失败", kind: "error" },
    );
  };

  const isDisabled = done || pending;
  const canMutateMail = !!session.data;

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {/* 邮件操作需要 Telegram 登录（session cookie）—— Worker 的 authAny
          对未登录 mutation 返 401。session 没拿到时隐藏这些后端动作，用户可
          从 header 右上的 "登录" 进入；登录回来后操作自然出现。 */}
      {canMutateMail && !inArchive && (
        <AccentButton
          label={starred ? "✅ 已星标" : "⭐ 星标"}
          tone={starred ? "success-soft" : "neutral"}
          isDisabled={isDisabled}
          onPress={() => runWithFeedback("toggle-star", !starred)}
        />
      )}
      {canMutateMail && inJunk ? (
        <>
          <AccentButton
            label="📥 移到收件箱"
            tone="accent"
            isDisabled={isDisabled}
            onPress={() => runWithFeedback("move-to-inbox")}
          />
          <AccentButton
            label="🗑 删除"
            tone="danger"
            isDisabled={isDisabled}
            onPress={() => runWithFeedback("trash")}
          />
        </>
      ) : canMutateMail && inArchive ? (
        <AccentButton
          label="📥 移出归档"
          tone="accent"
          isDisabled={isDisabled}
          onPress={() => runWithFeedback("unarchive")}
        />
      ) : canMutateMail ? (
        <>
          {canArchive && (
            <AccentButton
              label="📥 归档"
              tone="neutral"
              isDisabled={isDisabled}
              onPress={() => runWithFeedback("archive")}
            />
          )}
          <AccentButton
            label="🚫 标记为垃圾"
            tone="danger"
            isDisabled={isDisabled}
            onPress={() => runWithFeedback("mark-as-junk")}
          />
        </>
      ) : null}
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
};
