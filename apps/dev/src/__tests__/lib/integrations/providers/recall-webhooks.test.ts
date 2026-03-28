import { describe, expect, it } from 'vitest'
import { recallEventNormalizer } from '../../../../lib/integrations/providers/recall/webhooks'

describe('Recall.ai event normalizer', () => {
	it('normalizes a recording status change to done', () => {
		const payload = {
			event: 'bot.status_change',
			data: {
				bot_id: 'bot-123',
				status: { code: 'done', sub_code: 'call_ended_by_host' },
				meeting_url: 'https://meet.google.com/abc',
				video_url: 'https://api.recall.ai/api/v1/bot/bot-123/recording',
			},
		}

		const result = recallEventNormalizer(payload, {})

		expect(result).toEqual({
			entityType: 'recall.bot',
			action: 'done',
			installationId: 'bot-123',
			data: {
				bot_id: 'bot-123',
				status_code: 'done',
				sub_code: 'call_ended_by_host',
				meeting_url: 'https://meet.google.com/abc',
				video_url: 'https://api.recall.ai/api/v1/bot/bot-123/recording',
			},
		})
	})

	it('normalizes in_call_recording to recording action', () => {
		const payload = {
			event: 'bot.status_change',
			data: {
				bot_id: 'bot-456',
				status: { code: 'in_call_recording' },
			},
		}

		const result = recallEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.action).toBe('recording')
	})

	it('normalizes fatal status', () => {
		const payload = {
			event: 'bot.status_change',
			data: {
				bot_id: 'bot-789',
				status: { code: 'fatal', sub_code: 'bot_errored' },
			},
		}

		const result = recallEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.action).toBe('fatal')
		expect(result?.data.sub_code).toBe('bot_errored')
	})

	it('returns null for non-status-change events', () => {
		const payload = { event: 'bot.other_event', data: { bot_id: 'bot-1' } }
		expect(recallEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null for unknown status codes', () => {
		const payload = {
			event: 'bot.status_change',
			data: { bot_id: 'bot-1', status: { code: 'unknown_status' } },
		}
		expect(recallEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when bot_id is missing', () => {
		const payload = {
			event: 'bot.status_change',
			data: { status: { code: 'done' } },
		}
		expect(recallEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null for non-object payloads', () => {
		expect(recallEventNormalizer(null, {})).toBeNull()
		expect(recallEventNormalizer('string', {})).toBeNull()
	})
})
