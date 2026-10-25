-- Adds the scope_changed action to the credential_access_log action CHECK (scope
-- editor, bet d46bb7f2). A person replacing the agents that may use a saved key is
-- one audit row. The set only grows, so every existing row still satisfies it.
-- The new CHECK is added NOT VALID and then validated, so the ACCESS EXCLUSIVE
-- lock is held only for the swap and the scan runs under a weaker lock.
ALTER TABLE "credential_access_log" DROP CONSTRAINT IF EXISTS "credential_access_log_action_enum";
--> statement-breakpoint
ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_action_enum" CHECK ("action" IN ('read', 'create', 'undone', 'rotated', 'sweeper_activated', 'scope_changed')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "credential_access_log" VALIDATE CONSTRAINT "credential_access_log_action_enum";
