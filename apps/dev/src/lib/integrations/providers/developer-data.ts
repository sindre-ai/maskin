/** Providers behind the developer-data-integrations flag (apps/dev/src/lib/feature-flags.ts). */
export const DEVELOPER_DATA_PROVIDERS = [
	'cloudflare',
	'supabase',
	'neon',
	'planetscale',
	'netlify',
	'datadog',
	'new-relic',
	'pagerduty',
	'retool',
	'hex',
] as const
