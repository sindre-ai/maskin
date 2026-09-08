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

/** The subset of each provider that Maskin actually renders or installs. */
export interface OpenConnectorProvider {
	id: string
	name: string
	category: string | null
	iconUrl: string | null
	description: string | null
	actionCount: number
}

// Deliberately permissive: `id` and `name` are the only fields we cannot
// render a card without, so everything else is optional and degrades to null
// rather than dropping the provider. `.passthrough()` keeps unknown fields
// from failing the parse — OpenConnector adding a field must not empty our
// catalog overnight.
const providerSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		category: z.string().nullish(),
		iconUrl: z.string().nullish(),
		description: z.string().nullish(),
		actionCount: z.number().int().nonnegative().nullish(),
	})
	.passthrough()

// Accept either a bare array or the common `{ providers: [...] }` / `{ data:
// [...] }` envelopes, so a wrapper shape doesn't read as "catalog is empty".
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
		logger.warn('OpenConnector provider response failed schema validation', {
			topLevelKeys: keys,
		})
		return null
	}

	return unwrap(parsed.data).map((p) => ({
		id: p.id,
		name: p.name,
		category: p.category ?? null,
		iconUrl: p.iconUrl ?? null,
		description: p.description ?? null,
		actionCount: p.actionCount ?? 0,
	}))
}
