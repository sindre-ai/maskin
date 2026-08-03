import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it, vi } from 'vitest'
import {
	appendToLedger,
	buildWorkspaceStartupBlock,
	readLedgerTail,
	workspaceLedgerKey,
} from '../../services/workspace-briefing'

function createMockStorage(overrides?: Partial<StorageProvider>): StorageProvider {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('')),
		list: vi.fn().mockResolvedValue([]),
		listWithMetadata: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as StorageProvider
}

describe('workspaceLedgerKey', () => {
	it('scopes ledger path to the workspace under a reserved _workspace prefix', () => {
		expect(workspaceLedgerKey('ws-123')).toBe('agents/ws-123/_workspace/learnings.md')
	})
})

describe('appendToLedger', () => {
	it('creates the ledger with a single line on first write', async () => {
		const storage = createMockStorage({ exists: vi.fn().mockResolvedValue(false) })
		await appendToLedger(storage, 'ws-1', 'first entry')
		expect(storage.put).toHaveBeenCalledWith(
			'agents/ws-1/_workspace/learnings.md',
			Buffer.from('first entry\n', 'utf-8'),
		)
	})

	it('appends to an existing ledger', async () => {
		const storage = createMockStorage({
			exists: vi.fn().mockResolvedValue(true),
			get: vi.fn().mockResolvedValue(Buffer.from('old line\n')),
		})
		await appendToLedger(storage, 'ws-1', 'new line')
		expect(storage.put).toHaveBeenCalledWith(
			'agents/ws-1/_workspace/learnings.md',
			Buffer.from('old line\nnew line\n', 'utf-8'),
		)
	})

	it('caps ledger at 1000 lines (oldest drop)', async () => {
		const existing = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n')
		const storage = createMockStorage({
			exists: vi.fn().mockResolvedValue(true),
			get: vi.fn().mockResolvedValue(Buffer.from(`${existing}\n`)),
		})
		await appendToLedger(storage, 'ws-1', 'new line')
		const call = (storage.put as ReturnType<typeof vi.fn>).mock.calls[0]
		const written = (call[1] as Buffer).toString('utf-8')
		const lines = written.split('\n').filter((l) => l.length > 0)
		expect(lines).toHaveLength(1000)
		expect(lines[0]).toBe('line-1') // line-0 dropped
		expect(lines.at(-1)).toBe('new line')
	})

	it('skips empty lines after normalization', async () => {
		const storage = createMockStorage()
		await appendToLedger(storage, 'ws-1', '   \n  ')
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('collapses embedded newlines into spaces', async () => {
		const storage = createMockStorage()
		await appendToLedger(storage, 'ws-1', 'a\nb\r\nc')
		const call = (storage.put as ReturnType<typeof vi.fn>).mock.calls[0]
		expect((call[1] as Buffer).toString('utf-8')).toBe('a b c\n')
	})

	it('skips append if exists() throws (avoids silent wipe)', async () => {
		const storage = createMockStorage({
			exists: vi.fn().mockRejectedValue(new Error('S3 down')),
		})
		await appendToLedger(storage, 'ws-1', 'new line')
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('skips append if get() throws after exists() returns true (avoids silent wipe)', async () => {
		// This is the dangerous path: without the guard, a transient read error
		// would fall through to an empty baseline and the put would overwrite
		// the entire ledger with just the new line.
		const storage = createMockStorage({
			exists: vi.fn().mockResolvedValue(true),
			get: vi.fn().mockRejectedValue(new Error('read timed out')),
		})
		await appendToLedger(storage, 'ws-1', 'new line')
		expect(storage.put).not.toHaveBeenCalled()
	})
})

describe('readLedgerTail', () => {
	it('returns empty array when ledger does not exist', async () => {
		const storage = createMockStorage({ exists: vi.fn().mockResolvedValue(false) })
		const result = await readLedgerTail(storage, 'ws-1', 20)
		expect(result).toEqual([])
	})

	it('returns the last N non-empty lines', async () => {
		const storage = createMockStorage({
			exists: vi.fn().mockResolvedValue(true),
			get: vi.fn().mockResolvedValue(Buffer.from('a\nb\n\nc\nd\n')),
		})
		const result = await readLedgerTail(storage, 'ws-1', 3)
		expect(result).toEqual(['b', 'c', 'd'])
	})

	it('returns empty array on read error (ledger is best-effort)', async () => {
		const storage = createMockStorage({
			exists: vi.fn().mockRejectedValue(new Error('network down')),
		})
		const result = await readLedgerTail(storage, 'ws-1', 20)
		expect(result).toEqual([])
	})
})

describe('buildWorkspaceStartupBlock', () => {
	const args = {
		workspaceId: 'ws-abc',
		frontendUrl: 'https://maskin.io',
	}

	it('describes the workspace terrain: bets, tools, verdict, learning', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('Active bets')
		expect(block).toContain('metadata.verdict')
		expect(block).toContain('SESSION_LEARNING.md')
	})

	it('uses contextual framing rather than imperative step-by-step commands', () => {
		// Outcome-oriented models push back on prescriptive checklists — the
		// block should describe terrain, not dictate a sequence of actions.
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('You decide how to achieve the goal')
		expect(block).not.toMatch(/^\s*1\.\s+Read/m)
	})

	it('embeds the canonical object link format with the workspace id', () => {
		// The reporter saw agents emit `app.maskin.ai/objects/<id>` (wrong host,
		// no workspace segment). Pin the correct format into the briefing so
		// agents don't have to guess.
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('[title](https://maskin.io/ws-abc/objects/<id>)')
		expect(block).not.toContain('app.maskin.ai')
	})

	it('strips a trailing slash from the frontend URL before embedding it', () => {
		const block = buildWorkspaceStartupBlock({
			workspaceId: 'ws-abc',
			frontendUrl: 'https://maskin.io/',
		})
		expect(block).toContain('https://maskin.io/ws-abc/objects/<id>')
		expect(block).not.toContain('maskin.io//ws-abc')
	})
})
