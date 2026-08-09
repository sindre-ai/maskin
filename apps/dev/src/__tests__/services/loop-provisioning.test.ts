import { describe, expect, it } from 'vitest'
import {
	buildActorInsert,
	buildSkillInsert,
	buildTriggerInsert,
	claimProvisionedActor,
	findProvisionedActorByMetadataKey,
	installMetadata,
	rewriteWiring,
} from '../../services/loop-provisioning'
import { createTestContext } from '../setup'

describe('installMetadata', () => {
	it('packs install id, source id, and snapshot together', () => {
		const out = installMetadata('inst-1', 'src-1', { name: 'X' })
		expect(out).toEqual({
			installed_loop_id: 'inst-1',
			source_item_id: 'src-1',
			snapshot: { name: 'X' },
		})
	})
})

// UUID-format IDs used across rewriteWiring tests.
const SRC_1 = '11111111-1111-4111-a111-111111111111'
const SRC_2 = '22222222-2222-4222-a222-222222222222'
const LOCAL_1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const LOCAL_2 = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

describe('rewriteWiring', () => {
	it('returns the snapshot unchanged when the map is empty', () => {
		const snap = { a: SRC_1, nested: { b: SRC_2 } }
		expect(rewriteWiring(snap, new Map())).toEqual(snap)
	})

	it('rewrites recursively through nested objects and arrays', () => {
		const map = new Map([
			[SRC_1, LOCAL_1],
			[SRC_2, LOCAL_2],
		])
		const snap = {
			config: { targets: [SRC_1, 'unrelated'], owner: SRC_2 },
			pairs: [{ id: SRC_1 }, { id: SRC_2 }],
		}
		expect(rewriteWiring(snap, map)).toEqual({
			config: { targets: [LOCAL_1, 'unrelated'], owner: LOCAL_2 },
			pairs: [{ id: LOCAL_1 }, { id: LOCAL_2 }],
		})
	})

	it('leaves non-string scalars and unmatched UUIDs untouched', () => {
		const map = new Map([[SRC_1, LOCAL_1]])
		const snap = { a: SRC_2, b: 42, c: true, d: null }
		expect(rewriteWiring(snap, map)).toEqual(snap)
	})

	it('does not rewrite non-UUID strings even if they appear in the map', () => {
		// Verifies that systemPrompt / actionPrompt text can never be accidentally
		// rewritten — only UUID-format strings are candidates for ID substitution.
		const map = new Map([['some-label', 'other-label']])
		const snap = { actionPrompt: 'some-label', targetActorId: SRC_1 }
		expect(rewriteWiring(snap, map)).toEqual(snap)
	})
})

describe('buildActorInsert', () => {
	it('accepts camelCase and snake_case snapshot keys', () => {
		const camel = buildActorInsert(
			'ws-1',
			{ name: 'A', systemPrompt: 'go', llmProvider: 'anthropic' },
			{ installed_loop_id: 'i', source_item_id: 's', snapshot: {} },
			'actor-1',
		)
		expect(camel.workspaceId).toBe('ws-1')
		expect(camel.systemPrompt).toBe('go')
		expect(camel.llmProvider).toBe('anthropic')
		expect(camel.createdBy).toBe('actor-1')

		const snake = buildActorInsert(
			'ws-1',
			{ name: 'A', system_prompt: 'go', llm_provider: 'anthropic' },
			{ installed_loop_id: 'i', source_item_id: 's', snapshot: {} },
			'actor-1',
		)
		expect(snake.workspaceId).toBe('ws-1')
		expect(snake.systemPrompt).toBe('go')
		expect(snake.llmProvider).toBe('anthropic')
	})

	it('always mints a fresh apiKey, ignoring any value in the snapshot', () => {
		// Snapshot has no apiKey → mints a fresh one.
		const fromEmpty = buildActorInsert('ws-1', { name: 'A' }, { installed_loop_id: 'i' }, null)
		expect(fromEmpty.apiKey).toMatch(/^ank_/)

		// Snapshot carries a publisher apiKey → ignored. Honoring it would
		// either leak the publisher's bearer token into the installer workspace
		// or collide on the actors.api_key unique index.
		const fromPublisherKey = buildActorInsert(
			'ws-1',
			{ name: 'A', apiKey: 'ank_publisherleak' },
			{ installed_loop_id: 'i' },
			null,
		)
		expect(fromPublisherKey.apiKey).toMatch(/^ank_/)
		expect(fromPublisherKey.apiKey).not.toBe('ank_publisherleak')
	})
})

describe('findProvisionedActorByMetadataKey', () => {
	it('looks up an actor by the given metadata key, scoped to the workspace', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.select = [{ id: 'local-1' }]

		const found = await findProvisionedActorByMetadataKey(db, 'ws-1', 'source_item_id', 'src-1')

		expect(found).toEqual({ id: 'local-1' })
	})

	it('returns undefined when no actor carries the key value', async () => {
		const { db } = createTestContext()

		const found = await findProvisionedActorByMetadataKey(db, 'ws-1', 'source_item_id', 'src-1')

		expect(found).toBeUndefined()
	})
})

