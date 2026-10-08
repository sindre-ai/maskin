import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it, vi } from 'vitest'
import {
	appendToLedger,
	buildWorkspaceStartupBlock,
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

	it('describes the workspace terrain: briefing file, bets, tools, verdict, learning', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('/agent/workspace/WORKSPACE.md')
		expect(block).toContain('Active bets')
		expect(block).toContain('metadata.verdict')
		expect(block).toContain('SESSION_LEARNING.md')
	})

	it('tells unwatched runs to go ahead on reversible steps and not end on a plan, question or promise', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('Nobody is watching this run and nobody can answer mid-run')
		expect(block).toContain('"Shall I...?" or "Want me to...?" just blocks the work')
		expect(block).toContain(
			"If it's a plan, a question or a promise, do that work now. End only when the work is done or you're blocked on something only a person can give.",
		)
	})

	it('gives every session the try-first, do-it-now wording, interactive or not', () => {
		for (const interactive of [false, true]) {
			const block = buildWorkspaceStartupBlock({ ...args, interactive })
			expect(block).toContain(
				'Do the work, don\'t describe it. If your next step is something your tools can do, do it in this turn. Don\'t end with "I\'ll..." or "next I would...".',
			)
			expect(block).toContain(
				'Look before you ask. Read the object, its comments, the knowledge base and the code first. If another agent would know, ask that agent: @mention it on the object, or use run_agent if you need the answer now. Ask a person only for the cases below.',
			)
			expect(block).toContain(
				"Don't promise later work you haven't scheduled. If you say you'll check or do something later, set it up before you end: create a trigger for yourself, or @mention the agent who owns it. If you haven't, do it now or say plainly that it's still open.",
			)
			expect(block).toContain(
				"Done means checked. Before you say done, compare the result with what was asked and say what you checked. If you're blocked, say what blocked you and what you tried. Never make up a result.",
			)
			expect(block).toContain(
				"Ask a person first before you do anything outside the company or that costs money, or delete anything. For everything else that's reversible, go ahead and note what you did.",
			)
		}
	})

	it('gives chats the chat wording and not the unwatched-run wording', () => {
		const block = buildWorkspaceStartupBlock({ ...args, interactive: true })
		expect(block).toContain(
			'If they ask a question, think out loud or describe a problem, give your assessment and stop. Make changes when they ask for one.',
		)
		expect(block).not.toContain('Nobody is watching this run')
	})

	it('gives unwatched runs the unwatched-run wording and not the chat wording', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).toContain('Nobody is watching this run')
		expect(block).not.toContain('give your assessment and stop')
	})

	it('adds no shouty wording', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).not.toMatch(/\b(CRITICAL|MUST|NEVER|ALWAYS)\b/)
	})

	it('no longer says "You decide how to achieve the goal" (it never stated a goal)', () => {
		const block = buildWorkspaceStartupBlock(args)
		expect(block).not.toContain('You decide how to achieve the goal')
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
		mockResults.selectQueue = [[ws], [], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('No active bets')
		expect(result).not.toContain('Consider proposing one from an open')
	})

	it('shows the insight suggestion when insights exist but no active bets', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		const insight = buildObject({ workspaceId: ws.id, type: 'insight', status: 'new' })
		mockResults.selectQueue = [[ws], [], [], [], [insight], []]

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
		mockResults.selectQueue = [[ws], [], [], [closed], [], []]

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
		mockResults.selectQueue = [[ws], [], [paused], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('## Paused bets')
		expect(result).toContain('**Self-serve onboarding**')
		expect(result).toContain('not part of the current cycle')
	})

	it('omits the paused section entirely when no paused bets exist', async () => {
		const { db, mockResults } = createTestContext()
		const storage = createMockStorage()
		const ws = buildWorkspace()
		mockResults.selectQueue = [[ws], [], [], [], [], []]

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
		mockResults.selectQueue = [[ws], [], [], [], [], []]

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
				display_names: {
					insight: 'Signal',
					bet: 'Initiative',
					task: 'Action',
				},
			},
		})
		mockResults.selectQueue = [[ws], [], [], [], []]

		const result = await renderWorkspaceBriefing(db, storage, ws.id)
		expect(result).toContain('## Active initiatives')
		expect(result).toContain('## Open signals')
	})
})
