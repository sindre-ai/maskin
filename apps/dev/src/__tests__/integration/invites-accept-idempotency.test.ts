import { OpenAPIHono } from '@hono/zod-openapi'
import { workspaceInvitations } from '@maskin/db/schema'
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

describe('Invites — retrying POST /:token/accept with the same Idempotency-Key', () => {
	let workspaceId: string
	let inviterId: string

	beforeEach(async () => {
		inviterId = getTestActorId()
		const ws = await insertWorkspace(db, inviterId)
		workspaceId = ws.id
		await setWorkspacePlan(db, workspaceId, 'pro')
	})

	it('gives the invitee the same answer, including their key, when the first reply was lost', async () => {
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

		const send = () =>
			app().request(
				jsonRequest(
					'POST',
					`/api/invites/${rawToken}/accept`,
					{ email: 'retry-newbie@example.com', password: 'correct-horse-battery-staple' },
					{ 'Idempotency-Key': 'accept-retry-1' },
				),
			)

		const first = await send()
		expect(first.status).toBe(201)
		const firstBody = (await first.json()) as { actor: { api_key: string } }
		expect(firstBody.actor.api_key).toMatch(/^ank_/)

		// The client never saw the first reply and sends the identical request again.
		const retry = await send()
		expect(retry.status).toBe(201)
		const retryBody = (await retry.json()) as { actor: { api_key: string } }
		expect(retryBody.actor.api_key).toBe(firstBody.actor.api_key)
	})
})
