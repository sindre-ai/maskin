/** The category chips on Settings → Integrations, in the order the design shows them. */
export const INTEGRATION_CATEGORIES = [
	'Email & calendar',
	'Files',
	'Docs & data',
	'Chat & social',
	'Code',
	'Design',
	'Sales & payments',
	'Analytics',
	'Custom',
] as const

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number]

interface CatalogEntry {
	category: IntegrationCategory
	/** Site whose icon draws the logo tile. The letter tile stays when it does not load. */
	domain?: string
}

const CATALOG: Record<string, CatalogEntry> = {
	attio: { category: 'Sales & payments', domain: 'attio.com' },
	cloudflare: { category: 'Code', domain: 'cloudflare.com' },
	datadog: { category: 'Analytics', domain: 'datadoghq.com' },
	fathom: { category: 'Chat & social', domain: 'fathom.video' },
	fireflies: { category: 'Chat & social', domain: 'fireflies.ai' },
	github: { category: 'Code', domain: 'github.com' },
	gmail: { category: 'Email & calendar', domain: 'gmail.com' },
	'google-calendar': { category: 'Email & calendar', domain: 'calendar.google.com' },
	'google-drive': { category: 'Files', domain: 'drive.google.com' },
	'google-meet': { category: 'Chat & social', domain: 'meet.google.com' },
	'google-search-console': { category: 'Analytics', domain: 'search.google.com' },
	granola: { category: 'Chat & social', domain: 'granola.ai' },
	hex: { category: 'Analytics', domain: 'hex.tech' },
	linear: { category: 'Code', domain: 'linear.app' },
	'linkedin-unipile': { category: 'Chat & social', domain: 'linkedin.com' },
	microsoft: { category: 'Chat & social', domain: 'microsoft.com' },
	miro: { category: 'Design', domain: 'miro.com' },
	neon: { category: 'Docs & data', domain: 'neon.tech' },
	netlify: { category: 'Code', domain: 'netlify.com' },
	'new-relic': { category: 'Analytics', domain: 'newrelic.com' },
	notion: { category: 'Docs & data', domain: 'notion.so' },
	otter: { category: 'Chat & social', domain: 'otter.ai' },
	pagerduty: { category: 'Analytics', domain: 'pagerduty.com' },
	planetscale: { category: 'Docs & data', domain: 'planetscale.com' },
	posthog: { category: 'Analytics', domain: 'posthog.com' },
	resend: { category: 'Email & calendar', domain: 'resend.com' },
	retool: { category: 'Docs & data', domain: 'retool.com' },
	skjald: { category: 'Docs & data' },
	slack: { category: 'Chat & social', domain: 'slack.com' },
	stripe: { category: 'Sales & payments', domain: 'stripe.com' },
	supabase: { category: 'Docs & data', domain: 'supabase.com' },
	ubersuggest: { category: 'Analytics', domain: 'neilpatel.com' },
	zoom: { category: 'Chat & social', domain: 'zoom.us' },
}

/** A provider the catalog does not know yet is still listed, under Docs & data. */
export function categoryFor(provider: string): IntegrationCategory {
	if (provider === 'custom-mcp') return 'Custom'
	return CATALOG[provider]?.category ?? 'Docs & data'
}

export function logoDomainFor(provider: string): string | undefined {
	return CATALOG[provider]?.domain
}
