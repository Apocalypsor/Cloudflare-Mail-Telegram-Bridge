import { getOwnAccounts } from "@worker/db/accounts";
import {
  getMappingsByEmailIds,
  type MessageMapping,
} from "@worker/db/message-map";
import {
  type EmailListItem,
  type EmailProvider,
  getEmailProvider,
} from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { generateMailTokenById } from "@worker/utils/mail-token";
import {
  deleteJunkMappings,
  syncStarButtonsForMappings,
} from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";

const MAIL_LIST_TYPES = ["unread", "starred", "junk", "archived"] as const;
export type MailListType = (typeof MAIL_LIST_TYPES)[number];

const MAX_PER_ACCOUNT = 20;

export function isMailListType(s: string): s is MailListType {
  return (MAIL_LIST_TYPES as readonly string[]).includes(s);
}

interface MailListEmailItem {
  /** Provider 原生邮件 id：Gmail messageId / Outlook Graph id / IMAP RFC 822 Message-Id */
  id: string;
  /** 显示标题：优先 LLM short_summary，回退邮件 subject */
  title: string | null;
  /** mail-preview / mini app mail page 的 HMAC token */
  token: string;
  /** TG 消息位置（junk/archive 列表里被隐藏，因为 TG 消息可能已被删） */
  tgChatId?: string;
  tgMessageId?: number;
  /** 发件人（仅 search 列表填充，给前端在 subject 缺失时也能展示来源） */
  from?: string;
}

interface MailListAccountResult {
  accountId: number;
  accountEmail: string | null;
  items: MailListEmailItem[];
  total: number;
  /** provider 调用失败时的错误信息 */
  error?: string;
}

export interface MailListResult {
  type: MailListType;
  results: MailListAccountResult[];
  total: number;
  /** 列表查询时顺手做的副作用（如 starred 同步星标按钮、junk 清理 mapping）。
   *  caller 应通过 ctx.waitUntil 在响应后台跑。 */
  pendingSideEffects: (() => Promise<void>)[];
}

interface ListDef {
  fetcher: (p: EmailProvider) => Promise<EmailListItem[]>;
  errorEvent: string;
  /** junk/archive 列表：TG 消息可能已被删除，不返回 tgLink */
  hideTgLinks?: boolean;
  /** preview URL 需要带 folder 提示给 IMAP 定位 UID（per-folder） */
  previewFolder?: "inbox" | "junk" | "archive";
  /** 列出后的副作用 —— starred: 同步键盘；junk: 清 mapping；其余无 */
  afterMappings?: (
    env: Env,
    mappings: MessageMapping[],
    account: Account,
  ) => Promise<void>;
}

const LIST_DEFS: Record<MailListType, ListDef> = {
  unread: {
    fetcher: (p) => p.listUnread(MAX_PER_ACCOUNT),
    errorEvent: "bot.unread_query_failed",
  },
  starred: {
    fetcher: (p) => p.listStarred(MAX_PER_ACCOUNT),
    errorEvent: "bot.starred_query_failed",
    afterMappings: (env, mappings, account) =>
      syncStarButtonsForMappings(env, mappings, account),
  },
  junk: {
    fetcher: (p) => p.listJunk(MAX_PER_ACCOUNT),
    errorEvent: "bot.junk_query_failed",
    hideTgLinks: true,
    previewFolder: "junk",
    afterMappings: (env, mappings) => deleteJunkMappings(env, mappings),
  },
  archived: {
    fetcher: (p) => p.listArchived(MAX_PER_ACCOUNT),
    errorEvent: "bot.archived_query_failed",
    hideTgLinks: true,
    previewFolder: "archive",
  },
};

export function getPreviewFolder(
  type: MailListType,
): "inbox" | "junk" | "archive" | undefined {
  return LIST_DEFS[type].previewFolder;
}

/**
 * 跨该用户所有启用账号搜索邮件（Mini App 🔍 入口）。结果形状跟 `MailListResult`
 * 几乎一致，但没有副作用（搜索是只读的，不需要 sync star / 清 mapping）。
 * 命中 TG 已投递过的邮件会带 tgChatId/tgMessageId（前端可链接回 TG 消息）；
 * junk/archive 里的命中或没投递过的没有 mapping，链接字段缺省即可。
 */
