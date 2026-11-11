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
	github: { category: 'Code', domain: 'github.com' },
	gmail: { category: 'Email & calendar', domain: 'gmail.com' },
	'google-calendar': { category: 'Email & calendar', domain: 'calendar.google.com' },
	'google-drive': { category: 'Files', domain: 'drive.google.com' },
	'google-meet': { category: 'Chat & social', domain: 'meet.google.com' },
	'google-search-console': { category: 'Analytics', domain: 'search.google.com' },
	linear: { category: 'Code', domain: 'linear.app' },
	'linkedin-unipile': { category: 'Chat & social', domain: 'linkedin.com' },
	miro: { category: 'Design', domain: 'miro.com' },
	notion: { category: 'Docs & data', domain: 'notion.so' },
	posthog: { category: 'Analytics', domain: 'posthog.com' },
	resend: { category: 'Email & calendar', domain: 'resend.com' },
	skjald: { category: 'Docs & data' },
	slack: { category: 'Chat & social', domain: 'slack.com' },
	stripe: { category: 'Sales & payments', domain: 'stripe.com' },
	ubersuggest: { category: 'Analytics', domain: 'neilpatel.com' },
}

/** A provider the catalog does not know yet is still listed, under Docs & data. */
export function categoryFor(provider: string): IntegrationCategory {
	if (provider === 'custom-mcp') return 'Custom'
	return CATALOG[provider]?.category ?? 'Docs & data'
}

export function logoDomainFor(provider: string): string | undefined {
	return CATALOG[provider]?.domain
}
