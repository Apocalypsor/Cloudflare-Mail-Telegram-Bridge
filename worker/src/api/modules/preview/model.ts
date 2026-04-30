import { t } from "elysia";

export const PreviewBody = t.Object({
  html: t.Optional(t.String()),
});

export const JunkCheckBody = t.Object({
  subject: t.Optional(t.String()),
  body: t.Optional(t.String()),
});

export const ProxyQuery = t.Object({
  url: t.String(),
  sig: t.String(),
});
