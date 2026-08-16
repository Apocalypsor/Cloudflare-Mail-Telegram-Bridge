import { api } from "@page/api/client";

type MailContentFolder = "inbox" | "junk" | "archive";

export type MailAccess =
  | { access: string; accountId?: never; token?: never }
  | { access?: never; accountId: number; token: string };

interface MailContentQueryBase {
  emailMessageId: string;
  folder?: MailContentFolder;
}

type MailContentQueryInput = MailContentQueryBase & MailAccess;

export const mailContentQueryOptions = (input: MailContentQueryInput) => {
  const { emailMessageId, folder } = input;
  const credentialKey = input.access ?? input.accountId;
  return {
    queryKey: ["mail-preview", emailMessageId, credentialKey, folder],
    queryFn: async () => {
      const { data, error } = await api.api.mail({ id: emailMessageId }).get({
        query:
          input.access !== undefined
            ? { access: input.access, folder }
            : {
                accountId: String(input.accountId),
                t: input.token,
                folder,
              },
      });
      if (error) throw error;
      return data;
    },
  };
};

export const buildMailAttachmentUrl = (
  input: MailContentQueryInput & { attachmentId: string },
): string => {
  const { emailMessageId, folder, attachmentId } = input;
  const params = new URLSearchParams({ attachmentId });
  if (input.access !== undefined) params.set("access", input.access);
  else {
    params.set("accountId", String(input.accountId));
    params.set("t", input.token);
  }
  if (folder) params.set("folder", folder);
  return `/api/mail/${encodeURIComponent(emailMessageId)}/attachment?${params.toString()}`;
};
