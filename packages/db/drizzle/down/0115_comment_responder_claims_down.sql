-- Rollback for 0115. Drops the claim table; with it gone the two responder paths can again
-- double-dispatch for one comment, which is the pre-0115 behaviour.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "comment_responder_claims";
