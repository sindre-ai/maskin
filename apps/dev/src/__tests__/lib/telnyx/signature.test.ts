import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	TELNYX_TIMESTAMP_TOLERANCE_S,
	verifyTelnyxSignature,
} from '../../../lib/integrations/providers/telnyx/signature'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
// Telnyx publishes the raw 32-byte key as base64; the SPKI DER tail is the raw key.
const rawPublicKeyB64 = publicKey
	.export({ format: 'der', type: 'spki' })
	.subarray(-32)
	.toString('base64')

function signed(body: string, ts: number) {
	const signature = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64')
	return { signatureHeader: signature, timestampHeader: String(ts) }
}

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

describe('verifyTelnyxSignature', () => {
	const body = JSON.stringify({ data: { id: 'evt_1', event_type: 'call.answered' } })

	it('accepts a valid signature', () => {
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, NOW_S),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBeNull()
	})

	it('accepts an SPKI DER public key as well as the raw one', () => {
		const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, NOW_S),
				publicKey: spki,
				nowMs: NOW_MS,
			}),
		).toBeNull()
	})

	it('rejects a missing signature or timestamp header', () => {
		const { signatureHeader, timestampHeader } = signed(body, NOW_S)
		const base = { rawBody: body, publicKey: rawPublicKeyB64, nowMs: NOW_MS }
		expect(verifyTelnyxSignature({ ...base, signatureHeader: undefined, timestampHeader })).toBe(
			'missing_header',
		)
		expect(verifyTelnyxSignature({ ...base, signatureHeader, timestampHeader: undefined })).toBe(
			'missing_header',
		)
	})

	it('rejects a signature from a different key', () => {
		const other = generateKeyPairSync('ed25519')
		const signature = sign(null, Buffer.from(`${NOW_S}|${body}`), other.privateKey).toString(
			'base64',
		)
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				signatureHeader: signature,
				timestampHeader: String(NOW_S),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('bad_signature')
	})

	it('rejects a tampered body', () => {
		expect(
			verifyTelnyxSignature({
				rawBody: `${body} `,
				...signed(body, NOW_S),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('bad_signature')
	})

	it('rejects garbage in the signature header without throwing', () => {
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				signatureHeader: '!!not-base64!!',
				timestampHeader: String(NOW_S),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('bad_signature')
	})

	it('rejects timestamps more than 300s away, in either direction', () => {
		const past = NOW_S - TELNYX_TIMESTAMP_TOLERANCE_S - 1
		const future = NOW_S + TELNYX_TIMESTAMP_TOLERANCE_S + 1
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, past),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('stale_timestamp')
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, future),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('stale_timestamp')
	})

	it('accepts a timestamp exactly at the 300s edge', () => {
		const edge = NOW_S - TELNYX_TIMESTAMP_TOLERANCE_S
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, edge),
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBeNull()
	})

	it('rejects a non-numeric timestamp', () => {
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				signatureHeader: 'AAAA',
				timestampHeader: 'yesterday',
				publicKey: rawPublicKeyB64,
				nowMs: NOW_MS,
			}),
		).toBe('stale_timestamp')
	})

	it('fails closed when no public key is configured', () => {
		expect(
			verifyTelnyxSignature({
				rawBody: body,
				...signed(body, NOW_S),
				publicKey: null,
				nowMs: NOW_MS,
			}),
		).toBe('no_public_key')
	})
})
