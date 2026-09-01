import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateLLMAdapter = vi.fn()
vi.mock('../../lib/llm', () => ({
	createLLMAdapter: (...args: unknown[]) => mockCreateLLMAdapter(...args),
}))

const mockResolveChatCredentials = vi.fn()
vi.mock('../../lib/llm-routing', () => ({
	resolveChatCredentials: (...args: unknown[]) => mockResolveChatCredentials(...args),
}))

const mockCollectBriefingFacts = vi.fn()
vi.mock('../../services/workspace-briefing', () => ({
	collectBriefingFacts: (...args: unknown[]) => mockCollectBriefingFacts(...args),
}))

import {
	briefCacheKey,
	briefInputHash,
	buildScriptInstruction,
	deriveHeadline,
	formatSpokenFallback,
	generateSpokenBrief,
	resolveMentionedIds,
	utcDateStamp,
} from '../../services/spoken-brief'
import type { BriefingBetFact, BriefingFacts } from '../../services/workspace-briefing'

const BET_ID = '11111111-2222-4333-8444-555555555555'
const INSIGHT_ID = '99999999-2222-4333-8444-555555555555'
const WS_ID = 'aaaaaaaa-2222-4333-8444-555555555555'
const AGENT_ID = 'bbbbbbbb-2222-4333-8444-555555555555'

function buildFacts(overrides: Partial<BriefingFacts> = {}): BriefingFacts {
	return {
		workspaceId: WS_ID,
		found: true,
		workspaceName: 'Growth',
		labels: { bet: 'Bet', task: 'Task', insight: 'Insight' },
		activeBets: [
			{
				id: BET_ID,
				title: 'Cut signup friction',
				status: 'active',
				appetite: '2 weeks',
				verdict: null,
				excerpt: 'Onboarding drops 40% at the email step.',
				progress: { done: 3, total: 5 },
			},
		],
		pausedBets: [],
		closedBets: [],
		openInsights: [{ id: INSIGHT_ID, title: 'Support tickets spike on Mondays' }],
		ledgerLines: [],
		closedBetsDays: 30,
		...overrides,
	}
}

/** In-memory StorageProvider — the brief cache is the only thing it holds. */
function fakeStorage() {
	const files = new Map<string, Buffer>()
	return {
		files,
		put: vi.fn(async (key: string, data: Buffer) => {
			files.set(key, data)
		}),
		get: vi.fn(async (key: string) => {
			const found = files.get(key)
			if (!found) throw new Error(`no such key: ${key}`)
			return found
		}),
		exists: vi.fn(async (key: string) => files.has(key)),
		delete: vi.fn(async (key: string) => {
			files.delete(key)
		}),
		list: vi.fn(async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix))),
		listWithMetadata: vi.fn(async () => []),
		ensureBucket: vi.fn(async () => {}),
	}
}

/**
 * `generateSpokenBrief` makes two kinds of read: the workspace row, then the
 * agent via a `workspace_members` join. This returns each in turn.
 */
function fakeDb(rows: { workspace?: unknown; agent?: unknown }) {
	const workspaceRows = rows.workspace ? [rows.workspace] : []
	const agentRows = rows.agent ? [{ actor: rows.agent }] : []
	return {
		select: vi.fn((projection?: unknown) => {
			// The agent lookup selects `{ actor: actors }`; the workspace read
			// selects everything.
			const isJoin = projection !== undefined
			const result = isJoin ? agentRows : workspaceRows
			// Every read in the service ends in `.limit()`, so the chain never
			// needs to be thenable.
			const chain = {
				from: () => chain,
				innerJoin: () => chain,
				where: () => chain,
				limit: async () => result,
			}
			return chain
		}),
	}
}

function buildWorkspaceRow(settings: Record<string, unknown> = {}) {
	return { id: WS_ID, name: 'Growth', settings }
}

