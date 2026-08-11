-- Add public sharing fields to objects table
ALTER TABLE "objects" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;
ALTER TABLE "objects" ADD COLUMN "public_token" text;
CREATE UNIQUE INDEX "objects_public_token_unique" ON "objects" USING btree ("public_token");