describe('claimProvisionedActor', () => {
	it('wins the claim when nothing conflicts and stamps workspace + source_item_id on the row', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.insert = [{ id: 'local-1' }]

		const claim = await claimProvisionedActor(
			db,
			'ws-1',
			'src-1',
			{ name: 'A' },
			{ installed_loop_id: 'i' },
			'actor-1',
		)

		expect(claim).toEqual({ id: 'local-1', created: true })
		// The claim row must be scoped per-workspace and carry the dedup identity,
		// or the partial unique index (workspace_id, metadata->>'source_item_id')
		// has nothing to arbitrate on.
		expect(calls.inserts[0]).toMatchObject({
			workspaceId: 'ws-1',
			metadata: { installed_loop_id: 'i', source_item_id: 'src-1' },
		})
	})

	it('loses the claim and re-reads the winner when the insert conflicts', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.insert = []
		mockResults.select = [{ id: 'winner-1' }]

		const claim = await claimProvisionedActor(
			db,
			'ws-1',
			'src-1',
			{ name: 'A' },
			{ installed_loop_id: 'i' },
			'actor-1',
		)

		expect(claim).toEqual({ id: 'winner-1', created: false })
		// A lost claim still attempted the insert, which is what tripped the index.
		expect(calls.inserts[0]).toMatchObject({ workspaceId: 'ws-1' })
	})

	it('fails loudly when the claim is lost but no winner is visible', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.insert = []
		mockResults.select = []

		await expect(
			claimProvisionedActor(
				db,
				'ws-1',
				'src-1',
				{ name: 'A' },
				{ installed_loop_id: 'i' },
				'actor-1',
			),
		).rejects.toThrow(/lost claim for source_item_id src-1/)
	})
})

describe('buildTriggerInsert', () => {
	it('threads workspace + createdBy and defaults enabled=true', () => {
		const out = buildTriggerInsert(
			'ws-1',
			{
				name: 'Daily',
				type: 'cron',
				config: { expression: '0 9 * * *' },
				action_prompt: 'Run.',
				target_actor_id: 'local-1',
			},
			{ installed_loop_id: 'i' },
			'actor-1',
		)
		expect(out.workspaceId).toBe('ws-1')
		expect(out.targetActorId).toBe('local-1')
		expect(out.actionPrompt).toBe('Run.')
		expect(out.enabled).toBe(true)
		expect(out.createdBy).toBe('actor-1')
	})
})

describe('buildSkillInsert', () => {
	it('threads the caller-provided id/storageKey rather than trusting the snapshot', () => {
		const out = buildSkillInsert(
			'ws-1',
			'skill-local-1',
			'workspaces/ws-1/skills/skill-local-1/SKILL.md',
			{
				name: 'codebase-review',
				description: 'Review code.',
				content: '# Review\n',
				isValid: true,
			},
			{ installed_loop_id: 'i' },
			'actor-1',
		)
		expect(out.id).toBe('skill-local-1')
		expect(out.workspaceId).toBe('ws-1')
		expect(out.storageKey).toBe('workspaces/ws-1/skills/skill-local-1/SKILL.md')
		expect(out.name).toBe('codebase-review')
		expect(out.content).toBe('# Review\n')
		expect(out.createdBy).toBe('actor-1')
	})

	it('ignores any storageKey carried in the snapshot — the publisher key must never be reused', () => {
		// A malicious or stale snapshot could carry a storageKey pointing at the
		// publisher's own S3 object. buildSkillInsert must never read
		// snapshot.storageKey; only the caller-provided storageKey argument
		// (minted fresh per install) may end up on the row.
		const out = buildSkillInsert(
			'ws-1',
			'skill-local-1',
			'workspaces/ws-1/skills/skill-local-1/SKILL.md',
			{
				name: 'codebase-review',
				content: 'x',
				storageKey: 'workspaces/publisher-ws/skills/leak/SKILL.md',
			},
			{ installed_loop_id: 'i' },
			'actor-1',
		)
		expect(out.storageKey).toBe('workspaces/ws-1/skills/skill-local-1/SKILL.md')
	})

	it('computes sizeBytes from content and defaults isValid to true', () => {
		const out = buildSkillInsert(
			'ws-1',
			'skill-1',
			'workspaces/ws-1/skills/skill-1/SKILL.md',
			{ name: 'skill', content: 'hello' },
			{ installed_loop_id: 'i' },
			null,
		)
		expect(out.sizeBytes).toBe(Buffer.byteLength('hello', 'utf-8'))
		expect(out.isValid).toBe(true)
	})
})
