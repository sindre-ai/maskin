import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { sessions, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../app-factory'
import type { AgentStorageManager } from '../../services/agent-storage'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The merge-gate smoke for Part 1: a create_session call that goes through the
// real HTTP /mcp route, the real MCP server, the real REST route and the real
// auth middleware ends with sessions.spawned_by_session_id equal to the
// caller's session id. Before the transport fix the header never left apps/dev.

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

describe('create_session through HTTP /mcp (integration)', () => {
	let manager: SessionManager
	let server: ReturnType<typeof serve>
	let baseUrl: string
	let previousPort: string | undefined

	beforeAll(async () => {
		manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
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
		if (previousPort === undefined) process.env.PORT = undefined
		else process.env.PORT = previousPort
		await new Promise((resolve) => server.close(resolve))
		await manager.stop()
	})

	let workspaceId: string
	let caller: { id: string }
	let stranger: { id: string }
	let target: { id: string }
	let callerKey = ''

	beforeEach(async () => {
		const human = getTestActorId()
		const tag = Math.random().toString(36).slice(2)
		callerKey = `ank_e2e_caller_${tag}`
		workspaceId = (await insertWorkspace(db, human, { enterpriseGranted: true })).id
		const mk = async (name: string, apiKey: string) => {
			const actor = await insertActor(db, {
				type: 'agent',
				name,
				email: `${name}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey,
			})
			await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
			return actor
		}
		;[caller, stranger, target] = await Promise.all([
			mk('E2eCaller', callerKey),
			mk('E2eStranger', `ank_e2e_stranger_${tag}`),
			mk('E2eTarget', `ank_e2e_target_${tag}`),
		])
	})

	// The MCP and REST handlers finish some writes after the response is sent; let
	// them land before global-setup truncates the tables for the next test.
	afterEach(async () => {
		await new Promise((resolve) => setTimeout(resolve, 500))
	})

	async function createSessionOverMcp(sessionHeader: string | null) {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${callerKey}`,
				'X-Workspace-Id': workspaceId,
				...(sessionHeader ? { 'X-Maskin-Session-Id': sessionHeader } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'create_session',
					arguments: {
						actor_id: target.id,
						action_prompt: 'please help',
						auto_start: false,
						workspace_id: workspaceId,
					},
				},
			}),
		})
		expect(res.status).toBe(200)
		const rpc = (await res.json()) as {
			result?: { isError?: boolean; content?: Array<{ text?: string }> }
			error?: unknown
		}
		expect(rpc.error).toBeUndefined()
		expect(rpc.result?.isError).not.toBe(true)
		const created = JSON.parse(rpc.result?.content?.[0]?.text ?? '{}') as { id: string }
		const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
		return row
	}

	it('records the calling session as the helper’s sender', async () => {
		const mine = await insertSession(db, workspaceId, caller.id, caller.id, { status: 'running' })
		const row = await createSessionOverMcp(mine.id)
		expect(row.spawnedBySessionId).toBe(mine.id)
		expect((row.config as { hop_depth?: number }).hop_depth).toBe(1)
	})

	it('ignores another actor’s session id in the header (forged)', async () => {
		const theirs = await insertSession(db, workspaceId, stranger.id, stranger.id, {
			status: 'running',
		})
		const row = await createSessionOverMcp(theirs.id)
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('records nothing when the caller sends no session header', async () => {
		const row = await createSessionOverMcp(null)
		expect(row.spawnedBySessionId).toBeNull()
	})
})
