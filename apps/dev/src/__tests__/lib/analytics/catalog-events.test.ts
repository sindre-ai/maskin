import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	claimLoopActiveDay,
	computeConsecutiveDaysStreak,
	trackLoopActiveDay,
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
	it('emits package_forked with package_slug, package_version, and source_install_id', async () => {
		await trackPackageForked({
			packageId: 'pkg-1',
			packageSlug: 'customer-continuous-discovery',
			packageVersion: '1.2.0',
			sourceInstallId: 'install-1',
			workspaceId: 'ws-1',
			actorId: 'actor-1',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('package_forked', 'ws-1', {
			package_id: 'pkg-1',
			package_slug: 'customer-continuous-discovery',
			package_version: '1.2.0',
			source_install_id: 'install-1',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})

describe('trackLoopActiveDay', () => {
	it('emits loop_active_day with install_id, day, and consecutive_days', async () => {
		await trackLoopActiveDay({
			installId: 'install-1',
			packageId: 'pkg-1',
			workspaceId: 'ws-1',
			day: '2026-06-13',
			consecutiveDays: 7,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('loop_active_day', 'ws-1', {
			install_id: 'install-1',
			package_id: 'pkg-1',
			workspace_id: 'ws-1',
			day: '2026-06-13',
			consecutive_days: 7,
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

		// select(...).from(...).where(...).limit(...)
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
			[[{ id: 'install-1', sourcePackageId: 'pkg-1', workspaceId: 'ws-1' }]],
		)
		const result = await claimLoopActiveDay(
			db as unknown as Parameters<typeof claimLoopActiveDay>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toEqual({
			installedPackageId: 'install-1',
			packageId: 'pkg-1',
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
})

describe('computeConsecutiveDaysStreak', () => {
	function makeDb(rows: Array<{ utcDay: string }>) {
		const limit = vi.fn().mockResolvedValue(rows)
		const orderBy = vi.fn().mockReturnValue({ limit })
		const where = vi.fn().mockReturnValue({ orderBy })
		const from = vi.fn().mockReturnValue({ where })
		const select = vi.fn().mockReturnValue({ from })
		return { select }
	}

	it('returns 0 when today has not been claimed', async () => {
		const db = makeDb([])
		const result = await computeConsecutiveDaysStreak(
			db as unknown as Parameters<typeof computeConsecutiveDaysStreak>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBe(0)
	})

	it('counts a single day when only today is claimed', async () => {
		const db = makeDb([{ utcDay: '2026-06-13' }])
		const result = await computeConsecutiveDaysStreak(
			db as unknown as Parameters<typeof computeConsecutiveDaysStreak>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBe(1)
	})

	it('counts an unbroken streak ending at utcDay', async () => {
		const db = makeDb([
			{ utcDay: '2026-06-13' },
			{ utcDay: '2026-06-12' },
			{ utcDay: '2026-06-11' },
			{ utcDay: '2026-06-10' },
		])
		const result = await computeConsecutiveDaysStreak(
			db as unknown as Parameters<typeof computeConsecutiveDaysStreak>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBe(4)
	})

	it('stops at the first gap walking backwards', async () => {
		// 2026-06-13, 2026-06-12 are consecutive; 2026-06-10 is a gap (no 06-11).
		const db = makeDb([
			{ utcDay: '2026-06-13' },
			{ utcDay: '2026-06-12' },
			{ utcDay: '2026-06-10' },
			{ utcDay: '2026-06-09' },
		])
		const result = await computeConsecutiveDaysStreak(
			db as unknown as Parameters<typeof computeConsecutiveDaysStreak>[0],
			'install-1',
			'2026-06-13',
		)
		expect(result).toBe(2)
	})

	it('crosses month boundaries correctly', async () => {
		// 2026-07-01, 2026-06-30, 2026-06-29 — must still count as 3.
		const db = makeDb([
			{ utcDay: '2026-07-01' },
			{ utcDay: '2026-06-30' },
			{ utcDay: '2026-06-29' },
		])
		const result = await computeConsecutiveDaysStreak(
			db as unknown as Parameters<typeof computeConsecutiveDaysStreak>[0],
			'install-1',
			'2026-07-01',
		)
		expect(result).toBe(3)
	})
})
