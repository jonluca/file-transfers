import { publicProcedure, router } from "../trpc";

export const healthRouter = router({
  ping: publicProcedure.query(() => ({
    service: "mobile-boilerplate",
    status: "ok" as const,
    serverTime: new Date().toISOString(),
  })),
});
