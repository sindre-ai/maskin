-- Per-user favourites for the object-star toggle
-- (`POST/DELETE /api/objects/:id/star`) and the Starred filter on the objects
-- page. One row per (user, object) means "this user has starred this object";
-- absence means it isn't starred. Composite PK on (user_id, object_id) gives
-- uniqueness plus a covering index for point lookups by (user, object) —
-- which is what the toggle endpoints do on every write.
--
-- Both FKs cascade so deleting an actor or an object reaps their stars in the
-- same transaction, leaving no orphans for the Starred filter to render.
--
-- The secondary btree on (user_id, starred_at) supports the Starred-filter
-- read path: fetch this user's stars ordered by most-recently-starred, then
-- join to `objects` to render. Plain CREATE INDEX is fine — this is a brand
-- new empty table, no live writers to block.

CREATE TABLE IF NOT EXISTS "user_starred_objects" (
	"user_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"starred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_starred_objects_pk" PRIMARY KEY ("user_id", "object_id")
);

ALTER TABLE "user_starred_objects"
	DROP CONSTRAINT IF EXISTS "user_starred_objects_user_id_actors_id_fk";
ALTER TABLE "user_starred_objects"
	ADD CONSTRAINT "user_starred_objects_user_id_actors_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."actors"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_starred_objects"
	DROP CONSTRAINT IF EXISTS "user_starred_objects_object_id_objects_id_fk";
ALTER TABLE "user_starred_objects"
	ADD CONSTRAINT "user_starred_objects_object_id_objects_id_fk"
	FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id")
	ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "user_starred_objects_user_starred_at_idx"
	ON "user_starred_objects" ("user_id", "starred_at");
