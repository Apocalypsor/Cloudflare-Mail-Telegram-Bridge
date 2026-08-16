import { api } from "@page/api/client";

interface MailContentSearch {
  access?: string;
  accountId?: number;
  t?: string;
}

type NormalizedMailContentSearch<T extends MailContentSearch> = Omit<
  T,
  "accountId" | "t"
> & {
  accountId: number;
  t: string;
};

export type MailContentFolder = "inbox" | "junk" | "archive";

export interface MailContentQueryInput {
  emailMessageId: string;
  accountId: number;
  token: string;
  access?: string;
  folder?: MailContentFolder;
}

export const mailContentQueryOptions = ({
  emailMessageId,
  accountId,
  token,
  access,
  folder,
}: MailContentQueryInput) => {
  return {
    queryKey: ["mail-preview", emailMessageId, accountId, folder],
    queryFn: async () => {
      const { data, error } = await api.api.mail({ id: emailMessageId }).get({
        query:
          access !== undefined
            ? { access, folder }
            : { accountId: String(accountId), t: token, folder },
      });
      if (error) throw error;
      return data;
    },
  };
};

export const buildMailAttachmentUrl = ({
  emailMessageId,
  accountId,
  token,
  access,
  folder,
  attachmentId,
}: MailContentQueryInput & { attachmentId: string }): string => {
  const params = new URLSearchParams({ attachmentId });
  if (access !== undefined) params.set("access", access);
  else {
    params.set("accountId", String(accountId));
    params.set("t", token);
  }
  if (folder) params.set("folder", folder);
  return `/api/mail/${encodeURIComponent(emailMessageId)}/attachment?${params.toString()}`;
};

export const normalizeMailContentSearch = <T extends MailContentSearch>(
  search: T,
): NormalizedMailContentSearch<T> => {
  if (search.access !== undefined) {
    const credentials = parseMailPreviewAccess(search.access);
    if (!credentials) throw new Error("Invalid access");
    return {
      ...search,
      accountId: credentials.accountId,
      t: credentials.token,
    };
  }
  if (search.accountId !== undefined && search.t !== undefined) {
    return { ...search, accountId: search.accountId, t: search.t };
  }
  throw new Error("Missing mail access parameters");
};

const parseMailPreviewAccess = (
  access: string,
): { accountId: number; token: string } | null => {
  const separator = access.indexOf(".");
  if (separator <= 0 || separator !== access.lastIndexOf(".")) return null;

  const accountId = Number(access.slice(0, separator));
  const token = access.slice(separator + 1);
  if (!Number.isInteger(accountId) || accountId <= 0 || !token) return null;
  return { accountId, token };
};
