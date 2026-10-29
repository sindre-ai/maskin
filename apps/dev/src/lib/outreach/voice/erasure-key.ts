import { createHmac } from 'node:crypto'
import { z } from '@hono/zod-openapi'

/**
 * Key and HMAC for the erasure suppression marker (voice outreach errata section 9). This file
 * knows nothing about where the marker is stored: dnc-gate.ts owns the field name and the dial
 * check, the retention sweep owns the write.
 */

export const MIN_ERASURE_KEY_BYTES = 32

/** Prefix on the stored value, so a key rotation can be told apart from the old markers. */
export const ERASURE_MARKER_PREFIX = 'v1:'

export type ErasureKey = { ok: true; key: Buffer } | { ok: false; reason: string }

const keySchema = z
	.string()
	.refine(
		(v) => Buffer.byteLength(v, 'utf8') >= MIN_ERASURE_KEY_BYTES,
		`is shorter than ${MIN_ERASURE_KEY_BYTES} bytes`,
	)

/**
 * Zod-parse VOICE_ERASURE_MARKER_KEY once at startup. Missing, blank or short is not a startup
 * failure: it comes back as a reason, the dial check refuses on it, and erasure writes no marker.
 * The reason never contains the key.
 */
export function parseErasureKey(raw: string | undefined): ErasureKey {
	const value = raw?.trim() ?? ''
	if (value === '') return { ok: false, reason: 'VOICE_ERASURE_MARKER_KEY is not set' }
	const parsed = keySchema.safeParse(value)
	if (!parsed.success) {
		return {
			ok: false,
			reason: `VOICE_ERASURE_MARKER_KEY ${parsed.error.issues[0]?.message ?? 'is invalid'}`,
		}
	}
	return { ok: true, key: Buffer.from(parsed.data, 'utf8') }
}

/** "v1:" plus the hex HMAC-SHA-256 of an already normalised E.164 number. */
export function computeErasureMarker(e164: string, key: Buffer): string {
	return `${ERASURE_MARKER_PREFIX}${createHmac('sha256', key).update(e164, 'utf8').digest('hex')}`
}
