// Cross-provider contract test pinning the envKey-independent-provider invariant.
//
// **Reshape history.** This file originally asserted the `autoInject` contract
// PR #1595 restored for linkedin-unipile: for every provider with
// `mcp.autoInject && mcp.server`, session-manager must attach the server to
// `MCP_SERVERS_JSON` even when the provider's own token cannot be resolved.
// P3-K (Magnus 2026-09-14) reversed the auto-inject product decision — no
// provider auto-injects any more; every provider is user-added per-agent (see
// the per-identity Quick Add flow in `apps/web/src/components/agents/mcp-servers.tsx`).
// The follow-up de-trap then dropped linkedin-unipile's `mcp.server` entirely
// (multi-identity provider, no single paste-ready URL — the deprecated
// aggregate URL used to sit there and silently trapped clients pasting it
// verbatim); slack is now the load-bearing case that DOES still advertise a
// `Bearer ${MASKIN_API_KEY}` server spec and drives the coverage row below.
//
// **What survives.** P3-F's runtime code path — `serverConsumesEnvKey` short-
// circuiting the `Failed to load credentials for <provider>` warning for
// providers whose MCP server template does NOT reference their own envKey —
// stays in `session-manager.ts`. It is no longer user-visible via auto-inject,
// but it is still load-bearing for any provider a user hand-adds whose HTTP
// endpoint authenticates on `${MASKIN_API_KEY}` rather than a per-integration
// token. slack is the surviving reference: its credential blob is `xoxb-...`
// but the MCP server template uses `${MASKIN_API_KEY}`, so a session-manager
// path that dropped the short-circuit would still warn even though the server
// works fine. linkedin-unipile remains covered at the runtime level (a user
// hand-adds a per-identity mcpServers entry and the same short-circuit fires),
// but no config-level `mcp.server` means it falls outside the filter this
// contract test iterates.
//
// The invariant is stated as an end-state contract rather than "autoInject
// attaches": for every registered provider whose `mcp.server` is defined but
// does NOT reference its own `mcp.envKey`, driving `SessionManager.startSession`
// with an integration whose credential row has no resolvable per-provider token
// MUST complete without throwing and MUST NOT log the
// `Failed to load credentials for <provider>` warning.

import { vi } from 'vitest'

// ── Mocks: mirror apps/dev/src/__tests__/services/session-manager.test.ts ─────

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

vi.mock('../../../services/container-manager', () => ({
	ContainerManager: vi.fn().mockImplementation(() => mockContainerManager),
}))

vi.mock('../../../lib/claude-oauth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/claude-oauth')>()
	return {
		...actual,
		getValidOAuthToken: vi.fn().mockResolvedValue(null),
	}
})

vi.mock('../../../lib/crypto', () => ({
	decrypt: vi.fn().mockReturnValue('decrypted'),
}))

// NOTE — deliberately NOT mocking `../../../lib/integrations/registry`.
// This is a contract test over the real registered providers; stubbing the
// registry would let a provider be added without new coverage, which is the
// class of bug this file exists to prevent.

const { mockGetValidToken } = vi.hoisted(() => ({
	mockGetValidToken: vi.fn(),
}))

vi.mock('../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({
		getValidToken: mockGetValidToken,
	})),
}))

vi.mock('../../../services/workspace-briefing', () => ({
	buildWorkspaceStartupBlock: vi.fn().mockReturnValue(''),
	renderWorkspaceBriefing: vi.fn().mockResolvedValue('briefing'),
	appendToLedger: vi.fn().mockResolvedValue(undefined),
	readLedgerTail: vi.fn().mockResolvedValue([]),
	workspaceLedgerKey: vi.fn().mockReturnValue('agents/ws/_workspace/learnings.md'),
}))

