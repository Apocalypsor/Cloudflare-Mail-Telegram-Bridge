import { t } from "elysia";

export const WebhookBody = t.Unknown();

export const WebhookQuery = t.Object({
  secret: t.Optional(t.String()),
});
