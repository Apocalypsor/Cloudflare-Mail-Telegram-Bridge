import type { Env, WaitUntil } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";

export type { WaitUntil } from "@worker/types";

export interface ScheduledTaskContext {
  env: Env;
  date: Date;
  waitUntil: WaitUntil;
}

export abstract class ScheduledTask {
  protected constructor(private readonly errorEvent: string) {}

  async runIfDue(ctx: ScheduledTaskContext): Promise<void> {
    if (!this.shouldRun(ctx)) return;
    try {
      await this.run(ctx);
    } catch (error) {
      await reportErrorToObservability(ctx.env, this.errorEvent, error);
    }
  }

  protected shouldRun(_ctx: ScheduledTaskContext): boolean {
    return true;
  }

  protected isHourly(ctx: ScheduledTaskContext): boolean {
    return ctx.date.getUTCMinutes() === 0;
  }

  protected isQuarterHour(ctx: ScheduledTaskContext): boolean {
    return ctx.date.getUTCMinutes() % 15 === 0;
  }

  protected isUtcMidnight(ctx: ScheduledTaskContext): boolean {
    return this.isHourly(ctx) && ctx.date.getUTCHours() === 0;
  }

  protected abstract run(ctx: ScheduledTaskContext): Promise<void>;
}