interface MailSearchResult {
  query: string;
  results: MailListAccountResult[];
  total: number;
}

export async function searchMail(
  env: Env,
  userId: string,
  query: string,
): Promise<MailSearchResult> {
  const trimmed = query.trim();
  const accounts = (await getOwnAccounts(env.DB, userId)).filter(
    (a) => !a.disabled,
  );

  const results: MailListAccountResult[] = await Promise.all(
    accounts.map(async (account): Promise<MailListAccountResult> => {
      try {
        const provider = getEmailProvider(account, env);
        const msgs = await provider.searchMessages(trimmed, MAX_PER_ACCOUNT);
        if (msgs.length === 0)
          return {
            accountId: account.id,
            accountEmail: account.email,
            items: [],
            total: 0,
          };

        const mappings = await getMappingsByEmailIds(
          env.DB,
          account.id,
          msgs.map((m) => m.id),
        );
        const mappingMap = new Map(
          mappings.map((m) => [m.email_message_id, m]),
        );

        const items: MailListEmailItem[] = await Promise.all(
          msgs.map(async (msg) => {
            const mapping = mappingMap.get(msg.id);
            return {
              id: msg.id,
              title: mapping?.short_summary || msg.subject || null,
              token: await generateMailTokenById(
                env.ADMIN_SECRET,
                msg.id,
                account.id,
              ),
              tgChatId: mapping?.tg_chat_id,
              tgMessageId: mapping?.tg_message_id,
              from: msg.from,
            };
          }),
        );

        return {
          accountId: account.id,
          accountEmail: account.email,
          items,
          total: msgs.length,
        };
      } catch (err) {
        await reportErrorToObservability(env, "bot.search_failed", err, {
          accountId: account.id,
        });
        return {
          accountId: account.id,
          accountEmail: account.email,
          items: [],
          total: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const total = results.reduce((sum, r) => sum + r.total, 0);
  return { query: trimmed, results, total };
}

/** 拉取 user 所有启用账号的邮件列表 + 生成共享访问 token + 收集副作用 */
export async function getMailList(
  env: Env,
  userId: string,
  type: MailListType,
): Promise<MailListResult> {
  const def = LIST_DEFS[type];
  const accounts = (await getOwnAccounts(env.DB, userId)).filter(
    (a) => !a.disabled,
  );

  const pendingSideEffects: (() => Promise<void>)[] = [];

  const results: MailListAccountResult[] = await Promise.all(
    accounts.map(async (account): Promise<MailListAccountResult> => {
      try {
        const provider = getEmailProvider(account, env);
        const msgs = await def.fetcher(provider);
        if (msgs.length === 0)
          return {
            accountId: account.id,
            accountEmail: account.email,
            items: [],
            total: 0,
          };

        const mappings = await getMappingsByEmailIds(
          env.DB,
          account.id,
          msgs.map((m) => m.id),
        );
        const mappingMap = new Map(
          mappings.map((m) => [m.email_message_id, m]),
        );

        const items: MailListEmailItem[] = await Promise.all(
          msgs.map(async (msg) => {
            const mapping = mappingMap.get(msg.id);
            return {
              id: msg.id,
              title: mapping?.short_summary || msg.subject || null,
              token: await generateMailTokenById(
                env.ADMIN_SECRET,
                msg.id,
                account.id,
              ),
              tgChatId: !def.hideTgLinks ? mapping?.tg_chat_id : undefined,
              tgMessageId: !def.hideTgLinks
                ? mapping?.tg_message_id
                : undefined,
            };
          }),
        );

        if (def.afterMappings && mappings.length > 0) {
          const _mappings = mappings;
          const _account = account;
          const _after = def.afterMappings;
          pendingSideEffects.push(() => _after(env, _mappings, _account));
        }

        return {
          accountId: account.id,
          accountEmail: account.email,
          items,
          total: msgs.length,
        };
      } catch (err) {
        await reportErrorToObservability(env, def.errorEvent, err, {
          accountId: account.id,
        });
        return {
          accountId: account.id,
          accountEmail: account.email,
          items: [],
          total: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const total = results.reduce((sum, r) => sum + r.total, 0);
  return { type, results, total, pendingSideEffects };
}
