// Cross-provider contract test that pins two class-level invariants for MCP
// integrations. Both invariants are class fixes for the LinkedIn 2026-09-11
// failure — a config-shape-only test on a single provider would have missed it.
//
// Invariant 1 — session-manager auto-inject path.
// For every provider whose config declares `mcp.autoInject && mcp.server`,
// building a session container for a workspace with an active integration for
// that provider MUST attach the provider's `mcp.server` to `MCP_SERVERS_JSON`
// under the key `integration-<provider>`, AND MUST NOT log the
// `Failed to load credentials for <provider>` warning. This is the
// linkedin-unipile shape: the credential blob is `{ account_id }` with no
// `accessToken`, so `tokenManager.getValidToken` throws. Before **P3-F** that
// throw was swallowed as a credential-load warning and the autoInject branch
// was never reached — sessions in workspaces with LinkedIn connected shipped
// with zero LinkedIn tools. The class-fix contract says: providers whose MCP
// server template authenticates on `${MASKIN_API_KEY}` (not their own envKey)
// do not need a per-provider token to auto-inject.
//
// Invariant 2 — discovery contract.
// For every provider whose config declares `mcp`, `GET /api/integrations/providers`
// MUST surface `mcp.autoInject`, and MUST surface `mcp.server` whenever
// `autoInject` is true. This is the discovery contract PR #1595 restored for
// linkedin-unipile only — pinned here across every provider so a client driving
// Maskin over MCP can always discover what auto-attaches for a workspace's
// active integrations.

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
import integrationsRoutes from '../../../routes/integrations'
import { AgentStorageManager } from '../../../services/agent-storage'
import { SessionManager } from '../../../services/session-manager'
import { buildIntegration, buildSession } from '../../factories'
import { jsonGet } from '../../helpers'
import { createTestApp, createTestContext } from '../../setup'

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
 * Every provider currently registered whose MCP config asks session-manager to
 * auto-attach a server. GitHub is auto-injected too but takes the dedicated
 * per-installation branch in session-manager and does not declare a top-level
 * `mcp.server` (it fans out per owner). The filter naturally excludes it.
 */
const autoInjectProviders = listProviders()
	.map((p) => p.config)
	.filter(
		(c): c is typeof c & { mcp: { autoInject: true; envKey: string; server: McpServerSpec } } =>
			Boolean(c.mcp?.autoInject) && c.mcp?.server != null,
	)

// ── Invariant 1 — session-manager auto-inject path ────────────────────────────