vi.mock('../../../lib/credit-classifier', () => ({
	classifyCreditExhaustion: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { StorageProvider } from '@maskin/storage'
import { listProviders } from '../../../lib/integrations/registry'
import type { McpServerSpec } from '../../../lib/integrations/types'
import { logger } from '../../../lib/logger'
import { AgentStorageManager } from '../../../services/agent-storage'
import { SessionManager } from '../../../services/session-manager'
import { buildIntegration, buildSession } from '../../factories'
import { createTestContext } from '../../setup'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mirrors the P3-F helper: true when the provider's MCP server template
 * references its own envKey via `${ENV_KEY}` anywhere in url/headers/args/env.
 * Reproduced inline here rather than imported so this contract test doesn't
 * depend on the P3-F helper existing at any given point in history.
 */
function serverConsumesEnvKey(spec: McpServerSpec, envKey: string): boolean {
	const needle = `\${${envKey}}`
	if (spec.type === 'http') {
		if (spec.url.includes(needle)) return true
		return Object.values(spec.headers ?? {}).some(
			(v) => typeof v === 'string' && v.includes(needle),
		)
	}
	if (spec.command.includes(needle)) return true
	if (spec.args.some((a) => a.includes(needle))) return true
	return Object.values(spec.env ?? {}).some((v) => typeof v === 'string' && v.includes(needle))
}

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

const LAUNCHABLE_WS_SETTINGS = { llm_keys: { anthropic: 'sk-ant-test-ws' } }

/**
 * Every currently-registered provider whose MCP server template does NOT
 * reference its own envKey — i.e. authenticates on `${MASKIN_API_KEY}` or
 * similar Maskin-side material rather than a per-integration token. These
 * are the providers P3-F's session-manager short-circuit protects: a
 * token-resolution failure must not stop the session from booting.
 *
 * Slack is the surviving load-bearing case: its MCP server authenticates on
 * `Bearer ${MASKIN_API_KEY}`, not `${SLACK_BOT_TOKEN}`. Session-manager's
 * Slack branch still refuses to inject a non-bot token, so the test drives it
 * with a real xoxb- shape below. linkedin-unipile used to live in this filter
 * too — same short-circuit still fires at runtime for a hand-added per-
 * identity mcpServers entry — but the config no longer advertises a single
 * `mcp.server` spec (the aggregate URL was deprecated + de-trapped), so the
 * filter no longer includes it.
 */
const envKeyIndependentProviders = listProviders()
	.map((p) => p.config)
	.filter(
		(c): c is typeof c & { mcp: { envKey: string; server: McpServerSpec } } =>
			c.mcp?.server != null &&
			typeof c.mcp.envKey === 'string' &&
			!serverConsumesEnvKey(c.mcp.server, c.mcp.envKey),
	)

// ── The contract ──────────────────────────────────────────────────────────────

describe('providers.contract — envKey-independent-provider path', () => {
	let manager: SessionManager
	let mockResults: Record<string, unknown>
	let warnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		const storageProvider = createMockStorageProvider()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		manager = new SessionManager(ctx.db, storageProvider as StorageProvider)
		warnSpy = vi.spyOn(logger, 'warn')
		// buildLaunchSpec's GitHub credential preflight otherwise hits the real
		// api.github.com; stub every outbound fetch this class test could reach.
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ login: 'octocat' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			),
		)
	})

	afterEach(async () => {
		await manager.stop()
	})

	// Sanity: the class fix has to cover slack at minimum (linkedin-unipile
	// used to live here too; the de-trap that dropped its config-level
	// `mcp.server` moved coverage to the runtime path, not this filter). If a
	// provider is added later whose server authenticates on the Maskin API
	// key, it lands in this set automatically and gets a coverage row below.
	// If slack is ever removed from the registry, this test tells you before
	// the runtime code goes untested.
	it('names at least slack as an envKey-independent provider', () => {
		const names = envKeyIndependentProviders.map((c) => c.name).sort()
		expect(names).toContain('slack')
	})

	for (const providerConfig of envKeyIndependentProviders) {
		const { name: providerName, mcp } = providerConfig
		const { server } = mcp

		it(`does not throw and does not log 'Failed to load credentials' when ${providerName} has no per-integration token`, async () => {
			const session = buildSession({
				status: 'pending',
				interactive: false,
				actionPrompt: 'Do the thing',
				containerId: null,
			})
			const workspace = {
				id: session.workspaceId,
				enterpriseGranted: true,
				settings: LAUNCHABLE_WS_SETTINGS,
			}
			const agent = {
				id: session.actorId,
				type: 'agent',
				systemPrompt: 'You are a helpful AI agent.',
				llmProvider: null,
				llmConfig: null,
				apiKey: 'ank_test_agent_key',
				tools: null,
			}
			const integration = buildIntegration({
				workspaceId: session.workspaceId as string,
				provider: providerName,
				externalId: `ext-${providerName}`,
			})

			vi.spyOn(AgentStorageManager.prototype, 'pullWorkspaceSkillsForAgent').mockResolvedValue({
				pulled: 0,
				skipped: 0,
				failures: [],
			})

			// Order matches session-manager's select chain (session load →
			// hasCapacity workspace → running count → agent → workspace(llm keys)
			// → resolveLlmRoute workspace → integrations).
			mockResults.selectQueue = [
				[session],
				[workspace],
				[{ count: 0 }],
				[agent],
				[workspace],
				[workspace],
				[integration],
			]

			// Slack still needs an xoxb- token to survive its own bot-token guard
			// even though the MCP server doesn't consume it. Any future envKey-
			// independent provider added to this filter mirrors the production
			// shape used by linkedin-unipile at runtime: credential blob without
			// an accessToken → getValidToken throws.
			if (providerName === 'slack') {
				mockGetValidToken.mockResolvedValueOnce('xoxb-real-bot-token')
			} else {
				mockGetValidToken.mockRejectedValueOnce(
					new Error(`Integration ${integration.id} has no access token`),
				)
			}

			// The strongest contract: the session boots. Nothing about a missing
			// per-provider token when the server authenticates on Maskin's key
			// should stop that.
			await expect(manager.startSession(session.id)).resolves.not.toThrow()

			// And no `Failed to load credentials` warning: token-manager's throw
			// is expected for these providers, not an operator-facing incident.
			const credentialLoadWarn = warnSpy.mock.calls.find(
				([msg]) =>
					typeof msg === 'string' && msg === `Failed to load credentials for ${providerName}`,
			)
			expect(
				credentialLoadWarn,
				`logger.warn('Failed to load credentials for ${providerName}') must not fire — the envKey-independent-provider short-circuit lives specifically to keep this quiet when the MCP server authenticates on the Maskin API key rather than a per-provider token`,
			).toBeUndefined()

			// Server spec still exists on the config so the guard has something
			// to guard. Not asserting the spec is auto-injected any more (that
			// invariant went away with autoInject in P3-K) — just that it is
			// discoverable through the config.
			expect(server).toBeDefined()
		})
	}
})
