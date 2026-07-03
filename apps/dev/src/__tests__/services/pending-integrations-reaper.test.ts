import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingIntegrationsReaper } from '../../services/pending-integrations-reaper'

type ReapedRow = {
	id: string
	provider: string
	workspaceId: string
}

function makeFakeDb(reaped: ReapedRow[]) {
	const whereSpy = vi.fn()
	const db = {
		delete: () => ({
			where: (predicate: unknown) => {
				whereSpy(predicate)
				return {
					returning: () => Promise.resolve(reaped),
				}
			},
		}),
	}
	return { db, whereSpy }
}

describe('PendingIntegrationsReaper', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-03T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('issues a scoped delete on every tick', async () => {
		const { db, whereSpy } = makeFakeDb([])
		const reaper = new PendingIntegrationsReaper(db as never)

		await reaper.tick()

		expect(whereSpy).toHaveBeenCalledTimes(1)
	})

	it('does not run twice when ticks overlap', async () => {
		let release: (() => void) | null = null
		const whereSpy = vi.fn()
		const db = {
			delete: () => ({
				where: (predicate: unknown) => {
					whereSpy(predicate)
					return {
						returning: () =>
							new Promise<ReapedRow[]>((resolve) => {
								release = () => resolve([])
							}),
					}
				},
			}),
		}
		const reaper = new PendingIntegrationsReaper(db as never)

		const first = reaper.tick()
		await reaper.tick()
		expect(whereSpy).toHaveBeenCalledTimes(1)

		release?.()
		await first
	})

	it('does not throw when the delete fails', async () => {
		const db = {
			delete: () => ({
				where: () => ({
					returning: () => Promise.reject(new Error('db is down')),
				}),
			}),
		}
		const reaper = new PendingIntegrationsReaper(db as never)

		await expect(reaper.tick()).resolves.toBeUndefined()
	})

	it('logs reaped rows with provider summary', async () => {
		const { logger } = await import('../../lib/logger')
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

		const reaped: ReapedRow[] = [
			{ id: '4f338ab2-0000-0000-0000-000000000000', provider: 'github', workspaceId: 'ws-1' },
			{ id: '2d94de1e-0000-0000-0000-000000000000', provider: 'github', workspaceId: 'ws-1' },
		]
		const { db } = makeFakeDb(reaped)
		const reaper = new PendingIntegrationsReaper(db as never)

		await reaper.tick()

		expect(infoSpy).toHaveBeenCalled()
		const call = infoSpy.mock.calls.find((c) =>
			String(c[0]).includes('Reaped stale pending integration rows'),
		)
		expect(call).toBeDefined()
		expect(call?.[1]).toMatchObject({ count: 2, providers: ['github'] })
	})

	it('stays quiet when nothing is reaped', async () => {
		const { logger } = await import('../../lib/logger')
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

		const { db } = makeFakeDb([])
		const reaper = new PendingIntegrationsReaper(db as never)

		await reaper.tick()

		const reapedCall = infoSpy.mock.calls.find((c) =>
			String(c[0]).includes('Reaped stale pending integration rows'),
		)
		expect(reapedCall).toBeUndefined()
	})

	it('accepts a configured threshold', async () => {
		const { db } = makeFakeDb([])
		const reaper = new PendingIntegrationsReaper(db as never, 60_000)

		await expect(reaper.tick()).resolves.toBeUndefined()
	})
})
