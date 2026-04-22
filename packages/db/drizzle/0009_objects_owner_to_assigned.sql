-- Migration: replace `objects.owner` (single UUID) with `assigned_to` relationship edges.
-- Multiplayer mode: many assignees and many watchers per object, expressed as typed edges
-- in the existing relationships table. See plan: claude/improve-multiplayer-shared-objectives.

-- Step 1: Backfill every non-null owner as an `assigned_to` edge.
-- created_by falls back to the object's creator; relationships.created_by is NOT NULL.
INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
SELECT 'object', o.id, 'actor', o.owner, 'assigned_to', o.created_by
FROM objects o
WHERE o.owner IS NOT NULL
ON CONFLICT ON CONSTRAINT relationships_src_tgt_type_uniq DO NOTHING;

-- Step 2: Drop the column and its FK. Safe because every caller that still reads/writes
-- `owner` must be updated in the same changeset.
ALTER TABLE "objects" DROP CONSTRAINT IF EXISTS "objects_owner_actors_id_fk";
ALTER TABLE "objects" DROP COLUMN IF EXISTS "owner";
