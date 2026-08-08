import {
  ScheduledTask,
  type ScheduledTaskContext,
} from "@worker/handlers/scheduled/base";
import { syncAllEnabledAccountsUnreadMail } from "@worker/utils/mail-sync";

export class SyncUnreadMailTask extends ScheduledTask {
  constructor() {
    super("scheduled.sync_unread_mail_failed");
  }

  protected shouldRun(ctx: ScheduledTaskContext): boolean {
    return ctx.date.getUTCMinutes() % 10 === 0;
  }

  protected async run({ env, waitUntil }: ScheduledTaskContext): Promise<void> {
    await syncAllEnabledAccountsUnreadMail(env, waitUntil);
  }
}
