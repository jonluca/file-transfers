import { serve } from "@hono/node-server";
import app from "./app";
import { serverEnv } from "./env";

serve(
  {
    fetch: app.fetch,
    port: serverEnv.port,
  },
  (info) => {
    console.info(`Mobile Boilerplate backend listening on http://127.0.0.1:${info.port}`);
  },
);
