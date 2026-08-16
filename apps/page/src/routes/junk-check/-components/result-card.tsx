import { Chip } from "@heroui/react";

/** 垃圾邮件检测结果卡：左侧圆形 SVG 弧度 gauge 显示置信度（mount 时 stroke
 *  绕一圈展开动画），右侧大字号百分比 + 标签。整卡按 isJunk 走 emerald / red
 *  双色调。 */
export const ResultCard = ({
  result,
}: {
  result: {
    isJunk: boolean;
    junkConfidence: number;
    summary: string;
    tags: string[];
  };
}) => {
  const pct = Math.max(
    0,
    Math.min(100, Math.round(result.junkConfidence * 100)),
  );
  const isJunk = result.isJunk;

  // 圆环参数：r=42, 周长 ≈ 263.9。stroke-dashoffset 从 263.9 → 263.9*(1-pct/100)。
  const RADIUS = 42;
  const CIRC = 2 * Math.PI * RADIUS;
  const finalOffset = CIRC * (1 - pct / 100);

  return (
    <div
      className={`overflow-hidden rounded-2xl border ${
        isJunk
          ? "border-red-900/60 bg-linear-to-br from-red-950/40 via-red-950/20 to-zinc-950/60"
          : "border-emerald-900/60 bg-linear-to-br from-emerald-950/40 via-emerald-950/20 to-zinc-950/60"
      }`}
    >
      {/* gauge + numerical */}
      <div className="px-6 py-6 flex items-center gap-5">
        <Gauge
          pct={pct}
          finalOffset={finalOffset}
          circumference={CIRC}
          radius={RADIUS}
          isJunk={isJunk}
        />

        <div className="flex-1 min-w-0">
          <div
            className={`text-[11px] font-medium tracking-[0.18em] uppercase ${
              isJunk ? "text-red-300/80" : "text-emerald-300/80"
            }`}
          >
            {isJunk ? "Junk Detected" : "Looks Clean"}
          </div>
          <div
            className={`mt-1 text-2xl sm:text-3xl font-semibold tracking-tight ${
              isJunk ? "text-red-200" : "text-emerald-200"
            }`}
          >
            {isJunk ? "垃圾邮件" : "正常邮件"}
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            判断置信度{" "}
            <span className="tabular-nums text-zinc-300">{pct}%</span>
          </div>
        </div>
      </div>

      {(result.tags.length > 0 || result.summary) && (
        <div className="border-t border-zinc-800/60 px-6 py-5 space-y-3 bg-zinc-950/40 backdrop-blur-sm">
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
    </div>
  );
};

const Gauge = ({
  pct,
  finalOffset,
  circumference,
  radius,
  isJunk,
}: {
  pct: number;
  finalOffset: number;
  circumference: number;
  radius: number;
  isJunk: boolean;
}) => {
  // 100×100 viewBox 居中圆环。背景轨道 + 前景 stroke。前景 stroke 走 CSS
  // keyframe 从满 dashoffset (= circumference, 即 0%) 滚动到目标 offset
  // (即 pct%)。`--final-offset` 由 React 注入，keyframe 引用它，pct 一变
  // 动画 re-runs。
  const stroke = isJunk ? "rgb(248,113,113)" : "rgb(52,211,153)"; // red-400 / emerald-400
  return (
    <div className="relative w-24 h-24 shrink-0">
      <svg
        viewBox="0 0 100 100"
        className="w-full h-full -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
        />
        <circle
          key={pct}
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={finalOffset}
          style={{
            // 起点 dashoffset = circumference (空)，终点 = finalOffset
            // CSS keyframe 直接用 inline custom property
            ["--final-offset" as string]: String(finalOffset),
            ["--circumference" as string]: String(circumference),
            animation: "gauge-arc 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={`text-2xl font-semibold tabular-nums ${
            isJunk ? "text-red-200" : "text-emerald-200"
          }`}
        >
          {pct}
        </span>
        <span className="text-[9px] tracking-widest text-zinc-500 uppercase mt-0.5">
          %
        </span>
      </div>
    </div>
  );
};
