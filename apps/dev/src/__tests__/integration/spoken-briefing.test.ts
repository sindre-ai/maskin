import { workspaceMembers, workspaces } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefCacheCleaner } from '../../services/brief-cache-cleaner'
import { briefCacheKey, generateSpokenBrief } from '../../services/spoken-brief'
import {
	collectBriefingFacts,
	formatAgentBriefing,
	renderWorkspaceBriefing,
} from '../../services/workspace-briefing'
import { insertActor, insertObject, insertRelationship, insertWorkspace } from '../factories'
import { db } from './global-setup'

/** In-memory StorageProvider — the ledger and the brief cache both live here. */
function createMemoryStorage(): StorageProvider & { files: Map<string, Buffer> } {
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
		list: vi.fn(async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix))),
		listWithMetadata: vi.fn(async () => []),
		delete: vi.fn(async (key: string) => {
			files.delete(key)
		}),
		exists: vi.fn(async (key: string) => files.has(key)),
		ensureBucket: vi.fn(async () => undefined),
	} as unknown as StorageProvider & { files: Map<string, Buffer> }
}

async function seedAgent(workspaceId: string, name: string, overrides = {}) {
	const agent = await insertActor(db, {
		type: 'agent',
		name,
		systemPrompt: `You are ${name}.`,
		llmProvider: 'anthropic',
		llmConfig: {},
		...overrides,
	})
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

describe('spoken briefing', () => {
	let workspaceId: string
	let actorId: string
	let storage: StorageProvider & { files: Map<string, Buffer> }

	beforeEach(async () => {
		const actor = await insertActor(db)
		actorId = actor.id
		const workspace = await insertWorkspace(db, actorId)
		workspaceId = workspace.id
		storage = createMemoryStorage()
	})

	describe('collectBriefingFacts', () => {
		// The refactor that introduced the facts layer had to leave the
		// agent-facing document byte-identical — it is written to
		// /agent/workspace/WORKSPACE.md at every session start.
		it('reproduces the agent briefing exactly through the new formatter', async () => {
			const bet = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
				title: 'Cut signup friction',
				content: 'Onboarding drops 40% at the email step.',
				metadata: { appetite: '2 weeks' },
			})
			const task = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'done',
				title: 'Instrument the funnel',
			})
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				targetType: 'object',
				sourceId: bet.id,
				targetId: task.id,
				type: 'breaks_into',
			})
			await insertObject(db, workspaceId, actorId, {
				type: 'insight',
				status: 'open',
				title: 'Support tickets spike on Mondays',
			})

			const facts = await collectBriefingFacts(db, storage, workspaceId)
			expect(formatAgentBriefing(facts)).toBe(
				await renderWorkspaceBriefing(db, storage, workspaceId),
			)
		})

		it('carries child-task progress only on active bets', async () => {
			const active = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
				title: 'Active bet',
			})
			const paused = await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'paused',
				title: 'Paused bet',
			})
			const done = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'done' })
			const open = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				targetType: 'object',
				sourceId: active.id,
				targetId: done.id,
				type: 'breaks_into',
			})
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				targetType: 'object',
				sourceId: active.id,
				targetId: open.id,
				type: 'breaks_into',
			})
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				targetType: 'object',
				sourceId: paused.id,
				targetId: done.id,
				type: 'breaks_into',
			})

			const facts = await collectBriefingFacts(db, storage, workspaceId)
			expect(facts.activeBets[0]?.progress).toEqual({ done: 1, total: 2 })
			expect(facts.pausedBets[0]?.progress).toBeNull()
		})

		it('degrades rather than throwing for a workspace that does not exist', async () => {
			const facts = await collectBriefingFacts(db, storage, '00000000-0000-4000-8000-000000000000')
			expect(facts.found).toBe(false)
			expect(formatAgentBriefing(facts)).toContain('Workspace not found.')
		})
	})

	describe('generateSpokenBrief', () => {
		beforeEach(async () => {
			await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
				title: 'Cut signup friction',
			})
		})

		it('produces speakable prose with no markdown, ids or MCP plumbing', async () => {
			const brief = await generateSpokenBrief(db, storage, workspaceId)

			expect(brief.script.length).toBeGreaterThan(0)
			expect(brief.script).not.toMatch(/^#|\n#|^\s*-\s|`|\*\*/m)
			expect(brief.script).not.toContain('Digging deeper')
			expect(brief.script).not.toContain('get_objects')
			expect(brief.script).not.toMatch(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
			)
		})

		it('names the active bets so the card can link them', async () => {
			const brief = await generateSpokenBrief(db, storage, workspaceId)
			expect(brief.mentionedIds).toHaveLength(1)
		})

		it('caches under the day and reuses it while the workspace is unchanged', async () => {
			const first = await generateSpokenBrief(db, storage, workspaceId)
			expect(storage.files.has(briefCacheKey(workspaceId, new Date()))).toBe(true)

			const second = await generateSpokenBrief(db, storage, workspaceId)
			expect(second.cached).toBe(true)
			expect(second.script).toBe(first.script)
		})

		it('rewrites once a bet actually moves', async () => {
			await generateSpokenBrief(db, storage, workspaceId)
			await insertObject(db, workspaceId, actorId, {
				type: 'bet',
				status: 'active',
				title: 'Ship the pricing page',
			})

			const second = await generateSpokenBrief(db, storage, workspaceId)
			expect(second.cached).toBe(false)
			expect(second.script).toContain('Ship the pricing page')
		})

		it('picks the Chief of Staff over the legacy Workspace Coach', async () => {
			await seedAgent(workspaceId, 'Workspace Coach')
			await seedAgent(workspaceId, 'Chief of Staff')

			const brief = await generateSpokenBrief(db, storage, workspaceId)
			expect(brief.agent?.name).toBe('Chief of Staff')
		})

		it('honours the workspace pinned default agent above either', async () => {
			await seedAgent(workspaceId, 'Chief of Staff')
			const relay = await seedAgent(workspaceId, 'Relay')
			await db
				.update(workspaces)
				.set({ settings: { default_agent_id: relay.id } })
				.where(eq(workspaces.id, workspaceId))

			const brief = await generateSpokenBrief(db, storage, workspaceId)
			expect(brief.agent?.name).toBe('Relay')
		})

		it('never borrows another workspace agent — actors are scoped by membership', async () => {
			// actors carries no workspace column, so a name lookup that skips
			// workspace_members would happily pick up the neighbour's agent.
			const otherOwner = await insertActor(db)
			const other = await insertWorkspace(db, otherOwner.id)
			await seedAgent(other.id, 'Chief of Staff')

			const brief = await generateSpokenBrief(db, storage, workspaceId)
			expect(brief.agent).toBeNull()
		})
	})

	describe('BriefCacheCleaner', () => {
		it('deletes yesterday and leaves today alone', async () => {
			const today = new Date()
			const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
			await generateSpokenBrief(db, storage, workspaceId)
			const staleKey = briefCacheKey(workspaceId, yesterday)
			await storage.put(staleKey, Buffer.from('{}'))

			await new BriefCacheCleaner(storage).tick(today)

			expect(storage.files.has(staleKey)).toBe(false)
			expect(storage.files.has(briefCacheKey(workspaceId, today))).toBe(true)
		})

		it('leaves the workspace learnings ledger untouched', async () => {
			// The ledger lives under agents/, not briefs/ — a sweep that used a
			// looser prefix would silently eat every session's learnings.
			const ledgerKey = `agents/${workspaceId}/_workspace/learnings.md`
			await storage.put(ledgerKey, Buffer.from('a prior learning\n'))

			await new BriefCacheCleaner(storage).tick(new Date())

			expect(storage.files.has(ledgerKey)).toBe(true)
		})
	})
})
