import { t, type UnwrapSchema } from "elysia";

export const LoginCallbackQuery = t.Object({
  id: t.Optional(t.String()),
  first_name: t.Optional(t.String()),
  last_name: t.Optional(t.String()),
  username: t.Optional(t.String()),
  photo_url: t.Optional(t.String()),
  auth_date: t.Optional(t.String()),
  hash: t.Optional(t.String()),
  return_to: t.Optional(t.String()),
});

const WhoamiResponse = t.Object({
  telegramId: t.String(),
  isAdmin: t.Boolean(),
  firstName: t.String(),
  username: t.Union([t.String(), t.Null()]),
});
export type WhoamiResponse = UnwrapSchema<typeof WhoamiResponse>;
