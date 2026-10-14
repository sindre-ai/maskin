import { createHmac, randomBytes } from 'node:crypto'
import { verifyResendSvix } from '../../../../../lib/integrations/providers/resend/svix'

function signPayload(secret: string, id: string, ts: string, body: string): string {
	if (!secret.startsWith('whsec_')) throw new Error('test secret must start with whsec_')
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
	return createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
}

function whsecFromRandomKey(): string {
	return `whsec_${randomBytes(32).toString('base64')}`
}

function nowTs(): string {
	return String(Math.floor(Date.now() / 1000))
}

describe('verifyResendSvix', () => {
	it('returns true for a valid Svix headers + secret combination', () => {
		const secret = whsecFromRandomKey()
		const id = 'msg_test_1'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_1' } })
		const sig = signPayload(secret, id, ts, body)

		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v1,${sig}`,
				},
				secret,
			),
		).toBe(true)
	})

	it('returns false when the body is tampered', () => {
		const secret = whsecFromRandomKey()
		const id = 'msg_test_2'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_2' } })
		const sig = signPayload(secret, id, ts, body)
		const tamperedBody = body.replace('e_2', 'e_2_tampered')

		expect(
			verifyResendSvix(
				tamperedBody,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v1,${sig}`,
				},
				secret,
			),
		).toBe(false)
	})

	it('returns false when the signature is tampered', () => {
		const secret = whsecFromRandomKey()
		const id = 'msg_test_3'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_3' } })
		const sig = signPayload(secret, id, ts, body)
		const tamperedSig = `${sig.slice(0, -4)}XXXX`

		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v1,${tamperedSig}`,
				},
				secret,
			),
		).toBe(false)
	})

	it.each(['svix-id', 'svix-timestamp', 'svix-signature'] as const)(
		'returns false when %s header is missing',
		(missing) => {
			const secret = whsecFromRandomKey()
			const id = 'msg_test_4'
			const ts = nowTs()
			const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_4' } })
			const sig = signPayload(secret, id, ts, body)
			const headers: Record<string, string> = {
				'svix-id': id,
				'svix-timestamp': ts,
				'svix-signature': `v1,${sig}`,
			}
			delete headers[missing]

			expect(verifyResendSvix(body, headers, secret)).toBe(false)
		},
	)

	it('returns false when the timestamp is older than 300s', () => {
		const secret = whsecFromRandomKey()
		const id = 'msg_test_5'
		const staleTs = String(Math.floor(Date.now() / 1000) - 301)
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_5' } })
		const sig = signPayload(secret, id, staleTs, body)

		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': staleTs,
					'svix-signature': `v1,${sig}`,
				},
				secret,
			),
		).toBe(false)
	})

	it('returns true when the signature header carries several v1 candidates and any matches (rotated secret)', () => {
		const activeSecret = whsecFromRandomKey()
		const previousSecret = whsecFromRandomKey()
		const id = 'msg_test_6'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_6' } })
		const sigWithPrevious = signPayload(previousSecret, id, ts, body)
		const sigWithActive = signPayload(activeSecret, id, ts, body)

		// Header carries BOTH — the previous secret's signature first, the active
		// one second. Only the active-secret candidate matches; verifier must
		// still return true because at least one candidate is valid.
		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v1,${sigWithPrevious} v1,${sigWithActive}`,
				},
				activeSecret,
			),
		).toBe(true)
	})

	it('returns false when the secret does not have the whsec_ prefix', () => {
		const rawKey = randomBytes(32).toString('base64')
		const id = 'msg_test_7'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_7' } })
		// Sign with what would be the correct decoded key so the sig is otherwise valid;
		// verifier still refuses because the secret carries no whsec_ prefix.
		const key = Buffer.from(rawKey, 'base64')
		const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')

		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v1,${sig}`,
				},
				rawKey,
			),
		).toBe(false)
	})

	it('returns false when no v1 candidate exists in the signature header', () => {
		const secret = whsecFromRandomKey()
		const id = 'msg_test_8'
		const ts = nowTs()
		const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e_8' } })
		const sig = signPayload(secret, id, ts, body)

		expect(
			verifyResendSvix(
				body,
				{
					'svix-id': id,
					'svix-timestamp': ts,
					'svix-signature': `v2,${sig}`,
				},
				secret,
			),
		).toBe(false)
	})
})
