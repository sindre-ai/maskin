import { integrations, sessions as sessionsTable } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { encrypt } from '../../lib/crypto'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

async function insertResendIntegration(
	workspaceId: string,
	createdBy: string,
	accessToken: string,
	webhookSecret: string,
) {
	const rows = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'resend',
			status: 'active',
			externalId: `resend-token-${workspaceId.slice(0, 8)}`,
			credentials: encrypt(JSON.stringify({ accessToken, webhookSecret })),
			config: {},
			createdBy,
		})
		.returning()
	return rows[0]
}

// Slice 1 send-path proof — this is the "a send from the integration arrives
// from the customer's own domain" Won criteria expressed as a test. The full
// send exercise runs against Resend's real API, but the guardrail is that
// session-manager stamps THIS workspace's key into `envVars.RESEND_API_KEY`
// and drops the MCP server spec into `MCP_SERVERS_JSON`. Any regression that
// blends credentials across workspaces or drops the server would show up
// here first, against real Postgres so the workspace-scoped SELECT is exercised
// exactly the way production runs it.
describe('SessionManager.buildLaunchSpec — Resend per-workspace credential injection (Integration)', () => {
	let actorId: string

	beforeEach(() => {
		actorId = getTestActorId()
	})

	async function provisionWorkspaceAndSession(apiKey: string, webhookSecret: string) {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: true,
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		const agent = await insertActor(db, {
			type: 'agent',
			systemPrompt: 'You are a helpful AI agent.',
		})
		const pending = await insertSession(db, ws.id, agent.id, actorId, {
			status: 'pending',
			containerId: null,
		})
		await insertResendIntegration(ws.id, actorId, apiKey, webhookSecret)
		const [reloaded] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, pending.id))
		return { workspace: ws, session: reloaded }
	}

	it("injects workspace A's RESEND_API_KEY when booting a session in workspace A", async () => {
		const { session } = await provisionWorkspaceAndSession('re_workspace_A_key', 'whsec_A')
		const manager = new SessionManager(db, stubStorage())
		try {
			const spec = await manager.buildLaunchSpec(session)
			expect(spec.env.RESEND_API_KEY).toBe('re_workspace_A_key')

			expect(spec.env.MCP_SERVERS_JSON).toBeDefined()
			const parsed = JSON.parse(spec.env.MCP_SERVERS_JSON) as {
				mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
			}
			expect(parsed.mcpServers['integration-resend']).toEqual({
				type: 'http',
				url: 'https://mcp.resend.com/mcp',
				headers: { Authorization: 'Bearer ${RESEND_API_KEY}' },
			})
		} finally {
			await manager.stop()
		}
	})

	it("injects workspace B's RESEND_API_KEY when booting a session in workspace B — no cross-workspace leak", async () => {
		// Provision A first to prove the tenants are isolated even when both exist
		// side-by-side. If session-manager ever regressed to a "first-integration-
		// wins" style lookup, B's session would come up with A's key and this test
		// would catch it before the send path ever ran.
		const a = await provisionWorkspaceAndSession('re_workspace_A_key', 'whsec_A')
		const b = await provisionWorkspaceAndSession('re_workspace_B_key', 'whsec_B')
		expect(a.workspace.id).not.toBe(b.workspace.id)

		const manager = new SessionManager(db, stubStorage())
		try {
			const specB = await manager.buildLaunchSpec(b.session)
			expect(specB.env.RESEND_API_KEY).toBe('re_workspace_B_key')

			const parsedB = JSON.parse(specB.env.MCP_SERVERS_JSON) as {
				mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
			}
			expect(parsedB.mcpServers['integration-resend']).toEqual({
				type: 'http',
				url: 'https://mcp.resend.com/mcp',
				headers: { Authorization: 'Bearer ${RESEND_API_KEY}' },
			})

			// And re-verify A now, in the same suite/DB — A's key must still be A's.
			// This is the direct anti-leak check the parent bet asked for.
			const specA = await manager.buildLaunchSpec(a.session)
			expect(specA.env.RESEND_API_KEY).toBe('re_workspace_A_key')
		} finally {
			await manager.stop()
		}
	})

	it('does not inject the MCP server or the env var when the workspace has no active resend row', async () => {
		// Negative case: session-manager's active-integration lookup is workspace-
		// scoped AND `status='active'`-scoped. If a bug ever widened either scope,
		// a workspace with no Resend row (or with a `pending`/`awaiting_secret`
		// row) would silently inherit another workspace's server template. This
		// row does not fire, so the env var must be absent.
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: true,
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		const agent = await insertActor(db, {
			type: 'agent',
			systemPrompt: 'You are a helpful AI agent.',
		})
		const pending = await insertSession(db, ws.id, agent.id, actorId, {
			status: 'pending',
			containerId: null,
		})
		const [reloaded] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, pending.id))

		const manager = new SessionManager(db, stubStorage())
		try {
			const spec = await manager.buildLaunchSpec(reloaded)
			expect(spec.env.RESEND_API_KEY).toBeUndefined()
			const mcpJson = spec.env.MCP_SERVERS_JSON
			if (mcpJson) {
				const parsed = JSON.parse(mcpJson) as { mcpServers: Record<string, unknown> }
				expect(parsed.mcpServers['integration-resend']).toBeUndefined()
			}
		} finally {
			await manager.stop()
		}
	})
})
