import { t } from "elysia";

/** Push payloads 都是外部服务（Pub/Sub / Graph / IMAP bridge）发的，
 *  各自结构由 provider class 的 `enqueue` 静态方法解析；这里只走 unknown 透传。 */
export const PushBody = t.Unknown();

/** Outlook Graph subscription：先处理 `?validationToken=` 握手，再校验 `?secret=`。 */
export const OutlookPushQuery = t.Object({
  validationToken: t.Optional(t.String()),
  secret: t.Optional(t.String()),
});

/** IMAP bridge: GET /api/imap/accounts 返回的账号列表项（Eden 类型导出用）。 */
export const ImapAccountListItem = t.Object({
  id: t.Number(),
  email: t.Union([t.String(), t.Null()]),
  chat_id: t.String(),
  imap_host: t.Union([t.String(), t.Null()]),
  imap_port: t.Union([t.Number(), t.Null()]),
  imap_secure: t.Boolean(),
  imap_user: t.Union([t.String(), t.Null()]),
  imap_pass: t.Union([t.String(), t.Null()]),
});
