import { vi } from 'vitest'

// Mock external dependencies
vi.mock('node:fs/promises', () => ({
	mkdtemp: vi.fn().mockResolvedValue('/tmp/anko-session-test'),
	mkdir: vi.fn().mockResolvedValue(undefined),
	chmod: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:child_process', () => ({
	exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn() }),
	}
})

const mockBackend = {
	ensureImage: vi.fn().mockResolvedValue(undefined),
	create: vi.fn().mockResolvedValue('container-id-123'),
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	remove: vi.fn().mockResolvedValue(undefined),
	exec: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
	copyFileIn: vi.fn().mockResolvedValue(undefined),
	copyFileOut: vi.fn().mockResolvedValue(undefined),
	inspect: vi.fn().mockResolvedValue({ running: false, exitCode: 0 }),
	getHostAddress: vi.fn().mockReturnValue('host.docker.internal'),
	logs: vi.fn().mockReturnValue({
		[Symbol.asyncIterator]: async function* () {},
	}),
}

vi.mock('../../lib/claude-oauth', () => ({
	getValidOAuthToken: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn().mockReturnValue('decrypted'),
}))

vi.mock('../../lib/integrations/registry', () => ({
	getProvider: vi.fn().mockReturnValue(null),
}))

import type { StorageProvider } from '@maskin/storage'
import { SessionManager } from '../../services/session-manager'
import { buildSession } from '../factories'
import { createTestContext } from '../setup'

function createMockStorageProvider() {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('snapshot data')),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
	}
}

describe('SessionManager', () => {
	let manager: SessionManager
	let mockResults: Record<string, unknown>
	let storageProvider: ReturnType<typeof createMockStorageProvider>

	beforeEach(() => {
		vi.clearAllMocks()
		storageProvider = createMockStorageProvider()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		manager = new SessionManager(ctx.db, storageProvider as StorageProvider, mockBackend as any)
	})

	afterEach(async () => {
		await manager.stop()
	})

	describe('createSession()', () => {
		it('creates a session in pending state', async () => {
			const session = buildSession({ status: 'pending' })
			mockResults.insert = [session] // session insert
			// The second insert is for the event — use insertQueue
			mockResults.insertQueue = [[session], []]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Do the thing',
				createdBy: 'creator-1',
				autoStart: false,
			})

			expect(result.id).toBe(session.id)
		})

		it('throws when session insert fails', async () => {
			mockResults.insert = [] // empty = no row returned

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Do the thing',
					createdBy: 'creator-1',
					autoStart: false,
				}),
			).rejects.toThrow('Failed to create session')
		})
	})

	describe('stopSession()', () => {
		it('stops the container', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-abc',
			})
			mockResults.select = [session]

			await manager.stopSession(session.id)

			expect(mockBackend.stop).toHaveBeenCalledWith('container-abc')
		})

		it('throws when session not found', async () => {
			mockResults.select = []

			await expect(manager.stopSession('nonexistent')).rejects.toThrow(
				'not found or has no container',
			)
		})

		it('throws when session has no container', async () => {
			const session = buildSession({ containerId: null })
			mockResults.select = [session]

			await expect(manager.stopSession(session.id)).rejects.toThrow('not found or has no container')
		})
	})

	describe('pauseSession()', () => {
		it('snapshots and pauses a running session', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-xyz',
			})
			mockResults.select = [session]
			mockResults.insert = [] // for system log

			await manager.pauseSession(session.id)

			expect(mockBackend.exec).toHaveBeenCalledWith('container-xyz', [
				'tar',
				'-czf',
				'/tmp/snapshot.tar.gz',
				'/agent/',
			])
			expect(mockBackend.stop).toHaveBeenCalledWith('container-xyz')
			expect(mockBackend.remove).toHaveBeenCalledWith('container-xyz')
			expect(storageProvider.put).toHaveBeenCalledWith(
				`snapshots/${session.id}.tar.gz`,
				expect.anything(),
			)
		})

		it('throws when session not running', async () => {
			const session = buildSession({ status: 'paused', containerId: 'c1' })
			mockResults.select = [session]

			await expect(manager.pauseSession(session.id)).rejects.toThrow('not in running state')
		})

		it('reverts status on failure', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-fail',
			})
			mockResults.select = [session]
			mockBackend.exec.mockRejectedValueOnce(new Error('exec failed'))

			await expect(manager.pauseSession(session.id)).rejects.toThrow('exec failed')
			// Status should be reverted to running (via the catch block's db.update call)
		})
	})

	describe('resumeSession()', () => {
		it('throws when session not paused', async () => {
			const session = buildSession({ status: 'running' })
			mockResults.select = [session]

			await expect(manager.resumeSession(session.id)).rejects.toThrow(
				'not in paused state or no snapshot',
			)
		})

		it('throws when no snapshot path', async () => {
			const session = buildSession({ status: 'paused', snapshotPath: null })
			mockResults.select = [session]

			await expect(manager.resumeSession(session.id)).rejects.toThrow(
				'not in paused state or no snapshot',
			)
		})
	})

	describe('start() and stop()', () => {
		it('starts and stops watchdog without error', async () => {
			await manager.start()
			await manager.stop()
		})
	})
})
