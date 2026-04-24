/**
 * 包一个 async function 使结果在 Worker isolate 生命周期内只算一次 ——
 * 后续调用直接返回同一份已 resolve 的 Promise，**参数被忽略**。
 *
 * 用途：KV 里存的 bot info / commands version 这种"isolate 生命周期内
 * 不会变"的值，每次 webhook 都读 KV 浪费配额；套这个 wrapper 之后每个
 * isolate 冷启动第一次 call 才去 KV，后续纯内存命中。
 *
 * **注意**：
 * 1. 参数在首次 call 之后都被忽略。适用于参数稳定的场景（Workers env 在
 *    isolate 内是 singleton，所以我们项目里的 `getBotInfo(env)` 这种
 *    call shape 是安全的）。如果参数会变化，别用这个。
 * 2. 如果首次 call reject 了，会把 cache 清掉，下一次 call 会重试 ——
 *    不希望把偶发的 KV / 网络错误永久粘住。
 * 3. memo 没 TTL，靠 isolate 自然销毁失效（Workers 空闲几分钟–几十分钟
 *    或 deploy 触发回收）。需要立即刷新就 deploy。
 */
export function memoizeAsync<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  let cached: Promise<TReturn> | null = null;
  return (...args: TArgs): Promise<TReturn> => {
    if (cached) return cached;
    cached = fn(...args).catch((err) => {
      cached = null;
      throw err;
    });
    return cached;
  };
}
