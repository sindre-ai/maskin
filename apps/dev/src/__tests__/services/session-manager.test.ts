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
	pullImage: vi.fn().mockResolvedValue(undefined),
	createNetwork: vi.fn().mockResolvedValue('anko-net-test'),
	removeNetwork: vi.fn().mockResolvedValue(undefined),
	getIpOnNetwork: vi.fn().mockResolvedValue('172.20.0.2'),
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

vi.mock('../../lib/claude-oauth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/claude-oauth')>()
	return {
		...actual,
		getValidOAuthToken: vi.fn().mockResolvedValue(null),
	}
})

vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn().mockReturnValue('decrypted'),
}))

vi.mock('../../lib/integrations/registry', () => ({
	getProvider: vi.fn().mockReturnValue(null),
}))

const { mockGetValidToken, mockFetchInstallationOwnerLogin } = vi.hoisted(() => ({
	mockGetValidToken: vi.fn(),
	mockFetchInstallationOwnerLogin: vi.fn(),
}))

vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({
		getValidToken: mockGetValidToken,
	})),
}))

vi.mock('../../lib/integrations/providers/github/auth', () => ({
	fetchInstallationOwnerLogin: mockFetchInstallationOwnerLogin,
}))

vi.mock('../../services/workspace-briefing', () => ({
	buildWorkspaceStartupBlock: vi.fn().mockReturnValue(''),
	renderWorkspaceBriefing: vi.fn().mockResolvedValue('briefing'),
	appendToLedger: vi.fn().mockResolvedValue(undefined),
	readLedgerTail: vi.fn().mockResolvedValue([]),
	workspaceLedgerKey: vi.fn().mockReturnValue('agents/ws/_workspace/learnings.md'),
}))

const { mockClassifyCreditExhaustion } = vi.hoisted(() => ({
	mockClassifyCreditExhaustion: vi.fn(),
}))

vi.mock('../../lib/credit-classifier', () => ({
	classifyCreditExhaustion: mockClassifyCreditExhaustion,
}))

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { StorageProvider } from '@maskin/storage'
import { getProvider } from '../../lib/integrations/registry'
import { AgentStorageManager } from '../../services/agent-storage'
import { SessionManager, mergeLaunchRouteConfig } from '../../services/session-manager'
import { buildIntegration, buildSession } from '../factories'
import { createTestContext } from '../setup'

