import { randomUUID } from 'node:crypto'
import { buildActor, buildWorkspaceMember, buildWorkspaceSkill } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: agentSkillAttachmentsRoutes } = await import(
	'../../routes/agent-skill-attachments'
)

const callerActorId = 'test-actor-id'
const workspaceId = '00000000-0000-0000-0000-000000000010'
const actorId = '00000000-0000-0000-0000-000000000020'
const workspaceSkillId = '00000000-0000-0000-0000-000000000030'

describe('Agent Skill Attachments Routes', () => {
	describe('GET /:actorId/workspace-skills', () => {
		it('returns 200 with the attached skills visible to the caller', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ workspaceId })

			// Queue order:
			//  1. actor lookup (exists)
			//  2. caller's workspace memberships
			//  3. target actor's workspace memberships
			//  4. join query returning attached skills
			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[{ workspaceId }],
				[{ workspaceId }],
				[{ ...skill, attachedAt: new Date() }],
			]

			const res = await app.request(jsonGet(`/api/actors/${actorId}/workspace-skills`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(skill.id)
			expect(body[0].workspaceId).toBe(workspaceId)
			expect(body[0].attachedAt).toBeTruthy()
		})

		it('returns 404 when actor does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			mockResults.selectQueue = [[]]

			const res = await app.request(jsonGet(`/api/actors/${actorId}/workspace-skills`))
			expect(res.status).toBe(404)
		})

		it('returns 403 when caller shares no workspace with the actor', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')

			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[{ workspaceId: randomUUID() }],
				[{ workspaceId: randomUUID() }],
			]

			const res = await app.request(jsonGet(`/api/actors/${actorId}/workspace-skills`))
			expect(res.status).toBe(403)
		})

		it('filters out attachments in workspaces the caller cannot see', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const otherWorkspaceId = randomUUID()
			const visibleSkill = buildWorkspaceSkill({ workspaceId })
			const hiddenSkill = buildWorkspaceSkill({ workspaceId: otherWorkspaceId })

			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				// caller is only a member of `workspaceId`
				[{ workspaceId }],
				// target actor is in both
				[{ workspaceId }, { workspaceId: otherWorkspaceId }],
				[
					{ ...visibleSkill, attachedAt: new Date() },
					{ ...hiddenSkill, attachedAt: new Date() },
				],
			]

			const res = await app.request(jsonGet(`/api/actors/${actorId}/workspace-skills`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(visibleSkill.id)
		})
	})

	describe('POST /:actorId/workspace-skills', () => {
		it('returns 200 and writes an event when attaching a new skill', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			// Queue order:
			//  1. actor lookup
			//  2. skill lookup
			//  3. caller membership in skill workspace
			//  4. actor membership in skill workspace
			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				[buildWorkspaceMember({ workspaceId, actorId: callerActorId })],
				[buildWorkspaceMember({ workspaceId, actorId })],
			]
			mockResults.insert = [{ actorId, workspaceSkillId, createdAt: new Date() }]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(skill.id)
			expect(body.workspaceId).toBe(workspaceId)
			expect(body.attachedAt).toBeTruthy()
		})

		it('is idempotent — returns 200 when the attachment already exists', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			//  1. actor lookup
			//  2. skill lookup
			//  3. caller membership
			//  4. actor membership
			//  5. fallback select to fetch existing attachedAt (insert returned nothing)
			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				[buildWorkspaceMember({ workspaceId, actorId: callerActorId })],
				[buildWorkspaceMember({ workspaceId, actorId })],
				[{ createdAt: new Date() }],
			]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(skill.id)
		})

		it('returns 400 when the skill is in a different workspace than the actor', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			//  1. actor lookup
			//  2. skill lookup
			//  3. caller membership in skill workspace (ok)
			//  4. actor membership in skill workspace → NOT found
			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				[buildWorkspaceMember({ workspaceId, actorId: callerActorId })],
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(400)
		})

		it('returns 403 when the caller is not a member of the skill workspace', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				// caller NOT a member
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when the actor does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when the skill does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			mockResults.selectQueue = [[buildActor({ id: actorId })], []]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for an invalid workspaceSkillId', async () => {
			const { app } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/workspace-skills`, {
					workspaceSkillId: 'not-a-uuid',
				}),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('DELETE /:actorId/workspace-skills/:workspaceSkillId', () => {
		it('returns 200 when the attachment is removed', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			//  1. actor lookup
			//  2. skill lookup
			//  3. caller membership
			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				[buildWorkspaceMember({ workspaceId, actorId: callerActorId })],
			]
			mockResults.delete = [{ actorId, workspaceSkillId }]

			const res = await app.request(
				jsonDelete(`/api/actors/${actorId}/workspace-skills/${workspaceSkillId}`),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when the attachment does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				[buildWorkspaceMember({ workspaceId, actorId: callerActorId })],
			]
			mockResults.delete = []

			const res = await app.request(
				jsonDelete(`/api/actors/${actorId}/workspace-skills/${workspaceSkillId}`),
			)

			expect(res.status).toBe(404)
		})

		it('returns 403 when caller is not a member of the skill workspace', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			const skill = buildWorkspaceSkill({ id: workspaceSkillId, workspaceId })

			mockResults.selectQueue = [
				[buildActor({ id: actorId })],
				[skill],
				// caller is NOT a member
				[],
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${actorId}/workspace-skills/${workspaceSkillId}`),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when the actor does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonDelete(`/api/actors/${actorId}/workspace-skills/${workspaceSkillId}`),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when the skill does not exist', async () => {
			const { app, mockResults } = createTestApp(agentSkillAttachmentsRoutes, '/api/actors')
			mockResults.selectQueue = [[buildActor({ id: actorId })], []]

			const res = await app.request(
				jsonDelete(`/api/actors/${actorId}/workspace-skills/${workspaceSkillId}`),
			)

			expect(res.status).toBe(404)
		})
	})
})
