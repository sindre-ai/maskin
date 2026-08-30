import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDecrypt } = vi.hoisted(() => ({
	mockDecrypt: vi.fn(),
}))

vi.mock('../../lib/crypto', () => ({
	decrypt: mockDecrypt,
}))

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	_resetSlackCaches,
	type SlackConversation,
} from '../../lib/integrations/providers/slack/client'
import {
	extractSlackChannelIds,
	runSlackTriggerSetup,
} from '../../services/slack-trigger-setup'
import { buildIntegration } from '../factories'
import { createTestContext } from '../setup'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const TRIGGER_ID = '00000000-0000-0000-0000-000000000020'
const ACTOR_ID = '00000000-0000-0000-0000-000000000030'
const INTEGRATION_ID = '00000000-0000-0000-0000-000000000040'

function activeSlackIntegration(overrides?: Record<string, unknown>) {
	return buildIntegration({
		id: INTEGRATION_ID,
		workspaceId: WORKSPACE_ID,
		provider: 'slack',
		status: 'active',
		externalId: 'T123ABC',
		credentials: 'encrypted-blob',
		...overrides,
	})
}

/**
 * Wire the mock db so `runSlackTriggerSetup` observes:
 *   - one active Slack integration for the workspace,
 *   - the trigger row (used by loadExistingSetup + persistSetupResult).
 * `selectQueue` matches the reads in service order: integration lookup,
 * loadExistingSetup, then a final read inside persistSetupResult before the
 * merge write.
 */
function stubReads(mockResults: Record<string, unknown>, existingSetup?: Record<string, unknown>) {
	const md = existingSetup ? { slack_setup: existingSetup } : null
	mockResults.selectQueue = [
		[activeSlackIntegration()], // resolveSlackContext
		[{ metadata: md }], // loadExistingSetup
		[{ metadata: md }], // persistSetupResult read-before-write
	]
}

/** Queue fake fetch responses matching the service's call order:
 *  conversations.list (privacy check) → per-channel conversations.join → per-successful-channel chat.postMessage. */
function queueFetchResponses(fetchMock: ReturnType<typeof vi.fn>, ...bodies: unknown[]) {
	for (const b of bodies) {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => b,
			text: async () => JSON.stringify(b),
		} as Response)
	}
}

// Build a `conversations.list` payload the client's fetch path expects.
function convList(channels: Array<Partial<SlackConversation> & { id: string; name: string }>) {
	return {
		ok: true,
		channels: channels.map((c) => ({
			is_private: false,
			is_im: false,
			is_mpim: false,
			is_channel: true,
			...c,
		})),
	}
}

