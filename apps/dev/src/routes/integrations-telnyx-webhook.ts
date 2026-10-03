import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { telnyxWebhookEvents } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import type { CallClientState } from '../lib/integrations/providers/telnyx/client'
import { readTelnyxRuntimeConfig } from '../lib/integrations/providers/telnyx/config'
import {
	type TelnyxEvent,
	clientStateOf,
	parseTelnyxWebhook,
} from '../lib/integrations/providers/telnyx/events'
import { verifyTelnyxSignature } from '../lib/integrations/providers/telnyx/signature'
import { dispatchToolInvocation } from '../lib/integrations/providers/telnyx/tool-dispatch'
import { logger } from '../lib/logger'
import { type VoiceDb, applyVoiceEvent, runAppliedEffects } from '../lib/outreach/voice/apply'
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

/**
 * What has to happen after the claim + state write commit. Side effects (SMS,
 * forced hangup), the post-call seam and the tool router's answer all reach out
 * to other systems, so none of them run inside the transaction.
 */
type AfterCommit =
	| { kind: 'respond'; body: Record<string, unknown> }
	| {
			kind: 'applied'
			result: Extract<Awaited<ReturnType<typeof applyVoiceEvent>>, { found: true }>
			event: TelnyxEvent
			clientState: CallClientState
	  }
	| {
			kind: 'tool'
			event: Extract<TelnyxEvent, { event_type: 'assistant.tool_invocation' }>
			clientState: CallClientState
	  }

/** Runs inside the claim transaction: the state write commits or rolls back together with the claim. */
async function writeState(tx: VoiceDb, event: TelnyxEvent): Promise<AfterCommit> {
	const clientState = clientStateOf(event)
	if (!clientState) {
		// Not a call this system placed (or the dialer did not stamp it): nothing to drive.
		logger.warn('telnyx webhook event has no client_state', {
			eventId: event.event_id,
			eventType: event.event_type,
		})
		return { kind: 'respond', body: { ok: true, skipped: 'no_client_state' } }
	}

	if (event.event_type === 'assistant.tool_invocation') {
		// The trace entry is written by the tool router once the tool succeeded (recordToolSuccess),
		// not here: a failed tool must leave no entry for the reducer to read.
		return { kind: 'tool', event, clientState }
	}

	const voiceEvent = toVoiceEvent(event)
	if (!voiceEvent) {
		// transcription.final: buffered by the post-call slices, nothing for the reducer.
		logger.debug('telnyx webhook event not routed to reducer', { eventType: event.event_type })
		return { kind: 'respond', body: { ok: true } }
	}

	const result = await applyVoiceEvent(tx, {
		workspaceId: clientState.workspace_id,
		contactId: clientState.contact_id,
		event: voiceEvent,
	})
	if (!result.found) {
		logger.warn('telnyx webhook contact not found', {
			eventId: event.event_id,
			contactId: clientState.contact_id,
		})
		return { kind: 'respond', body: { ok: true, skipped: 'contact_not_found' } }
	}
	return { kind: 'applied', result, event, clientState }
}

async function afterCommit(db: Database, work: AfterCommit): Promise<unknown> {
	if (work.kind === 'respond') return work.body

	if (work.kind === 'tool') {
		// The tool's JSON result goes straight back in the 200 body.
		return dispatchToolInvocation({
			db,
			callId: work.event.payload.call_control_id,
			toolName: work.event.payload.tool_name,
			toolInput: work.event.payload.tool_input,
			clientState: work.clientState,
		})
	}

	const { result, event, clientState } = work
	if (result.applied) {
		await runAppliedEffects(result, effectRunnerOverride ?? createDefaultEffectRunner(db))
	}

	// Every hangup for this contact's current call opens the post-call seam, including one
	// the reducer absorbed (a transferred call still has a recording to mirror).
	if (event.event_type === 'call.hangup' && !result.staleCall) {
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
			transcript: event.payload.transcript,
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

	// Claim and state write share one transaction: a crash or failure between them rolls
	// both back, so Telnyx's retry is processed instead of being deduplicated away.
	let work: AfterCommit | null
	try {
		work = await db.transaction(async (tx) => {
			const claimed = await tx
				.insert(telnyxWebhookEvents)
				.values({ eventId: event.event_id })
				.onConflictDoNothing({ target: telnyxWebhookEvents.eventId })
				.returning({ eventId: telnyxWebhookEvents.eventId })
			if (claimed.length === 0) return null
			return writeState(tx, event)
		})
	} catch (err) {
		logger.error('telnyx webhook handler failed', {
			eventId: event.event_id,
			eventType: event.event_type,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Webhook handler failed'), 500)
	}
	if (work === null) return c.json({ ok: true, duplicate: true })

	try {
		return c.json(await afterCommit(db, work))
	} catch (err) {
		// Only the tool router can throw here (effects and hooks are isolated). Release the
		// claim so Telnyx's retry reaches the router again.
		await db
			.delete(telnyxWebhookEvents)
			.where(eq(telnyxWebhookEvents.eventId, event.event_id))
			.catch(() => undefined)
		logger.error('telnyx webhook post-commit step failed', {
			eventId: event.event_id,
			eventType: event.event_type,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Webhook handler failed'), 500)
	}
})

export default app
