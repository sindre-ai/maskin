import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mocks must be hoisted so the target module (webhooks.ts) sees the mock at
// import time. Same pattern PR B's slack-trigger-setup.test.ts uses.
const { mockDecrypt } = vi.hoisted(() => ({ mockDecrypt: vi.fn() }))
vi.mock('../../../../lib/crypto', () => ({ decrypt: mockDecrypt }))

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { handleMemberLeftChannel } from '../../../../lib/integrations/providers/slack/webhooks'
import { buildIntegration, buildTrigger } from '../../../factories'
import { createTestContext } from '../../../setup'

const TEAM_ID = 'T123AUTOPAUSE'
const BOT_USER_ID = 'U_BOT'
const CHANNEL_ID = 'C_KICKED'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000030'
const CREATED_BY = '00000000-0000-0000-0000-000000000031'
const TRIGGER_ID = '00000000-0000-0000-0000-000000000020'

function activeSlackIntegration(overrides?: Record<string, unknown>) {
	return buildIntegration({
		workspaceId: WORKSPACE_ID,
		provider: 'slack',
		status: 'active',
		externalId: TEAM_ID,
		credentials: 'encrypted-blob',
		config: { system_actor_id: SYSTEM_ACTOR_ID },
		...overrides,
	})
}

function slackChannelTrigger(overrides?: Record<string, unknown>) {
	return buildTrigger({
		id: TRIGGER_ID,
		workspaceId: WORKSPACE_ID,
		name: 'Slack channel triage',
		type: 'event',
		enabled: true,
		metadata: null,
		createdBy: CREATED_BY,
		config: {
			entity_type: 'slack.channel_message',
			action: 'created',
			conditions: [
				{ field: 'event.channel', operator: 'in', value: [CHANNEL_ID, 'C_OTHER'] },
			],
		},
		...overrides,
	})
}

function memberLeftPayload(overrides?: {
	user?: string
	channel?: string
	team_id?: string
}) {
	return {
		type: 'event_callback' as const,
		team_id: overrides?.team_id ?? TEAM_ID,
		event: {
			type: 'member_left_channel' as const,
			user: overrides?.user ?? BOT_USER_ID,
			channel: overrides?.channel ?? CHANNEL_ID,
		},
	}
}

