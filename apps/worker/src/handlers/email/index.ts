import { getImapAccountByForwardToken } from "@worker/db/accounts";
import { ImapProvider } from "@worker/providers/imap";
import type { Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import { extractForwardToken } from "./utils";

const emailHandler = async (
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  const token = extractForwardToken(message.to);
  if (!token) {
    message.setReject("Unknown recipient");
    return;
  }

  const account = await getImapAccountByForwardToken(env.DB, token);
  if (!account || account.disabled) {
    message.setReject("Unknown recipient");
    return;
  }

  const rfcMessageId = message.headers.get("message-id")?.trim();
  if (!rfcMessageId) {
    message.setReject("Missing Message-ID");
    return;
  }

  ctx.waitUntil(
    ImapProvider.dispatch(
      { accountId: account.id, rfcMessageId },
      env,
      ctx.waitUntil.bind(ctx),
    ).catch((err) =>
      reportErrorToObservability(
        env,
        "email.imap_forward_dispatch_failed",
        err,
        {
          accountId: account.id,
          recipient: message.to,
          rfcMessageId,
        },
      ),
    ),
  );
};

export default emailHandler;
