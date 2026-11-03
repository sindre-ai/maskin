import { logger } from './logger'

/**
 * Per-token USD prices for one model, as published by OpenRouter's
 * `GET /api/v1/models` (public, unauthenticated).
 *
 * All four fields are USD per single token (not per million). `cacheRead` and
 * `cacheWrite` are 0 when the catalogue publishes no price for that field —
 * the OpenRouter shape names them `input_cache_read` / `input_cache_write`
 * (older rows used `cache_read` / `cache_write`), and several models, including
 * `deepseek/deepseek-v4-flash`, publish no cache-write price at all.
 */
export interface ModelPricing {
	prompt: number
	completion: number
	cacheRead: number
	cacheWrite: number
}

/** Priced catalogue for one fetch, plus the wall-clock ms it was fetched at. */
interface PricingCache {
	fetchedAt: number
	models: Map<string, ModelPricing>
}

const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

let cache: PricingCache | null = null
let inFlight: Promise<PricingCache | null> | null = null

const asPrice = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) && n >= 0 ? n : null
}

/** Reads a price that may appear under its current or legacy catalogue key. */
const optionalPrice = (pricing: Record<string, unknown>, ...keys: string[]): number => {
	for (const key of keys) {
		const parsed = asPrice(pricing[key])
		if (parsed !== null) return parsed
	}
	return 0
}

/**
 * Parses the catalogue payload into a model-id → pricing map. A model whose
 * `prompt` or `completion` price is absent or unparseable is dropped rather
 * than defaulted to 0 — an unpriced model must read as unknown (and fall back
 * to the legacy token rate) instead of silently costing nothing.
 */
function parseCatalogue(payload: unknown): Map<string, ModelPricing> | null {
	if (typeof payload !== 'object' || payload === null) return null
	const data = (payload as { data?: unknown }).data
	if (!Array.isArray(data)) return null

	const models = new Map<string, ModelPricing>()
	for (const entry of data) {
		if (typeof entry !== 'object' || entry === null) continue
		const row = entry as { id?: unknown; pricing?: unknown }
		if (typeof row.id !== 'string' || row.id.length === 0) continue
		if (typeof row.pricing !== 'object' || row.pricing === null) continue
		const pricing = row.pricing as Record<string, unknown>
		const prompt = asPrice(pricing.prompt)
		const completion = asPrice(pricing.completion)
		if (prompt === null || completion === null) continue
		models.set(row.id, {
			prompt,
			completion,
			cacheRead: optionalPrice(pricing, 'input_cache_read', 'cache_read'),
			cacheWrite: optionalPrice(pricing, 'input_cache_write', 'cache_write'),
		})
	}
	return models.size > 0 ? models : null
}

async function fetchCatalogue(): Promise<PricingCache | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const res = await fetch(MODELS_ENDPOINT, { signal: controller.signal })
		if (!res.ok) {
			logger.error('pricing_malformed', { status: res.status, reason: 'non_ok_response' })
			return null
		}
		const models = parseCatalogue(await res.json())
		if (!models) {
			logger.error('pricing_malformed', { reason: 'unexpected_payload_shape' })
			return null
		}
		return { fetchedAt: Date.now(), models }
	} catch (err) {
		logger.error('pricing_malformed', { reason: 'fetch_failed', error: String(err) })
		return null
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Refreshes the in-process catalogue. Exported so tests can drive the cache
 * directly; runtime callers go through `getModelPricing`.
 */
export async function refreshPricing(): Promise<Map<string, ModelPricing> | null> {
	if (inFlight) return (await inFlight)?.models ?? null
	inFlight = fetchCatalogue()
	try {
		const fresh = await inFlight
		if (fresh) cache = fresh
		return fresh ? fresh.models : null
	} finally {
		inFlight = null
	}
}

/** Kicks off a background refresh, logging only if it can't land. */
function refreshInBackground(): void {
	void refreshPricing().then((models) => {
		if (!models) {
			logger.warn('pricing_refresh_stale', {
				servedAgeMs: cache ? Date.now() - cache.fetchedAt : null,
			})
		}
	})
}

/** Per-model endpoint prices (one row per host serving the model), cached like the catalogue. */
interface EndpointPricing {
	/** Lower-case host slug, as OpenRouter spells it in provider.only (e.g. "gmicloud"). */
	provider: string
	pricing: ModelPricing
}

const endpointCache = new Map<string, { fetchedAt: number; endpoints: EndpointPricing[] }>()

/**
 * Parses `GET /api/v1/models/{id}/endpoints`. The host slug is the part of the
 * endpoint `tag` before the first "/" ("gmicloud/fp8" -> "gmicloud"). Endpoints
 * without a prompt or completion price are dropped, as in `parseCatalogue`.
 */
function parseEndpoints(payload: unknown): EndpointPricing[] | null {
	if (typeof payload !== 'object' || payload === null) return null
	const data = (payload as { data?: { endpoints?: unknown } }).data
	if (!data || !Array.isArray(data.endpoints)) return null
	const out: EndpointPricing[] = []
	for (const entry of data.endpoints) {
		if (typeof entry !== 'object' || entry === null) continue
		const row = entry as { tag?: unknown; provider_name?: unknown; pricing?: unknown }
		const slugSource = typeof row.tag === 'string' ? row.tag : row.provider_name
		if (typeof slugSource !== 'string' || slugSource.length === 0) continue
		if (typeof row.pricing !== 'object' || row.pricing === null) continue
		const pricing = row.pricing as Record<string, unknown>
		const prompt = asPrice(pricing.prompt)
		const completion = asPrice(pricing.completion)
		if (prompt === null || completion === null) continue
		out.push({
			provider: (slugSource.split('/')[0] ?? '').replace(/\s+/g, '').toLowerCase(),
			pricing: {
				prompt,
				completion,
				cacheRead: optionalPrice(pricing, 'input_cache_read', 'cache_read'),
				cacheWrite: optionalPrice(pricing, 'input_cache_write', 'cache_write'),
			},
		})
	}
	return out.length > 0 ? out : null
}

async function fetchEndpoints(id: string): Promise<EndpointPricing[] | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const res = await fetch(`${MODELS_ENDPOINT}/${id}/endpoints`, { signal: controller.signal })
		if (!res.ok) {
			logger.warn('pricing_endpoints_unavailable', { model: id, status: res.status })
			return null
		}
		return parseEndpoints(await res.json())
	} catch (err) {
		logger.warn('pricing_endpoints_unavailable', { model: id, error: String(err) })
		return null
	} finally {
		clearTimeout(timer)
	}
}

