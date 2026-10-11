import { OpenAPIHono } from '@hono/zod-openapi'
import { idempotencyRecords, workspaceInvitations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { generateInviteToken, hashInviteToken } = await import('../../lib/invites-token')
const { default: workspaceInvitationsRoutes } = await import('../../routes/workspace-invitations')
const { createIdempotencyMiddleware } = await import('../../middleware/idempotency')

/**
 * The accept route is public (no auth), so in production the idempotency
 * middleware sees it with no actor. Mount the middleware in front of the real
 * route the same way app-factory.ts does, so a retry goes through both.
 */
function app() {
	const outer = new OpenAPIHono()
	outer.use('/api/*', createIdempotencyMiddleware(db))
	outer.route(
		'/',
		createIntegrationApp({ path: '/api/invites', module: workspaceInvitationsRoutes }),
	)
	return outer
}

describe('Invites — POST /:token/accept with an Idempotency-Key', () => {
	let workspaceId: string
	let inviterId: string

	beforeEach(async () => {
		inviterId = getTestActorId()
		const ws = await insertWorkspace(db, inviterId)
		workspaceId = ws.id
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	it('never writes the invitee key to the idempotency ledger', async () => {
		const rawToken = generateInviteToken()
		await db.insert(workspaceInvitations).values({
			workspaceId,
			email: 'retry-newbie@example.com',
			role: 'member',
			tokenHash: hashInviteToken(rawToken),
			invitedByActorId: inviterId,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			metadata: {},
		})

		const res = await app().request(
			jsonRequest(
				'POST',
				`/api/invites/${rawToken}/accept`,
				{ email: 'retry-newbie@example.com', password: 'correct-horse-battery-staple' },
				{ 'Idempotency-Key': 'accept-ledger-1' },
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { actor: { api_key: string } }
		expect(body.actor.api_key).toMatch(/^ank_/)

		const rows = await db
			.select()
			.from(idempotencyRecords)
			.where(eq(idempotencyRecords.key, 'anon:accept-ledger-1'))
		expect(rows).toHaveLength(0)
	})
})
