import { type KeyObject, createPublicKey, verify } from 'node:crypto'

/** Replay window: events whose timestamp is more than this far from now are rejected. */
export const TELNYX_TIMESTAMP_TOLERANCE_S = 300

// DER prefix that turns a raw 32-byte Ed25519 public key into an SPKI structure.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

let cached: { source: string; key: KeyObject } | null = null

/**
 * Telnyx publishes the account public key as base64 of the raw 32 bytes. An
 * SPKI DER key is accepted too. Parsed once and cached per distinct value.
 */
export function loadTelnyxPublicKey(base64Key: string): KeyObject {
	if (cached && cached.source === base64Key) return cached.key
	const raw = Buffer.from(base64Key, 'base64')
	const key =
		raw.length === 32
			? createPublicKey({
					key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
					format: 'der',
					type: 'spki',
				})
			: createPublicKey({ key: raw, format: 'der', type: 'spki' })
	cached = { source: base64Key, key }
	return key
}

export type SignatureFailure =
	| 'missing_header'
	| 'stale_timestamp'
	| 'bad_signature'
	| 'no_public_key'

export interface VerifyTelnyxSignatureInput {
	rawBody: string
	signatureHeader: string | undefined
	timestampHeader: string | undefined
	publicKey: string | null
	nowMs?: number
}

/**
 * Ed25519 over `${timestamp}|${rawBody}`, base64 signature. Null means valid.
 * Fails closed: an unconfigured public key rejects everything.
 */
export function verifyTelnyxSignature(input: VerifyTelnyxSignatureInput): SignatureFailure | null {
	if (!input.signatureHeader || !input.timestampHeader) return 'missing_header'
	if (!input.publicKey) return 'no_public_key'

	const ts = Number(input.timestampHeader)
	if (!Number.isFinite(ts)) return 'stale_timestamp'
	const nowS = (input.nowMs ?? Date.now()) / 1000
	if (Math.abs(nowS - ts) > TELNYX_TIMESTAMP_TOLERANCE_S) return 'stale_timestamp'

	try {
		const ok = verify(
			null,
			Buffer.from(`${input.timestampHeader}|${input.rawBody}`, 'utf8'),
			loadTelnyxPublicKey(input.publicKey),
			Buffer.from(input.signatureHeader, 'base64'),
		)
		return ok ? null : 'bad_signature'
	} catch {
		return 'bad_signature'
	}
}
