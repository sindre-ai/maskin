import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { GSC_PROVIDER } from './sync'

/**
 * Helpers for the sitemap tools in `mcp-server.ts`: where a sitemap may live, how it is
 * addressed on Google's side, and the audit trail that limits `delete_sitemap` to what
 * Maskin itself submitted.
 */

const GSC_SITES_API = 'https://www.googleapis.com/webmasters/v3/sites'

/** Permission levels that may submit and delete sitemaps. Restricted and unverified may not. */
const WRITE_PERMISSION_LEVELS: ReadonlySet<string> = new Set(['siteOwner', 'siteFullUser'])

export function canManageSitemaps(permissionLevel: unknown): boolean {
	return typeof permissionLevel === 'string' && WRITE_PERMISSION_LEVELS.has(permissionLevel)
}

/** Percent-encoded, so `sc-domain:maskin.io` and a sitemap URL are each one path segment. */
export function sitePath(property: string): string {
	return `${GSC_SITES_API}/${encodeURIComponent(property)}`
}

export function sitemapsPath(property: string): string {
	return `${sitePath(property)}/sitemaps`
}

export function sitemapPath(property: string, sitemapUrl: string): string {
	return `${sitemapsPath(property)}/${encodeURIComponent(sitemapUrl)}`
}

export type SitemapCheck = { ok: true; sitemapUrl: string } | { ok: false; message: string }

/**
 * Whether `sitemapUrl` sits under `property`. Fail closed: anything that is not clearly
 * inside the property is refused before Google is called.
 *  - `sc-domain:example.com` covers the domain and its subdomains. The match is on whole
 *    host labels, so `notexample.com` and `example.com.evil.test` do not pass.
 *  - A URL-prefix property (`https://example.com/blog/`) is a plain prefix match on the
 *    absolute URL, protocol included.
 * Returns the URL in its parsed form; the audit trail stores and compares that form.
 */
export function checkSitemapUnderProperty(property: string, sitemapUrl: string): SitemapCheck {
	let sitemap: URL
	try {
		sitemap = new URL(sitemapUrl)
	} catch {
		return { ok: false, message: 'sitemap_url must be an absolute http(s) URL.' }
	}
	if (sitemap.protocol !== 'https:' && sitemap.protocol !== 'http:') {
		return { ok: false, message: 'sitemap_url must be an absolute http(s) URL.' }
	}

	if (property.startsWith('sc-domain:')) {
		const domain = property.slice('sc-domain:'.length).toLowerCase()
		const host = sitemap.hostname.toLowerCase()
		if (domain && (host === domain || host.endsWith(`.${domain}`))) {
			return { ok: true, sitemapUrl: sitemap.href }
		}
		return { ok: false, message: `sitemap_url must be on ${domain} or one of its subdomains.` }
	}

	let prefix: URL
	try {
		prefix = new URL(property)
	} catch {
		return {
			ok: false,
			message:
				'site_url must be a property exactly as list_sites returns it, e.g. sc-domain:maskin.io or https://maskin.io/.',
		}
	}
	if (sitemap.href.startsWith(prefix.href)) return { ok: true, sitemapUrl: sitemap.href }
	return { ok: false, message: `sitemap_url must start with ${prefix.href}.` }
}

// ── Audit trail ──────────────────────────────────────────────────────────────

export const SITEMAP_SUBMITTED = 'gsc_sitemap_submitted'
export const SITEMAP_DELETED = 'gsc_sitemap_deleted'

export interface SitemapAuditInput {
	workspaceId: string
	actorId: string
	integrationId: string
	property: string
	sitemapUrl: string
}

/** Called only after Google has answered ok, so a failed call never counts as a submit. */
export async function recordSitemapAction(
	db: Database,
	action: typeof SITEMAP_SUBMITTED | typeof SITEMAP_DELETED,
	input: SitemapAuditInput,
): Promise<void> {
	await recordEvent(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		action,
		entityType: 'integration',
		entityId: input.integrationId,
		data: { provider: GSC_PROVIDER, property: input.property, sitemap_url: input.sitemapUrl },
	})
}

/**
 * The newest submit or delete Maskin recorded for this property and sitemap URL, or null.
 * Keyed by workspace, provider, property and URL, never by connection: a reconnect creates
 * a new connection, and a connection-keyed lookup would forget every earlier submit.
 */
export async function lastSitemapAction(
	db: Database,
	input: Pick<SitemapAuditInput, 'workspaceId' | 'property' | 'sitemapUrl'>,
): Promise<typeof SITEMAP_SUBMITTED | typeof SITEMAP_DELETED | null> {
	const [row] = await db
		.select({ action: events.action })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, input.workspaceId),
				eq(events.entityType, 'integration'),
				inArray(events.action, [SITEMAP_SUBMITTED, SITEMAP_DELETED]),
				sql`${events.data}->>'provider' = ${GSC_PROVIDER}`,
				sql`${events.data}->>'property' = ${input.property}`,
				sql`${events.data}->>'sitemap_url' = ${input.sitemapUrl}`,
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	const action = row?.action
	return action === SITEMAP_SUBMITTED || action === SITEMAP_DELETED ? action : null
}
