import { randomUUID } from 'node:crypto'
import { buildSaveSkillBody, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createSkillsTestApp } from '../setup'

const { default: agentSkillsRoutes } = await import('../../routes/agent-skills')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = '00000000-0000-0000-0000-000000000002'
const headers = { 'x-workspace-id': wsId }

const validSkillMd = `---
name: my-skill
description: A test skill
---

Do the thing`

describe('Agent Skills Routes', () => {
	describe('GET /:actorId/skills', () => {
		it('returns 200 with list of skills', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				agentSkillsRoutes,
				'/api/actors',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.listFileRecords as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ path: 'skills/my-skill/SKILL.md', sizeBytes: 100, updatedAt: new Date() },
			])
			;(agentStorage.getFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				Buffer.from(validSkillMd),
			)

			const res = await app.request(jsonGet(`/api/actors/${actorId}/skills`, headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].name).toBe('my-skill')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(agentSkillsRoutes, '/api/actors')

			const res = await app.request(jsonGet(`/api/actors/${actorId}/skills`, headers))

			expect(res.status).toBe(403)
		})
	})

	describe('GET /:actorId/skills/:skillName', () => {
		it('returns 200 when skill found', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				agentSkillsRoutes,
				'/api/actors',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.getFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				Buffer.from(validSkillMd),
			)

			const res = await app.request(jsonGet(`/api/actors/${actorId}/skills/my-skill`, headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.name).toBe('my-skill')
			expect(body.description).toBe('A test skill')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(agentSkillsRoutes, '/api/actors')

			const res = await app.request(jsonGet(`/api/actors/${actorId}/skills/my-skill`, headers))

			expect(res.status).toBe(403)
		})

		it('returns 404 when skill not found', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				agentSkillsRoutes,
				'/api/actors',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.getFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'))

			const res = await app.request(jsonGet(`/api/actors/${actorId}/skills/nonexistent`, headers))

			expect(res.status).toBe(404)
		})
	})

	describe('PUT /:actorId/skills/:skillName', () => {
		it('returns 200 when skill saved', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				agentSkillsRoutes,
				'/api/actors',
			)
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('PUT', `/api/actors/${actorId}/skills/my-skill`, buildSaveSkillBody(), headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.name).toBe('my-skill')
			expect(agentStorage.uploadFile).toHaveBeenCalled()
		})

		it('returns 400 for invalid skill name', async () => {
			const { app, mockResults } = createSkillsTestApp(agentSkillsRoutes, '/api/actors')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest(
					'PUT',
					`/api/actors/${actorId}/skills/UPPER CASE`,
					buildSaveSkillBody(),
					headers,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(agentSkillsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('PUT', `/api/actors/${actorId}/skills/my-skill`, buildSaveSkillBody(), headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /:actorId/skills/:skillName', () => {
		it('returns 200 when skill deleted', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				agentSkillsRoutes,
				'/api/actors',
			)
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('DELETE', `/api/actors/${actorId}/skills/my-skill`, undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(agentStorage.deleteFile).toHaveBeenCalled()
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(agentSkillsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('DELETE', `/api/actors/${actorId}/skills/my-skill`, undefined, headers),
			)

			expect(res.status).toBe(403)
		})
	})
})
