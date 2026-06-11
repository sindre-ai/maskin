-- Partial unique index preventing duplicate bets created from the same guest draft.
-- If claim-to-bet creation logic is (re-)introduced, two concurrent requests for the
-- same draft cannot both commit — the DB enforces the invariant regardless of any
-- application-level guard.
-- NULL values (the vast majority of rows) are excluded so normal bets are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS objects_claimed_from_guest_draft_uniq
  ON objects (workspace_id, (metadata->>'claimedFromGuestDraft'))
  WHERE metadata->>'claimedFromGuestDraft' IS NOT NULL;
