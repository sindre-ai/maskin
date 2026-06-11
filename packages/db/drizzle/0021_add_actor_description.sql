-- Add a short one-liner description to actors. Used to render an at-a-glance
-- summary for agents on the Agents list / sub-page (separate from the longer
-- system_prompt). 80-char cap is enforced at the validation (Zod) layer; we
-- leave the column unconstrained so existing data and rollbacks stay simple.
--
-- To revert: ALTER TABLE actors DROP COLUMN description;

ALTER TABLE actors ADD COLUMN description text;
