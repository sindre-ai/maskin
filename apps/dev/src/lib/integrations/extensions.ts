import { createHash, randomBytes } from 'node:crypto'
import {
	MAX_EXTENSION_TOOLS,
	type McpConfig,
	type ToolGrant,
	type WebhookConfig,
	evalJsonPath,
} from '@maskin/shared'
import type { WebhookConfig as VerifierConfig } from './types'
import type { WebhookHandler } from './webhooks/handler'
import { verifyTimestampSignature } from './webhooks/signatures'

// The cap itself lives in @maskin/shared so the write schema and the runtime share it.
export { MAX_EXTENSION_TOOLS }

/**
 * Plain reason an mcp_config cannot be saved, or null when it can. The tool cap
 * is already enforced by the Zod body schema (400 with a field error); this
 * covers what the schema deliberately still accepts: the http variant, which V1
 * does not run.
 */
export function mcpConfigWriteError(config: McpConfig | null | undefined): string | null {
	if (config && config.server.type !== 'stdio') {
		return 'Only stdio MCP servers are supported for now. HTTP-transport-only vendors cannot be added yet.'
	}
	return null
}

/** integrations.provider / webhook_deliveries.provider value for an extension. */
export function extensionProvider(slug: string): string {
	return `extension:${slug}`
}

/** Opaque URL segment for POST /api/webhooks/x/:token (32 random bytes, base64url). */
export function generateWebhookToken(): string {
	return randomBytes(32).toString('base64url')
}

/** Signing secret to paste into the vendor (32 random bytes, hex). */
export function generateSigningSecret(): string {
	return randomBytes(32).toString('hex')
}

/** Effect of a stored grant value; the object form's expiry is not enforced yet. */
export function grantEffect(grant: ToolGrant): 'allow' | 'deny' {
	return typeof grant === 'string' ? grant : grant.effect
}

/**
 * What granting an agent starts from: every declared tool gets a default from
 * its kind (read allow, write deny). Written out in full at grant time, because
 * the launch policy only allows tools it finds listed as allow.
 */
export function defaultToolGrants(
	tools: ReadonlyArray<{ name: string; kind: 'read' | 'write' }>,
): Record<string, 'allow' | 'deny'> {
	const out: Record<string, 'allow' | 'deny'> = {}
	for (const t of tools) out[t.name] = t.kind === 'read' ? 'allow' : 'deny'
	return out
}

// JSONPath subset lives in @maskin/shared so the settings UI validates with the same parser.
export { evalJsonPath, parseJsonPath } from '@maskin/shared'

export type MappedEvent = {
	externalId: string
	entityType: string
	action: string
	data: unknown
}

export type MapResult =
	| { ok: true; event: MappedEvent }
	| { ok: false; field: 'externalId' | 'entityType' | 'action' | 'data'; message: string }

function scalarToString(v: unknown): string | null {
	if (typeof v === 'string') return v.length > 0 ? v : null
	if (typeof v === 'number' || typeof v === 'boolean') return String(v)
	return null
}

/** Apply a webhook config's event map to a parsed payload. */
export function mapWebhookEvent(eventMap: WebhookConfig['eventMap'], payload: unknown): MapResult {
	const externalId = scalarToString(evalJsonPath(payload, eventMap.externalIdPath))
	if (externalId === null) {
		return {
			ok: false,
			field: 'externalId',
			message: `External ID path ${eventMap.externalIdPath} did not resolve to a value in this payload`,
		}
	}

	const resolve = (
		field: 'entityType' | 'action',
		src: { literal: string } | { path: string },
	): string | MapResult => {
		if ('literal' in src) return src.literal
		const value = scalarToString(evalJsonPath(payload, src.path))
		if (value === null) {
			return {
				ok: false,
				field,
				message: `Path ${src.path} did not resolve to a value in this payload`,
			}
		}
		return value
	}

	const entityType = resolve('entityType', eventMap.entityType)
	if (typeof entityType !== 'string') return entityType
	const action = resolve('action', eventMap.action)
	if (typeof action !== 'string') return action

	let data: unknown = payload
	if (eventMap.dataPath) {
		data = evalJsonPath(payload, eventMap.dataPath)
		if (data === undefined) {
			return {
				ok: false,
				field: 'data',
				message: `Data path ${eventMap.dataPath} did not resolve to a value in this payload`,
			}
		}
	}
	return { ok: true, event: { externalId, entityType, action, data } }
}

