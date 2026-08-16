import { t, type UnwrapSchema } from "elysia";

export const MailGetQuery = t.Object({
  access: t.Optional(t.String()),
  accountId: t.Optional(t.String()),
  t: t.Optional(t.String()),
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
});

export const MailAttachmentQuery = t.Composite([
  MailGetQuery,
  t.Object({
    attachmentId: t.String(),
  }),
]);

export const MailParams = t.Object({ id: t.String() });

const MailAccessBody = t.Object({ access: t.String() });
const MailLegacyActionBody = t.Object({
  accountId: t.Number(),
  token: t.String(),
});
export const MailActionBody = t.Union([MailAccessBody, MailLegacyActionBody]);
export type MailActionBody = UnwrapSchema<typeof MailActionBody>;

const MailToggleStarFields = t.Object({
  starred: t.Boolean(),
  /** 调用方知道邮件当前 folder（preview 页 search.folder）就传，IMAP 用以选对
   *  mailbox 加 / 去 \Flagged；不传按 INBOX。Gmail / Outlook 忽略。 */
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
});
export const MailToggleStarBody = t.Union([
  t.Composite([MailAccessBody, MailToggleStarFields]),
  t.Composite([MailLegacyActionBody, MailToggleStarFields]),
]);

const MailMetaResponse = t.Object({
  subject: t.Optional(t.Union([t.String(), t.Null()])),
  from: t.Optional(t.Union([t.String(), t.Null()])),
  to: t.Optional(t.Union([t.String(), t.Null()])),
  date: t.Optional(t.Union([t.Date(), t.Null()])),
});

const MailAttachmentResponse = t.Object({
  id: t.String(),
  filename: t.Union([t.String(), t.Null()]),
  mimeType: t.Union([t.String(), t.Null()]),
  size: t.Union([t.Number(), t.Null()]),
});

export const MailGetResponse = t.Object({
  meta: MailMetaResponse,
  accountEmail: t.Union([t.String(), t.Null()]),
  bodyHtml: t.String(),
  bodyHtmlRaw: t.String(),
  attachments: t.Array(MailAttachmentResponse),
  folder: t.Union([
    t.Literal("inbox"),
    t.Literal("junk"),
    t.Literal("archive"),
  ]),
  inJunk: t.Boolean(),
  inArchive: t.Boolean(),
  starred: t.Boolean(),
  canArchive: t.Boolean(),
  webMailUrl: t.String(),
  tgMessageLink: t.Union([t.String(), t.Null()]),
});
export type MailGetResponse = UnwrapSchema<typeof MailGetResponse>;
