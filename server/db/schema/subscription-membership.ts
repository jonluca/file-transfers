import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const subscriptionMembership = pgTable(
  "subscription_membership",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    appUserId: text("app_user_id"),
    isPremium: boolean("is_premium").default(false).notNull(),
    source: text("source").default("client_sync").notNull(),
    managementUrl: text("management_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("subscription_membership_app_user_id_idx").on(table.appUserId)],
);

export type SubscriptionMembership = typeof subscriptionMembership.$inferSelect;
