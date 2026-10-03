import type { Database } from '@maskin/db'
import { recordEvent } from '../../events/record-event'
import { createTelnyxClient } from '../../integrations/providers/telnyx/client'
import { readTelnyxRuntimeConfig } from '../../integrations/providers/telnyx/config'
import type { DeadLetter } from '../../integrations/providers/telnyx/http'
import { logger } from '../../logger'
import type { SmsMode, VoiceEffect } from './state'

export interface EffectContext {
	workspaceId: string
	contactId: string
	actorId: string
	dialAttemptN: number
}

export interface EffectRunner {
	sendSms(mode: SmsMode, ctx: EffectContext, to?: string, from?: string): Promise<void>
	hangupCall(callId: string, ctx: EffectContext): Promise<void>
	deadLetter(reason: string, ctx: EffectContext): Promise<void>
}

const SMS_TEMPLATE_ENV: Record<SmsMode, string> = {
	missed_call_nudge: 'VOICE_SMS_MISSED_CALL_NUDGE',
	voicemail_followup: 'VOICE_SMS_VOICEMAIL_FOLLOWUP',
}

/**
 * Dead letter: an audit row at Attention 5 addressed to #sales. Delivery to
 * Slack itself is not wired here (no in-app Slack poster exists on main).
 */
export async function recordDeadLetter(
	db: Database,
	ctx: EffectContext,
	payload: DeadLetter | { reason: string },
): Promise<void> {
	logger.error('voice dead letter', { contactId: ctx.contactId, ...payload })
	await recordEvent(db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		action: 'voice_dead_letter',
		entityType: 'object',
		entityId: ctx.contactId,
		data: { attention: 5, channel: '#sales', ...payload },
	})
}

export function createDefaultEffectRunner(db: Database): EffectRunner {
	function client(ctx: EffectContext) {
		const { apiKey } = readTelnyxRuntimeConfig()
		if (!apiKey) throw new Error('TELNYX_API_KEY is not configured')
		return createTelnyxClient({
			apiKey,
			onDeadLetter: (letter) => recordDeadLetter(db, ctx, letter),
		})
	}

	return {
		async sendSms(mode, ctx, to, from) {
			// The SMS copy is content with a legal read attached; it is supplied by
			// env and never invented here. Unset means the SMS is skipped, loudly.
			const text = process.env[SMS_TEMPLATE_ENV[mode]]?.trim()
			if (!text || !to || !from) {
				logger.warn('voice sms skipped', {
					mode,
					contactId: ctx.contactId,
					reason: !text ? 'no_template' : 'no_endpoints',
				})
				return
			}
			await client(ctx).sendMessage({
				from,
				to,
				text,
				idempotencyKey: `${ctx.contactId}:${ctx.dialAttemptN}:${mode}`,
			})
		},
		async hangupCall(callId, ctx) {
			await client(ctx).hangupCall(callId)
		},
		async deadLetter(reason, ctx) {
			await recordDeadLetter(db, ctx, { reason })
		},
	}
}

/** Runs each effect independently: one failing never blocks the others or the 200. */
export async function runEffects(
	effects: readonly VoiceEffect[],
	ctx: EffectContext,
	runner: EffectRunner,
): Promise<void> {
	for (const effect of effects) {
		try {
			if (effect.type === 'send_sms') await runner.sendSms(effect.mode, ctx, effect.to, effect.from)
			else if (effect.type === 'hangup_call') await runner.hangupCall(effect.callId, ctx)
			else await runner.deadLetter(effect.reason, ctx)
		} catch (err) {
			logger.error('voice effect failed', {
				effect: effect.type,
				contactId: ctx.contactId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}
