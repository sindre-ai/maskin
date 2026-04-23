import { buildSaveSkillBody, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createSkillsTestApp } from '../setup'

const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

const wsId = '00000000-0000-0000-0000-000000000001'

const validSkillMd = `---
name: team-skill
description: A shared team skill
---

Do the team thing`

describe('Workspace Skills Routes', () => {
	describe('GET /:workspaceId/skills', () => {
		it('returns 200 with list of team skills', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.listWorkspaceFileRecords as ReturnType<typeof vi.fn>).mockResolvedValue([
				{ path: 'skills/team-skill/SKILL.md', sizeBytes: 100, updatedAt: new Date() },
			])
			;(agentStorage.getWorkspaceFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				Buffer.from(validSkillMd),
			)

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/skills`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].name).toBe('team-skill')
			expect(body[0].description).toBe('A shared team skill')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/skills`))

			expect(res.status).toBe(403)
		})
	})

	describe('GET /:workspaceId/skills/:skillName', () => {
		it('returns 200 when skill found', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.getWorkspaceFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				Buffer.from(validSkillMd),
			)

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/skills/team-skill`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.name).toBe('team-skill')
			expect(body.description).toBe('A shared team skill')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/skills/team-skill`))

			expect(res.status).toBe(403)
		})

		it('returns 404 when skill not found', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			mockResults.select = [buildWorkspaceMember()]
			;(agentStorage.getWorkspaceFile as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Not found'),
			)

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/skills/missing`))

			expect(res.status).toBe(404)
		})
	})

	describe('PUT /:workspaceId/skills/:skillName', () => {
		it('returns 200 when skill saved', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${wsId}/skills/team-skill`, buildSaveSkillBody()),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.name).toBe('team-skill')
			expect(agentStorage.uploadWorkspaceFile).toHaveBeenCalled()
		})

		it('returns 400 for invalid skill name', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${wsId}/skills/UPPER%20CASE`, buildSaveSkillBody()),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${wsId}/skills/team-skill`, buildSaveSkillBody()),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /:workspaceId/skills/:skillName', () => {
		it('returns 200 when skill deleted', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(jsonDelete(`/api/workspaces/${wsId}/skills/team-skill`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(agentStorage.deleteWorkspaceFile).toHaveBeenCalled()
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(jsonDelete(`/api/workspaces/${wsId}/skills/team-skill`))

			expect(res.status).toBe(403)
		})
	})
})