describe('runSlackTriggerSetup', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		_resetSlackCaches()
		capturePosthogEventMock.mockClear()
		mockDecrypt.mockReturnValue(JSON.stringify({ accessToken: 'xoxb-test-token' }))
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('joins each channel, posts one confirmation per channel, and persists the metadata', async () => {
		const { db, mockResults, calls } = createTestContext()
		stubReads(mockResults)
		queueFetchResponses(
			fetchMock,
			convList([
				{ id: 'C1', name: 'general' },
				{ id: 'C2', name: 'random' },
			]),
			{ ok: true }, // join C1
			{ ok: true, ts: '1.001' }, // confirmation C1
			{ ok: true }, // join C2
			{ ok: true, ts: '1.002' }, // confirmation C2
		)

		await runSlackTriggerSetup(db, {
			triggerId: TRIGGER_ID,
			workspaceId: WORKSPACE_ID,
			channelIds: ['C1', 'C2'],
			triggerName: 'Sales alerts',
			actorId: ACTOR_ID,
		})

		// Assert the write's metadata shape (spec §2/§4).
		const written = calls.updates.at(-1) as { metadata: Record<string, unknown> }
		const setup = written.metadata.slack_setup as {
			channel_ids: string[]
			join_attempts: Array<{ channel_id: string; status: string }>
			confirmation_posted_at: Record<string, string>
			last_setup_at: string
		}
		expect(setup.channel_ids).toEqual(['C1', 'C2'])
		expect(setup.join_attempts.map((a) => a.status)).toEqual(['joined', 'joined'])
		expect(Object.keys(setup.confirmation_posted_at).sort()).toEqual(['C1', 'C2'])
		expect(typeof setup.last_setup_at).toBe('string')

		// Confirmation posts fire (`chat.postMessage`), once per channel.
		const postMessageCalls = fetchMock.mock.calls.filter(
			(c) => (c[0] as string) === 'https://slack.com/api/chat.postMessage',
		)
		expect(postMessageCalls).toHaveLength(2)
		const firstPostBody = JSON.parse((postMessageCalls[0][1] as RequestInit).body as string)
		expect(firstPostBody.text).toBe(
			'Maskin is now listening here for "Sales alerts" — @-mention me or reply to fire.',
		)
		expect(firstPostBody.attachments[0].blocks[1].elements.map((e: { text: { text: string } }) => e.text.text)).toEqual([
			'View trigger',
			'Pause',
		])

		// PostHog: one auto_join.attempted per channel + one message.posted per channel.
		const attempts = capturePosthogEventMock.mock.calls.filter((c) => c[0] === 'slack.auto_join.attempted')
		const posts = capturePosthogEventMock.mock.calls.filter((c) => c[0] === 'slack.message.posted')
		expect(attempts).toHaveLength(2)
		expect(posts).toHaveLength(2)
		expect(posts[0][2]).toMatchObject({ confirmation_type: 'trigger_setup', trigger_id: TRIGGER_ID })
	})

	it('skips the join API call and records not_public for a private channel', async () => {
		const { db, mockResults, calls } = createTestContext()
		stubReads(mockResults)
		queueFetchResponses(
			fetchMock,
			convList([{ id: 'CPRIV', name: 'founders', is_private: true }]),
			// No join, no confirmation — nothing else should be queued.
		)

		await runSlackTriggerSetup(db, {
			triggerId: TRIGGER_ID,
			workspaceId: WORKSPACE_ID,
			channelIds: ['CPRIV'],
			triggerName: 'Founders-only',
			actorId: ACTOR_ID,
		})

		// Only the conversations.list call should have fired — no join, no post.
		expect(
			fetchMock.mock.calls.filter((c) =>
				(c[0] as string).includes('/api/conversations.join'),
			),
		).toHaveLength(0)
		expect(
			fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/api/chat.postMessage')),
		).toHaveLength(0)

		const written = calls.updates.at(-1) as { metadata: Record<string, unknown> }
		const setup = written.metadata.slack_setup as {
			join_attempts: Array<{ status: string }>
			confirmation_posted_at?: Record<string, string>
		}
		expect(setup.join_attempts).toEqual([
			expect.objectContaining({ channel_id: 'CPRIV', status: 'not_public' }),
		])
		expect(setup.confirmation_posted_at).toBeUndefined()

		// The auto_join event still fires so the funnel captures the private
		// channel skip (spec §9 `outcome: not_public`).
		expect(
			capturePosthogEventMock.mock.calls.find((c) => c[0] === 'slack.auto_join.attempted')?.[2],
		).toMatchObject({ outcome: 'not_public', is_private: true })
	})

	it('is idempotent — a re-run does not re-post the confirmation for an already-joined channel', async () => {
		const { db, mockResults, calls } = createTestContext()
		stubReads(mockResults, {
			channel_ids: ['C1'],
			join_attempts: [{ channel_id: 'C1', status: 'joined', attempted_at: '2026-08-01T00:00:00Z' }],
			confirmation_posted_at: { C1: '2026-08-01T00:00:01Z' },
			last_setup_at: '2026-08-01T00:00:01Z',
		})
		queueFetchResponses(
			fetchMock,
			convList([{ id: 'C1', name: 'general' }]),
			// No join queued — service short-circuits on the cached 'joined' status.
			// No confirmation queued — dedup on confirmation_posted_at.
		)

		await runSlackTriggerSetup(db, {
			triggerId: TRIGGER_ID,
			workspaceId: WORKSPACE_ID,
			channelIds: ['C1'],
			triggerName: 'Sales alerts',
			actorId: ACTOR_ID,
		})

		expect(
			fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/api/conversations.join')),
		).toHaveLength(0)
		expect(
			fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/api/chat.postMessage')),
		).toHaveLength(0)

		const written = calls.updates.at(-1) as { metadata: Record<string, unknown> }
		const setup = written.metadata.slack_setup as {
			join_attempts: Array<{ status: string }>
			confirmation_posted_at: Record<string, string>
		}
		expect(setup.join_attempts[0].status).toBe('already_in')
		expect(setup.confirmation_posted_at.C1).toBe('2026-08-01T00:00:01Z')
	})

	it('records not_authed for every channel when no active Slack integration exists', async () => {
		const { db, mockResults, calls } = createTestContext()
		// resolveSlackContext returns null → the not-authed branch fires.
		mockResults.selectQueue = [
			[], // no integration
			// persist path still runs one read-before-write.
			[{ metadata: null }],
		]

		await runSlackTriggerSetup(db, {
			triggerId: TRIGGER_ID,
			workspaceId: WORKSPACE_ID,
			channelIds: ['C1', 'C2'],
			triggerName: 'Sales alerts',
			actorId: ACTOR_ID,
		})

		expect(fetchMock).not.toHaveBeenCalled()
		const written = calls.updates.at(-1) as { metadata: Record<string, unknown> }
		const setup = written.metadata.slack_setup as {
			join_attempts: Array<{ status: string }>
		}
		expect(setup.join_attempts.map((a) => a.status)).toEqual(['not_authed', 'not_authed'])
	})
})

describe('extractSlackChannelIds', () => {
	it('picks channel ids out of event.channel and event.item.channel `in` conditions', () => {
		const ids = extractSlackChannelIds({
			entity_type: 'slack.channel_message',
			action: 'created',
			conditions: [
				{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] },
				{ field: 'event.item.channel', operator: 'in', value: ['C2', 'C3'] },
				{ field: 'event.user', operator: 'in', value: ['U1'] },
			],
		})
		// Union, dedup preserving first-seen order.
		expect(ids).toEqual(['C1', 'C2', 'C3'])
	})

	it('returns an empty list for non-Slack triggers, so the route skips the setup service', () => {
		expect(
			extractSlackChannelIds({ entity_type: 'task', action: 'created' }),
		).toEqual([])
		expect(extractSlackChannelIds(null)).toEqual([])
	})

	it('ignores exclude filters — the setup service only joins channels the trigger listens on', () => {
		const ids = extractSlackChannelIds({
			conditions: [
				{ field: 'event.channel', operator: 'not_in', value: ['CBLOCK'] },
				{ field: 'event.channel', operator: 'in', value: ['CLISTEN'] },
			],
		})
		expect(ids).toEqual(['CLISTEN'])
	})
})
