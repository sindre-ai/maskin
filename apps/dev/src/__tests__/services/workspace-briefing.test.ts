import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it, vi } from 'vitest'
import {
	WORKSPACE_STARTUP_BLOCK,
	appendToLedger,
	readLedgerTail,
	renderWorkspaceBriefing,
	workspaceLedgerKey,
} from '../../services/workspace-briefing'
import { buildObject, buildRelationship, buildWorkspace } from '../factories'
import { createTestContext } from '../setup'

function createMockStorage(overrides?: Partial<StorageProvider>): StorageProvider {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('')),
		list: vi.fn().mockResolvedValue([]),
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

describe('WORKSPACE_STARTUP_BLOCK', () => {
	it('describes the workspace terrain: briefing file, bets, tools, verdict, learning', () => {
		expect(WORKSPACE_STARTUP_BLOCK).toContain('/agent/workspace/WORKSPACE.md')
		expect(WORKSPACE_STARTUP_BLOCK).toContain('Active bets')
		expect(WORKSPACE_STARTUP_BLOCK).toContain('metadata.verdict')
		expect(WORKSPACE_STARTUP_BLOCK).toContain('SESSION_LEARNING.md')
	})

	it('uses contextual framing rather than imperative step-by-step commands', () => {
		// Outcome-oriented models push back on prescriptive checklists — the
		// block should describe terrain, not dictate a sequence of actions.
		expect(WORKSPACE_STARTUP_BLOCK).toContain('You decide how to achieve the goal')
		expect(WORKSPACE_STARTUP_BLOCK).not.toMatch(/^\s*1\.\s+Read/m)
	})
})

describe('renderWorkspaceBriefing', () => {
	it('returns a not-found notice when workspace does not exist', async () => {
		const { db } = createTestContext()
		const storage = createMockStorage()
		const result = await renderWorkspaceBriefing(db, storage, 'ws-missing')
		expect(result).toContain('Workspace ws-missing')
		expect(result).toContain('not found')
	})

	it('renders empty-state placeholders when workspace has no objects or ledger', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace({ name: 'Empty WS' })
		mockResults.selectQueue = [
			[ws], // workspace lookup
			[], // active bets
			[], // paused bets
			[], // closed bets
			[], // open insights
		]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('# Empty WS — workspace briefing')
		expect(result).toContain('No active bets')
		expect(result).toContain('None in the last 30 days')
		expect(result).toContain('No open insights')
		expect(result).toContain('No prior session learnings yet')
	})

	it('omits the insight suggestion when no open insights exist', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		mockResults.selectQueue = [[ws], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('No active bets')
		expect(result).not.toContain('Consider proposing one from an open')
	})

	it('shows the insight suggestion when insights exist but no active bets', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		const insight = buildObject({ workspaceId: ws.id, type: 'insight', status: 'new' })
		mockResults.selectQueue = [[ws], [], [], [], [insight]]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('Consider proposing one from an open insight')
	})

	it('renders active bets with status, appetite, content excerpt, and id', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace({ name: 'Test' })
		const bet = buildObject({
			workspaceId: ws.id,
			type: 'bet',
			status: 'active',
			title: 'Ship the first end-to-end feature',
			content: 'Prove the full loop from signal to shipped value.',
			metadata: { appetite: '6 weeks' },
		})
		mockResults.selectQueue = [
			[ws], // workspace
			[bet], // active bets
			[], // paused bets
			[], // closed bets
			[], // open insights
			[], // child relationships
		]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('**Ship the first end-to-end feature** [active]')
		expect(result).toContain('appetite: 6 weeks')
		expect(result).toContain('Prove the full loop from signal to shipped value.')
		expect(result).toContain(`id: \`${bet.id}\``)
	})

	it('shows child task progress for active bets', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		const bet = buildObject({ workspaceId: ws.id, type: 'bet', status: 'active', title: 'Bet A' })
		const task1 = buildObject({ workspaceId: ws.id, type: 'task', status: 'done' })
		const task2 = buildObject({ workspaceId: ws.id, type: 'task', status: 'todo' })
		const rel1 = buildRelationship({ sourceId: bet.id, targetId: task1.id, type: 'breaks_into' })
		const rel2 = buildRelationship({ sourceId: bet.id, targetId: task2.id, type: 'breaks_into' })

		mockResults.selectQueue = [
			[ws],
			[bet],
			[], // paused
			[], // closed
			[], // insights
			[rel1, rel2], // child relationships
			[task1, task2], // child tasks
		]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('1/2 tasks done')
	})

	it('renders closed bets with verdict from metadata', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		const closed = buildObject({
			workspaceId: ws.id,
			type: 'bet',
			status: 'succeeded',
			title: 'Shipped onboarding',
			metadata: { verdict: 'Doubled day-1 activation, kept.' },
		})
		mockResults.selectQueue = [[ws], [], [], [closed], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('**Shipped onboarding** [succeeded] — Doubled day-1 activation')
	})

	it('renders paused bets in their own section when present', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		const paused = buildObject({
			workspaceId: ws.id,
			type: 'bet',
			status: 'paused',
			title: 'Self-serve onboarding',
		})
		mockResults.selectQueue = [[ws], [], [paused], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('## Paused bets')
		expect(result).toContain('**Self-serve onboarding**')
		expect(result).toContain('not part of the current cycle')
	})

	it('omits the paused section entirely when no paused bets exist', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		mockResults.selectQueue = [[ws], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).not.toContain('## Paused bets')
	})

	it('surfaces ledger lines under "Recent workspace learnings"', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage({
			exists: vi.fn().mockResolvedValue(true),
			get: vi
				.fn()
				.mockResolvedValue(Buffer.from('2026-04-20 · session abcd1234 · tried the outreach bet\n')),
		})
		const ws = buildWorkspace()
		mockResults.selectQueue = [[ws], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('Recent workspace learnings')
		expect(result).toContain('tried the outreach bet')
	})

	it('respects custom display_names from workspace settings', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace({
			name: 'Custom',
			settings: {
				display_names: { insight: 'Signal', bet: 'Initiative', task: 'Action' },
			},
		})
		mockResults.selectQueue = [[ws], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('## Active initiatives')
		expect(result).toContain('## Open signals')
	})
})
