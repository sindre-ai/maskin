import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../app-factory'
import { DEFAULT_RATE_LIMIT_CONFIG } from '../../lib/mcp-rate-limit'
import { __resetMcpRateLimit, initMcpRateLimit } from '../../routes/mcp'
import type { AgentStorageManager } from '../../services/agent-storage'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Two real actor keys through the real HTTP /mcp route, the real MCP server and
// the real auth lookup: the limiter keys on the actor the key resolves to, so
// one agent running out of tokens must not touch another, and the injected clock
// must refill the bucket.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

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

describe('POST /mcp rate limit (integration)', () => {
	let manager: SessionManager
	let server: ReturnType<typeof serve>
	let baseUrl: string
	let previousPort: string | undefined
	let clock = 0

	beforeAll(async () => {
		manager = new SessionManager(db, stubStorage())
		const app = createApp(
			{
				db,
				notifyBridge: {} as unknown as PgNotifyBridge,
				sessionManager: manager,
				agentStorage: {} as unknown as AgentStorageManager,
				storageProvider: stubStorage(),
			},
			{ includeExtensions: false },
		)
		await new Promise<void>((resolve) => {
			server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve())
		})
		const port = (server.address() as AddressInfo).port
		baseUrl = `http://127.0.0.1:${port}`
		// routes/mcp.ts points the in-process MCP server back at this process.
		previousPort = process.env.PORT
		process.env.PORT = String(port)
	})

	afterAll(async () => {
		__resetMcpRateLimit()
		if (previousPort === undefined) process.env.PORT = undefined
		else process.env.PORT = previousPort
		await new Promise((resolve) => server.close(resolve))
		await manager.stop()
	})

	let workspaceId: string
	let keyA = ''
	let keyB = ''

	beforeEach(async () => {
		const tag = Math.random().toString(36).slice(2)
		keyA = `ank_rl_a_${tag}`
		keyB = `ank_rl_b_${tag}`
		workspaceId = (await insertWorkspace(db, getTestActorId(), { enterpriseGranted: true })).id
		for (const [name, apiKey] of [
			['RateLimitA', keyA],
			['RateLimitB', keyB],
		] as const) {
			const actor = await insertActor(db, {
				type: 'agent',
				name,
				email: `${name}-${tag}@integration.test`,
				apiKey,
			})
			await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
		}
		clock = 1_000_000
		initMcpRateLimit({
			config: { ...DEFAULT_RATE_LIMIT_CONFIG, mode: 'enforce', agentPerMin: 3 },
			now: () => clock,
		})
	})

	// The MCP and REST handlers finish some writes after the response is sent; let
	// them land before global-setup truncates the tables for the next test.
	afterEach(async () => {
		__resetMcpRateLimit()
		await new Promise((resolve) => setTimeout(resolve, 300))
	})

	function call(key: string, id: number) {
		return fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${key}`,
				'X-Workspace-Id': workspaceId,
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: 'tools/call',
				params: { name: 'list_workspaces', arguments: {} },
			}),
		})
	}

	it('rejects the 4th call of key A, leaves key B alone and lets A back in after a refill', async () => {
		for (let i = 1; i <= 3; i++) expect((await call(keyA, i)).status).toBe(200)

		const rejected = await call(keyA, 4)
		expect(rejected.status).toBe(429)
		// 3 per minute: one token every 20 seconds.
		expect(rejected.headers.get('Retry-After')).toBe('20')
		expect(await rejected.json()).toEqual({
			jsonrpc: '2.0',
			id: 4,
			error: {
				code: -32029,
				message: 'Rate limit exceeded for this API key. Retry after 20 seconds.',
				data: { retry_after_seconds: 20, limit_per_minute: 3, class: 'agent' },
			},
		})

		// A different agent has its own bucket.
		expect((await call(keyB, 1)).status).toBe(200)

		clock += 20_000
		expect((await call(keyA, 5)).status).toBe(200)
		expect((await call(keyA, 6)).status).toBe(429)
	})
})
