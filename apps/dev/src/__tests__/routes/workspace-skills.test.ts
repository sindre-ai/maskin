import {
	buildCreateWorkspaceSkillBody,
	buildUpdateWorkspaceSkillBody,
	buildWorkspaceMember,
	buildWorkspaceSkill,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSkillsTestApp } from '../setup'

const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

const workspaceId = '00000000-0000-0000-0000-000000000001'

describe('Workspace Skills Routes', () => {
	describe('GET /:workspaceId/skills', () => {
		it('returns 200 with the list of workspace skills', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			// Mirror the column projection the route performs — the mock DB does
			// not honour drizzle's `.select({...})` call, so simulate it here.
			const { content: _content, ...skillListRow } = buildWorkspaceSkill({ workspaceId })
			mockResults.selectQueue = [[buildWorkspaceMember()], [skillListRow]]

			const res = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].name).toBe(skillListRow.name)
			// list response must NOT include content
			expect(body[0].content).toBeUndefined()
		})

		it('returns 403 when caller is not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills`))

			expect(res.status).toBe(403)
		})
	})

	describe('GET /:workspaceId/skills/:name', () => {
		it('returns 200 with full skill content when found', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			const skill = buildWorkspaceSkill({ workspaceId, name: 'my-skill' })
			mockResults.selectQueue = [[buildWorkspaceMember()], [skill]]

			const res = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills/my-skill`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.name).toBe('my-skill')
			expect(body.content).toBe(skill.content)
		})

		it('returns 404 when skill does not exist', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()], []]

			const res = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills/missing`))

			expect(res.status).toBe(404)
		})

		it('returns 403 when caller is not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills/my-skill`))

			expect(res.status).toBe(403)
		})
	})

	describe('POST /:workspaceId/skills', () => {
		it('returns 201 and persists the new skill', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const body = buildCreateWorkspaceSkillBody({ name: 'shared-skill' })
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: body.name,
				content: body.content,
			})

			// select #1: workspace membership
			// insert #1: workspace_skills returning — DB-first, unique index catches dupes
			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.insert = [inserted]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, body),
			)

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.name).toBe(body.name)
			// The route generates the skill's UUID via randomUUID() before the
			// insert and uses the same id for both the DB row and the S3 key.
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
				workspaceId,
				expect.stringMatching(/^[0-9a-f-]{36}$/),
				body.content,
			)
		})

		it('returns 409 when the DB unique index rejects a duplicate name', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const body = buildCreateWorkspaceSkillBody({ name: 'taken-name' })

			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.insertError = new Error(
				'duplicate key value violates unique constraint "workspace_skills_ws_name_uniq"',
			)

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, body),
			)

			expect(res.status).toBe(409)
			// S3 write must not happen when the DB rejects the insert
			expect(agentStorage.putWorkspaceSkill).not.toHaveBeenCalled()
		})

		it('returns 400 for an invalid skill name', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'UPPER CASE',
					content: '---\nname: x\ndescription: y\n---\n\nBody',
				}),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when content is empty', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'valid-name',
					content: '',
				}),
			)

			expect(res.status).toBe(400)
		})

		it('returns 403 when caller is not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/workspaces/${workspaceId}/skills`,
					buildCreateWorkspaceSkillBody(),
				),
			)

			expect(res.status).toBe(403)
		})

		it('rolls back the DB insert when the S3 write fails', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const body = buildCreateWorkspaceSkillBody({ name: 'rollback-skill' })
			const inserted = buildWorkspaceSkill({ workspaceId, name: body.name })

			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.insert = [inserted]
			vi.mocked(agentStorage.putWorkspaceSkill).mockRejectedValueOnce(new Error('S3 5xx'))

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, body),
			)

			// The handler re-throws the S3 error → Hono returns 500 by default.
			// What matters is that the S3 write was attempted and the DB row was
			// deleted as rollback.
			expect(res.status).toBe(500)
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalled()
		})
	})

	describe('PUT /:workspaceId/skills/:name', () => {
		it('returns 200 and writes updated content to S3 + DB', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const existing = buildWorkspaceSkill({ workspaceId, name: 'my-skill' })
			const body = buildUpdateWorkspaceSkillBody()
			const updated = { ...existing, content: body.content }

			mockResults.selectQueue = [[buildWorkspaceMember()], [existing]]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/my-skill`, body),
			)

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.name).toBe('my-skill')
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
				workspaceId,
				existing.id,
				body.content,
			)
		})

		it('returns 404 when the skill does not exist', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()], []]

			const res = await app.request(
				jsonRequest(
					'PUT',
					`/api/workspaces/${workspaceId}/skills/missing`,
					buildUpdateWorkspaceSkillBody(),
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for an invalid skill name in the path', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest(
					'PUT',
					`/api/workspaces/${workspaceId}/skills/UPPER`,
					buildUpdateWorkspaceSkillBody(),
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when content is empty', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/my-skill`, {
					content: '',
				}),
			)

			expect(res.status).toBe(400)
		})

		it('returns 403 when caller is not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest(
					'PUT',
					`/api/workspaces/${workspaceId}/skills/my-skill`,
					buildUpdateWorkspaceSkillBody(),
				),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /:workspaceId/skills/:name', () => {
		it('returns 200 and deletes both S3 object and DB row', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const existing = buildWorkspaceSkill({ workspaceId, name: 'my-skill' })
			mockResults.selectQueue = [[buildWorkspaceMember()], [existing]]

			const res = await app.request(
				jsonRequest('DELETE', `/api/workspaces/${workspaceId}/skills/my-skill`, undefined),
			)

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.deleted).toBe(true)
			expect(agentStorage.deleteWorkspaceSkill).toHaveBeenCalledWith(workspaceId, existing.id)
		})

		it('returns 404 when the skill does not exist', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()], []]

			const res = await app.request(
				jsonRequest('DELETE', `/api/workspaces/${workspaceId}/skills/missing`, undefined),
			)

			expect(res.status).toBe(404)
		})

		it('returns 403 when caller is not a workspace member', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest('DELETE', `/api/workspaces/${workspaceId}/skills/my-skill`, undefined),
			)

			expect(res.status).toBe(403)
		})
	})
})
