import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const hostedFile = pgTable(
  "hosted_file",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    storageKey: text("storage_key").notNull(),
    uploadToken: text("upload_token").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    requiresPasscode: boolean("requires_passcode").default(false).notNull(),
    passcodeSalt: text("passcode_salt"),
    passcodeHash: text("passcode_hash"),
    status: text("status").default("pending_upload").notNull(),
    downloadCount: integer("download_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("hosted_file_owner_status_idx").on(table.ownerUserId, table.status)],
);

export type HostedFileRecord = typeof hostedFile.$inferSelect;