function createMockStorageProvider() {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('snapshot data')),
		list: vi.fn().mockResolvedValue([]),
		listWithMetadata: vi.fn().mockResolvedValue([]),
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
		// Default: pretend GitHub is healthy so preflight in buildLaunchSpec does
		// not touch the real network. Individual tests override this for the
		// broken-identity path.
		//
		// GitHub App installation tokens (ghs_ prefix) 403 on /user for real —
		// that endpoint requires a user-context token. Mirror that here instead
		// of unconditionally allowing /user, so this default can't mask a
		// preflight regression that (re-)requires /user for installation tokens.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const u = url.toString()
				if (u.startsWith('https://api.github.com/user')) {
					const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
					if (auth?.startsWith('Bearer ghs_'))
						return new Response('{"message":"Resource not accessible by integration"}', {
							status: 403,
							headers: { 'content-type': 'application/json' },
						})
					return new Response(JSON.stringify({ login: 'octocat' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				if (u.startsWith('https://api.github.com/repos/'))
					return new Response(JSON.stringify({ permissions: { push: true } }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				if (u.startsWith('https://api.github.com/installation/repositories'))
					return new Response(
						JSON.stringify({
							repositories: [{ full_name: 'octocat/hello', permissions: { push: true } }],
						}),
						{
							status: 200,
							headers: { 'content-type': 'application/json' },
						},
					)
				if (u.startsWith('https://slack.com/api/chat.postMessage'))
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				throw new Error(`unexpected fetch in SessionManager test: ${u}`)
			}),
		)
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

		it('rejects pre-insert when the workspace is over its plan cap', async () => {
			// Workspace select returns a pro plan at cap; the cap query then
			// returns rows that sum to ≥ hard_cap_tokens. The session insert mock
			// is intentionally left configured so we can prove the insert is never
			// reached.
			mockResults.selectQueue = [
				[
					{
						id: 'ws-1',
						settings: {
							billing: { plan: 'pro', hard_cap_tokens: 100, period_start: 0 },
						},
					},
				],
				[{ inputTokens: 100, outputTokens: 0 }],
			]
			const sessionRow = buildSession({ status: 'pending' })
			mockResults.insertQueue = [[sessionRow], []]

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Do the thing',
					createdBy: 'creator-1',
					autoStart: false,
				}),
			).rejects.toMatchObject({
				name: 'PlanCapExceededError',
				plan: 'pro',
				used: 100,
				cap: 100,
			})
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
				systemPrompt: 'You are Workspace Coach.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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

	describe('startSession() — LLM model routing (llmConfig.model)', () => {
		it('forwards agent llmConfig.model as ANTHROPIC_MODEL on the workspace api_key route', async () => {
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
				llmConfig: { model: 'claude-sonnet-4-6' },
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const workspace = {
				id: session.workspaceId,
				byollmAllowed: true,
				settings: { llm_keys: { anthropic: 'sk-ant-ws' } },
			}

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace lookup
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace lookup (llm keys)
				[workspace], // resolveLlmRoute -> resolveClaudeCredentialsWithFailover: workspace lookup
				// (no claude_oauth in settings, so OAuth resolution falls through to
				// the workspace anthropic api_key route)
				[], // launchContainer: integrations lookup
			]

			await manager.startSession(session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.ANTHROPIC_API_KEY).toBe('sk-ant-ws')
			expect(createArgs.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
		})

		it('omits ANTHROPIC_MODEL when the agent has no model preference', async () => {
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
			const workspace = {
				id: session.workspaceId,
				byollmAllowed: true,
				settings: { llm_keys: { anthropic: 'sk-ant-ws' } },
			}

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session],
				[workspace],
				[{ count: 0 }],
				[agent],
				[workspace],
				[workspace],
				[],
			]

			await manager.startSession(session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.ANTHROPIC_API_KEY).toBe('sk-ant-ws')
			expect(createArgs.env.ANTHROPIC_MODEL).toBeUndefined()
		})

		it('forwards agent llmConfig.model as ANTHROPIC_MODEL on the Claude OAuth route', async () => {
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
				llmConfig: { model: 'claude-sonnet-4-6' },
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const expiresAt = Date.now() + 60 * 60 * 1000
			const workspace = {
				id: session.workspaceId,
				byollmAllowed: true,
				settings: {
					llm_keys: { anthropic: 'sk-ant-ws' },
					claude_oauth: {
						encryptedAccessToken: 'oauth-access',
						encryptedRefreshToken: 'oauth-refresh',
						expiresAt,
						scopes: ['read'],
						subscriptionType: 'pro',
					},
				},
			}

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace lookup
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace lookup (llm keys)
				[workspace], // resolveLlmRoute -> resolveClaudeCredentialsWithFailover: workspace lookup
				[], // launchContainer: integrations lookup
			]

			await manager.startSession(session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.CLAUDE_OAUTH_ACCESS_TOKEN).toBe('decrypted')
			expect(createArgs.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
		})
	})

	describe('startSession() — browser sidecar provisioning', () => {
		function buildTestSession(overrides: Record<string, unknown> = {}) {
			return buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
				...overrides,
			})
		}

		function buildTestAgent(actorId: string, tools: Record<string, unknown> | null = null) {
			return {
				id: actorId,
				type: 'agent' as const,
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools,
			}
		}

		function buildTestWorkspace(workspaceId: string) {
			return { id: workspaceId, byollmAllowed: true, settings: {} }
		}

		beforeEach(() => {
			vi.clearAllMocks()
			manager.setBrowserSidecarBuildContext('/repo/docker/browser-sidecar')
		})

		it('provisions a browser sidecar when browserRequired is true (AC-T1 Docker leg)', async () => {
			const session = buildTestSession({ config: { browserRequired: true } })
			const agent = buildTestAgent(session.actorId)
			const workspace = buildTestWorkspace(session.workspaceId)

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace llm keys
				[], // launchContainer: integrations
			]

			await manager.startSession(session.id)

			expect(mockContainerManager.ensureImage).toHaveBeenCalledWith(
				'browser-sidecar:latest',
				'/repo/docker/browser-sidecar',
			)
			expect(mockContainerManager.pullImage).not.toHaveBeenCalled()
			expect(mockContainerManager.createNetwork).toHaveBeenCalled()

			const browserCreateCall = mockContainerManager.create.mock.calls[0]?.[0] as Record<
				string,
				unknown
			>
			expect(browserCreateCall.image).toBe('browser-sidecar:latest')
			expect(browserCreateCall.name).toMatch(/^anko-browser-/)
			expect(browserCreateCall.networkMode).toMatch(/^anko-net-/)
			expect(browserCreateCall.memoryMb).toBe(512)
			expect(browserCreateCall.cpuShares).toBe(512)

			const agentCreateCall = mockContainerManager.create.mock.calls[1]?.[0] as {
				env: Record<string, string>
				networkMode?: string
			}
			expect(agentCreateCall.env.BROWSER_CDP_URL).toBe('http://172.20.0.2:9222')
			expect(agentCreateCall.networkMode).toMatch(/^anko-net-/)
		})

		it('does not provision a sidecar when browserRequired is absent (AC-T6 Docker leg)', async () => {
			const session = buildTestSession({ config: {} })
			const agent = buildTestAgent(session.actorId)
			const workspace = buildTestWorkspace(session.workspaceId)

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace llm keys
				[], // launchContainer: integrations
			]

			await manager.startSession(session.id)

			expect(mockContainerManager.ensureImage).not.toHaveBeenCalled()
			expect(mockContainerManager.pullImage).not.toHaveBeenCalled()
			expect(mockContainerManager.createNetwork).not.toHaveBeenCalled()

			const agentCreateCall = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
				networkMode?: string
			}
			expect(agentCreateCall.env.BROWSER_CDP_URL).toBeUndefined()
			expect(agentCreateCall.networkMode).toBeUndefined()
		})

		it('provisions a sidecar when MCP config references BROWSER_CDP_URL', async () => {
			const session = buildTestSession({ config: {} })
			const agent = buildTestAgent(session.actorId, {
				mcpServers: {
					playwright: {
						command: 'npx',
						args: ['@playwright/mcp@latest', '--cdp-endpoint', '${BROWSER_CDP_URL}'],
					},
				},
			})
			const workspace = buildTestWorkspace(session.workspaceId)

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			mockResults.selectQueue = [
				[session], // startSession: load session
				[workspace], // hasCapacity: workspace
				[{ count: 0 }], // hasCapacity: running count
				[agent], // launchContainer: agent lookup
				[workspace], // launchContainer: workspace llm keys
				[], // launchContainer: integrations
			]

			await manager.startSession(session.id)

			expect(mockContainerManager.ensureImage).toHaveBeenCalledWith(
				'browser-sidecar:latest',
				'/repo/docker/browser-sidecar',
			)
			const agentCreateCall = mockContainerManager.create.mock.calls[1]?.[0] as {
				env: Record<string, string>
				networkMode?: string
			}
			expect(agentCreateCall.env.BROWSER_CDP_URL).toBe('http://172.20.0.2:9222')
			expect(agentCreateCall.networkMode).toMatch(/^anko-net-/)
		})
	})

	describe('buildLaunchSpec() — previewGuestPorts (Critical #1 fix)', () => {
		function buildTestAgent(actorId: string) {
			return {
				id: actorId,
				type: 'agent' as const,
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
		}

		function buildTestWorkspace(workspaceId: string) {
			return { id: workspaceId, byollmAllowed: true, settings: {} }
		}

		beforeEach(() => {
			vi.clearAllMocks()
		})

		it('passes previewGuestPorts through and forces browserRequired to true', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				config: { previewGuestPorts: [3000, 8080] },
			})
			const agent = buildTestAgent(session.actorId)
			const workspace = buildTestWorkspace(session.workspaceId)

			mockResults.selectQueue = [
				[agent], // buildLaunchSpec: agent lookup
				[workspace], // buildLaunchSpec: workspace llm keys
				[], // buildLaunchSpec: integrations
			]

			const spec = await manager.buildLaunchSpec(
				session as unknown as Parameters<typeof manager.buildLaunchSpec>[0],
			)

			expect(spec.previewGuestPorts).toEqual([3000, 8080])
			expect(spec.browserRequired).toBe(true)
		})

		it('filters out non-integer, non-positive, and out-of-range port values', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				config: { previewGuestPorts: [3000, -1, 70000, 'abc', 1.5, 8080] },
			})
			const agent = buildTestAgent(session.actorId)
			const workspace = buildTestWorkspace(session.workspaceId)

			mockResults.selectQueue = [[agent], [workspace], []]

			const spec = await manager.buildLaunchSpec(
				session as unknown as Parameters<typeof manager.buildLaunchSpec>[0],
			)

			expect(spec.previewGuestPorts).toEqual([3000, 8080])
		})

		it('leaves browserRequired false and previewGuestPorts empty when the field is absent', async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				config: {},
			})
			const agent = buildTestAgent(session.actorId)
			const workspace = buildTestWorkspace(session.workspaceId)

			mockResults.selectQueue = [[agent], [workspace], []]

			const spec = await manager.buildLaunchSpec(
				session as unknown as Parameters<typeof manager.buildLaunchSpec>[0],
			)

			expect(spec.previewGuestPorts).toEqual([])
			expect(spec.browserRequired).toBe(false)
		})
	})

	describe('cleanupBrowserSidecar() — teardown SLA (AC-T5)', () => {
		// Access the private map + method through a structural cast so the test
		// can exercise the orchestration without standing up the whole
		// startSession flow. JS has no real private and this is the established
		// pattern in this repo for poking at session-manager internals.
		type Internals = {
			activeSessions: Map<
				string,
				{
					tempDir: string
					browserContainerId?: string
					networkName?: string
				}
			>
			cleanupBrowserSidecar(sessionId: string): Promise<void>
		}

		function notFound404(): Error {
			const err = new Error('(HTTP code 404) no such container - No such container: anko-browser-x')
			;(err as { statusCode?: number }).statusCode = 404
			return err
		}

		beforeEach(() => {
			vi.clearAllMocks()
		})

		it('stops + removes the sidecar and confirms the container is gone (delta 0)', async () => {
			const internals = manager as unknown as Internals
			const sessionId = 'sess-cleanup-fast'
			internals.activeSessions.set(sessionId, {
				tempDir: '/tmp/x',
				browserContainerId: 'browser-fast',
				networkName: 'anko-net-fast',
			})
			// First inspect after remove already 404s — the happy path.
			mockContainerManager.inspect.mockRejectedValueOnce(notFound404())

			const started = Date.now()
			await internals.cleanupBrowserSidecar(sessionId)
			const elapsed = Date.now() - started

			expect(mockContainerManager.stop).toHaveBeenCalledWith('browser-fast')
			expect(mockContainerManager.remove).toHaveBeenCalledWith('browser-fast')
			expect(mockContainerManager.inspect).toHaveBeenCalledWith('browser-fast')
			expect(mockContainerManager.removeNetwork).toHaveBeenCalledWith('anko-net-fast')
			// Bookkeeping cleared so the next session-end signal is a no-op.
			expect(internals.activeSessions.get(sessionId)?.browserContainerId).toBeUndefined()
			expect(internals.activeSessions.get(sessionId)?.networkName).toBeUndefined()
			// AC-T5: well inside the 60s budget.
			expect(elapsed).toBeLessThan(60_000)
		})

		it('keeps polling until inspect returns 404 (slow Docker daemon)', async () => {
			const internals = manager as unknown as Internals
			const sessionId = 'sess-cleanup-slow'
			internals.activeSessions.set(sessionId, {
				tempDir: '/tmp/x',
				browserContainerId: 'browser-slow',
			})
			// inspect reports the container alive twice, then 404 — wait loop must
			// keep going across the early polls.
			mockContainerManager.inspect
				.mockResolvedValueOnce({ running: false, exitCode: 0 })
				.mockResolvedValueOnce({ running: false, exitCode: 0 })
				.mockRejectedValueOnce(notFound404())

			await internals.cleanupBrowserSidecar(sessionId)

			expect(mockContainerManager.inspect.mock.calls.length).toBeGreaterThanOrEqual(3)
		})

		it('no-ops when there is no sidecar to clean up (the common path)', async () => {
			const internals = manager as unknown as Internals
			const sessionId = 'sess-no-sidecar'
			internals.activeSessions.set(sessionId, { tempDir: '/tmp/x' })

			await internals.cleanupBrowserSidecar(sessionId)

			expect(mockContainerManager.stop).not.toHaveBeenCalled()
			expect(mockContainerManager.remove).not.toHaveBeenCalled()
			expect(mockContainerManager.inspect).not.toHaveBeenCalled()
			expect(mockContainerManager.removeNetwork).not.toHaveBeenCalled()
		})

		it('is idempotent — a second call after teardown does nothing', async () => {
			const internals = manager as unknown as Internals
			const sessionId = 'sess-cleanup-idempotent'
			internals.activeSessions.set(sessionId, {
				tempDir: '/tmp/x',
				browserContainerId: 'browser-idem',
				networkName: 'anko-net-idem',
			})
			mockContainerManager.inspect.mockRejectedValueOnce(notFound404())

			await internals.cleanupBrowserSidecar(sessionId)
			const stopCallsAfterFirst = mockContainerManager.stop.mock.calls.length
			const removeCallsAfterFirst = mockContainerManager.remove.mock.calls.length

			await internals.cleanupBrowserSidecar(sessionId)

			expect(mockContainerManager.stop.mock.calls.length).toBe(stopCallsAfterFirst)
			expect(mockContainerManager.remove.mock.calls.length).toBe(removeCallsAfterFirst)
		})
	})

	describe('startSession() — GitHub installations', () => {
		const githubProviderConfig = {
			config: {
				name: 'github',
				mcp: {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-github'],
					envKey: 'GITHUB_TOKEN',
				},
			},
		}

		function setupLaunchMocks(opts: {
			session: ReturnType<typeof buildSession>
			workspace: { id: string; settings: Record<string, unknown> }
			agent: Record<string, unknown>
			integrationRows: ReturnType<typeof buildIntegration>[]
		}) {
			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})
			mockResults.selectQueue = [
				[opts.session], // startSession: load session
				[opts.workspace], // hasCapacity: workspace lookup
				[{ count: 0 }], // hasCapacity: running count
				[opts.agent], // launchContainer: agent lookup
				[opts.workspace], // launchContainer: workspace lookup (llm keys)
				[opts.workspace], // resolveLlmRoute -> resolveClaudeCredentialsWithFailover: workspace lookup
				opts.integrationRows, // launchContainer: integrations lookup
			]
		}

		function buildLaunchFixtures(integrationRows: ReturnType<typeof buildIntegration>[]) {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
			})
			return {
				session,
				workspace: { id: session.workspaceId, byollmAllowed: true, settings: {} },
				agent: {
					id: session.actorId,
					type: 'agent',
					systemPrompt: 'You are a helpful AI agent.',
					llmProvider: null,
					llmConfig: null,
					apiKey: 'ank_test_agent_key',
					tools: null,
				},
				integrationRows,
			}
		}

		it('produces per-owner env vars and auto-injects MCP server entries for two GitHub installations', async () => {
			const wsId = randomUUID()
			const integrationA = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-aaa',
				config: { owner_login: 'sindre-ai' },
			})
			const integrationB = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-bbb',
				config: { owner_login: 'vaerksted-ai' },
			})
			const fixtures = buildLaunchFixtures([integrationA, integrationB])
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken
				.mockResolvedValueOnce('ghs_token_sindre_ai')
				.mockResolvedValueOnce('ghs_token_vaerksted_ai')

			setupLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}

			expect(createArgs.env.GITHUB_TOKEN_SINDRE_AI).toBe('ghs_token_sindre_ai')
			expect(createArgs.env.GITHUB_TOKEN_VAERKSTED_AI).toBe('ghs_token_vaerksted_ai')
			// bare GITHUB_TOKEN is aliased from the first installation
			expect(createArgs.env.GITHUB_TOKEN).toBe('ghs_token_sindre_ai')
			// GITHUB_INTEGRATION_ID lets the container's credential helper mint fresh
			// tokens mid-session; it's also aliased from the first installation
			expect(createArgs.env.GITHUB_INTEGRATION_ID).toBe(integrationA.id)
			// each installation gets its own auto-injected MCP server entry
			const mcpKeys = createArgs.env.MCP_SERVERS_JSON
				? Object.keys(
						(
							JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
								mcpServers: Record<string, unknown>
							}
						).mcpServers,
					)
				: []
			expect(mcpKeys.filter((k) => k.startsWith('github-'))).toHaveLength(2)
			expect(mcpKeys).toContain('github-sindre-ai')
			expect(mcpKeys).toContain('github-vaerksted-ai')
		})

		it('sets GITHUB_REPO alongside GITHUB_INTEGRATION_ID when a scoped bet carries metadata.repo', async () => {
			// End-to-end wiring for T8: the credential helper forwards `?repo=` only
			// when GITHUB_REPO is populated, so buildLaunchSpec must resolve and set
			// it in the same block that sets GITHUB_INTEGRATION_ID.
			const wsId = randomUUID()
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-aaa',
				config: { owner_login: 'sindre-ai' },
			})
			const fixtures = buildLaunchFixtures([integration])
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			const scopedBet = {
				id: randomUUID(),
				type: 'bet',
				metadata: { repo: 'sindre-ai/maskin' },
			}

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_token_sindre_ai')

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})
			mockResults.selectQueue = [
				[fixtures.session],
				[fixtures.workspace],
				[{ count: 0 }],
				[fixtures.agent],
				[fixtures.workspace],
				[fixtures.workspace],
				fixtures.integrationRows,
				// resolveGithubRepoSlug: activeSessionId lookup returns the bet directly
				[scopedBet],
				// resolveGithubRepoSlug: bet.metadata lookup by id
				[scopedBet],
			]
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.GITHUB_INTEGRATION_ID).toBe(integration.id)
			expect(createArgs.env.GITHUB_REPO).toBe('sindre-ai/maskin')
		})

		it('leaves GITHUB_REPO unset when no scoped object or sandbox default resolves', async () => {
			const wsId = randomUUID()
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-aaa',
				config: { owner_login: 'sindre-ai' },
			})
			const fixtures = buildLaunchFixtures([integration])
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_token_sindre_ai')

			// Ensure no accidental sandbox default from the host environment leaks in.
			const originalEnv = process.env.GITHUB_REPO
			// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
			delete process.env.GITHUB_REPO
			try {
				setupLaunchMocks(fixtures)
				await manager.startSession(fixtures.session.id)

				const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
					env: Record<string, string>
				}
				expect(createArgs.env.GITHUB_INTEGRATION_ID).toBe(integration.id)
				expect(createArgs.env.GITHUB_REPO).toBeUndefined()
			} finally {
				if (originalEnv === undefined) {
					// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
					delete process.env.GITHUB_REPO
				} else {
					process.env.GITHUB_REPO = originalEnv
				}
			}
		})

		it('lazily backfills owner_login and persists it when the row is missing it', async () => {
			const integration = buildIntegration({
				provider: 'github',
				externalId: 'install-needs-backfill',
				config: {},
			})
			const fixtures = buildLaunchFixtures([integration])

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_token_acme')
			mockFetchInstallationOwnerLogin.mockResolvedValueOnce('acme-org')

			setupLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			expect(mockFetchInstallationOwnerLogin).toHaveBeenCalledWith('install-needs-backfill')

			const updateCall = calls.updates.find(
				(u): u is { config: { owner_login?: string } } =>
					typeof u === 'object' && u !== null && 'config' in u,
			) as { config: { owner_login?: string } } | undefined
			expect(updateCall?.config.owner_login).toBe('acme-org')

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(createArgs.env.GITHUB_TOKEN_ACME_ORG).toBe('ghs_token_acme')
			expect(createArgs.env.GITHUB_TOKEN).toBe('ghs_token_acme')
			const mcpKeys = createArgs.env.MCP_SERVERS_JSON
				? Object.keys(
						(
							JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
								mcpServers: Record<string, unknown>
							}
						).mcpServers,
					)
				: []
			expect(mcpKeys.filter((k) => k.startsWith('github-'))).toHaveLength(1)
			expect(mcpKeys).toContain('github-acme-org')
		})

		it('skips the integration when owner_login backfill fails (does not kill the session)', async () => {
			const integration = buildIntegration({
				provider: 'github',
				externalId: 'install-broken',
				config: {},
			})
			const fixtures = buildLaunchFixtures([integration])

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_token_unused')
			mockFetchInstallationOwnerLogin.mockRejectedValueOnce(new Error('GitHub 404'))

			setupLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			const githubKeys = Object.keys(createArgs.env).filter((k) => k.startsWith('GITHUB_TOKEN_'))
			expect(githubKeys).toEqual([])
			expect(createArgs.env.MCP_SERVERS_JSON).toBeUndefined()
			expect(createArgs.env.GITHUB_INTEGRATION_ID).toBeUndefined()
		})

		describe('Slack auto-inject + xoxb- guard', () => {
			const slackProviderConfig = {
				config: {
					name: 'slack',
					mcp: {
						envKey: 'SLACK_BOT_TOKEN',
						autoInject: true,
						server: {
							type: 'http' as const,
							url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
							headers: {
								Authorization: 'Bearer ${MASKIN_API_KEY}',
								'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
							},
						},
					},
				},
			}

			it('injects SLACK_BOT_TOKEN and the auto-inject MCP server when the stored token is a bot token', async () => {
				const integration = buildIntegration({ provider: 'slack', externalId: 'T-abc' })
				const fixtures = buildLaunchFixtures([integration])

				vi.mocked(getProvider).mockReturnValue(slackProviderConfig as never)
				mockGetValidToken.mockResolvedValueOnce('xoxb-real-bot-token')

				setupLaunchMocks(fixtures)
				await manager.startSession(fixtures.session.id)

				const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
					env: Record<string, string>
				}

				expect(createArgs.env.SLACK_BOT_TOKEN).toBe('xoxb-real-bot-token')
				expect(createArgs.env.MCP_SERVERS_JSON).toBeDefined()
				const parsed = JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
					mcpServers: Record<string, { type: string; url: string }>
				}
				expect(parsed.mcpServers['integration-slack']).toEqual({
					type: 'http',
					url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
					headers: {
						Authorization: 'Bearer ${MASKIN_API_KEY}',
						'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
					},
				})
			})

			it('refuses to inject when the stored Slack token is not a bot (xoxb-) token — guards against posting as a user', async () => {
				const integration = buildIntegration({ provider: 'slack', externalId: 'T-abc' })
				const fixtures = buildLaunchFixtures([integration])

				vi.mocked(getProvider).mockReturnValue(slackProviderConfig as never)
				// The stored credential is a user token — wrong scopes, do not inject
				mockGetValidToken.mockResolvedValueOnce('xoxp-user-token')

				setupLaunchMocks(fixtures)
				await manager.startSession(fixtures.session.id)

				const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
					env: Record<string, string>
				}

				expect(createArgs.env.SLACK_BOT_TOKEN).toBeUndefined()
				const mcpKeys = createArgs.env.MCP_SERVERS_JSON
					? Object.keys(
							(
								JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
									mcpServers: Record<string, unknown>
								}
							).mcpServers,
						)
					: []
				expect(mcpKeys).not.toContain('integration-slack')
			})
		})

		it('passes AGENT_MCP_JSON and GITHUB_TOKEN_* together so envsubst can resolve the token reference', async () => {
			const integration = buildIntegration({
				provider: 'github',
				externalId: 'install-aaa',
				config: { owner_login: 'sindre-ai' },
			})
			const fixtures = buildLaunchFixtures([integration])
			// Agent has opted into the GitHub MCP server for this org
			fixtures.agent.tools = {
				mcpServers: {
					'github-sindre-ai': {
						type: 'stdio',
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-github'],
						env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_SINDRE_AI}' },
					},
				},
			}

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_real_token')

			setupLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}

			// Token env var is present for envsubst to substitute into the MCP config
			expect(createArgs.env.GITHUB_TOKEN_SINDRE_AI).toBe('ghs_real_token')

			// AGENT_MCP_JSON carries the MCP config with the placeholder intact —
			// the container entrypoint runs envsubst to resolve it at startup
			expect(createArgs.env.AGENT_MCP_JSON).toBeDefined()
			const agentMcp = JSON.parse(createArgs.env.AGENT_MCP_JSON) as {
				mcpServers: Record<string, { env: Record<string, string> }>
			}
			expect(agentMcp.mcpServers['github-sindre-ai']).toBeDefined()
			expect(agentMcp.mcpServers['github-sindre-ai'].env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
				'${GITHUB_TOKEN_SINDRE_AI}',
			)
		})
	})

	describe('startSession() — GitHub preflight', () => {
		const githubProviderConfig = {
			config: {
				name: 'github',
				mcp: {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-github'],
					envKey: 'GITHUB_TOKEN',
				},
			},
		}
		const slackProviderConfig = {
			config: {
				name: 'slack',
				mcp: {
					envKey: 'SLACK_BOT_TOKEN',
				},
			},
		}

		function launchFixtures(opts: {
			integrationRows: ReturnType<typeof buildIntegration>[]
			agentTools?: Record<string, unknown> | null
		}) {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
			})
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }
			const agent = {
				id: session.actorId,
				type: 'agent' as const,
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: opts.agentTools ?? null,
			}
			return { session, workspace, agent, integrationRows: opts.integrationRows }
		}

		function loadLaunchMocks(fixtures: ReturnType<typeof launchFixtures>) {
			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})
			mockResults.selectQueue = [
				[fixtures.session],
				[fixtures.workspace],
				[{ count: 0 }],
				[fixtures.agent],
				[fixtures.workspace],
				[fixtures.workspace],
				fixtures.integrationRows,
			]
		}

		function jsonRes(body: unknown, status = 200): Response {
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			})
		}

		it('drops a broken github identity from AGENT_MCP_JSON and posts one Slack alert to C075JBZ65RT', async () => {
			const slackIntegration = buildIntegration({ provider: 'slack', externalId: 'T-preflight' })
			const fixtures = launchFixtures({
				integrationRows: [slackIntegration],
				agentTools: {
					mcpServers: {
						github: {
							type: 'stdio',
							command: 'npx',
							args: ['-y', '@modelcontextprotocol/server-github'],
							env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_ok' },
						},
						github_approver: {
							type: 'stdio',
							command: 'npx',
							args: ['-y', '@modelcontextprotocol/server-github'],
							env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_broken' },
						},
					},
				},
			})

			vi.mocked(getProvider).mockReturnValue(slackProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('xoxb-preflight-bot-token')

			const fetchCalls: Array<{ url: string; body?: unknown }> = []
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					const u = url.toString()
					fetchCalls.push({
						url: u,
						body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
					})
					if (u === 'https://api.github.com/user') {
						// Route the /user probe by Authorization header — the approver
						// token gets a 401, the primary succeeds.
						const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
						if (auth === 'Bearer ghp_broken')
							return new Response('bad creds ghp_broken', { status: 401 })
						return jsonRes({ login: 'octocat' })
					}
					if (u.startsWith('https://api.github.com/repos/'))
						return jsonRes({ permissions: { push: true } })
					if (u === 'https://slack.com/api/chat.postMessage') return jsonRes({ ok: true })
					throw new Error(`unexpected fetch: ${u}`)
				}),
			)

			loadLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			const agentMcp = JSON.parse(createArgs.env.AGENT_MCP_JSON) as {
				mcpServers: Record<string, unknown>
			}
			// Broken identity gated: agent literally cannot call mcp__github_approver__*
			expect(Object.keys(agentMcp.mcpServers)).toContain('github')
			expect(Object.keys(agentMcp.mcpServers)).not.toContain('github_approver')

			const slackPosts = fetchCalls.filter(
				(c) => c.url === 'https://slack.com/api/chat.postMessage',
			)
			expect(slackPosts).toHaveLength(1)
			const slackBody = slackPosts[0]?.body as { channel: string; text: string }
			expect(slackBody.channel).toBe('C075JBZ65RT')
			expect(slackBody.text).toContain('github_approver')
			expect(slackBody.text).toContain('401-unauth')
			expect(slackBody.text).not.toContain('ghp_broken')
		})

		it('missing token short-circuits to missing-token and never hits the anonymous rate-limit bucket', async () => {
			const slackIntegration = buildIntegration({ provider: 'slack', externalId: 'T-missing' })
			const fixtures = launchFixtures({
				integrationRows: [slackIntegration],
				agentTools: {
					mcpServers: {
						github_approver: {
							type: 'stdio',
							command: 'npx',
							args: ['-y', '@modelcontextprotocol/server-github'],
							env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_APPROVER}' },
						},
					},
				},
			})

			vi.mocked(getProvider).mockReturnValue(slackProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('xoxb-bot-token')

			const fetchCalls: string[] = []
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					const u = url.toString()
					fetchCalls.push(u)
					if (u === 'https://slack.com/api/chat.postMessage')
						return jsonRes({ ok: true, body: init?.body })
					throw new Error(`missing-token path must not hit ${u}`)
				}),
			)

			loadLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			expect(fetchCalls).not.toContain('https://api.github.com/user')
			expect(fetchCalls).toContain('https://slack.com/api/chat.postMessage')

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			const agentMcp = JSON.parse(createArgs.env.AGENT_MCP_JSON) as {
				mcpServers: Record<string, unknown>
			}
			expect(agentMcp.mcpServers).toEqual({})
		})

		it('leaves the MCP config untouched and posts no Slack alert when every identity is healthy', async () => {
			const wsId = randomUUID()
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-healthy',
				config: { owner_login: 'sindre-ai' },
			})
			const fixtures = launchFixtures({ integrationRows: [integration] })
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_healthy_token')

			// Rely on the outer describe's default fetch stub (healthy + no Slack call
			// expected because nothing failed).
			loadLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const fetchMock = vi.mocked(fetch)
			const calledUrls = fetchMock.mock.calls.map((args) => args[0]?.toString() ?? '')
			expect(calledUrls).not.toContain('https://slack.com/api/chat.postMessage')

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			const mcp = JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
				mcpServers: Record<string, unknown>
			}
			expect(mcp.mcpServers['github-sindre-ai']).toBeDefined()
		})

		it('probes the session’s resolved target repo directly instead of /installation/repositories once GITHUB_REPO is known', async () => {
			const wsId = randomUUID()
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-healthy',
				config: { owner_login: 'sindre-ai' },
			})
			const fixtures = launchFixtures({ integrationRows: [integration] })
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			vi.mocked(getProvider).mockReturnValue(githubProviderConfig as never)
			mockGetValidToken.mockResolvedValueOnce('ghs_healthy_token')

			const originalEnv = process.env.GITHUB_REPO
			process.env.GITHUB_REPO = 'sindre-ai/maskin'
			try {
				loadLaunchMocks(fixtures)
				await manager.startSession(fixtures.session.id)

				const fetchMock = vi.mocked(fetch)
				const calledUrls = fetchMock.mock.calls.map((args) => args[0]?.toString() ?? '')
				expect(calledUrls).toContain('https://api.github.com/repos/sindre-ai/maskin/git/blobs')
				expect(calledUrls).not.toContain(
					'https://api.github.com/installation/repositories?per_page=1',
				)

				const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
					env: Record<string, string>
				}
				const mcp = JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
					mcpServers: Record<string, unknown>
				}
				expect(mcp.mcpServers['github-sindre-ai']).toBeDefined()
			} finally {
				if (originalEnv === undefined) {
					// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
					delete process.env.GITHUB_REPO
				} else {
					process.env.GITHUB_REPO = originalEnv
				}
			}
		})

		it('attributes a write-scope failure to the correct installation when two orgs are connected', async () => {
			const wsId = randomUUID()
			const healthyIntegration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-healthy-org',
				config: { owner_login: 'sindre-ai' },
			})
			const brokenIntegration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				externalId: 'install-broken-org',
				config: { owner_login: 'vaerksted-ai' },
			})
			const slackIntegration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				externalId: 'T-multi-install',
			})
			const fixtures = launchFixtures({
				integrationRows: [healthyIntegration, brokenIntegration, slackIntegration],
			})
			fixtures.session.workspaceId = wsId
			fixtures.workspace.id = wsId

			vi.mocked(getProvider).mockImplementation(
				(provider: string) =>
					(provider === 'slack' ? slackProviderConfig : githubProviderConfig) as never,
			)
			mockGetValidToken
				.mockResolvedValueOnce('ghs_token_sindre_ai')
				.mockResolvedValueOnce('ghs_token_vaerksted_ai')
				.mockResolvedValueOnce('xoxb-multi-install-bot')

			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					const u = url.toString()
					const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
					if (u === 'https://api.github.com/installation/repositories?per_page=1') {
						if (auth === 'Bearer ghs_token_vaerksted_ai')
							return jsonRes({ repositories: [{ full_name: 'vaerksted-ai/x' }] })
						return jsonRes({ repositories: [{ full_name: 'sindre-ai/maskin' }] })
					}
					if (u === 'https://api.github.com/repos/sindre-ai/maskin/git/blobs')
						return jsonRes({ sha: 'abc123' }, 201)
					if (u === 'https://api.github.com/repos/vaerksted-ai/x/git/blobs')
						return new Response('Resource not accessible by integration', { status: 403 })
					if (u === 'https://slack.com/api/chat.postMessage') return jsonRes({ ok: true })
					throw new Error(`unexpected fetch: ${u}`)
				}),
			)

			loadLaunchMocks(fixtures)
			await manager.startSession(fixtures.session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			const mcp = JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
				mcpServers: Record<string, unknown>
			}
			// The failing org's identity is gated; the healthy org's identity is untouched.
			expect(mcp.mcpServers['github-sindre-ai']).toBeDefined()
			expect(mcp.mcpServers['github-vaerksted-ai']).toBeUndefined()

			const fetchMock = vi.mocked(fetch)
			const slackPost = fetchMock.mock.calls.find(
				(args) => args[0]?.toString() === 'https://slack.com/api/chat.postMessage',
			)
			const slackBody = JSON.parse((slackPost?.[1]?.body as string) ?? '{}') as { text: string }
			// Names the broken org's installation, not the healthy org's.
			expect(slackBody.text).toContain(brokenIntegration.externalId)
			expect(slackBody.text).not.toContain(healthyIntegration.externalId)
			expect(slackBody.text).toContain('github-vaerksted-ai')
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

		it('routes to the agent-server and marks the session terminal when agentServerId is set', async () => {
			const session = buildSession({
				status: 'running',
				agentServerId: 'agent-server-1',
				containerId: 'sandbox-name',
			})
			const server = {
				id: 'agent-server-1',
				url: 'https://agent-finland.maskin.test:3001',
				secret: 'x'.repeat(32),
			}
			// 1st select: stopSession's own session lookup. 2nd: the agent_servers
			// row lookup. markRemoteSessionComplete no longer does its own SELECT —
			// it does a single CAS UPDATE ... RETURNING instead (see updateQueue
			// below); the subsequent hasOtherActiveSessions select falls through to
			// the unset static `mockResults.select` default of [], i.e. "no other
			// active sessions", which drives the actors-table update below.
			mockResults.selectQueue = [[session], [server]]
			// 1st update: markRemoteSessionComplete's CAS on `sessions` — its
			// .returning() must yield the row so workspaceId/actorId are available
			// for the events insert. 2nd update: the actors.agentState sync inside
			// hasOtherActiveSessions' branch — its return value is unused by the
			// code, so an empty array is fine.
			mockResults.updateQueue = [[session], []]

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)

			try {
				await manager.stopSession(session.id)

				expect(fetchSpy).toHaveBeenCalledWith(
					`${server.url}/sessions/${session.id}/stop`,
					expect.objectContaining({
						method: 'POST',
						headers: expect.objectContaining({ Authorization: `Bearer ${server.secret}` }),
					}),
				)
				// Local Docker must never be touched for a remotely-dispatched session.
				expect(mockContainerManager.stop).not.toHaveBeenCalled()

				const statusUpdate = calls.updates.find(
					(u) => (u as Record<string, unknown>).status === 'failed',
				) as Record<string, unknown> | undefined
				expect(statusUpdate).toBeDefined()
			} finally {
				fetchSpy.mockRestore()
			}
		})

		it('throws when the session references a missing agent server', async () => {
			const session = buildSession({ status: 'running', agentServerId: 'ghost-server' })
			mockResults.selectQueue = [[session], []]

			await expect(manager.stopSession(session.id)).rejects.toThrow(
				'Agent server ghost-server not found',
			)
		})

		it('sanitizes an AgentServerHttpError from the remote stop call — no internal URL or response body leaks to the caller', async () => {
			const session = buildSession({
				status: 'running',
				agentServerId: 'agent-server-1',
				containerId: 'sandbox-name',
			})
			const server = {
				id: 'agent-server-1',
				url: 'https://agent-finland.maskin.test:3001',
				secret: 'x'.repeat(32),
			}
			mockResults.selectQueue = [[session], [server]]

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('internal stack trace: secrets.db line 42', {
					status: 500,
				}),
			)

			try {
				const err = await manager.stopSession(session.id).catch((e) => e)
				expect(err).toBeInstanceOf(Error)
				const message = (err as Error).message
				expect(message).toBe(`Failed to stop session ${session.id}: agent-server returned HTTP 500`)
				expect(message).not.toContain(server.url)
				expect(message).not.toContain('secrets.db')
			} finally {
				fetchSpy.mockRestore()
			}
		})

		it('sanitizes an AgentServerAuthError from the remote stop call', async () => {
			const session = buildSession({
				status: 'running',
				agentServerId: 'agent-server-1',
				containerId: 'sandbox-name',
			})
			const server = {
				id: 'agent-server-1',
				url: 'https://agent-finland.maskin.test:3001',
				secret: 'x'.repeat(32),
			}
			mockResults.selectQueue = [[session], [server]]

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response('', { status: 401 }))

			try {
				await expect(manager.stopSession(session.id)).rejects.toThrow(
					`Failed to stop session ${session.id}: agent-server rejected bearer token`,
				)
			} finally {
				fetchSpy.mockRestore()
			}
		})

		it('sanitizes a raw network/fetch error from the remote stop call — no internal host leaks to the caller', async () => {
			const session = buildSession({
				status: 'running',
				agentServerId: 'agent-server-1',
				containerId: 'sandbox-name',
			})
			const server = {
				id: 'agent-server-1',
				url: 'https://agent-finland.maskin.test:3001',
				secret: 'x'.repeat(32),
			}
			mockResults.selectQueue = [[session], [server]]

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockRejectedValue(new TypeError('fetch failed: connect ECONNREFUSED 10.2.0.5:3001'))

			try {
				const err = await manager.stopSession(session.id).catch((e) => e)
				expect(err).toBeInstanceOf(Error)
				const message = (err as Error).message
				expect(message).toBe(`Failed to stop session ${session.id}: agent-server request failed`)
				expect(message).not.toContain('10.2.0.5')
				expect(message).not.toContain(server.url)
			} finally {
				fetchSpy.mockRestore()
			}
		})
	})

	describe('markRemoteSessionComplete()', () => {
		it('no-ops without writing an event when the CAS update matches no row (already terminal / lost the race)', async () => {
			mockResults.update = [] // .returning() → no row: UPDATE matched nothing
			const initialInsertCount = calls.inserts.length

			await manager.markRemoteSessionComplete('some-session-id', 1)

			expect(calls.inserts.length).toBe(initialInsertCount)
		})

		it('inserts exactly one session_failed event when the CAS update matches a row (nonzero exit code)', async () => {
			const session = buildSession({ status: 'running' })
			mockResults.updateQueue = [[session], []]

			await manager.markRemoteSessionComplete(session.id, 137)

			const eventInsert = calls.inserts.find(
				(v) => (v as Record<string, unknown>).action === 'session_failed',
			)
			expect(eventInsert).toBeDefined()
		})

		it('retries the CAS update on a thrown DB error and succeeds once a retry clears', async () => {
			const session = buildSession({ status: 'running' })
			// hasOtherActiveSessions' SELECT — a non-empty result means "yes, other
			// active sessions exist", so the actors-table update branch is skipped
			// and doesn't consume an extra update() call, keeping the retry count
			// below attributable only to the CAS update.
			mockResults.select = [{ id: 'other-session' }]
			// 1st and 2nd CAS attempts throw; 3rd (final, within CAS_UPDATE_RETRIES)
			// succeeds and returns the row via .returning().
			mockResults.updateErrorQueue = [
				new Error('connection reset'),
				new Error('connection reset'),
				undefined,
			]
			mockResults.updateQueue = [[session]]

			await manager.markRemoteSessionComplete(session.id, 137)

			const eventInsert = calls.inserts.find(
				(v) => (v as Record<string, unknown>).action === 'session_failed',
			)
			expect(eventInsert).toBeDefined()
		})

		it('gives up and no-ops after exhausting retries when the fallback lookup also finds no session', async () => {
			mockResults.updateErrorQueue = [
				new Error('connection reset'),
				new Error('connection reset'),
				new Error('connection reset'),
			]
			// The fallback lookup after CAS retries are exhausted finds nothing
			// (unconfigured select defaults to []) — nothing left to clean up.
			const initialInsertCount = calls.inserts.length

			await expect(
				manager.markRemoteSessionComplete('some-session-id', 137),
			).resolves.toBeUndefined()

			expect(calls.inserts.length).toBe(initialInsertCount)
		})

		it('still runs terminal side effects via a fallback lookup when CAS retries are exhausted but the session is still running (Bug 2 regression)', async () => {
			const session = buildSession({ status: 'running' })
			mockResults.updateErrorQueue = [
				new Error('connection reset'),
				new Error('connection reset'),
				new Error('connection reset'),
			]
			// 1st select: markRemoteSessionComplete's own usage extraction (reads
			// session_logs) — empty means "no usage found", a no-op. 2nd select:
			// the fallback lookup after CAS retries are exhausted, finds the
			// session still 'running'. 3rd select: hasOtherActiveSessions' check —
			// a non-empty result skips the actors-table update branch.
			mockResults.selectQueue = [[], [session], [{ id: 'other-session' }]]

			await manager.markRemoteSessionComplete(session.id, 137)

			const eventInsert = calls.inserts.find(
				(v) => (v as Record<string, unknown>).action === 'session_failed',
			)
			expect(eventInsert).toBeDefined()
		})

		it('persists non-null usage fields via the fallback direct update when CAS retries are exhausted', async () => {
			const session = buildSession({ status: 'running' })
			mockResults.updateErrorQueue = [
				new Error('connection reset'),
				new Error('connection reset'),
				new Error('connection reset'),
			]
			const resultLogRow = {
				content: JSON.stringify({
					type: 'result',
					total_cost_usd: 0.1234,
					duration_ms: 5000,
					usage: {
						input_tokens: 100,
						output_tokens: 200,
						cache_creation_input_tokens: 10,
						cache_read_input_tokens: 20,
					},
				}),
			}
			// 1st select: markRemoteSessionComplete's own usage extraction (reads
			// session_logs) — finds the result event this time, unlike the sibling
			// "still runs terminal side effects" test above. 2nd select: the
			// fallback lookup after CAS retries are exhausted, finds the session
			// still 'running'. 3rd select: hasOtherActiveSessions' check — a
			// non-empty result skips the actors-table update branch.
			mockResults.selectQueue = [[resultLogRow], [session], [{ id: 'other-session' }]]

			await manager.markRemoteSessionComplete(session.id, 0)

			// calls.updates captures every .update().set() in call order, across
			// every table touched (sessions, then later actors/objects) — not just
			// the sessions-table update we care about. clearActiveSession() runs
			// after the fallback and would land last if we just took .at(-1), so
			// filter for the sessions-shaped payload (identified by totalCostUsd)
			// and take its last occurrence — the fallback direct update (~2830),
			// distinct from the 3 preceding (and failing) primary CAS attempts.
			const sessionUpdates = calls.updates.filter(
				(v): v is Record<string, unknown> =>
					typeof v === 'object' && v !== null && 'totalCostUsd' in v,
			)
			const fallbackUpdate = sessionUpdates.at(-1) as Record<string, unknown>
			expect(fallbackUpdate.totalCostUsd).toBe('0.1234')
			expect(fallbackUpdate.inputTokens).toBe(100)
			expect(fallbackUpdate.outputTokens).toBe(200)
			expect(fallbackUpdate.cacheCreationInputTokens).toBe(10)
			expect(fallbackUpdate.cacheReadInputTokens).toBe(20)
			expect(fallbackUpdate.durationMs).toBe(5000)
		})

		it('no-ops via the fallback lookup when a concurrent call already resolved the session', async () => {
			const session = buildSession({ status: 'failed' })
			mockResults.updateErrorQueue = [
				new Error('connection reset'),
				new Error('connection reset'),
				new Error('connection reset'),
			]
			// 1st select: the usage-extraction select (empty = no-op). 2nd select:
			// the fallback lookup, which finds the session already resolved.
			mockResults.selectQueue = [[], [session]]
			const initialInsertCount = calls.inserts.length

			await manager.markRemoteSessionComplete(session.id, 137)

			expect(calls.inserts.length).toBe(initialInsertCount)
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

		it('clears currentActivity to null on successful pause', async () => {
			const session = buildSession({
				status: 'running',
				containerId: 'container-abc',
				currentActivity: 'Searching codebase',
			})
			mockResults.select = [session]
			mockResults.insert = []
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })

			await manager.pauseSession(session.id)

			const pauseUpdate = calls.updates.find(
				(u) => (u as Record<string, unknown>).status === 'paused',
			)
			expect(pauseUpdate).toMatchObject({ currentActivity: null })
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

		// AC-T2: the persisted `session_logs` envelope tacks a
		// `maskin_attachments` field onto the JSON we write to stdin so
		// reload-from-history (via /logs replay) can render attached file
		// cards on the user turn. The CLI stdin write must NOT see the extra
		// field — keeping it Maskin-only protects against a future CLI
		// version rejecting unknown keys.
		it('persists maskin_attachments in the log envelope but keeps stdin clean', async () => {
			const session = buildSession({ interactive: true, status: 'running' })
			mockResults.insert = [{ id: 99, ...session, stream: 'stdout', content: '' }]

			const attachments = [
				{ kind: 'file', id: 'file-abc', name: 'photo.png', mime_type: 'image/png', size_bytes: 4 },
				{ kind: 'object', id: 'obj-1' },
			]
			await manager.writeInput(
				session.id,
				{ type: 'user', message: { role: 'user', content: 'look' } },
				attachments,
			)

			// 1. The CLI stdin payload must NOT carry maskin_attachments — keeping
			//    it Maskin-only protects against a future CLI version rejecting
			//    unknown keys.
			expect(mockContainerManager.write).toHaveBeenCalledWith(session.id, {
				type: 'user',
				message: { role: 'user', content: 'look' },
			})
			const wirePayload = (mockContainerManager.write.mock.calls[0] as unknown[])[1]
			expect(wirePayload).not.toHaveProperty('maskin_attachments')

			// 2. The session_logs row DOES carry it so reload can re-render the
			//    user bubble — including any image cards — without a second
			//    POST to /files.
			expect(calls.inserts.length).toBeGreaterThanOrEqual(1)
			const inserted = calls.inserts.at(-1) as { content: string; stream: string }
			expect(inserted.stream).toBe('stdout')
			expect(JSON.parse(inserted.content)).toEqual({
				type: 'user',
				message: { role: 'user', content: 'look' },
				maskin_attachments: attachments,
			})
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
				systemPrompt: 'You are Workspace Coach.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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
			const workspace = { id: session.workspaceId, byollmAllowed: true, settings: {} }

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

	describe('hasCapacity()', () => {
		it('returns false when starting sessions fill the workspace capacity', async () => {
			// Regression guard for the fix in PR #511: before the fix only 'running'
			// sessions were counted, so containers allocated in the 'starting' state
			// were invisible to the limiter and drainQueue could bypass the per-workspace cap.
			mockResults.selectQueue = [
				[{ settings: { max_concurrent_sessions: 2 } }], // workspace lookup
				[{ count: 2 }], // starting + running = at cap
			]

			const result = await (
				manager as unknown as { hasCapacity(workspaceId: string): Promise<boolean> }
			).hasCapacity('ws-1')

			expect(result).toBe(false)
		})

		it('returns true when there is remaining capacity', async () => {
			mockResults.selectQueue = [
				[{ settings: { max_concurrent_sessions: 3 } }], // workspace lookup
				[{ count: 1 }], // one session active, two slots free
			]

			const result = await (
				manager as unknown as { hasCapacity(workspaceId: string): Promise<boolean> }
			).hasCapacity('ws-1')

			expect(result).toBe(true)
		})

		it('uses the default cap of 3 when workspace has no max_concurrent_sessions setting', async () => {
			mockResults.selectQueue = [
				[{ settings: {} }], // workspace with no cap setting
				[{ count: 3 }], // three sessions active = at default cap
			]

			const result = await (
				manager as unknown as { hasCapacity(workspaceId: string): Promise<boolean> }
			).hasCapacity('ws-1')

			expect(result).toBe(false)
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
				[], // 2. stuckAgentSessions (no stuck sessions)
				[orphan], // 3. runningSessions (idle check)
				[], // 4. lastLog for orphan (empty → falls back to startedAt, which is >10min old)
				// markSessionFailedAfterContainerLoss → existing session select (new in this branch):
				[], // 5. existing session lookup (undefined → skip telemetry, update still fires)
				// markSessionFailedAfterContainerLoss → drainQueue → hasCapacity:
				[{ settings: {} }], // 6. drainQueue > workspace lookup
				[{ count: 0 }], // 7. drainQueue > running count
				[], // 8. drainQueue > nextQueued (empty = break)
				[], // 9. expiredPaused
				[], // 10. stuckPending
				[], // 11. stuckStarting
				[], // 12. final queuedSessions
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

		it('skips auto-pause when inspect reports the container is no longer running (agent-server session)', async () => {
			// For agent-server sessions the containerId is a remote msb sandbox name —
			// local Docker inspect is meaningless. The watchdog must skip (continue)
			// instead of marking failed; the agent-server's exit callback owns cleanup.
			const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000)
			const stale = buildSession({
				status: 'running',
				containerId: 'container-dead',
				agentServerId: 'server-1',
				startedAt: twentyMinutesAgo,
				interactive: false,
			})
			const pauseSpy = vi.spyOn(manager, 'pauseSession')
			mockContainerManager.inspect.mockResolvedValueOnce({ running: false, exitCode: 137 })

			mockResults.selectQueue = [
				[], // 1. timedOut
				[], // 2. stuckAgentSessions (no stuck sessions)
				[stale], // 3. runningSessions
				[], // 4. lastLog (empty → falls back to startedAt, which is >10min old)
				// isContainerAlive → inspect mock returns { running: false } (consumed here)
				// stale.agentServerId is set → continue, no markSessionFailedAfterContainerLoss
				[], // 5. expiredPaused
				[], // 6. stuckPending
				[], // 7. stuckStarting
				[], // 8. final queuedSessions
			]

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			expect(pauseSpy).not.toHaveBeenCalled()
			// No 'failed' update — agent-server sessions are deferred to the server's exit callback.
			const failedUpdate = calls.updates.find(
				(u): u is { status: string } =>
					typeof u === 'object' && u !== null && (u as { status?: string }).status === 'failed',
			)
			expect(failedUpdate).toBeUndefined()
		})
	})

	describe('appendRemoteSessionLogs() — github tool-call cause_tag tagging', () => {
		// The classifier singleton is process-wide; import lazily so the mock
		// setup at the top of the file has taken effect first.
		type ClassifierModule = typeof import('../../lib/integrations/providers/github/log-classifier')
		let sessionGithubLogClassifier: ClassifierModule['sessionGithubLogClassifier']

		beforeAll(async () => {
			const mod = await import('../../lib/integrations/providers/github/log-classifier')
			sessionGithubLogClassifier = mod.sessionGithubLogClassifier
		})

		function registerFakeInstall(sessionId: string, ownerLower: string, installationId: string) {
			sessionGithubLogClassifier.registerSession(sessionId, [
				{
					ownerLoginLower: ownerLower,
					installationId,
					tokenMetadata: {
						token: 'ghs_test',
						installationId,
						mintedAt: new Date(Date.now() - 60_000),
					},
				},
			])
		}

		function findInserts(pred: (row: { stream?: string; content?: string }) => boolean) {
			return calls.inserts.filter(
				(row): row is { stream: string; content: string } =>
					typeof row === 'object' &&
					row !== null &&
					pred(row as { stream?: string; content?: string }),
			)
		}

		it('emits a system-stream cause_tag line for a failing github tool_result and passes non-github stdout through unchanged', async () => {
			const sessionId = randomUUID()
			registerFakeInstall(sessionId, 'sindre-ai', '4711')
			try {
				const toolUse = JSON.stringify({
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'toolu_401',
								name: 'mcp__github-sindre-ai__get_issue',
								input: {},
							},
						],
					},
				})
				const toolResult = JSON.stringify({
					type: 'user',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_401',
								content: 'GitHub API 401: Bad credentials',
								is_error: true,
							},
						],
					},
				})
				const nonGithub =
					'plain container stdout with no JSON envelope — must be persisted untouched'

				await manager.appendRemoteSessionLogs(sessionId, [
					{ stream: 'stdout', content: `${toolUse}\n` },
					{ stream: 'stdout', content: `${toolResult}\n` },
					{ stream: 'stdout', content: `${nonGithub}\n` },
				])

				const tagged = findInserts(
					(r) => r.stream === 'system' && (r.content ?? '').includes('cause_tag=401-unauth'),
				)
				expect(tagged).toHaveLength(1)
				expect(tagged[0].content).toContain('tool=mcp__github-sindre-ai__get_issue')
				expect(tagged[0].content).toContain('installation_id=4711')

				const stdoutPassthrough = findInserts(
					(r) => r.stream === 'stdout' && (r.content ?? '').includes(nonGithub),
				)
				expect(stdoutPassthrough).toHaveLength(1)
			} finally {
				sessionGithubLogClassifier.unregisterSession(sessionId)
			}
		})

		it('lands ≥4 distinct cause_tags across a seeded fault-injection sequence', async () => {
			const sessionId = randomUUID()
			registerFakeInstall(sessionId, 'sindre-ai', '4711')
			try {
				const faults: Array<[string, string, string]> = [
					['toolu_401', 'mcp__github-sindre-ai__get_issue', 'GitHub API 401: Bad credentials'],
					[
						'toolu_403',
						'mcp__github-sindre-ai__merge_pull_request',
						'GitHub API 403: Resource not accessible by integration',
					],
					[
						'toolu_422',
						'mcp__github-sindre-ai__create_pull_request_review',
						'GitHub API 422: Validation Failed — expected number for pull_number',
					],
					// Owner the session doesn't know about → hadToken:false → missing-token.
					[
						'toolu_missing',
						'mcp__github-unknown-org__list_issues',
						'GitHub API 401: Bad credentials',
					],
				]

				const lines: Array<{ stream: 'stdout'; content: string }> = []
				for (const [id, name, body] of faults) {
					lines.push({
						stream: 'stdout',
						content: `${JSON.stringify({
							type: 'assistant',
							message: {
								content: [{ type: 'tool_use', id, name, input: {} }],
							},
						})}\n`,
					})
					lines.push({
						stream: 'stdout',
						content: `${JSON.stringify({
							type: 'user',
							message: {
								content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: true }],
							},
						})}\n`,
					})
				}

				await manager.appendRemoteSessionLogs(sessionId, lines)

				const tags = findInserts(
					(r) => r.stream === 'system' && (r.content ?? '').includes('[github-cause-tag]'),
				)
					.map((r) => r.content.match(/cause_tag=([\w-]+)/)?.[1])
					.filter((t): t is string => Boolean(t))

				const distinct = new Set(tags)
				expect(distinct.size).toBeGreaterThanOrEqual(4)
				expect(distinct).toContain('401-unauth')
				expect(distinct).toContain('403-permission')
				expect(distinct).toContain('schema-validation')
				expect(distinct).toContain('missing-token')
			} finally {
				sessionGithubLogClassifier.unregisterSession(sessionId)
			}
		})

		it('does not emit a cause_tag for an unregistered session', async () => {
			const sessionId = randomUUID()
			const toolUse = JSON.stringify({
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							id: 'toolu_x',
							name: 'mcp__github-sindre-ai__get_issue',
							input: {},
						},
					],
				},
			})
			const toolResult = JSON.stringify({
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_x',
							content: 'GitHub API 500: server error',
							is_error: true,
						},
					],
				},
			})
			await manager.appendRemoteSessionLogs(sessionId, [
				{ stream: 'stdout', content: `${toolUse}\n${toolResult}\n` },
			])
			const tagged = findInserts(
				(r) => r.stream === 'system' && (r.content ?? '').includes('[github-cause-tag]'),
			)
			expect(tagged).toHaveLength(0)
		})
	})

	describe('streamContainerLogs() — reconnect on transient stream drop', () => {
		it('falls back to tail:0 when no chunk was ever ingested, writes a drop marker, and does not surface the "interrupted" sentinel', async () => {
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

			// First connect throws before any chunk arrives (simulating a socket
			// drop), second connect yields one chunk and ends naturally.
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

			// Two calls: first replays history (`{}`); second reattaches — since no
			// chunk was ever ingested there's no timestamp to backfill from, so it
			// falls back to `tail: 0` rather than duplicating everything.
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

			// A drop is now visible even when the reconnect itself succeeds.
			const dropped = calls.inserts.find(
				(i): i is { stream: string; content: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { stream?: string }).stream === 'system' &&
					String((i as { content?: string }).content ?? '').includes('Log stream dropped'),
			)
			expect(dropped).toBeDefined()

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

		it('backfills via sinceUnixSec from the last ingested chunk when a drop happens mid-stream', async () => {
			const sessionId = 'sess-reconnect-backfill'
			const FIXED_TIME_MS = 1_700_000_000_000
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; logsDrained?: Promise<void> }>
				}
			).activeSessions.set(sessionId, { tempDir: '/tmp/test' })

			// First connect delivers a chunk, then the connection drops. Second
			// connect recovers.
			mockContainerManager.logs.mockImplementationOnce(() => ({
				async *[Symbol.asyncIterator]() {
					yield { stream: 'stdout' as const, data: 'first-chunk' }
					throw new Error('socket closed mid-stream')
				},
			}))
			mockContainerManager.logs.mockImplementationOnce(() => ({
				async *[Symbol.asyncIterator]() {
					yield { stream: 'stdout' as const, data: 'recovered-chunk' }
				},
			}))
			mockContainerManager.inspect.mockResolvedValueOnce({ running: true, exitCode: null })

			vi.useFakeTimers()
			vi.setSystemTime(FIXED_TIME_MS)
			try {
				;(
					manager as unknown as {
						streamContainerLogs(sessionId: string, containerId: string): void
					}
				).streamContainerLogs(sessionId, 'container-backfill')

				const drained = (
					manager as unknown as {
						activeSessions: Map<string, { logsDrained?: Promise<void> }>
					}
				).activeSessions.get(sessionId)?.logsDrained
				expect(drained).toBeDefined()

				await vi.runAllTimersAsync()
				await drained
			} finally {
				vi.useRealTimers()
			}

			// Second call backfills from the last successfully-ingested chunk's
			// timestamp instead of jumping to "now".
			expect(mockContainerManager.logs).toHaveBeenCalledTimes(2)
			expect(mockContainerManager.logs).toHaveBeenNthCalledWith(1, 'container-backfill', true, {})
			expect(mockContainerManager.logs).toHaveBeenNthCalledWith(2, 'container-backfill', true, {
				sinceUnixSec: Math.floor(FIXED_TIME_MS / 1000),
			})

			const dropped = calls.inserts.find(
				(i): i is { stream: string; content: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { stream?: string }).stream === 'system' &&
					String((i as { content?: string }).content ?? '').includes('Log stream dropped'),
			)
			expect(dropped).toBeDefined()
			expect(dropped?.content).toContain(new Date(FIXED_TIME_MS).toISOString())
		})
	})

	describe('handleCompletion() — agentState sync', () => {
		beforeEach(() => {
			vi.spyOn(AgentStorageManager.prototype, 'pushAgentFiles').mockResolvedValue(undefined)
			mockClassifyCreditExhaustion.mockReturnValue(null)
		})

		it('sets agentState to idle when session completes (exitCode 0)', async () => {
			const session = buildSession({ status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, { tempDir: '/tmp/test', stdoutTail: '' })

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			const actorUpdate = calls.updates.find(
				(u): u is Record<string, unknown> =>
					typeof u === 'object' && u !== null && 'agentState' in (u as Record<string, unknown>),
			)
			expect(actorUpdate?.agentState).toBe('idle')
		})

		it('sets agentState to failed when session fails (exitCode non-zero)', async () => {
			const session = buildSession({ status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, { tempDir: '/tmp/test', stdoutTail: '' })

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 1)

			const actorUpdate = calls.updates.find(
				(u): u is Record<string, unknown> =>
					typeof u === 'object' && u !== null && 'agentState' in (u as Record<string, unknown>),
			)
			expect(actorUpdate?.agentState).toBe('failed')
		})

		it('does not touch agentState when the agent has another active session', async () => {
			const session = buildSession({ status: 'running' })
			const otherSession = buildSession({ actorId: session.actorId, status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, { tempDir: '/tmp/test', stdoutTail: '' })

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
				[otherSession], // hasOtherActiveSessions: agent still has live work
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			const actorUpdate = calls.updates.find(
				(u): u is Record<string, unknown> =>
					typeof u === 'object' && u !== null && 'agentState' in (u as Record<string, unknown>),
			)
			expect(actorUpdate).toBeUndefined()
		})
	})

	describe('handleCompletion() — credit-exhaustion classification', () => {
		const knownReason = {
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Anthropic billing error — credit balance may be exhausted',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		}

		beforeEach(() => {
			vi.spyOn(AgentStorageManager.prototype, 'pushAgentFiles').mockResolvedValue(undefined)
			mockClassifyCreditExhaustion.mockReturnValue(knownReason)
		})

		afterEach(() => {
			vi.unstubAllEnvs()
		})

		it('writes failure_reason to both the DB result payload and the event data payload', async () => {
			const session = buildSession({ status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail: 'billing_error',
			})

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 1)

			// DB sessions.result must contain failure_reason
			const sessionUpdate = calls.updates.find(
				(u): u is { result: { exit_code: number; failure_reason: unknown } } =>
					typeof u === 'object' &&
					u !== null &&
					'result' in (u as Record<string, unknown>) &&
					typeof (u as Record<string, unknown>).result === 'object',
			)
			expect(sessionUpdate?.result).toMatchObject({ failure_reason: knownReason })

			// Event insert data must contain failure_reason
			const eventInsert = calls.inserts.find(
				(i): i is { action: string; data: { exit_code: number; failure_reason: unknown } } =>
					typeof i === 'object' &&
					i !== null &&
					typeof (i as Record<string, unknown>).action === 'string' &&
					(i as { action: string }).action.startsWith('session_'),
			)
			expect(eventInsert?.data).toMatchObject({ failure_reason: knownReason })
		})

		it('omits failure_reason when exitCode is 0 and no credit signal is present', async () => {
			const session = buildSession({ status: 'running' })
			mockClassifyCreditExhaustion.mockReturnValue(null)
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, { tempDir: '/tmp/test', stdoutTail: '' })

			mockResults.selectQueue = [[session], []]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			expect(mockClassifyCreditExhaustion).toHaveBeenCalledWith('', {
				includeAmbiguousSignals: false,
			})
			const sessionUpdate = calls.updates.find(
				(u): u is Record<string, unknown> =>
					typeof u === 'object' && u !== null && 'result' in (u as Record<string, unknown>),
			)
			expect(sessionUpdate?.result as Record<string, unknown>).not.toHaveProperty('failure_reason')
		})

		it('does not fail a successful session on an ambiguous credit-exhaustion substring', async () => {
			// Regression test: exitCode 0 must not run the ambiguous (bare-substring)
			// classifier branches — only the literal CLI banner strings can fail a
			// clean exit. Simulate the real classifier's behavior for this input via
			// the mock: since `includeAmbiguousSignals` will be false for exitCode 0,
			// the classifier must return null even though `stdoutTail` contains a
			// substring ('billing_error') that would match an ambiguous signal.
			const session = buildSession({ status: 'running' })
			mockClassifyCreditExhaustion.mockImplementation(
				(_tail: string, options?: { includeAmbiguousSignals?: boolean }) =>
					options?.includeAmbiguousSignals === false ? null : knownReason,
			)
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail: 'Tool result: {"error":"billing_error: connection refused"}',
			})

			mockResults.selectQueue = [[session], []]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			expect(mockClassifyCreditExhaustion).toHaveBeenCalledWith(
				'Tool result: {"error":"billing_error: connection refused"}',
				{ includeAmbiguousSignals: false },
			)
			const sessionUpdate = calls.updates.find(
				(u): u is { status: string; result: Record<string, unknown> } =>
					typeof u === 'object' &&
					u !== null &&
					'status' in (u as Record<string, unknown>) &&
					'result' in (u as Record<string, unknown>),
			)
			expect(sessionUpdate).toMatchObject({ status: 'completed' })
			expect(sessionUpdate?.result).not.toHaveProperty('failure_reason')
		})

		it('marks exitCode 0 sessions failed when Claude prints a limit banner', async () => {
			const session = buildSession({ status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail: "You've hit your limit · resets 3:20pm (UTC)",
			})

			mockResults.selectQueue = [[session], []]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			expect(mockClassifyCreditExhaustion).toHaveBeenCalledWith(
				"You've hit your limit · resets 3:20pm (UTC)",
				{ includeAmbiguousSignals: false },
			)
			const sessionUpdate = calls.updates.find(
				(u): u is { status: string; result: { exit_code: number; failure_reason: unknown } } =>
					typeof u === 'object' &&
					u !== null &&
					'status' in (u as Record<string, unknown>) &&
					'result' in (u as Record<string, unknown>),
			)
			expect(sessionUpdate).toMatchObject({
				status: 'failed',
				result: { exit_code: 0, failure_reason: knownReason },
			})
			const eventInsert = calls.inserts.find(
				(i): i is { action: string; data: { exit_code: number; failure_reason: unknown } } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { action?: string }).action === 'session_failed',
			)
			expect(eventInsert?.data).toMatchObject({ exit_code: 0, failure_reason: knownReason })
		})

		it('fails over primary OAuth runtime limits to backup and starts one retry session', async () => {
			vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'true')
			const session = buildSession({
				status: 'running',
				config: { llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
			})
			const retrySession = buildSession({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				createdBy: session.createdBy,
				status: 'pending',
				sourceSessionId: session.id,
				config: {
					llm_route: 'claude_oauth',
					llm_oauth_slot: 'backup',
					claude_oauth_runtime_failover_retry_of: session.id,
				},
			})
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail:
					'{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}\nYou\'ve hit your limit · resets 3:20pm (UTC)',
			})
			const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
				[], // hasOtherActiveSessions
				[], // existing runtime failover retry lookup
				[
					{
						id: session.workspaceId,
						settings: {
							claude_oauth: {
								primary: {
									encryptedAccessToken: 'primary-access',
									encryptedRefreshToken: 'primary-refresh',
									expiresAt: 1_800_000_000_000,
								},
								backup: {
									encryptedAccessToken: 'backup-access',
									encryptedRefreshToken: 'backup-refresh',
									expiresAt: 1_900_000_000_000,
								},
							},
						},
					},
				], // recordRuntimeClaudeOAuthFailover locked workspace read
			]
			mockResults.insertQueue = [
				[], // completion event
				[], // failover event
				[], // retry notice system log
				[retrySession], // createSession row insert
				[], // createSession event
				[], // terminal system log
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			const failoverUpdate = calls.updates.find(
				(u): u is { settings: { claude_oauth: { failover: { active_slot: string } } } } =>
					typeof u === 'object' &&
					u !== null &&
					typeof (u as { settings?: unknown }).settings === 'object' &&
					Boolean(
						(
							(u as { settings: { claude_oauth?: { failover?: unknown } } }).settings.claude_oauth
								?.failover as Record<string, unknown> | undefined
						)?.active_slot,
					),
			)
			expect(failoverUpdate?.settings.claude_oauth.failover).toMatchObject({
				active_slot: 'backup',
				last_classified_reason: 'quota_exhausted_5h',
			})
			const retryInsert = calls.inserts.find(
				(i): i is { config: Record<string, unknown>; actionPrompt: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { actionPrompt?: unknown }).actionPrompt === session.actionPrompt,
			)
			expect(retryInsert?.config).toMatchObject({
				llm_oauth_slot: 'backup',
				claude_oauth_runtime_failover_retry_of: session.id,
			})
			expect(retryInsert).toMatchObject({ sourceSessionId: session.id })
			expect(startSpy).toHaveBeenCalledWith(retrySession.id)
		})

		it('records backup OAuth runtime limits without starting another retry session', async () => {
			vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'true')
			const sourceSessionId = randomUUID()
			const session = buildSession({
				status: 'running',
				sourceSessionId,
				config: {
					llm_route: 'claude_oauth',
					llm_oauth_slot: 'backup',
					claude_oauth_runtime_failover_retry_of: sourceSessionId,
				},
			})
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail:
					'{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}\nYou\'ve hit your limit · resets 3:20pm (UTC)',
			})
			const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
				[], // hasOtherActiveSessions
				[
					{
						id: session.workspaceId,
						settings: {
							claude_oauth: {
								primary: {
									encryptedAccessToken: 'primary-access',
									encryptedRefreshToken: 'primary-refresh',
									expiresAt: 1_800_000_000_000,
								},
								backup: {
									encryptedAccessToken: 'backup-access',
									encryptedRefreshToken: 'backup-refresh',
									expiresAt: 1_900_000_000_000,
								},
								failover: {
									active_slot: 'backup',
									last_primary_failure_at: 1_783_005_600_000,
									last_classified_reason: 'quota_exhausted_5h',
								},
							},
						},
					},
				], // recordRuntimeClaudeOAuthBackupExhausted locked workspace read
			]
			mockResults.insertQueue = [
				[], // completion event
				[], // backup exhausted event
				[], // backup exhausted system log
				[], // terminal system log
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			const backupUpdate = calls.updates.find(
				(
					u,
				): u is {
					settings: {
						claude_oauth: {
							failover: {
								active_slot: string
								last_backup_classified_reason: string
							}
						}
					}
				} =>
					typeof u === 'object' &&
					u !== null &&
					typeof (u as { settings?: unknown }).settings === 'object' &&
					Boolean(
						(
							(u as { settings: { claude_oauth?: { failover?: unknown } } }).settings.claude_oauth
								?.failover as Record<string, unknown> | undefined
						)?.last_backup_classified_reason,
					),
			)
			expect(backupUpdate?.settings.claude_oauth.failover).toMatchObject({
				active_slot: 'backup',
				last_classified_reason: 'quota_exhausted_5h',
				last_backup_classified_reason: 'quota_exhausted_5h',
			})
			const backupEvent = calls.inserts.find(
				(i): i is { action: string; data: { source_session_id: string } } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { action?: string }).action === 'claude_subscription_backup_exhausted',
			)
			expect(backupEvent?.data).toMatchObject({ source_session_id: session.id })
			const retryInsert = calls.inserts.find(
				(i): i is { config: Record<string, unknown>; actionPrompt: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { actionPrompt?: unknown }).actionPrompt === session.actionPrompt,
			)
			expect(retryInsert).toBeUndefined()
			expect(startSpy).not.toHaveBeenCalled()
		})

		it('does not fail over to backup on a runtime limit when the failover flag is off', async () => {
			// Regression test: MASKIN_CLAUDE_FAILOVER_ENABLED gates session-start
			// failover (resolveClaudeCredentialsWithFailover) but previously did
			// NOT gate this runtime mid-session retry path — an operator using
			// the flag as an incident kill-switch would still see failover
			// triggered here. Flag left unset (default off) for this test.
			const session = buildSession({
				status: 'running',
				config: { llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
			})
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, {
				tempDir: '/tmp/test',
				stdoutTail:
					'{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}\nYou\'ve hit your limit · resets 3:20pm (UTC)',
			})
			const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)

			mockResults.selectQueue = [
				[session], // handleCompletion: load session
				[], // extractSessionUsage fallback
				[], // hasOtherActiveSessions
			]
			mockResults.insertQueue = [
				[], // completion event
				[], // terminal system log
			]

			await (
				manager as unknown as {
					handleCompletion(sessionId: string, containerId: string, exitCode: number): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', 0)

			const failoverUpdate = calls.updates.find(
				(u): u is { settings: { claude_oauth?: { failover?: unknown } } } =>
					typeof u === 'object' &&
					u !== null &&
					typeof (u as { settings?: unknown }).settings === 'object' &&
					Boolean(
						(u as { settings: { claude_oauth?: { failover?: unknown } } }).settings.claude_oauth
							?.failover,
					),
			)
			expect(failoverUpdate).toBeUndefined()
			const failoverEvent = calls.inserts.find(
				(i): i is { action: string } =>
					typeof i === 'object' &&
					i !== null &&
					((i as { action?: string }).action === 'claude_subscription_failover_triggered' ||
						(i as { action?: string }).action === 'claude_subscription_backup_exhausted'),
			)
			expect(failoverEvent).toBeUndefined()
			const retryInsert = calls.inserts.find(
				(i): i is { config: Record<string, unknown>; actionPrompt: string } =>
					typeof i === 'object' &&
					i !== null &&
					(i as { actionPrompt?: unknown }).actionPrompt === session.actionPrompt,
			)
			expect(retryInsert).toBeUndefined()
			expect(startSpy).not.toHaveBeenCalled()
		})

		it('does not call classifier when exitCode is null (OOM kill)', async () => {
			const session = buildSession({ status: 'running' })
			;(
				manager as unknown as {
					activeSessions: Map<string, { tempDir: string; stdoutTail?: string }>
				}
			).activeSessions.set(session.id, { tempDir: '/tmp/test', stdoutTail: '' })

			mockResults.selectQueue = [[session], []]

			await (
				manager as unknown as {
					handleCompletion(
						sessionId: string,
						containerId: string,
						exitCode: number | null,
					): Promise<void>
				}
			).handleCompletion(session.id, 'container-abc', null)

			expect(mockClassifyCreditExhaustion).not.toHaveBeenCalled()
		})
	})

	describe('resolveGithubRepoSlug()', () => {
		// T8 — sourcing chain for the container's GITHUB_REPO env var, consumed by
		// the git credential helper as a `?repo=` hint on token-mint requests
		// (T4's mint-on-write installation-ID recovery path). The DoD requires
		// each source to work in isolation, "no source" to leave the env unset,
		// and malformed sources to be rejected rather than passed downstream.
		const originalEnvRepo = process.env.GITHUB_REPO

		beforeEach(() => {
			// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
			delete process.env.GITHUB_REPO
		})

		afterEach(() => {
			if (originalEnvRepo === undefined) {
				// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
				delete process.env.GITHUB_REPO
			} else {
				process.env.GITHUB_REPO = originalEnvRepo
			}
		})

		it("uses the scoped task's own metadata.repo when set (task-level override)", async () => {
			const session = buildSession({ status: 'running' })
			const task = { id: randomUUID(), type: 'task', metadata: { repo: 'sindre-ai/maskin' } }
			mockResults.selectQueue = [[task]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'task' })
		})

		it("walks breaks_into from a task to its parent bet's metadata.repo when the task has no override", async () => {
			const session = buildSession({ status: 'running' })
			const task = { id: randomUUID(), type: 'task', metadata: null }
			const bet = { id: randomUUID(), metadata: { repo: 'sindre-ai/maskin' } }
			mockResults.selectQueue = [
				[task],
				[{ sourceId: task.id, targetId: bet.id }],
				[{ id: bet.id }],
				[bet],
			]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
		})

		it("uses the scoped bet's own metadata.repo when the session is bet-scoped", async () => {
			const session = buildSession({ status: 'running' })
			const bet = { id: randomUUID(), type: 'bet', metadata: { repo: 'sindre-ai/maskin' } }
			mockResults.selectQueue = [[bet], [bet]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
		})

		it('falls back to process.env.GITHUB_REPO when no scoped object exists (sandbox default)', async () => {
			const session = buildSession({ status: 'running' })
			process.env.GITHUB_REPO = 'sindre-ai/maskin'
			mockResults.selectQueue = [[]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'env' })
		})

		it('returns { slug: null, source: none } when no source is available', async () => {
			const session = buildSession({ status: 'running' })
			mockResults.selectQueue = [[]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: null, source: 'none' })
		})

		it('rejects a malformed bet.metadata.repo with a rejected marker instead of forwarding it', async () => {
			const session = buildSession({ status: 'running' })
			const bet = { id: randomUUID(), type: 'bet', metadata: { repo: 'not-a-slug' } }
			mockResults.selectQueue = [[bet], [bet]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved.slug).toBeNull()
			expect(resolved.source).toBe('none')
			expect(resolved.rejected).toBe(`bet:${bet.id}`)
		})

		it('rejects a malformed task.metadata.repo (missing "/") without walking to the bet', async () => {
			const session = buildSession({ status: 'running' })
			const task = { id: randomUUID(), type: 'task', metadata: { repo: 'missing-slash' } }
			mockResults.selectQueue = [[task]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved.slug).toBeNull()
			expect(resolved.source).toBe('none')
			expect(resolved.rejected).toBe(`task:${task.id}`)
		})

		it('normalizes a full https:// GitHub URL down to owner/name', async () => {
			const session = buildSession({ status: 'running' })
			const bet = {
				id: randomUUID(),
				type: 'bet',
				metadata: { repo: 'https://github.com/sindre-ai/maskin.git' },
			}
			mockResults.selectQueue = [[bet], [bet]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'bet' })
		})

		it('normalizes a git@github.com SSH form and strips the .git suffix', async () => {
			const session = buildSession({ status: 'running' })
			process.env.GITHUB_REPO = 'git@github.com:sindre-ai/maskin.git'
			mockResults.selectQueue = [[]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved).toEqual({ slug: 'sindre-ai/maskin', source: 'env' })
		})

		it('rejects a malformed sandbox default env value without setting the slug', async () => {
			const session = buildSession({ status: 'running' })
			process.env.GITHUB_REPO = '///not-valid///'
			mockResults.selectQueue = [[]]

			const resolved = await manager.resolveGithubRepoSlug(
				session as unknown as Parameters<typeof manager.resolveGithubRepoSlug>[0],
			)

			expect(resolved.slug).toBeNull()
			expect(resolved.source).toBe('none')
			expect(resolved.rejected).toBe('env:GITHUB_REPO')
		})
	})
})

