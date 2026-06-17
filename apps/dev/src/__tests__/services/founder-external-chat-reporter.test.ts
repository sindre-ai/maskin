import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/integrations/providers/slack/mcp-server', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/slack/mcp-server')
	>('../../lib/integrations/providers/slack/mcp-server')
	return {
		...actual,
		slackPostMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.0', channel: 'D1' }),
	}
})

vi.mock('../../lib/integrations/providers/slack/bot-token', () => ({
	resolveSlackBotToken: vi.fn(),
}))

import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { resolveSlackBotToken } from '../../lib/integrations/providers/slack/bot-token'
import { slackPostMessage } from '../../lib/integrations/providers/slack/mcp-server'
import {
	FounderExternalChatReporter,
	formatReminderMessage,
	parseExternalChatReport,
} from '../../services/founder-external-chat-reporter'
import { createTestContext } from '../setup'

const WS = '11111111-1111-1111-1111-111111111111'
const SEBASTIAN_ID = '22222222-2222-2222-2222-222222222222'
const MAGNUS_ID = '33333333-3333-3333-3333-333333333333'
const CONFIG_JSON = JSON.stringify({
	workspaceId: WS,
	founders: [
		{ actorId: SEBASTIAN_ID, name: 'Sebastian', slackUserId: 'U1SEBASTIAN' },
		{ actorId: MAGNUS_ID, name: 'Magnus', slackUserId: 'U2MAGNUS' },
	],
})

describe('parseExternalChatReport', () => {
	it('parses the canonical `claude=N chatgpt=N other=N` shape', () => {
		const result = parseExternalChatReport('claude=3 chatgpt=1 other=0', '2026-06-17')
		expect(result).toEqual({
			reportDate: '2026-06-17',
			entries: [
				{ provider: 'claude', sessionCount: 3 },
				{ provider: 'chatgpt', sessionCount: 1 },
				{ provider: 'other', sessionCount: 0 },
			],
		})
	})

	it('is case-insensitive and accepts colon or equals separators', () => {
		const result = parseExternalChatReport('Claude: 3, ChatGPT = 1', '2026-06-17')
		expect(result?.entries).toEqual([
			{ provider: 'claude', sessionCount: 3 },
			{ provider: 'chatgpt', sessionCount: 1 },
		])
	})

	it('honours an explicit date prefix and strips it from the providers list', () => {
		const result = parseExternalChatReport('date=2026-06-15 claude=4 chatgpt=2', '2026-06-17')
		expect(result?.reportDate).toBe('2026-06-15')
		expect(result?.entries.map((e) => e.provider)).toEqual(['claude', 'chatgpt'])
	})

	it('collapses unknown provider tokens into a summed `other` bucket', () => {
		const result = parseExternalChatReport('cursor=2 perplexity=3', '2026-06-17')
		expect(result?.entries).toEqual([{ provider: 'other', sessionCount: 5 }])
	})

	it('returns null for chitchat that contains no `provider=count` token', () => {
		expect(parseExternalChatReport('thanks!', '2026-06-17')).toBeNull()
		expect(parseExternalChatReport('', '2026-06-17')).toBeNull()
	})

	it('takes the last occurrence when a provider is named twice (self-correction)', () => {
		const result = parseExternalChatReport('claude=3 claude=5', '2026-06-17')
		expect(result?.entries).toEqual([{ provider: 'claude', sessionCount: 5 }])
	})

	it('accepts short aliases (c/cg/gpt/o)', () => {
		const result = parseExternalChatReport('c=2 cg=4 o=1', '2026-06-17')
		expect(result?.entries).toEqual([
			{ provider: 'claude', sessionCount: 2 },
			{ provider: 'chatgpt', sessionCount: 4 },
			{ provider: 'other', sessionCount: 1 },
		])
	})
})

describe('formatReminderMessage', () => {
	it('includes the founder name and the report date', () => {
		const msg = formatReminderMessage('Sebastian', '2026-06-17')
		expect(msg).toContain('Sebastian')
		expect(msg).toContain('2026-06-17')
		expect(msg).toMatch(/claude=3 chatgpt=1 other=0/)
	})
})

