import { healthRouter } from "./routers/health";
import { viewerRouter } from "./routers/viewer";
import { router } from "./trpc";

export const appRouter = router({
  health: healthRouter,
  viewer: viewerRouter,
});

export type AppRouter = typeof appRouter;