describe('handleMemberLeftChannel', () => {
	beforeEach(() => {
		mockDecrypt.mockReset().mockReturnValue(JSON.stringify({ botUserId: BOT_USER_ID }))
		capturePosthogEventMock.mockReset().mockResolvedValue(undefined)
		process.env.SLACK_AUTO_PAUSE_ON_KICK = '1'
	})

	afterEach(() => {
		delete process.env.SLACK_AUTO_PAUSE_ON_KICK
	})

	it('no-ops when the SLACK_AUTO_PAUSE_ON_KICK kill switch is off', async () => {
		delete process.env.SLACK_AUTO_PAUSE_ON_KICK
		const { db, mockResults, calls } = createTestContext()
		// Even with a matching integration + trigger queued, the handler must
		// short-circuit before any DB read fires — asserted via the empty calls
		// buffer and the untouched selectQueue.
		mockResults.selectQueue = [[activeSlackIntegration()], [slackChannelTrigger()]]

		const result = await handleMemberLeftChannel(db, memberLeftPayload())

		expect(result.pausedTriggerIds).toEqual([])
		expect(calls.updates).toEqual([])
		expect(calls.inserts).toEqual([])
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('no-ops when no active Slack integration matches the team_id (uninstalled team)', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[]]

		const result = await handleMemberLeftChannel(db, memberLeftPayload({ team_id: 'T_UNKNOWN' }))

		expect(result.pausedTriggerIds).toEqual([])
		expect(calls.updates).toEqual([])
		expect(calls.inserts).toEqual([])
	})

	it('no-ops (per integration) when a human leaves the channel — bot-only guard skips', async () => {
		const { db, mockResults, calls } = createTestContext()
		// Only one select needed — the triggers lookup should never fire because
		// the bot-only guard skips this integration first.
		mockResults.selectQueue = [[activeSlackIntegration()]]

		const result = await handleMemberLeftChannel(db, memberLeftPayload({ user: 'U_HUMAN' }))

		expect(result.pausedTriggerIds).toEqual([])
		expect(calls.updates).toEqual([])
		expect(calls.inserts).toEqual([])
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('no-ops when the bot leaves but no trigger listens on that channel', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[activeSlackIntegration()], []]

		const result = await handleMemberLeftChannel(db, memberLeftPayload())

		expect(result.pausedTriggerIds).toEqual([])
		expect(calls.updates).toEqual([])
		expect(calls.inserts).toEqual([])
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('pauses matching triggers, stamps metadata, writes events + notifications rows, fires PostHog', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [[activeSlackIntegration()], [slackChannelTrigger()]]

		const result = await handleMemberLeftChannel(db, memberLeftPayload())

		expect(result.pausedTriggerIds).toEqual([TRIGGER_ID])

		// The pause update carries both enabled=false AND the auto_paused stamp
		// with previous_enabled=true (trigger was enabled before this handler
		// touched it).
		expect(calls.updates).toHaveLength(1)
		const updateSet = calls.updates[0] as {
			enabled: boolean
			metadata: {
				auto_paused: {
					reason: string
					channel_id: string
					paused_at: string
					previous_enabled: boolean
				}
			}
		}
		expect(updateSet.enabled).toBe(false)
		expect(updateSet.metadata.auto_paused.reason).toBe('slack_member_left')
		expect(updateSet.metadata.auto_paused.channel_id).toBe(CHANNEL_ID)
		expect(updateSet.metadata.auto_paused.previous_enabled).toBe(true)
		expect(typeof updateSet.metadata.auto_paused.paused_at).toBe('string')

		// Two inserts: audit row on events, inbox row on notifications.
		expect(calls.inserts).toHaveLength(2)
		const eventsInsert = calls.inserts[0] as {
			workspaceId: string
			actorId: string
			action: string
			entityType: string
			entityId: string
			data: { reason: string; channel_id: string }
		}
		expect(eventsInsert.workspaceId).toBe(WORKSPACE_ID)
		expect(eventsInsert.actorId).toBe(SYSTEM_ACTOR_ID)
		expect(eventsInsert.action).toBe('auto_paused')
		expect(eventsInsert.entityType).toBe('trigger')
		expect(eventsInsert.entityId).toBe(TRIGGER_ID)
		expect(eventsInsert.data).toEqual({ reason: 'slack_member_left', channel_id: CHANNEL_ID })

		const notifInsert = calls.inserts[1] as {
			workspaceId: string
			type: string
			title: string
			content: string
			sourceActorId: string
			targetActorId: string
			metadata: { reason: string; trigger_id: string; channel_id: string }
			status: string
		}
		expect(notifInsert.workspaceId).toBe(WORKSPACE_ID)
		expect(notifInsert.type).toBe('trigger.auto_paused')
		expect(notifInsert.title).toBe('Trigger auto-paused')
		expect(notifInsert.sourceActorId).toBe(SYSTEM_ACTOR_ID)
		expect(notifInsert.targetActorId).toBe(CREATED_BY)
		expect(notifInsert.metadata).toEqual({
			reason: 'slack_member_left',
			trigger_id: TRIGGER_ID,
			channel_id: CHANNEL_ID,
		})
		expect(notifInsert.status).toBe('unresolved')

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'slack.trigger.auto_paused',
			WORKSPACE_ID,
			expect.objectContaining({
				workspace_id: WORKSPACE_ID,
				slack_team_id: TEAM_ID,
				trigger_id: TRIGGER_ID,
				channel_id: CHANNEL_ID,
				reason: 'member_left',
			}),
		)
	})

	it('still stamps metadata.auto_paused when the trigger is already disabled, carrying previous_enabled=false', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[activeSlackIntegration()],
			[slackChannelTrigger({ enabled: false, metadata: null })],
		]

		const result = await handleMemberLeftChannel(db, memberLeftPayload())

		expect(result.pausedTriggerIds).toEqual([TRIGGER_ID])
		expect(calls.updates).toHaveLength(1)
		const updateSet = calls.updates[0] as {
			enabled: boolean
			metadata: { auto_paused: { previous_enabled: boolean } }
		}
		expect(updateSet.enabled).toBe(false)
		// previous_enabled reflects the pre-pause state — 'already disabled' means
		// Task 4's Resume flow shouldn't re-enable the trigger on click.
		expect(updateSet.metadata.auto_paused.previous_enabled).toBe(false)
	})

	it('short-circuits (no update, no insert) when the trigger is already auto_paused for this channel within the recency window', async () => {
		const { db, mockResults, calls } = createTestContext()
		const freshlyPausedAt = new Date().toISOString()
		mockResults.selectQueue = [
			[activeSlackIntegration()],
			[
				slackChannelTrigger({
					enabled: false,
					metadata: {
						auto_paused: {
							reason: 'slack_member_left',
							channel_id: CHANNEL_ID,
							paused_at: freshlyPausedAt,
							previous_enabled: true,
						},
					},
				}),
			],
		]

		const result = await handleMemberLeftChannel(db, memberLeftPayload())

		// The trigger was matched, but the recency guard skipped it.
		expect(result.pausedTriggerIds).toEqual([])
		expect(calls.updates).toEqual([])
		expect(calls.inserts).toEqual([])
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