function buildAgentRow(overrides: Record<string, unknown> = {}) {
	return {
		id: AGENT_ID,
		name: 'Chief of Staff',
		type: 'agent',
		systemPrompt: 'You are the Chief of Staff.',
		llmProvider: 'anthropic',
		llmConfig: { api_key: 'sk-test', model: 'claude-haiku-4-5-20251001' },
		...overrides,
	}
}

// biome-ignore lint/suspicious/noExplicitAny: the fakes are structural stand-ins
type AnyDb = any

describe('buildScriptInstruction', () => {
	it('tells the model the text will be spoken, not read', () => {
		const instruction = buildScriptInstruction(buildFacts().labels)
		expect(instruction).toMatch(/spoken aloud/i)
	})

	it('bans the syntax that would be read out as noise', () => {
		const instruction = buildScriptInstruction(buildFacts().labels)
		for (const banned of ['Headings', 'bullet points', 'markdown', 'object ids']) {
			expect(instruction).toContain(banned)
		}
	})

	it('leaves the judgment call to the agent it is appended to', () => {
		// The task block sets form only — how opinionated the brief is comes
		// from the agent's own system prompt, which is the editable part.
		const instruction = buildScriptInstruction(buildFacts().labels)
		expect(instruction).toMatch(/You choose what leads/)
	})

	it('uses the workspace vocabulary for its examples', () => {
		const labels = { bet: 'Wager', task: 'Step', insight: 'Signal' }
		expect(buildScriptInstruction(labels)).toContain('wagers')
	})
})

describe('briefInputHash', () => {
	it('is stable for identical facts', () => {
		expect(briefInputHash(buildFacts())).toBe(briefInputHash(buildFacts()))
	})

	it('changes when a bet moves', () => {
		const moved = buildFacts({
			activeBets: [{ ...buildFacts().activeBets[0], status: 'paused' } as BriefingBetFact],
		})
		expect(briefInputHash(moved)).not.toBe(briefInputHash(buildFacts()))
	})

	it('changes when task progress advances', () => {
		const advanced = buildFacts({
			activeBets: [
				{ ...buildFacts().activeBets[0], progress: { done: 4, total: 5 } } as BriefingBetFact,
			],
		})
		expect(briefInputHash(advanced)).not.toBe(briefInputHash(buildFacts()))
	})
})

describe('briefCacheKey', () => {
	it('keys by workspace and UTC day', () => {
		expect(briefCacheKey(WS_ID, new Date('2026-08-19T23:30:00Z'))).toBe(
			`briefs/${WS_ID}/2026-08-19.json`,
		)
	})

	it('rolls over at UTC midnight, not local midnight', () => {
		expect(utcDateStamp(new Date('2026-08-20T00:30:00Z'))).toBe('2026-08-20')
	})
})

describe('deriveHeadline', () => {
	it('takes the first sentence, since the script titles itself', () => {
		expect(deriveHeadline('Signup is the one to watch. Everything else is fine.')).toBe(
			'Signup is the one to watch.',
		)
	})

	it('falls back to the whole script when there is no sentence break', () => {
		expect(deriveHeadline('Nothing needs you today')).toBe('Nothing needs you today')
	})

	it('truncates a runaway first sentence', () => {
		expect(deriveHeadline(`${'a'.repeat(300)}.`)).toHaveLength(140)
	})
})

describe('resolveMentionedIds', () => {
	it('always includes the active bets the brief is about', () => {
		expect(resolveMentionedIds(buildFacts(), 'Nothing much happened.')).toContain(BET_ID)
	})

	it('picks up an insight the script actually names', () => {
		const ids = resolveMentionedIds(
			buildFacts(),
			'Support tickets spike on Mondays, which is worth a look.',
		)
		expect(ids).toContain(INSIGHT_ID)
	})

	it('does not match on a title too short to be distinctive', () => {
		const facts = buildFacts({
			activeBets: [],
			openInsights: [{ id: INSIGHT_ID, title: 'Ops' }],
		})
		expect(resolveMentionedIds(facts, 'Operations are steady.')).not.toContain(INSIGHT_ID)
	})
})

