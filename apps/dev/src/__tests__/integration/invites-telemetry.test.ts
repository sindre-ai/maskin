import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertWorkspace, setWorkspacePlan } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Baseline + retirement-observation events on the two pre-existing endpoints.
// The invite endpoints' own events are asserted in invites-create/lifecycle.
const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { default: actorsRoutes } = await import('../../routes/actors')

describe('PostHog events on the pre-existing member paths', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
	})

	describe('POST /api/workspaces/:id/members', () => {
		let workspaceId: string
		const callerId = () => getTestActorId()

		beforeEach(async () => {
			const ws = await insertWorkspace(db, callerId())
			workspaceId = ws.id
			await setWorkspacePlan(db, workspaceId, 'pro')
		})

		function add(actorId: string) {
			return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes }).request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/members`, { actor_id: actorId }),
			)
		}

		it('emits workspace_member_invited with invite_method actor_id when a member is added', async () => {
			const target = await insertActor(db)

			const res = await add(target.id)

			expect(res.status).toBe(201)
			expect(await res.json()).toEqual({ added: true })
			expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
			expect(capturePosthogEventMock).toHaveBeenCalledWith('workspace_member_invited', callerId(), {
				invite_method: 'actor_id',
				workspace_id: workspaceId,
				role: 'member',
			})
		})

		it('does not emit for the idempotent already-a-member no-op', async () => {
			const target = await insertActor(db)
			await add(target.id)
			capturePosthogEventMock.mockClear()

			const res = await add(target.id)

			expect(res.status).toBe(201)
			expect(await res.json()).toEqual({ added: false })
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('does not emit when the seat cap blocks the add', async () => {
			await setWorkspacePlan(db, workspaceId, 'trial')
			const target = await insertActor(db)

			const res = await add(target.id)

			expect(res.status).toBe(403)
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})
	})

	describe('POST /api/actors (organic signup)', () => {
		function signup(body: Record<string, unknown>) {
			return createIntegrationApp({ path: '/api/actors', module: actorsRoutes }).request(
				jsonRequest('POST', '/api/actors', body),
			)
		}

		it('emits workspace_member_joined with from_invite false when a human lands in their workspace', async () => {
			const res = await signup({
				type: 'human',
				name: 'Organic Olga',
				email: `olga-${randomUUID().slice(0, 8)}@example.com`,
				password: 'correct-horse-battery-staple',
			})

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.workspace_id).toBeTruthy()
			// Provisioning emits its own workspace_created; only the joined event is under test.
			const joined = capturePosthogEventMock.mock.calls.filter(
				([name]) => name === 'workspace_member_joined',
			)
			expect(joined).toHaveLength(1)
			expect(capturePosthogEventMock).toHaveBeenCalledWith('workspace_member_joined', body.id, {
				from_invite: false,
				workspace_id: body.workspace_id,
			})
		})

		it('does not emit when no workspace is created', async () => {
			const res = await signup({
				type: 'human',
				name: 'Workspaceless Wim',
				email: `wim-${randomUUID().slice(0, 8)}@example.com`,
				password: 'correct-horse-battery-staple',
				auto_create_workspace: false,
			})

			expect(res.status).toBe(201)
			expect(
				capturePosthogEventMock.mock.calls.filter(([name]) => name === 'workspace_member_joined'),
			).toHaveLength(0)
		})
	})
})
