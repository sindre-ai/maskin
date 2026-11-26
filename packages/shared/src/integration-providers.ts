/**
 * Providers whose installs are a list, not a single row. GitHub installs once
 * per org; LinkedIn once per workspace member (see the actor-scoped uniques in
 * packages/db/src/schema.ts); Skjald once per connected app. Gmail and Google
 * Calendar once per Google account, Linear once per Linear organization.
 *
 * A provider belongs here only if its connect stores a stable per-account id
 * (a registry resolveExternalId). Without one the row would carry a random id
 * and every "Connect another account" would add a duplicate of the same account.
 *
 * Anything not listed here is single-install: the settings page renders one row
 * and silently drops extra installs, and an agent's Connect card is skipped
 * once the provider is already active. Adding a provider to this set is what
 * makes its second install visible at all.
 */
export const MULTI_INSTALL_PROVIDERS: ReadonlySet<string> = new Set([
	'github',
	'gmail',
	'google-calendar',
	'linear',
	'linkedin-unipile',
	'skjald',
])
