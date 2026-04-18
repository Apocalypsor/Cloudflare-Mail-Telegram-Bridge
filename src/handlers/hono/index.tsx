import { FAVICON_BASE64 } from "@assets/favicon";
import auth from "@handlers/hono/auth";
import gmailPush from "@handlers/hono/email/gmail/push";
import imapRoutes from "@handlers/hono/email/imap/index";
import oauth from "@handlers/hono/email/oauth";
import outlookPush from "@handlers/hono/email/outlook/push";
import preview from "@handlers/hono/preview";
import telegram from "@handlers/hono/telegram";
import { reportErrorToObservability } from "@utils/observability";
import { Hono } from "hono";
import type { AppEnv } from "@/types";

const app = new Hono<AppEnv>();

// ─── Favicon ─────────────────────────────────────────────────────────────────
const faviconBuf = Uint8Array.from(atob(FAVICON_BASE64), (c) =>
  c.charCodeAt(0),
);
app.get("/favicon.png", (c) => {
  return c.body(faviconBuf, 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=604800, immutable",
  });
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.onError(async (error, c) => {
  await reportErrorToObservability(c.env, "http.unhandled_error", error, {
    method: c.req.method,
    pathname: new URL(c.req.url).pathname,
  });
  return c.text("Internal Server Error", 500);
});

// ─── Mount sub-routers ──────────────────────────────────────────────────────
app.route("", auth);
app.route("", telegram);
app.route("", gmailPush);
app.route("", outlookPush);
app.route("", oauth);
app.route("", imapRoutes);
app.route("", preview);

export default app;
