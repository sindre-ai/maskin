/**
 * Providers whose installs are a list, not a single row. GitHub installs once
 * per org; LinkedIn once per workspace member (see the actor-scoped uniques in
 * packages/db/src/schema.ts); Skjald once per connected app.
 *
 * Anything not listed here is single-install: the settings page renders one row
 * and silently drops extra installs, and an agent's Connect card is skipped
 * once the provider is already active. Adding a provider to this set is what
 * makes its second install visible at all.
 */
export const MULTI_INSTALL_PROVIDERS: ReadonlySet<string> = new Set([
	'github',
	'linkedin-unipile',
	'skjald',
])
