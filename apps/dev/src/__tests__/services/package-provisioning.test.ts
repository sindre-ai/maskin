import { describe, expect, it } from 'vitest'
import {
	buildActorInsert,
	buildTriggerInsert,
	installMetadata,
	rewriteWiring,
} from '../../services/package-provisioning'

describe('installMetadata', () => {
	it('packs install id, source id, and snapshot together', () => {
		const out = installMetadata('inst-1', 'src-1', { name: 'X' })
		expect(out).toEqual({
			installed_package_id: 'inst-1',
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
			{ name: 'A', systemPrompt: 'go', llmProvider: 'anthropic' },
			{ installed_package_id: 'i', source_item_id: 's', snapshot: {} },
			'actor-1',
		)
		expect(camel.systemPrompt).toBe('go')
		expect(camel.llmProvider).toBe('anthropic')
		expect(camel.createdBy).toBe('actor-1')

		const snake = buildActorInsert(
			{ name: 'A', system_prompt: 'go', llm_provider: 'anthropic' },
			{ installed_package_id: 'i', source_item_id: 's', snapshot: {} },
			'actor-1',
		)
		expect(snake.systemPrompt).toBe('go')
		expect(snake.llmProvider).toBe('anthropic')
	})

	it('always mints a fresh apiKey, ignoring any value in the snapshot', () => {
		// Snapshot has no apiKey → mints a fresh one.
		const fromEmpty = buildActorInsert({ name: 'A' }, { installed_package_id: 'i' }, null)
		expect(fromEmpty.apiKey).toMatch(/^ank_/)

		// Snapshot carries a publisher apiKey → ignored. Honoring it would
		// either leak the publisher's bearer token into the installer workspace
		// or collide on the actors.api_key unique index.
		const fromPublisherKey = buildActorInsert(
			{ name: 'A', apiKey: 'ank_publisherleak' },
			{ installed_package_id: 'i' },
			null,
		)
		expect(fromPublisherKey.apiKey).toMatch(/^ank_/)
		expect(fromPublisherKey.apiKey).not.toBe('ank_publisherleak')
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
			{ installed_package_id: 'i' },
			'actor-1',
		)
		expect(out.workspaceId).toBe('ws-1')
		expect(out.targetActorId).toBe('local-1')
		expect(out.actionPrompt).toBe('Run.')
		expect(out.enabled).toBe(true)
		expect(out.createdBy).toBe('actor-1')
	})
})