/** Mean of each price field across the given endpoints. */
function meanPricing(endpoints: ModelPricing[]): ModelPricing {
	const mean = (pick: (p: ModelPricing) => number) =>
		endpoints.reduce((sum, p) => sum + pick(p), 0) / endpoints.length
	return {
		prompt: mean((p) => p.prompt),
		completion: mean((p) => p.completion),
		cacheRead: mean((p) => p.cacheRead),
		cacheWrite: mean((p) => p.cacheWrite),
	}
}

/**
 * Per-token pricing for the hosts that actually serve funded requests.
 *
 * The catalogue price (`getModelPricing`) is the cheapest host's headline price,
 * but funded requests are pinned to `provider.only` hosts chosen for speed, and
 * those bill several times more (DigitalOcean and GMICloud charged about 4x the
 * catalogue price on uncached input in October 2026). Pricing from the catalogue
 * therefore under-counted spend by about half against OpenRouter's invoice.
 *
 * Returns the mean price over the model's endpoints whose host is in `providers`,
 * which tracks the observed split between them (requests alternate and fail
 * over). Falls back to the catalogue price when `providers` is empty, the
 * endpoint list is unreachable, or none of the hosts serve the model, so a
 * session is never priced at zero for lack of endpoint data.
 */
export async function getServedModelPricing(
	id: string,
	providers: string[],
): Promise<ModelPricing | null> {
	const wanted = providers.map((p) => p.trim().toLowerCase()).filter(Boolean)
	if (wanted.length === 0) return getModelPricing(id)

	const now = Date.now()
	let hit = endpointCache.get(id)
	if (!hit || now - hit.fetchedAt >= CACHE_TTL_MS) {
		const endpoints = await fetchEndpoints(id)
		if (endpoints) {
			hit = { fetchedAt: now, endpoints }
			endpointCache.set(id, hit)
		}
		// A failed refresh keeps serving the stale list rather than dropping to the catalogue.
	}
	const served = hit?.endpoints.filter((e) => wanted.includes(e.provider)) ?? []
	if (served.length === 0) return getModelPricing(id)
	return meanPricing(served.map((e) => e.pricing))
}

/**
 * Returns OpenRouter's per-token pricing for a model id, or null when the
 * catalogue has no entry for it (the caller then prices with the legacy token
 * rate rather than treating the usage as free).
 *
 * The catalogue is fetched on first use, cached in-process for one hour, and
 * thereafter served stale-while-refresh: a stale cache answers the current
 * call immediately and refreshes in the background, so cost accounting never
 * blocks a session lifecycle on a network round trip.
 */
export async function getModelPricing(id: string): Promise<ModelPricing | null> {
	const now = Date.now()

	if (!cache) {
		const models = await refreshPricing()
		if (!models) {
			logger.error('pricing_cold_fallback', { model: id })
			return null
		}
	} else if (now - cache.fetchedAt >= CACHE_TTL_MS) {
		refreshInBackground()
	}

	const pricing = cache?.models.get(id)
	if (!pricing) {
		logger.warn('pricing_unknown_model', { model: id })
		return null
	}
	return pricing
}

/** Test-only: clears the in-process catalogue and any in-flight refresh. */
export function resetPricingCache(): void {
	cache = null
	inFlight = null
	endpointCache.clear()
}
