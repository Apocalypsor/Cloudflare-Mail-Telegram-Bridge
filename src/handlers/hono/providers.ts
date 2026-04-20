import { PROVIDERS } from "@providers";
import { Hono } from "hono";
import type { AppEnv } from "@/types";

/**
 * 所有 provider 的 HTTP 路由挂载点：push webhook、bridge accounts 列表等。
 * 每个 provider class 在 static `registerRoutes` 里注册自己需要的路径和鉴权逻辑，
 * 这里只负责遍历 PROVIDERS 把它们拼起来。
 */
const providers = new Hono<AppEnv>();

for (const klass of Object.values(PROVIDERS)) {
  klass.registerRoutes?.(providers);
}

export default providers;
