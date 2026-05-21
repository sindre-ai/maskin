import { vi } from 'vitest'

const mockContainerManager = {
	ensureImage: vi.fn().mockResolvedValue(undefined),
	createNetwork: vi.fn().mockResolvedValue('net-id'),
	create: vi.fn().mockResolvedValue('container-id-123'),
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	remove: vi.fn().mockResolvedValue(undefined),
	removeNetwork: vi.fn().mockResolvedValue(undefined),
	inspect: vi.fn().mockResolvedValue({ running: false, exitCode: 0 }),
}

vi.mock('../../services/container-manager', () => ({
	ContainerManager: vi.fn().mockImplementation(() => mockContainerManager),
}))

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthBrowserManager } from '../../services/auth-browser-manager'
import { createTestContext } from '../setup'

function resetMocks() {
	for (const fn of Object.values(mockContainerManager)) {
		if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear()
	}
}

describe('AuthBrowserManager', () => {
	beforeEach(() => {
		resetMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('startSession', () => {
		it('inserts a row with status=starting and returns id + accessToken', async () => {
			const { db, mockResults, calls } = createTestContext()
			// First select (concurrency check) → no active flow
			// Insert → returns one row
			mockResults.selectQueue = [[]]
			mockResults.insert = [
				{
					id: 'abs-001',
					workspaceId: 'ws-1',
					actorId: 'actor-1',
					provider: 'linkedin',
					status: 'starting',
					accessToken: 'token-xyz',
					expiresAt: new Date(Date.now() + 600_000),
				},
			]

			const mgr = new AuthBrowserManager(db)
			const result = await mgr.startSession({
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				provider: 'linkedin',
			})

			expect(result.id).toBe('abs-001')
			expect(result.accessToken).toBeTruthy()
			expect(result.expiresAt).toBeInstanceOf(Date)

			// Verify the inserted row carried the expected shape
			expect(calls.inserts).toHaveLength(1)
			const inserted = calls.inserts[0] as Record<string, unknown>
			expect(inserted.workspaceId).toBe('ws-1')
			expect(inserted.actorId).toBe('actor-1')
			expect(inserted.provider).toBe('linkedin')
			expect(inserted.status).toBe('starting')
			expect(typeof inserted.accessToken).toBe('string')
			expect(inserted.expiresAt).toBeInstanceOf(Date)
		})

		it('rejects when another flow is already active in the workspace', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.selectQueue = [
				[{ id: 'abs-existing' }], // concurrency check finds an active row
			]
			const mgr = new AuthBrowserManager(db)
			await expect(
				mgr.startSession({ workspaceId: 'ws-1', actorId: 'actor-1', provider: 'linkedin' }),
			).rejects.toThrow(/already running/i)
		})
	})

	describe('stopSession', () => {
		it('stops + removes the container and network, flips status to failed', async () => {
			const { db, mockResults, calls } = createTestContext()
			mockResults.select = [
				{
					id: 'abs-001',
					containerId: 'container-id-123',
					networkName: 'anko-auth-net-abc',
					status: 'ready',
				},
			]

			const mgr = new AuthBrowserManager(db)
			await mgr.stopSession('abs-001')

			expect(mockContainerManager.stop).toHaveBeenCalledWith('container-id-123')
			expect(mockContainerManager.remove).toHaveBeenCalledWith('container-id-123')
			expect(mockContainerManager.removeNetwork).toHaveBeenCalledWith('anko-auth-net-abc')

			expect(calls.updates).toHaveLength(1)
			const update = calls.updates[0] as Record<string, unknown>
			expect(update.status).toBe('failed')
			expect(update.containerId).toBeNull()
			expect(update.networkName).toBeNull()
		})

		it('preserves captured status when stopping a captured session', async () => {
			const { db, mockResults, calls } = createTestContext()
			mockResults.select = [
				{ id: 'abs-002', containerId: 'cid', networkName: 'net', status: 'captured' },
			]
			const mgr = new AuthBrowserManager(db)
			await mgr.stopSession('abs-002')
			const update = calls.updates[0] as Record<string, unknown>
			expect(update.status).toBe('captured')
		})

		it('is a no-op when the row does not exist', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = []
			const mgr = new AuthBrowserManager(db)
			await mgr.stopSession('missing-id')
			expect(mockContainerManager.stop).not.toHaveBeenCalled()
		})
	})

	describe('markCaptured', () => {
		it('writes encrypted credentials, flips status to captured, and tears down', async () => {
			const { db, mockResults, calls } = createTestContext()
			mockResults.selectQueue = [
				// stopSession's lookup
				[{ id: 'abs-1', containerId: 'cid', networkName: 'net', status: 'captured' }],
			]
			const mgr = new AuthBrowserManager(db)
			await mgr.markCaptured('abs-1', 'encrypted-blob')

			expect(calls.updates).toHaveLength(2)
			const captureUpdate = calls.updates[0] as Record<string, unknown>
			expect(captureUpdate.status).toBe('captured')
			expect(captureUpdate.capturedCredentials).toBe('encrypted-blob')

			expect(mockContainerManager.stop).toHaveBeenCalledWith('cid')
			expect(mockContainerManager.removeNetwork).toHaveBeenCalledWith('net')
		})
	})

	describe('getCdpEndpoint', () => {
		it('returns ws URL when row is ready, token matches, and not expired', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = [
				{
					id: 'abcdef12-rest-of-uuid',
					status: 'ready',
					accessToken: 'tok-1',
					expiresAt: new Date(Date.now() + 60_000),
				},
			]
			const mgr = new AuthBrowserManager(db)
			const url = await mgr.getCdpEndpoint('abcdef12-rest-of-uuid', 'tok-1')
			expect(url).toBe('ws://anko-auth-browser-abcdef12:9222')
		})

		it('returns null when access token does not match', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = [
				{ id: 'x', status: 'ready', accessToken: 'real', expiresAt: new Date(Date.now() + 60_000) },
			]
			const mgr = new AuthBrowserManager(db)
			expect(await mgr.getCdpEndpoint('x', 'wrong')).toBeNull()
		})

		it('returns null when status is not ready', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = [
				{
					id: 'x',
					status: 'starting',
					accessToken: 'tok',
					expiresAt: new Date(Date.now() + 60_000),
				},
			]
			const mgr = new AuthBrowserManager(db)
			expect(await mgr.getCdpEndpoint('x', 'tok')).toBeNull()
		})

		it('returns null when expired', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = [
				{ id: 'x', status: 'ready', accessToken: 'tok', expiresAt: new Date(Date.now() - 1000) },
			]
			const mgr = new AuthBrowserManager(db)
			expect(await mgr.getCdpEndpoint('x', 'tok')).toBeNull()
		})

		it('returns null when row is missing', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = []
			const mgr = new AuthBrowserManager(db)
			expect(await mgr.getCdpEndpoint('nope', 'tok')).toBeNull()
		})
	})

	describe('reapExpired', () => {
		it('tears down expired sessions and flips status to expired', async () => {
			const { db, mockResults, calls } = createTestContext()
			mockResults.select = [
				{ id: 'e-1', containerId: 'cid-1', networkName: 'net-1' },
				{ id: 'e-2', containerId: null, networkName: 'net-2' },
			]
			const mgr = new AuthBrowserManager(db)
			await mgr.reapExpired()

			expect(mockContainerManager.stop).toHaveBeenCalledWith('cid-1')
			expect(mockContainerManager.removeNetwork).toHaveBeenCalledWith('net-1')
			expect(mockContainerManager.removeNetwork).toHaveBeenCalledWith('net-2')
			expect(calls.updates).toHaveLength(2)
			for (const u of calls.updates) {
				expect((u as Record<string, unknown>).status).toBe('expired')
			}
		})

		it('is a no-op when nothing is expired', async () => {
			const { db, mockResults } = createTestContext()
			mockResults.select = []
			const mgr = new AuthBrowserManager(db)
			await mgr.reapExpired()
			expect(mockContainerManager.stop).not.toHaveBeenCalled()
		})
	})
})
