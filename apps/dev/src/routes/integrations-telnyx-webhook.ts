import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { telnyxWebhookEvents } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { readTelnyxRuntimeConfig } from '../lib/integrations/providers/telnyx/config'
import {
	type TelnyxEvent,
	clientStateOf,
	parseTelnyxWebhook,
} from '../lib/integrations/providers/telnyx/events'
import { verifyTelnyxSignature } from '../lib/integrations/providers/telnyx/signature'
import { dispatchToolInvocation } from '../lib/integrations/providers/telnyx/tool-dispatch'
import { logger } from '../lib/logger'
import {
	applyVoiceEvent,
	recordToolInvocation,
	runAppliedEffects,
} from '../lib/outreach/voice/apply'
import { type EffectRunner, createDefaultEffectRunner } from '../lib/outreach/voice/effects'
import { runPostCallHooks } from '../lib/outreach/voice/post-call'
import type { VoiceEvent } from '../lib/outreach/voice/state'

type Env = {
	Variables: {
		db: Database
	}
}

const app = new OpenAPIHono<Env>()

/** Test seam: swap the object that performs SMS / hangup / dead-letter effects. */
let effectRunnerOverride: EffectRunner | null = null
export function setEffectRunnerForTests(runner: EffectRunner | null): void {
	effectRunnerOverride = runner
}

/** Maps a Telnyx event onto the reducer's input, or null when the reducer has no use for it. */
function toVoiceEvent(event: TelnyxEvent): VoiceEvent | null {
	const endpoints = { to: event.payload.to, from: event.payload.from }
	switch (event.event_type) {
		case 'call.initiated':
			return {
				type: 'call_initiated',
				callId: event.payload.call_control_id,
				dialAttemptN: clientStateOf(event)?.dial_attempt_n,
				...endpoints,
			}
		case 'call.answered':
			return { type: 'call_answered', callId: event.payload.call_control_id, ...endpoints }
		case 'call.hangup':
			return {
				type: 'call_hangup',
				callId: event.payload.call_control_id,
				cause: event.payload.hangup_cause,
				durationS: event.payload.duration_s,
				...endpoints,
			}
		case 'call.machine.premium.detection.ended':
			return {
				type: 'machine_detection',
				callId: event.payload.call_control_id,
				result: event.payload.result,
				...endpoints,
			}
		case 'call.transfer.completed':
			return { type: 'transfer_completed', callId: event.payload.call_control_id }
		case 'call.transfer.failed':
			return { type: 'transfer_failed', callId: event.payload.call_control_id }
		default:
			return null
	}
}

async function handleEvent(db: Database, event: TelnyxEvent): Promise<unknown> {
	const clientState = clientStateOf(event)
	if (!clientState) {
		// Not a call this system placed (or the dialer did not stamp it): nothing to drive.
		logger.warn('telnyx webhook event has no client_state', {
			eventId: event.event_id,
			eventType: event.event_type,
		})
		return { ok: true, skipped: 'no_client_state' }
	}

	if (event.event_type === 'assistant.tool_invocation') {
		await recordToolInvocation(db, {
			workspaceId: clientState.workspace_id,
			contactId: clientState.contact_id,
			callId: event.payload.call_control_id,
			toolName: event.payload.tool_name,
		})
		// The tool's JSON result goes straight back in the 200 body.
		return dispatchToolInvocation({
			callId: event.payload.call_control_id,
			toolName: event.payload.tool_name,
			toolInput: event.payload.tool_input,
			clientState,
		})
	}

	const voiceEvent = toVoiceEvent(event)
	if (!voiceEvent) {
		// transcription.final: buffered by the post-call slices, nothing for the reducer.
		logger.debug('telnyx webhook event not routed to reducer', { eventType: event.event_type })
		return { ok: true }
	}

	const result = await applyVoiceEvent(db, {
		workspaceId: clientState.workspace_id,
		contactId: clientState.contact_id,
		event: voiceEvent,
	})
	if (!result.found) {
		logger.warn('telnyx webhook contact not found', {
			eventId: event.event_id,
			contactId: clientState.contact_id,
		})
		return { ok: true, skipped: 'contact_not_found' }
	}

	if (result.applied) {
		await runAppliedEffects(result, effectRunnerOverride ?? createDefaultEffectRunner(db))
	}

	// Every hangup that belongs to this contact's current call opens the post-call seam.
	if (event.event_type === 'call.hangup' && result.applied) {
		await runPostCallHooks({
			db,
			workspaceId: clientState.workspace_id,
			contactId: clientState.contact_id,
			callId: event.payload.call_control_id,
			status: result.status,
			hangupCause: event.payload.hangup_cause ?? null,
			durationS: event.payload.duration_s ?? null,
			recordingUrl: event.payload.recording_url ?? null,
			transcriptUrl: event.payload.transcript_url ?? null,
		})
	}

	return { ok: true, status: result.status, applied: result.applied }
}

app.post('/', async (c) => {
	const db = c.get('db')
	const rawBody = await c.req.text()

	const failure = verifyTelnyxSignature({
		rawBody,
		signatureHeader: c.req.header('telnyx-signature-ed25519'),
		timestampHeader: c.req.header('telnyx-timestamp'),
		publicKey: readTelnyxRuntimeConfig().publicKey,
	})
	if (failure) {
		logger.warn('telnyx webhook rejected', { reason: failure })
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	let body: unknown
	try {
		body = JSON.parse(rawBody)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Body is not valid JSON'), 400)
	}

	const parsed = parseTelnyxWebhook(body)
	if (parsed.kind === 'unknown') {
		logger.info('telnyx webhook event type not handled', {
			eventId: parsed.eventId,
			eventType: parsed.eventType,
		})
		return c.json({ ok: true, skipped: true, reason: 'unhandled_event_type' })
	}
	if (parsed.kind === 'invalid') {
		logger.warn('telnyx webhook payload invalid', {
			eventId: parsed.eventId,
			eventType: parsed.eventType,
			reason: parsed.reason,
		})
		return c.json(createApiError('BAD_REQUEST', 'Malformed Telnyx event'), 400)
	}

	const { event } = parsed

	// Claim before doing any work, so Telnyx's retries (and replays) are no-ops.
	const claimed = await db
		.insert(telnyxWebhookEvents)
		.values({ eventId: event.event_id })
		.onConflictDoNothing({ target: telnyxWebhookEvents.eventId })
		.returning({ eventId: telnyxWebhookEvents.eventId })
	if (claimed.length === 0) {
		return c.json({ ok: true, duplicate: true })
	}

	try {
		return c.json(await handleEvent(db, event))
	} catch (err) {
		// Release the claim so Telnyx's retry reprocesses the event.
		await db
			.delete(telnyxWebhookEvents)
			.where(eq(telnyxWebhookEvents.eventId, event.event_id))
			.catch(() => undefined)
		logger.error('telnyx webhook handler failed', {
			eventId: event.event_id,
			eventType: event.event_type,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Webhook handler failed'), 500)
	}
})

export default app
