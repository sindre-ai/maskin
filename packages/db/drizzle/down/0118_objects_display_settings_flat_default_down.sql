-- Rollback for 0118. Nothing to undo in SQL: the forward migration overwrote groupBy = 'status'
-- with 'none' and did not record which rows it changed, so the old values cannot be restored.
-- Reverting the app change brings back the grouped default for people with no saved view; a
-- person who wants Group by State again picks it in the Display panel.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

SELECT 1;
