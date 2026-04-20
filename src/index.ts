import app from "@handlers/hono";
import { handleQueueBatch } from "@handlers/queue";
import { renewAllPush } from "@providers";
import { checkImapBridgeHealth } from "@providers/imap";
import { retryAllFailedEmails } from "@services/bridge";
import { isDigestHour, sendDigestNotifications } from "@services/digest";
import { dispatchDueReminders } from "@services/reminders";
import { reportErrorToObservability } from "@utils/observability";
import type { Env, QueueMessage } from "@/types";

export type { Env } from "@/types";

export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const date = new Date(event.scheduledTime);
  const isMidnight = date.getUTCHours() === 0;
  // 每分钟都跑：分钟级提醒分发；只有整点的 tick 才跑下面的 hourly 任务。
  const isHourly = date.getUTCMinutes() === 0;

  // 每分钟：分发到期提醒
  const reminderTask = dispatchDueReminders(env).catch((error: unknown) =>
    reportErrorToObservability(env, "scheduled.reminders_failed", error),
  );

  if (!isHourly) {
    await reminderTask;
    return;
  }

  await Promise.allSettled([
    reminderTask,
    // 每小时：自动重试失败邮件的 LLM 摘要
    retryAllFailedEmails(env).catch((error: unknown) =>
      reportErrorToObservability(env, "scheduled.retry_failed_emails", error),
    ),
    // 每小时：检查 IMAP 中间件健康
    checkImapBridgeHealth(env)
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
      ),
    // 仅凌晨：续订所有账号推送通知
    isMidnight
      ? renewAllPush(env).catch((error: unknown) =>
          reportErrorToObservability(env, "scheduled.push_renew_failed", error),
        )
      : Promise.resolve(),
    // 早9晚6：邮件摘要通知
    isDigestHour(event.scheduledTime)
      ? sendDigestNotifications(env, event.scheduledTime).catch(
          (error: unknown) =>
            reportErrorToObservability(env, "scheduled.digest_failed", error),
        )
      : Promise.resolve(),
  ]);
}
