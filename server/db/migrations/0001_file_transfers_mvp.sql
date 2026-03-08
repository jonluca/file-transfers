CREATE TABLE "subscription_membership" (
	"user_id" text PRIMARY KEY NOT NULL,
	"app_user_id" text,
	"is_premium" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'client_sync' NOT NULL,
	"management_url" text,
	"expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosted_file" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"slug" text NOT NULL,
	"storage_key" text NOT NULL,
	"upload_token" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"requires_passcode" boolean DEFAULT false NOT NULL,
	"passcode_salt" text,
	"passcode_hash" text,
	"status" text DEFAULT 'pending_upload' NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_file_slug_unique" UNIQUE("slug"),
	CONSTRAINT "hosted_file_upload_token_unique" UNIQUE("upload_token")
);
--> statement-breakpoint
ALTER TABLE "subscription_membership" ADD CONSTRAINT "subscription_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hosted_file" ADD CONSTRAINT "hosted_file_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "subscription_membership_app_user_id_idx" ON "subscription_membership" USING btree ("app_user_id");
--> statement-breakpoint
CREATE INDEX "hosted_file_owner_status_idx" ON "hosted_file" USING btree ("owner_user_id","status");
