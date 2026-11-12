-- Rollback for 0142. Nothing to undo, on purpose.
--
-- 0142 only moved the DM marker off chats that were really topical and added empty DMs.
-- Code from before it reads the marker the same way, so it works on the new data as it
-- is. Putting the marker back on the old chats would mean deleting the new DMs, and
-- people may have written in them since; the old chats lose nothing by staying unmarked.
SELECT 1;
