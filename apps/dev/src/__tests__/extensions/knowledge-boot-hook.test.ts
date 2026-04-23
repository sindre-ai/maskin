import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '@maskin/db'
import { knowledgeSessionBootHook } from '@maskin/ext-knowledge/boot-hook'
import { vi } from 'vitest'
import { createTestContext } from '../setup'

/**
 * These tests use a real temp dir instead of mocking fs. vi.mock('node:fs/promises')
 * does not apply to imports made from packages outside apps/dev in this workspace
 * setup, so mocking would silently no-op. A real fs in /tmp is cheap and verifies
 * the actual behavior end-to-end within the extension.
 */
describe('knowledge extension — sessionBootHook', () => {
	let db: Database
	let mockResults: Record<string, unknown>
	let tempDir: string

	beforeEach(async () => {
		vi.clearAllMocks()
		const ctx = createTestContext()
		db = ctx.db
		mockResults = ctx.mockResults
		tempDir = await mkdtemp(join(tmpdir(), 'knowledge-boot-test-'))
	})

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true })
	})

	it('writes validated knowledge articles as markdown files under tempDir/knowledge', async () => {
		mockResults.select = [
			{
				id: 'article-1',
				title: 'Never push to main',
				content: 'Always open a PR first.',
				metadata: { summary: 'Git workflow rule', confidence: 'high' },
				updatedAt: new Date(),
			},
			{
				id: 'article-2',
				title: 'Cap outreach at 50/day',
				content: 'Per-inbox daily cap.',
				metadata: { summary: 'Outreach send cap' },
				updatedAt: new Date(),
			},
		]

		await knowledgeSessionBootHook({ db, workspaceId: 'ws-1', tempDir })

		const first = await readFile(join(tempDir, 'knowledge', 'article-1.md'), 'utf8')
		expect(first).toContain('## Never push to main')
		expect(first).toContain('Git workflow rule')
		expect(first).toContain('Always open a PR first.')
		expect(first).toContain('[maskin://objects/article-1]')

		const second = await readFile(join(tempDir, 'knowledge', 'article-2.md'), 'utf8')
		expect(second).toContain('## Cap outreach at 50/day')
		expect(second).toContain('Outreach send cap')
	})

	it('writes nothing when no validated articles exist', async () => {
		mockResults.select = []

		await knowledgeSessionBootHook({ db, workspaceId: 'ws-1', tempDir })

		await expect(
			readFile(join(tempDir, 'knowledge', 'anything.md'), 'utf8'),
		).rejects.toThrow()
	})

	it('swallows DB errors so session startup is not blocked', async () => {
		const throwingDb = new Proxy(db, {
			get(target, prop) {
				if (prop === 'select') {
					return () => {
						throw new Error('db unavailable')
					}
				}
				return Reflect.get(target, prop)
			},
		})

		await expect(
			knowledgeSessionBootHook({ db: throwingDb, workspaceId: 'ws-1', tempDir }),
		).resolves.toBeUndefined()
	})
})
