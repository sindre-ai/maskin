import AdmZip from 'adm-zip'
import {
	buildCreateWorkspaceSkillBody,
	buildUpdateWorkspaceSkillBody,
	buildWorkspaceMember,
	buildWorkspaceSkill,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSkillsTestApp } from '../setup'

const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

function makeBundleBuffer(entries: Record<string, string>): Buffer {
	const zip = new AdmZip()
	for (const [path, content] of Object.entries(entries)) {
		zip.addFile(path, Buffer.from(content, 'utf-8'))
	}
	return zip.toBuffer()
}

function uploadRequest(workspaceId: string, fileName: string, body: Buffer, query = '') {
	const formData = new FormData()
	formData.append('file', new File([body], fileName))
	return new Request(`http://localhost/api/workspaces/${workspaceId}/skills/upload${query}`, {
		method: 'POST',
		body: formData,
	})
}

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
			// Submit content whose frontmatter name diverges from the row name
			// to confirm the route rewrites it back to match `existing.name`.
			const body = {
				content: '---\nname: stale-name\ndescription: Updated\n---\n\nNew body',
			}
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
			const putCall = vi.mocked(agentStorage.putWorkspaceSkill).mock.calls[0]
			expect(putCall?.[0]).toBe(workspaceId)
			expect(putCall?.[1]).toBe(existing.id)
			// Frontmatter is rewritten to match the row name even on non-rename updates.
			expect(putCall?.[2]).toContain('name: my-skill')
			expect(putCall?.[2]).not.toContain('name: stale-name')
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
				content: '---\nname: my-skill\ndescription: existing\n---\nOLD',
			})
			const body = buildUpdateWorkspaceSkillBody({
				content: '---\nname: my-skill\ndescription: existing\n---\nNEW',
			})

			// outer SELECT, inner SELECT FOR UPDATE both return existing
			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing]]
			mockResults.update = [{ ...existing, content: body.content }]
			vi.mocked(agentStorage.putWorkspaceSkill).mockRejectedValueOnce(new Error('S3 5xx'))

			const res = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/my-skill`, body),
			)

			expect(res.status).toBe(500)
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledTimes(1)
			const putCall = vi.mocked(agentStorage.putWorkspaceSkill).mock.calls[0]
			expect(putCall?.[0]).toBe(workspaceId)
			expect(putCall?.[1]).toBe(existing.id)
			expect(putCall?.[2]).toContain('NEW')
			expect(putCall?.[2]).toContain('name: my-skill')
		})
	})

	describe('POST /:workspaceId/skills/upload', () => {
		const SKILL_MD = '---\nname: docx\ndescription: Docx skill\n---\n\nDoc body.'

		it('persists a single SKILL.md upload and emits is_folder=false', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: 'docx',
				content: SKILL_MD,
				isFolder: false,
				fileCount: null,
			})
			mockResults.selectQueue = [[buildWorkspaceMember()], [inserted]]
			mockResults.insert = [inserted]

			const res = await app.request(
				uploadRequest(workspaceId, 'docx.md', Buffer.from(SKILL_MD, 'utf-8')),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.isFolder).toBe(false)
			expect(body.fileCount).toBeNull()
			expect(body.isValid).toBe(true)
			expect(body.error).toBeNull()
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalled()
			// Single-file upload must NOT touch the folder helpers.
			expect(agentStorage.putWorkspaceSkillFile).not.toHaveBeenCalled()
			expect(agentStorage.clearWorkspaceSkillFolder).not.toHaveBeenCalled()
		})

		it('persists a folder zip upload and writes each bundled file', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: 'docx',
				content: SKILL_MD,
				isFolder: true,
				fileCount: 3,
			})
			mockResults.selectQueue = [[buildWorkspaceMember()], [inserted]]
			mockResults.insert = [inserted]

			const buf = makeBundleBuffer({
				'docx/SKILL.md': SKILL_MD,
				'docx/reference/style.md': 'Style guide',
				'docx/scripts/run.py': 'print("hi")',
			})

			const res = await app.request(uploadRequest(workspaceId, 'docx.zip', buf))
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.isFolder).toBe(true)
			expect(body.fileCount).toBe(3)
			expect(body.error).toBeNull()

			// SKILL.md goes through putWorkspaceSkill; bundled files through
			// putWorkspaceSkillFile. We expect both helpers to fire — and the
			// bundled-file helper to be called for entries OTHER than SKILL.md.
			expect(agentStorage.putWorkspaceSkill).toHaveBeenCalledTimes(1)
			const bundleCalls = vi.mocked(agentStorage.putWorkspaceSkillFile).mock.calls
			const bundlePaths = bundleCalls.map((args) => args[2]).sort()
			expect(bundlePaths).toEqual(['reference/style.md', 'scripts/run.py'])
		})

		it('persists malformed bundles with isValid=false instead of returning 4xx', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: 'broken',
				content: '',
				isFolder: true,
				fileCount: 0,
				isValid: false,
				description: null,
			})
			mockResults.selectQueue = [[buildWorkspaceMember()], [inserted]]
			mockResults.insert = [inserted]

			const buf = makeBundleBuffer({ 'README.md': 'no skill md here' })

			const res = await app.request(uploadRequest(workspaceId, 'broken.zip', buf))
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.isValid).toBe(false)
			expect(body.error).toEqual({
				kind: 'no_skill_md',
				message: expect.stringContaining('SKILL.md'),
			})
		})

		it('rejects oversize zip-bombs at the per-entry cap', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()]]
			// 6MB of zeros compresses to roughly nothing but exceeds the 5MB per-entry cap.
			const huge = Buffer.alloc(6 * 1024 * 1024, 0)
			const zip = new AdmZip()
			zip.addFile('SKILL.md', Buffer.from(SKILL_MD, 'utf-8'))
			zip.addFile('huge.bin', huge)
			const buf = zip.toBuffer()

			// The persist path still tries to INSERT the malformed row.
			const inserted = buildWorkspaceSkill({
				workspaceId,
				name: 'bomb',
				isFolder: true,
				fileCount: 0,
				isValid: false,
			})
			mockResults.insert = [inserted]

			const res = await app.request(uploadRequest(workspaceId, 'bomb.zip', buf))
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.error.kind).toBe('too_large')
			expect(body.isValid).toBe(false)
		})

		it('replaces an existing folder skill in place when ?skillId is set', async () => {
			const { app, mockResults, agentStorage } = createSkillsTestApp(
				workspaceSkillsRoutes,
				'/api/workspaces',
			)
			const existing = buildWorkspaceSkill({
				workspaceId,
				name: 'docx',
				isFolder: true,
				fileCount: 2,
			})
			const updated = { ...existing, fileCount: 1, updatedAt: new Date() }

			// replace lookup, tx lock, tx re-fetch
			mockResults.selectQueue = [[buildWorkspaceMember()], [existing], [existing], [updated]]
			mockResults.update = [updated]

			const buf = makeBundleBuffer({ 'docx/SKILL.md': SKILL_MD })

			const res = await app.request(
				uploadRequest(workspaceId, 'docx.zip', buf, `?skillId=${existing.id}`),
			)
			expect(res.status).toBe(201)
			expect(agentStorage.clearWorkspaceSkillFolder).toHaveBeenCalledWith(workspaceId, existing.id)
		})

		it('returns 400 for unsupported file types', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()]]

			const res = await app.request(
				uploadRequest(workspaceId, 'bad.txt', Buffer.from('hi', 'utf-8')),
			)
			expect(res.status).toBe(400)
		})

		it('returns 403 for non-workspace members', async () => {
			const { app } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			const res = await app.request(
				uploadRequest(workspaceId, 'docx.md', Buffer.from(SKILL_MD, 'utf-8')),
			)
			expect(res.status).toBe(403)
		})

		it('returns 404 when replacing a missing skill', async () => {
			const { app, mockResults } = createSkillsTestApp(workspaceSkillsRoutes, '/api/workspaces')
			mockResults.selectQueue = [[buildWorkspaceMember()], []]

			const res = await app.request(
				uploadRequest(
					workspaceId,
					'docx.md',
					Buffer.from(SKILL_MD, 'utf-8'),
					'?skillId=00000000-0000-0000-0000-0000000000aa',
				),
			)
			expect(res.status).toBe(404)
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
