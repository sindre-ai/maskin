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
	buildWorkspaceStartupBlock: vi.fn().mockReturnValue(''),
	renderWorkspaceBriefing: vi.fn().mockResolvedValue('briefing'),
	appendToLedger: vi.fn().mockResolvedValue(undefined),
	readLedgerTail: vi.fn().mockResolvedValue([]),
	workspaceLedgerKey: vi.fn().mockReturnValue('agents/ws/_workspace/learnings.md'),
}))

import { execFile } from 'node:child_process'
import type { StorageProvider } from '@maskin/storage'
import { AgentStorageManager } from '../../services/agent-storage'
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
	let calls: { inserts: unknown[]; updates: unknown[] }
	let storageProvider: ReturnType<typeof createMockStorageProvider>

	beforeEach(() => {
		vi.clearAllMocks()
		storageProvider = createMockStorageProvider()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		calls = ctx.calls
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

		it('refuses with PlanCapExceededError when workspace is over its plan cap', async () => {
			// First select: workspace row carrying a starter plan + period_start + cap.
			// Second select: maskin_plan usage rows summing past the cap.
			mockResults.selectQueue = [
				[
					{
						settings: {
							billing: {
								plan: 'starter',
								period_start: 1_700_000_000,
								hard_cap_tokens: 1_000_000,
							},
						},
					},
				],
				[{ inputTokens: 1_100_000, outputTokens: 0 }],
			]

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Do the thing',
					createdBy: 'creator-1',
					autoStart: false,
				}),
			).rejects.toMatchObject({
				name: 'PlanCapExceededError',
				plan: 'starter',
				used: 1_100_000,
				cap: 1_000_000,
			})

			// Session row must not be inserted when pre-flight rejects.
			expect(calls.inserts).toHaveLength(0)
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
				apiKey: 'ank_test_agent_key',
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
				apiKey: 'ank_test_agent_key',
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

		it('refuses to launch when the agent has no apiKey', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
			})
			const agent = {
				id: session.actorId,
				name: 'Orphaned Agent',
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

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace lookup
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup (apiKey is null)
				[workspace], // launchContainer: workspace lookup (llm keys)
			]

			await expect(manager.startSession(session.id)).rejects.toThrow(/apiKey is null/)
			expect(mockContainerManager.create).not.toHaveBeenCalled()
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
				apiKey: 'ank_test_agent_key',
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
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })

			await manager.pauseSession(session.id)

			// Snapshot is streamed via dockerode's getArchive — no in-container
			// `tar -czf` exec, no double-wrapping. Stored at `.tar` (uncompressed).
			expect(mockContainerManager.exec).not.toHaveBeenCalled()
			expect(mockContainerManager.copyFrom).toHaveBeenCalledWith('container-xyz', '/agent/')
			expect(mockContainerManager.stop).toHaveBeenCalledWith('container-xyz')
			expect(mockContainerManager.remove).toHaveBeenCalledWith('container-xyz')
			expect(storageProvider.put).toHaveBeenCalledWith(
				`snapshots/${session.id}.tar`,
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
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })
			mockContainerManager.copyFrom.mockRejectedValueOnce(new Error('copy failed'))

			await expect(manager.pauseSession(session.id)).rejects.toThrow('copy failed')
			// Status should be reverted to running (via the catch block's db.update call)
		})

		it('marks session failed when container is already gone (no snapshot attempt)', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-zombie',
			})
			mockResults.select = [session]
			// inspect default mock returns { running: false } — container is dead

			await manager.pauseSession(session.id)

			// Must not attempt snapshot work on a dead container
			expect(mockContainerManager.copyFrom).not.toHaveBeenCalled()
			expect(mockContainerManager.stop).not.toHaveBeenCalled()
			expect(storageProvider.put).not.toHaveBeenCalled()
			// Should resolve (not throw) so the auto-pause loop doesn't keep retrying
		})

		it('marks session failed when container vanishes mid-pause', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-vanish',
			})
			mockResults.select = [session]
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })
			// dockerode-style 409 thrown after we started snapshotting
			mockContainerManager.copyFrom.mockRejectedValueOnce(
				Object.assign(new Error('(HTTP code 409) container is not running'), {
					statusCode: 409,
				}),
			)

			await manager.pauseSession(session.id)
			// Resolves cleanly — caught and routed to terminal-failed
		})
	})

	describe('writeInput()', () => {
		it('persists the user input as a stdout session_logs row and emits a log event', async () => {
			const session = buildSession({ interactive: true, status: 'running' })
			const log = {
				id: 42,
				sessionId: session.id,
				stream: 'stdout',
				content: '{"type":"user","message":{"role":"user","content":"hello"}}',
				createdAt: new Date(),
			}
			mockResults.insert = [log]

			const events: unknown[] = []
			manager.on('log', (e) => events.push(e))

			await manager.writeInput(session.id, {
				type: 'user',
				message: { role: 'user', content: 'hello' },
			})

			expect(mockContainerManager.write).toHaveBeenCalledWith(session.id, {
				type: 'user',
				message: { role: 'user', content: 'hello' },
			})
			expect(events).toEqual([
				{
					sessionId: session.id,
					logId: 42,
					stream: 'stdout',
					data: '{"type":"user","message":{"role":"user","content":"hello"}}',
				},
			])
		})

		it('does not record a log row when the stdin write fails', async () => {
			const session = buildSession({ interactive: true, status: 'running' })
			mockContainerManager.write.mockRejectedValueOnce(new Error('stream closed'))

			const events: unknown[] = []
			manager.on('log', (e) => events.push(e))

			await expect(
				manager.writeInput(session.id, {
					type: 'user',
					message: { role: 'user', content: 'hi' },
				}),
			).rejects.toThrow('stream closed')

			expect(events).toEqual([])
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
				apiKey: 'ank_test_agent_key',
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

		it('extracts the snapshot with `tar -xf --strip-components=1` (not `-xzf`)', async () => {
			// Regression guard for the snapshot round-trip fix: dockerode's
			// getArchive returns an uncompressed tar rooted at `agent/...`.
			// Using `-xzf` would fail with "not in gzip format" and silently
			// lose the workspace (resume's catch block marks the session
			// failed). `--strip-components=1` is also required so files land at
			// tempDir/<name> — what the `${tempDir}:/agent` bind mount expects.
			const session = buildSession({
				status: 'paused',
				snapshotPath: 'snapshots/abc.tar',
				containerId: null,
			})
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'Test agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const workspace = { id: session.workspaceId, settings: {} }

			vi.spyOn(AgentStorageManager.prototype, 'pullAgentFiles').mockResolvedValue(undefined)
			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // resumeSession: load session
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace lookup (llm keys)
				[], // launchContainer: integrations lookup
			]

			await manager.resumeSession(session.id)

			const tarCalls = vi.mocked(execFile).mock.calls.filter((call) => call[0] === 'tar')
			expect(tarCalls).toHaveLength(1)
			const [, tarArgs] = tarCalls[0] as [string, string[], ...unknown[]]
			expect(tarArgs).toEqual([
				'-xf',
				expect.stringMatching(/snapshot\.tar$/),
				'-C',
				expect.any(String),
				'--strip-components=1',
			])
			// `-xzf` would attempt gzip decompression on an uncompressed tar.
			expect(tarArgs).not.toContain('-xzf')
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

	describe('runWatchdog() — idle auto-pause guards', () => {
		it('marks a running-but-containerless session failed instead of trying to pause it', async () => {
			// A `running` row that somehow has no containerId is unrecoverable:
			// pauseSession would reject on its own `!session.containerId` guard
			// every minute forever. The watchdog must route it to terminal-failed.
			const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000)
			const orphan = buildSession({
				status: 'running',
				containerId: null,
				startedAt: twentyMinutesAgo,
				interactive: false,
			})
			const pauseSpy = vi.spyOn(manager, 'pauseSession')

			mockResults.selectQueue = [
				[], // 1. timedOut
				[orphan], // 2. runningSessions (idle check)
				[], // 3. lastLog for orphan (empty → falls back to startedAt, which is >10min old)
				// markSessionFailedAfterContainerLoss → drainQueue → hasCapacity:
				[{ settings: {} }], // 4. drainQueue > workspace lookup
				[{ count: 0 }], // 5. drainQueue > running count
				[], // 6. drainQueue > nextQueued (empty = break)
				[], // 7. expiredPaused
				[], // 8. stuckPending
				[], // 9. stuckStarting
				[], // 10. final queuedSessions
			]

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			expect(pauseSpy).not.toHaveBeenCalled()
			// markSessionFailedAfterContainerLoss writes status='failed' on the sessions row.
			const failedUpdate = calls.updates.find(
				(u): u is { status: string } =>
					typeof u === 'object' && u !== null && (u as { status?: string }).status === 'failed',
			)
			expect(failedUpdate).toBeDefined()
		})

		it('skips auto-pause when inspect reports the container is no longer running', async () => {
			// Container died but the exit watcher hasn't noticed yet (e.g., inspect was
			// transiently failing). The watchdog should leave the session alone this tick
			// instead of pausing — watchContainerExit / the timeout reaper will catch it.
			const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000)
			const stale = buildSession({
				status: 'running',
				containerId: 'container-dead',
				startedAt: twentyMinutesAgo,
				interactive: false,
			})
			const pauseSpy = vi.spyOn(manager, 'pauseSession')
			mockContainerManager.inspect.mockResolvedValueOnce({ running: false, exitCode: 137 })

			mockResults.selectQueue = [
				[], // 1. timedOut
				[stale], // 2. runningSessions
				[], // 3. lastLog (empty → falls back to startedAt, which is >10min old)
				[], // 4. expiredPaused
				[], // 5. stuckPending
				[], // 6. stuckStarting
				[], // 7. final queuedSessions
			]

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			expect(pauseSpy).not.toHaveBeenCalled()
			// No 'failed' update should have happened either — we explicitly defer to
			// watchContainerExit so the session isn't yanked out from under it.
			const failedUpdate = calls.updates.find(
				(u): u is { status: string } =>
					typeof u === 'object' && u !== null && (u as { status?: string }).status === 'failed',
			)
			expect(failedUpdate).toBeUndefined()
		})
	})

	describe('streamContainerLogs() — reconnect on transient stream drop', () => {
		it('reattaches with tail:0 after a dropped log stream and does not surface the "interrupted" sentinel', async () => {
			// Regression guard for the false-positive auto-pause bug: when
			// dockerode's logs(follow:true) connection drops mid-session,
			// `session_logs` stops growing and the 10-min idle watchdog
			// previously mistook the silence for an idle agent and force-paused
			// a still-running container. The reconnect loop must transparently
			// recover so the watchdog never sees a stale `lastLog` row, and
			// must NOT write the "Log stream interrupted" system log on a
			// single transient drop.
			const sessionId = 'sess-reconnect'

			// streamContainerLogs only attaches `logsDrained` if there's an
			// existing activeSessions entry, so seed one.
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; logsDrained?: Promise<void> }>
				}
			).activeSessions.set(sessionId, { tempDir: '/tmp/test' })

			// First connect throws (simulating a socket drop), second connect
			// yields one chunk and ends naturally.
			mockContainerManager.logs.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]() {
					return { next: () => Promise.reject(new Error('socket closed mid-stream')) }
				},
			}))
			mockContainerManager.logs.mockImplementationOnce(() => ({
				async *[Symbol.asyncIterator]() {
					yield { stream: 'stdout' as const, data: 'recovered-chunk' }
				},
			}))
			// Container is still alive between attempts — reconnect must proceed.
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })

			vi.useFakeTimers()
			try {
				;(
					manager as unknown as {
						streamContainerLogs(sessionId: string, containerId: string): void
					}
				).streamContainerLogs(sessionId, 'container-reconnect')

				const drained = (
					manager as unknown as {
						activeSessions: Map<string, { logsDrained?: Promise<void> }>
					}
				).activeSessions.get(sessionId)?.logsDrained
				expect(drained).toBeDefined()

				// Advances the 2s reconnect setTimeout plus any chained microtasks.
				await vi.runAllTimersAsync()
				await drained
			} finally {
				vi.useRealTimers()
			}

			// Two calls: first replays history (`{}`), second reattaches from
			// "now" (`tail: 0`) to avoid duplicating already-persisted rows.
			expect(mockContainerManager.logs).toHaveBeenCalledTimes(2)
			expect(mockContainerManager.logs).toHaveBeenNthCalledWith(1, 'container-reconnect', true, {})
			expect(mockContainerManager.logs).toHaveBeenNthCalledWith(2, 'container-reconnect', true, {
				tail: 0,
			})

			// The "Log stream interrupted" sentinel is reserved for genuine
			// exhaustion of reconnects; a single transient drop must not write it.
			const interrupted = calls.inserts.find(
				(i): i is { stream: string; content: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { stream?: string }).stream === 'system' &&
					String((i as { content?: string }).content ?? '').includes('Log stream interrupted'),
			)
			expect(interrupted).toBeUndefined()

			// The recovered chunk from the second attempt is persisted, which
			// is what keeps the idle watchdog's `lastLog` heuristic honest.
			const recovered = calls.inserts.find(
				(i): i is { stream: string; content: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { stream?: string }).stream === 'stdout' &&
					(i as { content?: string }).content === 'recovered-chunk',
			)
			expect(recovered).toBeDefined()
		})
	})
})
