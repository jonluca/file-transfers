import { eq } from "drizzle-orm";
import { z } from "zod";
import { subscriptionMembership } from "../../db/schema";
import { protectedProcedure, publicProcedure, router } from "../trpc";

function mapMembership(value: typeof subscriptionMembership.$inferSelect | undefined | null, isAuthenticated: boolean) {
  const now = new Date();
  const isPremium = Boolean(value?.isPremium && (!value.expiresAt || value.expiresAt > now));

  return {
    isAuthenticated,
    isPremium,
    source: (value?.source ?? (isAuthenticated ? "client_sync" : "anonymous")) as
      | "anonymous"
      | "preview"
      | "client_sync"
      | "webhook",
    managementUrl: value?.managementUrl ?? null,
    expiresAt: value?.expiresAt?.toISOString() ?? null,
  };
}

export const entitlementsRouter = router({
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.session?.user) {
      return mapMembership(null, false);
    }

    const membership = await ctx.db.query.subscriptionMembership.findFirst({
      where: eq(subscriptionMembership.userId, ctx.session.user.id),
    });

    return mapMembership(membership, true);
  }),
  syncPurchase: protectedProcedure
    .input(
      z.object({
        appUserId: z.string().min(1),
        isPremium: z.boolean(),
        source: z.enum(["preview", "client_sync"]).default("client_sync"),
        managementUrl: z.string().url().nullable(),
        expiresAt: z.string().datetime().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

      const [membership] = await ctx.db
        .insert(subscriptionMembership)
        .values({
          userId: ctx.session.user.id,
          appUserId: input.appUserId,
          isPremium: input.isPremium,
          source: input.source,
          managementUrl: input.managementUrl,
          expiresAt,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: subscriptionMembership.userId,
          set: {
            appUserId: input.appUserId,
            isPremium: input.isPremium,
            source: input.source,
            managementUrl: input.managementUrl,
            expiresAt,
            lastSyncedAt: now,
            updatedAt: now,
          },
        })
        .returning();

      return mapMembership(membership, true);
    }),
});
