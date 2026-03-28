import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'recall',
	displayName: 'Recall.ai',
	description: 'Send bots to join and record video meetings',

	auth: {
		type: 'api_key',
		config: {
			headerName: 'Authorization',
			headerPrefix: 'Token ',
			envKeyName: 'RECALL_API_KEY',
		},
	},

	// Svix-style verification — handled by customWebhookVerifier
	webhook: { type: 'custom' },

	events: {
		definitions: [
			{
				entityType: 'recall.bot',
				actions: ['ready', 'recording', 'done', 'fatal'],
				label: 'Bot Status',
			},
		],
	},
}

/**
 * Verify Recall.ai webhook signatures (Svix standard).
 *
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 * Secret: whsec_<base64-key> from RECALL_WEBHOOK_SECRET env var
 * Signing base: `${msgId}.${msgTimestamp}.${body}`
 * Signature format: `v1,<base64-hmac>`
 */
export function verifyRecallWebhook(body: string, headers: Record<string, string>): boolean {
	const secret = process.env.RECALL_WEBHOOK_SECRET
	if (!secret) return false

	const msgId = headers['webhook-id'] ?? headers['svix-id']
	const msgTimestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp']
	const msgSignature = headers['webhook-signature'] ?? headers['svix-signature']

	if (!msgId || !msgTimestamp || !msgSignature) return false

	// Decode the whsec_ prefixed secret
	const secretBytes = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')

	// Compute expected signature
	const toSign = `${msgId}.${msgTimestamp}.${body}`
	const expectedSig = createHmac('sha256', secretBytes).update(toSign).digest('base64')

	// The signature header may contain multiple signatures separated by spaces (e.g. "v1,sig1 v1,sig2")
	const signatures = msgSignature.split(' ')
	for (const sig of signatures) {
		const [version, sigValue] = sig.split(',')
		if (version !== 'v1' || !sigValue) continue

		const expected = Buffer.from(expectedSig)
		const received = Buffer.from(sigValue)
		if (expected.length === received.length && timingSafeEqual(expected, received)) {
			return true
		}
	}

	return false
}
