import { t, type UnwrapSchema } from "elysia";

export const MailGetQuery = t.Object({
  accountId: t.String(),
  t: t.String(),
  folder: t.Optional(
    t.Union([t.Literal("inbox"), t.Literal("junk"), t.Literal("archive")]),
  ),
});

export const MailParams = t.Object({ id: t.String() });

export const MailActionBody = t.Object({
  accountId: t.Number(),
  token: t.String(),
});
export type MailActionBody = UnwrapSchema<typeof MailActionBody>;

export const MailToggleStarBody = t.Composite([
  MailActionBody,
  t.Object({ starred: t.Boolean() }),
]);
export type MailToggleStarBody = UnwrapSchema<typeof MailToggleStarBody>;

const MailMetaResponse = t.Object({
  subject: t.Optional(t.Union([t.String(), t.Null()])),
  from: t.Optional(t.Union([t.String(), t.Null()])),
  to: t.Optional(t.Union([t.String(), t.Null()])),
  date: t.Optional(t.Union([t.String(), t.Null()])),
});

export const MailGetResponse = t.Object({
  meta: MailMetaResponse,
  accountEmail: t.Union([t.String(), t.Null()]),
  bodyHtml: t.String(),
  bodyHtmlRaw: t.String(),
  inJunk: t.Boolean(),
  inArchive: t.Boolean(),
  starred: t.Boolean(),
  canArchive: t.Boolean(),
  webMailUrl: t.String(),
  tgMessageLink: t.Union([t.String(), t.Null()]),
});
export type MailGetResponse = UnwrapSchema<typeof MailGetResponse>;