describe('FounderExternalChatReporter', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let ctx: ReturnType<typeof createTestContext>
	let reporter: FounderExternalChatReporter

	beforeEach(() => {
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		ctx = createTestContext()
		vi.mocked(capturePosthogEvent).mockClear()
		vi.mocked(slackPostMessage).mockClear()
		vi.mocked(resolveSlackBotToken).mockReset()
	})

	afterEach(() => {
		reporter?.stop()
	})

	describe('start()', () => {
		it('does not subscribe when FOUNDER_EXTERNAL_REPORT_CONFIG is unset', () => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: undefined,
			})
			reporter.start()
			expect(bridge.listenerCount('event')).toBe(0)
		})

		it('does not subscribe when the config JSON is invalid', () => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: '{ not json',
			})
			reporter.start()
			expect(bridge.listenerCount('event')).toBe(0)
		})

		it('subscribes exactly once when the config is valid', () => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: CONFIG_JSON,
			})
			reporter.start()
			expect(bridge.listenerCount('event')).toBe(1)
		})
	})

	describe('handleEvent()', () => {
		const baseEvent: PgEvent = {
			workspace_id: WS,
			entity_type: 'slack.direct_message',
			entity_id: 'integration-1',
			action: 'created',
			actor_id: 'system-actor',
			event_id: '42',
		}

		beforeEach(() => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: CONFIG_JSON,
				now: () => new Date('2026-06-17T14:00:00Z'),
			})
		})

		it('emits one PostHog event per parsed provider for a matching founder DM', async () => {
			ctx.mockResults.select = [
				{
					data: {
						event: { type: 'message', user: 'U1SEBASTIAN', text: 'claude=3 chatgpt=1', ts: '1' },
					},
				},
			]
			await reporter.handleEvent(baseEvent)

			expect(vi.mocked(capturePosthogEvent)).toHaveBeenCalledTimes(2)
			expect(vi.mocked(capturePosthogEvent)).toHaveBeenNthCalledWith(
				1,
				'external_chat_session_reported',
				SEBASTIAN_ID,
				expect.objectContaining({
					workspace_id: WS,
					actor_id: SEBASTIAN_ID,
					actor_type: 'human',
					provider: 'claude',
					session_count: 3,
					report_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
					source: 'slack',
				}),
			)
			expect(vi.mocked(capturePosthogEvent)).toHaveBeenNthCalledWith(
				2,
				'external_chat_session_reported',
				SEBASTIAN_ID,
				expect.objectContaining({ provider: 'chatgpt', session_count: 1 }),
			)
		})

		it('ignores DMs from Slack users not on the founders list', async () => {
			ctx.mockResults.select = [
				{ data: { event: { type: 'message', user: 'UNOTFOUNDER', text: 'claude=3' } } },
			]
			await reporter.handleEvent(baseEvent)
			expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()
		})

		it('ignores events for other workspaces', async () => {
			await reporter.handleEvent({ ...baseEvent, workspace_id: 'other-ws' })
			expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()
		})

		it('ignores Slack message subtypes (edits, deletes)', async () => {
			ctx.mockResults.select = [
				{
					data: {
						event: {
							type: 'message',
							subtype: 'message_changed',
							user: 'U1SEBASTIAN',
							text: 'claude=99',
						},
					},
				},
			]
			await reporter.handleEvent(baseEvent)
			expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()
		})

		it('ignores replies that contain no `provider=count` token', async () => {
			ctx.mockResults.select = [
				{ data: { event: { type: 'message', user: 'U1SEBASTIAN', text: 'sorry forgot' } } },
			]
			await reporter.handleEvent(baseEvent)
			expect(vi.mocked(capturePosthogEvent)).not.toHaveBeenCalled()
		})

		it('routes Magnus reports to Magnus actor id', async () => {
			ctx.mockResults.select = [
				{ data: { event: { type: 'message', user: 'U2MAGNUS', text: 'claude=2' } } },
			]
			await reporter.handleEvent(baseEvent)
			expect(vi.mocked(capturePosthogEvent)).toHaveBeenCalledWith(
				'external_chat_session_reported',
				MAGNUS_ID,
				expect.objectContaining({ provider: 'claude', session_count: 2 }),
			)
		})
	})

	describe('runDailyReminder()', () => {
		beforeEach(() => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: CONFIG_JSON,
				now: () => new Date('2026-06-17T15:00:00Z'),
			})
		})

		it('sends one DM per configured founder when the bot token resolves', async () => {
			vi.mocked(resolveSlackBotToken).mockResolvedValueOnce({
				botToken: 'xoxb-test',
				slackTeamId: 'T1',
				integrationId: 'int-1',
			})
			await reporter.runDailyReminder()
			expect(vi.mocked(slackPostMessage)).toHaveBeenCalledTimes(2)
			const channels = vi
				.mocked(slackPostMessage)
				.mock.calls.map(([_, args]) => (args as { channel: string }).channel)
			expect(channels).toEqual(['U1SEBASTIAN', 'U2MAGNUS'])
		})

		it('skips sending and logs when no active Slack bot token is configured', async () => {
			vi.mocked(resolveSlackBotToken).mockResolvedValueOnce(null)
			await reporter.runDailyReminder()
			expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled()
		})

		it('does not abort the batch when one founder DM fails', async () => {
			vi.mocked(resolveSlackBotToken).mockResolvedValueOnce({
				botToken: 'xoxb-test',
				slackTeamId: 'T1',
				integrationId: 'int-1',
			})
			vi.mocked(slackPostMessage)
				.mockRejectedValueOnce(new Error('chat.postMessage HTTP 429'))
				.mockResolvedValueOnce({ ok: true, ts: '1', channel: 'D2' })
			await reporter.runDailyReminder()
			expect(vi.mocked(slackPostMessage)).toHaveBeenCalledTimes(2)
		})
	})

	describe('stop()', () => {
		it('removes the event listener and stops the cron job', () => {
			reporter = new FounderExternalChatReporter({
				bridge,
				db: ctx.db,
				configJson: CONFIG_JSON,
			})
			reporter.start()
			expect(bridge.listenerCount('event')).toBe(1)
			reporter.stop()
			expect(bridge.listenerCount('event')).toBe(0)
		})
	})
})
