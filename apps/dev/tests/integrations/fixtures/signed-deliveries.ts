import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { WebhookConfig } from '../../../src/lib/integrations/types'

/**
 * Signed webhook deliveries for the vendors the bring-your-own extension
 * stack is built against. Each builder returns the raw body and the headers
 * exactly as the generic route will see them (header names lowercased).
 */

export interface SignedDelivery {
	body: string
	headers: Record<string, string>
}

function hmacSha256Hex(secret: string, body: string): string {
	return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Fireflies V2: raw-body HMAC-SHA256, "sha256=" prefix, X-Hub-Signature,
 * no timestamp. Docs: https://docs.fireflies.ai/graphql-api/webhooks-v2
 */
export const FIREFLIES_VERIFY_CONFIG: WebhookConfig = {
	signatureHeader: 'x-hub-signature',
	signatureScheme: 'hmac-sha256',
	signaturePrefix: 'sha256=',
	secretEnv: 'UNUSED_SECRET_PASSED_AS_PARAM',
}

export function buildFirefliesDelivery(opts: {
	secret: string
	meetingId?: string
	clientReferenceId?: string
}): SignedDelivery {
	const payload = {
		event: 'meeting.transcribed',
		timestamp: 1760000000000,
		meeting_id: opts.meetingId ?? 'ASxwZxCstx',
		...(opts.clientReferenceId ? { client_reference_id: opts.clientReferenceId } : {}),
	}
	const body = JSON.stringify(payload)
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'x-hub-signature': `sha256=${hmacSha256Hex(opts.secret, body)}`,
		},
	}
}

/**
 * Cal.com: raw-body HMAC-SHA256, raw hex digest with no prefix, in
 * x-cal-signature-256. Docs:
 * https://cal.com/docs/developing/guides/automation/webhooks
 */
export const CALCOM_VERIFY_CONFIG: WebhookConfig = {
	signatureHeader: 'x-cal-signature-256',
	signatureScheme: 'hmac-sha256',
	secretEnv: 'UNUSED_SECRET_PASSED_AS_PARAM',
}

export function buildCalcomDelivery(opts: {
	secret: string
	triggerEvent?: 'BOOKING_CREATED' | 'BOOKING_CANCELLED'
	uid?: string
}): SignedDelivery {
	const payload = {
		triggerEvent: opts.triggerEvent ?? 'BOOKING_CREATED',
		createdAt: '2026-10-17T12:00:00.000Z',
		payload: {
			uid: opts.uid ?? 'bk_7Hn2xQ',
			title: 'Intro call',
			startTime: '2026-10-20T09:00:00.000Z',
		},
	}
	const body = JSON.stringify(payload)
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'x-cal-signature-256': hmacSha256Hex(opts.secret, body),
		},
	}
}

/**
 * Telnyx: Ed25519 over "{timestamp}|{body}", base64 signature in
 * telnyx-signature-ed25519, unix seconds in telnyx-timestamp. The public key is
 * what the owner pastes as the signing secret (raw 32 bytes, base64). Docs:
 * https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
 */
export function generateTelnyxKeys() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	const publicKeyBase64 = Buffer.from(
		publicKey.export({ format: 'jwk' }).x as string,
		'base64url',
	).toString('base64')
	return { publicKeyBase64, privateKey }
}

export function buildTelnyxDelivery(opts: {
	privateKey: ReturnType<typeof generateKeyPairSync<'ed25519'>>['privateKey']
	eventId?: string
	eventType?: string
	timestamp?: number
}): SignedDelivery {
	const body = JSON.stringify({
		data: {
			id: opts.eventId ?? 'evt-0b1c2d',
			event_type: opts.eventType ?? 'call.hangup',
			record_type: 'event',
			payload: { call_control_id: 'v3:abc', call_session_id: 'sess-1' },
		},
	})
	const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
	const signature = sign(null, Buffer.from(`${timestamp}|${body}`), opts.privateKey).toString(
		'base64',
	)
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'telnyx-timestamp': timestamp,
			'telnyx-signature-ed25519': signature,
		},
	}
}

/**
 * Standard Webhooks (Svix, Resend, Clerk): headers webhook-id, webhook-timestamp and
 * webhook-signature "v1,<base64>"; signed text "<id>.<timestamp>.<body>", HMAC-SHA256
 * under the base64-decoded secret. `secret` is the "whsec_..." string the vendor shows.
 * https://www.standardwebhooks.com
 */
export function buildStandardWebhooksDelivery(opts: {
	secret: string
	id?: string
	timestamp?: number
	/** Extra "v1,<base64>" entries put ahead of the real one, as during a secret rotation. */
	extraSignatures?: string[]
}): SignedDelivery {
	const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em-1a2b3c' } })
	const id = opts.id ?? 'msg_2Lh9KRb0pzN3LMtP'
	const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
	const key = Buffer.from(opts.secret.replace(/^whsec_/, ''), 'base64')
	const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'webhook-id': id,
			'webhook-timestamp': timestamp,
			'webhook-signature': [...(opts.extraSignatures ?? []), `v1,${signature}`].join(' '),
		},
	}
}

/**
 * Stripe style: one Stripe-Signature header "t=<unix seconds>,v1=<hex>"; signed text
 * "<t>.<body>", HMAC-SHA256 under the secret as given.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function buildStripeDelivery(opts: { secret: string; timestamp?: number }): SignedDelivery {
	const body = JSON.stringify({ id: 'evt_1Nq', type: 'invoice.paid', data: { object: {} } })
	const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
	const signature = createHmac('sha256', opts.secret).update(`${timestamp}.${body}`).digest('hex')
	return {
		body,
		headers: {
			'content-type': 'application/json',
			'stripe-signature': `t=${timestamp},v1=${signature},v0=ignored`,
		},
	}
}