describe('mergeLaunchRouteConfig()', () => {
	it('returns null when the route and oauth slot are unchanged', () => {
		expect(
			mergeLaunchRouteConfig(
				{ llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
				'claude_oauth',
				'primary',
			),
		).toBeNull()
	})

	it('merges in the new route and oauth slot when they change', () => {
		expect(mergeLaunchRouteConfig({}, 'claude_oauth', 'backup')).toMatchObject({
			llm_route: 'claude_oauth',
			llm_oauth_slot: 'backup',
		})
	})

	it('clears a stale claude_oauth_runtime_failover_retry_of marker once the slot resolves back to primary', () => {
		// Regression test: a retry session created during a runtime failover is
		// stamped with llm_oauth_slot: 'backup' + claude_oauth_runtime_failover_retry_of.
		// If primary recovers before that retry session's container actually
		// launches, the slot resolves back to 'primary' here — the stale
		// retry_of marker must not survive, or maybeRetryClaudeOAuthOnBackup's
		// gate (`llm_oauth_slot === 'backup' || typeof retry_of === 'string'`)
		// would misclassify a later, unrelated primary failure as
		// "backup already exhausted".
		const existingConfig = {
			llm_route: 'claude_oauth',
			llm_oauth_slot: 'backup',
			claude_oauth_runtime_failover_retry_of: 'source-session-id',
		}
		const updated = mergeLaunchRouteConfig(existingConfig, 'claude_oauth', 'primary')
		expect(updated).toMatchObject({ llm_route: 'claude_oauth', llm_oauth_slot: 'primary' })
		expect(updated?.claude_oauth_runtime_failover_retry_of).toBeUndefined()
	})

	it('preserves other config fields untouched', () => {
		const existingConfig = {
			llm_route: 'agent_override',
			runtime: 'claude-code',
			env_vars: { FOO: 'bar' },
		}
		const updated = mergeLaunchRouteConfig(existingConfig, 'claude_oauth', 'primary')
		expect(updated).toMatchObject({
			runtime: 'claude-code',
			env_vars: { FOO: 'bar' },
			llm_route: 'claude_oauth',
			llm_oauth_slot: 'primary',
		})
	})

	it('returns null when only the route is unchanged and no oauth slot is taken (non-OAuth route)', () => {
		expect(
			mergeLaunchRouteConfig({ llm_route: 'workspace_api_key' }, 'workspace_api_key', undefined),
		).toBeNull()
	})
})
