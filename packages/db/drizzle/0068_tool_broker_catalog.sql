-- The browsable integration catalogue.
--
-- WHOLLY MASKIN-OWNED, and that is the point rather than a detail. Every row is
-- normalised at ingest: our own id, our own description, our own icon path. No
-- upstream identifier, feed name, or upstream URL is stored, because anything
-- stored here can reach an API response, a page, or a browser request — and the
-- catalogue's source must not be discoverable from any of them.
--
-- `icon_path` is a key in OUR storage, never a URL. Upstream icon values point
-- at the source's own domain, so hotlinking one would put that hostname in every
-- browser request and in the page DOM — a leak no source-scanning guard can
-- catch, because the string would never appear in our code. The CHECK below
-- makes storing an absolute URL impossible rather than merely discouraged.
--
-- `endpoint_url` and `domain` describe the THIRD-PARTY PROVIDER (mcp.linear.app,
-- linear.app). Those are fine to store and must be: they are what we connect to.
--
-- Rows that vanish upstream are marked inactive, never deleted. A workspace may
-- already have connected one, and its absence upstream is not a reason to forget
-- what it was.

CREATE TABLE IF NOT EXISTS "tool_broker_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"domain" text NOT NULL,
	"icon_path" text,
	"connect_kind" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"auth_kind" text NOT NULL,
	"supports_dcr" boolean NOT NULL DEFAULT false,
	"credential_setup" text,
	"verified_at" timestamp with time zone,
	"status" text NOT NULL DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_broker_catalog_connect_kind_check"
		CHECK ("connect_kind" IN ('mcp', 'openapi')),
	CONSTRAINT "tool_broker_catalog_auth_kind_check"
		CHECK ("auth_kind" IN ('none', 'api_key', 'oauth2')),
	CONSTRAINT "tool_broker_catalog_status_check"
		CHECK ("status" IN ('active', 'inactive')),
	-- An icon must be a key in our own storage. Storing an absolute URL is the
	-- leak this table exists to prevent, so the database refuses it outright.
	CONSTRAINT "tool_broker_catalog_icon_is_not_a_url"
		CHECK ("icon_path" IS NULL OR "icon_path" !~* '^[a-z][a-z0-9+.-]*:'),
	-- One row per provider endpoint: the natural key for an idempotent upsert.
	CONSTRAINT "tool_broker_catalog_endpoint_uniq" UNIQUE ("endpoint_url")
);

CREATE INDEX IF NOT EXISTS "tool_broker_catalog_active_name_idx"
	ON "tool_broker_catalog" ("status", "name");

COMMENT ON COLUMN "tool_broker_catalog"."icon_path" IS
	'Key in Maskin storage. Never a URL — see the CHECK constraint; upstream icon URLs would leak the catalogue source into every browser request.';
