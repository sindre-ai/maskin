import { vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(Buffer.from('file content')),
	readdir: vi.fn().mockResolvedValue([]),
}))

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import type { StorageProvider } from '@maskin/storage'
import { AgentStorageManager } from '../../services/agent-storage'
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
			;(readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'))
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
			;(readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'))
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
})
