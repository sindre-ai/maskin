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
			expect(body[0].isValid).toBe(true)
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
			expect(json.isValid).toBe(true)
			// The route generates the skill's UUID via randomUUID() before the
			// insert and uses the same id for both the DB row and the S3 key.
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
				workspaceId,
				expect.stringMatching(/^[0-9a-f-]{36}$/),
				body.content,
			)
		})

		it('stores unparseable content as an invalid skill', async () => {
			// Drag-and-drop may land files that don't have SKILL.md frontmatter.
			// We persist them with is_valid=false so users can fix them in-UI.
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			const body = {
				name: 'not-yet-valid',
				content: 'no frontmatter here, just a plain markdown body',
			}
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: body.name,
				content: body.content,
				description: null,
				isValid: false,
			})

			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.insert = [inserted]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, body),
			)

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.isValid).toBe(false)
			expect(json.description).toBeNull()
		})

		it('returns 409 when the DB unique index rejects a duplicate name', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const body = buildCreateWorkspaceSkillBody({ name: 'taken-name' })

			mockResults.selectQueue = [[buildWorkspaceMember()]]
			const uniqueErr = Object.assign(
				new Error('duplicate key value violates unique constraint "workspace_skills_ws_name_uniq"'),
				{ code: '23505', constraint_name: 'workspace_skills_ws_name_uniq' },
			)
			mockResults.insertError = uniqueErr

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
			// The INSERT and the S3 put run inside a single db.transaction, so a
			// throw from the put unwinds the tx — no orphan workspace_skills row
			// is committed. The mock tx runs the callback, propagates the throw,
			// and the route returns 500 (Hono's default for re-thrown errors).
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

			// 3 selects: workspace membership, outer existing lookup, inner SELECT FOR UPDATE inside tx
			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing]]
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

		it('renames a skill and rewrites the frontmatter name', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const existing = buildWorkspaceSkill({
				workspaceId,
				name: 'old-name',
				content: '---\nname: old-name\ndescription: existing\n---\n\nBody',
			})
			const body = {
				name: 'new-name',
				content: '---\nname: old-name\ndescription: existing\n---\n\nBody',
			}
			const updated = { ...existing, name: 'new-name' }

			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing]]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/old-name`, body),
			)

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.name).toBe('new-name')
			// The storage put should receive content whose frontmatter name has
			// been rewritten to match the new DB name.
			const putCall = vi.mocked(agentStorage.putWorkspaceSkill).mock.calls[0]
			expect(putCall?.[2]).toContain('name: new-name')
			expect(putCall?.[2]).not.toContain('name: old-name')
		})

		it('returns 409 when renaming collides with an existing skill', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			const existing = buildWorkspaceSkill({ workspaceId, name: 'old-name' })
			const body = {
				name: 'taken-name',
				content: '---\nname: old-name\ndescription: existing\n---\n\nBody',
			}

			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing]]
			const uniqueErr = Object.assign(
				new Error('duplicate key value violates unique constraint "workspace_skills_ws_name_uniq"'),
				{ code: '23505', constraint_name: 'workspace_skills_ws_name_uniq' },
			)
			mockResults.updateError = uniqueErr

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/old-name`, body),
			)

			expect(res.status).toBe(409)
		})

		it('does not perform a stale-content S3 rollback when the S3 write fails', async () => {
			// Old behavior re-put existing.content (stale) on DB-update failure,
			// which could overwrite a concurrent successful update. New behavior:
			// UPDATE runs inside a tx and S3 put runs after the row lock — if the
			// put throws, the tx rolls back the DB and S3 was never modified.
			// What matters: putWorkspaceSkill is called exactly once (with the new
			// content), never a second time with the prior content.
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const existing = buildWorkspaceSkill({
				workspaceId,
				name: 'my-skill',
				content: '---\nname: x\n---\nOLD',
			})
			const body = buildUpdateWorkspaceSkillBody({ content: '---\nname: x\n---\nNEW' })

			// outer SELECT, inner SELECT FOR UPDATE both return existing
			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing]]
			mockResults.update = [{ ...existing, content: body.content }]
			vi.mocked(agentStorage.putWorkspaceSkill).mockRejectedValueOnce(new Error('S3 5xx'))

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/my-skill`, body),
			)

			expect(res.status).toBe(500)
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledTimes(1)
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledWith(
				workspaceId,
				existing.id,
				body.content,
			)
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
