import type { Attachment } from "@worker/types";

export const attachmentToBlob = (attachment: Attachment): Blob => {
  const mime = attachment.mimeType || "application/octet-stream";
  const part =
    typeof attachment.content === "string"
      ? new TextEncoder().encode(attachment.content)
      : attachment.content;
  return new Blob([part as unknown as ArrayBuffer], { type: mime });
};
