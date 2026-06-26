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
	trackObjectCreated,
	trackObjectDriverChanged,
	trackPackageForked,
	trackPackageInstalled,
	utcDayString,
} from '../../../lib/analytics/catalog-events'

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

describe('trackPackageInstalled', () => {
	it('emits package_installed with workspace as distinct id and the contracted props', async () => {
		await trackPackageInstalled({
			packageId: 'pkg-1',
			packageSlug: 'customer-continuous-discovery',
			packageVersion: '1.0.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('package_installed', 'ws-1', {
			package_id: 'pkg-1',
			package_slug: 'customer-continuous-discovery',
			package_version: '1.0.0',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})

describe('trackPackageForked', () => {
	it('emits package_forked with version_at_fork and the install id', async () => {
		await trackPackageForked({
			packageId: 'pkg-1',
			installedPackageId: 'install-1',
			versionAtFork: '1.2.0',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('package_forked', 'ws-1', {
			package_id: 'pkg-1',
			installed_package_id: 'install-1',
			version_at_fork: '1.2.0',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})

describe('trackLoopActiveDay', () => {
	it('emits loop_active_day with utc_day and slug', async () => {
		await trackLoopActiveDay({
			installedPackageId: 'install-1',
			packageId: 'pkg-1',
			packageSlug: 'customer-continuous-discovery',
			workspaceId: 'ws-1',
			utcDay: '2026-06-13',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_active_day', 'ws-1', {
			installed_package_id: 'install-1',
			package_id: 'pkg-1',
			package_slug: 'customer-continuous-discovery',
			workspace_id: 'ws-1',
			utc_day: '2026-06-13',
		})
	})
})

describe('trackObjectCreated', () => {
	it('emits object_created with workspace as distinct id and driver_actor_id', async () => {
		await trackObjectCreated({
			entityId: 'obj-1',
			entityType: 'task',
			driverActorId: 'actor-9',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('object_created', 'ws-1', {
			entity_id: 'obj-1',
			entity_type: 'task',
			driver_actor_id: 'actor-9',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})

	it('passes null driver_actor_id through unchanged', async () => {
		await trackObjectCreated({
			entityId: 'obj-2',
			entityType: 'bet',
			driverActorId: null,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('object_created', 'ws-1', {
			entity_id: 'obj-2',
			entity_type: 'bet',
			driver_actor_id: null,
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})

describe('trackObjectDriverChanged', () => {
	it('emits object_driver_changed with previous and next driver', async () => {
		await trackObjectDriverChanged({
			entityId: 'obj-1',
			entityType: 'task',
			driverActorId: 'actor-9',
			previousDriverActorId: 'actor-8',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('object_driver_changed', 'ws-1', {
			entity_id: 'obj-1',
			entity_type: 'task',
			driver_actor_id: 'actor-9',
			previous_driver_actor_id: 'actor-8',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})

	it('carries null when driver is cleared', async () => {
		await trackObjectDriverChanged({
			entityId: 'obj-2',
			entityType: 'bet',
			driverActorId: null,
			previousDriverActorId: 'actor-8',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('object_driver_changed', 'ws-1', {
			entity_id: 'obj-2',
			entity_type: 'bet',
			driver_actor_id: null,
			previous_driver_actor_id: 'actor-8',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
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

	it('returns the resolved package context when the claim is won', async () => {
		const db = makeDb(
			[{ installedPackageId: 'install-1' }],
			[
				[{ id: 'install-1', sourcePackageId: 'pkg-1', workspaceId: 'ws-1' }],
				[{ slug: 'customer-continuous-discovery' }],
			],
		)
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toEqual({
			installedPackageId: 'install-1',
			packageId: 'pkg-1',
			packageSlug: 'customer-continuous-discovery',
			workspaceId: 'ws-1',
		})
	})

	it('returns null when the install row is gone before the lookup', async () => {
		const db = makeDb([{ installedPackageId: 'install-1' }], [[]])
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBeNull()
	})

	it('returns null when the catalog package row is gone before the slug lookup', async () => {
		const db = makeDb(
			[{ installedPackageId: 'install-1' }],
			[[{ id: 'install-1', sourcePackageId: 'pkg-1', workspaceId: 'ws-1' }], []],
		)
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBeNull()
	})
})
