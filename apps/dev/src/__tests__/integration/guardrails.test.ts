import {
	agentGrants,
	integrations,
	sendPermissions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import {
	type Guardrails,
	SEND_PERMISSION_KINDS,
	STARTING_SEND_MODES,
	type SendPermissionKind,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { encrypt } from '../../lib/crypto'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: guardrailsRoutes } = await import('../../routes/guardrails')

const app = () =>
	createIntegrationApp({ path: '/api/guardrails', module: guardrailsRoutes as never })

async function read(workspaceId: string) {
	const res = await app().request(jsonGet('/api/guardrails', { 'X-Workspace-Id': workspaceId }))
	expect(res.status).toBe(200)
	return (await res.json()) as Guardrails
}

async function addAgent(workspaceId: string, name: string) {
	const agent = await insertActor(db, { type: 'agent', name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

async function addIntegration(workspaceId: string, provider: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: 'fake-token-0123456789' })),
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('failed to seed integration')
	return row
}

describe('GET /api/guardrails — real Postgres', () => {
	it('reads the starting send modes, no daily target, and an agent with no access', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await addAgent(ws.id, 'Quiet agent')

		const body = await read(ws.id)
		expect(body.workspace.daily_budget).toBeNull()
		expect(body.workspace.daily_budget_enforced).toBe(false)
		expect(body.workspace.send_defaults.map((s) => s.kind)).toEqual([...SEND_PERMISSION_KINDS])
		for (const s of body.workspace.send_defaults) {
			expect(s).toMatchObject({
				mode: STARTING_SEND_MODES[s.kind as SendPermissionKind],
				source: 'starting',
			})
		}
		expect(body.agents).toHaveLength(1)
		expect(body.agents[0]).toMatchObject({
			name: 'Quiet agent',
			access: { read_write: 0, read: 0, none: 0, credentials: 0 },
		})
	})

	it('shows the workspace default, an agent override and where each came from', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await addAgent(ws.id, 'Sender')
		const other = await addAgent(ws.id, 'Other')
		await db.insert(sendPermissions).values([
			{
				workspaceId: ws.id,
				agentId: null,
				kind: 'email',
				mode: 'deny',
				updatedBy: getTestActorId(),
			},
			{
				workspaceId: ws.id,
				agentId: agent.id,
				kind: 'email',
				mode: 'always_allow',
				updatedBy: getTestActorId(),
			},
		])

		const body = await read(ws.id)
		expect(body.workspace.send_defaults.find((s) => s.kind === 'email')).toEqual({
			kind: 'email',
			mode: 'deny',
			source: 'workspace',
		})
		const sender = body.agents.find((a) => a.agent_id === agent.id)
		expect(sender?.send.find((s) => s.kind === 'email')).toEqual({
			kind: 'email',
			mode: 'always_allow',
			source: 'agent',
		})
		const unchanged = body.agents.find((a) => a.agent_id === other.id)
		expect(unchanged?.send.find((s) => s.kind === 'email')).toEqual({
			kind: 'email',
			mode: 'deny',
			source: 'workspace',
		})
	})

	it('counts integrations per access level and says the daily target is not enforced', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await addAgent(ws.id, 'Worker')
		await db
			.update(workspaces)
			.set({
				settings: {
					daily_budget: {
						unit: 'tokens',
						amount: 5_000_000,
						stop_share: 90,
						timezone: 'Europe/Copenhagen',
					},
				},
			})
			.where(eq(workspaces.id, ws.id))
		const writes = await addIntegration(ws.id, 'linear')
		const reads = await addIntegration(ws.id, 'notion')
		const blocked = await addIntegration(ws.id, 'attio')
		await db.insert(agentGrants).values([
			{ workspaceId: ws.id, integrationId: writes.id, actorId: agent.id, access: 'read_write' },
			{ workspaceId: ws.id, integrationId: reads.id, actorId: agent.id, access: 'read' },
			{ workspaceId: ws.id, integrationId: blocked.id, actorId: agent.id, access: 'none' },
		])

		const body = await read(ws.id)
		expect(body.workspace.daily_budget).toEqual({
			unit: 'tokens',
			amount: 5_000_000,
			stop_share: 90,
			timezone: 'Europe/Copenhagen',
		})
		expect(body.workspace.daily_budget_enforced).toBe(false)
		expect(body.agents[0]?.access).toEqual({ read_write: 1, read: 1, none: 1, credentials: 0 })
	})

	it('lists only the agents of the workspace asked about', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const otherWs = await insertWorkspace(db, getTestActorId())
		await addAgent(ws.id, 'Here')
		await addAgent(otherWs.id, 'Elsewhere')

		const body = await read(ws.id)
		expect(body.agents.map((a) => a.name)).toEqual(['Here'])
	})
})
