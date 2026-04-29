import { renewAllPush } from "@providers";
import { checkImapBridgeHealth } from "@providers/imap";
import { retryAllFailedEmails } from "@services/bridge";
import { dispatchDueReminders } from "@services/reminders";
import { reportErrorToObservability } from "@utils/observability";
import type { Env } from "@/types";

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const date = new Date(event.scheduledTime);
  const isMidnight = date.getUTCHours() === 0;
  const isHourly = date.getUTCMinutes() === 0;
  const waitUntil = ctx.waitUntil.bind(ctx);

  await Promise.allSettled([
    dispatchDueReminders(env, waitUntil).catch((error: unknown) =>
      reportErrorToObservability(env, "scheduled.reminders_failed", error),
    ),
    // 每小时：自动重试失败邮件的 LLM 摘要
    isHourly
      ? retryAllFailedEmails(env).catch((error: unknown) =>
          reportErrorToObservability(
            env,
            "scheduled.retry_failed_emails",
            error,
          ),
        )
      : Promise.resolve(),
    // 每小时：检查 IMAP 中间件健康
    isHourly
      ? checkImapBridgeHealth(env)
          .then((health) => {
            if (health !== null && !health.ok) {
              return reportErrorToObservability(
                env,
                "scheduled.imap_bridge_unhealthy",
                new Error("IMAP bridge unhealthy"),
                {
                  total: health.total,
                  usable: health.usable,
                },
              );
            }
          })
          .catch((error: unknown) =>
            reportErrorToObservability(
              env,
              "scheduled.imap_bridge_health_check_failed",
              error,
            ),
          )
      : Promise.resolve(),
    // 仅凌晨：续订所有账号推送通知
    isMidnight
      ? renewAllPush(env).catch((error: unknown) =>
          reportErrorToObservability(env, "scheduled.push_renew_failed", error),
        )
      : Promise.resolve(),
  ]);
}
