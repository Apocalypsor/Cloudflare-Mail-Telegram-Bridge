import { t, type UnwrapSchema } from "elysia";

export const ListParams = t.Object({ type: t.String() });
export const ListQuery = t.Object({ cache: t.Optional(t.String()) });
export const SearchQuery = t.Object({ q: t.Optional(t.String()) });

export const MailListType = t.Union([
  t.Literal("unread"),
  t.Literal("starred"),
  t.Literal("junk"),
  t.Literal("archived"),
]);
export type MailListType = UnwrapSchema<typeof MailListType>;

export const MailListItem = t.Object({
  id: t.String(),
  title: t.Union([t.String(), t.Null()]),
  token: t.String(),
  tgChatId: t.Optional(t.String()),
  tgMessageId: t.Optional(t.Number()),
  from: t.Optional(t.String()),
});
export type MailListItem = UnwrapSchema<typeof MailListItem>;

export const MailListAccountResult = t.Object({
  accountId: t.Number(),
  accountEmail: t.Union([t.String(), t.Null()]),
  items: t.Array(MailListItem),
  total: t.Number(),
  error: t.Optional(t.String()),
});
export type MailListAccountResult = UnwrapSchema<typeof MailListAccountResult>;

export const MailListResponse = t.Object({
  type: MailListType,
  results: t.Array(MailListAccountResult),
  total: t.Number(),
});
