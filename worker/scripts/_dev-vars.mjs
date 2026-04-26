/**
 * 共享给本目录下其它 dev-* 脚本的 .dev.vars 解析器。
 * 不要在 worker 运行时代码里 import —— 仅 node 脚本用途。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const devVarsPath = resolve(scriptsDir, "..", ".dev.vars");

/**
 * 读取 worker/.dev.vars，按行解析成对象（剥外层引号、跳过 # 注释空行）。
 * 缺文件 / 缺指定 key 时打印 hint 并 process.exit(1)。
 */
export function loadDevVars(requiredKeys = []) {
  let raw;
  try {
    raw = readFileSync(devVarsPath, "utf8");
  } catch {
    console.error(
      `找不到 ${devVarsPath}\n请先创建 worker/.dev.vars，至少包含 ${requiredKeys.join(" / ") || "需要的 key"}。`,
    );
    process.exit(1);
  }

  const env = Object.fromEntries(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const eq = line.indexOf("=");
        if (eq === -1) return [line, ""];
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );

  const missing = requiredKeys.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`worker/.dev.vars 缺少: ${missing.join(", ")}`);
    process.exit(1);
  }

  return env;
}
