/** The category chips on Settings → Integrations, in the order the design shows them. */
export const INTEGRATION_CATEGORIES = [
	'Email & calendar',
	'Files',
	'Docs & data',
	'Chat & social',
	'Code',
	'Design',
	'Sales & payments',
	'Accounting',
	'Analytics',
	'Custom',
] as const

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number]

/** Only these two companies get a pill of their own on Settings → Integrations. */
export type IntegrationVendor = 'Google' | 'Microsoft'

/** A tool counts as New for this many days after it was added. */
export const NEW_WINDOW_DAYS = 30

interface CatalogEntry {
	category: IntegrationCategory
	/** Site whose icon draws the logo tile. The letter tile stays when it does not load. */
	domain?: string
	/** The company behind the tool, for the vendor pills. Left out for everyone else. */
	vendor?: IntegrationVendor
	/** Place in the Popular shelf, 1 first. Editorial, not usage data. Left out means not Popular. */
	featured?: number
	/** Date the tool first shipped (YYYY-MM-DD). Left out means older than the New shelf tracks. */
	addedOn?: string
	/** One line on what the tool is for. Left out means the page shows the category instead. */
	description?: string
}

const CATALOG: Record<string, CatalogEntry> = {
	attio: { category: 'Sales & payments', domain: 'attio.com' },
	box: { category: 'Files', domain: 'box.com', addedOn: '2026-11-22' },
	cloudflare: { category: 'Code', domain: 'cloudflare.com', addedOn: '2026-11-21' },
	datadog: { category: 'Analytics', domain: 'datadoghq.com', addedOn: '2026-11-21' },
	fathom: { category: 'Chat & social', domain: 'fathom.video', addedOn: '2026-11-21' },
	fireflies: { category: 'Chat & social', domain: 'fireflies.ai', addedOn: '2026-11-21' },
	github: { category: 'Code', domain: 'github.com', description: 'Pull requests', featured: 4 },
	gmail: {
		category: 'Email & calendar',
		domain: 'gmail.com',
		description: 'Drafts and sending',
		vendor: 'Google',
		featured: 1,
	},
	'google-calendar': {
		category: 'Email & calendar',
		domain: 'calendar.google.com',
		vendor: 'Google',
		featured: 2,
	},
	'google-drive': {
		category: 'Files',
		domain: 'drive.google.com',
		description: 'Files',
		vendor: 'Google',
		featured: 5,
	},
	'google-meet': { category: 'Chat & social', domain: 'meet.google.com', vendor: 'Google' },
	'google-search-console': { category: 'Analytics', domain: 'search.google.com', vendor: 'Google' },
	granola: { category: 'Chat & social', domain: 'granola.ai', addedOn: '2026-11-21' },
	hex: { category: 'Analytics', domain: 'hex.tech', addedOn: '2026-11-21' },
	lattice: { category: 'Docs & data', domain: 'lattice.com', addedOn: '2026-11-22' },
	linear: { category: 'Code', domain: 'linear.app', description: 'Issues', featured: 7 },
	'linkedin-unipile': {
		category: 'Chat & social',
		domain: 'linkedin.com',
		description: 'Posting and outreach',
	},
	looker: { category: 'Analytics', domain: 'looker.com', addedOn: '2026-11-22' },
	microsoft: {
		category: 'Chat & social',
		domain: 'microsoft.com',
		description: 'Teams transcripts',
		vendor: 'Microsoft',
	},
	miro: { category: 'Design', domain: 'miro.com' },
	neon: { category: 'Docs & data', domain: 'neon.tech', addedOn: '2026-11-21' },
	netlify: { category: 'Code', domain: 'netlify.com', addedOn: '2026-11-21' },
	'new-relic': { category: 'Analytics', domain: 'newrelic.com', addedOn: '2026-11-21' },
	notion: { category: 'Docs & data', domain: 'notion.so', featured: 6 },
	numina: { category: 'Accounting', domain: 'numina.app', addedOn: '2026-11-22' },
	otter: { category: 'Chat & social', domain: 'otter.ai', addedOn: '2026-11-21' },
	pagerduty: { category: 'Analytics', domain: 'pagerduty.com', addedOn: '2026-11-21' },
	planetscale: { category: 'Docs & data', domain: 'planetscale.com', addedOn: '2026-11-21' },
	posthog: { category: 'Analytics', domain: 'posthog.com', description: 'Product analytics' },
	'power-bi': {
		category: 'Analytics',
		domain: 'powerbi.microsoft.com',
		vendor: 'Microsoft',
		addedOn: '2026-11-22',
	},
	resend: { category: 'Email & calendar', domain: 'resend.com', description: 'Email sending' },
	retool: { category: 'Docs & data', domain: 'retool.com', addedOn: '2026-11-21' },
	salesforce: { category: 'Sales & payments', domain: 'salesforce.com', addedOn: '2026-11-22' },
	skjald: { category: 'Docs & data' },
	slack: {
		category: 'Chat & social',
		domain: 'slack.com',
		description: 'Channels and triggers',
		featured: 3,
	},
	stripe: { category: 'Sales & payments', domain: 'stripe.com' },
	supabase: { category: 'Docs & data', domain: 'supabase.com', addedOn: '2026-11-21' },
	ubersuggest: { category: 'Analytics', domain: 'neilpatel.com' },
	dinero: { category: 'Accounting', domain: 'dinero.dk', addedOn: '2026-11-22' },
	uniconta: { category: 'Accounting', domain: 'uniconta.com', addedOn: '2026-11-22' },
	'business-central': {
		category: 'Accounting',
		domain: 'dynamics.microsoft.com',
		addedOn: '2026-11-24',
	},
	'wordpress-self-hosted': {
		category: 'Docs & data',
		domain: 'wordpress.org',
		addedOn: '2026-11-25',
		description: 'Posts and pages on your own site',
	},
	zendesk: { category: 'Docs & data', domain: 'zendesk.com', addedOn: '2026-11-22' },
	zoom: { category: 'Chat & social', domain: 'zoom.us', addedOn: '2026-11-20' },
	apollo: { category: 'Sales & payments', domain: 'apollo.io', addedOn: '2026-11-22' },
	zoominfo: { category: 'Sales & payments', domain: 'zoominfo.com', addedOn: '2026-11-22' },
	outreach: { category: 'Sales & payments', domain: 'outreach.io', addedOn: '2026-11-22' },
	gong: { category: 'Sales & payments', domain: 'gong.io', addedOn: '2026-11-22' },
	clay: { category: 'Sales & payments', domain: 'clay.com', addedOn: '2026-11-22' },
	calendly: { category: 'Email & calendar', domain: 'calendly.com', addedOn: '2026-11-22' },
	monday: { category: 'Docs & data', domain: 'monday.com', addedOn: '2026-11-22' },
	make: { category: 'Docs & data', domain: 'make.com', addedOn: '2026-11-22' },
	hubspot: {
		category: 'Sales & payments',
		domain: 'hubspot.com',
		featured: 8,
		addedOn: '2026-11-22',
	},
	asana: { category: 'Docs & data', domain: 'asana.com', addedOn: '2026-11-22' },
	docusign: { category: 'Docs & data', domain: 'docusign.com', addedOn: '2026-11-22' },
	figma: { category: 'Docs & data', domain: 'figma.com', addedOn: '2026-11-22' },
	dropbox: { category: 'Docs & data', domain: 'dropbox.com', addedOn: '2026-11-22' },
	intercom: { category: 'Chat & social', domain: 'intercom.com', addedOn: '2026-11-22' },
	pipedrive: { category: 'Sales & payments', domain: 'pipedrive.com', addedOn: '2026-11-22' },
	ramp: { category: 'Sales & payments', domain: 'ramp.com', addedOn: '2026-11-22' },
	squarespace: { category: 'Docs & data', domain: 'squarespace.com', addedOn: '2026-11-22' },
	xero: { category: 'Sales & payments', domain: 'xero.com', addedOn: '2026-11-22' },
	brevo: { category: 'Sales & payments', domain: 'brevo.com', addedOn: '2026-11-24' },
	brex: { category: 'Sales & payments', domain: 'brex.com', addedOn: '2026-11-24' },
	coda: { category: 'Docs & data', domain: 'coda.io', addedOn: '2026-11-24' },
	deel: { category: 'Sales & payments', domain: 'deel.com', addedOn: '2026-11-24' },
	drata: { category: 'Analytics', domain: 'drata.com', addedOn: '2026-11-24' },
	framer: { category: 'Design', domain: 'framer.com', addedOn: '2026-11-24' },
	freshbooks: { category: 'Sales & payments', domain: 'freshbooks.com', addedOn: '2026-11-24' },
	greenhouse: { category: 'Sales & payments', domain: 'greenhouse.com', addedOn: '2026-11-24' },
	gusto: { category: 'Sales & payments', domain: 'gusto.com', addedOn: '2026-11-24' },
	klaviyo: { category: 'Sales & payments', domain: 'klaviyo.com', addedOn: '2026-11-24' },
	mailchimp: { category: 'Sales & payments', domain: 'mailchimp.com', addedOn: '2026-11-24' },
	mercury: { category: 'Sales & payments', domain: 'mercury.com', addedOn: '2026-11-24' },
	mural: { category: 'Design', domain: 'mural.co', addedOn: '2026-11-24' },
	trello: { category: 'Docs & data', domain: 'trello.com', addedOn: '2026-11-24' },
	vanta: { category: 'Analytics', domain: 'vanta.com', addedOn: '2026-11-24' },
	wix: { category: 'Design', domain: 'wix.com', addedOn: '2026-11-24' },
}

