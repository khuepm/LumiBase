ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "site_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_site_ts_idx" ON "audit_log" USING btree ("site_id","timestamp");
