import { Spinner } from "@heroui/react";
import { INPUT_CLASS } from "@page/styles/inputs";
import { PRESETS } from "../-utils/presets";
import { DEVICE_TZ_VALUE, TZ_GROUPS } from "../-utils/tz";

/** "新建提醒" 表单：日期/时间 + 时区下拉 + 快捷 preset + 备注 + 保存。
 *  纯展示组件，状态由 caller 管。成功 / 失败提示渲染在 page 级 banner，不在这里。 */
export function ReminderAddSection({
  date,
  time,
  text,
  minDate,
  timezone,
  tzLabel,
  activePreset,
  saving,
  onDateChange,
  onTimeChange,
  onTextChange,
  onTimezoneChange,
  onPreset,
  onSave,
}: {
  date: string;
  time: string;
  text: string;
  minDate: string;
  /** 下拉框当前 value（"device" 或 IANA 名） */
  timezone: string;
  /** 实际生效的 IANA 名 —— 提示文案显示用 */
  tzLabel: string;
  activePreset: number | null;
  saving: boolean;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  onTextChange: (v: string) => void;
  onTimezoneChange: (v: string) => void;
  onPreset: (idx: number) => void;
  onSave: () => void;
}) {
  const inputClass = `text-[15px] ${INPUT_CLASS}`;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
      <div>
        <label
          htmlFor="when-date"
          className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
        >
          提醒时间
        </label>
        <div className="flex gap-2">
          <input
            id="when-date"
            type="date"
            value={date}
            min={minDate}
            onChange={(e) => onDateChange(e.target.value)}
            className={`flex-1 min-w-0 ${inputClass}`}
          />
          <input
            type="time"
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className={`flex-[0_0_38%] min-w-0 ${inputClass}`}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="when-tz"
          className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
        >
          时区
        </label>
        <select
          id="when-tz"
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          className={`w-full ${inputClass} appearance-none cursor-pointer`}
        >
          <option value={DEVICE_TZ_VALUE}>设备本地（{tzLabel}）</option>
          {TZ_GROUPS.map((g) => (
            <optgroup key={g.region} label={g.region}>
              {g.items.map((it) => (
                <option key={it.value} value={it.value}>
                  {it.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p, i) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onPreset(i)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors border ${
              activePreset === i
                ? "bg-emerald-500 border-emerald-500 text-emerald-950"
                : "bg-zinc-800 border-zinc-700 text-zinc-100 hover:bg-zinc-700"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div>
        <label
          htmlFor="remind-text"
          className="block text-xs font-medium tracking-wide text-zinc-400 uppercase mb-2"
        >
          备注（可选）
        </label>
        <textarea
          id="remind-text"
          maxLength={1000}
          placeholder="可留空 —— 不填只发送邮件主题和链接"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          autoCorrect="off"
          autoCapitalize="off"
          className={`w-full min-h-[80px] resize-y ${inputClass}`}
        />
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="w-full px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 text-sm font-semibold transition-[colors,transform] duration-100 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center"
      >
        {saving ? <Spinner size="sm" /> : "保存提醒"}
      </button>

      <div className="text-xs text-zinc-500">
        时间按 <span className="text-zinc-300">{tzLabel}</span> 解释
      </div>
    </div>
  );
}
