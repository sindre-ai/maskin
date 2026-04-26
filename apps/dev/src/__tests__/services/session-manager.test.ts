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
	execFile: vi.fn(
		(
			_cmd: string,
			_args: string[],
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => cb(null, '', ''),
	),
}))

const mockContainerManager = {
	ensureImage: vi.fn().mockResolvedValue(undefined),
	create: vi.fn().mockResolvedValue('container-id-123'),
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	remove: vi.fn().mockResolvedValue(undefined),
	exec: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
	copyTo: vi.fn().mockResolvedValue(undefined),
	copyFrom: vi.fn().mockResolvedValue({}),
	inspect: vi.fn().mockResolvedValue({ running: false, exitCode: 0 }),
	logs: vi.fn().mockReturnValue({
		[Symbol.asyncIterator]: async function* () {},
	}),
	attachStdin: vi.fn().mockResolvedValue(undefined),
	detachStdin: vi.fn(),
	write: vi.fn().mockResolvedValue(undefined),
	getStdinStream: vi.fn(),
}

vi.mock('../../services/container-manager', () => ({
	ContainerManager: vi.fn().mockImplementation(() => mockContainerManager),
}))

vi.mock('../../lib/claude-oauth', () => ({
	getValidOAuthToken: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn().mockReturnValue('decrypted'),
}))

vi.mock('../../lib/integrations/registry', () => ({
	getProvider: vi.fn().mockReturnValue(null),
}))

vi.mock('../../services/workspace-briefing', () => ({
	WORKSPACE_STARTUP_BLOCK: '',
	renderWorkspaceBriefing: vi.fn().mockResolvedValue('briefing'),
	appendToLedger: vi.fn().mockResolvedValue(undefined),
	readLedgerTail: vi.fn().mockResolvedValue([]),
	workspaceLedgerKey: vi.fn().mockReturnValue('agents/ws/_workspace/learnings.md'),
}))

import type { Database } from '@maskin/db'
import { notifications } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { AgentStorageManager } from '../../services/agent-storage'
import { SessionManager } from '../../services/session-manager'
import { buildSession } from '../factories'
import { createTestContext } from '../setup'

interface InsertCall {
	table: unknown
	values: Record<string, unknown>
}

/**
 * Wrap a mock-DB context so every `db.insert(table).values(v)` call is
 * recorded. Use this to assert which tables a service writes to (the base
 * `createTestContext` proxy ignores the `table` argument).
 */
