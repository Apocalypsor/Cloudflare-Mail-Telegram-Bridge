import { Hono } from "hono";
import type { AppEnv } from "@/types";
import { registerMailRoutes } from "./mail";
import { registerProxyRoutes } from "./proxy";
import { registerToolRoutes } from "./tools";

const preview = new Hono<AppEnv>();

registerToolRoutes(preview);
registerMailRoutes(preview);
registerProxyRoutes(preview);

export default preview;
