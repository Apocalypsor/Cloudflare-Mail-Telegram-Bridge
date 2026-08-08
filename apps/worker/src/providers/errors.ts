import { HTTPError } from "ky";

export class EmailMessageNotFoundError extends Error {
  readonly folder: string;
  readonly messageId: string;

  constructor(messageId: string, folder: string) {
    super(`Message-Id not found in ${folder}: ${messageId}`);
    this.name = "EmailMessageNotFoundError";
    this.folder = folder;
    this.messageId = messageId;
  }
}

export const isEmailMessageNotFound = (error: unknown): boolean =>
  error instanceof EmailMessageNotFoundError ||
  (error instanceof HTTPError && error.response.status === 404);
