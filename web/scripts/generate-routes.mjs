// 多入口 bundle 需要两棵 routeTree —— 一棵给 web，一棵给 Mini App。
// `tsr` CLI 只认项目根目录下的单一 `tsr.config.json`，不支持用参数切换
// 目标目录，所以直接调底层 Generator 跑两次。
//
// Vite 构建时 `tanstackRouter()` 插件会同时生成两棵树，这个脚本只是给
// `pnpm typecheck`（tsc 不跑 vite 插件）做前置生成。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{ routesDirectory: string; generatedRouteTree: string }>} */
const entries = [
  {
    routesDirectory: "src/routes-web",
    generatedRouteTree: "src/routeTree.web.gen.ts",
  },
  {
    routesDirectory: "src/routes-miniapp",
    generatedRouteTree: "src/routeTree.miniapp.gen.ts",
  },
];

for (const entry of entries) {
  // getConfig 会把 routesDirectory / generatedRouteTree / tmpDir 等路径都
  // 解析成绝对路径，并填好 Generator 需要的 tmpDir 默认值。
  const config = getConfig(
    {
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: entry.routesDirectory,
      generatedRouteTree: entry.generatedRouteTree,
    },
    root,
  );
  await new Generator({ config, root }).run();
}
