import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const subscriptionMembership = sqliteTable(
  "subscription_membership",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    appUserId: text("app_user_id"),
    isPremium: integer("is_premium", { mode: "boolean" }).default(false).notNull(),
    source: text("source").default("client_sync").notNull(),
    managementUrl: text("management_url"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
  },
  (table) => [index("subscription_membership_app_user_id_idx").on(table.appUserId)],
);

export type SubscriptionMembership = typeof subscriptionMembership.$inferSelect;
