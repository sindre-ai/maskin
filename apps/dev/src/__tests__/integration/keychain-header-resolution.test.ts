import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The header smoke assertion of the Keychain bet: a header written as
// Bearer ${KEYCHAIN_BYO_APIKEY_X} in an actor's mcpServers config reaches the MCP
// server with the token for a granted actor and without it for an ungranted one.
// The env comes from buildLaunchSpec against a real database. The expansion is the
// real setup_mcps function out of docker/agent-base/agent-run.sh, run in bash with
// that env, so the container's own envsubst step is what resolves the name. The MCP
// server is a local HTTP listener that records the Authorization header it receives.
//
// Not run: the Claude Code CLI itself. The request below is made with the headers the
// CLI would read from the generated mcp-config.json.

const AGENT_RUN = resolve(__dirname, '../../../../../docker/agent-base/agent-run.sh')
const TOKEN = `fake-coolify-${'0123456789'.repeat(3)}`
const HEADER_TEMPLATE = 'Bearer ${KEYCHAIN_BYO_APIKEY_COOLIFY}'

let dir: string
let kms: LocalFileKmsProvider
let mcpServer: Server
let mcpUrl: string
const received: Array<string | undefined> = []

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-header-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
	mcpServer = createServer((req, res) => {
		received.push(req.headers.authorization)
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end('{"ok":true}')
	})
	await new Promise<void>((r) => mcpServer.listen(0, '127.0.0.1', r))
	mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`
})
afterAll(async () => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
	await new Promise<void>((r) => mcpServer.close(() => r()))
})

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

/** Runs the container's setup_mcps with the given env and returns the headers it wrote. */
function expandHeaders(env: Record<string, string>): Record<string, string> {
	const tmp = mkdtempSync(join(tmpdir(), 'keychain-mcp-'))
	try {
		const script = [
			'set -e',
			// The cdp retry proxy is browser-only and returns early without BROWSER_CDP_URL.
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
				// Every KEYCHAIN_ name the session was given, exported the way the container has it.
				...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('KEYCHAIN_'))),
			},
			encoding: 'utf8',
		})
		const json = out.slice(out.indexOf('{'))
		const config = JSON.parse(json) as {
			mcpServers: Record<string, { headers: Record<string, string> }>
		}
		return config.mcpServers.coolify?.headers ?? {}
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

async function callMcp(headers: Record<string, string>) {
	const before = received.length
	const res = await fetch(mcpUrl, { method: 'POST', headers, body: '{}' })
	expect(res.status).toBe(200)
	expect(received.length).toBe(before + 1)
	return received[received.length - 1]
}

describe('Keychain header resolution (Integration)', () => {
	it('resolves Bearer ${KEYCHAIN_BYO_APIKEY_X} to the token for a granted actor and to nothing for an ungranted one', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human, {
			enterpriseGranted: true,
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		const tools = {
			mcpServers: {
				coolify: { type: 'http', url: mcpUrl, headers: { Authorization: HEADER_TEMPLATE } },
			},
		}
		const granted = await insertActor(db, { type: 'agent', tools })
		const ungranted = await insertActor(db, { type: 'agent', tools })
		await db.insert(workspaceMembers).values([
			{ workspaceId: ws.id, actorId: granted.id, role: 'member' },
			{ workspaceId: ws.id, actorId: ungranted.id, role: 'member' },
		])
		const { integrationId } = await createByoApiKey(db, kms, {
			workspaceId: ws.id,
			actorId: human,
			displayName: 'Coolify',
			rawSecret: TOKEN,
		})
		await db
			.update(integrations)
			.set({ scopeGrants: [{ kind: 'actor', actorId: granted.id }] })
			.where(eq(integrations.id, integrationId))

		const manager = new SessionManager(db, stubStorage())
		const specFor = async (actorId: string) => {
			const s = await insertSession(db, ws.id, actorId, human, {
				status: 'pending',
				containerId: null,
			})
			const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
			return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
		}
		let grantedEnv: Record<string, string>
		let ungrantedEnv: Record<string, string>
		try {
			grantedEnv = await specFor(granted.id)
			ungrantedEnv = await specFor(ungranted.id)
		} finally {
			await manager.stop()
		}

		// The actor config carries the reference, never a value.
		expect(grantedEnv.AGENT_MCP_JSON).toContain(HEADER_TEMPLATE)
		expect(grantedEnv.AGENT_MCP_JSON).not.toContain(TOKEN)

		const grantedHeaders = expandHeaders(grantedEnv)
		expect(grantedHeaders.Authorization).toBe(`Bearer ${TOKEN}`)
		expect(await callMcp(grantedHeaders)).toBe(`Bearer ${TOKEN}`)

		// A missing name expands to empty: the silent 401 the spec warns about, and exactly
		// what an ungranted actor must get.
		const ungrantedHeaders = expandHeaders(ungrantedEnv)
		expect(ungrantedHeaders.Authorization).toBe('Bearer ')
		const seen = await callMcp(ungrantedHeaders)
		expect(seen ?? '').not.toContain(TOKEN)
	})
})
