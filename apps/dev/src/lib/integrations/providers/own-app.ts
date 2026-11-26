/**
 * Providers that sign in through an app Maskin owns at the vendor, or that need the vendor to approve
 * Maskin first. Behind the own-app-integrations flag (apps/dev/src/lib/feature-flags.ts), and offered
 * only once the vendor's app id is set on the server (see providerAppReady).
 */
export const OWN_APP_PROVIDERS = [
	'hubspot',
	'asana',
	'docusign',
	'figma',
	'dropbox',
	'intercom',
	'pipedrive',
	'ramp',
	'squarespace',
	'xero',
] as const

/** True when the server has a non-blank value for the vendor's app id. */
export const appIdIsSet = (
	clientIdEnv: string,
	env: Record<string, string | undefined> = process.env,
): boolean => !!env[clientIdEnv]?.trim()
