import { t } from "elysia";

export const OAuthParams = t.Object({ provider: t.String() });

export const OAuthAccountQuery = t.Object({
  account: t.Optional(t.String()),
});