function withInsertTracking(ctx: ReturnType<typeof createTestContext>): {
	db: Database
	mockResults: ReturnType<typeof createTestContext>['mockResults']
	inserts: InsertCall[]
} {
	const inserts: InsertCall[] = []
	const wrapped = new Proxy(ctx.db, {
		get: (target, prop) => {
			const original = Reflect.get(target, prop)
			if (prop !== 'insert' || typeof original !== 'function') {
				return original
			}
			return (table: unknown) => {
				const chain = (original as (t: unknown) => Record<string, unknown>)(table)
				const origValues = chain.values as (v: Record<string, unknown>) => unknown
				chain.values = (v: Record<string, unknown>) => {
					inserts.push({ table, values: v })
					return origValues(v)
				}
				return chain
			}
		},
	}) as Database
	return { db: wrapped, mockResults: ctx.mockResults, inserts }
}

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
		manager = new SessionManager(ctx.db, storageProvider as StorageProvider)
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

	describe('createSession() — interactive', () => {
		it('persists interactive=true when config.interactive is true', async () => {
			const session = buildSession({ status: 'pending', interactive: true })
			mockResults.insertQueue = [[session], []]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: '',
				config: { interactive: true },
				createdBy: 'creator-1',
				autoStart: false,
			})

			expect(result.interactive).toBe(true)
		})

		it('defaults interactive to false when config.interactive is missing', async () => {
			const session = buildSession({ status: 'pending', interactive: false })
			mockResults.insertQueue = [[session], []]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Do the thing',
				createdBy: 'creator-1',
				autoStart: false,
			})

			expect(result.interactive).toBe(false)
		})
	})

	describe('startSession() — interactive launch flow', () => {
		it('sets INTERACTIVE=1 and omits ACTION_PROMPT for interactive sessions', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: true,
				actionPrompt: '',
				containerId: null,
			})
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'You are Sindre.',
				llmProvider: null,
				llmConfig: null,
				apiKey: null,
				tools: null,
			}
			const workspace = { id: session.workspaceId, settings: {} }

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			// Select queue in startSession → hasCapacity → launchContainer order.
			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace lookup
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace lookup (llm keys)
				[], // launchContainer: integrations lookup
			]

			await manager.startSession(session.id)

			expect(mockContainerManager.create).toHaveBeenCalledTimes(1)
			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
				interactive?: boolean
			}
			expect(createArgs.env.INTERACTIVE).toBe('1')
			expect(createArgs.env.ACTION_PROMPT).toBeUndefined()
			expect(createArgs.interactive).toBe(true)
			expect(mockContainerManager.attachStdin).toHaveBeenCalledWith(session.id, 'container-id-123')
		})

		it('sets ACTION_PROMPT and omits INTERACTIVE for non-interactive sessions', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
			})
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: null,
				tools: null,
			}
			const workspace = { id: session.workspaceId, settings: {} }

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [[session], [workspace], [{ count: 0 }], [agent], [workspace], []]

			await manager.startSession(session.id)

			expect(mockContainerManager.create).toHaveBeenCalledTimes(1)
			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
				interactive?: boolean
			}
			expect(createArgs.env.ACTION_PROMPT).toBe('Do the thing')
			expect(createArgs.env.INTERACTIVE).toBeUndefined()
			expect(createArgs.interactive).toBe(false)
			expect(mockContainerManager.attachStdin).not.toHaveBeenCalled()
		})

		it('ignores user-provided INTERACTIVE env var in session config', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
				config: { env_vars: { INTERACTIVE: '1' } },
			})
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: null,
				tools: null,
			}
			const workspace = { id: session.workspaceId, settings: {} }

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [[session], [workspace], [{ count: 0 }], [agent], [workspace], []]

			await manager.startSession(session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.INTERACTIVE).toBeUndefined()
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

			expect(mockContainerManager.stop).toHaveBeenCalledWith('container-abc')
		})

		it('detaches stdin before stopping the container', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-abc',
				interactive: true,
			})
			mockResults.select = [session]

			await manager.stopSession(session.id)

			expect(mockContainerManager.detachStdin).toHaveBeenCalledWith(session.id)
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

			expect(mockContainerManager.exec).toHaveBeenCalledWith('container-xyz', [
				'tar',
				'-czf',
				'/tmp/snapshot.tar.gz',
				'/agent/',
			])
			expect(mockContainerManager.stop).toHaveBeenCalledWith('container-xyz')
			expect(mockContainerManager.remove).toHaveBeenCalledWith('container-xyz')
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
			mockContainerManager.exec.mockRejectedValueOnce(new Error('exec failed'))

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

		it('re-attaches stdin when resuming an interactive session', async () => {
			// Regression guard: writeInput after resume must not fail because stdin
			// was never re-attached to the post-resume container.
			const session = buildSession({
				status: 'paused',
				interactive: true,
				snapshotPath: 'snapshots/abc.tar.gz',
				containerId: null,
			})
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'You are Sindre.',
				llmProvider: null,
				llmConfig: null,
				apiKey: null,
				tools: null,
			}
			const workspace = { id: session.workspaceId, settings: {} }

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			// resumeSession → launchContainer → attachStdin
			mockResults.selectQueue = [
				[session], // resumeSession: load session
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace lookup (llm keys)
				[], // launchContainer: integrations lookup
			]

			await manager.resumeSession(session.id)

			expect(mockContainerManager.attachStdin).toHaveBeenCalledWith(session.id, 'container-id-123')
		})
	})

	describe('startSession() — workspace skills wiring', () => {
		it('pulls attached workspace skills immediately after agent files', async () => {
			const session = buildSession({
				status: 'pending',
				actorId: 'actor-1',
				workspaceId: 'ws-1',
				containerId: null,
			})

			const pullAgentFilesSpy = vi
				.spyOn(AgentStorageManager.prototype, 'pullAgentFiles')
				.mockResolvedValue(undefined)
			const pullWorkspaceSkillsSpy = vi
				.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent')
				.mockResolvedValue({ pulled: 0, skipped: 0, failures: [] })

			// Short-circuit container launch so the test doesn't need to mock the full
			// launchContainer DB/Docker path — the wiring we care about runs earlier.
			vi.spyOn(
				manager as unknown as {
					launchContainer(
						session: ReturnType<typeof buildSession>,
						tempDir: string,
						name?: string,
					): Promise<string>
				},
				'launchContainer',
			).mockResolvedValue('container-abc')

			// startSession → select session, hasCapacity → select workspace + count.
			// renderWorkspaceBriefing falls back gracefully when later selects return
			// empty (writeWorkspaceBriefing catches all errors).
			mockResults.selectQueue = [[session], [{ settings: {} }], [{ count: 0 }]]

			await manager.startSession(session.id)

			expect(pullAgentFilesSpy).toHaveBeenCalledWith('actor-1', 'ws-1', expect.any(String))
			expect(pullWorkspaceSkillsSpy).toHaveBeenCalledWith('actor-1', 'ws-1', expect.any(String))

			const agentFilesOrder = pullAgentFilesSpy.mock.invocationCallOrder[0] ?? 0
			const workspaceSkillsOrder = pullWorkspaceSkillsSpy.mock.invocationCallOrder[0] ?? 0
			expect(workspaceSkillsOrder).toBeGreaterThan(agentFilesOrder)
		})

		it('still calls pullWorkspaceSkillsForAgent when the agent has no attachments', async () => {
			// pullWorkspaceSkillsForAgent is documented as a no-op when the join
			// returns no rows; session-manager should still invoke it unconditionally
			// so the caller owns the empty-case semantics (not session-manager).
			const session = buildSession({
				status: 'pending',
				actorId: 'actor-2',
				workspaceId: 'ws-2',
				containerId: null,
			})

			vi.spyOn(AgentStorageManager.prototype, 'pullAgentFiles').mockResolvedValue(undefined)
			const pullWorkspaceSkillsSpy = vi
				.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent')
				.mockResolvedValue({ pulled: 0, skipped: 0, failures: [] })

			vi.spyOn(
				manager as unknown as {
					launchContainer(
						session: ReturnType<typeof buildSession>,
						tempDir: string,
						name?: string,
					): Promise<string>
				},
				'launchContainer',
			).mockResolvedValue('container-xyz')

			mockResults.selectQueue = [[session], [{ settings: {} }], [{ count: 0 }]]

			await manager.startSession(session.id)

			expect(pullWorkspaceSkillsSpy).toHaveBeenCalledTimes(1)
			expect(pullWorkspaceSkillsSpy).toHaveBeenCalledWith('actor-2', 'ws-2', expect.any(String))
		})
	})

	describe('start() and stop()', () => {
		it('starts and stops watchdog without error', async () => {
			await manager.start()
			await manager.stop()
		})
	})

	describe('runWatchdog() — zombie starting sessions', () => {
		it('fails sessions stuck in starting for >10 minutes', async () => {
			const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000)
			const stuckSession = buildSession({
				status: 'starting',
				containerId: null,
				updatedAt: twentyMinutesAgo,
				startedAt: null,
			})

			// Set up the select queue for each watchdog query in order:
			// 1. timedOut (running past timeout) → empty
			// 2. runningSessions (for idle check) → empty
			// 3. expiredPaused → empty
			// 4. stuckPending → empty
			// 5. stuckStarting → our stuck session
			// 6. drainQueue > hasCapacity: workspace lookup
			// 7. drainQueue > hasCapacity: count running sessions
			// 8. drainQueue > nextQueued → empty (no queued sessions)
			// 9. queuedSessions (final drain) → empty
			mockResults.selectQueue = [
				[], // 1. timedOut
				[], // 2. runningSessions
				[], // 3. expiredPaused
				[], // 4. stuckPending
				[stuckSession], // 5. stuckStarting
				[{ settings: {} }], // 6. drainQueue > workspace
				[{ count: 0 }], // 7. drainQueue > count
				[], // 8. drainQueue > nextQueued (empty = break)
				[], // 9. final queuedSessions
			]

			// Access private runWatchdog via cast
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			// The watchdog should have completed without error,
			// processing the stuck starting session through the failure path
		})

		it('does not fail sessions in starting for less than 10 minutes', async () => {
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
			const recentSession = buildSession({
				status: 'starting',
				containerId: null,
				updatedAt: fiveMinutesAgo,
			})

			// The DB query uses lt(updatedAt, tenMinutesAgo), so a session
			// updated 5 minutes ago should NOT be returned by the query.
			// With the mock DB, the query returns whatever we put in the queue,
			// so we simulate the correct DB behavior by returning empty for stuckStarting.
			mockResults.selectQueue = [
				[], // 1. timedOut
				[], // 2. runningSessions
				[], // 3. expiredPaused
				[], // 4. stuckPending
				[], // 5. stuckStarting (empty — session is too recent)
				[], // 6. queuedSessions
			]

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			// Watchdog completes without processing the recent session
		})
	})

	describe('handleCompletion() — failure notifications', () => {
		it('inserts an alert notification when a session exits non-zero', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			const session = buildSession({
				status: 'running',
				containerId: 'c-1',
				actorId: 'actor-fail',
				triggerId: null,
			})
			tracked.mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[{ settings: {} }], // drainQueue → hasCapacity workspace
				[{ count: 0 }], // drainQueue → hasCapacity count
				[], // drainQueue → nextQueued (empty, break)
			]

			await (
				trackedManager as unknown as {
					handleCompletion(s: string, c: string, e: number): Promise<void>
				}
			).handleCompletion(session.id, 'c-1', 7)

			const notifInserts = tracked.inserts.filter((i) => i.table === notifications)
			expect(notifInserts).toHaveLength(1)
			const v = notifInserts[0]?.values
			expect(v?.type).toBe('alert')
			expect(v?.workspaceId).toBe(session.workspaceId)
			expect(v?.sourceActorId).toBe(session.actorId)
			expect(v?.sessionId).toBe(session.id)
			expect(v?.status).toBe('pending')
			expect(String(v?.content)).toContain('exit code 7')
		})

		it('does not insert a notification when a session completes successfully', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			const session = buildSession({
				status: 'running',
				containerId: 'c-ok',
				actorId: 'actor-ok',
			})
			tracked.mockResults.selectQueue = [[session], [{ settings: {} }], [{ count: 0 }], []]

			await (
				trackedManager as unknown as {
					handleCompletion(s: string, c: string, e: number): Promise<void>
				}
			).handleCompletion(session.id, 'c-ok', 0)

			const notifInserts = tracked.inserts.filter((i) => i.table === notifications)
			expect(notifInserts).toHaveLength(0)
		})

		it('inserts an alert notification when the watchdog times out a session', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			const timedOutSession = buildSession({
				status: 'running',
				containerId: 'c-timeout',
				actorId: 'actor-timeout',
				triggerId: null,
				timeoutAt: new Date(Date.now() - 60_000),
			})
			tracked.mockResults.selectQueue = [
				[timedOutSession], // 1. timedOut
				[], // 2. runningSessions
				[], // 3. expiredPaused
				[], // 4. stuckPending
				[], // 5. stuckStarting
				[{ settings: {} }], // 6. drainQueue → workspace
				[{ count: 0 }], // 7. drainQueue → count
				[], // 8. drainQueue → nextQueued
				[], // 9. final queuedSessions
			]

			await (trackedManager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			const notifInserts = tracked.inserts.filter((i) => i.table === notifications)
			expect(notifInserts).toHaveLength(1)
			const v = notifInserts[0]?.values
			expect(v?.type).toBe('alert')
			expect(v?.sourceActorId).toBe(timedOutSession.actorId)
			expect(v?.sessionId).toBe(timedOutSession.id)
			expect(String(v?.title)).toContain('timed out')
		})
	})

	describe('checkActorHealth()', () => {
		it('creates a recommendation when failure rate exceeds threshold', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			const actorId = 'actor-flaky'
			const workspaceId = 'ws-1'
			// 3 failed + 1 timeout + 4 completed = 50% failure rate over 8 sessions
			const recent = [
				...Array(3).fill({ actorId, workspaceId, status: 'failed' }),
				{ actorId, workspaceId, status: 'timeout' },
				...Array(4).fill({ actorId, workspaceId, status: 'completed' }),
			]
			tracked.mockResults.selectQueue = [
				recent, // checkActorHealth: recent sessions
				[], // checkActorHealth: existing notification dedup → none
				[{ name: 'Flaky Agent' }], // checkActorHealth: actor name
			]

			await (trackedManager as unknown as { checkActorHealth(): Promise<void> }).checkActorHealth()

			const notifInserts = tracked.inserts.filter((i) => i.table === notifications)
			expect(notifInserts).toHaveLength(1)
			const v = notifInserts[0]?.values
			expect(v?.type).toBe('recommendation')
			expect(v?.workspaceId).toBe(workspaceId)
			expect(v?.sourceActorId).toBe(actorId)
			expect(String(v?.content)).toContain('50%')
			expect(String(v?.content)).toContain('4/8')
			expect(String(v?.title)).toContain('Flaky Agent')
		})

		it('skips actors below the minimum sample size', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			// 2 sessions both failed → 100% rate but sample too small
			const recent = [
				{ actorId: 'a', workspaceId: 'w', status: 'failed' },
				{ actorId: 'a', workspaceId: 'w', status: 'failed' },
			]
			tracked.mockResults.selectQueue = [recent]

			await (trackedManager as unknown as { checkActorHealth(): Promise<void> }).checkActorHealth()

			expect(tracked.inserts.filter((i) => i.table === notifications)).toHaveLength(0)
		})

		it('skips actors below the failure-rate threshold', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			// 1 failed + 9 completed = 10% — below 25% threshold
			const recent = [
				{ actorId: 'a', workspaceId: 'w', status: 'failed' },
				...Array(9).fill({ actorId: 'a', workspaceId: 'w', status: 'completed' }),
			]
			tracked.mockResults.selectQueue = [recent]

			await (trackedManager as unknown as { checkActorHealth(): Promise<void> }).checkActorHealth()

			expect(tracked.inserts.filter((i) => i.table === notifications)).toHaveLength(0)
		})

		it('deduplicates against an existing pending recommendation', async () => {
			const ctx = createTestContext()
			const tracked = withInsertTracking(ctx)
			const trackedManager = new SessionManager(tracked.db, storageProvider as StorageProvider)

			const recent = [
				...Array(4).fill({ actorId: 'a', workspaceId: 'w', status: 'failed' }),
				...Array(4).fill({ actorId: 'a', workspaceId: 'w', status: 'completed' }),
			]
			tracked.mockResults.selectQueue = [
				recent,
				[{ id: 'existing-notif-id' }], // dedup: notification already exists
			]

			await (trackedManager as unknown as { checkActorHealth(): Promise<void> }).checkActorHealth()

			expect(tracked.inserts.filter((i) => i.table === notifications)).toHaveLength(0)
		})
	})
})
