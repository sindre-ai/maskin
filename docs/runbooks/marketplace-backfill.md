# Marketplace install-audit backfill

## What this script does

Backfills `marketplace_installations` audit rows for seed-provisioned items
(loops, agents, skills) that exist in pre-migration workspaces without a
corresponding install-audit row. Without this run, workspaces created before
the Marketplace bet's seed-reify migration render their seeded items as
**Install** on the Marketplace page instead of **Installed / Manage** — the
Manage state flip reads from `marketplace_installations` presence, so the
audit row is the load-bearing link.

New workspaces post-migration get an install-audit row (`source='seed'`)
written alongside every seeded row at bootstrap time. This script handles
the pre-migration tail.

Matching precedent: Keychain and Registry each shipped their own one-shot
backfill scripts run via SSH after their bet's migration landed. This is
the Marketplace-shaped version of that.

## When to run it

- **Once after the Marketplace bet's seed-reify migration deploys.**
- **Every time a Postgres snapshot older than the bet's deploy date is
  restored** (rare; ops backfill dance). The script is idempotent, so a
  re-run against a fully-linked DB is a no-op.
- **NOT** on every deploy — the bootstrap path writes install-audit rows
  inline for new workspaces, so once the tail is caught up there's nothing
  for this script to do.

## How to run it

1. SSH to the app host that has direct Postgres access, same pattern as the
   Keychain/Registry backfill runbooks.
2. Export the database URL:

   `export DATABASE_URL=<production connection string>`

3. Dry-run first — reports match counts without writing:

   `DRY_RUN=1 pnpm --filter @maskin/dev exec tsx scripts/backfill-marketplace-installations.ts`

4. Live run — writes the audit rows:

   `pnpm --filter @maskin/dev exec tsx scripts/backfill-marketplace-installations.ts`

5. Verify counts match the dry-run report:

   ```
   Marketplace install-audit backfill:
     loops:  <N> inserted / <N> matched
     agents: <N> inserted / <N> matched
     skills: <N> inserted / <N> matched
     total:  <N> audit rows written
   ```

6. Spot-check the Marketplace page as any pre-migration workspace: the
   seeded items should render **Installed / Manage** on their cards.

## What the script does NOT do

- **Does not backfill MCP-server installs.** The Marketplace Tools tab
  reads from `mcp_installations` (Registry-owned). Run the Registry
  backfill first if the workspace's Tools tab needs the same treatment.
- **Does not touch user-hand-created rows.** Rows whose slug does not
  match any catalog entry stay unlinked; they were not installed through
  the Marketplace, so they should not appear on the Manage state.
- **Does not rename actors or workspace-skills.** Agent matching uses a
  canonical-form slug derived from `actors.name` (lowercased, spaces
  hyphenated). An actor a user renamed after install won't match and stays
  unlinked — that's correct behaviour, we can't distinguish "renamed seed
  agent" from "hand-created agent that happened to be named after a
  catalog item".

## What to check if it fails

- **`ERROR: relation "marketplace_installations" does not exist`** — the
  Marketplace bet's schema migration hasn't landed yet on this database.
  Run pending migrations first via the standard deploy path.
- **`ERROR: relation "marketplace_agents" does not exist`** — same as
  above; the seed-reify migration is what provisions the catalog tables.
- **All three counters show 0 matched** — either the seed-reify migration
  ran but populated with a different slug set, or the workspace was created
  post-migration and the bootstrap already wrote the audit rows. Compare a
  handful of `marketplace_loops.slug` values against `installed_loops` +
  `marketplace_loops` join by hand to confirm.

## Blast radius if run in error

- **Safe to re-run.** The partial unique index
  `(workspace_id, item_kind, catalog_slug) WHERE uninstalled_at IS NULL`
  on `marketplace_installations` makes every insert idempotent —
  duplicates are silently dropped.
- **Safe to interrupt.** Each `WITH new_rows` CTE is one transaction; a
  killed run either commits its full loops/agents/skills batch or none
  of that batch. Re-run picks up where it left off.
- **Not safe to run before the migration.** See the failure modes above.
