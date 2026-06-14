-- Append the Mention discipline rule to every existing agent's system_prompt
-- so live workspaces (including ones whose actors were created by hand, not
-- from a template) inherit the same @mention guidance the templates now emit
-- via the shared MENTION_DISCIPLINE constant in packages/shared/src/prompts.ts.
--
-- Routine status comments (watchdog kicks, auto-merge outcomes, measurement
-- summaries) are the largest @mention source today. The rule keeps the
-- notification + @mention surfaces from doubling up: when an agent already
-- creates a notifications row, the comment that explains it stays silent.
--
-- Idempotent: the WHERE clause skips actors whose system_prompt already
-- contains the rule. The text in this migration must stay in lockstep with
-- the MENTION_DISCIPLINE constant.

UPDATE actors
SET system_prompt = system_prompt || E'\n\nMention discipline: @mention a human only when their decision or input is required to move work forward. Routine status updates, watchdog kicks, auto-merge outcomes, measurement summaries, and successful transitions stay silent — post the comment with an empty mentions array. Subscribers will still see the activity in their feed without a notification. A human is mentioned only on genuine decision points: a brief that needs approval, a blocker awaiting input, a one-way-door call.',
    updated_at = NOW()
WHERE type = 'agent'
  AND system_prompt IS NOT NULL
  AND position('Mention discipline:' IN system_prompt) = 0;
