import { eq } from "drizzle-orm";
import { z } from "zod";
import { userProfile } from "../../db/schema";
import { protectedProcedure, router } from "../trpc";

const accentThemeSchema = z.enum(["blue", "green", "amber", "pink"]);

function normalizeOptionalField(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export const viewerRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const profile = await ctx.db.query.userProfile.findFirst({
      where: eq(userProfile.userId, ctx.session.user.id),
    });

    return {
      user: {
        id: ctx.session.user.id,
        email: ctx.session.user.email,
        name: ctx.session.user.name,
      },
      profile: {
        displayName: profile?.displayName ?? ctx.session.user.name ?? null,
        bio: profile?.bio ?? null,
        accentTheme: (profile?.accentTheme ?? "blue") as z.infer<typeof accentThemeSchema>,
        emailUpdatesEnabled: profile?.emailUpdatesEnabled ?? false,
      },
    };
  }),
  updateProfile: protectedProcedure
    .input(
      z.object({
        displayName: z.string().max(80).nullable(),
        bio: z.string().max(280).nullable(),
        accentTheme: accentThemeSchema,
        emailUpdatesEnabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      const [profile] = await ctx.db
        .insert(userProfile)
        .values({
          userId: ctx.session.user.id,
          displayName: normalizeOptionalField(input.displayName),
          bio: normalizeOptionalField(input.bio),
          accentTheme: input.accentTheme,
          emailUpdatesEnabled: input.emailUpdatesEnabled,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userProfile.userId,
          set: {
            displayName: normalizeOptionalField(input.displayName),
            bio: normalizeOptionalField(input.bio),
            accentTheme: input.accentTheme,
            emailUpdatesEnabled: input.emailUpdatesEnabled,
            updatedAt: now,
          },
        })
        .returning();

      return {
        displayName: profile.displayName,
        bio: profile.bio,
        accentTheme: profile.accentTheme as z.infer<typeof accentThemeSchema>,
        emailUpdatesEnabled: profile.emailUpdatesEnabled,
      };
    }),
});
