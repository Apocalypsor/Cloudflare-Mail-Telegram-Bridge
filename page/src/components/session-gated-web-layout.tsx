import type { ReactNode } from "react";
import { useRequireTelegramLogin } from "@/hooks/use-require-telegram-login";
import { SessionGatePlaceholder } from "./session-gate-placeholder";
import { WebLayout } from "./web-layout";

/** WebLayout 包一层 session gate —— session 没拿到（loading / redirecting /
 *  unauthenticated）渲染 placeholder，OK 才渲染 children。preview / junk-check
 *  这种"必须登录才能用"的工具页直接用这个就行，不再 if-return 一遍 gate。 */
export function SessionGatedWebLayout({
  subtitle,
  children,
}: {
  subtitle: string;
  children: ReactNode;
}) {
  const session = useRequireTelegramLogin();
  const ready = !session.isLoading && !session.isRedirecting && session.data;

  return (
    <WebLayout subtitle={subtitle}>
      {ready ? (
        children
      ) : (
        <SessionGatePlaceholder redirecting={session.isRedirecting} />
      )}
    </WebLayout>
  );
}
