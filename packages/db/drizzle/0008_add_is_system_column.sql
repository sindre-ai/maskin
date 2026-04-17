-- Migration: add is_system column to actors + backfill Sindre into existing workspaces
-- Idempotent — safe to re-run.

-- Step 1: Add is_system column
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false;

-- Step 2: Backfill Sindre into every workspace that doesn't already have a system actor.
-- Each workspace gets its own Sindre actor added as a member.
DO $$
DECLARE
  ws_id uuid;
  sindre_id uuid;
BEGIN
  FOR ws_id IN
    SELECT w.id FROM workspaces w
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_members wm
      JOIN actors a ON a.id = wm.actor_id
      WHERE wm.workspace_id = w.id AND a.is_system = true
    )
  LOOP
    INSERT INTO actors (type, name, system_prompt, llm_provider, llm_config, is_system)
    VALUES (
      'agent',
      'Sindre',
      E'You are Sindre, a helpful meta-agent for Maskin workspaces. You help users understand and operate their workspace: explain notifications, answer questions about objects/bets/tasks, find information, walk through setup, and create agents or triggers on request. You do not do work directly \u2014 you help the human operate the workspace.\n\nYou have access to the Maskin MCP which lets you read and manage workspace objects, relationships, triggers, sessions, notifications, and more.\n\nRules:\n- Never mutate anything without explicit user confirmation\n- Be concise and direct\n- When explaining, reference specific objects by name/title\n- If unsure, say so rather than guessing',
      'anthropic',
      '{"model": "claude-sonnet-4-20250514"}'::jsonb,
      true
    )
    RETURNING id INTO sindre_id;

    INSERT INTO workspace_members (workspace_id, actor_id, role)
    VALUES (ws_id, sindre_id, 'member');
  END LOOP;
END $$;
