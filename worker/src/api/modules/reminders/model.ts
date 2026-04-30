import { t, type UnwrapSchema } from "elysia";

export const ReminderId = t.Object({ id: t.String() });

export const ResolveContextQuery = t.Object({
  start: t.Optional(t.String()),
});

export const EmailContextQuery = t.Object({
  accountId: t.Optional(t.String()),
  emailMessageId: t.Optional(t.String()),
  token: t.Optional(t.String()),
});

export const ListQuery = t.Object({
  accountId: t.Optional(t.String()),
  emailMessageId: t.Optional(t.String()),
  token: t.Optional(t.String()),
});

export const CreateBody = t.Object({
  text: t.Optional(t.String()),
  remind_at: t.Optional(t.String()),
  accountId: t.Optional(t.Number()),
  emailMessageId: t.Optional(t.String()),
  token: t.Optional(t.String()),
});

export const UpdateBody = t.Object({
  text: t.Optional(t.String()),
  remind_at: t.Optional(t.String()),
});

/** Reminder 行（含 enrich 字段：mail_token / email_summary 仅 list 接口填）。 */
export const Reminder = t.Object({
  id: t.Number(),
  telegram_user_id: t.String(),
  text: t.String(),
  remind_at: t.String(),
  account_id: t.Union([t.Number(), t.Null()]),
  email_message_id: t.Union([t.String(), t.Null()]),
  email_subject: t.Union([t.String(), t.Null()]),
  tg_chat_id: t.Union([t.String(), t.Null()]),
  tg_message_id: t.Union([t.Number(), t.Null()]),
  sent_at: t.Union([t.String(), t.Null()]),
  created_at: t.String(),
  mail_token: t.Optional(t.Union([t.String(), t.Null()])),
  email_summary: t.Optional(t.Union([t.String(), t.Null()])),
});
export type Reminder = UnwrapSchema<typeof Reminder>;
