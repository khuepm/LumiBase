CREATE TABLE IF NOT EXISTS "lumibase_publisher_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"publisher" text NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "publisher_keys_key_id_unique" ON "lumibase_publisher_keys" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "is_official" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "auto_install" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "enabled_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN IF NOT EXISTS "verified_at" timestamp;
