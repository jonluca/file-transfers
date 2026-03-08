import { entitlementsRouter } from "./routers/entitlements";
import { healthRouter } from "./routers/health";
import { hostedFilesRouter } from "./routers/hosted-files";
import { router } from "./trpc";

export const appRouter = router({
  entitlements: entitlementsRouter,
  health: healthRouter,
  hostedFiles: hostedFilesRouter,
});

export type AppRouter = typeof appRouter;
