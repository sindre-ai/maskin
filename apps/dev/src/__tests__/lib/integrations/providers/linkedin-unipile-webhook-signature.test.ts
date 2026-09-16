import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	UNIPILE_SIGNATURE_MAX_AGE_SEC,
	verifyUnipileWebhookSignature,
} from '../../../../lib/integrations/providers/linkedin-unipile/webhook-signature'

/**
 * R11-C · Unipile v2 webhook signature verification unit coverage.
 *
 * Pins the invariants that keep the /api/integrations/linkedin-unipile/webhook
 * route safe:
 *
 *   1. Correct HMAC over `${t}.${rawBody}` with the endpoint secret is
 *      accepted.
 *   2. Any tamper — body, timestamp, signature bytes — is rejected.
 *   3. Timestamps outside the ±5-min replay window are rejected even if
 *      the HMAC is otherwise valid.
 *   4. Header casing does NOT matter here (the route reads both spellings
 *      before calling the verifier), but a malformed header value (bad
 *      key syntax, non-hex v0, non-numeric t) is rejected uniformly.
 *
 * Doubles as the executable spec of Unipile's format so a future
 * upstream change fails the suite loudly instead of silently
 * mis-authenticating.
 */

const SECRET = 'wes_01testendpointsecret'
const NOW_MS = 1_710_662_400_000 // fixed clock so timestamp maths are deterministic

function signValid(rawBody: string, tSec: number, secret: string = SECRET): string {
	const v0 = createHmac('sha256', secret).update(`${tSec}.${rawBody}`).digest('hex')
	return `t=${tSec},v0=${v0}`
}

describe('verifyUnipileWebhookSignature', () => {
	it('accepts a well-formed signature computed with the endpoint secret', () => {
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const t = Math.floor(NOW_MS / 1000)
		expect(verifyUnipileWebhookSignature(body, signValid(body, t), SECRET, NOW_MS)).toEqual({
			ok: true,
		})
	})

	it('accepts extra unknown kv-pairs in the header (forward-compat with v1, v2, …)', () => {
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const t = Math.floor(NOW_MS / 1000)
		const v0 = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')
		// Interleave a hypothetical future `v1=` and a `debug=` field.
		const header = `debug=whatever,t=${t},v1=deadbeef,v0=${v0}`
		expect(verifyUnipileWebhookSignature(body, header, SECRET, NOW_MS)).toEqual({ ok: true })
	})

	it('rejects when the header is missing', () => {
		const body = '{}'
		expect(verifyUnipileWebhookSignature(body, undefined, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'missing-header',
		})
		expect(verifyUnipileWebhookSignature(body, null, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'missing-header',
		})
		expect(verifyUnipileWebhookSignature(body, '', SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'missing-header',
		})
	})

	it('rejects a header missing v0', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000)
		expect(verifyUnipileWebhookSignature(body, `t=${t}`, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'malformed-header',
		})
	})

	it('rejects a header missing t', () => {
		const body = '{}'
		const v0 = createHmac('sha256', SECRET).update(`0.${body}`).digest('hex')
		expect(verifyUnipileWebhookSignature(body, `v0=${v0}`, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'malformed-header',
		})
	})

	it('rejects a non-numeric t', () => {
		const body = '{}'
		expect(verifyUnipileWebhookSignature(body, 't=notanumber,v0=deadbeef', SECRET, NOW_MS)).toEqual(
			{ ok: false, reason: 'malformed-header' },
		)
	})

	it('rejects a non-hex v0', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000)
		expect(verifyUnipileWebhookSignature(body, `t=${t},v0=NOT_HEX_xyz!!!`, SECRET, NOW_MS)).toEqual(
			{ ok: false, reason: 'malformed-header' },
		)
	})

	it('rejects a header with a bare token (no =)', () => {
		expect(verifyUnipileWebhookSignature('{}', 'garbage', SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'malformed-header',
		})
	})

	it('rejects when the timestamp is older than the max-age window', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000) - UNIPILE_SIGNATURE_MAX_AGE_SEC - 1
		expect(verifyUnipileWebhookSignature(body, signValid(body, t), SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'timestamp-out-of-window',
		})
	})

	it('rejects when the timestamp is far in the future (skew guard both directions)', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000) + UNIPILE_SIGNATURE_MAX_AGE_SEC + 1
		expect(verifyUnipileWebhookSignature(body, signValid(body, t), SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'timestamp-out-of-window',
		})
	})

	it('accepts a timestamp exactly at the window edge', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000) - UNIPILE_SIGNATURE_MAX_AGE_SEC
		expect(verifyUnipileWebhookSignature(body, signValid(body, t), SECRET, NOW_MS)).toEqual({
			ok: true,
		})
	})

	it('rejects a tampered body (same signature, changed byte)', () => {
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const t = Math.floor(NOW_MS / 1000)
		const header = signValid(body, t)
		const tamperedBody = body.replace('acc_1', 'acc_2')
		expect(verifyUnipileWebhookSignature(tamperedBody, header, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'signature-mismatch',
		})
	})

	it('rejects when computed with a different secret', () => {
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const t = Math.floor(NOW_MS / 1000)
		const attackerHeader = signValid(body, t, 'wes_wrongsecret')
		expect(verifyUnipileWebhookSignature(body, attackerHeader, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'signature-mismatch',
		})
	})

	it('rejects when v0 length differs from the expected hex length (truncated signature)', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000)
		const truncated = signValid(body, t).slice(0, -10) // chop 10 chars off v0
		expect(verifyUnipileWebhookSignature(body, truncated, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'signature-mismatch',
		})
	})

	it('is case-insensitive on the v0 hex encoding', () => {
		const body = '{}'
		const t = Math.floor(NOW_MS / 1000)
		const v0 = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex').toUpperCase()
		expect(verifyUnipileWebhookSignature(body, `t=${t},v0=${v0}`, SECRET, NOW_MS)).toEqual({
			ok: true,
		})
	})

	it('verifies against the RAW body byte-for-byte (whitespace in JSON matters)', () => {
		// The route MUST verify against the raw body received on the wire, not
		// a parse-then-serialise round-trip. This test pins that discipline by
		// signing one whitespace-heavy body and asserting that a
		// pretty-printed version fails.
		const rawBody = '{"type":"account.reconnect","account_id":"acc_1"}'
		const t = Math.floor(NOW_MS / 1000)
		const header = signValid(rawBody, t)
		const reserialised = JSON.stringify(JSON.parse(rawBody), null, 2)
		expect(reserialised).not.toBe(rawBody) // sanity — the two strings really do differ
		expect(verifyUnipileWebhookSignature(reserialised, header, SECRET, NOW_MS)).toEqual({
			ok: false,
			reason: 'signature-mismatch',
		})
	})
})
