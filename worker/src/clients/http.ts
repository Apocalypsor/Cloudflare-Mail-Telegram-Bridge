import ky from "ky";

/** 全局 HTTP 客户端，使用 ky 默认 retry（limit 2，自动处理 429 等） */
export const http = ky.create({});
