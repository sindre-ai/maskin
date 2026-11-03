import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Resend webhook delivery signed by Svix.
 *
 * Kept out of `webhooks/signatures.ts` on purpose: the three declarative schemes
 * there (`hmac-sha256`, `hmac-sha1`, `timestamp`) cannot express Svix — base64
 * (not hex), base64-decoded secret (not raw), signing string `id.ts.body` (not
 * templated), and a space-separated candidate list for secret rotation.
 * Extending them for one provider over-fits; a per-provider verifier is the
 * smaller edit. Called INLINE from the `/resend/:token` route because it needs
 * the per-row `whsec_...` secret, which the `(body, headers) => boolean`
 * signature of `ResolvedProvider.customWebhookVerifier` cannot reach.
 */
export function verifyResendSvix(
	body: string,
	headers: Record<string, string>,
	secret: string,
): boolean {
	const id = headers['svix-id']
	const ts = headers['svix-timestamp']
	const sigHeader = headers['svix-signature']
	if (!id || !ts || !sigHeader) return false

	const tsNum = Number(ts)
	if (!Number.isFinite(tsNum)) return false
	const ageSeconds = Math.abs(Date.now() / 1000 - tsNum)
	if (ageSeconds > 300) return false

	if (!secret.startsWith('whsec_')) return false
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64')

	const signingString = `${id}.${ts}.${body}`
	const expected = createHmac('sha256', key).update(signingString).digest('base64')
	const expectedBuf = Buffer.from(expected)

	const candidates = sigHeader
		.split(' ')
		.map((s) => s.trim())
		.filter((s) => s.startsWith('v1,'))
	for (const candidate of candidates) {
		const provided = Buffer.from(candidate.slice('v1,'.length))
		if (provided.length !== expectedBuf.length) continue
		if (timingSafeEqual(provided, expectedBuf)) return true
	}
	return false
}