describe('providers.contract — session-manager auto-inject path', () => {
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

	// The test list is generated from the real registry so a new autoInject
	// provider added without a `server` (or without any coverage of its
	// credential shape) fails this iteration explicitly.
	it('lists at least the providers that need this contract', () => {
		const names = autoInjectProviders.map((c) => c.name).sort()
		// Sanity: the class fix has to cover linkedin-unipile at minimum, plus
		// the other Maskin-key-authenticated auto-inject providers currently in
		// the registry. Update this list only when adding a new autoInject
		// provider with a server spec.
		expect(names).toEqual(['linkedin-unipile', 'posthog', 'slack'])
	})

	for (const providerConfig of autoInjectProviders) {
		const { name: providerName, mcp } = providerConfig
		const { server, envKey } = mcp

		it(`attaches integration-${providerName} to MCP_SERVERS_JSON with the declared server spec, no credential-load warning`, async () => {
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

			// Realistic per-provider credential shape:
			//   * server references its own envKey (e.g. PostHog Bearer
			//     ${POSTHOG_TOKEN}) — must have a resolvable token.
			//   * server references only ${MASKIN_API_KEY} (Slack, linkedin-unipile)
			//     — token-manager may still throw for providers that store no
			//     accessToken (linkedin-unipile: credential blob `{ account_id }`);
			//     the class-fix says auto-inject fires anyway.
			if (serverConsumesEnvKey(server, envKey)) {
				mockGetValidToken.mockResolvedValueOnce(`test-token-${providerName}`)
			} else if (providerName === 'slack') {
				// Slack's server auth doesn't consume SLACK_BOT_TOKEN, but session-
				// manager's Slack branch still refuses to inject if the stored
				// token isn't a bot token. Feed the real production shape.
				mockGetValidToken.mockResolvedValueOnce('xoxb-real-bot-token')
			} else {
				// linkedin-unipile shape: no accessToken in credentials → token-
				// manager throws exactly this on Standard OAuth2 flow (see
				// apps/dev/src/lib/integrations/oauth/token-manager.ts).
				mockGetValidToken.mockRejectedValueOnce(
					new Error(`Integration ${integration.id} has no access token`),
				)
			}

			await manager.startSession(session.id)

			const createArgs = mockContainerManager.create.mock.calls[0]?.[0] as {
				env: Record<string, string>
			}
			expect(
				createArgs?.env.MCP_SERVERS_JSON,
				`session should receive MCP_SERVERS_JSON when a workspace has an active ${providerName} integration`,
			).toBeDefined()
			const parsed = JSON.parse(createArgs.env.MCP_SERVERS_JSON) as {
				mcpServers: Record<string, unknown>
			}
			expect(
				parsed.mcpServers[`integration-${providerName}`],
				`integration-${providerName} should be auto-injected verbatim from the provider's mcp.server spec`,
			).toEqual(server)

			const credentialLoadWarn = warnSpy.mock.calls.find(
				([msg]) =>
					typeof msg === 'string' && msg === `Failed to load credentials for ${providerName}`,
			)
			expect(
				credentialLoadWarn,
				`logger.warn('Failed to load credentials for ${providerName}') must not fire — the whole point of the class fix is that a missing per-provider token does NOT block auto-injection when the server authenticates on the Maskin API key`,
			).toBeUndefined()
		})
	}
})

// ── Invariant 2 — discovery contract ──────────────────────────────────────────

describe('providers.contract — GET /api/integrations/providers discovery', () => {
	// github is the sole exemption from the `server` half of the contract: its
	// entries are fanned out per installation with literal tokens, so there is
	// no single spec to advertise. The `autoInject` half still holds.
	const GITHUB_SERVER_EXEMPTION = new Set<string>(['github'])

	it('serves mcp.autoInject for every provider that declares mcp', async () => {
		const { app } = createTestApp(integrationsRoutes, '/api/integrations')
		const res = await app.request(jsonGet('/api/integrations/providers'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{
			name: string
			mcp?: { autoInject: boolean; server?: unknown }
		}>

		const declared = listProviders()
			.map((p) => p.config)
			.filter((c) => c.mcp != null)

		expect(declared.length).toBeGreaterThan(0)

		for (const cfg of declared) {
			const entry = body.find((p) => p.name === cfg.name)
			expect(entry, `${cfg.name} must appear in GET /api/integrations/providers`).toBeDefined()
			expect(
				entry?.mcp?.autoInject,
				`${cfg.name}: discovery must surface mcp.autoInject (found ${JSON.stringify(entry?.mcp)})`,
			).toBe(cfg.mcp?.autoInject ?? false)
		}
	})

	it('serves mcp.server for every provider where autoInject=true (except github, which fans out per installation)', async () => {
		const { app } = createTestApp(integrationsRoutes, '/api/integrations')
		const res = await app.request(jsonGet('/api/integrations/providers'))
		const body = (await res.json()) as Array<{
			name: string
			mcp?: { autoInject: boolean; server?: unknown }
		}>

		const declared = listProviders()
			.map((p) => p.config)
			.filter((c) => c.mcp?.autoInject === true)

		for (const cfg of declared) {
			if (GITHUB_SERVER_EXEMPTION.has(cfg.name)) continue
			const entry = body.find((p) => p.name === cfg.name)
			expect(
				entry?.mcp?.server,
				`${cfg.name}: discovery must surface mcp.server whenever autoInject is true — otherwise a non-browser client sees "connected, zero tools" with nothing explaining the gap`,
			).toBeDefined()
			expect(
				entry?.mcp?.server,
				`${cfg.name}: discovery server spec must be the provider's declared mcp.server verbatim`,
			).toEqual(cfg.mcp?.server)
		}
	})
})
