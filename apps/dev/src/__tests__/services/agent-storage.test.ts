import { vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(Buffer.from('file content')),
	readdir: vi.fn().mockResolvedValue([]),
	rm: vi.fn().mockResolvedValue(undefined),
	stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}))

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageProvider } from '@maskin/storage'
import { AgentStorageManager, workspaceSkillKey } from '../../services/agent-storage'
import { createTestContext } from '../setup'

function createMockStorage() {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('s3 content')),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
	}
}

describe('AgentStorageManager', () => {
	const actorId = 'actor-123'
	const workspaceId = 'ws-123'
	let storage: ReturnType<typeof createMockStorage>
	let manager: AgentStorageManager
	let mockResults: Record<string, unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		storage = createMockStorage()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		manager = new AgentStorageManager(storage as StorageProvider, ctx.db)
	})

	describe('pullAgentFiles()', () => {
		it('downloads files from S3 and writes locally', async () => {
			const prefix = `agents/${workspaceId}/${actorId}/`
			storage.list.mockResolvedValue([
				`${prefix}skills/my-skill/SKILL.md`,
				`${prefix}memory/CLAUDE.md`,
			])
			storage.get.mockResolvedValue(Buffer.from('file data'))

			await manager.pullAgentFiles(actorId, workspaceId, '/tmp/agent')

			expect(storage.list).toHaveBeenCalledWith(prefix)
			expect(storage.get).toHaveBeenCalledTimes(2)
			expect(writeFile).toHaveBeenCalledTimes(2)
			// Ensures directory structure created
			expect(mkdir).toHaveBeenCalled()
		})

		it('creates empty directory structure even with no files', async () => {
			storage.list.mockResolvedValue([])

			await manager.pullAgentFiles(actorId, workspaceId, '/tmp/agent')

			// Should create skills, learnings, memory, workspace dirs
			expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('skills'), { recursive: true })
			expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('learnings'), { recursive: true })
			expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('memory'), { recursive: true })
			expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('workspace'), { recursive: true })
		})

		it('continues past per-file failures, then throws an aggregate error naming each failed key', async () => {
			// Without per-key try/catch, the first bad object would abort the whole
			// pull with only its key in the error message. The aggregate error must
			// name every failure so operators can see the full divergence.
			const prefix = `agents/${workspaceId}/${actorId}/`
			storage.list.mockResolvedValue([
				`${prefix}memory/CLAUDE.md`,
				`${prefix}skills/broken/SKILL.md`,
				`${prefix}learnings/session-1.md`,
			])
			storage.get.mockImplementation(async (key: string) => {
				if (key.includes('broken')) throw new Error('NoSuchKey')
				return Buffer.from('ok', 'utf-8')
			})

			await expect(manager.pullAgentFiles(actorId, workspaceId, '/tmp/agent')).rejects.toThrow(
				/skills\/broken\/SKILL\.md/,
			)

			// The two healthy files were still written despite the middle failure.
			expect(writeFile).toHaveBeenCalledWith(
				join('/tmp/agent/memory/CLAUDE.md'),
				expect.any(Buffer),
			)
			expect(writeFile).toHaveBeenCalledWith(
				join('/tmp/agent/learnings/session-1.md'),
				expect.any(Buffer),
			)
		})
	})

	describe('pushAgentFiles()', () => {
		it('pushes learning file to S3', async () => {
			;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('learning data'))
			;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([])
			// Mock the DB upsert (update returns empty → insert)
			mockResults.update = []
			mockResults.insert = []

			await manager.pushAgentFiles(actorId, workspaceId, 'session-1', '/tmp/agent')

			const expectedKey = `agents/${workspaceId}/${actorId}/learnings/session-session-1.md`
			expect(storage.put).toHaveBeenCalledWith(expectedKey, expect.any(Buffer))
		})

		it('pushes memory files to S3', async () => {
			// Learning file doesn't exist
			;(readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
			)
			// Memory dir has files
			;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['CLAUDE.md', 'notes.md'])
			;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('memory data'))
			mockResults.update = []
			mockResults.insert = []

			await manager.pushAgentFiles(actorId, workspaceId, 'session-1', '/tmp/agent')

			expect(storage.put).toHaveBeenCalledWith(
				`agents/${workspaceId}/${actorId}/memory/CLAUDE.md`,
				expect.any(Buffer),
			)
		})

		it('appends a summary to the workspace ledger on every push (regression guard)', async () => {
			// The workspace-scoped ledger is what lets future sessions see what
			// was tried across the workspace. This test pins the contract so a
			// future refactor of pushAgentFiles cannot silently drop it.
			;(readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				Buffer.from('Shipped outreach automation\n'),
			)
			;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([])
			mockResults.update = []
			mockResults.insert = []

			await manager.pushAgentFiles(actorId, workspaceId, 'session-1', '/tmp/agent')

			const ledgerCall = (storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
				(call) => (call[0] as string) === `agents/${workspaceId}/_workspace/learnings.md`,
			)
			expect(ledgerCall).toBeDefined()
			const written = (ledgerCall?.[1] as Buffer).toString('utf-8')
			expect(written).toContain('session-')
			expect(written).toContain('Shipped outreach automation')
		})

		it('falls back to actionPrompt when no SESSION_LEARNING.md is present', async () => {
			// readFile rejects for all paths (neither learning file nor SESSION_LEARNING exists)
			;(readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
				Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
			)
			;(readdir as ReturnType<typeof vi.fn>).mockResolvedValue([])

			await manager.pushAgentFiles(actorId, workspaceId, 'session-1', '/tmp/agent', {
				actionPrompt: 'Reply to the new GitHub issue about billing',
			})

			const ledgerCall = (storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
				(call) => (call[0] as string) === `agents/${workspaceId}/_workspace/learnings.md`,
			)
			expect(ledgerCall).toBeDefined()
			expect((ledgerCall?.[1] as Buffer).toString('utf-8')).toContain(
				'Reply to the new GitHub issue about billing',
			)
		})
	})

	describe('getFile()', () => {
		it('constructs correct S3 key and returns content', async () => {
			const content = Buffer.from('skill content')
			storage.get.mockResolvedValue(content)

			const result = await manager.getFile(actorId, workspaceId, 'skills', 'my-skill/SKILL.md')

			expect(result).toBe(content)
			expect(storage.get).toHaveBeenCalledWith(
				`agents/${workspaceId}/${actorId}/skills/my-skill/SKILL.md`,
			)
		})
	})

	describe('uploadFile()', () => {
		it('uploads to S3 and upserts DB record', async () => {
			const content = Buffer.from('skill data')
			mockResults.update = []
			mockResults.insert = []

			const key = await manager.uploadFile(
				actorId,
				workspaceId,
				'skills',
				'my-skill/SKILL.md',
				content,
			)

			expect(key).toBe(`agents/${workspaceId}/${actorId}/skills/my-skill/SKILL.md`)
			expect(storage.put).toHaveBeenCalledWith(key, content)
		})
	})

	describe('listFileRecords()', () => {
		it('queries DB for file records', async () => {
			const records = [{ path: 'skills/a/SKILL.md', sizeBytes: 100 }]
			mockResults.select = records

			const result = await manager.listFileRecords(actorId, workspaceId, 'skills')

			expect(result).toEqual(records)
		})
	})

	describe('listFiles()', () => {
		it('lists files with type prefix', async () => {
			storage.list.mockResolvedValue(['key1', 'key2'])

			const result = await manager.listFiles(actorId, workspaceId, 'skills')

			expect(storage.list).toHaveBeenCalledWith(`agents/${workspaceId}/${actorId}/skills/`)
			expect(result).toEqual(['key1', 'key2'])
		})

		it('lists all files without type filter', async () => {
			storage.list.mockResolvedValue(['key1'])

			await manager.listFiles(actorId, workspaceId)

			expect(storage.list).toHaveBeenCalledWith(`agents/${workspaceId}/${actorId}/`)
		})
	})

	describe('deleteFile()', () => {
		it('deletes from S3 and DB', async () => {
			await manager.deleteFile(actorId, workspaceId, 'skills', 'my-skill/SKILL.md')

			expect(storage.delete).toHaveBeenCalledWith(
				`agents/${workspaceId}/${actorId}/skills/my-skill/SKILL.md`,
			)
		})
	})

	describe('workspace skills', () => {
		const skillId = '11111111-1111-1111-1111-111111111111'
		const expectedKey = `workspaces/${workspaceId}/skills/${skillId}/SKILL.md`

		describe('putWorkspaceSkill()', () => {
			it('writes SKILL.md to the workspace-scoped S3 prefix', async () => {
				const result = await manager.putWorkspaceSkill(
					workspaceId,
					skillId,
					'---\nname: deploy-check\n---\nHello',
				)

				expect(storage.put).toHaveBeenCalledWith(expectedKey, expect.any(Buffer))
				expect(result.storageKey).toBe(expectedKey)
				expect(result.sizeBytes).toBeGreaterThan(0)
			})

			it('round-trips content with getWorkspaceSkill()', async () => {
				const content = '---\nname: deploy-check\n---\nBody'
				let written: Buffer | null = null
				storage.put.mockImplementation(async (_key, data) => {
					written = data as Buffer
				})
				storage.get.mockImplementation(async (key) => {
					if (key === expectedKey && written) return written
					throw new Error(`unexpected key: ${key}`)
				})

				await manager.putWorkspaceSkill(workspaceId, skillId, content)
				const readBack = await manager.getWorkspaceSkill(workspaceId, skillId)

				expect(readBack).toBe(content)
			})
		})

		describe('getWorkspaceSkill()', () => {
			it('reads and decodes the workspace-scoped S3 key', async () => {
				storage.get.mockResolvedValue(Buffer.from('Some skill body', 'utf-8'))

				const content = await manager.getWorkspaceSkill(workspaceId, skillId)

				expect(storage.get).toHaveBeenCalledWith(expectedKey)
				expect(content).toBe('Some skill body')
			})
		})

		describe('deleteWorkspaceSkill()', () => {
			it('removes the workspace-scoped S3 key', async () => {
				await manager.deleteWorkspaceSkill(workspaceId, skillId)

				expect(storage.delete).toHaveBeenCalledWith(expectedKey)
			})
		})

		describe('pullWorkspaceSkillsForAgent()', () => {
			it('writes a stub index containing every attached skill, no SKILL.md bodies', async () => {
				// AC-T3: CLAUDE.md (via this index) carries N stubs with name +
				// 1-line description and zero full bodies. We assert the on-disk
				// index against a fixture and assert no S3 body fetch was issued.
				mockResults.select = [
					{ name: 'deploy-check', description: 'Verify deploy went out cleanly.' },
					{ name: 'pr-review', description: 'Review an open pull request.' },
				]

				const result = await manager.pullWorkspaceSkillsForAgent(actorId, workspaceId, '/tmp/agent')

				expect(storage.get).not.toHaveBeenCalled()
				expect(writeFile).toHaveBeenCalledTimes(1)
				expect(writeFile).toHaveBeenCalledWith(
					join('/tmp/agent/skills/.workspace-skills.md'),
					expect.any(String),
					'utf-8',
				)
				const written = vi.mocked(writeFile).mock.calls[0]?.[1] as string
				expect(written).toMatchSnapshot()
				// The index references the get_workspace_skill tool by name; the AC
				// is that no full SKILL.md *body* is inlined. storage.get above is the
				// authoritative check (no S3 fetch = no body), and we keep the file
				// short (one bullet per skill) on top.
				expect(written.length).toBeLessThan(1024)
				expect(result.pulled).toBe(2)
				expect(result.skipped).toBe(0)
				expect(result.failures).toEqual([])
			})

			it('falls back to (no description) when the skill row has no description', async () => {
				mockResults.select = [
					{ name: 'orphan-skill', description: null },
					{ name: 'blank-skill', description: '   ' },
				]

				await manager.pullWorkspaceSkillsForAgent(actorId, workspaceId, '/tmp/agent')

				const written = vi.mocked(writeFile).mock.calls[0]?.[1] as string
				expect(written).toContain('- **blank-skill**: (no description)')
				expect(written).toContain('- **orphan-skill**: (no description)')
			})

			it('is a no-op when the agent has no attached skills', async () => {
				mockResults.select = []

				const result = await manager.pullWorkspaceSkillsForAgent(actorId, workspaceId, '/tmp/agent')

				expect(storage.get).not.toHaveBeenCalled()
				expect(writeFile).not.toHaveBeenCalled()
				expect(result.pulled).toBe(0)
			})

			it('omits skills whose folder already exists on disk (agent-local wins)', async () => {
				mockResults.select = [
					{ name: 'deploy-check', description: 'Verify deploy.' },
					{ name: 'pr-review', description: 'Review a PR.' },
				]
				// deploy-check exists locally, pr-review does not
				const existingFolder = join('/tmp/agent/skills/deploy-check')
				;(stat as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
					if (path === existingFolder) {
						return { isDirectory: () => true } as { isDirectory: () => boolean }
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
				})

				const result = await manager.pullWorkspaceSkillsForAgent(actorId, workspaceId, '/tmp/agent')

				const written = vi.mocked(writeFile).mock.calls[0]?.[1] as string
				expect(written).toContain('- **pr-review**:')
				expect(written).not.toContain('- **deploy-check**:')
				expect(result.pulled).toBe(1)
				expect(result.skipped).toBe(1)
			})
		})
	})
})
