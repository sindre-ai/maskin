CREATE TABLE "agent_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"max_concurrent_sessions" integer NOT NULL,
	"status" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_servers" ADD CONSTRAINT "agent_servers_url_unique" UNIQUE ("url");
--> statement-breakpoint
ALTER TABLE "agent_servers" ADD CONSTRAINT "agent_servers_status_check" CHECK ("status" IN ('active', 'draining', 'disabled'));
