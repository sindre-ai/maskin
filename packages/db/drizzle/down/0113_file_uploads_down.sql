-- Rollback for 0113. Drops the upload ledger and narrows files.size_bytes back to integer.
--
-- Fails if any file is larger than 2 GiB (the cast overflows); delete or shrink those first.
-- Unfinished multipart uploads left in the bucket are not touched; abort them with the
-- bucket's lifecycle rule or the S3 console.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "file_uploads";
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "size_bytes" TYPE integer;
