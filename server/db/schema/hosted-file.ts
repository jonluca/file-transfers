import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const hostedFile = sqliteTable(
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
    sizeBytes: integer("size_bytes").notNull(),
    requiresPasscode: integer("requires_passcode", { mode: "boolean" }).default(false).notNull(),
    passcodeSalt: text("passcode_salt"),
    passcodeHash: text("passcode_hash"),
    status: text("status").default("pending_upload").notNull(),
    downloadCount: integer("download_count").default(0).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
  },
  (table) => [index("hosted_file_owner_status_idx").on(table.ownerUserId, table.status)],
);

export type HostedFileRecord = typeof hostedFile.$inferSelect;
