import { authMiniApp } from "@worker/api/plugins/auth-miniapp";
import { cf } from "@worker/api/plugins/cf";
import { getCachedMailList, putCachedMailList } from "@worker/db/kv";
import {
  getMailList,
  isMailListType,
  searchMail,
} from "@worker/utils/mail-list";
import {
  markAllAsRead,
  trashAllJunkEmails,
} from "@worker/utils/message-actions";
import { Elysia, type UnwrapSchema } from "elysia";
import {
  ListParams,
  ListQuery,
  type MailListResponse,
  SearchQuery,
} from "./model";

/**
 * Mini App 通用 API:
 *  - GET  /api/mini-app/list/:type      list (unread/starred/junk/archived)
 *  - POST /api/mini-app/mark-all-as-read
 *  - POST /api/mini-app/trash-all-junk
 *  - GET  /api/mini-app/search?q=...
 *
 * 鉴权统一走 X-Telegram-Init-Data（authMiniApp）。
 */
export const miniAppController = new Elysia({ name: "controller.miniapp" })
  .use(cf)
  .use(authMiniApp)

  .get(
    "/api/mini-app/list/:type",
    async ({ env, executionCtx, userId, params, query, status }) => {
      const type = params.type;
      if (!isMailListType(type))
        return status(400, { error: "Unknown list type" });

      const useCache = query.cache === "true";
      if (useCache) {
        const cached = await getCachedMailList(env.EMAIL_KV, userId, type);
        if (cached) {
          return JSON.parse(cached) as UnwrapSchema<typeof MailListResponse>;
        }
      }

      const result = await getMailList(env, userId, type);
      if (result.pendingSideEffects.length > 0) {
        executionCtx.waitUntil(
          Promise.allSettled(result.pendingSideEffects.map((t) => t())),
        );
      }
      const payload = {
        type: result.type,
        results: result.results,
        total: result.total,
      };
      executionCtx.waitUntil(
        putCachedMailList(
          env.EMAIL_KV,
          userId,
          type,
          JSON.stringify(payload),
        ).catch(() => {}),
      );
      return payload;
    },
    { params: ListParams, query: ListQuery },
  )

  .post("/api/mini-app/mark-all-as-read", async ({ env, userId }) => {
    return await markAllAsRead(env, userId);
  })

  .post("/api/mini-app/trash-all-junk", async ({ env, userId }) => {
    return await trashAllJunkEmails(env, userId);
  })

  .get(
    "/api/mini-app/search",
    async ({ env, userId, query, status }) => {
      const q = (query.q ?? "").trim();
      if (!q) return status(400, { error: "缺少搜索关键词" });
      if (q.length > 200) return status(400, { error: "关键词过长" });
      return await searchMail(env, userId, q);
    },
    { query: SearchQuery },
  );
