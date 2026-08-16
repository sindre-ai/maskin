import { randomUUID } from 'node:crypto'
import {
	events,
	actors,
	agentSkills,
	objects,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, count, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import {
	AGENT_BUILDER_ACTOR_NAME,
	getOrBootstrapAgentBuilderActor,
} from '../../services/agent-builder-bootstrap'
import { AgentStorageManager, workspaceSkillKey } from '../../services/agent-storage'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The reviewer and refine paths make one or more LLM calls before writing to
// the DB. Mocking at the callLlm() boundary lets the DB writes run against
// real Postgres (the whole point of an integration test) without opening a
// socket to OpenRouter.
vi.mock('../../services/llm-call', () => ({
	callLlm: vi.fn(),
}))

// PostHog capture is fire-and-forget; short-circuit so a missing key never
// prints a warning during the run.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { callLlm: mockedCallLlm } = await import('../../services/llm-call')
const callLlm = mockedCallLlm as unknown as ReturnType<typeof vi.fn>

const { AgentReviewTargetError, loadReviewTarget, refineAgent, reviewWork } = await import(
	'../../services/agent-builder'
)

const REVIEWER_PASS_VERDICT = JSON.stringify({
	criteria: [
		{ name: 'persona_specificity', pass: true, fix: '' },
		{ name: 'opinionation_scaffolding_present', pass: true, fix: '' },
		{ name: 'worked_examples_at_least_two', pass: true, fix: '' },
		{ name: 'no_hedging_enforcement', pass: true, fix: '' },
		{ name: 'scope_boundaries_named', pass: true, fix: '' },
	],
	overall: 'pass',
})

const STAGE3_JSON = JSON.stringify({
	background:
		'Sable is a migration architect who has shipped hundreds of schema changes to hot Postgres tables. Bias: favours Postgres idioms.',
	instructions: [
		'Ask for the target table row count before proposing a plan.',
		'Prefer shadow-write + backfill + cut-over over ALTER TABLE.',
	],
	decision_framework:
		'Apply the three-step framework: shadow-write, backfill in chunks, cut over behind a feature flag.',
	tool_guidance:
		'Reach for postgres_mcp to inspect table stats. Use github_mcp to open the migration PR.',
	output_format:
		'Every response has: Diagnosis, Plan (numbered), Risks, Recommendation, Assumptions.',
	bias_statement:
		'Under-values logical replication for cross-region setups; over-indexes on Postgres conventions when advising on MySQL.',
	worked_examples: [
		{
			title: 'Add NOT NULL column to hot table',
			ask: 'How do we add a NOT NULL column without downtime?',
			response:
				'Diagnosis: standard ALTER holds ACCESS EXCLUSIVE. Plan: add nullable, backfill, CHECK NOT VALID, VALIDATE. Recommendation: Ship the five-step plan behind a feature flag. Assumptions: table is under 1TB.',
		},
		{
			title: 'Rename a column in production',
			ask: 'Can we just rename user_id to account_id?',
			response:
				'Diagnosis: in-place rename breaks readers. Plan: add new column, dual-write, backfill, switch, drop. Recommendation: Reject the one-shot rename. Assumptions: all readers live in this monorepo.',
		},
	],
})

const STAGE4_JSON = JSON.stringify({
	opinionation_clause:
		'End every in-domain response with a "Recommendation:" line and an "Assumptions:" line. Do not use "might", "could", or "it depends" in the closing block.',
	recommendation_openings: [
		'Ship the shadow-write plan behind a feature flag.',
		'Reject the migration and run a dual-write for one sprint.',
	],
	assumption_openings: ['Assuming the table is under 1TB', 'If autovacuum is tuned'],
})

/**
 * Minimal in-memory StorageProvider so the SKILL.md republish inside
 * `refineAgent` runs its real code path without needing SeaweedFS in CI.
 * Mirrors the shape used by `workspace-skills.test.ts`.
 */
function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
		async put(key, data) {
			if (Buffer.isBuffer(data)) {
				store.set(key, data)
			} else if (data instanceof Uint8Array) {
				store.set(key, Buffer.from(data))
			} else {
				throw new Error('Streaming put not supported in memory storage')
			}
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

describe('agent-builder service integration', () => {
	beforeEach(() => {
		callLlm.mockReset()
	})

	describe('reviewWork', () => {
		it('reviews an object.content payload and writes a reviewer_verdict_submitted events row', async () => {
			callLlm.mockResolvedValueOnce({ ok: true, content: REVIEWER_PASS_VERDICT })

			const ws = await insertWorkspace(db, getTestActorId())
			const draft = await insertObject(db, ws.id, getTestActorId(), {
				content:
					'# Draft SME agent\n\n## Response protocol\n\nEnd with Recommendation: and Assumptions:.',
			})

			const out = await reviewWork(db, {
				workspaceId: ws.id,
				actorId: getTestActorId(),
				objectId: draft.id,
			})

			expect(out.verdict.overall).toBe('pass')
			expect(out.verdict.criteria).toHaveLength(5)
			expect(out.targetActorId).toBeNull()
			expect(out.rubricId).toBeTruthy()

			// getOrBootstrapCanonicalRubric writes a workspace object on first call —
			// verify it landed with the expected type so a future run resolves it
			// instead of double-bootstrapping.
			const rubricRows = await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'agent_builder_rubric')))
			expect(rubricRows).toHaveLength(1)
			expect(rubricRows[0].id).toBe(out.rubricId)

			// reviewer_verdict_submitted event: entityType='object' (no target actor)
			// and entityId=rubricId per the reviewer's SSE-anchoring rule.
			const verdictEvents = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, ws.id), eq(events.action, 'reviewer_verdict_submitted')))
			expect(verdictEvents).toHaveLength(1)
			expect(verdictEvents[0].entityType).toBe('object')
			expect(verdictEvents[0].entityId).toBe(out.rubricId)
			expect(verdictEvents[0].actorId).toBe(getTestActorId())
			const data = verdictEvents[0].data as {
				overall: string
				cycle_number: number
				rubric_id: string
				failing_criteria: string[]
			}
			expect(data.overall).toBe('pass')
			expect(data.cycle_number).toBe(1)
			expect(data.rubric_id).toBe(out.rubricId)
			expect(data.failing_criteria).toEqual([])
		})
	})

	describe('refineAgent', () => {
		it('re-runs stages 3-4 against Postgres, updates the actor system_prompt, and audits the change', async () => {
			callLlm
				.mockResolvedValueOnce({ ok: true, content: STAGE3_JSON })
				.mockResolvedValueOnce({ ok: true, content: STAGE4_JSON })

			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertActor(db, {
				type: 'agent',
				name: 'Sable Ostrik',
				description: 'Use this agent when planning zero-downtime migrations.',
				systemPrompt: '# Sable Ostrik\n\n## Background\n\nprevious background text.',
				createdBy: getTestActorId(),
			})
			await db.insert(workspaceMembers).values({
				workspaceId: ws.id,
				actorId: agent.id,
				role: 'member',
			})

			const storage = createMemoryStorage()
			const agentStorage = new AgentStorageManager(storage, db)
			const initialSkillMd =
				'---\nname: sable-ostrik-abc12345\ndescription: Use this agent when planning zero-downtime migrations.\n---\n\nold body'
			const skillId = randomUUID()
			const storageKey = workspaceSkillKey(ws.id, skillId)
			await db.insert(workspaceSkills).values({
				id: skillId,
				workspaceId: ws.id,
				name: 'sable-ostrik-abc12345',
				description: 'Use this agent when planning zero-downtime migrations.',
				content: initialSkillMd,
				storageKey,
				sizeBytes: Buffer.byteLength(initialSkillMd, 'utf-8'),
				createdBy: getTestActorId(),
			})
			await db.insert(agentSkills).values({
				actorId: agent.id,
				workspaceSkillId: skillId,
			})

			const out = await refineAgent(
				{
					db,
					agentStorage,
					workspaceId: ws.id,
					actorId: getTestActorId(),
				},
				{
					actorId: agent.id,
					context: 'Sharpen the bias statement — name at least two blind spots.',
				},
			)

			expect(out.updatedActorId).toBe(agent.id)
			expect(out.newSystemPrompt).toMatch(/## Response protocol/)
			expect(out.diff).toContain('length changed by')

			// actor.system_prompt persisted with the assembled prompt.
			const [actorRow] = await db
				.select({ systemPrompt: actors.systemPrompt })
				.from(actors)
				.where(eq(actors.id, agent.id))
				.limit(1)
			expect(actorRow.systemPrompt).toBe(out.newSystemPrompt)
			expect(actorRow.systemPrompt).not.toBe(
				'# Sable Ostrik\n\n## Background\n\nprevious background text.',
			)

			// workspace_skill.content republished + S3 write executed.
			const [skillRow] = await db
				.select({ content: workspaceSkills.content, sizeBytes: workspaceSkills.sizeBytes })
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, skillId))
				.limit(1)
			expect(skillRow.content).toContain('## Response protocol')
			expect(skillRow.sizeBytes).toBe(Buffer.byteLength(skillRow.content, 'utf-8'))
			expect(storage._store.get(storageKey)?.toString('utf-8')).toBe(skillRow.content)

			// Audit event: updated / actor / entityId=agent.id / source=agent_builder_refine.
			const [auditEvent] = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.workspaceId, ws.id),
						eq(events.action, 'updated'),
						eq(events.entityType, 'actor'),
						eq(events.entityId, agent.id),
					),
				)
				.limit(1)
			expect(auditEvent).toBeDefined()
			const data = auditEvent.data as { source: string; refinement_context: string }
			expect(data.source).toBe('agent_builder_refine')
			expect(data.refinement_context).toContain('Sharpen the bias statement')
		})
	})

	describe('loadReviewTarget', () => {
		it('throws object_no_content when the target object has an empty content field', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const emptyObject = await insertObject(db, ws.id, getTestActorId(), {
				content: '   ',
			})

			await expect(
				loadReviewTarget(db, ws.id, { objectId: emptyObject.id }),
			).rejects.toBeInstanceOf(AgentReviewTargetError)

			await expect(loadReviewTarget(db, ws.id, { objectId: emptyObject.id })).rejects.toMatchObject(
				{ reason: 'object_no_content' },
			)
		})
	})

	describe('getOrBootstrapAgentBuilderActor', () => {
		it('creates the actor + membership + self-critique skill on first call, and reuses it on the second', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const storage = createMemoryStorage()
			const agentStorage = new AgentStorageManager(storage, db)

			const first = await getOrBootstrapAgentBuilderActor(db, agentStorage, ws.id, getTestActorId())
			expect(first.bootstrapped).toBe(true)

			const [actorRow] = await db.select().from(actors).where(eq(actors.id, first.actorId)).limit(1)
			expect(actorRow).toBeDefined()
			expect(actorRow.name).toBe(AGENT_BUILDER_ACTOR_NAME)
			expect(actorRow.systemPrompt).toBeTruthy()

			const [memberRow] = await db
				.select()
				.from(workspaceMembers)
				.where(
					and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.actorId, first.actorId)),
				)
				.limit(1)
			expect(memberRow).toBeDefined()

			const skillRows = await db
				.select({ id: workspaceSkills.id, content: workspaceSkills.content })
				.from(workspaceSkills)
				.innerJoin(agentSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
				.where(and(eq(workspaceSkills.workspaceId, ws.id), eq(agentSkills.actorId, first.actorId)))
			expect(skillRows).toHaveLength(1)
			// S3 write executed for real (memory-backed StorageProvider), not just
			// a DB row — putWorkspaceSkill's storageKey must resolve to content.
			const storageKey = workspaceSkillKey(ws.id, skillRows[0].id)
			expect(storage._store.get(storageKey)?.toString('utf-8')).toBe(skillRows[0].content)

			// Second call in the same workspace must be a pure read — no second
			// actor, no duplicate membership/skill rows.
			const second = await getOrBootstrapAgentBuilderActor(
				db,
				agentStorage,
				ws.id,
				getTestActorId(),
			)
			expect(second.bootstrapped).toBe(false)
			expect(second.actorId).toBe(first.actorId)

			const [{ value: actorCount }] = await db
				.select({ value: count() })
				.from(actors)
				.where(eq(actors.name, AGENT_BUILDER_ACTOR_NAME))
			expect(actorCount).toBe(1)
		})
	})
})
