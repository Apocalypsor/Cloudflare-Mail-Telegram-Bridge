interface MailAttachmentItem {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export const MailAttachments = ({
  attachments,
  getDownloadUrl,
}: {
  attachments: MailAttachmentItem[];
  getDownloadUrl: (attachmentId: string) => string;
}) => {
  if (attachments.length === 0) return null;

  return (
    <section className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 text-sm font-semibold text-zinc-100">
        附件 ({attachments.length})
      </div>
      <ul className="divide-y divide-zinc-800">
        {attachments.map((att) => {
          const size = formatBytes(att.size);
          return (
            <a
              key={att.id}
              href={getDownloadUrl(att.id)}
              target="_blank"
              rel="noreferrer"
              className="px-4 py-3 flex items-start gap-3 text-sm hover:bg-zinc-800/60 active:bg-zinc-800 transition-colors"
            >
              <span className="mt-0.5 text-zinc-500" aria-hidden>
                📎
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-zinc-100 wrap-break-word">
                  {att.filename || "未命名附件"}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 wrap-break-word">
                  {[att.mimeType, size].filter(Boolean).join(" · ") ||
                    "未知类型"}
                </div>
              </div>
            </a>
          );
        })}
      </ul>
    </section>
  );
};

const formatBytes = (size: number | null): string | null => {
  if (size == null || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
};
