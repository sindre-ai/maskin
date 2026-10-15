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
}
