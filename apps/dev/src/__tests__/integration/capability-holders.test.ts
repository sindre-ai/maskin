import { agentGrants, integrations, workspaceMembers } from '@maskin/db/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	countUnscannedServers,
	holdersForSources,
	holdersOf,
	recipientCanAct,
	visibleHolders,
} from '../../lib/capabilities/holders'
import { buildIntegration, insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

describe('capabilities holders (integration)', () => {
	let workspaceId: string
	let ownerId: string
	let adminId: string
	let memberId: string
	let agentWithAdminRoleId: string
	let salesRepId: string
	let researcherId: string
	let ctx: { db: typeof db; workspaceId: string }

	async function join(actorId: string, role: string, ws = workspaceId) {
		await db.insert(workspaceMembers).values({ workspaceId: ws, actorId, role })
	}

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
		ctx = { db, workspaceId }

		adminId = (await insertActor(db, { type: 'human', name: 'Admin Human' })).id
		memberId = (await insertActor(db, { type: 'human', name: 'Member Human' })).id
		agentWithAdminRoleId = (await insertActor(db, { type: 'agent', name: 'Admin Agent' })).id
		salesRepId = (await insertActor(db, { type: 'agent', name: 'Sales Rep' })).id
		researcherId = (await insertActor(db, { type: 'agent', name: 'Researcher' })).id
		await join(adminId, 'admin')
		await join(memberId, 'member')
		await join(agentWithAdminRoleId, 'admin')
		await join(salesRepId, 'member')
		await join(researcherId, 'member')
	})

	async function addIntegration(
		provider: string,
		opts: {
			config?: Record<string, unknown>
			defaultAgentAccess?: 'read' | 'read_write' | 'none'
			workspace?: string
		} = {},
	) {
		const [row] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId: opts.workspace ?? workspaceId,
					provider,
					status: 'active',
					createdBy: ownerId,
					config: opts.config ?? {},
					...(opts.defaultAgentAccess ? { defaultAgentAccess: opts.defaultAgentAccess } : {}),
				}) as never,
			)
			.returning()
		return { key: `integration:${provider}:${row.id}`, provider, integrationId: row.id }
	}

	async function grant(
		integrationId: string,
		actorId: string,
		access: 'none' | 'read' | 'read_write',
	) {
		await db.insert(agentGrants).values({ workspaceId, integrationId, actorId, access })
	}

	describe('recipientCanAct', () => {
		it('is true for a human owner and a human admin', async () => {
			expect(await recipientCanAct(ctx, ownerId)).toBe(true)
			expect(await recipientCanAct(ctx, adminId)).toBe(true)
		})

		it('is false for a member', async () => {
			expect(await recipientCanAct(ctx, memberId)).toBe(false)
		})

		it('is false for an agent, even one with an admin membership', async () => {
			expect(await recipientCanAct(ctx, agentWithAdminRoleId)).toBe(false)
		})

		it('is false for someone who is not in the workspace', async () => {
			const stranger = await insertActor(db, { type: 'human', name: 'Stranger' })
			expect(await recipientCanAct(ctx, stranger.id)).toBe(false)
		})
	})

	describe('holdersOf', () => {
		it('built-in: every agent in the workspace, no humans', async () => {
			const holders = await holdersOf(ctx, { key: 'maskin:builtin' })
			expect(holders).toEqual([agentWithAdminRoleId, salesRepId, researcherId].sort())
		})

		it('ignores toolName in v1', async () => {
			const all = await holdersOf(ctx, { key: 'maskin:builtin' })
			expect(await holdersOf(ctx, { key: 'maskin:builtin' }, 'create_objects')).toEqual(all)
		})

		it('an agent with a grant is a holder, one without is not (default off)', async () => {
			const slack = await addIntegration('slack', { defaultAgentAccess: 'none' })
			await grant(slack.integrationId, salesRepId, 'read')
			expect(await holdersOf(ctx, slack)).toEqual([salesRepId])
		})

		it('with the workspace default on, every agent without a grant is a holder', async () => {
			const slack = await addIntegration('slack', { defaultAgentAccess: 'read' })
			expect(await holdersOf(ctx, slack)).toEqual(
				[agentWithAdminRoleId, salesRepId, researcherId].sort(),
			)
		})

		it('with the default switched off and no grant, nobody is a holder', async () => {
			const slack = await addIntegration('slack', { defaultAgentAccess: 'none' })
			expect(await holdersOf(ctx, slack)).toEqual([])
		})

		it("an agent's own none grant beats the default", async () => {
			const slack = await addIntegration('slack', { defaultAgentAccess: 'read' })
			await grant(slack.integrationId, researcherId, 'none')
			expect(await holdersOf(ctx, slack)).toEqual([agentWithAdminRoleId, salesRepId].sort())
		})

		it('an integration switched off for agent sessions has no holders, grants or not', async () => {
			const hidden = await addIntegration('slack', {
				config: { expose_to_agent_sessions: false },
				defaultAgentAccess: 'read',
			})
			await grant(hidden.integrationId, salesRepId, 'read_write')
			expect(await holdersOf(ctx, hidden)).toEqual([])
		})

		it('a hand-added server living on the workspace counts for the agents granted it', async () => {
			const custom = await addIntegration('custom-mcp', { defaultAgentAccess: 'none' })
			await grant(custom.integrationId, researcherId, 'read_write')
			expect(await holdersOf(ctx, custom)).toEqual([researcherId])
		})

		it('a provider this build has no server for has no holders', async () => {
			const unknown = await addIntegration('no-such-provider', { defaultAgentAccess: 'read' })
			expect(await holdersOf(ctx, unknown)).toEqual([])
		})

		it('holdersForSources answers every source in one call', async () => {
			const slack = await addIntegration('slack', { defaultAgentAccess: 'read' })
			const meet = await addIntegration('google-meet', { defaultAgentAccess: 'none' })
			const map = await holdersForSources(ctx, [{ key: 'maskin:builtin' }, slack, meet])
			expect(map.get('maskin:builtin')).toHaveLength(3)
			expect(map.get(slack.key)).toHaveLength(3)
			expect(map.get(meet.key)).toEqual([])
		})

		it("does not read another workspace's integration", async () => {
			const otherWs = await insertWorkspace(db, ownerId)
			const other = await addIntegration('slack', {
				defaultAgentAccess: 'read',
				workspace: otherWs.id,
			})
			expect(await holdersOf(ctx, other)).toEqual([])
		})
	})

	describe('visibleHolders', () => {
		it('a member sees the agents of the workspace (every member sees every agent today)', async () => {
			const visible = await visibleHolders(ctx, memberId, [salesRepId, researcherId])
			expect(visible).toEqual([salesRepId, researcherId])
		})

		it('an agent that is not in the workspace is not visible and is not named', async () => {
			const outsider = await insertActor(db, { type: 'agent', name: 'Outsider' })
			const otherWs = await insertWorkspace(db, ownerId)
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: otherWs.id, actorId: outsider.id, role: 'member' })
			const visible = await visibleHolders(ctx, memberId, [salesRepId, outsider.id])
			expect(visible).toEqual([salesRepId])
		})

		it('a human is not an agent holder and is dropped', async () => {
			expect(await visibleHolders(ctx, memberId, [adminId, salesRepId])).toEqual([salesRepId])
		})

		it('fails closed: a recipient outside the workspace sees nothing', async () => {
			const stranger = await insertActor(db, { type: 'human', name: 'Stranger' })
			expect(await visibleHolders(ctx, stranger.id, [salesRepId])).toEqual([])
		})

		it('returns nothing for an empty list', async () => {
			expect(await visibleHolders(ctx, memberId, [])).toEqual([])
		})
	})

	describe('countUnscannedServers', () => {
		it('counts hand-added servers on the workspace that at least one agent can use', async () => {
			const used = await addIntegration('custom-mcp', { defaultAgentAccess: 'none' })
			await grant(used.integrationId, salesRepId, 'read_write')
			await addIntegration('custom-mcp', { defaultAgentAccess: 'none' })
			await addIntegration('slack', { defaultAgentAccess: 'read' })
			expect(await countUnscannedServers(ctx)).toBe(1)
		})

		it('is zero when no hand-added server exists', async () => {
			expect(await countUnscannedServers(ctx)).toBe(0)
		})
	})
})