// ── Per-token rate limit ────────────────────────────────────────────────────
// In-memory fixed window per webhook token. Defensive only (one process, resets
// on restart), matching the "60 a minute, no Redis" decision in the tech spec.

const WINDOW_MS = 60_000
const MAX_TRACKED_TOKENS = 5_000
const windows = new Map<string, { start: number; count: number }>()

export function allowWebhookRequest(token: string, perMinute: number, now = Date.now()): boolean {
	const w = windows.get(token)
	if (!w || now - w.start >= WINDOW_MS) {
		if (!w && windows.size >= MAX_TRACKED_TOKENS) {
			const oldest = windows.keys().next().value
			if (oldest !== undefined) windows.delete(oldest)
		}
		windows.set(token, { start: now, count: 1 })
		return true
	}
	if (w.count >= perMinute) return false
	w.count += 1
	return true
}

export function resetWebhookRateLimits(): void {
	windows.clear()
}

/**
 * events.entity_id is a uuid, but a vendor's delivery id is any string. Derive a
 * stable uuid (v5 layout, SHA-1 of extension id + external id) so repeat
 * deliveries about the same vendor entity share one entity id.
 */
export function deliveryEntityId(extensionId: string, externalId: string): string {
	const h = createHash('sha1').update(`${extensionId}:${externalId}`).digest()
	h[6] = ((h[6] ?? 0) & 0x0f) | 0x50
	h[8] = ((h[8] ?? 0) & 0x3f) | 0x80
	const hex = h.subarray(0, 16).toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// ── Signature check ─────────────────────────────────────────────────────────

/**
 * Check a delivery against an extension's webhook_config using the secret the
 * caller already resolved. Header names are matched lowercased, the way the
 * route builds its header map. The timestamp scheme is checked here with the
 * extension's own maxAgeSeconds; the raw-body schemes go through the shared
 * WebhookHandler.
 */
export function verifyExtensionSignature(
	handler: WebhookHandler,
	config: WebhookConfig,
	body: string,
	headers: Record<string, string>,
	secret: string,
): boolean {
	const signatureHeader = config.signatureHeader.toLowerCase()
	if (config.signatureScheme === 'timestamp') {
		if (!config.timestampHeader || !config.timestampBodyTemplate) {
			throw new Error(
				'timestampHeader and timestampBodyTemplate are required for the timestamp scheme',
			)
		}
		return verifyTimestampSignature(body, headers, secret, {
			timestampHeader: config.timestampHeader.toLowerCase(),
			signatureHeader,
			// The spec's {ts} and the verifier's {timestamp} mean the same thing.
			bodyTemplate: config.timestampBodyTemplate.replace('{ts}', '{timestamp}'),
			signaturePrefix: config.signaturePrefix,
			maxAgeSeconds: config.maxAgeSeconds,
		})
	}
	const verifierConfig: VerifierConfig = {
		signatureHeader,
		signatureScheme: config.signatureScheme,
		signaturePrefix: config.signaturePrefix,
		// The secret is passed in; the env name is never read.
		secretEnv: '',
	}
	return handler.verify(verifierConfig, body, headers, { secret })
}

/**
 * Replay window for the raw-body schemes: when the config names a timestamp
 * header and the delivery carries one, reject anything older (or further in the
 * future) than maxAgeSeconds. The timestamp scheme already does this inside
 * the verifier. Vendors with no timestamp header (Fireflies) have no replay
 * window beyond the 14-day idempotency ledger.
 */
export function isStaleDelivery(
	config: WebhookConfig,
	headers: Record<string, string>,
	nowMs = Date.now(),
): boolean {
	if (config.signatureScheme === 'timestamp' || !config.timestampHeader) return false
	const raw = headers[config.timestampHeader.toLowerCase()]
	if (!raw) return false
	const n = Number(raw)
	if (!Number.isFinite(n)) return true
	const seconds = n > 1e12 ? n / 1000 : n
	return Math.abs(nowMs / 1000 - seconds) > config.maxAgeSeconds
}
