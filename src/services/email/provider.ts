import type { Account, Env } from "@/types";

export interface EmailListItem {
  id: string;
  subject?: string;
}

export abstract class EmailProvider {
  protected account: Account;
  protected env: Env;

  constructor(account: Account, env: Env) {
    this.account = account;
    this.env = env;
  }

  abstract markAsRead(messageId: string): Promise<void>;
  abstract addStar(messageId: string): Promise<void>;
  abstract removeStar(messageId: string): Promise<void>;
  abstract isStarred(messageId: string): Promise<boolean>;
  abstract isJunk(messageId: string): Promise<boolean>;
  abstract listUnread(maxResults?: number): Promise<EmailListItem[]>;
  abstract listStarred(maxResults?: number): Promise<EmailListItem[]>;
  abstract listJunk(maxResults?: number): Promise<EmailListItem[]>;
  abstract markAsJunk(messageId: string): Promise<void>;
  abstract moveToInbox(messageId: string): Promise<void>;
  abstract trashMessage(messageId: string): Promise<void>;
  abstract trashAllJunk(): Promise<number>;

  /** 注册/续订推送通知（Gmail watch / Outlook subscription） */
  async renewPush(): Promise<void> {}
  /** 停止推送通知 */
  async stopPush(): Promise<void> {}

  /** 解析推送通知并将新邮件入队，子类必须 override */
  static async enqueue(_body: unknown, _env: Env): Promise<void> {
    throw new Error("enqueue not implemented");
  }
}
