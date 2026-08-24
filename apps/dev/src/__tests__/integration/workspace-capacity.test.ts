import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { countHumanMembers } from '../../lib/workspace-capacity'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: { createSession: (...args: unknown[]) => Promise<unknown> }
	}
}

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
}

/**
 * Same shape as global-setup.ts's createIntegrationApp, but lets a test bind
 * an arbitrary actorId instead of the fixed shared test actor — needed for
 * multi-actor authorization/capacity scenarios (only the current billing
 * owner may transfer, only owner/admin may remove someone else, etc.) that
 * the shared helper's single-actor middleware can't express.
 */
function createAppAsActor(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', { createSession: async () => ({}) })
		await next()
	})
	// The assignability check between workspacesRoutes' own (narrower) Env and
	// this app's Env happens once here, at this typed parameter boundary —
	// mirroring global-setup.ts's createIntegrationApp — rather than inside
	// app.route(), which requires an exact Env match between the two apps.
	mountWorkspacesRoutes(app, [{ path: '/api/workspaces', module: workspacesRoutes }])
	return app
}

function mountWorkspacesRoutes(
	app: OpenAPIHono<Env>,
	routeModules: Array<{ path: string; module: OpenAPIHono<Env> }>,
) {
	for (const { path, module } of routeModules) {
		app.route(path, module)
	}
}

/**
 * Sets the plan by writing the row directly, the same way the other seeds in
 * this file do. It used to go through `PATCH /api/workspaces/:id`, which no
 * longer accepts `settings.billing` — that path is owned by Stripe and
 * accepting it was a self-service entitlement bypass. The API is not the seam
 * for putting a test workspace on a paid tier; the DB is.
 */
async function setPlan(workspaceId: string, plan: 'trial' | 'pro' | 'team' | 'byollm') {
	const [row] = await db
		.select({ settings: workspacesTable.settings })
		.from(workspacesTable)
		.where(eq(workspacesTable.id, workspaceId))
	const current = (row?.settings ?? {}) as Record<string, unknown>
	const billing = (current.billing ?? {}) as Record<string, unknown>
	await db
		.update(workspacesTable)
		.set({ settings: { ...current, billing: { ...billing, plan } } })
		.where(eq(workspacesTable.id, workspaceId))
}

// Delegates to the production helper rather than re-deriving the join —
// a plain `workspace_members` count would also tally the 6 seeded default
// agent actors, which never count toward the human seat cap.
async function humanMemberCount(workspaceId: string): Promise<number> {
	return countHumanMembers(db, workspaceId)
}

async function getWorkspace(workspaceId: string) {
	const [row] = await db
		.select()
		.from(workspacesTable)
		.where(eq(workspacesTable.id, workspaceId))
		.limit(1)
	return row
}