describe('formatSpokenFallback', () => {
	it('writes sentences, never markdown or bullets', () => {
		const prose = formatSpokenFallback(buildFacts())
		expect(prose).not.toMatch(/[#*`_]|^- /m)
		expect(prose).toMatch(/\.$/)
	})

	it('spells out counts so the voice does not read bare digits', () => {
		const prose = formatSpokenFallback(buildFacts())
		expect(prose).toContain('three of five')
		expect(prose).not.toMatch(/\b3\/5\b/)
	})

	it('says so plainly when the workspace is empty', () => {
		const prose = formatSpokenFallback(buildFacts({ activeBets: [], openInsights: [] }))
		expect(prose).toContain('Nothing is running in Growth right now.')
		expect(prose).toContain('Nothing needs you today.')
	})
})

describe('generateSpokenBrief', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCollectBriefingFacts.mockResolvedValue(buildFacts())
	})

	it('has the workspace agent write it, using its own system prompt', async () => {
		const chat = vi.fn().mockResolvedValue({ content: 'Signup is the one to watch.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'anthropic',
			apiKey: 'sk-test',
			model: 'claude-haiku-4-5-20251001',
		})

		const brief = await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)

		expect(brief.source).toBe('agent')
		expect(brief.script).toBe('Signup is the one to watch.')
		expect(brief.agent).toEqual({ id: AGENT_ID, name: 'Chief of Staff' })
		const system = chat.mock.calls[0]?.[0].messages[0].content
		expect(system).toContain('You are the Chief of Staff.')
		expect(system).toMatch(/spoken aloud/i)
	})

	it('caps the completion so a brief cannot run away', async () => {
		const chat = vi.fn().mockResolvedValue({ content: 'Short.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'openai',
			apiKey: 'sk',
			model: 'gpt-4o-mini',
		})

		await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)
		expect(chat.mock.calls[0]?.[0].max_tokens).toBeLessThanOrEqual(700)
	})

	it('serves a second request from cache without calling the model again', async () => {
		const chat = vi.fn().mockResolvedValue({ content: 'Signup is the one to watch.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'anthropic',
			apiKey: 'sk',
			model: 'm',
		})
		const storage = fakeStorage()
		const db = fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb

		const first = await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		const second = await generateSpokenBrief(db, storage as AnyDb, WS_ID)

		expect(first.source).toBe('agent')
		expect(first.cached).toBe(false)
		expect(second.cached).toBe(true)
		// The cache must not launder authorship: a cached agent brief is still an
		// agent brief, and every field the card renders survives the round-trip.
		expect(second).toEqual({ ...first, cached: true })
		expect(chat).toHaveBeenCalledTimes(1)
	})

	it('rewrites when the workspace has changed under the cache', async () => {
		const chat = vi.fn().mockResolvedValue({ content: 'Signup is the one to watch.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'anthropic',
			apiKey: 'sk',
			model: 'm',
		})
		const storage = fakeStorage()
		const db = fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb

		await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		mockCollectBriefingFacts.mockResolvedValue(
			buildFacts({
				activeBets: [{ ...buildFacts().activeBets[0], status: 'paused' } as BriefingBetFact],
			}),
		)
		const second = await generateSpokenBrief(db, storage as AnyDb, WS_ID)

		expect(second.source).toBe('agent')
		expect(second.cached).toBe(false)
		expect(chat).toHaveBeenCalledTimes(2)
	})

	it('falls back to prose when the workspace has no chat-callable credentials', async () => {
		// Not an error state — a Claude-OAuth-only workspace lands here.
		mockResolveChatCredentials.mockReturnValue(null)

		const brief = await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)

		expect(brief.source).toBe('fallback')
		expect(brief.script).toContain('Cut signup friction')
		expect(mockCreateLLMAdapter).not.toHaveBeenCalled()
		// An agent resolved, but it never wrote anything — crediting it would tell
		// the reader a named colleague produced concatenated prose.
		expect(brief.agent).toBeNull()
	})

	it('reuses the credential-less fallback, which is deterministic anyway', async () => {
		mockResolveChatCredentials.mockReturnValue(null)
		const storage = fakeStorage()
		const db = fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb

		const first = await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		const second = await generateSpokenBrief(db, storage as AnyDb, WS_ID)

		expect(first.cached).toBe(false)
		expect(second.cached).toBe(true)
		expect(second.source).toBe('fallback')
		expect(second.agent).toBeNull()
	})

	it('never caches a fallback caused by a failed call, so a retry can succeed', async () => {
		// The failure is transient. Caching it would pin the workspace to
		// degraded prose until the facts change or UTC midnight, and every press
		// of play would read the failure back and look like it had worked.
		const chat = vi
			.fn()
			.mockRejectedValueOnce(new Error('503 upstream'))
			.mockResolvedValue({ content: 'Signup is the one to watch.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'openai',
			apiKey: 'sk',
			model: 'm',
		})
		const storage = fakeStorage()
		const db = fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb

		const failed = await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		expect(failed.source).toBe('fallback')

		const retried = await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		expect(retried.cached).toBe(false)
		expect(retried.source).toBe('agent')
		expect(retried.script).toBe('Signup is the one to watch.')
		expect(chat).toHaveBeenCalledTimes(2)
	})

	it('never caches a fallback caused by an empty completion either', async () => {
		const chat = vi
			.fn()
			.mockResolvedValueOnce({ content: '  ' })
			.mockResolvedValue({ content: 'Written on the retry.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'openai',
			apiKey: 'sk',
			model: 'm',
		})
		const storage = fakeStorage()
		const db = fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb

		await generateSpokenBrief(db, storage as AnyDb, WS_ID)
		const retried = await generateSpokenBrief(db, storage as AnyDb, WS_ID)

		expect(retried.source).toBe('agent')
		expect(retried.script).toBe('Written on the retry.')
	})

	it('falls back to prose rather than throwing when the model call fails', async () => {
		mockCreateLLMAdapter.mockReturnValue({
			chat: vi.fn().mockRejectedValue(new Error('402 insufficient credits')),
		})
		mockResolveChatCredentials.mockReturnValue({
			provider: 'openai',
			apiKey: 'sk',
			model: 'm',
		})

		const brief = await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)
		expect(brief.source).toBe('fallback')
		expect(brief.agent).toBeNull()
	})

	it('falls back when the model returns an empty completion', async () => {
		// Reasoning models sometimes spend the whole budget before writing.
		mockCreateLLMAdapter.mockReturnValue({ chat: vi.fn().mockResolvedValue({ content: '  ' }) })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'openai',
			apiKey: 'sk',
			model: 'm',
		})

		const brief = await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow(), agent: buildAgentRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)
		expect(brief.source).toBe('fallback')
	})

	it('still produces a brief when the workspace has no agent at all', async () => {
		const brief = await generateSpokenBrief(
			fakeDb({ workspace: buildWorkspaceRow() }) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)
		expect(brief.source).toBe('fallback')
		expect(brief.agent).toBeNull()
	})

	it('prefers the workspace pinned default agent', async () => {
		const chat = vi.fn().mockResolvedValue({ content: 'Pinned.' })
		mockCreateLLMAdapter.mockReturnValue({ chat })
		mockResolveChatCredentials.mockReturnValue({
			provider: 'anthropic',
			apiKey: 'sk',
			model: 'm',
		})
		const pinned = buildAgentRow({ id: AGENT_ID, name: 'Relay' })

		const brief = await generateSpokenBrief(
			fakeDb({
				workspace: buildWorkspaceRow({ default_agent_id: AGENT_ID }),
				agent: pinned,
			}) as AnyDb,
			fakeStorage() as AnyDb,
			WS_ID,
		)
		expect(brief.agent?.name).toBe('Relay')
	})
})
