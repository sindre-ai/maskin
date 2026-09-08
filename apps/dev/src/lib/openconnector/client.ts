import { z } from 'zod'
import { logger } from '../logger'

/**
 * Thin read-only client for the OpenConnector runtime's provider catalog.
 *
 * OpenConnector is a *backend* detail. Nothing it returns is presented to the
 * user as "an OpenConnector thing" — the catalog is synced into ordinary
 * marketplace rows (see jobs/sync-openconnector-catalog.ts) and from there it
 * is indistinguishable from any other marketplace integration. Keep the vendor
 * name out of routes, components and user-facing copy; it belongs here and in
 * the sync job only.
 *
 * Both env vars are unset by default. When either is missing we skip the fetch
 * entirely and return an empty catalog rather than throwing — a Maskin
 * deployment with no OpenConnector runtime is a supported configuration, not an
 * error, and the marketplace simply renders no integrations. Same for a
 * runtime that is unreachable or returns a shape we don't recognise: this
 * client never throws, because a catalog refresh failing must not take down the
 * nightly job or any request that touches it.
 */

const REQUEST_TIMEOUT_MS = 10_000

/**
 * The subset of each provider Maskin actually renders or installs.
 *
 * Field names here are Maskin's, not the runtime's. OpenConnector calls the
 * stable slug `service` and the label `displayName`; we normalise to `id` /
 * `name` at this boundary so nothing downstream has to know the wire shape.
 * Verified against a live runtime (GET /v1/providers, 1465 rows).
 */
export interface OpenConnectorProvider {
	id: string
	name: string
	category: string | null
	iconUrl: string | null
	homepageUrl: string | null
	scenario: string | null
	authTypes: string[]
}

// Mirrors the runtime's RuntimeProviderMetadata. `service` and `displayName`
// are the only fields we cannot render a card without; everything else
// degrades rather than dropping the provider. `.passthrough()` keeps unknown
// fields from failing the parse.
//
// NOTE: there is deliberately no `description` or `actionCount` here — the
// runtime does not return either. `scenario` is a discovery slug
// ("cross-border-ecommerce"), not prose, so it is kept as provenance rather
// than displayed as a description.
const providerSchema = z
	.object({
		service: z.string().min(1),
		displayName: z.string().min(1),
		iconUrl: z.string().nullish(),
		homepageUrl: z.string().nullish(),
		scenario: z.string().nullish(),
		categories: z
			.array(z.object({ id: z.string(), displayName: z.string() }).passthrough())
			.nullish(),
		authTypes: z.array(z.string()).nullish(),
	})
	.passthrough()

// The runtime wraps rows as `{ success, message, data, meta }`; a bare array
// and `{ providers: [...] }` are accepted too so a shape change doesn't read
// as "catalog is empty".
const responseSchema = z.union([
	z.array(providerSchema),
	z.object({ providers: z.array(providerSchema) }),
	z.object({ data: z.array(providerSchema) }),
])

export interface OpenConnectorConfig {
	baseUrl: string
	token: string
}

/**
 * Returns null when the runtime is not configured. Callers treat null and []
 * the same way (no catalog), but the distinction is kept so the sync job can
 * skip reconciliation entirely rather than interpreting "not configured" as
 * "every provider was removed" and deleting the catalog.
 */
export function resolveOpenConnectorConfig(
	env: NodeJS.ProcessEnv = process.env,
): OpenConnectorConfig | null {
	const baseUrl = env.OPENCONNECTOR_RUNTIME_URL?.trim()
	const token = env.OPENCONNECTOR_RUNTIME_TOKEN?.trim()
	if (!baseUrl || !token) return null
	return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

function unwrap(parsed: z.infer<typeof responseSchema>): z.infer<typeof providerSchema>[] {
	if (Array.isArray(parsed)) return parsed
	return 'providers' in parsed ? parsed.providers : parsed.data
}

/**
 * Fetch the provider catalog. Never throws — returns null when the runtime is
 * unconfigured or unreachable, so the caller can tell "no catalog available"
 * apart from "the runtime says there are zero providers".
 */
export async function listProviders(
	config: OpenConnectorConfig | null = resolveOpenConnectorConfig(),
	fetchImpl: typeof fetch = fetch,
): Promise<OpenConnectorProvider[] | null> {
	if (!config) {
		logger.debug(
			'OpenConnector catalog skipped — OPENCONNECTOR_RUNTIME_URL / OPENCONNECTOR_RUNTIME_TOKEN unset',
		)
		return null
	}

	let res: Response
	try {
		res = await fetchImpl(`${config.baseUrl}/v1/providers`, {
			headers: {
				Authorization: `Bearer ${config.token}`,
				Accept: 'application/json',
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch (err) {
		// undici reports every network fault as `TypeError: fetch failed` and
		// puts the real diagnostic (ECONNREFUSED, ENOTFOUND, TLS) on `.cause`.
		const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : ''
		logger.warn('OpenConnector provider fetch failed', {
			error: err instanceof Error ? err.message : String(err),
			cause,
		})
		return null
	}

	if (!res.ok) {
		logger.warn('OpenConnector provider fetch non-2xx', { status: res.status })
		return null
	}

	let payload: unknown
	try {
		payload = await res.json()
	} catch (err) {
		logger.warn('OpenConnector provider response was not JSON', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}

	const parsed = responseSchema.safeParse(payload)
	if (!parsed.success) {
		// Log the top-level keys only, never the body — a provider payload can
		// carry credential-shaped fields, and this line goes to shared logs.
		const keys =
			payload && typeof payload === 'object'
				? Object.keys(payload as object).join(', ')
				: typeof payload
		// error, not warn: unlike an outage this never recovers on its own. The
		// catalog silently staying empty is exactly how the field-name mismatch
		// that shipped in the first cut of this client went unnoticed.
		logger.error('OpenConnector provider response failed schema validation', {
			topLevelKeys: keys,
			issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
		})
		return null
	}

	return unwrap(parsed.data).map((p) => ({
		id: p.service,
		name: p.displayName,
		// The runtime returns an ordered category list; the first is the
		// primary facet and becomes the marketplace filter chip via use_case.
		category: p.categories?.[0]?.displayName ?? null,
		iconUrl: p.iconUrl ?? null,
		homepageUrl: p.homepageUrl ?? null,
		scenario: p.scenario ?? null,
		authTypes: p.authTypes ?? [],
	}))
}