describe('Workspace capacity (seat cap + ownership cap) Integration', () => {
	describe('seat cap', () => {
		it('blocks the 2nd human member on a trial workspace (cap 1)', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Trial Seat' }),
			)
			const ws = await createRes.json()

			const other = await insertActor(db, { name: 'Second Human' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: other.id }),
			)
			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('SEAT_CAP_EXCEEDED')
			expect(body.error.cap).toBe(1)
			expect(body.error.used).toBe(1)

			expect(await humanMemberCount(ws.id)).toBe(1)
		})

		it('never blocks agents, even on a trial workspace already at the human seat cap', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Trial + Agent' }),
			)
			const ws = await createRes.json()

			const agent = await insertActor(db, { type: 'agent', name: 'Agent One' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: agent.id }),
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.added).toBe(true)
		})

		it('allows up to 5 human members on a pro workspace and blocks the 6th', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Pro Seats' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')

			// Owner already counts as 1 — 4 more fit under cap 5.
			for (let i = 0; i < 4; i++) {
				const human = await insertActor(db, { name: `Pro Member ${i}` })
				const res = await app.request(
					jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: human.id }),
				)
				expect(res.status).toBe(201)
			}
			expect(await humanMemberCount(ws.id)).toBe(5)

			const sixth = await insertActor(db, { name: 'Sixth Human' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: sixth.id }),
			)
			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('SEAT_CAP_EXCEEDED')
			expect(body.error.cap).toBe(5)
			expect(body.error.used).toBe(5)
		})

		it('serializes concurrent invites racing the last seat — exactly one succeeds', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Race Seats' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')

			// Bring to 4/5 (owner + 3), leaving exactly one free seat two
			// concurrent requests will race for.
			for (let i = 0; i < 3; i++) {
				const human = await insertActor(db, { name: `Pre-race Member ${i}` })
				await app.request(
					jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: human.id }),
				)
			}
			expect(await humanMemberCount(ws.id)).toBe(4)

			const [candidateA, candidateB] = await Promise.all([
				insertActor(db, { name: 'Race Candidate A' }),
				insertActor(db, { name: 'Race Candidate B' }),
			])

			const [resA, resB] = await Promise.all([
				app.request(
					jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: candidateA.id }),
				),
				app.request(
					jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: candidateB.id }),
				),
			])

			const statuses = [resA.status, resB.status].sort()
			expect(statuses).toEqual([201, 403])
			expect(await humanMemberCount(ws.id)).toBe(5)
		})

		it('re-inviting an already-a-member actor is idempotent, not a 500', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Idempotent Invite' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')

			const human = await insertActor(db, { name: 'Repeat Invitee' })
			const first = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: human.id }),
			)
			expect(first.status).toBe(201)
			expect((await first.json()).added).toBe(true)

			const second = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: human.id }),
			)
			expect(second.status).toBe(201)
			expect((await second.json()).added).toBe(false)
			expect(await humanMemberCount(ws.id)).toBe(2)
		})
	})

	describe('ownership cap', () => {
		it('sets the creator as billing_owner_id on a new workspace', async () => {
			const app = createApp()
			const res = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Owner Set' }))
			expect(res.status).toBe(201)
			const ws = await res.json()
			expect(ws.billingOwnerId).toBe(getTestActorId())
		})

		it('blocks a trial actor from creating a second workspace', async () => {
			const app = createApp()
			const first = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Owned #1' }))
			expect(first.status).toBe(201)

			const second = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Owned #2' }))
			expect(second.status).toBe(403)
			const body = await second.json()
			expect(body.error.code).toBe('OWNERSHIP_CAP_EXCEEDED')
			expect(body.error.effective_tier).toBe('trial')
			expect(body.error.cap).toBe(1)
		})

		it('effective tier is the MAX across owned workspaces — a single cap governs total count, not per-tier buckets', async () => {
			// Pre-seed 24 owned workspaces directly (1 team + 23 pro) so the
			// actor's effective tier is 'team' (cap 25) regardless of what tier a
			// NEW workspace would be created at.
			await insertWorkspace(db, getTestActorId(), { settings: { billing: { plan: 'team' } } })
			for (let i = 0; i < 23; i++) {
				await insertWorkspace(db, getTestActorId(), { settings: { billing: { plan: 'pro' } } })
			}
			expect(
				(
					await db
						.select({ id: workspacesTable.id })
						.from(workspacesTable)
						.where(eq(workspacesTable.billingOwnerId, getTestActorId()))
				).length,
			).toBe(24)

			const app = createApp()
			// The 25th workspace is a plain trial-tier create — proves the actor
			// is NOT limited to a separate 1-workspace trial bucket; they're
			// governed by their team-tier effective cap (25) instead.
			const ok = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Owned #25' }))
			expect(ok.status).toBe(201)

			const blocked = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Owned #26' }),
			)
			expect(blocked.status).toBe(403)
			const body = await blocked.json()
			expect(body.error.code).toBe('OWNERSHIP_CAP_EXCEEDED')
			expect(body.error.effective_tier).toBe('team')
			expect(body.error.cap).toBe(25)
			expect(body.error.used).toBe(25)
		})

		it('serializes concurrent workspace creations racing the last ownership slot', async () => {
			const app = createApp()
			const [resA, resB] = await Promise.all([
				app.request(jsonRequest('POST', '/api/workspaces', { name: 'Race Owned A' })),
				app.request(jsonRequest('POST', '/api/workspaces', { name: 'Race Owned B' })),
			])

			const statuses = [resA.status, resB.status].sort()
			expect(statuses).toEqual([201, 403])

			const owned = await db
				.select({ id: workspacesTable.id })
				.from(workspacesTable)
				.where(eq(workspacesTable.billingOwnerId, getTestActorId()))
			expect(owned).toHaveLength(1)
		})
	})

	describe('transfer ownership', () => {
		it('requires the new owner to already be a member; succeeds once added', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Transfer Target' }),
			)
			const ws = await createRes.json()
			// Trial's seat cap is 1 (owner only) — bump to pro so a second member
			// can actually be added below; the point of this test is the
			// member-required invariant, not the seat cap.
			await setPlan(ws.id, 'pro')
			const newOwner = await insertActor(db, { name: 'Future Owner' })

			const before = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: newOwner.id,
				}),
			)
			expect(before.status).toBe(404)

			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: newOwner.id }),
			)
			const after = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: newOwner.id,
				}),
			)
			expect(after.status).toBe(200)
			const body = await after.json()
			expect(body.billingOwnerId).toBe(newOwner.id)

			// role='owner' access control is untouched by a billing-ownership transfer.
			const [creatorMembership] = await db
				.select({ role: workspaceMembers.role })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, ws.id),
						eq(workspaceMembers.actorId, getTestActorId()),
					),
				)
			expect(creatorMembership?.role).toBe('owner')
		})

		it('blocks a transfer that would exceed the new owner’s ownership cap', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Capped Transfer' }),
			)
			const ws = await createRes.json()
			// Seat cap forces 'pro' to add a second member below — which also
			// means the transfer's candidate tier is 'pro' (cap 5), so the target
			// must already be AT the pro cap (5 owned), not just any lower tier,
			// for this transfer to actually exceed their cap.
			await setPlan(ws.id, 'pro')

			const newOwner = await insertActor(db, { name: 'Already Capped Owner' })
			for (let i = 0; i < 5; i++) {
				await insertWorkspace(db, newOwner.id, { settings: { billing: { plan: 'pro' } } })
			}
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: newOwner.id }),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: newOwner.id,
				}),
			)
			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('OWNERSHIP_CAP_EXCEEDED')

			const row = await getWorkspace(ws.id)
			expect(row?.billingOwnerId).toBe(getTestActorId())
		})

		it('only the current billing owner (not just any role=owner member) can initiate a transfer', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Owner Role Test' }),
			)
			const ws = await createRes.json()

			// Added as role='owner' (access control) but never made billing owner.
			const accessOwner = await insertActor(db, { name: 'Access Owner Only' })
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: accessOwner.id,
					role: 'owner',
				}),
			)
			const target = await insertActor(db, { name: 'Transfer Target 2' })
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: target.id }),
			)

			const appAsAccessOwner = createAppAsActor(accessOwner.id)
			const res = await appAsAccessOwner.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: target.id,
				}),
			)
			expect(res.status).toBe(403)

			const row = await getWorkspace(ws.id)
			expect(row?.billingOwnerId).toBe(getTestActorId())
		})

		it('cannot transfer billing ownership to an agent', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'No Agent Owner' }),
			)
			const ws = await createRes.json()

			const agent = await insertActor(db, { type: 'agent', name: 'Agent Target' })
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: agent.id }),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: agent.id,
				}),
			)
			expect(res.status).toBe(409)
		})

		it('handles concurrent cross-transfers between two actors without deadlocking', async () => {
			const actorB = await insertActor(db, { name: 'Cross Transfer B' })
			const wsA = await insertWorkspace(db, getTestActorId(), {
				settings: { billing: { plan: 'pro' } },
			})
			const wsB = await insertWorkspace(db, actorB.id, { settings: { billing: { plan: 'pro' } } })

			await db
				.insert(workspaceMembers)
				.values({ workspaceId: wsA.id, actorId: actorB.id, role: 'member' })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: wsB.id, actorId: getTestActorId(), role: 'member' })

			const appAsA = createApp()
			const appAsB = createAppAsActor(actorB.id)

			const [resA, resB] = await Promise.all([
				appAsA.request(
					jsonRequest('POST', `/api/workspaces/${wsA.id}/transfer-ownership`, {
						new_owner_actor_id: actorB.id,
					}),
				),
				appAsB.request(
					jsonRequest('POST', `/api/workspaces/${wsB.id}/transfer-ownership`, {
						new_owner_actor_id: getTestActorId(),
					}),
				),
			])

			expect(resA.status).toBe(200)
			expect(resB.status).toBe(200)

			expect((await getWorkspace(wsA.id))?.billingOwnerId).toBe(actorB.id)
			expect((await getWorkspace(wsB.id))?.billingOwnerId).toBe(getTestActorId())
		})
	})

	describe('remove member / leave workspace', () => {
		it('self-removal frees a seat-cap slot', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Leave Frees Seat' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')

			const members = []
			for (let i = 0; i < 4; i++) {
				const human = await insertActor(db, { name: `Leave Test Member ${i}` })
				await app.request(
					jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: human.id }),
				)
				members.push(human)
			}
			expect(await humanMemberCount(ws.id)).toBe(5)

			const leavingMember = members[0]
			const appAsMember = createAppAsActor(leavingMember.id)
			const leaveRes = await appAsMember.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${leavingMember.id}`, {
					method: 'DELETE',
				}),
			)
			expect(leaveRes.status).toBe(200)
			expect(await humanMemberCount(ws.id)).toBe(4)

			const newHuman = await insertActor(db, { name: 'Fills Freed Seat' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: newHuman.id }),
			)
			expect(res.status).toBe(201)
		})

		it('cannot remove the current billing owner', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'No Remove Owner' }),
			)
			const ws = await createRes.json()

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${getTestActorId()}`, {
					method: 'DELETE',
				}),
			)
			expect(res.status).toBe(409)

			expect(await humanMemberCount(ws.id)).toBe(1)
		})

		it('billing owner CAN be removed after transferring ownership away first', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Transfer Then Remove' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')
			const newOwner = await insertActor(db, { name: 'New Owner For Removal' })
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: newOwner.id }),
			)
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/transfer-ownership`, {
					new_owner_actor_id: newOwner.id,
				}),
			)

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${getTestActorId()}`, {
					method: 'DELETE',
				}),
			)
			expect(res.status).toBe(200)
			expect(await humanMemberCount(ws.id)).toBe(1)
		})

		it('only owner/admin can remove someone else; a plain member cannot, but can still self-remove', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Plain Member Removal' }),
			)
			const ws = await createRes.json()
			await setPlan(ws.id, 'pro')

			const memberX = await insertActor(db, { name: 'Plain Member X' })
			const memberY = await insertActor(db, { name: 'Plain Member Y' })
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: memberX.id }),
			)
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: memberY.id }),
			)

			const appAsX = createAppAsActor(memberX.id)
			const removeOther = await appAsX.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${memberY.id}`, {
					method: 'DELETE',
				}),
			)
			expect(removeOther.status).toBe(403)

			const selfRemove = await appAsX.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${memberX.id}`, {
					method: 'DELETE',
				}),
			)
			expect(selfRemove.status).toBe(200)
			expect(await humanMemberCount(ws.id)).toBe(2)
		})
	})

	describe('enterprise allowlist bypass', () => {
		const ORIGINAL_ENV = process.env.MASKIN_ENTERPRISE_ACTOR_IDS

		afterEach(() => {
			if (ORIGINAL_ENV === undefined) {
				// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
				delete process.env.MASKIN_ENTERPRISE_ACTOR_IDS
			} else {
				process.env.MASKIN_ENTERPRISE_ACTOR_IDS = ORIGINAL_ENV
			}
		})

		it('lets an allowlisted actor exceed the trial ownership cap', async () => {
			process.env.MASKIN_ENTERPRISE_ACTOR_IDS = getTestActorId()
			const app = createApp()
			const first = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Enterprise Owned #1' }),
			)
			expect(first.status).toBe(201)

			const second = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Enterprise Owned #2' }),
			)
			expect(second.status).toBe(201)
		})

		it('lets a workspace bill-owned by an allowlisted actor exceed the trial seat cap', async () => {
			process.env.MASKIN_ENTERPRISE_ACTOR_IDS = getTestActorId()
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Enterprise Seats' }),
			)
			const ws = await createRes.json()

			const other = await insertActor(db, { name: 'Enterprise Second Human' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: other.id }),
			)
			expect(res.status).toBe(201)
			expect(await humanMemberCount(ws.id)).toBe(2)
		})

		it('still enforces the seat cap once the actor is removed from the allowlist', async () => {
			process.env.MASKIN_ENTERPRISE_ACTOR_IDS = getTestActorId()
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Enterprise Then Not' }),
			)
			const ws = await createRes.json()

			// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
			delete process.env.MASKIN_ENTERPRISE_ACTOR_IDS
			const other = await insertActor(db, { name: 'Blocked Second Human' })
			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, { actor_id: other.id }),
			)
			expect(res.status).toBe(403)
		})
	})
})
