import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	claimLoopActiveDay,
	trackLoopActiveDay,
	trackLoopForked,
	trackLoopInstalled,
	trackLoopUninstalled,
	trackSlackMentionReceived,
	utcDayString,
} from '../../../lib/analytics/loop-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('utcDayString', () => {
	it('returns YYYY-MM-DD for the given date', () => {
		expect(utcDayString(new Date('2026-06-13T22:31:00Z'))).toBe('2026-06-13')
	})

	it('is UTC-stable across the day boundary', () => {
		// 2026-06-13 23:59:59 UTC and 2026-06-14 00:00:00 UTC must produce
		// different strings — the idempotency claim depends on it.
		expect(utcDayString(new Date('2026-06-13T23:59:59Z'))).toBe('2026-06-13')
		expect(utcDayString(new Date('2026-06-14T00:00:00Z'))).toBe('2026-06-14')
	})
})

describe('trackLoopInstalled', () => {
	it('emits loop_installed with workspace as distinct id and the contracted props', async () => {
		await trackLoopInstalled({
			loopId: 'loop-1',
			loopSlug: 'customer-continuous-discovery',
			loopVersion: '1.0.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			provisioned: { actors: 2, triggers: 1, skills: 0, integrations: 1 },
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_installed', 'ws-1', {
			loop_id: 'loop-1',
			loop_slug: 'customer-continuous-discovery',
			loop_version: '1.0.0',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			component_type_count: 3,
			component_types: ['actor', 'trigger', 'integration'],
		})
	})

	it('reports component_type_count 0 with an empty component_types array for an item-less install', async () => {
		await trackLoopInstalled({
			loopId: 'loop-1',
			loopSlug: 'placeholder',
			loopVersion: '0.1.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.component_type_count).toBe(0)
		expect(props.component_types).toEqual([])
	})

	it('counts distinct types, not element counts (single-item card stays at count 1)', async () => {
		await trackLoopInstalled({
			loopId: 'loop-1',
			loopSlug: 'triple-actor',
			loopVersion: '1.0.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			provisioned: { actors: 3, triggers: 0, skills: 0, integrations: 0 },
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.component_type_count).toBe(1)
		expect(props.component_types).toEqual(['actor'])
	})
})

describe('trackLoopForked', () => {
	it('emits loop_forked with version_at_fork and the install id', async () => {
		await trackLoopForked({
			loopId: 'loop-1',
			installedLoopId: 'install-1',
			versionAtFork: '1.2.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_forked', 'ws-1', {
			loop_id: 'loop-1',
			installed_loop_id: 'install-1',
			version_at_fork: '1.2.0',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})

describe('trackLoopUninstalled', () => {
	it('emits loop_uninstalled with the kept_items flag', async () => {
		await trackLoopUninstalled({
			loopId: 'loop-1',
			installedLoopId: 'install-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			keptItems: true,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_uninstalled', 'ws-1', {
			loop_id: 'loop-1',
			installed_loop_id: 'install-1',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			kept_items: true,
		})
	})
})

describe('trackSlackMentionReceived', () => {
	it('emits slack_mention_received with the workspace as distinct id and contracted props', async () => {
		await trackSlackMentionReceived({
			actorId: 'actor-1',
			workspaceId: 'ws-1',
			channelType: 'channel',
			slackTeamId: 'T123',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('slack_mention_received', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			channel_type: 'channel',
			agent: 'workspace_coach',
			slack_team_id: 'T123',
		})
	})

	it('does not include a raw Slack user id (PII guard)', async () => {
		// Anonymisation contract: only the resolved Maskin actor id is sent —
		// `slack_user_id` is deliberately omitted from the prop bag. This test
		// fails if a future refactor leaks it in.
		await trackSlackMentionReceived({
			actorId: 'actor-1',
			workspaceId: 'ws-1',
			channelType: 'im',
			slackTeamId: 'T123',
		})
		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props).not.toHaveProperty('slack_user_id')
		expect(props).not.toHaveProperty('user_id')
	})
})

describe('trackLoopActiveDay', () => {
	it('emits loop_active_day with utc_day and slug', async () => {
		await trackLoopActiveDay({
			installedLoopId: 'install-1',
			loopId: 'loop-1',
			loopSlug: 'customer-continuous-discovery',
			workspaceId: 'ws-1',
			utcDay: '2026-06-13',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_active_day', 'ws-1', {
			installed_loop_id: 'install-1',
			loop_id: 'loop-1',
			loop_slug: 'customer-continuous-discovery',
			workspace_id: 'ws-1',
			utc_day: '2026-06-13',
		})
	})
})

describe('claimLoopActiveDay', () => {
	function makeDb(claimRows: Array<unknown>, selectRowsQueue: Array<Array<unknown>>) {
		// insert(...).values(...).onConflictDoNothing(...).returning(...)
		const returning = vi.fn().mockResolvedValue(claimRows)
		const onConflictDoNothing = vi.fn().mockReturnValue({ returning })
		const values = vi.fn().mockReturnValue({ onConflictDoNothing })
		const insert = vi.fn().mockReturnValue({ values })

		// select(...).from(...).where(...).limit(...) — chained twice
		const limit = vi.fn().mockImplementation(() => Promise.resolve(selectRowsQueue.shift() ?? []))
		const where = vi.fn().mockReturnValue({ limit })
		const from = vi.fn().mockReturnValue({ where })
		const select = vi.fn().mockReturnValue({ from })

		return { insert, select }
	}

	it('returns null when the day has already been claimed (no returning row)', async () => {
		const db = makeDb([], [])
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBeNull()
		expect(db.select).not.toHaveBeenCalled()
	})

	it('returns the resolved loop context when the claim is won', async () => {
		const db = makeDb(
			[{ installedLoopId: 'install-1' }],
			[
				[{ id: 'install-1', sourceLoopId: 'loop-1', workspaceId: 'ws-1' }],
				[{ slug: 'customer-continuous-discovery' }],
			],
		)
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toEqual({
			installedLoopId: 'install-1',
			loopId: 'loop-1',
			loopSlug: 'customer-continuous-discovery',
			workspaceId: 'ws-1',
		})
	})

	it('returns null when the install row is gone before the lookup', async () => {
		const db = makeDb([{ installedLoopId: 'install-1' }], [[]])
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBeNull()
	})

	it('returns null when the marketplace loop row is gone before the slug lookup', async () => {
		const db = makeDb(
			[{ installedLoopId: 'install-1' }],
			[[{ id: 'install-1', sourceLoopId: 'loop-1', workspaceId: 'ws-1' }], []],
		)
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBeNull()
	})
})
