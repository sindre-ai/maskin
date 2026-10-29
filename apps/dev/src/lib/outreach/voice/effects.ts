import type { Database } from '@maskin/db'
import { recordEvent } from '../../events/record-event'
import { slackApiCall } from '../../integrations/providers/slack/slack-api'
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

const SALES_CHANNEL = '#sales'

export type SalesPoster = (text: string) => Promise<void>

/**
 * Posts to #sales with the workspace bot token, the same transport and env var
 * as notifySebkOnSlack (lib/vat-notifications.ts). Never throws: a Slack outage
 * must not turn a recorded dead letter into a failed effect.
 */
export const postToSales: SalesPoster = async (text) => {
	const token = process.env.SLACK_BOT_TOKEN?.trim()
	if (!token) {
		logger.warn('voice dead letter not posted to #sales: SLACK_BOT_TOKEN unset')
		return
	}
	try {
		await slackApiCall(token, 'chat.postMessage', {
			channel: SALES_CHANNEL,
			text,
			unfurl_links: false,
		})
	} catch (err) {
		logger.warn('voice dead letter post to #sales failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

function deadLetterText(ctx: EffectContext, payload: DeadLetter | { reason: string }): string {
	const reason = 'reason' in payload ? payload.reason : payload.error
	return `Voice dead letter: contact ${ctx.contactId}, dial attempt ${ctx.dialAttemptN}, reason: ${reason}`
}

/**
 * Dead letter: an audit row at Attention 5 addressed to #sales, plus one
 * message to #sales through the existing Slack path.
 */
export async function recordDeadLetter(
	db: Database,
	ctx: EffectContext,
	payload: DeadLetter | { reason: string },
	post: SalesPoster = postToSales,
): Promise<void> {
	logger.error('voice dead letter', { contactId: ctx.contactId, ...payload })
	await recordEvent(db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		action: 'voice_dead_letter',
		entityType: 'object',
		entityId: ctx.contactId,
		data: { attention: 5, channel: SALES_CHANNEL, ...payload },
	})
	await post(deadLetterText(ctx, payload))
}

export function createDefaultEffectRunner(
	db: Database,
	post: SalesPoster = postToSales,
): EffectRunner {
	function client(ctx: EffectContext) {
		const { apiKey, apiBaseUrl } = readTelnyxRuntimeConfig()
		if (!apiKey) throw new Error('TELNYX_API_KEY is not configured')
		return createTelnyxClient({
			apiKey,
			baseUrl: apiBaseUrl,
			onDeadLetter: (letter) => recordDeadLetter(db, ctx, letter, post),
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
			await recordDeadLetter(db, ctx, { reason }, post)
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
