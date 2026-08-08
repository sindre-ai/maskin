-- Add vaerksted_identity_id to actors so a Maskin actor can optionally link
-- to a vaerksted-auth identity ("Continue with vaerksted" login/signup, see
-- vaerksted-auth-and-sync.md §4/§8). Nullable, no FK constraint — this is a
-- cross-service reference into vaerksted-auth's own database (a separate
-- deployable with its own schema per §4), same precedent as
-- sessions.source_session_id in 0039_sessions_source_session_id.sql.

ALTER TABLE "actors" ADD COLUMN "vaerksted_identity_id" uuid;
