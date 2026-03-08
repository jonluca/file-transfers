import { publicProcedure, router } from "../trpc";

export const healthRouter = router({
  ping: publicProcedure.query(() => ({
    service: "file-transfers",
    status: "ok" as const,
    serverTime: new Date().toISOString(),
  })),
});
