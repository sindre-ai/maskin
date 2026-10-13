import { actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
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

	const MEET_SERVER = {
		type: 'http',
		url: '${MASKIN_API_URL}/api/integrations/google-meet/mcp',
		headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
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

	async function addIntegration(provider: string, config: Record<string, unknown> = {}) {
		const [row] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId,
					provider,
					status: 'active',
					createdBy: ownerId,
					config,
				}) as never,
			)
			.returning()
		return { key: `integration:${provider}:${row.id}`, provider, integrationId: row.id }
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

		it('auto-injected provider: every agent unless the integration is not exposed', async () => {
			const slack = await addIntegration('slack')
			expect(await holdersOf(ctx, slack)).toHaveLength(3)

			const hidden = await addIntegration('posthog', { expose_to_agent_sessions: false })
			expect(await holdersOf(ctx, hidden)).toEqual([])
		})

		it('opt-in provider: only agents whose config has the same transport', async () => {
			const meet = await addIntegration('google-meet')
			await db
				.update(actors)
				.set({ tools: { mcpServers: { anything: MEET_SERVER } } })
				.where(eq(actors.id, salesRepId))
			expect(await holdersOf(ctx, meet)).toEqual([salesRepId])
		})

		it('opt-in provider nobody attached: no holders', async () => {
			const meet = await addIntegration('google-meet')
			expect(await holdersOf(ctx, meet)).toEqual([])
		})

		it('a provider with no declared server and no auto-inject has no holders', async () => {
			const linkedin = await addIntegration('linkedin-unipile')
			expect(await holdersOf(ctx, linkedin)).toEqual([])
		})

		it('holdersForSources answers every source in one call', async () => {
			const slack = await addIntegration('slack')
			const meet = await addIntegration('google-meet')
			const map = await holdersForSources(ctx, [{ key: 'maskin:builtin' }, slack, meet])
			expect(map.get('maskin:builtin')).toHaveLength(3)
			expect(map.get(slack.key)).toHaveLength(3)
			expect(map.get(meet.key)).toEqual([])
		})

		it("does not read another workspace's integration", async () => {
			const otherWs = await insertWorkspace(db, ownerId)
			const [row] = await db
				.insert(integrations)
				.values(
					buildIntegration({
						workspaceId: otherWs.id,
						provider: 'slack',
						status: 'active',
						createdBy: ownerId,
					}) as never,
				)
				.returning()
			const holders = await holdersOf(ctx, {
				key: `integration:slack:${row.id}`,
				provider: 'slack',
				integrationId: row.id,
			})
			expect(holders).toEqual([])
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
		it('counts distinct hand-attached transports no provider covers', async () => {
			const custom = { type: 'http', url: 'https://example.com/mcp' }
			await db
				.update(actors)
				.set({
					tools: {
						mcpServers: {
							a: custom,
							b: custom,
							meet: MEET_SERVER,
							maskin: { type: 'http', url: '${MASKIN_API_URL}/mcp' },
							gh: { type: 'stdio', command: 'github-mcp-server', args: ['stdio'] },
						},
					},
				})
				.where(eq(actors.id, salesRepId))
			expect(await countUnscannedServers(ctx)).toBe(1)
		})
	})
})
