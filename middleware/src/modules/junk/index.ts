import { auth } from "@middleware/plugins/auth";
import { imap } from "@middleware/plugins/imap";
import { Elysia } from "elysia";
import { AccountBody, AccountMessageBody, ListBody } from "./model";

export const junkController = new Elysia({ name: "controller.junk" })
  .use(auth)
  .use(imap)

  .post(
    "/junk",
    async ({ body, imap }) => {
      const messages = await imap.listJunk(
        body.accountId,
        body.maxResults ?? 20,
      );
      return { messages };
    },
    { body: ListBody },
  )

  .post(
    "/is-junk",
    async ({ body, imap }) => {
      const junk = await imap.isJunk(body.accountId, body.rfcMessageId);
      return { junk };
    },
    { body: AccountMessageBody },
  )

  .post(
    "/mark-as-junk",
    async ({ body, imap }) => {
      await imap.markAsJunk(body.accountId, body.rfcMessageId);
      return { ok: true };
    },
    { body: AccountMessageBody },
  )

  .post(
    "/move-to-inbox",
    async ({ body, imap }) => {
      await imap.moveToInbox(body.accountId, body.rfcMessageId);
      return { ok: true };
    },
    { body: AccountMessageBody },
  )

  .post(
    "/trash",
    async ({ body, imap }) => {
      await imap.trashMessage(body.accountId, body.rfcMessageId);
      return { ok: true };
    },
    { body: AccountMessageBody },
  )

  .post(
    "/trash-all-junk",
    async ({ body, imap }) => {
      const count = await imap.trashAllJunk(body.accountId);
      return { count };
    },
    { body: AccountBody },
  );
