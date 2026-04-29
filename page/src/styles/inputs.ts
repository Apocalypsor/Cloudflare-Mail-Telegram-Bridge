/** 通用文本输入 / textarea / select 的 Tailwind class —— `<input>` `<textarea>`
 *  `<select>` 都用同一套（zinc-950 底 / zinc-800 边 / focus emerald 描边）。
 *  layout（w-full / flex-1 等）和字号（text-sm / text-[15px]）由 caller 加。
 *
 *  调样式只改这里一处；想覆盖某属性直接在 caller 端再写 class 后跟着，Tailwind
 *  按出现顺序合并，后写的赢。 */
export const INPUT_CLASS =
  "px-3 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 outline-none focus:border-emerald-500 placeholder:text-zinc-600 transition-colors";
