import { Card, Chip } from "@heroui/react";

/** 垃圾邮件检测结果卡：图标 + 置信度条 + 标签 + 摘要。
 *  isJunk 决定整体红 / 绿配色。 */
export function ResultCard({
  result,
}: {
  result: {
    isJunk: boolean;
    junkConfidence: number;
    summary: string;
    tags: string[];
  };
}) {
  const pct = Math.round(result.junkConfidence * 100);
  const isJunk = result.isJunk;

  return (
    <Card
      className={`overflow-hidden ${
        isJunk
          ? "bg-red-950/20 border border-red-900/60"
          : "bg-emerald-950/20 border border-emerald-900/60"
      }`}
    >
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center justify-center w-10 h-10 rounded-full text-xl ${
              isJunk ? "bg-red-500/20" : "bg-emerald-500/20"
            }`}
          >
            {isJunk ? "🚫" : "✅"}
          </span>
          <div>
            <div
              className={`text-lg font-semibold ${
                isJunk ? "text-red-300" : "text-emerald-300"
              }`}
            >
              {isJunk ? "垃圾邮件" : "正常邮件"}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              判断置信度 {pct}%
            </div>
          </div>
        </div>
      </div>

      {/* confidence bar —— HeroUI Progress 样式化成本比纯 div 高，直接画 */}
      <div className="px-5 pb-3">
        <div className="h-1.5 rounded-full bg-zinc-900 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isJunk ? "bg-red-500" : "bg-emerald-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {(result.tags.length > 0 || result.summary) && (
        <div className="border-t border-zinc-800/60 px-5 py-4 space-y-3 bg-zinc-950/30">
          {result.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.tags.map((tag) => (
                <Chip
                  key={tag}
                  size="sm"
                  className="bg-zinc-800 border border-zinc-700 text-zinc-300"
                >
                  {tag}
                </Chip>
              ))}
            </div>
          )}
          {result.summary && (
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {result.summary}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