/** A provider the catalog does not know yet is still listed, under Docs & data. */
export function categoryFor(provider: string): IntegrationCategory {
	if (provider === 'custom-mcp') return 'Custom'
	return CATALOG[provider]?.category ?? 'Docs & data'
}

export function logoDomainFor(provider: string): string | undefined {
	return CATALOG[provider]?.domain
}

export function vendorFor(provider: string): IntegrationVendor | undefined {
	return CATALOG[provider]?.vendor
}

export function descriptionFor(provider: string): string | undefined {
	return CATALOG[provider]?.description
}

export function addedOnFor(provider: string): string | undefined {
	return CATALOG[provider]?.addedOn
}

/** Featured tools in shelf order. Empty when nothing is featured, so the shelf stays hidden. */
export function popularProviders(): string[] {
	return Object.entries(CATALOG)
		.flatMap(([provider, entry]) =>
			entry.featured === undefined ? [] : [[provider, entry.featured] as const],
		)
		.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
		.map(([provider]) => provider)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** True when the tool was added within the last 30 days. No date means not new. */
export function isNewProvider(provider: string, now: Date = new Date()): boolean {
	const addedOn = CATALOG[provider]?.addedOn
	if (!addedOn) return false
	const added = Date.parse(`${addedOn}T00:00:00Z`)
	if (Number.isNaN(added)) return false
	const ageDays = (now.getTime() - added) / DAY_MS
	return ageDays >= 0 && ageDays <= NEW_WINDOW_DAYS
}

/** Tools inside the New window, newest first. Empty hides the shelf. */
export function newProviders(now: Date = new Date()): string[] {
	return Object.entries(CATALOG)
		.filter(([provider]) => isNewProvider(provider, now))
		.sort(
			(a, b) => (b[1].addedOn ?? '').localeCompare(a[1].addedOn ?? '') || a[0].localeCompare(b[0]),
		)
		.map(([provider]) => provider)
}
