export class EmailMessageNotFoundError extends Error {
  readonly folder: string;
  readonly messageId: string;

  constructor(messageId: string, folder: string, cause?: unknown) {
    super(`Message-Id not found in ${folder}: ${messageId}`, { cause });
    this.name = "EmailMessageNotFoundError";
    this.folder = folder;
    this.messageId = messageId;
  }
}
