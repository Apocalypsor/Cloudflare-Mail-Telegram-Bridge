import { getAccountById } from "@db/accounts";
import {
  deleteMsSubscription,
  getMsAccountBySubscription,
  getMsSubscriptionId,
  putMsSubscription,
  refreshMsSubAccountMapping,
} from "@db/kv";
import {
  getAccessToken,
  graphGet,
  graphPatch,
  graphPost,
} from "@services/email/outlook/utils";
import { EmailProvider } from "@services/email/provider";
import { http } from "@utils/http";
import { HTTPError } from "ky";
import { MS_GRAPH_API, MS_SUBSCRIPTION_LIFETIME_MINUTES } from "@/constants";
import type { Env } from "@/types";

export { fetchRawMime, getAccessToken } from "@services/email/outlook/utils";

interface GraphMessage {
  id: string;
  subject?: string;
  parentFolderId?: string;
  flag?: { flagStatus: string };
}

interface GraphMessageList {
  value?: GraphMessage[];
}

interface GraphFolder {
  id: string;
}

export class OutlookProvider extends EmailProvider {
  private async token(): Promise<string> {
    return getAccessToken(this.env, this.account);
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────

  /** 解析 Graph change notification 并入队 */
  static async enqueue(
    body: {
      value: Array<{
        subscriptionId: string;
        changeType: string;
        resource: string;
        resourceData?: { id: string };
        clientState?: string;
      }>;
    },
    env: Env,
  ): Promise<void> {
    const batch: Array<{ body: { accountId: number; messageId: string } }> = [];

    for (const notification of body.value) {
      if (notification.clientState !== env.MS_WEBHOOK_SECRET) {
        console.log("Outlook push: invalid clientState, skipping");
        continue;
      }

      const messageId = notification.resourceData?.id;
      if (!messageId) {
        console.log("Outlook push: no resourceData.id, skipping");
        continue;
      }

      const accountIdStr = await getMsAccountBySubscription(
        env.EMAIL_KV,
        notification.subscriptionId,
      );
      if (!accountIdStr) {
        console.log(
          `Outlook push: unknown subscriptionId ${notification.subscriptionId}`,
        );
        continue;
      }

      const accountId = parseInt(accountIdStr, 10);
      const account = await getAccountById(env.DB, accountId);
      if (!account) {
        console.log(`Outlook push: account ${accountId} not found`);
        continue;
      }

      batch.push({ body: { accountId: account.id, messageId } });
    }

    if (batch.length > 0) {
      console.log(`Outlook push: enqueueing ${batch.length} messages`);
      await env.EMAIL_QUEUE.sendBatch(batch);
    }
  }

  // ─── Push (Outlook Subscription) ──────────────────────────────────────

  async renewPush() {
    if (!this.env.MS_WEBHOOK_SECRET) {
      throw new Error("MS_WEBHOOK_SECRET not configured");
    }
    const token = await this.token();
    const workerUrl = this.env.WORKER_URL?.replace(/\/$/, "") || "";
    const notificationUrl = `${workerUrl}/api/outlook/push?secret=${this.env.MS_WEBHOOK_SECRET}`;

    const expiration = new Date(
      Date.now() + MS_SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1000,
    ).toISOString();

    const ttl = MS_SUBSCRIPTION_LIFETIME_MINUTES * 60;

    const existingSubId = await getMsSubscriptionId(
      this.env.EMAIL_KV,
      this.account.id,
    );

    if (existingSubId) {
      try {
        const resp = await http.patch(
          `${MS_GRAPH_API}/subscriptions/${existingSubId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            json: { expirationDateTime: expiration },
            throwHttpErrors: false,
          },
        );
        if (resp.ok) {
          await refreshMsSubAccountMapping(
            this.env.EMAIL_KV,
            existingSubId,
            this.account.id,
            ttl,
          );
          console.log(`Outlook subscription renewed for ${this.account.email}`);
          return;
        }
      } catch {
        // 续订失败，创建新的
      }
    }

    let sub: { id: string };
    try {
      sub = (await http
        .post(`${MS_GRAPH_API}/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
          json: {
            changeType: "created",
            notificationUrl,
            resource: "me/mailFolders('Inbox')/messages",
            expirationDateTime: expiration,
            clientState: this.env.MS_WEBHOOK_SECRET,
          },
        })
        .json()) as { id: string };
    } catch (err) {
      if (err instanceof HTTPError) {
        const text = await err.response.text();
        throw new Error(
          `Failed to create Graph subscription for ${this.account.email}: ${err.response.status} ${text}`,
        );
      }
      throw err;
    }
    await putMsSubscription(this.env.EMAIL_KV, this.account.id, sub.id, ttl);
    console.log(
      `Outlook subscription created for ${this.account.email}, id=${sub.id}`,
    );
  }

  async stopPush() {
    const token = await this.token();
    const subId = await getMsSubscriptionId(this.env.EMAIL_KV, this.account.id);
    if (!subId) return;

    try {
      await http.delete(`${MS_GRAPH_API}/subscriptions/${subId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // 删除失败不影响主流程
    }
    await deleteMsSubscription(this.env.EMAIL_KV, this.account.id);
    console.log(`Outlook subscription stopped for ${this.account.email}`);
  }

  // ─── Message actions ──────────────────────────────────────────────────

  async markAsRead(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      isRead: true,
    });
  }

  async addStar(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      flag: { flagStatus: "flagged" },
    });
  }

  async removeStar(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      flag: { flagStatus: "notFlagged" },
    });
  }

  async isStarred(messageId: string) {
    const msg = await graphGet<GraphMessage>(
      await this.token(),
      `/me/messages/${messageId}?$select=flag`,
    );
    return msg.flag?.flagStatus === "flagged";
  }

  async isJunk(messageId: string) {
    const token = await this.token();
    const msg = await graphGet<GraphMessage>(
      token,
      `/me/messages/${messageId}?$select=parentFolderId`,
    );
    if (!msg.parentFolderId) return false;
    const junkFolder = await graphGet<GraphFolder>(
      token,
      `/me/mailFolders('JunkEmail')?$select=id`,
    );
    return msg.parentFolderId === junkFolder.id;
  }

  async listUnread(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/mailFolders('Inbox')/messages?$filter=isRead eq false&$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async listStarred(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async listJunk(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/mailFolders('JunkEmail')/messages?$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async markAsJunk(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "JunkEmail",
    });
  }

  async moveToInbox(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "Inbox",
    });
  }

  async trashMessage(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "DeletedItems",
    });
  }

  async trashAllJunk() {
    const token = await this.token();
    const data = await graphGet<GraphMessageList>(
      token,
      `/me/mailFolders('JunkEmail')/messages?$select=id&$top=100`,
    );
    if (!data.value || data.value.length === 0) return 0;
    const ids = data.value.map((m) => m.id);
    await Promise.all(
      ids.map((id) =>
        graphPost(token, `/me/messages/${id}/move`, {
          destinationId: "DeletedItems",
        }),
      ),
    );
    return ids.length;
  }
}
