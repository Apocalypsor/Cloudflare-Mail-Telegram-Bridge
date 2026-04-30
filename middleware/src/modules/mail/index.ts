import { auth } from "@middleware/plugins/auth";
import { imap } from "@middleware/plugins/imap";
import { Elysia } from "elysia";
import {
  AccountBody,
  AccountMessageBody,
  ArchiveBody,
  FetchBody,
  FlagBody,
  ListBody,
  ListFolderBody,
  LocateBody,
  SearchBody,
  UnarchiveBody,
} from "./model";

export const mailController = new Elysia({ name: "controller.mail" })
  .use(auth)
  .use(imap)

  .post(
    "/flag",
    async ({ body, imap }) => {
      const ok = await imap.setFlag(
        body.accountId,
        body.rfcMessageId,
        body.flag,
        body.add,
      );
      return { ok };
    },
    { body: FlagBody },
  )

  .post(
    "/fetch",
    async ({ body, imap }) => {
      const rawEmail = await imap.fetchEmail(
        body.accountId,
        body.rfcMessageId,
        body.folder,
        body.archiveFolder,
      );
      return { rawEmail };
    },
    { body: FetchBody },
  )

  .post(
    "/unread",
    async ({ body, imap }) => {
      const messages = await imap.listUnread(
        body.accountId,
        body.maxResults ?? 20,
      );
      return { messages };
    },
    { body: ListBody },
  )

  .post(
    "/starred",
    async ({ body, imap }) => {
      const messages = await imap.listStarred(
        body.accountId,
        body.maxResults ?? 20,
      );
      return { messages };
    },
    { body: ListBody },
  )

  .post(
    "/is-starred",
    async ({ body, imap }) => {
      const starred = await imap.isStarred(body.accountId, body.rfcMessageId);
      return { starred };
    },
    { body: AccountMessageBody },
  )

  .post(
    "/list-folder",
    async ({ body, imap }) => {
      const messages = await imap.listFolder(
        body.accountId,
        body.folder,
        body.maxResults ?? 20,
      );
      return { messages };
    },
    { body: ListFolderBody },
  )

  .post(
    "/archive",
    async ({ body, imap }) => {
      await imap.archiveMessage(body.accountId, body.rfcMessageId, body.folder);
      return { ok: true };
    },
    { body: ArchiveBody },
  )

  .post(
    "/unarchive",
    async ({ body, imap }) => {
      await imap.unarchiveMessage(
        body.accountId,
        body.rfcMessageId,
        body.archiveFolder,
      );
      return { ok: true };
    },
    { body: UnarchiveBody },
  )

  .post(
    "/locate",
    async ({ body, imap }) => {
      return imap.locate(body.accountId, body.rfcMessageId, body.archiveFolder);
    },
    { body: LocateBody },
  )

  .post(
    "/search",
    async ({ body, imap }) => {
      const messages = await imap.searchMessages(
        body.accountId,
        body.query,
        body.maxResults ?? 20,
      );
      return { messages };
    },
    { body: SearchBody },
  )

  .post(
    "/mark-all-read",
    async ({ body, imap }) => imap.markAllAsRead(body.accountId),
    { body: AccountBody },
  );
