import { createHmac } from 'node:crypto'
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
